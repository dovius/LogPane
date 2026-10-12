import { describe, expect, it } from 'vitest';
import { contextRange, entriesToNdjson, entriesToText, entryToRow, entryToText, stackTraceOf, type RowColumns } from '../../src/core/exportText';
import { parseText } from '../../src/core/parse';

const ALL: RowColumns = { timeMode: 'utc', withDate: false, logger: true, thread: true };
const one = (line: string) => parseText(line, 1)[0];

describe('entryToRow', () => {
  const e = one(JSON.stringify({ timestamp: '2026-10-01T10:00:00.123456Z', level: 'WARN', loggerName: 'com.acme.Svc', threadName: 'main', message: 'slow' }));

  it('writes the visible columns in order', () => {
    expect(entryToRow(e, ALL)).toBe('10:00:00.123\tWARN\tcom.acme.Svc\tmain\tslow');
    expect(entryToRow(e, { ...ALL, withDate: true, source: 'pod-a' })).toBe('10-01 10:00:00.123\tWARN\tpod-a\tcom.acme.Svc\tmain\tslow');
    expect(entryToRow(e, { ...ALL, source: '' }).split('\t')).toHaveLength(6); // an empty label still takes its column
    expect(entryToRow(e, { timeMode: 'utc', withDate: false, logger: false, thread: false })).toBe('10:00:00.123\tWARN\tslow');
  });

  it('entries without a timestamp or level leave those columns empty', () => {
    expect(entryToRow(one('{"message":"no time"}'), ALL)).toBe('\t\t\t\tno time');
    expect(entryToRow(one('just text'), ALL)).toBe('\t\t\t\tjust text');
  });

  // BUG: a tab inside a value is copied verbatim, so the row gets extra columns and no longer lines up when pasted into a spreadsheet
  it('keeps exactly one column per field when values contain tabs', () => {
    const tabbed = one(JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', level: 'INFO', loggerName: 'a.B', threadName: 'pool\t1', message: 'k=v\tk2=v2' }));
    expect(entryToRow(tabbed, ALL).split('\t')).toHaveLength(5);
  });

  it('current behaviour: a multi-line message (folded stack trace) spans several lines of the copied text', () => {
    const [plain] = parseText('2026-10-01 10:00:00 ERROR boom\n\tat a.B.c(B.java:1)\nCaused by: x', 1);
    const row = entryToRow(plain, ALL);
    expect(row.split('\n')).toHaveLength(3);
    expect(row.split('\n')[0]).toBe('10:00:00.000\tERROR\t\t\t2026-10-01 10:00:00 ERROR boom');
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
