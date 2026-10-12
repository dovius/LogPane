import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TextPiece } from '../core/filter';
import { jsonTokens } from './format';

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
  return <>{pieces.map((p) => (p.hit ? <mark class="lv-hit">{p.text}</mark> : p.text))}</>;
}

export function JsonView({ value }: { value: unknown }) {
  return (
    <pre class="lv-pre lv-json">
      {jsonTokens(value).map((t) => (t.kind === 'punct' ? t.text : <span class={`lv-j-${t.kind}`}>{t.text}</span>))}
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
