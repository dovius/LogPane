// Details panel, copy actions, Show in context, export, row selection copy and the keyboard.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { KNOWN_TRACE, ordersService } from '../support/mocklogs';
import { captureCopy, clickRow, counts, launch, search, selectRowsAndCopy, serve, visibleMessages, waitCounts, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
let srv: DevServer;
let page: Page;
const orders = ordersService(100);

beforeAll(async () => {
  h = await launch();
  srv = await serve({ logs: { orders: orders.text } });
  page = await h.openManual(srv.url('orders'));
  await waitLoaded(page, orders.total);
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
});
beforeEach(async () => {
  await page.locator('.lv-search-input').blur().catch(() => undefined);
  if (await page.$('.lv-details')) await page.click('.lv-details button[aria-label="Close"]');
  const clear = page.locator('.lv-filterbar button:text("Clear filters")');
  if (await clear.count()) await clear.click();
  await waitCounts(page, orders.total, orders.total);
});

describe('details panel', () => {
  it('shows the message with its JSON payload pretty-printed', async () => {
    await search(page, 'ORD-10042');
    await clickRow(page, 'Order created');
    expect(await page.textContent('.lv-details .lv-msg-text')).toBe('Order created:');
    const json = await page.textContent('.lv-details .lv-json-card .lv-json');
    expect(json).toContain('"orderId": "ORD-10042"');
    expect(json).toContain('"qty": 1');
  });

  it('renders a structured exception as a Java stack trace', async () => {
    await search(page, 'ORD-10024');
    await clickRow(page, 'Checkout failed');
    const chain = await page.$$eval('.lv-chain .lv-chain-type', (els) => els.map((e) => e.textContent));
    expect(chain).toEqual(['PaymentDeclinedException', 'ClientWebApplicationException']);
    const stack = (await page.textContent('.lv-stack')) ?? '';
    expect(stack).toContain('com.example.orders.payment.PaymentDeclinedException: Payment for order ORD-10024 was declined');
    expect(stack).toContain('at com.example.orders.service.CheckoutService.checkout(CheckoutService.java:142)');
    expect(stack).toContain('Caused by: org.jboss.resteasy.reactive.ClientWebApplicationException: Payment Required, status code 402');
    // framework frames are dimmed, application frames are not; the exception type stands out
    const classes = await page.$$eval('.lv-stack > div', (els) => els.map((e) => [e.textContent?.trim(), e.className]));
    expect(classes.find(([t]) => t?.startsWith('at java.lang.Thread'))?.[1]).toContain('lv-sl-framework');
    expect(classes.find(([t]) => t?.startsWith('at com.example.orders.api'))?.[1]).toContain('lv-sl-app');
    expect(await page.textContent('.lv-stack .lv-sl-exception .lv-sl-type')).toBe('com.example.orders.payment.PaymentDeclinedException');
  });

  it('lists fields with UTC and local time, source, logger, thread, sequence and MDC', async () => {
    await search(page, 'ORD-10007');
    await clickRow(page, 'Order created');
    const fields = await page.$$eval('.lv-frows .lv-fkey', (els) => els.map((e) => e.textContent));
    expect(fields).toEqual(expect.arrayContaining(['Time', 'Source', 'Logger', 'Thread', 'Sequence', 'traceId', 'spanId', 'hostName']));
    const time = (await page.textContent('.lv-frows .lv-fval')) ?? '';
    expect(time).toMatch(/2026-10-01 09:00:02\.10\d+ UTC/);
    expect(time).toMatch(/2026-10-01 12:00:02\.10\d+ UTC\+03:00/);
    expect(await page.textContent('.lv-details-title')).toMatch(/^2026-10-01 09:00:02\.10\d+ UTC$/);
    // MDC ids are grouped under Trace, bookkeeping under Host & process (collapsed)
    expect(await page.textContent('.lv-dsec:has(h3:text-is("Trace"))')).toContain(KNOWN_TRACE);
    expect(await page.$eval('details:has(summary:text("Host & process"))', (el) => (el as HTMLDetailsElement).open)).toBe(false);
  });

  it('logger link filters by logger; raw JSON can be expanded', async () => {
    await search(page, 'ORD-10007');
    await clickRow(page, 'Order created');
    await page.click('.lv-details summary:text("Raw JSON")');
    expect(await page.textContent('.lv-details details[open] .lv-json')).toContain(`"traceId": "${KNOWN_TRACE}"`);
    await page.click('.lv-frows button.lv-link:text("com.example.orders.service.CheckoutService")');
    await search(page, '');
    await waitCounts(page, 100 + orders.counts.ERROR, orders.total); // "Order created" per cycle + "Checkout failed"
  });

  it('a click on the selected row closes the panel; Esc closes it too', async () => {
    await search(page, 'ORD-10042');
    await clickRow(page, 'Order created');
    await page.locator('.lv-list .lv-row.lv-sel').click();
    expect(await page.$('.lv-details')).toBeNull();
    await clickRow(page, 'Order created');
    await page.keyboard.press('Escape');
    expect(await page.$('.lv-details')).toBeNull();
  });

  it('switching entries scrolls the panel back to the top', async () => {
    await search(page, 'ORD-10024');
    await clickRow(page, 'Checkout failed');
    await page.$eval('.lv-details-body', (el) => (el.scrollTop = 10_000));
    await page.locator('.lv-list .lv-row', { hasText: 'Order created' }).click();
    expect(await page.$eval('.lv-details-body', (el) => el.scrollTop)).toBe(0);
  });

  it('Show in context clears filters and keeps the entry selected and visible', async () => {
    await search(page, 'ORD-10050');
    await clickRow(page, '201 Created');
    await page.click('button:text("Show in context")');
    await waitCounts(page, orders.total, orders.total);
    expect(await page.inputValue('.lv-search-input')).toBe('');
    await page.waitForTimeout(200);
    const visible = await page.$eval('.lv-row.lv-sel', (el) => {
      const list = document.querySelector('.lv-list')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return r.top >= list.top && r.bottom <= list.bottom && el.textContent?.includes('201 Created ORD-10050');
    });
    expect(visible).toBe(true);
  });

  it('the panel can be resized and keeps its width', async () => {
    await search(page, 'ORD-10042');
    await clickRow(page, 'Order created');
    const before = await page.$eval('.lv-details', (el) => el.getBoundingClientRect().width);
    const handle = (await page.$('.lv-resizer'))!.boundingBox();
    const box = (await handle)!;
    await page.mouse.move(box.x + 4, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 150, box.y + 200, { steps: 5 });
    await page.mouse.up();
    const after = await page.$eval('.lv-details', (el) => el.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before + 100);
    const saved = (await h.storage()).lvSettings as { detailsWidth: number };
    expect(Math.abs(saved.detailsWidth - after)).toBeLessThan(3);
  });
});

describe('copy', () => {
  it('Copy entry gives a readable line with the stack trace', async () => {
    await search(page, 'ORD-10024');
    await clickRow(page, 'Checkout failed');
    const text = await captureCopy(page, () => page.click('button:text("Copy entry")'));
    const [first, ...rest] = text.split('\n');
    expect(first).toMatch(/^2026-10-01T09:00:07\.26\d*Z ERROR \[com\.example\.orders\.service\.CheckoutService\] \(executor-thread-1\) \{traceId=[0-9a-f]{32}\} Checkout failed for ORD-10024: payment declined$/);
    expect(rest[0]).toContain('PaymentDeclinedException');
    expect(text).toContain('Caused by:');
  });

  it('Copy JSON, Copy stack trace and Copy ±N lines', async () => {
    await search(page, 'ORD-10024');
    await clickRow(page, 'Checkout failed');
    const json = JSON.parse(await captureCopy(page, () => page.click('button:text("Copy JSON")')));
    expect(json.message).toBe('Checkout failed for ORD-10024: payment declined');
    const stack = await captureCopy(page, () => page.click('button[aria-label="Copy stack trace"]'));
    expect(stack.split('\n')[0]).toBe('com.example.orders.payment.PaymentDeclinedException: Payment for order ORD-10024 was declined');
    const context = await captureCopy(page, () => page.click('button:text("Copy ±20 lines")'));
    expect(context.split('\n').filter((l) => /^2026-/.test(l)).length).toBe(41);
    expect(context).toContain('Checkout failed for ORD-10024');
  });

  it('the c key copies the selected entry', async () => {
    await search(page, 'ORD-10042');
    await clickRow(page, '201 Created');
    await page.locator('.lv-search-input').blur();
    const text = await captureCopy(page, () => page.keyboard.press('c'));
    expect(text).toContain('201 Created ORD-10042');
  });

  it('selecting rows copies tab-separated lines with full values', async () => {
    await search(page, 'ORD-10024');
    const text = await selectRowsAndCopy(page, 'Order created', '201 Created');
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.split('\t').length === 4)).toBe(true);
    expect(lines[1].split('\t')).toEqual(['09:00:07.260', 'ERROR', 'com.example.orders.service.CheckoutService', 'Checkout failed for ORD-10024: payment declined']);
    expect(text).not.toContain('EXC');
  });

  it('Export copies or downloads exactly what is shown', async () => {
    await page.click('.lv-level-chip.lv-lvl-WARN');
    await waitCounts(page, orders.counts.WARN, orders.total);
    const text = await captureCopy(page, async () => {
      await page.click('button:text("Export ▾")');
      await page.click('button:text("Copy shown as text")');
    });
    expect(text.split('\n')).toHaveLength(orders.counts.WARN);
    expect(text.split('\n').every((l) => l.includes(' WARN '))).toBe(true);
    const ndjson = await captureCopy(page, async () => {
      await page.click('button:text("Export ▾")');
      await page.click('button:text("Copy shown as raw JSON lines")');
    });
    expect(ndjson.split('\n').map((l) => JSON.parse(l).level)).toEqual(Array(orders.counts.WARN).fill('WARN'));
    await page.click('button:text("Export ▾")');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:text("Download shown (.log)")')]);
    expect(download.suggestedFilename()).toBe('app-orders-filtered.log');
    await page.click('.lv-level-chip.lv-lvl-WARN');
  });
});

