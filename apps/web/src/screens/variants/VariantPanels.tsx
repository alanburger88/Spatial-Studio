import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBaseAgain as baseValueAgain, VARIANT_GROUP_LABEL, VARIANT_GROUPS, VARIANT_PURPOSE_LABEL, type Project, type UpdateEntry, type VariantDifference, type VariantGroup } from '@iss/model';
import { ApiFailure, variantApi, type FamilyDto } from '../../api/client';
import { useCan, useIsDirty, useStudio } from '../../state/store';
import { Dialog, Loading } from '../../ui/common';
import { NewVariantDialog } from './NewVariantDialog';
import { useVariant, type VariantState } from './useVariant';
import './variants.css';

/**
 * Variants by brand or region (wave 5) on Overview: for a variant, where it stands (the base it follows, an update
 * available, what differs, detach); for a base, its family. Everything shown is worked out from the working version and
 * the base's saved versions with the pure functions of `@iss/model`; applying anything goes through the command bus as
 * one undoable step, and nothing is saved, approved or released by it.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Stay behind for now" is remembered for this browser session, per variant and base version. */
const stayKey = (p: Project, latest: number) => `iss.variant.stay.${p.projectId}.${latest}`;
const stayed = (k: string) => { try { return sessionStorage.getItem(k) === '1'; } catch { return false; } };

export function VariantOverview({ project }: { project: Project }) {
  if (project.variantOf) return <VariantPanel project={project} />;
  return <FamilyLine project={project} />;
}

/* ------------------------------------------------------------------ a variant */

function VariantPanel({ project }: { project: Project }) {
  const vs = useVariant(project);
  const v = project.variantOf!;
  const canEdit = useCan('edit');
  const [detaching, setDetaching] = useState(false);
  const base = `/studio/${v.projectId}`;
  return (
    <section className="panel vr-panel" aria-labelledby="vr-h" data-testid="variant-panel">
      <div className="panel-head vr-head">
        <h2 className="section-title" id="vr-h">Variant of “{vs.baseTitle ?? v.baseTitle}”</h2>
        <span className="chip variant" data-testid="variant-purpose">{VARIANT_PURPOSE_LABEL[v.purpose]}: {v.label}</span>
        <span className="chip" data-testid="variant-follows">Follows version {v.modelVersion}{vs.latest ? ` of ${vs.latest}` : ''}</span>
        {vs.behind && <span className="chip warning" data-testid="variant-behind">Update available</span>}
        <div className="right row">
          {vs.status !== 'missing' && <Link className="btn sm ghost" to={`${base}/overview`} data-testid="variant-open-base">Open the base</Link>}
          <button type="button" className="btn sm" onClick={() => setDetaching(true)} disabled={!canEdit} data-testid="variant-detach">Detach from the base</button>
        </div>
      </div>
      <div className="panel-body vr-body">
        {vs.status === 'loading' && <Loading label="Comparing with the base…" />}
        {(vs.status === 'missing' || vs.status === 'error') && <p className="callout warning" role="note" data-testid="variant-base-missing">{vs.message}</p>}
        {vs.status === 'ready' && <>
          {vs.update && <UpdateBox project={project} vs={vs} />}
          <Differences project={project} vs={vs} />
        </>}
      </div>
      {detaching && <DetachDialog project={project} onClose={() => setDetaching(false)} />}
    </section>
  );
}

function DetachDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const v = project.variantOf!;
  const detach = () => {
    const r = useStudio.getState().dispatch({ type: 'DETACH_VARIANT' });
    if (r.ok) useStudio.getState().toast({ kind: 'success', title: 'Detached', message: `“${project.title}” is now an ordinary document. Save to keep it that way; Undo brings the link back.` });
    onClose();
  };
  return (
    <Dialog title="Detach from the base?" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger" onClick={detach} data-testid="variant-detach-confirm">Detach</button></>}>
      <p>“{project.title}” stops following “{v.baseTitle}”. Its content does not change, but it becomes an ordinary document for good: it no longer gets updates from the base, its data fields, calculations and page design become its own to change, and it leaves the base’s family.</p>
      <p className="muted">This is a change to the working version, like any other: save it to keep it. Until you save, Undo puts the link back.</p>
    </Dialog>
  );
}

/* ---- the update */

function EntryList({ entries, testId, mode }: { entries: UpdateEntry[]; testId: string; mode: 'in' | 'kept' | 'look' }) {
  if (!entries.length) return <p className="muted vr-none" data-testid={`${testId}-none`}>Nothing.</p>;
  return (
    <ul className="vr-entries list-rows" data-testid={testId}>
      {entries.map((e, i) => (
        <li key={`${e.id}-${i}`} data-id={e.id} className="vr-entry">
          <div className="vr-entry-head"><span className="chip">{VARIANT_GROUP_LABEL[e.group]}</span> <strong>{e.label}</strong>{e.change !== 'changed' && <span className="muted"> · {e.change === 'added' ? 'new in the base' : 'removed from the base'}</span>}</div>
          {mode === 'in' && e.change === 'changed' && <Values a={{ k: 'Base before', v: e.baseBefore }} b={{ k: 'Base now', v: e.baseNow }} />}
          {mode !== 'in' && <Values a={{ k: 'Yours', v: e.yours }} b={{ k: 'Base now', v: e.baseNow }} />}
          {e.note && <p className="vr-note">{e.note}</p>}
        </li>
      ))}
    </ul>
  );
}
function Values({ a, b }: { a: { k: string; v: string | null }; b: { k: string; v: string | null } }) {
  return (
    <dl className="vr-values">
      <div><dt>{a.k}</dt><dd>{a.v ?? <span className="muted">not there</span>}</dd></div>
      <div><dt>{b.k}</dt><dd>{b.v ?? <span className="muted">not there</span>}</dd></div>
    </dl>
  );
}

