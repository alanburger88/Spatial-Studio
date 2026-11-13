import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { ACTION_LABEL, WORKFLOW_LABEL, WORKFLOW_STATES, type WorkflowAction, type WorkflowState } from '@iss/model';
import { api, ApiFailure, type BlockingGroup, type CommentDto, type VersionDto, type WorkflowDto } from '../api/client';
import { ChangeSummaryCard, lastApprovedVersion } from '../assist/ChangeSummaryCard';
import { useIsDirty, useStudio } from '../state/store';
import { Biz, Proof, Tech } from '../ui/common';
import { nodeTitle } from '../ui/plain';
import { CommentsTab, useCommentsRev } from '../screens/design/Comments';
import { ResolveInBlockers } from '../screens/blockers/link';
import { Drawer, When, fmtAbs, useDrawers } from './History';
import './collab.css';

/* ------------------------------------------------------------------ workflow state shared by chip + panel */

interface WfStore { wf: WorkflowDto | null; loading: boolean; error: string | null; load(projectId: string, checks: boolean): Promise<WorkflowDto | null>; set(wf: WorkflowDto): void }
export const useWorkflow = create<WfStore>((set, get) => ({
  wf: null, loading: false, error: null,
  async load(projectId, checks) {
    set({ loading: true });
    try {
      const wf = await api.workflow(projectId, checks);
      // Keep readiness from a previous full load when this one skipped the checks for the same saved version.
      const prev = get().wf;
      set({ wf: !checks && prev && prev.projectId === wf.projectId && prev.modelVersion === wf.modelVersion && prev.readiness ? { ...wf, readiness: prev.readiness } : wf, loading: false, error: null });
      return wf;
    } catch (e: any) { set({ loading: false, error: e.message }); return null; }
  },
  set(wf) { set({ wf }); },
}));

const STATE_TONE: Record<WorkflowState, string> = { draft: '', in_review: 'info', changes_requested: 'warning', approved: 'accent', published: 'accent' };
const SHORT_LABEL: Record<WorkflowState, string> = { draft: 'Draft', in_review: 'Review', changes_requested: 'Changes', approved: 'Approved', published: 'Published' };
const STATE_GLYPH: Record<WorkflowState, string> = { draft: '○', in_review: '◐', changes_requested: '!', approved: '✓', published: '★' };

export function StateChip({ state, testId }: { state: WorkflowState; testId?: string }) {
  return <span className={`chip ${STATE_TONE[state]}`} data-testid={testId} data-state={state}><span aria-hidden="true">{STATE_GLYPH[state]}</span> {WORKFLOW_LABEL[state]}</span>;
}

