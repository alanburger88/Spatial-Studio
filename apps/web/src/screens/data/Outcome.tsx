import { useMemo } from 'react';
import type { Project, SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import { Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { localeLabel, nodeTitle } from '../../ui/plain';

export interface Outcome {
  language: string;
  messages: Array<{ nodeId: string; node: string; version: string | null }>;
  sections: Array<{ nodeId: string; node: string; shown: boolean }>;
  blocking: Array<{ code: string; message: string }>;
  error: string | null;
}

/** What the document does for this customer, worked out in the browser from the (possibly unsaved) model and customer. */
export function computeOutcome(project: Project, record: SyntheticRecord): Outcome {
  try {
    const res = resolve({ project, record });
    const visible = new Set(res.semanticManifest.visibleNodeIds);
    return {
      language: res.locale,
      messages: Object.entries(res.result.selectedVariants).map(([nodeId, variantId]) => ({
        nodeId, node: nodeTitle(project, nodeId), version: variantId ? project.contentParts.find((c) => c.id === variantId)?.title ?? variantId : null,
      })),
      sections: project.nodes.filter((n) => (n.visibleWhen || n.ruleDriven) && !n.decorative).map((n) => ({ nodeId: n.id, node: nodeTitle(project, n.id), shown: visible.has(n.id) })),
      blocking: res.findings.filter((f) => f.severity === 'blocking').map((f) => ({ code: f.code, message: f.message })),
      error: null,
    };
  } catch (e) {
    return { language: record.customer?.locale ?? '', messages: [], sections: [], blocking: [], error: e instanceof Error ? e.message : 'The document could not be worked out for this customer.' };
  }
}

const signature = (o: Outcome) => JSON.stringify([o.language, o.messages.map((m) => [m.nodeId, m.version]), o.sections.map((s) => [s.nodeId, s.shown]), o.blocking.map((b) => b.code + b.message), o.error]);

/** The right-hand panel: what this customer gets, live, with a marker when it differs from the saved customer. */
export function OutcomePanel({ project, saved, draft, hasProblems, jsonBroken, dirty, recordId, onPreview, previewHint, canPreview }: {
  project: Project; saved: SyntheticRecord; draft: SyntheticRecord; hasProblems: boolean; jsonBroken: boolean; dirty: boolean; recordId: string;
  onPreview: () => void; previewHint: string | null; canPreview: boolean;
}) {
  const before = useMemo(() => computeOutcome(project, saved), [project, saved]);
  const now = useMemo(() => (hasProblems ? null : computeOutcome(project, draft)), [project, draft, hasProblems]);
  const changed = !!now && dirty && signature(now) !== signature(before);
  const diffs = useMemo(() => {
    if (!now || !changed) return [];
    const out: string[] = [];
    for (const m of now.messages) { const was = before.messages.find((b) => b.nodeId === m.nodeId); if ((was?.version ?? null) !== m.version) out.push(`${m.node}: ${was?.version ?? 'none'} → ${m.version ?? 'none'}`); }
    for (const s of now.sections) { const was = before.sections.find((b) => b.nodeId === s.nodeId); if (was && was.shown !== s.shown) out.push(`${s.node}: ${was.shown ? 'shown' : 'hidden'} → ${s.shown ? 'shown' : 'hidden'}`); }
    if (before.language !== now.language) out.push(`Document language: ${localeLabel(before.language)} → ${localeLabel(now.language)}`);
    if (before.blocking.length !== now.blocking.length) out.push(`Blocking issues: ${before.blocking.length} → ${now.blocking.length}`);
    return out;
  }, [now, before, changed]);

  return (
    <aside className="panel dx-right" data-side="right" data-side-title="What they get" data-testid="dx-outcome" aria-label="What this customer gets">
      <div className="panel-head">What this customer gets
        {changed && <span className="right"><span className="chip warning" data-testid="dx-outcome-changed">Changed since last save</span></span>}
      </div>
      <div className="panel-body dx-outcome-body">
        {hasProblems ? (
          <p className="callout warning" data-testid="dx-outcome-blocked">{jsonBroken ? 'The JSON cannot be read yet.' : 'Some values do not fit the data fields.'} Fix the values to see the result.</p>
        ) : now && (
          <>
            {changed && diffs.length > 0 && (
              <div className="callout accent dx-diffs" data-testid="dx-outcome-diffs">
                <strong>What changes</strong>
                <ul>{diffs.map((d) => <li key={d}>{d}</li>)}</ul>
              </div>
            )}
            {dirty && !changed && <p className="muted dx-same">Your edits do not change what this customer gets.</p>}
            {now.error && <p className="callout error">{now.error}</p>}
            <h4 className="section-title">Document language</h4>
            <p className="dx-lang" data-testid="dx-outcome-language">{localeLabel(now.language)}</p>
            <h4 className="section-title">Message versions</h4>
            {now.messages.length === 0 ? <p className="muted">This document has no message sets with versions.</p> : (
              <ul className="list-rows dx-msgs" data-testid="dx-outcome-messages">
                {now.messages.map((m) => (
                  <li key={m.nodeId} data-testid={`dx-msg-${m.nodeId}`}>
                    <span className="dx-msg-node">{m.node}</span>
                    <strong className="dx-msg-version">{m.version ?? 'Nothing is shown'}</strong>
                  </li>
                ))}
              </ul>
            )}
            {now.sections.length > 0 && (
              <>
                <h4 className="section-title">Sections that depend on the customer</h4>
                <ul className="list-rows dx-msgs" data-testid="dx-outcome-sections">
                  {now.sections.map((s) => <li key={s.nodeId}><span className="dx-msg-node">{s.node}</span><span className={`chip ${s.shown ? 'accent' : ''}`}>{s.shown ? 'Shown' : 'Hidden'}</span></li>)}
                </ul>
              </>
            )}
            <h4 className="section-title">Blocking issues</h4>
            {now.blocking.length === 0 ? <p className="muted" data-testid="dx-outcome-ok">None. The document can be issued for this customer.</p> : (
              <ul className="dx-blocking" data-testid="dx-outcome-blocking">{now.blocking.map((b) => <li key={b.code + b.message}><Icon.warning width={14} height={14} aria-hidden="true" /> {b.message}</li>)}</ul>
            )}
          </>
        )}
      </div>
      <div className="dx-outcome-foot">
        <button type="button" className="btn primary" data-testid="dx-preview" disabled={!canPreview} title={previewHint ?? 'Open this customer in the design view'} onClick={onPreview}><Icon.eye width={14} height={14} /> Preview this customer</button>
        {previewHint && <span className="muted dx-hint" data-testid="dx-preview-hint">{previewHint}</span>}
        <Tech><span className="dx-id">Record <span className="chip code">{recordId}</span></span></Tech>
      </div>
    </aside>
  );
}
