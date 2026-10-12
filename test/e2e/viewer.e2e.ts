// Opening a Raw log page: what the user sees first, every supported format, Raw toggle.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGE_LINES, FORMAT_LINES, PLAIN_JAVA_LOG, ordersService } from '../support/mocklogs';
import { counts, launch, levelChips, serve, visibleMessages, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
let srv: DevServer;
const orders = ordersService(100);

beforeAll(async () => {
  h = await launch();
  srv = await serve({
    logs: {
      'orders-6f7c9d8b4-x2k4p': orders.text,
      formats: FORMAT_LINES.map((f) => f.line).join('\n'),
      'plain-java': PLAIN_JAVA_LOG,
      empty: '',
      'blank-lines': '\n\n   \n',
      crlf: FORMAT_LINES.slice(0, 3).map((f) => f.line).join('\r\n'),
      bom: `﻿${FORMAT_LINES[0].line}\n${FORMAT_LINES[1].line}\n`,
      'no-trailing-newline': FORMAT_LINES.slice(0, 2).map((f) => f.line).join('\n'),
      mixed: [FORMAT_LINES[0].line, EDGE_LINES.brokenJson, 'plain line in between', EDGE_LINES.arrayLine, FORMAT_LINES[1].line].join('\n'),
    },
  });
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
});

describe('opening a Raw log page', () => {
  it('shows every entry with correct level counts', async () => {
    const page = await h.openManual(srv.url('orders-6f7c9d8b4-x2k4p', 'orders'));
    await waitLoaded(page, orders.total);
    expect(await levelChips(page)).toEqual({ ERROR: orders.counts.ERROR, WARN: orders.counts.WARN, INFO: orders.counts.INFO, DEBUG: orders.counts.DEBUG });
    expect(await counts(page)).toEqual({ shown: orders.total, total: orders.total });
    await page.close();
  });

  it('starts at the bottom (newest entries), hides the raw text and names the tab', async () => {
    const page = await h.openManual(srv.url('orders-6f7c9d8b4-x2k4p', 'orders'));
    await waitLoaded(page, orders.total);
    expect(await page.$eval('.lv-list', (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 30)).toBe(true);
    expect((await visibleMessages(page)).slice(-3).join('|')).toContain('201 Created ORD-10099');
    expect(await page.$eval('body > pre', (el) => getComputedStyle(el).contentVisibility)).toBe('hidden');
    expect(await page.title()).toBe('orders (x2k4p) – LogPane');
    expect(await page.textContent('.lv-src-chip')).toContain('orders (x2k4p)');
    await page.close();
  });

  it('Raw shows the original text and the floating button brings the viewer back', async () => {
    const page = await h.openManual(srv.url('orders-6f7c9d8b4-x2k4p', 'orders'));
    await waitLoaded(page, orders.total);
    await page.click('.lv-header-right button:text-is("Raw")');
    expect(await page.$eval('#lv-root', (el) => getComputedStyle(el).display)).toBe('none');
    expect(await page.$eval('body > pre', (el) => getComputedStyle(el).contentVisibility)).toBe('visible');
    expect(await page.isVisible('#lv-reopen')).toBe(true);
    await page.click('#lv-reopen');
    expect(await page.isVisible('#lv-root .lv-list')).toBe(true);
    expect(await page.isVisible('#lv-reopen')).toBe(false);
    await page.close();
  });

  it('injecting twice does not mount a second viewer', async () => {
    const page = await h.openManual(srv.url('orders-6f7c9d8b4-x2k4p', 'orders'));
    await waitLoaded(page, orders.total);
    await h.sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    });
    await page.waitForTimeout(300);
    expect(await page.$$eval('#lv-root', (els) => els.length)).toBe(1);
    await page.close();
  });
});

describe('formats', () => {
  it('reads every supported JSON log format and plain text', async () => {
    const page = await h.openManual(srv.url('formats'));
    await waitLoaded(page, FORMAT_LINES.length);
    const rows = await page.$$eval('.lv-list .lv-row', (els) =>
      els.map((r) => ({ level: r.querySelector('.lv-c-level')?.textContent ?? '', logger: r.querySelector('.lv-c-logger')?.getAttribute('title') ?? '', msg: r.querySelector('.lv-c-msg')?.textContent ?? '' })),
    );
    for (const f of FORMAT_LINES) {
      const row = rows.find((r) => r.msg.includes(f.expect.message));
      expect(row, f.name).toBeDefined();
      expect(row!.level, f.name).toBe(f.expect.level);
      if (f.expect.logger) expect(row!.logger, f.name).toBe(f.expect.logger);
    }
    await page.close();
  });

  it('keeps entries in file order', async () => {
    const page = await h.openManual(srv.url('formats'));
    await waitLoaded(page, FORMAT_LINES.length);
    const msgs = await visibleMessages(page);
    const order = FORMAT_LINES.map((f) => msgs.findIndex((m) => m.includes(f.expect.message)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    await page.close();
  });

  it('folds plain-text stack traces into one entry', async () => {
    const page = await h.openManual(srv.url('plain-java'));
    await waitLoaded(page, 3);
    expect(await levelChips(page)).toEqual({ ERROR: 1, WARN: 1, INFO: 1 });
    await page.locator('.lv-list .lv-row', { hasText: 'Boom' }).click();
    const message = await page.textContent('.lv-details section .lv-pre');
    expect(message).toContain('java.lang.IllegalStateException: boom');
    expect(message).toContain('Caused by: java.io.IOException: disk full');
    await page.close();
  });

  it('handles CRLF line endings, a BOM and a missing final newline', async () => {
    for (const [pod, n] of [['crlf', 3], ['bom', 2], ['no-trailing-newline', 2]] as const) {
      const page = await h.openManual(srv.url(pod));
      await waitLoaded(page, n);
      const msgs = await visibleMessages(page);
      expect(msgs.some((m) => m.includes('\r')), pod).toBe(false);
      expect(await levelChips(page), pod).not.toHaveProperty('plain');
      await page.close();
    }
  });

  it('shows broken and non-JSON lines as plain entries without dropping anything', async () => {
    const page = await h.openManual(srv.url('mixed'));
    await waitLoaded(page, 5);
    const msgs = await visibleMessages(page);
    expect(msgs.some((m) => m.includes('cut in the mid'))).toBe(true);
    expect(msgs.some((m) => m.includes('plain line in between'))).toBe(true);
    expect(msgs.some((m) => m.includes('[1,2,3]'))).toBe(true);
    await page.close();
  });

  it('opens empty and blank logs without errors', async () => {
    for (const pod of ['empty', 'blank-lines']) {
      const page = await h.openManual(srv.url(pod));
      await page.waitForSelector('.lv-count');
      await page.waitForTimeout(300);
      expect(await counts(page), pod).toEqual({ shown: 0, total: 0 });
      await page.close();
    }
  });
});

describe('health', () => {
  it('no page errors', () => {
    expect(h.errors).toEqual([]);
  });
});
