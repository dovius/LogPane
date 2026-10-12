import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { contextRange, entriesToNdjson, entriesToText, entryToText, stackTraceOf } from '../core/exportText';
import { EMPTY_FILTER, applyFilter, isFilterActive, type FilterState } from '../core/filter';
import { labelForFileName, labelForUrl, toRawLogUrl } from '../core/sources';
import { dayKey } from '../core/time';
import { LEVELS, type Level, type LogEntry } from '../core/types';
import { AddSourceDialog } from './AddSourceDialog';
import { copyText, downloadText } from './clipboard';
import { DetailsPanel, type CopyWhat } from './DetailsPanel';
import { pluralize } from './format';
import { ColumnHeader, LogList, gridTemplate, type ListApi } from './LogList';
import { saveSettings, type Settings } from './settings';
import { isRejected, type LogStore } from './store';
import { RELOAD_TAIL_MIN_SECONDS, type ViewState } from './viewState';
import { FilterBar, Header } from './Toolbar';

/** Suggestion shown after a manual open on a Raw log page: open these automatically from now on. */
export interface AutoPrompt {
  host: string;
  onEnable: () => void;
  onDismiss: () => void;
}

export interface AppProps {
  store: LogStore;
  mode: 'page' | 'standalone';
  initialSettings: Settings;
  /** Raw URLs can be fetched (same origin as the page). */
  canFetchUrls: boolean;
  /** Resolves pasted relative URLs; also the only origin URLs may come from. */
  baseUrl?: string;
  onShowRaw?: () => void;
  onAutoOpen?: () => void;
  autoPrompt?: AutoPrompt;
  /** Restored after the page was reloaded by Reload / Tail. */
  initialView?: ViewState;
  /** Reload the page itself (like F5), for consoles that reject the viewer's own requests. */
  reloadPage?: (state: ViewState) => void;
}

function useStoreVersion(store: LogStore): number {
  const [version, setVersion] = useState(store.version);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setVersion(store.version));
    setVersion(store.version); // catch up on changes made before the first effect ran
    return unsubscribe;
  }, [store]);
  return version;
}

function positionOf(indices: readonly number[], entries: readonly LogEntry[], target: LogEntry | null): number {
  if (!target) return -1;
  for (let p = 0; p < indices.length; p++) if (entries[indices[p]] === target) return p;
  return -1;
}

function isField(t: EventTarget | null): t is HTMLElement {
  const el = t as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}

