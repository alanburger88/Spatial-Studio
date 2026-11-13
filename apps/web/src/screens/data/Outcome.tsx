import { useMemo } from 'react';
import { dayWords, type Project, type SyntheticRecord } from '@iss/model';
import { formatCents, formatDate, formatNumber, resolve, type CalculatedOutcome, type Finding } from '@iss/resolver';
import { dated, usePreviewDate } from '../../state/store';
import { Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { localeLabel, nodeTitle } from '../../ui/plain';
import { ResolveInBlockers } from '../blockers/link';

export interface Outcome {
  language: string;
  messages: Array<{ nodeId: string; node: string; version: string | null }>;
  sections: Array<{ nodeId: string; node: string; shown: boolean }>;
  blocking: Array<{ code: string; message: string; finding: Finding }>;
  error: string | null;
  /** Only for a document that uses dates: the document's date for this customer, and whether it was given ("As issued on"). */
  documentDate?: { date: string | null; given: boolean } | null;
  /** Only for a document with calculated fields: each value, worked out for this customer (from the engine, never computed here). */
  calculated?: Array<{ key: string; label: string; value: string | null; missing: string | null }>;
}

/** A calculated value as a person reads it, in the document language (the studio's own formatters, never the browser's locale). */
function calcText(c: CalculatedOutcome, locale: string): string | null {
  if (c.value === null || c.value === undefined) return null;
  if (c.type === 'money' && typeof c.value === 'number') return formatCents(c.value, locale);
  if (c.type === 'date' && typeof c.value === 'string') return formatDate(c.value, locale);
  if (c.type === 'number' && typeof c.value === 'number') return formatNumber(c.value, locale);
  if (c.type === 'bool') return c.value ? 'Yes' : 'No';
  return String(c.value);
}

/** What the document does for this customer, worked out in the browser from the (possibly unsaved) model and customer. */
export function computeOutcome(project: Project, record: SyntheticRecord, issueDate: string | null = null): Outcome {
  try {
    const res = resolve({ project, record, ...dated(issueDate) });
    const visible = new Set(res.semanticManifest.visibleNodeIds);
    return {
      language: res.locale,
      messages: Object.entries(res.result.selectedVariants).map(([nodeId, variantId]) => ({
        nodeId, node: nodeTitle(project, nodeId), version: variantId ? project.contentParts.find((c) => c.id === variantId)?.title ?? variantId : null,
      })),
      sections: project.nodes.filter((n) => (n.visibleWhen || n.ruleDriven) && !n.decorative).map((n) => ({ nodeId: n.id, node: nodeTitle(project, n.id), shown: visible.has(n.id) })),
      blocking: res.findings.filter((f) => f.severity === 'blocking').map((f) => ({ code: f.code, message: f.message, finding: f })),
      error: null,
      ...(res.documentDate ? { documentDate: { date: res.documentDate.date, given: res.documentDate.given } } : {}),
      ...(res.calculated ? { calculated: Object.entries(res.calculated).map(([key, c]) => ({ key, label: c.label, value: calcText(c, res.locale), missing: c.missing ? c.missing.message : null })) } : {}),
    };
  } catch (e) {
    return { language: record.customer?.locale ?? '', messages: [], sections: [], blocking: [], error: e instanceof Error ? e.message : 'The document could not be worked out for this customer.' };
  }
}

const signature = (o: Outcome) => JSON.stringify([o.language, o.messages.map((m) => [m.nodeId, m.version]), o.sections.map((s) => [s.nodeId, s.shown]), o.blocking.map((b) => b.code + b.message), o.error, ...(o.calculated ? [o.calculated.map((c) => [c.key, c.value])] : []), ...(o.documentDate ? [o.documentDate.date] : [])]);

/** The right-hand panel: what this customer gets, live, with a marker when it differs from the saved customer. */
export function OutcomePanel({ project, saved, draft, hasProblems, jsonBroken, dirty, recordId, onPreview, previewHint, canPreview }: {
  project: Project; saved: SyntheticRecord; draft: SyntheticRecord; hasProblems: boolean; jsonBroken: boolean; dirty: boolean; recordId: string;
  onPreview: () => void; previewHint: string | null; canPreview: boolean;
}) {
  const issueDate = usePreviewDate();
  const before = useMemo(() => computeOutcome(project, saved, issueDate), [project, saved, issueDate]);
  const now = useMemo(() => (hasProblems ? null : computeOutcome(project, draft, issueDate)), [project, draft, hasProblems, issueDate]);
  const changed = !!now && dirty && signature(now) !== signature(before);
  const diffs = useMemo(() => {
    if (!now || !changed) return [];
    const out: string[] = [];
    for (const m of now.messages) { const was = before.messages.find((b) => b.nodeId === m.nodeId); if ((was?.version ?? null) !== m.version) out.push(`${m.node}: ${was?.version ?? 'none'} → ${m.version ?? 'none'}`); }
    for (const s of now.sections) { const was = before.sections.find((b) => b.nodeId === s.nodeId); if (was && was.shown !== s.shown) out.push(`${s.node}: ${was.shown ? 'shown' : 'hidden'} → ${s.shown ? 'shown' : 'hidden'}`); }
    if (before.language !== now.language) out.push(`Document language: ${localeLabel(before.language)} → ${localeLabel(now.language)}`);
    if (before.blocking.length !== now.blocking.length) out.push(`Blocking issues: ${before.blocking.length} → ${now.blocking.length}`);
    for (const c of now.calculated ?? []) { const was = before.calculated?.find((b) => b.key === c.key); if (was && was.value !== c.value) out.push(`${c.label}: ${was.value ?? 'missing'} → ${c.value ?? 'missing'}`); }
    if (now.documentDate && before.documentDate && now.documentDate.date !== before.documentDate.date) out.push(`The document’s date: ${before.documentDate.date ? dayWords(before.documentDate.date) : 'none'} → ${now.documentDate.date ? dayWords(now.documentDate.date) : 'none'}`);
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
            {now.documentDate && (
              <>
                <h4 className="section-title">The document’s date</h4>
                <p className="dx-lang" data-testid="dx-outcome-date" data-value={now.documentDate.date ?? ''}>
                  {now.documentDate.date ? `${dayWords(now.documentDate.date)}${now.documentDate.given ? ' (as issued on, set for the preview)' : ' (from this customer’s data)'}` : 'None: this customer’s document has no date.'}
                </p>
              </>
            )}
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
            {now.calculated && now.calculated.length > 0 && (
              <>
                <h4 className="section-title">Calculated values</h4>
                <ul className="list-rows dx-msgs" data-testid="dx-outcome-calculated">
                  {now.calculated.map((c) => (
                    <li key={c.key} data-testid={`dx-calc-${c.key}`} data-value={c.value ?? ''}>
                      <span className="dx-msg-node">{c.label}</span>
                      {c.value !== null ? <strong className="dx-msg-version">{c.value}</strong> : <span className="chip warning" title={c.missing ?? undefined}>Missing</span>}
                      {c.value === null && c.missing && <span className="muted dx-calc-why">{c.missing}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h4 className="section-title">Blocking issues</h4>
            {now.blocking.length === 0 ? <p className="muted" data-testid="dx-outcome-ok">None. The document can be issued for this customer.</p> : (
              <ul className="dx-blocking" data-testid="dx-outcome-blocking">{now.blocking.map((b) => <li key={b.code + b.message}><Icon.warning width={14} height={14} aria-hidden="true" /> {b.message} <ResolveInBlockers finding={b.finding} /></li>)}</ul>
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
