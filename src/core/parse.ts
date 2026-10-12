import { exceptionChain } from './stacktrace';
import {
  BOILERPLATE_KEYS, FIELD_ALIASES, collectValues, detectPlainLevel, isGelf, normalizeLevel, pick, pickString, syslogLevel,
} from './fields';
import { leadingTimestampMatch, parseTimestamp } from './time';
import type { JsonObject, LogEntry } from './types';

/** Keys already indexed explicitly (or useless) and therefore skipped when indexing "other" fields. */
const INDEXED_KEYS = new Set<string>([
  ...BOILERPLATE_KEYS, ...FIELD_ALIASES.message, ...FIELD_ALIASES.logger, ...FIELD_ALIASES.thread,
  ...FIELD_ALIASES.stackText, 'mdc', 'exception',
]);

const CONTINUATION_RE = /^(?:\s+\S|Caused by:|Suppressed:|\.\.\. \d+ (?:more|common frames omitted)|at [\w$.<>]+\()/;
/**
 * First line of a Java stack trace printed after a plain-text log line (logback, log4j):
 * `java.lang.IllegalStateException: boom`. "Exception in thread …" starts a new entry instead.
 */
const EXCEPTION_HEADER_RE = /^(?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)(?::|$)/;
/** containerd / CRI-O node log line after its timestamp: `stdout F <line>`. */
const CRI_STREAM_RE = /^(?:stdout|stderr) [FP] /;

export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function asObject(v: unknown): JsonObject | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined;
}

