import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import type { Command } from '@iss/model';
import type { AssistSource, FixImpact, FixProposal } from '@iss/scenarios';
import { api } from '../api/client';
import { useStudio } from '../state/store';
import { Icon } from '../ui/icons';
import './assist.css';

/**
 * Shared presentation of assistant output, used by every screen so an AI suggestion always looks and behaves the same:
 *  - it is a PROPOSAL (titled card, who produced it, how risky, what it will change),
 *  - a person applies it; it lands as ONE undoable step and is recorded in Activity as assistant-assisted,
 *  - features that need a live model say so plainly when no AI key is configured.
 */

/* ------------------------------------------------------------------ live-AI status */

type AiStatus = { mode: 'external' | 'offline'; label: string; model?: string } | null;
const useAiStatusStore = create<{ status: AiStatus; loaded: boolean; load(): void }>((set, get) => ({
  status: null, loaded: false,
  load() {
    if (get().loaded) return;
    set({ loaded: true });
    api.assistantStatus().then((status) => set({ status }), () => set({ status: null }));
  },
}));
/** Whether a live AI model is configured on the server (null while unknown). Fetched once per session. */
export function useAiLive(): boolean | null {
  const s = useAiStatusStore();
  useEffect(() => { s.load(); }, [s]);
  return s.status ? s.status.mode === 'external' : null;
}

/** Says who produced something: computed by the studio, or suggested by a model. */
export function SourceChip({ source }: { source: AssistSource | 'sample' }) {
  return source === 'ai'
    ? <span className="chip info as-source" data-testid="assist-source" data-source="ai" title="Suggested by an AI model. Read it before accepting.">AI suggestion</span>
    : source === 'sample'
      ? <span className="chip as-source" data-testid="assist-source" data-source="sample" title="Written for the demo; not reviewed.">Sample</span>
      : <span className="chip as-source" data-testid="assist-source" data-source="builtin" title="Computed by the studio from the document, its rules and the synthetic customers. No AI model was used.">Built-in</span>;
}

