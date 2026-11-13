import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { projectContentDigest, projectFieldIndex, type Project } from '@iss/model';
import { formatCents, formatDate, resolve } from '@iss/resolver';
import { api } from '../api/client';
import { Biz, Proof, Tech } from '../ui/common';
import { fieldLabel, nodeTitle, predicateSentence, ruleSentence, ruleTitle } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useStudio } from '../state/store';
import '../screens/AiAssistant.css';

/**
 * The assistant conversation, shared by the AI Assistant screen and the side panel (assist/AssistPanel.tsx).
 * The conversation lives in one small store, so opening the panel shows exactly the thread the screen shows.
 */

/* ------------------------------------------------------------------- types */

type Action = { action: string; [k: string]: any };
type Reply = {
  mode: 'external' | 'offline'; providerStatus: string; requestId: string; response: string;
  understood?: boolean; suggestions?: string[];
  actions: Action[]; rejected: Array<{ action: unknown; reason: string }>;
  explanation?: { runId: string; nodeId: string; summary: string; evidence: Array<{ ruleId: string; outcome: string; condition: string; inputs: Record<string, unknown> }>; notRendered?: string };
  proposal?: Proposal;
  scenarioPreview?: { recordId: string; overrides: Record<string, unknown>; runId: string; selectedVariants: Record<string, string | null>; matchedRuleIds: string[] };
};
type Proposal = {
  proposalId: string; kind: string; targetId: string; before: unknown; after: unknown; validations: string[];
  impact: { evaluated: number; changed: number; sample: Array<{ recordId: string; before: string | null; after: string | null }> };
  command: any; provenance: string; baseModelVersion: number;
};
type ActionState = { busy?: boolean; done?: boolean; message?: string; error?: string; data?: any };
type ProposalState = { status: 'pending' | 'busy' | 'approved' | 'declined' | 'error'; error?: string; versionBefore: number; digestBefore: string; versionAfter?: number; digestAfter?: string; provenance?: string; label?: string };
type Turn =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; reply: Reply; actionStates: Record<number, ActionState>; proposal?: ProposalState }
  | { id: number; kind: 'error'; text: string; message: string };

const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const nest = (fields: Record<string, unknown>) => {
  const out: any = {};
  for (const [path, v] of Object.entries(fields)) {
    const parts = path.split('.');
    let t = out;
    parts.slice(0, -1).forEach((p) => { t = t[p] ??= {}; });
    t[parts[parts.length - 1]] = v;
  }
  return out;
};

const ACTION_TITLES: Record<string, string> = {
  select_scenario: 'Select scenario', set_scenario_fields: 'Set scenario fields', navigate_view: 'Open view', open_project: 'Open project', set_cube_axes: 'Set cube axes',
  focus_component: 'Focus component', explain_resolution: 'Explain resolution', run_validation: 'Run validation', compare_scenarios: 'Compare scenarios', generate_edge_case: 'Generate edge case',
  propose_rule_edit: 'Propose rule edit', propose_content_edit: 'Propose content edit',
};

/* ------------------------------------------------------------ shared conversation state */

