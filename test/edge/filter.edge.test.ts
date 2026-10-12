import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, applyFilter, compileFilter, highlightPieces, isFilterActive, parseQuery, type FilterState } from '../../src/core/filter';
import { parseText } from '../../src/core/parse';
import { LEVELS, type Level, type LogEntry } from '../../src/core/types';

type Rng = () => number;
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: Rng, n: number) => Math.floor(r() * n);
const pickOne = <T>(r: Rng, xs: readonly T[]): T => xs[int(r, xs.length)];

const f = (patch: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTER, ...patch });
const BASE = Date.UTC(2026, 9, 1, 10, 0, 0);
const TOKENS = ['order', 'Order', 'ORD-1', 'cache', 'miss', 'user=u7', 'a.b', 'x-y', '(paren)', '[br]', '$1', 'ÄÖ', 'naïve', '😀', 'error', 'WARN', '-dash', '"q"'];
const LOGGERS = ['com.acme.A', 'com.acme.B', ''];

function genEntries(r: Rng, n: number): LogEntry[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const msg = Array.from({ length: 1 + int(r, 5) }, () => pickOne(r, TOKENS)).join(' ');
    const k = int(r, 5);
    if (k === 0) lines.push(`plain ${pickOne(r, ['ERROR', 'INFO', ''])} ${msg}`);
    else if (k === 1) lines.push(`2026-10-01 10:00:${String(int(r, 60)).padStart(2, '0')} WARN ${msg}`);
    else {
      lines.push(JSON.stringify({
        timestamp: new Date(BASE + int(r, 60_000)).toISOString(), level: pickOne(r, ['INFO', 'WARN', 'ERROR', 'DEBUG', 'x']),
        loggerName: pickOne(r, LOGGERS), message: msg, traceId: pickOne(r, ['t1', 't2', '']), extra: { k: pickOne(r, TOKENS) },
      }));
    }
  }
  return parseText(lines.join('\n'), 1 + int(r, 3));
}

function randomFilter(r: Rng, withLevels: boolean): FilterState {
  const termCount = int(r, 3);
  const terms = Array.from({ length: termCount }, () => {
    const t = pickOne(r, TOKENS);
    return r() < 0.25 ? `-${t}` : r() < 0.2 ? `"${t} ${pickOne(r, TOKENS)}"` : t;
  });
  return f({
    text: terms.join(' '),
    caseSensitive: r() < 0.3,
    levels: withLevels ? LEVELS.filter(() => r() < 0.4) : [],
    loggers: r() < 0.2 ? [pickOne(r, LOGGERS)] : [],
    hiddenSources: r() < 0.2 ? [1 + int(r, 3)] : [],
    traceId: r() < 0.15 ? pickOne(r, ['t1', 't2']) : '',
    fromMs: r() < 0.2 ? BASE + int(r, 60_000) : null,
    toMs: r() < 0.2 ? BASE + int(r, 60_000) : null,
  });
}

describe('parseQuery tokenizer', () => {
  it.each<[string, string[], string[]]>([
    ['', [], []],
    ['   ', [], []],
    ['\t\n ', [], []],
    ['-', [], []], // an exclusion still being typed
    ['--', ['--'], []],
    ['---x', ['---x'], []],
    ['- x', ['x'], []],
    ['x -', ['x'], []],
    ['-"a b"', [], ['a b']],
    ['"unbalanced', ['unbalanced'], []],
    ['"a b', ['a b'], []],
    ['""', [], []],
    ['-""', [], []],
    ['-"', [], []],
    ['"""', [], []],
    ['"-x"', ['-x'], []],
    ['foo"bar"', ['foo"bar"'], []],
    ['a"b c"d', ['a"b', 'c"d'], []],
    ['"a" "b"', ['a', 'b'], []],
    ['"a""b"', ['a', 'b'], []],
    ['ÄÖ NAÏVE', ['äö', 'naïve'], []],
    ['  spaced   out  ', ['spaced', 'out'], []],
  ])('%j', (text, include, exclude) => {
    expect(parseQuery(text, false)).toEqual({ include, exclude });
  });

  it('keeps case when case-sensitive', () => {
    expect(parseQuery('Foo -Bar "Baz Q"', true)).toEqual({ include: ['Foo', 'Baz Q'], exclude: ['Bar'] });
  });

  it('"--verbose" searches for the flag as written; "-verbose" excludes', () => {
    expect(parseQuery('--verbose', false)).toEqual({ include: ['--verbose'], exclude: [] });
    const entries = parseText('run --verbose\nrun quiet', 1);
    expect(applyFilter(entries, f({ text: '--verbose' })).indices).toEqual([0]);
    expect(applyFilter(entries, f({ text: '-verbose' })).indices).toEqual([1]);
  });

  it('a filter that tokenizes to nothing filters nothing', () => {
    const entries = parseText('a\nb', 1);
    for (const text of ['""', '-""', '"', '   ']) {
      const res = applyFilter(entries, f({ text }));
      expect(res.indices).toEqual([0, 1]);
      expect(res.highlight).toBeNull();
    }
  });
});

