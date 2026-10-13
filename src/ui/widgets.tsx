import { Component, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TextPiece } from '../core/filter';
import { TOO_DEEP, safeStringify, visibleControls } from '../core/safeText';
import { jsonTextTokens } from './format';

/**
 * Renders `fallback` instead of letting an error take down the whole viewer (one crafted entry must not
 * break the rest). A new `resetKey` (e.g. another selected entry) tries the children again.
 */
export class ErrorBoundary extends Component<
  { resetKey?: unknown; fallback: (error: Error) => ComponentChildren; children: ComponentChildren },
  { error: Error | null; key: unknown }
> {
  override state = { error: null as Error | null, key: this.props.resetKey };

  static override getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static override getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/** A `<details>` whose content is only built once it is opened. */
export function LazyDetails(props: { summary: ComponentChildren; children: () => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{props.summary}</summary>
      {open && props.children()}
    </details>
  );
}

export function Popover(props: {
  label: ComponentChildren;
  title?: string;
  buttonClass?: string;
  align?: 'left' | 'right';
  children: (close: () => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div class="lv-popover-wrap" ref={ref}>
      <button type="button" class={`lv-btn ${props.buttonClass ?? ''}${open ? ' lv-on' : ''}`} title={props.title} onClick={() => setOpen(!open)}>
        {props.label}
      </button>
      {open && <div class={`lv-popover lv-popover-${props.align ?? 'left'}`}>{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Pieces({ pieces }: { pieces: TextPiece[] }) {
  return <>{pieces.map((p) => (p.hit ? <mark class="lv-hit">{visibleControls(p.text)}</mark> : visibleControls(p.text)))}</>;
}

/** Pretty-printed JSON beyond this many characters is cut until "Show all" (one span per token). */
export const JSON_VIEW_LIMIT = 200_000;

/** `fallback`: shown as plain text when the value is too deeply nested to pretty-print (e.g. the raw line). */
export function JsonView({ value, fallback }: { value: unknown; fallback?: string }) {
  const [all, setAll] = useState(false);
  const pretty = useMemo(() => safeStringify(value, 2), [value]);
  const text = pretty === TOO_DEEP && fallback !== undefined ? fallback : pretty;
  const cut = !all && text.length > JSON_VIEW_LIMIT;
  const tokens = useMemo(() => jsonTextTokens(visibleControls(cut ? text.slice(0, JSON_VIEW_LIMIT) : text)), [text, cut]);
  return (
    <pre class="lv-pre lv-json">
      {tokens.map((t) => (t.kind === 'punct' ? t.text : <span class={`lv-j-${t.kind}`}>{t.text}</span>))}
      {cut && (
        <button type="button" class="lv-btn lv-btn-small lv-show-all" onClick={() => setAll(true)}>
          Show all ({Math.round(text.length / 1024).toLocaleString()} KB)
        </button>
      )}
    </pre>
  );
}

export function CopyButton(props: { label?: string; title?: string; onCopy: () => void }) {
  return (
    <button type="button" class="lv-btn lv-btn-small" title={props.title} onClick={props.onCopy}>
      {props.label ?? 'Copy'}
    </button>
  );
}
