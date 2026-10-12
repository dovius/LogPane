import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LogParser, looksLikeJsonLog, parseText, parseTextChunked } from '../src/core/parse';
import { formatException, frameCount } from '../src/core/stacktrace';
import { emptyLevelCounts } from '../src/core/types';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const sample = fixture('quarkus-sample.log');

describe('parseText', () => {
  const entries = parseText(sample, 1);

  it('keeps going past broken and plain-text lines', () => {
    expect(entries).toHaveLength(11);
    const counts = emptyLevelCounts();
    for (const e of entries) counts[e.level]++;
    expect(counts).toMatchObject({ ERROR: 2, WARN: 2, INFO: 5, DEBUG: 1, OTHER: 1 });
  });

  it('extracts Quarkus fields', () => {
    const e = entries[4];
    expect(e.lineNo).toBe(5);
    expect(e.level).toBe('INFO');
    expect(e.logger).toBe('create-order-route');
    expect(e.thread).toBe('Camel (camel-1) thread #5 - Multicast');
    expect(e.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(e.spanId).toBe('ff29ae1c6e656bcc');
    expect(e.seq).toBe(104);
    expect(e.tsMs).toBe(Date.UTC(2026, 9, 1, 13, 55, 50, 873));
    expect(e.tsNanos).toBe(702060);
    expect(e.message.startsWith('Create New Order: {')).toBe(true);
  });

  it('keeps the raw line of a broken JSON line and inherits the previous timestamp', () => {
    const broken = entries[6];
    expect(broken.json).toBeUndefined();
    expect(broken.raw).toContain('truncated line');
    expect(broken.tsInherited).toBe(true);
    expect(broken.tsMs).toBe(entries[5].tsMs);
  });

  it('folds plain-text stack trace continuation lines', () => {
    const plain = entries[7];
    expect(plain.lineNo).toBe(8);
    expect(plain.raw.split('\n')).toEqual([
      'Exception in thread "worker-1" java.lang.IllegalStateException: boom',
      '\tat com.example.Main.run(Main.java:10)',
      'Caused by: java.io.IOException: disk full',
      '\t... 3 more',
    ]);
    expect(plain.haystack).toContain('disk full');
    expect(entries[8].lineNo).toBe(13);
  });

  it('understands logstash-style fields', () => {
    const e = entries[10];
    expect(e.level).toBe('WARN');
    expect(e.logger).toBe('com.example.Legacy');
    expect(e.thread).toBe('http-nio-1');
    expect(e.stackText).toContain('java.lang.RuntimeException: slow');
    expect(e.tsMs).toBe(Date.UTC(2026, 9, 1, 13, 55, 52, 123));
  });

  it('indexes exception types, MDC values and custom fields for search', () => {
    expect(entries[5].haystack).toContain('org.apache.camel.http.base.httpoperationfailedexception');
    expect(entries[5].haystack).toContain('10a8b6361caebe91');
    expect(entries[5].haystack).not.toContain('demo-adapter-7d9f8c6b5-x2k4p'); // hostName is boilerplate
  });

  it('parses "<timestamp> {json}" lines', () => {
    const [e] = parseText('2026-10-01T10:00:00.5Z {"level":"error","msg":"boom"}', 1);
    expect(e.json).toBeDefined();
    expect(e.level).toBe('ERROR');
    expect(e.message).toBe('boom');
    expect(e.tsMs).toBe(Date.UTC(2026, 9, 1, 10, 0, 0, 500));
  });

  it('maps numeric pino levels', () => {
    const [e] = parseText('{"level":50,"time":1759312800000,"msg":"x"}', 1);
    expect(e.level).toBe('ERROR');
    expect(e.tsMs).toBe(1759312800000);
  });
});

describe('other formats', () => {
  it('unwraps Docker json-file lines', () => {
    const [jsonInner, plainInner] = parseText(
      [
        JSON.stringify({ log: '{"level":"warn","msg":"disk 91%","reqId":"r-1"}\n', stream: 'stdout', time: '2026-10-01T10:00:00.123456789Z' }),
        JSON.stringify({ log: '2026-10-01 10:00:01 ERROR boom\n', stream: 'stderr', time: '2026-10-01T10:00:01Z' }),
      ].join('\n'),
      1,
    );
    expect(jsonInner).toMatchObject({ level: 'WARN', message: 'disk 91%', traceId: 'r-1', tsNanos: 456789 });
    expect(jsonInner.tsMs).toBe(Date.UTC(2026, 9, 1, 10, 0, 0, 123));
    expect(plainInner).toMatchObject({ level: 'ERROR', message: '2026-10-01 10:00:01 ERROR boom' });
  });

  it('reads Spring Boot GELF, ECS and logstash structured logging', () => {
    const [gelf, ecs, logstash] = parseText(
      [
        JSON.stringify({ version: '1.1', short_message: 'Started', timestamp: 1759312800.5, level: 3, _level_name: 'ERROR', _process_thread_name: 'main', host: 'h', _log_logger: 'org.example.App', _error_stack_trace: 'java.lang.X: y\n\tat a.B.c(B.java:1)' }),
        JSON.stringify({ '@timestamp': '2026-10-01T10:00:00.5Z', 'log.level': 'WARN', 'process.thread.name': 'main', 'log.logger': 'org.example.App', message: 'ecs', 'trace.id': 't-1', 'error.stack_trace': 'boom' }),
        JSON.stringify({ '@timestamp': '2026-10-01T12:00:00.5+02:00', '@version': '1', message: 'logstash', logger_name: 'org.example.App', thread_name: 'main', level: 'INFO', level_value: 20000 }),
      ].join('\n'),
      1,
    );
    expect(gelf).toMatchObject({ level: 'ERROR', message: 'Started', logger: 'org.example.App', thread: 'main', tsMs: 1759312800500 });
    expect(gelf.stackText).toContain('java.lang.X: y');
    expect(parseText(JSON.stringify({ version: '1.1', short_message: 'x', host: 'h', level: 4 }), 1)[0].level).toBe('WARN');
    expect(ecs).toMatchObject({ level: 'WARN', logger: 'org.example.App', thread: 'main', traceId: 't-1', stackText: 'boom' });
    expect(logstash).toMatchObject({ level: 'INFO', logger: 'org.example.App', tsMs: Date.UTC(2026, 9, 1, 10, 0, 0, 500) });
  });

  it('links entries by correlation or request id when there is no trace id', () => {
    const [a, b, c] = parseText(
      ['{"msg":"a","correlationId":"c-9"}', '{"msg":"b","mdc":{"requestId":"r-2"}}', '{"msg":"c","traceId":"t","correlationId":"c"}'].join('\n'),
      1,
    );
    expect([a.traceId, b.traceId, c.traceId]).toEqual(['c-9', 'r-2', 't']);
  });

  it('reads winston and bunyan lines', () => {
    const [winston, bunyan] = parseText(
      ['{"level":"error","message":"failed","timestamp":"2026-10-01T10:00:00.000Z"}', '{"name":"api","hostname":"h","pid":1,"level":40,"msg":"slow","time":"2026-10-01T10:00:00.000Z","v":0}'].join('\n'),
      1,
    );
    expect(winston).toMatchObject({ level: 'ERROR', message: 'failed' });
    expect(bunyan).toMatchObject({ level: 'WARN', message: 'slow' });
  });
});

describe('incremental parsing', () => {
  it('chunked parsing gives the same result as sync parsing', async () => {
    const sync = parseText(sample, 1);
    const chunked = await parseTextChunked(sample, new LogParser(1), undefined, 3);
    expect(chunked.map((e) => [e.lineNo, e.raw])).toEqual(sync.map((e) => [e.lineNo, e.raw]));
  });

  it('continues line numbers and folds continuations across pushes', () => {
    const p = new LogParser(1);
    const first = p.pushLines(['plain error', '\tat a.B.c(B.java:1)']);
    const second = p.pushLines(['\tat a.B.d(B.java:2)', '{"level":"INFO","message":"next"}']);
    expect(first).toHaveLength(1);
    expect(first[0].raw.split('\n')).toHaveLength(3);
    expect(second).toHaveLength(1);
    expect(second[0].lineNo).toBe(4);
  });
});

describe('looksLikeJsonLog', () => {
  it('detects JSON logs', () => {
    expect(looksLikeJsonLog(sample)).toBe(true);
    expect(looksLikeJsonLog('hello\nworld\n{"a":1}')).toBe(false);
    expect(looksLikeJsonLog('')).toBe(false);
  });
});

describe('stack traces', () => {
  const entries = parseText(sample, 1);

  it('renders a Quarkus cause chain as a Java stack trace', () => {
    expect(formatException(entries[5].exception)).toBe(
      [
        'com.example.adapter.exception.DownstreamException: HTTP operation failed invoking http://inventory.svc:8080/stock with statusCode: 500',
        'Caused by: org.apache.camel.http.base.HttpOperationFailedException: HTTP operation failed invoking http://inventory.svc:8080/stock with statusCode: 500',
        '\tat org.apache.camel.component.http.HttpProducer.populateHttpOperationFailedException(HttpProducer.java:466)',
        '\tat org.apache.camel.component.http.HttpProducer.lambda$process$1(HttpProducer.java:284)',
        '\tat org.apache.camel.impl.engine.DefaultReactiveExecutor$Worker.doRun(DefaultReactiveExecutor.java:199)',
        '\tat java.lang.Thread.run(Thread.java:1583)',
      ].join('\n'),
    );
    expect(frameCount(entries[5].exception)).toBe(4);
  });

  it('handles unknown/native lines, suppressed exceptions and circular references', () => {
    expect(formatException(entries[8].exception)).toBe(
      [
        'java.lang.IllegalStateException: Route failed',
        '\tat com.example.adapter.routes.OrdersRoute.configure(Unknown Source)',
        '\tat jdk.internal.misc.Unsafe.park(Native Method)',
        '\tSuppressed: java.io.IOException: close failed',
        '\t\tat com.example.Io.close(Io.java:12)',
        'Caused by: [CIRCULAR REFERENCE: refId=1]',
      ].join('\n'),
    );
  });
});

// Optional check against a real log: LV_REAL_LOG=/path/to/pod.log npm test
const realLog = process.env.LV_REAL_LOG;
describe.skipIf(!realLog)('real log file', () => {
  it('parses every line', () => {
    const text = readFileSync(realLog!, 'utf8');
    const entries = parseText(text, 1);
    const counts = emptyLevelCounts();
    for (const e of entries) counts[e.level]++;
    console.log(entries.length, counts);
    expect(entries.every((e) => e.json)).toBe(true);
  });
});
