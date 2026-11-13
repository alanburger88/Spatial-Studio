import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { projectContentDigest } from '@iss/model';
import type { Blocker, BlockerKind, BlockerLink, FixProposal } from '@iss/scenarios';
import { Loading, ScreenHeader } from '../ui/common';
import { Icon } from '../ui/icons';
import { applyAssistCommands } from '../assist/common';
import { useStudio, editBlockedReason } from '../state/store';
import { FixAllButton, FixAllDialog, useSafePlan } from './ValidateCompare';
import { BlockerDetail } from './blockers/BlockerDetail';
import { BlockerList } from './blockers/BlockerList';
import { Summary } from './blockers/Summary';
import { useFullCheck } from './blockers/fullCheck';
import { KIND_LABEL, isKind, plural } from './blockers/labels';
import { useDocumentBlockers, useFixImpacts, type WantedImpact } from './blockers/useBlockers';
import './Blockers.css';

/**
 * Blockers (S17): everything that stops this document being issued, one entry per root cause across every customer,
 * always worked out from the open (possibly unsaved) model. Rules, wording and data are current after every change;
 * pages and PDF/web differences come from the last full check, with its time, and the screen says which is which.
 * Applying a fix goes through the same one-undoable-step path as everywhere else; nothing is applied by this screen alone.
 */
