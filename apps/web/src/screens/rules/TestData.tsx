import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@iss/model';
import { resolve } from '@iss/resolver';
import { api, type RemovalResult, type TestDataResult, type TestDataTargetDto } from '../../api/client';
import { SourceChip } from '../../assist/common';
import { Dialog, Loading, Tech } from '../../ui/common';
import { localeLabel } from '../../ui/plain';
import { editBlockedReason, useIsDirty, useStudio } from '../../state/store';
import { ResolveCustomerInBlockers } from '../blockers/link';
import './RuleAssist.css';
import './TestData.css';

type Plan = TestDataResult & { existing: number };
type Done = TestDataResult & { generated: number; replaced: number };
type Existing = { count: number; stale: boolean };

const GROUPS: Array<{ id: string; title: string; kinds: TestDataTargetDto['kind'][] }> = [
  { id: 'rules', title: 'Rules', kinds: ['rule'] },
  { id: 'versions', title: 'Message versions', kinds: ['variant'] },
  { id: 'sections', title: 'Sections', kinds: ['section-shown', 'section-hidden'] },
  { id: 'languages', title: 'Document languages', kinds: ['language'] },
  { id: 'edges', title: 'Edge values', kinds: ['edge', 'empty'] },
];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function TestDataDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const blocked = useStudio((s) => editBlockedReason(s.session));
  const dirty = useIsDirty();
  const [outcomes, setOutcomes] = useState(true);
  const [edges, setEdges] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Existing | null>(null);
  const [busy, setBusy] = useState<null | 'generate' | 'clear'>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [tab, setTab] = useState<'customers' | 'covers'>('customers');
  const [confirmClear, setConfirmClear] = useState(false);
  const [removal, setRemoval] = useState<RemovalResult | null>(null);
  const own = project.documentType === 'custom';
  const [showAll, setShowAll] = useState(false);
  const seq = useRef(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const pid = project.projectId;

  const loadExisting = () => api.testData(pid).then((t) => setExisting({ count: t.count, stale: t.stale })).catch(() => setExisting(null));
  useEffect(() => { void loadExisting(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Live preview: debounced, newest request wins.
  useEffect(() => {
    const my = ++seq.current;
    setPlan(null); setPlanError(null);
    const h = setTimeout(() => {
      api.planTestData(pid, { project: projectRef.current, outcomes, edges })
        .then((p) => { if (seq.current === my) setPlan(p); })
        .catch((e) => { if (seq.current === my) setPlanError(e instanceof Error ? e.message : 'The preview could not be computed.'); });
    }, 250);
    return () => clearTimeout(h);
  }, [pid, outcomes, edges]);

  const toggle = (which: 'outcomes' | 'edges') => {
    if (which === 'outcomes') { if (outcomes && !edges) return; setOutcomes(!outcomes); } else { if (edges && !outcomes) return; setEdges(!edges); }
    setDone(null);
  };

  /** Generated customers the document cannot be issued to, worked out from the model on screen. */
  const records = useStudio((s) => s.records);
  const blockedIds = useMemo(() => {
    const out = new Set<string>();
    if (!done) return out;
    for (const c of done.customers) {
      const r = c.recordId ? records.find((x) => x.recordId === c.recordId) : undefined;
      if (r && resolve({ project, record: r }).findings.some((f) => f.severity === 'blocking')) out.add(c.recordId!);
    }
    return out;
  }, [done, records, project]);

  const count = plan?.customers.length ?? 0;
  const unreachable = useMemo(() => (plan?.targets ?? []).filter((t) => t.customer === null), [plan]);
  const shownUnreachable = unreachable.length > 5 && !showAll ? [] : unreachable;
  const existingCount = existing?.count ?? 0;
  const disabledWhy = blocked ?? (plan && count === 0 ? 'Nothing to generate for these options' : null);

  const generate = async () => {
    setBusy('generate'); setError(null);
    try {
      const r = await api.generateTestData(pid, { project: projectRef.current, outcomes, edges });
      await useStudio.getState().refreshRecords();
      setDone(r); setTab('customers'); setConfirmClear(false); setRemoval(null);
      await loadExisting();
    } catch (e) { setError(e instanceof Error ? e.message : 'The customers could not be generated.'); }
    setBusy(null);
  };
  const clear = async () => {
    setBusy('clear'); setError(null);
    try {
      const r = await api.clearTestData(pid);
      await useStudio.getState().refreshRecords();
      setDone(null); setConfirmClear(false); setRemoval(r);
      await loadExisting();
    } catch (e) { setError(e instanceof Error ? e.message : 'The customers could not be removed.'); }
    setBusy(null);
  };
  const preview = (recordId: string) => { useStudio.getState().setCtx({ recordId, overrides: {}, journeyCursor: null }); onClose(); };

  const nameOf = (recordId: string | null) => done?.customers.find((c) => c.recordId === recordId)?.name ?? '';

  const footer = (
    <>
      {existingCount > 0 && (confirmClear ? (
        <span className="td-confirm" role="group" aria-label="Confirm removing the generated customers">
          <span>Remove {plural(existingCount, 'generated customer', 'generated customers')}? {own ? 'Customers you supplied stay, and the document always keeps one customer.' : 'Sample and imported customers stay.'}</span>
          <button type="button" className="btn sm danger" onClick={clear} disabled={busy !== null || !!blocked} data-testid="testdata-clear-confirm">{busy === 'clear' ? 'Removing…' : 'Yes, remove'}</button>
          <button type="button" className="btn sm ghost" onClick={() => setConfirmClear(false)}>Keep them</button>
        </span>
      ) : (
        <button type="button" className="btn sm td-remove" onClick={() => setConfirmClear(true)} disabled={busy !== null || !!blocked} title={blocked ?? 'Remove every generated customer of this document'} data-testid="testdata-clear">Remove generated customers</button>
      ))}
      <button type="button" className="btn ghost" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
      {!done && <button type="button" className="btn primary" onClick={generate} disabled={busy !== null || !plan || !!disabledWhy} title={disabledWhy ?? undefined} data-testid="testdata-generate">
        {busy === 'generate' ? 'Generating…' : `Generate ${plan ? plural(count, 'customer', 'customers') : 'customers'}`}
      </button>}
    </>
  );

  return (
    <Dialog title={<>Generate test customers <SourceChip source="builtin" /></>} onClose={onClose} labelledBy="testdata-title" footer={footer}>
      <div className="ra-wide td-wide" data-testid="testdata-dialog">
        {!done && <p className="td-intro">Make customers for this document only, so every rule, message version, optional section and language is tried. They are marked “Generated” and never touch {own ? 'the customers you supplied' : 'the sample or imported customers'}.{own && ' Generate them again after you change the data fields or the rules.'}</p>}
        <fieldset className="td-options">
          <legend className="sr-only">What to generate</legend>
          <label className="td-opt"><input type="checkbox" checked={outcomes} onChange={() => toggle('outcomes')} aria-disabled={outcomes && !edges} data-testid="testdata-outcomes" />
            <span><strong>Every outcome once</strong><span className="muted"> One customer for each rule, message version, optional section and document language.</span></span></label>
          <label className="td-opt"><input type="checkbox" checked={edges} onChange={() => toggle('edges')} aria-disabled={edges && !outcomes} data-testid="testdata-edges" />
            <span><strong>Edge values</strong><span className="muted"> Just below, exactly on and just above each limit a rule uses, each choice a rule mentions, and an empty value for optional fields.</span></span></label>
          <p className="hint">At least one has to stay on.</p>
        </fieldset>

        {existingCount > 0 && !done && (
          <p className="callout td-existing" data-testid="testdata-existing">
            This document already has {plural(existingCount, 'generated customer', 'generated customers')}. Generating again replaces them.
            {existing?.stale && <strong> The document has changed since they were generated.</strong>}
          </p>
        )}
        {dirty && <p className="callout warning td-unsaved" data-testid="testdata-unsaved">You have unsaved changes. The customers are generated for what is on screen now, not for the last saved version.</p>}

        {!done && (
          <section className="td-plan" aria-live="polite" aria-busy={!plan && !planError} data-testid="testdata-plan">
            {planError ? <p className="callout error" role="alert">{planError}</p>
              : !plan ? <Loading label="Working out which customers are needed…" />
              : (
                <>
                  <p className="ra-summary"><span data-testid="testdata-plan-count">{plural(count, 'customer', 'customers')} would be created</span> <SourceChip source="builtin" /></p>
                  {plan.summary && (
                    <p className="td-sum" data-testid="testdata-plan-summary">
                      {outcomes && <span>Outcomes reached: <b>{plan.summary.outcomes.reached} of {plan.summary.outcomes.total}</b></span>}
                      {edges && <span>Edge values reached: <b>{plan.summary.edges.reached} of {plan.summary.edges.total}</b></span>}
                    </p>
                  )}
                  {plan.summary?.capped && <p className="callout warning" data-testid="testdata-capped">The limit on generated customers was reached, so some were left out.</p>}
                  {unreachable.length > 0 && (
                    <div className="td-unreach" data-testid="testdata-unreachable">
                      <p className="td-sub">{plural(unreachable.length, 'thing', 'things')} no customer can reach</p>
                      {unreachable.length > 5 && <button type="button" className="btn sm" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide them' : `Show the ${unreachable.length} that cannot be reached`}</button>}
                      {shownUnreachable.length > 0 && (
                        <ul className="list-rows">
                          {shownUnreachable.map((t) => (
                            <li key={t.id} className="td-item"><strong>{t.title}</strong>{t.reason && <span className="muted"> · {t.reason}</span>}<Tech> <span className="chip code">{t.targetId}</span></Tech></li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </>
              )}
          </section>
        )}

        {removal && !done && (
          <p className="callout accent" role="status" data-testid="testdata-removed">
            {plural(removal.removed, 'generated customer', 'generated customers')} removed.
            {removal.note && <span data-testid="testdata-kept-note"> {removal.note}</span>}
            {removal.kept && <span data-testid="testdata-kept"> Kept: {removal.kept.name} ({removal.kept.label}).</span>}
          </p>
        )}
        {blocked && <p className="hint" data-testid="testdata-blocked">{blocked}, so customers cannot be generated or removed. You can still see what would be created.</p>}
        {error && <p className="callout error" role="alert" data-testid="testdata-error">{error}</p>}

        {done && (
          <section className="td-done" data-testid="testdata-done">
            <p className="callout accent">{plural(done.generated, 'customer', 'customers')} generated{done.replaced > 0 ? `, replacing ${done.replaced}` : ''}. Pick one in the customer list under “Generated for this document”.</p>
            <div className="tabs" role="tablist" aria-label="Generated customers">
              <button type="button" role="tab" id="td-tab-customers" aria-selected={tab === 'customers'} aria-controls="td-panel" className={tab === 'customers' ? 'active' : ''} onClick={() => setTab('customers')} data-testid="testdata-tab-customers">Customers</button>
              <button type="button" role="tab" id="td-tab-covers" aria-selected={tab === 'covers'} aria-controls="td-panel" className={tab === 'covers' ? 'active' : ''} onClick={() => setTab('covers')} data-testid="testdata-tab-covers">What each one covers</button>
            </div>
            <div id="td-panel" role="tabpanel" aria-labelledby={tab === 'customers' ? 'td-tab-customers' : 'td-tab-covers'}>
              {tab === 'customers' ? (
                <table className="table td-table" data-testid="testdata-customers">
                  <thead><tr><th scope="col">Customer</th><th scope="col">Why it exists</th><th scope="col">Language</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
                  <tbody>
                    {done.customers.map((c, i) => (
                      <tr key={c.recordId ?? i} data-testid="testdata-customer" data-record={c.recordId ?? ''}>
                        <td><strong>{c.name}</strong><Tech> <span className="chip code">{c.recordId}</span></Tech></td>
                        <td>{c.label}</td>
                        <td>{localeLabel(c.locale)}</td>
                        <td>{c.recordId && <button type="button" className="btn sm" onClick={() => preview(c.recordId!)} aria-label={`Preview as ${c.name}`} data-testid="testdata-preview">Preview</button>}{c.recordId && blockedIds.has(c.recordId) && <> <span className="chip error" data-testid="testdata-blocked-customer">Blocked</span> <ResolveCustomerInBlockers recordId={c.recordId} /></>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="td-covers" data-testid="testdata-covers">
                  {GROUPS.map((g) => {
                    const rows = done.targets.filter((t) => g.kinds.includes(t.kind));
                    if (!rows.length) return null;
                    return (
                      <div key={g.id} className="td-group">
                        <h4 className="td-sub">{g.title} <span className="chip count">{rows.length}</span></h4>
                        <ul className="list-rows">
                          {rows.map((t) => (
                            <li key={t.id} className="td-item" data-testid="testdata-target" data-kind={t.kind}>
                              <strong>{t.title}</strong>
                              {t.recordId ? <span className="muted"> · {nameOf(t.recordId)}<Tech> <span className="chip code">{t.recordId}</span></Tech></span> : <span className="muted"> · no customer can reach this{t.reason ? `: ${t.reason}` : ''}</span>}
                              {t.observed && <span className="td-observed" data-testid="testdata-observed">The document: {t.observed}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}
