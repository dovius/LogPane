// Reload and Tail, on a console that accepts the viewer's requests and on one that only accepts page loads.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { iso, ordersService, quarkusLine } from '../support/mocklogs';
import { clickRow, counts, launch, search, serve, visibleMessages, waitCounts, waitLoaded, waitReady, type DevServer, type Harness } from './harness';

let h: Harness;
let normal: DevServer;
let strict: DevServer;
const orders = ordersService(30);
let seq = 9000;
const newLine = (msg: string, level = 'INFO') =>
  quarkusLine({ ms: Date.parse('2026-10-01T10:00:00Z') + seq * 10, seq: seq++, level: level as 'INFO', logger: 'tail.test', message: msg });

beforeAll(async () => {
  h = await launch();
  normal = await serve({ logs: { orders: orders.text } });
  strict = await serve({ logs: { orders: orders.text }, navigationOnly: true });
});
afterAll(async () => {
  await h?.close();
  await normal?.close();
  await strict?.close();
});

const tailSelect = (page: Page) => page.locator('.lv-header-right .lv-select select');
const marker = (page: Page) => page.evaluate(() => (window as unknown as { __marker?: number }).__marker);

describe('console that accepts the viewer requests', () => {
  it('Reload fetches again without reloading the page and keeps filters', async () => {
    const page = await h.openManual(normal.url('orders'));
    await waitLoaded(page, orders.total);
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await search(page, '"Order created"');
    normal.append('orders', [newLine('Order created: reload-1')]);
    await page.click('button:text("⟳ Reload")');
    await waitCounts(page, 31, orders.total + 1);
    expect(await marker(page)).toBe(1);
    expect(await page.textContent('.lv-toast')).toBe('Reloaded');
    await page.close();
  });

  it('Tail adds new lines once, follows the bottom and stops when switched off', async () => {
    const page = await h.openManual(normal.url('orders'));
    const start = await waitReady(page);
    await tailSelect(page).selectOption('2');
    normal.append('orders', [newLine('tail A'), newLine('tail B', 'WARN')]);
    await waitCounts(page, start + 2, start + 2, 8000);
    normal.append('orders', [newLine('tail C', 'ERROR')]);
    await waitCounts(page, start + 3, start + 3, 8000);
    expect((await visibleMessages(page)).slice(-3)).toEqual(['tail A', 'tail B', 'tail C']);
    expect(await page.$eval('.lv-list', (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 30)).toBe(true);
    // no duplicates after more polls with nothing new
    await page.waitForTimeout(4500);
    expect((await counts(page)).total).toBe(start + 3);
    await tailSelect(page).selectOption('0');
    normal.append('orders', [newLine('after tail off')]);
    await page.waitForTimeout(3000);
    expect((await counts(page)).total).toBe(start + 3);
    await page.close();
  });

  it('Tail does not yank the view when the user scrolled up', async () => {
    const page = await h.openManual(normal.url('orders'));
    await waitReady(page);
    await page.keyboard.press('g');
    await page.waitForTimeout(100);
    await tailSelect(page).selectOption('2');
    const total = (await counts(page)).total;
    normal.append('orders', [newLine('while scrolled up')]);
    await waitCounts(page, total + 1, total + 1, 8000);
    expect(await page.$eval('.lv-list', (el) => el.scrollTop)).toBe(0);
    await tailSelect(page).selectOption('0');
    await page.close();
  });
});

describe('console that only accepts page loads (401 for the viewer requests)', () => {
  it('Reload reloads the tab and restores search, filters and selection', async () => {
    const page = await h.openManual(strict.url('orders'));
    const total = await waitReady(page);
    await search(page, 'ORD-10024');
    await page.click('.lv-level-chip.lv-lvl-ERROR');
    await clickRow(page, 'Checkout failed');
    strict.append('orders', [newLine('Checkout failed for ORD-10024 again', 'ERROR')]);
    await Promise.all([page.waitForEvent('load'), page.click('button:text("⟳ Reload")')]);
    await page.waitForSelector('#lv-root .lv-list .lv-row', { timeout: 10000 });
    await waitCounts(page, 2, total + 1);
    expect(await page.inputValue('.lv-search-input')).toBe('ORD-10024');
    expect(await page.getAttribute('.lv-level-chip.lv-lvl-ERROR', 'class')).toContain('lv-solo');
    expect(await page.textContent('.lv-details .lv-pre')).toContain('Checkout failed for ORD-10024: payment declined');
    expect(await page.$('.lv-src-chip.lv-err')).toBeNull();
    await page.close();
  });

  it('Tail switches to reloading the page (Tail ↻) and keeps tailing', async () => {
    const page = await h.openManual(strict.url('orders'));
    const total = await waitReady(page);
    await tailSelect(page).selectOption('2');
    await page.waitForFunction(() => document.querySelector('.lv-header-right .lv-select')?.textContent?.includes('↻'), null, { timeout: 8000 });
    expect(await page.$('.lv-src-chip.lv-err')).toBeNull();
    strict.append('orders', [newLine('arrives by reload')]);
    await page.waitForEvent('load', { timeout: 20000 });
    await page.waitForSelector('#lv-root .lv-list .lv-row', { timeout: 10000 });
    await waitCounts(page, total + 1, total + 1);
    expect(await page.textContent('.lv-header-right .lv-select')).toContain('↻');
    expect(await tailSelect(page).inputValue()).toBe('2');
    expect((await visibleMessages(page)).at(-1)).toBe('arrives by reload');
    await tailSelect(page).selectOption('0');
    await page.close();
  });

  it('auto-opened pages come back after Reload without re-injection', async () => {
    await h.setAutoOrigins([`http://localhost:${strict.port}`]);
    const page = await h.newPage();
    await page.goto(strict.url('orders'));
    await page.waitForSelector('#lv-root .lv-list .lv-row');
    await search(page, 'payment');
    await Promise.all([page.waitForEvent('load'), page.click('button:text("⟳ Reload")')]);
    await page.waitForSelector('#lv-root .lv-list .lv-row', { timeout: 10000 });
    expect(await page.inputValue('.lv-search-input')).toBe('payment');
    await page.close();
    await h.setAutoOrigins([]);
  });
});

describe('health', () => {
  it('no page errors (401s from the strict console are expected network errors)', () => {
    expect(h.errors.filter((e) => !e.includes('401'))).toEqual([]);
  });
});
