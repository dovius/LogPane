import { safeStringify } from '../core/safeText';

/** `com.example.orders.processors.ErrorProcessor` → `c.e.o.p.ErrorProcessor`. */
export function abbreviateLogger(name: string, max = 28): string {
  if (name.length <= max || !name.includes('.')) return name;
  const parts = name.split('.');
  const last = parts.pop()!;
  return `${parts.map((p) => p[0] ?? '').join('.')}.${last}`;
}

/** First line of a message, capped so huge payloads don't bloat list rows. */
export function listText(message: string, max = 400): string {
  const nl = message.indexOf('\n');
  const first = nl >= 0 ? `${message.slice(0, nl)} ⏎ …` : message;
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct';

export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
}

const JSON_TOKEN_RE = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Pretty-prints a value and splits it into tokens for syntax colouring. */
export function jsonTokens(value: unknown): JsonToken[] {
  return jsonTextTokens(safeStringify(value, 2));
}

/** Tokens of (possibly cut off) pretty-printed JSON text. */
export function jsonTextTokens(text: string): JsonToken[] {
  const out: JsonToken[] = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), kind: 'punct' });
    if (m[1] !== undefined) {
      out.push({ text: m[1], kind: m[2] ? 'key' : 'string' });
      if (m[2]) out.push({ text: m[2], kind: 'punct' });
    } else {
      out.push({ text: m[0], kind: /^[tfn]/.test(m[0]) ? 'literal' : 'number' });
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'punct' });
  return out;
}

const FRAMEWORK_FRAME_RE = /^\s*at (?:java\.|javax\.|jdk\.|sun\.|com\.sun\.|kotlin\.|org\.apache\.|io\.quarkus\.|io\.vertx\.|io\.netty\.|io\.opentelemetry\.|io\.smallrye\.|org\.jboss\.|org\.springframework\.|reactor\.|org\.hibernate\.)/;

/** Framework frames are dimmed so application frames stand out. */
export function isFrameworkFrame(line: string): boolean {
  return FRAMEWORK_FRAME_RE.test(line);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export type StackLineKind = 'exception' | 'app' | 'framework' | 'other';

export type StackPart = { kind: 'line'; text: string; line: StackLineKind } | { kind: 'fold'; lines: string[] };

export function stackLineKind(line: string): StackLineKind {
  if (/^\s*at /.test(line)) return isFrameworkFrame(line) ? 'framework' : 'app';
  if (/^\s*\.\.\. \d+/.test(line)) return 'other';
  return 'exception'; // "Type: message", "Caused by: …", "Suppressed: …"
}

/** Stack trace lines, with runs of `minFold` or more framework frames folded into one part. */
export function stackParts(stack: string, minFold = 3): StackPart[] {
  const parts: StackPart[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= minFold) parts.push({ kind: 'fold', lines: run });
    else for (const text of run) parts.push({ kind: 'line', text, line: 'framework' });
    run = [];
  };
  for (const text of stack.split('\n')) {
    const line = stackLineKind(text);
    if (line === 'framework') {
      run.push(text);
      continue;
    }
    flush();
    parts.push({ kind: 'line', text, line });
  }
  flush();
  return parts;
}

const BREAK_AFTER_RE = /[./$#](?=[\w$])|(?=\()/g;

/**
 * Lets long identifiers (loggers, classes, stack frames, URLs) wrap after dots and slashes instead of
 * mid-word. Tokens shorter than `minToken` are left alone; `null` marks a `<wbr>`.
 */
export function breakAtDots(text: string, minToken = 20): (string | null)[] {
  if (text.length > 4000) return [text]; // huge payloads: not worth thousands of nodes
  const out: (string | null)[] = [];
  let at = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const token = m[0];
    if (token.length < minToken) continue;
    for (const b of token.matchAll(BREAK_AFTER_RE)) {
      const cut = (m.index ?? 0) + (b.index ?? 0) + b[0].length;
      if (cut <= at || cut >= (m.index ?? 0) + token.length) continue;
      out.push(text.slice(at, cut), null);
      at = cut;
    }
  }
  if (at < text.length || !out.length) out.push(text.slice(at));
  return out;
}

/** Longer stack lines are shown as they are, without splitting into class, method and location. */
export const MAX_STACK_LINE = 4000;

export type StackLine =
  | { kind: 'frame'; method: string; location: string }
  | { kind: 'exception'; prefix: string; type: string; message: string }
  | { kind: 'other'; text: string };

/**
 * `\tat a.b.C.run(C.java:12)` → frame `a.b.C.run` at `(C.java:12)`;
 * `Caused by: a.b.Error: boom` → prefix `Caused by: `, type `a.b.Error`, message `boom`.
 */
export function parseStackLine(line: string): StackLine {
  // Lines come from the log: no regex with backtracking over the whole line, and huge ones stay plain text.
  if (line.length > MAX_STACK_LINE) return { kind: 'other', text: line.trim() };
  const body = line.trimStart();
  if (body.startsWith('at ')) {
    const rest = body.slice(3).trimEnd();
    const open = rest.endsWith(')') ? rest.lastIndexOf('(') : -1;
    return open < 0 || rest.indexOf(')', open) !== rest.length - 1
      ? { kind: 'frame', method: rest, location: '' }
      : { kind: 'frame', method: rest.slice(0, open), location: rest.slice(open) };
  }
  const ex = /^(\s*(?:Caused by|Suppressed|Wrapped by): )?([\w$./]+)(?:: ([\s\S]*))?$/.exec(line);
  if (ex && /\w[.$]\w|Exception|Error|Throwable/.test(ex[2])) {
    return { kind: 'exception', prefix: ex[1] ?? '', type: ex[2], message: ex[3] ?? '' };
  }
  return { kind: 'other', text: line.replace(/^\s+/, '') };
}

/** `2026-10-01T09:30:01.123Z` → `2026-10-01 09:30:01.123 UTC`; local offsets become `UTC+03:00`. */
export function readableTimestamp(iso: string): string {
  return iso.replace('T', ' ').replace(/Z$/, ' UTC').replace(/([+-]\d{2}:\d{2})$/, ' UTC$1');
}
