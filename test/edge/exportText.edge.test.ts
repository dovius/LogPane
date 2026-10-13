import { describe, expect, it } from 'vitest';
import { alignRows, contextRange, entriesToNdjson, entriesToText, entryToCells, entryToText, rowsToHtml, stackTraceOf, type RowColumns } from '../../src/core/exportText';
import { parseText } from '../../src/core/parse';

const ALL: RowColumns = { timeMode: 'utc', withDate: false, logger: true, thread: true };
const one = (line: string) => parseText(line, 1)[0];

describe('entryToCells', () => {
  const e = one(JSON.stringify({ timestamp: '2026-10-01T10:00:00.123456Z', level: 'WARN', loggerName: 'com.acme.Svc', threadName: 'main', message: 'slow' }));

  it('gives the visible columns in order', () => {
    expect(entryToCells(e, ALL)).toEqual(['10:00:00.123', 'WARN', 'com.acme.Svc', 'main', 'slow']);
    expect(entryToCells(e, { ...ALL, withDate: true, source: 'pod-a' })).toEqual(['10-01 10:00:00.123', 'WARN', 'pod-a', 'com.acme.Svc', 'main', 'slow']);
    expect(entryToCells(e, { ...ALL, source: '' })).toHaveLength(6); // an empty label still takes its column
    expect(entryToCells(e, { timeMode: 'utc', withDate: false, logger: false, thread: false })).toEqual(['10:00:00.123', 'WARN', 'slow']);
  });

  it('entries without a timestamp or level leave those columns empty', () => {
    expect(entryToCells(one('{"message":"no time"}'), ALL)).toEqual(['', '', '', '', 'no time']);
    expect(entryToCells(one('just text'), ALL)).toEqual(['', '', '', '', 'just text']);
  });

  it('keeps one line per cell except the message, and no tabs anywhere', () => {
    const tabbed = one(JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', level: 'INFO', loggerName: 'a.B', threadName: 'pool\t1\nx', message: 'k=v\tk2=v2' }));
    expect(entryToCells(tabbed, ALL)).toEqual(['10:00:00.000', 'INFO', 'a.B', 'pool 1 x', 'k=v    k2=v2']);
  });
});

describe('alignRows', () => {
  const rows = [
    ['09:18:20.795', 'INFO', 'com.example.orders.api.OrderResource', 'POST /api/orders customer=C-1592'],
    ['09:18:20.799', 'INFO', 'com.example.orders.service.CheckoutService', 'Order created: {"orderId":"ORD-48357"}'],
    ['09:18:25.411', 'DEBUG', 'io.smallrye.health', 'Health check UP (database, kafka)'],
    ['09:18:26.000', '', '', ''],
  ];

  it('lines the columns up with spaces, two between columns', () => {
    expect(alignRows(rows).split('\n')).toEqual([
      '09:18:20.795  INFO   com.example.orders.api.OrderResource        POST /api/orders customer=C-1592',
      '09:18:20.799  INFO   com.example.orders.service.CheckoutService  Order created: {"orderId":"ORD-48357"}',
      '09:18:25.411  DEBUG  io.smallrye.health                          Health check UP (database, kafka)',
      '09:18:26.000', // nothing after the last value: no trailing spaces
    ]);
  });

  it('indents a multi-line message (stack trace) under the message column', () => {
    const [plain] = parseText('2026-10-01 10:00:00 ERROR boom\n\tat a.B.c(B.java:1)\nCaused by: x', 1);
    const lines = alignRows([entryToCells(plain, ALL), ['10:00:01.000', 'INFO', 'a.Long.Logger', 'main', 'next']]).split('\n');
    expect(lines).toHaveLength(4);
    const col = lines[0].indexOf('2026-10-01 10:00:00 ERROR boom');
    expect(lines[1]).toBe(`${' '.repeat(col)}    at a.B.c(B.java:1)`);
    expect(lines[2]).toBe(`${' '.repeat(col)}Caused by: x`);
    expect(lines[3].indexOf('next')).toBe(col);
  });

  it("doesn't pad past 60 characters for one very long value", () => {
    const long = 'x'.repeat(100);
    const lines = alignRows([['a', long, 'm1'], ['b', 'short', 'm2']]).split('\n');
    expect(lines[0]).toBe(`a  ${long}  m1`);
    expect(lines[1]).toBe(`b  ${'short'.padEnd(60)}  m2`);
  });
});

describe('rowsToHtml', () => {
  it('is a table with one cell per column, and escapes everything', () => {
    const html = rowsToHtml([['09:00:00.000', 'INFO', '<img src=x onerror=alert(1)>', 'a & "b"\n\tat c']]);
    expect(html.startsWith('<table')).toBe(true);
    expect(html.match(/<td/g)).toHaveLength(4);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a &amp; &quot;b&quot;\n\tat c');
    expect(html).not.toContain('<img');
  });
});

describe('entryToText', () => {
  it('plain entries are the raw text, optionally with the source label', () => {
    const [plain] = parseText('boom\n\tat a.B.c(B.java:1)', 1);
    expect(entryToText(plain, 'utc')).toBe('boom\n\tat a.B.c(B.java:1)');
    expect(entryToText(plain, 'utc', 'pod a')).toBe('[pod a] boom\n\tat a.B.c(B.java:1)');
    expect(entryToText(plain, 'utc', '')).toBe('boom\n\tat a.B.c(B.java:1)');
  });

  it('JSON entries without any timestamp have no time column', () => {
    expect(entryToText(one('{"level":"INFO","message":"m"}'), 'utc')).toBe('INFO  m');
    expect(entryToText(one('{"message":""}'), 'utc')).toBe('OTHER');
  });

  it('current behaviour: an inherited time is not printed unless the entry had its own (unparseable) time text', () => {
    const [, noTs, badTs] = parseText(['{"timestamp":"2026-10-01T10:00:00Z","message":"a"}', '{"level":"INFO","message":"b"}', '{"timestamp":"10:00","level":"INFO","message":"c"}'].join('\n'), 1);
    expect(noTs.tsInherited).toBe(true);
    expect(entryToText(noTs, 'utc')).toBe('INFO  b');
    expect(entryToText(badTs, 'utc')).toBe('10:00 INFO  c');
  });

  it('keeps newlines and tabs in messages and appends structured and plain stack traces', () => {
    const [structured, stack, kubectl] = parseText(
      [
        JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', level: 'ERROR', loggerName: 'L', threadName: 'T', mdc: { traceId: 'abc' }, message: 'line1\n\tline2', exception: { exceptionType: 'X', message: 'boom', frames: [{ class: 'a.B', method: 'c', line: 3 }] } }),
        JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', level: 'WARN', message: 'm', stack_trace: 'java.lang.Y: y\n\tat q.R.s(R.java:1)' }),
        '2026-10-01T10:00:00.5Z {"level":"info","msg":"k"}',
      ].join('\n'),
      1,
    );
    expect(entryToText(structured, 'utc', 'src')).toBe('[src] 2026-10-01T10:00:00.000Z ERROR [L] (T) {traceId=abc} line1\n\tline2\nX: boom\n\tat a.B.c(B.java:3)');
    expect(entryToText(stack, 'utc')).toBe('2026-10-01T10:00:00.000Z WARN  m\njava.lang.Y: y\n\tat q.R.s(R.java:1)');
    expect(entryToText(kubectl, 'utc')).toBe('2026-10-01T10:00:00.500Z INFO  k');
  });

  it('a structured exception takes precedence over stackText', () => {
    const e = { ...one('{"message":"m"}'), exception: { exceptionType: 'S' }, stackText: 'plain' };
    expect(stackTraceOf(e)).toBe('S');
    expect(stackTraceOf({ ...e, exception: undefined })).toBe('plain');
    expect(stackTraceOf(one('{"message":"m"}'))).toBe('');
  });
});

describe('entriesToText / entriesToNdjson', () => {
  const entries = [...parseText('{"level":"INFO","message":"a"}\nplain\n\tat x.Y(Y.java:1)', 1), ...parseText('{"level":"WARN","message":"b"}', 2)];

  it('joins blocks with newlines and labels only known sources', () => {
    expect(entriesToText(entries, 'utc', new Map([[2, 'two']]))).toBe('INFO  a\nplain\n\tat x.Y(Y.java:1)\n[two] WARN  b');
    expect(entriesToText([], 'utc')).toBe('');
  });

  it('NDJSON export is the raw text, so multi-line plain entries stay multi-line', () => {
    expect(entriesToNdjson(entries)).toBe('{"level":"INFO","message":"a"}\nplain\n\tat x.Y(Y.java:1)\n{"level":"WARN","message":"b"}');
    expect(entriesToNdjson([])).toBe('');
  });
});

describe('contextRange', () => {
  it.each<[number, number, number, [number, number]]>([
    [0, 0, 5, [0, 0]],
    [10, 0, 0, [0, 1]],
    [10, 9, 3, [6, 10]],
    [10, 5, 100, [0, 10]],
    [1, 0, 10, [0, 1]],
  ])('total=%i index=%i n=%i', (total, index, n, expected) => {
    expect(contextRange(total, index, n)).toEqual(expected);
  });

  it('current behaviour: out-of-range input yields an inverted (empty) window', () => {
    expect(contextRange(10, 50, 5)).toEqual([45, 10]);
    expect(contextRange(10, 5, -1)).toEqual([6, 5]);
  });
});
