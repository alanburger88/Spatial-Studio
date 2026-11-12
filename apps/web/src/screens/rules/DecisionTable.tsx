import { useMemo, useState } from 'react';
import type { Predicate, Project, Rule, Scalar, SyntheticRecord } from '@iss/model';
import { ADDON_GROUP, analyseDecisionTable, decisionGroups, groupRules, termsOnField, type Combo, type DecisionTableAnalysis } from '@iss/scenarios';
import { describePredicate } from '@iss/resolver';
import { useStudio } from '../../state/store';
import { Empty, Tech, Biz } from '../../ui/common';
import { actionSentence, fieldLabel, nodeTitle, predicateSentence } from '../../ui/plain';
import './DecisionTable.css';

const SYM: Record<string, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

function plainValue(v: unknown): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v === null || v === undefined) return 'empty';
  return String(v).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
}

/** One condition on one field, in plain words ("≥ 2", "is yes") or raw (`≥ 2`, `= true`). */
function termText(project: Project, t: Predicate, tech: boolean): string {
  if ('args' in t || t.op === 'not') return tech ? describePredicate(t) : predicateSentence(project, t);
  if (tech) {
    if (t.op === 'in') return `in [${t.value.join(', ')}]`;
    if (t.op === 'isNull') return 'is null';
    if (t.op === 'notNull') return 'not null';
    return `${SYM[t.op]} ${JSON.stringify((t as { value: Scalar }).value)}`;
  }
  switch (t.op) {
    case 'in': return `one of ${t.value.map(plainValue).join(', ')}`;
    case 'isNull': return 'is empty';
    case 'notNull': return 'is present';
    case 'eq': return typeof t.value === 'string' ? `is “${plainValue(t.value)}”` : `is ${plainValue(t.value)}`;
    case 'ne': return typeof t.value === 'string' ? `is not “${plainValue(t.value)}”` : `is not ${plainValue(t.value)}`;
    default: return `${SYM[t.op]} ${(t as { value: Scalar }).value}`;
  }
}