type AssistStatus = { mode: 'external' | 'offline'; label: string; model?: string } | null;
interface ConvStore {
  threads: Record<string, Turn[]>;
  status: AssistStatus; statusError: string | null; statusLoaded: boolean;
  forceOffline: boolean; input: string; sending: boolean;
}
const EMPTY: Turn[] = [];
let seq = 1;
export const useConv = create<ConvStore>(() => ({ threads: {}, status: null, statusError: null, statusLoaded: false, forceOffline: false, input: '', sending: false }));
const setTurns = (pid: string, fn: (t: Turn[]) => Turn[]) => useConv.setState((s) => ({ threads: { ...s.threads, [pid]: fn(s.threads[pid] ?? EMPTY) } }));
const patchTurn = (pid: string, id: number, fn: (t: Turn) => Turn) => setTurns(pid, (ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

/** Put a prompt in the message box and focus it. */
export const pickPrompt = (text: string) => { useConv.setState({ input: text }); document.getElementById('ai-input')?.focus(); };

/** Conversation state and operations for the current project. Safe to call from several components at once. */
export function useConversation() {
  const project = useStudio((s) => s.project)!;
  const pid = project.projectId;
  const navigate = useNavigate();
  const conv = useConv();
  const turns = conv.threads[pid] ?? EMPTY;

  useEffect(() => {
    if (useConv.getState().statusLoaded) return;
    useConv.setState({ statusLoaded: true });
    api.assistantStatus().then((status) => useConv.setState({ status }), (e) => useConv.setState({ statusError: e.message, statusLoaded: false }));
  }, []);

  const lastReply = [...turns].reverse().find((t): t is Extract<Turn, { kind: 'assistant' }> => t.kind === 'assistant');
  const mode: 'external' | 'offline' | null = conv.forceOffline ? 'offline' : lastReply?.reply.mode ?? conv.status?.mode ?? null;
  const modeLabel = mode === 'external' ? 'Live AI' : mode === 'offline' ? 'Guided Assistant (offline)' : conv.statusError ? 'Assistant unavailable' : 'Checking assistant…';
  const primaryNodeId = project.nodes.find((n) => n.type === 'variant-set')?.id ?? null;
  const base = `/studio/${pid}`;
  const store = useStudio;

  const send = async (text: string) => {
    const message = text.trim();
    const cur = useConv.getState();
    if (!message || cur.sending) return;
    useConv.setState({ sending: true, input: '' });
    setTurns(pid, (ts) => [...ts, { id: seq++, kind: 'user', text: message }]);
    const s = store.getState();
    try {
      const reply: Reply = await api.assistantMessage({
        message, forceOffline: cur.forceOffline,
        context: { projectId: pid, recordId: s.ctx.recordId, overrides: s.ctx.overrides, journeyCursor: s.ctx.journeyCursor, selectedNodeId: s.ctx.selectedNodeId },
        project: s.project ?? undefined,
      });
      const proj = store.getState().project!;
      setTurns(pid, (ts) => [...ts, { id: seq++, kind: 'assistant', reply, actionStates: {}, proposal: reply.proposal ? { status: 'pending', versionBefore: proj.modelVersion, digestBefore: projectContentDigest(proj) } : undefined }]);
    } catch (e: any) {
      setTurns(pid, (ts) => [...ts, { id: seq++, kind: 'error', text: message, message: e.message ?? String(e) }]);
    } finally { useConv.setState({ sending: false }); }
  };

  /* ---- non-mutating action handlers (never touch the model) ---- */
  const applyAction = async (turn: Extract<Turn, { kind: 'assistant' }>, i: number) => {
    const a = turn.reply.actions[i];
    const setState = (st: ActionState) => patchTurn(pid, turn.id, (t) => (t.kind === 'assistant' ? { ...t, actionStates: { ...t.actionStates, [i]: st } } : t));
    const st = store.getState();
    const records = st.records;
    try {
      switch (a.action) {
        case 'select_scenario':
          st.setRecord(a.recordId); st.setOverrides(a.overrides ?? {});
          setState({ done: true, message: `Scenario ${a.recordId} selected in the top bar.` }); break;
        case 'set_scenario_fields':
          st.patchOverrides(nest(a.fields));
          setState({ done: true, message: 'Scenario overrides applied (not a model edit).' }); break;
        case 'navigate_view': {
          const node = a.nodeId ?? primaryNodeId;
          setState({ done: true, message: `Opened ${a.view}.` });
          navigate(`${base}/${a.view}${a.view === 'exploded' && node ? `/${node}` : ''}`); break;
        }
        case 'open_project':
          setState({ done: true, message: `Opening ${a.projectId}.` });
          navigate(`/studio/${a.projectId}/design`); break;
        case 'set_cube_axes':
          st.setCtx({ cubeAxes: a.axes }); setState({ done: true, message: `Cube axes ${a.axes.join(' × ')}.` }); navigate(`${base}/cube`); break;
        case 'focus_component':
          st.select(a.nodeId); setState({ done: true, message: `Selected ${a.nodeId}.` });
          navigate(`${base}/${a.view ?? 'exploded'}${(a.view ?? 'exploded') === 'exploded' ? `/${a.nodeId}` : ''}`); break;
        case 'explain_resolution':
          st.select(a.nodeId); setState({ done: true, message: `Selected ${a.nodeId}; the explanation above is the engine trace.` }); break;
        case 'run_validation':
          setState({ done: true, message: 'Opening Validate & Compare.' }); navigate(`${base}/validate`); break;
        case 'compare_scenarios': {
          const out = (a.recordIds as string[]).map((rid) => {
            const rec = records.find((r) => r.recordId === rid);
            if (!rec) return { recordId: rid, error: 'No matching fixture' };
            const r = resolve({ project: st.project!, record: rec, overrides: {}, journeyCursor: null, profileId: st.ctx.profileId });
            return { recordId: rid, selected: r.result.selectedVariants, rules: r.result.matchedRuleIds, runId: r.runId, digest: r.contentDigest };
          });
          setState({ done: true, data: { compare: out } }); break;
        }
        case 'generate_edge_case': {
          if (!turn.actionStates[i]?.data?.edge) {
            setState({ busy: true });
            const r = await api.generateEdgeCase(st.ctx.recordId, a.preset);
            setState({ data: { edge: r }, message: 'Generated inputs shown below; apply to use them as scenario overrides.' });
          } else {
            st.patchOverrides(turn.actionStates[i].data.edge.overrides);
            setState({ done: true, data: turn.actionStates[i].data, message: 'Edge-case overrides applied to the scenario (not a model edit).' });
          }
          break;
        }
      }
    } catch (e: any) { setState({ error: e.message ?? String(e) }); }
  };

  /* ---- O08 proposals ---- */
  const decide = async (turn: Extract<Turn, { kind: 'assistant' }>, approved: boolean) => {
    const prop = turn.reply.proposal!;
    const set = (p: Partial<ProposalState>) => patchTurn(pid, turn.id, (t) => (t.kind === 'assistant' && t.proposal ? { ...t, proposal: { ...t.proposal, ...p } } : t));
    const dispatch = store.getState().dispatch;
    set({ status: 'busy', error: undefined });
    const cur = store.getState().project!;
    try {
      const r = await api.decideProposal(prop.proposalId, approved, cur.modelVersion);
      if (approved) {
        if (!r.command) throw new Error('The server returned no command for an approved proposal.');
        const out = dispatch(r.command);
        if (!out.ok) { set({ status: 'error', error: out.message }); return; }
        const after = store.getState().project!;
        set({ status: 'approved', provenance: r.provenance, label: out.label, versionAfter: after.modelVersion, digestAfter: projectContentDigest(after) });
      } else {
        const after = store.getState().project!;
        set({ status: 'declined', provenance: r.provenance, versionAfter: after.modelVersion, digestAfter: projectContentDigest(after) });
      }
    } catch (e: any) { set({ status: 'error', error: e.message ?? String(e) }); }
  };

  return { project, turns, mode, modeLabel, status: conv.status, statusError: conv.statusError, forceOffline: conv.forceOffline, input: conv.input, sending: conv.sending, send, applyAction, decide };
}

/* ------------------------------------------------------------ the conversation itself */

/** Message log + composer. `compact` is the side-panel layout. All the existing assistant test ids live here. */
export function Conversation({ compact = false }: { compact?: boolean }) {
  const c = useConversation();
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: useStudio.getState().reducedMotion ? 'auto' : 'smooth' }); }, [c.turns.length, c.sending]);
  const setInput = (input: string) => useConv.setState({ input });
  const { send, turns, project, input, sending } = c;
  return (
    <div className={`ai-conv${compact ? ' compact' : ''}`}>
      <div className="ai-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
        {turns.length === 0 && (
          <div className="ai-welcome">
            <h2>Ask about this document</h2>
            <p>{compact ? 'Type a question, or pick an example below. Scenario actions are shown as cards that you apply explicitly. Rule or content edits appear as proposals that need your approval.' : 'Try a prompt from the right, or type your own. Scenario actions are shown as cards that you apply explicitly. Rule or content edits appear as proposals that need your approval.'}</p>
          </div>
        )}
        {turns.map((t) => {
          if (t.kind === 'user') return <div key={t.id} className="ai-msg user"><span className="sr-only">You said:</span>{t.text}</div>;
          if (t.kind === 'error') return (
            <div key={t.id} className="ai-msg assistant"><div className="callout error" role="alert"><strong>The assistant could not answer.</strong> {t.message}
              <div className="ai-retry"><button className="btn sm" onClick={() => send(t.text)} disabled={sending}><Icon.reset /> Retry</button><span className="muted"> Switch on &ldquo;Force offline fallback&rdquo; on the AI Assistant screen to use the guided assistant.</span></div></div></div>
          );
          return <AssistantTurn key={t.id} turn={t} project={project} onApply={(i) => c.applyAction(t, i)} onDecide={(ok) => c.decide(t, ok)} onPick={pickPrompt} />;
        })}
        {sending && <div className="ai-msg assistant"><span className="spinner" /> <span className="muted">Working…</span></div>}
      </div>
      <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <label htmlFor="ai-input" className="sr-only">Message to the assistant</label>
        <textarea id="ai-input" className="textarea" rows={2} value={input} maxLength={2000} placeholder={compact ? 'Ask a question about this document…' : 'e.g. Show me a Spanish-speaking cardholder who has missed two payments…'}
          data-testid="assistant-input" onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }} />
        <button type="submit" className="btn primary" data-testid="assistant-send" disabled={sending || !input.trim()}><Icon.chevron /> Send</button>
      </form>
      <p className="ai-compose-note muted">Sending only asks the assistant; it never applies anything. Enter sends, Shift+Enter adds a line.</p>
    </div>
  );
}


