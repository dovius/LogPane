import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/core/parse';
import { compareEntries, dayKey, formatFull, formatTime, leadingTimestamp, parseTimestamp, parseUserTime } from '../../src/core/time';
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

/** Runs `fn` with process.env.TZ switched (Node re-reads TZ on assignment), restoring it afterwards. */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const U = Date.UTC;
const T0 = U(2026, 9, 1, 13, 55, 19);

describe('parseTimestamp: ISO formats', () => {
  it.each([
    ['2026-10-01T13:55:19Z', T0, 0],
    ['2026-10-01T13:55:19z', T0, 0],
    ['2026-10-01t13:55:19z', T0, 0],
    ['2026-10-01 13:55:19', T0, 0],
    ['2026-10-01T13:55:19', T0, 0],
    ['  2026-10-01T13:55:19Z  ', T0, 0],
    ['2026-10-01T13:55Z', U(2026, 9, 1, 13, 55), 0],
    ['2026-10-01 13:55:19,169', T0 + 169, 0],
    ['2026-10-01T15:55:19+02', T0, 0],
    ['2026-10-01T15:55:19+0200', T0, 0],
    ['2026-10-01T15:55:19+02:00', T0, 0],
    ['2026-10-01T15:55:19 +02:00', T0, 0],
    ['2026-10-01T08:25:19-05:30', T0, 0],
    ['2026-10-02T03:55:19+14:00', T0, 0],
    ['2026-10-01T01:55:19-12:00', T0, 0],
    ['2026-10-01T13:55:19-00:00', T0, 0],
    ['2026-10-01T15:55:19.123456789+02:00', T0 + 123, 456789],
  ])('%s', (input, ms, nanos) => {
    expect(parseTimestamp(input)).toEqual({ ms, nanos });
  });

  it('handles 0 to 12 fractional digits (extra digits are truncated, not rounded)', () => {
    const digits = '987654321987';
    expect(parseTimestamp('2026-10-01T13:55:19.Z')).toBeNull(); // a dot without digits
    for (let n = 0; n <= 12; n++) {
      const frac = digits.slice(0, n);
      const input = `2026-10-01T13:55:19${n ? `.${frac}` : ''}Z`;
      const ms = T0 + Number((frac + '000').slice(0, 3));
      const nanos = Number((frac.slice(3) + '000000').slice(0, 6));
      expect(parseTimestamp(input), input).toEqual({ ms, nanos });
    }
    expect(parseTimestamp('2026-10-01T13:55:19.9999999999Z')).toEqual({ ms: T0 + 999, nanos: 999999 });
  });

  it('accepts leap days in leap years', () => {
    expect(parseTimestamp('2024-02-29T12:00:00Z')?.ms).toBe(U(2024, 1, 29, 12));
    expect(parseTimestamp('2000-02-29T00:00:00Z')?.ms).toBe(U(2000, 1, 29));
  });

  it('rejects out-of-range fields', () => {
    for (const s of ['2026-10-01T25:00:00Z', '2026-10-01T23:60:00Z', '2026-10-01T23:59:61Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-10-00T00:00:00Z', '2026-10-32T00:00:00Z', '2026-10-01T10:00:00+24:00']) {
      expect(parseTimestamp(s), s).toBeNull();
    }
  });

  it('rejects impossible dates and times instead of rolling them over', () => {
    expect(parseTimestamp('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-02-29T00:00:00Z')).toBeNull(); // not a leap year
    expect(parseTimestamp('2028-02-29T00:00:00Z')?.ms).toBe(U(2028, 1, 29)); // leap year
    expect(parseTimestamp('2026-04-31T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-10-01T24:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-13-01T00:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-10-01T23:60:00Z')).toBeNull();
    expect(parseTimestamp('2026-12-31T23:59:60Z')).toBeNull(); // leap seconds are not representable
  });

  it('current behaviour: a fraction after HH:mm is read as fractional seconds', () => {
    expect(parseTimestamp('2026-10-01T13:55.5Z')).toEqual({ ms: U(2026, 9, 1, 13, 55, 0, 500), nanos: 0 });
  });

  it('rejects other shapes and non-string, non-number values', () => {
    for (const s of ['', '2026-10-01', '13:55:19', 'yesterday', '2026-10-01T13:55:19+2', '2026-10-01T13:55:19 UTC', '2026/10/01 13:55:19', '2026-10-01T13:55:19+02:00[Europe/Paris]', '1759312800']) {
      expect(parseTimestamp(s), s).toBeNull();
    }
    for (const v of [null, undefined, true, {}, [], Number.NaN, Infinity, -Infinity]) expect(parseTimestamp(v)).toBeNull();
  });
});

