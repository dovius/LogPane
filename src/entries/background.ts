import { AUTO_ORIGINS_KEY, AUTO_SCRIPT_ID, RAW_LOG_PATH, getAutoOrigins, normalizeOrigin, originPattern } from './autoOrigins';

const TEXT_TYPES = ['text/plain', 'application/json', 'application/x-ndjson', 'application/jsonl'];

async function openViewerTab(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
}

async function injectViewer(tabId: number): Promise<void> {
  const target = { tabId };
  await chrome.scripting.executeScript({ target, func: () => void ((window as { __lvManual?: boolean }).__lvManual = true) });
  await chrome.scripting.insertCSS({ target, files: ['viewer.css'] });
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
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
      await injectViewer(tab.id);
      return;
    }
  } catch {
    // chrome:// pages, the Web Store, file:// without access etc.
  }
  await openViewerTab();
});

/*
 * Reloading a Raw log page. Some consoles reject the viewer's own requests (401) and accept only real
 * navigations, so Reload / Tail fall back to reloading the tab like F5. The view state is kept here,
 * per tab and URL, because the page itself may not be allowed to use storage.
 */
interface PendingReload {
  url: string;
  state: unknown;
  /** The viewer was opened by the toolbar button, so it has to be injected again after the reload. */
  reopen: boolean;
}
const pendingKey = (tabId: number) => `reload:${tabId}`;

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const key = pendingKey(tabId);
  const pending = (await chrome.storage.session.get(key))[key] as PendingReload | undefined;
  if (!pending?.reopen) return;
  // Chrome keeps activeTab across same-origin reloads. If injecting still fails, the saved view stays
  // and is restored when the toolbar button is clicked on this page again.
  await injectViewer(tabId).catch(() => undefined);
});
chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(pendingKey(tabId)));

// Content scripts live in untrusted pages: accept only our own sender, known actions and well-formed values.
chrome.runtime.onMessage.addListener((msg: { type?: unknown; origin?: unknown; state?: unknown; reopen?: unknown }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const tabId = sender.tab?.id;
  if (msg?.type === 'lv-reload-tab' && tabId !== undefined && sender.url) {
    const pending: PendingReload = { url: sender.url, state: msg.state ?? null, reopen: msg.reopen === true };
    void chrome.storage.session.set({ [pendingKey(tabId)]: pending }).then(() => chrome.tabs.reload(tabId, { bypassCache: true }));
    return;
  }
  if (msg?.type === 'lv-take-view' && tabId !== undefined) {
    const key = pendingKey(tabId);
    void chrome.storage.session.get(key).then(async (got) => {
      const pending = got[key] as PendingReload | undefined;
      await chrome.storage.session.remove(key);
      sendResponse(pending && pending.url === sender.url ? pending.state : null);
    });
    return true; // async response
  }
  if (msg?.type !== 'lv-open-options') return;
  const origin = typeof msg.origin === 'string' ? normalizeOrigin(msg.origin) : null;
  if (!origin) return void chrome.runtime.openOptionsPage();
  // A small window with one "Enable" button; Chrome's permission prompt needs that click.
  void chrome.windows.create({
    url: chrome.runtime.getURL(`options.html?add=${encodeURIComponent(origin)}&popup=1`),
    type: 'popup',
    width: 560,
    height: 460,
  });
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
      // Start before the text renders so the raw log never flashes (content.ts waits for the full text).
      runAt: 'document_start',
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
