import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolve } from '@iss/resolver';
import type { Finding } from '@iss/resolver';
import { proposeFixes, fixImpact, safeFixPlan, type AssistLink, type FixImpact, type FixProposal } from '@iss/scenarios';
import { ScreenHeader, Loading, SeverityLabel, Proof, Tech, Named, Dialog } from '../ui/common';
import { ProposalCard, ImpactLine, applyAssistCommands } from '../assist/common';
import { nodeTitle, ruleTitle, localeLabel } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useStudio, useResolution, useScenarioRequest, useRecord, useScenarioEngine, editBlockedReason } from '../state/store';
import { recordSummary } from '../shell/RecordPicker';
import { api, ApiFailure, type PdfAccessibilityDto } from '../api/client';
import { abridge } from './RulesData';
import { ParityRow, blockWord } from './PreviewExport';
import { ResolveInBlockers } from './blockers/link';
import './PreviewExport.css';
import './ValidateCompare.css';

/* ------------------------------------------------------------------ types */

type Suite = 'rules' | 'bindings' | 'pagination' | 'parity' | 'accessibility';
type Sev = 'blocking' | 'error' | 'warning' | 'info';
const SUITES: Array<{ id: Suite; label: string; what: string }> = [
  { id: 'rules', label: 'Rules', what: 'Exclusive ties, no-match, input consistency, required content' },
  { id: 'bindings', label: 'Bindings', what: 'Typed field paths and null policies' },
  { id: 'pagination', label: 'Pagination', what: 'Real composer page metrics and table continuation' },
  { id: 'parity', label: 'PDF / HTML parity', what: 'Semantic facts emitted by each output' },
  { id: 'accessibility', label: 'Accessibility', what: 'Model checks, automated axe on the HTML output, and the PDF accessibility checks (plus veraPDF when it is installed)' },
];
const SEVS: Sev[] = ['blocking', 'error', 'warning', 'info'];

interface Issue {
  issueId: string; code: string; severity: Sev; suite: Suite; message: string; nodeId?: string; ruleIds?: string[]; ruleId?: string; page?: number; locale?: string;
  suggestion?: string; details?: Record<string, unknown>; runId?: string; source?: string;
  reproduction?: { recordId: string; overrides?: Record<string, unknown>; journeyCursor?: number | null };
}
interface ParityCheck { id: string; label: string; status: 'match' | 'mismatch' | 'allowed-difference'; blocking: boolean; expected: unknown; pdf?: unknown; html?: unknown; note?: string }
interface Report {
  runId: string; modelVersion: number; contentDigest: string; issues: Issue[]; counts: Record<Sev, number>; pageCount: number | null; note?: string;
  suites: Record<Suite, { status: 'clean' | 'warnings' | 'errors' | 'not-run'; count: number; durationMs: number }>;
  parity: { ok: boolean; checks: ParityCheck[]; allowedDifferences: string[] } | null;
  /** The accessibility suite's PDF part (absent when that suite did not run). */
  pdfAccessibility?: PdfAccessibilityDto | null;
  // client-side metadata
  recordId: string; overrideCount: number; ranAt: string; ranAtMs: number; elapsedMs: number; suitesRequested: Suite[];
}

/** Keeps the last report per project so Go-to-source and back does not lose it. Never used as model state. */
const lastReports = new Map<string, Report>();

function relAgo(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
}

/** Plain-language headline for a check code (readable words; the code itself stays beside it as a chip). */
const BLOCK_TITLE = (code: string, details?: Record<string, unknown>): string => {
  // The PDF accessibility checks word their own titles.
  if (code.startsWith('PDF_A11Y_') && typeof details?.title === 'string') return `PDF: ${details.title}`;
  const w = blockWord(code); return w.charAt(0).toUpperCase() + w.slice(1);
};

const RESOLVER_SOURCES: Finding['source'][] = ['resolver', 'domain', 'binding', 'composer', 'parity', 'accessibility', 'rules-static', 'translation'];
const SUITE_SOURCE: Record<Suite, Finding['source']> = { rules: 'resolver', bindings: 'binding', pagination: 'composer', parity: 'parity', accessibility: 'accessibility' };
/** The resolver's Finding shape for an issue this screen holds (server suites or the All customers grouping). */
function toFinding(i: Pick<Issue, 'code' | 'severity' | 'nodeId' | 'ruleId' | 'ruleIds' | 'locale' | 'message' | 'source' | 'details' | 'suggestion' | 'page' | 'suite'>): Finding {
  const f: Finding = { code: i.code, severity: i.severity as Finding['severity'], message: i.message, source: RESOLVER_SOURCES.includes(i.source as Finding['source']) ? (i.source as Finding['source']) : SUITE_SOURCE[i.suite] };
  if (i.nodeId) f.nodeId = i.nodeId;
  if (i.locale) f.locale = i.locale;
  if (i.ruleIds?.length) f.ruleIds = i.ruleIds;
  if (i.ruleId) f.ruleId = i.ruleId;
  if (i.suggestion) f.suggestion = i.suggestion;
  if (i.page !== undefined) f.page = i.page;
  if (i.details) f.details = i.details;
  return f;
}

const idsOf = (i: Issue) => [...(i.ruleIds ?? []), ...(i.ruleId && !(i.ruleIds ?? []).includes(i.ruleId) ? [i.ruleId] : [])];
const sevRank = (s: Sev) => SEVS.indexOf(s);

/** Issues that report the same root cause (same rule pair) from different checks are shown as one card. */
interface Group { key: string; primary: Issue; members: Issue[]; severity: Sev }
function groupIssues(list: Issue[]): Group[] {
  const out: Group[] = []; const byKey = new Map<string, Group>();
  for (const i of list) {
    const ids = [...new Set(idsOf(i))].sort();
    const key = ids.length >= 2 ? `pair:${ids.join('+')}` : `issue:${i.issueId}`;
    const g = byKey.get(key);
    if (g) { g.members.push(i); if (sevRank(i.severity) < sevRank(g.severity)) { g.severity = i.severity; g.primary = i; } }
    else { const n: Group = { key, primary: i, members: [i], severity: i.severity }; byKey.set(key, n); out.push(n); }
  }
  return out;
}
const countGroups = (gs: Group[]): Record<Sev, number> => { const c: Record<Sev, number> = { blocking: 0, error: 0, warning: 0, info: 0 }; gs.forEach((g) => { c[g.severity]++; }); return c; };

/* ----------------------------------------------------------------- screen */