export function App(props: AppProps) {
  const { store } = props;
  const version = useStoreVersion(store);
  const entries = store.entries;

  const [settings, setSettings] = useState(props.initialSettings);
  const updateSettings = (patch: Partial<Settings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  const [detailsWidth, setDetailsWidth] = useState(settings.detailsWidth);

  const [query, setQuery] = useState(props.initialView?.query ?? '');
  const [filter, setFilter] = useState<FilterState>(props.initialView?.filter ?? EMPTY_FILTER);
  const patchFilter = (patch: Partial<FilterState>) => setFilter((f) => ({ ...f, ...patch }));
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.text === query ? f : { ...f, text: query })), 150);
    return () => clearTimeout(t);
  }, [query]);

  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [flash, setFlash] = useState<LogEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tailSeconds, setTailSeconds] = useState(props.initialView?.tailSeconds ?? 0);
  /** The console rejected a tail request, so Tail reloads the page instead. */
  const [tailByReload, setTailByReload] = useState(props.initialView?.tailByReload ?? false);
  const restoreView = useRef(props.initialView);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(Boolean(props.autoPrompt));
  const [scrollNonce, setScrollNonce] = useState(0);
  const listApi = useRef<ListApi>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ entry: LogEntry; align: 'nearest' | 'center' } | null>(null);
  const toastTimer = useRef<number>();

  const result = useMemo(() => applyFilter(entries, filter), [entries, filter]);
  const { indices } = result;
  const sources = useMemo(() => new Map(store.sources.map((s) => [s.info.id, s.info])), [version]);
  const multiSource = store.sources.length > 1;
  const cols = { source: multiSource, logger: settings.showLogger, thread: settings.showThread };
  const loggers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.logger, (counts.get(e.logger) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [entries]);
  const [firstMs, lastMs] = useMemo(() => {
    const first = entries.find((e) => !Number.isNaN(e.tsMs));
    let last: LogEntry | undefined;
    for (let i = entries.length - 1; i >= 0 && !last; i--) if (!Number.isNaN(entries[i].tsMs)) last = entries[i];
    return [first?.tsMs ?? Number.NaN, last?.tsMs ?? Number.NaN];
  }, [entries]);
  const withDate = !Number.isNaN(firstMs) && dayKey(firstMs, settings.timeMode) !== dayKey(lastMs, settings.timeMode);
  const selectedPos = useMemo(() => positionOf(indices, entries, selected), [indices, entries, selected]);
  const rowHeight = Math.round(settings.fontSize * 1.7);

  const showToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };

  const scrollTo = (entry: LogEntry, align: 'nearest' | 'center') => {
    pendingScroll.current = { entry, align };
    setScrollNonce((n) => n + 1);
  };

  useEffect(() => {
    const p = pendingScroll.current;
    if (!p) return;
    pendingScroll.current = null;
    listApi.current?.scrollToPos(positionOf(indices, entries, p.entry), p.align);
  }, [result, scrollNonce]);

  // After a reload entries are new objects: keep the same line selected.
  useEffect(() => {
    if (selected && !entries.includes(selected)) {
      setSelected(entries.find((e) => e.sourceId === selected.sourceId && e.lineNo === selected.lineNo) ?? null);
    }
  }, [entries]);

  // After the page was reloaded by Reload / Tail: bring back the selection and scroll position.
  useEffect(() => {
    const view = restoreView.current;
    if (!view || !entries.length || store.loading) return;
    restoreView.current = undefined;
    const pageId = store.pageSource?.info.id;
    if (view.selectedLine !== undefined) {
      const e = entries.find((x) => x.sourceId === pageId && x.lineNo === view.selectedLine);
      if (e) setSelected(e);
    }
    if (!view.atBottom) requestAnimationFrame(() => listApi.current?.setScrollTop(view.scrollTop));
  }, [entries]);

  const viewState = (): ViewState => {
    const pageId = store.pageSource?.info.id;
    const scroll = listApi.current?.scrollState() ?? { top: 0, atBottom: true };
    return {
      query,
      filter: { ...filter, text: query, hiddenSources: [] },
      selectedLine: selected && selected.sourceId === pageId ? selected.lineNo : undefined,
      scrollTop: scroll.top,
      atBottom: scroll.atBottom,
      tailSeconds,
      tailByReload,
    };
  };
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const otherSourcesWarning = 'Reloading the page removes the other logs you added. Continue?';

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!tailSeconds) return;
    const reloadPage = props.reloadPage;
    if (tailByReload) {
      if (!reloadPage) return;
      // Reload once the interval has passed and the tab is visible.
      const due = Date.now() + Math.max(RELOAD_TAIL_MIN_SECONDS, tailSeconds) * 1000;
      const id = setInterval(() => {
        if (Date.now() >= due && !document.hidden && !store.loading) {
          clearInterval(id);
          reloadPage(viewStateRef.current());
        }
      }, 500);
      return () => clearInterval(id);
    }
    let running = false;
    const id = setInterval(async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        await store.tail();
        if (isRejected(store.pageSource) && reloadPage) {
          if (store.sources.length > 1) {
            setTailSeconds(0);
            showToast('This console rejects LogPane requests: Tail works here with a single log only');
          } else {
            store.clearError(store.pageSource!);
            setTailByReload(true);
            showToast(`This console rejects LogPane requests, so Tail reloads the page every ${Math.max(RELOAD_TAIL_MIN_SECONDS, tailSeconds)} s`);
          }
        }
      } finally {
        running = false;
      }
    }, tailSeconds * 1000);
    return () => clearInterval(id);
  }, [tailSeconds, tailByReload, store]);

  const selectPos = (pos: number, align: 'nearest' | 'center' = 'nearest') => {
    if (pos < 0 || pos >= indices.length) return;
    const e = entries[indices[pos]];
    setSelected(e);
    scrollTo(e, align);
  };

  const move = (delta: number) => {
    if (!indices.length) return;
    if (selectedPos < 0) {
      const [first, last] = listApi.current?.visibleRange() ?? [0, indices.length - 1];
      selectPos(delta > 0 ? first : last);
    } else {
      selectPos(Math.max(0, Math.min(indices.length - 1, selectedPos + delta)));
    }
  };

  const jump = (kind: 'error' | 'warn', dir: 1 | -1) => {
    const match = kind === 'error' ? (l: Level) => l === 'ERROR' || l === 'FATAL' : (l: Level) => l === 'WARN';
    let pos = selectedPos;
    if (pos < 0) {
      const [first, last] = listApi.current?.visibleRange() ?? [0, indices.length - 1];
      pos = dir > 0 ? first - 1 : last + 1;
    }
    for (pos += dir; pos >= 0 && pos < indices.length; pos += dir) {
      if (match(entries[indices[pos]].level)) {
        selectPos(pos, 'center');
        return;
      }
    }
    showToast(`No ${dir > 0 ? 'next' : 'previous'} ${kind === 'error' ? 'error' : 'warning'}`);
  };

  const onLevelClick = (level: Level, multi: boolean) =>
    setFilter((f) => {
      if (!multi) return { ...f, levels: f.levels.length === 1 && f.levels[0] === level ? [] : [level] };
      const base = f.levels.length ? f.levels : LEVELS.filter((l) => result.counts[l] > 0);
      const levels = base.includes(level) ? base.filter((l) => l !== level) : [...base, level];
      return { ...f, levels: levels.length === LEVELS.filter((l) => result.counts[l] > 0).length ? [] : levels };
    });

  const labels = () => (multiSource ? store.labels() : undefined);
  const copy = async (text: string, what: string) => showToast((await copyText(text)) ? `Copied ${what}` : 'Copy failed');

  const onCopy = (what: CopyWhat, e = selected) => {
    if (!e) return;
    const label = multiSource ? sources.get(e.sourceId)?.label : undefined;
    if (what === 'entry') void copy(entryToText(e, settings.timeMode, label), 'entry');
    else if (what === 'json') void copy(e.json ? JSON.stringify(e.json, null, 2) : e.raw, e.json ? 'JSON' : 'raw line');
    else if (what === 'stack') void copy(stackTraceOf(e), 'stack trace');
    else {
      const [a, b] = contextRange(entries.length, entries.indexOf(e), settings.contextLines);
      void copy(entriesToText(entries.slice(a, b), settings.timeMode, labels()), pluralize(b - a, 'entry', 'entries'));
    }
  };

  const shownEntries = () => indices.map((i) => entries[i]);
  const onCopyFiltered = (format: 'text' | 'ndjson') => {
    const list = shownEntries();
    void copy(format === 'text' ? entriesToText(list, settings.timeMode, labels()) : entriesToNdjson(list), pluralize(list.length, 'entry', 'entries'));
  };
  const onDownload = () => {
    const base = store.sources.length === 1 ? store.sources[0].info.label.replace(/[^\w.-]+/g, '_') : 'logs';
    downloadText(entriesToText(shownEntries(), settings.timeMode, labels()), `${base}-${isFilterActive(filter) ? 'filtered' : 'all'}.log`);
  };

  const showInContext = (e: LogEntry) => {
    setQuery('');
    setFilter((f) => ({ ...EMPTY_FILTER, regex: f.regex, caseSensitive: f.caseSensitive }));
    setSelected(e);
    setFlash(e);
    scrollTo(e, 'center');
  };

  const clearFilters = () => {
    setQuery('');
    setFilter((f) => ({ ...EMPTY_FILTER, regex: f.regex, caseSensitive: f.caseSensitive }));
    if (selected) scrollTo(selected, 'center');
  };

  const addFiles = async (files: File[]) => {
    for (const file of files) void store.addText({ label: labelForFileName(file.name), kind: 'file' }, await file.text());
  };
  const addUrls = (urls: string[]) => {
    const origin = props.baseUrl ? new URL(props.baseUrl).origin : undefined;
    for (const input of urls) {
      const url = toRawLogUrl(input, props.baseUrl);
      if (!url) showToast(`Not a URL: ${input}`);
      else if (origin && new URL(url).origin !== origin) showToast(`Only URLs from ${origin} can be fetched here`);
      else void store.addUrl({ label: labelForUrl(url), kind: 'url', url });
    }
  };
  const pasteCount = useRef(0);
  const addPaste = (text: string) => void store.addText({ label: `pasted ${++pasteCount.current}`, kind: 'paste' }, text);

  const removeSource = (id: number) => {
    store.remove(id);
    patchFilter({ hiddenSources: filter.hiddenSources.filter((h) => h !== id) });
    if (selected?.sourceId === id) setSelected(null);
  };

  const reload = async () => {
    setBusy(true);
    try {
      await store.reload();
      // The console accepts only real navigations: reload the tab like F5, keeping the view.
      if (isRejected(store.pageSource) && props.reloadPage) {
        if (store.sources.length > 1 && !window.confirm(otherSourcesWarning)) return;
        showToast('Reloading the page…');
        props.reloadPage(viewState());
        return;
      }
      const failed = store.sources.find((s) => s.status === 'error');
      showToast(failed ? `Reload failed: ${failed.error}` : 'Reloaded');
    } finally {
      setBusy(false);
    }
  };

  const onResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const rect = rootRef.current!.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    let width = detailsWidth;
    const onMove = (ev: PointerEvent) => {
      width = Math.round(Math.max(300, Math.min(rect.width - 320, rect.right - ev.clientX)));
      setDetailsWidth(width);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      updateSettings({ detailsWidth: width });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (adding) return;
      if (e.key === 'Escape') {
        if (isField(e.target)) {
          if (e.target === searchRef.current && query) setQuery('');
          else e.target.blur();
        } else if (selected) setSelected(null);
        return;
      }
      if (isField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case '/':
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case 'ArrowDown':
        case 'j':
          move(1);
          break;
        case 'ArrowUp':
        case 'k':
          move(-1);
          break;
        case 'n':
          jump('error', 1);
          break;
        case 'N':
          jump('error', -1);
          break;
        case 'w':
          jump('warn', 1);
          break;
        case 'W':
          jump('warn', -1);
          break;
        case 'g':
          listApi.current?.scrollToEdge('top');
          break;
        case 'G':
          listApi.current?.scrollToEdge('bottom');
          break;
        case 'c':
          onCopy('entry');
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (props.mode !== 'standalone' || adding || isField(e.target)) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text?.trim()) addPaste(text);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
    };
  });

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const loadingSource = store.sources.find((s) => s.status === 'loading');
  const style = {
    '--lv-font': `${settings.fontSize}px`,
    '--lv-row-h': `${rowHeight}px`,
    '--lv-cols': gridTemplate(cols, withDate),
    '--lv-cols-narrow': gridTemplate(cols, withDate, true),
    '--lv-details-w': `${detailsWidth}px`,
  };

  return (
    <div
      class="lv-app"
      ref={rootRef}
      style={style}
      onDragOver={(e) => {
        if (!hasFiles(e) || adding) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null || !rootRef.current?.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e) || adding) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(Array.from(e.dataTransfer?.files ?? []));
      }}
    >
      {store.sources.length > 0 && (
        <>
          <Header
            mode={props.mode}
            sources={store.sources}
            hiddenSources={filter.hiddenSources}
            onToggleSource={(id) =>
              patchFilter({ hiddenSources: filter.hiddenSources.includes(id) ? filter.hiddenSources.filter((h) => h !== id) : [...filter.hiddenSources, id] })
            }
            onRemoveSource={removeSource}
            onAdd={() => setAdding(true)}
            counts={result.counts}
            levels={filter.levels}
            onLevelClick={onLevelClick}
            canRefetch={store.hasRefetchable}
            busy={busy || Boolean(loadingSource)}
            onReload={() => void reload()}
            tailSeconds={tailSeconds}
            tailByReload={tailByReload}
            onTail={setTailSeconds}
            settings={settings}
            onSettings={updateSettings}
            onShowRaw={props.onShowRaw}
            onAutoOpen={props.onAutoOpen}
          />
          <FilterBar
            inputRef={searchRef}
            query={query}
            onQuery={setQuery}
            filter={filter}
            onFilter={patchFilter}
            regexError={result.error}
            loggers={loggers}
            shown={indices.length}
            total={entries.length}
            filtersActive={isFilterActive(filter) || Boolean(query.trim())}
            onClear={clearFilters}
            onJump={jump}
            timeMode={settings.timeMode}
            referenceMs={firstMs}
            onCopyFiltered={onCopyFiltered}
            onDownload={onDownload}
          />
        </>
      )}
      {promptOpen && props.autoPrompt && (
        <div class="lv-banner" role="region" aria-label="Automatic opening">
          <span>
            Skip the toolbar click next time: open Raw logs from <b>{props.autoPrompt.host}</b> in LogPane automatically?
          </span>
          <button
            type="button"
            class="lv-btn lv-btn-small lv-primary"
            onClick={() => {
              props.autoPrompt!.onEnable();
              setPromptOpen(false);
            }}
          >
            Enable…
          </button>
          <button
            type="button"
            class="lv-btn lv-btn-small"
            onClick={() => {
              props.autoPrompt!.onDismiss();
              setPromptOpen(false);
            }}
          >
            Not now
          </button>
        </div>
      )}
      <div class={`lv-main${selected ? ' lv-with-details' : ''}`}>
        <div class="lv-list-wrap">
          {store.sources.length === 0 ? (
            <EmptyState onFiles={(f) => void addFiles(f)} onPaste={addPaste} />
          ) : (
            <>
              <ColumnHeader cols={cols} />
              <LogList
                entries={entries}
                indices={indices}
                selected={selected}
                flash={flash}
                onSelect={setSelected}
                rowHeight={rowHeight}
                highlight={result.highlight}
                timeMode={settings.timeMode}
                withDate={withDate}
                cols={cols}
                sources={sources}
                apiRef={listApi}
              />
              {loadingSource && (
                <div class="lv-overlay-msg">
                  Parsing {loadingSource.info.label}… {Math.round(loadingSource.progress * 100)}%
                </div>
              )}
              {!loadingSource && entries.length > 0 && indices.length === 0 && (
                <div class="lv-overlay-msg">
                  No entries match the filters.{' '}
                  <button type="button" class="lv-link" onClick={clearFilters}>
                    Clear filters
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {selected && (
          <DetailsPanel
            entry={selected}
            source={sources.get(selected.sourceId)}
            timeMode={settings.timeMode}
            contextLines={settings.contextLines}
            onResizeStart={onResizeStart}
            onClose={() => setSelected(null)}
            onFilterTrace={(traceId) => {
              patchFilter({ traceId });
              scrollTo(selected, 'center');
            }}
            onFilterLogger={(logger) => {
              patchFilter({ loggers: [logger] });
              scrollTo(selected, 'center');
            }}
            onSearch={(term) => setQuery(`"${term}"`)}
            onShowInContext={() => showInContext(selected)}
            onCopy={(what) => onCopy(what)}
          />
        )}
      </div>
      {adding && (
        <AddSourceDialog
          canFetchUrls={props.canFetchUrls}
          onFiles={(f) => void addFiles(f)}
          onUrls={addUrls}
          onPaste={addPaste}
          onClose={() => setAdding(false)}
        />
      )}
      {dragging && <div class="lv-drop-overlay">Drop log files to add them</div>}
      {toast && <div class="lv-toast" role="status">{toast}</div>}
    </div>
  );
}

function EmptyState(props: { onFiles: (files: File[]) => void; onPaste: (text: string) => void }) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div class="lv-empty">
      <h1>LogPane</h1>
      <p class="lv-tagline">Structured logs, without the noise.</p>
      <p>Drop a <code>.log</code> file anywhere on this page, paste log text (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>V</kbd>), or</p>
      <button type="button" class="lv-btn lv-primary" onClick={() => fileRef.current?.click()}>
        Choose files…
      </button>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => props.onFiles(Array.from((e.currentTarget as HTMLInputElement).files ?? []))}
      />
      <textarea
        class="lv-input"
        rows={6}
        spellcheck={false}
        placeholder="…or paste JSON log lines here"
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <button type="button" class="lv-btn" disabled={!text.trim()} onClick={() => props.onPaste(text)}>
        Open pasted text
      </button>
      <p class="lv-dim">Everything stays in this browser tab. Nothing is uploaded anywhere.</p>
    </div>
  );
}

export function mountApp(container: HTMLElement, props: AppProps): void {
  render(<App {...props} />, container);
}