/** Plain state for a feature that needs a live model when none is configured, or when the model returned nothing usable. */
export function NeedsAi({ message, children }: { message?: string; children?: ReactNode }) {
  return (
    <div className="callout as-needs" role="status" data-testid="assist-needs-ai">
      <Icon.info width={14} height={14} />
      <div>
        <strong>This needs a live AI model.</strong>{' '}
        {message ?? 'No AI key is configured. Set AI_PROVIDER=anthropic and AI_API_KEY in the server’s .env to turn it on.'}
        {children && <div className="as-needs-extra">{children}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ applying proposals */

/**
 * Apply an assistant proposal as ONE undoable step and record it in Activity. Returns whether it was applied.
 * `feature` is a short area name for the activity log: 'fix', 'fix-all', 'rule', 'coverage', 'rewrite', 'glossary', …
 */
export function applyAssistCommands(commands: Command[], label: string, feature: string, source: AssistSource = 'builtin'): boolean {
  const st = useStudio.getState();
  if (!commands.length) return false;
  const res = st.dispatch(commands.length === 1 ? commands[0] : { type: 'BATCH', label, commands });
  if (!res.ok) return false; // the store already showed why
  st.toast({ kind: 'success', title: 'Applied', message: `${label}. Undo is available in the top bar.` });
  const p = useStudio.getState().project;
  if (p) void api.assistApplied({ projectId: p.projectId, feature, label, source, changes: commands.length, modelVersion: p.modelVersion });
  return true;
}

/** One-line effect of a fix, with emphasis on who is unblocked and whether anybody else is affected. */
export function ImpactLine({ impact }: { impact: FixImpact }) {
  const bad = impact.newlyBlocked.length > 0;
  return (
    <p className={`as-impact${bad ? ' bad' : impact.resolves ? ' good' : ''}`} data-testid="assist-impact" data-resolves={impact.resolves ? 'yes' : 'no'} data-unblocked={impact.unblocked.length} data-newly-blocked={impact.newlyBlocked.length}>
      {impact.summary}
    </p>
  );
}

/**
 * A fix (or any change proposal) as a card: what it does, why, who produced it, how risky, its effect, and the action.
 * `onOpen` handles proposals a person must carry out elsewhere (kind 'link').
 */
export function ProposalCard({ proposal, impact, applied, busy, onApply, onOpen, children }: { proposal: FixProposal; impact?: FixImpact | null; applied?: boolean; busy?: boolean; onApply?: () => void; onOpen?: () => void; children?: ReactNode }) {
  return (
    <div className={`as-card${applied ? ' applied' : ''}`} data-testid="assist-proposal" data-kind={proposal.kind} data-risk={proposal.risk} data-proposal-id={proposal.id}>
      <div className="as-card-head">
        <strong>{proposal.title}</strong>
        <SourceChip source={proposal.source} />
        {proposal.kind === 'change' && (proposal.risk === 'safe'
          ? <span className="chip ok" title="Cannot change what any currently unaffected customer receives, and is easy to undo.">Low risk</span>
          : <span className="chip warning" title={proposal.riskReason ?? 'Changes what some customers receive. Read the effect before applying.'}>Review first</span>)}
      </div>
      <p className="as-card-text">{proposal.explanation}</p>
      {proposal.kind === 'change' && proposal.risk === 'review' && proposal.riskReason && <p className="as-card-risk">{proposal.riskReason}</p>}
      {impact && <ImpactLine impact={impact} />}
      {children}
      <div className="row wrap as-card-actions">
        {proposal.kind === 'change' && onApply && (applied
          ? <span className="chip ok" data-testid="assist-applied">Applied · undo in the top bar</span>
          : <button type="button" className="btn primary sm" onClick={onApply} disabled={busy || (impact ? impact.newlyBlocked.length > 0 : false)} data-testid="assist-apply">Apply this fix</button>)}
        {proposal.kind === 'link' && onOpen && <button type="button" className="btn sm" onClick={onOpen} data-testid="assist-open"><Icon.external width={13} height={13} /> {proposal.link?.label ?? 'Open'}</button>}
        {proposal.kind === 'scenario' && <span className="muted">Nothing to change in the document.</span>}
        {impact && impact.newlyBlocked.length > 0 && <span className="as-card-risk">Not offered: it would block {impact.newlyBlocked.length} other customer{impact.newlyBlocked.length === 1 ? '' : 's'}.</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ writing suggestions */

/**
 * A wording suggestion beside the original. The person accepts it into the field (where they can still edit it),
 * or discards it. Nothing is written until they accept.
 */
export function SuggestionCompare({ original, suggestion, source, note, onAccept, onDiscard, acceptLabel = 'Use this', blockedReason }: { original: string; suggestion: string; source: AssistSource | 'sample'; note?: ReactNode; onAccept: () => void; onDiscard?: () => void; acceptLabel?: string; /** When set, the suggestion can be read but not used, and this says why (read-only role, changed data fields). */ blockedReason?: string | null }) {
  return (
    <div className="as-compare" data-testid="assist-suggestion">
      <div className="as-compare-col"><span className="as-compare-lbl">Now</span><p>{original || <span className="muted">Empty</span>}</p></div>
      <div className="as-compare-col new"><span className="as-compare-lbl">Suggestion <SourceChip source={source} /></span><p data-testid="assist-suggestion-text">{suggestion}</p></div>
      {note && <div className="as-compare-note">{note}</div>}
      <div className="row wrap as-card-actions">
        <button type="button" className="btn primary sm" onClick={onAccept} disabled={!!blockedReason} title={blockedReason ?? undefined} data-testid="assist-accept">{acceptLabel}</button>
        {onDiscard && <button type="button" className="btn ghost sm" onClick={onDiscard} data-testid="assist-discard">Discard</button>}
      </div>
    </div>
  );
}

/** Small inline busy/done state for an assistant action button. */
export function useBusy(): [boolean, <T>(job: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(job: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try { return await job(); } catch (e) { useStudio.getState().toast({ kind: 'error', title: 'The assistant could not finish', message: e instanceof Error ? e.message : String(e) }); return undefined; } finally { setBusy(false); }
  };
  return [busy, run];
}
