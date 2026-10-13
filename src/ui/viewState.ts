import type { FilterState } from '../core/filter';
import { LEVELS } from '../core/types';

/** What the viewer restores after its page is reloaded (Reload / Tail on consoles that reject page requests). */
export interface ViewState {
  query: string;
  filter: FilterState;
  /** Line number of the selected entry in the page source. */
  selectedLine?: number;
  scrollTop: number;
  atBottom: boolean;
  tailSeconds: number;
  /** Tail by reloading the page because the console rejects background requests. */
  tailByReload: boolean;
}

/** Shortest interval for tailing by page reload: each cycle downloads and parses the whole log. */
export const RELOAD_TAIL_MIN_SECONDS = 10;

/** Tail intervals offered in the toolbar (0 = off). */
export const TAIL_OPTIONS = [0, 2, 5, 10, 30];

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function sanitizeFilter(v: unknown): FilterState {
  const f = (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  return {
    text: text(f.text, 10_000),
    regex: f.regex === true,
    caseSensitive: f.caseSensitive === true,
    levels: LEVELS.filter((l) => list(f.levels).includes(l)),
    loggers: list(f.loggers).filter((l): l is string => typeof l === 'string').slice(0, 1000),
    hiddenSources: list(f.hiddenSources).filter((n): n is number => Number.isInteger(n)).slice(0, 100),
    traceId: text(f.traceId, 200),
    fromMs: finite(f.fromMs),
    toMs: finite(f.toMs),
  };
}

/**
 * The view saved before a reload comes back through the background after the page was replaced:
 * whatever its shape, only well-formed values within the toolbar's own ranges are used.
 */
export function sanitizeViewState(v: unknown): ViewState | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  const line = finite(s.selectedLine);
  return {
    query: text(s.query, 10_000),
    filter: sanitizeFilter(s.filter),
    selectedLine: line !== null && Number.isInteger(line) && line > 0 ? line : undefined,
    scrollTop: Math.max(0, finite(s.scrollTop) ?? 0),
    atBottom: s.atBottom === true,
    tailSeconds: TAIL_OPTIONS.includes(s.tailSeconds as number) ? (s.tailSeconds as number) : 0,
    tailByReload: s.tailByReload === true,
  };
}
