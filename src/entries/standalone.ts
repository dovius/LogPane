// logpane.html: the viewer as one self-contained file, opened from disk. It reads only files and pasted text,
// so it has no network code and no extension APIs at all (build.mjs fails if any shows up in it).
import { mountApp } from '../ui/App';
import { localSettings } from '../ui/settings';
import { LogStore } from '../ui/store';

async function main(): Promise<void> {
  mountApp(document.getElementById('lv-root')!, {
    store: new LogStore(),
    mode: 'standalone',
    initialSettings: await localSettings.load(),
    saveSettings: localSettings.save,
    canFetchUrls: false,
  });
}

void main();
