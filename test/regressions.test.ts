// Regression tests for bugs found by the end-to-end suites and performance checks.
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, REGEX_SUBJECT_LIMIT, REGEX_TOO_SLOW, applyFilter, type FilterState } from '../src/core/filter';
import { parseText, searchText } from '../src/core/parse';

const f = (patch: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTER, ...patch });

describe('plain-text Java logs', () => {
  it('folds the exception line that follows a log line (logback / log4j layout)', () => {
    const entries = parseText(
      [
        '2026-10-01 09:00:01,000 ERROR [main] c.e.App - Boom',
        'java.lang.IllegalStateException: boom',
        '\tat com.example.App.run(App.java:10)',
        'Caused by: java.io.IOException: disk full',
        'com.example.CustomError',
        '2026-10-01 09:00:02,000 WARN  [main] c.e.App - Recovered',
      ].join('\n'),
      1,
    );
    expect(entries.map((e) => e.level)).toEqual(['ERROR', 'WARN']);
    expect(entries[0].raw.split('\n')).toHaveLength(5);
  });

  it('keeps "Exception in thread" and exceptions after JSON lines as their own entries', () => {
    const entries = parseText(['{"level":"INFO","message":"json"}', 'java.lang.RuntimeException: printed by e.printStackTrace()', 'plain', 'Exception in thread "main" java.lang.Error: x'].join('\n'), 1);
    expect(entries.map((e) => e.raw.split('\n')[0])).toEqual([
      '{"level":"INFO","message":"json"}',
      'java.lang.RuntimeException: printed by e.printStackTrace()',
      'plain',
      'Exception in thread "main" java.lang.Error: x',
    ]);
  });

  it('does not treat ordinary words ending in Error as exception lines', () => {
    const entries = parseText(['plain line', 'ConnectionError happened', 'my.pkg.notAnException'].join('\n'), 1);
    expect(entries).toHaveLength(3);
  });
});

describe('container runtime (CRI) node logs', () => {
  it('unwraps "<ts> stdout F <json>" lines', () => {
    const [e] = parseText('2026-10-01T10:00:00.123456789Z stdout F {"level":"warn","msg":"from cri"}', 1);
    expect(e).toMatchObject({ level: 'WARN', message: 'from cri', tsNanos: 456789 });
    expect(e.tsMs).toBe(Date.UTC(2026, 9, 1, 10, 0, 0, 123));
  });
});

describe('regex search safety', () => {
  const lines = ['alpha foo', 'beta', 'x\nfoo on a second line', 'gamma foo bar', 'Foo upper', ''];
  const entries = parseText(lines.map((l) => JSON.stringify({ level: 'INFO', message: l })).join('\n'), 1);

  it('anchoring a leading .* / .+ never changes the result', () => {
    for (const src of ['.*foo', '.+foo', '.*foo bar', '.+o', '.*', '.*?foo', '.*foo|beta', '.*(foo)$']) {
      for (const caseSensitive of [false, true]) {
        const got = applyFilter(entries, f({ text: src, regex: true, caseSensitive })).indices;
        const re = new RegExp(src, caseSensitive ? '' : 'i');
        const expected = entries.flatMap((e, i) => (re.test(caseSensitive ? searchText(e) : e.haystack) ? [i] : []));
        expect(got, `${src} ${caseSensitive}`).toEqual(expected);
      }
    }
  });

  it('a leading .* over many entries stays fast', () => {
    const big = parseText(Array.from({ length: 20_000 }, (_, i) => JSON.stringify({ level: 'INFO', message: `processed message #${i} ${'payload '.repeat(30)}` })).join('\n'), 1);
    const t = performance.now();
    const r = applyFilter(big, f({ text: '.*nomatch', regex: true }));
    expect(r.indices).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('stops a catastrophically slow pattern with a clear error instead of freezing', () => {
    const big = parseText(Array.from({ length: 20_000 }, () => JSON.stringify({ level: 'INFO', message: 'a'.repeat(400) })).join('\n'), 1);
    const t = performance.now();
    const r = applyFilter(big, f({ text: 'a.*a.*a.*b', regex: true }));
    expect(r.error).toBe(REGEX_TOO_SLOW);
    expect(r.indices).toEqual([]);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('only the first REGEX_SUBJECT_LIMIT characters of an entry are searched by a regex', () => {
    const long = parseText(JSON.stringify({ level: 'INFO', message: `${'x'.repeat(REGEX_SUBJECT_LIMIT + 10)}needle` }), 1);
    expect(applyFilter(long, f({ text: 'needle', regex: true })).indices).toEqual([]);
    expect(applyFilter(long, f({ text: 'needle' })).indices).toEqual([0]); // plain search sees everything
  });
});

describe('when Reload / Tail fall back to reloading the page', () => {
  it('any failure to re-read the page except a real HTTP answer (404 / 5xx)', async () => {
    const { isRejected } = await import('../src/ui/store');
    const src = (errorStatus?: number, status: 'error' | 'ready' = 'error') => ({ status, errorStatus }) as Parameters<typeof isRejected>[0];
    expect(isRejected(src(undefined))).toBe(true); // network / CORS (file://), login page instead of the log
    expect(isRejected(src(401))).toBe(true);
    expect(isRejected(src(403))).toBe(true);
    expect(isRejected(src(404))).toBe(false);
    expect(isRejected(src(500))).toBe(false);
    expect(isRejected(src(undefined, 'ready'))).toBe(false);
    expect(isRejected(undefined)).toBe(false);
  });
});
