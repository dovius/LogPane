import { useMemo, useState } from 'preact/hooks';
import { extractEmbeddedJson } from '../core/embedded';
import { stackTraceOf } from '../core/exportText';
import { safeStringify, visibleControls } from '../core/safeText';
import { exceptionChain } from '../core/stacktrace';
import { formatFull, type TimeMode } from '../core/time';
import type { LogEntry, SourceInfo } from '../core/types';
import { groupFields, layoutRows, nameColumnWidth, splitPlainStack, type FieldItem } from './fieldGroups';
import { abbreviateLogger, breakAtDots, parseStackLine, readableTimestamp, stackParts, type StackLineKind } from './format';
import { JsonView, LazyDetails } from './widgets';

export type CopyWhat = 'entry' | 'json' | 'stack' | 'context';

/** Log text for display: control / bidi characters made visible, long identifiers wrap at their dots. */
function Dotted({ text, min }: { text: string; min?: number }) {
  return <>{breakAtDots(visibleControls(text), min).map((p) => (p === null ? <wbr /> : p))}</>;
}

/** A field value styled by type: strings as text, numbers / booleans / null like JSON, arrays as lists. */
function FieldValue({ value }: { value: unknown }) {
  if (value === null) return <span class="lv-v-null">null</span>;
  if (typeof value === 'number') return <span class="lv-v-num">{String(value)}</span>;
  if (typeof value === 'boolean') return <span class="lv-v-bool">{String(value)}</span>;
  if (typeof value === 'string') return <Dotted text={value} />;
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) {
    return (
      <span class="lv-v-list">
        {value.slice(0, LIST_LIMIT).map((v) => (
          <span class="lv-v-item">
            <FieldValue value={v} />
          </span>
        ))}
        {value.length > LIST_LIMIT && <span class="lv-dim">… {(value.length - LIST_LIMIT).toLocaleString()} more</span>}
      </span>
    );
  }
  return <code class="lv-v-json">{safeStringify(value)}</code>;
}

const valueText = (v: unknown) => (typeof v === 'string' ? v : safeStringify(v));

function IconButton(props: { label: string; icon: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" class="lv-icon-btn" title={props.label} aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
    </button>
  );
}

/** Lists longer than this show "Show all" (an entry can carry thousands of fields). */
const FIELD_LIMIT = 300;
const LIST_LIMIT = 100;

function FieldRows(props: {
  items: FieldItem[];
  onFilterTrace: (traceId: string) => void;
  onSearch: (term: string) => void;
  onCopyText: (text: string, what: string) => void;
}) {
  const [all, setAll] = useState(false);
  const items = all ? props.items : props.items.slice(0, FIELD_LIMIT);
  return (
    <div class="lv-frows">
      {items.map((it) => {
        if (it.kind === 'group') {
          return (
            <div class="lv-fgroup" key={`g:${it.path}`} title={it.path}>
              <Dotted text={it.path} min={1} />
            </div>
          );
        }
        const r = it.row;
        return (
          <div class="lv-frow" key={r.key}>
            <span class={it.nested ? 'lv-fkey lv-fkey-nested' : 'lv-fkey'} title={r.key}>
              <Dotted text={it.name} min={1} />
            </span>
            <span class="lv-fval">
              {r.action === 'trace' ? (
                <button type="button" class="lv-link" title="Show all entries of this trace" onClick={() => props.onFilterTrace(String(r.value))}>
                  {visibleControls(String(r.value))}
                </button>
              ) : (
                <FieldValue value={r.value} />
              )}
            </span>
            <span class="lv-factions">
              {r.action === 'search' && <IconButton label={`Search for this ${it.name}`} icon="⌕" onClick={() => props.onSearch(valueText(r.value))} />}
              <IconButton label={`Copy ${it.name}`} icon="⧉" onClick={() => props.onCopyText(valueText(r.value), r.label)} />
            </span>
          </div>
        );
      })}
      {items.length < props.items.length && (
        <button type="button" class="lv-btn lv-btn-small lv-show-all" onClick={() => setAll(true)}>
          Show {(props.items.length - items.length).toLocaleString()} more fields
        </button>
      )}
    </div>
  );
}

