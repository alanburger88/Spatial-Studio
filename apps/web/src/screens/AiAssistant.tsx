import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectContentDigest } from '@iss/model';
import { resolve } from '@iss/resolver';
import { api } from '../api/client';
import { ScreenHeader, Biz, Proof } from '../ui/common';
import { ruleSentence, ruleTitle } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useStudio } from '../state/store';
import './AiAssistant.css';

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

/** Conversation survives navigation away (e.g. after Apply opens the Cube) within the session. */
const threads = new Map<string, Turn[]>();
let seq = 1;

const PROMPT_GROUPS: Record<string, Array<{ title: string; prompts: string[] }>> = {
  'credit-statement': [
    { title: 'Scenario', prompts: ['Choose assistance case CARD-0002', 'Show me a Spanish-speaking cardholder who has missed two payments and requests assistance', 'Show Spanish edge case', 'Compare CARD-0001 and CARD-0002'] },
    { title: 'Explain', prompts: ['Why is this message showing?', 'What rules apply?', 'Explain the selected variant'] },
    { title: 'Edit (needs approval)', prompts: ['Change R04 priority to 420', 'Disable R04'] },
    { title: 'Navigate', prompts: ['Run validation', 'Open cube', 'Export PDF', 'Switch to EOB'] },
  ],
  eob: [
    { title: 'Scenario', prompts: ['Choose case EOB-0002', 'Show me a claim that was denied pending review', 'Show claim appeal edge case', 'Compare EOB-0001 and EOB-0002'] },
    { title: 'Explain', prompts: ['Why is this message showing?', 'What rules apply?', 'Explain the selected variant'] },
    { title: 'Navigate', prompts: ['Run validation', 'Open cube', 'Export PDF', 'Switch to Aster Card'] },
  ],
};

const pick = (text: string, set: (t: string) => void) => { set(text); document.getElementById('ai-input')?.focus(); };
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

/* ------------------------------------------------------------------ screen */

