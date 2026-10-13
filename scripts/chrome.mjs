// Finds a Chromium that can load an unpacked extension from the command line (branded Google Chrome
// no longer allows --load-extension): LOGPANE_CHROME, or the newest Chrome for Testing in the
// Playwright browser cache (`npx playwright-core install chromium`). Used by the tests and the preview.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHES = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright'), join(homedir(), 'AppData/Local/ms-playwright')];
const EXECUTABLES = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux/chrome',
  'chrome-win/chrome.exe',
];

/** @returns {string} */
export function findChrome() {
  if (process.env.LOGPANE_CHROME) return process.env.LOGPANE_CHROME;
  const candidates = [];
  for (const cache of CACHES.filter(existsSync)) {
    for (const dir of readdirSync(cache)) {
      const m = /^chromium-(\d+)$/.exec(dir);
      if (!m) continue;
      for (const exe of EXECUTABLES) {
        const p = join(cache, dir, exe);
        if (existsSync(p)) candidates.push([Number(m[1]), p]);
      }
    }
  }
  candidates.sort((a, b) => b[0] - a[0]);
  if (!candidates.length) throw new Error('No Chromium found. Run `npx playwright-core install chromium` or set LOGPANE_CHROME.');
  return candidates[0][1];
}
