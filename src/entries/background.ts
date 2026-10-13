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
  void chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  void chrome.action.setTitle({ tabId: tab.id, title: 'Open in LogPane' });
  // A saved view waiting for this tab is handed over only if the viewer opens on the same page (lv-take-view).
  try {
    const [probe] = await chrome.scripting.executeScript({
      target,
      func: () => ({ contentType: document.contentType, mounted: (window as { __lvMounted?: unknown }).__lvMounted === true }),
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
  void chrome.storage.session.remove(pendingKey(tab.id));
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
  /** When the reload was asked for (ms). */
  at: number;
}
const pendingKey = (tabId: number) => `reload:${tabId}`;
/** A saved view older than this belongs to a reload that never came back; it is dropped. */
const PENDING_MAX_AGE_MS = 2 * 60_000;
/** Larger view states are not kept (they hold a search, filters and a few numbers). */
const MAX_STATE_CHARS = 64 * 1024;
const sameDocument = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];

async function takePending(tabId: number): Promise<PendingReload | undefined> {
  const key = pendingKey(tabId);
  const pending = (await chrome.storage.session.get(key))[key] as PendingReload | undefined;
  if (pending) await chrome.storage.session.remove(key);
  return pending;
}

const unhide = (tabId: number) =>
  chrome.scripting.executeScript({ target: { tabId }, func: () => document.documentElement.classList.remove('lv-pending') }).catch(() => undefined);

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'loading' && info.status !== 'complete') return;
  const key = pendingKey(tabId);
  const pending = (await chrome.storage.session.get(key))[key] as PendingReload | undefined;
  if (!pending) return;
  // The reload went somewhere else (a login page, a redirect) or never came back: forget it, touch nothing.
  // tab.url is only visible where LogPane has access; without access nothing can be injected anyway.
  if (Date.now() - pending.at > PENDING_MAX_AGE_MS || (tab.url !== undefined && !sameDocument(tab.url, pending.url))) {
    await chrome.storage.session.remove(key);
    return;
  }
  if (!pending.reopen) return; // the automatic content script takes the view itself
  const target = { tabId };
  if (info.status === 'loading') {
    // Hide the raw text as early as possible: laying out a big log is what makes the reload slow.
    await chrome.scripting.insertCSS({ target, files: ['viewer.css'] }).catch(() => undefined);
    await chrome.scripting
      .executeScript({ target, injectImmediately: true, func: () => document.documentElement.classList.add('lv-pending') })
      .catch(() => undefined);
    return;
  }
  // Inject again only into the same document, and only if it still is a plain-text log.
  const [probe] = await chrome.scripting
    .executeScript({ target, func: () => ({ url: location.href, contentType: document.contentType }) })
    .catch(() => [undefined]);
  const page = probe?.result as { url: string; contentType: string } | undefined;
  if (page && (!sameDocument(page.url, pending.url) || !TEXT_TYPES.includes(page.contentType))) {
    await chrome.storage.session.remove(key);
    await unhide(tabId);
    return;
  }
  // Chrome keeps activeTab across same-origin reloads. If injecting still fails, show the raw text again and
  // badge the toolbar button: one click reopens the viewer with the saved view.
  await injectViewer(tabId).catch(async () => {
    await unhide(tabId);
    await chrome.action.setBadgeText({ tabId, text: '↻' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d32f1e' });
    await chrome.action.setTitle({ tabId, title: 'Click to reopen LogPane on this page' });
  });
});
chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(pendingKey(tabId)));

/** The one "enable automatic opening" popup; a new request replaces it instead of piling up windows. */
let setupWindow: number | undefined;
chrome.windows.onRemoved.addListener((id) => {
  if (id === setupWindow) setupWindow = undefined;
});

async function openSetup(origin: string): Promise<void> {
  if (setupWindow !== undefined) await chrome.windows.remove(setupWindow).catch(() => undefined);
  // A small window with one "Enable" button; Chrome's permission prompt needs that click.
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`options.html?add=${encodeURIComponent(origin)}&popup=1`),
    type: 'popup',
    width: 560,
    height: 460,
  });
  setupWindow = win?.id;
}

// Content scripts live in untrusted pages: accept only our own sender in a tab's top frame, known actions
// and well-formed values. What a message may affect (tab, URL, origin) is taken from the sender, never from the message.
chrome.runtime.onMessage.addListener((msg: { type?: unknown; state?: unknown; reopen?: unknown }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url) return;
  if (msg?.type === 'lv-reload-tab') {
    let state = msg.state ?? null;
    try {
      if (JSON.stringify(state).length > MAX_STATE_CHARS) state = null;
    } catch {
      state = null;
    }
    const pending: PendingReload = { url: sender.url, state, reopen: msg.reopen === true, at: Date.now() };
    void chrome.storage.session.set({ [pendingKey(tabId)]: pending }).then(() => chrome.tabs.reload(tabId, { bypassCache: true }));
    return;
  }
  if (msg?.type === 'lv-take-view') {
    const url = sender.url;
    void takePending(tabId).then((pending) => sendResponse(pending && sameDocument(pending.url, url) ? pending.state : null));
    return true; // async response
  }
  if (msg?.type !== 'lv-open-options') return;
  const page = new URL(sender.url);
  const origin = page.protocol === 'https:' || page.protocol === 'http:' ? normalizeOrigin(page.origin) : null;
  if (!origin) return void chrome.runtime.openOptionsPage();
  void openSetup(origin);
});

/** Keeps the registered content script in sync with the enabled (and still permitted) origins. */
let syncing: Promise<void> = Promise.resolve();
function syncAutoScripts(): Promise<void> {
  // one at a time (several storage / permission events can arrive together), and a failure doesn't block the next
  syncing = syncing.then(registerAutoScripts).catch((err: unknown) => console.warn('LogPane: could not update automatic opening', err));
  return syncing;
}

async function registerAutoScripts(): Promise<void> {
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