describe('parseTimestamp: epoch numbers', () => {
  it('distinguishes seconds, milliseconds and nanoseconds at the documented boundaries', () => {
    expect(parseTimestamp(0)).toEqual({ ms: 0, nanos: 0 });
    expect(parseTimestamp(-1)).toBeNull(); // before 1970: not a log timestamp
    expect(parseTimestamp(1e11)).toEqual({ ms: 1e14, nanos: 0 }); // still seconds
    expect(parseTimestamp(1e11 + 1)).toEqual({ ms: 1e11 + 1, nanos: 0 }); // milliseconds
    expect(parseTimestamp(1e14)).toEqual({ ms: 1e14, nanos: 0 }); // still milliseconds
    expect(parseTimestamp(1e14 + 1)).toEqual({ ms: 1e11, nanos: 1000 }); // microseconds
    expect(parseTimestamp(1e17)).toEqual({ ms: 1e14, nanos: 0 }); // still microseconds
    expect(parseTimestamp(1e17 + 1e3)?.ms).toBe(1e11); // nanoseconds
  });

  it('reads realistic seconds, fractional seconds, milliseconds and nanoseconds', () => {
    expect(parseTimestamp(1759312800)).toEqual({ ms: 1759312800000, nanos: 0 });
    expect(parseTimestamp(1759312800.5)).toEqual({ ms: 1759312800500, nanos: 0 });
    expect(parseTimestamp(1759312800.123)).toEqual({ ms: 1759312800123, nanos: 0 });
    expect(parseTimestamp(1759312800123)).toEqual({ ms: 1759312800123, nanos: 0 });
    const ns = parseTimestamp(1759312800123456789)!; // a double: ~256 ns precision
    expect(ns.ms).toBe(1759312800123);
    expect(Math.abs(ns.nanos - 456789)).toBeLessThan(300);
  });

  it('GELF-style seconds with 3 decimals never lose a millisecond to float error', () => {
    const r = mulberry32(5);
    for (let i = 0; i < 20_000; i++) {
      const sec = 1_600_000_000 + int(r, 400_000_000);
      const milli = int(r, 1000);
      expect(parseTimestamp(Number(`${sec}.${String(milli).padStart(3, '0')}`))).toEqual({ ms: sec * 1000 + milli, nanos: 0 });
    }
  });

  // BUG: microsecond epochs (Go UnixMicro, many Python/Rust loggers) fall into the nanosecond bucket and show up as January 1970
  it('reads microsecond epoch numbers', () => {
    expect(parseTimestamp(1759312800123456)).toEqual({ ms: 1759312800123, nanos: 456000 });
  });

  // BUG: Math.round of the sub-millisecond fraction can produce nanos = 1 000 000 (outside 0..999999); formatFull then prints a wrong time
  it('keeps nanos within 0..999999 for fractional epoch numbers', () => {
    const t = parseTimestamp(1.9999999999)!;
    expect(t.nanos).toBeLessThan(1_000_000);
    expect(formatFull(t.ms, t.nanos, 'utc')).toBe('1970-01-01T00:00:02.000Z');
  });

  // BUG: numbers outside the Date range are accepted; formatTime then prints "NaN:NaN:NaN.NaN" and withSinceTime throws a RangeError
  it('rejects epoch numbers outside the JS Date range', () => {
    expect(parseTimestamp(1e22)).toBeNull();
    expect(parseTimestamp(-1e20)).toBeNull();
  });

  it('reads Google Cloud style {seconds, nanos} objects', () => {
    expect(parseTimestamp({ seconds: 1759312800, nanos: 123456789 })).toEqual({ ms: 1759312800123, nanos: 456789 });
    expect(parseTimestamp({ seconds: 1759312800 })).toEqual({ ms: 1759312800000, nanos: 0 });
    expect(parseTimestamp({ seconds: 'x' })).toBeNull();
  });
});

