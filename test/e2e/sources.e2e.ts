// Several logs at once: adding by URL / file / paste, merging, hiding, removing, error states.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { KNOWN_TRACE, ordersService, paymentsService } from '../support/mocklogs';
import { clickRow, counts, launch, search, serve, visibleMessages, waitCounts, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
let srv: DevServer;
const orders = ordersService(60);
const payments = paymentsService();
const dir = mkdtempSync(join(tmpdir(), 'logpane-files-'));

beforeAll(async () => {
  h = await launch();
  srv = await serve({
    logs: { 'orders-6f7c9d8b4-x2k4p': orders.text, 'payments-5d8b7c6f9-q7m2z': payments.text },
    routes: {
      '/api/kubernetes/api/v1/namespaces/demo/pods/expired/log': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>Log in</html>' },
      '/api/kubernetes/api/v1/namespaces/demo/pods/gone/log': { status: 404, body: 'pods "gone" not found' },
    },
  });
  writeFileSync(join(dir, 'payments.log'), payments.text);
  writeFileSync(join(dir, 'extra.ndjson'), '{"timestamp":"2026-10-01T09:00:00.500Z","level":"WARN","message":"from extra file"}\n');
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
});

async function openOrders(): Promise<Page> {
  const page = await h.openManual(srv.url('orders-6f7c9d8b4-x2k4p', 'orders'));
  await waitLoaded(page, orders.total);
  return page;
}

async function addUrls(page: Page, urls: string): Promise<void> {
  await page.click('button:text("+ Add log")');
  await page.fill('.lv-modal textarea >> nth=0', urls);
  await page.click('.lv-modal button:text-is("Add")');
}

describe('adding logs', () => {
  it('adds a Raw URL and merges both logs by time', async () => {
    const page = await openOrders();
    await addUrls(page, srv.url('payments-5d8b7c6f9-q7m2z', 'payments'));
    await waitLoaded(page, orders.total + payments.total);
    expect(await page.$$eval('.lv-src-chip .lv-src-label', (els) => els.map((e) => e.textContent))).toEqual(['orders (x2k4p)', 'payments (q7m2z)']);
    expect(await page.textContent('.lv-head')).toContain('Source');
    // the payment lines sit between the order lines of the same request
    await search(page, KNOWN_TRACE);
    await waitCounts(page, 3 + 2, orders.total + payments.total);
    const msgs = await visibleMessages(page);
    expect(msgs.map((m) => m.replace(/^(EXC)?(\{\})?/, '').slice(0, 20))).toEqual(['POST /api/orders cus', 'Charge request for O', 'Card declined for OR', 'Order created: {"ord', '201 Created ORD-1000']);
    await page.close();
  });

  it('turns a console page URL into its Raw URL', async () => {
    const page = await openOrders();
    const consoleUrl = `http://localhost:${srv.port}/k8s/ns/demo/pods/payments-5d8b7c6f9-q7m2z/logs?container=payments`;
    await addUrls(page, consoleUrl);
    await waitLoaded(page, orders.total + payments.total);
    await page.close();
  });

  it('adds several files at once and pasted text', async () => {
    const page = await openOrders();
    await page.click('button:text("+ Add log")');
    await page.setInputFiles('.lv-modal input[type=file]', [join(dir, 'payments.log'), join(dir, 'extra.ndjson')]);
    await waitLoaded(page, orders.total + payments.total + 1);
    await page.click('button:text("+ Add log")');
    await page.fill('.lv-modal textarea >> nth=1', '{"level":"ERROR","message":"pasted line","timestamp":"2026-10-01T09:00:00.001Z"}');
    await page.click('.lv-modal button:text-is("Add")');
    await waitLoaded(page, orders.total + payments.total + 2);
    expect(await page.$$eval('.lv-src-chip .lv-src-label', (els) => els.map((e) => e.textContent))).toEqual(['orders (x2k4p)', 'payments', 'extra', 'pasted 1']);
    await page.close();
  });

  it('hiding and removing sources', async () => {
    const page = await openOrders();
    await addUrls(page, srv.url('payments-5d8b7c6f9-q7m2z', 'payments'));
    await waitLoaded(page, orders.total + payments.total);
    await page.locator('.lv-src-chip', { hasText: 'payments' }).locator('.lv-chip-main').click();
    await waitCounts(page, orders.total, orders.total + payments.total);
    expect(await page.locator('.lv-src-chip', { hasText: 'payments' }).getAttribute('class')).toContain('lv-off');
    await page.locator('.lv-src-chip', { hasText: 'payments' }).locator('.lv-chip-main').click();
    await waitCounts(page, orders.total + payments.total, orders.total + payments.total);
    await search(page, 'Card declined');
    await clickRow(page, 'Card declined');
    await search(page, '');
    await page.locator('.lv-src-chip', { hasText: 'payments' }).locator('.lv-chip-x').click();
    await waitLoaded(page, orders.total);
    expect(await page.$('.lv-details')).toBeNull(); // the selected entry belonged to the removed source
    expect(await page.textContent('.lv-head')).not.toContain('Source');
    await page.close();
  });

  it('shows each source on rows and in copies', async () => {
    const page = await openOrders();
    await addUrls(page, srv.url('payments-5d8b7c6f9-q7m2z', 'payments'));
    await waitLoaded(page, orders.total + payments.total);
    await search(page, 'Card declined');
    expect(await page.textContent('.lv-list .lv-row .lv-c-src')).toBe('payments (q7m2z)');
    await page.close();
  });
});

describe('add log errors', () => {
  it('rejects other origins, non-URLs and reports HTTP / session errors on the chip', async () => {
    const page = await openOrders();
    await addUrls(page, 'https://example.com/api/kubernetes/api/v1/namespaces/x/pods/y/log');
    expect(await page.textContent('.lv-toast')).toContain('Only URLs from');
    await addUrls(page, 'not a url at all');
    expect(await page.textContent('.lv-toast')).toBe('Not a URL: not a url at all');
    await addUrls(page, srv.url('gone'));
    await page.waitForSelector('.lv-src-chip.lv-err');
    expect(await page.textContent('.lv-src-chip.lv-err')).toContain('HTTP 404');
    await addUrls(page, srv.url('expired'));
    await page.waitForFunction(() => document.querySelectorAll('.lv-src-chip.lv-err').length === 2);
    expect(await page.locator('.lv-src-chip.lv-err').nth(1).textContent()).toContain('HTML page instead of a log');
    expect((await counts(page)).total).toBe(orders.total);
    await page.close();
  });

  it('the dialog closes with Esc and Cancel and does nothing', async () => {
    const page = await openOrders();
    await page.click('button:text("+ Add log")');
    await page.keyboard.press('Escape');
    expect(await page.$('.lv-modal')).toBeNull();
    await page.click('button:text("+ Add log")');
    expect(await page.isDisabled('.lv-modal button:text-is("Add")')).toBe(true);
    await page.click('.lv-modal button:text("Cancel")');
    expect(await page.$('.lv-modal')).toBeNull();
    expect((await counts(page)).total).toBe(orders.total);
    await page.close();
  });
});

describe('health', () => {
  it('no page errors (the 404 from the "gone" pod is expected)', () => {
    expect(h.errors.filter((e) => !e.includes('status of 404'))).toEqual([]);
  });
});
