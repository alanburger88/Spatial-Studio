import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DOCUMENT_TYPE_LABEL, currentRelease, languageName, projectContentDigest, projectLanguages, translationStatus, type Project, type ReleaseInfo } from '@iss/model';
import { OUTPUT_PROFILES, coverageGaps, runTestCases, summariseTests, type CoverageGap } from '@iss/scenarios';
import { ApiFailure, api, type AuditEventDto, type ProjectReleasesDto } from '../api/client';
import { useIsDirty, useStudio } from '../state/store';
import { Empty, ErrorState, Loading, ScreenHeader } from '../ui/common';
import { StateChip, useWorkflow } from '../shell/Review';
import { useDrawers, When } from '../shell/History';
import { useDocumentBlockers } from './blockers/useBlockers';
import { clockTime, fullCheckOf, useFullCheck } from './blockers/fullCheck';
import { auditSentence } from './Activity';
import './Overview.css';

/**
 * Overview (S19): the document's home. Where it stands, what to do next, and a few facts at a glance.
 * Nothing here is stored or invented: every line is worked out from the open project, the same engines the other screens
 * use (coverage, blockers, translation status, pinned tests) or the API (releases, activity).
 */

type StepState = 'done' | 'todo' | 'attention' | 'not-needed' | 'working';
interface Step {
  key: string;
  title: string;
  state: StepState;
  why: ReactNode;
  /** One button: opens the screen (or panel) where the step is dealt with. */
  action: { label: string; to?: string; run?: () => void };
}

const STATE_WORD: Record<StepState, string> = { done: 'Done', todo: 'To do', attention: 'Needs attention', 'not-needed': 'Not needed', working: 'Checking' };
const STATE_GLYPH: Record<StepState, string> = { done: '✓', todo: '○', attention: '!', 'not-needed': '–', working: '…' };
const STATE_CHIP: Record<StepState, string> = { done: 'accent', todo: '', attention: 'warning', 'not-needed': 'info', working: '' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const customers = (n: number) => plural(n, 'synthetic customer');

/** Rules, message versions and sections that no customer reaches. Worked out after paint, again a moment after the model or customers change. */
function useCoverage(project: Project, records: ReturnType<typeof useStudio.getState>['records']): { gaps: CoverageGap[] | null; stale: boolean } {
  const [state, setState] = useState<{ gaps: CoverageGap[]; project: Project; records: typeof records } | null>(null);
  useEffect(() => {
    if (records.length === 0) { setState({ gaps: [], project, records }); return; }
    const h = setTimeout(() => {
      try { setState({ gaps: coverageGaps(project, records), project, records }); } catch { setState(null); }
    }, 250);
    return () => clearTimeout(h);
  }, [project, records]);
  return { gaps: state?.gaps ?? null, stale: !!state && (state.project !== project || state.records !== records) };
}

/** Pinned tests, run with the same engine as the Rules & Data screen. A handful of resolutions, so it is done after paint. */
function usePinnedTests(project: Project, records: ReturnType<typeof useStudio.getState>['records']) {
  const [sum, setSum] = useState<{ total: number; passed: number; failed: number } | null>(null);
  useEffect(() => {
    const h = setTimeout(() => { try { setSum(summariseTests(runTestCases(project, records))); } catch { setSum(null); } }, 100);
    return () => clearTimeout(h);
  }, [project, records]);
  return sum;
}

function useReleases(projectId: string) {
  const savedVersion = useStudio((s) => s.serverVersion);
  const wf = useWorkflow((s) => (s.wf && s.wf.projectId === projectId ? s.wf : null));
  const [data, setData] = useState<ProjectReleasesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    api.projectReleases(projectId)
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiFailure ? e.message : 'The releases could not be loaded.'); });
    return () => { live = false; };
  }, [projectId, rev, savedVersion, wf?.state, wf?.updatedAt]);
  return { data, error, retry: () => setRev((r) => r + 1) };
}