describe('regex search', () => {
  const entries = parseText(['{"level":"INFO","message":"Order ORD-17 created"}', 'plain line', '{"level":"WARN","message":"cache miss"}'].join('\n'), 1);

  it('empty-match regexes match every entry and still highlight safely', () => {
    for (const text of ['^', '$', 'x*', '(?:)', '\\b', '(?=e)', 'zzz|', '(?<=e)']) {
      const res = applyFilter(entries, f({ text, regex: true }));
      expect(res.error, text).toBeUndefined();
      expect(res.indices, text).toEqual([0, 1, 2]);
      expect(res.highlight!.flags).toContain('g');
      for (const e of entries) expect(highlightPieces(e.message, res.highlight).map((p) => p.text).join('')).toBe(e.message);
    }
  });

  it('a whitespace-only regex is treated as "no filter" (current behaviour)', () => {
    expect(applyFilter(entries, f({ text: ' ', regex: true })).indices).toEqual([0, 1, 2]);
  });

  it('case-insensitive regexes run against the lower-cased haystack, case-sensitive ones against the original', () => {
    expect(applyFilter(entries, f({ text: 'ORD-\\d+', regex: true })).indices).toEqual([0]);
    expect(applyFilter(entries, f({ text: '[A-Z]{3}-\\d+', regex: true })).indices).toEqual([0]);
    expect(applyFilter(entries, f({ text: '^order', regex: true })).indices).toEqual([0]);
    expect(applyFilter(entries, f({ text: '^order', regex: true, caseSensitive: true })).indices).toEqual([]);
    expect(applyFilter(entries, f({ text: '(?<=Order )ORD', regex: true, caseSensitive: true })).indices).toEqual([0]);
    expect(applyFilter(entries, f({ text: 'ORD', regex: true, caseSensitive: true })).highlight!.flags).toBe('g');
    expect(applyFilter(entries, f({ text: 'ord', regex: true })).highlight!.flags).toBe('gi');
  });

  it('invalid regexes report an error, match nothing and do not highlight', () => {
    for (const text of ['(', '[', '*', 'a{2,1}', '(?<n>a)(?<n>b)', '\\']) {
      const res = applyFilter(entries, f({ text, regex: true }));
      expect(res.error, text).toBeTruthy();
      expect(res.indices).toEqual([]);
      expect(res.highlight).toBeNull();
      expect(res.counts).toEqual({ FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0, OTHER: 0 });
    }
  });

  it('regex test is stateless across entries (no lastIndex leakage)', () => {
    const many = parseText(Array.from({ length: 50 }, () => 'match me').join('\n'), 1);
    expect(applyFilter(many, f({ text: 'match', regex: true })).indices).toHaveLength(50);
  });
});