/** Top-bar status chip; opens the Review panel. Refreshes whenever a new version is saved. */
export function WorkflowChip() {
  const project = useStudio((s) => s.project);
  const serverVersion = useStudio((s) => s.serverVersion);
  const wf = useWorkflow((s) => s.wf);
  const pid = project?.projectId;
  useEffect(() => {
    if (!pid) return;
    const before = useWorkflow.getState().wf;
    useWorkflow.getState().load(pid, false).then((next) => {
      if (!next || !before || before.projectId !== next.projectId) return;
      if (before.state !== 'draft' && next.state === 'draft' && next.history[0]?.action === 'auto_reopen') {
        useStudio.getState().toast({ kind: 'warning', title: 'Back to draft', message: `v${next.modelVersion} changed the ${WORKFLOW_LABEL[before.state].toLowerCase()} document, so it needs review again.` });
      }
    });
  }, [pid, serverVersion]);
  if (!project) return null;
  const state = wf && wf.projectId === pid ? wf.state : null;
  return (
    <button type="button" className={`chip wf-chip ${state ? STATE_TONE[state] : 'loading'}`} onClick={() => useDrawers.getState().show('review')} data-testid="workflow-status" data-state={state ?? ''}
      aria-haspopup="dialog" title={state ? `Review status: ${WORKFLOW_LABEL[state]} — open review & approval` : 'Loading review status'}>
      <span className="wf-glyph" aria-hidden="true">{state ? STATE_GLYPH[state] : '…'}</span>
      <span className="wf-full">{state ? WORKFLOW_LABEL[state] : 'Status'}</span>
      <span className="wf-short" aria-hidden="true">{state ? SHORT_LABEL[state] : 'Status'}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ review panel */

export function ReviewPanel() {
  const open = useDrawers((s) => s.open === 'review');
  return open ? <ReviewPanelInner /> : null;
}

const LOCALE_WORD: Record<string, string> = { 'en-US': 'English', 'es-US': 'Spanish' };
/** Business view: drop raw component ids and locale codes from engine messages (Technical view keeps them). */
function plainMessage(g: BlockingGroup): string {
  let m = g.message;
  if (g.nodeId) m = m.split(` (${g.nodeId})`).join('');
  for (const [code, name] of Object.entries(LOCALE_WORD)) m = m.split(` ${code} `).join(` ${name} `);
  return m;
}

const STEP_SENTENCE: Record<string, string> = { submit: 'submitted for review', request_changes: 'requested changes', approve: 'approved', publish: 'published', reopen: 'moved back to draft', auto_reopen: 'moved back to draft automatically' };

function ReviewPanelInner() {
  const navigate = useNavigate();
  const close = useDrawers((s) => s.close);
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const serverVersion = useStudio((s) => s.serverVersion);
  const session = useStudio((s) => s.session);
  const dirty = useIsDirty();
  const { wf, error } = useWorkflow();
  const commentsRev = useCommentsRev((s) => s.rev);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<WorkflowAction | null>(null);
  const [comments, setComments] = useState<CommentDto[] | null>(null);
  const [composeNode, setComposeNode] = useState<string>(() => useStudio.getState().ctx.selectedNodeId ?? project.nodes[0]?.id ?? '');
  const pid = project.projectId;

  useEffect(() => { void useWorkflow.getState().load(pid, true); }, [pid, serverVersion]);
  useEffect(() => {
    let live = true;
    api.comments(pid, { status: 'open' }).then((r) => live && setComments(r.comments)).catch(() => live && setComments([]));
    return () => { live = false; };
  }, [pid, commentsRev, serverVersion]);

  const current = wf && wf.projectId === pid ? wf : null;
  const goNode = (nodeId: string) => { useStudio.getState().select(nodeId); close(); navigate(`/studio/${pid}/design`); };
  const goValidate = (g: BlockingGroup) => {
    if (g.recordIds[0] && records.some((r) => r.recordId === g.recordIds[0])) useStudio.getState().setRecord(g.recordIds[0]);
    if (g.nodeId) useStudio.getState().select(g.nodeId);
    close(); navigate(`/studio/${pid}/validate`);
  };
  const goRules = () => { close(); navigate(`/studio/${pid}/rules-data`); };
  const title = (id: string | null) => (id ? nodeTitle(project, id) : 'nothing');

  const act = async (action: WorkflowAction) => {
    setBusy(action);
    try {
      const next = await api.workflowAction(pid, action, comment.trim() || undefined);
      useWorkflow.getState().set({ ...next, readiness: current?.readiness ?? null });
      void useWorkflow.getState().load(pid, true);
      setComment('');
      useStudio.getState().toast({ kind: 'success', title: WORKFLOW_LABEL[next.state], message: `${project.title} v${next.modelVersion} — ${STEP_SENTENCE[action]}.` });
    } catch (e: any) {
      useStudio.getState().toast({ kind: 'error', title: `${ACTION_LABEL[action]} not possible`, message: e instanceof ApiFailure ? e.message : String(e) });
      if (e instanceof ApiFailure && e.body?.error?.readiness) useWorkflow.getState().set({ ...(current as WorkflowDto), readiness: e.body.error.readiness });
    } finally { setBusy(null); }
  };

  const grouped = useMemo(() => {
    const roots = (comments ?? []).filter((c) => !c.parentId);
    const by = new Map<string, CommentDto[]>();
    for (const c of roots) by.set(c.nodeId, [...(by.get(c.nodeId) ?? []), c]);
    return [...by.entries()].map(([nodeId, list]) => ({ nodeId, list, replies: (comments ?? []).filter((c) => c.parentId && list.some((r) => r.id === c.parentId)).length }));
  }, [comments]);

  const r = current?.readiness ?? null;
  const authorRole = session?.authEnabled && session.user ? `${session.user.name} (${session.user.role})` : null;
  return (
    <Drawer title="Review & approval" sub={<>{project.title}</>} testId="review-panel" onClose={close} labelId="review-title">
      <div className="drawer-body">
        {error && !current && <div className="callout error" role="alert">Review status could not be loaded: {error}</div>}
        {!current ? <p className="muted"><span className="spinner" /> Loading review status…</p> : (
          <>
            <section className="drawer-section" aria-label="Current status">
              <div className="wf-status">
                <StateChip state={current.state} testId="review-state" />
                <span className="muted" style={{ fontSize: 12.5 }}>Saved version v{current.modelVersion}{current.updatedAt ? <> · {WORKFLOW_LABEL[current.state].toLowerCase()} {current.updatedBy ? `by ${current.updatedBy} ` : ''}<When iso={current.updatedAt} />{current.stateVersion && current.stateVersion !== current.modelVersion ? ` (at v${current.stateVersion})` : ''}</> : ''}</span>
              </div>
              <div className="wf-steps" aria-label="Workflow">
                {WORKFLOW_STATES.filter((s) => s !== 'changes_requested' || current.state === 'changes_requested').map((s, i) => <span key={s}>{i ? '→ ' : ''}<span className={s === current.state ? 'on' : ''}>{WORKFLOW_LABEL[s]}</span> </span>)}
              </div>
              {dirty && <div className="callout warning" style={{ marginTop: 10 }}>You have unsaved changes. Review and approval apply to the <strong>saved</strong> version (v{serverVersion}); save first to include your changes.</div>}
            </section>

            {current.state === 'in_review' && <ReviewSummary pid={pid} version={current.modelVersion} />}

            <section className="drawer-section" aria-labelledby="wf-act-h">
              <h3 id="wf-act-h">Next step</h3>
              <div className="wf-actions">
                {current.actions.length ? (
                  <>
                    <textarea className="textarea" style={{ minHeight: 56 }} aria-label="Note for this step" placeholder="Note for this step (required when requesting changes)" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} data-testid="workflow-comment" />
                    <div className="btns">
                      {current.actions.map((a) => {
                        const needsSave = dirty && (a.action === 'submit' || a.action === 'approve' || a.action === 'publish');
                        const disabled = !a.allowed || !!busy || needsSave || (a.action === 'request_changes' && !comment.trim());
                        const why = needsSave ? 'Save your changes first' : a.action === 'request_changes' && !comment.trim() && a.allowed ? 'Write what needs to change' : a.reason;
                        return (
                          <button key={a.action} type="button" className={`btn${a.action === 'approve' || a.action === 'publish' || a.action === 'submit' ? ' primary' : ''}`} onClick={() => act(a.action)} disabled={disabled} title={why ?? `${a.label}: document becomes ${WORKFLOW_LABEL[a.to].toLowerCase()}`} data-testid={`workflow-action-${a.action}`}>
                            {busy === a.action ? 'Working…' : a.label}
                          </button>
                        );
                      })}
                    </div>
                    {current.actions.filter((a) => !a.allowed && a.reason).map((a) => <div key={a.action} className="wf-reason"><strong>{a.label}:</strong> {a.reason}</div>)}
                  </>
                ) : <p className="muted" style={{ margin: 0 }}>No further steps — the document is {WORKFLOW_LABEL[current.state].toLowerCase()}.</p>}
                {authorRole && <div className="wf-reason">Signed in as {authorRole}.</div>}
              </div>
            </section>

            <section className="drawer-section" aria-labelledby="wf-ready-h" data-testid="review-readiness">
              <h3 id="wf-ready-h">Ready to approve? {r && <span className="count">checked v{r.modelVersion}</span>}</h3>
              {!r ? <p className="muted"><span className="spinner" /> Checking every synthetic record and test…</p> : (
                <>
                {!r.ready && <p className="wf-reason" style={{ margin: '0 0 8px' }} data-testid="readiness-summary">Approval is blocked by {r.blocking.length} blocking issue{r.blocking.length === 1 ? '' : 's'} and {r.testsFailed} failing test{r.testsFailed === 1 ? '' : 's'} in saved version v{r.modelVersion}.</p>}
                <ul className="ready-list">
                  {r.blocking.length === 0
                    ? <li className="ready-item ok"><span className="glyph" aria-hidden="true">✓</span><span>No blocking issues for any of the {r.recordsChecked} synthetic records.</span></li>
                    : r.blocking.map((g, i) => (
                      <li key={i} className="ready-item bad" data-testid="readiness-blocking">
                        <span className="glyph" aria-hidden="true">■</span>
                        <span>
                          <strong>Blocking:</strong> <Biz>{plainMessage(g)}</Biz><Tech>{g.message}</Tech>
                          <span className="muted"> {g.recordIds.length ? `Affects ${g.recordIds.length} of ${r.recordsChecked} synthetic records.` : 'Found by the rule & binding checks.'}</span>
                          <Tech><span className="tech mono" style={{ display: 'block', fontSize: 11 }}>{g.code}{g.nodeId ? ` · ${g.nodeId}` : ''}{g.locale ? ` · ${g.locale}` : ''} · {g.source}{g.recordIds.length ? ` · ${g.recordIds.slice(0, 6).join(', ')}${g.recordIds.length > 6 ? '…' : ''}` : ''}</span></Tech>
                          <span className="links">
                            <ResolveInBlockers finding={{ code: g.code, nodeId: g.nodeId ?? undefined, locale: g.locale ?? undefined, message: g.message }} onNavigate={close} />
                            <button type="button" className="linkbtn" onClick={() => goValidate(g)}>Open in Validate{g.recordIds[0] ? ` (${g.recordIds[0]})` : ''}</button>
                            {g.nodeId && project.nodes.some((n) => n.id === g.nodeId) && <button type="button" className="linkbtn" onClick={() => goNode(g.nodeId!)}>Show “{title(g.nodeId)}”</button>}
                            {g.source === 'rules-static' && <button type="button" className="linkbtn" onClick={goRules}>Open Rules &amp; Data</button>}
                          </span>
                        </span>
                      </li>
                    ))}
                  {r.testsRun === 0
                    ? <li className="ready-item"><span className="glyph" aria-hidden="true">–</span><span>No pinned tests yet. <button type="button" className="linkbtn" onClick={goRules}>Add tests in Rules &amp; Data</button></span></li>
                    : r.testsFailed === 0
                      ? <li className="ready-item ok"><span className="glyph" aria-hidden="true">✓</span><span>All {r.testsRun} test{r.testsRun === 1 ? '' : 's'} pass.</span></li>
                      : r.tests.filter((t) => !t.pass).map((t) => (
                        <li key={t.testId} className="ready-item bad" data-testid="readiness-test">
                          <span className="glyph" aria-hidden="true">✗</span>
                          <span>
                            <strong>Test “{t.name}” fails</strong> <span className="muted">({t.recordId})</span>: {t.diffs.map((d) => d.message).join('; ')}.
                            <Tech><span className="tech mono" style={{ display: 'block', fontSize: 11 }}>{t.testId} · {t.diffs.map((d) => `${d.kind}${d.nodeId ? `:${d.nodeId}` : ''} expected ${d.expected}, got ${d.got}`).join(' | ')}</span></Tech>
                            <span className="links"><button type="button" className="linkbtn" onClick={goRules}>Open Rules &amp; Data</button></span>
                          </span>
                        </li>
                      ))}
                </ul>
                </>
              )}
            </section>

            <section className="drawer-section" aria-labelledby="wf-cmt-h">
              <h3 id="wf-cmt-h">Open comments <span className="count">{comments ? `${grouped.reduce((n, g) => n + g.list.length, 0)} thread${grouped.reduce((n, g) => n + g.list.length, 0) === 1 ? '' : 's'}` : ''}</span></h3>
              {!comments ? <p className="muted"><span className="spinner" /> Loading…</p> : grouped.length === 0 ? <p className="muted" style={{ marginTop: 0 }}>No open comments.</p> : grouped.map((g) => (
                <div key={g.nodeId} className="rev-group" data-testid="review-comment-group" data-node={g.nodeId}>
                  <div className="head">
                    <button type="button" className="linkbtn" onClick={() => goNode(g.nodeId)} title="Select this component in Design Studio">{project.nodes.some((n) => n.id === g.nodeId) ? title(g.nodeId) : `${g.nodeId} (no longer in the document)`}</button>
                    <Tech><span className="mono muted" style={{ fontSize: 11 }}>{g.nodeId}</span></Tech>
                    <span className="count">{g.list.length} open{g.replies ? ` · ${g.replies} repl${g.replies === 1 ? 'y' : 'ies'}` : ''}</span>
                  </div>
                  <div className="body">
                    {g.list.map((c) => <div key={c.id} className="rev-snippet"><span className="who">{c.authorName}</span> <span className="when"><When iso={c.createdAt} /></span><div>{c.body.length > 220 ? `${c.body.slice(0, 219)}…` : c.body}</div></div>)}
                  </div>
                </div>
              ))}
              <details className="drawer-section" style={{ marginTop: 12 }}>
                <summary className="linkbtn" style={{ display: 'inline-block' }}>Comment on a component…</summary>
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <label className="field" style={{ margin: 0 }}>
                    <span className="label">Component</span>
                    <select className="select" value={composeNode} onChange={(e) => setComposeNode(e.target.value)} data-testid="review-comment-node">
                      {project.nodes.map((n) => <option key={n.id} value={n.id}>{nodeTitle(project, n.id)}{n.id !== nodeTitle(project, n.id) ? ` (${n.id})` : ''}</option>)}
                    </select>
                  </label>
                  {composeNode && <CommentsTab nodeId={composeNode} />}
                </div>
              </details>
            </section>

            <section className="drawer-section" aria-labelledby="wf-hist-h">
              <h3 id="wf-hist-h">History <span className="count">{current.history.length ? `${current.history.length} step${current.history.length === 1 ? '' : 's'}` : ''}</span></h3>
              {!current.history.length ? <p className="muted" style={{ marginTop: 0 }}>No review steps yet — the document has been a draft since it was created.</p> : (
                <ol className="wf-history" data-testid="workflow-history">
                  {current.history.map((h) => (
                    <li key={h.id}>
                      <div><strong>{h.user ?? 'Someone'}</strong> {STEP_SENTENCE[h.action] ?? h.action} <span className="muted">v{h.modelVersion}</span></div>
                      <div className="meta">{WORKFLOW_LABEL[h.from]} → {WORKFLOW_LABEL[h.to]} · <time dateTime={h.at}>{fmtAbs(h.at)}</time></div>
                      {h.comment && <div className="note">{h.comment}</div>}
                    </li>
                  ))}
                </ol>
              )}
              <div style={{ marginTop: 10 }}>
                <Proof label="Review record">
                  <dl className="kv" style={{ maxWidth: 480 }}>
                    <dt>State</dt><dd className="mono">{current.state}</dd>
                    <dt>Recorded at version</dt><dd>{current.stateVersion ?? '—'}</dd>
                    <dt>Synthetic records checked</dt><dd>{r ? r.recordsChecked : '—'}</dd>
                    <dt>Tests run</dt><dd>{r ? `${r.testsRun - r.testsFailed} of ${r.testsRun} pass` : '—'}</dd>
                  </dl>
                </Proof>
              </div>
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}

/** What changed in the saved version under review: against the last approved version, else against the version before it. Computed by the studio. */
function ReviewSummary({ pid, version }: { pid: string; version: number }) {
  const serverVersion = useStudio((s) => s.serverVersion);
  const [versions, setVersions] = useState<VersionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.versions(pid).then((r) => live && setVersions(r.versions)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [pid, serverVersion]);
  const approved = versions ? lastApprovedVersion(versions, version) : null;
  const previous = versions ? versions.filter((v) => v.modelVersion < version).sort((a, b) => b.modelVersion - a.modelVersion)[0] ?? null : null;
  const base = approved ?? previous;
  return (
    <section className="drawer-section" aria-labelledby="wf-sum-h" data-testid="review-summary">
      <h3 id="wf-sum-h">What changed</h3>
      {error ? <p className="muted">The version history could not be loaded, so there is no summary: {error}</p>
        : !versions ? <p className="muted"><span className="spinner" /> Looking up the version to compare with…</p>
          : <ChangeSummaryCard pid={pid} from={base?.modelVersion ?? null} to={version}
              fromLabel={base ? `v${base.modelVersion}${approved ? ' (last approved)' : ''}` : undefined} toLabel={`v${version} (under review)`}
              note={base && !approved ? 'No version has been approved yet, so this compares with the version saved before it.' : undefined} />}
    </section>
  );
}