/* ---------------------------------------------------------- assistant turn */

function AssistantTurn({ turn, project, onApply, onDecide, onPick }: { turn: Extract<Turn, { kind: 'assistant' }>; project: any; onApply: (i: number) => void; onDecide: (ok: boolean) => void; onPick: (q: string) => void }) {
  const { reply } = turn;
  const nodeName = (id: string) => project.nodes.find((n: any) => n.id === id)?.name ?? id;
  const hasEngineEvidence = !!reply.explanation;
  return (
    <div className="ai-msg assistant" data-testid="assistant-reply">
      <div className="ai-msg-head">
        <span className={`chip ${reply.mode === 'external' ? 'accent' : 'warning'}`} title={reply.providerStatus}>Answered by: {reply.mode === 'external' ? 'Live AI' : 'Guided Assistant (offline)'}</span>
        {reply.mode === 'offline' && reply.understood === false && <span className="chip">Not understood</span>}
        <Proof label="Request ID"><span className="muted mono ai-req">{reply.requestId}</span></Proof>
      </div>
      <p className="ai-text">{reply.response}</p>
      {reply.suggestions && reply.suggestions.length > 0 && (
        <div className="ai-suggest" data-testid="assistant-suggestions">
          <div className="ai-ba-h">Questions the offline assistant can answer here</div>
          <div className="ai-suggest-list">{reply.suggestions.map((q) => <button key={q} type="button" className="ai-chip" onClick={() => onPick(q)} data-testid="prompt-chip">{q}</button>)}</div>
        </div>
      )}

      {reply.scenarioPreview && (
        <div className="card ai-preview" data-testid="scenario-preview">
          <div className="ai-card-h"><Icon.eye width={14} height={14} /> Engine-resolved preview <span className="muted">for <span className="mono">{reply.scenarioPreview.recordId}</span> · run <span className="mono">{reply.scenarioPreview.runId}</span></span></div>
          <div className="ai-pv-row">{Object.entries(reply.scenarioPreview.selectedVariants).map(([k, v]) => <span key={k} className="chip variant">{nodeName(k)}: <span className="mono">{fmt(v)}</span></span>)}</div>
          <div className="ai-pv-row"><span className="muted">Matched rules</span>{reply.scenarioPreview.matchedRuleIds.map((r) => <span key={r} className="chip">{r}</span>)}</div>
          {Object.keys(reply.scenarioPreview.overrides).length > 0 && <div className="ai-pv-row"><span className="muted">Overrides</span><span className="mono">{JSON.stringify(reply.scenarioPreview.overrides)}</span></div>}
        </div>
      )}

      {reply.actions.length > 0 && (
        <div className="ai-actions" aria-label="Proposed actions">
          {reply.actions.map((a, i) => {
            const st = turn.actionStates[i] ?? {};
            const mutating = a.action === 'propose_rule_edit' || a.action === 'propose_content_edit';
            const edge = st.data?.edge;
            return (
              <div className="card ai-action" key={i} data-testid={`action-${a.action}`}>
                <div className="ai-action-main">
                  <div className="ai-action-title"><span className="chip info">{ACTION_TITLES[a.action] ?? a.action}</span> {!mutating && <span className="muted">non-mutating</span>}</div>
                  <ActionSummary a={a} />
                  {edge && <div className="ai-edge"><div className="muted">{edge.description}</div><pre className="code">{JSON.stringify(edge.overrides, null, 2)}</pre><div className="muted">Seed <span className="mono">{edge.seed}</span> · scenario hash <span className="mono">{String(edge.scenarioHash).slice(0, 12)}</span></div></div>}
                  {st.data?.compare && (
                    <div className="ai-compare" data-testid="compare-result">
                      {st.data.compare.map((c: any) => (
                        <div key={c.recordId} className="card">
                          <strong className="mono">{c.recordId}</strong>
                          {c.error ? <p className="muted">{c.error}</p> : <>
                            <div className="ai-pv-row">{Object.entries(c.selected).map(([k, v]) => <span key={k} className="chip variant">{nodeName(k)}: <span className="mono">{fmt(v)}</span></span>)}</div>
                            <div className="ai-pv-row"><span className="muted">Rules</span>{(c.rules as string[]).map((r) => <span key={r} className="chip">{r}</span>)}</div>
                            <div className="muted mono ai-small">{c.runId}</div></>}
                        </div>
                      ))}
                    </div>
                  )}
                  {st.message && <div className="ai-done" role="status"><Icon.validate width={14} height={14} /> {st.message}</div>}
                  {st.error && <div className="callout error" role="alert">{st.error}</div>}
                </div>
                {!mutating ? (
                  <button className="btn primary sm" onClick={() => onApply(i)} disabled={st.busy || (st.done && a.action !== 'compare_scenarios')} data-testid="action-apply">
                    {st.done ? (a.action === 'compare_scenarios' ? 'Compared' : 'Applied') : a.action === 'generate_edge_case' ? (edge ? 'Apply to scenario' : 'Generate') : a.action === 'compare_scenarios' ? 'Compare' : 'Apply'}
                  </button>
                ) : <span className="muted ai-small">See proposal below</span>}
              </div>
            );
          })}
        </div>
      )}

      {reply.rejected.length > 0 && (
        <div className="callout warning ai-rejected" data-testid="rejected-actions">
          <strong>Rejected actions</strong>
          <ul>{reply.rejected.map((r, i) => <li key={i}><span className="mono">{fmt((r.action as any)?.action ?? 'unknown')}</span>: {r.reason}</li>)}</ul>
        </div>
      )}

      {reply.explanation && <ExplanationCard project={project} ex={reply.explanation} />}
      {!hasEngineEvidence && reply.mode === 'external' && reply.actions.length === 0 && !reply.proposal && <p className="muted ai-small">Live AI text is not engine evidence. Ask &ldquo;explain the selected variant&rdquo; for a trace-based explanation.</p>}

      {reply.proposal && <ProposalCard project={project} proposal={reply.proposal} state={turn.proposal!} currentVersion={useStudio.getState().project!.modelVersion} onDecide={onDecide} />}
    </div>
  );
}

