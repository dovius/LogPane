// Injected into a "Raw" log page (text/plain) – either by the toolbar button or automatically
// on domains enabled in the options. Replaces the plain text with the viewer; "Raw" toggles back.
import { looksLikeJsonLog } from '../core/parse';
import { labelForUrl } from '../core/sources';
import { mountApp } from '../ui/App';
import { loadSettings } from '../ui/settings';
import { LogStore } from '../ui/store';

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

async function main(): Promise<void> {
  if (window.__lvMounted) return;
  const manual = Boolean(window.__lvManual);
  if (!manual && !TEXT_TYPES.includes(document.contentType)) return;
  const pre = document.querySelector('body > pre');
  const text = pre?.textContent ?? document.body?.innerText ?? '';
  // Automatic mode only takes over pages that really are JSON logs.
  if (!manual && !looksLikeJsonLog(text)) return;
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
  mountApp(root, {
    store,
    mode: 'page',
    initialSettings: await loadSettings(),
    canFetchUrls: true,
    baseUrl: location.href,
    onShowRaw: toggleRaw,
    onAutoOpen: () => void chrome.runtime.sendMessage({ type: 'lv-open-options', origin: location.origin }),
  });
  void store.addText({ label, kind: 'page', url: location.href }, text);

  chrome.runtime.onMessage.addListener((msg: { type?: unknown }, sender) => {
    if (sender.id === chrome.runtime.id && msg?.type === 'lv-toggle') toggleRaw();
  });
}

void main();