function outcomeText(project: Project, r: Rule, tech: boolean): string {
  const a = r.then;
  if (tech) return a.op === 'selectVariant' ? `selectVariant → ${a.variantId}` : a.op === 'showSection' ? `showSection → ${a.targetNodeId}` : a.op === 'requireNodes' ? `requireNodes → ${a.nodeIds.join(', ')}` : a.op === 'setApprovedLocale' ? `setApprovedLocale → ${a.locale}` : `setPresentationHint → ${a.hint}`;
  if (a.op === 'selectVariant') return nodeTitle(project, a.variantId);
  const s = actionSentence(project, r);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A possible combination in words. */
export function comboText(project: Project, c: Combo, tech: boolean): string {
  return Object.entries(c).map(([path, v]) => (tech ? `${path} = ${JSON.stringify(v)}` : predicateSentence(project, { op: 'eq', path, value: v as Scalar }))).join(' · ');
}

function IssueLinks({ ids, onOpen, project }: { ids: string[]; onOpen: (id: string) => void; project: Project }) {
  return (
    <>{ids.map((id) => {
      const r = project.rules.find((x) => x.id === id);
      return <button key={id} type="button" className="rdt-link" data-testid={`dt-link-${id}`} onClick={() => onOpen(id)} title={r?.title ? `${r.title} — open in editor` : 'Open in editor'}>
        <span className="mono">{id}</span>{r?.title && <Biz><span> {r.title}</span></Biz>}
      </button>;
    })}</>
  );
}

function Analysis({ project, a, onOpen }: { project: Project; a: DecisionTableAnalysis; onOpen: (id: string) => void }) {
  const tech = useStudio((s) => s.viewMode) === 'technical';
  const ex = (c: Combo) => comboText(project, c, tech);
  const clean = !a.overlaps.length && !a.shadowed.length && !a.gaps.possible && !a.gaps.recordIds.length;
  const gapRecs = a.gaps.recordIds.length;
  return (
    <section className="rdt-analysis" aria-label="Gap and overlap analysis" data-testid="dt-analysis">
      <div className="rdt-an-head">
        <strong>Checks</strong>
        <span className="muted"> — <em>seen in {a.evaluated} synthetic records</em> and <em>possible combinations</em> ({a.domainSize}{a.domainCapped ? '+' : ''} generated from the fields below)</span>
      </div>
      {clean && <p className="rdt-ok" data-testid="dt-clean">✔ No ties, shadowed rules or gaps found.</p>}
      {a.overlaps.map((o) => (
        <div key={o.ruleIds.join('+')} className="rdt-issue bad" role="alert" data-testid="dt-overlap">
          <div><strong>⚠ Blocking tie.</strong> <IssueLinks ids={o.ruleIds} onOpen={onOpen} project={project} /> can both match at the same priority<Tech><span className="mono"> (P{o.priority})</span></Tech>, so no winner can be chosen.</div>
          <div className="rdt-basis">
            <span className="chip">Seen in synthetic records: {o.recordIds.length ? `${o.recordIds.length} of ${a.evaluated}` : 'none'}</span>
            {o.recordIds.length > 0 && <span className="muted mono rdt-ids" title={o.recordIds.join(', ')}>{o.recordIds.slice(0, 4).join(', ')}{o.recordIds.length > 4 ? '…' : ''}</span>}
          </div>
          {o.example && <div className="rdt-basis"><span className="chip info">Possible combination</span><span>{ex(o.example)}</span></div>}
        </div>
      ))}
      {a.shadowed.map((s) => (
        <div key={s.ruleId} className="rdt-issue warn" data-testid="dt-shadowed">
          <div><strong>Never wins.</strong> <IssueLinks ids={[s.ruleId]} onOpen={onOpen} project={project} /> always has a higher-priority rule matching too ({' '}<IssueLinks ids={s.beatenBy} onOpen={onOpen} project={project} />).</div>
          <div className="rdt-basis"><span className="chip">Seen in synthetic records: matches {s.matchesInRecords}, wins 0</span><span className="chip info">Possible combinations: matches {s.matchesInDomain}, wins 0</span></div>
        </div>
      ))}
      {(a.gaps.possible > 0 || gapRecs > 0) && (
        <div className={`rdt-issue ${a.gaps.blocking ? 'bad' : 'info'}`} role={a.gaps.blocking ? 'alert' : undefined} data-testid="dt-gap">
          <div><strong>{a.gaps.blocking ? '⚠ Blocking gap.' : 'Gap (informational).'}</strong> {a.gaps.blocking ? 'Some situations match no rule and there is no fallback, so nothing is chosen.' : `Some situations match no rule, so the fallback “${a.fallbackVariantId ? nodeTitle(project, a.fallbackVariantId) : ''}” applies.`}</div>
          <div className="rdt-basis"><span className="chip">Seen in synthetic records: {gapRecs ? `${gapRecs} of ${a.evaluated}` : 'none'}</span><span className="chip info">Possible combinations: {a.gaps.possible} of {a.domainSize}{a.domainCapped ? '+' : ''}</span></div>
          {a.gaps.examples.length > 0 && (
            <details className="rdt-ex"><summary>Show {Math.min(a.gaps.examples.length, 6)} example combination{a.gaps.examples.length === 1 ? '' : 's'}</summary>
              <ul>{a.gaps.examples.map((c, i) => <li key={i} data-testid="dt-gap-example">{ex(c)}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

/** Decision-table view: one exclusive group (or the independent add-ons) as rules × conditions × outcome. */
export function DecisionTable({ project, records, onOpenRule }: { project: Project; records: SyntheticRecord[]; onOpenRule: (ruleId: string) => void }) {
  const tech = useStudio((s) => s.viewMode) === 'technical';
  const groups = useMemo(() => decisionGroups(project), [project]);
  const [pick, setPick] = useState('payment-guidance');
  const groupId = groups.some((g) => g.id === pick) ? pick : groups[0]?.id ?? '';
  const a = useMemo(() => (groupId ? analyseDecisionTable(project, groupId, records) : null), [project, groupId, records]);
  const rules = useMemo(() => (groupId ? groupRules(project, groupId) : []), [project, groupId]);
  if (!groups.length || !a) return <section className="panel rdt" data-testid="view-table"><Empty title="No rules to tabulate" message="This project has no exclusive or add-on rules yet." /></section>;

  const word = project.documentType === 'eob' ? 'members' : 'customers';
  const addons = a.kind === 'addons';
  const tied = new Set(a.overlaps.flatMap((o) => o.ruleIds));
  const shadow = new Set(a.shadowed.map((s) => s.ruleId));
  const label = (id: string) => (id === ADDON_GROUP ? 'Add-on rules' : nodeTitle(project, id));
  const nCols = 3 + a.fields.length + 1;

  return (
    <section className="panel rdt" data-testid="view-table" aria-label="Decision table">
      <div className="panel-head">
        <label htmlFor="dt-group" className="rdt-grouplbl">Rule group</label>
        <select id="dt-group" className="select rdt-group" value={groupId} onChange={(e) => setPick(e.target.value)} data-testid="dt-group">
          {groups.map((g) => <option key={g.id} value={g.id}>{label(g.id)}{tech && g.id !== ADDON_GROUP ? ` (${g.id})` : ''} — {g.ruleIds.length} rules</option>)}
        </select>
        <span className="sub">{addons ? 'Independent: every matching add-on applies.' : 'Highest priority wins.'}</span>
      </div>
      <div className="rdt-scroll">
        {!addons && <Analysis project={project} a={a} onOpen={onOpenRule} />}
        {addons && <p className="hint rdt-note">Add-ons apply independently, so there are no ties or gaps to analyse. Counts show how many synthetic {word} each add-on currently applies to.</p>}
        <table className="table rdt-table" data-testid="dt-table">
          <caption className="rd-sr">{label(groupId)} decision table: one row per rule{addons ? '' : ', highest priority first'}.</caption>
          <thead>
            <tr>
              <th scope="col" className="rdt-rank">{addons ? '#' : 'Order'}</th>
              <th scope="col">Rule</th>
              {a.fields.map((f) => <th scope="col" key={f} className="rdt-fld"><span className="rdt-fld-l">{tech ? <span className="mono">{f.replace(/\./g, '.\u200b')}</span> : fieldLabel(project, f)}</span></th>)}
              <th scope="col">Outcome</th>
              <th scope="col" className="num">{addons ? 'Applies to' : 'Wins'}<span className="rdt-sub">synthetic {word}</span></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => {
              const off = r.enabled === false;
              const below = rules.length - 1 - i;
              return (
                <tr key={r.id} className={`rowlink ${off ? 'rdt-off' : ''} ${tied.has(r.id) ? 'rdt-bad' : ''}`} data-testid="dt-row" data-rule-id={r.id} onClick={() => onOpenRule(r.id)}>
                  <td className="rdt-rank">
                    {addons ? i + 1 : <><strong>{i + 1}</strong>{below > 0 && <span className="rdt-beats"><Biz>wins over {below === 1 ? '1 rule' : `${below} rules`} below</Biz><Tech>P{r.priority}</Tech></span>}{below === 0 && <Tech><span className="rdt-beats">P{r.priority}</span></Tech>}</>}
                  </td>
                  <td className="rdt-rule">
                    <button type="button" className="rdt-open" data-testid={`dt-open-${r.id}`} onClick={(e) => { e.stopPropagation(); onOpenRule(r.id); }} title={`Open ${r.id} in the editor`}>
                      <span className="mono rd-rule-id">{r.id}</span> <span className="rdt-title">{r.title || outcomeText(project, r, false)}</span>
                    </button>
                    <span className="rdt-flags">
                      {off && <span className="chip warning">Off</span>}
                      {tied.has(r.id) && <span className="chip error">⚠ Tie</span>}
                      {shadow.has(r.id) && <span className="chip warning">Never wins</span>}
                    </span>
                  </td>
                  {a.fields.map((f) => {
                    const terms = termsOnField(r, f);
                    return <td key={f} className={`rdt-cell ${terms.length ? '' : 'any'}`} data-testid="dt-cell">{terms.length ? terms.map((t, k) => <span key={k} className={tech ? 'mono' : ''}>{k > 0 && ' and '}{termText(project, t, tech)}</span>) : <span className="muted">any</span>}</td>;
                  })}
                  <td className="rdt-out" title={outcomeText(project, r, false)}>{outcomeText(project, r, tech)}</td>
                  <td className="num rdt-wins" data-testid="dt-wins"><strong>{a.wins[r.id] ?? 0}</strong> <span className="muted">of {a.evaluated}</span></td>
                </tr>
              );
            })}
            {!addons && (
              <tr className={`rdt-fallback ${a.fallbackVariantId ? '' : 'rdt-bad'}`} data-testid="dt-fallback">
                <td className="rdt-rank"><span className="muted">last</span></td>
                <th scope="row" className="rdt-rule">{a.fallbackVariantId ? 'Fallback' : 'No fallback'}</th>
                <td colSpan={Math.max(a.fields.length, 1)} className="muted">{a.fallbackVariantId ? 'Used when none of the rules above match' : 'Nothing is shown when no rule above matches'}</td>
                <td className="rdt-out">{a.fallbackVariantId ? (tech ? a.fallbackVariantId : nodeTitle(project, a.fallbackVariantId)) : <span>⚠ Blocking when it happens</span>}</td>
                <td className="num rdt-wins"><strong>{a.fallbackVariantId ? a.fallbackWins : a.unresolved}</strong> <span className="muted">of {a.evaluated}</span></td>
              </tr>
            )}
          </tbody>
          {!addons && a.unresolved > 0 && a.fallbackVariantId && <tfoot><tr><td colSpan={nCols} className="rdt-foot">⚠ {a.unresolved} synthetic {word} resolve to no message (blocking tie).</td></tr></tfoot>}
        </table>
      </div>
    </section>
  );
}