function ActionSummary({ a }: { a: Action }) {
  switch (a.action) {
    case 'select_scenario': return <div>Record <span className="mono">{a.recordId}</span>{a.overrides && Object.keys(a.overrides).length > 0 && <> with overrides <span className="mono">{JSON.stringify(a.overrides)}</span></>}</div>;
    case 'set_scenario_fields': return <div className="ai-scroll-x"><table className="table ai-fields" aria-label="Scenario fields"><tbody>{Object.entries(a.fields).map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td><strong>{fmt(v)}</strong></td></tr>)}</tbody></table></div>;
    case 'navigate_view': return <div>View <span className="mono">{a.view}</span>{a.nodeId && <> · node <span className="mono">{a.nodeId}</span></>}</div>;
    case 'open_project': return <div>Project <span className="mono">{a.projectId}</span></div>;
    case 'set_cube_axes': return <div>Axes <span className="mono">{a.axes.join(' × ')}</span></div>;
    case 'focus_component': return <div>Node <span className="mono">{a.nodeId}</span>{a.view && <> in <span className="mono">{a.view}</span></>}</div>;
    case 'explain_resolution': return <div>Node <span className="mono">{a.nodeId}</span></div>;
    case 'run_validation': return <div>{a.checks?.length ? `Checks: ${a.checks.join(', ')}` : 'All validation suites'}</div>;
    case 'compare_scenarios': return <div>Records <span className="mono">{a.recordIds.join(' vs ')}</span></div>;
    case 'generate_edge_case': return <div>Preset <span className="mono">{a.preset}</span> (deterministic generator)</div>;
    case 'propose_rule_edit': return <div>Rule <span className="mono">{a.ruleId}</span>: <span className="mono">{JSON.stringify(a.patch)}</span></div>;
    case 'propose_content_edit': return <div>Content <span className="mono">{a.contentPartId}</span> ({a.locale})</div>;
    default: return <pre className="code">{JSON.stringify(a, null, 2)}</pre>;
  }
}

