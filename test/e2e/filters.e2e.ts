// Search, level chips, logger picker, time range, trace filter and their combinations.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { KNOWN_TRACE, ordersService } from '../support/mocklogs';
import { clickRow, counts, launch, levelChips, search, serve, visibleMessages, waitCounts, waitLoaded, type DevServer, type Harness } from './harness';

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
  // start every test from an unfiltered view
  const clear = page.locator('.lv-filterbar button:text("Clear filters")');
  if (await clear.count()) await clear.click();
  if (await page.$('.lv-details')) await page.click('.lv-details button[aria-label="Close"]');
  for (const t of await page.$$('.lv-search .lv-toggle.lv-on')) await t.click();
  await waitCounts(page, orders.total, orders.total);
});

describe('search', () => {
  it('matches terms in the message, case-insensitively', async () => {
    await search(page, 'ord-10042');
    const msgs = await visibleMessages(page);
    expect(msgs.length).toBe(2); // "Order created: {…ORD-10042…}" and "201 Created ORD-10042"; POST has no order id
    expect(msgs.every((m) => m.includes('ORD-10042'))).toBe(true);
  });

  it('ANDs terms, keeps "phrases" together and excludes -terms', async () => {
    await search(page, 'created ORD-10042');
    expect((await counts(page)).shown).toBe(2);
    await search(page, '"201 Created" ORD-10042');
    expect((await counts(page)).shown).toBe(1);
    await search(page, 'ORD-10042 -"201 created"');
    expect((await counts(page)).shown).toBe(1);
  });

  it('highlights the matches', async () => {
    await search(page, 'ORD-10042');
    const marks = await page.$$eval('.lv-list mark.lv-hit', (els) => els.map((e) => e.textContent));
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => m === 'ORD-10042')).toBe(true);
  });

  it('searches logger names, MDC values and exception types too', async () => {
    await search(page, 'PaymentDeclinedException');
    expect((await counts(page)).shown).toBe(orders.counts.ERROR);
    await search(page, KNOWN_TRACE);
    expect((await counts(page)).shown).toBe(3);
    await search(page, 'smallrye');
    expect((await counts(page)).shown).toBe(orders.counts.DEBUG);
  });

  it('supports regular expressions and shows invalid ones', async () => {
    await page.click('.lv-search .lv-toggle[title="Regular expression"]');
    await search(page, 'ORD-1004[0-2]\\b');
    expect((await counts(page)).shown).toBe(6);
    await search(page, '([');
    expect(await page.$eval('.lv-search', (el) => el.classList.contains('lv-invalid'))).toBe(true);
    expect((await counts(page)).shown).toBe(0);
    expect(await page.textContent('.lv-overlay-msg')).toContain('Search: Invalid regular expression');
    await search(page, '');
    expect(await page.$eval('.lv-search', (el) => el.classList.contains('lv-invalid'))).toBe(false);
  });

  it('can be case sensitive', async () => {
    await page.click('.lv-search .lv-toggle[title="Case sensitive"]');
    await search(page, 'checkout failed');
    expect((await counts(page)).shown).toBe(0);
    await search(page, 'Checkout failed');
    expect((await counts(page)).shown).toBe(orders.counts.ERROR);
  });

  it('shows a "no match" hint with a working Clear filters link', async () => {
    await search(page, 'nothing-matches-this-xyz');
    expect(await page.textContent('.lv-overlay-msg')).toContain('No entries match');
    await page.click('.lv-overlay-msg .lv-link');
    await waitCounts(page, orders.total, orders.total);
    expect(await page.inputValue('.lv-search-input')).toBe('');
  });

  it('treats regex characters literally in normal mode', async () => {
    await search(page, '/api/orders');
    expect((await counts(page)).shown).toBe(100);
    await search(page, '.*');
    expect((await counts(page)).shown).toBe(0);
  });
});

