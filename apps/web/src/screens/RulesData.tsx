import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  projectFieldIndex, projectFields, getPath, validatePredicate, validateRule, applyCommand, dayWords,
  type DocNode, type DocumentType, type FieldDef, type Locale, type Predicate, type Project, type Rule, type RuleAction, type RuleMode, type Scalar, type SyntheticRecord,
} from '@iss/model';
import { itemScopeIndex, type ItemsMatch } from '@iss/model';
import { describePredicate, resolve, type Finding, type TraceEntry } from '@iss/resolver';
import { EDGE_CASE_PRESETS, impactOf } from '@iss/scenarios';
import { ScreenHeader, Loading, Empty, SeverityLabel, formatMoney, Tech, Biz, Proof } from '../ui/common';
import { ruleTitle, ruleSentence, predicateSentence, fieldLabel, nodeTitle } from '../ui/plain';
import { Icon } from '../ui/icons';
import { ImpactPreview } from '../ui/ImpactPreview';
import { DataFieldsEditor } from './rules/DataFieldsEditor';
import { useStudio, useResolution, useRecord, editBlockedReason, usePreviewDate, dated } from '../state/store';
import { NotInEffectChip, PeriodChip, PeriodEditor } from './dates/period';
import type { CoverageGap } from '@iss/scenarios';
import { api } from '../api/client';
import { DecisionTable } from './rules/DecisionTable';
import { DraftTestImpact, TestsPanel, TestsSummary } from './rules/TestCases';
import { DescribeRuleDialog, ReviewRulesDialog } from './rules/RuleAssist';
import { CoverageDialog, stepLabelOf } from './rules/Coverage';
import { TestDataDialog } from './rules/TestData';
import { OwnCustomers } from './rules/OwnCustomers';
import { makeTransactions } from '../demo/defects';
import './RulesData.css';
import { fromVisual, toVisual, type Cond, type LeafOp } from './conditionShape';

/* ------------------------------------------------------------------ helpers */

const OP_LABEL: Record<LeafOp, string> = { eq: 'is equal to', ne: 'is not equal to', gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most', in: 'is one of', isNull: 'is empty', notNull: 'is present' };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function opsFor(f: FieldDef | undefined): LeafOp[] {
  if (!f) return ['eq', 'ne'];
  switch (f.type) {
    case 'enum': return ['eq', 'ne', 'in', 'isNull', 'notNull'];
    case 'bool': return ['eq', 'ne', 'isNull', 'notNull'];
    case 'string': return ['eq', 'ne', 'isNull', 'notNull'];
    default: return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull'];
  }
}
function defaultValue(f: FieldDef | undefined, op: LeafOp): Scalar | Scalar[] {
  if (op === 'isNull' || op === 'notNull') return null;
  if (op === 'in') return f?.enumValues?.length ? [f.enumValues[0]] : [];
  switch (f?.type) {
    case 'enum': return f.enumValues![0];
    case 'bool': return true;
    case 'int': case 'cents': case 'points': case 'number': return 0;
    case 'date': return '2026-10-31';
    default: return '';
  }
}

function fieldValue(rec: SyntheticRecord | undefined, path: string): unknown {
  if (!rec) return undefined;
  if (path.startsWith('claim.')) return (rec.claims?.[0] as Record<string, unknown> | undefined)?.[path.slice(6)];
  const v = getPath(rec, path);
  return v === null ? undefined : v;
}
function show(v: unknown, f?: FieldDef): string {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (f?.type === 'cents' && typeof v === 'number') return `${v} (${formatMoney(v)})`;
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 70 ? s.slice(0, 67) + '…' : s;
}
function nest(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  return parts.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>;
}
function unsetPath(overrides: Record<string, unknown>, path: string): Record<string, unknown> {
  const out = clone(overrides);
  const parts = path.split('.');
  const chain: Array<Record<string, unknown>> = [out];
  for (const k of parts.slice(0, -1)) { const n = chain[chain.length - 1][k]; if (!isPlainObject(n)) return out; chain.push(n); }
  delete chain[chain.length - 1][parts[parts.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) if (!Object.keys(chain[i]).length) delete chain[i - 1][parts[i - 1]];
  return out;
}
interface DiffRow { key: string; label: string; base: string; next: string; revert: string }
function diffOverrides(base: SyntheticRecord | undefined, overrides: Record<string, unknown>, fields: Map<string, FieldDef>): DiffRow[] {
  const rows: DiffRow[] = [];
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v)) { walk(v, path); continue; }
      if (path === 'claims' && Array.isArray(v)) {
        const baseClaims = (base?.claims ?? []) as Array<Record<string, unknown>>;
        (v as Array<Record<string, unknown>>).forEach((c, i) => {
          for (const [ck, cv] of Object.entries(c)) {
            if (JSON.stringify(baseClaims[i]?.[ck]) !== JSON.stringify(cv)) rows.push({ key: `claims[${i}].${ck}`, label: `claims[${i}].${ck}`, base: show(baseClaims[i]?.[ck], fields.get(`claim.${ck}`)), next: show(cv, fields.get(`claim.${ck}`)), revert: 'claims' });
          }
        });
        if (v.length !== baseClaims.length) rows.push({ key: 'claims.length', label: 'claims', base: `${baseClaims.length} items`, next: `${v.length} items`, revert: 'claims' });
        continue;
      }
      const baseV = base ? getPath(base, path) : undefined;
      if (Array.isArray(v)) {
        const sum = (a: unknown[]) => a.every((r) => isPlainObject(r) && typeof r.amountCents === 'number') ? ` · Σ ${formatMoney((a as Array<{ amountCents: number }>).reduce((s, r) => s + r.amountCents, 0))}` : '';
        const b = Array.isArray(baseV) ? baseV : [];
        rows.push({ key: path, label: path, base: `${b.length} rows${sum(b)}`, next: `${v.length} rows${sum(v)}`, revert: path });
      } else if (JSON.stringify(baseV ?? null) !== JSON.stringify(v ?? null)) {
        rows.push({ key: path, label: path, base: show(baseV, fields.get(path)), next: show(v, fields.get(path)), revert: path });
      }
    }
  };
  walk(overrides, '');
  return rows;
}
export function abridge(v: unknown): unknown {
  if (Array.isArray(v)) return v.length > 3 ? [...v.slice(0, 2).map(abridge), `… ${v.length - 2} more rows`] : v.map(abridge);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, abridge(x)]));
  return v;
}
function nextRuleId(rules: Rule[]): string {
  const nums = rules.map((r) => /^R(\d+)$/.exec(r.id)).filter(Boolean).map((m) => Number(m![1]));
  return `R${Math.max(20, ...nums) + 1}`;
}
const variantNodes = (p: Project) => p.nodes.filter((n) => n.type === 'variant-set' || n.type === 'conditional-region');

/* ----------------------------------------------------------- small controls */

function NumField({ value, onCommit, label, id, testid, min }: { value: number | undefined; onCommit: (n: number) => void; label: string; id?: string; testid?: string; min?: number }) {
  const [txt, setTxt] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => { setTxt(value === undefined || value === null ? '' : String(value)); }, [value]);
  const bad = txt.trim() !== '' && !/^-?\d+$/.test(txt.trim());
  return (
    <input className="input rd-num" id={id} aria-label={label} data-testid={testid} inputMode="numeric" value={txt} aria-invalid={bad || undefined}
      onChange={(e) => { setTxt(e.target.value); const t = e.target.value.trim(); if (/^-?\d+$/.test(t)) { const n = parseInt(t, 10); if (min === undefined || n >= min) onCommit(n); } }} />
  );
}

function Switch({ checked, onChange, label, disabled, testid }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean; testid?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} data-testid={testid} className={`rd-switch ${checked ? 'on' : ''}`} onClick={onChange}>
      <span className="rd-switch-knob" aria-hidden="true" /><span className="rd-switch-text">{checked ? 'Enabled' : 'Disabled'}</span>
    </button>
  );
}

