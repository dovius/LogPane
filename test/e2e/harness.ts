// End-to-end harness: a real Chromium with the built extension loaded, plus helpers for the viewer UI.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
// @ts-expect-error: plain JS module without types
import { findChrome } from '../../scripts/chrome.mjs';
// @ts-expect-error: plain JS module without types
import { startDevServer } from '../../scripts/dev-server.mjs';

export const ROOT = resolve(__dirname, '../..');
export const DIST = join(ROOT, 'dist');

export interface DevServer {
  port: number;
  url(pod: string, container?: string): string;
  append(pod: string, lines: string[]): void;
  lineCount(pod: string): number;
  close(): Promise<void>;
}

export function serve(options: {
  logs: Record<string, string>;
  navigationOnly?: boolean;
  rejectFetch?: 'network' | 'login-page';
  growEveryMs?: number;
  routes?: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>;
  loginAfterNavigations?: number;
}): Promise<DevServer> {
  return startDevServer(options);
}

export interface Harness {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  /** Uncaught page errors and console errors seen so far (favicon 404s are ignored). */
  errors: string[];
  newPage(opts?: { dark?: boolean }): Promise<Page>;
  /** Open a Raw log URL and inject the viewer like the toolbar button does. */
  openManual(url: string, opts?: { dark?: boolean }): Promise<Page>;
  inject(page: Page): Promise<void>;
  setAutoOrigins(origins: string[]): Promise<void>;
  /** Turns on "Allow access to file URLs" for the extension (Chrome reloads it). */
  enableFileAccess(): Promise<void>;
  storage(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /**
   * Host access of the test copy. Default: localhost and local files, so tests can inject the viewer
   * like the toolbar button does. `[]` keeps only activeTab, like the real extension. Then the toolbar
   * button is pressed through its keyboard shortcut (see pressToolbarButton), which needs a headed browser.
   */
  hostPermissions?: string[];
  headless?: boolean;
}

/** Keyboard shortcut of the toolbar button in the test copy (grants activeTab like a click). */
export const ACTION_SHORTCUT = 'Control+Shift+Y';

export async function launch(options: LaunchOptions = {}): Promise<Harness> {
  if (!existsSync(join(DIST, 'manifest.json'))) throw new Error('dist/ is missing: run `npm run build` first');
  const ext = mkdtempSync(join(tmpdir(), 'logpane-ext-'));
  cpSync(DIST, ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = options.hostPermissions ?? ['http://localhost/*', 'file:///*'];
  manifest.commands = { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' } } };
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));
  const profile = mkdtempSync(join(tmpdir(), 'logpane-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: findChrome(),
    headless: options.headless ?? true,
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
    timezoneId: 'Europe/Vilnius',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let sw = ctx.serviceWorkers()[0];
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const errors: string[] = [];
  const currentSw = () => sw;

  const newPage = async (opts: { dark?: boolean } = {}) => {
    const page = await ctx.newPage();
    if (opts.dark) await page.emulateMedia({ colorScheme: 'dark' });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      const where = m.location().url;
      if (m.type() === 'error' && !where.endsWith('favicon.ico')) errors.push(`console: ${m.text()}${where ? ` @ ${where}` : ''}`);
    });
    return page;
  };

  const inject = async (page: Page) => {
    await page.bringToFront();
    await currentSw().evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const target = { tabId: tab.id! };
      await chrome.scripting.executeScript({ target, func: () => void ((window as { __lvManual?: boolean }).__lvManual = true) });
      await chrome.scripting.insertCSS({ target, files: ['viewer.css'] });
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
    });
    await page.waitForSelector('#lv-root .lv-app');
  };

  return {
    ctx,
    get sw() {
      return currentSw();
    },
    extId,
    errors,
    newPage,
    inject,
    async openManual(url, opts) {
      const page = await newPage(opts);
      await page.goto(url);
      await inject(page);
      return page;
    },
    async setAutoOrigins(origins) {
      await currentSw().evaluate((o) => chrome.storage.local.set({ autoOrigins: o }), origins);
      // the background re-registers the content script on storage change
      await currentSw().evaluate(async (count) => {
        for (let i = 0; i < 50; i++) {
          const scripts = await chrome.scripting.getRegisteredContentScripts();
          if ((count === 0 && scripts.length === 0) || (count > 0 && scripts.length === 1)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
      }, origins.length);
    },
    storage: () => currentSw().evaluate(() => chrome.storage.local.get(null)),
    async enableFileAccess() {
      const page = await ctx.newPage();
      await page.goto(`chrome://extensions/?id=${extId}`);
      const toggle = page.locator('#allow-on-file-urls #crToggle');
      await toggle.waitFor();
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
        const reloaded = ctx.waitForEvent('serviceworker', { timeout: 15000 });
        await toggle.click();
        sw = await reloaded; // Chrome restarts the extension with file access
      }
      await page.close();
    },
    async close() {
      await ctx.close();
      rmSync(profile, { recursive: true, force: true });
      rmSync(ext, { recursive: true, force: true });
    },
  };
}

