import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { mayContainJson } from '../core/embedded';
import { alignRows, entryToCells, rowsToHtml } from '../core/exportText';
import { highlightPieces } from '../core/filter';
import { escapeControls, visibleControls } from '../core/safeText';
import { formatTime, type TimeMode } from '../core/time';
import type { LogEntry, SourceInfo } from '../core/types';
import { abbreviateLogger, listText } from './format';
import { Pieces } from './widgets';

export interface Columns {
  source: boolean;
  logger: boolean;
  thread: boolean;
}

export interface ListApi {
  scrollToPos(pos: number, align: 'nearest' | 'center'): void;
  scrollToEdge(edge: 'top' | 'bottom'): void;
  /** First and last fully visible positions. */
  visibleRange(): [number, number];
  scrollState(): { top: number; atBottom: boolean };
  setScrollTop(top: number): void;
}

const OVERSCAN = 12;

/**
 * Source / logger / thread shrink before the message does, so the message keeps at least 24ch.
 * `narrow` (phones) uses fixed columns and lets the message take whatever is left.
 */
export function gridTemplate(cols: Columns, withDate: boolean, narrow = false): string {
  return [
    withDate ? '19ch' : '13ch',
    '6ch',
    cols.source ? (narrow ? '16ch' : 'minmax(10ch, 26ch)') : '',
    cols.logger ? (narrow ? '20ch' : 'minmax(10ch, 26ch)') : '',
    cols.thread ? (narrow ? '14ch' : 'minmax(8ch, 20ch)') : '',
    narrow ? 'minmax(0, 1fr)' : 'minmax(24ch, 1fr)',
  ].filter(Boolean).join(' ');
}

export function ColumnHeader({ cols, timeMode }: { cols: Columns; timeMode: TimeMode }) {
  return (
    <div class="lv-row lv-head" role="row">
      <span>
        Time <span class="lv-head-note">{timeMode === 'utc' ? 'UTC' : 'local'}</span>
      </span>
      <span>Level</span>
      {cols.source && <span>Source</span>}
      {cols.logger && <span>Logger</span>}
      {cols.thread && <span>Thread</span>}
      <span>Message</span>
    </div>
  );
}

