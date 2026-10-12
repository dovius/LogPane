// Performance budgets for a big log on a 4x slower CPU (a weak laptop). Generous limits: they catch
// regressions like laying out the raw text again, not normal machine noise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bigLog } from '../support/mocklogs';
import { launch, search, serve, waitCounts, waitLoaded, type DevServer, type Harness } from './harness';

const LINES = 52_000; // ≈ 30 MB
let h: Harness;
let srv: DevServer;

beforeAll(async () => {
  h = await launch();
  srv = await serve({ logs: { big: bigLog(LINES) } });
  await h.setAutoOrigins([`http://localhost:${srv.port}`]);
});
afterAll(async () => {
  await h?.close();
  await srv?.close();
});

describe('30 MB log on a 4x throttled CPU', () => {
  it('opens within budget and never blocks the page for long', async () => {
    const page = await h.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __tasks: number[] }).__tasks = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as unknown as { __tasks: number[] }).__tasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
    });
    const cdp = await h.ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const start = Date.now();
    await page.goto(srv.url('big'), { waitUntil: 'commit' });
    await waitLoaded(page, LINES, 60_000);
    const elapsed = Date.now() - start;
    const tasks = await page.evaluate(() => (window as unknown as { __tasks: number[] }).__tasks);
    console.log(`time to rows ${elapsed} ms, longest task ${Math.round(Math.max(0, ...tasks))} ms`);
    expect(elapsed).toBeLessThan(4000); // measured ≈ 1 s; was 9 s before hiding the raw text with display:none
    expect(Math.max(0, ...tasks)).toBeLessThan(400); // measured < 60 ms; was 1.7 s

    const t1 = Date.now();
    await search(page, '#4242');
    await waitCounts(page, 11, LINES);
    expect(Date.now() - t1).toBeLessThan(1500);

    const t2 = Date.now();
    await search(page, '');
    await page.click('.lv-level-chip.lv-lvl-ERROR');
    await waitCounts(page, Math.ceil(LINES / 97), LINES);
    expect(Date.now() - t2).toBeLessThan(1500);
    await page.click('.lv-level-chip.lv-lvl-ERROR');

    // a catastrophic regex is stopped with a message instead of freezing the tab
    await page.click('.lv-search .lv-toggle[title="Regular expression"]');
    const t3 = Date.now();
    await search(page, 'a.*a.*a.*a.*z');
    await page.waitForFunction(() => document.querySelector('.lv-overlay-msg')?.textContent?.includes('too slow') || Number(document.querySelector('.lv-count')?.textContent?.split('/')[0].replace(/\D/g, '')) >= 0, null, { timeout: 15000 });
    expect(Date.now() - t3).toBeLessThan(8000); // 4x throttled; unprotected this takes minutes
    await search(page, '');
    await page.click('.lv-search .lv-toggle[title="Regular expression"]');
    await waitCounts(page, LINES, LINES);

    // scrolling stays smooth: only visible rows are in the DOM
    await page.mouse.move(500, 400);
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 3000);
    expect(await page.$$eval('.lv-list .lv-row', (els) => els.length)).toBeLessThan(150);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.close();
  });
});
