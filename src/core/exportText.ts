import { formatException } from './stacktrace';
import { formatFull, formatTime, type TimeMode } from './time';
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

export interface RowColumns {
  timeMode: TimeMode;
  withDate: boolean;
  /** Source label when the source column is shown. */
  source?: string;
  logger: boolean;
  thread: boolean;
}

/**
 * The list row as cells: the visible columns in their order, but with full values (whole logger name,
 * untruncated message, no badges). Used when rows are selected and copied. Tabs become spaces (a tab
 * would break the alignment), and only the last cell, the message, may span several lines.
 */
export function entryToCells(e: LogEntry, cols: RowColumns): string[] {
  const parts = [formatTime(e.tsMs, cols.timeMode, cols.withDate), e.level === 'OTHER' ? '' : e.level];
  if (cols.source !== undefined) parts.push(cols.source);
  if (cols.logger) parts.push(e.logger);
  if (cols.thread) parts.push(e.thread);
  const cells = parts.map((p) => p.replace(/[\t\r\n]+/g, ' '));
  cells.push(e.message.replace(/\t/g, '    '));
  return cells;
}

/** Columns wider than this are not padded further (a very long logger name would push everything far right). */
const MAX_PAD = 60;

/**
 * Rows as plain text with the columns lined up by spaces, two between columns, so they stay aligned in any
 * editor with a fixed-width font (tab stops don't: a long logger name skips one). The last column is not
 * padded; its further lines (a stack trace) are indented under its start.
 */
export function alignRows(rows: readonly string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length - 1; i++) widths[i] = Math.max(widths[i] ?? 0, Math.min(row[i].length, MAX_PAD));
  }
  return rows
    .map((row) => {
      let head = '';
      for (let i = 0; i < row.length - 1; i++) head += row[i].length >= widths[i] ? `${row[i]}  ` : `${row[i].padEnd(widths[i])}  `;
      const [first, ...more] = (row[row.length - 1] ?? '').split('\n');
      const indent = ' '.repeat(head.length);
      return [`${head}${first}`.trimEnd(), ...more.map((l) => `${indent}${l}`.trimEnd())].join('\n');
    })
    .join('\n');
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The same rows as an HTML table, for spreadsheets and rich-text editors (one cell per column). */
export function rowsToHtml(rows: readonly string[][]): string {
  const td = (c: string) => `<td style="padding:0 12px 0 0;vertical-align:top;white-space:pre">${escapeHtml(c)}</td>`;
  return `<table style="border-collapse:collapse;font-family:monospace">${rows.map((r) => `<tr>${r.map(td).join('')}</tr>`).join('')}</table>`;
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
