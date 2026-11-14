import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CUSTOMER_PLACEHOLDER, READER_FORMS, answerBaseQuestion, checkBaseQuestion, exampleQuestions, readBaseQuestion, scrubCustomers,
  type BaseAnswer, type BaseQuestion, type ReaderChoice,
} from '@iss/scenarios';
import { api } from '../api/client';
import { usePreviewDate, useScenarioEngine, useStudio } from '../state/store';
import { recordSummary } from '../shell/RecordPicker';
import { useDocumentBlockers } from '../screens/blockers/useBlockers';
import { Icon } from '../ui/icons';
import { useAiLive } from './common';
import { usePanel } from './panelStore';
import './ask.css';

/**
 * "Ask about all customers" (wave 4, item 7). A question is read into a structured question — by the built-in reader,
 * or, when it cannot and an AI key is set, by a model that is given only the document's names (customer names are taken
 * out of the sentence first) — and the ANSWER is always worked out here by the engine from every customer. The answer
 * follows the open model: change a rule and it is worked out again. Nothing is changed by asking.
 */

type Asked = { question: BaseQuestion; source: 'builtin' | 'ai'; sentence: string };
type Pending =
  | { kind: 'ask'; message: string; choices: ReaderChoice[]; source: 'builtin' | 'ai'; sentence: string }
  | { kind: 'refused' | 'unknown'; message: string; sentence: string; aiMessage?: string };

const SHOW = 10;