describe('highlightPieces', () => {
  const ALPHA = ['a', 'b', 'A', 'B', ' ', '\n', '.', '-', 'ä', '😀', '\ud800', 'x', 'ab', 'aa'];
  const REGEXES = [/a/g, /a*/g, /b+/gi, /(?:)/g, /^/g, /$/g, /\b/g, /(?=a)/g, /a|/g, /|a/g, /ab|a/g, /😀/g, /[\s\S]/g, /\n/g, /x?/g, /a{2}/gi, /(?<=a)b/g];

  it('reconstructs the original text exactly, never loops, and respects maxHits (property)', () => {
    const r = mulberry32(3);
    for (let i = 0; i < 4000; i++) {
      const text = Array.from({ length: int(r, 40) }, () => pickOne(r, ALPHA)).join('');
      const re = pickOne(r, REGEXES);
      const maxHits = pickOne(r, [0, 1, 2, 20, 50]);
      const pieces = highlightPieces(text, re, maxHits);
      expect(pieces.map((p) => p.text).join('')).toBe(text);
      const hits = pieces.filter((p) => p.hit);
      expect(hits.length).toBeLessThanOrEqual(maxHits);
      for (const h of hits) expect(h.text.length).toBeGreaterThan(0);
      for (let k = 1; k < pieces.length; k++) expect(pieces[k - 1].hit || pieces[k].hit).toBe(true); // no two adjacent plain pieces
    }
  });

  it('works with highlight regexes built by compileFilter from arbitrary terms (property)', () => {
    const r = mulberry32(4);
    const chars = 'abAB .*+?^${}()|[]\\/-"';
    for (let i = 0; i < 2000; i++) {
      const word = () => Array.from({ length: 1 + int(r, 4) }, () => chars[int(r, chars.length)]).join('');
      const text = Array.from({ length: 1 + int(r, 3) }, word).join(' ');
      const c = compileFilter(f({ text, caseSensitive: r() < 0.5 }));
      const subject = Array.from({ length: int(r, 30) }, () => chars[int(r, chars.length)]).join('');
      const pieces = highlightPieces(subject, c.highlight);
      expect(pieces.map((p) => p.text).join('')).toBe(subject);
    }
  });

  it('every plain-text match has at least one highlight in its raw text (ASCII)', () => {
    const r = mulberry32(6);
    for (let i = 0; i < 300; i++) {
      const raw = Array.from({ length: 1 + int(r, 6) }, () => pickOne(r, ['Order', 'cache', 'MISS', 'x-y', 'a.b', '(p)'])).join(' ');
      const entries = parseText(raw, 1);
      const term = pickOne(r, ['order', 'Cache', 'miss', 'x-y', 'a.b', '(p)', 'zzz']);
      const res = applyFilter(entries, f({ text: term }));
      if (res.indices.length) expect(highlightPieces(entries[0].raw, res.highlight).some((p) => p.hit)).toBe(true);
    }
  });

  it('handles a null regex and empty text', () => {
    expect(highlightPieces('abc', null)).toEqual([{ text: 'abc', hit: false }]);
    expect(highlightPieces('', /a/g)).toEqual([{ text: '', hit: false }]);
  });

  it('resets lastIndex so a shared regex gives the same pieces on every call', () => {
    const re = /b/g;
    const first = highlightPieces('abcabc', re, 1);
    expect(highlightPieces('abcabc', re, 1)).toEqual(first);
    expect(first).toEqual([{ text: 'a', hit: false }, { text: 'b', hit: true }, { text: 'cabc', hit: false }]);
  });

  it('is fast with a zero-length regex on 1 MB of text', () => {
    const t0 = performance.now();
    const pieces = highlightPieces('ab'.repeat(500_000), /x*/g);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(pieces).toHaveLength(1);
  });
});

describe('applyFilter consistency (property)', () => {
  it('without a level filter, the sum of counts equals the number of results', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = mulberry32(seed);
      const entries = genEntries(r, 40);
      const filter = randomFilter(r, false);
      const res = applyFilter(entries, filter);
      expect(Object.values(res.counts).reduce((a, b) => a + b, 0)).toBe(res.indices.length);
    }
  });

  it('with a level filter, results are exactly the allowed levels of the counted entries', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = mulberry32(seed);
      const entries = genEntries(r, 40);
      const filter = randomFilter(r, true);
      const res = applyFilter(entries, filter);
      const allowed: readonly Level[] = filter.levels.length ? filter.levels : LEVELS;
      expect(allowed.reduce((n, l) => n + res.counts[l], 0)).toBe(res.indices.length);
      const c = compileFilter(filter);
      const expected = entries.flatMap((e, i) => (c.matchesExceptLevel(e) && c.matchesLevel(e) ? [i] : []));
      expect(res.indices).toEqual(expected);
      // counts don't depend on the level filter
      expect(applyFilter(entries, { ...filter, levels: [] }).counts).toEqual(res.counts);
    }
  });

  it('an extra include term never adds results; a term and its exclusion partition the entries', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = mulberry32(seed);
      const entries = genEntries(r, 40);
      const a = pickOne(r, TOKENS.filter((t) => !t.includes('"')));
      const b = pickOne(r, TOKENS.filter((t) => !t.includes('"') && !t.startsWith('-')));
      const caseSensitive = r() < 0.5;
      const one = new Set(applyFilter(entries, f({ text: `"${a}"`, caseSensitive })).indices);
      const two = applyFilter(entries, f({ text: `"${a}" ${b}`, caseSensitive })).indices;
      for (const i of two) expect(one.has(i)).toBe(true);
      const without = applyFilter(entries, f({ text: `-${b}`, caseSensitive })).indices;
      const withB = applyFilter(entries, f({ text: b, caseSensitive })).indices;
      expect([...withB, ...without].sort((x, y) => x - y)).toEqual(entries.map((_, i) => i));
    }
  });
});