function UpdateBox({ project, vs }: { project: Project; vs: VariantState }) {
  const u = vs.update!;
  const canEdit = useCan('edit');
  const key = stayKey(project, u.toVersion);
  const [stay, setStay] = useState(() => stayed(key));
  useEffect(() => setStay(stayed(key)), [key]);
  const apply = () => {
    const r = useStudio.getState().dispatch({ type: 'UPDATE_FROM_BASE', project: u.project, label: `Update from “${vs.baseTitle}” (version ${u.fromVersion} to ${u.toVersion})` });
    if (r.ok) useStudio.getState().toast({ kind: 'success', title: 'Update applied', message: `${r.label}. It is in the working version: save to keep it, or Undo.` });
  };
  const stayBehind = () => { try { sessionStorage.setItem(key, '1'); } catch { /* ignore */ } setStay(true); };
  if (stay) {
    return (
      <div className="vr-stay" data-testid="variant-update-stayed">
        <span>Staying on version {u.fromVersion} of the base for now. Version {u.toVersion} is available.</span>
        <button type="button" className="btn sm ghost" onClick={() => { try { sessionStorage.removeItem(key); } catch { /* ignore */ } setStay(false); }} data-testid="variant-update-show">Show the update</button>
      </div>
    );
  }
  return (
    <section className="vr-update" aria-labelledby="vr-up-h" data-testid="variant-update">
      <div className="vr-update-head">
        <h3 id="vr-up-h">Update available: the base has a newer version ({u.fromVersion} → {u.toVersion})</h3>
        <p className="muted">{plural(u.baseChanges.summary.total, 'change')} in the base. Applying the update is one step in the working version: nothing is saved, approved or released by it, and Undo takes it back.</p>
      </div>
      <div className="vr-groups">
        <div className="vr-group"><h4>Comes in <span className="chip count" data-testid="variant-update-in-count">{u.comesIn.length}</span></h4><p className="muted">The base changed it and you had not.</p><EntryList entries={u.comesIn} testId="variant-update-comes-in" mode="in" /></div>
        <div className="vr-group"><h4>Kept as yours <span className="chip count" data-testid="variant-update-kept-count">{u.kept.length}</span></h4><p className="muted">You both changed it: yours stays. The base’s new value is beside it, so you can decide.</p><EntryList entries={u.kept} testId="variant-update-kept" mode="kept" /></div>
        <div className="vr-group"><h4>Needs a look <span className={`chip count${u.needsLook.length ? ' warning' : ''}`} data-testid="variant-update-look-count">{u.needsLook.length}</span></h4><p className="muted">The base removed or reshaped something you changed or added to.</p><EntryList entries={u.needsLook} testId="variant-update-needs-look" mode="look" /></div>
      </div>
      <div className="row wrap vr-actions">
        <Link className="btn" to={`/studio/${project.projectId}/before-after?before=working&after=update`} data-testid="variant-update-see">See what customers will see differently</Link>
        <button type="button" className="btn primary" onClick={apply} disabled={!canEdit} data-testid="variant-update-apply">Apply the update</button>
        <button type="button" className="btn ghost" onClick={stayBehind} data-testid="variant-update-stay">Stay on version {u.fromVersion} for now</button>
      </div>
    </section>
  );
}

/* ---- what differs */

