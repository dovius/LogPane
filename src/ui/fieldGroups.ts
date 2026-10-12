import { FIELD_ALIASES } from '../core/fields';
import type { JsonObject, LogEntry } from '../core/types';

export type FieldAction = 'trace' | 'search';

export interface FieldRow {
  /** Dotted path, unique within the entry (`context.request.method`, `mdc.userId`). */
  key: string;
  /** What the row shows as its name. */
  label: string;
  value: unknown;
  action?: FieldAction;
}

export interface FieldGroups {
  /** Trace / span / correlation identifiers (from MDC or top-level fields). */
  trace: FieldRow[];
  /** MDC values and the application's own fields, nested objects flattened to dotted keys. */
  context: FieldRow[];
  /** Host / process / framework bookkeeping, shown last. */
  process: FieldRow[];
}

/** Fields rendered elsewhere in the panel (message, level, logger, …). */
const SHOWN_ELSEWHERE = new Set<string>([
  ...FIELD_ALIASES.timestamp, ...FIELD_ALIASES.level, ...FIELD_ALIASES.logger, ...FIELD_ALIASES.message,
  ...FIELD_ALIASES.thread, ...FIELD_ALIASES.sequence, ...FIELD_ALIASES.stackText, 'mdc', 'exception', '_level_name',
]);

const TRACE_KEY_RE = /^(?:trace[_.]?id|span[_.]?id|parent[_.]?(?:span[_.]?)?id|sampled|correlation[_.]?id|request[_.]?id|x-request-id|reqId|dd\.(?:trace|span)_id)$/i;

const PROCESS_KEYS = new Set([
  'hostName', 'host', 'hostname', 'processName', 'processId', 'pid', 'threadId', 'loggerClassName', '@version',
  'level_value', 'ndc', 'version', 'v', 'process.pid', 'host.name', 'ecs.version', 'log.origin.file.name', 'log.origin.file.line',
]);

const MAX_DEPTH = 4;

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEmpty(v: unknown): boolean {
  if (v === '' || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && Object.keys(v).length === 0;
}

/** `{a: {b: 1, c: [1, 2]}}` → `a.b = 1`, `a.c = [1, 2]`; objects deeper than MAX_DEPTH stay as one value. */
function flatten(prefix: string, value: unknown, depth: number, out: [string, unknown][]): void {
  if (isPlainObject(value) && depth < MAX_DEPTH && Object.keys(value).length) {
    for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, v, depth + 1, out);
  } else {
    out.push([prefix, value]);
  }
}

function row(key: string, label: string, value: unknown, traceId: string): FieldRow {
  if (value === traceId && typeof value === 'string' && value) return { key, label, value, action: 'trace' };
  if (typeof value === 'string' && value.length >= 3) return { key, label, value, action: 'search' };
  if (typeof value === 'number') return { key, label, value, action: 'search' };
  return { key, label, value };
}

export function groupFields(e: LogEntry): FieldGroups {
  const groups: FieldGroups = { trace: [], context: [], process: [] };
  const json = e.json;
  if (!json) return groups;

  const mdc = isPlainObject(json.mdc) ? json.mdc : undefined;
  const topKeys = new Set(Object.keys(json));
  for (const [k, v] of mdc ? Object.entries(mdc) : []) {
    if (isEmpty(v)) continue;
    const key = `mdc.${k}`;
    // MDC keys are shown without the prefix unless a top-level field has the same name
    const label = topKeys.has(k) ? key : k;
    if (TRACE_KEY_RE.test(k)) groups.trace.push(row(key, label, v, e.traceId));
    else if (isPlainObject(v)) {
      const flat: [string, unknown][] = [];
      flatten(label, v, 1, flat);
      for (const [fk, fv] of flat) if (!isEmpty(fv)) groups.context.push(row(`mdc.${fk}`, fk, fv, e.traceId));
    } else groups.context.push(row(key, label, v, e.traceId));
  }

  const flat: [string, unknown][] = [];
  for (const [k, v] of Object.entries(json)) {
    if (SHOWN_ELSEWHERE.has(k)) continue;
    flatten(k, v, 0, flat);
  }
  for (const [k, v] of flat) {
    if (isEmpty(v)) continue;
    const last = k.slice(k.lastIndexOf('.') + 1);
    // a nested id is named by its own key (`x-request-id`, not `context.request.headers.x-request-id`)
    if (TRACE_KEY_RE.test(last)) groups.trace.push(row(k, last, v, e.traceId));
    else if (TRACE_KEY_RE.test(k)) groups.trace.push(row(k, k, v, e.traceId));
    else if (PROCESS_KEYS.has(k)) groups.process.push(row(k, k, v, e.traceId));
    else groups.context.push(row(k, k, v, e.traceId));
  }

  // The same id can be both in MDC and at the top level: show it once.
  const seen = new Set<string>();
  groups.trace = groups.trace.filter((r) => {
    const id = `${r.label.replace(/^mdc\./, '').replace(/[_.]/g, '').toLowerCase()}=${String(r.value)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return groups;
}

/** Splits a folded plain-text entry into its first line and the stack trace below it, if it has one. */
export function splitPlainStack(raw: string): { message: string; stack: string } | null {
  const nl = raw.indexOf('\n');
  if (nl < 0) return null;
  const rest = raw.slice(nl + 1);
  if (!/^\s*at |^Caused by:|^[\w$.]+(?:Exception|Error|Throwable)\b|^\s*\.\.\. \d+/m.test(rest)) return null;
  return { message: raw.slice(0, nl), stack: rest };
}

export type FieldItem = { kind: 'group'; path: string } | { kind: 'row'; row: FieldRow; name: string; nested: boolean };

/**
 * Lays out flattened rows for display: consecutive rows under the same parent object get one group
 * heading (`context.request`) and show only the rest of their path (`method`, `headers.user-agent`).
 * A lone nested value keeps its full dotted name.
 */
export function layoutRows(rows: FieldRow[]): FieldItem[] {
  const items: FieldItem[] = [];
  let group = '';
  rows.forEach((row, i) => {
    const label = row.label;
    if (group && label.startsWith(`${group}.`)) {
      items.push({ kind: 'row', row, name: label.slice(group.length + 1), nested: true });
      return;
    }
    const parent = label.slice(0, Math.max(0, label.lastIndexOf('.')));
    if (parent && rows[i + 1]?.label.startsWith(`${parent}.`)) {
      group = parent;
      items.push({ kind: 'group', path: parent }, { kind: 'row', row, name: label.slice(parent.length + 1), nested: true });
      return;
    }
    group = '';
    items.push({ kind: 'row', row, name: label, nested: false });
  });
  return items;
}

/** Width of the name column in characters, the same for every field list in the panel so values line up. */
export function nameColumnWidth(lists: FieldItem[][], extra: string[] = [], min = 8, max = 22): number {
  let w = min;
  for (const items of lists) for (const it of items) if (it.kind === 'row') w = Math.max(w, it.name.length + (it.nested ? 2 : 0));
  for (const name of extra) w = Math.max(w, name.length);
  return Math.min(w, max);
}
