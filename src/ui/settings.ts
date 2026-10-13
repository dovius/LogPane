import type { TimeMode } from '../core/time';
import { TAIL_OPTIONS } from './viewState';

export interface Settings {
  timeMode: TimeMode;
  fontSize: number;
  /** Width of the details panel in px; 0 sizes it to the window until the user drags it. */
  detailsWidth: number;
  showLogger: boolean;
  showThread: boolean;
  tailSeconds: number;
  contextLines: number;
}

export const DEFAULT_SETTINGS: Settings = {
  timeMode: 'utc',
  fontSize: 12,
  detailsWidth: 0,
  showLogger: true,
  showThread: false,
  tailSeconds: 5,
  contextLines: 20,
};

const KEY = 'lvSettings';

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 20;

const intIn = (v: unknown, min: number, max: number, fallback: number) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/** Stored settings are checked field by field: another page or an older version may have written anything. */
export function sanitizeSettings(v: unknown): Settings {
  const s = (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    timeMode: s.timeMode === 'local' ? 'local' : 'utc',
    fontSize: intIn(s.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, d.fontSize),
    detailsWidth: s.detailsWidth === 0 ? 0 : intIn(s.detailsWidth, 200, 10_000, d.detailsWidth),
    showLogger: bool(s.showLogger, d.showLogger),
    showThread: bool(s.showThread, d.showThread),
    tailSeconds: TAIL_OPTIONS.includes(s.tailSeconds as number) ? (s.tailSeconds as number) : d.tailSeconds,
    contextLines: intIn(s.contextLines, 1, 500, d.contextLines),
  };
}

const hasChromeStorage = () => typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

export async function loadSettings(): Promise<Settings> {
  try {
    if (hasChromeStorage()) {
      return sanitizeSettings((await chrome.storage.local.get(KEY))[KEY]);
    }
    const raw = localStorage.getItem(KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : undefined);
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
