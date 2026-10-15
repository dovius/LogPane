import { mergeEntries } from '../core/merge';
import { LogParser, parseLinesChunked, splitLines } from '../core/parse';
import { SOURCE_COLORS, supportsSinceTime, withSinceTime } from '../core/sources';
import { createTailState, newLines, recordLines, type TailState } from '../core/tail';
import type { LogEntry, SourceInfo, SourceKind } from '../core/types';

export interface SourceState {
  info: SourceInfo;
  entries: LogEntry[];
  parser: LogParser;
  tail: TailState;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** HTTP status of the last failed fetch, if it was an HTTP error. */
  errorStatus?: number;
  /** The error came from LogPane's own limits (see LimitError), not from the server. */
  errorLimit?: boolean;
  /** Parse progress 0..1 while loading. */
  progress: number;
}

export interface NewSource {
  label: string;
  kind: SourceKind;
  url?: string;
}

export class HttpError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
  }
}

/** A log LogPane refuses or gives up on itself (too large, stalled, redirected away): a page reload won't help. */
export class LimitError extends Error {}

/** Larger logs are refused instead of exhausting the tab: parsed entries take several times the text. */
export const MAX_LOG_BYTES = 256 * 1024 * 1024;
export const tooLarge = () => new LimitError(`This log is larger than ${MAX_LOG_BYTES / 1024 / 1024} MB, more than LogPane can open in a browser tab.`);

/**
 * The page could not be fetched again, but a real page load would work:
 * - 401/403: consoles that accept only navigations (OpenShift);
 * - no HTTP status at all: network/CORS failure (file://, sandboxed responses) or a login page instead of the log.
 * 404 / 5xx are real answers and stay visible as errors.
 */
export const isRejected = (s: SourceState | undefined) =>
  s?.status === 'error' && !s.errorLimit && (s.errorStatus === undefined || s.errorStatus === 401 || s.errorStatus === 403);

/** Reads a log from its URL (fetchText). */
export type FetchLog = (url: string) => Promise<string>;

const canRefetch = (s: SourceState) => Boolean(s.info.url) && (s.info.kind === 'page' || s.info.kind === 'url');

/** All loaded sources and their merged entries. Components re-render on `version` changes. */
export class LogStore {
  sources: SourceState[] = [];
  entries: LogEntry[] = [];
  version = 0;
  private nextId = 1;
  private listeners = new Set<() => void>();

  /** Without fetchLog the store never touches the network: no URLs, Reload or Tail (file viewer, logpane.html). */
  constructor(private readonly fetchLog?: FetchLog) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private remerge(): void {
    this.entries = mergeEntries(this.sources.map((s) => s.entries));
  }

  source(id: number): SourceState | undefined {
    return this.sources.find((s) => s.info.id === id);
  }

  labels(): Map<number, string> {
    return new Map(this.sources.map((s) => [s.info.id, s.info.label]));
  }

  get hasRefetchable(): boolean {
    return Boolean(this.fetchLog) && this.sources.some(canRefetch);
  }

  /** The source for the page the viewer runs on (Raw log page), if any. */
  get pageSource(): SourceState | undefined {
    return this.sources.find((s) => s.info.kind === 'page');
  }

  get loading(): boolean {
    return this.sources.some((s) => s.status === 'loading');
  }

  private create(meta: NewSource): SourceState {
    const id = this.nextId++;
    const s: SourceState = {
      info: { id, label: meta.label, kind: meta.kind, url: meta.url, color: SOURCE_COLORS[(id - 1) % SOURCE_COLORS.length] },
      entries: [],
      parser: new LogParser(id),
      tail: createTailState(),
      status: 'loading',
      progress: 0,
    };
    this.sources.push(s);
    this.emit();
    return s;
  }

  private async load(s: SourceState, text: string): Promise<void> {
    s.parser = new LogParser(s.info.id);
    s.tail = createTailState();
    s.status = 'loading';
    s.progress = 0;
    const lines = splitLines(text);
    recordLines(s.tail, lines);
    s.entries = await parseLinesChunked(lines, s.parser, (done, total) => {
      s.progress = done / total;
      this.emit();
    });
    s.status = 'ready';
    s.error = undefined;
    s.errorStatus = undefined;
    s.errorLimit = undefined;
    this.remerge();
    this.emit();
  }

  private fail(s: SourceState, err: unknown): void {
    s.status = 'error';
    s.error = err instanceof Error ? err.message : String(err);
    s.errorStatus = err instanceof HttpError ? err.status : undefined;
    s.errorLimit = err instanceof LimitError;
    this.emit();
  }

  async addText(meta: NewSource, text: string): Promise<void> {
    const s = this.create(meta);
    // UTF-16 length: close enough to the byte size for this limit
    if (text.length > MAX_LOG_BYTES) return this.fail(s, tooLarge());
    await this.load(s, text);
  }

  async addFile(meta: NewSource, file: File): Promise<void> {
    const s = this.create(meta);
    if (file.size > MAX_LOG_BYTES) return this.fail(s, tooLarge());
    try {
      await this.load(s, await file.text());
    } catch (err) {
      this.fail(s, err);
    }
  }

  async addUrl(meta: NewSource & { url: string }): Promise<void> {
    const s = this.create(meta);
    try {
      if (!this.fetchLog) throw new LimitError('This viewer opens files and pasted text only.');
      await this.load(s, await this.fetchLog(meta.url));
    } catch (err) {
      this.fail(s, err);
    }
  }

  /** Forget a failed fetch (the viewer handles it differently, e.g. by reloading the page). */
  clearError(s: SourceState): void {
    if (s.status !== 'error') return;
    s.status = 'ready';
    s.error = undefined;
    s.errorStatus = undefined;
    s.errorLimit = undefined;
    this.emit();
  }

  remove(id: number): void {
    this.sources = this.sources.filter((s) => s.info.id !== id);
    this.remerge();
    this.emit();
  }

  /** Re-fetches every URL-backed source from scratch. */
  async reload(): Promise<void> {
    const fetchLog = this.fetchLog;
    if (!fetchLog) return;
    await Promise.all(
      this.sources.filter(canRefetch).map(async (s) => {
        try {
          await this.load(s, await fetchLog(s.info.url!));
        } catch (err) {
          this.fail(s, err);
        }
      }),
    );
  }

  /** Fetches only what is new since the last entry; returns the number of new entries. */
  async tail(): Promise<number> {
    const fetchLog = this.fetchLog;
    if (!fetchLog) return 0;
    let added = 0;
    await Promise.all(
      this.sources.filter((s) => canRefetch(s) && s.status !== 'loading').map(async (s) => {
        const url = s.info.url!;
        const lastMs = s.entries.length ? s.entries[s.entries.length - 1].tsMs : Number.NaN;
        const fetchUrl = supportsSinceTime(url) && !Number.isNaN(lastMs) ? withSinceTime(url, lastMs) : url;
        try {
          const fresh = newLines(s.tail, splitLines(await fetchLog(fetchUrl)));
          if (s.status === 'error') {
            s.status = 'ready';
            s.error = undefined;
            s.errorStatus = undefined;
            s.errorLimit = undefined;
          }
          if (!fresh.length) return;
          recordLines(s.tail, fresh);
          const entries = s.parser.pushLines(fresh);
          for (const e of entries) s.entries.push(e);
          added += entries.length;
        } catch (err) {
          this.fail(s, err);
        }
      }),
    );
    this.remerge();
    this.emit();
    return added;
  }
}
