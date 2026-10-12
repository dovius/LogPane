import type { JsonObject, Level } from './types';

/**
 * Field names used by common JSON log formats, in priority order.
 * Quarkus/JBoss first, then logstash-logback-encoder, ECS, GELF (Spring Boot structured logging),
 * pino/bunyan/winston and others.
 * Dotted names match both a literal key ("log.level") and a nested path ({log: {level}}).
 */
export const FIELD_ALIASES = {
  timestamp: ['timestamp', '@timestamp', 'time', 'ts', 'date', 'datetime'],
  level: ['level', 'log.level', 'severity', 'levelname', 'loglevel', 'lvl'],
  logger: ['loggerName', 'logger_name', 'logger', 'log.logger', 'category', '_log_logger', '_logger_name'],
  message: ['message', 'msg', '@message', 'short_message', 'log'],
  thread: ['threadName', 'thread_name', 'thread', 'process.thread.name', '_process_thread_name', '_thread_name'],
  /** Trace IDs first, then correlation / request IDs: all of them link related entries. */
  traceId: [
    'mdc.traceId', 'traceId', 'trace_id', 'trace.id', 'mdc.trace_id', 'dd.trace_id',
    'mdc.correlationId', 'correlationId', 'correlation_id', 'mdc.correlation_id', 'correlation.id',
    'mdc.requestId', 'requestId', 'request_id', 'mdc.request_id', 'reqId', 'x-request-id',
  ],
  spanId: ['mdc.spanId', 'spanId', 'span_id', 'span.id', 'mdc.span_id', 'dd.span_id'],
  sequence: ['sequence', 'seq'],
  stackText: ['stack_trace', 'stackTrace', 'error.stack_trace', 'exception.stacktrace', 'err.stack', 'stack', '_error_stack_trace'],
} as const;

/** Top-level keys that carry no useful search signal (identical on every line or already indexed). */
export const BOILERPLATE_KEYS = new Set([
  'timestamp', '@timestamp', 'time', 'ts', 'sequence', 'loggerClassName', 'hostName', 'host', 'hostname',
  'processName', 'processId', 'pid', 'threadId', 'level', 'severity', '@version', 'level_value', 'ndc',
  'version', '_level_name', '_process_pid', 'stream', 'v',
]);

export function getPath(obj: JsonObject, path: string): unknown {
  if (path in obj) return obj[path];
  if (!path.includes('.')) return undefined;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as JsonObject)[part];
  }
  return cur;
}

export function pick(obj: JsonObject, aliases: readonly string[]): unknown {
  for (const name of aliases) {
    const v = getPath(obj, name);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function pickString(obj: JsonObject, aliases: readonly string[]): string {
  const v = pick(obj, aliases);
  if (v === undefined) return '';
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const LEVEL_NAMES: Record<string, Level> = {
  FATAL: 'FATAL', CRITICAL: 'FATAL', CRIT: 'FATAL', EMERG: 'FATAL', EMERGENCY: 'FATAL', ALERT: 'FATAL', PANIC: 'FATAL',
  ERROR: 'ERROR', ERR: 'ERROR', SEVERE: 'ERROR',
  WARN: 'WARN', WARNING: 'WARN',
  INFO: 'INFO', INFORMATION: 'INFO', NOTICE: 'INFO', CONFIG: 'INFO',
  DEBUG: 'DEBUG', DBG: 'DEBUG', FINE: 'DEBUG',
  TRACE: 'TRACE', FINER: 'TRACE', FINEST: 'TRACE', ALL: 'TRACE', VERBOSE: 'TRACE',
};

export function normalizeLevel(value: unknown): Level {
  if (typeof value === 'number') {
    // pino / bunyan numeric levels
    if (value >= 60) return 'FATAL';
    if (value >= 50) return 'ERROR';
    if (value >= 40) return 'WARN';
    if (value >= 30) return 'INFO';
    if (value >= 20) return 'DEBUG';
    return 'TRACE';
  }
  if (typeof value !== 'string') return 'OTHER';
  return LEVEL_NAMES[value.trim().toUpperCase()] ?? 'OTHER';
}

/** GELF (and syslog) severities: 0 emergency … 7 debug. */
export function syslogLevel(value: unknown): Level {
  const n = Number(value);
  if (!Number.isFinite(n)) return normalizeLevel(value);
  if (n <= 2) return 'FATAL';
  if (n === 3) return 'ERROR';
  if (n === 4) return 'WARN';
  if (n <= 6) return 'INFO';
  return 'DEBUG';
}

export function isGelf(obj: JsonObject): boolean {
  return typeof obj.short_message === 'string' && (obj.version === '1.1' || 'host' in obj);
}

const PLAIN_LEVEL_RE = /\b(FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\b/;

/** Best-effort level detection for plain-text lines. */
export function detectPlainLevel(line: string): Level {
  const m = PLAIN_LEVEL_RE.exec(line.slice(0, 200));
  return m ? normalizeLevel(m[1]) : 'OTHER';
}

/** Collects lower-cased string values of an object (one level of nesting is enough for MDC-like maps). */
export function collectValues(value: unknown, out: string[], depth = 0): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value) out.push(value);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
  } else if (typeof value === 'object' && depth < 3) {
    for (const v of Array.isArray(value) ? value : Object.values(value)) collectValues(v, out, depth + 1);
  }
}
