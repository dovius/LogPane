// The toolbar icon: grey everywhere, in colour in the tabs where LogPane is open.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { ordersService } from '../support/mocklogs';
import { DIST, launch, serve, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
let srv: DevServer;
const orders = ordersService(20);
const ACTIVE = 'icons/icon16.png';
const IDLE = 'icons/idle16.png';

beforeAll(async () => {
  h = await launch();
  srv = await serve({
    logs: { orders: orders.text },
    routes: { '/page.html': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>Some page</title><p>Not a log</p>' } },
  });
  // record every icon the background sets (it looks chrome.action.setIcon up on each call)
  await h.sw.evaluate(() => {
    const g = globalThis as unknown as { __icons: { tabId?: number; icon: string }[] };
    g.__icons = [];
    const set = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = ((details: chrome.action.TabIconDetails) => {
      g.__icons.push({ tabId: details.tabId ?? undefined, icon: String((details.path as Record<string, string>)[16]) });
      return set(details);
    }) as typeof chrome.action.setIcon;
  });
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
});

/** The icon last set for the page's tab (undefined: the manifest default, grey). */
async function iconOf(page: Page): Promise<string | undefined> {
  await page.bringToFront();
  await page.waitForTimeout(200);
  return h.sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const calls = (globalThis as unknown as { __icons: { tabId?: number; icon: string }[] }).__icons.filter((c) => c.tabId === tab.id);
    return calls.at(-1)?.icon;
  });
}

describe('toolbar icon', () => {
  it('is grey by default; the colour icons stay for the extensions page and the store', () => {
    const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
    expect(Object.values(manifest.action.default_icon)).toEqual(['icons/idle16.png', 'icons/idle32.png', 'icons/idle48.png']);
    expect(Object.values(manifest.icons).every((p) => /icons\/icon\d+\.png$/.test(String(p)))).toBe(true);
    for (const p of [...Object.values(manifest.action.default_icon), ...Object.values(manifest.icons)]) expect(existsSync(join(DIST, String(p))), String(p)).toBe(true);
  });

  it('turns to colour where the viewer is opened, and back to grey when the tab moves on', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    expect(await iconOf(page)).toBe(ACTIVE);
    await page.goto(`http://localhost:${srv.port}/page.html`);
    expect(await iconOf(page)).toBe(IDLE);
    expect(await page.title()).toBe('Some page');
    await page.close();
  });

  it('turns to colour on automatically opened pages', async () => {
    await h.setAutoOrigins([`http://localhost:${srv.port}`]);
    const page = await h.newPage();
    await page.goto(srv.url('orders'));
    await waitLoaded(page, orders.total);
    expect(await iconOf(page)).toBe(ACTIVE);
    await page.close();
    await h.setAutoOrigins([]);
  });

  it('turns to colour in the file viewer tab', async () => {
    const page = await h.newPage();
    await page.goto(`chrome-extension://${h.extId}/viewer.html`);
    await page.waitForSelector('.lv-empty');
    expect(await iconOf(page)).toBe(ACTIVE);
    await page.close();
  });

  it('stays grey on pages LogPane is not open on', async () => {
    const page = await h.newPage();
    await page.goto(srv.url('orders')); // a Raw log, but nobody opened LogPane there
    expect(await iconOf(page)).toBe(IDLE);
    await page.close();
  });
});

describe('health', () => {
  it('no page errors', () => {
    expect(h.errors).toEqual([]);
  });
});
