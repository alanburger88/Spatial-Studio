import { useEffect, useState } from 'react';
import type { SyntheticRecord } from '@iss/model';
import { summarizeChanges, type ChangeSummary } from '@iss/scenarios';
import { Loading } from '../../ui/common';
import type { SideData } from './SideBySide';

/**
 * Part 3: what changed in the document between the two versions (the studio's own change summary), so a visible
 * difference can be traced to the edit that caused it. Worked out only when opened: it resolves every customer twice.
 */
export function DocChanges({ before, after, records }: { before: SideData; after: SideData; records: SyntheticRecord[] }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ summary: ChangeSummary } | { error: string } | null>(null);
  useEffect(() => {
    setState(null);
    if (!open) return;
    const t = window.setTimeout(() => {
      try { setState({ summary: summarizeChanges(before.project, after.project, records, { issueDate: after.issueDate ?? before.issueDate ?? null }) }); }
      catch (e) { setState({ error: e instanceof Error ? e.message : String(e) }); }
    }, 30);
    return () => window.clearTimeout(t);
  }, [open, before.project, after.project, before.issueDate, after.issueDate, records]);

  return (
    <details className="cmp-doc" data-testid="cmp-doc-changes" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary><span className="section-title">What changed in the document</span></summary>
      {open && !state && <Loading label="Working out what changed…" />}
      {state && 'error' in state && <div className="callout error" role="alert">The summary could not be worked out: {state.error}</div>}
      {state && 'summary' in state && <Summary s={state.summary} />}
    </details>
  );
}

function Summary({ s }: { s: ChangeSummary }) {
  const none = s.headline === 'No changes' && s.sections.length === 0;
  return (
    <div className="cmp-doc-body" data-testid="cmp-doc-summary" data-changes={none ? 'none' : 'some'}>
      <p><strong data-testid="cmp-doc-headline">{s.headline}</strong></p>
      {s.attention.length > 0 && (
        <div>
          <div className="cmp-sub">Look at first</div>
          <ol>{s.attention.map((a, k) => <li key={k}>{a}</li>)}</ol>
        </div>
      )}
      {s.sections.map((sec) => (
        <details key={sec.area} className="cmp-doc-section" data-area={sec.area} open>
          <summary><span>{sec.title}</span> <span className="chip count">{sec.items.length}</span></summary>
          <ul>{sec.items.map((it, n) => <li key={n}>{it}</li>)}</ul>
        </details>
      ))}
    </div>
  );
}
