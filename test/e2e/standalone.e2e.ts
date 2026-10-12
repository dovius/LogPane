// The file viewer: extension page (toolbar button on other pages) and the single-file logpane.html.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { ordersService, paymentsService } from '../support/mocklogs';
import { DIST, counts, launch, levelChips, waitLoaded, type Harness } from './harness';

let h: Harness;
const orders = ordersService(50);
const payments = paymentsService();
const dir = mkdtempSync(join(tmpdir(), 'logpane-standalone-'));
const ordersFile = join(dir, 'orders-6f7c9d8b4-x2k4p-orders.log');
const paymentsFile = join(dir, 'payments.log');

beforeAll(async () => {
  h = await launch();
  writeFileSync(ordersFile, orders.text);
  writeFileSync(paymentsFile, payments.text);
});
afterAll(async () => {
  await h?.close();
});

const pages = () => [
  ['extension page', `chrome-extension://${h.extId}/viewer.html`],
  ['single file', `file://${join(DIST, 'standalone/logpane.html')}`],
] as const;

async function dropFiles(page: Page, files: { name: string; text: string }[]): Promise<void> {
  const transfer = await page.evaluateHandle((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }));
    return dt;
  }, files);
  await page.dispatchEvent('.lv-app', 'dragover', { dataTransfer: transfer });
  expect(await page.isVisible('.lv-drop-overlay')).toBe(true);
  await page.dispatchEvent('.lv-app', 'drop', { dataTransfer: transfer });
}

describe.each([0, 1])('file viewer (%s)', (i) => {
  const name = () => pages()[i][0];
  const url = () => pages()[i][1];

  it('shows the empty state with a privacy note and no toolbars', async () => {
    const page = await h.newPage();
    await page.goto(url());
    await page.waitForSelector('.lv-empty');
    expect(await page.textContent('.lv-empty')).toContain('Nothing is uploaded anywhere');
    expect(await page.$('.lv-filterbar')).toBeNull();
    await page.close();
  });

  it('opens chosen files and merges them', async () => {
    const page = await h.newPage();
    await page.goto(url());
    await page.setInputFiles('.lv-empty input[type=file]', [ordersFile, paymentsFile]);
    await waitLoaded(page, orders.total + payments.total);
    expect(await page.$$eval('.lv-src-label', (els) => els.map((e) => e.textContent))).toEqual(['orders-6f7c9d8b4-x2k4p-orders', 'payments']);
    expect(await levelChips(page)).toMatchObject({ ERROR: orders.counts.ERROR + 1 });
    await page.close();
  });

  it('opens dropped files, then more dropped onto the viewer', async () => {
    const page = await h.newPage();
    await page.goto(url());
    await page.waitForSelector('.lv-empty');
    await dropFiles(page, [{ name: 'a.log', text: orders.text }]);
    await waitLoaded(page, orders.total);
    await dropFiles(page, [{ name: 'b.log', text: payments.text }]);
    await waitLoaded(page, orders.total + payments.total);
    expect(await page.isVisible('.lv-drop-overlay')).toBe(false);
    await page.close();
  });

  it('opens pasted text from the box and from Ctrl+V anywhere', async () => {
    const page = await h.newPage();
    await page.goto(url());
    await page.fill('.lv-empty textarea', payments.text);
    await page.click('button:text("Open pasted text")');
    await waitLoaded(page, payments.total);
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, orders.text);
    await waitLoaded(page, payments.total + orders.total);
    expect(await page.$$eval('.lv-src-label', (els) => els.map((e) => e.textContent))).toEqual(['pasted 1', 'pasted 2']);
    await page.close();
  });

  it('cannot reach the network (CSP) but can still download', async () => {
    const page = await h.newPage();
    await page.goto(url());
    await page.setInputFiles('.lv-empty input[type=file]', [paymentsFile]);
    await waitLoaded(page, payments.total);
    const blocked = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener('securitypolicyviolation', (e) => resolve(`blocked ${e.violatedDirective}`), { once: true });
          fetch('https://example.com/collect').then(() => resolve('allowed'), () => setTimeout(() => resolve('failed'), 300));
        }),
    );
    expect(blocked, name()).toMatch(/^blocked connect-src/);
    await page.click('button:text("Export ▾")');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:text("Download shown (.log)")')]);
    expect(download.suggestedFilename()).toBe('payments-all.log');
    await page.close();
  });

  it('removing the last source returns to the empty state', async () => {
    const page = await h.newPage();
    await page.goto(url());
    await page.setInputFiles('.lv-empty input[type=file]', [paymentsFile]);
    await waitLoaded(page, payments.total);
    await page.click('.lv-src-chip .lv-chip-x');
    await page.waitForSelector('.lv-empty');
    expect(await counts(page).catch(() => null)).toBeNull();
    await page.close();
  });
});

describe('health', () => {
  it('no page errors (CSP reports from the deliberate network test are expected)', () => {
    expect(h.errors.filter((e) => !/Content Security Policy|example\.com\/collect/.test(e))).toEqual([]);
  });
});
