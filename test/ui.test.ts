// Pure helpers behind the details panel: field grouping, stack trace rendering, wrapping.
import { describe, expect, it } from 'vitest';
import { parseText } from '../src/core/parse';
import { groupFields, layoutRows, nameColumnWidth, splitPlainStack, type FieldRow } from '../src/ui/fieldGroups';
import { breakAtDots, parseStackLine, readableTimestamp, stackLineKind, stackParts } from '../src/ui/format';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const entry = (obj: object) => parseText(JSON.stringify(obj), 1)[0];
const labels = (rows: FieldRow[]) => rows.map((r) => r.label);

describe('groupFields', () => {
  const quarkus = entry({
    timestamp: '2026-10-01T09:30:01.000Z', sequence: 2, loggerName: 'com.example.Checkout', level: 'ERROR', threadName: 'executor-thread-1', message: 'Checkout failed',
    mdc: { traceId: TRACE, spanId: '318d2baa07406069', sampled: 'true', userId: 'C-1628', empty: '' },
    ndc: '', hostName: 'orders-6f7c9d8b4-x2k4p', processName: '/usr/bin/java', processId: 1,
    exception: { refId: 1, exceptionType: 'java.lang.IllegalStateException', message: 'boom', frames: [] },
  });

  it('splits MDC and fields into trace ids, context and host / process bookkeeping', () => {
    const g = groupFields(quarkus);
    expect(labels(g.trace)).toEqual(['traceId', 'spanId', 'sampled']);
    expect(labels(g.context)).toEqual(['userId']);
    expect(labels(g.process)).toEqual(['hostName', 'processName', 'processId']);
  });

  it('leaves out what the panel shows elsewhere and empty values', () => {
    const all = Object.values(groupFields(quarkus)).flat().map((r) => r.key);
    for (const key of ['timestamp', 'sequence', 'loggerName', 'level', 'threadName', 'message', 'exception', 'mdc', 'ndc', 'mdc.empty']) expect(all).not.toContain(key);
  });

  it('marks the entry traceId as a trace link, other strings and numbers as searchable', () => {
    const g = groupFields(quarkus);
    expect(g.trace[0]).toMatchObject({ key: 'mdc.traceId', value: TRACE, action: 'trace' });
    expect(g.trace[1].action).toBe('search');
    expect(g.process.find((r) => r.label === 'processId')?.action).toBe('search');
    const short = groupFields(entry({ message: 'm', ok: true, id: 'ab' })).context;
    expect(short.map((r) => r.action)).toEqual([undefined, undefined]);
  });

  it('flattens nested objects to dotted keys and keeps arrays of values whole', () => {
    const g = groupFields(entry({ message: 'POST /api/orders 201', context: { request: { method: 'POST', query: { dryRun: false } }, response: { status: 201 } }, tags: ['http', 'public'], region: null, extra: {} }));
    expect(g.context.map((r) => [r.label, r.value])).toEqual([
      ['context.request.method', 'POST'],
      ['context.request.query.dryRun', false],
      ['context.response.status', 201],
      ['tags', ['http', 'public']],
      ['region', null],
    ]);
  });

  it('shows an id found both in MDC and at the top level once', () => {
    const g = groupFields(entry({ message: 'm', traceId: TRACE, mdc: { traceId: TRACE } }));
    expect(g.trace).toHaveLength(1);
    expect(g.trace[0].action).toBe('trace');
  });

  it('prefixes an MDC key only when a top-level field has the same name', () => {
    const g = groupFields(entry({ message: 'm', tenant: 'top', mdc: { tenant: 'mdc', userId: 'u-1' } }));
    expect(labels(g.context)).toEqual(['mdc.tenant', 'userId', 'tenant']);
  });

  it('names nested ids by their own key, dotted id fields keep their name', () => {
    const g = groupFields(entry({ message: 'm', context: { headers: { 'x-request-id': 'req-7f3a' } }, 'trace.id': 'abc123def4567890' }));
    expect(g.trace.map((r) => [r.key, r.label])).toEqual([
      ['context.headers.x-request-id', 'x-request-id'],
      ['trace.id', 'trace.id'],
    ]);
  });

  it('has nothing to group for plain-text entries', () => {
    expect(groupFields(parseText('2026-10-01 09:00:00 INFO plain text', 1)[0])).toEqual({ trace: [], context: [], process: [] });
  });
});

describe('layoutRows', () => {
  const rows = (...names: string[]): FieldRow[] => names.map((label) => ({ key: label, label, value: 1 }));
  const shape = (names: string[]) =>
    layoutRows(rows(...names)).map((it) => (it.kind === 'group' ? `[${it.path}]` : it.nested ? `  ${it.name}` : it.name));

  it('puts rows that share a parent object under one heading', () => {
    expect(shape(['context.request.method', 'context.request.path', 'context.request.query.dryRun', 'context.response.status', 'context.response.bytes', 'tags'])).toEqual([
      '[context.request]', '  method', '  path', '  query.dryRun',
      '[context.response]', '  status', '  bytes',
      'tags',
    ]);
  });

  it('keeps the full name of a lone nested value', () => {
    expect(shape(['http.request.method', 'url.full', 'service.name', 'service.version'])).toEqual(['http.request.method', 'url.full', '[service]', '  name', '  version']);
  });

  it('sizes the name column from the longest name, the same for every list', () => {
    const a = layoutRows(rows('traceId', 'parentId'));
    const b = layoutRows(rows('context.request.method', 'context.request.path'));
    expect(nameColumnWidth([a])).toBe(8);
    expect(nameColumnWidth([a, b])).toBe(8); // "  method"
    expect(nameColumnWidth([a], ['Sequence', 'loggerClassName'])).toBe(15);
    expect(nameColumnWidth([layoutRows(rows('a.very.long.dotted.name.that.goes.on'))])).toBe(22);
  });
});

