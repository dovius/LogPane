// Injected into a "Raw" log page (text/plain) – either by the toolbar button or automatically
// on domains enabled in the options. Replaces the plain text with the viewer; "Raw" toggles back.
import { looksLikeJsonLog } from '../core/parse';
import { labelForUrl } from '../core/sources';
import { mountApp, type AutoPrompt } from '../ui/App';
import { loadSettings } from '../ui/settings';
import { LogStore } from '../ui/store';
import { dismissOrigin, getAutoOrigins, getDismissedOrigins, isRawLogPath } from './autoOrigins';

declare global {
  interface Window {
    __lvMounted?: boolean;
    __lvManual?: boolean;
  }
}

const TEXT_TYPES = ['text/plain', 'application/json', 'application/x-ndjson', 'application/jsonl'];

function toggleRaw(): void {
  document.documentElement.classList.toggle('lv-active');
}

function waitForDocument(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
}

const openAutoSetup = () => void chrome.runtime.sendMessage({ type: 'lv-open-options', origin: location.origin });

/** After a manual open on a Raw log page, offer to skip the toolbar click next time. */
async function autoPrompt(): Promise<AutoPrompt | undefined> {
  if (!isRawLogPath(location.pathname)) return undefined;
  const [enabled, dismissed] = await Promise.all([getAutoOrigins(), getDismissedOrigins()]);
  if (enabled.includes(location.origin) || dismissed.includes(location.origin)) return undefined;
  return { host: location.host, onEnable: openAutoSetup, onDismiss: () => void dismissOrigin(location.origin) };
}

async function mount(text: string, manual: boolean): Promise<void> {
  window.__lvMounted = true;
  const root = document.createElement('div');
  root.id = 'lv-root';
  const reopen = document.createElement('button');
  reopen.id = 'lv-reopen';
  reopen.type = 'button';
  reopen.textContent = 'Open in LogPane';
  reopen.addEventListener('click', toggleRaw);
  document.body.append(root, reopen);
  document.documentElement.classList.add('lv-active');

  const label = labelForUrl(location.href);
  document.title = `${label} – LogPane`;

  const store = new LogStore();
  const [initialSettings, prompt] = await Promise.all([loadSettings(), manual ? autoPrompt() : undefined]);
  mountApp(root, {
    store,
    mode: 'page',
    initialSettings,
    canFetchUrls: true,
    baseUrl: location.href,
    onShowRaw: toggleRaw,
    onAutoOpen: openAutoSetup,
    autoPrompt: prompt,
  });
  void store.addText({ label, kind: 'page', url: location.href }, text);

  chrome.runtime.onMessage.addListener((msg: { type?: unknown }, sender) => {
    if (sender.id === chrome.runtime.id && msg?.type === 'lv-toggle') toggleRaw();
  });
}

async function main(): Promise<void> {
  if (window.__lvMounted) return;
  const manual = Boolean(window.__lvManual);
  if (!manual && !TEXT_TYPES.includes(document.contentType)) return;
  // Automatic mode runs at document_start: keep the raw text hidden while it streams in, so it never flashes.
  const html = document.documentElement;
  if (!manual) html.classList.add('lv-pending');
  try {
    await waitForDocument();
    const pre = document.querySelector('body > pre');
    const text = pre?.textContent ?? document.body?.innerText ?? '';
    // Automatic mode only takes over pages that really are JSON logs.
    if (!manual && !looksLikeJsonLog(text)) return;
    await mount(text, manual);
  } finally {
    html.classList.remove('lv-pending');
  }
}

void main();