function useRecentActivity(projectId: string) {
  const savedVersion = useStudio((s) => s.serverVersion);
  const [events, setEvents] = useState<AuditEventDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    api.audit({ projectId, limit: 5 })
      .then((r) => { if (live) { setEvents(r.events.slice(0, 5)); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiFailure ? e.message : 'The activity could not be loaded.'); });
    return () => { live = false; };
  }, [projectId, rev, savedVersion]);
  return { events, error, retry: () => setRev((r) => r + 1) };
}

export function Overview() {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const savedVersion = useStudio((s) => s.serverVersion);
  const dirty = useIsDirty();
  const navigate = useNavigate();
  const pid = project.projectId;
  const base = `/studio/${pid}`;
  const wf = useWorkflow((s) => (s.wf && s.wf.projectId === pid ? s.wf : null));
  const { data: blockerData } = useDocumentBlockers();
  const full = useFullCheck((s) => fullCheckOf(s, pid));
  const { gaps, stale: gapsStale } = useCoverage(project, records);
  const tests = usePinnedTests(project, records);
  const rel = useReleases(pid);
  const activity = useRecentActivity(pid);

  const docRecords = useMemo(() => records.filter((r) => r.documentType === project.documentType), [records, project.documentType]);
  const languages = projectLanguages(project);
  const translations = useMemo(() => languages.map((l) => ({ locale: l, summary: translationStatus(project, l).summary })), [project]); // eslint-disable-line react-hooks/exhaustive-deps
  const blockers = blockerData?.result ?? null;

  const releases: ReleaseInfo[] = rel.data?.releases ?? [];
  const production = currentRelease(releases, 'production');
  const test = currentRelease(releases, 'test');

  /* ------------------------------------------------------------------ the next steps, in order */
  const steps: Step[] = [];

  // (a) customers to test with
  steps.push({
    key: 'customers', title: 'Customers to test with',
    state: docRecords.length > 0 ? 'done' : 'todo',
    why: docRecords.length > 0 ? `${customers(docRecords.length)} to try this document on.` : 'There are no customers yet, so nothing can be previewed or checked. Add one, or generate test customers from your rules.',
    action: { label: docRecords.length > 0 ? 'Open customers' : 'Add customers', to: `${base}/data` },
  });

  // (b) every outcome covered
  {
    let state: StepState; let why: ReactNode;
    if (docRecords.length === 0) { state = 'todo'; why = 'Coverage needs customers to look at. Add some first.'; }
    else if (!gaps) { state = 'working'; why = 'Working out which rules, message versions and sections the customers reach…'; }
    else if (gaps.length === 0 && project.rules.length === 0) { state = 'not-needed'; why = 'This document has no rules yet, so there are no outcomes to cover.'; }
    else if (gaps.length === 0) { state = 'done'; why = `Every rule, message version and section is reached by at least one of ${customers(docRecords.length)}.`; }
    else {
      const reachable = gaps.filter((g) => g.scenario).length;
      state = 'todo';
      why = `${plural(gaps.length, 'rule, message version or section is', 'rules, message versions or sections are')} not reached by any of ${customers(docRecords.length)}. ${reachable === gaps.length ? 'Generating test customers would reach all of them.' : `${reachable} could be reached with a generated customer; ${gaps.length - reachable} cannot be reached at all.`}`;
    }
    steps.push({ key: 'coverage', title: 'Every outcome has a customer', state, why: gapsStale && state !== 'working' ? <>{why} <span className="muted">(updating…)</span></> : why, action: { label: 'Find coverage gaps', to: `${base}/rules-data` } });
  }

  // (c) no blockers
  {
    let state: StepState; let why: ReactNode;
    if (!blockers) { state = 'working'; why = 'Checking every customer for blockers…'; }
    else if (blockers.blockers.length > 0) {
      const n = blockers.blockers.length;
      state = 'attention';
      why = `${plural(n, 'blocker')} ${n === 1 ? 'stops' : 'stop'} ${blockers.stopped} of ${customers(blockers.checked)} from being issued.`;
    }
    else if (blockers.checked === 0) { state = 'todo'; why = 'Blockers are found by checking customers. Add some first.'; }
    else { state = 'done'; why = `No blocker stops any of ${customers(blockers.checked)}.`; }
    steps.push({ key: 'blockers', title: 'No blockers', state, why, action: { label: 'See blockers', to: `${base}/blockers` } });
  }

  // (d) translations approved for every language
  {
    let state: StepState; let why: ReactNode;
    if (languages.length === 0) { state = 'not-needed'; why = 'This document has no language besides English, so there is nothing to translate.'; }
    else {
      const open = translations.filter((t) => t.summary.approved < t.summary.total);
      if (open.length === 0) { state = 'done'; why = `All wording is approved in ${languages.map(languageName).join(' and ')}.`; }
      else {
        const mandatory = open.some((t) => t.summary.mandatoryMissing > 0);
        state = mandatory ? 'attention' : 'todo';
        why = open.map((t) => `${languageName(t.locale)}: ${t.summary.total - t.summary.approved} of ${plural(t.summary.total, 'text')} not approved yet (${t.summary.drafts} draft, ${t.summary.missing} missing)`).join('. ') + '.' + (mandatory ? ' Some of the missing text is required.' : '');
      }
    }
    steps.push({ key: 'translations', title: 'Translations approved', state, why, action: { label: 'Open wording & translations', to: `${base}/content` } });
  }

  // (e) a full check since the last change
  {
    let state: StepState; let why: ReactNode;
    const digest = projectContentDigest(project);
    if (docRecords.length === 0) { state = 'todo'; why = 'A full check runs over the customers. Add some first.'; }
    else if (full.status === 'running') { state = 'working'; why = `Running now: ${full.done} of ${customers(full.total)} checked.`; }
    else if (full.ranAtMs && full.digest === digest) {
      const found = new Set(full.findings.map((f) => f.recordId)).size;
      state = full.error ? 'attention' : 'done';
      why = `Run at ${clockTime(full.ranAtMs)} on this version of the document, across ${customers(full.total)}${found ? `; it found blocking problems for ${plural(found, 'customer')}` : '; it found no blocking problems'}.${full.error ? ` ${full.error}` : ''}`;
    } else if (full.ranAtMs) { state = 'todo'; why = `The document has changed since the last full check (run at ${clockTime(full.ranAtMs)}). Run it again.`; }
    else { state = 'todo'; why = 'No full check has been run in this browser session. The studio keeps the result for this session only, so it cannot tell whether one was run earlier.'; }
    steps.push({ key: 'full-check', title: 'Full check since the last change', state, why, action: { label: 'Open blockers to run it', to: `${base}/blockers` } });
  }

  // (f) reviewed and approved
  {
    let state: StepState; let why: ReactNode;
    const unsaved = dirty ? ' You have unsaved changes: they are not part of what is reviewed until you save.' : '';
    if (!wf) { state = 'working'; why = 'Loading the review status…'; }
    else if (wf.state === 'approved' || wf.state === 'published') { state = 'done'; why = `Version ${wf.modelVersion} is ${wf.label.toLowerCase()}.${unsaved}`; }
    else if (wf.state === 'changes_requested') { state = 'attention'; why = `A reviewer asked for changes to version ${wf.modelVersion}.${unsaved}`; }
    else if (wf.state === 'in_review') { state = 'todo'; why = `Version ${wf.modelVersion} is waiting for a reviewer to approve it.${unsaved}`; }
    else { state = 'todo'; why = `Version ${wf.modelVersion} is a draft. Submit it for review, then have it approved.${unsaved}`; }
    steps.push({ key: 'review', title: 'Reviewed and approved', state, why, action: { label: 'Open review', run: () => useDrawers.getState().show('review') } });
  }

  // (g) released to Production
  {
    let state: StepState; let why: ReactNode;
    if (rel.error && !rel.data) { state = 'attention'; why = `The releases could not be loaded: ${rel.error}`; }
    else if (!rel.data) { state = 'working'; why = 'Loading the releases…'; }
    else if (production) {
      state = 'done';
      why = `Release ${production.number} (version ${production.modelVersion}) is live in Production.${production.modelVersion < savedVersion ? ` The document has moved on to version ${savedVersion} since.` : ''}`;
    } else if (releases.length > 0) {
      state = 'todo';
      why = test ? `Release ${test.number} is in Test but nothing is live in Production yet.` : `${plural(releases.length, 'release')} exist${releases.length === 1 ? 's' : ''}, but none is current in Production.`;
    } else { state = 'todo'; why = 'Nothing has been released yet. Approving the document makes release 1, which goes to Test first.'; }
    steps.push({ key: 'release', title: 'Released to Production', state, why, action: { label: 'Open releases', to: `${base}/releases` } });
  }

  const nextIdx = steps.findIndex((s) => s.state !== 'done' && s.state !== 'not-needed');
  const nextKey = nextIdx >= 0 && steps[nextIdx].state !== 'working' ? steps[nextIdx].key : null;
  const remaining = steps.filter((s) => s.state !== 'done' && s.state !== 'not-needed').length;

  const stageText = (r: ReleaseInfo | null): string => (r ? `Release ${r.number} (version ${r.modelVersion})` : 'Nothing');
  const goTo = (a: Step['action']) => (a.run ? a.run() : a.to && navigate(a.to));

  return (
    <section className="screen" data-testid="overview-screen">
      <ScreenHeader id="S19" title="Overview" subtitle="Where this document stands and what to do next. Everything here is worked out from the document, its customers and its releases." />
      <div className="screen-body ov-body">
        {/* ---------------------------------------------------------------- status strip */}
        <div className="ov-status panel" role="group" aria-label="Document status" data-testid="overview-status">
          <div className="ov-fact ov-fact-wide">
            <span className="ov-label">Document</span>
            <strong className="ov-value ov-title" title={project.title} data-testid="overview-title">{project.title}</strong>
            <span className="muted" data-testid="overview-kind">{DOCUMENT_TYPE_LABEL[project.documentType]}</span>
          </div>
          <div className="ov-fact">
            <span className="ov-label">Review</span>
            <span className="ov-value" data-testid="overview-workflow">{wf ? <StateChip state={wf.state} /> : <span className="muted">Loading…</span>}</span>
          </div>
          <div className="ov-fact">
            <span className="ov-label">Version</span>
            <strong className="ov-value" data-testid="overview-version">Version {project.modelVersion}</strong>
            <span className={dirty ? 'ov-unsaved' : 'muted'} data-testid="overview-saved">{dirty ? '● Unsaved changes' : 'All changes saved'}</span>
          </div>
          <div className="ov-fact ov-fact-wide">
            <span className="ov-label">Released</span>
            {rel.error && !rel.data ? <span className="muted" data-testid="overview-released">Could not be loaded</span>
              : !rel.data ? <span className="muted" data-testid="overview-released">Loading…</span>
              : <span className="ov-stages" data-testid="overview-released">
                  <span><span className="muted">Test</span> <strong data-testid="overview-test">{stageText(test)}</strong></span>
                  <span><span className="muted">Production</span> <strong data-testid="overview-production">{stageText(production)}</strong></span>
                </span>}
          </div>
        </div>

        <div className="ov-grid">
          {/* ---------------------------------------------------------------- next steps */}
          <section className="panel ov-steps-panel" aria-labelledby="ov-steps-h">
            <div className="panel-head">
              <h2 className="section-title" id="ov-steps-h">Next steps</h2>
              <div className="right muted" data-testid="overview-remaining">{remaining === 0 ? 'All steps are done' : `${remaining} of ${steps.length} still to go`}</div>
            </div>
            <ol className="ov-steps list-rows" data-testid="overview-steps">
              {steps.map((s, i) => (
                <li key={s.key} className={`ov-step${s.key === nextKey ? ' is-next' : ''}`} data-testid={`overview-step-${s.key}`} data-state={s.state} aria-current={s.key === nextKey ? 'step' : undefined}>
                  <span className="ov-step-n" aria-hidden="true">{i + 1}</span>
                  <div className="ov-step-main">
                    <div className="ov-step-head">
                      <strong>{s.title}</strong>
                      <span className={`chip ${STATE_CHIP[s.state]}`} data-testid={`overview-step-state-${s.key}`}><span aria-hidden="true">{STATE_GLYPH[s.state]}</span> {STATE_WORD[s.state]}</span>
                      {s.key === nextKey && <span className="chip info ov-next" data-testid="overview-next">Next</span>}
                    </div>
                    <p className="ov-why" data-testid={`overview-step-why-${s.key}`}>{s.why}</p>
                  </div>
                  <div className="ov-step-act">
                    {s.state === 'done' || s.state === 'not-needed'
                      ? <button type="button" className="btn ghost sm" onClick={() => goTo(s.action)} data-testid={`overview-step-action-${s.key}`}>{s.action.label}</button>
                      : <button type="button" className={`btn sm${s.key === nextKey ? ' primary' : ''}`} onClick={() => goTo(s.action)} data-testid={`overview-step-action-${s.key}`}>{s.action.label}</button>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <div className="ov-side">
            {/* -------------------------------------------------------------- at a glance */}
            <section className="panel" aria-labelledby="ov-glance-h" data-testid="overview-glance">
              <div className="panel-head"><h2 className="section-title" id="ov-glance-h">At a glance</h2></div>
              <dl className="ov-glance">
                <div><dt>Customers</dt><dd data-testid="glance-customers">
                  {!blockers ? <span className="muted">Checking…</span>
                    : blockers.checked === 0 ? 'No customers yet'
                    : <>{customers(blockers.checked)}: <strong>{blockers.issuable}</strong> can be issued{blockers.stopped > 0 ? <>, <strong>{blockers.stopped}</strong> stopped by a blocker</> : ', none stopped'}</>}
                </dd></div>
                <div><dt>Languages</dt><dd data-testid="glance-languages">{['English', ...languages.map(languageName)].join(', ')}</dd></div>
                <div><dt>Outputs</dt><dd data-testid="glance-outputs">{[...OUTPUT_PROFILES.map((p) => p.label), 'Email', 'Text message'].join(', ')}</dd></div>
                <div><dt>Pinned tests</dt><dd data-testid="glance-tests">
                  {!tests ? <span className="muted">Checking…</span>
                    : tests.total === 0 ? <>None yet. <Link to={`${base}/rules-data`}>Pin one from Rules</Link></>
                    : <><strong>{tests.passed}</strong> of {tests.total} pass{tests.failed > 0 ? <>, <strong>{tests.failed}</strong> fail</> : ''} <Link to={`${base}/rules-data`}>Open rules</Link></>}
                </dd></div>
              </dl>
            </section>

            {/* -------------------------------------------------------------- recent activity */}
            <section className="panel" aria-labelledby="ov-activity-h" data-testid="overview-activity">
              <div className="panel-head">
                <h2 className="section-title" id="ov-activity-h">Recent activity</h2>
                <div className="right"><Link to={`${base}/activity`} data-testid="overview-activity-link">All activity</Link></div>
              </div>
              {activity.error && !activity.events ? <ErrorState title="Activity could not be loaded" message={activity.error} onRetry={activity.retry} />
                : !activity.events ? <Loading label="Loading activity…" />
                : activity.events.length === 0 ? <Empty title="Nothing recorded yet" message="Saves, reviews and releases of this document will appear here." />
                : (
                  <ul className="ov-activity list-rows">
                    {activity.events.map((e) => (
                      <li key={e.id}>
                        <span className="ov-act-what">{auditSentence(e, project)}</span>
                        <span className="ov-act-meta muted">{e.userName ?? 'Someone'} · <When iso={e.at} /></span>
                      </li>
                    ))}
                  </ul>
                )}
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
export default Overview;
