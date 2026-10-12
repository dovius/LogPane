import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractEmbeddedJson } from '../src/core/embedded';
import { contextRange, entryToText } from '../src/core/exportText';
import { EMPTY_FILTER, applyFilter, highlightPieces, parseQuery, type FilterState } from '../src/core/filter';
import { mergeEntries } from '../src/core/merge';
import { parseText } from '../src/core/parse';
import { labelForFileName, labelForUrl, parsePodLogUrl, toRawLogUrl, withSinceTime } from '../src/core/sources';
import { createTailState, newLines, recordLines } from '../src/core/tail';
import { compareEntries, formatFull, formatTime, parseTimestamp, parseUserTime } from '../src/core/time';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const sample = parseText(fixture('quarkus-sample.log'), 1);
const other = parseText(fixture('other-service.log'), 2);

describe('time', () => {
  it('parses 7, 8 and 9 fractional digits without losing order', () => {
    expect(parseTimestamp('2026-10-01T13:55:19.1693672Z')).toEqual({ ms: Date.UTC(2026, 9, 1, 13, 55, 19, 169), nanos: 367200 });
    expect(parseTimestamp('2026-10-01T13:55:50.87370206Z')).toEqual({ ms: Date.UTC(2026, 9, 1, 13, 55, 50, 873), nanos: 702060 });
    expect(parseTimestamp('2026-10-01T13:55:50.884532509Z')).toEqual({ ms: Date.UTC(2026, 9, 1, 13, 55, 50, 884), nanos: 532509 });
    // As strings "…50.87370206Z" > "…50.873702061Z" although it is earlier.
    const a = parseText('{"timestamp":"2026-10-01T13:55:50.87370206Z"}', 1)[0];
    const b = parseText('{"timestamp":"2026-10-01T13:55:50.873702061Z"}', 2)[0];
    expect(compareEntries(a, b)).toBeLessThan(0);
  });

  it('parses offsets, missing zones and epoch numbers', () => {
    expect(parseTimestamp('2026-10-01T15:55:52.123+0200')?.ms).toBe(Date.UTC(2026, 9, 1, 13, 55, 52, 123));
    expect(parseTimestamp('2026-10-01 13:55:52,5')?.ms).toBe(Date.UTC(2026, 9, 1, 13, 55, 52, 500));
    expect(parseTimestamp(1759326950)?.ms).toBe(1759326950000);
    expect(parseTimestamp('yesterday')).toBeNull();
  });

  it('formats UTC times with full precision', () => {
    const t = parseTimestamp('2026-10-01T13:55:50.87370206Z')!;
    expect(formatTime(t.ms, 'utc')).toBe('13:55:50.873');
    expect(formatTime(t.ms, 'utc', true)).toBe('10-01 13:55:50.873');
    expect(formatFull(t.ms, t.nanos, 'utc')).toBe('2026-10-01T13:55:50.87370206Z');
  });

  it('parses user time input on the day of the log', () => {
    const ref = Date.UTC(2026, 9, 1, 13, 0, 0);
    expect(parseUserTime('13:55:50', 'utc', ref)).toBe(Date.UTC(2026, 9, 1, 13, 55, 50));
    expect(parseUserTime('13:55:50.5', 'utc', ref)).toBe(Date.UTC(2026, 9, 1, 13, 55, 50, 500));
    expect(parseUserTime('2026-10-02 08:00', 'utc', ref)).toBe(Date.UTC(2026, 9, 2, 8, 0));
    expect(parseUserTime('2026-10-01T13:55:50Z', 'local', ref)).toBe(Date.UTC(2026, 9, 1, 13, 55, 50));
    expect(parseUserTime('nonsense', 'utc', ref)).toBeNull();
  });
});

