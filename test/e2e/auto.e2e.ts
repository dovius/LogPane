// Automatic opening: suggestion banner, setup window, options page, the auto-opened page itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAIN_JAVA_LOG, ordersService } from '../support/mocklogs';
import { launch, serve, waitLoaded, type DevServer, type Harness } from './harness';

let h: Harness;
let srv: DevServer;
const orders = ordersService(40);

beforeAll(async () => {
  h = await launch();
  srv = await serve({ logs: { orders: orders.text, 'plain-java': PLAIN_JAVA_LOG }, routes: { '/files/app.log': { body: orders.text } } });
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
});

const origin = () => `http://localhost:${srv.port}`;

describe('suggestion banner', () => {
  it('appears after a manual open on a Raw log page; "Not now" is remembered', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    expect(await page.textContent('.lv-banner')).toContain(`localhost:${srv.port}`);
    await page.click('.lv-banner button:text("Not now")');
    expect(await page.$('.lv-banner')).toBeNull();
    expect((await h.storage()).autoPromptDismissed).toEqual([origin()]);
    await page.reload();
    await h.inject(page);
    await waitLoaded(page, orders.total);
    expect(await page.$('.lv-banner')).toBeNull();
    await page.close();
    await h.sw.evaluate(() => chrome.storage.local.remove('autoPromptDismissed'));
  });

  it('is not shown on other text pages (auto-open would not apply there)', async () => {
    const page = await h.openManual(`${origin()}/files/app.log`);
    await waitLoaded(page, orders.total);
    expect(await page.$('.lv-banner')).toBeNull();
    await page.close();
  });

  it('"Enable…" opens a setup window that enables auto-open and closes itself', async () => {
    const page = await h.openManual(srv.url('orders'));
    await waitLoaded(page, orders.total);
    const [setup] = await Promise.all([h.ctx.waitForEvent('page'), page.click('.lv-banner button:text("Enable…")')]);
    await setup.waitForSelector('#pending:not([hidden]) button');
    expect(await setup.textContent('#pending')).toContain(origin());
    await setup.click('#pending button');
    await setup.waitForEvent('close', { timeout: 5000 });
    expect((await h.storage()).autoOrigins).toEqual([origin()]);
    const scripts = await h.sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    expect(scripts.map((s) => [s.runAt, s.matches])).toEqual([['document_start', ['http://localhost/api/kubernetes/api/v1/namespaces/*/pods/*/log*']]]);
    await page.close();
  });
});

describe('auto-opened pages', () => {
  it('open straight in the viewer, without the suggestion banner', async () => {
    await h.setAutoOrigins([origin()]);
    const page = await h.newPage();
    await page.goto(srv.url('orders'));
    await waitLoaded(page, orders.total);
    expect(await page.$('.lv-banner')).toBeNull();
    expect(await page.evaluate(() => document.documentElement.classList.contains('lv-pending'))).toBe(false);
    await page.close();
  });

  it('leave plain-text logs and HTML pages alone', async () => {
    const page = await h.newPage();
    await page.goto(srv.url('plain-java'));
    await page.waitForTimeout(500);
    expect(await page.$('#lv-root')).toBeNull();
    expect(await page.$eval('body > pre', (el) => getComputedStyle(el).display)).toBe('block');
    expect(await page.evaluate(() => document.documentElement.className)).toBe('');
    await page.goto(`${origin()}/`);
    await page.waitForTimeout(300);
    expect(await page.$('#lv-root')).toBeNull();
    await page.close();
  });

  it('the toolbar button toggles between viewer and raw text', async () => {
    const page = await h.newPage();
    await page.goto(srv.url('orders'));
    await waitLoaded(page, orders.total);
    const toggle = () => h.sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tab.id!, { type: 'lv-toggle' });
    });
    await toggle();
    expect(await page.$eval('#lv-root', (el) => getComputedStyle(el).display)).toBe('none');
    await toggle();
    expect(await page.$eval('#lv-root', (el) => getComputedStyle(el).display)).not.toBe('none');
    await page.close();
  });
});

describe('options page', () => {
  it('lists, adds and removes domains', async () => {
    const page = await h.newPage();
    await page.goto(`chrome-extension://${h.extId}/options.html`);
    await page.waitForSelector('#origins li');
    expect(await page.textContent('#origins')).toContain(origin());
    await page.fill('#origin-input', 'http://localhost:12345/some/path');
    await page.click('#add-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#origins')?.textContent?.includes('http://localhost:12345'));
    // one concrete https domain (or localhost): no other schemes, no wildcards, no plain http elsewhere
    for (const bad of ['ftp://nope', '*', '*.example.com', 'https://*.example.com', 'http://console.example.com', 'https://a..b']) {
      await page.fill('#origin-input', bad);
      await page.click('#add-form button[type=submit]');
      expect(await page.textContent('#status'), bad).toContain('Enter one https domain');
    }
    await page.locator('#origins li', { hasText: 'http://localhost:12345' }).locator('button').click();
    await page.waitForFunction(() => !document.querySelector('#origins')?.textContent?.includes('http://localhost:12345'));
    await page.locator('#origins li', { hasText: origin() }).locator('button').click();
    await page.waitForFunction(() => document.querySelector('#origins')?.textContent?.includes('None yet'));
    expect((await h.storage()).autoOrigins).toEqual([]);
    expect(await h.sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
    await page.close();
  });

  it('is styled under the strict CSP without errors', async () => {
    const page = await h.newPage();
    const csp: string[] = [];
    page.on('console', (m) => /Content Security Policy|Refused/.test(m.text()) && csp.push(m.text()));
    await page.goto(`chrome-extension://${h.extId}/options.html`);
    await page.waitForSelector('#origins li');
    expect(await page.$eval('body', (b) => getComputedStyle(b).fontFamily)).toContain('system-ui');
    expect(csp).toEqual([]);
    await page.close();
  });
});

describe('health', () => {
  it('no page errors', () => {
    expect(h.errors).toEqual([]);
  });
});
