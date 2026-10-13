// Chrome Web Store screenshots, from the fictional demo logs of scripts/make-demo.mjs. Not part of the normal run:
//   npm run build && LOGPANE_STORE_SHOTS=1 LOGPANE_SKIP_BUILD=1 npx vitest run --config vitest.e2e.config.ts test/e2e/store-shots.e2e.ts
// Rendered at 10/9 from a 1152×720 layout (1280×800 files): room for the whole toolbar, and text that stays
// readable when the store shows them at 640×400.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Page } from 'playwright-core';
import { ROOT, clickRow, launch, search, serve, waitReady, type DevServer, type Harness } from './harness';

const OUT = process.env.LOGPANE_STORE_SHOTS_DIR ?? join(ROOT, 'store');
const ORDERS = 'orders-service-6f7c9d8b4-x2k4p';
const PAYMENTS = 'payment-service-5d8b7c6f9-q7m2z';

let h: Harness;
let srv: DevServer;
let demo: string;

beforeAll(async () => {
  demo = mkdtempSync(join(tmpdir(), 'logpane-demo-'));
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'make-demo.mjs'), demo], { stdio: 'ignore' });
  const logs = Object.fromEntries(readdirSync(demo).map((f) => [f.replace(/\.log$/, ''), readFileSync(join(demo, f), 'utf8')]));
  h = await launch({ deviceScaleFactor: 1280 / 1152 });
  srv = await serve({ logs });
  // the suggestion banner is for real use, not for the store
  await h.sw.evaluate((origin) => chrome.storage.local.set({ autoPromptDismissed: [origin] }), `http://localhost:${srv.port}`);
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
  rmSync(demo, { recursive: true, force: true });
});

async function open(pod: string, container: string, dark = false): Promise<Page> {
  const page = await h.newPage({ dark });
  await page.setViewportSize({ width: 1152, height: 720 });
  await page.goto(srv.url(pod, container));
  await h.inject(page);
  await waitReady(page);
  return page;
}

async function addLog(page: Page, pod: string, container: string): Promise<void> {
  await page.click('button[title^="Add another log"]');
  await page.fill('.lv-modal textarea >> nth=0', srv.url(pod, container));
  await page.click('.lv-modal button:text-is("Add")');
  await page.waitForSelector('.lv-src-chip >> nth=1');
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

describe.skipIf(!process.env.LOGPANE_STORE_SHOTS)('store screenshots', () => {
  it('1: an error with a readable stack trace', async () => {
    const page = await open(ORDERS, 'orders-service');
    await search(page, 'ORD-48263');
    await clickRow(page, 'Checkout failed');
    await page.click('button:text("Show in context")');
    await page.waitForTimeout(1600); // the row's highlight fades
    await shot(page, 'screenshot-1-stack-trace');
    await page.close();
  });

  it('2: one trace across two services, with its JSON payload (dark)', async () => {
    const page = await open(ORDERS, 'orders-service', true);
    await addLog(page, PAYMENTS, 'payment-service');
    await search(page, 'ORD-48217');
    await clickRow(page, 'Order created');
    await page.click('.lv-frows button.lv-link[title="Show all entries of this trace"]');
    await search(page, ''); // the entry stays selected, the list now shows its whole trace
    await page.$eval('.lv-details-body', (el) => (el.scrollTop = 0)); // back to the message and its JSON
    await shot(page, 'screenshot-2-trace-across-services');
    await page.close();
  });

  it('3: search and level filters across two logs', async () => {
    const page = await open(ORDERS, 'orders-service');
    await addLog(page, PAYMENTS, 'payment-service');
    await search(page, 'ORD -health');
    await page.click('.lv-level-chip.lv-lvl-ERROR');
    await page.click('.lv-level-chip.lv-lvl-WARN', { modifiers: ['ControlOrMeta'] });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('g'); // from the first match
    await shot(page, 'screenshot-3-search-filter');
    await page.close();
  });

  it('4: adding another log', async () => {
    const page = await open(ORDERS, 'orders-service');
    await page.click('button[title^="Add another log"]');
    // a console pod-log page URL (fictional, example.com): the dialog converts these to the Raw log
    await page.fill('.lv-modal textarea >> nth=0', `https://console-openshift-console.apps.example.com/k8s/ns/shop/pods/${PAYMENTS}/logs`);
    await shot(page, 'screenshot-4-add-log');
    await page.close();
  });

  it('5: the local file viewer', async () => {
    const page = await h.newPage();
    await page.setViewportSize({ width: 1152, height: 720 });
    await page.goto(`chrome-extension://${h.extId}/viewer.html`);
    await page.waitForSelector('.lv-empty');
    await shot(page, 'screenshot-5-file-viewer');
    await page.close();
  });
});
