// viewer.html: works as an extension page, opened from disk (file://) or as the single-file build.
import { mountApp } from '../ui/App';
import { loadSettings } from '../ui/settings';
import { LogStore } from '../ui/store';

async function main(): Promise<void> {
  // As the extension's own file viewer tab: colour toolbar icon there too (logpane.html has no extension APIs).
  if (location.protocol === 'chrome-extension:') void chrome.runtime.sendMessage({ type: 'lv-active' }).catch(() => undefined);
  const root = document.getElementById('lv-root')!;
  mountApp(root, {
    store: new LogStore(),
    mode: 'standalone',
    initialSettings: await loadSettings(),
    canFetchUrls: false,
  });
}

void main();
