// Screenshots of many UI states for design review. Not part of the normal run:
//   LOGPANE_SHOTS=1 LOGPANE_SHOTS_DIR=/tmp/lv-ui/round1 npx vitest run --config vitest.e2e.config.ts test/e2e/ui-shots.e2e.ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Page } from 'playwright-core';
import { KNOWN_TRACE, iso, ordersService, paymentsService, quarkusException, quarkusLine } from '../support/mocklogs';
import { clickRow, launch, search, serve, waitReady, type DevServer, type Harness } from './harness';

const OUT = process.env.LOGPANE_SHOTS_DIR ?? '/tmp/lv-ui/shots';
const T = Date.parse('2026-10-01T09:30:00.000Z');

/** Entries chosen to stress the details panel. */
const SHOWCASE = [
  quarkusLine({ ms: T, seq: 1, level: 'INFO', logger: 'io.quarkus', message: 'orders-service 2.4.1 on JVM (powered by Quarkus 3.27.0) started in 2.481s. Listening on: http://0.0.0.0:8080' }),
  JSON.stringify({
    timestamp: iso(T + 1000, 9, 123456), sequence: 2, loggerName: 'com.example.orders.service.CheckoutService', level: 'ERROR', threadName: 'executor-thread-12',
    message: 'Checkout failed for ORD-48332: payment declined by provider (attempt 3/3)',
    mdc: { traceId: KNOWN_TRACE, spanId: '318d2baa07406069', parentId: 'b92f833e2e0ce866', sampled: 'true', userId: 'C-1628', tenant: 'eu-west' },
    ndc: '', hostName: 'orders-6f7c9d8b4-x2k4p', processName: '/usr/lib/jvm/java-21-openjdk/bin/java', processId: 1,
    exception: {
      ...(quarkusException('com.example.orders.payment.PaymentDeclinedException', 'Payment for order ORD-48332 was declined', {
        type: 'org.jboss.resteasy.reactive.ClientWebApplicationException', message: "Received: 'Payment Required, status code 402' when invoking: Rest Client method: 'com.example.orders.payment.PaymentApi#charge'",
      }) as object),
    },
  }),
  quarkusLine({
    ms: T + 2000, seq: 3, level: 'INFO', logger: 'com.example.orders.service.CheckoutService', traceId: KNOWN_TRACE,
    message: `Order created: ${JSON.stringify({ orderId: 'ORD-48333', customer: { id: 'C-1628', tier: 'gold', email: 'anna@example.com' }, items: [{ sku: 'SKU-0087', qty: 3, price: 19.9 }, { sku: 'SKU-1042', qty: 1, price: 4.5 }], total: 64.2, currency: 'EUR', express: true, notes: null })}`,
  }),
  JSON.stringify({
    '@timestamp': new Date(T + 3000).toISOString(), '@version': '1', level: 'WARN', logger_name: 'org.springframework.web.servlet.mvc.method.annotation.ExceptionHandlerExceptionResolver',
    thread_name: 'http-nio-8080-exec-7', message: 'Resolved [org.springframework.web.client.ResourceAccessException: I/O error on POST request for "http://inventory.svc.cluster.local:8080/api/v1/reservations": Connect timed out]',
    application: 'payments', environment: 'staging', version: '5.12.0', traceId: KNOWN_TRACE,
    stack_trace: 'org.springframework.web.client.ResourceAccessException: I/O error on POST request: Connect timed out\n\tat org.springframework.web.client.RestTemplate.doExecute(RestTemplate.java:905)\n\tat com.example.payments.InventoryClient.reserve(InventoryClient.java:44)\nCaused by: java.net.SocketTimeoutException: Connect timed out\n\tat java.base/sun.nio.ch.NioSocketImpl.timedFinishConnect(NioSocketImpl.java:546)\n\t... 52 common frames omitted',
  }),
  '2026-10-01 09:30:04,000 ERROR [main] c.e.legacy.BatchJob - Nightly batch failed',
  'java.lang.IllegalStateException: Batch 2026-10-01 already running',
  '\tat com.example.legacy.BatchJob.start(BatchJob.java:58)',
  '\tat com.example.legacy.Scheduler.run(Scheduler.java:21)',
  'Caused by: java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms.',
  '\t... 4 more',
  JSON.stringify({
    timestamp: iso(T + 5000), level: 'DEBUG', loggerName: 'org.hibernate.SQL', threadName: 'executor-thread-3',
    message: `select o1_0.id,o1_0.customer_id,o1_0.created_at,o1_0.status,o1_0.total from orders o1_0 where o1_0.customer_id=? and o1_0.status in (?,?,?) and o1_0.created_at between ? and ? order by o1_0.created_at desc ${'offset ? rows fetch first ? rows only '.repeat(6)}`,
  }),
  JSON.stringify({
    timestamp: iso(T + 6000), level: 'INFO', loggerName: 'com.example.gateway.AccessLog', threadName: 'vert.x-eventloop-thread-1', message: 'POST /api/orders 201 (184 ms)',
    context: { request: { method: 'POST', path: '/api/orders', query: { dryRun: false }, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'x-request-id': 'req-7f3a' } }, response: { status: 201, bytes: 812 } },
    tags: ['http', 'public-api'], durationMs: 184, cached: false, region: null,
  }),
  JSON.stringify({ '@timestamp': new Date(T + 7000).toISOString(), 'log.level': 'INFO', message: 'Ąžuolas čiurlena ėžerą 💥 日本語 — unicode check', 'service.name': 'notifications', 'service.version': '1.8.2', 'http.request.method': 'GET', 'url.full': 'https://notifications.example.com/api/v2/templates/order-confirmation?locale=lt-LT&preview=true', 'trace.id': 'abc123def4567890abc123def4567890' }),
  JSON.stringify({ timestamp: iso(T + 8000), level: 'INFO', loggerName: 'route-sync', message: 'Synced [{"id":1,"status":"ok"},{"id":2,"status":"retry"}]' }),
].join('\n');