describe('filter', () => {
  const run = (f: Partial<FilterState>) => applyFilter(sample, { ...EMPTY_FILTER, ...f });
  const lines = (f: Partial<FilterState>) => run(f).indices.map((i) => sample[i].lineNo);

  it('parses queries with phrases and exclusions', () => {
    expect(parseQuery('statusCode "New Order" -cache', false)).toEqual({ include: ['statuscode', 'new order'], exclude: ['cache'] });
  });

  it('ANDs terms, supports phrases, exclusions and exception text', () => {
    expect(lines({ text: 'statusCode 500' })).toEqual([6]);
    expect(lines({ text: '"truncated line"' })).toEqual([7]);
    expect(lines({ text: 'HttpOperationFailedException' })).toEqual([6]);
    expect(lines({ text: 'disk full' })).toEqual([8]);
    expect(run({ text: '-cache' }).indices).toHaveLength(sample.length - 1);
  });

  it('supports case-sensitive and regex search', () => {
    expect(lines({ text: '"route failed"', caseSensitive: true })).toEqual([]);
    expect(lines({ text: '"Route failed"', caseSensitive: true })).toEqual([13]);
    expect(lines({ text: 'ORD-\\d+', regex: true })).toEqual([5]);
    expect(run({ text: '(', regex: true }).error).toBeTruthy();
  });

  it('filters by level while counting the other levels', () => {
    const r = run({ levels: ['ERROR'], text: 'route' });
    expect(r.indices.map((i) => sample[i].lineNo)).toEqual([13]);
    expect(r.counts.INFO).toBe(2); // OrdersRoute logger + create-order-route
    expect(r.counts.ERROR).toBe(1);
  });

  it('filters by trace, logger, source and time', () => {
    expect(lines({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736' })).toEqual([5, 6]);
    expect(lines({ loggers: ['com.example.adapter.routes.OrdersRoute'] })).toEqual([4, 13]);
    expect(lines({ hiddenSources: [1] })).toEqual([]);
    expect(lines({ fromMs: Date.UTC(2026, 9, 1, 13, 55, 51), toMs: Date.UTC(2026, 9, 1, 13, 55, 51, 999) })).toEqual([13, 14]);
  });

  it('splits text into highlight pieces', () => {
    const re = run({ text: '"new order"' }).highlight;
    expect(highlightPieces('Create New Order: {}', re)).toEqual([
      { text: 'Create ', hit: false },
      { text: 'New Order', hit: true },
      { text: ': {}', hit: false },
    ]);
  });
});

describe('merge', () => {
  it('interleaves sources by time', () => {
    const merged = mergeEntries([sample, other]);
    expect(merged).toHaveLength(sample.length + other.length);
    const around = merged.slice(4, 9).map((e) => `${e.sourceId}:${e.lineNo}`);
    expect(around).toEqual(['2:1', '1:5', '2:2', '1:6', '1:7']);
  });

  it('keeps the order within a source even when timestamps go backwards', () => {
    const a = parseText(['{"timestamp":"2026-01-01T00:00:02Z","message":"a1"}', '{"timestamp":"2026-01-01T00:00:01Z","message":"a2"}'].join('\n'), 1);
    const b = parseText('{"timestamp":"2026-01-01T00:00:00Z","message":"b1"}', 2);
    expect(mergeEntries([a, b]).map((e) => e.message)).toEqual(['b1', 'a1', 'a2']);
  });
});

describe('sources', () => {
  const console = 'https://console-openshift-console.apps.c1.example.com';
  const raw = `${console}/api/kubernetes/api/v1/namespaces/shop/pods/my-pod-abc/log?container=app`;

  it('turns console page URLs into raw log URLs', () => {
    expect(toRawLogUrl(`${console}/k8s/ns/shop/pods/my-pod-abc/logs?container=app`)).toBe(raw);
    expect(toRawLogUrl(`${console}/k8s/ns/shop/core~v1~Pod/my-pod-abc/containers/app/logs`)).toBe(raw);
    expect(toRawLogUrl(raw)).toBe(raw);
    expect(toRawLogUrl('/api/kubernetes/api/v1/namespaces/shop/pods/my-pod-abc/log?container=app', console)).toBe(raw);
    expect(toRawLogUrl('not a url')).toBeNull();
  });

  it('labels sources', () => {
    expect(parsePodLogUrl(raw)).toEqual({ namespace: 'shop', pod: 'my-pod-abc', container: 'app' });
    expect(labelForUrl(raw)).toBe('app (abc)');
    expect(labelForUrl(raw.replace('?container=app', ''))).toBe('my-pod-abc');
    expect(labelForFileName('my-pod-abc-app.log')).toBe('my-pod-abc-app');
  });

  it('adds sinceTime one second before the last entry', () => {
    const u = new URL(withSinceTime(raw, Date.UTC(2026, 9, 1, 13, 55, 50, 884)));
    expect(u.searchParams.get('sinceTime')).toBe('2026-10-01T13:55:49Z');
    expect(u.searchParams.get('container')).toBe('app');
  });
});

describe('tail', () => {
  const state = () => {
    const s = createTailState();
    recordLines(s, ['A', 'B', 'C']);
    return s;
  };

  it('cuts the known prefix when the whole log comes back', () => {
    expect(newLines(state(), ['A', 'B', 'C', 'D'])).toEqual(['D']);
    expect(newLines(state(), ['A', 'B', 'C'])).toEqual([]);
  });

  it('skips the overlapping prefix of a sinceTime response', () => {
    expect(newLines(state(), ['B', 'C', 'D', 'E'])).toEqual(['D', 'E']);
    expect(newLines(state(), ['X', 'Y'])).toEqual(['X', 'Y']);
    expect(newLines(state(), ['C', 'C', 'D'])).toEqual(['C', 'D']);
    expect(newLines(createTailState(), ['A'])).toEqual(['A']);
  });
});

describe('embedded JSON', () => {
  it('extracts JSON from a message', () => {
    expect(extractEmbeddedJson('Create New Order: {"orderId":"ORD-1001","n":100}')).toEqual({
      prefix: 'Create New Order: ', value: { orderId: 'ORD-1001', n: 100 }, suffix: '',
    });
    expect(extractEmbeddedJson('payload {"a":"}{","b":[1,2]} done')).toEqual({ prefix: 'payload ', value: { a: '}{', b: [1, 2] }, suffix: ' done' });
    expect(extractEmbeddedJson('items=[{"a":1}]')?.value).toEqual([{ a: 1 }]);
  });

  it('ignores placeholders and bracketed words', () => {
    expect(extractEmbeddedJson('idempotentKey=${file:name}-${file:modified}')).toBeNull();
    expect(extractEmbeddedJson('    [MicroProfilePropertiesSource] camel.main.x = 30')).toBeNull();
    expect(extractEmbeddedJson('thread [2] and {}')).toBeNull();
  });
});

describe('export', () => {
  it('formats an entry with its stack trace', () => {
    const text = entryToText(sample[5], 'utc');
    expect(text.split('\n')[0]).toBe(
      '2026-10-01T13:55:50.884532509Z ERROR [com.example.adapter.processors.ErrorProcessor] (Camel (camel-1) thread #3 - Multicast) {traceId=4bf92f3577b34da6a3ce929d0e0e4736} Connection failure [errorCode=E-1002]: HTTP operation failed with statusCode: 500',
    );
    expect(text).toContain('\nCaused by: org.apache.camel.http.base.HttpOperationFailedException');
    expect(entryToText(sample[7], 'utc', 'pod-a')).toMatch(/^\[pod-a\] Exception in thread/);
  });

  it('computes context windows', () => {
    expect(contextRange(100, 5, 10)).toEqual([0, 16]);
    expect(contextRange(100, 95, 10)).toEqual([85, 100]);
  });
});