function StackLineView({ text, kind }: { text: string; kind: StackLineKind }) {
  const l = parseStackLine(text);
  if (l.kind === 'frame') {
    return (
      <div class={`lv-sl lv-sl-frame lv-sl-${kind}`}>
        <span class="lv-sl-at">at </span>
        <Dotted text={l.method} min={1} />
        <wbr />
        <span class="lv-sl-loc">{visibleControls(l.location)}</span>
      </div>
    );
  }
  if (l.kind === 'exception') {
    return (
      <div class="lv-sl lv-sl-exception">
        {l.prefix && <span class="lv-sl-by">{l.prefix.trim()} </span>}
        <span class="lv-sl-type">
          <Dotted text={l.type} min={1} />
        </span>
        {l.message && <span class="lv-sl-msg">: {visibleControls(l.message)}</span>}
      </div>
    );
  }
  return <div class={kind === 'other' ? 'lv-sl lv-sl-more' : 'lv-sl lv-sl-cont'}>{visibleControls(l.text)}</div>;
}

/** Longer stack traces are cut until "Show all": every line is several elements. */
const STACK_LINE_LIMIT = 2000;
const STACK_CHAR_LIMIT = 200_000;

/** The first lines of `stack` within the limits, and how many lines were left out. */
function cutStack(stack: string): { shown: string; hidden: number } {
  if (stack.length <= STACK_CHAR_LIMIT && stack.split('\n', STACK_LINE_LIMIT + 1).length <= STACK_LINE_LIMIT) return { shown: stack, hidden: 0 };
  const lines = stack.split('\n');
  let n = 0;
  for (let chars = 0; n < lines.length && n < STACK_LINE_LIMIT && chars + lines[n].length <= STACK_CHAR_LIMIT; n++) chars += lines[n].length + 1;
  n = Math.max(n, 1);
  return { shown: lines.slice(0, n).join('\n'), hidden: lines.length - n };
}

