import { useMemo, useState } from 'react';
import {
  AVAILABLE_LANGUAGES, SOURCE_LANGUAGE, WORDING_RULE_KIND_LABEL, WORDING_RULE_KINDS_LIST, WORDING_RULE_SCOPE_LABEL, WORDING_RULE_SCOPES_LIST, checkWordingRule,
  type Project, type WordingRule, type WordingRuleKind, type WordingRuleScope,
} from '@iss/model';
import { checkWording, wordingRuleLabel, type RuleInForce, type WordingTextScope } from '@iss/scenarios';
import { Icon } from '../../ui/icons';
import { SeverityChip } from './WordingFindings';
import './wording.css';

/**
 * Editing wording rules: the fields of one rule (only those its kind takes), a list editor for a library draft, and
 * "Try a sentence" to see which rules a sentence breaks. Whether a rule is a "must" or a "should" is set only by an admin
 * (`canSetSeverity`); for anyone else the choice is shown but locked, and a new rule starts as a "should".
 */

const PHRASE_KINDS: WordingRuleKind[] = ['banned', 'required', 'preferred'];
const KIND_HINT: Record<WordingRuleKind, string> = {
  banned: 'A word or phrase customers must not read. Matched as whole words, ignoring case.',
  required: 'A phrase that must appear, as written (ignoring case and spacing), in the kind of text chosen.',
  preferred: 'Write one form instead of another, such as “email” not “e-mail”.',
  'reading-level': 'English only. Judged on texts of twelve words or more.',
  'sentence-length': 'No sentence longer than this many words.',
  tone: 'English only. No wording that reads as a demand for money where the document is not a bill.',
};

/** Keeps only the fields a rule of its kind takes (the validator refuses the others). */
export function cleanRule(x: WordingRule): WordingRule {
  const phrase = PHRASE_KINDS.includes(x.kind);
  const limit = x.kind === 'reading-level' || x.kind === 'sentence-length';
  const englishOnly = x.kind === 'reading-level' || x.kind === 'tone';
  return {
    id: x.id, kind: x.kind, severity: x.severity,
    ...(phrase ? { phrase: x.phrase ?? '' } : {}),
    ...((x.kind === 'banned' || x.kind === 'preferred') && x.replacement !== undefined ? { replacement: x.replacement } : x.kind === 'preferred' ? { replacement: '' } : {}),
    ...(limit ? { limit: x.limit ?? (x.kind === 'reading-level' ? 8 : 25) } : {}),
    ...(x.appliesTo && x.appliesTo !== 'anywhere' ? { appliesTo: x.appliesTo } : {}),
    ...(!englishOnly && x.language && x.language !== SOURCE_LANGUAGE ? { language: x.language } : {}),
    ...(x.note ? { note: x.note } : {}),
  };
}

export function newRule(id: string, kind: WordingRuleKind = 'banned'): WordingRule {
  return cleanRule({ id, kind, severity: 'should', phrase: '' });
}

