import { useEffect, useMemo, useState } from 'react';
import { projectFieldIndex, type Project, type SyntheticRecord } from '@iss/model';
import { coverageGaps, type CoverageGap } from '@iss/scenarios';
import { applyAssistCommands, SourceChip } from '../../assist/common';
import { Dialog, formatMoney, Loading, Tech } from '../../ui/common';
import { fieldLabel } from '../../ui/plain';
import { editBlockedReason, useStudio } from '../../state/store';
import './RuleAssist.css';

type Scenario = NonNullable<CoverageGap['scenario']>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What the scenario changes, as "field label → value" (derived from the scenario itself). */
export function scenarioChanges(project: Project, record: SyntheticRecord | undefined, overrides: Record<string, unknown>): Array<{ label: string; value: string }> {
  const idx = projectFieldIndex(project);
  const out: Array<{ label: string; value: string }> = [];
  const fmt = (path: string, v: unknown): string => {
    const f = idx.get(path);
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v === null || v === undefined) return 'empty';
    if (f?.type === 'cents' && typeof v === 'number') return formatMoney(v);
    if (Array.isArray(v)) return `${v.length} row${v.length === 1 ? '' : 's'}`;
    return String(v);
  };
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (path === 'claims' && Array.isArray(v)) {
        const base = (record?.claims ?? []) as Array<Record<string, unknown>>;
        (v as Array<Record<string, unknown>>).forEach((c, i) => {
          for (const [ck, cv] of Object.entries(c)) {
            if (JSON.stringify(base[i]?.[ck]) !== JSON.stringify(cv)) out.push({ label: fieldLabel(project, `claim.${ck}`), value: fmt(`claim.${ck}`, cv) });
          }
        });
      } else if (isObj(v)) walk(v, path);
      else out.push({ label: fieldLabel(project, path), value: fmt(path, v) });
    }
  };
  walk(overrides, '');
  return out;
}

export function stepLabelOf(project: Project, cursor: number): string {
  const e = project.journey?.events[cursor];
  if (!e) return `Step ${cursor + 1}`;
  return `${e.day ? `Day ${e.day} · ` : ''}${e.label ?? e.eventType.replace(/[-_]/g, ' ')}`;
}

/** Number of targets coverageGaps considers, counted the same way (enabled rules, message versions, sections). */
function targetTotal(project: Project): number {
  const rules = project.rules.filter((r) => r.scope === project.documentType && r.enabled !== false).length;
  const versions = project.nodes.filter((n) => n.type === 'variant-set' || (n.type === 'conditional-region' && (n.variantIds ?? []).length > 1)).reduce((s, n) => s + (n.variantIds ?? []).length, 0);
  const nodeIds = new Set(project.nodes.map((n) => n.id));
  const partIds = new Set(project.contentParts.map((c) => c.id));
  const sections = project.nodes.filter((n) => n.type === 'conditional-region' || n.visibleWhen).length
    + new Set(project.rules.filter((r) => r.scope === project.documentType && r.enabled !== false && r.then.op === 'showSection').map((r) => (r.then as { targetNodeId: string }).targetNodeId).filter((id) => !nodeIds.has(id) && partIds.has(id))).size;
  return rules + versions + sections;
}

const KIND_WORD: Record<CoverageGap['kind'], string> = { rule: 'Rule', variant: 'Message version', section: 'Section' };

