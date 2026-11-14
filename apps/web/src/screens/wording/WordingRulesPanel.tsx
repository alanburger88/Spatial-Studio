import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  WORDING_RULE_SCOPE_LABEL, languageShortName, linkOfKind, nextWordingRuleId, ownWordingRuleProblem,
  type Project, type WordingRule,
} from '@iss/model';
import { wordingFixFor, wordingRulesInForce, wordingSummary, type RuleInForce, type WordingFinding } from '@iss/scenarios';
import { applyAssistCommands } from '../../assist/common';
import { useCan, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { LibraryChip, LinkedNotice, NotLinkedActions, PickFromLibraryDialog } from '../library/LinkUI';
import { RuleFields, TrySentence, newRule } from './RuleEditor';
import { SeverityChip } from './WordingFindings';
import { useDocumentWording } from './useWording';
import './wording.css';

/**
 * The Wording rules panel of Content & Translations: the house rules this document follows (read-only, from the library,
 * linked, updated and unlinked with the library's own controls), the document's own rules (each change one undoable step),
 * and "Check wording": the findings across the document, counted by rule, each opening its list.
 */
export function WordingRulesPanel({ project }: { project: Project }) {
  const [params] = useSearchParams();
  const [open, setOpen] = useState(params.get('wording') === 'open');
  const check = useDocumentWording(project);
  const rules = useMemo(() => wordingRulesInForce(project), [project]);
  const must = check?.findings.filter((f) => f.severity === 'must').length ?? 0;
  const should = check?.findings.filter((f) => f.severity === 'should').length ?? 0;
  return (
    <details className="panel wr-panel" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="wr-panel">
      <summary data-testid="wr-panel-toggle">
        Wording rules
        <span className="chip count" data-testid="wr-rule-count">{rules.length} {rules.length === 1 ? 'rule' : 'rules'}</span>
        {rules.length > 0 && check && (must + should === 0
          ? <span className="chip accent" data-testid="wr-clean"><span aria-hidden="true">✓</span> No findings</span>
          : <>
            {must > 0 && <span className="chip error" data-testid="wr-must-count"><span aria-hidden="true">■</span> {must} must</span>}
            {should > 0 && <span className="chip warning" data-testid="wr-should-count"><span aria-hidden="true">▲</span> {should} should</span>}
          </>)}
      </summary>
      {open && (
        <div className="wr-panel-body">
          <HouseRules project={project} rules={rules.filter((r) => r.origin === 'house')} />
          <OwnRules project={project} />
          <CheckWording project={project} findings={check?.findings ?? []} notes={check?.notes.map((n) => n.message) ?? []} rules={rules} />
        </div>
      )}
    </details>
  );
}

function RuleLine({ r }: { r: RuleInForce | { rule: WordingRule; label: string } }) {
  return (
    <>
      <SeverityChip severity={r.rule.severity} />
      <span className="grow">{r.label}{r.rule.appliesTo && r.rule.appliesTo !== 'anywhere' ? <span className="muted"> · {WORDING_RULE_SCOPE_LABEL[r.rule.appliesTo]}</span> : null}{r.rule.language ? <span className="muted"> · {languageShortName(r.rule.language)}</span> : null}</span>
    </>
  );
}

function HouseRules({ project, rules }: { project: Project; rules: RuleInForce[] }) {
  const link = linkOfKind(project, 'wording-rules');
  const canEdit = useCan('edit');
  const [picking, setPicking] = useState(false);
  return (
    <section className="wr-col" aria-labelledby="wr-house-h" data-testid="wr-house">
      <h3 className="section-title" id="wr-house-h">House rules</h3>
      {link ? <LinkedNotice link={link} what="The house wording rules" /> : (
        <>
          <p className="muted">This document follows no house rules. House rules live in the shared library; an admin decides which are a “must”.</p>
          <div className="row wrap" style={{ gap: 6 }}>
            <button type="button" className="btn sm" onClick={() => setPicking(true)} disabled={!canEdit} data-testid="wr-house-from-library"><Icon.list width={13} height={13} /> Follow house rules from the library</button>
            {(project.wordingRules?.length ?? 0) > 0 && <NotLinkedActions kind="wording-rules" refId="wording-rules" defaultTitle="House wording rules" label="these wording rules" />}
          </div>
        </>
      )}
      {rules.length > 0 && (
        <ul className="wr-readonly-list" data-testid="wr-house-list" aria-label="House rules (read-only)">
          {rules.map((r) => <li key={r.key} data-testid="wr-house-rule" data-rule={r.rule.id}><RuleLine r={r} /></li>)}
        </ul>
      )}
      {picking && (
        <PickFromLibraryDialog kind="wording-rules" title="House wording rules from the library" onClose={() => setPicking(false)}
          hint="The document follows the chosen house rules. They are read-only here and receive the library’s updates after you review them. The document can still add rules of its own."
          onPick={(item, version, content) => useStudio.getState().dispatch({ type: 'LINK_LIBRARY_ITEM', item: { id: item.id, kind: 'wording-rules', title: item.title }, version, content }).ok} />
      )}
    </section>
  );
}

function OwnRules({ project }: { project: Project }) {
  const own = project.wordingRules ?? [];
  const canEdit = useCan('edit');
  const dispatch = useStudio((s) => s.dispatch);
  const [draft, setDraft] = useState<WordingRule | null>(null);
  const [editing, setEditing] = useState<{ id: string; rule: WordingRule } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = () => { setEditing(null); setError(null); setDraft(newRule(nextWordingRuleId(project, 'banned'))); };
  const run = (ok: boolean, message?: string) => { if (ok) { setError(null); return true; } setError(message ?? null); return false; };
  const add = () => {
    if (!draft) return;
    const why = ownWordingRuleProblem(project, draft);
    if (why) { setError(why); return; }
    const r = dispatch({ type: 'ADD_WORDING_RULE', rule: draft });
    if (run(r.ok, r.ok ? undefined : r.message)) setDraft(null);
  };
  const save = () => {
    if (!editing) return;
    const why = ownWordingRuleProblem(project, editing.rule, editing.id);
    if (why) { setError(why); return; }
    const r = dispatch({ type: 'UPDATE_WORDING_RULE', ruleId: editing.id, rule: editing.rule });
    if (run(r.ok, r.ok ? undefined : r.message)) setEditing(null);
  };
  return (
    <section className="wr-col" aria-labelledby="wr-own-h" data-testid="wr-own">
      <h3 className="section-title" id="wr-own-h">This document’s own rules</h3>
      <p className="muted">They add to the house rules; they cannot weaken a house “must”.</p>
      {own.length === 0 && !draft && <p className="muted" data-testid="wr-own-empty">None yet.</p>}
      <ol className="wr-rules wr-readonly-list">
        {own.map((x, i) => editing?.id === x.id ? (
          <li key={x.id} className="wr-rule-row" data-testid="wr-own-rule" data-rule={x.id} data-editing="true">
            <RuleFields rule={editing.rule} idx={i} canSetSeverity languages={project.languages} onChange={(rule) => setEditing({ id: x.id, rule })} />
            <span className="row" style={{ gap: 4 }}>
              <button type="button" className="btn sm primary" onClick={save} data-testid="wr-own-save">Save the rule</button>
              <button type="button" className="btn sm ghost" onClick={() => { setEditing(null); setError(null); }}>Cancel</button>
            </span>
          </li>
        ) : (
          <li key={x.id} data-testid="wr-own-rule" data-rule={x.id}>
            <>
              <RuleLine r={{ rule: x, label: ruleText(x) }} />
              {canEdit && (
                <span className="wr-rule-move">
                  <button type="button" className="btn sm ghost" onClick={() => { setDraft(null); setError(null); setEditing({ id: x.id, rule: x }); }} data-testid="wr-own-edit" aria-label={`Change the rule ${ruleText(x)}`}>Change</button>
                  <button type="button" className="btn sm ghost icon" onClick={() => run(dispatch({ type: 'MOVE_WORDING_RULE', ruleId: x.id, index: i - 1 }).ok)} disabled={i === 0} aria-label={`Move ${ruleText(x)} up`} data-testid="wr-own-up">↑</button>
                  <button type="button" className="btn sm ghost icon" onClick={() => run(dispatch({ type: 'MOVE_WORDING_RULE', ruleId: x.id, index: i + 1 }).ok)} disabled={i === own.length - 1} aria-label={`Move ${ruleText(x)} down`} data-testid="wr-own-down">↓</button>
                  <button type="button" className="btn sm ghost icon" onClick={() => run(dispatch({ type: 'REMOVE_WORDING_RULE', ruleId: x.id }).ok)} aria-label={`Remove ${ruleText(x)}`} data-testid="wr-own-remove"><Icon.trash width={14} height={14} /></button>
                </span>
              )}
            </>
          </li>
        ))}
      </ol>
      {draft && (
        <div className="wr-rule-row" data-testid="wr-own-new">
          <RuleFields rule={draft} idx={own.length} canSetSeverity languages={project.languages} onChange={setDraft} />
          <span className="row" style={{ gap: 4 }}>
            <button type="button" className="btn sm primary" onClick={add} data-testid="wr-own-add-save">Add the rule</button>
            <button type="button" className="btn sm ghost" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
          </span>
        </div>
      )}
      {error && <div className="callout error" role="alert" data-testid="wr-own-error">{error}</div>}
      {canEdit && !draft && <div><button type="button" className="btn sm" onClick={start} data-testid="wr-own-add"><Icon.plus width={13} height={13} /> Add a rule of this document</button></div>}
      <TrySentence rules={wordingRulesInForce(project)} project={project} />
    </section>
  );
}

const ruleText = (r: WordingRule): string => wordingRulesInForce({ wordingRules: [r] }).at(0)?.label ?? r.id;

function CheckWording({ project, findings, notes, rules }: { project: Project; findings: WordingFinding[]; notes: string[]; rules: RuleInForce[] }) {
  const [openRule, setOpenRule] = useState<string | null>(null);
  const navigate = useNavigate();
  const canEdit = useCan('edit');
  const summary = useMemo(() => wordingSummary({ rules, findings, notes: [], textsChecked: 0 }), [rules, findings]);
  const go = (f: WordingFinding) => {
    const base = `/studio/${project.projectId}`;
    if (f.locale !== 'en-US') { navigate(`${base}/content`); return; }
    if (f.textId?.startsWith('@email/') || f.textId?.startsWith('@sms/')) { navigate(`${base}/channels`); return; }
    const node = f.nodeId && project.nodes.some((n) => n.id === f.nodeId) ? f.nodeId : null;
    if (node) useStudio.getState().select(node);
    navigate(`${base}/design`);
  };
  const replace = (f: WordingFinding) => {
    const fix = wordingFixFor(project, f.id, 'text');
    if (!fix || 'reason' in fix) { useStudio.getState().toast({ kind: 'error', title: 'Not replaced', message: fix && 'reason' in fix ? fix.reason : 'There is nothing to replace.' }); return; }
    applyAssistCommands(fix.commands, fix.title, 'wording');
  };
  return (
    <section className="wr-col" aria-labelledby="wr-check-h" data-testid="wr-check">
      <h3 className="section-title" id="wr-check-h">Check wording</h3>
      {!rules.length ? <p className="muted">Add a rule, or follow the house rules, to check this document’s wording.</p> : (
        <>
          <p className="muted" data-testid="wr-check-summary">{findings.length === 0 ? 'Every text a customer reads meets the rules that can judge it.' : `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'} across the document. A “must” is a blocker; a “should” is a warning.`}</p>
          <ul className="wr-summary-list" data-testid="wr-summary">
            {summary.map(({ rule, findings: fs }) => (
              <li key={rule.key} data-testid="wr-summary-rule" data-rule={rule.rule.id} data-count={fs.length}>
                <button type="button" className="wr-summary-btn" aria-expanded={openRule === rule.key} onClick={() => setOpenRule(openRule === rule.key ? null : rule.key)} disabled={!fs.length} data-testid="wr-summary-open">
                  <RuleLine r={rule} /><span className="chip count">{fs.length}</span>
                </button>
                {openRule === rule.key && fs.length > 0 && (
                  <ul className="wr-summary-findings" data-testid="wr-summary-findings">
                    {fs.map((f) => (
                      <li key={f.id} data-testid="wr-summary-finding" data-text={f.textId ?? ''}>
                        <span className="grow">{f.textTitle ? <strong>{f.textTitle}</strong> : <strong>The whole document</strong>}{f.locale !== 'en-US' ? ` · ${languageShortName(f.locale)}` : ''}{f.match && f.kind !== 'reading-level' ? <> — “{f.match.length > 60 ? `${f.match.slice(0, 59)}…` : f.match}”</> : f.grade !== undefined ? <> — about grade {Math.round(f.grade)}</> : null}{f.kind === 'required' ? <span className="muted"> — {f.message}</span> : null}</span>
                        {f.linked ? <LibraryChip link={(project.libraryLinks ?? []).find((l) => l.linkId === f.linked!.linkId)!} /> : (
                          <>
                            {f.replacement && canEdit && <button type="button" className="btn sm" onClick={() => replace(f)} data-testid="wr-summary-replace">Replace with “{f.replacement}”</button>}
                            {f.textId && <button type="button" className="btn sm ghost" onClick={() => go(f)} data-testid="wr-summary-go">Open</button>}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {notes.map((n, i) => <p key={i} className="muted wr-note" data-testid="wr-check-note">{n}</p>)}
        </>
      )}
    </section>
  );
}
