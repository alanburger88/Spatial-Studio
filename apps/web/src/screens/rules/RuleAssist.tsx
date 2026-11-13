import { useEffect, useMemo, useRef, useState } from 'react';
import { applyCommand, projectFieldIndex, type Project, type Rule } from '@iss/model';
import { fixImpact, reviewRules, type FixImpact, type RuleObservation } from '@iss/scenarios';
import { api } from '../../api/client';
import { applyAssistCommands, NeedsAi, ProposalCard, SourceChip, useBusy } from '../../assist/common';
import { Dialog, Loading, Tech } from '../../ui/common';
import { ImpactPreview } from '../../ui/ImpactPreview';
import { ruleTitle } from '../../ui/plain';
import { editBlockedReason, useStudio } from '../../state/store';
import './RuleAssist.css';

type DescribeReply = Awaited<ReturnType<typeof api.assistRuleDraft>>;

/** Example sentences built from this document's own field labels and message names (never invented fields). */
function examplesFor(project: Project): string[] {
  const idx = [...projectFieldIndex(project).values()].filter((f) => !f.derived && f.type !== 'array');
  const money = idx.find((f) => f.type === 'cents' && /balance/i.test(f.label)) ?? idx.find((f) => f.type === 'cents');
  const count = idx.find((f) => f.type === 'int' && !/page|count of pages/i.test(f.label));
  const flag = idx.find((f) => f.type === 'bool' && !/accessib|large|contrast/i.test(f.path));
  const set = project.nodes.find((n) => n.type === 'variant-set' && (n.variantIds?.length ?? 0) > 0);
  const partName = (id?: string) => project.contentParts.find((c) => c.id === id)?.title;
  const msg = partName(set?.variantIds?.[0]) ?? 'the reminder';
  const out: string[] = [];
  if (money) out.push(`When ${money.label.toLowerCase()} is over $500, show ${msg.toLowerCase()}`);
  if (count && flag) out.push(`If ${count.label.toLowerCase()} is at least 2 and ${flag.label.toLowerCase()} is no, show ${msg.toLowerCase()}`);
  else if (flag) out.push(`If ${flag.label.toLowerCase()} is yes, show ${msg.toLowerCase()}`);
  return out.slice(0, 3);
}

const MAX = 600;

/* ================================================================== Describe the rule */