export function ValidateCompare() {
  const project = useStudio((s) => s.project);
  const ctx = useStudio((s) => s.ctx);
  const navigate = useNavigate();
  const req = useScenarioRequest();
  const res = useResolution();
  const record = useRecord();

  const [report, setReport] = useState<Report | null>(() => (project ? lastReports.get(project.projectId) ?? null : null));
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [suites, setSuites] = useState<Suite[]>(SUITES.map((s) => s.id));
  const [selected, setSelected] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [sevFilter, setSevFilter] = useState<Sev[]>([...SEVS]);
  const [suiteFilter, setSuiteFilter] = useState<'all' | Suite>('all');
  const [scope, setScopeState] = useState<Scope>(readScope);
  const setScope = (v: Scope) => { setScopeState(v); try { localStorage.setItem(SCOPE_KEY, v); } catch { /* storage unavailable */ } };
  const [want, setWant] = useState<{ code: string; nodeId?: string } | null>(null);
  const [bSel, setBSel] = useState<string | null>(null);
  const [fixAll, setFixAll] = useState(false);
  const [onlyBlockingPick, setOnlyBlockingPick] = useState<boolean | null>(null);
  const blockers = useBlockers(scope === 'all');
  const seq = useRef(0);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { if (project) setReport(lastReports.get(project.projectId) ?? null); setSelected(null); setFailedKey(null); }, [project?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (status !== 'running') return;
    const t0 = performance.now();
    const h = setInterval(() => setElapsed(Math.round((performance.now() - t0) / 100) / 10), 100);
    return () => clearInterval(h);
  }, [status]);

  /** The server validates in the paged-pdf context; compare with the identical local run id to detect staleness. */
  const currentRunId = useMemo(() => {
    if (!project || !record || record.documentType !== project.documentType) return null;
    if (ctx.profileId === 'paged-pdf' && res) return res.runId;
    try { return resolve({ project, record, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor, profileId: 'paged-pdf', ...(project.documentDate && ctx.issueDate ? { issueDate: ctx.issueDate } : {}) }).runId; } catch { return null; }
  }, [project, record, ctx.overrides, ctx.journeyCursor, ctx.profileId, ctx.issueDate, res]);
  const stale = !!report && !!currentRunId && report.runId !== currentRunId;

  const sameSuites = (a: Suite[], b: Suite[]) => a.length === b.length && a.every((x) => b.includes(x));
  const runKey = `${currentRunId ?? ''}|${[...suites].sort().join(',')}`;
  const runKeyRef = useRef(runKey);
  runKeyRef.current = runKey;
  const inflightKey = useRef<string | null>(null);

  const run = async (opts: { manual?: boolean } = {}) => {
    if (!req || !project || !suites.length) return;
    /* A manual click while the in-flight run already covers the current run simply waits for it. */
    if (opts.manual && inflightKey.current === runKey) return;
    const my = ++seq.current;
    const myKey = runKey;
    inflightKey.current = myKey;
    setStatus('running'); setError(null); setElapsed(0);
    const t0 = performance.now();
    try {
      // With the accessibility suite, veraPDF runs as well when it is installed on the studio's machine (never downloaded).
      const out = await api.validateChecks({ ...req, suites, ...(suites.includes('accessibility') ? { verapdf: true } : {}) });
      if (my !== seq.current) return;
      inflightKey.current = null;
      const rep: Report = {
        ...out, recordId: req.recordId, overrideCount: Object.keys(req.overrides ?? {}).length, ranAt: new Date().toLocaleTimeString(), ranAtMs: Date.now(), elapsedMs: Math.round(performance.now() - t0), suitesRequested: suites,
        issues: (out.issues ?? []) as Issue[],
      };
      lastReports.set(project.projectId, rep);
      setReport(rep); setStatus('idle');
    } catch (e) {
      if (my !== seq.current) return;
      inflightKey.current = null;
      const f = e instanceof ApiFailure ? e : null;
      setError({ title: f ? `Validation failed (${f.code})` : 'Validation failed', message: (e as Error).message });
      setFailedKey(myKey);
      setStatus('error');
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  /** Run automatically on open and (debounced) whenever the current run or the chosen suites change. */
  const upToDate = !!report && !!currentRunId && report.runId === currentRunId && sameSuites(report.suitesRequested, suites);
  const firstRun = useRef(true);
  useEffect(() => {
    if (!req || !project || !currentRunId || !suites.length) return;
    if (upToDate || inflightKey.current === runKey || failedKey === runKey) return;
    const t = setTimeout(() => { firstRun.current = false; void runRef.current(); }, firstRun.current && !report ? 30 : 800);
    return () => clearTimeout(t);
  }, [runKey, upToDate, !!req, project?.projectId, failedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (failedKey && failedKey !== runKey) setFailedKey(null); }, [runKey, failedKey]);

  const [, setTick] = useState(0);
  useEffect(() => { const h = setInterval(() => setTick((t) => t + 1), 20000); return () => clearInterval(h); }, []);

  /** The shell dock compares against the server's raw per-check counts. */
  useEffect(() => { useStudio.getState().setLastValidation(report ? { runId: report.runId, counts: report.counts } : null); }, [report]);

  const issues = report?.issues ?? [];
  const groups = useMemo(() => groupIssues(issues), [issues]);
  const gCounts = useMemo(() => countGroups(groups), [groups]);
  const shown = useMemo(() => groups.filter((g) => sevFilter.includes(g.severity) && (suiteFilter === 'all' || g.members.some((i) => i.suite === suiteFilter))).sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.primary.suite.localeCompare(b.primary.suite)), [groups, sevFilter, suiteFilter]);
  const currentGroup = groups.find((g) => g.primary.issueId === selected) ?? null;
  const current = currentGroup?.primary ?? null;
  /* Never an empty detail panel: first blocking issue, else the first issue in list order (list is severity-sorted). */
  useEffect(() => {
    if (!shown.length) { if (selected) setSelected(null); return; }
    if (!selected || !shown.some((g) => g.primary.issueId === selected)) setSelected((shown.find((g) => g.severity === 'blocking') ?? shown[0]).primary.issueId);
  }, [shown, selected]);

  const choose = (id: string, focusInspector = false) => {
    setSelected(id);
    useStudio.getState().setCtx({ activeValidationIssue: id });
    if (focusInspector) setTimeout(() => inspectorRef.current?.focus(), 0);
  };
  /* "Preview this customer" from the All customers view: land on the same issue in the single-customer view once its run is current. */
  useEffect(() => {
    if (!want || scope !== 'this' || !report || !upToDate) return;
    const g = groups.find((x) => x.members.some((m) => m.code === want.code && (!want.nodeId || m.nodeId === want.nodeId))) ?? groups.find((x) => x.members.some((m) => m.code === want.code));
    if (g) { setSevFilter([...SEVS]); setSuiteFilter('all'); choose(g.primary.issueId); }
    setWant(null);
  }, [want, scope, report, upToDate, groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const onlyBlocking = onlyBlockingPick ?? (blockers.data ? blockers.data.groups.some((g) => isBlocking(g.severity)) : true);
  const bShown = useMemo(() => (blockers.data?.groups ?? []).filter((g) => !onlyBlocking || isBlocking(g.severity)), [blockers.data, onlyBlocking]);
  const bCurrent = bShown.find((g) => g.key === bSel) ?? null;
  useEffect(() => {
    if (scope !== 'all') return;
    if (!bShown.length) { if (bSel) setBSel(null); return; }
    if (!bSel || !bShown.some((g) => g.key === bSel)) setBSel((bShown.find((g) => isBlocking(g.severity)) ?? bShown[0]).key);
  }, [scope, bShown, bSel]);
  const previewCustomer = (recordId: string, g: BGroup) => {
    const st = useStudio.getState();
    const cursor = st.ctx.journeyCursor;
    st.setRecord(recordId);
    st.setJourneyCursor(cursor); // setRecord resets the journey step; the blockers were computed for this one
    setWant({ code: g.code, nodeId: g.nodeId });
    setScope('this');
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const btns = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-issue]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    btns[n].focus();
    choose(btns[n].dataset.issue!);
  };

  const base = project ? `/studio/${project.projectId}` : '';
  const goTo = (i: Issue, ruleId?: string) => {
    const st = useStudio.getState();
    if (i.nodeId && project?.nodes.some((n) => n.id === i.nodeId)) st.select(i.nodeId);
    const rid = ruleId ?? idsOf(i)[0];
    if (rid) navigate(`${base}/rules-data?rule=${encodeURIComponent(rid)}`);
    else if (i.suite === 'rules') navigate(`${base}/rules-data`);
    else if (i.suite === 'pagination') navigate(`${base}/page-stack`);
    else if (i.suite === 'parity' && !i.nodeId) navigate(`${base}/outputs`);
    else navigate(`${base}/design`);
  };
  const reportCurrent = !!report && upToDate;
  const serverFindings = useMemo(() => (report && reportCurrent ? report.issues.map(toFinding) : []), [report, reportCurrent]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useSafePlan(serverFindings);
  const openLink = (link: AssistLink) => {
    const st = useStudio.getState();
    if (link.nodeId && st.project?.nodes.some((n) => n.id === link.nodeId)) st.select(link.nodeId);
    const rid = link.ruleId;
    navigate(`${base}/${link.view}${link.view === 'rules-data' && rid ? `?rule=${encodeURIComponent(rid)}` : ''}`);
  };
  /** From the PDF accessibility panel: the matching issue of the list, selected and shown in the detail panel. */
  const showPdfIssue = (code: string, nodeId: string | undefined, page: number | undefined) => {
    const g = groups.find((x) => x.members.some((m) => m.code === code && m.nodeId === nodeId && m.page === page)) ?? groups.find((x) => x.members.some((m) => m.code === code && m.nodeId === nodeId));
    if (!g) return;
    setSevFilter([...SEVS]); setSuiteFilter('all');
    choose(g.primary.issueId, true);
  };
  const blockerIssue = (g: BGroup): Issue => ({ issueId: g.key, code: g.code, severity: g.severity, suite: g.suite, message: g.message, nodeId: g.nodeId, ruleIds: g.ruleIds, locale: g.locale, suggestion: g.suggestion });
  const sourceLabel = (i: Issue) => (idsOf(i).length ? `Rule ${idsOf(i)[0]} in Rules & Data` : i.suite === 'rules' ? 'Rules & Data' : i.suite === 'pagination' ? 'Page Composition Stack' : i.suite === 'parity' && !i.nodeId ? 'Preview & Export' : `${i.nodeId ?? 'node'} in Design Studio`);

  if (!project) return <Loading label="Loading project…" />;
  const running = status === 'running';
  const who = record ? `${record.customer.givenName} ${record.customer.familyName}` : 'this customer';
  const outdated = stale || (!!report && !upToDate && !!currentRunId && report.runId !== currentRunId);
  const pending = !running && !report && status !== 'error' && suites.length > 0;

  return (
    <section className="screen" data-testid="validate-view">
      <ScreenHeader id="S09" title="Validate & Compare"
        subtitle="Runs automatically for the current customer and scenario: real rule, binding, pagination, PDF/HTML parity and accessibility checks, then jump to the exact cause."
        actions={
          <>
            <span className={`vc-fresh ${outdated ? 'old' : ''}`} role="status" data-testid={outdated ? 'stale-marker' : 'validation-freshness'}>
              {running ? (report && outdated ? 'Out of date — re-running…' : 'Checking…')
                : !report ? (status === 'error' ? 'Not checked' : 'Starting checks…')
                : outdated ? (status === 'error' ? 'Out of date — re-run failed' : 'Out of date — re-running…')
                : `Checked ${relAgo(report.ranAtMs)} · up to date`}
            </span>
            <FixAllButton plan={plan} onOpen={() => setFixAll(true)} />
            <button className="btn primary" onClick={() => void run({ manual: true })} disabled={!req || !suites.length} aria-busy={running} data-testid="run-validation">
              {running ? <span className="spinner" /> : <Icon.validate />} {running ? `Validating… ${elapsed.toFixed(1)}s` : report ? 'Re-run' : 'Run validation'}
            </button>
          </>
        } />
      <div className="screen-body vc-body">
        <div className="vc-main" aria-busy={running}>
          <ScopeSwitch scope={scope} onChange={setScope} />
          {scope === 'all' && <BlockersAll state={blockers} shown={bShown} selected={bSel} onSelect={setBSel} onlyBlocking={onlyBlocking} onToggle={setOnlyBlockingPick} />}
          {scope === 'this' && <>
          {/* run status */}
          <div className="vc-status" aria-live="polite">
            {(running || pending) && !report && <div className="callout accent" data-testid="validation-progress"><span className="spinner" /> Checking {who}: rules, bindings, pagination, parity and accessibility. Pagination and parity compose a PDF, so the first results take a few seconds.</div>}
            {running && report && <div className="callout accent" data-testid="validation-progress"><span className="spinner" /> Re-checking {who} after your change; the results below are the previous run until this finishes.</div>}
            {status === 'error' && error && (
              <div className="callout error" role="alert" data-testid="validation-error"><strong>{error.title}.</strong> {error.message} <button className="btn sm" onClick={() => { setFailedKey(null); void run(); }}><Icon.reset /> Retry</button></div>
            )}
            {outdated && !running && status !== 'error' && <Tech><div className="callout warning"><span className="muted">report <span className="mono">{report!.runId}</span> · current <span className="mono">{currentRunId}</span></span></div></Tech>}
          </div>

          {/* suite selection */}
          <fieldset className="vc-suitepick">
            <legend>Suites to run</legend>
            {SUITES.map((s) => (
              <label key={s.id} className="vc-check" title={s.what}>
                <input type="checkbox" checked={suites.includes(s.id)} onChange={() => setSuites((cur) => (cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id]))} data-testid={`suite-toggle-${s.id}`} /> {s.label}
              </label>
            ))}
          </fieldset>

          {(report || running || pending) && (
            <>
              <Overview report={report} running={running} suites={suites} stale={outdated} gCounts={gCounts} />
              <section className="panel vc-listpanel" data-testid="validation-list-panel" aria-label="Issues">
                <div className="panel-head">Issues <span className="sub">{report ? `${shown.length} of ${groups.length} issue${groups.length === 1 ? '' : 's'}${groups.length !== issues.length ? ` (${issues.length} checks)` : ''}` : ''}</span>
                  <div className="right">
                    <label className="vc-sel"><span className="rd-sr">Filter by suite</span>
                      <select className="select" value={suiteFilter} onChange={(e) => setSuiteFilter(e.target.value as 'all' | Suite)} aria-label="Filter by suite" data-testid="filter-suite">
                        <option value="all">All suites</option>{SUITES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select></label>
                  </div>
                </div>
                <div className="vc-sevfilter" role="group" aria-label="Filter by severity">
                  {SEVS.map((s) => (
                    <label key={s} className={`vc-check vc-sev ${s}`}>
                      <input type="checkbox" checked={sevFilter.includes(s)} data-testid={`filter-${s}`} onChange={() => setSevFilter((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))} /> {s} <span className="vc-n">{report ? gCounts[s] : ''}</span>
                    </label>
                  ))}
                </div>
                <div className="vc-list-scroll">
                  {report && (
                    <ul className="vc-list list-rows" data-testid="validation-list" aria-label="Validation issues" ref={listRef} onKeyDown={onListKey}>
                      {shown.map((g) => {
                        const i = g.primary;
                        const multi = g.members.length > 1;
                        const sel = selected === i.issueId;
                        const plain = BLOCK_TITLE(i.code, i.details);
                        return (
                          <li key={g.key} className={`vc-item ${sel ? 'selected' : ''}`}>
                            <button type="button" data-issue={i.issueId} data-testid={`issue-${i.code}`} className={`vc-issue ${g.severity}`} aria-current={sel} onClick={() => choose(i.issueId)}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); choose(i.issueId, true); } }}>
                              <span className="vc-issue-top"><SeverityLabel severity={g.severity} />
                                {plain && <strong className="vc-title">{plain}</strong>}
                                <span className="chip code">{i.code}</span>
                                <span className="muted vc-suite">{SUITES.find((x) => x.id === i.suite)?.label ?? i.suite}</span>
                                {i.nodeId && <Named name={nodeTitle(project, i.nodeId)} code={i.nodeId} />}
                                {[...new Set(g.members.flatMap(idsOf))].map((r) => <span key={r} className="chip code">{r}</span>)}
                                {i.page !== undefined && <span className="chip count">page {i.page}</span>}
                                {multi && <span className="chip info">{g.members.length} checks agree</span>}</span>
                              <span className="vc-issue-msg">{i.message}</span>
                            </button>
                            {i.severity === 'blocking' && <span className="vc-resolve"><ResolveInBlockers finding={toFinding(i)} /></span>}
                            {multi && (
                              <details className="vc-agree">
                                <summary>Show the {g.members.length} agreeing checks</summary>
                                <ul>{g.members.map((m) => <li key={m.issueId}><span className="chip code">{m.code}</span> <span className="muted">{SUITES.find((x) => x.id === m.suite)?.label ?? m.suite}{m.source ? ` · ${m.source}` : ''}</span></li>)}</ul>
                              </details>
                            )}
                          </li>
                        );
                      })}
                      {!shown.length && (
                        <li className="vc-clean" data-testid="validation-clean">
                          {groups.length ? 'No issues match the current filters.' : <><span className="sev ok">✔ Clean</span> No findings from the {report.suitesRequested.length} suite(s) that ran. Automated checks are not WCAG or regulatory certification.</>}
                        </li>
                      )}
                    </ul>
                  )}
                  {!report && <Loading label="Waiting for the first results…" />}
                </div>
              </section>
              {report && <ParityPanel report={report} />}
              {report && <PdfAccessibilityPanel report={report} onShow={showPdfIssue} onOpen={(nodeId) => goTo({ issueId: 'pdf', code: 'PDF', severity: 'warning', suite: 'accessibility', message: '', nodeId })} />}
            </>
          )}
          </>}
          <p className="hint vc-note" data-testid="certification-note">Automated checks are not WCAG or regulatory certification. They are necessary but not sufficient. “Checked by the studio” means the studio’s own PDF checks, not validation against PDF/UA; only a veraPDF run validates the PDF against the PDF/UA-1 profile.</p>
        </div>

        <aside className="panel vc-inspector" data-side="right" data-side-title="Issue detail" data-testid="validation-inspector" aria-label="Validation detail" tabIndex={-1} ref={inspectorRef}>
          {scope === 'all' ? <BlockerDetail group={bCurrent} data={blockers.data} loading={blockers.loading} onlyBlocking={onlyBlocking} onPreview={previewCustomer} onGo={(g) => goTo(blockerIssue(g))} onOpenLink={openLink} sourceLabel={bCurrent ? sourceLabel(blockerIssue(bCurrent)) : ''} /> : current ? <Inspector issue={current} members={currentGroup!.members} onGo={goTo} onOpenLink={openLink} sourceLabel={sourceLabel(current)} stale={outdated} /> : (
            <Summary report={report} running={running || pending} who={who} recordId={record?.recordId} gCounts={gCounts} filtered={groups.length > 0} />
          )}
        </aside>
      </div>
      {fixAll && plan.ready && plan.plan && plan.plan.batch && <FixAllDialog plan={plan.plan} onClose={() => setFixAll(false)} />}
    </section>
  );
}