export function AiAssistant() {
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const records = useStudio((s) => s.records);
  const dispatch = useStudio((s) => s.dispatch);
  const store = useStudio;
  const navigate = useNavigate();
  const pid = project.projectId;
  const base = `/studio/${pid}`;

  const [turns, setTurnsState] = useState<Turn[]>(() => threads.get(pid) ?? []);
  const setTurns = useCallback((fn: (t: Turn[]) => Turn[]) => setTurnsState((prev) => { const next = fn(prev); threads.set(pid, next); return next; }), [pid]);
  useEffect(() => { setTurnsState(threads.get(pid) ?? []); }, [pid]);
  const patchTurn = (id: number, fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

  const [status, setStatus] = useState<{ mode: 'external' | 'offline'; label: string; model?: string } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [forceOffline, setForceOffline] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { api.assistantStatus().then(setStatus).catch((e) => setStatusError(e.message)); }, []);
  const lastReply = [...turns].reverse().find((t): t is Extract<Turn, { kind: 'assistant' }> => t.kind === 'assistant');
  const mode: 'external' | 'offline' | null = forceOffline ? 'offline' : lastReply?.reply.mode ?? status?.mode ?? null;
  const modeLabel = mode === 'external' ? 'Live AI' : mode === 'offline' ? 'Guided Assistant (offline)' : statusError ? 'Assistant unavailable' : 'Checking assistant…';
  useEffect(() => { const el = logRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: store.getState().reducedMotion ? 'auto' : 'smooth' }); }, [turns.length, sending, store]);

  const primaryNodeId = project.nodes.find((n) => n.type === 'variant-set')?.id ?? null;

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setInput('');
    setTurns((ts) => [...ts, { id: seq++, kind: 'user', text: message }]);
    const s = store.getState();
    try {
      const reply: Reply = await api.assistantMessage({
        message, forceOffline,
        context: { projectId: pid, recordId: s.ctx.recordId, overrides: s.ctx.overrides, journeyCursor: s.ctx.journeyCursor, selectedNodeId: s.ctx.selectedNodeId },
        project: s.project ?? undefined,
      });
      const proj = store.getState().project!;
      setTurns((ts) => [...ts, { id: seq++, kind: 'assistant', reply, actionStates: {}, proposal: reply.proposal ? { status: 'pending', versionBefore: proj.modelVersion, digestBefore: projectContentDigest(proj) } : undefined }]);
    } catch (e: any) {
      setTurns((ts) => [...ts, { id: seq++, kind: 'error', text: message, message: e.message ?? String(e) }]);
    } finally { setSending(false); }
  };

  /* ---- non-mutating action handlers (never touch the model) ---- */
  const applyAction = async (turn: Extract<Turn, { kind: 'assistant' }>, i: number) => {
    const a = turn.reply.actions[i];
    const setState = (st: ActionState) => patchTurn(turn.id, (t) => (t.kind === 'assistant' ? { ...t, actionStates: { ...t.actionStates, [i]: st } } : t));
    const st = store.getState();
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
    const set = (p: Partial<ProposalState>) => patchTurn(turn.id, (t) => (t.kind === 'assistant' && t.proposal ? { ...t, proposal: { ...t.proposal, ...p } } : t));
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

  return (
    <section className="screen" data-testid="assistant-view">
      <ScreenHeader id="S12" title="AI Assistant" subtitle="Describe a scenario or ask why. The assistant proposes typed, validated actions; the deterministic engine does the work and nothing changes without your approval."
        badge={<span className={`chip ${mode === 'external' ? 'accent' : 'warning'} ai-badge`} data-testid="ai-mode" title={lastReply?.reply.providerStatus ?? status?.label}>{mode === 'external' ? <Icon.ai width={14} height={14} /> : <Icon.rules width={14} height={14} />} {modeLabel}</span>} />
      <div className="screen-body ai-body">
        <div className="panel ai-thread-panel">
          <div className="panel-head"><Icon.ai /> Conversation</div>
          <div className="ai-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
            {turns.length === 0 && (
              <div className="ai-welcome">
                <h2>Ask about this document</h2>
                <p>Try a prompt from the right, or type your own. Scenario actions are shown as cards that you apply explicitly. Rule or content edits appear as proposals that need your approval.</p>
              </div>
            )}
            {turns.map((t) => {
              if (t.kind === 'user') return <div key={t.id} className="ai-msg user"><span className="sr-only">You said:</span>{t.text}</div>;
              if (t.kind === 'error') return (
                <div key={t.id} className="ai-msg assistant"><div className="callout error" role="alert"><strong>The assistant could not answer.</strong> {t.message}
                  <div className="ai-retry"><button className="btn sm" onClick={() => send(t.text)} disabled={sending}><Icon.reset /> Retry</button><span className="muted"> Switch on &ldquo;Force offline fallback&rdquo; to use the guided assistant.</span></div></div></div>
              );
              return <AssistantTurn key={t.id} turn={t} project={project} onApply={(i) => applyAction(t, i)} onDecide={(ok) => decide(t, ok)} onPick={(q) => pick(q, setInput)} />;
            })}
            {sending && <div className="ai-msg assistant"><span className="spinner" /> <span className="muted">Working…</span></div>}
          </div>
          <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <label htmlFor="ai-input" className="sr-only">Message to the assistant</label>
            <textarea id="ai-input" className="textarea" rows={2} value={input} maxLength={2000} placeholder="e.g. Show me a Spanish-speaking cardholder who has missed two payments…"
              data-testid="assistant-input" onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }} />
            <button type="submit" className="btn primary" data-testid="assistant-send" disabled={sending || !input.trim()}><Icon.chevron /> Send</button>
          </form>
          <p className="ai-compose-note muted">Sending only asks the assistant; it never applies anything. Enter sends, Shift+Enter adds a line.</p>
        </div>

        <aside className="ai-side">
          <div className="panel">
            <div className="panel-head">Provider</div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Mode</dt><dd>{modeLabel}</dd>
                {status?.model && mode === 'external' && <><dt>Model</dt><dd>{status.model}</dd></>}
                <dt>Scenario</dt><dd className="mono">{ctx.recordId}</dd>
              </dl>
              {statusError && <div className="callout error" role="alert" style={{ marginTop: 8 }}>Status unavailable: {statusError}</div>}
              <div className="ai-live-how">
                <strong>{mode === 'external' ? 'Live mode is on' : 'Enable live mode'}</strong>
                {mode === 'external'
                  ? <p className="muted">Questions go to the server-side adapter; every action it returns is re-validated against the typed allowlist.</p>
                  : <p className="muted">Offline is the default and always works. For free-form questions, put <span className="mono">AI_PROVIDER=anthropic</span> and <span className="mono">AI_API_KEY=…</span> (optionally <span className="mono">AI_MODEL</span>) in a local, uncommitted <span className="mono">.env</span> or the API environment, then restart the API. The key stays on the server and never reaches the browser.</p>}
              </div>
              <label className="ai-toggle"><input type="checkbox" checked={forceOffline} onChange={(e) => setForceOffline(e.target.checked)} data-testid="force-offline" /> <span><strong>Force offline fallback</strong><br /><span className="muted">Demonstrates that the deterministic guided assistant always works, with no outbound calls.</span></span></label>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">Suggested prompts</div>
            <div className="panel-body ai-chips">
              {(PROMPT_GROUPS[project.documentType] ?? PROMPT_GROUPS.eob).map((g) => (
                <div className="ai-chip-group" key={g.title}>
                  <div className="ai-ba-h">{g.title}</div>
                  <div className="ai-chip-wrap">{g.prompts.map((p) => <button key={p} type="button" className="ai-chip" title={p} onClick={() => pick(p, setInput)} data-testid="prompt-chip">{p}</button>)}</div>
                </div>
              ))}
              <p className="hint muted">Choosing a prompt fills the box; press Send to ask.</p>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">Safety</div>
            <div className="panel-body ai-safety">
              <ul>
                <li>Only allowlisted, typed actions are accepted; anything else is rejected with a reason.</li>
                <li>Explanations come from the deterministic resolver trace, not from the language model.</li>
                <li>Rule and content changes are proposals; approving is one undoable command.</li>
                <li>No real communications are sent.</li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </section>
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

      {reply.explanation && (
        <div className="card ai-explain" data-testid="assistant-explanation">
          <div className="ai-card-h"><Icon.info width={14} height={14} /> Explanation</div>
          <p className="ai-text">{reply.explanation.summary}</p>
          {reply.explanation.evidence.length > 0 && (
            <table className="table" aria-label="Evidence">
              <thead><tr><th>Rule</th><th>Outcome</th><th>Condition</th><th>Inputs</th></tr></thead>
              <tbody>{reply.explanation.evidence.map((e, i) => (
                <tr key={i}><td className="mono">{e.ruleId}</td><td>{e.outcome}</td><td>{e.condition}</td><td className="mono ai-small">{Object.entries(e.inputs).map(([k, v]) => `${k} = ${fmt(v)}`).join(', ')}</td></tr>
              ))}</tbody>
            </table>
          )}
          {reply.explanation.notRendered && <p className="muted">{reply.explanation.notRendered}</p>}
          <p className="muted ai-src">Source: deterministic resolver trace, run <span className="mono">{reply.explanation.runId}</span></p>
        </div>
      )}
      {!hasEngineEvidence && reply.mode === 'external' && reply.actions.length === 0 && !reply.proposal && <p className="muted ai-small">Live AI text is not engine evidence. Ask &ldquo;explain the selected variant&rdquo; for a trace-based explanation.</p>}

      {reply.proposal && <ProposalCard project={project} proposal={reply.proposal} state={turn.proposal!} currentVersion={useStudio.getState().project!.modelVersion} onDecide={onDecide} />}
    </div>
  );
}

function ActionSummary({ a }: { a: Action }) {
  switch (a.action) {
    case 'select_scenario': return <div>Record <span className="mono">{a.recordId}</span>{a.overrides && Object.keys(a.overrides).length > 0 && <> with overrides <span className="mono">{JSON.stringify(a.overrides)}</span></>}</div>;
    case 'set_scenario_fields': return <table className="table ai-fields" aria-label="Scenario fields"><tbody>{Object.entries(a.fields).map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td><strong>{fmt(v)}</strong></td></tr>)}</tbody></table>;
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
            <table className="table" aria-label="Impact sample"><thead><tr><th>Record</th><th>Before</th><th>After</th></tr></thead>
              <tbody>{p.impact.sample.map((s) => <tr key={s.recordId}><td className="mono">{s.recordId}</td><td className="mono">{fmt(s.before)}</td><td className="mono">{fmt(s.after)}</td></tr>)}</tbody></table>
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
