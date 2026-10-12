#!/usr/bin/env node
// Generates realistic-looking but entirely fictional logs of two services that call each other,
// for demos and store screenshots:  node scripts/make-demo.mjs <out-dir>
//   → orders-service-6f7c9d8b4-x2k4p.log (Quarkus JSON), payment-service-5d8b7c6f9-q7m2z.log (logstash JSON)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'demo';
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rand() * a.length)];
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const iso = (ms, extraDigits) => new Date(ms).toISOString().replace('Z', `${String(Math.floor(rand() * 10 ** extraDigits)).padStart(extraDigits, '0')}Z`);

const ordersHost = 'orders-service-6f7c9d8b4-x2k4p';
const orders = [];
const payments = [];
let oSeq = 1200;
const o = (ms, level, loggerName, message, extra = {}) =>
  orders.push({ ms, line: JSON.stringify({
    timestamp: iso(ms, 6), sequence: oSeq++, loggerClassName: 'org.jboss.logging.Logger', loggerName, level, message,
    threadName: extra.thread ?? 'executor-thread-1', threadId: 31, mdc: extra.mdc ?? {}, ndc: '', hostName: ordersHost,
    processName: '/usr/lib/jvm/java-21-openjdk/bin/java', processId: 1, ...(extra.exception ? { exception: extra.exception } : {}),
  }) });
const p = (ms, level, logger, message, extra = {}) =>
  payments.push({ ms, line: JSON.stringify({
    '@timestamp': new Date(ms).toISOString(), '@version': '1', message, logger_name: logger, thread_name: extra.thread ?? 'http-nio-8080-exec-3',
    level, level_value: { ERROR: 40000, WARN: 30000, INFO: 20000, DEBUG: 10000 }[level],
    ...(extra.traceId ? { traceId: extra.traceId, spanId: hex(16) } : {}), ...(extra.stack ? { stack_trace: extra.stack } : {}),
  }) });

const frames = (list) => list.map(([cls, method, line]) => ({ class: cls, method, line }));
const declined = (orderId) => ({
  refId: 1,
  exceptionType: 'com.example.orders.payment.PaymentDeclinedException',
  message: `Payment for order ${orderId} was declined`,
  frames: frames([
    ['com.example.orders.payment.PaymentClient', 'charge', 88],
    ['com.example.orders.service.CheckoutService', 'checkout', 142],
    ['com.example.orders.api.OrderResource', 'placeOrder', 61],
    ['org.jboss.resteasy.reactive.server.handlers.InvocationHandler', 'handle', 29],
    ['io.quarkus.vertx.core.runtime.VertxCoreRecorder$14', 'runWith', 635],
    ['java.lang.Thread', 'run', 1583],
  ]),
  causedBy: { exception: {
    refId: 2,
    exceptionType: 'org.jboss.resteasy.reactive.ClientWebApplicationException',
    message: 'Received: \'Payment Required, status code 402\' when invoking: Rest Client method: \'PaymentApi#charge\'',
    frames: frames([
      ['org.jboss.resteasy.reactive.client.impl.RestClientRequestContext', 'unwrapException', 205],
      ['org.jboss.resteasy.reactive.client.handlers.ClientResponseCompleteRestHandler', 'handle', 26],
      ['io.quarkus.rest.client.reactive.runtime.RestClientBase', 'invoke', 117],
    ]),
  } },
});

let t = Date.parse('2026-10-01T09:14:02.000Z');
o(t, 'INFO', 'io.quarkus', 'orders-service 2.4.1 on JVM (powered by Quarkus 3.27.0) started in 2.481s. Listening on: http://0.0.0.0:8080', { thread: 'main' });
o((t += 3), 'INFO', 'io.quarkus', 'Profile prod activated.', { thread: 'main' });
o((t += 1), 'INFO', 'io.quarkus', 'Installed features: [cdi, hibernate-orm, jdbc-postgresql, kafka-client, opentelemetry, rest, rest-client, smallrye-health]', { thread: 'main' });
p(t - 4000, 'INFO', 'com.example.payments.PaymentApplication', 'Started PaymentApplication in 3.912 seconds (process running for 4.4)', { thread: 'main' });
o((t += 900), 'WARN', 'io.quarkus.config', 'Unrecognized configuration key "quarkus.http.cors" was provided; it will be ignored', { thread: 'main' });

