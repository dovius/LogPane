import { describe, expect, it } from 'vitest';
import { RECENT_WINDOW, createTailState, newLines, recordLines, type TailState } from '../../src/core/tail';

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

const stateWith = (...batches: string[][]): TailState => {
  const s = createTailState();
  for (const b of batches) recordLines(s, b);
  return s;
};
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}`);

describe('empty inputs', () => {
  it('recordLines with nothing is a no-op, including firstLine', () => {
    const s = createTailState();
    recordLines(s, []);
    expect(s).toEqual({ lineCount: 0, firstLine: undefined, recent: [] });
    recordLines(s, ['A']);
    recordLines(s, []);
    expect(s).toEqual({ lineCount: 1, firstLine: 'A', recent: ['A'] });
  });

  it('newLines with empty incoming returns nothing, on fresh and filled states', () => {
    expect(newLines(createTailState(), [])).toEqual([]);
    expect(newLines(stateWith(['A', 'B']), [])).toEqual([]);
  });

  it('a fresh state takes everything and returns a copy', () => {
    const incoming = ['A', 'B'];
    const out = newLines(createTailState(), incoming);
    expect(out).toEqual(incoming);
    expect(out).not.toBe(incoming);
  });

  it('blank lines are lines too', () => {
    const s = stateWith(['A', '', 'B']);
    expect(newLines(s, ['A', '', 'B', '', 'C'])).toEqual(['', 'C']);
  });
});

describe('whole log returned again', () => {
  it('cuts the known prefix, including when nothing is new', () => {
    const s = stateWith(['A', 'B'], ['C']);
    expect(newLines(s, ['A', 'B', 'C'])).toEqual([]);
    expect(newLines(s, ['A', 'B', 'C', 'C', 'D'])).toEqual(['C', 'D']);
  });

  it('firstLine is kept from the very first batch', () => {
    const s = stateWith(['first'], ['second']);
    expect(s.firstLine).toBe('first');
  });

  it('treats changed content as new when it does not continue from our last line', () => {
    // same first line, but the old content changed (rotation / restart): nothing overlaps our end
    const s = stateWith(['A', 'B', 'C']);
    expect(newLines(s, ['A', 'X', 'Y', 'Z'])).toEqual(['A', 'X', 'Y', 'Z']);
  });
});

describe('duplicates', () => {
  it('counts repeated lines in the overlap', () => {
    expect(newLines(stateWith(['A', 'B', 'B']), ['B', 'B', 'B', 'C'])).toEqual(['B', 'C']);
    expect(newLines(stateWith(['B', 'B']), ['B', 'B', 'B'])).toEqual(['B']);
    expect(newLines(stateWith(['A']), ['A', 'A', 'A'])).toEqual(['A', 'A']);
  });

  // BUG: the overlap is matched as a multiset against the whole window, not as "suffix of what we have == prefix of the response",
  // so a new line that repeats an older one (a repeated error, a common stack frame, a blank line) is dropped
  it('keeps new lines that happen to equal older lines in the window', () => {
    const s = stateWith(['ERROR payment failed', '\tat com.acme.Pay.charge(Pay.java:42)', 'INFO retrying']);
    const incoming = ['INFO retrying', 'ERROR payment failed', '\tat com.acme.Pay.charge(Pay.java:42)', 'INFO giving up'];
    expect(newLines(s, incoming)).toEqual(['ERROR payment failed', '\tat com.acme.Pay.charge(Pay.java:42)', 'INFO giving up']);
  });

  // BUG (same root cause): a new blank line right after the overlap is swallowed because an older blank line is in the window
  it('keeps a new blank line that follows the overlap', () => {
    expect(newLines(stateWith(['A', '', 'B']), ['B', '', ''])).toEqual(['', '']);
  });

  it('keeps a new line that repeats an older one right after the overlap', () => {
    expect(newLines(stateWith(['A', 'B', 'C']), ['C', 'A', 'D'])).toEqual(['A', 'D']);
  });
});

describe('rotation / restart', () => {
  it('unrelated content is all new', () => {
    const s = stateWith(range(0, 100));
    expect(newLines(s, ['fresh 1', 'fresh 2'])).toEqual(['fresh 1', 'fresh 2']);
  });

  it('a restarted log that begins with the same banner keeps the banner', () => {
    const s = stateWith(['BANNER', 'a', 'b', 'c']);
    expect(newLines(s, ['BANNER', 'x'])).toEqual(['BANNER', 'x']);
  });
});

describe('window overflow beyond RECENT_WINDOW', () => {
  it('keeps exactly the last RECENT_WINDOW lines, for one big batch and many small ones', () => {
    const big = stateWith(range(0, RECENT_WINDOW + 1000));
    expect(big.lineCount).toBe(RECENT_WINDOW + 1000);
    expect(big.firstLine).toBe('line 0');
    expect(big.recent).toEqual(range(1000, RECENT_WINDOW + 1000));

    const many = createTailState();
    for (let i = 0; i < RECENT_WINDOW + 1000; i += 37) recordLines(many, range(i, Math.min(i + 37, RECENT_WINDOW + 1000)));
    expect(many.recent).toEqual(big.recent);
    expect(many.lineCount).toBe(big.lineCount);
  });

  it('a whole-log response still works when the log is longer than the window', () => {
    const s = stateWith(range(0, 12_000));
    expect(newLines(s, range(0, 12_003))).toEqual(range(12_000, 12_003));
  });

  it('an overlap inside the window is cut; an overlap reaching past it comes back as duplicates (current behaviour)', () => {
    const s = stateWith(range(0, 12_000));
    expect(newLines(s, range(12_000 - RECENT_WINDOW, 12_002))).toEqual(range(12_000, 12_002));
    expect(newLines(s, range(12_000 - RECENT_WINDOW - 1, 12_002))).toHaveLength(RECENT_WINDOW + 3);
  });

  it('recordLines does not overflow the call stack with huge batches', () => {
    expect(() => recordLines(createTailState(), range(0, 500_000))).not.toThrow();
  });
});

describe('simulated tailing (property, unique lines)', () => {
  it('reconstructs the full log from whole-log and sinceTime-style responses', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = mulberry32(seed);
      const full: string[] = [];
      let n = 0;
      const grow = (k: number) => {
        for (let i = 0; i < k; i++) full.push(`${seed}:${n++} ${r() < 0.2 ? '' : 'payload'}`);
      };
      grow(int(r, 6000));
      const s = createTailState();
      const received = full.slice();
      recordLines(s, received);
      for (let step = 0; step < 120; step++) {
        const before = full.length;
        grow(int(r, 3) === 0 ? 0 : int(r, 80));
        const added = full.length - before;
        const overlap = Math.min(before, int(r, 400));
        const incoming = r() < 0.3 ? full.slice() : full.slice(full.length - added - overlap);
        const fresh = newLines(s, incoming);
        recordLines(s, fresh);
        received.push(...fresh);
      }
      expect(received).toEqual(full);
    }
  });
});

describe('performance', () => {
  it('matches a 10k-line response against a full window quickly', () => {
    const s = stateWith(range(0, 20_000));
    const t0 = performance.now();
    expect(newLines(s, range(20_000 - 4000, 26_000))).toHaveLength(6000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