function ValueEditor({ field, op, value, onChange, label }: { field: FieldDef | undefined; op: LeafOp; value: Scalar | Scalar[]; onChange: (v: Scalar | Scalar[]) => void; label: string }) {
  if (op === 'isNull' || op === 'notNull') return <span className="muted rd-novalue">no value needed</span>;
  if (op === 'in') {
    const vals = Array.isArray(value) ? value.map(String) : [];
    return (
      <fieldset className="rd-multi"><legend className="rd-sr">{label}</legend>
        {(field?.enumValues ?? []).map((v) => (
          <label key={v}><input type="checkbox" checked={vals.includes(v)} onChange={(e) => onChange(e.target.checked ? [...vals, v] : vals.filter((x) => x !== v))} /> {v}</label>
        ))}
      </fieldset>
    );
  }
  const scalar = Array.isArray(value) ? null : value;
  switch (field?.type) {
    case 'enum': return <select className="select" aria-label={label} value={String(scalar ?? '')} onChange={(e) => onChange(e.target.value)}>{field.enumValues!.map((v) => <option key={v} value={v}>{v}</option>)}</select>;
    case 'bool': return <select className="select" aria-label={label} value={String(scalar)} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">true</option><option value="false">false</option></select>;
    case 'int': case 'points': case 'cents': case 'number':
      return (
        <span className="rd-valwrap">
          <NumField value={typeof scalar === 'number' ? scalar : undefined} label={label} onCommit={onChange} />
          {field.type === 'cents' && typeof scalar === 'number' && <span className="rd-hint">{formatMoney(scalar)}</span>}
          {field.type === 'points' && <span className="rd-hint">points</span>}
        </span>
      );
    case 'date': return <input className="input" type="date" aria-label={label} value={String(scalar ?? '')} onChange={(e) => onChange(e.target.value)} />;
    default: return <input className="input" aria-label={label} value={String(scalar ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}

/* ============================================================== S07 screen */

export function RulesData() {
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const ctx = useStudio((s) => s.ctx);
  const dispatch = useStudio((s) => s.dispatch);
  const res = useResolution();
  const record = useRecord();
  const previewDate = usePreviewDate();
  const [params, setParams] = useSearchParams();

  const techMode = useStudio((s) => s.viewMode) === 'technical';
  const docType: DocumentType = project?.documentType ?? 'credit-statement';
  const customFields = project?.customFields;
  const fields = useMemo(() => projectFields({ documentType: docType, customFields }), [docType, customFields]);
  const fieldMap = useMemo(() => projectFieldIndex({ documentType: docType, customFields }), [docType, customFields]);

  /* ---- rule selection + local draft (never in the model until Apply) ---- */
  const [isNew, setIsNew] = useState(false);
  const paramRule = params.get('rule');
  const firstRule = project?.rules[0]?.id ?? '';
  const ruleId = isNew ? '' : project?.rules.some((r) => r.id === paramRule) ? paramRule! : (project?.rules.find((r) => r.id === 'R04') ?? project?.rules[0])?.id ?? firstRule;
  const stored = project?.rules.find((r) => r.id === ruleId);
  const storedJson = stored ? JSON.stringify(stored) : '';
  const baseRef = useRef('');
  const [draft, setDraft] = useState<Rule | null>(null);
  const [tab, setTab] = useState<'visual' | 'ast'>('visual');
  const [astText, setAstText] = useState('');
  const [astErrors, setAstErrors] = useState<string[]>([]);
  const [enableMsg, setEnableMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [dock, setDock] = useState<DockTab | null>(null);
  const [showFields, setShowFields] = useState(false);
  const [view, setView] = useState<'editor' | 'table' | 'tests'>('editor');
  const [toggleNote, setToggleNote] = useState<{ before: Project; after: Project; ruleId: string; verb: string } | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [assist, setAssist] = useState<'describe' | 'review' | 'coverage' | 'testdata' | null>(null);
  const [previewed, setPreviewed] = useState<{ title: string; recordId: string; overrides: string; cursor: number | null } | null>(null);
  const blockedReason = useStudio((s) => editBlockedReason(s.session));
  const openDock = (t: DockTab) => { setDock(t); setTimeout(() => dockRef.current?.scrollIntoView({ block: 'nearest', behavior: useStudio.getState().reducedMotion ? 'auto' : 'smooth' }), 30); };

  // "?assist=coverage" (from Overview) opens the coverage dialog straight away; the address is tidied so a reload does not reopen it.
  useEffect(() => {
    if (params.get('assist') !== 'coverage') return;
    setAssist('coverage');
    const next = new URLSearchParams(params); next.delete('assist');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    if (isNew || !stored) return;
    const dirty = draft && draft.id === stored.id && baseRef.current && JSON.stringify(draft) !== baseRef.current;
    // A period is changed by its own command (not through the draft): an unsaved draft takes the new period and
    // version, so applying it later never puts the old period back.
    if (dirty && draft && (JSON.stringify(draft.effective ?? null) !== JSON.stringify(stored.effective ?? null) || draft.version !== stored.version)) {
      const base = JSON.parse(baseRef.current) as Rule;
      const sync = (r: Rule): Rule => { const { effective: _e, ...rest } = r; return { ...rest, version: stored.version, ...(stored.effective ? { effective: stored.effective } : {}) } as Rule; };
      baseRef.current = JSON.stringify(sync(base));
      setDraft(sync(draft));
      return;
    }
    if (dirty) return;
    baseRef.current = storedJson;
    setDraft(clone(stored));
    setAstText(pretty(stored.when));
    setAstErrors([]);
    setEnableMsg(null);
    if (!draft || draft.id !== stored.id) { setTestResult(null); setToggleNote(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleId, storedJson, isNew]);

  const isDirty = isNew || (!!draft && !!stored && JSON.stringify(draft) !== baseRef.current);
  const confirmDiscard = () => !isDirty || window.confirm('Discard the unsaved rule draft? The model has not been changed.');
  const selectRule = (id: string) => {
    if (id === ruleId && !isNew) return true;
    if (!confirmDiscard()) return false;
    setIsNew(false);
    baseRef.current = '';
    setDraft(null);
    setTestResult(null);
    setParams({ rule: id }, { replace: true });
    return true;
  };
  const addRule = () => {
    if (!project || !confirmDiscard()) return;
    const id = nextRuleId(project.rules);
    // A document with its own data starts a rule on one of its own fields (a choice first), never on a standard customer field.
    const ownFields = fields.filter((f) => f.path.startsWith('custom.') && f.type !== 'array');
    const first = (project.documentType === 'custom' ? ownFields.find((f) => f.type === 'enum') ?? ownFields.find((f) => !f.derived) ?? ownFields[0] : undefined) ?? fields.find((f) => f.type === 'enum' && !f.derived && f.path !== 'documentType') ?? fields[0];
    setIsNew(true);
    baseRef.current = '';
    setDraft({ id, scope: project.documentType, mode: 'additive', priority: 30, when: { op: 'eq', path: first.path, value: first.enumValues?.[0] ?? '' }, then: { op: 'setPresentationHint', hint: `custom-${id.toLowerCase()}` }, version: 1, enabled: true, title: 'New rule' });
    setAstText('');
    setAstErrors([]);
    setTab('visual');
    setTestResult(null);
    setEnableMsg(null);
  };
  /** Load a rule drafted by the assistant as a NEW unsaved draft (nothing is written to the model). */
  const openDraft = (rule: Rule) => {
    if (!project || blockedReason || !confirmDiscard()) return;
    setAssist(null);
    setView('editor');
    setIsNew(true);
    baseRef.current = '';
    setDraft(clone(rule));
    setAstText(pretty(rule.when));
    setAstErrors([]);
    setTab('visual');
    setTestResult(null);
    setEnableMsg(null);
    setTimeout(() => document.querySelector('[data-testid="rule-impact"]')?.scrollIntoView({ block: 'nearest', behavior: useStudio.getState().reducedMotion ? 'auto' : 'smooth' }), 120);
  };
  const previewGap = (gap: CoverageGap, sc: NonNullable<CoverageGap['scenario']>) => {
    const st = useStudio.getState();
    st.setRecord(sc.recordId);
    st.setOverrides(sc.overrides);
    st.setJourneyCursor(sc.journeyCursor);
    setPreviewed({ title: gap.title, recordId: sc.recordId, overrides: JSON.stringify(sc.overrides), cursor: sc.journeyCursor });
    setAssist(null);
    if (gap.kind === 'rule') selectRule(gap.targetId);
  };
  const cancelDraft = () => {
    setIsNew(false); baseRef.current = ''; setDraft(null); setTestResult(null);
    if (stored) { setDraft(clone(stored)); baseRef.current = storedJson; setAstText(pretty(stored.when)); setAstErrors([]); }
  };

  /* ---- derived trace/match info ---- */
  const trace = res?.trace ?? [];
  const ruleTrace = useMemo(() => new Map(trace.filter((t) => t.kind === 'rule').map((t) => [t.ruleId, t])), [trace]);

  const ruleErrors = useMemo(() => {
    if (!draft || !project) return [] as string[];
    const e = validateRule(draft, project);
    if (isNew && project.rules.some((r) => r.id === draft.id)) e.unshift(`Rule ID ${draft.id} already exists.`);
    return e;
  }, [draft, project, isNew]);
  const allErrors = tab === 'ast' && astErrors.length ? astErrors : ruleErrors;
  const canApply = !!draft && isDirty && allErrors.length === 0 && astErrors.length === 0;

  /** The model as it would be if this (valid) draft were applied now: null when nothing to preview. */
  const draftProject = useMemo(() => {
    if (!project || !draft || !isDirty || allErrors.length || astErrors.length) return null;
    const r = applyCommand(project, { type: 'UPSERT_RULE', rule: { ...draft, enabled: stored?.enabled ?? draft.enabled ?? true } });
    return r.ok ? r.project : null;
  }, [project, draft, isDirty, allErrors.length, astErrors.length, stored?.enabled]);

  const patchDraft = useCallback((p: Partial<Rule>) => setDraft((d) => (d ? { ...d, ...p } : d)), []);
  const setWhen = (when: Predicate) => { patchDraft({ when }); setAstText(pretty(when)); setAstErrors([]); };

  const onAst = (text: string) => {
    setAstText(text);
    try {
      const parsed = JSON.parse(text) as Predicate;
      const errs = validatePredicate(parsed, fieldMap);
      if (errs.length) { setAstErrors(errs); return; }
      setAstErrors([]);
      patchDraft({ when: parsed });
    } catch (e) {
      setAstErrors([`JSON syntax error: ${(e as Error).message}`]);
    }
  };
  const switchTab = (t: 'visual' | 'ast') => {
    if (t === 'ast' && draft) { setAstText(pretty(draft.when)); setAstErrors([]); }
    if (t === 'visual') setAstErrors([]);
    setTab(t);
  };

  const apply = () => {
    if (!draft || !canApply) return;
    const out = dispatch({ type: 'UPSERT_RULE', rule: { ...draft, enabled: stored?.enabled ?? draft.enabled ?? true } });
    if (!out.ok) return;
    const saved = useStudio.getState().project?.rules.find((r) => r.id === draft.id);
    setIsNew(false);
    if (saved) { baseRef.current = JSON.stringify(saved); setDraft(clone(saved)); setAstText(pretty(saved.when)); }
    setParams({ rule: draft.id }, { replace: true });
    setTestResult(null);
    setToggleNote(null);
  };
  const toggleEnabled = () => {
    if (!stored) return;
    const before = useStudio.getState().project;
    const out = dispatch({ type: 'SET_RULE_ENABLED', ruleId: stored.id, enabled: stored.enabled === false });
    setEnableMsg(out.ok ? null : out.message);
    const after = useStudio.getState().project;
    setToggleNote(out.ok && before && after ? { before, after, ruleId: stored.id, verb: stored.enabled === false ? 'enabled' : 'disabled' } : null);
  };
  const deleteRule = () => {
    if (!stored) return;
    let effect = '';
    if (project) {
      const gone = applyCommand(project, { type: 'DELETE_RULE', ruleId: stored.id });
      if (gone.ok) {
        const imp = impactOf(project, gone.project, records);
        effect = imp.changed.length ? ` This changes ${imp.changed.length} of ${imp.evaluated} synthetic ${docType === 'eob' ? 'members' : 'customers'}' documents${imp.newBlocking ? ` and adds ${imp.newBlocking} blocking issue${imp.newBlocking === 1 ? '' : 's'}` : ''}.` : ` No synthetic ${docType === 'eob' ? "member's" : "customer's"} document changes.`;
      }
    }
    if (!window.confirm(`Delete rule ${stored.id}?${effect} You can undo this from the top bar.`)) return;
    const out = dispatch({ type: 'DELETE_RULE', ruleId: stored.id });
    if (out.ok) { baseRef.current = ''; setDraft(null); setParams({}, { replace: true }); }
    else setEnableMsg(out.message);
  };

  const runTest = () => {
    if (!draft || !project || ruleErrors.length || astErrors.length) return;
    setTestResult(testRule(project, records, draft, record, ctx.overrides, previewDate));
  };

  if (!project) return <Loading label="Loading project…" />;
  const modelNodes = project.nodes;

  /* ------------------------------------------------------------------ render */
  const header = (
    <ScreenHeader id="S07" title="Rules & Data"
      subtitle="Edit the declarative rules behind each document outcome, test them against every record, and inspect the exact inputs behind the current scenario."
      badge={<TestsSummary project={project} onOpen={() => setView('tests')} />}
      actions={<>
        <div className="segmented" role="group" aria-label="Rules view" data-testid="rules-view-switch">
          {([['editor', 'Editor'], ['table', 'Table'], ['tests', 'Tests']] as const).map(([v, label]) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} data-testid={`rules-view-${v}`}>{label}</button>
          ))}
        </div>
        <button className="btn" onClick={() => setShowFields(true)} data-testid="open-data-fields"><Icon.list /> Data fields</button>
        <button className="btn" onClick={() => openDock('scenario')}><Icon.list /> Scenario data</button>
        <button className="btn primary" onClick={addRule} data-testid="add-rule"><Icon.plus /> Add rule</button>
      </>} />
  );

  return (
    <section className="screen" data-testid="rules-data-view">
      {header}
      <div className="screen-body rd-body">
        {project.documentType === 'custom' && !(project.customFields?.length) && (
          <div className="callout accent rd-nofields" data-testid="no-data-fields">
            <div><strong>This document has no data fields yet.</strong> <span>Every customer has a name and a language. Add the data your document is about (an amount, a date, a choice, a list of rows) and use it in components and rules.</span></div>
            <button className="btn primary" onClick={() => setShowFields(true)} data-testid="no-data-fields-open"><Icon.plus /> Add data fields</button>
          </div>
        )}
        {view === 'table' && <DecisionTable project={project} records={records} onOpenRule={(id) => { if (selectRule(id)) setView('editor'); }} />}
        {view === 'tests' && <TestsPanel project={project} />}
        {previewed && ctx.recordId === previewed.recordId && JSON.stringify(ctx.overrides) === previewed.overrides && (ctx.journeyCursor ?? null) === previewed.cursor && (
          <div className="callout accent rd-scenario-note" role="status" data-testid="coverage-preview-note">
            <span>The top bar now shows a coverage scenario for “{previewed.title}”{previewed.cursor !== null ? ` at the journey step “${stepLabelOf(project, previewed.cursor)}”` : ''}. The decision trace below uses it.</span>
            <button className="btn sm" onClick={() => { useStudio.getState().setRecord(ctx.recordId); setPreviewed(null); }} data-testid="coverage-preview-reset">Reset scenario</button>
            <span className="muted">Reset clears the what-if changes and journey step.</span>
          </div>
        )}
        <div className="rd-row rd-row1" hidden={view !== 'editor'}>
          <RuleTree assist={<div className="ra-assist" data-testid="rules-assist"><button className="btn sm" onClick={() => setAssist('describe')} data-testid="rule-describe-button"><Icon.plus /> Describe a rule</button><button className="btn sm" onClick={() => setAssist('review')} data-testid="rules-review"><Icon.target /> Review my rules</button><button className="btn sm" onClick={() => setAssist('coverage')} data-testid="coverage-open"><Icon.list /> Find coverage gaps</button><button className="btn sm" onClick={() => setAssist('testdata')} data-testid="testdata-open"><Icon.plus /> Generate test customers</button></div>} project={project} ruleTrace={ruleTrace} selectedId={isNew ? draft?.id ?? '' : ruleId} newId={isNew ? draft?.id : undefined} onSelect={selectRule} day={res?.documentDate?.date ?? null} />

          <div className="panel rd-editor-panel" data-testid="rule-editor" aria-label="Rule editor">
            {!draft ? (
              <Empty title="No rule selected" message="Choose a rule from the tree or add a new one." />
            ) : (
              <>
                <div className="panel-head">
                  <span className="mono rd-ruleid">{draft.id}</span>
                  <span className="rd-headtitle" title={draft.title || undefined}>{isNew ? 'New rule draft' : ruleTitle(project, draft)}</span>
                  {isDirty && <span className="chip warning" data-testid="draft-chip">{isNew ? 'Draft · not in model' : 'Unsaved draft'}</span>}
                  {!isDirty && <span className="chip accent">Saved<Tech> · model v{project.modelVersion}</Tech></span>}
                  <div className="right">
                    {!isNew && stored && (
                      <Switch checked={stored.enabled !== false} onChange={toggleEnabled} label={`Rule ${stored.id} enabled`} testid="rule-enabled-toggle" />
                    )}
                  </div>
                </div>
                <div className="rd-editor-scroll">
                  <p className="rd-summary" data-testid="rule-summary">{ruleSentence(project, draft)}</p>
                  {enableMsg && <div className="callout error rd-gap" role="alert" data-testid="rule-protected-msg"><strong>Not allowed.</strong> {enableMsg}</div>}
                  {draft.mode === 'obligation' && (
                    <div className="callout accent rd-gap"><strong>Obligation rule.</strong> It enforces mandatory content, cannot be disabled or deleted, and its required nodes are read-only.</div>
                  )}
                  <div className="tabs rd-tabs" role="tablist" aria-label="Rule editor mode">
                    <button role="tab" id="rd-tab-visual" aria-selected={tab === 'visual'} aria-controls="rd-pane" onClick={() => switchTab('visual')} data-testid="tab-visual">Visual</button>
                    <button role="tab" id="rd-tab-ast" aria-selected={tab === 'ast'} aria-controls="rd-pane" onClick={() => switchTab('ast')} data-testid="tab-ast">Advanced AST</button>
                  </div>
                  <div id="rd-pane" role="tabpanel" aria-labelledby={tab === 'visual' ? 'rd-tab-visual' : 'rd-tab-ast'}>
                    <h3 className="section-title">If — condition</h3>
                    {tab === 'visual' ? (
                      <VisualBuilder tech={techMode} when={draft.when} fields={fields} fieldMap={fieldMap} onChange={setWhen} onUseAst={() => switchTab('ast')} />
                    ) : (
                      <div className="field">
                        <label htmlFor="rd-ast">Declarative expression (JSON). Never executed as code; validated before it can be applied.</label>
                        <textarea id="rd-ast" className="textarea rd-ast mono" spellCheck={false} rows={12} value={astText} onChange={(e) => onAst(e.target.value)} aria-invalid={astErrors.length > 0 || undefined} data-testid="ast-textarea" />
                        {astErrors.length === 0 ? <span className="hint rd-ok">Valid expression. Reads as: {describePredicate(draft.when)}</span> : null}
                      </div>
                    )}
                    <Tech><div className="rd-reads"><span className="rd-reads-lbl">Reads as</span> <span data-testid="rule-reads-as">{describePredicate(draft.when)}</span></div></Tech>

                    <h3 className="section-title">Then — outcome</h3>
                    <ActionEditor draft={draft} project={project} nodes={modelNodes} onChange={patchDraft} locked={!isNew && stored?.mode === 'obligation'} />

                    <h3 className="section-title">Name &amp; precedence</h3>
                    <div className="rd-meta">
                      <div className="field rd-wide"><label htmlFor="rd-title">Rule name</label>
                        <input id="rd-title" className="input" placeholder={ruleTitle(project, { ...draft, title: undefined })} value={draft.title ?? ''} onChange={(e) => patchDraft({ title: e.target.value })} data-testid="rule-title" /></div>
                      {(isNew || techMode) && <div className="field"><label htmlFor="rd-id">Rule ID</label>
                        <input id="rd-id" className="input mono" value={draft.id} disabled={!isNew} onChange={(e) => patchDraft({ id: e.target.value.toUpperCase() })} /></div>}
                      <div className="field"><label htmlFor="rd-mode">Mode</label>
                        <select id="rd-mode" className="select" value={draft.mode} onChange={(e) => patchDraft({ mode: e.target.value as RuleMode })} disabled={modeOptions(draft.then.op).length < 2}>
                          {modeOptions(draft.then.op).map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <span className="hint">{draft.then.op === 'selectVariant' ? 'Exclusive: one message wins.' : draft.then.op === 'requireNodes' ? 'Obligation: always required.' : 'Additive: applies independently.'}</span></div>
                      <div className="field"><label htmlFor="rd-prio">Priority (0–10000)</label>
                        <NumField id="rd-prio" label="Priority" min={0} value={draft.priority} onCommit={(n) => patchDraft({ priority: n })} testid="rule-priority" />
                        <span className="hint">{draft.mode === 'exclusive' ? 'Highest wins; equal priority is a blocking tie.' : 'Not used for ordering here.'}</span></div>
                      {techMode && <div className="field"><label htmlFor="rd-group">Exclusive group</label>
                        <input id="rd-group" className="input mono" value={draft.exclusiveGroup ?? ''} readOnly disabled placeholder="—" />
                        <span className="hint">Equals the target node for exclusive rules.</span></div>}
                    </div>

                    {project.documentDate && (
                      <>
                        <h3 className="section-title">When — in effect</h3>
                        <PeriodEditor period={isNew ? undefined : stored?.effective} testId="rule-period"
                          disabledReason={isNew ? 'Add the rule to the model first, then give it a period.' : stored?.mode === 'obligation' ? 'A rule that enforces mandatory content is always in effect.' : blockedReason ? `${blockedReason}.` : null}
                          command={(period) => ({ type: 'SET_RULE_PERIOD', ruleId: stored!.id, period })} />
                      </>
                    )}

                    {allErrors.length > 0 && (
                      <div className="callout error rd-gap" role="alert" data-testid="rule-errors">
                        <strong>This draft cannot be applied.</strong> The model is unchanged.
                        <ul>{allErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                      </div>
                    )}

                    <p className="hint rd-note">Apply is one undo step (top bar). Test runs the real resolver on all {records.length} {docType === 'eob' ? 'EOB' : docType === 'custom' ? 'customer' : 'statement'} records using a temporary copy of the project.</p>
                    {testResult && <TestPanel result={testResult} draft={draft} onPick={(id) => useStudio.getState().setRecord(id)} />}
                  </div>
                </div>
                {(draftProject || (toggleNote && toggleNote.ruleId === stored?.id && !isDirty)) && (
                  <div className="rd-impact" data-testid="rule-impact">
                    {draftProject
                      ? <ImpactPreview before={project} after={draftProject} />
                      : toggleNote && (
                        <>
                          <div className="imp-undo" role="status"><span>Rule {toggleNote.verb}.</span>
                            <button className="btn sm" onClick={() => { useStudio.getState().undo(); setToggleNote(null); }} data-testid="impact-undo">Undo</button>
                            <button className="btn sm ghost" onClick={() => setToggleNote(null)}>Dismiss</button></div>
                          <ImpactPreview before={toggleNote.before} after={toggleNote.after} />
                        </>
                      )}
                  </div>
                )}
                <div className="rd-actions" data-testid="rule-actions">
                  <button className="btn primary" disabled={!canApply} onClick={apply} data-testid="apply-rule-change" title={canApply ? 'Commit this rule as one undoable change' : allErrors[0] ?? 'No changes to apply'}>
                    <Icon.save /> {isNew ? 'Add rule to model' : 'Apply rule change'}
                  </button>
                  <button className="btn" onClick={runTest} disabled={allErrors.length > 0} data-testid="test-rule"><Icon.target /> Test this rule</button>
                  <button className="btn ghost" onClick={cancelDraft} disabled={!isDirty}>{isNew ? 'Discard draft' : 'Revert draft'}</button>
                  {!isNew && stored && stored.mode !== 'obligation' && <button className="btn ghost danger" onClick={deleteRule}><Icon.trash /> Delete</button>}
                  <DraftTestImpact before={project} after={draftProject} />
                  {!canApply && <span className="rd-actions-hint">{allErrors.length ? 'Fix the issues above to apply.' : 'No changes to apply.'}</span>}
                </div>
              </>
            )}
          </div>

          <TracePanel project={project} res={res} onSelectRule={selectRule} fieldMap={fieldMap} />
        </div>

        <div className="rd-dock" ref={dockRef}>
          <div className="rd-dockbar">
            <div className="rd-docktabs" role="tablist" aria-label="Scenario data and reference">
              {(['scenario', 'tokens'] as DockTab[]).map((t) => (
                <button key={t} role="tab" id={`rd-dock-tab-${t}`} aria-selected={dock === t} aria-controls={`rd-dock-${t}`} onClick={() => (dock === t ? setDock(null) : openDock(t))} data-testid={`dock-tab-${t}`}>
                  {t === 'scenario' ? <><Icon.design /> Scenario data</> : <><Icon.list /> Fields &amp; tokens</>}
                  <span className="rd-caret" aria-hidden="true">{dock === t ? '▾' : '▴'}</span>
                </button>
              ))}
            </div>
            {project.documentType === 'custom' && <OwnCustomers project={project} />}
          </div>
          <div className="rd-drawer" hidden={!dock}>
            <div id="rd-dock-scenario" role="tabpanel" aria-labelledby="rd-dock-tab-scenario" hidden={dock !== 'scenario'}><RecordEditor project={project} fields={fields} fieldMap={fieldMap} /></div>
            <div id="rd-dock-tokens" role="tabpanel" aria-labelledby="rd-dock-tab-tokens" hidden={dock !== 'tokens'}><TokenPicker fields={fields} /></div>
          </div>
        </div>
      </div>
      {showFields && <DataFieldsEditor onClose={() => setShowFields(false)} />}
      {assist === 'describe' && <DescribeRuleDialog project={project} blockedReason={blockedReason} onClose={() => setAssist(null)} onOpenDraft={openDraft} />}
      {assist === 'review' && <ReviewRulesDialog project={project} onClose={() => setAssist(null)} onSelectRule={(id) => { setView('editor'); return selectRule(id); }} />}
      {assist === 'coverage' && <CoverageDialog project={project} onClose={() => setAssist(null)} onPreview={previewGap} onGenerate={() => setAssist('testdata')} />}
      {assist === 'testdata' && <TestDataDialog project={project} onClose={() => setAssist(null)} />}
    </section>
  );
}

type DockTab = 'scenario' | 'tokens';

function modeOptions(op: RuleAction['op']): RuleMode[] {
  return op === 'selectVariant' ? ['exclusive'] : op === 'requireNodes' ? ['obligation'] : ['additive'];
}

/* ------------------------------------------------------------------ left: tree */

function RuleTree({ assist, project, ruleTrace, selectedId, newId, onSelect, day }: { assist: React.ReactNode; project: Project; ruleTrace: Map<string, TraceEntry>; selectedId: string; newId?: string; onSelect: (id: string) => void; /** The document's date of the current preview (periods are marked against it). */ day: string | null }) {
  const nodes = useMemo(() => new Map(project.nodes.map((n) => [n.id, n])), [project.nodes]);
  const exclusive = project.rules.filter((r) => r.mode === 'exclusive');
  const groups = [...new Set(exclusive.map((r) => r.exclusiveGroup ?? ''))];
  const additive = project.rules.filter((r) => r.mode === 'additive');
  const obligation = project.rules.filter((r) => r.mode === 'obligation');
  const listRef = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rule-row]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  const row = (r: Rule) => {
    const t = ruleTrace.get(r.id);
    const state = ruleState(r, t);
    const title = ruleTitle(project, r);
    return (
      <button key={r.id} type="button" data-rule-row data-testid={`rule-row-${r.id}`} className={`rd-rule ${selectedId === r.id ? 'selected' : ''}`} aria-pressed={selectedId === r.id} onClick={() => onSelect(r.id)} title={title}>
        <span className="rd-rule-title">{title}</span>
        <span className="rd-rule-meta">
          <span className="mono rd-rule-id">{r.id}</span>
          <Tech><span className="rd-prio">P{r.priority}</span></Tech>
          <span className={`rd-state ${state.cls}`} data-testid={`rule-state-${r.id}`}>{state.label}</span>
        </span>
        {project.documentDate && r.effective && (
          <span className="rd-rule-meta">
            <PeriodChip period={r.effective} testId={`rule-period-chip-${r.id}`} />
            <NotInEffectChip period={r.effective} day={day} testId={`rule-off-${r.id}`} />
          </span>
        )}
      </button>
    );
  };
  return (
    <aside className="panel" aria-label="Rule tree" data-testid="rule-tree" data-side="left" data-side-title="Rules">
      <div className="panel-head"><Icon.rules /> Rules <span className="sub">{project.rules.length} rules</span></div>
      {assist}
      <div className="panel-body rd-tree" ref={listRef} onKeyDown={onKey}>
        {newId && <div className="rd-newrow"><span className="mono">{newId}</span> <span className="chip warning">draft</span></div>}
        <h3 className="section-title">Choose one message (exclusive)</h3>
        {groups.map((g) => (
          <div key={g} className="rd-group" role="group" aria-label={`Choose one message: ${nodes.get(g)?.name ?? g}`}>
            <div className="rd-group-name"><Icon.target /> {nodes.get(g)?.name ?? nodeTitle(project, g)} <Tech><span className="mono muted">{g}</span></Tech></div>
            {exclusive.filter((r) => (r.exclusiveGroup ?? '') === g).sort((a, b) => b.priority - a.priority).map(row)}
          </div>
        ))}
        <h3 className="section-title">Add-ons (independent)</h3>
        {additive.map(row)}
        <h3 className="section-title">Always required</h3>
        {obligation.map(row)}
      </div>
    </aside>
  );
}
const OUTCOME_WORD: Record<string, string> = { selected: 'Selected', applied: 'Applied', required: 'Applied', outranked: 'Outranked', tie: 'Tie', 'not-matched': 'Not matched', disabled: 'Off', 'out-of-scope': 'Out of scope' };
const outcomeCls = (o: string) => (o === 'selected' || o === 'applied' || o === 'required' ? 'ok' : o === 'tie' ? 'bad' : o === 'outranked' ? 'info' : o === 'disabled' ? 'warn' : '');
/** One clear status word per rule for the current scenario, derived from the resolver trace. */
function ruleState(r: Rule, t: TraceEntry | undefined): { label: string; cls: string } {
  if (r.enabled === false) return { label: 'Off', cls: 'warn' };
  if (!t) return { label: 'Not evaluated', cls: '' };
  if (t.outcome === 'out-of-scope' && t.period) return { label: 'Not in effect', cls: 'warn' };
  if (!t.matched) return { label: 'Not matched', cls: '' };
  return { label: OUTCOME_WORD[t.outcome] ?? 'Matched', cls: outcomeCls(t.outcome) || 'ok' };
}

/* ------------------------------------------------------------- visual builder */

function VisualBuilder({ when, fields, fieldMap, onChange, onUseAst, tech }: { tech: boolean; when: Predicate; fields: FieldDef[]; fieldMap: Map<string, FieldDef>; onChange: (p: Predicate) => void; onUseAst: () => void }) {
  const visual = useMemo(() => toVisual(when, { items: true }), [when]);
  const projectId = useStudio((s) => s.project?.projectId ?? '');
  if (!visual) {
    return (
      <div className="callout warning">
        This expression is nested deeper than one AND/OR level, so the visual builder cannot show it faithfully. Edit it in the <button className="btn sm" onClick={onUseAst}>Advanced AST</button> tab.
        <div className="rd-reads"><span data-testid="rule-reads-as-nested">{describePredicate(when)}</span></div>
      </div>
    );
  }
  const pickable = fields.filter((f) => f.type !== 'array');
  const update = (i: number, c: Partial<Cond>) => onChange(fromVisual({ ...visual, conds: visual.conds.map((x, j) => (j === i ? { ...x, ...c } : x)) }));
  const changeField = (i: number, path: string) => {
    const f = fieldMap.get(path);
    const ops = opsFor(f);
    const cur = visual.conds[i].op;
    const op = ops.includes(cur) ? cur : ops[0];
    update(i, { path, op, value: defaultValue(f, op) });
  };
  const changeOp = (i: number, op: LeafOp) => update(i, { op, value: defaultValue(fieldMap.get(visual.conds[i].path), op) });
  const add = () => {
    const f = pickable.find((x) => x.type === 'bool') ?? pickable[0];
    onChange(fromVisual({ ...visual, conds: [...visual.conds, { path: f.path, op: 'eq', value: defaultValue(f, 'eq'), neg: false }] }));
  };
  // Richer data shapes (wave 5): a condition about the items of one of the document's lists.
  const lists = fields.filter((f) => f.type === 'array' && f.path.startsWith('custom.'));
  const addItems = () => {
    const list = lists[0];
    if (!list) return;
    onChange(fromVisual({ ...visual, conds: [...visual.conds, { path: list.path, op: 'eq', value: null, neg: false, items: { match: 'any', where: firstItemTest(fieldMap, list.path) } }] }));
  };
  return (
    <div className="rd-builder" data-testid="visual-builder">
      {visual.conds.length > 1 && (
        <div className="row rd-combiner">
          <span className="muted">Match</span>
          <div className="segmented" role="group" aria-label="Combine conditions with">
            <button type="button" aria-pressed={visual.combiner === 'and'} onClick={() => onChange(fromVisual({ ...visual, combiner: 'and' }))}>ALL (AND)</button>
            <button type="button" aria-pressed={visual.combiner === 'or'} onClick={() => onChange(fromVisual({ ...visual, combiner: 'or' }))}>ANY (OR)</button>
          </div>
          <span className="muted">of the conditions below</span>
        </div>
      )}
      <ol className="rd-conds">
        {visual.conds.map((c, i) => {
          const f = fieldMap.get(c.path);
          const ops = opsFor(f);
          if (c.items) return (
            <li key={i} className="rd-cond rd-cond-items" data-testid={`cond-${i}`}>
              <span className="rd-cond-join" aria-hidden="true">{i === 0 ? 'IF' : visual.combiner.toUpperCase()}</span>
              <label className="rd-not"><input type="checkbox" checked={c.neg} onChange={(e) => update(i, { neg: e.target.checked })} /> NOT</label>
              <ItemsCondition c={c} i={i} lists={lists} fieldMap={fieldMap} onChange={(patch) => update(i, patch)} />
              <button type="button" className="btn ghost sm icon" aria-label={`Remove condition ${i + 1}`} disabled={visual.conds.length < 2} onClick={() => onChange(fromVisual({ ...visual, conds: visual.conds.filter((_, j) => j !== i) }))}><Icon.close /></button>
            </li>
          );
          return (
            <li key={i} className="rd-cond" data-testid={`cond-${i}`}>
              <span className="rd-cond-join" aria-hidden="true">{i === 0 ? 'IF' : visual.combiner.toUpperCase()}</span>
              <label className="rd-not"><input type="checkbox" checked={c.neg} onChange={(e) => update(i, { neg: e.target.checked })} /> NOT</label>
              <div className="rd-fieldwrap">
                <select className="select rd-field" aria-label={`Condition ${i + 1} field`} title={f ? `${f.label} (${c.path})` : c.path} value={c.path} onChange={(e) => changeField(i, e.target.value)} data-testid={`cond-${i}-field`}>
                  {!f && <option value={c.path}>{c.path} (unknown)</option>}
                  {pickable.map((x) => <option key={x.path} value={x.path}>{x.label}{x.derived ? ' (derived)' : ''}</option>)}
                </select>
                {tech && <span className="rd-path mono" title={c.path}>{c.path}</span>}
                {c.path.startsWith('calc.') && (
                  <Link className="rd-calc-link" data-testid={`cond-${i}-calc-link`} to={`/studio/${projectId}/calculations?calc=${encodeURIComponent(c.path.slice('calc.'.length))}`} title="Open this calculation">How it is worked out</Link>
                )}
              </div>
              <select className="select rd-op" aria-label={`Condition ${i + 1} operator`} value={c.op} onChange={(e) => changeOp(i, e.target.value as LeafOp)} data-testid={`cond-${i}-op`}>
                {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
              </select>
              <div className="rd-value" data-testid={`cond-${i}-value`}><ValueEditor field={f} op={c.op} value={c.value} onChange={(v) => update(i, { value: v })} label={`Condition ${i + 1} value`} /></div>
              <button type="button" className="btn ghost sm icon" aria-label={`Remove condition ${i + 1}`} disabled={visual.conds.length < 2} onClick={() => onChange(fromVisual({ ...visual, conds: visual.conds.filter((_, j) => j !== i) }))}><Icon.close /></button>
            </li>
          );
        })}
      </ol>
      <div className="row">
        <button type="button" className="btn sm" onClick={add} data-testid="add-condition"><Icon.plus /> Add condition</button>
        {lists.length > 0 && <button type="button" className="btn sm" onClick={addItems} data-testid="add-items-condition"><Icon.plus /> Add a condition about items</button>}
      </div>
    </div>
  );
}

/** A first test on one item of a list: its first field that is not a list. */
function firstItemTest(fieldMap: Map<string, FieldDef>, list: string): Predicate {
  const f = [...itemScopeIndex(fieldMap, list).values()].find((x) => x.item === list && x.type !== 'array' && !x.calculated);
  if (!f) return { op: 'notNull', path: `${list}[].` };
  return fromVisual({ combiner: 'and', conds: [{ path: f.path, op: opsFor(f)[0], value: defaultValue(f, opsFor(f)[0]), neg: false }] });
}

const ITEMS_MATCH_LABEL: Record<ItemsMatch, string> = { any: 'any item', every: 'every item', none: 'no item', atLeast: 'at least' };

/** "Any item of Accounts has Closing balance less than 0" (wave 5): how many items must meet a test on one item. */
function ItemsCondition({ c, i, lists, fieldMap, onChange }: { c: Cond; i: number; lists: FieldDef[]; fieldMap: Map<string, FieldDef>; onChange: (patch: Partial<Cond>) => void }) {
  const it = c.items!;
  const inner = [...itemScopeIndex(fieldMap, c.path).values()].filter((x) => x.item === c.path && x.type !== 'array' && !x.calculated);
  const leaf = toVisual(it.where);
  const one = leaf && leaf.conds.length === 1 ? leaf.conds[0] : null;
  const f = one ? fieldMap.get(one.path) ?? inner.find((x) => x.path === one.path) : undefined;
  const setWhere = (cond: Cond) => onChange({ items: { ...it, where: fromVisual({ combiner: 'and', conds: [cond] }) } });
  return (
    <div className="rd-items" data-testid={`cond-${i}-items`}>
      <select className="select" aria-label={`Condition ${i + 1}: how many items`} value={it.match} onChange={(e) => onChange({ items: { ...it, match: e.target.value as ItemsMatch, ...(e.target.value === 'atLeast' ? { count: it.count ?? 2 } : {}) } })} data-testid={`cond-${i}-match`}>
        {(Object.keys(ITEMS_MATCH_LABEL) as ItemsMatch[]).map((m) => <option key={m} value={m}>{ITEMS_MATCH_LABEL[m]}</option>)}
      </select>
      {it.match === 'atLeast' && <input className="input rd-items-count" type="number" min={1} max={1000} aria-label={`Condition ${i + 1}: number of items`} value={it.count ?? 1} onChange={(e) => onChange({ items: { ...it, count: Math.max(1, Math.floor(Number(e.target.value) || 1)) } })} data-testid={`cond-${i}-count`} />}
      <span className="muted">of</span>
      <select className="select" aria-label={`Condition ${i + 1}: list`} value={c.path} onChange={(e) => onChange({ path: e.target.value, items: { ...it, where: firstItemTest(fieldMap, e.target.value) } })} data-testid={`cond-${i}-list`}>
        {lists.map((l) => <option key={l.path} value={l.path}>{l.label}</option>)}
      </select>
      <span className="muted">has</span>
      {one && !one.neg ? (
        <>
          <select className="select" aria-label={`Condition ${i + 1}: field of the item`} value={one.path} onChange={(e) => { const g = inner.find((x) => x.path === e.target.value); const op = opsFor(g)[0]; setWhere({ path: e.target.value, op, value: defaultValue(g, op), neg: false }); }} data-testid={`cond-${i}-item-field`}>
            {!inner.some((x) => x.path === one.path) && <option value={one.path}>{f?.label ?? one.path}</option>}
            {inner.map((x) => <option key={x.path} value={x.path}>{x.label}</option>)}
          </select>
          <select className="select rd-op" aria-label={`Condition ${i + 1}: operator`} value={one.op} onChange={(e) => setWhere({ ...one, op: e.target.value as LeafOp, value: defaultValue(f, e.target.value as LeafOp) })} data-testid={`cond-${i}-item-op`}>
            {opsFor(f).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
          </select>
          <div className="rd-value"><ValueEditor field={f} op={one.op} value={one.value} onChange={(v) => setWhere({ ...one, value: v })} label={`Condition ${i + 1}: value`} /></div>
        </>
      ) : <span className="rd-reads" data-testid={`cond-${i}-items-nested`}>{describePredicate(it.where)} <span className="muted">(edit in the Advanced AST tab)</span></span>}
    </div>
  );
}

/* ---------------------------------------------------------------- action editor */

function ActionEditor({ draft, project, nodes, onChange, locked }: { draft: Rule; project: Project; nodes: DocNode[]; onChange: (p: Partial<Rule>) => void; locked: boolean }) {
  const a = draft.then;
  const tech = useStudio((s) => s.viewMode) === 'technical';
  const idSuffix = (id: string) => (tech ? ` · ${id}` : '');
  const targets = variantNodes(project);
  const setAction = (op: RuleAction['op']) => {
    if (op === a.op) return;
    switch (op) {
      case 'selectVariant': { const t = targets[0]; if (!t) return; onChange({ then: { op, targetNodeId: t.id, variantId: t.variantIds?.[0] ?? '' }, mode: 'exclusive', exclusiveGroup: t.id }); break; }
      case 'showSection': { const t = nodes.find((n) => n.ruleDriven) ?? nodes[0]; onChange({ then: { op, targetNodeId: t.id }, mode: 'additive', exclusiveGroup: undefined }); break; }
      case 'setPresentationHint': onChange({ then: { op, hint: `custom-${draft.id.toLowerCase()}` }, mode: 'additive', exclusiveGroup: undefined }); break;
      case 'setApprovedLocale': onChange({ then: { op, locale: 'es-US' }, mode: 'additive', exclusiveGroup: undefined }); break;
      default: break;
    }
  };
  if (locked || a.op === 'requireNodes') {
    return (
      <div className="card rd-action" data-testid="action-editor">
        <div className="muted">Always included in every output (read-only)</div>
        <div className="row wrap rd-gap">{a.op === 'requireNodes' && a.nodeIds.map((n) => <span key={n} className="chip accent" title={n}><Icon.lock /> {nodeTitle(project, n)}</span>)}</div>
      </div>
    );
  }
  const opts: Array<[RuleAction['op'], string]> = [['selectVariant', 'Select variant (exclusive)'], ['showSection', 'Show section (additive)'], ['setPresentationHint', 'Set presentation hint'], ['setApprovedLocale', 'Set approved locale']];
  const hints = [...new Set(project.rules.map((r) => (r.then.op === 'setPresentationHint' ? r.then.hint : null)).filter(Boolean))] as string[];
  return (
    <div className="card rd-action" data-testid="action-editor">
      <div className="rd-actrow">
        <div className="field"><label htmlFor="rd-act">Action</label>
          <select id="rd-act" className="select" value={a.op} onChange={(e) => setAction(e.target.value as RuleAction['op'])} data-testid="action-op">
            {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
        {a.op === 'selectVariant' && (() => {
          const t = targets.find((n) => n.id === a.targetNodeId);
          return (<>
            <div className="field"><label htmlFor="rd-target">Where it appears</label>
              <select id="rd-target" className="select" title={nodeTitle(project, a.targetNodeId)} value={a.targetNodeId} data-testid="action-target"
                onChange={(e) => { const n = targets.find((x) => x.id === e.target.value)!; onChange({ then: { op: 'selectVariant', targetNodeId: n.id, variantId: n.variantIds?.[0] ?? '' }, exclusiveGroup: n.id }); }}>
                {!t && <option value={a.targetNodeId}>{a.targetNodeId} (invalid)</option>}
                {targets.map((n) => <option key={n.id} value={n.id}>{n.name ?? n.id}{idSuffix(n.id)}</option>)}
              </select></div>
            <div className="field"><label htmlFor="rd-variant">Message shown</label>
              <select id="rd-variant" className="select" title={nodeTitle(project, a.variantId)} value={a.variantId} data-testid="action-variant" onChange={(e) => onChange({ then: { ...a, variantId: e.target.value } })}>
                {!t?.variantIds?.includes(a.variantId) && <option value={a.variantId}>{a.variantId} (not defined)</option>}
                {(t?.variantIds ?? []).map((v) => <option key={v} value={v}>{nodeTitle(project, v)}{idSuffix(v)}</option>)}
              </select></div>
          </>);
        })()}
        {a.op === 'showSection' && (
          <div className="field"><label htmlFor="rd-sec">Section</label>
            <select id="rd-sec" className="select" title={nodeTitle(project, a.targetNodeId)} value={a.targetNodeId} data-testid="action-target" onChange={(e) => onChange({ then: { op: 'showSection', targetNodeId: e.target.value } })}>
              <optgroup label="Rule-driven sections">{nodes.filter((n) => n.ruleDriven).map((n) => <option key={n.id} value={n.id}>{n.name ?? n.id}{idSuffix(n.id)}</option>)}</optgroup>
              <optgroup label="Other sections">{nodes.filter((n) => !n.ruleDriven).map((n) => <option key={n.id} value={n.id}>{n.name ?? n.id}{idSuffix(n.id)}</option>)}</optgroup>
            </select></div>
        )}
        {a.op === 'setPresentationHint' && (
          <div className="field"><label htmlFor="rd-hint">Hint (kebab-case)</label>
            <input id="rd-hint" className="input mono" list="rd-hints" value={a.hint} onChange={(e) => onChange({ then: { op: 'setPresentationHint', hint: e.target.value } })} data-testid="action-hint" />
            <datalist id="rd-hints">{hints.map((h) => <option key={h} value={h} />)}</datalist></div>
        )}
        {a.op === 'setApprovedLocale' && (<>
          <div className="field"><label htmlFor="rd-loc">Locale</label>
            <select id="rd-loc" className="select" value={a.locale} onChange={(e) => onChange({ then: { ...a, locale: e.target.value as Locale } })}><option value="en-US">en-US</option><option value="es-US">es-US</option></select></div>
          <label className="rd-check"><input type="checkbox" checked={!!a.errorIfMissingMandatoryTranslation} onChange={(e) => onChange({ then: { ...a, errorIfMissingMandatoryTranslation: e.target.checked } })} /> Error if mandatory translation is missing</label>
        </>)}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- test this rule */

interface TestRow { recordId: string; persona?: string; matched: boolean; outcome: string; inputs: Record<string, unknown>; primaryBefore: string | null; primaryAfter: string | null; changed: boolean; tiesAfter: number; findingsBefore: number; findingsAfter: number; current?: boolean }
interface TestOutcome { rows: TestRow[]; total: number; matched: number; changed: number; ties: number; primaryNode: string | null; target: string | null; error?: string; ranAt: string; modelVersion: number }

function testRule(project: Project, records: SyntheticRecord[], draft: Rule, current: SyntheticRecord | undefined, overrides: Record<string, unknown>, issueDate: string | null = null): TestOutcome {
  const exists = project.rules.some((r) => r.id === draft.id);
  const temp: Project = { ...project, rules: exists ? project.rules.map((r) => (r.id === draft.id ? draft : r)) : [...project.rules, draft] };
  const primaryNode = draft.then.op === 'selectVariant' ? draft.then.targetNodeId : project.nodes.find((n) => n.type === 'variant-set')?.id ?? null;
  const sel = (r: ReturnType<typeof resolve>) => (primaryNode ? r.result.selectedVariants[primaryNode] ?? null : null);
  const ties = (r: ReturnType<typeof resolve>) => r.findings.filter((f) => f.code === 'EXCLUSIVE_PRIORITY_TIE').length;
  const one = (rec: SyntheticRecord, ov: Record<string, unknown>, isCurrent = false): TestRow | null => {
    try {
      const before = resolve({ project, record: rec, overrides: ov, ...dated(issueDate) });
      const after = resolve({ project: temp, record: rec, overrides: ov, ...dated(issueDate) });
      const t = after.trace.find((x) => x.ruleId === draft.id && x.kind === 'rule');
      const pb = sel(before), pa = sel(after);
      return { recordId: rec.recordId, persona: rec.personaId, matched: !!t?.matched, outcome: t?.outcome ?? 'not-matched', inputs: t?.predicateInputs ?? {}, primaryBefore: pb, primaryAfter: pa, changed: pb !== pa, tiesAfter: ties(after), findingsBefore: before.findings.length, findingsAfter: after.findings.length, current: isCurrent };
    } catch { return null; }
  };
  const rows = records.map((r) => one(r, {})).filter(Boolean) as TestRow[];
  const cur = current ? one(current, overrides, true) : null;
  return {
    rows: cur ? [cur, ...rows] : rows,
    total: rows.length, matched: rows.filter((r) => r.matched).length, changed: rows.filter((r) => r.changed).length, ties: rows.filter((r) => r.tiesAfter > 0).length,
    primaryNode, target: draft.then.op === 'selectVariant' ? draft.then.targetNodeId : null, ranAt: new Date().toLocaleTimeString(), modelVersion: project.modelVersion,
  };
}

function TestPanel({ result, draft, onPick }: { result: TestOutcome; draft: Rule; onPick: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const interesting = result.rows.filter((r) => r.current || r.matched || r.changed);
  const shown = all ? result.rows : interesting.slice(0, 8);
  return (
    <div className="rd-test" data-testid="rule-test-result">
      <h3 className="section-title">Test result · {draft.id} against {result.total} records</h3>
      <div className="rd-stats">
        <div className="rd-stat"><strong data-testid="test-matched">{result.matched}</strong><span>records matched</span></div>
        <div className="rd-stat"><strong data-testid="test-changed">{result.changed}</strong><span>primary variant changes{result.primaryNode ? ` (${result.primaryNode})` : ''}</span></div>
        <div className={`rd-stat ${result.ties ? 'bad' : ''}`}><strong>{result.ties}</strong><span>records with an EXCLUSIVE_PRIORITY_TIE</span></div>
      </div>
      {result.ties > 0 && <div className="callout error rd-gap" role="alert"><SeverityLabel severity="blocking" /> This draft would make exclusive rules tie on {result.ties} record(s). Change its priority or condition before applying.</div>}
      <div className="rd-tablewrap">
        <table className="table">
          <caption className="rd-sr">Per-record evaluation of the draft rule</caption>
          <thead><tr><th scope="col">Record</th><th scope="col">Rule</th><th scope="col">Inputs used</th><th scope="col">Primary variant: before → after</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={(r.current ? 'cur-' : '') + r.recordId} className={r.current ? 'selected' : ''}>
                <td><button className="rowlink" onClick={() => onPick(r.recordId)} title="Switch scenario to this record">{r.recordId}</button>{r.current && <span className="chip accent rd-mini">current scenario</span>}<div className="muted">{r.persona ?? ''}</div></td>
                <td><span className={`chip ${r.matched ? 'accent' : ''}`}>{r.matched ? '✔ ' : '– '}{OUTCOME_WORD[r.outcome] ?? r.outcome}</span></td>
                <td className="mono rd-inputs">{Object.entries(r.inputs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') || '—'}</td>
                <td>{r.primaryBefore === null && r.primaryAfter === null ? <span className="muted">n/a</span> : <span className={r.changed ? 'rd-changed' : ''}>{r.primaryBefore ?? 'none'} → {r.primaryAfter ?? 'none'}{r.changed ? ' ● changed' : ' (same)'}</span>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={4} className="muted">This draft matches no record and changes nothing.</td></tr>}
          </tbody>
        </table>
      </div>
      {result.rows.length > shown.length || all ? <button className="btn sm" onClick={() => setAll(!all)}>{all ? 'Show matching/changed only' : `Show all ${result.rows.length} rows`}</button> : null}
      <p className="hint">Computed at {result.ranAt} from model v{result.modelVersion}. Computed against the unsaved draft; nothing was written to the model.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- right: trace */

const OUTCOME_ICON: Record<string, string> = { selected: '✔', outranked: '↓', tie: '⚠', applied: '✔', required: '■', 'not-matched': '–', disabled: '○', 'out-of-scope': '·' };

function TracePanel({ project, res, onSelectRule, fieldMap }: { project: Project; res: ReturnType<typeof useResolution>; onSelectRule: (id: string) => void; fieldMap: Map<string, FieldDef> }) {
  const [matchedOnly, setMatchedOnly] = useState(false);
  if (!res) return <aside className="panel" data-testid="rule-trace"><Loading label="Resolving scenario…" /></aside>;
  const entries = res.trace.filter((t) => !matchedOnly || t.matched);
  const order = { blocking: 0, error: 1, warning: 2, info: 3 } as Record<string, number>;
  const findings = [...res.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const fmt = (k: string, v: unknown) => { const f = fieldMap.get(k); return f?.type === 'cents' && typeof v === 'number' ? `${v} (${formatMoney(v)})` : JSON.stringify(v); };
  const plainVal = (k: string, v: unknown) => { const f = fieldMap.get(k); if (v === true) return 'yes'; if (v === false) return 'no'; if (v === null || v === undefined) return 'empty'; if (f?.type === 'cents' && typeof v === 'number') return formatMoney(v); return String(v); };
  const ruleOf = (id: string) => project.rules.find((r) => r.id === id);
  const matchedCount = res.trace.filter((t) => t.matched).length;
  return (
    <aside className="panel" data-testid="rule-trace" aria-label="Decision trace" data-side="right" data-side-title="Decision trace">
      <div className="panel-head"><Icon.list /> Decision trace <Tech><span className="sub mono">{res.recordId}</span></Tech>
        <div className="right"><label className="rd-check"><input type="checkbox" checked={matchedOnly} onChange={(e) => setMatchedOnly(e.target.checked)} /> matched only</label></div></div>
      <div className="panel-body rd-trace">
        <div className="rd-run">{matchedCount} of {res.trace.length} rules matched for this scenario</div>
        {res.documentDate && <div className="rd-run" data-testid="trace-document-date">{res.documentDate.date ? `${res.documentDate.given ? 'As issued on' : 'The document’s date:'} ${dayWords(res.documentDate.date)}` : 'This customer’s document has no date'}</div>}
        <Proof label="Run ID"><span className="mono rd-run">{res.runId} · {res.recordId}</span></Proof>
        <h3 className="section-title">Findings ({findings.length})</h3>
        {findings.length === 0 ? <div className="callout accent">No findings for this scenario.</div> : (
          <ul className="rd-findings" data-testid="trace-findings">{findings.map((f, i) => <FindingRow key={i} f={f} onSelectRule={onSelectRule} />)}</ul>
        )}
        <h3 className="section-title">Evaluations ({entries.length})</h3>
        <ol className="rd-trace-list">
          {entries.map((t, i) => {
            const rule = t.kind === 'rule' ? ruleOf(t.ruleId) : undefined;
            const word = OUTCOME_WORD[t.outcome] ?? t.outcome;
            const inputs = Object.entries(t.predicateInputs);
            return (
              <li key={t.ruleId + i} className={`rd-trace-item o-${t.outcome} ${t.matched ? 'm' : ''}`} data-testid={`trace-${t.ruleId}`}>
                <div className="rd-trace-head">
                  {rule && <span className="rd-trace-title" title={ruleTitle(project, rule)}>{ruleTitle(project, rule)}</span>}
                  <span className={`rd-state ${outcomeCls(t.outcome)}`}>{OUTCOME_ICON[t.outcome]} {t.outcome === 'out-of-scope' && t.period ? 'Not in effect' : word}</span>
                </div>
                <div className="rd-trace-head rd-trace-tags">
                  {t.kind === 'rule' ? <button className="rowlink mono rd-tid" onClick={() => onSelectRule(t.ruleId)} aria-label={`Open rule ${t.ruleId}`}>{t.ruleId}</button> : <span className="mono rd-tid">{t.ruleId}</span>}
                  <Tech>
                    <span className="chip">{t.mode ?? t.kind}</span>
                    {t.priority !== undefined && <span className="chip">P{t.priority}</span>}
                    <span className={`chip ${t.enabled ? '' : 'warning'}`}>{t.enabled ? 'enabled' : 'disabled'}</span>
                  </Tech>
                  <Biz>{!t.enabled && <span className="chip warning">off</span>}</Biz>
                </div>
                <div className="rd-trace-cond"><strong>{t.matched ? 'Matched' : 'Not matched'}:</strong> {predicateSentence(project, t.expression)}</div>
                <Biz>
                  {inputs.length > 0 && <div className="rd-trace-plain muted">Inputs: {inputs.map(([k, v]) => `${fieldLabel(project, k)} = ${plainVal(k, v)}`).join(' · ')}</div>}
                </Biz>
                <Tech>
                  <div className="rd-trace-cond mono rd-raw">{describePredicate(t.expression)}</div>
                  {inputs.length > 0 && (
                    <div className="rd-trace-inputs">{inputs.map(([k, v]) => <span key={k} className="rd-input"><span className="muted">{k}</span> = <b>{fmt(k, v)}</b></span>)}</div>
                  )}
                  {t.targetNodeId && <div className="rd-trace-target muted">target {t.targetNodeId}{t.action?.op === 'selectVariant' ? ` → ${t.action.variantId}` : ''}</div>}
                </Tech>
                {t.note && <div className="rd-trace-note">{t.note}</div>}
              </li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}

function FindingRow({ f, onSelectRule }: { f: Finding; onSelectRule: (id: string) => void }) {
  const ids = [...(f.ruleIds ?? []), ...(f.ruleId ? [f.ruleId] : [])];
  return (
    <li className={`rd-finding ${f.severity}`}>
      <div className="rd-finding-head"><SeverityLabel severity={f.severity} /><span className="mono rd-code">{f.code}</span>{f.nodeId && <span className="chip mono">{f.nodeId}</span>}</div>
      <div>{f.message}</div>
      {f.suggestion && <div className="muted">Suggestion: {f.suggestion}</div>}
      {ids.length > 0 && <div className="row wrap">{ids.map((id) => <button key={id} className="chip rd-chipbtn" onClick={() => onSelectRule(id)}>{id}</button>)}</div>}
    </li>
  );
}

/* ------------------------------------------------------ O04 customer record editor */

function RecordEditor({ project, fields, fieldMap }: { project: Project; fields: FieldDef[]; fieldMap: Map<string, FieldDef> }) {
  const record = useRecord();
  const res = useResolution();
  const overrides = useStudio((s) => s.ctx.overrides);
  const { patchOverrides, setOverrides, clearOverrides, toast } = useStudio.getState();
  const personas = useStudio((s) => s.personas);
  const eff = res?.effectiveRecord;
  const isCard = project.documentType === 'credit-statement';
  const diff = useMemo(() => diffOverrides(record, overrides, fieldMap), [record, overrides, fieldMap]);
  const [n, setN] = useState<number | undefined>(isCard ? 250 : undefined);
  const presets = EDGE_CASE_PRESETS.filter((p) => p.documentType === project.documentType);
  const [preset, setPreset] = useState(presets[0]?.id ?? '');
  const [gen, setGen] = useState<{ overrides: Record<string, unknown>; description: string; scenarioHash: string; seed: string; presetId: string } | null>(null);
  const [genState, setGenState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [genErr, setGenErr] = useState('');
  useEffect(() => { setGen(null); setPreset(presets[0]?.id ?? ''); }, [project.documentType, record?.recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = fields.filter((f) => !f.derived && f.type !== 'array' && f.path !== 'documentType' && f.path !== 'recordId');
  const groups = [...new Set(editable.map((f) => f.path.split('.')[0]))];
  const setField = (f: FieldDef, value: unknown) => {
    if (f.path.startsWith('claim.')) {
      const claims = (eff?.claims ?? []) as Array<Record<string, unknown>>;
      if (!claims.length) return;
      patchOverrides({ claims: claims.map((c, i) => (i === 0 ? { ...c, [f.path.slice(6)]: value } : c)) });
    } else patchOverrides(nest(f.path, value));
  };
  const overridden = (f: FieldDef) => {
    if (f.path.startsWith('claim.')) return diff.some((d) => d.key === `claims[0].${f.path.slice(6)}`);
    return diff.some((d) => d.key === f.path);
  };
  const sumTx = (eff?.card?.transactions ?? []).reduce((s, t) => s + (t as { amountCents: number }).amountCents, 0);
  const purchases = typeof eff?.card?.purchasesCents === 'number' ? (eff.card.purchasesCents as number) : 0;
  const txCount = (eff?.card?.transactions ?? []).length;

  const setTx = () => {
    if (!n || n < 1 || n > 2000) { toast({ kind: 'warning', title: 'Choose 1–2000 rows' }); return; }
    patchOverrides({ card: { transactions: makeTransactions(n, purchases) } });
  };
  const generate = async () => {
    if (!record) return;
    setGenState('loading'); setGenErr('');
    try { setGen(await api.generateEdgeCase(record.recordId, preset)); setGenState('idle'); }
    catch (e) { setGenState('error'); setGenErr((e as Error).message); setGen(null); }
  };

  return (
    <section className="panel" data-testid="customer-record-editor" aria-label="Customer record editor">
      <div className="panel-head">
        <Icon.design /> Scenario data
        <span className="sub mono">{record?.recordId}{record?.personaId ? ` · ${personaName(personas, record.personaId)}` : ''}</span>
        <div className="right">
          <span className={`chip ${diff.length ? 'warning' : ''}`} data-testid="override-count">{diff.length} override{diff.length === 1 ? '' : 's'}</span>
          <button className="btn sm" onClick={() => clearOverrides()} disabled={!Object.keys(overrides).length} data-testid="reset-scenario"><Icon.reset /> Reset scenario</button>
        </div>
      </div>
      <div className="panel-body rd-record">
        <p className="hint">Edits here are scenario overrides applied on top of the record. The record and the project model are never changed.</p>
        {!eff ? <Loading /> : (
          <div className="rd-record-grid">
            <div>
              <h3 className="section-title">Editable fields</h3>
              {groups.map((g) => (
                <fieldset key={g} className="rd-fs"><legend>{g}</legend>
                  <div className="rd-fields">
                    {editable.filter((f) => f.path.split('.')[0] === g).map((f) => {
                      const v = fieldValue(eff, f.path);
                      const id = `rf-${f.path}`;
                      const unavailable = f.path.startsWith('claim.') && !(eff.claims?.length);
                      return (
                        <div key={f.path} className={`rd-f ${overridden(f) ? 'ov' : ''}`}>
                          <label htmlFor={id}>{f.label}{overridden(f) && <span className="rd-ovmark" title="Overridden"> ●</span>}</label>
                          {f.type === 'enum' ? (
                            <select id={id} className="select" value={String(v ?? '')} disabled={unavailable} onChange={(e) => setField(f, e.target.value)} data-testid={`field-${f.path}`}>
                              {v === undefined && <option value="">—</option>}
                              {f.enumValues!.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : f.type === 'bool' ? (
                            <select id={id} className="select" value={v === undefined ? '' : String(v)} disabled={unavailable} onChange={(e) => setField(f, e.target.value === 'true')} data-testid={`field-${f.path}`}>
                              {v === undefined && <option value="">—</option>}<option value="true">true</option><option value="false">false</option>
                            </select>
                          ) : f.type === 'int' || f.type === 'points' || f.type === 'cents' ? (
                            <span className="rd-valwrap"><NumField id={id} label={f.label} value={typeof v === 'number' ? v : undefined} onCommit={(x) => setField(f, x)} testid={`field-${f.path}`} />{f.type === 'cents' && typeof v === 'number' && <span className="rd-hint">{formatMoney(v)}</span>}</span>
                          ) : f.type === 'date' ? (
                            <input id={id} className="input" type="date" value={String(v ?? '')} disabled={unavailable} onChange={(e) => setField(f, e.target.value)} data-testid={`field-${f.path}`} />
                          ) : (
                            <input id={id} className="input" value={String(v ?? '')} disabled={unavailable} onChange={(e) => setField(f, e.target.value)} data-testid={`field-${f.path}`} />
                          )}
                          <span className="hint mono">{f.path}</span>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
            <div>
              <h3 className="section-title">Override diff</h3>
              {diff.length === 0 ? <div className="callout">No overrides. The scenario equals the fixture record.</div> : (
                <ul className="rd-diff" data-testid="override-diff">
                  {diff.map((d) => (
                    <li key={d.key}><span className="mono rd-diff-k">{d.label}</span><span className="rd-diff-v"><span className="rd-old">{d.base}</span> → <b>{d.next}</b></span>
                      <button className="btn ghost sm icon" aria-label={`Revert ${d.label}`} onClick={() => setOverrides(unsetPath(overrides, d.revert))}><Icon.undo /></button></li>
                  ))}
                </ul>
              )}

              {isCard && (<>
                <h3 className="section-title">Transactions</h3>
                <div className="card">
                  <div className="row wrap">
                    <label htmlFor="rd-txn" className="muted">Set transactions to</label>
                    <NumField id="rd-txn" label="Transaction count" min={0} value={n} onCommit={setN} testid="tx-count" />
                    <button className="btn sm primary" onClick={setTx} data-testid="set-transactions">Set transactions to {n ?? '…'}</button>
                  </div>
                  <p className="hint" data-testid="tx-sum">Currently {txCount} rows summing to {formatMoney(sumTx)}; purchases {formatMoney(purchases)} {sumTx === purchases ? '✔ reconciled' : '▲ differs'}. New rows split purchases exactly in integer cents.</p>
                </div>
              </>)}

              {project.documentType !== 'custom' && <><h3 className="section-title">Edge-case generator</h3>
              <div className="card" data-testid="edge-case-generator">
                <div className="field"><label htmlFor="rd-preset">Preset</label>
                  <select id="rd-preset" className="select" value={preset} onChange={(e) => { setPreset(e.target.value); setGen(null); }} data-testid="edge-preset">
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  <span className="hint">{presets.find((p) => p.id === preset)?.description}</span></div>
                <button className="btn sm" onClick={generate} disabled={genState === 'loading' || !preset} data-testid="generate-edge">{genState === 'loading' ? <span className="spinner" /> : <Icon.target />} Generate inputs</button>
                {genState === 'error' && <div className="callout error rd-gap" role="alert">{genErr} <button className="btn sm" onClick={generate}>Retry</button></div>}
                {gen && (
                  <div className="rd-gen" data-testid="edge-preview">
                    <div className="muted">{gen.description} · seed <span className="mono">{gen.seed}</span> · scenario <span className="mono">{gen.scenarioHash}</span></div>
                    <pre className="code" aria-label="Generated overrides preview">{pretty(abridge(gen.overrides))}</pre>
                    <div className="row"><button className="btn primary sm" data-testid="apply-edge" onClick={() => { setOverrides(gen.overrides); setGen(null); }}>Apply as scenario overrides</button><button className="btn ghost sm" onClick={() => setGen(null)}>Discard</button></div>
                    <p className="hint">Shown before applying. Applying replaces the current scenario overrides; Reset scenario undoes it.</p>
                  </div>
                )}
              </div></>}
              {project.documentType === 'custom' && <p className="hint" data-testid="own-data-edge-note">To try values just below, on and above a limit your rules use, generate test customers: the “Generate test customers” button in the rule list makes one customer for each edge.</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
function personaName(personas: Array<{ id: string; name: string }>, id: string) { return personas.find((p) => p.id === id)?.name ?? id; }

/* ----------------------------------------------------------- O03 token picker */

function TokenPicker({ fields }: { fields: FieldDef[] }) {
  const res = useResolution();
  const toast = useStudio((s) => s.toast);
  const [q, setQ] = useState('');
  const eff = res?.effectiveRecord;
  const list = fields.filter((f) => !q || `${f.path} ${f.label} ${f.type}`.toLowerCase().includes(q.toLowerCase()));
  const copy = async (path: string) => {
    try { await navigator.clipboard.writeText(`{{${path}}}`); toast({ kind: 'success', title: 'Token copied', message: `{{${path}}}` }); }
    catch { toast({ kind: 'info', title: 'Token', message: `{{${path}}}` }); }
  };
  return (
    <aside className="panel" data-testid="token-picker" aria-label="Field token picker">
      <div className="panel-head"><Icon.list /> Fields &amp; tokens <span className="sub">{fields.length} paths</span></div>
      <div className="rd-tp-search"><input className="input" type="search" placeholder="Search path, label or type…" aria-label="Search fields" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="panel-body rd-tp">
        <table className="table">
          <caption className="rd-sr">Schema paths with types and current example values</caption>
          <thead><tr><th scope="col">Path</th><th scope="col">Type</th><th scope="col">Current</th><th scope="col"><span className="rd-sr">Copy</span></th></tr></thead>
          <tbody>
            {list.map((f) => {
              const v = f.path.startsWith('claim.') ? fieldValue(eff, f.path) : f.derived ? derivedValue(eff, f.path) : fieldValue(eff, f.path);
              return (
                <tr key={f.path}>
                  <td><div className="mono rd-tp-path">{f.path}</div><div className="muted">{f.label}{f.derived ? ' · derived' : ''}</div>
                    {f.itemFields && <div className="rd-tp-items">{f.itemFields.map((i) => <span key={i.key} className="chip mono">{i.key}:{i.type}</span>)}</div>}</td>
                  <td><span className="chip">{f.type}</span></td>
                  <td className="rd-tp-val">{show(v, f)}</td>
                  <td><button className="btn ghost sm icon" aria-label={`Copy token for ${f.path}`} onClick={() => copy(f.path)}><Icon.copy /></button></td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={4} className="muted">No field matches “{q}”.</td></tr>}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
function derivedValue(rec: SyntheticRecord | undefined, path: string): unknown {
  if (!rec) return undefined;
  const v = getPath(rec, path);
  if (v !== null && v !== undefined) return v;
  const card = rec.card as { transactions?: Array<{ amountCents: number }>; creditLimitCents?: number; newBalanceCents?: number } | undefined;
  // The calculated number of rows of a list field.
  const listPath = /^(custom\.[A-Za-z0-9]+)\.count$/.exec(path)?.[1];
  if (listPath) { const rows = getPath(rec, listPath); return Array.isArray(rows) ? rows.length : undefined; }
  if (path === 'card.transactionsTotalCents') return card?.transactions?.reduce((s, t) => s + t.amountCents, 0);
  if (path === 'card.availableCreditCents' && card) return (card.creditLimitCents ?? 0) - (card.newBalanceCents ?? 0);
  return undefined;
}

