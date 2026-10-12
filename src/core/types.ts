export type Level = 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE' | 'OTHER';

/** Display order, most severe first. */
export const LEVELS: readonly Level[] = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'OTHER'];

export type LevelCounts = Record<Level, number>;

export function emptyLevelCounts(): LevelCounts {
  return { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0, OTHER: 0 };
}

export type JsonObject = Record<string, unknown>;

export interface LogEntry {
  sourceId: number;
  /** 1-based line number of the (first) physical line in its source. */
  lineNo: number;
  /** Original text; physical lines joined with "\n" for multi-line plain-text entries. */
  raw: string;
  /** Parsed object for JSON lines, undefined for plain-text lines. */
  json?: JsonObject;
  /** Timestamp as written in the log, if any. */
  tsText?: string;
  /** Epoch milliseconds, NaN when unknown. */
  tsMs: number;
  /** Sub-millisecond part in nanoseconds (0..999999), used for ordering. */
  tsNanos: number;
  /** True when the timestamp was copied from the previous entry (plain-text lines). */
  tsInherited: boolean;
  /** `sequence` field when present, NaN otherwise. */
  seq: number;
  level: Level;
  logger: string;
  thread: string;
  message: string;
  traceId: string;
  spanId: string;
  /** Structured exception object (Quarkus JSON format) when present. */
  exception?: JsonObject;
  /** Plain stack trace string (logstash / ECS style) when present. */
  stackText?: string;
  /** Lower-cased text used for case-insensitive search. */
  haystack: string;
}

export type SourceKind = 'page' | 'url' | 'file' | 'paste';

export interface SourceInfo {
  id: number;
  label: string;
  kind: SourceKind;
  /** Where the text can be fetched again (page and url sources). */
  url?: string;
  color: string;
}
