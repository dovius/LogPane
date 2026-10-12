import { formatException } from './stacktrace';
import { formatFull, type TimeMode } from './time';
import type { LogEntry } from './types';

export function stackTraceOf(e: LogEntry): string {
  if (e.exception) return formatException(e.exception);
  return e.stackText ?? '';
}

/** One human-readable block per entry: `<time> LEVEL [logger] (thread) message` plus the stack trace. */
export function entryToText(e: LogEntry, mode: TimeMode, sourceLabel?: string): string {
  if (!e.json) return sourceLabel ? `[${sourceLabel}] ${e.raw}` : e.raw;
  const head = [
    sourceLabel ? `[${sourceLabel}]` : '',
    e.tsInherited ? e.tsText ?? '' : formatFull(e.tsMs, e.tsNanos, mode),
    e.level.padEnd(5),
    e.logger ? `[${e.logger}]` : '',
    e.thread ? `(${e.thread})` : '',
    e.traceId ? `{traceId=${e.traceId}}` : '',
    e.message,
  ].filter(Boolean).join(' ');
  const stack = stackTraceOf(e);
  return stack ? `${head}\n${stack}` : head;
}

export function entriesToText(entries: readonly LogEntry[], mode: TimeMode, labels?: ReadonlyMap<number, string>): string {
  return entries.map((e) => entryToText(e, mode, labels?.get(e.sourceId))).join('\n');
}

export function entriesToNdjson(entries: readonly LogEntry[]): string {
  return entries.map((e) => e.raw).join('\n');
}

/** Inclusive-exclusive window of `n` entries on each side of `index`. */
export function contextRange(total: number, index: number, n: number): [number, number] {
  return [Math.max(0, index - n), Math.min(total, index + n + 1)];
}