/* ------------------------------------------------------------ O08 proposal */

/** Business-language before -> after lines for a proposal, derived from the model rules and the server's command. */
function plainChange(project: any, p: Proposal): string[] {
  if (p.kind !== 'rule') return [`Wording for ${p.targetId}: “${fmt(p.before)}” → “${fmt(p.after)}”`];
  const before = project.rules.find((r: any) => r.id === p.targetId);
  const after = p.command?.rule;
  if (!before || !after) return [`Rule ${p.targetId} would change. Open the proof for the raw difference.`];
  const t0 = ruleTitle(project, before);
  const title = t0.includes('“') ? t0 : `“${t0}”`;
  const lines: string[] = [];
  if (before.priority !== after.priority) lines.push(`Priority ${before.priority} → ${after.priority} for ${title}`);
  if ((before.enabled !== false) !== (after.enabled !== false)) lines.push(`${title} would be switched ${after.enabled === false ? 'off' : 'on'}`);
  if (JSON.stringify(before.when) !== JSON.stringify(after.when)) lines.push(`Condition changes from “${ruleSentence(project, before)}” to “${ruleSentence(project, after)}”`);
  if (!lines.length) lines.push(`No visible change to ${title}`);
  lines.push(`Rule now reads: ${ruleSentence(project, after)}`);
  return lines;
}