/* ------------------------------------------------- all customers (blockers) */

type Scope = 'this' | 'all';
const SCOPE_KEY = 'iss.validateScope';
const readScope = (): Scope => { try { return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'this'; } catch { return 'this'; } };
const isBlocking = (s: Sev) => s === 'blocking' || s === 'error';

interface BGroup {
  key: string; code: string; severity: Sev; suite: Suite; nodeId?: string; ruleIds: string[]; locale?: string; message: string; suggestion?: string;
  recordIds: string[]; messages: Map<string, string>; source?: Finding['source']; details?: Record<string, unknown>;
}
interface BData { engine: unknown; cursor: number | null; profileId: string; groups: BGroup[]; total: number; affected: number; blockedIds: Set<string> }

/** Resolves every synthetic record once for the current profile and journey step (engine caches), after first paint, and groups the findings by issue. */
function useBlockers(active: boolean): { data: BData | null; loading: boolean } {
  const engine = useScenarioEngine();
  const cursor = useStudio((s) => s.ctx.journeyCursor);
  const profileId = useStudio((s) => s.ctx.profileId);
  const [data, setData] = useState<BData | null>(null);
  const fresh = !!data && data.engine === engine && data.cursor === cursor && data.profileId === profileId;
  useEffect(() => {
    if (!active || !engine || fresh) return;
    let cancelled = false;
    const h = setTimeout(() => {
      const scen = engine.universe({ journeyCursors: [cursor], profiles: [profileId] });
      const byKey = new Map<string, BGroup>();
      const blockedIds = new Set<string>();
      const affectedIds = new Set<string>();
      for (const sc of scen) {
        const res = engine.resolveScenario(sc);
        for (const f of res.findings) {
          if (f.severity === 'info') continue;
          const sev = f.severity as Sev;
          const ruleIds = [...new Set([...(f.ruleIds ?? []), ...(f.ruleId ? [f.ruleId] : [])])].sort();
          const key = [f.code, f.nodeId ?? '', ruleIds.join('+'), f.locale ?? ''].join('|');
          let g = byKey.get(key);
          if (!g) {
            const suite: Suite = f.source === 'binding' ? 'bindings' : f.source === 'accessibility' ? 'accessibility' : f.source === 'composer' ? 'pagination' : f.source === 'parity' ? 'parity' : 'rules';
            g = { key, code: f.code, severity: sev, suite, nodeId: f.nodeId, ruleIds, locale: f.locale, message: f.message, suggestion: f.suggestion, source: f.source, details: f.details, recordIds: [], messages: new Map() };
            byKey.set(key, g);
          }
          if (sevRank(sev) < sevRank(g.severity)) g.severity = sev;
          if (!g.recordIds.includes(sc.recordId)) g.recordIds.push(sc.recordId);
          if (!g.messages.has(sc.recordId)) g.messages.set(sc.recordId, f.message);
          affectedIds.add(sc.recordId);
          if (isBlocking(sev)) blockedIds.add(sc.recordId);
        }
      }
      const groups = [...byKey.values()].sort((a, b) => Number(isBlocking(b.severity)) - Number(isBlocking(a.severity)) || sevRank(a.severity) - sevRank(b.severity) || b.recordIds.length - a.recordIds.length || a.code.localeCompare(b.code));
      if (!cancelled) setData({ engine, cursor, profileId, groups, total: scen.length, affected: affectedIds.size, blockedIds });
    }, 30);
    return () => { cancelled = true; clearTimeout(h); };
  }, [active, engine, cursor, profileId, fresh]);
  return { data: fresh ? data : null, loading: active && !fresh };
}

