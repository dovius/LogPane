import type { LogEntry } from './types';

export type TimeMode = 'utc' | 'local';

export interface ParsedTime {
  ms: number;
  /** Sub-millisecond nanoseconds, 0..999999. */
  nanos: number;
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:[.,](\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Largest epoch milliseconds a JS Date can hold. */
const MAX_DATE_MS = 8.64e15;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Rejects impossible dates instead of letting Date roll them over (Feb 30, 25:00, 10:99). */
export function validDateParts(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 60;
}

/** Splits fractional milliseconds into whole ms + nanos, carrying a rounded-up 1 000 000 ns. */
function fromMs(ms: number): ParsedTime | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  let whole = Math.floor(ms);
  let nanos = Math.round((ms - whole) * 1e6);
  if (nanos >= 1e6) {
    whole += 1;
    nanos -= 1e6;
  }
  return { ms: whole, nanos };
}

/**
 * Parses ISO-8601 timestamps with any number of fractional digits (Quarkus writes 7–9),
 * epoch numbers in s / ms / µs / ns, and `{seconds, nanos}` objects (Google Cloud style).
 * Timestamps without a zone are treated as UTC, which is what containers almost always run in.
 */
export function parseTimestamp(value: unknown): ParsedTime | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return null; // no log is written before 1970
    // ns > 1e17 ≥ µs > 1e14 ≥ ms > 1e11 ≥ s. µs / ns are split with integer maths: as fractional
    // milliseconds they would lose sub-microsecond precision.
    if (value > 1e14) {
      const per = value > 1e17 ? 1e6 : 1e3;
      const ms = Math.floor(value / per);
      return ms > MAX_DATE_MS ? null : { ms, nanos: Math.min(999_999, Math.round((value - ms * per) * (1e6 / per))) };
    }
    return fromMs(value > 1e11 ? value : value * 1000);
  }
  if (value !== null && typeof value === 'object' && typeof (value as { seconds?: unknown }).seconds === 'number') {
    const { seconds, nanos } = value as { seconds: number; nanos?: unknown };
    const n = typeof nanos === 'number' && Number.isFinite(nanos) && nanos >= 0 ? Math.floor(nanos) : 0;
    if (!Number.isInteger(seconds)) return fromMs(seconds * 1000 + n / 1e6);
    const ms = seconds * 1000 + Math.floor(n / 1e6);
    return ms < 0 || ms > MAX_DATE_MS ? null : { ms, nanos: n % 1e6 };
  }
  if (typeof value !== 'string') return null;
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  const [, date, time, frac = '', zoneRaw] = m;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, sec = 0] = time.split(':').map(Number);
  if (!validDateParts(y, mo, d, h, mi, sec)) return null;
  const fracMs = (frac + '000').slice(0, 3);
  const nanos = Number((frac.slice(3) + '000000').slice(0, 6));
  let zone = zoneRaw ? zoneRaw.toUpperCase() : 'Z';
  if (zone !== 'Z' && !zone.includes(':')) zone = zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ms = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}.${fracMs}${zone}`);
  return Number.isNaN(ms) ? null : { ms, nanos };
}

const LEADING_TS_RE = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/;

/** Timestamp at the very start of a plain-text line, e.g. `2026-10-01 13:55:19,169 INFO ...`. */
export function leadingTimestamp(line: string): string | null {
  return leadingTimestampMatch(line)?.text ?? null;
}

/** Like leadingTimestamp, plus where the prefix ends (after an optional closing bracket). */
export function leadingTimestampMatch(line: string): { text: string; end: number } | null {
  const m = LEADING_TS_RE.exec(line);
  return m ? { text: m[1], end: m[0].length } : null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function parts(ms: number, mode: TimeMode) {
  const d = new Date(ms);
  return mode === 'utc'
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() }
    : { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds() };
}

/** Compact time for the list column: `13:55:50.884`, optionally prefixed with `10-01 `. */
export function formatTime(ms: number, mode: TimeMode, withDate = false): string {
  if (Number.isNaN(ms)) return '';
  const p = parts(ms, mode);
  const time = `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(p.ms, 3)}`;
  return withDate ? `${pad(p.mo)}-${pad(p.d)} ${time}` : time;
}

/** Full timestamp with sub-millisecond digits and zone, for details and exports. */
export function formatFull(ms: number, nanos: number, mode: TimeMode): string {
  if (Number.isNaN(ms)) return '';
  const p = parts(ms, mode);
  const frac = `${pad(p.ms, 3)}${nanos ? pad(nanos, 6).replace(/0+$/, '') : ''}`;
  let zone = 'Z';
  if (mode === 'local') {
    const off = -new Date(ms).getTimezoneOffset();
    zone = `${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  }
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${frac}${zone}`;
}

export function dayKey(ms: number, mode: TimeMode): string {
  if (Number.isNaN(ms)) return '';
  const p = parts(ms, mode);
  return `${p.y}-${p.mo}-${p.d}`;
}

/**
 * Parses user input for the from/to filter, in the current display mode.
 * Accepts full ISO timestamps, `YYYY-MM-DD HH:mm[:ss[.SSS]]`, or a bare `HH:mm[:ss[.SSS]]`
 * which is placed on the day of `referenceMs` (the first log entry).
 */
export function parseUserTime(input: string, mode: TimeMode, referenceMs: number): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return parseTimestamp(s)?.ms ?? null;
  const m = /^(?:(\d{4})-(\d{2})-(\d{2})[T ])?(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?$/.exec(s);
  if (!m) return null;
  let y: number, mo: number, d: number;
  if (m[1]) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    if (Number.isNaN(referenceMs)) return null;
    const p = parts(referenceMs, mode);
    [y, mo, d] = [p.y, p.mo, p.d];
  }
  const [h, mi, sec, frac] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Number((m[7] ?? '0').padEnd(3, '0'))];
  if (!validDateParts(y, mo, d, h, mi, sec) || sec > 59) return null;
  const ms = mode === 'utc'
    ? Date.UTC(y, mo - 1, d, h, mi, sec, frac)
    : new Date(y, mo - 1, d, h, mi, sec, frac).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Orders entries by time; ties keep source order (sequence, then line number). */
export function compareEntries(a: LogEntry, b: LogEntry): number {
  const aNaN = Number.isNaN(a.tsMs);
  const bNaN = Number.isNaN(b.tsMs);
  if (aNaN !== bNaN) return aNaN ? 1 : -1;
  if (!aNaN && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
  if (a.tsNanos !== b.tsNanos) return a.tsNanos - b.tsNanos;
  if (a.sourceId !== b.sourceId) return a.sourceId - b.sourceId;
  if (!Number.isNaN(a.seq) && !Number.isNaN(b.seq) && a.seq !== b.seq) return a.seq - b.seq;
  return a.lineNo - b.lineNo;
}