/** The fields of one rule. */
export function RuleFields({ rule, onChange, canSetSeverity, languages, idx }: { rule: WordingRule; onChange: (r: WordingRule) => void; canSetSeverity: boolean; languages?: string[]; idx: number }) {
  const set = (p: Partial<WordingRule>) => onChange(cleanRule({ ...rule, ...p }));
  const langs = languages ?? AVAILABLE_LANGUAGES.map((l) => l.code);
  const name = (n: string) => `${n} (rule ${idx + 1})`;
  return (
    <>
      <label className="field">Rule
        <select className="select" value={rule.kind} onChange={(e) => set({ kind: e.target.value as WordingRuleKind })} aria-label={name('Kind of rule')} data-testid="wr-field-kind">
          {WORDING_RULE_KINDS_LIST.map((k) => <option key={k} value={k}>{WORDING_RULE_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label className="field">Must or should
        <select className="select" value={rule.severity} disabled={!canSetSeverity} onChange={(e) => set({ severity: e.target.value as 'must' | 'should' })} aria-label={name('Must or should')} data-testid="wr-field-severity"
          title={canSetSeverity ? undefined : 'Only an admin sets whether a rule is a “must” or a “should”.'}>
          <option value="must">Must (a blocker)</option><option value="should">Should (a warning)</option>
        </select>
      </label>
      {PHRASE_KINDS.includes(rule.kind) && (
        <label className="field">{rule.kind === 'preferred' ? 'Not this' : 'Phrase'}
          <input className="input" value={rule.phrase ?? ''} maxLength={200} onChange={(e) => set({ phrase: e.target.value })} aria-label={name(rule.kind === 'preferred' ? 'Form not to use' : 'Phrase')} data-testid="wr-field-phrase" />
        </label>
      )}
      {(rule.kind === 'banned' || rule.kind === 'preferred') && (
        <label className="field">{rule.kind === 'preferred' ? 'Write instead' : 'Replacement (optional)'}
          <input className="input" value={rule.replacement ?? ''} maxLength={200} onChange={(e) => set({ replacement: e.target.value === '' && rule.kind === 'banned' ? undefined : e.target.value })} aria-label={name(rule.kind === 'preferred' ? 'Preferred form' : 'Replacement')} data-testid="wr-field-replacement" />
        </label>
      )}
      {(rule.kind === 'reading-level' || rule.kind === 'sentence-length') && (
        <label className="field">{rule.kind === 'reading-level' ? 'Grade at most' : 'Words at most'}
          <input className="input" type="number" min={rule.kind === 'reading-level' ? 1 : 5} max={rule.kind === 'reading-level' ? 18 : 100} value={rule.limit ?? ''} style={{ width: 90 }}
            onChange={(e) => set({ limit: e.target.value === '' ? undefined : Number(e.target.value) })} aria-label={name(rule.kind === 'reading-level' ? 'Grade' : 'Words')} data-testid="wr-field-limit" />
        </label>
      )}
      {rule.kind !== 'tone' && (
        <label className="field">Where
          <select className="select" value={rule.appliesTo ?? 'anywhere'} onChange={(e) => set({ appliesTo: e.target.value as WordingRuleScope })} aria-label={name('Where it applies')} data-testid="wr-field-scope">
            {WORDING_RULE_SCOPES_LIST.map((s) => <option key={s} value={s}>{WORDING_RULE_SCOPE_LABEL[s]}</option>)}
          </select>
        </label>
      )}
      {rule.kind !== 'reading-level' && rule.kind !== 'tone' && (
        <label className="field">Language
          <select className="select" value={rule.language ?? SOURCE_LANGUAGE} onChange={(e) => set({ language: e.target.value === SOURCE_LANGUAGE ? undefined : e.target.value })} aria-label={name('Language')} data-testid="wr-field-language">
            {[SOURCE_LANGUAGE, ...langs.filter((l) => l !== SOURCE_LANGUAGE)].map((l) => <option key={l} value={l}>{AVAILABLE_LANGUAGES.find((x) => x.code === l)?.name ?? l}{l === SOURCE_LANGUAGE ? ' (the source)' : ''}</option>)}
          </select>
        </label>
      )}
      <label className="field">Why (optional)
        <input className="input" value={rule.note ?? ''} maxLength={300} onChange={(e) => set({ note: e.target.value || undefined })} aria-label={name('Why the rule exists')} data-testid="wr-field-note" />
      </label>
      <p className="muted wr-problem" style={{ color: 'var(--iss-text-muted)' }}>{KIND_HINT[rule.kind]}</p>
    </>
  );
}

/** A list of rules edited in place (a library draft): add, change, remove and reorder. */
export function RuleListEditor({ rules, onChange, canSetSeverity }: { rules: WordingRule[]; onChange: (rules: WordingRule[]) => void; canSetSeverity: boolean }) {
  const freeId = (kind: WordingRuleKind) => { for (let i = 1; ; i++) { const id = `${kind}-${i}`; if (!rules.some((r) => r.id === id)) return id; } };
  const move = (i: number, d: -1 | 1) => { const next = [...rules]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); onChange(next); };
  return (
    <div className="wr-editor" data-testid="lib-edit-rules">
      {!canSetSeverity && <p className="wr-sev-locked" data-testid="wr-severity-locked">Only an admin sets whether a rule is a “must” (a blocker) or a “should” (a warning). New rules start as a “should”.</p>}
      {rules.length === 0 && <p className="muted">No rules yet.</p>}
      <ol className="wr-rules">
        {rules.map((r, i) => {
          const problem = checkWordingRule(r).problems[0];
          return (
            <li key={i} className="wr-rule-row" data-testid="wr-rule-row" data-rule={r.id}>
              <span className="wr-rule-num" aria-hidden="true">{i + 1}.</span>
              <RuleFields rule={r} idx={i} canSetSeverity={canSetSeverity} onChange={(x) => onChange(rules.map((y, j) => (j === i ? x : y)))} />
              <span className="wr-rule-move">
                <button type="button" className="btn sm ghost icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move rule ${i + 1} up`} data-testid="wr-rule-up">↑</button>
                <button type="button" className="btn sm ghost icon" onClick={() => move(i, 1)} disabled={i === rules.length - 1} aria-label={`Move rule ${i + 1} down`} data-testid="wr-rule-down">↓</button>
                <button type="button" className="btn sm ghost icon" onClick={() => onChange(rules.filter((_, j) => j !== i))} aria-label={`Remove rule ${i + 1}`} data-testid="wr-rule-remove"><Icon.trash width={14} height={14} /></button>
              </span>
              {problem && <p className="wr-problem" role="alert">{problem}</p>}
            </li>
          );
        })}
      </ol>
      <div><button type="button" className="btn sm" onClick={() => onChange([...rules, newRule(freeId('banned'))])} disabled={rules.length >= 200} data-testid="lib-edit-rules-add"><Icon.plus width={13} height={13} /> Add a rule</button></div>
      <TrySentence rules={rules.filter((r) => checkWordingRule(r).rule).map((rule) => ({ rule, origin: 'house' as const, link: null, key: `house:${rule.id}`, label: wordingRuleLabel(rule) }))} />
    </div>
  );
}

/** "Try a sentence": which of these rules a sentence breaks, worked out by the same checker as the studio. */
export function TrySentence({ rules, project }: { rules: RuleInForce[]; project?: Project }) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<WordingTextScope>('messages');
  // A rule about tone only applies to documents that are not bills: tried as an explanation of benefits unless a document is given.
  const host = (project ?? { documentType: 'eob' }) as Project;
  const result = useMemo(() => (text.trim() && rules.length ? checkWording(host, { rules, text: { text, scope, title: 'The sentence' } }) : null), [text, scope, rules, host]);
  return (
    <div className="wr-try" data-testid="wr-try">
      <div className="row wrap" style={{ gap: 6, alignItems: 'flex-end' }}>
        <label className="field grow" style={{ flex: 1, minWidth: 200 }}>Try a sentence
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a sentence to see which rules it breaks" data-testid="wr-try-input" />
        </label>
        <label className="field">As
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as WordingTextScope)} data-testid="wr-try-scope">
            {(['messages', 'disclosures', 'labels', 'email', 'sms'] as WordingTextScope[]).map((s) => <option key={s} value={s}>{WORDING_RULE_SCOPE_LABEL[s]}</option>)}
          </select>
        </label>
      </div>
      <div aria-live="polite" data-testid="wr-try-result" data-count={result?.findings.length ?? 0}>
        {!result ? <p className="muted wr-note">{rules.length ? 'Nothing typed yet.' : 'Add a rule first.'}</p>
          : result.findings.length === 0 ? <p className="wr-note" data-testid="wr-try-ok">✓ It breaks none of these rules{result.notes.length ? ' that can judge it' : ''}.</p>
            : (
              <ul className="wr-try-result">
                {result.findings.map((f) => <li key={f.id} data-testid="wr-try-finding" data-rule={f.ruleId}><SeverityChip severity={f.severity} /> {f.ruleLabel}{f.match && f.kind !== 'reading-level' ? <> — “{f.match.length > 80 ? `${f.match.slice(0, 79)}…` : f.match}”</> : f.grade !== undefined ? <> — about grade {Math.round(f.grade)}</> : null}</li>)}
              </ul>
            )}
        {result?.notes.map((n, i) => <p key={i} className="muted wr-note">{n.message.replace('“The sentence” is', 'The sentence is')}</p>)}
      </div>
    </div>
  );
}