function Differences({ project, vs }: { project: Project; vs: VariantState }) {
  const canEdit = useCan('edit');
  const groups = VARIANT_GROUPS.map((g) => ({ g, items: vs.differences.filter((d) => d.group === g) })).filter((x) => x.items.length);
  const useBase = (d: VariantDifference) => {
    const r = baseValueAgain(project, vs.at!, d.id, { customers: vs.customers });
    const toast = useStudio.getState().toast;
    if ('error' in r) { toast({ kind: 'warning', title: 'Not changed', message: r.error }); return; }
    const done = useStudio.getState().dispatch({ type: 'USE_BASE_AGAIN', project: r.project, label: r.label });
    if (done.ok) toast({ kind: 'success', title: 'The base’s again', message: `${done.label}. Undo takes it back.` });
  };
  return (
    <section className="vr-diffs" aria-labelledby="vr-diff-h" data-testid="variant-differences" data-count={vs.differences.length}>
      <h3 id="vr-diff-h">Differences from the base <span className="chip count">{vs.differences.length}</span></h3>
      {vs.differences.length === 0
        ? <p className="muted" data-testid="variant-no-differences">None yet: this variant is the same as version {vs.follows} of the base. Change its brand, wording, sections, lookup tables or rules, and the differences appear here.</p>
        : groups.map(({ g, items }) => (
          <div key={g} className="vr-diff-group" data-testid={`variant-diff-group-${g}`}>
            <h4>{VARIANT_GROUP_LABEL[g as VariantGroup]} <span className="chip count">{items.length}</span></h4>
            <ul className="list-rows vr-entries">
              {items.map((d) => (
                <li key={d.id} className="vr-entry" data-testid="variant-diff" data-id={d.id}>
                  <div className="vr-entry-head">
                    <strong>{d.label}</strong>
                    {d.kind !== 'changed' && <span className="muted"> · {d.kind === 'added' ? (g === 'sections' ? 'your own' : 'only in this variant') : (g === 'sections' ? 'hidden in this variant' : 'not in this variant')}</span>}
                    <button type="button" className="btn sm ghost right" onClick={() => useBase(d)} disabled={!canEdit} data-testid="variant-use-base">Use the base’s again</button>
                  </div>
                  <Values a={{ k: 'Base', v: d.base }} b={{ k: 'This variant', v: d.variant }} />
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

/* ------------------------------------------------------------------ a base: its family */

/** The family of a document (design rule 10): the base and each variant, what it is for, the base version it follows,
 * whether it is behind, its review state and latest release, and whether its rules differ. */
export function FamilyView({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const [fam, setFam] = useState<FamilyDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const saved = useStudio((s) => s.serverVersion);
  useEffect(() => {
    let live = true;
    variantApi.family(projectId).then((f) => { if (live) { setFam(f); setErr(null); } }, (e) => { if (live) setErr(e instanceof ApiFailure ? e.message : 'The family could not be loaded.'); });
    return () => { live = false; };
  }, [projectId, saved]);
  if (err) return <p className="callout warning" role="note">{err}</p>;
  if (!fam) return <Loading label="Loading the family…" />;
  if (!fam.variants.length) return null;
  const stage = (m: FamilyDto['variants'][number]) => (m.latestRelease ? `Release ${m.latestRelease.number}${m.latestRelease.stage ? ` (${m.latestRelease.stage === 'production' ? 'Production' : 'Test'})` : ''}` : 'None yet');
  const rows = [...(fam.base ? [fam.base] : []), ...fam.variants];
  return (
    <section className={`vr-family${compact ? ' compact' : ''}`} aria-labelledby={`vr-fam-h-${projectId}`} data-testid="variant-family">
      <h3 id={`vr-fam-h-${projectId}`}>Family: the base and its variants</h3>
      <div className="vr-table-wrap">
        <table className="table vr-table">
          <thead><tr><th>Document</th><th>For</th><th>Follows</th><th>Review</th><th>Latest release</th><th>Rules</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.projectId} data-testid="variant-family-row" data-project={m.projectId} aria-current={m.projectId === projectId ? 'true' : undefined}>
                <td><Link to={`/studio/${m.projectId}/overview`}>{m.title}</Link>{m.projectId === projectId && <span className="muted"> (this document)</span>}</td>
                <td>{m.variant ? `${VARIANT_PURPOSE_LABEL[m.variant.purpose]}: ${m.variant.label}` : <span className="chip">Base</span>}</td>
                <td>{m.variant ? <>Version {m.variant.follows}{m.variant.baseMissing ? <span className="chip warning"> base not found</span> : m.variant.behind ? <> <span className="chip warning" data-testid="variant-family-behind">Behind</span></> : <span className="muted"> (up to date)</span>}</> : <>Version {m.modelVersion}</>}</td>
                <td>{m.workflow.replace('_', ' ')}</td>
                <td>{stage(m)}</td>
                <td>{m.variant ? (m.variant.rulesDiffer === null ? '—' : m.variant.rulesDiffer ? <span className="chip info" title="Its rules differ from the base’s: the base’s tests do not prove it">Its own</span> : 'Same as the base') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** On an ordinary document's Overview: its family (when it has variants) and "New variant". */
function FamilyLine({ project }: { project: Project }) {
  const canEdit = useCan('edit');
  const dirty = useIsDirty();
  const [making, setMaking] = useState(false);
  return (
    <section className="panel vr-family-panel" aria-label="Variants" data-testid="variant-family-panel">
      <div className="panel-body">
        <FamilyView projectId={project.projectId} />
        <div className="row wrap vr-new-line">
          <span className="muted">A variant follows this document for a brand or a region, with its own brand, wording, sections, tables and rules.{dirty ? ' It is made from the last saved version.' : ''}</span>
          <button type="button" className="btn sm" onClick={() => setMaking(true)} disabled={!canEdit} data-testid="new-variant">New variant</button>
        </div>
      </div>
      {making && <NewVariantDialog base={{ projectId: project.projectId, title: project.title }} onClose={() => setMaking(false)} />}
    </section>
  );
}
