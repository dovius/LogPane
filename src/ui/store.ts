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

/**
 * The page could not be fetched again, but a real page load would work:
 * - 401/403: consoles that accept only navigations (OpenShift);
 * - no HTTP status at all: network/CORS failure (file://, sandboxed responses) or a login page instead of the log.
 * 404 / 5xx are real answers and stay visible as errors.
 */
export const isRejected = (s: SourceState | undefined) =>
  s?.status === 'error' && (s.errorStatus === undefined || s.errorStatus === 401 || s.errorStatus === 403);

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new HttpError(res.status, res.statusText);
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error('Got an HTML page instead of a log. Is the console session still valid?');
  }
  return res.text();
}

const canRefetch = (s: SourceState) => Boolean(s.info.url) && (s.info.kind === 'page' || s.info.kind === 'url');

/** All loaded sources and their merged entries. Components re-render on `version` changes. */
export class LogStore {
  sources: SourceState[] = [];
  entries: LogEntry[] = [];
  version = 0;
  private nextId = 1;
  private listeners = new Set<() => void>();

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
    return this.sources.some(canRefetch);
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
    this.remerge();
    this.emit();
  }

  private fail(s: SourceState, err: unknown): void {
    s.status = 'error';
    s.error = err instanceof Error ? err.message : String(err);
    s.errorStatus = err instanceof HttpError ? err.status : undefined;
    this.emit();
  }

  async addText(meta: NewSource, text: string): Promise<void> {
    await this.load(this.create(meta), text);
  }

  async addUrl(meta: NewSource & { url: string }): Promise<void> {
    const s = this.create(meta);
    try {
      await this.load(s, await fetchText(meta.url));
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
    this.emit();
  }

  remove(id: number): void {
    this.sources = this.sources.filter((s) => s.info.id !== id);
    this.remerge();
    this.emit();
  }

  /** Re-fetches every URL-backed source from scratch. */
  async reload(): Promise<void> {
    await Promise.all(
      this.sources.filter(canRefetch).map(async (s) => {
        try {
          await this.load(s, await fetchText(s.info.url!));
        } catch (err) {
          this.fail(s, err);
        }
      }),
    );
  }

  /** Fetches only what is new since the last entry; returns the number of new entries. */
  async tail(): Promise<number> {
    let added = 0;
    await Promise.all(
      this.sources.filter((s) => canRefetch(s) && s.status !== 'loading').map(async (s) => {
        const url = s.info.url!;
        const lastMs = s.entries.length ? s.entries[s.entries.length - 1].tsMs : Number.NaN;
        const fetchUrl = supportsSinceTime(url) && !Number.isNaN(lastMs) ? withSinceTime(url, lastMs) : url;
        try {
          const fresh = newLines(s.tail, splitLines(await fetchText(fetchUrl)));
          if (s.status === 'error') {
            s.status = 'ready';
            s.error = undefined;
            s.errorStatus = undefined;
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