let h: Harness;
let srv: DevServer;
let n = 0;

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) });
}

async function open(url: string, opts: { width?: number; height?: number; dark?: boolean } = {}): Promise<Page> {
  const page = await h.newPage({ dark: opts.dark });
  await page.setViewportSize({ width: opts.width ?? 1440, height: opts.height ?? 900 });
  await page.goto(url);
  await h.inject(page);
  await waitReady(page);
  return page;
}

describe.skipIf(!process.env.LOGPANE_SHOTS)('UI screenshots', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    h = await launch();
    srv = await serve({ logs: { 'orders-6f7c9d8b4-x2k4p': ordersService(120).text, 'payments-5d8b7c6f9-q7m2z': paymentsService().text, showcase: SHOWCASE } });
  });
  afterAll(async () => {
    await h?.close();
    await srv?.close();
  });

  it('details panel, entry by entry (light and dark)', async () => {
    for (const dark of [false, true]) {
      const page = await open(srv.url('showcase', 'orders'), { dark });
      const theme = dark ? 'dark' : 'light';
      if (!dark) await shot(page, `list-${theme}`);
      for (const [label, rowText] of [
        ['error-exception', 'Checkout failed for ORD-48332'],
        ['json-payload', 'Order created'],
        ['logstash-stack', 'Resolved [org.springframework'],
        ['plain-multiline', 'Nightly batch failed'],
        ['long-sql', 'select o1_0.id'],
        ['nested-fields', 'POST /api/orders 201'],
        ['ecs-unicode', 'Ąžuolas'],
        ['json-array', 'Synced'],
      ] as const) {
        if (dark && !['error-exception', 'json-payload', 'nested-fields'].includes(label)) continue;
        await clickRow(page, rowText);
        await shot(page, `details-${label}-${theme}`);
        if (label === 'error-exception' && !dark) {
          await page.$eval('.lv-details-body', (el) => (el.scrollTop = 99999));
          await shot(page, `details-${label}-scrolled-${theme}`);
        }
      }
      await page.close();
    }
  });

  it('details panel at other widths', async () => {
    for (const width of [1280, 1920, 900]) {
      const page = await open(srv.url('showcase', 'orders'), { width });
      await clickRow(page, 'Checkout failed for ORD-48332');
      await shot(page, `details-error-w${width}`);
      await page.close();
    }
  });

  it('list with two sources, filters, menus and dialogs', async () => {
    const page = await open(srv.url('orders-6f7c9d8b4-x2k4p', 'orders-service'), { width: 1280 });
    await shot(page, 'banner-and-list-1280');
    await page.click('.lv-banner button:text("Not now")');
    await page.click('button:text("+ Add log")');
    await page.fill('.lv-modal textarea >> nth=0', srv.url('payments-5d8b7c6f9-q7m2z', 'payment-service'));
    await shot(page, 'add-log-dialog');
    await page.click('.lv-modal button:text-is("Add")');
    await page.waitForSelector('.lv-src-chip >> nth=1');
    await shot(page, 'two-sources-1280');
    await search(page, 'ORD-1004');
    await page.click('.lv-level-chip.lv-lvl-INFO');
    await shot(page, 'filters-active');
    await page.click('.lv-filterbar button:text-is("Logger")');
    await shot(page, 'logger-picker');
    await page.keyboard.press('Escape');
    await page.click('.lv-filterbar button:text("Time")');
    await shot(page, 'time-picker');
    await page.fill('.lv-time-input >> nth=0', '09:00:12');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await shot(page, 'time-range-active');
    await page.click('button:text("View ▾")');
    await shot(page, 'view-menu');
    await page.keyboard.press('Escape');
    await page.click('button:text("Export ▾")');
    await shot(page, 'export-menu');
    await page.keyboard.press('Escape');
    await search(page, 'zzz-nothing');
    await shot(page, 'no-results');
    await page.close();
    const dark = await open(srv.url('orders-6f7c9d8b4-x2k4p', 'orders-service'), { width: 1440, dark: true });
    await dark.click('.lv-banner button:text("Not now")', { timeout: 2000 }).catch(() => undefined);
    await shot(dark, 'list-dark-1440');
    await dark.close();
  });

  it('file viewer and small screens', async () => {
    const page = await h.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`chrome-extension://${h.extId}/viewer.html`);
    await page.waitForSelector('.lv-empty');
    await shot(page, 'file-viewer-empty');
    await page.close();
    const phone = await open(srv.url('showcase'), { width: 390, height: 844 });
    await shot(phone, 'phone-list');
    await clickRow(phone, 'Checkout failed for ORD-48332');
    await shot(phone, 'phone-details');
    await phone.close();
  });
});
