import { useMemo } from 'preact/hooks';
import { extractEmbeddedJson } from '../core/embedded';
import { stackTraceOf } from '../core/exportText';
import { FIELD_ALIASES } from '../core/fields';
import { exceptionChain } from '../core/stacktrace';
import { formatFull, type TimeMode } from '../core/time';
import type { JsonObject, LogEntry, SourceInfo } from '../core/types';
import { isFrameworkFrame } from './format';
import { CopyButton, JsonView } from './widgets';

export type CopyWhat = 'entry' | 'json' | 'stack' | 'context';

/** Keys rendered in dedicated sections and therefore left out of "Other fields". */
const SHOWN_KEYS = new Set<string>([
  ...FIELD_ALIASES.timestamp, ...FIELD_ALIASES.level, ...FIELD_ALIASES.logger, ...FIELD_ALIASES.message,
  ...FIELD_ALIASES.thread, ...FIELD_ALIASES.sequence, ...FIELD_ALIASES.stackText, 'mdc', 'exception',
]);

function fieldText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function DetailsPanel(props: {
  entry: LogEntry;
  source?: SourceInfo;
  timeMode: TimeMode;
  contextLines: number;
  onResizeStart: (e: PointerEvent) => void;
  onClose: () => void;
  onFilterTrace: (traceId: string) => void;
  onFilterLogger: (logger: string) => void;
  onSearch: (term: string) => void;
  onShowInContext: () => void;
  onCopy: (what: CopyWhat) => void;
}) {
  const { entry: e } = props;
  const embedded = useMemo(() => (e.json ? extractEmbeddedJson(e.message) : null), [e]);
  const stack = useMemo(() => stackTraceOf(e), [e]);
  const chain = useMemo(() => (e.exception ? exceptionChain(e.exception) : []), [e]);
  const mdc = e.json?.mdc && typeof e.json.mdc === 'object' ? (e.json.mdc as JsonObject) : undefined;
  const others = e.json ? Object.entries(e.json).filter(([k]) => !SHOWN_KEYS.has(k)) : [];

  return (
    <aside class="lv-details" aria-label="Entry details">
      <div class="lv-resizer" onPointerDown={props.onResizeStart} title="Drag to resize" />
      <div class="lv-details-bar">
        {e.level !== 'OTHER' && <span class={`lv-lvl lv-lvl-${e.level}`}>{e.level}</span>}
        <span class="lv-details-title" title={e.tsText}>
          {e.tsInherited ? 'No timestamp' : formatFull(e.tsMs, e.tsNanos, props.timeMode)}
        </span>
        <span class="lv-grow" />
        <button type="button" class="lv-btn lv-btn-small" onClick={props.onShowInContext} title="Clear filters and scroll to this entry">
          Show in context
        </button>
        <button type="button" class="lv-btn lv-btn-icon" onClick={props.onClose} title="Close (Esc)" aria-label="Close">
          ✕
        </button>
      </div>
      <div class="lv-details-actions">
        <CopyButton label="Copy entry" title="Copy as readable text (c)" onCopy={() => props.onCopy('entry')} />
        <CopyButton label={e.json ? 'Copy JSON' : 'Copy raw'} onCopy={() => props.onCopy('json')} />
        <CopyButton label={`Copy ±${props.contextLines} lines`} title="Copy this entry with surrounding lines (unfiltered)" onCopy={() => props.onCopy('context')} />
      </div>

      <div class="lv-details-body" key={`${e.sourceId}:${e.lineNo}`}>
        <section>
          <h3>Message</h3>
          {embedded ? (
            <>
              {embedded.prefix.trim() && <pre class="lv-pre lv-wrap">{embedded.prefix.trim()}</pre>}
              <JsonView value={embedded.value} />
              {embedded.suffix.trim() && <pre class="lv-pre lv-wrap">{embedded.suffix.trim()}</pre>}
            </>
          ) : (
            <pre class="lv-pre lv-wrap">{e.message || <span class="lv-dim">(empty)</span>}</pre>
          )}
        </section>

        {stack && (
          <section>
            <h3>
              Stack trace <span class="lv-grow" />
              <CopyButton label="Copy stack trace" onCopy={() => props.onCopy('stack')} />
            </h3>
            {chain.length > 1 && (
              <ol class="lv-chain">
                {chain.map((c) => (
                  <li>
                    <b>{c.type.slice(c.type.lastIndexOf('.') + 1)}</b> <span class="lv-dim">{c.message}</span>
                  </li>
                ))}
              </ol>
            )}
            <pre class="lv-pre lv-stack">
              {stack.split('\n').map((line) => (
                <div class={isFrameworkFrame(line) ? 'lv-dim' : /^\s*at /.test(line) ? 'lv-app-frame' : 'lv-exc-line'}>{line}</div>
              ))}
            </pre>
          </section>
        )}

        <section>
          <h3>Fields</h3>
          <dl class="lv-fields">
            {!e.tsInherited && (
              <>
                <dt>Time</dt>
                <dd>
                  {formatFull(e.tsMs, e.tsNanos, 'utc')}
                  <br />
                  <span class="lv-dim">{formatFull(e.tsMs, e.tsNanos, 'local')} (local)</span>
                </dd>
              </>
            )}
            {props.source && (
              <>
                <dt>Source</dt>
                <dd>
                  <i class="lv-dot" style={{ background: props.source.color }} /> {props.source.label}, line {e.lineNo}
                </dd>
              </>
            )}
            {e.logger && (
              <>
                <dt>Logger</dt>
                <dd>
                  <button type="button" class="lv-link" title="Show only this logger" onClick={() => props.onFilterLogger(e.logger)}>
                    {e.logger}
                  </button>
                </dd>
              </>
            )}
            {e.thread && (
              <>
                <dt>Thread</dt>
                <dd>{e.thread}</dd>
              </>
            )}
            {!Number.isNaN(e.seq) && (
              <>
                <dt>Sequence</dt>
                <dd>{e.seq}</dd>
              </>
            )}
            {e.traceId && !(mdc && Object.values(mdc).includes(e.traceId)) && (
              <>
                <dt>Trace / correlation</dt>
                <dd>
                  <button type="button" class="lv-link" onClick={() => props.onFilterTrace(e.traceId)}>{e.traceId}</button>
                </dd>
              </>
            )}
            {mdc &&
              Object.entries(mdc).map(([k, v]) => (
                <>
                  <dt>mdc.{k}</dt>
                  <dd>
                    {v === e.traceId ? (
                      <button type="button" class="lv-link" title="Show all related entries" onClick={() => props.onFilterTrace(String(v))}>
                        {String(v)}
                      </button>
                    ) : typeof v === 'string' && v.length >= 8 ? (
                      <button type="button" class="lv-link" title="Search for this value" onClick={() => props.onSearch(v)}>
                        {v}
                      </button>
                    ) : (
                      fieldText(v)
                    )}
                  </dd>
                </>
              ))}
            {others.map(([k, v]) => (
              <>
                <dt>{k}</dt>
                <dd>{fieldText(v)}</dd>
              </>
            ))}
          </dl>
        </section>

        <section>
          <details>
            <summary>{e.json ? 'Raw JSON' : 'Raw line'}</summary>
            {e.json ? <JsonView value={e.json} /> : <pre class="lv-pre lv-wrap">{e.raw}</pre>}
          </details>
        </section>
      </div>
    </aside>
  );
}