describe('formatFull / formatTime / dayKey', () => {
  it('returns empty strings for NaN', () => {
    expect(formatFull(Number.NaN, 5, 'utc')).toBe('');
    expect(formatTime(Number.NaN, 'local', true)).toBe('');
    expect(dayKey(Number.NaN, 'utc')).toBe('');
  });

  it('trims trailing zeros of the nanos but keeps the 3 millisecond digits', () => {
    expect(formatFull(T0, 0, 'utc')).toBe('2026-10-01T13:55:19.000Z');
    expect(formatFull(T0 + 5, 100, 'utc')).toBe('2026-10-01T13:55:19.0050001Z');
    expect(formatFull(T0, 1, 'utc')).toBe('2026-10-01T13:55:19.000000001Z');
    expect(formatFull(T0, 999999, 'utc')).toBe('2026-10-01T13:55:19.000999999Z');
  });

  it('round-trips through parseTimestamp in UTC (years 1000-9999, any nanos)', () => {
    const r = mulberry32(11);
    const lo = U(1000, 0, 1);
    const hi = U(9999, 11, 31, 23, 59, 59, 999);
    for (let i = 0; i < 5000; i++) {
      const ms = lo + Math.floor(r() * (hi - lo));
      const nanos = pickOne(r, [0, 1, 10, 999999, 500000, int(r, 1e6)]);
      expect(parseTimestamp(formatFull(ms, nanos, 'utc'))).toEqual({ ms, nanos });
    }
  });

  it.each(['Europe/Vilnius', 'America/St_Johns', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'America/Los_Angeles'])(
    'round-trips in local mode across DST in %s',
    (tz) => {
      withTZ(tz, () => {
        const r = mulberry32(tz.length);
        const lo = U(1980, 0, 1);
        const hi = U(2099, 0, 1);
        for (let i = 0; i < 3000; i++) {
          const ms = lo + Math.floor(r() * (hi - lo));
          const nanos = int(r, 1e6);
          const text = formatFull(ms, nanos, 'local');
          expect(parseTimestamp(text), text).toEqual({ ms, nanos });
        }
      });
    },
  );

  it('writes half- and quarter-hour offsets', () => {
    withTZ('Asia/Kathmandu', () => expect(formatFull(U(2026, 0, 1), 0, 'local')).toBe('2026-01-01T05:45:00.000+05:45'));
    withTZ('America/St_Johns', () => expect(formatFull(U(2026, 0, 1), 0, 'local')).toBe('2025-12-31T20:30:00.000-03:30'));
  });

  it('formatTime and dayKey follow the display mode', () => {
    withTZ('Asia/Tokyo', () => {
      const ms = U(2026, 9, 1, 20, 0, 0, 7);
      expect(formatTime(ms, 'utc', true)).toBe('10-01 20:00:00.007');
      expect(formatTime(ms, 'local', true)).toBe('10-02 05:00:00.007');
      expect(dayKey(ms, 'utc')).toBe('2026-10-1');
      expect(dayKey(ms, 'local')).toBe('2026-10-2');
    });
  });
});

