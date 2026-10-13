// Reload and Tail where the page can't be fetched again by the viewer: local files (file://, like a
// downloaded log dropped into Chrome), consoles that fail the request (network / CORS) or answer with a
// login page. All of them must reload the tab like F5 and come back with the same view.
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { ordersService, quarkusLine } from '../support/mocklogs';
import { clickRow, counts, launch, search, serve, visibleMessages, waitCounts, waitReady, type DevServer, type Harness } from './harness';

let h: Harness;
let network: DevServer;
let login: DevServer;
const orders = ordersService(30);
const dir = mkdtempSync(join(tmpdir(), 'logpane-local-'));
const file = join(dir, 'orders-service-6f7c9d8b4-x2k4p-orders-service.log');
let seq = 50_000;
const line = (msg: string, level: 'INFO' | 'ERROR' = 'INFO') =>
  quarkusLine({ ms: Date.parse('2026-10-01T11:00:00Z') + seq, seq: seq++, level, logger: 'reload.test', message: msg });

beforeAll(async () => {
  h = await launch();
  await h.enableFileAccess();
  writeFileSync(file, orders.text);
  network = await serve({ logs: { orders: orders.text }, rejectFetch: 'network' });
  login = await serve({ logs: { orders: orders.text }, rejectFetch: 'login-page' });
});
afterAll(async () => {
  await h?.close();
  await network?.close();
  await login?.close();
});

const tail = (page: Page) => page.locator('.lv-header-right .lv-select select');
const reloadAndWait = async (page: Page) => {
  await Promise.all([page.waitForEvent('load', { timeout: 15000 }), page.click('button[aria-label="Reload"]')]);
  await page.waitForSelector('#lv-root .lv-list .lv-row', { timeout: 15000 });
};

describe('local file (file://)', () => {
  it('Reload re-reads the file from disk and keeps the view, without fetch errors', async () => {
    const page = await h.openManual(`file://${file}`);
    const total = await waitReady(page);
    expect(await page.textContent('.lv-src-chip .lv-src-label')).toBe('orders-service-6f7c9d8b4-x2k4p-orders-service');
    expect(await page.$('button:text("+ Add log")')).not.toBeNull();
    await search(page, 'checkout failed');
    await clickRow(page, 'Checkout failed');
    appendFileSync(file, `${line('Checkout failed again after reload', 'ERROR')}\n`);
    await reloadAndWait(page);
    await waitCounts(page, 2, total + 1);
    expect(await page.inputValue('.lv-search-input')).toBe('checkout failed');
    expect(await page.textContent('.lv-details .lv-pre')).toContain('Checkout failed for ORD-10024');
    expect(await page.$('.lv-src-chip.lv-err')).toBeNull();
    await page.close();
  });

  it('Tail reloads the page (Tail ↻) and shows lines appended to the file', async () => {
    const page = await h.openManual(`file://${file}`);
    const total = await waitReady(page);
    expect(await page.$('.lv-header-right .lv-select .lv-tail-reload')).not.toBeNull(); // "Tail ↻"
    await tail(page).selectOption('2');
    appendFileSync(file, `${line('appended while tailing')}\n`);
    await page.waitForEvent('load', { timeout: 20000 });
    await page.waitForSelector('#lv-root .lv-list .lv-row', { timeout: 15000 });
    await waitCounts(page, total + 1, total + 1);
    expect((await visibleMessages(page)).at(-1)).toBe('appended while tailing');
    expect(await tail(page).inputValue()).toBe('2');
    await tail(page).selectOption('0');
    await page.close();
  });

  it('adding logs by URL is not offered where nothing can be fetched', async () => {
    const page = await h.openManual(`file://${file}`);
    await waitReady(page);
    await page.click('button:text("+ Add log")');
    expect(await page.$$eval('.lv-modal textarea', (els) => els.length)).toBe(1); // only "paste log text"
    await page.keyboard.press('Escape');
    await page.close();
  });
});

describe('console that fails the request (network / CORS error)', () => {
  it('Reload reloads the page and keeps the view', async () => {
    const page = await h.openManual(network.url('orders'));
    const total = await waitReady(page);
    await search(page, 'ORD-10007');
    network.append('orders', [line('ORD-10007 refund')]);
    await reloadAndWait(page);
    await waitCounts(page, 3, total + 1);
    expect(await page.inputValue('.lv-search-input')).toBe('ORD-10007');
    expect(await page.$('.lv-src-chip.lv-err')).toBeNull();
    await page.close();
  });

  it('Tail switches to page reloads after the first failed request', async () => {
    const page = await h.openManual(network.url('orders'));
    const total = await waitReady(page);
    await tail(page).selectOption('2');
    await page.waitForFunction(() => Boolean(document.querySelector('.lv-header-right .lv-select .lv-tail-reload')), null, { timeout: 8000 });
    expect(await page.$('.lv-src-chip.lv-err')).toBeNull();
    network.append('orders', [line('tailed over a failing network')]);
    await page.waitForEvent('load', { timeout: 20000 });
    await page.waitForSelector('#lv-root .lv-list .lv-row', { timeout: 15000 });
    await waitCounts(page, total + 1, total + 1);
    await tail(page).selectOption('0');
    await page.close();
  });
});

describe('console that answers with a login page (session expired)', () => {
  it('Reload reloads the page instead of showing an error', async () => {
    const page = await h.openManual(login.url('orders'));
    await waitReady(page);
    await search(page, 'payment');
    await reloadAndWait(page);
    expect(await page.inputValue('.lv-search-input')).toBe('payment');
    expect(await page.$('.lv-src-chip.lv-err')).toBeNull();
    await page.close();
  });
});

describe('when the viewer cannot be reopened after a reload', () => {
  it('the toolbar button gets a ↻ badge, and the saved view is kept for the next click', async () => {
    // 127.0.0.1 is not covered by the test copy's host access, like a page without activeTab.
    const page = await h.newPage();
    await page.goto(network.url('orders').replace('localhost', '127.0.0.1'));
    await page.bringToFront();
    const result = await h.sw.evaluate(async (url) => {
      // without access to the site the tab's URL is hidden from the extension: take the active tab
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.storage.session.set({ [`reload:${tab.id}`]: { url, state: { query: 'kept' }, reopen: true } });
      await chrome.tabs.reload(tab.id!);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const badge = await chrome.action.getBadgeText({ tabId: tab.id });
        if (badge) return { badge, title: await chrome.action.getTitle({ tabId: tab.id }), pending: await chrome.storage.session.get(`reload:${tab.id}`) };
      }
      return null;
    }, page.url());
    expect(result?.badge).toBe('↻');
    expect(result?.title).toBe('Click to reopen LogPane on this page');
    expect(Object.values(result?.pending ?? {})).toHaveLength(1);
    expect(await page.$('#lv-root')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.classList.contains('lv-pending'))).toBe(false);
    await page.close();
  });
});

describe('health', () => {
  it('no page errors (only the deliberately failing network requests)', () => {
    const port = String(network.port);
    expect(h.errors.filter((e) => !(e.includes(`:${port}/`) && /ERR_EMPTY_RESPONSE|Failed to load resource|Failed to fetch/.test(e)))).toEqual([]);
    expect(h.errors.some((e) => e.includes('file://'))).toBe(false); // nothing is fetched from local files
  });
});