export function DescribeRuleDialog({ project, blockedReason, onClose, onOpenDraft }: { project: Project; blockedReason: string | null; onClose: () => void; onOpenDraft: (rule: Rule) => void }) {
  const [sentence, setSentence] = useState('');
  const [reply, setReply] = useState<DescribeReply | null>(null);
  const [busy, run] = useBusy();
  const examples = useMemo(() => examplesFor(project), [project]);
  const submit = async () => {
    const text = sentence.trim();
    if (!text) return;
    setReply(null);
    // Always the current, possibly unsaved project from the store.
    const current = useStudio.getState().project ?? project;
    const r = await run(() => api.assistRuleDraft(current.projectId, { sentence: text, project: current }));
    if (r) setReply(r);
  };
  const rule = reply?.draft.rule ?? null;
  const after = useMemo(() => {
    if (!rule) return null;
    const r = applyCommand(project, { type: 'UPSERT_RULE', rule });
    return r.ok ? r.project : null;
  }, [rule, project]);
  const needsAi = !!reply && !rule && /\b(AI|model|key)\b/i.test(reply.message);
  return (
    <Dialog title="Describe a rule" onClose={onClose} labelledBy="rule-describe-title">
      <div className="ra-wide ra-describe" data-testid="rule-describe">
        <div className="field">
          <label htmlFor="rule-describe-text">Write the rule as a sentence</label>
          <textarea id="rule-describe-text" className="textarea" rows={3} maxLength={MAX} value={sentence} data-testid="rule-describe-input"
            placeholder={examples[0] ?? 'When the new balance is over $500, show the payment reminder'}
            onChange={(e) => setSentence(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit(); }} />
          <span className="hint ra-count">{sentence.length} / {MAX}. The assistant drafts a rule for you to check; nothing is saved until you save it.</span>
        </div>
        {examples.length > 0 && (
          <div className="ra-examples" role="group" aria-label="Example sentences">
            <span className="muted">Try:</span>
            {examples.map((ex) => <button key={ex} type="button" className="chip ra-chipbtn" onClick={() => setSentence(ex)}>{ex}</button>)}
          </div>
        )}
        <div className="row ra-submitrow">
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !sentence.trim()} data-testid="rule-describe-submit">Draft this rule</button>
          {busy && <Loading label="Reading your sentence…" />}
        </div>

        {reply && (
          <div className="ra-result" data-testid="rule-describe-result" data-mode={reply.mode} data-has-rule={rule ? 'true' : 'false'} aria-live="polite">
            {rule ? (
              <>
                <div className="ra-read">
                  <div className="ra-read-head"><strong>I read this as</strong> <SourceChip source={reply.draft.source} /></div>
                  <p className="ra-restate" data-testid="rule-describe-restatement">{reply.draft.restatement}</p>
                  {reply.mode === 'ai' && <p className="ra-aiwarn">Checked against this document’s fields and components; read it before saving.</p>}
                </div>
                {reply.draft.uncertain.length > 0 && (
                  <div className="callout warning ra-uncertain" data-testid="rule-describe-uncertain">
                    <strong>Check these points</strong>
                    <ul>{reply.draft.uncertain.map((u, i) => <li key={i}>{u}</li>)}</ul>
                  </div>
                )}
                {after && <div className="ra-impact"><ImpactPreview before={project} after={after} /></div>}
                <div className="row wrap ra-actions">
                  <button type="button" className="btn primary" disabled={!!blockedReason} title={blockedReason ?? 'Loads the rule into the editor as a new unsaved draft'}
                    onClick={() => onOpenDraft(rule)} data-testid="rule-describe-open">Open in the rule editor</button>
                  <span className="muted">{blockedReason ? `${blockedReason}, so a draft cannot be opened for saving.` : 'It opens as an unsaved draft. You can change it and see the impact before you save.'}</span>
                </div>
              </>
            ) : (
              <>
                {needsAi
                  ? <NeedsAi message={reply.message}><span>What works without an AI key: a plain sentence such as “{examples[0] ?? 'When the new balance is over $500, show the payment reminder'}”.</span></NeedsAi>
                  : <div className="callout warning" role="status"><strong>I could not turn that into a rule.</strong> {reply.message}</div>}
                {reply.draft.uncertain.length > 0 && (
                  <div className="ra-reasons" data-testid="rule-describe-reasons">
                    <strong>What was unclear</strong>
                    <ul>{reply.draft.uncertain.map((u, i) => <li key={i}>{u}</li>)}</ul>
                  </div>
                )}
                {!needsAi && examples[0] && <p className="hint">Your text is kept above so you can rephrase it. A sentence like “{examples[0]}” works.</p>}
              </>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ================================================================== Review my rules */

const SEV_ORDER: Array<RuleObservation['severity']> = ['blocking', 'warning', 'info'];
const SEV_TITLE: Record<RuleObservation['severity'], string> = { blocking: 'Needs fixing', warning: 'Worth a look', info: 'For information' };
const KIND_WORD: Record<RuleObservation['kind'], string> = { tie: 'Tie', overlap: 'Overlap', unreachable: 'Not reached', 'no-fallback': 'No fallback', shadowed: 'Shadowed', gap: 'Gap', disabled: 'Switched off' };

export function ReviewRulesDialog({ project, onClose, onSelectRule }: { project: Project; onClose: () => void; onSelectRule: (id: string) => boolean }) {
  const records = useStudio((s) => s.records);
  const blocked = useStudio((s) => editBlockedReason(s.session));
  const [items, setItems] = useState<RuleObservation[] | null>(null);
  const [impacts, setImpacts] = useState<Map<string, FixImpact>>(new Map());
  const [justApplied, setJustApplied] = useState<string | null>(null);
  const seq = useRef(0);

  // Run after first paint, and again whenever the model changes (an applied fix, an undo).
  useEffect(() => {
    const my = ++seq.current;
    setItems(null);
    const h = setTimeout(() => {
      if (my !== seq.current) return;
      const obs = reviewRules(project, records);
      const imp = new Map<string, FixImpact>();
      for (const o of obs) if (o.proposal?.kind === 'change') { try { imp.set(o.proposal.id, fixImpact(project, o.proposal, records)); } catch { /* no impact line */ } }
      if (my === seq.current) { setImpacts(imp); setItems(obs); }
    }, 30);
    return () => clearTimeout(h);
  }, [project, records]);

  const counts = useMemo(() => ({ blocking: items?.filter((o) => o.severity === 'blocking').length ?? 0, warning: items?.filter((o) => o.severity === 'warning').length ?? 0, info: items?.filter((o) => o.severity === 'info').length ?? 0 }), [items]);
  const apply = (o: RuleObservation) => {
    const p = o.proposal;
    if (!p?.commands) return;
    if (applyAssistCommands(p.commands, p.title, 'rule-review', p.source)) setJustApplied(p.title);
  };
  const pick = (id: string) => { if (onSelectRule(id)) onClose(); };

  return (
    <Dialog title={<>Review my rules <SourceChip source="builtin" /></>} onClose={onClose} labelledBy="rules-review-title">
      <div className="ra-wide ra-review" data-testid="rules-review-panel">
        {!items ? <Loading label="Reviewing rules against the synthetic customers…" /> : (
          <>
            <p className="ra-summary" data-testid="rules-review-summary" data-blocking={counts.blocking} data-warning={counts.warning} data-info={counts.info}>
              {counts.blocking + counts.warning === 0
                ? `No ties, shadowed rules or missing fallbacks found; ${counts.info} informational note${counts.info === 1 ? '' : 's'}.`
                : `${counts.blocking} to fix, ${counts.warning} worth a look, ${counts.info} for information.`}
              <span className="muted"> Checked against {records.length} synthetic customers.</span>
            </p>
            {justApplied && <p className="callout accent ra-applied" role="status">Applied “{justApplied}”. The review has been re-run. Undo is in the top bar.</p>}
            {blocked && <p className="hint">{blocked}, so fixes can be read but not applied.</p>}
            {SEV_ORDER.map((sev) => {
              const group = items.filter((o) => o.severity === sev);
              if (!group.length) return null;
              return (
                <section key={sev} className="ra-group" aria-label={SEV_TITLE[sev]}>
                  <h3 className="section-title">{SEV_TITLE[sev]} <span className="chip count">{group.length}</span></h3>
                  <ul className="list-rows ra-list">
                    {group.map((o) => (
                      <li key={o.id} className="ra-item" data-testid="rules-review-item" data-kind={o.kind} data-severity={o.severity}>
                        <div className="ra-item-head">
                          <span className={`chip ${o.severity === 'blocking' ? 'error' : o.severity === 'warning' ? 'warning' : ''}`}>{o.severity === 'blocking' ? 'Blocking · ' : ''}{KIND_WORD[o.kind]}</span>
                          <strong>{o.title}</strong>
                        </div>
                        <p className="ra-item-detail">{o.detail}</p>
                        {o.ruleIds.length > 0 && (
                          <div className="row wrap ra-rules"><span className="muted">Rules involved:</span>
                            {o.ruleIds.map((id) => {
                              const r = project.rules.find((x) => x.id === id);
                              return <button key={id} type="button" className="chip ra-chipbtn" onClick={() => pick(id)} data-testid={`rules-review-rule-${id}`} title="Select this rule in the tree">{r ? ruleTitle(project, r) : id}<Tech> · {id}</Tech></button>;
                            })}
                          </div>
                        )}
                        {o.proposal && (
                          <ProposalCard proposal={o.proposal} impact={impacts.get(o.proposal.id) ?? null} busy={!!blocked} onApply={() => apply(o)}
                            onOpen={() => { if (o.proposal?.link?.ruleId) pick(o.proposal.link.ruleId); }} />
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {items.length === 0 && <p className="muted">Nothing to report.</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}
