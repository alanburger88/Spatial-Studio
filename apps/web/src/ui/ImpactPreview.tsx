import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@iss/model';
import { impactOf, type Impact, type ImpactChange } from '@iss/scenarios';
import { indexTree } from '@iss/resolver';
import { usePreviewDate, useScenarioEngine, useStudio } from '../state/store';
import { Tech, Biz } from './common';
import { nodeTitle } from './plain';
import './ImpactPreview.css';

const DEBOUNCE_MS = 250;

/** Debounced impact of a proposed model change over every record of the project's document type. */
export function useImpact(before: Project | null, after: Project | null): { impact: Impact | null; pending: boolean; ms: number | null } {
  const records = useStudio((s) => s.records);
  const issueDate = usePreviewDate();
  const [state, setState] = useState<{ impact: Impact | null; ms: number | null; for: unknown }>({ impact: null, ms: null, for: null });
  useEffect(() => {
    if (!before || !after) return;
    const h = setTimeout(() => {
      const t0 = performance.now();
      const impact = impactOf(before, after, records, issueDate);
      setState({ impact, ms: Math.round(performance.now() - t0), for: after });
    }, DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [before, after, records, issueDate]);
  const current = state.for === after && !!after;
  return { impact: current ? state.impact : null, pending: !!after && !current, ms: current ? state.ms : null };
}

const people = (p: Project, n: number) => `${n === 1 ? '1' : n} ${p.documentType === 'eob' ? (n === 1 ? 'member' : 'members') : (n === 1 ? 'customer' : 'customers')}`;

interface Group { key: string; change: ImpactChange; records: Array<{ id: string; name: string }> }

function groupChanges(impact: Impact): Group[] {
  const map = new Map<string, Group>();
  for (const rec of impact.changed) for (const c of rec.changes) {
    const key = `${c.kind}|${c.nodeId}|${c.before}|${c.after}`;
    let g = map.get(key);
    if (!g) { g = { key, change: c, records: [] }; map.set(key, g); }
    g.records.push({ id: rec.recordId, name: rec.name });
  }
  return [...map.values()].sort((a, b) => b.records.length - a.records.length || a.key.localeCompare(b.key));
}

function describe(c: ImpactChange, before: Project, after: Project): string {
  const t = (p: Project, id: string) => (id ? id.split(', ').map((v) => nodeTitle(p, v)).join(' + ') : 'nothing chosen');
  switch (c.kind) {
    case 'variant': return `${nodeTitle(after, c.nodeId)}: ${t(before, c.before)} → ${t(after, c.after)}`;
    case 'section': return `${nodeTitle(after, c.nodeId)}: ${c.before === 'shown' ? 'shown' : 'hidden'} → ${c.after === 'shown' ? 'shown' : 'hidden'}`;
    case 'locale': return `Language: ${c.before} → ${c.after}`;
    case 'blocking': return c.after ? `New blocking issue${c.nodeId ? ` in ${nodeTitle(after, c.nodeId)}` : ''}` : `Blocking issue resolved${c.nodeId ? ` in ${nodeTitle(before, c.nodeId)}` : ''}`;
  }
}

const MAX_CHIPS = 12;

function Row({ g, before, after }: { g: Group; before: Project; after: Project }) {
  const [all, setAll] = useState(false);
  const shown = all ? g.records : g.records.slice(0, MAX_CHIPS);
  const go = (id: string) => useStudio.getState().setRecord(id);
  const isBlock = g.change.kind === 'blocking';
  return (
    <li className={`imp-row ${isBlock && g.change.after ? 'bad' : ''}`} data-testid="impact-row">
      <div className="imp-row-head">
        <span className="imp-row-text">{describe(g.change, before, after)}</span>
        <Tech>{g.change.kind === 'blocking' && <span className="mono imp-code">{g.change.after || g.change.before}</span>}</Tech>
        <span className="imp-count"> — {people(after, g.records.length)}</span>
      </div>
      <div className="imp-chips">
        {shown.map((r) => (
          <button key={r.id} type="button" className="imp-chip" onClick={() => go(r.id)} title={`${r.name} (${r.id}) — open this record`}>
            <Biz>{r.name}</Biz><Tech><span className="mono">{r.id}</span></Tech>
          </button>
        ))}
        {g.records.length > MAX_CHIPS && !all && <button type="button" className="imp-more" onClick={() => setAll(true)}>+{g.records.length - MAX_CHIPS} more</button>}
      </div>
    </li>
  );
}

/** Before-you-apply preview: exactly which customers' documents change, derived from the real resolver. */
export function ImpactPreview({ before, after, className }: { before: Project; after: Project; className?: string }) {
  const { impact, pending, ms } = useImpact(before, after);
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => (impact ? groupChanges(impact) : []), [impact]);
  if (!impact) return <div className={`imp ${className ?? ''}`} data-testid="impact-preview" aria-busy={pending}><div className="imp-summary muted" data-testid="impact-summary" role="status">Checking every customer…</div></div>;
  const n = impact.changed.length;
  const none = n === 0 && impact.newBlocking === 0;
  return (
    <div className={`imp ${n ? 'has-changes' : ''} ${className ?? ''}`} data-testid="impact-preview" aria-busy={pending}>
      <div className="imp-summary" data-testid="impact-summary" role="status">
        {none ? <span className="imp-none">No synthetic {after.documentType === 'eob' ? "member's" : "customer's"} document changes</span>
          : <strong>Changes {n} of {impact.evaluated} synthetic {after.documentType === 'eob' ? 'members' : 'customers'}</strong>}
        {impact.newBlocking > 0 && <span className="imp-bad">+{impact.newBlocking} new blocking issue{impact.newBlocking === 1 ? '' : 's'}</span>}
        {impact.resolvedBlocking > 0 && <span className="imp-good">{impact.resolvedBlocking} blocking issue{impact.resolvedBlocking === 1 ? '' : 's'} resolved</span>}
        <Tech>{ms !== null && <span className="muted mono imp-ms">{impact.evaluated}×2 resolves · {ms} ms</span>}</Tech>
        {groups.length > 0 && <button type="button" className="btn sm ghost imp-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Hide details' : 'Show details'}</button>}
      </div>
      {open && groups.length > 0 && (
        <ul className="imp-list" aria-label="What changes">
          {groups.map((g) => <Row key={g.key} g={g} before={before} after={after} />)}
        </ul>
      )}
    </div>
  );
}

/** "Shown to 7 of 70 customers": real resolution of every record against the current model. */
export function ReachLine({ nodeId, variantId, testId = 'impact-reach' }: { nodeId: string; variantId?: string; testId?: string }) {
  const engine = useScenarioEngine();
  const data = useMemo(() => {
    if (!engine) return null;
    const sc = engine.universe();
    let n = 0;
    for (const s of sc) {
      const node = indexTree(engine.resolveScenario(s).root).get(nodeId);
      if (variantId ? node?.variants?.selected.includes(variantId) : node?.visible) n++;
    }
    return { n, total: sc.length };
  }, [engine, nodeId, variantId]);
  if (!data) return null;
  const word = engine!.project.documentType === 'eob' ? 'members' : 'customers';
  return <p className="imp-reach" data-testid={testId}>{data.n === 0 ? <>Not shown to any of the {data.total} synthetic {word} right now</> : <>Shown to <strong>{data.n} of {data.total} synthetic</strong> {word}</>}</p>;
}
