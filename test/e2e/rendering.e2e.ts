// Hostile and unusual content, display settings, themes and small screens.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { EDGE_LINES, ordersService } from '../support/mocklogs';
import { clickRow, fitsHorizontally, launch, search, serve, visibleMessages, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
let srv: DevServer;
const orders = ordersService(40);
const edge = Object.values(EDGE_LINES);

beforeAll(async () => {
  h = await launch();
  srv = await serve({ logs: { edge: edge.join('\n'), orders: orders.text } });
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
});

async function openEdge(): Promise<Page> {
  const page = await h.openManual(srv.url('edge'));
  await waitLoaded(page, edge.length);
  return page;
}

describe('hostile and unusual content', () => {
  it('never runs injected markup, in rows, details or raw JSON', async () => {
    const page = await openEdge();
    for (const text of ['img src=x', 'keys', 'proto']) {
      await search(page, text);
      await clickRow(page, text === 'img src=x' ? 'onerror' : text);
      await page.click('.lv-details summary');
    }
    await search(page, '');
    const result = await page.evaluate(() => ({
      pwned: (window as unknown as { __pwned?: number }).__pwned ?? null,
      injected: document.querySelectorAll('#lv-root img, #lv-root svg, #lv-root script, #lv-root [onerror], #lv-root [onload], #lv-root [onmouseover]').length,
      polluted: ({} as Record<string, unknown>).polluted ?? null,
    }));
    expect(result).toEqual({ pwned: null, injected: 0, polluted: null });
    await page.close();
  });

  it('shows unicode, control characters and odd values as text', async () => {
    const page = await openEdge();
    const msgs = await visibleMessages(page);
    expect(msgs.some((m) => m.includes('Ąžuolas čiurlena ėžerą 💥 日本語 עברית العربية'))).toBe(true);
    expect(msgs.some((m) => m.includes('12345'))).toBe(true); // numeric message
    expect(msgs.some((m) => m.includes('"nested":{"a":[1,2,3]}'))).toBe(true); // object message
    expect(msgs.some((m) => m.includes('chars .*+?^${}()|[]\\ and /slashes/'))).toBe(true);
    await search(page, 'ąžuolas');
    expect(await page.$$eval('mark.lv-hit', (els) => els.map((e) => e.textContent))).toEqual(['Ąžuolas']);
    await page.close();
  });

  it('keeps a 200 000-character line usable: short in the list, complete in details', async () => {
    const page = await openEdge();
    await search(page, 'LONG');
    const rowText = (await visibleMessages(page))[0];
    expect(rowText.length).toBeLessThan(500);
    await clickRow(page, 'LONG');
    const full = await page.$eval('.lv-details section .lv-pre', (el) => el.textContent?.length ?? 0);
    expect(full).toBeGreaterThan(200_000);
    await page.close();
  });

  it('deeply nested and broken JSON lines do not break anything', async () => {
    const page = await openEdge();
    await search(page, 'deep');
    expect((await visibleMessages(page)).length).toBeGreaterThan(0);
    await search(page, 'cut in the mid');
    expect((await visibleMessages(page)).length).toBe(1);
    await page.close();
  });
});

describe('display settings', () => {
  it('UTC / Local switches the time column and is remembered', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    await page.keyboard.press('g');
    const firstTime = (t: string) => page.waitForFunction((x) => document.querySelector('.lv-list .lv-c-time')?.textContent === x, t);
    await firstTime('09:00:00.000');
    await page.click('.lv-seg button:text("Local")');
    await firstTime('12:00:00.000'); // Europe/Vilnius, summer time
    expect(((await h.storage()).lvSettings as { timeMode: string }).timeMode).toBe('local');
    await page.reload();
    await h.inject(page);
    await waitLoaded(page, orders.total);
    expect(await page.getAttribute('.lv-seg button:text("Local")', 'class')).toContain('lv-on');
    await page.click('.lv-seg button:text("UTC")');
    await page.close();
  });

  it('A− / A+ change the text and row size', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    const height = () => page.$eval('.lv-list .lv-row', (el) => el.getBoundingClientRect().height);
    const before = await height();
    await page.click('.lv-seg button:text("A+")');
    await page.click('.lv-seg button:text("A+")');
    expect(await height()).toBeGreaterThan(before);
    for (let i = 0; i < 20; i++) await page.click('.lv-seg button:text("A−")');
    expect(((await h.storage()).lvSettings as { fontSize: number }).fontSize).toBe(9); // clamped
    for (let i = 0; i < 3; i++) await page.click('.lv-seg button:text("A+")');
    await page.close();
  });

  it('View menu toggles the logger and thread columns', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    await page.click('button:text("View ▾")');
    await page.click('.lv-menu label:has-text("Thread column") input');
    expect(await page.textContent('.lv-head')).toContain('Thread');
    await page.click('.lv-menu label:has-text("Logger column") input');
    expect(await page.textContent('.lv-head')).not.toContain('Logger');
    await page.click('.lv-menu label:has-text("Logger column") input');
    await page.click('.lv-menu label:has-text("Thread column") input');
    expect(await page.textContent('.lv-help')).toContain('next / previous error');
    await page.keyboard.press('Escape');
    expect(await page.$('.lv-menu')).toBeNull();
    await page.close();
  });
});

describe('accessibility basics', () => {
  it('every button, input and select has an accessible name (menus and dialog open too)', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    await clickRow(page, 'Order created');
    const unnamed = async () =>
      page.$$eval('#lv-root button, #lv-root input, #lv-root select, #lv-root textarea', (els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null || el.tagName === 'SELECT')
          .filter((el) => {
            const label = el.closest('label')?.textContent?.trim();
            const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.textContent ?? '').trim() || label;
            return !name;
          })
          .map((el) => el.outerHTML.slice(0, 120)),
      );
    expect(await unnamed()).toEqual([]);
    await page.click('button:text("View ▾")');
    expect(await unnamed()).toEqual([]);
    await page.keyboard.press('Escape');
    await page.click('.lv-filterbar button:text-is("Logger")');
    expect(await unnamed()).toEqual([]);
    await page.keyboard.press('Escape');
    await page.click('button:text("+ Add log")');
    expect(await unnamed()).toEqual([]);
    await page.keyboard.press('Escape');
    await page.close();
  });
});

describe('themes and small screens', () => {
  it('follows the dark system theme', async () => {
    const page = await h.newPage({ dark: true });
    await page.goto(srv.url('orders'));
    await h.inject(page);
    await waitLoaded(page, orders.total);
    const bg = await page.$eval('.lv-app', (el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(13, 17, 23)');
    await page.close();
  });

  for (const width of [360, 768, 1024]) {
    it(`fits a ${width}px wide window without horizontal scrolling`, async () => {
      const page = await h.openManual(srv.url('orders'));
      await page.setViewportSize({ width, height: 800 });
      await waitLoaded(page, orders.total);
      await clickRow(page, 'Order created');
      expect(await fitsHorizontally(page)).toBe(true);
      await page.close();
    });
  }
});

describe('health', () => {
  it('no page errors', () => {
    expect(h.errors).toEqual([]);
  });
});