describe('compareEntries', () => {
  const at = (iso: string, sourceId: number, lineNo = 1) => {
    const [e] = parseText(JSON.stringify({ timestamp: iso, message: iso }), sourceId);
    e.lineNo = lineNo;
    return e;
  };

  /** Renders an instant with `digits` fractional digits and a zone offset; returns the text and its true value in ns. */
  function render(r: Rng, ms: number, nanos: number): { text: string; ns: bigint } {
    const digits = int(r, 10);
    const nine = String(ms % 1000).padStart(3, '0') + String(nanos).padStart(6, '0');
    const frac = nine.slice(0, digits);
    const kept = (frac + '000000000').slice(0, 9);
    const ns = BigInt(ms - (ms % 1000)) * 1_000_000n + BigInt(Number(kept));
    const offMin = pickOne(r, [0, 0, 60, 120, -300, 330, -570, 765, 840, -720]);
    const wall = new Date(ms + offMin * 60_000).toISOString().slice(0, 19).replace('T', pickOne(r, ['T', ' ']));
    const sign = offMin < 0 ? '-' : '+';
    const hh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0');
    const mm = String(Math.abs(offMin) % 60).padStart(2, '0');
    const zone = offMin === 0 ? pickOne(r, ['Z', 'z', '+00:00', '']) : pickOne(r, [`${sign}${hh}:${mm}`, `${sign}${hh}${mm}`]);
    return { text: `${wall}${digits ? pickOne(r, ['.', ',']) + frac : ''}${zone}`, ns };
  }

  it('orders mixed precisions, offsets and separators like the true instants (property)', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const r = mulberry32(seed);
      const base = U(2026, 9, 1, 13, 55, 50);
      const items: { e: LogEntry; ns: bigint }[] = [];
      for (let i = 0; i < 60; i++) {
        // cluster instants inside a few ms so that sub-millisecond digits decide
        const ms = base + int(r, 4);
        const nanos = pickOne(r, [0, int(r, 1e6), 999999, 1, 702060, 702061]);
        if (r() < 0.15) {
          const [e] = parseText(JSON.stringify({ time: ms, msg: 'epoch' }), i + 1);
          items.push({ e, ns: BigInt(ms) * 1_000_000n });
        } else {
          const { text, ns } = render(r, ms, nanos);
          items.push({ e: at(text, i + 1), ns });
        }
      }
      for (const a of items) {
        for (const b of items) {
          const got = Math.sign(compareEntries(a.e, b.e));
          const want = a.ns === b.ns ? Math.sign(a.e.sourceId - b.e.sourceId) : a.ns < b.ns ? -1 : 1;
          if (got !== want) throw new Error(`${a.e.tsText} vs ${b.e.tsText}: got ${got}, want ${want}`);
        }
      }
    }
  });

  it('puts entries without a timestamp last and breaks ties by source, sequence, line', () => {
    const none1 = parseText('plain', 1)[0];
    const none2 = parseText('plain', 2)[0];
    const timed = at('2026-10-01T00:00:00Z', 3);
    expect(compareEntries(none1, timed)).toBeGreaterThan(0);
    expect(compareEntries(timed, none1)).toBeLessThan(0);
    expect(compareEntries(none1, none2)).toBeLessThan(0);
    const [a, b] = parseText('{"timestamp":"2026-10-01T00:00:00Z","sequence":9}\n{"timestamp":"2026-10-01T00:00:00Z","sequence":3}', 1);
    expect(compareEntries(b, a)).toBeLessThan(0); // sequence wins over line number
    expect(compareEntries(a, a)).toBe(0);
  });

  it('documents that the sequence tie-break is not transitive when only some entries have one', () => {
    // Only relevant within one source, which mergeEntries never reorders, so it is harmless today.
    const mk = (seq: number, lineNo: number): LogEntry => ({ ...at('2026-10-01T00:00:00Z', 1, lineNo), seq });
    const A = mk(2, 1);
    const B = mk(Number.NaN, 2);
    const C = mk(1, 3);
    expect(compareEntries(A, B)).toBeLessThan(0);
    expect(compareEntries(B, C)).toBeLessThan(0);
    expect(compareEntries(C, A)).toBeLessThan(0);
  });
});

