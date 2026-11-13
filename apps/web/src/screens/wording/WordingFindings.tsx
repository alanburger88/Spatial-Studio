import { useEffect, useRef, useState } from 'react';
import { adaptCase, replaceOccurrences, type WordingFinding, type WordingTextScope } from '@iss/scenarios';
import { api } from '../../api/client';
import { NeedsAi, useBusy } from '../../assist/common';
import { GuardedSuggestion, recordAssist, useReadOnlyReason } from '../../assist/WritingHelp';
import { useStudio } from '../../state/store';
import { Tech } from '../../ui/common';
import { useTextWording } from './useWording';
import './wording.css';

/**
 * The wording rules' findings for the text being typed, shown under its field. Each says which rule, whether it is a
 * "must" (a blocker) or a "should" (a warning), and where the match is. A replacement the rule gives is applied TO THE
 * FIELD with one click; "Suggest compliant wording" asks the AI route for a rewrite the server has checked with the same
 * rules. Nothing here changes the document: the field's own save does, so undo and autosave work as usual.
 */

export interface WordingFindingsProps {
  text: string;
  scope: WordingTextScope;
  locale?: string;
  /** Puts new text into the field (a replacement, or an AI suggestion the person accepts). */
  onApply?: (next: string) => void;
  /** For editors that are not plain text (rich text): make the replacement in the editor itself. */
  onReplace?: (finding: WordingFinding, replacement: string) => void;
  /** Why the field cannot be changed (read-only, from the library); the findings are still shown. */
  blockedReason?: string | null;
  testId?: string;
}

export const MUST_LABEL = { must: 'Must', should: 'Should' } as const;

/** "■ Must" / "▲ Should": shape and word, never colour alone. */
export function SeverityChip({ severity }: { severity: 'must' | 'should' }) {
  return (
    <span className={`chip ${severity === 'must' ? 'error' : 'warning'} wr-sev`} data-testid="wording-severity" data-severity={severity} title={severity === 'must' ? 'Breaking it is a blocker: the document cannot be approved.' : 'A warning: the document can still be approved.'}>
      <span aria-hidden="true">{severity === 'must' ? '■' : '▲'}</span> {MUST_LABEL[severity]}
    </span>
  );
}

export function WordingFindings({ text, scope, locale = 'en-US', onApply, onReplace, blockedReason, testId = 'wording-findings' }: WordingFindingsProps) {
  const check = useTextWording(text, scope, locale);
  const ro = useReadOnlyReason();
  const blocked = blockedReason ?? ro;
  const [ai, setAi] = useState<{ findingId: string; original: string; reply: Awaited<ReturnType<typeof api.assistCompliant>> } | null>(null);
  const [busy, run] = useBusy();
  const seq = useRef(0);
  // A suggestion is for the text as it was asked for: typing on drops it.
  useEffect(() => { if (ai && ai.original !== text) setAi(null); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!check || (!check.findings.length && !check.notes.length)) return null;

  const replace = (f: WordingFinding) => {
    if (!f.replacement) return;
    if (onReplace) onReplace(f, f.replacement);
    else onApply?.(replaceOccurrences(text, f.occurrences, f.replacement));
  };
  const suggest = async (f: WordingFinding) => {
    const project = useStudio.getState().project;
    if (!project) return;
    const my = ++seq.current;
    const reply = await run(() => api.assistCompliant(project.projectId, { text, scope, locale, project }));
    if (reply && my === seq.current) setAi({ findingId: f.id, original: text, reply });
  };
  const canEdit = !blocked && (!!onApply || !!onReplace);
  return (
    <div className="wr-findings" data-testid={testId} data-count={check.findings.length}>
      <p className="wr-findings-head">
        <strong>Wording rules</strong>{' '}
        <span className="muted">{check.findings.length ? `${check.findings.length} ${check.findings.length === 1 ? 'thing' : 'things'} to fix in this text` : 'This text meets the rules that can judge it.'}</span>
      </p>
      <ul className="wr-list" aria-live="polite">
        {check.findings.map((f) => (
          <li key={f.id} className="wr-item" data-testid="wording-finding" data-rule={f.ruleId} data-kind={f.kind} data-severity={f.severity}>
            <div className="wr-item-head">
              <SeverityChip severity={f.severity} />
              <span className="wr-rule">{f.ruleLabel}</span>
              {f.origin === 'house' && <span className="chip wr-origin" title={f.ruleLink ? `From the library: “${f.ruleLink.title}”, version ${f.ruleLink.version}` : 'A house rule'}>House rule</span>}
            </div>
            <p className="wr-msg">{f.kind === 'reading-level' ? `Reads at about grade ${Math.round(f.grade ?? 0)}.` : f.kind === 'sentence-length' ? `${f.occurrences.length === 1 ? 'A sentence is' : `${f.occurrences.length} sentences are`} too long: “${clip(f.match ?? '')}”` : <>Found “<mark className="wr-match">{f.match}</mark>”{f.occurrences.length > 1 ? ` ${f.occurrences.length} times` : ''}.</>}
              {f.note && <span className="muted"> {f.note}</span>}
              <Tech><span className="chip code wr-pos" title="Position of the first match in the text">characters {f.start ?? 0}–{f.end ?? 0}</span></Tech>
            </p>
            {canEdit && (
              <div className="row wrap wr-actions">
                {f.replacement && <button type="button" className="btn sm primary" onClick={() => replace(f)} data-testid="wording-replace">Replace with “{adaptCase(f.match ?? '', f.replacement)}”</button>}
                <button type="button" className="btn sm ghost" onClick={() => suggest(f)} disabled={busy || !text.trim()} aria-busy={busy && ai?.findingId !== f.id} data-testid="wording-suggest">Suggest compliant wording</button>
              </div>
            )}
            {ai?.findingId === f.id && (
              <div className="wr-ai" aria-live="polite" data-testid="wording-ai">
                {ai.reply.mode === 'ai' && ai.reply.options[0] ? (
                  <GuardedSuggestion original={ai.original} suggestion={ai.reply.options[0].text} source="ai" acceptLabel="Use this wording"
                    blockedReason={ai.reply.options[0].tokenCheck.ok ? null : 'This suggestion changes the data fields in the text, so it cannot be used.'}
                    note={<span data-testid="wording-ai-note">Checked against the wording rules: it breaks no “must” rule.{ai.reply.options[0].warnings.length ? ` Still a warning: ${ai.reply.options[0].warnings.join('; ')}.` : ''} Read it before using it.</span>}
                    onAccept={() => {
                      const t = ai.reply.options[0].text;
                      if (onApply) onApply(t); else if (onReplace) onReplace({ ...f, occurrences: [{ start: 0, end: text.length, match: text }] }, t);
                      recordAssist('wording', 'Used AI wording that meets the wording rules', 'ai');
                      setAi(null);
                    }}
                    onDiscard={() => setAi(null)} />
                ) : /AI key|live AI/i.test(ai.reply.message) ? <NeedsAi message={ai.reply.message} /> : (
                  <div className="callout warning" role="status" data-testid="wording-ai-refused">{ai.reply.message}</div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {check.notes.map((n, i) => <p key={i} className="muted wr-note" data-testid="wording-note">{n.message.replace('“This text” is', 'This text is')}</p>)}
      {blocked && check.findings.length > 0 && <p className="muted wr-note" data-testid="wording-blocked">{blocked}</p>}
    </div>
  );
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
