import type { TimeMode } from '../core/time';

export interface Settings {
  timeMode: TimeMode;
  fontSize: number;
  detailsWidth: number;
  showLogger: boolean;
  showThread: boolean;
  tailSeconds: number;
  contextLines: number;
}

export const DEFAULT_SETTINGS: Settings = {
  timeMode: 'utc',
  fontSize: 12,
  detailsWidth: 520,
  showLogger: true,
  showThread: false,
  tailSeconds: 5,
  contextLines: 20,
};

const KEY = 'lvSettings';

const hasChromeStorage = () => typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

export async function loadSettings(): Promise<Settings> {
  try {
    if (hasChromeStorage()) {
      const got = await chrome.storage.local.get(KEY);
      return { ...DEFAULT_SETTINGS, ...(got[KEY] as Partial<Settings> | undefined) };
    }
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    if (hasChromeStorage()) void chrome.storage.local.set({ [KEY]: s });
    else localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // settings are a convenience; ignore storage failures
  }
}