describe('keyboard', () => {
  it('/ focuses search, Esc clears it, Esc again blurs', async () => {
    await page.locator('.lv-list').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    if (await page.$('.lv-details')) await page.click('.lv-details button[aria-label="Close"]');
    await page.keyboard.press('/');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('lv-search-input'))).toBe(true);
    await page.keyboard.type('ORD-10042');
    await page.keyboard.press('Escape');
    expect(await page.inputValue('.lv-search-input')).toBe('');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('lv-search-input'))).toBe(false);
  });

  it('j/k and arrows move the selection; g/G jump to top/bottom', async () => {
    await page.keyboard.press('g');
    await page.keyboard.press('j');
    const first = await page.textContent('.lv-row.lv-sel .lv-c-msg');
    await page.keyboard.press('ArrowDown');
    const second = await page.textContent('.lv-row.lv-sel .lv-c-msg');
    await page.keyboard.press('k');
    expect(await page.textContent('.lv-row.lv-sel .lv-c-msg')).toBe(first);
    expect(second).not.toBe(first);
    expect(first).toContain('POST /api/orders');
    await page.keyboard.press('Escape');
    await page.keyboard.press('G');
    await page.waitForTimeout(100);
    expect((await visibleMessages(page)).at(-1)).toContain('Health check UP'); // last line of the last cycle
  });

  it('n/N jump between errors, w/W between warnings, with a hint at the end', async () => {
    await page.keyboard.press('g');
    await page.keyboard.press('n');
    expect(await page.textContent('.lv-row.lv-sel .lv-c-msg')).toContain('Checkout failed for ORD-10024');
    await page.keyboard.press('n');
    expect(await page.textContent('.lv-row.lv-sel .lv-c-msg')).toContain('ORD-10049');
    await page.keyboard.press('N');
    expect(await page.textContent('.lv-row.lv-sel .lv-c-msg')).toContain('ORD-10024');
    await page.keyboard.press('N');
    expect(await page.textContent('.lv-toast')).toBe('No previous error');
    await page.keyboard.press('w');
    expect(await page.textContent('.lv-row.lv-sel .lv-c-msg')).toContain('Payment call took');
    await page.keyboard.press('W');
    await page.keyboard.press('Escape');
  });

  it('the jump buttons do the same as n/N', async () => {
    await page.keyboard.press('g');
    await page.click('button[title="Next error (n)"]');
    expect(await page.textContent('.lv-row.lv-sel .lv-c-msg')).toContain('ORD-10024');
    await page.keyboard.press('Escape');
  });
});

describe('health', () => {
  it('no page errors', () => {
    expect(h.errors).toEqual([]);
  });
});
