import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolve } from '@iss/resolver';
import { ScreenHeader, Loading, SeverityLabel, formatMoney } from '../ui/common';
import { Icon } from '../ui/icons';
import { useStudio, useResolution, useScenarioRequest, useRecord } from '../state/store';
import { api, ApiFailure } from '../api/client';
import { abridge, injectD01, makeTransactions, restoreR03 } from './RulesData';
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
  recordId: string; overrideCount: number; ranAt: string; elapsedMs: number; suitesRequested: Suite[];
}

/** Keeps the last report per project so Go-to-source and back does not lose it. Never used as model state. */
const lastReports = new Map<string, Report>();

const idsOf = (i: Issue) => [...(i.ruleIds ?? []), ...(i.ruleId && !(i.ruleIds ?? []).includes(i.ruleId) ? [i.ruleId] : [])];
const sevRank = (s: Sev) => SEVS.indexOf(s);
const fmtVal = (v: unknown): string => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

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
  const [sevFilter, setSevFilter] = useState<Sev[]>([...SEVS]);
  const [suiteFilter, setSuiteFilter] = useState<'all' | Suite>('all');
  const seq = useRef(0);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => { if (project) setReport(lastReports.get(project.projectId) ?? null); setSelected(null); }, [project?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const run = async () => {
    if (!req || !project || status === 'running' || !suites.length) return;
    const my = ++seq.current;
    setStatus('running'); setError(null); setElapsed(0);
    const t0 = performance.now();
    try {
      const out = await api.validate({ ...req, suites });
      if (my !== seq.current) return;
      const rep: Report = {
        ...out, recordId: req.recordId, overrideCount: Object.keys(req.overrides ?? {}).length, ranAt: new Date().toLocaleTimeString(), elapsedMs: Math.round(performance.now() - t0), suitesRequested: suites,
        issues: (out.issues ?? []) as Issue[],
      };
      lastReports.set(project.projectId, rep);
      setReport(rep); setSelected(null); setStatus('idle');
    } catch (e) {
      if (my !== seq.current) return;
      const f = e instanceof ApiFailure ? e : null;
      setError({ title: f ? `Validation failed (${f.code})` : 'Validation failed', message: (e as Error).message });
      setStatus('error');
    }
  };

  const issues = report?.issues ?? [];
  const shown = useMemo(() => issues.filter((i) => sevFilter.includes(i.severity) && (suiteFilter === 'all' || i.suite === suiteFilter)).sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.suite.localeCompare(b.suite)), [issues, sevFilter, suiteFilter]);
  const current = issues.find((i) => i.issueId === selected) ?? null;
  useEffect(() => { if (selected && !shown.some((i) => i.issueId === selected)) setSelected(null); }, [shown, selected]);

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

  return (
    <section className="screen" data-testid="validate-view">
      <ScreenHeader id="S09" title="Validate & Compare"
        subtitle="Run the real rule, binding, pagination, PDF/HTML parity and accessibility checks for the current scenario, then jump to the exact cause."
        badge={<span className="chip sim">Synthetic data only</span>}
        actions={
          <>
            <button className="btn primary" onClick={run} disabled={running || !req || !suites.length} data-testid="run-validation">
              {running ? <span className="spinner" /> : <Icon.validate />} {running ? `Validating… ${elapsed.toFixed(1)}s` : report ? 'Run again' : 'Run validation'}
            </button>
          </>
        } />
      <div className="screen-body vc-body">
        <DefectPanel />

        <div className="vc-main" aria-busy={running}>
          {/* run status */}
          <div className="vc-status" aria-live="polite">
            {running && <div className="callout accent" data-testid="validation-progress"><span className="spinner" /> Running real checks on the server: rules, bindings, pagination, parity, accessibility. Pagination and parity compose a PDF, so this takes a few seconds.</div>}
            {status === 'error' && error && (
              <div className="callout error" role="alert" data-testid="validation-error"><strong>{error.title}.</strong> {error.message} <button className="btn sm" onClick={run}><Icon.reset /> Retry</button></div>
            )}
            {stale && !running && (
              <div className="callout warning" data-testid="stale-marker"><strong>Results are stale.</strong> The model or scenario changed after this report ran (report run <span className="mono">{report!.runId}</span>, current <span className="mono">{currentRunId}</span>). <button className="btn sm" onClick={run}>Re-run validation</button></div>
            )}
          </div>

          {/* suite selection */}
          <div className="vc-suitepick" role="group" aria-label="Suites to run">
            <span className="muted">Suites to run</span>
            {SUITES.map((s) => (
              <button key={s.id} type="button" className="chip vc-toggle" aria-pressed={suites.includes(s.id)} title={s.what} onClick={() => setSuites((cur) => (cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id]))}>
                {suites.includes(s.id) ? '☑' : '☐'} {s.label}
              </button>
            ))}
          </div>

          {!report && status !== 'running' && status !== 'error' && (
            <div className="panel vc-empty" data-testid="validation-empty">
              <div className="empty">
                <Icon.validate />
                <strong>No validation has been run yet</strong>
                <span>Validation runs the real resolver, binding checks, the paged composer, a PDF vs HTML parity comparison and an automated accessibility scan for record <span className="mono">{ctx.recordId}</span>{Object.keys(ctx.overrides).length ? ` with ${Object.keys(ctx.overrides).length} scenario override group(s)` : ''}.</span>
                <button className="btn primary" onClick={run} disabled={!req}><Icon.validate /> Run validation</button>
              </div>
            </div>
          )}

          {(report || running) && (
            <>
              <Overview report={report} running={running} suites={suites} stale={stale} />
              <section className="panel vc-listpanel" data-testid="validation-list-panel" aria-label="Issues">
                <div className="panel-head">Issues <span className="sub">{report ? `${shown.length} of ${issues.length}` : ''}</span>
                  <div className="right">
                    <label className="vc-sel"><span className="rd-sr">Filter by suite</span>
                      <select className="select" value={suiteFilter} onChange={(e) => setSuiteFilter(e.target.value as 'all' | Suite)} aria-label="Filter by suite" data-testid="filter-suite">
                        <option value="all">All suites</option>{SUITES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select></label>
                  </div>
                </div>
                <div className="vc-sevfilter" role="group" aria-label="Filter by severity">
                  {SEVS.map((s) => (
                    <button key={s} type="button" className={`chip vc-toggle ${s}`} aria-pressed={sevFilter.includes(s)} data-testid={`filter-${s}`} onClick={() => setSevFilter((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}>
                      {sevFilter.includes(s) ? '☑' : '☐'} {s} {report ? report.counts[s] ?? 0 : ''}
                    </button>
                  ))}
                </div>
                <div className="vc-list-scroll">
                  {report && (
                    <ul className="vc-list" data-testid="validation-list" aria-label="Validation issues" ref={listRef} onKeyDown={onListKey}>
                      {shown.map((i) => (
                        <li key={i.issueId}>
                          <button type="button" data-issue={i.issueId} data-testid={`issue-${i.code}`} className={`vc-issue ${i.severity} ${selected === i.issueId ? 'selected' : ''}`} aria-current={selected === i.issueId} onClick={() => choose(i.issueId)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); choose(i.issueId, true); } }}>
                            <span className="vc-issue-top"><SeverityLabel severity={i.severity} /><span className="mono vc-code">{i.code}</span><span className="chip vc-suite">{i.suite}</span>
                              {i.nodeId && <span className="chip mono">{i.nodeId}</span>}
                              {idsOf(i).map((r) => <span key={r} className="chip mono accent">{r}</span>)}
                              {i.page !== undefined && <span className="chip">page {i.page}</span>}</span>
                            <span className="vc-issue-msg">{i.message}</span>
                          </button>
                        </li>
                      ))}
                      {!shown.length && (
                        <li className="vc-clean" data-testid="validation-clean">
                          {issues.length ? 'No issues match the current filters.' : <><span className="sev ok">✔ clean</span> No findings from the {report.suitesRequested.length} suite(s) that ran. Automated checks are not WCAG or regulatory certification.</>}
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
          <p className="hint vc-note" data-testid="certification-note">Automated checks are not WCAG or regulatory certification. They are necessary but not sufficient; PDF accessibility (tagging/PDF-UA) is not evaluated. All data is synthetic.</p>
        </div>

        <aside className="panel vc-inspector" data-testid="validation-inspector" aria-label="Validation detail" tabIndex={-1} ref={inspectorRef}>
          {current ? <Inspector issue={current} onGo={goTo} sourceLabel={sourceLabel(current)} stale={stale} /> : (
            <div className="empty"><strong>Select an issue</strong><span>Choose an item in the list (arrow keys move, Enter opens details) to see the message, suggested fix, reproduction and a link to its source.</span></div>
          )}
        </aside>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- overview/cards */

const STATUS_VIEW: Record<string, { icon: string; label: string; cls: string }> = {
  clean: { icon: '✔', label: 'clean', cls: 'ok' }, warnings: { icon: '▲', label: 'warnings', cls: 'warning' }, errors: { icon: '■', label: 'errors', cls: 'error' }, 'not-run': { icon: '–', label: 'not run', cls: '' },
};

function Overview({ report, running, suites, stale }: { report: Report | null; running: boolean; suites: Suite[]; stale: boolean }) {
  return (
    <section className="vc-overview" aria-label="Overview" data-testid="validation-overview">
      <div className="vc-counters">
        {SEVS.map((s) => (
          <div key={s} className={`vc-counter ${s} ${report && report.counts[s] ? 'has' : ''}`} data-testid={`count-${s}`}>
            <strong>{report ? report.counts[s] ?? 0 : '…'}</strong><SeverityLabel severity={s} />
          </div>
        ))}
        <div className="vc-counter"><strong data-testid="page-count">{report?.pageCount ?? '–'}</strong><span className="muted">PDF pages</span></div>
        <div className="vc-meta">
          {report && <><div className="mono">{report.runId}</div><div className="muted">{report.recordId} · model v{report.modelVersion} · {report.overrideCount} override group(s)</div><div className="muted">ran {report.ranAt} · {(report.elapsedMs / 1000).toFixed(1)}s{stale ? ' · stale' : ''}</div></>}
        </div>
      </div>
      <div className="vc-suites" data-testid="suite-cards">
        {SUITES.map((s) => {
          const st = report?.suites?.[s.id];
          const view = running && suites.includes(s.id) && !report ? { icon: '…', label: 'running', cls: '' } : STATUS_VIEW[st?.status ?? 'not-run'];
          return (
            <div key={s.id} className={`vc-suite ${view.cls}`} data-testid={`suite-${s.id}`}>
              <div className="vc-suite-head"><span className={`sev ${view.cls}`}><span aria-hidden="true">{view.icon}</span> {view.label}</span></div>
              <strong>{s.label}</strong>
              <div className="muted">{st && st.status !== 'not-run' ? `${st.count} finding${st.count === 1 ? '' : 's'} · ${st.durationMs} ms` : 'not run'}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- inspector */

function Inspector({ issue: i, onGo, sourceLabel, stale }: { issue: Issue; onGo: (i: Issue, ruleId?: string) => void; sourceLabel: string; stale: boolean }) {
  const setRecord = useStudio((s) => s.setRecord);
  const setOverrides = useStudio((s) => s.setOverrides);
  const setJourneyCursor = useStudio((s) => s.setJourneyCursor);
  const rep = i.reproduction;
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
        <h2 className="vc-detail-code mono">{i.code}</h2>
        <p className="vc-detail-msg">{i.message}</p>
        {stale && <div className="callout warning">This report is stale; re-run validation to confirm the issue still applies.</div>}
        <dl className="kv vc-kv">
          <dt>Suite</dt><dd>{i.suite}</dd>
          <dt>Severity</dt><dd><SeverityLabel severity={i.severity} /></dd>
          {i.nodeId && <><dt>Node</dt><dd className="mono">{i.nodeId}</dd></>}
          {idsOf(i).length > 0 && <><dt>Rules</dt><dd className="mono">{idsOf(i).join(', ')}</dd></>}
          {i.page !== undefined && <><dt>Page</dt><dd>{i.page}</dd></>}
          {i.locale && <><dt>Locale</dt><dd>{i.locale}</dd></>}
          {i.source && <><dt>Source</dt><dd>{i.source}</dd></>}
          {i.runId && <><dt>Run</dt><dd className="mono">{i.runId}</dd></>}
        </dl>
        {i.suggestion && <><h3 className="section-title">Suggested correction</h3><div className="callout accent" data-testid="issue-suggestion">{i.suggestion}</div></>}
        <h3 className="section-title">Reproduction</h3>
        {rep ? (
          <div className="card vc-repro">
            <div>Record <span className="mono">{rep.recordId}</span>{rep.journeyCursor !== null && rep.journeyCursor !== undefined ? <> · journey cursor <span className="mono">{rep.journeyCursor}</span></> : ' · no journey cursor'}</div>
            <div className="muted">Scenario overrides</div>
            <pre className="code">{Object.keys(rep.overrides ?? {}).length ? JSON.stringify(abridge(rep.overrides), null, 2) : '{} (none: the fixture record as-is)'}</pre>
            <button className="btn sm" onClick={reproduce} data-testid="reproduce-scenario"><Icon.target /> Load this scenario</button>
          </div>
        ) : <div className="muted">This check does not depend on a particular scenario (model-level analysis).</div>}
        {i.details && Object.keys(i.details).length > 0 && (<><h3 className="section-title">Details</h3><pre className="code" data-testid="issue-details">{JSON.stringify(abridge(i.details), null, 2)}</pre></>)}
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
        <span className="sub">{p.checks.length} checks</span>
        <div className="right"><label className="rd-check"><input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /> mismatches only</label></div></div>
      <div className="vc-parity-scroll">
        <table className="table">
          <caption className="rd-sr">Expected resolver facts compared with values extracted from the PDF and HTML outputs</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">Expected</th><th scope="col">PDF</th><th scope="col">HTML</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.status === 'mismatch' ? 'vc-bad' : ''}>
                <th scope="row" className="vc-rowhead">{c.label}{c.blocking && <span className="chip error vc-mini">blocking</span>}{c.note && <div className="muted">{c.note}</div>}</th>
                <td className="mono vc-val" title={fmtVal(c.expected)}>{fmtVal(c.expected)}</td>
                <td className="mono vc-val" title={fmtVal(c.pdf)}>{fmtVal(c.pdf)}</td>
                <td className="mono vc-val" title={fmtVal(c.html)}>{fmtVal(c.html)}</td>
                <td>{c.status === 'match' ? <span className="sev ok">✔ match</span> : c.status === 'mismatch' ? <span className="sev error">■ mismatch</span> : <span className="sev info">● allowed</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="muted">No mismatching checks.</td></tr>}
          </tbody>
        </table>
      </div>
      {p.allowedDifferences.length > 0 && (
        <div className="vc-allowed"><strong>Allowed differences</strong><ul>{p.allowedDifferences.map((a, k) => <li key={k}>{a}</li>)}</ul></div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------- seeded defects */

function DefectPanel() {
  const project = useStudio((s) => s.project)!;
  const dispatch = useStudio((s) => s.dispatch);
  const patchOverrides = useStudio((s) => s.patchOverrides);
  const clearOverrides = useStudio((s) => s.clearOverrides);
  const overrides = useStudio((s) => s.ctx.overrides);
  const res = useResolution();
  const eff = res?.effectiveRecord;
  const isCard = project.documentType === 'credit-statement';
  const r3 = project.rules.find((r) => r.id === 'R03');
  const table = project.nodes.find((n) => n.id === 'transaction-table');
  const claim0 = eff?.claims?.[0] as Record<string, unknown> | undefined;
  const txCount = (eff?.card?.transactions ?? []).length;
  const active = {
    d01: isCard && r3?.priority === 400,
    d02: eff?.customer.locale === 'es-US',
    d03: isCard && table?.flowContinuation === false && txCount >= 250,
    d04: !isCard && claim0?.patientResponsibilityCents === 30000 && claim0?.liabilityConfirmed === false,
  };
  const d03 = () => {
    const purchases = typeof eff?.card?.purchasesCents === 'number' ? (eff.card.purchasesCents as number) : 0;
    patchOverrides({ card: { transactions: makeTransactions(250, purchases) } });
    dispatch({ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: false } });
  };
  const d04 = () => {
    if (!claim0 || !eff?.claims) return;
    patchOverrides({ claims: [{ ...claim0, patientResponsibilityCents: 30000, liabilityConfirmed: false, status: 'denied-pending-review' }, ...eff.claims.slice(1)] });
  };
  const n = Object.keys(overrides).length;
  const Card = ({ id, title, text, on, children, note }: { id: string; title: string; text: string; on: boolean; children: React.ReactNode; note?: string }) => (
    <div className={`card vc-defect ${on ? 'active' : ''}`} data-testid={`defect-${id}`}>
      <div className="vc-defect-head"><strong>{id.toUpperCase()} · {title}</strong>{on && <span className="chip warning">active</span>}</div>
      <p className="hint">{text}</p>
      <div className="row wrap">{children}</div>
      {note && <p className="hint">{note}</p>}
    </div>
  );
  return (
    <aside className="panel vc-defects" aria-label="Seeded defect fixtures" data-testid="seeded-defects">
      <div className="panel-head">Seeded defects <span className="chip warning">demo fixtures</span></div>
      <div className="panel-body">
        <p className="hint">Deliberate defects for the guided demo. Apply one, then run validation to see the real finding. Model edits are undoable from the top bar; overrides are scenario-only.</p>
        <Card id="d01" title="Rule priority tie" on={active.d01} text="R03 and R04 get equal priority 400 in the same exclusive group. Also switches to CARD-0002 (2 missed payments + assistance), which matches both rules." note={!isCard ? 'Credit-statement project only.' : 'Expect EXCLUSIVE_PRIORITY_TIE.'}>
          <button className="btn danger sm" onClick={() => { if (injectD01()) useStudio.getState().setRecord('CARD-0002'); }} disabled={!isCard || active.d01} data-testid="seed-d01">Inject D01</button>
          <button className="btn sm" onClick={() => restoreR03()} disabled={!isCard || !active.d01}>Restore R03</button>
        </Card>
        <Card id="d02" title="Missing Spanish disclosure" on={active.d02} text="Scenario override customer.locale = es-US where mandatory translations are not approved." note="Expect REQUIRED_TRANSLATION_MISSING.">
          <button className="btn danger sm" onClick={() => patchOverrides({ customer: { locale: 'es-US' } })} disabled={active.d02} data-testid="seed-d02">Apply D02</button>
        </Card>
        <Card id="d03" title="Table overflow, no continuation" on={active.d03} text="250 synthetic transactions (scenario) and flowContinuation=false on the transaction table (model edit)." note={!isCard ? 'Credit-statement project only.' : 'Expect FLOW_OVERFLOW_NO_CONTINUATION.'}>
          <button className="btn danger sm" onClick={d03} disabled={!isCard || active.d03} data-testid="seed-d03">Apply D03</button>
          <button className="btn sm" disabled={!isCard || table?.flowContinuation !== false} onClick={() => dispatch({ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: true } })}>Re-enable continuation</button>
        </Card>
        <Card id="d04" title="Unconfirmed liability as due" on={active.d04} text="Claim override: member responsibility $300.00 with liabilityConfirmed=false, status denied-pending-review." note={isCard ? 'EOB project only.' : `Sets ${formatMoney(30000)} against an unconfirmed claim.`}>
          <button className="btn danger sm" onClick={d04} disabled={isCard || !claim0 || active.d04} data-testid="seed-d04">Apply D04</button>
        </Card>
        <button className="btn" onClick={() => clearOverrides()} disabled={!n} data-testid="clear-overrides"><Icon.reset /> Clear scenario overrides{n ? ` (${n})` : ''}</button>
      </div>
    </aside>
  );
}