describe('levels', () => {
  it('a click shows only that level, a second click shows all again', async () => {
    await page.click('.lv-level-chip.lv-lvl-WARN');
    await waitCounts(page, orders.counts.WARN, orders.total);
    expect((await visibleMessages(page)).every((m) => m.includes('Payment call took'))).toBe(true);
    await page.click('.lv-level-chip.lv-lvl-WARN');
    await waitCounts(page, orders.total, orders.total);
  });

  it('Ctrl/⌘-click adds and removes levels', async () => {
    await page.click('.lv-level-chip.lv-lvl-ERROR');
    await page.click('.lv-level-chip.lv-lvl-WARN', { modifiers: ['ControlOrMeta'] });
    await waitCounts(page, orders.counts.ERROR + orders.counts.WARN, orders.total);
    await page.click('.lv-level-chip.lv-lvl-ERROR', { modifiers: ['ControlOrMeta'] });
    await waitCounts(page, orders.counts.WARN, orders.total);
  });

  it('Ctrl-click with all levels shown hides just that level', async () => {
    await page.click('.lv-level-chip.lv-lvl-INFO', { modifiers: ['ControlOrMeta'] });
    await waitCounts(page, orders.total - orders.counts.INFO, orders.total);
  });

  it('chip counts follow the other filters', async () => {
    await search(page, 'payment');
    const chips = await levelChips(page);
    expect(chips.WARN).toBe(orders.counts.WARN);
    expect(chips.ERROR).toBe(orders.counts.ERROR); // "payment declined"
    expect(chips.INFO ?? 0).toBe(0);
  });
});

describe('logger picker', () => {
  it('filters by one or more loggers and can be searched', async () => {
    await page.click('.lv-filterbar button:text-is("Logger")');
    await page.fill('.lv-logger-picker input', 'payment');
    const labels = await page.$$eval('.lv-logger-list label', (els) => els.map((e) => e.getAttribute('title')));
    expect(labels).toEqual(['com.example.orders.payment.PaymentClient']);
    await page.click('.lv-logger-list label');
    await waitCounts(page, orders.counts.WARN, orders.total);
    expect(await page.textContent('.lv-filterbar .lv-popover-wrap .lv-btn')).toContain('Logger (1)');
    await page.click('.lv-logger-picker button:text("All")');
    await waitCounts(page, orders.total, orders.total);
    await page.keyboard.press('Escape');
  });
});

describe('time range', () => {
  it('from/to accept HH:mm:ss on the log day (UTC) and mark invalid input', async () => {
    const from = page.locator('.lv-time-input').nth(0);
    const to = page.locator('.lv-time-input').nth(1);
    await from.fill('09:00:03');
    await from.press('Enter');
    await to.fill('09:00:05.999');
    await to.press('Enter');
    // cycles 10..19 start at 09:00:03.000 … 09:00:05.700 (300 ms apart)
    const shown = (await counts(page)).shown;
    expect(shown).toBeGreaterThan(20);
    expect(shown).toBeLessThan(45);
    const times = await page.$$eval('.lv-list .lv-c-time', (els) => els.map((e) => e.textContent ?? ''));
    expect(times.every((t) => t >= '09:00:03.000' && t <= '09:00:05.999')).toBe(true);
    await from.fill('25:99');
    await from.press('Enter');
    expect(await from.evaluate((el) => el.classList.contains('lv-invalid'))).toBe(true);
    await from.fill('');
    await from.press('Enter');
    await to.fill('');
    await to.press('Enter');
    await waitCounts(page, orders.total, orders.total);
  });
});

describe('trace filter', () => {
  it('clicking the traceId in details shows the whole request; the chip clears it', async () => {
    await search(page, 'ORD-10007');
    await clickRow(page, 'Order created');
    await page.click(`.lv-fields button.lv-link:text("${KNOWN_TRACE}")`);
    await search(page, '');
    await waitCounts(page, 3, orders.total);
    expect(await page.textContent('.lv-trace-chip')).toContain(KNOWN_TRACE.slice(0, 10));
    await page.click('.lv-trace-chip .lv-chip-x');
    await waitCounts(page, orders.total, orders.total);
  });

  it('filters combine (trace + level + search) and Clear filters resets all', async () => {
    await search(page, 'ORD-10024');
    await clickRow(page, 'Checkout failed');
    await page.click('.lv-fields button.lv-link[title="Show all related entries"]');
    await page.click('.lv-level-chip.lv-lvl-ERROR');
    await search(page, 'declined');
    await waitCounts(page, 1, orders.total);
    await page.click('.lv-filterbar button:text("Clear filters")');
    await waitCounts(page, orders.total, orders.total);
    expect(await page.$('.lv-trace-chip')).toBeNull();
  });
});

describe('health', () => {
  it('no page errors', () => {
    expect(h.errors).toEqual([]);
  });
});
