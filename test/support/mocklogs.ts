// Deterministic mock logs for the end-to-end tests: realistic services, every supported format,
// and nasty edge cases. Nothing here comes from a real system.

/** Small seeded PRNG (mulberry32), so generated logs are identical on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const hex = (r: () => number, n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');

/** ISO timestamp with `digits` fractional digits (Quarkus writes 7–9). */
export function iso(ms: number, digits = 9, extra = 0): string {
  const base = new Date(ms).toISOString().slice(0, 23); // …HH:mm:ss.SSS
  const frac = `${base.slice(20)}${String(extra).padStart(6, '0')}`.slice(0, digits);
  return `${base.slice(0, 19)}.${frac}Z`;
}

const T0 = Date.parse('2026-10-01T09:00:00.000Z');

export interface QuarkusLine {
  ms: number;
  level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  logger: string;
  message: string;
  thread?: string;
  traceId?: string;
  spanId?: string;
  exception?: unknown;
  digits?: number;
  seq?: number;
}

export function quarkusLine(l: QuarkusLine, host = 'orders-6f7c9d8b4-x2k4p'): string {
  return JSON.stringify({
    timestamp: iso(l.ms, l.digits ?? 9, (l.seq ?? 0) % 1_000_000),
    sequence: l.seq ?? 0,
    loggerClassName: 'org.jboss.logging.Logger',
    loggerName: l.logger,
    level: l.level,
    message: l.message,
    threadName: l.thread ?? 'executor-thread-1',
    threadId: 31,
    mdc: l.traceId ? { traceId: l.traceId, spanId: l.spanId ?? '00f067aa0ba902b7', sampled: 'true' } : {},
    ndc: '',
    hostName: host,
    processName: '/usr/lib/jvm/java-21-openjdk/bin/java',
    processId: 1,
    ...(l.exception ? { exception: l.exception } : {}),
  });
}

export function quarkusException(type: string, message: string, cause?: { type: string; message: string }): unknown {
  return {
    refId: 1,
    exceptionType: type,
    message,
    frames: [
      { class: 'com.example.orders.service.CheckoutService', method: 'checkout', line: 142 },
      { class: 'com.example.orders.api.OrderResource', method: 'placeOrder', line: 61 },
      { class: 'io.quarkus.vertx.core.runtime.VertxCoreRecorder$14', method: 'runWith', line: 635 },
      { class: 'java.lang.Thread', method: 'run', line: 1583 },
    ],
    ...(cause
      ? {
          causedBy: {
            exception: {
              refId: 2,
              exceptionType: cause.type,
              message: cause.message,
              frames: [{ class: 'com.example.orders.payment.PaymentClient', method: 'charge', line: 88 }],
            },
          },
        }
      : {}),
  };
}

export const KNOWN_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

/**
 * A realistic service log with a known shape, for asserting counts in the UI:
 * `n` request cycles, one every 300 ms, each INFO "POST", INFO "Order created: {json}", INFO "201 Created".
 * Every 10th cycle adds WARN "slow", every 25th adds ERROR with a structured exception.
 * Cycle 7 uses KNOWN_TRACE. A DEBUG health line follows every 5th cycle.
 */
