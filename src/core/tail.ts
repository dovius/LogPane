/** Physical lines kept per source to reconcile overlapping tail responses. */
export const RECENT_WINDOW = 5000;

export interface TailState {
  /** Physical lines received so far. */
  lineCount: number;
  firstLine: string | undefined;
  /** Last RECENT_WINDOW physical lines. */
  recent: string[];
}

export function createTailState(): TailState {
  return { lineCount: 0, firstLine: undefined, recent: [] };
}

export function recordLines(state: TailState, lines: readonly string[]): void {
  if (!lines.length) return;
  if (state.lineCount === 0) state.firstLine = lines[0];
  state.lineCount += lines.length;
  const keep = lines.length >= RECENT_WINDOW ? lines.slice(-RECENT_WINDOW) : lines;
  state.recent.push(...keep);
  if (state.recent.length > RECENT_WINDOW) state.recent.splice(0, state.recent.length - RECENT_WINDOW);
}

/**
 * Returns the lines in `incoming` that the source does not have yet.
 *
 * Two response shapes are handled:
 *  - the whole log again (server ignored `sinceTime`): recognised by its first line, the known prefix is cut off;
 *  - lines since `sinceTime`: the response starts with lines we already have; that overlap is a prefix
 *    and is skipped line by line against the recent window (multiset, so repeated lines are counted).
 */
export function newLines(state: TailState, incoming: readonly string[]): string[] {
  if (state.lineCount === 0) return incoming.slice();
  if (
    incoming.length >= state.lineCount &&
    incoming[0] === state.firstLine &&
    incoming[state.lineCount - 1] === state.recent[state.recent.length - 1]
  ) {
    return incoming.slice(state.lineCount);
  }
  const counts = new Map<string, number>();
  for (const line of state.recent) counts.set(line, (counts.get(line) ?? 0) + 1);
  let i = 0;
  for (; i < incoming.length; i++) {
    const n = counts.get(incoming[i]);
    if (!n) break;
    counts.set(incoming[i], n - 1);
  }
  return incoming.slice(i);
}
