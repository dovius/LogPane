import type { FilterState } from '../core/filter';

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