describe('splitPlainStack', () => {
  it('splits a folded Java entry into its first line and the stack trace', () => {
    const raw = '2026-10-01 09:00:01,000 ERROR [main] c.e.App - Boom\njava.lang.IllegalStateException: boom\n\tat com.example.App.run(App.java:10)\nCaused by: java.io.IOException: disk full\n\t... 2 more';
    expect(splitPlainStack(raw)).toEqual({ message: '2026-10-01 09:00:01,000 ERROR [main] c.e.App - Boom', stack: raw.slice(raw.indexOf('\n') + 1) });
  });

  it('leaves other multi-line text and single lines alone', () => {
    expect(splitPlainStack('first line\nsecond line of prose')).toBeNull();
    expect(splitPlainStack('one line only')).toBeNull();
  });
});

describe('stack trace lines', () => {
  const stack = [
    'com.example.PaymentDeclinedException: declined',
    '\tat com.example.Checkout.run(Checkout.java:42)',
    '\tat io.quarkus.runtime.A.a(A.java:1)',
    '\tat io.vertx.core.B.b(B.java:2)',
    '\tat java.lang.Thread.run(Thread.java:1583)',
    'Caused by: java.io.IOException: closed',
    '\tat org.jboss.C.c(C.java:3)',
    '\tat java.base/sun.nio.D.d(D.java:4)',
    '\t... 52 common frames omitted',
  ].join('\n');

  it('tells exception lines, application and framework frames apart', () => {
    expect(stack.split('\n').map(stackLineKind)).toEqual(['exception', 'app', 'framework', 'framework', 'framework', 'exception', 'framework', 'framework', 'other']);
  });

  it('folds runs of three or more framework frames', () => {
    const parts = stackParts(stack);
    expect(parts.map((p) => (p.kind === 'fold' ? `fold ${p.lines.length}` : p.line))).toEqual(['exception', 'app', 'fold 3', 'exception', 'framework', 'framework', 'other']);
    expect(stackParts(stack, 99).some((p) => p.kind === 'fold')).toBe(false);
  });

  it('parses frames, exception lines and the rest', () => {
    expect(parseStackLine('\tat com.example.Checkout.run(Checkout.java:42)')).toEqual({ kind: 'frame', method: 'com.example.Checkout.run', location: '(Checkout.java:42)' });
    expect(parseStackLine('\tat java.base/sun.nio.D.d(D.java:4)')).toMatchObject({ method: 'java.base/sun.nio.D.d' });
    expect(parseStackLine('Caused by: java.sql.SQLException: HikariPool-1 - timeout: 30000ms')).toEqual({ kind: 'exception', prefix: 'Caused by: ', type: 'java.sql.SQLException', message: 'HikariPool-1 - timeout: 30000ms' });
    expect(parseStackLine('\tSuppressed: java.io.IOException: closed')).toMatchObject({ kind: 'exception', prefix: '\tSuppressed: ', type: 'java.io.IOException' });
    expect(parseStackLine('java.lang.OutOfMemoryError')).toEqual({ kind: 'exception', prefix: '', type: 'java.lang.OutOfMemoryError', message: '' });
    expect(parseStackLine('\t... 4 more')).toEqual({ kind: 'other', text: '... 4 more' });
    expect(parseStackLine('continuation of a multi-line message')).toEqual({ kind: 'other', text: 'continuation of a multi-line message' });
  });
});

describe('breakAtDots', () => {
  it('adds break points after dots and slashes of long tokens, and before "("', () => {
    expect(breakAtDots('com.example.orders.service.CheckoutService')).toEqual(['com.', null, 'example.', null, 'orders.', null, 'service.', null, 'CheckoutService']);
    expect(breakAtDots('a.b.C.run(C.java:12)', 1)).toEqual(['a.', null, 'b.', null, 'C.', null, 'run', null, '(C.', null, 'java:12)']);
    expect(breakAtDots('see https://example.com/api/v2/templates').join('')).toBe('see https://example.com/api/v2/templates');
  });

  it('leaves short tokens, prose and huge texts alone', () => {
    expect(breakAtDots('Order ORD-1 created in 3.5 s')).toEqual(['Order ORD-1 created in 3.5 s']);
    expect(breakAtDots('')).toEqual(['']);
    const huge = 'x.'.repeat(3000);
    expect(breakAtDots(huge)).toEqual([huge]);
  });
});

describe('readableTimestamp', () => {
  it('spells out the zone', () => {
    expect(readableTimestamp('2026-10-01T09:30:01.000123456Z')).toBe('2026-10-01 09:30:01.000123456 UTC');
    expect(readableTimestamp('2026-10-01T12:30:01.000+03:00')).toBe('2026-10-01 12:30:01.000 UTC+03:00');
  });
});
