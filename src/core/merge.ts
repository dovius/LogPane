import { compareEntries } from './time';
import type { LogEntry } from './types';

/**
 * K-way merge by timestamp. Each list keeps its own order (log order within a pod is the truth,
 * even when threads interleave slightly out of timestamp order); only the interleaving is decided by time.
 */
export function mergeEntries(lists: readonly (readonly LogEntry[])[]): LogEntry[] {
  const nonEmpty = lists.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0].slice();
  const total = nonEmpty.reduce((n, l) => n + l.length, 0);
  const out = new Array<LogEntry>(total);
  const pos = new Array<number>(nonEmpty.length).fill(0);
  for (let k = 0; k < total; k++) {
    let best = -1;
    for (let i = 0; i < nonEmpty.length; i++) {
      if (pos[i] >= nonEmpty[i].length) continue;
      if (best < 0 || compareEntries(nonEmpty[i][pos[i]], nonEmpty[best][pos[best]]) < 0) best = i;
    }
    out[k] = nonEmpty[best][pos[best]++];
  }
  return out;
}