export function Blockers() {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const session = useStudio((s) => s.session);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, current, full } = useDocumentBlockers();
  const readOnly = editBlockedReason(session);
  const base = `/studio/${project.projectId}`;

  const kindParam = params.get('kind');
  const kind: BlockerKind | null = isKind(kindParam) ? kindParam : null;
  const wantedId = params.get('blocker');
  /** `?customer=<id>`: only the blockers that stop this customer (from a blocked batch result or a generated customer). */
  const customerId = params.get('customer');

  const [applied, setApplied] = useState<{ blockerId: string; fixId: string } | null>(null);
  const [appliedIds, setAppliedIds] = useState<string[]>([]);
  const [note, setNote] = useState<{ title: string | null; applied: boolean; next: string | null } | null>(null);
  const [fixAllOpen, setFixAllOpen] = useState(false);
  const asideBody = useRef<HTMLDivElement>(null);

  const blockers = data?.result.blockers ?? [];
  const ofCustomer = customerId ? blockers.filter((b) => b.recordIds.includes(customerId)) : blockers;
  const shown = kind ? ofCustomer.filter((b) => b.kind === kind) : ofCustomer;
  const customerName = (() => { const r = customerId ? records.find((x) => x.recordId === customerId) : undefined; return r ? `${r.customer.givenName} ${r.customer.familyName}` : customerId; })();
  const selected: Blocker | null = blockers.find((b) => b.id === wantedId) ?? shown[0] ?? null;
  useEffect(() => { asideBody.current?.scrollTo?.({ top: 0 }); }, [selected?.id]);

  const setParam = (patch: Record<string, string | null>, replace = true) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace });
  const select = (id: string) => { setNote(null); setApplied(null); setParam({ blocker: id }); };
  const setKind = (k: BlockerKind | null) => setParam({ kind: k });

  /* When the selected blocker disappears (a fix was applied, or the model changed), say so and move to the next one. */
  const prev = useRef<{ ids: string[]; titles: Map<string, string>; selected: string | null } | null>(null);
  useEffect(() => {
    if (!data || !current) return;
    const ids = blockers.map((b) => b.id);
    const was = prev.current;
    const gone = wantedId && !ids.includes(wantedId) ? wantedId : was?.selected && !ids.includes(was.selected) ? was.selected : null;
    if (gone) {
      let next: string | null = null;
      const i = was ? was.ids.indexOf(gone) : -1;
      if (was && i >= 0) next = was.ids.slice(i + 1).find((x) => ids.includes(x)) ?? [...was.ids.slice(0, i)].reverse().find((x) => ids.includes(x)) ?? null;
      setNote({ title: was?.titles.get(gone) ?? null, applied: !!applied && applied.blockerId === gone, next });
      setApplied(null);
      setParam({ blocker: next });
    }
    prev.current = { ids, titles: new Map(blockers.map((b) => [b.id, b.title])), selected: gone ? null : selected?.id ?? null };
  }, [data, current]); // eslint-disable-line react-hooks/exhaustive-deps
  /* A kind with nothing left in it is not a filter any more. */
  useEffect(() => { if (data && current && kind && !blockers.some((b) => b.kind === kind)) setKind(null); }, [data, current, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The full check: what it found, and whether the document has changed since. */
  const digest = useMemo(() => projectContentDigest(project), [project]);
  const modelChanged = full.ranAtMs !== null && full.digest !== digest;
  const checkFindings = useMemo(() => (modelChanged ? [] : full.findings.map((x) => x.finding)), [full.findings, modelChanged]);
  const plan = useSafePlan(checkFindings);
  useEffect(() => { setAppliedIds([]); }, [full.ranAtMs]);

  /* The effect of each fix on every customer: the selected blocker's first, then the best fix of each row. */
  const wanted = useMemo<WantedImpact[]>(() => {
    const out: WantedImpact[] = [];
    if (selected) for (const fix of selected.fixes) out.push({ blocker: selected, fix });
    for (const b of blockers) if (b !== selected && b.fixes[0]) out.push({ blocker: b, fix: b.fixes[0] });
    return out;
  }, [data, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const impactFor = useFixImpacts(project, records, wanted, !!data && current);

  const openLink = (link?: BlockerLink | null) => {
    const l = link ?? selected?.link;
    if (!l) return;
    const st = useStudio.getState();
    if (l.nodeId && project.nodes.some((n) => n.id === l.nodeId)) st.select(l.nodeId);
    if (l.view === 'data') navigate(`${base}/data${l.recordId ? `?customer=${encodeURIComponent(l.recordId)}` : ''}`);
    else navigate(`${base}/${l.view}${l.view === 'rules-data' && l.ruleId ? `?rule=${encodeURIComponent(l.ruleId)}` : ''}`);
  };
  const openData = (recordId: string) => navigate(`${base}/data?customer=${encodeURIComponent(recordId)}`);
  const previewCustomer = (recordId: string) => { useStudio.getState().setRecord(recordId); navigate(`${base}/outputs`); };
  const generate = () => {
    navigate(`${base}/rules-data`);
    let n = 0;
    const t = window.setInterval(() => { const b = document.querySelector<HTMLButtonElement>('[data-testid="testdata-open"]'); if (b) { window.clearInterval(t); b.click(); } else if (++n > 20) window.clearInterval(t); }, 100);
  };

  const apply = (fix: FixProposal) => {
    if (!selected || !fix.commands?.length) return;
    if (applyAssistCommands(fix.commands, fix.title, 'fix', fix.source)) {
      setApplied({ blockerId: selected.id, fixId: fix.id });
      if (selected.speed === 'full-check') setAppliedIds((cur) => [...cur, selected.id]);
    }
  };

  if (!data) {
    return (
      <section className="screen" data-testid="blockers-screen">
        <ScreenHeader id="S17" title="Blockers" subtitle="Everything that stops this document being issued, and how to resolve it." />
        <div className="screen-body"><Loading label="Checking every synthetic customer…" /></div>
      </section>
    );
  }

  const { result } = data;
  const empty = result.blockers.length === 0;
  const unconfirmed = selected ? appliedIds.includes(selected.id) : false;
  return (
    <section className="screen" data-testid="blockers-screen">
      <ScreenHeader id="S17" title="Blockers"
        subtitle="Everything that stops this document being issued, one entry for each cause, across every synthetic customer. Rules, wording and data are checked again after every change; pages and PDF/web differences come from the last full check, with its time." />
      <div className="screen-body bl-body">
        <div className="bl-main" aria-busy={!current}>
          <Summary data={data} current={current} full={full} modelChanged={modelChanged} kind={kind} onKind={setKind}
            onRunFull={() => void useFullCheck.getState().run(project, records)} onCancelFull={() => useFullCheck.getState().cancel(project.projectId)}
            fixAll={<FixAllButton plan={plan} onOpen={() => setFixAllOpen(true)} testId="bl-fix-all-safe" />} />

          {customerId && !empty && (
            <div className="callout accent bl-customer-filter" role="status" data-testid="bl-customer-filter">
              <span>{ofCustomer.length ? <>Showing the {plural(ofCustomer.length, 'blocker')} that stop <strong>{customerName}</strong>.</> : <>No blocker stops <strong>{customerName}</strong> any more.</>}</span>
              <button type="button" className="btn ghost sm" onClick={() => setParam({ customer: null })} data-testid="bl-customer-clear">Show all blockers</button>
            </div>
          )}

          {empty ? (
            <section className="panel bl-empty" data-testid="bl-empty" role="status" aria-label="No blockers">
              <span className="bl-empty-mark" aria-hidden="true">✔</span>
              <h2>Nothing stops this document being issued to any of the {result.checked} synthetic customers checked.</h2>
              <p>A cause that none of these customers reaches is not listed, so this is only as good as the customers: generate test customers to cover every rule, message, language and edge value.</p>
              {full.ranAtMs === null && <p className="muted" data-testid="bl-empty-full">Pages and PDF/web differences have not been checked yet. Run the full check to include them.</p>}
              <div className="row wrap"><button type="button" className="btn" onClick={generate} data-testid="bl-generate"><Icon.plus /> Generate test customers</button></div>
            </section>
          ) : (
            <section className="panel bl-listpanel" aria-label="Blockers">
              <div className="panel-head">{kind ? KIND_LABEL[kind] : 'Blockers'} <span className="sub">{shown.length === blockers.length ? plural(blockers.length, 'cause') : `${shown.length} of ${blockers.length} causes`}</span></div>
              {shown.length === 0 && <p className="muted bl-none-shown">Nothing to show with this filter.</p>}
              <div className="bl-list-scroll">
                <BlockerList blockers={shown} selectedId={selected?.id ?? null} onSelect={select} impactFor={impactFor} totalChecked={result.checked} />
              </div>
            </section>
          )}
        </div>

        <aside className="panel bl-aside" data-side="right" data-side-title="Blocker" data-testid="bl-aside" aria-label="Blocker detail">
          <div className="panel-head">Blocker detail</div>
          <div className="panel-body bl-aside-body" ref={asideBody}>
            {note && (
              <div className="callout accent bl-resolved" role="status" data-testid="bl-resolved">
                <Icon.info width={14} height={14} />
                <span>{note.title ? <><strong>{note.title}</strong> is no longer a blocker.</> : <>That blocker is no longer listed; it may already be fixed.</>}{' '}
                  {note.next ? 'Showing the next one.' : result.blockers.length ? 'Showing the first one.' : 'Nothing else stops this document.'}</span>
                <button type="button" className="btn ghost sm" onClick={() => setNote(null)} aria-label="Dismiss">Dismiss</button>
              </div>
            )}

            {selected ? (
              <BlockerDetail blocker={selected} records={records} personas={personas} impactFor={impactFor} readOnlyReason={readOnly}
                appliedFixId={applied && applied.blockerId === selected.id ? applied.fixId : null}
                onApply={apply} onOpen={openLink} onOpenData={openData} onPreview={previewCustomer} stale={modelChanged}>
                {unconfirmed && <p className="bl-note warn" role="status" data-testid="bl-unconfirmed">A fix was applied. This blocker comes from the full check, so run the full check again to confirm that it is gone.</p>}
              </BlockerDetail>
            ) : (
              <p className="muted" data-testid="bl-detail-empty">{empty ? `Nothing to resolve. All ${result.checked} synthetic customers can be issued the document.` : 'Choose a blocker to see what is wrong and how to fix it.'}</p>
            )}
          </div>
        </aside>
      </div>
      {fixAllOpen && plan.ready && plan.plan?.batch && <FixAllDialog plan={plan.plan} onClose={() => setFixAllOpen(false)} />}
    </section>
  );
}
