#!/usr/bin/env node
// Opens the built extension in its own Chromium window with demo logs, to look at the UI without
// installing anything into your Chrome:
//
//   npm run preview            (builds first)
//
// Demo logs (scripts/make-demo.mjs) are served by the dev server on localhost, and LogPane opens on
// them automatically. The file viewer is in the second tab. Close the window (or Ctrl+C) to stop;
// the temporary profile, extension copy and logs are removed.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from './chrome.mjs';
import { startDevServer } from './dev-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/ is missing: run `npm run build` first (npm run preview does it for you)');
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), 'logpane-preview-'));
const demo = join(temp, 'logs');
execFileSync(process.execPath, [join(root, 'scripts', 'make-demo.mjs'), demo], { stdio: 'ignore' });
const logs = Object.fromEntries(readdirSync(demo).map((f) => [f.replace(/\.log$/, ''), readFileSync(join(demo, f), 'utf8')]));
const srv = await startDevServer({ logs });

// A copy of the extension that may open on the local dev server by itself (the real one asks first).
const ext = join(temp, 'extension');
cpSync(dist, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://localhost/*'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const ctx = await chromium.launchPersistentContext(join(temp, 'profile'), {
  executablePath: findChrome(),
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--window-size=1440,900', '--no-first-run'],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
await sw.evaluate(async (origin) => {
  await chrome.storage.local.set({ autoOrigins: [origin] });
  // the background registers the automatic content script on this change
  for (let i = 0; i < 50 && !(await chrome.scripting.getRegisteredContentScripts()).length; i++) await new Promise((r) => setTimeout(r, 50));
}, `http://localhost:${srv.port}`);

const pods = Object.keys(logs);
const [first] = ctx.pages().length ? ctx.pages() : [await ctx.newPage()];
await first.goto(srv.url(pods[0]));
const viewer = await ctx.newPage();
await viewer.goto(`chrome-extension://${extId}/viewer.html`);
await first.bringToFront();

console.log('LogPane preview is open in a separate Chromium window.');
console.log(`  Demo logs:    http://localhost:${srv.port}/`);
for (const pod of pods) console.log(`    ${srv.url(pod)}`);
console.log(`  File viewer:  chrome-extension://${extId}/viewer.html (demo files in ${demo})`);
console.log('Close the window or press Ctrl+C to stop.');

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await ctx.close().catch(() => undefined);
  await srv.close();
  rmSync(temp, { recursive: true, force: true });
  process.exit(0);
};
ctx.on('close', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