function ProposalCard({ project, proposal: p, state, currentVersion, onDecide }: { project: any; proposal: Proposal; state: ProposalState; currentVersion: number; onDecide: (ok: boolean) => void }) {
  const decided = state.status === 'approved' || state.status === 'declined';
  const stale = !decided && currentVersion !== p.baseModelVersion;
  const rule = p.kind === 'rule';
  return (
    <div className={`card ai-proposal ${decided ? state.status : ''}`} data-testid="proposal-card" role="group" aria-label={`Proposal for ${p.targetId}`}>
      <div className="ai-card-h"><Icon.rules width={14} height={14} /> Proposal · approval required <span className="chip warning">Not applied</span> <span className="muted">{rule ? 'Rule' : 'Content'} <span className="mono">{p.targetId}</span></span></div>
      <Biz><div className="ai-plain" data-testid="proposal-plain">{plainChange(project, p).map((l, i) => <p key={i} className={i === 0 ? 'ai-plain-main' : 'ai-plain-sub'}>{l}</p>)}</div></Biz>
      <Proof label="Raw before / after (JSON)">
        <div className="ai-ba">
          <div><div className="ai-ba-h">Before</div><pre className="code" data-testid="proposal-before">{JSON.stringify(p.before, null, 2)}</pre></div>
          <div><div className="ai-ba-h">After</div><pre className="code" data-testid="proposal-after">{JSON.stringify(p.after, null, 2)}</pre></div>
        </div>
      </Proof>
      <div className="ai-prop-grid">
        <div>
          <div className="section-title">Validation</div>
          <ul className="ai-validations">{p.validations.map((v) => <li key={v}><Icon.validate width={13} height={13} /> {v}</li>)}</ul>
        </div>
        <div>
          <div className="section-title">Impact (deterministic engine)</div>
          <p className="ai-impact" data-testid="proposal-impact"><strong>{p.impact.evaluated}</strong> scenarios evaluated · <strong>{p.impact.changed}</strong> would change</p>
          {p.impact.sample.length > 0 ? (
            <div className="ai-scroll-x"><table className="table" aria-label="Impact sample"><thead><tr><th>Record</th><th>Before</th><th>After</th></tr></thead>
              <tbody>{p.impact.sample.map((s) => <tr key={s.recordId}><td className="mono">{s.recordId}</td><td className="mono">{fmt(s.before)}</td><td className="mono">{fmt(s.after)}</td></tr>)}</tbody></table></div>
          ) : <p className="muted">No evaluated scenario changes its selected variant.</p>}
        </div>
      </div>
      {!decided && <p className="muted ai-prov">Provenance: {p.provenance}</p>}
      {stale && <div className="callout warning" role="status">The model changed since this proposal was made (v{p.baseModelVersion} → v{currentVersion}). The server records the version you decide against.</div>}

      {!decided && (
        <div className="ai-decide">
          <button className="btn primary" onClick={() => onDecide(true)} disabled={state.status === 'busy'} data-testid="proposal-approve"><Icon.validate /> Approve and apply</button>
          <button className="btn" onClick={() => onDecide(false)} disabled={state.status === 'busy'} data-testid="proposal-decline">Decline</button>
          {state.status === 'busy' && <span className="spinner" aria-label="Working" />}
          <span className="muted ai-small">Approval is never automatic. One undoable command is applied only if you approve.</span>
        </div>
      )}
      {state.status === 'error' && <div className="callout error" role="alert">{state.error}</div>}
      {state.status === 'declined' && (
        <div className="callout accent ai-proof" data-testid="proposal-proof" role="status">
          <strong>Model unchanged — version v{state.versionAfter}, digest <span className="mono">{state.digestAfter?.slice(0, 12)}</span></strong>
          <div className="ai-small">Before decision: v{state.versionBefore}, <span className="mono">{state.digestBefore.slice(0, 12)}</span> · After: v{state.versionAfter}, <span className="mono">{state.digestAfter?.slice(0, 12)}</span> — {state.digestBefore === state.digestAfter ? 'identical' : 'DIFFERENT'}. {state.provenance}</div>
        </div>
      )}
      {state.status === 'approved' && (
        <div className="callout accent ai-proof" data-testid="proposal-applied" role="status">
          <strong>Applied as one undoable edit{state.label ? `: ${state.label}` : ''}.</strong>
          <div className="ai-small">Model v{state.versionBefore} → v{state.versionAfter} · digest <span className="mono">{state.digestBefore.slice(0, 12)}</span> → <span className="mono">{state.digestAfter?.slice(0, 12)}</span>. Use Undo in the top bar to revert.</div>
          <div className="ai-prov-label" data-testid="proposal-provenance">Assistant suggestion; evaluated by deterministic engine; approved by user.</div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ engine explanation */

type EngineExplanation = NonNullable<Reply['explanation']>;
const OUTCOME_WORDS: Record<string, { text: string; tone: string }> = {
  selected: { text: 'Applied · decides the message', tone: 'ok' },
  applied: { text: 'Applied', tone: 'ok' },
  required: { text: 'Always included', tone: 'ok' },
  outranked: { text: 'Matched, but a higher-priority rule won', tone: 'warning' },
  tie: { text: 'Matched, but tied with another rule', tone: 'warning' },
  'not-matched': { text: 'Did not apply', tone: '' },
  disabled: { text: 'Switched off', tone: '' },
  'out-of-scope': { text: 'Not for this output', tone: '' },
};

/**
 * Why the engine chose what it chose. Business view: one stacked block per rule, in plain words with names (it has to
 * stay readable in the narrow side panel). The rule ids, raw conditions and input paths are the proof, kept in a
 * scrollable table that Technical view shows open.
 */
function ExplanationCard({ project, ex }: { project: Project; ex: EngineExplanation }) {
  const fields = projectFieldIndex(project);
  const valueOf = (path: string, v: unknown): string => {
    const f = fields.get(path);
    if (v === null || v === undefined || v === '') return 'empty';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (f?.type === 'cents' && typeof v === 'number') return formatCents(v);
    if (f?.type === 'date' && typeof v === 'string') return formatDate(v);
    return String(v).replace(/[-_]/g, ' ');
  };
  const ruleOf = (id: string) => project.rules.find((r) => r.id === id);
  const subject = project.nodes.some((n) => n.id === ex.nodeId) ? nodeTitle(project, ex.nodeId) : 'This part';
  const names = (outcome: string) => ex.evidence.filter((e) => e.outcome === outcome).map((e) => { const r = ruleOf(e.ruleId); return `“${r ? ruleTitle(project, r) : e.ruleId}”`; });
  const decided = names('selected'), applied = names('applied'), tied = names('tie');
  const headline = ex.notRendered ? `“${subject}” is not shown for this customer.`
    : decided.length ? `“${subject}” is decided by the rule ${decided[0]}.`
    : tied.length ? `The rules ${tied.join(' and ')} tie for “${subject}”, so nothing is chosen.`
    : applied.length ? `“${subject}” is affected by the rule${applied.length === 1 ? '' : 's'} ${applied.join(', ')}.`
    : ex.evidence.length ? `None of the rules below applied to “${subject}” for this customer.`
    : `No rules are involved in “${subject}” for this customer.`;
  return (
    <div className="card ai-explain" data-testid="assistant-explanation">
      <div className="ai-card-h"><Icon.info width={14} height={14} /> Explanation</div>
      <Biz>
        <p className="ai-text" data-testid="assistant-explanation-headline">{headline}</p>
        {ex.evidence.length > 0 && (
          <ul className="ai-ev" aria-label="Rules checked">
            {ex.evidence.map((e, i) => {
              const rule = ruleOf(e.ruleId);
              const words = OUTCOME_WORDS[e.outcome] ?? { text: e.outcome, tone: '' };
              const inputs = Object.entries(e.inputs);
              return (
                <li key={i} className="ai-ev-item" data-outcome={e.outcome} data-testid="assistant-evidence">
                  <div className="ai-ev-head"><strong>{rule ? ruleTitle(project, rule) : e.ruleId}</strong><span className={`chip ${words.tone}`}>{words.text}</span></div>
                  <div className="ai-ev-line"><span className="ai-ev-k">Applies when</span><span>{rule ? predicateSentence(project, rule.when) : e.condition}</span></div>
                  {inputs.length > 0 && <div className="ai-ev-line"><span className="ai-ev-k">This customer</span><span>{inputs.map(([k, v]) => `${fieldLabel(project, k)}: ${valueOf(k, v)}`).join(' · ')}</span></div>}
                </li>
              );
            })}
          </ul>
        )}
      </Biz>
      <Proof label="Rule IDs and engine trace" testId="assistant-explanation-proof">
        <p className="ai-text ai-small">{ex.summary}</p>
        {ex.evidence.length > 0 && (
          <div className="ai-scroll-x">
            <table className="table ai-evidence-table" aria-label="Evidence">
              <thead><tr><th>Rule</th><th>Outcome</th><th>Condition</th><th>Inputs</th></tr></thead>
              <tbody>{ex.evidence.map((e, i) => (
                <tr key={i}><td className="mono">{e.ruleId}</td><td>{e.outcome}</td><td>{e.condition}</td><td className="mono ai-small">{Object.entries(e.inputs).map(([k, v]) => `${k} = ${fmt(v)}`).join(', ')}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {ex.notRendered && <p className="muted">{ex.notRendered}</p>}
      </Proof>
      <p className="muted ai-src">Source: deterministic resolver trace (worked out by the rule engine, not by AI)<Tech>, run <span className="mono">{ex.runId}</span></Tech></p>
    </div>
  );
}