export function AskAllCustomers({ inPanel = true }: { inPanel?: boolean }) {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const profileId = useStudio((s) => s.ctx.profileId);
  const journeyCursor = useStudio((s) => s.ctx.journeyCursor);
  const issueDate = usePreviewDate();
  const engine = useScenarioEngine();
  const { data } = useDocumentBlockers();
  const live = useAiLive();
  const navigate = useNavigate();
  const inputId = useId();
  const [text, setText] = useState('');
  const [asked, setAsked] = useState<Asked | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const pid = project.projectId;

  const blockerList = data?.result.blockers;
  const examples = useMemo(() => { try { return exampleQuestions(project, records, { issueDate, engine: engine ?? undefined }); } catch { return []; } }, [project, records, issueDate, engine]);

  /* The answer always follows the open model, the customers, the top-bar output, step and day. */
  const needsBlockers = !!asked && (asked.question.target.kind === 'blocker' || asked.question.butNot?.kind === 'blocker');
  const answer = useMemo<BaseAnswer | null>(() => {
    if (!asked) return null;
    if (needsBlockers && !data) return null;
    // A question asked before the model changed may name something that is gone: it is checked again first.
    const ok = checkBaseQuestion(project, asked.question, { records });
    if (!ok.question) return null;
    return answerBaseQuestion(project, records, ok.question, {
      profileId, journeyCursor, issueDate, engine: engine ?? undefined,
      ...(data ? { blockers: { checked: data.result.checked, blockers: data.result.blockers } } : {}),
    });
  }, [asked, project, records, profileId, journeyCursor, issueDate, engine, data, needsBlockers]);
  const gone = !!asked && !answer && !(needsBlockers && !data);

  const run = async (sentence: string) => {
    const s = sentence.trim();
    if (!s || busy) return;
    setAll(false);
    const read = readBaseQuestion(project, s, { records, blockers: blockerList });
    if (read.status === 'understood') { setPending(null); setAsked({ question: read.question, source: 'builtin', sentence: s }); return; }
    setAsked(null);
    if (read.status === 'ask') { setPending({ kind: 'ask', message: read.message, choices: read.choices, source: 'builtin', sentence: s }); return; }
    if (read.status === 'refused' || !live) { setPending({ kind: read.status, message: read.message, sentence: s }); return; }
    // The built-in reader could not read it and an AI key is set: the model reads it, without any customer's name.
    const scrubbed = scrubCustomers(s, records.filter((r) => r.documentType === project.documentType));
    setBusy(true);
    try {
      const r = await api.assistBaseQuestion(pid, { sentence: scrubbed.text, project });
      if (r.mode !== 'ai' || !r.question) { setPending({ kind: 'unknown', message: read.message, sentence: s, aiMessage: r.message }); return; }
      let q = r.question;
      if (q.customer === CUSTOMER_PLACEHOLDER) {
        if (scrubbed.recordIds.length === 1) q = { ...q, customer: scrubbed.recordIds[0] };
        else if (scrubbed.recordIds.length > 1) {
          const choices = scrubbed.recordIds.slice(0, 8).flatMap((id) => { const rec = records.find((x) => x.recordId === id); const cq = { ...q, customer: id }; return rec ? [{ label: `${recordSummary(rec, personas).name} (${id})`, question: cq }] : []; });
          setPending({ kind: 'ask', message: 'The question names more than one customer. Which one?', choices, source: 'ai', sentence: s });
          return;
        } else { setPending({ kind: 'unknown', message: 'The AI reading asks about one customer, but no customer of this document is named in the question.', sentence: s }); return; }
      }
      const checked = checkBaseQuestion(project, q, { records });
      if (!checked.question) { setPending({ kind: 'unknown', message: checked.problems.join(' '), sentence: s }); return; }
      setPending(null);
      setAsked({ question: checked.question, source: 'ai', sentence: s });
    } catch (e) {
      setPending({ kind: 'unknown', message: read.message, sentence: s, aiMessage: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  const choose = (c: ReaderChoice, source: 'builtin' | 'ai', sentence: string) => { setPending(null); setAll(false); setAsked({ question: c.question, source, sentence }); };
  const leave = () => { if (inPanel) usePanel.getState().close(false); };
  const openLandscape = (ids: string[]) => { leave(); navigate(`/studio/${pid}/landscape?customers=${encodeURIComponent(ids.join(','))}`); };
  const openData = (ids: string[]) => { leave(); navigate(`/studio/${pid}/data?customer=${encodeURIComponent(ids[0])}&customers=${encodeURIComponent(ids.join(','))}`); };
  const openBlocker = (id: string) => { leave(); navigate(`/studio/${pid}/blockers?blocker=${encodeURIComponent(id)}`); };
  const nameOf = (id: string) => { const r = records.find((x) => x.recordId === id); return r ? recordSummary(r, personas) : { name: id, tag: null }; };

  return (
    <section className={`ask${inPanel ? ' in-panel' : ''}`} data-testid="ask-all" aria-labelledby={`${inputId}-h`}>
      <h3 id={`${inputId}-h`} className="ask-title">Ask about all customers</h3>
      <p className="ask-lead muted">The studio checks every synthetic customer of this document and answers from the engine. {live ? 'A sentence the built-in reader cannot read is read by AI, which is given only the document’s names, never a customer’s data or name.' : 'Without an AI key, use one of the forms below; free sentences need an AI key.'}</p>
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void run(text); }}>
        <label htmlFor={inputId} className="sr-only">Your question about all customers</label>
        <input id={inputId} className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Who gets …? How many get …? Who is stopped?" data-testid="ask-input" autoComplete="off" />
        <button type="submit" className="btn primary sm" disabled={!text.trim() || busy} aria-busy={busy} data-testid="ask-submit">{busy ? 'Reading…' : 'Ask'}</button>
      </form>
      {examples.length > 0 && (
        <div className="ask-examples" aria-label="Example questions">
          {examples.map((x) => <button key={x} type="button" className="ask-chip" onClick={() => { setText(x); void run(x); }} data-testid="ask-example" title="Ask this">{x}</button>)}
        </div>
      )}

      {pending?.kind === 'ask' && (
        <div className="callout ask-askback" role="status" data-testid="ask-askback">
          <p><strong>{pending.message}</strong></p>
          <div className="ask-choices">
            {pending.choices.map((c) => <button key={c.label} type="button" className="btn sm" onClick={() => choose(c, pending.source, pending.sentence)} data-testid="ask-choice">{c.label}</button>)}
          </div>
        </div>
      )}
      {pending && pending.kind !== 'ask' && (
        <div className={`callout ${pending.kind === 'refused' ? 'warning' : ''} ask-notread`} role="status" data-testid="ask-notread" data-kind={pending.kind}>
          <p>{pending.message}</p>
          {pending.aiMessage && <p className="muted" data-testid="ask-ai-message">{pending.aiMessage}</p>}
          {pending.kind === 'unknown' && <p className="muted">The built-in reader understands: {READER_FORMS.join(' · ')}{live ? '' : ' Free sentences need an AI key (none is set).'}</p>}
        </div>
      )}

      {asked && !answer && !gone && <p className="muted ask-wait" role="status"><span className="spinner" /> Checking every customer…</p>}
      {gone && <p className="callout warning" role="status" data-testid="ask-gone">The document has changed and no longer has what this question named. Ask again.</p>}

      {answer && asked && (
        <article className="ask-answer" data-testid="ask-answer" data-count={answer.count} data-total={answer.total} aria-live="polite">
          <p className="ask-understood" data-testid="ask-understood">
            <span className="ask-label">Understood as</span> {answer.understood}
            <span className={`chip ${asked.source === 'ai' ? 'info' : ''} ask-src`} data-testid="ask-read-by" data-source={asked.source} title={asked.source === 'ai' ? 'An AI model read your sentence into this question; check that it is what you meant.' : 'Read by the studio’s built-in reader; no AI model was used.'}>{asked.source === 'ai' ? 'Read by AI' : 'Read by the built-in reader'}</span>
          </p>
          {answer.why ? (
            <div className="ask-why" data-testid="ask-why" data-gets={answer.why.gets ? 'yes' : 'no'}>
              <p className="ask-headline">{answer.why.headline}</p>
              {answer.why.steps.length > 0 && <ol className="ask-steps">{answer.why.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
            </div>
          ) : (
            <>
              <p className="ask-count" data-testid="ask-count" data-n={answer.count}><strong>{answer.count} of {answer.total} synthetic customers</strong></p>
              <p className="ask-headline" data-testid="ask-headline">{answer.headline}</p>
              {answer.reasons.length > 0 && (
                <div className="ask-reasons">
                  <div className="ask-sub">Why, in words</div>
                  <ul>{answer.reasons.map((r, i) => <li key={i} data-testid="ask-reason" data-n={r.count}><span className="chip count">{r.count}</span> <span>{r.text}</span></li>)}</ul>
                </div>
              )}
              {answer.byBlocker && answer.byBlocker.length > 0 && (
                <div className="ask-blockers">
                  <div className="ask-sub">Open each in Blockers</div>
                  <ul>{answer.byBlocker.map((b) => <li key={b.id}><button type="button" className="linkbtn" onClick={() => openBlocker(b.id)} data-testid="ask-open-blocker" data-blocker={b.id}>{b.title}</button></li>)}</ul>
                </div>
              )}
            </>
          )}
          {answer.notes.length > 0 && <ul className="ask-notes muted">{answer.notes.map((n, i) => <li key={i} data-testid="ask-note">{n}</li>)}</ul>}
          {!answer.why && answer.recordIds.length > 0 && (
            <div className="ask-customers">
              <div className="ask-sub">The customers</div>
              <ul className="list-rows" data-testid="ask-customers">
                {(all ? answer.recordIds : answer.recordIds.slice(0, SHOW)).map((id) => {
                  const s = nameOf(id);
                  return (
                    <li key={id} data-testid="ask-customer" data-record={id}>
                      <button type="button" className="linkbtn ask-cust" onClick={() => useStudio.getState().setRecord(id)} title={`Make ${s.name} the customer in the top bar`}>{s.name}</button>
                      {answer.perCustomer[id] && <span className="muted ask-percust">{answer.perCustomer[id]}</span>}
                    </li>
                  );
                })}
              </ul>
              {answer.recordIds.length > SHOW && <button type="button" className="btn ghost sm" onClick={() => setAll((x) => !x)} aria-expanded={all} data-testid="ask-show-all">{all ? 'Show the first 10' : `Show all ${answer.recordIds.length}`}</button>}
            </div>
          )}
          {!answer.why && (
            <div className="row wrap ask-links">
              <button type="button" className="btn sm" onClick={() => openLandscape(answer.recordIds)} disabled={!answer.recordIds.length} data-testid="ask-open-landscape"><Icon.external width={13} height={13} /> Scenario Landscape</button>
              <button type="button" className="btn sm" onClick={() => openData(answer.recordIds)} disabled={!answer.recordIds.length} data-testid="ask-open-data"><Icon.external width={13} height={13} /> Data Explorer</button>
            </div>
          )}
          <p className="ask-foot"><span className="chip as-source" data-testid="assist-source" data-source="builtin" title="Worked out by the studio's engine from every synthetic customer. No AI model counted anything.">Answer: worked out by the studio</span></p>
        </article>
      )}
    </section>
  );
}
