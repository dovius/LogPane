import { AUTO_ORIGINS_KEY, AUTO_SCRIPT_ID, RAW_LOG_PATH, getAutoOrigins, normalizeOrigin, originPattern } from './autoOrigins';

const TEXT_TYPES = ['text/plain', 'application/json', 'application/x-ndjson', 'application/jsonl'];

async function openViewerTab(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
}

// Toolbar button: on a plain-text page inject the viewer (or toggle it if already there);
// anywhere else open the standalone viewer for files.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return openViewerTab();
  const target = { tabId: tab.id };
  try {
    const [probe] = await chrome.scripting.executeScript({
      target,
      func: () => ({ contentType: document.contentType, mounted: Boolean((window as { __lvMounted?: boolean }).__lvMounted) }),
    });
    const info = probe?.result as { contentType: string; mounted: boolean } | undefined;
    if (info?.mounted) {
      await chrome.tabs.sendMessage(tab.id, { type: 'lv-toggle' });
      return;
    }
    if (info && TEXT_TYPES.includes(info.contentType)) {
      await chrome.scripting.executeScript({ target, func: () => void ((window as { __lvManual?: boolean }).__lvManual = true) });
      await chrome.scripting.insertCSS({ target, files: ['viewer.css'] });
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
      return;
    }
  } catch {
    // chrome:// pages, the Web Store, file:// without access etc.
  }
  await openViewerTab();
});

// Content scripts live in untrusted pages: accept only our own sender and a well-formed origin.
chrome.runtime.onMessage.addListener((msg: { type?: unknown; origin?: unknown }, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'lv-open-options') return;
  const origin = typeof msg.origin === 'string' ? normalizeOrigin(msg.origin) : null;
  const query = origin ? `?add=${encodeURIComponent(origin)}` : '';
  void chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${query}`) });
});

/** Keeps the registered content script in sync with the enabled (and still permitted) origins. */
async function syncAutoScripts(): Promise<void> {
  const origins: string[] = [];
  for (const origin of await getAutoOrigins()) {
    if (await chrome.permissions.contains({ origins: [originPattern(origin)] })) origins.push(origin);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] });
  if (!origins.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: AUTO_SCRIPT_ID,
      matches: origins.map((o) => originPattern(o).replace(/\/\*$/, RAW_LOG_PATH)),
      js: ['content.js'],
      css: ['viewer.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(() => void syncAutoScripts());
chrome.runtime.onStartup.addListener(() => void syncAutoScripts());
chrome.permissions.onRemoved.addListener(() => void syncAutoScripts());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && AUTO_ORIGINS_KEY in changes) void syncAutoScripts();
});
