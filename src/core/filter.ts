import { searchText } from './parse';
import { emptyLevelCounts, type Level, type LevelCounts, type LogEntry } from './types';

export interface FilterState {
  /** Free text: space-separated terms are ANDed, "quoted phrases" stay together, -term excludes. */
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Levels to show; empty means all. */
  levels: Level[];
  /** Loggers to show; empty means all. */
  loggers: string[];
  hiddenSources: number[];
  traceId: string;
  fromMs: number | null;
  toMs: number | null;
}

export const EMPTY_FILTER: FilterState = {
  text: '', regex: false, caseSensitive: false, levels: [], loggers: [], hiddenSources: [], traceId: '', fromMs: null, toMs: null,
};

export interface TextQuery {
  include: string[];
  exclude: string[];
}

const TOKEN_RE = /(-?)"([^"]*)"?|(\S+)/g;

export function parseQuery(text: string, caseSensitive: boolean): TextQuery {
  const q: TextQuery = { include: [], exclude: [] };
  for (const m of text.matchAll(TOKEN_RE)) {
    let term: string;
    let negate: boolean;
    if (m[3] !== undefined) {
      if (m[3] === '-') continue; // an exclusion still being typed
      // "-term" excludes; "--flag" is searched for as written
      negate = m[3].startsWith('-') && !m[3].startsWith('--');
      term = negate ? m[3].slice(1) : m[3];
    } else {
      negate = m[1] === '-';
      term = m[2];
    }
    if (!term) continue;
    if (!caseSensitive) term = term.toLowerCase();
    (negate ? q.exclude : q.include).push(term);
  }
  return q;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex search looks at this much of each entry: a careless pattern on a huge line can take minutes. */
export const REGEX_SUBJECT_LIMIT = 2000;

/**
 * Backtracking cost grows roughly with length^(unbounded quantifiers), so patterns with more `*` / `+`
 * look at less of each entry.
 */
export function regexSubjectLimit(source: string): number {
  const unbounded = (source.match(/[*+]|\{\d+,\}/g) ?? []).length;
  return unbounded <= 1 ? REGEX_SUBJECT_LIMIT : unbounded === 2 ? 1000 : 300;
}
/** A regex filter that takes longer than this over all entries is stopped with an error. */
export const REGEX_BUDGET_MS = 1000;
export const REGEX_TOO_SLOW = 'This regular expression is too slow on these logs. Make it more specific (avoid patterns like .*.*).';
export const REGEX_NESTED =
  'This regular expression repeats a group that itself repeats or has alternatives, like (a+)+ or (a|ab)*. That can freeze the tab on some lines; write it without the outer repetition (e.g. a+).';

const QUANTIFIER_RE = /^(?:[*+]|\{\d*,\d*\}|\{\d+\})/;

/** `*`, `+`, `{n,}` and `{n,m}` with more than one repetition (`?`, `{1}` don't repeat). */
function repeats(q: string): boolean {
  if (q === '*' || q === '+') return true;
  const m = /^\{(\d*)(,?)(\d*)\}$/.exec(q);
  if (!m) return false;
  if (!m[2]) return Number(m[1]) > 1;
  return m[3] === '' || Number(m[3]) > 1;
}

/**
 * Detects the patterns behind exponential backtracking (JavaScript can't interrupt a running regex): a group
 * repeated without bound whose body repeats or alternates, at any depth, e.g. `(a+)+`, `(\w|\d)*$`, `((ab)+c)*`.
 * Other patterns stay polynomial, which the subject limit and the time budget keep in check.
 */
export function nestedRepetition(source: string): boolean {
  // one frame per open group: does its body contain a quantifier or an alternation?
  const stack: { risky: boolean }[] = [{ risky: false }];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      // character class: skip to the closing bracket (a leading ] or ^] is literal)
      i++;
      if (source[i] === '^') i++;
      if (source[i] === ']') i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(') {
      stack.push({ risky: false });
      continue;
    }
    if (c === '|') {
      stack[stack.length - 1].risky = true;
      continue;
    }
    const q = QUANTIFIER_RE.exec(source.slice(i, i + 24))?.[0];
    if (c === ')') {
      const group = stack.length > 1 ? stack.pop()! : { risky: false };
      const after = QUANTIFIER_RE.exec(source.slice(i + 1, i + 25))?.[0];
      // only an unbounded outer repetition is exponential: (\d+\.){3} is fine, (\d+\.)+ is not
      if (after !== undefined && /^(?:[*+]|\{\d*,\})$/.test(after) && group.risky) return true;
      if ((after !== undefined && repeats(after)) || group.risky) stack[stack.length - 1].risky = true;
      if (after) i += after.length;
      continue;
    }
    if (q) {
      if (repeats(q)) stack[stack.length - 1].risky = true;
      i += q.length - 1;
    }
  }
  return false;
}

/**
 * `.*foo` is tried from every position of every line (quadratic); anchored at line starts it gives
 * the same answer much faster. Only for patterns without alternation, where the anchor can't change meaning.
 */
function fastRegex(source: string, flags: string): RegExp {
  // `m` makes ^ match at line starts; only safe when the pattern has no ^ / $ / | of its own
  if (/^\.[*+]/.test(source) && !/[|^$]/.test(source)) return new RegExp(`^(?:${source})`, `${flags}m`);
  return new RegExp(source, flags);
}

