import { useEffect, useRef, useState } from 'preact/hooks';

export function AddSourceDialog(props: {
  canFetchUrls: boolean;
  onFiles: (files: File[]) => void;
  onUrls: (urls: string[]) => void;
  onPaste: (text: string) => void;
  onClose: () => void;
}) {
  const [urls, setUrls] = useState('');
  const [pasted, setPasted] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const firstRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const submit = () => {
    const list = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
    if (list.length) props.onUrls(list);
    if (pasted.trim()) props.onPaste(pasted);
    props.onClose();
  };

  return (
    <div class="lv-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="lv-modal" role="dialog" aria-label="Add log" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
        <h2>Add log</h2>
        <p class="lv-dim">Added logs are merged with the current ones by timestamp, so you can follow one traceId across services.</p>

        <div
          class={`lv-dropzone${dragOver ? ' lv-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(false);
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length) {
              props.onFiles(files);
              props.onClose();
            }
          }}
        >
          Drop .log files here or{' '}
          <button type="button" class="lv-link" onClick={() => fileRef.current?.click()}>
            choose files
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept=".log,.txt,.json,.jsonl,.ndjson,text/plain,application/json"
            onChange={(e) => {
              const files = Array.from((e.currentTarget as HTMLInputElement).files ?? []);
              if (files.length) {
                props.onFiles(files);
                props.onClose();
              }
            }}
          />
        </div>

        {props.canFetchUrls && (
          <label class="lv-field">
            <span>Raw log URLs (one per line). Console pod-log page URLs are converted automatically.</span>
            <textarea
              ref={firstRef}
              class="lv-input"
              rows={3}
              spellcheck={false}
              placeholder="https://console-openshift-console.apps…/api/kubernetes/api/v1/namespaces/<ns>/pods/<pod>/log?container=<c>"
              value={urls}
              onInput={(e) => setUrls((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </label>
        )}

        <label class="lv-field">
          <span>…or paste log text</span>
          <textarea
            ref={props.canFetchUrls ? undefined : firstRef}
            class="lv-input"
            rows={4}
            spellcheck={false}
            value={pasted}
            onInput={(e) => setPasted((e.currentTarget as HTMLTextAreaElement).value)}
          />
        </label>

        <div class="lv-modal-actions">
          <button type="button" class="lv-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" class="lv-btn lv-primary" disabled={!urls.trim() && !pasted.trim()} onClick={submit}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
