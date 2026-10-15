// viewer.html inside the extension: the file viewer the toolbar button opens on pages that aren't logs.
// Files and pasted text only, like the standalone logpane.html (standalone.ts).
import { mountApp } from '../ui/App';
import { chromeSettings } from '../ui/settings';
import { LogStore } from '../ui/store';

async function main(): Promise<void> {
  void chrome.runtime.sendMessage({ type: 'lv-active' }).catch(() => undefined); // colour toolbar icon in this tab
  mountApp(document.getElementById('lv-root')!, {
    store: new LogStore(),
    mode: 'standalone',
    initialSettings: await chromeSettings.load(),
    saveSettings: chromeSettings.save,
    canFetchUrls: false,
  });
}

void main();
