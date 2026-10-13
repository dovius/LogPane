// Hostile and unusual content, display settings, themes and small screens.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { EDGE_LINES, ordersService } from '../support/mocklogs';
import { clickRow, fitsHorizontally, launch, search, serve, visibleMessages, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
let srv: DevServer;
const orders = ordersService(40);
const edge = Object.values(EDGE_LINES);

/** Lines built to freeze or crash a naive viewer when the entry is opened. */
const CRAFTED = [
  `{"timestamp":"2026-10-01T09:00:00Z","level":"INFO","message":"DEEP FIELD","data":${'['.repeat(20_000)}1${']'.repeat(20_000)}}`,
  JSON.stringify({ timestamp: '2026-10-01T09:00:01Z', level: 'ERROR', message: 'SPACE FRAME', stack_trace: `x.Boom: b\n\tat ${' '.repeat(200_000)}x\n\tat a.B.c(B.java:1)` }),
  `2026-10-01 09:00:02 ERROR SEPARATORS\n ${'\u2028'.repeat(200_000)}q`,
  JSON.stringify({ timestamp: '2026-10-01T09:00:03Z', level: 'WARN', message: 'BIDI invoice\u202Efdp.exe \u001b[31mred\u001b[0m', user: 'eve\u2066x\u2069' }),
  JSON.stringify({ timestamp: '2026-10-01T09:00:04Z', level: 'INFO', message: 'MANY FIELDS', ...Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`f${i}`, i])) }),
];

beforeAll(async () => {
  h = await launch();
  srv = await serve({ logs: { edge: edge.join('\n'), orders: orders.text, crafted: CRAFTED.join('\n') } });
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
      await page.click('.lv-details summary:has-text("Raw")');
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

  it('crafted entries open quickly and completely, without errors', async () => {
    const page = await h.openManual(srv.url('crafted'));
    await waitLoaded(page, CRAFTED.length);
    for (const marker of ['DEEP FIELD', 'SPACE FRAME', 'SEPARATORS', 'BIDI', 'MANY FIELDS']) {
      const t0 = Date.now();
      await clickRow(page, marker);
      await page.waitForSelector('.lv-details-body');
      expect(Date.now() - t0, marker).toBeLessThan(3000);
      expect(await page.$('.lv-details-broken'), marker).toBeNull();
      await page.click('.lv-details summary:has-text("Raw")');
      expect((await page.textContent('.lv-details details[open] .lv-pre'))?.length, marker).toBeGreaterThan(0);
    }
    // the deep one: shown as its raw line, the stack frame of spaces as text
    await clickRow(page, 'DEEP FIELD');
    await page.click('.lv-details summary:has-text("Raw")');
    expect(await page.textContent('.lv-details details[open] .lv-pre')).toContain('"message":"DEEP FIELD"');
    await clickRow(page, 'SPACE FRAME');
    expect(await page.textContent('.lv-stack')).toContain('Show 2 more lines'); // the 200 000-char frame is past the limit
    await page.click('.lv-stack .lv-show-all');
    expect(await page.textContent('.lv-stack')).toContain('at a.B.c(B.java:1)');
    // hidden reordering and colour codes are made visible / dropped
    await clickRow(page, 'BIDI');
    const msg = (await page.textContent('.lv-details .lv-msg')) ?? '';
    expect(msg).toBe('BIDI invoice⟨U+202E⟩fdp.exe red');
    expect(await page.textContent('.lv-details-body')).toContain('eve⟨U+2066⟩x⟨U+2069⟩');
    expect((await visibleMessages(page)).find((m) => m.startsWith('BIDI'))).toBe('BIDI invoice⟨U+202E⟩fdp.exe red');
    // thousands of fields: the first ones, and the rest on request
    await clickRow(page, 'MANY FIELDS');
    expect(await page.$$eval('.lv-frows .lv-frow', (els) => els.length)).toBeLessThan(400);
    await page.click('.lv-show-all:has-text("more fields")');
    expect(await page.$$eval('.lv-frows .lv-frow', (els) => els.length)).toBeGreaterThan(5000);
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
    expect(await page.textContent('.lv-head')).toContain('UTC');
    await page.click('button:text("View ▾")');
    await page.click('.lv-seg button:text("Local")');
    await firstTime('12:00:00.000'); // Europe/Vilnius, summer time
    expect(await page.textContent('.lv-head')).toContain('local');
    expect(((await h.storage()).lvSettings as { timeMode: string }).timeMode).toBe('local');
    await page.reload();
    await h.inject(page);
    await waitLoaded(page, orders.total);
    await page.click('button:text("View ▾")');
    expect(await page.getAttribute('.lv-seg button:text("Local")', 'class')).toContain('lv-on');
    await page.click('.lv-seg button:text("UTC")');
    await page.close();
  });

  it('A− / A+ change the text and row size', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    const height = () => page.$eval('.lv-list .lv-row', (el) => el.getBoundingClientRect().height);
    const before = await height();
    await page.click('button:text("View ▾")');
    const smaller = page.locator('.lv-seg button:text("A−")');
    await page.click('.lv-seg button:text("A+")');
    await page.click('.lv-seg button:text("A+")');
    expect(await height()).toBeGreaterThan(before);
    expect(await page.textContent('.lv-view-menu')).toContain('14px');
    for (let i = 0; i < 20 && !(await smaller.isDisabled()); i++) await smaller.click();
    expect(await smaller.isDisabled()).toBe(true); // clamped
    expect(((await h.storage()).lvSettings as { fontSize: number }).fontSize).toBe(9);
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
