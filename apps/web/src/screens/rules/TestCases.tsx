import { useEffect, useMemo, useState } from 'react';
import type { Project, TestCase } from '@iss/model';
import { captureExpectation, nextTestId, runTestCases, summariseTests, type TestResult } from '@iss/scenarios';
import { useStudio } from '../../state/store';
import { Empty, Proof, Tech, Biz } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { nodeTitle } from '../../ui/plain';
import './TestCases.css';

const DEBOUNCE_MS = 250;
const EMPTY: TestCase[] = [];

/** Debounced results of every pinned test against a model (re-run on every model change). */
export function useTestResults(project: Project | null): { results: TestResult[]; pending: boolean } {
  const records = useStudio((s) => s.records);
  const [state, setState] = useState<{ results: TestResult[]; for: unknown }>({ results: [], for: null });
  const tests = project?.testCases ?? EMPTY;
  useEffect(() => {
    if (!project) return;
    if (!tests.length) { setState({ results: [], for: project }); return; }
    const h = setTimeout(() => setState({ results: runTestCases(project, records, tests), for: project }), DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [project, records, tests]);
  const current = !!project && state.for === project;
  return { results: current ? state.results : [], pending: !!project && !current };
}

/** Header chip: "12 of 12 tests pass". Opens the Tests view. */
export function TestsSummary({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const { results, pending } = useTestResults(project);
  const n = project.testCases?.length ?? 0;
  const s = summariseTests(results);
  const ok = !pending && s.failed === 0;
  const text = n === 0 ? 'No tests pinned' : pending ? `Checking ${n} test${n === 1 ? '' : 's'}…` : s.failed === 0 ? `${s.passed} of ${s.total} tests pass` : `${s.passed} of ${s.total} tests pass · ${s.failed} fail${s.failed === 1 ? 's' : ''}`;
  return (
    <button type="button" className={`chip rdtest-chip ${n === 0 || pending ? '' : ok ? 'accent' : 'error'}`} onClick={onOpen} data-testid="tests-summary" data-state={n === 0 ? 'empty' : pending ? 'pending' : ok ? 'pass' : 'fail'} title="Open regression tests" role="status" aria-live="polite">
      {n > 0 && !pending && <span aria-hidden="true">{ok ? '✔' : '⚠'}</span>}{text}
    </button>
  );
}

/** Next to Apply: which pinned tests the draft would break (run against the draft model). */
export function DraftTestImpact({ before, after }: { before: Project; after: Project | null }) {
  const now = useTestResults(before);
  const next = useTestResults(after);
  const n = before.testCases?.length ?? 0;
  if (!n || !after) return null;
  if (next.pending || now.pending) return <span className="rdtest-draft muted" data-testid="draft-tests" role="status">Checking {n} test{n === 1 ? '' : 's'} against the draft…</span>;
  const passing = new Set(now.results.filter((r) => r.pass).map((r) => r.testId));
  const broken = next.results.filter((r) => !r.pass && passing.has(r.testId));
  if (!broken.length) return <span className="rdtest-draft ok" data-testid="draft-tests" data-breaks="0" role="status">✔ All {n} tests still pass with this draft</span>;
  return (
    <span className="rdtest-draft bad" data-testid="draft-tests" data-breaks={broken.length} role="status">
      <strong>⚠ Would break {broken.length} of {n} test{n === 1 ? '' : 's'}:</strong>{' '}
      {broken.slice(0, 2).map((b) => <span key={b.testId} className="rdtest-draft-item">“{b.name}” — {b.diffs[0]?.message}</span>)}
      {broken.length > 2 && <span> and {broken.length - 2} more</span>}
    </span>
  );
}

function expectLines(project: Project, t: TestCase): string[] {
  const e = t.expect;
  const lines: string[] = [];
  for (const [id, v] of Object.entries(e.selectedVariants ?? {})) lines.push(`${nodeTitle(project, id)}: ${v ? nodeTitle(project, v) : 'nothing chosen'}`);
  if (e.visibleNodeIds?.length) lines.push(`Shown: ${e.visibleNodeIds.map((i) => nodeTitle(project, i)).join(', ')}`);
  if (e.hiddenNodeIds?.length) lines.push(`Hidden: ${e.hiddenNodeIds.map((i) => nodeTitle(project, i)).join(', ')}`);
  if (e.approvedLocale) lines.push(`Approved language: ${e.approvedLocale}`);
  if (e.noBlocking) lines.push('No blocking issues');
  return lines;
}

interface Pending { recordId: string; overrides: Record<string, unknown>; journeyCursor: number | null; name: string }

/** Regression tests: pin the current scenario and the outcome it must keep producing. */
export function TestsPanel({ project }: { project: Project }) {
  const records = useStudio((s) => s.records);
  const ctx = useStudio((s) => s.ctx);
  const dispatch = useStudio((s) => s.dispatch);
  const { results, pending: running } = useTestResults(project);
  const tests = project.testCases ?? EMPTY;
  const [naming, setNaming] = useState<Pending | null>(null);
  const [pickId, setPickId] = useState('');
  const docRecords = useMemo(() => records.filter((r) => r.documentType === project.documentType), [records, project.documentType]);
  const byId = useMemo(() => new Map(results.map((r) => [r.testId, r])), [results]);
  const s = summariseTests(results);
  const who = (id: string) => { const r = records.find((x) => x.recordId === id); return r ? `${r.customer.givenName} ${r.customer.familyName}`.trim() : id; };

  const suggest = (recordId: string, overrides: Record<string, unknown>, cursor: number | null) => {
    const rec = records.find((r) => r.recordId === recordId);
    const e = rec ? captureExpectation(project, rec, overrides, cursor) : undefined;
    const first = Object.entries(e?.selectedVariants ?? {}).find(([, v]) => v);
    return `${recordId}${first ? ` · ${nodeTitle(project, first[1]!)}` : ''}${Object.keys(overrides).length ? ' · with edits' : ''}`;
  };
  const startPin = (recordId: string, overrides: Record<string, unknown>, journeyCursor: number | null) => setNaming({ recordId, overrides, journeyCursor, name: suggest(recordId, overrides, journeyCursor) });
  const confirmPin = () => {
    if (!naming) return;
    const rec = records.find((r) => r.recordId === naming.recordId);
    if (!rec) return;
    const tc: TestCase = {
      id: nextTestId(tests), name: naming.name.trim(), recordId: naming.recordId,
      overrides: naming.overrides, journeyCursor: naming.journeyCursor,
      expect: captureExpectation(project, rec, naming.overrides, naming.journeyCursor), createdAt: new Date().toISOString(),
    };
    if (dispatch({ type: 'UPSERT_TEST_CASE', testCase: tc }).ok) setNaming(null);
  };
  const open = (t: TestCase) => {
    const st = useStudio.getState();
    st.setRecord(t.recordId);
    st.setOverrides(t.overrides ?? {});
    st.setJourneyCursor(t.journeyCursor ?? null);
    st.toast({ kind: 'info', title: `Scenario loaded: ${t.name}`, message: 'Record, edits and journey step now match this test.' });
  };
  const update = (t: TestCase) => {
    const rec = records.find((r) => r.recordId === t.recordId);
    if (!rec) return;
    dispatch({ type: 'UPSERT_TEST_CASE', testCase: { ...t, expect: captureExpectation(project, rec, t.overrides ?? {}, t.journeyCursor ?? null) } });
  };
  const del = (t: TestCase) => {
    if (window.confirm(`Delete test “${t.name}”? You can undo this from the top bar.`)) dispatch({ type: 'DELETE_TEST_CASE', testCaseId: t.id });
  };

  return (
    <section className="panel rdtest" data-testid="tests-panel" aria-label="Regression tests">
      <div className="panel-head">
        <Icon.target /> Regression tests
        <span className="sub" data-testid="tests-count">{tests.length === 0 ? 'none yet' : running ? 'checking…' : `${s.passed} of ${s.total} pass`}</span>
        <div className="right rdtest-pin">
          <button type="button" className="btn primary sm" onClick={() => startPin(ctx.recordId, ctx.overrides, ctx.journeyCursor)} data-testid="pin-test" title="Pin the current record, edits and journey step, with the outcome it produces now"><Icon.plus /> Pin current scenario as a test</button>
          <label className="rd-sr" htmlFor="pin-pick">Pin from record</label>
          <select id="pin-pick" className="select" value={pickId} onChange={(e) => setPickId(e.target.value)} data-testid="pin-from-record">
            <option value="">Pin from record…</option>
            {docRecords.map((r) => <option key={r.recordId} value={r.recordId}>{r.recordId} — {`${r.customer.givenName} ${r.customer.familyName}`.trim()}</option>)}
          </select>
          <button type="button" className="btn sm" disabled={!pickId} onClick={() => { startPin(pickId, {}, null); setPickId(''); }} data-testid="pin-from-record-go">Pin</button>
        </div>
      </div>
      <div className="rdtest-body">
        {naming && (
          <form className="rdtest-form" onSubmit={(e) => { e.preventDefault(); if (naming.name.trim()) confirmPin(); }} data-testid="pin-form">
            <label htmlFor="pin-name">Name this test <span className="muted">({naming.recordId}{Object.keys(naming.overrides).length ? ' with your scenario edits' : ''}{naming.journeyCursor !== null ? `, journey step ${naming.journeyCursor + 1}` : ''})</span></label>
            <div className="row">
              <input id="pin-name" className="input" autoFocus value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} data-testid="pin-name" />
              <button type="submit" className="btn primary" disabled={!naming.name.trim()} data-testid="pin-confirm">Save test</button>
              <button type="button" className="btn ghost" onClick={() => setNaming(null)}>Cancel</button>
            </div>
          </form>
        )}
        {tests.length === 0 && !naming ? (
          <Empty title="No tests yet" message="Pin the scenario you are looking at as a test: it saves the record, your edits and the outcome it produces now, and tells you if a later rule change would alter that outcome." />
        ) : (
          <ul className="rdtest-list" aria-label="Pinned tests">
            {tests.map((t) => {
              const r = byId.get(t.id);
              const status = !r ? 'pending' : r.pass ? 'pass' : 'fail';
              return (
                <li key={t.id} className={`rdtest-row ${status}`} data-testid="test-row" data-status={status} data-test-id={t.id}>
                  <div className="rdtest-main">
                    <span className={`rdtest-status ${status}`} data-testid="test-status">{status === 'pass' ? '✔ Pass' : status === 'fail' ? '⚠ Fail' : 'Checking…'}</span>
                    <strong className="rdtest-name" title={t.name}>{t.name}</strong>
                    <Biz><span className="muted rdtest-who">{who(t.recordId)}</span></Biz>
                    <span className="mono rd-rule-id">{t.recordId}</span>
                    <Tech><span className="mono rd-rule-id">{t.id}</span></Tech>
                  </div>
                  {r && !r.pass && (
                    <ul className="rdtest-diffs" data-testid="test-diffs">{r.diffs.map((d, i) => <li key={i}>{d.message}</li>)}</ul>
                  )}
                  <details className="rdtest-exp"><summary>Expects</summary>
                    <ul>{expectLines(project, t).map((l, i) => <li key={i}>{l}</li>)}</ul>
                    <Proof label="Scenario and expectation (JSON)"><pre className="code">{JSON.stringify({ recordId: t.recordId, overrides: t.overrides, journeyCursor: t.journeyCursor, expect: t.expect }, null, 2)}</pre></Proof>
                  </details>
                  <div className="rdtest-actions">
                    <button type="button" className="btn sm" onClick={() => open(t)} data-testid="test-open">Open scenario</button>
                    {status === 'fail' && <button type="button" className="btn sm" onClick={() => update(t)} data-testid="test-update" title="Replace the expectation with what the model produces now">Update expectation</button>}
                    <button type="button" className="btn sm ghost danger" onClick={() => del(t)} data-testid="test-delete" aria-label={`Delete test ${t.name}`}><Icon.trash /> Delete</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