export function CoverageDialog({ project, onClose, onPreview, onGenerate }: { project: Project; onClose: () => void; onPreview: (gap: CoverageGap, scenario: Scenario) => void; onGenerate?: () => void }) {
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const blocked = useStudio((s) => editBlockedReason(s.session));
  const [gaps, setGaps] = useState<CoverageGap[] | null>(null);
  const [total, setTotal] = useState(0);
  const testCases = project.testCases ?? [];

  useEffect(() => {
    // Computed once when opened (after first paint). Pinning a test does not change coverage, so the list is not recomputed.
    const h = setTimeout(() => {
      setTotal(targetTotal(project));
      setGaps(coverageGaps(project, records));
    }, 30);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isPinned = (g: CoverageGap) => !!g.testCase && testCases.some((t) => t.id === g.testCase!.id && t.name === g.testCase!.name);
  const pinnable = (gaps ?? []).filter((g) => g.testCase && !isPinned(g));
  const pin = (g: CoverageGap) => { if (g.testCase) applyAssistCommands([{ type: 'UPSERT_TEST_CASE', testCase: g.testCase }], `Pin test “${g.testCase.name}”`, 'coverage'); };
  const pinAll = () => {
    const commands = pinnable.map((g) => ({ type: 'UPSERT_TEST_CASE' as const, testCase: g.testCase! }));
    applyAssistCommands(commands, `Pin ${commands.length} coverage test${commands.length === 1 ? '' : 's'}`, 'coverage');
  };
  const nameOf = (id: string) => { const r = records.find((x) => x.recordId === id); return r ? `${r.customer.givenName} ${r.customer.familyName}` : id; };
  const personaOf = (id: string) => { const r = records.find((x) => x.recordId === id); return r?.personaId ? personas.find((p) => p.id === r.personaId)?.name : undefined; };
  const exercised = gaps ? Math.max(0, total - gaps.length) : 0;

  return (
    <Dialog title={<>Find coverage gaps <SourceChip source="builtin" /></>} onClose={onClose} labelledBy="coverage-title">
      <div className="ra-wide ra-cov" data-testid="coverage-panel">
        {onGenerate && (
          <p className="row wrap ra-covbar ra-gen">
            <span className="muted">Rather than fixing gaps one by one:</span>
            <button type="button" className="btn sm" onClick={onGenerate} data-testid="coverage-generate">Generate test customers for all of this</button>
          </p>
        )}
        {!gaps ? <Loading label="Trying what-if scenarios on the synthetic customers…" /> : (
          <>
            <p className="ra-summary" data-testid="coverage-summary" data-gaps={gaps.length} data-total={total}>
              {exercised} of {total} rules, versions and sections are exercised by the {records.length} synthetic customers as issued.
              {gaps.length > 0 && <span className="muted"> {gaps.length} {gaps.length === 1 ? 'is' : 'are'} not.</span>}
            </p>
            <div className="row wrap ra-covbar">
              <button type="button" className="btn sm" onClick={pinAll} disabled={!!blocked || pinnable.length === 0} title={blocked ?? (pinnable.length ? 'Pin every offered test as one undoable step' : 'Nothing left to pin')} data-testid="coverage-pin-all">Pin all{pinnable.length ? ` (${pinnable.length})` : ''}</button>
              {blocked && <span className="hint">{blocked}, so tests cannot be pinned.</span>}
            </div>
            {gaps.length === 0 ? <p className="callout accent">Every rule, message version and section is reached by at least one synthetic customer as issued.</p> : (
              <ul className="list-rows ra-list">
                {gaps.map((g) => {
                  const s = g.scenario;
                  const changes = s ? scenarioChanges(project, records.find((r) => r.recordId === s.recordId), s.overrides) : [];
                  const pinned = isPinned(g);
                  const journeyOnly = !!s && s.journeyCursor !== null;
                  return (
                    <li key={g.id} className="ra-item" data-testid="coverage-gap" data-kind={g.kind} data-target={g.targetId}>
                      <div className="ra-item-head"><span className="chip">{KIND_WORD[g.kind]}</span><strong>{g.title}</strong><Tech><span className="chip code">{g.targetId}</span></Tech></div>
                      <p className="ra-item-detail">No synthetic customer {g.kind === 'rule' ? 'matches this rule' : g.kind === 'variant' ? 'receives this message' : 'sees this section'} as issued.</p>
                      {s ? (
                        <div className="ra-scenario">
                          <p className="ra-item-detail" data-testid="coverage-scenario"><strong>A scenario that reaches it.</strong> {s.explanation}</p>
                          <dl className="ra-kv">
                            <dt>Customer</dt><dd>{nameOf(s.recordId)}{personaOf(s.recordId) ? <span className="muted"> · {personaOf(s.recordId)}</span> : null}<Tech> <span className="chip code">{s.recordId}</span></Tech></dd>
                            <dt>Data changes</dt><dd>{changes.length ? changes.map((c, i) => <span key={i} className="ra-change">{c.label} → <b>{c.value}</b></span>) : <span className="muted">None</span>}</dd>
                            {journeyOnly && <><dt>Journey step</dt><dd>{stepLabelOf(project, s.journeyCursor!)}</dd></>}
                          </dl>
                          {journeyOnly && changes.length === 0 && <p className="hint">No customer gets this as issued: it is reached only at this journey step.</p>}
                        </div>
                      ) : null}
                      {g.reason && <p className="ra-reason" data-testid="coverage-reason">{s ? '' : 'No scenario found. '}{g.reason}</p>}
                      <div className="row wrap ra-actions">
                        {s && <button type="button" className="btn sm" onClick={() => onPreview(g, s)} data-testid="coverage-preview">Preview this scenario</button>}
                        {pinned
                          ? <span className="chip ok" data-testid="coverage-pinned">Pinned</span>
                          : <button type="button" className="btn sm" disabled={!g.testCase || !!blocked} onClick={() => pin(g)} data-testid="coverage-pin"
                              title={blocked ?? (g.testCase ? 'Save this scenario as a pinned test' : 'No test is offered for this one')}>Pin as a test</button>}
                        {!pinned && !g.testCase && s && <span className="hint">No test offered: {g.reason ? 'the outcome would be the wrong one to pin.' : 'a test could not be built.'}</span>}
                        {!pinned && g.testCase && blocked && <span className="hint">{blocked}.</span>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
