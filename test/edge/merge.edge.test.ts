import { describe, expect, it } from 'vitest';
import { mergeEntries } from '../../src/core/merge';
import { parseText } from '../../src/core/parse';
import { compareEntries } from '../../src/core/time';
import type { LogEntry } from '../../src/core/types';

type Rng = () => number;
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: Rng, n: number) => Math.floor(r() * n);
const pickOne = <T>(r: Rng, xs: readonly T[]): T => xs[int(r, xs.length)];
function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = int(r, i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

function entry(sourceId: number, lineNo: number, tsMs: number, tsNanos = 0): LogEntry {
  return {
    sourceId, lineNo, raw: `${sourceId}:${lineNo}`, tsMs, tsNanos, tsInherited: false, seq: Number.NaN,
    level: 'INFO', logger: '', thread: '', message: `${sourceId}:${lineNo}`, traceId: '', spanId: '', haystack: '',
  };
}
const ids = (es: readonly LogEntry[]) => es.map((e) => e.raw);

/** A list that is sorted by compareEntries: ascending time with many ties, NaN entries at the end. */
function sortedList(r: Rng, sourceId: number): LogEntry[] {
  const times = Array.from({ length: int(r, 40) }, () => ({ ms: 1000 + int(r, 15), nanos: pickOne(r, [0, 0, 1, 500000, 999999]) }));
  times.sort((a, b) => a.ms - b.ms || a.nanos - b.nanos);
  const out = times.map((t, i) => entry(sourceId, i + 1, t.ms, t.nanos));
  for (let k = int(r, 3); k > 0; k--) out.push(entry(sourceId, out.length + 1, Number.NaN));
  return out;
}

describe('mergeEntries basics', () => {
  it('handles no lists, empty lists and returns a copy for a single list', () => {
    expect(mergeEntries([])).toEqual([]);
    expect(mergeEntries([[], []])).toEqual([]);
    const one = [entry(1, 1, 5), entry(1, 2, 3)];
    const merged = mergeEntries([[], one, []]);
    expect(merged).toEqual(one);
    expect(merged).not.toBe(one);
    expect(merged[0]).toBe(one[0]);
  });

  it('is stable: fully equal heads come out in list order', () => {
    const a = entry(1, 1, 10);
    const b = entry(1, 1, 10); // same source id, time and line: compareEntries === 0
    expect(compareEntries(a, b)).toBe(0);
    expect(mergeEntries([[a], [b]])[0]).toBe(a);
    expect(mergeEntries([[b], [a]])[0]).toBe(b);
  });

  it('breaks time ties by source id, not by list position', () => {
    const s2 = [entry(2, 1, 10)];
    const s1 = [entry(1, 1, 10)];
    expect(ids(mergeEntries([s2, s1]))).toEqual(['1:1', '2:1']);
  });
});

describe('mergeEntries properties', () => {
  it('k-way merge of sorted lists equals a stable reference sort of their concatenation', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed);
      const k = 2 + int(r, 6);
      const sourceIds = shuffle(r, Array.from({ length: k }, (_, i) => i + 1));
      const lists = sourceIds.map((id) => sortedList(r, id));
      const reference = lists.flat().sort(compareEntries);
      expect(ids(mergeEntries(lists))).toEqual(ids(reference));
    }
  });

  it('keeps every entry exactly once and preserves per-source order for unsorted inputs', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed);
      const lists = Array.from({ length: 1 + int(r, 6) }, (_, i) =>
        Array.from({ length: int(r, 30) }, (_, j) => entry(i + 1, j + 1, r() < 0.1 ? Number.NaN : int(r, 50), int(r, 3))),
      );
      const merged = mergeEntries(lists);
      expect(merged).toHaveLength(lists.reduce((n, l) => n + l.length, 0));
      expect(new Set(merged).size).toBe(merged.length);
      for (const list of lists) {
        if (!list.length) continue;
        expect(merged.filter((e) => e.sourceId === list[0].sourceId)).toEqual(list);
      }
    }
  });

  it('when every list is sorted, the output is sorted', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = mulberry32(seed);
      const merged = mergeEntries(Array.from({ length: 2 + int(r, 4) }, (_, i) => sortedList(r, i + 1)));
      for (let i = 1; i < merged.length; i++) expect(compareEntries(merged[i - 1], merged[i])).toBeLessThanOrEqual(0);
    }
  });

  it('does not mutate its inputs', () => {
    const a = [entry(1, 1, 3), entry(1, 2, 1)];
    const b = [entry(2, 1, 2)];
    const before = [ids(a), ids(b)];
    mergeEntries([a, b]);
    expect([ids(a), ids(b)]).toEqual(before);
  });
});

describe('sources whose first lines have no timestamp', () => {
  const podA = parseText(
    ['Picked up JAVA_TOOL_OPTIONS: -Xmx512m', '{"timestamp":"2026-10-01T10:00:01Z","message":"a1"}', '{"timestamp":"2026-10-01T10:00:02Z","message":"a2"}'].join('\n'),
    1,
  );
  const podB = parseText(['{"timestamp":"2026-10-01T10:00:00Z","message":"b0"}', '{"timestamp":"2026-10-01T10:00:03Z","message":"b3"}'].join('\n'), 2);

  it('the banner takes the first timestamp of its source, so it stays right before a1', () => {
    expect(podA[0].tsMs).toBe(podA[1].tsMs);
    expect(podA[0].tsInherited).toBe(true);
    expect(mergeEntries([podA, podB]).map((e) => e.message.split(':')[0])).toEqual(['b0', 'Picked up JAVA_TOOL_OPTIONS', 'a1', 'a2', 'b3']);
  });

  // BUG: a leading line without a timestamp (JVM banner, "Picked up JAVA_TOOL_OPTIONS", shell output) has tsMs NaN, sorts "last" and blocks
  // its whole source in the k-way merge, so every entry of that pod is shown after all entries of the other pods
  it('interleaves the timestamped entries of both sources by time', () => {
    const merged = mergeEntries([podA, podB]);
    const timed = merged.filter((e) => !e.tsInherited).map((e) => e.message);
    expect(timed).toEqual(['b0', 'a1', 'a2', 'b3']);
  });
});

describe('performance', () => {
  it('merges 8 sources x 10k entries quickly', () => {
    const r = mulberry32(9);
    const lists = Array.from({ length: 8 }, (_, i) => {
      let t = 0;
      return Array.from({ length: 10_000 }, (_, j) => entry(i + 1, j + 1, (t += int(r, 20))));
    });
    const t0 = performance.now();
    const merged = mergeEntries(lists);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(merged).toHaveLength(80_000);
  });
});
