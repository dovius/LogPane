import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { FilterState } from '../core/filter';
import { formatFull, parseUserTime, type TimeMode } from '../core/time';
import { LEVELS, type Level, type LevelCounts } from '../core/types';
import type { Settings } from './settings';
import type { SourceState } from './store';
import { RELOAD_TAIL_MIN_SECONDS } from './viewState';
import { Popover } from './widgets';

const TAIL_OPTIONS = [0, 2, 5, 10, 30];

export function Header(props: {
  mode: 'page' | 'standalone';
  sources: SourceState[];
  hiddenSources: number[];
  onToggleSource: (id: number) => void;
  onRemoveSource: (id: number) => void;
  onAdd: () => void;
  counts: LevelCounts;
  levels: Level[];
  onLevelClick: (level: Level, multi: boolean) => void;
  canRefetch: boolean;
  busy: boolean;
  onReload: () => void;
  tailSeconds: number;
  /** Tail reloads the page (the console rejects the viewer's own requests). */
  tailByReload: boolean;
  onTail: (seconds: number) => void;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onShowRaw?: () => void;
  onAutoOpen?: () => void;
}) {
  const { settings: s } = props;
  const multi = props.sources.length > 1;
  return (
    <header class="lv-header">
      <div class="lv-sources">
        {props.sources.map((src) => {
          const hidden = props.hiddenSources.includes(src.info.id);
          const title = [src.info.label, src.info.url, src.error && `Error: ${src.error}`].filter(Boolean).join('\n');
          return (
            <span class={`lv-chip lv-src-chip${hidden ? ' lv-off' : ''}${src.status === 'error' ? ' lv-err' : ''}`} title={title}>
              <button type="button" class="lv-chip-main" onClick={() => multi && props.onToggleSource(src.info.id)} title={multi ? 'Show / hide this source' : title}>
                <i class="lv-dot" style={{ background: src.info.color }} />
                <span class="lv-src-label">{src.info.label}</span>
                {src.status === 'loading' && <span class="lv-dim"> {Math.round(src.progress * 100)}%</span>}
                {src.status === 'error' && <span class="lv-err-text"> ⚠ {src.error}</span>}
                {src.status === 'ready' && <span class="lv-dim"> {src.entries.length.toLocaleString()}</span>}
              </button>
              {(multi || props.mode === 'standalone') && (
                <button type="button" class="lv-chip-x" title="Remove this source" aria-label="Remove source" onClick={() => props.onRemoveSource(src.info.id)}>
                  ✕
                </button>
              )}
            </span>
          );
        })}
        <button type="button" class="lv-btn" onClick={props.onAdd} title="Add another log (file or Raw URL) and merge by time">
          + Add log
        </button>
      </div>

      <div class="lv-levels" role="group" aria-label="Levels">
        {LEVELS.filter((l) => props.counts[l] > 0 || props.levels.includes(l)).map((l) => {
          const active = props.levels.length === 0 || props.levels.includes(l);
          return (
            <button
              type="button"
              class={`lv-level-chip lv-lvl-${l}${active ? '' : ' lv-off'}${props.levels.includes(l) ? ' lv-solo' : ''}`}
              title="Click: show only this level (click again for all). Ctrl/⌘/Shift-click: add or remove."
              onClick={(e) => props.onLevelClick(l, e.ctrlKey || e.metaKey || e.shiftKey)}
            >
              {l === 'OTHER' ? 'plain' : l} <b>{props.counts[l].toLocaleString()}</b>
            </button>
          );
        })}
      </div>

      <div class="lv-header-right">
        {props.canRefetch && (
          <>
            <button type="button" class="lv-btn" disabled={props.busy} onClick={props.onReload} title="Fetch the log again (filters are kept)">
              ⟳ Reload
            </button>
            <label
              class={`lv-select${props.tailSeconds ? ' lv-on' : ''}`}
              title={
                props.tailByReload
                  ? `This page can only be re-read by reloading it, so Tail reloads the page (at least every ${RELOAD_TAIL_MIN_SECONDS} s, paused while the tab is hidden)`
                  : 'Poll for new lines (paused while the tab is hidden)'
              }
            >
              {props.tailByReload ? 'Tail ↻' : 'Tail'}
              <select value={props.tailSeconds} onChange={(e) => props.onTail(Number((e.currentTarget as HTMLSelectElement).value))}>
                {TAIL_OPTIONS.map((sec) => (
                  <option value={sec}>{sec ? `${sec}s` : 'off'}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <div class="lv-seg" role="group" aria-label="Time zone">
          <button type="button" class={s.timeMode === 'utc' ? 'lv-on' : ''} onClick={() => props.onSettings({ timeMode: 'utc' })}>UTC</button>
          <button type="button" class={s.timeMode === 'local' ? 'lv-on' : ''} onClick={() => props.onSettings({ timeMode: 'local' })}>Local</button>
        </div>
        <div class="lv-seg" role="group" aria-label="Font size">
          <button type="button" title="Smaller text" onClick={() => props.onSettings({ fontSize: Math.max(9, s.fontSize - 1) })}>A−</button>
          <button type="button" title="Larger text" onClick={() => props.onSettings({ fontSize: Math.min(20, s.fontSize + 1) })}>A+</button>
        </div>
        <Popover label="View ▾" align="right">
          {() => (
            <div class="lv-menu">
              <label>
                <input type="checkbox" checked={s.showLogger} onChange={() => props.onSettings({ showLogger: !s.showLogger })} /> Logger column
              </label>
              <label>
                <input type="checkbox" checked={s.showThread} onChange={() => props.onSettings({ showThread: !s.showThread })} /> Thread column
              </label>
              <label>
                Context lines for copy
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={s.contextLines}
                  onChange={(e) => props.onSettings({ contextLines: Math.max(1, Math.min(500, Number((e.currentTarget as HTMLInputElement).value) || 20)) })}
                />
              </label>
              {props.onAutoOpen && (
                <button type="button" class="lv-btn" onClick={props.onAutoOpen}>
                  Open automatically on this domain…
                </button>
              )}
              <ShortcutHelp />
            </div>
          )}
        </Popover>
        {props.onShowRaw && (
          <button type="button" class="lv-btn" onClick={props.onShowRaw} title="Show the original raw text">
            Raw
          </button>
        )}
      </div>
    </header>
  );
}

function ShortcutHelp() {
  return (
    <div class="lv-help">
      <b>Keyboard</b>
      <div><kbd>/</kbd> search</div>
      <div><kbd>↑</kbd><kbd>↓</kbd> or <kbd>j</kbd><kbd>k</kbd> move</div>
      <div><kbd>n</kbd> / <kbd>N</kbd> next / previous error</div>
      <div><kbd>w</kbd> / <kbd>W</kbd> next / previous warning</div>
      <div><kbd>g</kbd> / <kbd>G</kbd> top / bottom</div>
      <div><kbd>c</kbd> copy entry</div>
      <div><kbd>Esc</kbd> close details / clear search</div>
      <b>Search</b>
      <div>terms are ANDed, <code>"exact phrase"</code>, <code>-exclude</code></div>
    </div>
  );
}

function TimeInput(props: { value: number | null; placeholder: string; timeMode: TimeMode; referenceMs: number; onChange: (ms: number | null) => void }) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (props.value === null) setText('');
    else setText(formatFull(props.value, 0, props.timeMode).replace('T', ' ').replace(/(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/, '$1'));
    setInvalid(false);
  }, [props.value, props.timeMode]);
  const commit = () => {
    if (!text.trim()) {
      setInvalid(false);
      props.onChange(null);
      return;
    }
    const ms = parseUserTime(text, props.timeMode, props.referenceMs);
    setInvalid(ms === null);
    if (ms !== null) props.onChange(ms);
  };
  return (
    <input
      class={`lv-input lv-time-input${invalid ? ' lv-invalid' : ''}`}
      value={text}
      placeholder={props.placeholder}
      title={`HH:mm[:ss[.SSS]] or YYYY-MM-DD HH:mm:ss (${props.timeMode === 'utc' ? 'UTC' : 'local time'}); Enter to apply`}
      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

export function FilterBar(props: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQuery: (q: string) => void;
  filter: FilterState;
  onFilter: (patch: Partial<FilterState>) => void;
  regexError?: string;
  loggers: [string, number][];
  shown: number;
  total: number;
  filtersActive: boolean;
  onClear: () => void;
  onJump: (kind: 'error' | 'warn', dir: 1 | -1) => void;
  timeMode: TimeMode;
  referenceMs: number;
  onCopyFiltered: (format: 'text' | 'ndjson') => void;
  onDownload: () => void;
}) {
  const f = props.filter;
  const [loggerQuery, setLoggerQuery] = useState('');
  const toggleLogger = (name: string) =>
    props.onFilter({ loggers: f.loggers.includes(name) ? f.loggers.filter((l) => l !== name) : [...f.loggers, name] });
  return (
    <div class="lv-filterbar">
      <div class={`lv-search${props.regexError ? ' lv-invalid' : ''}`}>
        <input
          ref={props.inputRef}
          class="lv-search-input"
          type="search"
          placeholder={f.regex ? 'Regular expression…' : 'Search…  (/)'}
          value={props.query}
          spellcheck={false}
          onInput={(e) => props.onQuery((e.currentTarget as HTMLInputElement).value)}
          title={props.regexError ?? 'Terms are ANDed, "exact phrase", -exclude'}
        />
        <button type="button" class={`lv-toggle${f.regex ? ' lv-on' : ''}`} title="Regular expression" onClick={() => props.onFilter({ regex: !f.regex })}>
          .*
        </button>
        <button type="button" class={`lv-toggle${f.caseSensitive ? ' lv-on' : ''}`} title="Case sensitive" onClick={() => props.onFilter({ caseSensitive: !f.caseSensitive })}>
          Aa
        </button>
      </div>

      <Popover label={f.loggers.length ? `Logger (${f.loggers.length})` : 'Logger'} buttonClass={f.loggers.length ? 'lv-active' : ''}>
        {() => {
          const q = loggerQuery.toLowerCase();
          const list = props.loggers.filter(([name]) => !q || name.toLowerCase().includes(q));
          return (
            <div class="lv-logger-picker">
              <div class="lv-row-flex">
                <input class="lv-input" placeholder="Filter loggers…" value={loggerQuery} onInput={(e) => setLoggerQuery((e.currentTarget as HTMLInputElement).value)} />
                <button type="button" class="lv-btn lv-btn-small" disabled={!f.loggers.length} onClick={() => props.onFilter({ loggers: [] })}>
                  All
                </button>
              </div>
              <div class="lv-logger-list">
                {list.slice(0, 500).map(([name, count]) => (
                  <label title={name}>
                    <input type="checkbox" checked={f.loggers.includes(name)} onChange={() => toggleLogger(name)} />
                    <span class="lv-logger-name">{name || '(none)'}</span>
                    <span class="lv-dim">{count.toLocaleString()}</span>
                  </label>
                ))}
                {!list.length && <div class="lv-dim">No loggers</div>}
              </div>
            </div>
          );
        }}
      </Popover>

      <TimeInput value={f.fromMs} placeholder="from" timeMode={props.timeMode} referenceMs={props.referenceMs} onChange={(fromMs) => props.onFilter({ fromMs })} />
      <TimeInput value={f.toMs} placeholder="to" timeMode={props.timeMode} referenceMs={props.referenceMs} onChange={(toMs) => props.onFilter({ toMs })} />

      {f.traceId && (
        <span class="lv-chip lv-trace-chip" title={`traceId ${f.traceId}`}>
          trace {f.traceId.slice(0, 10)}…
          <button type="button" class="lv-chip-x" aria-label="Clear trace filter" onClick={() => props.onFilter({ traceId: '' })}>
            ✕
          </button>
        </span>
      )}
      {props.filtersActive && (
        <button type="button" class="lv-btn lv-btn-small" onClick={props.onClear}>
          Clear filters
        </button>
      )}

      <span class="lv-grow" />

      <div class="lv-seg" role="group" aria-label="Jump">
        <button type="button" title="Previous error (N)" onClick={() => props.onJump('error', -1)}>◀</button>
        <span class="lv-seg-label lv-lvl-ERROR">ERROR</span>
        <button type="button" title="Next error (n)" onClick={() => props.onJump('error', 1)}>▶</button>
      </div>
      <span class="lv-count" title="Entries shown / total">
        {props.shown.toLocaleString()} / {props.total.toLocaleString()}
      </span>
      <Popover label="Export ▾" align="right">
        {(close) => (
          <div class="lv-menu">
            <button type="button" class="lv-btn" onClick={() => { props.onCopyFiltered('text'); close(); }}>Copy shown as text</button>
            <button type="button" class="lv-btn" onClick={() => { props.onCopyFiltered('ndjson'); close(); }}>Copy shown as raw JSON lines</button>
            <button type="button" class="lv-btn" onClick={() => { props.onDownload(); close(); }}>Download shown (.log)</button>
          </div>
        )}
      </Popover>
    </div>
  );
}
