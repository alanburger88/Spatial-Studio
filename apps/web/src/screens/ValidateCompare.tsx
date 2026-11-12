import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolve } from '@iss/resolver';
import { ScreenHeader, Loading, SeverityLabel, Proof, Tech, Named } from '../ui/common';
import { nodeTitle, ruleTitle, localeLabel } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useStudio, useResolution, useScenarioRequest, useRecord } from '../state/store';
import { api, ApiFailure } from '../api/client';
import { abridge } from './RulesData';
import { ParityRow, blockWord } from './PreviewExport';
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
  { id: 'accessibility', label: 'Accessibility', what: 'Model checks plus automated axe on the HTML output' },
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
const BLOCK_TITLE = (code: string): string => { const w = blockWord(code); return w.charAt(0).toUpperCase() + w.slice(1); };

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
    try { return resolve({ project, record, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor, profileId: 'paged-pdf' }).runId; } catch { return null; }
  }, [project, record, ctx.overrides, ctx.journeyCursor, ctx.profileId, res]);
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
      const out = await api.validate({ ...req, suites });
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
  const sourceLabel = (i: Issue) => (idsOf(i).length ? `Rule ${idsOf(i)[0]} in Rules & Data` : i.suite === 'rules' ? 'Rules & Data' : i.suite === 'pagination' ? 'Page Composition Stack' : i.suite === 'parity' && !i.nodeId ? 'Preview & Export' : `${i.nodeId ?? 'node'} in 2D Design`);

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
            <button className="btn primary" onClick={() => void run({ manual: true })} disabled={!req || !suites.length} aria-busy={running} data-testid="run-validation">
              {running ? <span className="spinner" /> : <Icon.validate />} {running ? `Validating… ${elapsed.toFixed(1)}s` : report ? 'Re-run' : 'Run validation'}
            </button>
          </>
        } />
      <div className="screen-body vc-body">
        <div className="vc-main" aria-busy={running}>
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
                        const plain = BLOCK_TITLE(i.code);
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
            </>
          )}
          <p className="hint vc-note" data-testid="certification-note">Automated checks are not WCAG or regulatory certification. They are necessary but not sufficient; PDF accessibility (tagging/PDF-UA) is not evaluated.</p>
        </div>

        <aside className="panel vc-inspector" data-side="right" data-side-title="Issue detail" data-testid="validation-inspector" aria-label="Validation detail" tabIndex={-1} ref={inspectorRef}>
          {current ? <Inspector issue={current} members={currentGroup!.members} onGo={goTo} sourceLabel={sourceLabel(current)} stale={outdated} /> : (
            <Summary report={report} running={running || pending} who={who} recordId={record?.recordId} gCounts={gCounts} filtered={groups.length > 0} />
          )}
        </aside>
      </div>
    </section>
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

function Inspector({ issue: i, members, onGo, sourceLabel, stale }: { issue: Issue; members: Issue[]; onGo: (i: Issue, ruleId?: string) => void; sourceLabel: string; stale: boolean }) {
  const setRecord = useStudio((s) => s.setRecord);
  const setOverrides = useStudio((s) => s.setOverrides);
  const setJourneyCursor = useStudio((s) => s.setJourneyCursor);
  const project = useStudio((s) => s.project)!;
  const rep = i.reproduction;
  const plain = BLOCK_TITLE(i.code);
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
        <dl className="kv vc-kv">
          <dt>Suite</dt><dd>{suiteLabel}</dd>
          <dt>Severity</dt><dd><SeverityLabel severity={i.severity} /></dd>
          {i.nodeId && <><dt>Section</dt><dd><Named name={nodeTitle(project, i.nodeId)} code={i.nodeId} /></dd></>}
          {idsOf(i).length > 0 && <><dt>Rules</dt><dd>{idsOf(i).map((r) => { const rule = project.rules.find((x) => x.id === r); return <span key={r} className="vc-rule">{rule ? ruleTitle(project, rule) : null} <span className="chip code">{r}</span></span>; })}</dd></>}
          {i.page !== undefined && <><dt>Page</dt><dd>{i.page}</dd></>}
          {i.locale && <><dt>Language</dt><dd title={i.locale}>{localeLabel(i.locale)}</dd></>}
          {i.source && <><dt>Source</dt><dd>{i.source}</dd></>}
        </dl>
        {i.suggestion && <><h3 className="section-title">Suggested correction</h3><div className="callout accent" data-testid="issue-suggestion">{i.suggestion}</div></>}
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