function ScopeSwitch({ scope, onChange }: { scope: Scope; onChange: (s: Scope) => void }) {
  return (
    <div className="vc-scope">
      <div className="segmented" role="group" aria-label="Validation scope">
        <button type="button" aria-pressed={scope === 'this'} onClick={() => onChange('this')} data-testid="scope-this">This customer</button>
        <button type="button" aria-pressed={scope === 'all'} onClick={() => onChange('all')} data-testid="scope-all">All customers</button>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function BlockersAll({ state, shown, selected, onSelect, onlyBlocking, onToggle }: { state: { data: BData | null; loading: boolean }; shown: BGroup[]; selected: string | null; onSelect: (k: string) => void; onlyBlocking: boolean; onToggle: (v: boolean) => void }) {
  const project = useStudio((s) => s.project)!;
  const listRef = useRef<HTMLUListElement>(null);
  const { data } = state;
  if (!data) return <section className="panel vc-blockers" data-testid="blockers-all" aria-busy="true"><Loading label="Checking every synthetic customer…" /></section>;
  const blocking = data.groups.filter((g) => isBlocking(g.severity));
  const warns = data.groups.length - blocking.length;
  const clear = data.total - data.blockedIds.size;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const btns = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-group]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    btns[n].focus();
    onSelect(btns[n].dataset.group!);
  };
  return (
    <section className="panel vc-blockers" data-testid="blockers-all" aria-label="Issues across all synthetic customers">
      <div className="panel-head">Issues across customers <span className="sub">{data.total} synthetic customers checked</span></div>
      <p className="vc-bsummary" data-testid="blockers-summary" role="status">
        {blocking.length
          ? <><strong>{plural(blocking.length, 'blocking issue affects', 'blocking issues affect')} {data.blockedIds.size} of {data.total} synthetic customers</strong> · {clear} {clear === 1 ? 'is' : 'are'} clear</>
          : <><strong>No blocking issues for any synthetic customer</strong> · {data.total} checked</>}
        {warns > 0 && <span className="muted"> · {plural(warns, 'warning', 'warnings')}</span>}
      </p>
      <div className="vc-sevfilter" role="group" aria-label="Filter by severity">
        <label className="vc-check">
          <input type="checkbox" checked={onlyBlocking} onChange={(e) => onToggle(e.target.checked)} data-testid="blockers-only" /> Blocking only
        </label>
        <span className="muted vc-bnote">Checked for the output and journey step chosen in the top bar.</span>
      </div>
      <div className="vc-list-scroll vc-blist">
        {shown.length ? (
          <ul className="vc-list list-rows" aria-label="Issues across customers" ref={listRef} onKeyDown={onKey}>
            {shown.map((g) => {
              const sel = selected === g.key;
              return (
                <li key={g.key} className={`vc-item ${sel ? 'selected' : ''}`}>
                  <button type="button" className={`vc-issue ${g.severity}`} data-testid="blocker-group" data-group={g.key} data-code={g.code} data-node={g.nodeId} data-severity={g.severity} aria-current={sel} onClick={() => onSelect(g.key)}>
                    <span className="vc-issue-top"><SeverityLabel severity={g.severity} />
                      <strong className="vc-title">{BLOCK_TITLE(g.code, g.details)}</strong>
                      <Tech><span className="chip code">{g.code}</span></Tech>
                      {g.nodeId && <Named name={nodeTitle(project, g.nodeId)} code={g.nodeId} />}
                      {g.ruleIds.map((r) => <span key={r} className="chip code">{r}</span>)}
                      <span className="chip count vc-reach">{g.recordIds.length} of {data.total} synthetic customers</span></span>
                    <span className="vc-issue-msg">{g.message}</span>
                  </button>
                  {g.severity === 'blocking' && <span className="vc-resolve"><ResolveInBlockers finding={{ code: g.code, nodeId: g.nodeId, ruleIds: g.ruleIds, locale: g.locale, message: g.message, details: g.details }} /></span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="vc-clean" data-testid="blockers-empty">
            {data.groups.length ? 'No warnings or blockers match the filter.' : <><span className="sev ok">✔ Clear</span> No blocking issues for any synthetic customer; {data.total} checked.</>}
          </div>
        )}
      </div>
    </section>
  );
}

function BlockerDetail({ group: g, data, loading, onlyBlocking, onPreview, onGo, onOpenLink, sourceLabel }: { group: BGroup | null; data: BData | null; loading: boolean; onlyBlocking: boolean; onPreview: (recordId: string, g: BGroup) => void; onGo: (g: BGroup) => void; onOpenLink: (l: AssistLink) => void; sourceLabel: string }) {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  if (!g || !data) {
    return (
      <>
        <div className="panel-head"><span id="vc-detail-title">Issue detail</span></div>
        <div className="panel-body vc-detail" aria-labelledby="vc-detail-title" data-testid="blocker-detail-empty">
          {loading || !data ? <p className="vc-detail-msg"><span className="spinner" /> Checking every synthetic customer…</p>
            : <><h2 className="vc-detail-code">{onlyBlocking || !data.groups.length ? 'No blocking issues for any synthetic customer' : 'Nothing matches the filter'}</h2>
              <p className="vc-detail-msg">{data.total} synthetic customers were checked for the current output and journey step.</p></>}
        </div>
      </>
    );
  }
  const names = g.recordIds.map((id) => {
    const r = records.find((x) => x.recordId === id);
    const sum = r ? recordSummary(r, personas) : null;
    return { id, name: sum?.name ?? id, tag: sum?.tag ?? null, message: g.messages.get(id) ?? g.message };
  });
  const differing = new Set(names.map((n) => n.message)).size > 1;
  const finding = toFinding({ code: g.code, severity: g.severity, suite: g.suite, message: g.message, nodeId: g.nodeId, ruleIds: g.ruleIds, locale: g.locale, source: g.source, details: g.details, suggestion: g.suggestion });
  const issue: Issue = { issueId: g.key, code: g.code, severity: g.severity, suite: g.suite, message: g.message, nodeId: g.nodeId, ruleIds: g.ruleIds, locale: g.locale };
  return (
    <>
      <div className="panel-head"><span id="vc-detail-title">Issue detail</span><div className="right"><SeverityLabel severity={g.severity} /></div></div>
      <div className="panel-body vc-detail" aria-labelledby="vc-detail-title" data-testid="blocker-detail" data-code={g.code}>
        <h2 className="vc-detail-code">{BLOCK_TITLE(g.code, g.details)} <Tech><span className="chip code">{g.code}</span></Tech></h2>
        <p className="vc-detail-msg">{g.message}</p>
        {g.suggestion && <><h3 className="section-title">Suggested correction</h3><div className="callout accent" data-testid="issue-suggestion">{g.suggestion}</div></>}
        <h3 className="section-title">Suggested fix</h3>
        <SuggestedFix key={g.key} finding={finding} recordId={g.recordIds[0]} onOpenLink={onOpenLink} />
        <dl className="kv vc-kv">
          <dt>Reach</dt><dd>{g.recordIds.length} of {data.total} synthetic customers</dd>
          {g.nodeId && <><dt>Section</dt><dd><Named name={nodeTitle(project, g.nodeId)} code={g.nodeId} /></dd></>}
          {g.ruleIds.length > 0 && <><dt>Rules</dt><dd>{g.ruleIds.map((r) => { const rule = project.rules.find((x) => x.id === r); return <span key={r} className="vc-rule">{rule ? ruleTitle(project, rule) : null} <span className="chip code">{r}</span></span>; })}</dd></>}
          {g.locale && <><dt>Language</dt><dd title={g.locale}>{localeLabel(g.locale)}</dd></>}
        </dl>
        <h3 className="section-title">Affected customers</h3>
        <ul className="list-rows vc-affected" data-testid="blocker-customers" aria-label="Affected synthetic customers">
          {names.map((n) => (
            <li key={n.id} className="vc-aff" data-record={n.id}>
              <div className="vc-aff-who">
                <strong className="vc-aff-name">{n.name}</strong>
                {n.tag && <span className="muted vc-aff-tag">{n.tag}</span>}
                <Tech><span className="chip code">{n.id}</span></Tech>
                {differing && <span className="vc-aff-msg muted">{n.message}</span>}
              </div>
              <button type="button" className="btn sm" onClick={() => onPreview(n.id, g)} data-testid="blocker-open-customer" aria-label={`Preview this customer: ${n.name}`}>Preview this customer</button>
            </li>
          ))}
        </ul>
        <h3 className="section-title">Source</h3>
        <div className="row wrap">
          <button className="btn primary" onClick={() => onGo(g)} data-testid="go-to-source"><Icon.external /> Go to source</button>
          {g.severity === 'blocking' && <ResolveInBlockers finding={finding} className="btn" testId="resolve-in-blockers-detail">Resolve in Blockers</ResolveInBlockers>}
        </div>
        <p className="hint">Opens {sourceLabel}{issue.nodeId ? ' with the node selected' : ''}. Your selection and scenario are kept.</p>
      </div>
    </>
  );
}

/* ----------------------------------------------------------- overview/cards */

const STATUS_VIEW: Record<string, { icon: string; label: string; cls: string }> = {
  clean: { icon: '✔', label: 'Clean', cls: 'ok' }, warnings: { icon: '▲', label: 'Warnings', cls: 'warning' }, errors: { icon: '■', label: 'Errors', cls: 'error' }, 'not-run': { icon: '–', label: 'Not run', cls: '' },
};

function Overview({ report, running, suites, stale, gCounts }: { report: Report | null; running: boolean; suites: Suite[]; stale: boolean; gCounts: Record<Sev, number> }) {
  const raw = report?.counts;
  const rec = useRecord(report?.recordId);
  const who = rec ? `${rec.customer.givenName} ${rec.customer.familyName}` : report?.recordId ?? '';
  return (
    <section className="vc-overview" aria-label="Overview" data-testid="validation-overview">
      <div className="vc-counters">
        {SEVS.map((s) => {
          const n = report ? gCounts[s] : 0; const r = raw?.[s] ?? 0;
          return (
            <div key={s} className={`vc-counter ${s} ${report && n ? 'has' : ''}`} data-testid={`count-${s}`}>
              <strong>{report ? n : '…'}</strong><SeverityLabel severity={s} />
              {report && r !== n && <small className="muted">{r} checks</small>}
            </div>
          );
        })}
        <div className="vc-counter"><strong data-testid="page-count">{report?.pageCount ?? '–'}</strong><span className="muted">PDF pages</span></div>
        <div className="vc-meta">
          {report && <>
            <div className="muted"><Named name={who} code={report.recordId} /> · ran {report.ranAt} · {(report.elapsedMs / 1000).toFixed(1)}s{stale ? ' · out of date' : ''}</div>
            <Tech><div className="muted" data-testid="raw-counts">raw checks: {SEVS.map((s) => `${s} ${raw?.[s] ?? 0}`).join(' · ')}</div></Tech>
            <Proof label="Proof"><span className="mono">{report.runId}</span> <span className="muted">· model v{report.modelVersion} · {report.overrideCount} override group(s)</span></Proof>
          </>}
        </div>
      </div>
      <table className="table vc-suites" data-testid="suite-cards">
        <caption className="rd-sr">Result per validation suite</caption>
        <thead><tr><th scope="col">Suite</th><th scope="col">Status</th><th scope="col" className="num">Findings</th><th scope="col" className="num">Time</th></tr></thead>
        <tbody>
          {SUITES.map((s) => {
            const st = report?.suites?.[s.id];
            const view = running && suites.includes(s.id) && !report ? { icon: '…', label: 'Running', cls: '' } : STATUS_VIEW[st?.status ?? 'not-run'];
            const ran = st && st.status !== 'not-run';
            return (
              <tr key={s.id} className={`vc-suite ${view.cls}`} data-testid={`suite-${s.id}`}>
                <th scope="row">{s.label}</th>
                <td><span className={`sev ${view.cls}`}><span aria-hidden="true">{view.icon}</span> {view.label}</span></td>
                <td className="num">{ran ? st.count : '–'}</td>
                <td className="num muted">{ran ? `${st.durationMs} ms` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/* --------------------------------------------------------------- inspector */

function Inspector({ issue: i, members, onGo, onOpenLink, sourceLabel, stale }: { issue: Issue; members: Issue[]; onGo: (i: Issue, ruleId?: string) => void; onOpenLink: (l: AssistLink) => void; sourceLabel: string; stale: boolean }) {
  const setRecord = useStudio((s) => s.setRecord);
  const setOverrides = useStudio((s) => s.setOverrides);
  const setJourneyCursor = useStudio((s) => s.setJourneyCursor);
  const project = useStudio((s) => s.project)!;
  const rep = i.reproduction;
  const finding = useMemo(() => toFinding(i), [i]);
  const plain = BLOCK_TITLE(i.code, i.details);
  const suiteLabel = SUITES.find((x) => x.id === i.suite)?.label ?? i.suite;
  const reproduce = () => {
    if (!rep) return;
    setRecord(rep.recordId);
    setOverrides(rep.overrides ?? {});
    setJourneyCursor(rep.journeyCursor ?? null);
  };
  return (
    <>
      <div className="panel-head"><span id="vc-detail-title">Issue detail</span><div className="right"><SeverityLabel severity={i.severity} /></div></div>
      <div className="panel-body vc-detail" aria-labelledby="vc-detail-title">
        <h2 className="vc-detail-code">{plain ?? i.code} {plain && <span className="chip code">{i.code}</span>}</h2>
        <p className="vc-detail-msg">{i.message}</p>
        {members.length > 1 && (
          <div className="callout info vc-members" data-testid="issue-members">
            <strong>{members.length} checks agree on this root cause</strong>
            <ul>{members.map((m) => <li key={m.issueId}><span className="chip code">{m.code}</span> <span className="muted">· {SUITES.find((x) => x.id === m.suite)?.label ?? m.suite}</span></li>)}</ul>
          </div>
        )}
        {stale && <div className="callout warning">This report is out of date and is being re-run; the issue may no longer apply.</div>}
        {i.suggestion && <><h3 className="section-title">Suggested correction</h3><div className="callout accent" data-testid="issue-suggestion">{i.suggestion}</div></>}
        <h3 className="section-title">Suggested fix</h3>
        <SuggestedFix key={i.issueId} finding={finding} scenario onOpenLink={onOpenLink} />
        <dl className="kv vc-kv">
          <dt>Suite</dt><dd>{suiteLabel}</dd>
          <dt>Severity</dt><dd><SeverityLabel severity={i.severity} /></dd>
          {i.nodeId && <><dt>Section</dt><dd><Named name={nodeTitle(project, i.nodeId)} code={i.nodeId} /></dd></>}
          {idsOf(i).length > 0 && <><dt>Rules</dt><dd>{idsOf(i).map((r) => { const rule = project.rules.find((x) => x.id === r); return <span key={r} className="vc-rule">{rule ? ruleTitle(project, rule) : null} <span className="chip code">{r}</span></span>; })}</dd></>}
          {i.page !== undefined && <><dt>Page</dt><dd>{i.page}</dd></>}
          {i.locale && <><dt>Language</dt><dd title={i.locale}>{localeLabel(i.locale)}</dd></>}
          {i.source && <><dt>Source</dt><dd>{i.source}</dd></>}
        </dl>
        <h3 className="section-title">Reproduction</h3>
        {rep ? (
          <div className="vc-repro">
            <div>Customer <ReproName recordId={rep.recordId} />{rep.journeyCursor !== null && rep.journeyCursor !== undefined ? <> · journey step <span className="chip count">{rep.journeyCursor}</span></> : ' · no journey step'}</div>
            <div className="muted">Scenario overrides</div>
            <pre className="code">{Object.keys(rep.overrides ?? {}).length ? JSON.stringify(abridge(rep.overrides), null, 2) : '{} (none: the fixture record as-is)'}</pre>
            <button className="btn sm" onClick={reproduce} data-testid="reproduce-scenario"><Icon.target /> Load this scenario</button>
          </div>
        ) : <div className="muted">This check does not depend on a particular scenario (model-level analysis).</div>}
        {i.details && Object.keys(i.details).length > 0 && (<><h3 className="section-title">Details</h3><pre className="code" data-testid="issue-details">{JSON.stringify(abridge(i.details), null, 2)}</pre></>)}
        {i.runId && <Proof label="Proof"><span className="chip code">run {i.runId}</span></Proof>}
        <h3 className="section-title">Source</h3>
        <div className="row wrap">
          <button className="btn primary" onClick={() => onGo(i)} data-testid="go-to-source"><Icon.external /> Go to source</button>
          {i.severity === 'blocking' && <ResolveInBlockers finding={finding} className="btn" testId="resolve-in-blockers-detail">Resolve in Blockers</ResolveInBlockers>}
          {idsOf(i).slice(1).map((r) => <button key={r} className="btn sm" onClick={() => onGo(i, r)}>Rule {r}</button>)}
        </div>
        <p className="hint">Opens {sourceLabel}{i.nodeId ? ' with the node selected' : ''}. Your selection and scenario are kept.</p>
      </div>
    </>
  );
}

function ReproName({ recordId }: { recordId: string }) {
  const rec = useRecord(recordId);
  return <Named name={rec ? `${rec.customer.givenName} ${rec.customer.familyName}` : recordId} code={recordId} />;
}

/** Shown when no issue can be selected: running, clean, or everything filtered out. Never "Select an issue". */
function Summary({ report, running, who, recordId, gCounts, filtered }: { report: Report | null; running: boolean; who: string; recordId?: string; gCounts: Record<Sev, number>; filtered: boolean }) {
  const total = SEVS.reduce((n, s) => n + gCounts[s], 0);
  return (
    <>
      <div className="panel-head"><span id="vc-detail-title">Issue detail</span></div>
      <div className="panel-body vc-detail" aria-labelledby="vc-detail-title" data-testid="validation-summary">
        {!report ? (
          running ? <p className="vc-detail-msg"><span className="spinner" /> Checking {who}…</p> : <p className="vc-detail-msg">Validation has not produced a result yet.</p>
        ) : filtered ? (
          <p className="vc-detail-msg">No issues match the current severity and suite filters. Clear a filter to see the {total} issue{total === 1 ? '' : 's'} found for <Named name={who} code={recordId ?? report.recordId} />.</p>
        ) : (
          <>
            <h2 className="vc-detail-code">No issues found for <Named name={who} code={recordId ?? report.recordId} /></h2>
            <p className="vc-detail-msg">{report.suitesRequested.length} suite{report.suitesRequested.length === 1 ? '' : 's'} ran against this scenario and reported nothing to fix.</p>
          </>
        )}
        {report && (
          <div className="vc-sumcounts">
            {SEVS.map((s) => <span key={s} className="chip count">{gCounts[s]} {s}</span>)}
            {report.pageCount != null && <span className="chip count">{report.pageCount} PDF pages</span>}
          </div>
        )}
        <p className="hint">Automated checks are not WCAG or regulatory certification.</p>
      </div>
    </>
  );
}

/* -------------------------------------------------------- suggested fixes */

/** The assistant's built-in fix engine for one issue: proposals, each with its effect on every synthetic customer, applied only by a click. */
function SuggestedFix({ finding, recordId, scenario, onOpenLink }: { finding: Finding; recordId?: string; scenario?: boolean; onOpenLink: (l: AssistLink) => void }) {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const ctx = useStudio((s) => s.ctx);
  const session = useStudio((s) => s.session);
  const blockedReason = editBlockedReason(session);
  const proposals = useMemo(() => {
    try { return proposeFixes(project, finding, { records, recordId: recordId ?? ctx.recordId, overrides: scenario ? ctx.overrides : undefined, journeyCursor: ctx.journeyCursor, profileId: ctx.profileId }); } catch { return [] as FixProposal[]; }
  }, [project, records, finding, recordId, scenario, ctx.recordId, ctx.overrides, ctx.journeyCursor, ctx.profileId]);
  const [impacts, setImpacts] = useState<Record<string, FixImpact>>({});
  const [done, setDone] = useState<{ proposals: FixProposal[]; impacts: Record<string, FixImpact>; applied: string } | null>(null);
  /* Effects are computed when a proposal is shown (not for every issue up front), one at a time so the panel stays responsive. */
  useEffect(() => {
    if (done) return;
    let cancelled = false;
    const queue = proposals.filter((p) => p.kind === 'change');
    setImpacts({});
    const next = (k: number) => {
      if (cancelled || k >= queue.length) return;
      setTimeout(() => {
        if (cancelled) return;
        let imp: FixImpact | null = null;
        try { imp = fixImpact(project, queue[k], records, { finding, profileId: ctx.profileId, journeyCursor: ctx.journeyCursor }); } catch { imp = null; }
        if (imp && !cancelled) setImpacts((cur) => ({ ...cur, [queue[k].id]: imp! }));
        next(k + 1);
      }, 20);
    };
    next(0);
    return () => { cancelled = true; };
  }, [proposals, done]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = done?.proposals ?? proposals;
  const shownImpacts = done?.impacts ?? impacts;
  const apply = (p: FixProposal) => {
    if (!p.commands?.length) return;
    const frozen = { proposals, impacts, applied: p.id };
    if (applyAssistCommands(p.commands, p.title, 'fix', p.source)) setDone(frozen);
  };
  if (!shown.length) return <p className="vc-nofix muted" data-testid="fix-panel" data-count="0">No automatic fix for this issue; use Go to source.</p>;
  return (
    <div className="vc-fixes" data-testid="fix-panel" data-count={shown.length}>
      {blockedReason && shown.some((p) => p.kind === 'change') && <p className="hint vc-fix-ro" data-testid="fix-readonly">You can see the proposals but not apply them: {blockedReason.charAt(0).toLowerCase() + blockedReason.slice(1)}.</p>}
      {shown.map((p, k) => {
        const imp = shownImpacts[p.id];
        const wasApplied = done?.applied === p.id;
        return (
          <ProposalCard key={p.id} proposal={p} impact={p.kind === 'change' ? imp ?? null : null} applied={wasApplied}
            busy={!!blockedReason || (p.kind === 'change' && (!imp || (!!done && !wasApplied)))}
            onApply={() => apply(p)} onOpen={() => p.link && onOpenLink(p.link)}>
            {shown.length > 1 && k === 0 && <span className="chip accent vc-recommended" data-testid="fix-recommended">Recommended</span>}
            {p.kind === 'change' && !imp && !wasApplied && <p className="muted vc-fix-wait" role="status"><span className="spinner" /> Checking the effect on every synthetic customer…</p>}
            {p.kind === 'change' && imp && !imp.resolves && !imp.newlyBlocked.length && <p className="vc-fix-warn">Not shown to fully resolve this issue; read the effect above before applying.</p>}
          </ProposalCard>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ fix all safe */

export type Plan = ReturnType<typeof safeFixPlan>;
/** The "Fix all safe issues" plan, computed after paint; only valid for the exact model and findings it was computed from. */
export function useSafePlan(extra: Finding[]): { plan: Plan | null; ready: boolean } {
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const profileId = useStudio((s) => s.ctx.profileId);
  const cursor = useStudio((s) => s.ctx.journeyCursor);
  const [st, setSt] = useState<{ plan: Plan | null; project: unknown; extra: Finding[]; profileId: string; cursor: number | null } | null>(null);
  useEffect(() => {
    if (!project) return;
    const h = setTimeout(() => {
      let plan: Plan | null = null;
      try { plan = safeFixPlan(project, records, { profileId, journeyCursor: cursor, findings: extra }); } catch { plan = null; }
      setSt({ plan, project, extra, profileId, cursor });
    }, 120);
    return () => clearTimeout(h);
  }, [project, records, profileId, cursor, extra]);
  const ready = !!st && st.project === project && st.extra === extra && st.profileId === profileId && st.cursor === cursor;
  return { plan: ready ? st!.plan : null, ready };
}

export function FixAllButton({ plan, onOpen, testId = 'fix-all-safe' }: { plan: { plan: Plan | null; ready: boolean }; onOpen: () => void; testId?: string }) {
  const n = plan.plan?.batch ? plan.plan.items.length : 0;
  const why = !plan.ready ? 'Checking which fixes are low risk…' : n ? `Apply ${n} low-risk fix${n === 1 ? '' : 'es'} in one undoable step, after you confirm` : 'No low-risk fixes available; open an issue to see proposals that need review';
  return (
    <span title={why}>
      <button type="button" className="btn" onClick={onOpen} disabled={!n} data-testid={testId} aria-label={n ? `Fix all safe issues (${n})` : 'Fix all safe issues (none available)'}>
        <Icon.validate /> Fix all safe issues{n ? <span className="chip count">{n}</span> : null}
      </button>
    </span>
  );
}

export function FixAllDialog({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const ctx = useStudio((s) => s.ctx);
  const session = useStudio((s) => s.session);
  const blockedReason = editBlockedReason(session);
  const [busy, setBusy] = useState(false);
  const n = plan.items.length;
  const [combined, setCombined] = useState<FixImpact | null>(null);
  useEffect(() => {
    if (!plan.batch) return;
    const h = setTimeout(() => {
      try {
        setCombined(fixImpact(project, { id: 'fix-all', findingCode: '', title: `Fix ${n} safe issues`, explanation: '', kind: 'change', commands: [plan.batch!], risk: 'safe', source: 'builtin' }, records, { profileId: ctx.profileId, journeyCursor: ctx.journeyCursor }));
      } catch { setCombined(null); }
    }, 20);
    return () => clearTimeout(h);
  }, [plan, project, records, ctx.profileId, ctx.journeyCursor, n]);
  const confirm = () => {
    if (!plan.batch || busy) return;
    setBusy(true);
    const ok = applyAssistCommands([plan.batch], `Fix ${n} safe issue${n === 1 ? '' : 's'}`, 'fix-all', 'builtin');
    setBusy(false);
    if (ok) onClose();
  };
  const where = (nodeId?: string) => (nodeId ? nodeTitle(project, nodeId) : '');
  return (
    <Dialog title={`Fix ${n} safe issue${n === 1 ? '' : 's'}`} onClose={onClose} labelledBy="fix-all-title"
      footer={<>
        <button type="button" className="btn ghost" onClick={onClose} data-testid="fix-all-cancel">Cancel</button>
        <button type="button" className="btn primary" onClick={confirm} disabled={busy || !!blockedReason || !plan.batch} title={blockedReason ?? undefined} data-testid="fix-all-apply">Apply {n} fix{n === 1 ? '' : 'es'}</button>
      </>}>
      <div className="vc-fixall" data-testid="fix-all-dialog">
        <p className="vc-fixall-lead">These low-risk fixes are computed by the studio (Built-in; no AI model). They are applied together as <strong>one undoable step</strong>. Nothing is approved, exported or published.</p>
        {blockedReason && <p className="hint" data-testid="fix-readonly">You cannot apply them: {blockedReason.charAt(0).toLowerCase() + blockedReason.slice(1)}.</p>}
        <ul className="list-rows vc-fixall-list" aria-label="Fixes that will be applied" data-testid="fix-all-items">
          {plan.items.map((it) => (
            <li key={it.group.key + it.proposal.id} className="vc-fixall-item" data-testid="fix-all-item">
              <div className="vc-fixall-top"><strong>{it.proposal.title}</strong><span className="chip">Built-in</span><span className="chip ok">Low risk</span></div>
              <div className="muted vc-fixall-sub">{BLOCK_TITLE(it.group.finding.code, it.group.finding.details)}{where(it.group.finding.nodeId) ? ` · ${where(it.group.finding.nodeId)}` : ''}</div>
              <ImpactLine impact={it.impact} />
            </li>
          ))}
        </ul>
        <h3 className="section-title">Combined effect</h3>
        {combined ? <ImpactLine impact={{ ...combined, resolves: true, summary: `Together: ${combined.unblocked.length ? `unblocks ${combined.unblocked.length} of ${combined.totalCustomers} synthetic customers; ` : ''}${combined.changedCustomers} of ${combined.totalCustomers} synthetic customers receive something different; ${combined.newlyBlocked.length ? `${combined.newlyBlocked.length} would be newly blocked.` : 'nobody is newly blocked.'}` }} />
          : <p className="muted vc-fix-wait" role="status"><span className="spinner" /> Checking the combined effect…</p>}
        {plan.skipped.length > 0 && (
          <details className="vc-fixall-skipped" open={plan.skipped.length <= 3} data-testid="fix-all-skipped">
            <summary><strong>{plan.skipped.length} issue{plan.skipped.length === 1 ? '' : 's'} not included</strong></summary>
            <ul className="list-rows">
              {plan.skipped.map((s) => (
                <li key={s.group.key} className="vc-fixall-item">
                  <div className="vc-fixall-top"><strong>{BLOCK_TITLE(s.group.finding.code, s.group.finding.details)}</strong>{where(s.group.finding.nodeId) && <span className="muted">{where(s.group.finding.nodeId)}</span>}</div>
                  <div className="muted vc-fixall-sub">{s.reason}</div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ PDF accessibility (wave 2) */

const PDF_STATUS: Record<string, { icon: string; label: string; cls: string }> = {
  passed: { icon: '✔', label: 'Passed', cls: 'ok' }, failed: { icon: '■', label: 'Failed', cls: 'error' }, 'not-checked': { icon: '–', label: 'Not checked', cls: '' },
};
const whenOf = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

/**
 * The PDF part of the accessibility suite: the two levels of proof, always labelled as what they are ("Checked by the
 * studio", "Validated by veraPDF"), the checks with passed / failed / not checked, each failure linking to the part of
 * the document, and what the composing browser cannot write.
 */
function PdfAccessibilityPanel({ report, onShow, onOpen }: { report: Report; onShow: (code: string, nodeId: string | undefined, page: number | undefined) => void; onOpen: (nodeId: string) => void }) {
  const project = useStudio((s) => s.project);
  const r = report.pdfAccessibility;
  if (!r) return <section className="panel" data-testid="pdf-a11y-panel" aria-label="PDF accessibility"><div className="panel-head">PDF accessibility</div><div className="empty">The accessibility suite was not run for this report, so the PDF was not checked.</div></section>;
  const s = r.studio;
  const v = r.verapdf;
  return (
    <section className="panel vc-pdf" data-testid="pdf-a11y-panel" aria-label="PDF accessibility">
      <div className="panel-head">PDF accessibility
        <span className={`chip ${s.summary.failed ? (s.required ? 'error' : 'warning') : s.summary.notChecked ? 'info' : 'accent'}`} data-testid="pdf-a11y-summary">{s.summary.failed ? `${s.summary.failed} of ${s.checks.length} checks failed` : `${s.summary.passed} of ${s.checks.length} checks passed`}</span>
        <span className="chip count">{s.pageCount} page{s.pageCount === 1 ? '' : 's'}</span>
        {s.required ? <span className="chip info" title="Set in Design, Page setup">Accessible PDF is required</span> : <span className="muted vc-pdf-req">An accessible PDF is not required for this document, so failures are warnings.</span>}
      </div>
      <div className="panel-body vc-pdf-body">
        <dl className="vc-pdf-levels">
          <div data-testid="pdf-a11y-level-studio"><dt>Checked by the studio</dt>
            <dd>{whenOf(r.checkedAt)} · {s.summary.passed} passed, {s.summary.failed} failed{s.summary.notChecked ? `, ${s.summary.notChecked} not checked` : ''}. The studio read the PDF it composed; this is not validation against PDF/UA.</dd></div>
          <div data-testid="pdf-a11y-level-verapdf"><dt>Validated by veraPDF</dt>
            <dd>{v.status === 'ran' ? <>{whenOf(v.ranAt)}{v.version ? ` · veraPDF ${v.version}` : ''} · {v.compliant ? 'veraPDF found that the PDF meets the PDF/UA-1 profile.' : `veraPDF found that the PDF does not meet the PDF/UA-1 profile: ${v.failedRules.length} rule${v.failedRules.length === 1 ? '' : 's'} failed.`}</>
              : v.status === 'not-installed' ? 'veraPDF is not installed on this machine, so the PDF was not validated against PDF/UA.'
              : v.status === 'not-run' ? 'Not run for this check.'
              : `veraPDF gave no verdict: ${v.message}`}</dd></div>
        </dl>
        <table className="table vc-pdf-checks" data-testid="pdf-a11y-checks">
          <caption className="rd-sr">The studio’s PDF accessibility checks and their results</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">What was found</th></tr></thead>
          <tbody>
            {s.checks.map((c) => {
              const view = PDF_STATUS[c.status] ?? PDF_STATUS['not-checked'];
              const found = s.findings.filter((f) => f.details.check === c.id);
              return (
                <tr key={c.id} data-testid={`pdf-a11y-check-${c.id}`} data-status={c.status}>
                  <th scope="row">{c.label}</th>
                  <td><span className={`sev ${view.cls}`}><span aria-hidden="true">{view.icon}</span> {view.label}</span></td>
                  <td>
                    <span className="muted">{c.detail}</span>
                    {found.length > 0 && (
                      <ul className="vc-pdf-found">
                        {found.slice(0, 6).map((f, k) => (
                          <li key={k}>
                            <span>{f.details.title}{f.nodeId ? <> in <Named name={project ? nodeTitle(project, f.nodeId) : f.nodeId} code={f.nodeId} /></> : null}{f.page ? ` (page ${f.page})` : ''}. {f.details.fix}</span>
                            <span className="vc-pdf-acts">
                              <button type="button" className="btn sm ghost" onClick={() => onShow(f.code, f.nodeId, f.page)} data-testid="pdf-a11y-show">Show the issue</button>
                              {f.nodeId && project?.nodes.some((n) => n.id === f.nodeId) && <button type="button" className="btn sm ghost" onClick={() => onOpen(f.nodeId!)} data-testid="pdf-a11y-open">Open in Design</button>}
                            </span>
                          </li>
                        ))}
                        {found.length > 6 && <li className="muted">and {found.length - 6} more in the issue list</li>}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {v.status === 'ran' && v.failedRules.length > 0 && (
          <table className="table vc-pdf-checks" data-testid="pdf-a11y-verapdf-rules">
            <caption className="vc-pdf-cap">Rules veraPDF reported as failed</caption>
            <thead><tr><th scope="col">Rule</th><th scope="col">What it says</th><th scope="col" className="num">Times</th></tr></thead>
            <tbody>{v.failedRules.map((x) => <tr key={x.id}><td><span className="chip code">{x.id}</span></td><td>{x.description}{x.knownLimit ? <div className="muted">Expected: {x.knownLimit}</div> : null}</td><td className="num">{x.count}</td></tr>)}</tbody>
          </table>
        )}
        <div className="vc-pdf-limits" data-testid="pdf-a11y-limits">
          <strong>What the composing browser cannot write</strong>
          <ul>{s.knownLimits.map((k) => <li key={k.id}>{k.text}</li>)}</ul>
        </div>
        <Proof label="How it was checked"><span className="muted">{s.checker} · read with {s.reader} · customer {r.recordId}{s.title ? ` · title “${s.title}”` : ''}{s.language ? ` · language ${s.language}` : ''}</span></Proof>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ parity */

function ParityPanel({ report }: { report: Report }) {
  const [onlyBad, setOnlyBad] = useState(false);
  const p = report.parity;
  if (!p) return <section className="panel" data-testid="parity-panel"><div className="panel-head">PDF / HTML parity</div><div className="empty">The parity suite was not run for this report.</div></section>;
  const bad = p.checks.filter((c) => c.status === 'mismatch');
  const rows = onlyBad ? bad : p.checks;
  return (
    <section className="panel" data-testid="parity-panel" aria-label="PDF and HTML parity">
      <div className="panel-head">PDF / HTML parity
        <span className={`chip ${bad.length ? 'error' : 'accent'}`}>{bad.length ? `■ ${bad.length} mismatch${bad.length === 1 ? '' : 'es'}` : '✔ all semantic facts match'}</span>
        <span className="chip count">{p.checks.length} checks</span>
        <div className="right"><label className="rd-check"><input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> mismatches only</label></div></div>
      <div className="vc-parity-scroll">
        <table className="table ox-par-table">
          <caption className="rd-sr">Expected resolver facts compared with values extracted from the PDF and HTML outputs; select a row for the values</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {rows.map((c) => <ParityRow key={c.id} c={c} />)}
            {!rows.length && <tr><td colSpan={2} className="muted">No mismatching checks.</td></tr>}
          </tbody>
        </table>
      </div>
      {p.allowedDifferences.length > 0 && (
        <div className="vc-allowed"><strong>Allowed differences</strong><ul>{p.allowedDifferences.map((a, k) => <li key={k}>{a}</li>)}</ul></div>
      )}
    </section>
  );
}
