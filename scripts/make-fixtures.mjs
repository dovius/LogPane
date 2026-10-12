#!/usr/bin/env node
// Generates synthetic Quarkus-style JSON logs (no real project data).
//   node scripts/make-fixtures.mjs                 → test/fixtures/*.log
//   node scripts/make-fixtures.mjs --big 50000 out.log
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = 'demo-adapter-7d9f8c6b5-x2k4p';
const base = {
  loggerClassName: 'org.jboss.logging.Logger', ndc: '', hostName: host,
  processName: '/usr/lib/jvm/java-21-openjdk/bin/java', processId: 1,
};
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

let seq = 100;
const line = (timestamp, level, loggerName, message, extra = {}) =>
  JSON.stringify({
    timestamp, sequence: seq++, loggerClassName: base.loggerClassName, loggerName, level, message,
    threadName: extra.threadName ?? 'main', threadId: extra.threadId ?? 1, mdc: extra.mdc ?? {}, ndc: '',
    hostName: base.hostName, processName: base.processName, processId: 1,
    ...(extra.exception ? { exception: extra.exception } : {}),
  });

const mdc = (spanId, parentId) => ({ spanId, parentId, traceId: TRACE, sampled: 'true' });
const frame = (cls, method, ln) => ({ class: cls, method, line: ln });

const httpError = {
  refId: 1,
  exceptionType: 'com.example.adapter.exception.DownstreamException',
  message: 'HTTP operation failed invoking http://inventory.svc:8080/stock with statusCode: 500',
  frames: [],
  causedBy: {
    exception: {
      refId: 2,
      exceptionType: 'org.apache.camel.http.base.HttpOperationFailedException',
      message: 'HTTP operation failed invoking http://inventory.svc:8080/stock with statusCode: 500',
      frames: [
        frame('org.apache.camel.component.http.HttpProducer', 'populateHttpOperationFailedException', 466),
        frame('org.apache.camel.component.http.HttpProducer', 'lambda$process$1', 284),
        frame('org.apache.camel.impl.engine.DefaultReactiveExecutor$Worker', 'doRun', 199),
        frame('java.lang.Thread', 'run', 1583),
      ],
    },
  },
};

const circular = {
  refId: 1,
  exceptionType: 'java.lang.IllegalStateException',
  message: 'Route failed',
  frames: [frame('com.example.adapter.routes.OrdersRoute', 'configure', -1), frame('jdk.internal.misc.Unsafe', 'park', -2)],
  suppressed: [{ exception: { refId: 3, exceptionType: 'java.io.IOException', message: 'close failed', frames: [frame('com.example.Io', 'close', 12)] } }],
  causedBy: { exception: { refId: 1 } },
};

const sample = [
  line('2026-10-01T13:55:19.1693672Z', 'WARN', 'io.quarkus.config', 'The "quarkus.log.console.json" config property is deprecated and should not be used anymore.'),
  line('2026-10-01T13:55:23.880597149Z', 'INFO', 'org.apache.camel.quarkus.core.CamelBootstrapRecorder', 'Apache Camel Quarkus is starting'),
  line('2026-10-01T13:55:24.171471497Z', 'INFO', 'org.apache.camel.main.BaseMainSupport', '    [MicroProfilePropertiesSource] camel.main.durationMaxIdleSeconds = 30'),
  line('2026-10-01T13:55:24.398671393Z', 'INFO', 'com.example.adapter.routes.OrdersRoute', 'file:/tmp/data?fileName=Mapping.txt&noop=true&idempotentKey=${file:name}-${file:modified}'),
  line('2026-10-01T13:55:50.87370206Z', 'INFO', 'create-order-route', 'Create New Order: {"orderId":"ORD-1001","sku":"SKU-42","qty":2,"channel":"WEB"}', { threadName: 'Camel (camel-1) thread #5 - Multicast', threadId: 42, mdc: mdc('ff29ae1c6e656bcc', '6b9a14bb6e340662') }),
  line('2026-10-01T13:55:50.884532509Z', 'ERROR', 'com.example.adapter.processors.ErrorProcessor', 'Connection failure [errorCode=E-1002]: HTTP operation failed with statusCode: 500', { threadName: 'Camel (camel-1) thread #3 - Multicast', threadId: 40, mdc: mdc('10a8b6361caebe91', 'fa0483936477065c'), exception: httpError }),
  '{"timestamp":"2026-10-01T13:55:50.9","level":"INFO","message":"truncated line',
  'Exception in thread "worker-1" java.lang.IllegalStateException: boom',
  '\tat com.example.Main.run(Main.java:10)',
  'Caused by: java.io.IOException: disk full',
  '\t... 3 more',
  '',
  line('2026-10-01T13:55:51.02840416Z', 'ERROR', 'com.example.adapter.routes.OrdersRoute', 'Route failed', { exception: circular }),
  line('2026-10-01T13:55:51.5Z', 'DEBUG', 'com.example.adapter.Cache', 'cache hit ratio 0.93'),
  JSON.stringify({ '@timestamp': '2026-10-01T13:55:52.123+00:00', level: 'WARN', logger_name: 'com.example.Legacy', thread_name: 'http-nio-1', message: 'Slow response', stack_trace: 'java.lang.RuntimeException: slow\n\tat a.b.C.d(C.java:1)' }),
];

const other = [
  line('2026-10-01T13:55:50.870000001Z', 'INFO', 'inventory-route', 'Received stock request', { threadName: 'executor-thread-1', mdc: mdc('6b9a14bb6e340662', '') }),
  line('2026-10-01T13:55:50.88Z', 'ERROR', 'com.example.inventory.StockResource', 'Stock lookup failed', { threadName: 'executor-thread-1', mdc: mdc('aa00bb11cc22dd33', '6b9a14bb6e340662') }),
  line('2026-10-01T13:55:53.000000000Z', 'INFO', 'inventory-route', 'Health check OK'),
];

function big(n) {
  const loggers = ['com.example.adapter.routes.OrdersRoute', 'org.apache.camel.main.BaseMainSupport', 'create-order-route', 'com.example.Cache'];
  const levels = ['INFO', 'INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR'];
  const start = Date.parse('2026-10-01T10:00:00Z');
  const out = [];
  for (let i = 0; i < n; i++) {
    const level = levels[i % levels.length];
    const ts = new Date(start + i * 37).toISOString().replace('Z', `${String(i % 1000).padStart(3, '0')}Z`);
    out.push(line(ts, level, loggers[i % loggers.length], `Processed message #${i} payload: {"id":${i},"ok":${level !== 'ERROR'}}`, {
      mdc: i % 3 ? mdc(i.toString(16).padStart(16, '0'), '') : {}, ...(level === 'ERROR' ? { exception: httpError } : {}),
    }));
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === '--big') {
  const out = args[2] ?? '/tmp/big.log';
  writeFileSync(out, big(Number(args[1] ?? 50000)).join('\n') + '\n');
  console.log(`wrote ${out}`);
} else {
  const dir = join(root, 'test', 'fixtures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'quarkus-sample.log'), sample.join('\n') + '\n');
  writeFileSync(join(dir, 'other-service.log'), other.join('\n') + '\n');
  console.log(`wrote fixtures to ${dir}`);
}