const products = ['SKU-1042', 'SKU-2210', 'SKU-0087', 'SKU-3301', 'SKU-1777'];
for (let i = 0; i < 160; i++) {
  t += 300 + Math.floor(rand() * 2500);
  const traceId = hex(32);
  const mdc = (span = hex(16)) => ({ traceId, spanId: span, parentId: hex(16), sampled: 'true' });
  const orderId = `ORD-${String(48210 + i)}`;
  const kind = i % 23 === 7 ? 'declined' : i % 11 === 3 ? 'slow' : i % 5 === 0 ? 'health' : 'ok';
  if (kind === 'health') {
    o(t, 'DEBUG', 'io.smallrye.health', 'Health check UP (database, kafka)', { thread: 'vert.x-eventloop-thread-0' });
    continue;
  }
  const total = (20 + rand() * 280).toFixed(2);
  o(t, 'INFO', 'com.example.orders.api.OrderResource', `POST /api/orders customer=C-${1000 + Math.floor(rand() * 900)}`, { mdc: mdc() });
  o((t += 4), 'INFO', 'com.example.orders.service.CheckoutService', `Order created: ${JSON.stringify({ orderId, items: [{ sku: pick(products), qty: 1 + Math.floor(rand() * 3) }], total: Number(total), currency: 'EUR' })}`, { mdc: mdc() });
  p((t += 9), 'INFO', 'com.example.payments.ChargeController', `Charge request for ${orderId}, amount=${total} EUR`, { traceId });
  if (kind === 'slow') {
    p((t += 1800), 'WARN', 'com.example.payments.provider.ProviderClient', `Provider responded slowly (1812 ms) for ${orderId}, retrying (attempt 2/3)`, { traceId });
    o((t += 40), 'WARN', 'com.example.orders.payment.PaymentClient', `Payment call took 1861 ms for ${orderId}`, { mdc: mdc() });
  }
  if (kind === 'declined') {
    p((t += 120), 'ERROR', 'com.example.payments.ChargeController', `Card declined for ${orderId}: insufficient_funds`, {
      traceId, stack: `com.example.payments.CardDeclinedException: insufficient_funds\n\tat com.example.payments.provider.ProviderClient.charge(ProviderClient.java:77)\n\tat com.example.payments.ChargeController.charge(ChargeController.java:41)`,
    });
    o((t += 6), 'ERROR', 'com.example.orders.service.CheckoutService', `Checkout failed for ${orderId}: payment declined`, { mdc: mdc(), exception: declined(orderId) });
    o((t += 2), 'INFO', 'com.example.orders.events.OrderEvents', `Published OrderFailed event: ${JSON.stringify({ orderId, reason: 'PAYMENT_DECLINED' })}`, { mdc: mdc(), thread: 'kafka-producer-network-thread' });
    continue;
  }
  p((t += 60 + Math.floor(rand() * 90)), 'INFO', 'com.example.payments.ChargeController', `Charge captured for ${orderId} (auth ${hex(8).toUpperCase()})`, { traceId });
  o((t += 5), 'INFO', 'com.example.orders.events.OrderEvents', `Published OrderPaid event: ${JSON.stringify({ orderId, paidAt: new Date(t).toISOString() })}`, { mdc: mdc(), thread: 'kafka-producer-network-thread' });
  o((t += 2), 'INFO', 'com.example.orders.api.OrderResource', `201 Created ${orderId} in ${70 + Math.floor(rand() * 120)} ms`, { mdc: mdc() });
}

mkdirSync(outDir, { recursive: true });
const write = (name, list) => writeFileSync(join(outDir, name), list.sort((a, b) => a.ms - b.ms).map((x) => x.line).join('\n') + '\n');
write(`${ordersHost}.log`, orders);
write('payment-service-5d8b7c6f9-q7m2z.log', payments);
console.log(`wrote ${orders.length} + ${payments.length} lines to ${outDir}`);