export function ordersService(n = 100, seed = 1): { text: string; counts: Record<string, number>; total: number } {
  const r = rng(seed);
  const lines: string[] = [];
  const counts: Record<string, number> = { INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
  let seq = 1000;
  const push = (l: QuarkusLine) => {
    lines.push(quarkusLine({ ...l, seq: seq++ }));
    counts[l.level]++;
  };
  for (let i = 0; i < n; i++) {
    const ms = T0 + i * 300;
    const traceId = i === 7 ? KNOWN_TRACE : hex(r, 32);
    const orderId = `ORD-${10000 + i}`;
    push({ ms, level: 'INFO', logger: 'com.example.orders.api.OrderResource', message: `POST /api/orders customer=C-${1000 + Math.floor(r() * 900)}`, traceId });
    push({ ms: ms + 3, level: 'INFO', logger: 'com.example.orders.service.CheckoutService', message: `Order created: ${JSON.stringify({ orderId, sku: pick(r, ['SKU-1', 'SKU-2', 'SKU-3']), qty: 1 + (i % 3) })}`, traceId, digits: [7, 8, 9][i % 3] });
    if (i % 10 === 9) push({ ms: ms + 50, level: 'WARN', logger: 'com.example.orders.payment.PaymentClient', message: `Payment call took ${1500 + i} ms for ${orderId}`, traceId });
    if (i % 25 === 24) {
      push({
        ms: ms + 60, level: 'ERROR', logger: 'com.example.orders.service.CheckoutService', message: `Checkout failed for ${orderId}: payment declined`, traceId,
        exception: quarkusException('com.example.orders.payment.PaymentDeclinedException', `Payment for order ${orderId} was declined`, { type: 'org.jboss.resteasy.reactive.ClientWebApplicationException', message: 'Payment Required, status code 402' }),
      });
    }
    push({ ms: ms + 90, level: 'INFO', logger: 'com.example.orders.api.OrderResource', message: `201 Created ${orderId} in ${40 + (i % 50)} ms`, traceId });
    if (i % 5 === 4) push({ ms: ms + 150, level: 'DEBUG', logger: 'io.smallrye.health', message: 'Health check UP', thread: 'vert.x-eventloop-thread-0' });
  }
  return { text: `${lines.join('\n')}\n`, counts, total: lines.length };
}

/** A second service sharing KNOWN_TRACE, in logstash format (Spring Boot), with timestamps interleaving ordersService. */
export function paymentsService(): { text: string; total: number } {
  const lines = [
    { '@timestamp': new Date(T0 + 7 * 300 + 1).toISOString(), message: 'Charge request for ORD-10007', logger_name: 'com.example.payments.ChargeController', thread_name: 'http-nio-8080-exec-1', level: 'INFO', traceId: KNOWN_TRACE },
    { '@timestamp': new Date(T0 + 7 * 300 + 2).toISOString(), message: 'Card declined for ORD-10007: insufficient_funds', logger_name: 'com.example.payments.ChargeController', thread_name: 'http-nio-8080-exec-1', level: 'ERROR', traceId: KNOWN_TRACE, stack_trace: 'com.example.payments.CardDeclinedException: insufficient_funds\n\tat com.example.payments.ProviderClient.charge(ProviderClient.java:77)' },
    { '@timestamp': new Date(T0 + 40 * 300).toISOString(), message: 'Settlement batch done', logger_name: 'com.example.payments.Settlement', thread_name: 'scheduler-1', level: 'INFO' },
  ].map((o) => JSON.stringify(o));
  return { text: `${lines.join('\n')}\n`, total: lines.length };
}

/** One line per supported format; `expect` describes what the viewer must show. */
export const FORMAT_LINES: { name: string; line: string; expect: { level: string; message: string; logger?: string } }[] = [
  { name: 'quarkus', line: quarkusLine({ ms: T0, level: 'INFO', logger: 'io.quarkus', message: 'Quarkus started' }), expect: { level: 'INFO', message: 'Quarkus started', logger: 'io.quarkus' } },
  { name: 'logstash', line: JSON.stringify({ '@timestamp': '2026-10-01T09:00:01.000+00:00', '@version': '1', message: 'Logstash line', logger_name: 'org.example.Logstash', thread_name: 'main', level: 'WARN', level_value: 30000 }), expect: { level: 'WARN', message: 'Logstash line', logger: 'org.example.Logstash' } },
  { name: 'ecs', line: JSON.stringify({ '@timestamp': '2026-10-01T09:00:02.000Z', 'log.level': 'ERROR', message: 'ECS line', 'log.logger': 'org.example.Ecs', 'process.thread.name': 'main', 'error.stack_trace': 'java.lang.IllegalStateException: ecs\n\tat a.B.c(B.java:1)' }), expect: { level: 'ERROR', message: 'ECS line', logger: 'org.example.Ecs' } },
  { name: 'gelf', line: JSON.stringify({ version: '1.1', host: 'h', short_message: 'GELF line', timestamp: (T0 + 3000) / 1000, level: 4, _log_logger: 'org.example.Gelf' }), expect: { level: 'WARN', message: 'GELF line', logger: 'org.example.Gelf' } },
  { name: 'pino', line: JSON.stringify({ level: 50, time: T0 + 4000, pid: 1, hostname: 'h', msg: 'Pino line' }), expect: { level: 'ERROR', message: 'Pino line' } },
  { name: 'bunyan', line: JSON.stringify({ name: 'api', hostname: 'h', pid: 1, level: 30, msg: 'Bunyan line', time: '2026-10-01T09:00:05.000Z', v: 0 }), expect: { level: 'INFO', message: 'Bunyan line' } },
  { name: 'winston', line: JSON.stringify({ level: 'debug', message: 'Winston line', timestamp: '2026-10-01T09:00:06.000Z' }), expect: { level: 'DEBUG', message: 'Winston line' } },
  { name: 'docker-json', line: JSON.stringify({ log: '{"level":"warn","msg":"Docker inner line"}\n', stream: 'stdout', time: '2026-10-01T09:00:07.000000000Z' }), expect: { level: 'WARN', message: 'Docker inner line' } },
  { name: 'docker-plain', line: JSON.stringify({ log: '2026-10-01 09:00:08 ERROR Docker plain line\n', stream: 'stderr', time: '2026-10-01T09:00:08.000Z' }), expect: { level: 'ERROR', message: '2026-10-01 09:00:08 ERROR Docker plain line' } },
  { name: 'kubectl-timestamps', line: '2026-10-01T09:00:09.123456789Z {"level":"INFO","message":"Kubectl prefixed line"}', expect: { level: 'INFO', message: 'Kubectl prefixed line' } },
  { name: 'plain', line: '2026-10-01 09:00:10,000 WARN  [main] o.e.Plain - Plain text line', expect: { level: 'WARN', message: '2026-10-01 09:00:10,000 WARN  [main] o.e.Plain - Plain text line' } },
];

/** Tricky content. Each must render as text and never break the page. */
export const EDGE_LINES = {
  xssMessage: JSON.stringify({ timestamp: iso(T0), level: 'ERROR', message: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>', loggerName: '<b onmouseover=alert(1)>x</b>' }),
  xssKeys: JSON.stringify({ timestamp: iso(T0), level: 'INFO', message: 'keys', '<svg onload=window.__pwned=3>': 'v', mdc: { '"><img src=y onerror=window.__pwned=4>': 'z' } }),
  protoKeys: '{"timestamp":"2026-10-01T09:00:00Z","level":"INFO","message":"proto","__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
  unicode: JSON.stringify({ timestamp: iso(T0 + 1), level: 'INFO', message: 'Ąžuolas čiurlena ėžerą 💥 日本語 עברית العربية zero​width', loggerName: 'lt.ąčęėįšųūž.Žurnalas' }),
  longMessage: JSON.stringify({ timestamp: iso(T0 + 2), level: 'INFO', message: `LONG ${'x'.repeat(200_000)} END` }),
  deepJson: `{"timestamp":"2026-10-01T09:00:00.003Z","level":"INFO","message":"deep","data":${'['.repeat(3000)}${']'.repeat(3000)}}`,
  numberMessage: '{"timestamp":"2026-10-01T09:00:00.004Z","level":"INFO","message":12345}',
  objectMessage: '{"timestamp":"2026-10-01T09:00:00.005Z","level":"INFO","message":{"nested":{"a":[1,2,3]}}}',
  nullFields: '{"timestamp":null,"level":null,"message":null,"loggerName":null}',
  noTimestamp: '{"level":"WARN","message":"no timestamp here"}',
  brokenJson: '{"timestamp":"2026-10-01T09:00:00.006Z","level":"ERROR","message":"cut in the mid',
  arrayLine: '[1,2,3]',
  controlChars: JSON.stringify({ timestamp: iso(T0 + 7), level: 'INFO', message: 'tab\there\u0000nul\u0007bell\u001bESC' }),
  emptyMessage: '{"timestamp":"2026-10-01T09:00:00.008Z","level":"INFO","message":""}',
  regexChars: JSON.stringify({ timestamp: iso(T0 + 9), level: 'INFO', message: 'chars .*+?^${}()|[]\\ and /slashes/' }),
};

/** A plain-text Java log with multi-line stack traces (folded into one entry each). */
export const PLAIN_JAVA_LOG = [
  '2026-10-01 09:00:00,000 INFO  [main] c.e.App - Starting App',
  '2026-10-01 09:00:01,000 ERROR [main] c.e.App - Boom',
  'java.lang.IllegalStateException: boom',
  '\tat com.example.App.run(App.java:10)',
  '\tat com.example.App.main(App.java:5)',
  'Caused by: java.io.IOException: disk full',
  '\t... 2 more',
  '2026-10-01 09:00:02,000 WARN  [main] c.e.App - Recovered',
  '',
].join('\n');

/** Big synthetic log (~580 bytes per line). */
export function bigLog(lines: number, seed = 7): string {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const level = i % 97 === 0 ? 'ERROR' : i % 13 === 0 ? 'WARN' : i % 5 === 0 ? 'DEBUG' : 'INFO';
    out.push(quarkusLine({
      ms: T0 + i * 37, seq: i, level, logger: pick(r, ['com.example.a.Alpha', 'com.example.b.Beta', 'route-gamma', 'io.quarkus.Delta']),
      message: `Processed message #${i} payload: {"id":${i},"ok":${level !== 'ERROR'}}`, traceId: i % 3 ? hex(r, 32) : undefined,
      exception: level === 'ERROR' ? quarkusException('com.example.Failure', `failure ${i}`) : undefined,
    }));
  }
  return `${out.join('\n')}\n`;
}