function StackTrace(props: { stack: string; showAll: boolean }) {
  const [full, setFull] = useState(false);
  const { shown, hidden } = useMemo(() => (full ? { shown: props.stack, hidden: 0 } : cutStack(props.stack)), [props.stack, full]);
  const parts = useMemo(() => stackParts(shown), [shown]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  // memoised: parsing every line again on each re-render of the app (Tail, toasts) adds up
  const lines = useMemo(
    () =>
      parts.map((p, i) =>
        p.kind === 'line' ? (
          <StackLineView text={p.text} kind={p.line} />
        ) : props.showAll || open.has(i) ? (
          p.lines.map((text) => <StackLineView text={text} kind="framework" />)
        ) : (
          <button type="button" class="lv-fold" onClick={() => setOpen(new Set(open).add(i))} title="Show these frames">
            ⋯ {p.lines.length} framework frames
          </button>
        ),
      ),
    [parts, open, props.showAll],
  );
  return (
    <div class="lv-pre lv-stack">
      {lines}
      {hidden > 0 && (
        <button type="button" class="lv-btn lv-btn-small lv-show-all" onClick={() => setFull(true)}>
          Show {hidden.toLocaleString()} more lines
        </button>
      )}
    </div>
  );
}

export function DetailsPanel(props: {
  entry: LogEntry;
  source?: SourceInfo;
  timeMode: TimeMode;
  contextLines: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onResizeStart: (e: PointerEvent) => void;
  onClose: () => void;
  onFilterTrace: (traceId: string) => void;
  onFilterLogger: (logger: string) => void;
  onSearch: (term: string) => void;
  onShowInContext: () => void;
  onCopy: (what: CopyWhat) => void;
  onCopyText: (text: string, what: string) => void;
}) {
  const { entry: e } = props;
  const plain = useMemo(() => (e.json ? null : splitPlainStack(e.raw)), [e]);
  const message = plain ? plain.message : e.message;
  const embedded = useMemo(() => (e.json ? extractEmbeddedJson(e.message) : null), [e]);
  const stack = useMemo(() => (plain ? plain.stack : stackTraceOf(e)), [e, plain]);
  const chain = useMemo(() => (e.exception ? exceptionChain(e.exception) : []), [e]);
  const groups = useMemo(() => groupFields(e), [e]);
  const layout = useMemo(
    () => ({ trace: layoutRows(groups.trace), context: layoutRows(groups.context), process: layoutRows(groups.process) }),
    [groups],
  );
  const nameCh = nameColumnWidth([layout.trace, layout.context, layout.process], ['Sequence']);
  const [showAllFrames, setShowAllFrames] = useState(false);
  const hasFolds = useMemo(() => stackParts(stack).some((p) => p.kind === 'fold'), [stack]);
  const frames = useMemo(() => stack.split('\n').filter((l) => /^\s*at /.test(l)), [stack]);
  const hasTime = !Number.isNaN(e.tsMs) && !e.tsInherited;
  const fieldProps = { onFilterTrace: props.onFilterTrace, onSearch: props.onSearch, onCopyText: props.onCopyText };

  return (
    <aside class={`lv-details lv-dl-${e.level}`} aria-label="Entry details">
      <div class="lv-resizer" onPointerDown={props.onResizeStart} title="Drag to resize" />
      <header class="lv-dhead">
        <div class="lv-dhead-row">
          <span class={`lv-pill lv-lvl-${e.level}`}>{e.level === 'OTHER' ? 'TEXT' : e.level}</span>
          <span class="lv-details-title" title={e.tsText}>
            {hasTime ? readableTimestamp(formatFull(e.tsMs, e.tsNanos, props.timeMode)) : 'No timestamp'}
          </span>
          <span class="lv-grow" />
          <span class="lv-seg lv-seg-small" role="group" aria-label="Entries">
            <button type="button" title="Previous entry (k)" aria-label="Previous entry" disabled={!props.canPrev} onClick={props.onPrev}>
              ↑
            </button>
            <button type="button" title="Next entry (j)" aria-label="Next entry" disabled={!props.canNext} onClick={props.onNext}>
              ↓
            </button>
          </span>
          <button type="button" class="lv-btn lv-btn-icon" onClick={props.onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>
        <div class="lv-dmeta">
          <div class="lv-dmeta-in">
            {e.logger && (
              <button type="button" class="lv-dmeta-item lv-link" title={`${e.logger}\nShow only this logger`} onClick={() => props.onFilterLogger(e.logger)}>
                {visibleControls(abbreviateLogger(e.logger, 40))}
              </button>
            )}
            {e.thread && <span class="lv-dmeta-item" title="Thread">{visibleControls(e.thread)}</span>}
            {props.source && (
              <span class="lv-dmeta-item" title={`${props.source.label}, line ${e.lineNo}`}>
                <i class="lv-dot" style={{ background: props.source.color }} />
                line {e.lineNo}
              </span>
            )}
          </div>
        </div>
        <div class="lv-dtools">
          <button type="button" class="lv-btn lv-btn-small" title="Copy as readable text (c)" onClick={() => props.onCopy('entry')}>
            Copy entry
          </button>
          <button type="button" class="lv-btn lv-btn-small" onClick={() => props.onCopy('json')}>
            {e.json ? 'Copy JSON' : 'Copy raw'}
          </button>
          <button type="button" class="lv-btn lv-btn-small" title="Copy this entry with the surrounding lines (unfiltered)" onClick={() => props.onCopy('context')}>
            Copy ±{props.contextLines} lines
          </button>
          <span class="lv-grow" />
          <button type="button" class="lv-btn lv-btn-small" onClick={props.onShowInContext} title="Clear filters and scroll to this entry">
            Show in context
          </button>
        </div>
      </header>

      <div class="lv-details-body" key={`${e.sourceId}:${e.lineNo}`} style={{ '--lv-fkey-w': `${nameCh}ch` }}>
        <section class="lv-dsec">
          <h3>
            Message
            <span class="lv-grow" />
            <button type="button" class="lv-btn lv-btn-small" aria-label="Copy message" title="Copy message" onClick={() => props.onCopyText(message, 'message')}>
              Copy
            </button>
          </h3>
          {embedded ? (
            <>
              {embedded.prefix.trim() && <p class="lv-msg-text">{visibleControls(embedded.prefix.trim())}</p>}
              <div class="lv-json-card">
                <div class="lv-json-card-head">
                  <span>JSON</span>
                  <IconButton label="Copy JSON payload" icon="⧉" onClick={() => props.onCopyText(safeStringify(embedded.value, 2), 'JSON payload')} />
                </div>
                <JsonView value={embedded.value} />
              </div>
              {embedded.suffix.trim() && <p class="lv-msg-text">{visibleControls(embedded.suffix.trim())}</p>}
            </>
          ) : (
            <pre class="lv-pre lv-wrap lv-msg">{message ? <Dotted text={message} /> : <span class="lv-dim">(empty)</span>}</pre>
          )}
        </section>

        {stack && (
          <section class="lv-dsec">
            <h3>
              Stack trace
              <span class="lv-h3-note">
                {frames.length} {frames.length === 1 ? 'frame' : 'frames'}
              </span>
              <span class="lv-grow" />
              {hasFolds && (
                <button type="button" class="lv-btn lv-btn-small" onClick={() => setShowAllFrames(!showAllFrames)}>
                  {showAllFrames ? 'Hide framework frames' : 'Show all frames'}
                </button>
              )}
              <button type="button" class="lv-btn lv-btn-small" aria-label="Copy stack trace" title="Copy stack trace" onClick={() => props.onCopy('stack')}>
                Copy
              </button>
            </h3>
            {chain.length > 0 && (
              <ol class="lv-chain">
                {chain.map((c, i) => (
                  <li class={i === 0 ? 'lv-chain-root' : ''}>
                    {i > 0 && <span class="lv-chain-by">caused by</span>}
                    <span class="lv-chain-type" title={c.type}>
                      {visibleControls(c.type.slice(c.type.lastIndexOf('.') + 1)) || 'Exception'}
                    </span>
                    {c.message && <span class="lv-chain-msg">{visibleControls(c.message)}</span>}
                  </li>
                ))}
              </ol>
            )}
            <StackTrace stack={stack} showAll={showAllFrames} />
          </section>
        )}

        <section class="lv-dsec">
          <h3>Details</h3>
          <div class="lv-frows">
            {hasTime && (
              <div class="lv-frow">
                <span class="lv-fkey">Time</span>
                <span class="lv-fval">
                  {readableTimestamp(formatFull(e.tsMs, e.tsNanos, 'utc'))}
                  <span class="lv-fsub">{readableTimestamp(formatFull(e.tsMs, e.tsNanos, 'local'))}</span>
                </span>
                <span class="lv-factions">
                  <IconButton label="Copy time" icon="⧉" onClick={() => props.onCopyText(e.tsText ?? formatFull(e.tsMs, e.tsNanos, 'utc'), 'time')} />
                </span>
              </div>
            )}
            {props.source && (
              <div class="lv-frow">
                <span class="lv-fkey">Source</span>
                <span class="lv-fval">
                  <i class="lv-dot" style={{ background: props.source.color }} /> {props.source.label}
                  <span class="lv-fsub">line {e.lineNo}</span>
                </span>
                <span class="lv-factions" />
              </div>
            )}
            {e.logger && (
              <div class="lv-frow">
                <span class="lv-fkey">Logger</span>
                <span class="lv-fval">
                  <button type="button" class="lv-link" title="Show only this logger" onClick={() => props.onFilterLogger(e.logger)}>
                    <Dotted text={e.logger} />
                  </button>
                </span>
                <span class="lv-factions">
                  <IconButton label="Copy logger" icon="⧉" onClick={() => props.onCopyText(e.logger, 'logger')} />
                </span>
              </div>
            )}
            {e.thread && (
              <div class="lv-frow">
                <span class="lv-fkey">Thread</span>
                <span class="lv-fval">{visibleControls(e.thread)}</span>
                <span class="lv-factions">
                  <IconButton label="Search for this thread" icon="⌕" onClick={() => props.onSearch(e.thread)} />
                </span>
              </div>
            )}
            {!Number.isNaN(e.seq) && (
              <div class="lv-frow">
                <span class="lv-fkey">Sequence</span>
                <span class="lv-fval">
                  <span class="lv-v-num">{e.seq}</span>
                </span>
                <span class="lv-factions" />
              </div>
            )}
          </div>
        </section>

        {groups.trace.length > 0 && (
          <section class="lv-dsec">
            <h3>Trace</h3>
            <FieldRows items={layout.trace} {...fieldProps} />
          </section>
        )}

        {groups.context.length > 0 && (
          <section class="lv-dsec">
            <h3>
              Context <span class="lv-h3-note">{groups.context.length}</span>
            </h3>
            <FieldRows items={layout.context} {...fieldProps} />
          </section>
        )}

        {groups.process.length > 0 && (
          <section class="lv-dsec">
            <details>
              <summary>
                Host &amp; process <span class="lv-h3-note">{groups.process.length}</span>
              </summary>
              <FieldRows items={layout.process} {...fieldProps} />
            </details>
          </section>
        )}

        <section class="lv-dsec">
          <LazyDetails summary={e.json ? 'Raw JSON' : 'Raw line'}>
            {() => (e.json ? <JsonView value={e.json} fallback={e.raw} /> : <pre class="lv-pre lv-wrap">{visibleControls(e.raw)}</pre>)}
          </LazyDetails>
        </section>
      </div>
    </aside>
  );
}