export function LogList(props: {
  entries: readonly LogEntry[];
  indices: readonly number[];
  selected: LogEntry | null;
  flash: LogEntry | null;
  onSelect: (e: LogEntry | null) => void;
  rowHeight: number;
  highlight: RegExp | null;
  highlightMax?: number;
  timeMode: TimeMode;
  withDate: boolean;
  cols: Columns;
  sources: ReadonlyMap<number, SourceInfo>;
  apiRef: RefObject<ListApi>;
}) {
  const { entries, indices, rowHeight: rowH } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const atBottom = useRef(true);
  const total = indices.length;

  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Grid cells copy badly (glued or one per line), so a selection over several cells or rows is copied
  // as one line per entry with the columns lined up by spaces, plus an HTML table for spreadsheets.
  // A selection inside a single cell copies as usual.
  const copyState = useRef(props);
  copyState.current = props;
  useEffect(() => {
    const onCopy = (ev: ClipboardEvent) => {
      const list = ref.current;
      const sel = document.getSelection();
      if (!list || !sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!range.intersectsNode(list)) return;
      const cell = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest('.lv-row[data-pos] > span');
      const anchorCell = cell(sel.anchorNode);
      if (anchorCell && anchorCell === cell(sel.focusNode)) return;
      // A row counts only if some of its text is selected (a triple-click ends at the next row's start).
      const touches = (row: Element) => {
        if (!range.intersectsNode(row)) return false;
        const part = document.createRange();
        part.selectNodeContents(row);
        if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
        return part.toString().trim() !== '';
      };
      const positions = [...list.querySelectorAll<HTMLElement>('.lv-row[data-pos]')]
        .filter(touches)
        .map((row) => Number(row.dataset.pos));
      if (!positions.length) return;
      const { entries, indices, cols, timeMode, withDate, sources } = copyState.current;
      const rows: string[][] = [];
      for (let pos = Math.min(...positions); pos <= Math.max(...positions); pos++) {
        const e = entries[indices[pos]];
        rows.push(entryToCells(e, { timeMode, withDate, logger: cols.logger, thread: cols.thread, source: cols.source ? sources.get(e.sourceId)?.label ?? '' : undefined }));
      }
      const safe = rows.map((row) => row.map(escapeControls));
      ev.clipboardData?.setData('text/plain', alignRows(safe));
      ev.clipboardData?.setData('text/html', rowsToHtml(safe));
      ev.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, []);

  props.apiRef.current = {
    scrollToPos(pos, align) {
      const el = ref.current;
      if (!el || pos < 0) return;
      const top = pos * rowH;
      if (align === 'center') el.scrollTop = Math.max(0, top - (el.clientHeight - rowH) / 2);
      else if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
    },
    scrollToEdge(edge) {
      const el = ref.current;
      if (el) el.scrollTop = edge === 'top' ? 0 : el.scrollHeight;
    },
    scrollState() {
      return { top: ref.current?.scrollTop ?? 0, atBottom: atBottom.current };
    },
    setScrollTop(top) {
      const el = ref.current;
      if (el) el.scrollTop = top;
    },
    visibleRange() {
      const el = ref.current;
      if (!el || total === 0) return [0, total - 1];
      const first = Math.min(total - 1, Math.ceil(el.scrollTop / rowH));
      const last = Math.max(first, Math.min(total - 1, Math.floor((el.scrollTop + el.clientHeight) / rowH) - 1));
      return [first, last];
    },
  };

  // Stick to the bottom while new lines arrive (tail), like `tail -f`.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [total]);

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLDivElement;
    atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - rowH;
    setScrollTop(el.scrollTop);
  };

  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + height) / rowH) + OVERSCAN);
  const rows = [];
  for (let pos = start; pos < end; pos++) {
    const e = entries[indices[pos]];
    rows.push(
      <Row
        key={`${e.sourceId}:${e.lineNo}`}
        pos={pos}
        e={e}
        selected={e === props.selected}
        flash={e === props.flash}
        onSelect={props.onSelect}
        highlight={props.highlight}
        highlightMax={props.highlightMax}
        timeMode={props.timeMode}
        withDate={props.withDate}
        cols={props.cols}
        source={props.sources.get(e.sourceId)}
      />,
    );
  }

  return (
    <div class="lv-list" ref={ref} onScroll={onScroll} tabIndex={0} role="grid">
      <div class="lv-list-inner" style={{ height: `${total * rowH}px` }}>
        <div class="lv-list-rows" style={{ transform: `translateY(${start * rowH}px)` }}>{rows}</div>
      </div>
    </div>
  );
}

function Row(props: {
  pos: number;
  e: LogEntry;
  selected: boolean;
  flash: boolean;
  onSelect: (e: LogEntry | null) => void;
  highlight: RegExp | null;
  highlightMax?: number;
  timeMode: TimeMode;
  withDate: boolean;
  cols: Columns;
  source?: SourceInfo;
}) {
  const { e, cols } = props;
  const cls = `lv-row lv-l-${e.level}${props.selected ? ' lv-sel' : ''}${props.flash ? ' lv-flash' : ''}`;
  const hasError = Boolean(e.exception || e.stackText);
  return (
    <div
      class={cls}
      role="row"
      data-pos={props.pos}
      onClick={() => {
        // Selecting text inside a row should not open or close the details panel.
        if (!document.getSelection()?.isCollapsed) return;
        props.onSelect(props.selected ? null : e);
      }}
    >
      <span class={`lv-c-time${e.tsInherited ? ' lv-dim' : ''}`} title={e.tsText}>
        {formatTime(e.tsMs, props.timeMode, props.withDate)}
      </span>
      <span class="lv-c-level">{e.level !== 'OTHER' && <span class={`lv-lvl lv-lvl-${e.level}`}>{e.level}</span>}</span>
      {cols.source && (
        <span class="lv-c-src" title={props.source?.label}>
          <i class="lv-dot" style={{ background: props.source?.color }} />
          {props.source?.label}
        </span>
      )}
      {cols.logger && (
        <span class="lv-c-logger" title={e.logger}>
          {visibleControls(abbreviateLogger(e.logger))}
        </span>
      )}
      {cols.thread && (
        <span class="lv-c-thread" title={e.thread}>
          {visibleControls(e.thread)}
        </span>
      )}
      <span class="lv-c-msg">
        {hasError && <span class="lv-badge lv-badge-exc" title="Has stack trace">EXC</span>}
        {e.json && mayContainJson(e.message) && <span class="lv-badge" title="Message contains JSON">{'{}'}</span>}
        <Pieces pieces={highlightPieces(listText(e.message), props.highlight, props.highlightMax ?? 20)} />
      </span>
    </div>
  );
}
