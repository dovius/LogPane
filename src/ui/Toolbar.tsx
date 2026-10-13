import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { FilterState } from '../core/filter';
import { formatFull, parseUserTime, type TimeMode } from '../core/time';
import type { Level, LevelCounts } from '../core/types';
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type Settings } from './settings';
import type { SourceState } from './store';
import { RELOAD_TAIL_MIN_SECONDS, TAIL_OPTIONS } from './viewState';
import { Popover } from './widgets';

/** Quick ranges of the Time filter, counted back from the newest entry (logs are often hours old). */
const LAST_RANGES: [string, number][] = [['1 min', 60_000], ['5 min', 300_000], ['15 min', 900_000], ['1 hour', 3_600_000], ['6 hours', 21_600_000]];

export function Header(props: {
  mode: 'page' | 'standalone';
  sources: SourceState[];
  hiddenSources: number[];
  onToggleSource: (id: number) => void;
  onRemoveSource: (id: number) => void;
  onAdd: () => void;
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
          + <span class="lv-btn-text">Add log</span>
        </button>
      </div>

      <div class="lv-header-right">
        {props.canRefetch && (
          <>
            <button type="button" class="lv-btn" disabled={props.busy} onClick={(e) => e.isTrusted && props.onReload()} title="Fetch the log again (filters are kept)">
              ⟳ <span class="lv-btn-text">Reload</span>
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
        <Popover label="View ▾" align="right">
          {() => (
            <div class="lv-menu lv-view-menu">
              <div class="lv-menu-row">
                <span class="lv-menu-label">Time zone</span>
                <div class="lv-seg" role="group" aria-label="Time zone">
                  <button type="button" class={s.timeMode === 'utc' ? 'lv-on' : ''} onClick={() => props.onSettings({ timeMode: 'utc' })}>UTC</button>
                  <button type="button" class={s.timeMode === 'local' ? 'lv-on' : ''} onClick={() => props.onSettings({ timeMode: 'local' })}>Local</button>
                </div>
              </div>
              <div class="lv-menu-row">
                <span class="lv-menu-label">Text size</span>
                <div class="lv-seg" role="group" aria-label="Text size">
                  <button type="button" title="Smaller text" disabled={s.fontSize <= MIN_FONT_SIZE} onClick={() => props.onSettings({ fontSize: Math.max(MIN_FONT_SIZE, s.fontSize - 1) })}>A−</button>
                  <span class="lv-seg-label">{s.fontSize}px</span>
                  <button type="button" title="Larger text" disabled={s.fontSize >= MAX_FONT_SIZE} onClick={() => props.onSettings({ fontSize: Math.min(MAX_FONT_SIZE, s.fontSize + 1) })}>A+</button>
                </div>
              </div>
              <hr />
              <label>
                <input type="checkbox" checked={s.showLogger} onChange={() => props.onSettings({ showLogger: !s.showLogger })} /> Logger column
              </label>
              <label>
                <input type="checkbox" checked={s.showThread} onChange={() => props.onSettings({ showThread: !s.showThread })} /> Thread column
              </label>
              <label class="lv-menu-row">
                <span class="lv-menu-label">Context lines for copy</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={s.contextLines}
                  onChange={(e) => props.onSettings({ contextLines: Math.max(1, Math.min(500, Number((e.currentTarget as HTMLInputElement).value) || 20)) })}
                />
              </label>
              {props.onAutoOpen && (
                <button type="button" class="lv-btn lv-menu-item" onClick={(e) => e.isTrusted && props.onAutoOpen?.()}>
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
      <dl>
        <dt><kbd>/</kbd></dt>
        <dd>search</dd>
        <dt><kbd>↑</kbd><kbd>↓</kbd> <kbd>j</kbd><kbd>k</kbd></dt>
        <dd>move</dd>
        <dt><kbd>n</kbd> <kbd>N</kbd></dt>
        <dd>next / previous error</dd>
        <dt><kbd>w</kbd> <kbd>W</kbd></dt>
        <dd>next / previous warning</dd>
        <dt><kbd>g</kbd> <kbd>G</kbd></dt>
        <dd>top / bottom</dd>
        <dt><kbd>c</kbd></dt>
        <dd>copy entry</dd>
        <dt><kbd>Esc</kbd></dt>
        <dd>close details / clear search</dd>
      </dl>
      <b>Search</b>
      <div>terms are ANDed, <code>"exact phrase"</code>, <code>-exclude</code></div>
    </div>
  );
}

const timeText = (ms: number, mode: TimeMode) => formatFull(ms, 0, mode).replace('T', ' ').replace(/(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/, '$1');

function TimeInput(props: { value: number | null; label: string; placeholder: string; timeMode: TimeMode; referenceMs: number; onChange: (ms: number | null) => void }) {
  const shown = (value: number | null, mode: TimeMode) => (value === null ? '' : timeText(value, mode));
  const [text, setText] = useState(() => shown(props.value, props.timeMode));
  const [invalid, setInvalid] = useState(false);
  /** Typed but not applied yet (applied on Enter, blur, or when the popover closes). */
  const pending = useRef<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // Follow changes from outside (presets, Clear, UTC / Local). Not on mount: effects run after paint,
  // and resetting then would drop what was typed right after the popover opened.
  const synced = useRef(shown(props.value, props.timeMode));
  useEffect(() => {
    const next = shown(props.value, props.timeMode);
    if (next === synced.current) return;
    synced.current = next;
    setText(next);
    setInvalid(false);
  }, [props.value, props.timeMode]);
  const commit = (value = text): boolean => {
    pending.current = null;
    const p = latest.current;
    if (!value.trim()) {
      setInvalid(false);
      if (p.value !== null) p.onChange(null);
      return true;
    }
    const ms = parseUserTime(value, p.timeMode, p.referenceMs);
    setInvalid(ms === null);
    if (ms !== null && ms !== p.value) p.onChange(ms);
    return ms !== null;
  };
  useEffect(
    () => () => {
      if (pending.current !== null) commit(pending.current);
    },
    [],
  );
  return (
    <input
      class={`lv-input lv-time-input${invalid ? ' lv-invalid' : ''}`}
      value={text}
      placeholder={props.placeholder}
      aria-label={props.label}
      spellcheck={false}
      title={`HH:mm[:ss[.SSS]] or YYYY-MM-DD HH:mm:ss (${props.timeMode === 'utc' ? 'UTC' : 'local time'}); Enter to apply`}
      onInput={(e) => {
        const v = (e.currentTarget as HTMLInputElement).value;
        pending.current = v;
        setText(v);
      }}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

/** `09:00:12 – 09:30:00`, `from 09:00:12`, `until 09:30:00` (time of day of the bounds), or '' without a range. */
function rangeLabel(fromMs: number | null, toMs: number | null, mode: TimeMode): string {
  const short = (ms: number) => timeText(ms, mode).slice(11, 19);
  if (fromMs !== null && toMs !== null) return `${short(fromMs)} – ${short(toMs)}`;
  if (fromMs !== null) return `from ${short(fromMs)}`;
  return toMs !== null ? `until ${short(toMs)}` : '';
}

function TimeRange(props: { filter: FilterState; onFilter: (patch: Partial<FilterState>) => void; timeMode: TimeMode; referenceMs: number; lastMs: number }) {
  const { fromMs, toMs } = props.filter;
  const active = fromMs !== null || toMs !== null;
  const label = rangeLabel(fromMs, toMs, props.timeMode) || 'Time';
  const zone = props.timeMode === 'utc' ? 'UTC' : 'local time';
  // the log's own first / last time as the example
  const hint = (ms: number, fallback: string) => (Number.isNaN(ms) ? fallback : timeText(ms, props.timeMode).slice(11, 19));
  return (
    <Popover label={<>{label} ▾</>} title={`Time range (${zone})`} buttonClass={active ? 'lv-active' : ''}>
      {(close) => (
        <div class="lv-time-picker">
          <div class="lv-time-fields">
            <label>
              <span>From</span>
              <TimeInput value={fromMs} label="From" placeholder={hint(props.referenceMs, 'from')} timeMode={props.timeMode} referenceMs={props.referenceMs} onChange={(fromMs) => props.onFilter({ fromMs })} />
            </label>
            <label>
              <span>To</span>
              <TimeInput value={toMs} label="To" placeholder={hint(props.lastMs, 'to')} timeMode={props.timeMode} referenceMs={props.referenceMs} onChange={(toMs) => props.onFilter({ toMs })} />
            </label>
          </div>
          <div class="lv-dim lv-time-hint">HH:mm[:ss.SSS] on the log's day, or YYYY-MM-DD HH:mm; {zone}</div>
          {!Number.isNaN(props.lastMs) && (
            <div class="lv-time-presets" role="group" aria-label="Last part of the log">
              <span class="lv-menu-label" title="Counted back from the newest entry">Last</span>
              {LAST_RANGES.map(([name, ms]) => (
                <button
                  type="button"
                  class="lv-btn lv-btn-small"
                  title={`The last ${name} of the log (before its newest entry)`}
                  onClick={() => {
                    props.onFilter({ fromMs: props.lastMs - ms, toMs: null });
                    close();
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <div class="lv-row-flex lv-time-actions">
            <span class="lv-grow" />
            <button type="button" class="lv-btn lv-btn-small" disabled={!active} onClick={() => props.onFilter({ fromMs: null, toMs: null })}>
              Clear
            </button>
            <button type="button" class="lv-btn lv-btn-small lv-primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function LevelChips(props: { present: Level[]; counts: LevelCounts; levels: Level[]; onLevelClick: (level: Level, multi: boolean) => void }) {
  return (
    <div class="lv-levels" role="group" aria-label="Levels">
      {props.present.map((l) => {
        const solo = props.levels.includes(l);
        const active = props.levels.length === 0 || solo;
        const n = props.counts[l];
        return (
          <button
            type="button"
            class={`lv-level-chip lv-lvl-${l}${active ? '' : ' lv-off'}${solo ? ' lv-solo' : ''}${n ? '' : ' lv-zero'}`}
            title="Click: show only this level (click again for all). Ctrl/⌘/Shift-click: add or remove."
            aria-pressed={solo}
            onClick={(e) => props.onLevelClick(l, e.ctrlKey || e.metaKey || e.shiftKey)}
          >
            {l === 'OTHER' ? 'plain' : l} <b>{n.toLocaleString()}</b>
          </button>
        );
      })}
    </div>
  );
}

export function FilterBar(props: {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQuery: (q: string) => void;
  filter: FilterState;
  onFilter: (patch: Partial<FilterState>) => void;
  presentLevels: Level[];
  counts: LevelCounts;
  onLevelClick: (level: Level, multi: boolean) => void;
  regexError?: string;
  loggers: [string, number][];
  shown: number;
  total: number;
  filtersActive: boolean;
  onClear: () => void;
  onJump: (kind: 'error' | 'warn', dir: 1 | -1) => void;
  timeMode: TimeMode;
  referenceMs: number;
  lastMs: number;
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

      <LevelChips present={props.presentLevels} counts={props.counts} levels={f.levels} onLevelClick={props.onLevelClick} />

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

      <TimeRange filter={f} onFilter={props.onFilter} timeMode={props.timeMode} referenceMs={props.referenceMs} lastMs={props.lastMs} />

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

/** Shown instead of the list when nothing matches: each active filter can be removed on its own. */
export function NoMatches(props: {
  filter: FilterState;
  query: string;
  error?: string;
  hiddenSourceLabels: string[];
  timeMode: TimeMode;
  onFilter: (patch: Partial<FilterState>) => void;
  onQuery: (q: string) => void;
  onClear: () => void;
}) {
  const f = props.filter;
  const chips: [string, () => void][] = [];
  if (props.query.trim()) chips.push([`${f.regex ? 'Regex' : 'Search'} “${props.query.trim().slice(0, 40)}”`, () => props.onQuery('')]);
  if (f.levels.length) chips.push([`Level ${f.levels.map((l) => (l === 'OTHER' ? 'plain' : l)).join(', ')}`, () => props.onFilter({ levels: [] })]);
  if (f.loggers.length) chips.push([f.loggers.length === 1 ? `Logger ${f.loggers[0].slice(f.loggers[0].lastIndexOf('.') + 1)}` : `${f.loggers.length} loggers`, () => props.onFilter({ loggers: [] })]);
  if (f.traceId) chips.push([`Trace ${f.traceId.slice(0, 10)}…`, () => props.onFilter({ traceId: '' })]);
  const range = rangeLabel(f.fromMs, f.toMs, props.timeMode);
  if (range) chips.push([`Time ${range}`, () => props.onFilter({ fromMs: null, toMs: null })]);
  if (props.hiddenSourceLabels.length) chips.push([`Hidden ${props.hiddenSourceLabels.join(', ')}`, () => props.onFilter({ hiddenSources: [] })]);
  return (
    <div class={`lv-overlay-msg lv-nomatch${props.error ? ' lv-overlay-error' : ''}`} role="status">
      <div class="lv-nomatch-title">{props.error ? `Search: ${props.error}` : 'No entries match the filters.'}</div>
      {chips.length > 1 && (
        <div class="lv-nomatch-chips">
          {chips.map(([label, remove]) => (
            <button type="button" class="lv-nomatch-chip" title="Remove this filter" onClick={remove}>
              {label} <span aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" class="lv-link" onClick={props.onClear}>
        Clear {chips.length > 1 ? 'all filters' : 'filters'}
      </button>
    </div>
  );
}
