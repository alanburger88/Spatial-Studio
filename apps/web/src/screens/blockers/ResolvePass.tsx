import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { Persona, Project, SyntheticRecord } from '@iss/model';
import { resolveOrder, testsForFixedBlockers, type BlockerLink, type BlockerWithStatus, type FixProposal } from '@iss/scenarios';
import { applyAssistCommands } from '../../assist/common';
import { recordSummary } from '../../shell/RecordPicker';
import { useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { CountChips, Customers, FixCards, type DataActions } from './BlockerDetail';
import { clockTime, type FullCheckResult } from './fullCheck';
import { KIND_LABEL, KIND_NEXT, plural } from './labels';
import { WordingHelp } from './WordingHelp';
import { useFixImpacts, type BlockerData } from './useBlockers';
import { WorkChips } from './WorkParts';
import { statusOf, useBlockerWork } from './work';

/**
 * "Resolve one by one": a guided pass over the open blockers, most customers still stopped first. Each step explains the
 * blocker, shows the fixes side by side with their effect, and offers Apply (one undoable step, like everywhere else) or
 * Skip. The progress is what the engine works out after each step, never an estimate. The pass keeps its place per
 * document for this browser session, so it can be left and resumed; closing it loses nothing because every applied fix is
 * already an ordinary edit. At the end it offers to pin a test for each blocker fixed in the pass.
 */

/** A blocker fixed in this pass (or on its own), remembered so a test can be pinned for it. */
export interface FixedBlocker { blockerId: string; title: string; recordIds: string[] }
interface Awaiting extends FixedBlocker { project: Project; speed: 'fast' | 'full-check' }
interface PassState {
  open: boolean;
  /** Customers stopped when the pass started. */
  startStopped: number;
  skipped: string[];
  fixed: FixedBlocker[];
  /** Fixes applied to blockers from the full check: only the next full check can confirm them. */
  unconfirmed: string[];
  /** A fix was applied to this blocker and the engine has not answered yet (or it still stops someone). */
  awaiting: Awaiting | null;
  pinned: string[];
}
const FRESH: PassState = { open: false, startStopped: 0, skipped: [], fixed: [], unconfirmed: [], awaiting: null, pinned: [] };

interface PassStore {
  byProject: Record<string, PassState>;
  patch(projectId: string, p: Partial<PassState> | ((s: PassState) => Partial<PassState>)): void;
}
export const useResolvePass = create<PassStore>((set) => ({
  byProject: {},
  patch(projectId, p) {
    set((st) => {
      const cur = st.byProject[projectId] ?? FRESH;
      return { byProject: { ...st.byProject, [projectId]: { ...cur, ...(typeof p === 'function' ? p(cur) : p) } } };
    });
  },
}));
export const passOf = (s: PassStore, projectId: string): PassState => s.byProject[projectId] ?? FRESH;

/** Starts a pass (or resumes the one in progress). */
export function openPass(projectId: string, stoppedNow: number): void {
  const st = useResolvePass.getState();
  const cur = passOf(st, projectId);
  const inProgress = cur.startStopped > 0 || cur.skipped.length || cur.fixed.length;
  st.patch(projectId, inProgress ? { open: true } : { ...FRESH, open: true, startStopped: stoppedNow });
}

/** The blockers the pass still has to visit. */
export function passRemaining(data: BlockerData, s: PassState): BlockerWithStatus[] {
  return resolveOrder(data.result).filter((b) => !s.skipped.includes(b.id) && !s.unconfirmed.includes(b.id));
}

/* ------------------------------------------------------------------ pin a test for what was fixed */

/**
 * The offer to pin a test for each fixed blocker: one affected customer per blocker, ticked, which the person can untick.
 * Nothing is pinned until they choose "Pin"; pinning is one undoable step through the usual path.
 */
export function PinOffer({ fixed, records, personas, project, onPinned, compact }: { fixed: FixedBlocker[]; records: SyntheticRecord[]; personas: Persona[]; project: Project; onPinned?: (ids: string[]) => void; compact?: boolean }) {
  const journeyCursor = useStudio((s) => s.ctx.journeyCursor);
  const items = useMemo(() => fixed.map((f) => {
    const recordId = f.recordIds.find((id) => records.some((r) => r.recordId === id && r.documentType === project.documentType)) ?? null;
    const r = recordId ? records.find((x) => x.recordId === recordId)! : null;
    return { ...f, recordId, name: r ? recordSummary(r, personas).name : null };
  }), [fixed, records, personas, project.documentType]);
  const pinnable = items.filter((i) => i.recordId);
  const [chosen, setChosen] = useState<string[]>(() => pinnable.map((i) => i.blockerId));
  useEffect(() => { setChosen(pinnable.map((i) => i.blockerId)); }, [pinnable.map((i) => i.blockerId).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return null;
  const pin = () => {
    const picked = pinnable.filter((i) => chosen.includes(i.blockerId));
    const tests = testsForFixedBlockers(project, records, picked.map((i) => ({ blockerId: i.blockerId, title: i.title, recordId: i.recordId! })), { journeyCursor });
    if (!tests.length) return;
    const stamped = tests.map((t) => ({ ...t, createdAt: new Date().toISOString() }));
    if (applyAssistCommands(stamped.map((testCase) => ({ type: 'UPSERT_TEST_CASE' as const, testCase })), stamped.length === 1 ? `Pin test “${stamped[0].name}”` : `Pin ${stamped.length} tests for fixed blockers`, 'pin-test')) onPinned?.(picked.map((i) => i.blockerId));
  };
  return (
    <div className={`bl-pin${compact ? ' compact' : ''}`} data-testid="bl-pin-offer">
      <p className="bl-pin-lead"><strong>Pin a test so {items.length === 1 ? 'this problem' : 'these problems'} cannot come back unnoticed.</strong> Each test keeps what the document gives one affected customer now; it fails in Rules &amp; Data and on the approval screen if a later change brings the problem back.</p>
      <ul className="bl-pin-list">
        {items.map((i) => (
          <li key={i.blockerId}>
            {i.recordId ? (
              <label className="bl-pin-item">
                <input type="checkbox" checked={chosen.includes(i.blockerId)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, i.blockerId] : c.filter((x) => x !== i.blockerId)))} data-testid={`bl-pin-${i.blockerId}`} />
                <span><strong>{i.title}</strong> <span className="muted">with {i.name}</span></span>
              </label>
            ) : <span className="muted bl-pin-item">{i.title}: no customer it stopped is left to test with.</span>}
          </li>
        ))}
      </ul>
      {pinnable.length > 0 && <button type="button" className="btn primary sm" onClick={pin} disabled={!chosen.length} data-testid="bl-pin-confirm">{chosen.length === 1 ? 'Pin 1 test' : `Pin ${chosen.length} tests`}</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ the pass */

export function ResolvePass({ data, current, full, modelChanged, readOnlyReason, dataActions, onOpen, onPreview, onRunFull, onClose }: {
  data: BlockerData; current: boolean; full: FullCheckResult; modelChanged: boolean; readOnlyReason: string | null; dataActions: DataActions;
  onOpen: (link?: BlockerLink | null) => void; onPreview: (recordId: string) => void; onRunFull: () => void; onClose: () => void;
}) {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const pid = project.projectId;
  const s = useResolvePass((st) => passOf(st, pid));
  const patch = (p: Partial<PassState> | ((s: PassState) => Partial<PassState>)) => useResolvePass.getState().patch(pid, p);
  const { result } = data;
  const work = useBlockerWork();

  /* After a fix: once the engine has worked out the changed model, the blocker is either gone (fixed) or still there. */
  useEffect(() => {
    const a = s.awaiting;
    if (!a || !current || data.project === a.project) return;
    const still = result.blockers.find((b) => b.id === a.blockerId);
    if (!still) patch((p) => ({ awaiting: null, fixed: [...p.fixed.filter((f) => f.blockerId !== a.blockerId), { blockerId: a.blockerId, title: a.title, recordIds: a.recordIds }] }));
    else if (a.speed === 'full-check') patch((p) => ({ awaiting: null, unconfirmed: [...p.unconfirmed, a.blockerId] }));
  }, [data, current]); // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = passRemaining(data, s);
  const step = s.awaiting && remaining.some((b) => b.id === s.awaiting!.blockerId) ? remaining.find((b) => b.id === s.awaiting!.blockerId)! : remaining[0] ?? null;
  const stillAfterFix = !!(s.awaiting && step && s.awaiting.blockerId === step.id && current && data.project !== s.awaiting.project);
  const wanted = useMemo(() => (step ? step.fixes.map((fix) => ({ blocker: step, fix })) : []), [data, step?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const impactFor = useFixImpacts(project, records, wanted, current);

  const apply = (fix: FixProposal) => {
    if (!step || !fix.commands?.length) return;
    // The model as it was before the fix: once the engine has worked out a different one, the fix has been taken into account.
    const before = data.project;
    if (applyAssistCommands(fix.commands, fix.title, 'fix', fix.source)) patch({ awaiting: { blockerId: step.id, title: step.title, recordIds: step.recordIds, project: before, speed: step.speed } });
  };
  const skip = () => { if (step) patch((p) => ({ skipped: [...p.skipped, step.id], awaiting: null })); };

  const start = Math.max(s.startStopped, result.stopped);
  const visited = s.fixed.length + s.skipped.length + s.unconfirmed.length;
  const toPin = s.fixed.filter((f) => !s.pinned.includes(f.blockerId));

  return (
    <section className="panel bl-pass" data-testid="bl-pass" aria-labelledby="bl-pass-h" aria-busy={!current}>
      <div className="panel-head bl-pass-head">
        <h2 id="bl-pass-h">Resolve one by one</h2>
        <span className="sub">{step ? `${plural(remaining.length, 'blocker')} to go` : 'Done'}{visited ? ` · ${s.fixed.length} fixed, ${s.skipped.length} skipped` : ''}</span>
        <button type="button" className="btn sm" onClick={onClose} data-testid="bl-pass-close">Leave the pass</button>
      </div>
      <div className="panel-body bl-pass-body">
        <div className="bl-progress" data-testid="bl-pass-progress" data-stopped={result.stopped} data-start={start}>
          <div className="bl-progress-text">
            <strong data-testid="bl-pass-stopped">{result.stopped}</strong> of {result.checked} synthetic customers still stopped
            {start > result.stopped ? <span className="muted"> (down from {start} when the pass started)</span> : null}
            {result.setAside > 0 && <span className="muted"> · {result.setAside} set aside as known data problems</span>}
            {!current && <span className="muted"> · checking again after your change…</span>}
          </div>
          {/* Filled: customers no longer stopped since the pass started; the rest of the bar: customers still stopped. */}
          <div className="bl-progress-bar" role="progressbar" aria-label="Customers no longer stopped" aria-valuemin={0} aria-valuemax={Math.max(start, 1)} aria-valuenow={start - result.stopped} aria-valuetext={`${result.stopped} of ${start} customers still stopped`}>
            <span style={{ width: `${start ? ((start - result.stopped) / start) * 100 : 100}%` }} />
          </div>
          <p className="hint bl-pass-speeds" data-testid="bl-pass-speeds">
            Rules, wording and data: {current ? `checked just now for all ${result.checked} synthetic customers` : 'updating…'}. Pages and PDF/web differences: {full.ranAtMs !== null ? `from the full check at ${clockTime(full.ranAtMs)}${modelChanged ? ', made before your last change' : ''}` : 'not checked yet'}.
          </p>
        </div>

        {step ? (
          <div className="bl-pass-step" data-testid="bl-pass-step" data-blocker={step.id} data-kind={step.kind}>
            <div className="bl-detail-head">
              <span className="muted bl-pass-n">Blocker {visited + 1} of {visited + remaining.length}</span>
              <h3 className="bl-detail-title" data-testid="bl-pass-title">{step.title}</h3>
              <div className="bl-chips">
                <span className={`chip${step.kind === 'customer-data' ? ' warning' : ''}`}>{KIND_LABEL[step.kind]}</span>
                <CountChips blocker={step} />
                <WorkChips status={statusOf(step, work.items.find((i) => i.blockerId === step.id))} item={work.items.find((i) => i.blockerId === step.id)} />
                {step.speed === 'full-check' ? <span className="chip info">from the full check</span> : <span className="chip">checked just now</span>}
              </div>
            </div>
            <h4 className="section-title">What is wrong and why</h4>
            <p className="bl-why">{step.explanation}</p>
            {step.speed === 'full-check' && (
              <div className="bl-note warn bl-pass-fullnote" role="status" data-testid="bl-pass-fullcheck">
                This comes from the last full check{full.ranAtMs !== null ? ` at ${clockTime(full.ranAtMs)}` : ''}, which composes the pages. Whether a fix works is confirmed by running it again.
                <button type="button" className="btn sm" onClick={onRunFull} disabled={full.status === 'running'} data-testid="bl-pass-run-full"><Icon.validate /> {full.status === 'running' ? 'Checking…' : 'Run the full check'}</button>
              </div>
            )}

            <h4 className="section-title">Who is affected</h4>
            <Customers blocker={step} records={records} personas={personas} onPreview={onPreview} data={dataActions} />

            {step.kind === 'customer-data' ? (
              <>
                <h4 className="section-title">What can be done</h4>
                <p className="hint">{KIND_NEXT['customer-data']} Open the customer to see the values that disagree, or, if they cannot be corrected before approval, mark it as a known data problem for that customer with a reason.</p>
                <div className="row wrap bl-pass-actions">
                  <button type="button" className="btn primary" onClick={() => dataActions.onOpenData(step.openRecordIds[0] ?? step.recordIds[0], step.id)} disabled={!step.recordIds.length} data-testid="bl-pass-open-data"><Icon.external /> Open in Data Explorer</button>
                  {step.openRecordIds[0] && <button type="button" className="btn" onClick={() => dataActions.onMarkKnown(step, step.openRecordIds[0])} disabled={!!dataActions.knownBlockedReason} title={dataActions.knownBlockedReason ?? undefined} data-testid="bl-pass-mark-known">Mark as a known data problem</button>}
                  <button type="button" className="btn ghost" onClick={skip} data-testid="bl-pass-skip">Skip</button>
                </div>
              </>
            ) : (
              <>
                <h4 className="section-title">{step.fixes.length > 1 ? 'Fixes to choose from, side by side' : 'How to fix it'}</h4>
                {readOnlyReason && step.fixes.some((f) => f.kind === 'change') && <p className="hint bl-readonly">You can see the fixes but not apply them: {readOnlyReason.charAt(0).toLowerCase() + readOnlyReason.slice(1)}.</p>}
                {stillAfterFix && <p className="bl-note warn" role="status" data-testid="bl-pass-still">The fix was applied, but this still stops {plural(step.openRecordIds.length, 'customer')}. Choose another fix, open where it is fixed, or skip it. Undo is in the top bar.</p>}
                <FixCards blocker={step} impactFor={impactFor} readOnlyReason={readOnlyReason} appliedFixId={null} onApply={apply} onOpen={onOpen} />
                {/* Phase 5: AI drafts for wording blockers */}
                <WordingHelp key={`assist-${step.id}`} blocker={step} onOpen={onOpen} compact />
                <div className="row wrap bl-pass-actions">
                  <button type="button" className="btn" onClick={() => onOpen(step.link)} data-testid="bl-pass-open"><Icon.external /> {step.link?.label ?? 'Open where this is fixed'}</button>
                  <button type="button" className="btn ghost" onClick={skip} data-testid="bl-pass-skip">Skip</button>
                </div>
              </>
            )}
            {s.fixed.length > 0 && <p className="hint bl-pass-later">When the pass ends you will be offered to pin a test for each blocker you fixed.</p>}
          </div>
        ) : (
          <div className="bl-pass-end" data-testid="bl-pass-end">
            <h3 className="bl-detail-title">{result.stopped === 0 ? 'Nothing stops any customer any more.' : 'You have been through every open blocker.'}</h3>
            <p data-testid="bl-pass-summary">{plural(s.fixed.length, 'blocker')} fixed, {s.skipped.length} skipped{s.unconfirmed.length ? `, ${s.unconfirmed.length} waiting for the full check to confirm` : ''}. {result.stopped} of {result.checked} synthetic customers {result.stopped === 1 ? 'is' : 'are'} still stopped{result.setAside ? ` and ${result.setAside} ${result.setAside === 1 ? 'is' : 'are'} set aside as known data problems` : ''}.</p>
            {s.unconfirmed.length > 0 && <div className="row wrap"><button type="button" className="btn" onClick={onRunFull} disabled={full.status === 'running'} data-testid="bl-pass-run-full"><Icon.validate /> Run the full check to confirm</button></div>}
            {toPin.length > 0 && <PinOffer fixed={toPin} records={records} personas={personas} project={project} onPinned={(ids) => patch((p) => ({ pinned: [...p.pinned, ...ids] }))} />}
            {s.pinned.length > 0 && <p className="hint" data-testid="bl-pass-pinned">{plural(s.pinned.length, 'test')} pinned. They are in Rules &amp; Data → Tests; undo is in the top bar.</p>}
            <div className="row wrap">
              {s.skipped.length > 0 && <button type="button" className="btn" onClick={() => patch({ skipped: [] })} data-testid="bl-pass-again">Go through the {plural(s.skipped.length, 'skipped blocker')} again</button>}
              <button type="button" className="btn primary" onClick={() => { useResolvePass.getState().patch(pid, { ...FRESH }); onClose(); }} data-testid="bl-pass-finish">Finish</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