// ---- viewer helpers ----

export async function counts(page: Page): Promise<{ shown: number; total: number }> {
  const text = (await page.textContent('.lv-count')) ?? '';
  const [shown, total] = text.split('/').map((x) => Number(x.replace(/\D/g, '')));
  return { shown, total };
}

/** Waits until the "shown / total" counter matches. */
export async function waitCounts(page: Page, shown: number, total?: number, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    ([s, t]) => {
      const [a, b] = (document.querySelector('.lv-count')?.textContent ?? '').split('/').map((x) => Number(x.replace(/\D/g, '')));
      return a === s && (t === null || b === t);
    },
    [shown, total ?? null] as const,
    { timeout },
  );
}

export async function waitLoaded(page: Page, total: number, timeout = 30000): Promise<void> {
  await waitCounts(page, total, total, timeout);
}

/** Waits until the log is parsed and shown (total not known in advance); returns the total. */
export async function waitReady(page: Page, timeout = 30000): Promise<number> {
  await page.waitForFunction(
    () => {
      if (document.querySelector('.lv-overlay-msg')?.textContent?.startsWith('Parsing')) return false;
      const [a, b] = (document.querySelector('.lv-count')?.textContent ?? '').split('/').map((x) => Number(x.replace(/\D/g, '')));
      return b > 0 && a === b;
    },
    null,
    { timeout },
  );
  return (await counts(page)).total;
}

export async function levelChips(page: Page): Promise<Record<string, number>> {
  const chips = await page.$$eval('.lv-level-chip', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  return Object.fromEntries(chips.map((c) => { const [name, n] = c.split(/\s+/); return [name, Number(n.replace(/\D/g, ''))]; }));
}

export async function search(page: Page, text: string): Promise<void> {
  await page.fill('.lv-search-input', text);
  await page.waitForFunction((t) => (document.querySelector<HTMLInputElement>('.lv-search-input')?.value ?? '') === t, text);
  await page.waitForTimeout(220); // search is debounced (150 ms)
}

/** Message texts of the rendered (visible) rows. */
export function visibleMessages(page: Page): Promise<string[]> {
  return page.$$eval('.lv-list .lv-row .lv-c-msg', (els) => els.map((e) => e.textContent ?? ''));
}

export async function clickRow(page: Page, text: string): Promise<void> {
  await page.locator('.lv-list .lv-row', { hasText: text }).first().click();
  await page.waitForSelector('.lv-details');
}

/**
 * Runs `action` and returns what it put on the system clipboard (Copy buttons use navigator.clipboard,
 * row selection uses the copy event; both end up there).
 */
export async function captureCopy(page: Page, action: () => Promise<void>): Promise<string> {
  const sentinel = '__logpane_clipboard_sentinel__';
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await page.bringToFront();
  await page.evaluate((s) => navigator.clipboard.writeText(s), sentinel);
  await action();
  const handle = await page.waitForFunction(
    async (s) => {
      const text = await navigator.clipboard.readText();
      return text !== s ? text : null;
    },
    sentinel,
    { timeout: 5000 },
  );
  return (await handle.jsonValue()) as string;
}

/** Selects text from the start of one row to the end of another (by visible position) and copies it. */
export async function selectRowsAndCopy(page: Page, fromText: string, toText: string): Promise<string> {
  return captureCopy(page, () =>
    page.evaluate(([a, b]) => {
      const rows = [...document.querySelectorAll('.lv-list .lv-row[data-pos]')];
      const from = rows.find((r) => r.textContent?.includes(a))!;
      const to = rows.find((r) => r.textContent?.includes(b))!;
      const range = document.createRange();
      range.setStart(from.firstElementChild!, 0);
      range.setEnd(to.lastElementChild!, to.lastElementChild!.childNodes.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.execCommand('copy');
    }, [fromText, toText] as const),
  );
}

/** True when nothing in the page overflows horizontally (layout fits the viewport). */
export function fitsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(() => (document.querySelector('.lv-app')?.scrollWidth ?? 0) <= window.innerWidth + 1);
}
