// What the page around the viewer can and can't make LogPane do: a reload that lands on a login page,
// page scripts clicking LogPane's buttons, a view saved for a different page.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ordersService } from '../support/mocklogs';
import { launch, serve, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
/** The viewer's own requests fail, and every page load after the first lands on a login page (expired session). */
let expiring: DevServer;
let srv: DevServer;
const orders = ordersService(30);

beforeAll(async () => {
  h = await launch();
  expiring = await serve({ logs: { orders: orders.text }, rejectFetch: 'network', loginAfterNavigations: 1 });
  srv = await serve({ logs: { orders: orders.text } });
});
afterAll(async () => {
  await h?.close();
  await expiring?.close();
  await srv?.close();
});

const activeTabState = () =>
  h.sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return { badge: await chrome.action.getBadgeText({ tabId: tab.id }), saved: Object.keys(await chrome.storage.session.get(null)) };
  });

describe('reloading into an expired session', () => {
  it('a Reload that lands on an HTML login page leaves that page alone', async () => {
    const page = await h.openManual(expiring.url('orders'));
    await waitLoaded(page, orders.total);
    await page.click('button:text("⟳ Reload")');
    await page.waitForURL(/\/login\?/, { timeout: 15000 });
    await page.waitForLoadState('load');
    await page.waitForTimeout(800); // the background reacts to the tab's 'complete'
    expect(await page.title()).toBe('Log in');
    expect(await page.$('#lv-root')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.classList.contains('lv-pending'))).toBe(false);
    expect(await activeTabState()).toEqual({ badge: '', saved: [] });
    await page.close();
  });
});

describe('page scripts', () => {
  it("can't open the setup window or dismiss the suggestion; real clicks open one window at a time", async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    const setupWindows = () => h.ctx.pages().filter((p) => p.url().includes('/options.html'));
    // page.evaluate runs in the page's own world, like the page's scripts: its clicks are not trusted
    await page.evaluate(() => {
      (document.querySelector('.lv-banner .lv-primary') as HTMLElement).click();
      (Array.from(document.querySelectorAll('.lv-banner button')).find((b) => b.textContent === 'Not now') as HTMLElement).click();
    });
    await page.click('button:text("View ▾")');
    await page.evaluate(() => (document.querySelector('.lv-menu-item') as HTMLElement).click());
    await page.waitForTimeout(1000);
    expect(setupWindows()).toHaveLength(0);
    expect(await page.$('.lv-banner')).not.toBeNull();
    expect((await h.storage()).autoPromptDismissed).toBeUndefined();

    const [first] = await Promise.all([h.ctx.waitForEvent('page'), page.click('.lv-menu-item')]);
    await first.waitForLoadState();
    const [second] = await Promise.all([h.ctx.waitForEvent('page'), page.click('.lv-menu-item')]);
    await second.waitForLoadState();
    await page.waitForTimeout(500);
    expect(setupWindows()).toEqual([second]);
    await second.close();
    await page.close();
  });

  it("can't drive the viewer with synthetic key presses", async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })));
    expect(await page.evaluate(() => document.activeElement?.classList.contains('lv-search-input'))).toBe(false);
    await page.keyboard.press('/');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('lv-search-input'))).toBe(true);
    await page.close();
  });
});

describe('saved views', () => {
  it('a view saved for a different page is not handed over, and is forgotten', async () => {
    const page = await h.newPage();
    await page.goto(srv.url('orders'));
    await page.bringToFront();
    await h.sw.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.storage.session.set({ [`reload:${tab.id}`]: { url: `${url}&other=1`, state: { query: 'kept for another page' }, reopen: false, at: Date.now() } });
    }, page.url());
    await h.inject(page);
    await waitLoaded(page, orders.total);
    expect(await page.inputValue('.lv-search-input')).toBe('');
    expect((await activeTabState()).saved).toEqual([]);
    await page.close();
  });
});

describe('health', () => {
  it('no page errors (only the deliberately failing network requests)', () => {
    const port = String(expiring.port);
    expect(h.errors.filter((e) => !(e.includes(`:${port}/`) && /ERR_EMPTY_RESPONSE|Failed to load resource|Failed to fetch/.test(e)))).toEqual([]);
  });
});