export interface CompiledFilter {
  /** Every predicate except the level one (so level chips can show "what you'd get"). */
  matchesExceptLevel: (e: LogEntry) => boolean;
  matchesLevel: (e: LogEntry) => boolean;
  /** Global regex for highlighting matches in the UI, or null. */
  highlight: RegExp | null;
  /** At most this many highlighted matches per row (unset: the UI default). */
  highlightMax?: number;
  error?: string;
  /** Regex search: applyFilter stops after REGEX_BUDGET_MS. */
  timed?: boolean;
}

function compileText(f: FilterState): Pick<CompiledFilter, 'highlight' | 'highlightMax' | 'error' | 'timed'> & { test: ((e: LogEntry) => boolean) | null } {
  if (!f.text.trim()) return { test: null, highlight: null };
  const text = (e: LogEntry) => (f.caseSensitive ? searchText(e) : e.haystack);
  if (f.regex) {
    let re: RegExp;
    try {
      re = new RegExp(f.text, f.caseSensitive ? '' : 'i');
    } catch (err) {
      return { test: () => false, highlight: null, error: (err as Error).message };
    }
    if (nestedRepetition(f.text)) return { test: () => false, highlight: null, error: REGEX_NESTED };
    const fast = fastRegex(f.text, re.flags);
    const limit = regexSubjectLimit(f.text);
    const test = (e: LogEntry) => {
      const t = text(e);
      return fast.test(t.length > limit ? t.slice(0, limit) : t);
    };
    // After the first match, more searches over the rest of the line can be much slower than the filter
    // test was: patterns with several unbounded quantifiers highlight one match per row.
    return { test, highlight: new RegExp(re.source, re.flags + 'g'), highlightMax: limit < REGEX_SUBJECT_LIMIT ? 1 : undefined, timed: true };
  }
  const q = parseQuery(f.text, f.caseSensitive);
  if (!q.include.length && !q.exclude.length) return { test: null, highlight: null };
  const test = (e: LogEntry) => {
    const t = text(e);
    for (const term of q.include) if (!t.includes(term)) return false;
    for (const term of q.exclude) if (t.includes(term)) return false;
    return true;
  };
  const highlight = q.include.length
    ? new RegExp(q.include.map(escapeRe).sort((a, b) => b.length - a.length).join('|'), f.caseSensitive ? 'g' : 'gi')
    : null;
  return { test, highlight };
}

export function compileFilter(f: FilterState): CompiledFilter {
  const textPart = compileText(f);
  const levels = f.levels.length ? new Set(f.levels) : null;
  const loggers = f.loggers.length ? new Set(f.loggers) : null;
  const hidden = f.hiddenSources.length ? new Set(f.hiddenSources) : null;
  const { traceId, fromMs, toMs } = f;
  const textTest = textPart.test;
  return {
    matchesExceptLevel: (e) => {
      if (hidden && hidden.has(e.sourceId)) return false;
      if (traceId && e.traceId !== traceId) return false;
      if (loggers && !loggers.has(e.logger)) return false;
      if (fromMs !== null && !(e.tsMs >= fromMs)) return false;
      if (toMs !== null && !(e.tsMs <= toMs)) return false;
      return textTest ? textTest(e) : true;
    },
    matchesLevel: levels ? (e) => levels.has(e.level) : () => true,
    highlight: textPart.highlight,
    highlightMax: textPart.highlightMax,
    error: textPart.error,
    timed: textPart.timed,
  };
}

export interface FilterResult {
  /** Indexes into the entries array that pass all filters. */
  indices: number[];
  /** Per-level counts of entries that pass every filter except the level one. */
  counts: LevelCounts;
  highlight: RegExp | null;
  highlightMax?: number;
  error?: string;
}

export function applyFilter(entries: readonly LogEntry[], f: FilterState): FilterResult {
  const c = compileFilter(f);
  const counts = emptyLevelCounts();
  const indices: number[] = [];
  const deadline = c.timed ? performance.now() + REGEX_BUDGET_MS : Number.POSITIVE_INFINITY;
  for (let i = 0; i < entries.length; i++) {
    // checked on every entry: a single slow regex test can take a long time
    if (c.timed && performance.now() > deadline) {
      return { indices: [], counts: emptyLevelCounts(), highlight: null, error: REGEX_TOO_SLOW };
    }
    const e = entries[i];
    if (!c.matchesExceptLevel(e)) continue;
    counts[e.level]++;
    if (c.matchesLevel(e)) indices.push(i);
  }
  return { indices, counts, highlight: c.highlight, highlightMax: c.highlightMax, error: c.error };
}

export function isFilterActive(f: FilterState): boolean {
  return Boolean(
    f.text.trim() || f.levels.length || f.loggers.length || f.hiddenSources.length || f.traceId || f.fromMs !== null || f.toMs !== null,
  );
}

export interface TextPiece {
  text: string;
  hit: boolean;
}

/** Splits text into highlighted / plain pieces. */
export function highlightPieces(text: string, re: RegExp | null, maxHits = 50): TextPiece[] {
  if (!re || !text) return [{ text, hit: false }];
  const pieces: TextPiece[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let hits = 0;
  while (hits < maxHits && (m = re.exec(text))) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) pieces.push({ text: text.slice(last, m.index), hit: false });
    pieces.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    hits++;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), hit: false });
  return pieces;
}