describe('leadingTimestamp', () => {
  it.each([
    ['2026-10-01 13:55:19,169 INFO x', '2026-10-01 13:55:19,169'],
    ['[2026-10-01T13:55:19.169Z] x', '2026-10-01T13:55:19.169Z'],
    ['2026-10-01T13:55:19+0200 x', '2026-10-01T13:55:19+0200'],
    ['2026-10-01T13:55:19.123456789Z{"a":1}', '2026-10-01T13:55:19.123456789Z'],
    ['2026-10-01T13:55:19+02 x', '2026-10-01T13:55:19'], // an hour-only offset is not captured (then read as UTC)
    ['2026-10-01T13:55:19z x', '2026-10-01T13:55:19'], // lowercase z not captured
  ])('%s', (line, ts) => {
    expect(leadingTimestamp(line)).toBe(ts);
  });

  it('needs seconds and the very start of the line', () => {
    expect(leadingTimestamp('2026-10-01T13:55 x')).toBeNull();
    expect(leadingTimestamp(' 2026-10-01 13:55:19 x')).toBeNull();
    expect(leadingTimestamp('x 2026-10-01 13:55:19')).toBeNull();
    expect(leadingTimestamp('')).toBeNull();
  });
});

describe('parseUserTime', () => {
  const ref = U(2026, 9, 1, 13, 0, 0);

  it('parses the documented shapes', () => {
    expect(parseUserTime('9:05', 'utc', ref)).toBe(U(2026, 9, 1, 9, 5));
    expect(parseUserTime('  13:55  ', 'utc', ref)).toBe(U(2026, 9, 1, 13, 55));
    expect(parseUserTime('13:55:50,25', 'utc', ref)).toBe(U(2026, 9, 1, 13, 55, 50, 250));
    expect(parseUserTime('2026-10-02T08:00:01.007', 'utc', ref)).toBe(U(2026, 9, 2, 8, 0, 1, 7));
    expect(parseUserTime('2026-10-01 15:55:50 +0200', 'utc', ref)).toBe(U(2026, 9, 1, 13, 55, 50));
    expect(parseUserTime('2026-10-01T13:55:50.884532509Z', 'utc', ref)).toBe(U(2026, 9, 1, 13, 55, 50, 884));
  });

  it('rejects what it cannot place', () => {
    expect(parseUserTime('', 'utc', ref)).toBeNull();
    expect(parseUserTime('   ', 'utc', ref)).toBeNull();
    expect(parseUserTime('13:55', 'utc', Number.NaN)).toBeNull();
    expect(parseUserTime('13:55:50.1234', 'utc', ref)).toBeNull(); // more than 3 fractional digits without a zone
    expect(parseUserTime('13:55:50Z', 'utc', ref)).toBeNull(); // a zone needs a date
    expect(parseUserTime('2026-10-01', 'utc', ref)).toBeNull(); // date only
    expect(parseUserTime('13', 'utc', ref)).toBeNull();
  });

  it('rejects out-of-range fields instead of rolling them over', () => {
    expect(parseUserTime('25:00', 'utc', ref)).toBeNull();
    expect(parseUserTime('10:99', 'utc', ref)).toBeNull();
    expect(parseUserTime('10:00:60', 'utc', ref)).toBeNull();
    expect(parseUserTime('2026-02-30 10:00', 'utc', ref)).toBeNull();
    expect(parseUserTime('23:59:59.999', 'utc', ref)).toBe(U(2026, 9, 1, 23, 59, 59, 999));
  });

  it('places a bare time on the local day of the reference in local mode', () => {
    withTZ('Asia/Tokyo', () => {
      const lateUtc = U(2026, 9, 1, 20, 0); // already Oct 2 in Tokyo
      expect(parseUserTime('06:00', 'local', lateUtc)).toBe(U(2026, 9, 1, 21, 0));
      expect(parseUserTime('06:00', 'utc', lateUtc)).toBe(U(2026, 9, 1, 6, 0));
    });
  });

  it('resolves DST gaps forward and ambiguous fall-back times to the earlier instant', () => {
    withTZ('Europe/Vilnius', () => {
      expect(parseUserTime('2026-03-29 03:30', 'local', 0)).toBe(U(2026, 2, 29, 1, 30));
      expect(parseUserTime('2026-10-25 03:30', 'local', 0)).toBe(U(2026, 9, 25, 0, 30));
    });
  });
});
