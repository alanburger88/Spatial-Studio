import { useRef } from 'react';
import { Tech } from '../../ui/common';
import type { Rec } from './explorerModel';

/** The customer as formatted JSON in a monospace editor, with line numbers. The studio's own fields are shown above, greyed. */
export function JsonEditor({ text, error, onChange, readOnly, fixed }: { text: string; error: string | null; onChange: (t: string) => void; readOnly: boolean; fixed: Rec }) {
  const gutter = useRef<HTMLPreElement>(null);
  const lines = text.split('\n').length;
  const keys = Object.keys(fixed);
  return (
    <div className="dx-json-wrap">
      <div className="dx-json-fixed" data-testid="dx-json-fixed">
        <span className="dx-json-fixed-title">Kept by the studio, not edited here</span>
        <span className="dx-json-fixed-list">
          {keys.map((k) => {
            const v = fixed[k];
            // Names first: the technical keys only show in Technical view.
            return <span key={k} className="dx-json-fixed-item"><Tech><code>{k}</code> </Tech>{k === 'generated' ? `generated: ${(v as { label?: string })?.label ?? ''}` : k === 'recordId' ? <Tech><code>{String(v)}</code></Tech> : k === 'imported' ? 'imported' : k === 'demonstrationOnly' ? 'demonstration data' : k === 'projectId' ? 'belongs to this document' : k === 'personaId' ? `persona ${String(v)}` : k === 'documentType' ? `${String(v)}` : `${k}: ${String(v)}`}</span>;
          })}
        </span>
      </div>
      <div className={`dx-json-editor${error ? ' bad' : ''}`}>
        <pre className="dx-json-gutter" ref={gutter} aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</pre>
        <textarea className="dx-json" data-testid="dx-json" spellCheck={false} wrap="off" value={text} readOnly={readOnly} aria-label="Customer as JSON" aria-invalid={!!error} aria-describedby={error ? 'dx-json-error' : undefined}
          onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
          onChange={(e) => onChange(e.target.value)} />
      </div>
      {error ? (
        <div className="callout error dx-json-error" id="dx-json-error" role="alert" data-testid="dx-json-error"><strong>This is not valid JSON.</strong> {error} The last valid customer is kept until this is fixed, and Save is off.</div>
      ) : (
        <p className="muted dx-json-hint" data-testid="dx-json-ok">Changes here update the form straight away.</p>
      )}
    </div>
  );
}
