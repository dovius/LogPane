import type { JsonObject } from './types';

/*
 * Quarkus JSON logging writes exceptions as:
 *   { refId, exceptionType, message, frames: [{class, method, line}], causedBy: { exception: {...} }, suppressed: [...] }
 * A bare { refId } is a back-reference to an exception already printed (circular cause chain).
 */

const MAX_DEPTH = 50;

export interface ExceptionLink {
  type: string;
  message: string;
}

function asObject(v: unknown): JsonObject | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined;
}

/** `causedBy` is `{exception: {...}}` in Quarkus; accept a direct exception object too. */
function unwrap(v: unknown): JsonObject | undefined {
  const o = asObject(v);
  if (!o) return undefined;
  return asObject(o.exception) ?? o;
}

function typeOf(e: JsonObject): string {
  const t = e.exceptionType ?? e.type ?? e.class ?? e.className;
  return typeof t === 'string' ? t : '';
}

function header(e: JsonObject): string {
  const type = typeOf(e) || 'Exception';
  const msg = typeof e.message === 'string' ? e.message : e.message == null ? '' : JSON.stringify(e.message);
  return msg ? `${type}: ${msg}` : type;
}

/** `com.acme.Outer$Inner` → `Outer.java`; the JSON format does not carry file names. */
export function fileNameForClass(cls: string): string {
  const simple = cls.slice(cls.lastIndexOf('.') + 1).split('$')[0];
  return `${simple || cls}.java`;
}

export function formatFrame(frame: unknown): string {
  const f = asObject(frame);
  if (!f) return `at ${String(frame)}`;
  const cls = typeof f.class === 'string' ? f.class : typeof f.className === 'string' ? f.className : '?';
  const method = typeof f.method === 'string' ? f.method : '?';
  const line = typeof f.line === 'number' ? f.line : Number.NaN;
  let location: string;
  if (line === -2) location = 'Native Method';
  else if (Number.isNaN(line) || line < 0) location = 'Unknown Source';
  else location = `${typeof f.file === 'string' ? f.file : fileNameForClass(cls)}:${line}`;
  return `at ${cls}.${method}(${location})`;
}

function isBackReference(e: JsonObject): boolean {
  return e.refId !== undefined && !typeOf(e) && e.message === undefined && e.frames === undefined;
}

function appendException(out: string[], e: JsonObject, prefix: string, indent: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    out.push(`${indent}${prefix}[... cause chain truncated]`);
    return;
  }
  if (isBackReference(e)) {
    out.push(`${indent}${prefix}[CIRCULAR REFERENCE: refId=${String(e.refId)}]`);
    return;
  }
  out.push(`${indent}${prefix}${header(e)}`);
  const frames = Array.isArray(e.frames) ? e.frames : [];
  for (const f of frames) out.push(`${indent}\t${formatFrame(f)}`);
  if (Array.isArray(e.suppressed)) {
    for (const s of e.suppressed) {
      const se = unwrap(s);
      if (se) appendException(out, se, 'Suppressed: ', `${indent}\t`, depth + 1);
    }
  }
  const cause = unwrap(e.causedBy ?? e.cause);
  if (cause) appendException(out, cause, 'Caused by: ', indent, depth + 1);
}

/** Renders a structured exception as a regular Java stack trace (pasteable into IDE "Analyze Stack Trace"). */
export function formatException(exception: unknown): string {
  const e = unwrap(exception);
  if (!e) return typeof exception === 'string' ? exception : '';
  const out: string[] = [];
  appendException(out, e, '', '', 0);
  return out.join('\n');
}

/** Exception types and messages along the cause chain, outermost first. */
export function exceptionChain(exception: unknown): ExceptionLink[] {
  const chain: ExceptionLink[] = [];
  let e = unwrap(exception);
  while (e && chain.length <= MAX_DEPTH && !isBackReference(e)) {
    chain.push({ type: typeOf(e), message: typeof e.message === 'string' ? e.message : '' });
    e = unwrap(e.causedBy ?? e.cause);
  }
  return chain;
}

export function frameCount(exception: unknown): number {
  let n = 0;
  let e = unwrap(exception);
  for (let depth = 0; e && depth <= MAX_DEPTH; depth++) {
    if (Array.isArray(e.frames)) n += e.frames.length;
    e = unwrap(e.causedBy ?? e.cause);
  }
  return n;
}