function tryParseObject(text: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Text searched by the free-text filter (original case). */
export function searchText(e: LogEntry): string {
  if (!e.json) return e.raw;
  const parts: string[] = [e.message, e.logger, e.thread];
  collectValues(e.json.mdc, parts);
  if (e.exception) for (const link of exceptionChain(e.exception)) parts.push(link.type, link.message);
  if (e.stackText) parts.push(e.stackText);
  for (const [k, v] of Object.entries(e.json)) if (!INDEXED_KEYS.has(k)) collectValues(v, parts);
  return parts.join('\n');
}

function isDockerWrapper(obj: JsonObject): boolean {
  return typeof obj.log === 'string' && typeof obj.stream === 'string' && 'time' in obj;
}

/** Structured (Quarkus) exception objects have a type, frames or a cause. */
function structuredException(v: unknown): JsonObject | undefined {
  const o = asObject(v);
  return o && ('exceptionType' in o || 'frames' in o || 'causedBy' in o) ? o : undefined;
}

/**
 * Line-oriented, incremental parser for one source. Every line is handled on its own, so a broken
 * or non-JSON line never stops the rest. Plain-text continuation lines (`\tat ...`, `Caused by: ...`)
 * are folded into the preceding plain-text entry.
 */
export class LogParser {
  /** Physical lines consumed so far. */
  lineCount = 0;
  private last: LogEntry | null = null;
  private lastTs = { ms: Number.NaN, nanos: 0, text: undefined as string | undefined };
  /** Entries before the first timestamp of the source (banners); they get that first timestamp. */
  private untimed: LogEntry[] | null = [];

  constructor(readonly sourceId: number) {}

  /** Parses more lines; returns the new entries. May extend the previously returned last entry. */
  pushLines(lines: readonly string[]): LogEntry[] {
    const out: LogEntry[] = [];
    for (const line of lines) {
      const lineNo = ++this.lineCount;
      if (line.trim() === '') continue;
      if (this.last && !this.last.json && !line.trimStart().startsWith('{') && (CONTINUATION_RE.test(line) || EXCEPTION_HEADER_RE.test(line))) {
        this.extend(this.last, line);
        continue;
      }
      const entry = this.parseLine(line, lineNo);
      if (!Number.isNaN(entry.tsMs) && !entry.tsInherited) {
        this.lastTs = { ms: entry.tsMs, nanos: entry.tsNanos, text: entry.tsText };
        if (this.untimed) {
          // Without a time these would sort after every other source when merging.
          for (const e of this.untimed) {
            e.tsMs = entry.tsMs;
            e.tsNanos = entry.tsNanos;
          }
          this.untimed = null;
        }
      } else if (this.untimed) {
        this.untimed.push(entry);
      }
      this.last = entry;
      out.push(entry);
    }
    return out;
  }

  private extend(entry: LogEntry, line: string): void {
    entry.raw += `\n${line}`;
    entry.message += `\n${line}`;
    entry.haystack += `\n${line.toLowerCase()}`;
  }

  private parseLine(line: string, lineNo: number): LogEntry {
    // trimStart also drops a BOM and non-breaking spaces before the JSON
    const trimmed = line.trimStart();
    if (trimmed.startsWith('{')) {
      const obj = tryParseObject(trimmed);
      if (obj) return isDockerWrapper(obj) ? this.dockerEntry(obj, line, lineNo) : this.jsonEntry(obj, line, lineNo);
    }
    const ts = leadingTimestampMatch(trimmed);
    if (ts) {
      // `kubectl logs --timestamps` style "<rfc3339> {json}", `[<ts>] {json}`, and CRI node logs "<ts> stdout F {json}"
      let rest = trimmed.slice(ts.end).trimStart();
      if (CRI_STREAM_RE.test(rest)) rest = rest.slice(9);
      if (rest.startsWith('{')) {
        const obj = tryParseObject(rest);
        if (obj) return this.jsonEntry(obj, line, lineNo, ts.text);
      }
    }
    return this.plainEntry(line, lineNo, ts?.text ?? null);
  }

  /** Docker json-file line: the application's own line (often JSON itself) is in `log`. */
  private dockerEntry(obj: JsonObject, raw: string, lineNo: number): LogEntry {
    const inner = (obj.log as string).replace(/\r?\n$/, '');
    const time = typeof obj.time === 'string' ? obj.time : undefined;
    const innerObj = inner.trimStart().startsWith('{') ? tryParseObject(inner) : undefined;
    if (innerObj) return this.jsonEntry(innerObj, raw, lineNo, time);
    const entry = this.jsonEntry({ ...obj, log: inner }, raw, lineNo);
    if (entry.level === 'OTHER') entry.level = detectPlainLevel(inner);
    return entry;
  }

  private jsonEntry(obj: JsonObject, raw: string, lineNo: number, fallbackTs?: string): LogEntry {
    // The line's own time wins; a wrapper's time (kubectl prefix, docker) is used when it is missing or unreadable.
    const own = pick(obj, FIELD_ALIASES.timestamp);
    const ownTs = parseTimestamp(own);
    const fallback = ownTs || fallbackTs === undefined ? null : parseTimestamp(fallbackTs);
    const ts = ownTs ?? fallback;
    const tsValue = ownTs || !fallback ? own ?? fallbackTs : fallbackTs;
    const exception = structuredException(obj.exception);
    const stack = exception ? undefined : pick(obj, FIELD_ALIASES.stackText) ?? obj.exception;
    const seq = Number(pick(obj, FIELD_ALIASES.sequence));
    const entry: LogEntry = {
      sourceId: this.sourceId,
      lineNo,
      raw,
      json: obj,
      tsText: typeof tsValue === 'string' ? tsValue : tsValue === undefined ? undefined : typeof tsValue === 'object' ? safeStringify(tsValue) : String(tsValue),
      tsMs: ts ? ts.ms : this.lastTs.ms,
      tsNanos: ts ? ts.nanos : this.lastTs.nanos,
      tsInherited: !ts,
      seq: Number.isFinite(seq) ? seq : Number.NaN,
      level: isGelf(obj)
        ? obj._level_name ? normalizeLevel(obj._level_name) : syslogLevel(obj.level)
        : normalizeLevel(pick(obj, FIELD_ALIASES.level)),
      logger: pickString(obj, FIELD_ALIASES.logger),
      thread: pickString(obj, FIELD_ALIASES.thread),
      message: pickString(obj, FIELD_ALIASES.message),
      traceId: pickString(obj, FIELD_ALIASES.traceId),
      spanId: pickString(obj, FIELD_ALIASES.spanId),
      exception,
      stackText: typeof stack === 'string' && stack ? stack : undefined,
      haystack: '',
    };
    entry.haystack = searchText(entry).toLowerCase();
    return entry;
  }

  private plainEntry(line: string, lineNo: number, tsText: string | null): LogEntry {
    const ts = tsText ? parseTimestamp(tsText) : null;
    return {
      sourceId: this.sourceId,
      lineNo,
      raw: line,
      tsText: ts ? (tsText ?? undefined) : undefined,
      tsMs: ts ? ts.ms : this.lastTs.ms,
      tsNanos: ts ? ts.nanos : this.lastTs.nanos,
      tsInherited: !ts,
      seq: Number.NaN,
      level: detectPlainLevel(line),
      logger: '',
      thread: '',
      message: line,
      traceId: '',
      spanId: '',
      haystack: line.toLowerCase(),
    };
  }
}

export function parseText(text: string, sourceId: number): LogEntry[] {
  return new LogParser(sourceId).pushLines(splitLines(text));
}

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Same as parseText but yields every `chunk` lines so big logs don't freeze the tab. */
export function parseTextChunked(
  text: string,
  parser: LogParser,
  onProgress?: (done: number, total: number) => void,
  chunk = 5000,
): Promise<LogEntry[]> {
  return parseLinesChunked(splitLines(text), parser, onProgress, chunk);
}

export async function parseLinesChunked(
  lines: readonly string[],
  parser: LogParser,
  onProgress?: (done: number, total: number) => void,
  chunk = 5000,
): Promise<LogEntry[]> {
  if (lines.length <= chunk) return parser.pushLines(lines);
  const out: LogEntry[] = [];
  for (let i = 0; i < lines.length; i += chunk) {
    const batch = parser.pushLines(lines.slice(i, i + chunk));
    for (const e of batch) out.push(e);
    onProgress?.(Math.min(i + chunk, lines.length), lines.length);
    await yieldToBrowser();
  }
  return out;
}

/** True when most of the first non-empty lines are JSON objects. */
export function looksLikeJsonLog(text: string, sample = 20): boolean {
  let total = 0;
  let json = 0;
  let pos = 0;
  while (total < sample && pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    if (!line) continue;
    total++;
    if (line.startsWith('{') && tryParseObject(line)) json++;
  }
  return total > 0 && json / total >= 0.5;
}