describe('time, trace, logger and source filters', () => {
  const entries = parseText(
    ['banner without time', '{"timestamp":"2026-10-01T10:00:00Z","message":"a","traceId":"T"}', '{"timestamp":"1970-01-01T00:00:00Z","message":"epoch"}', 'continuation-less plain'].join('\n'),
    1,
  );

  it('a leading banner takes the first timestamp of its source; entries with no time at all are excluded by time bounds', () => {
    expect(entries[0].tsMs).toBe(entries[1].tsMs);
    expect(applyFilter(entries, f({ fromMs: -8.64e15 })).indices).toEqual([0, 1, 2, 3]);
    const untimed = parseText('no time here\nnor here', 1);
    expect(untimed.every((e) => Number.isNaN(e.tsMs))).toBe(true);
    expect(applyFilter(untimed, f({ fromMs: -8.64e15 })).indices).toEqual([]);
    expect(applyFilter(untimed, f({ toMs: 8.64e15 })).indices).toEqual([]);
  });

  it('epoch 0 is a real bound, not "unset"', () => {
    expect(isFilterActive(f({ fromMs: 0 }))).toBe(true);
    // the last plain line inherits the epoch-0 timestamp of the line before it
    expect(applyFilter(entries, f({ toMs: 0 })).indices).toEqual([2, 3]);
    expect(applyFilter(entries, f({ fromMs: 0, toMs: 0 })).indices).toEqual([2, 3]);
  });

  it('a NaN bound or an inverted range matches nothing', () => {
    expect(applyFilter(entries, f({ fromMs: Number.NaN })).indices).toEqual([]);
    expect(applyFilter(entries, f({ fromMs: Date.UTC(2027, 0, 1), toMs: Date.UTC(2026, 0, 1) })).indices).toEqual([]);
  });

  it('trace filter is exact; plain lines never match a trace', () => {
    expect(applyFilter(entries, f({ traceId: 'T' })).indices).toEqual([1]);
    expect(applyFilter(entries, f({ traceId: 't' })).indices).toEqual([]);
  });

  it('logger filter with the empty logger selects plain lines', () => {
    expect(applyFilter(entries, f({ loggers: [''] })).indices).toEqual([0, 1, 2, 3]);
  });

  it('hiding a source that does not exist changes nothing', () => {
    expect(applyFilter(entries, f({ hiddenSources: [99] })).indices).toEqual([0, 1, 2, 3]);
  });

  it('isFilterActive edge cases', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive(f({ text: '   ' }))).toBe(false);
    expect(isFilterActive(f({ text: '-' }))).toBe(true);
    expect(isFilterActive(f({ regex: true, caseSensitive: true }))).toBe(false);
    expect(isFilterActive(f({ toMs: 0 }))).toBe(true);
  });

  it('applyFilter on an empty list', () => {
    const res = applyFilter([], f({ text: 'x', levels: ['ERROR'] }));
    expect(res.indices).toEqual([]);
    expect(Object.values(res.counts).every((n) => n === 0)).toBe(true);
  });
});

describe('performance on 50k entries', () => {
  const lines: string[] = [];
  for (let i = 0; i < 50_000; i++) {
    lines.push(JSON.stringify({
      timestamp: new Date(BASE + i * 7).toISOString(), level: ['INFO', 'WARN', 'ERROR', 'DEBUG'][i % 4], loggerName: `com.acme.svc${i % 13}`,
      threadName: `worker-${i % 8}`, message: `request ${i} handled in ${i % 1000}ms user=u${i % 97}`, mdc: { traceId: `t${i % 500}` },
    }));
  }
  const entries = parseText(lines.join('\n'), 1);

  it.each<[string, Partial<FilterState>, number]>([
    ['case-insensitive terms', { text: 'user=u5 -handled "in 3"' }, 200],
    ['regex + level', { text: 'u\\d+7$', regex: true, levels: ['ERROR'] }, 200],
    ['time + trace + logger', { fromMs: BASE + 1000, toMs: BASE + 200_000, traceId: 't7', loggers: ['com.acme.svc7'] }, 200],
    ['case-sensitive terms (recomputes searchText per entry)', { text: 'User', caseSensitive: true }, 1000],
  ])('%s', (_name, patch, limitMs) => {
    applyFilter(entries, f(patch)); // warm up
    const t0 = performance.now();
    applyFilter(entries, f(patch));
    expect(performance.now() - t0).toBeLessThan(limitMs);
  });
});
