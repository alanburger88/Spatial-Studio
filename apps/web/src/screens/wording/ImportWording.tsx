import { useMemo, useRef, useState } from 'react';
import './ImportWording.css';
import { AVAILABLE_LANGUAGES, SOURCE_LANGUAGE, languageName } from '@iss/model';
import { WORDING_FILE_LABEL, messageSections, planWordingImport, readWordingFile, type ColumnRole, type RowDecision, type WordingColumn, type WordingTable } from '@iss/scenarios';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';

const ROLE_LABEL: Record<ColumnRole, string> = { id: 'Text id', english: 'English text', title: 'Title (for new messages)', language: 'A translation', ignore: 'Not imported' };
type View = 'changes' | 'skipped' | 'unmatched' | 'problems' | 'all';
const SHOW_MAX = 400;

/**
 * "Import wording…" (wave 3, section 4) on Content & Translations. Reads the studio's own XLIFF and CSV files or a plain
 * spreadsheet, lets the person confirm what each column is, and shows exactly what would change (the dry run) before
 * anything changes. Applying is one undoable step. Imported translations are drafts marked "imported"; nothing is
 * approved; linked library wording, protected disclosures and approved translations are listed as skipped, with why.
 */
export function ImportWording({ onClose, onApplied }: { onClose: () => void; onApplied?: (summary: string) => void }) {
  const project = useStudio((s) => s.project)!;
  const [table, setTable] = useState<WordingTable | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [columns, setColumns] = useState<WordingColumn[]>([]);
  const [decisions, setDecisions] = useState<Record<number, RowDecision>>({});
  const [applyEnglish, setApplyEnglish] = useState(true);
  const [draftOverApproved, setDraftOverApproved] = useState(false);
  const [view, setView] = useState<View>('changes');
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const sections = useMemo(() => messageSections(project), [project]);

  const load = (text: string, name: string | null) => {
    const t = readWordingFile(text, project);
    setTable(t); setColumns(t.columns); setDecisions({}); setFileName(name); setError(null); setView('changes');
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { setError('The file is larger than 5 MB.'); return; }
    load(await f.text(), f.name);
    if (fileRef.current) fileRef.current.value = '';
  };
  const plan = useMemo(() => (table ? planWordingImport(project, table, { columns, decisions, applyEnglish, draftOverApproved }) : null), [project, table, columns, decisions, applyEnglish, draftOverApproved]);
  const setColumn = (i: number, patch: Partial<WordingColumn>) => setColumns((cs) => cs.map((c) => (c.index === i ? { ...c, ...patch, ...(patch.role && patch.role !== 'language' ? { locale: undefined } : {}), ...(patch.role === 'language' && !c.locale ? { locale: 'es-US' } : {}) } : c)));

  const apply = () => {
    if (!plan?.command) return;
    const r = useStudio.getState().dispatch(plan.command);
    if (!r.ok) { setError(r.message); return; }
    useStudio.getState().toast({ kind: 'success', title: 'Wording imported', message: `${plan.label.replace(/^Import wording: /, '')}. Imported translations are drafts: review and approve them. Undo takes the whole import back.` });
    onApplied?.(plan.label);
    onClose();
  };

  const rows = plan?.rows ?? [];
  const visible = rows.filter((r) => view === 'all' ? true : view === 'changes' ? r.changes.length > 0 : view === 'skipped' ? r.skipped.length > 0 && r.decision !== 'unmatched' : view === 'unmatched' ? r.decision === 'unmatched' || r.match?.how === 'guess' || !!decisions[r.index] : r.problems.length > 0);
  const c = plan?.counts;
  return (
    <Dialog title="Import wording" onClose={onClose} labelledBy="wi-title"
      footer={<>
        {plan && <span className="muted wi-foot" data-testid="wi-foot">{plan.blocking[0] ?? (plan.command ? 'Nothing has changed yet. Importing is one step that Undo takes back.' : 'There is nothing to change.')}</span>}
        <button type="button" className="btn" onClick={onClose} data-testid="wi-cancel">Cancel</button>
        <button type="button" className="btn primary" onClick={apply} disabled={!plan?.command} data-testid="wi-apply">Import</button>
      </>}>
      <div className="wi" data-testid="wi-dialog">
        <p className="muted">A wording table: the studio’s own export from this screen or from a release package (CSV or XLIFF), or a spreadsheet with an id or English column and a column per language. Rows are matched to this document’s texts by id, then by their English. Imported translations are drafts until a person approves them.</p>
        <div className="row wi-pick">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="wi-choose">Choose a file…</button>
          <input ref={fileRef} type="file" hidden accept=".csv,.xlf,.xliff,.xml,text/csv,application/xliff+xml,text/xml,text/plain" onChange={(e) => onFile(e.target.files?.[0])} data-testid="wi-file" aria-label="Choose a wording file" />
          {fileName && <span className="muted">{fileName}</span>}
          {table && <span className="chip info" data-testid="wi-kind" data-kind={table.kind}>{WORDING_FILE_LABEL[table.kind]}</span>}
        </div>
        <details className="wi-paste">
          <summary>Or paste a table</summary>
          <textarea className="textarea" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Wording table as CSV" data-testid="wi-text" placeholder={'id,English,Spanish\npayment-reminder,Your payment is due,Su pago vence'} />
          <button type="button" className="btn sm" disabled={!paste.trim()} onClick={() => load(paste, null)} data-testid="wi-read-paste">Read it</button>
        </details>
        {error && <p className="callout error" role="alert" data-testid="wi-error">{error}</p>}
        {table && table.problems.length > 0 && <ul className="callout warning wi-problems" data-testid="wi-file-problems">{table.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}

        {table && columns.length > 0 && (
          <fieldset className="wi-cols" data-testid="wi-columns">
            <legend>What each column is</legend>
            {columns.map((col) => (
              <div key={col.index} className="wi-col" data-testid="wi-col" data-role={col.role} data-locale={col.locale ?? ''}>
                <span className="wi-colname" title={col.why}>“{col.heading || `Column ${col.index + 1}`}”</span>
                <select className="select" value={col.role} onChange={(e) => setColumn(col.index, { role: e.target.value as ColumnRole })} aria-label={`What column “${col.heading}” is`} data-testid={`wi-col-role-${col.index}`} disabled={table.kind === 'xliff'}>
                  {(Object.keys(ROLE_LABEL) as ColumnRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                {col.role === 'language' && (
                  <select className="select" value={col.locale ?? ''} onChange={(e) => setColumn(col.index, { locale: e.target.value })} aria-label={`Language of column “${col.heading}”`} data-testid={`wi-col-locale-${col.index}`} disabled={table.kind === 'xliff'}>
                    {AVAILABLE_LANGUAGES.filter((l) => l.code !== SOURCE_LANGUAGE).map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                  </select>
                )}
              </div>
            ))}
          </fieldset>
        )}

        {plan && (
          <>
            <div className="wi-opts">
              <label><input type="checkbox" checked={applyEnglish} onChange={(e) => setApplyEnglish(e.target.checked)} data-testid="wi-apply-english" /> Change the English of messages matched by id when the file’s English differs</label>
              <label><input type="checkbox" checked={draftOverApproved} onChange={(e) => setDraftOverApproved(e.target.checked)} data-testid="wi-draft-over-approved" /> Add changes to approved translations as drafts to review (the approved text stays until a person approves the draft)</label>
            </div>
            <section className="wi-summary" data-testid="wi-summary" data-drafts={c!.drafts} data-english={c!.english} data-new={c!.newMessages + c!.alternatives} data-skipped={c!.skipped} data-unmatched={c!.unmatched} data-problems={c!.problems} role="status">
              <h3 className="section-title">What will change</h3>
              <p>
                {c!.rows} row{c!.rows === 1 ? '' : 's'} read. <strong>{c!.drafts}</strong> new draft{c!.drafts === 1 ? '' : 's'}, <strong>{c!.english}</strong> English change{c!.english === 1 ? '' : 's'}, <strong>{c!.newMessages}</strong> new message{c!.newMessages === 1 ? '' : 's'}, <strong>{c!.alternatives}</strong> new alternative{c!.alternatives === 1 ? '' : 's'}.{' '}
                {c!.unchanged} already the same, {c!.skipped} skipped, {c!.unmatched} not matched{c!.problems ? `, ${c!.problems} problem${c!.problems === 1 ? '' : 's'} to look at` : ''}.
              </p>
              {plan.languages.length > 0 && <ul className="wi-langs">{plan.languages.map((l) => <li key={l.locale} data-testid="wi-lang" data-locale={l.locale} data-added={l.added ? 'yes' : 'no'}>{languageName(l.locale)}: {l.drafts} draft{l.drafts === 1 ? '' : 's'}{l.added ? ' (the language is added to the document)' : ''}</li>)}</ul>}
              {plan.blocking.map((b, i) => <p key={i} className="callout error" role="alert" data-testid="wi-blocking">{b}</p>)}
            </section>
            <div className="segmented" role="group" aria-label="Rows to show">
              {(['changes', 'skipped', 'unmatched', 'problems', 'all'] as View[]).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} data-testid={`wi-view-${v}`}>{{ changes: 'Changes', skipped: 'Skipped', unmatched: 'Not matched or a guess', problems: 'Problems', all: 'All rows' }[v]}</button>)}
            </div>
            <div className="wi-rows-wrap">
              <table className="table wi-rows">
                <thead><tr><th scope="col">Row</th><th scope="col">From the file</th><th scope="col">Matched to</th><th scope="col">What happens</th></tr></thead>
                <tbody>
                  {visible.slice(0, SHOW_MAX).map((r) => (
                    <tr key={r.index} data-testid="wi-row" data-line={r.line} data-decision={r.decision} data-how={r.match?.how ?? 'none'}>
                      <td className="mono">{r.line}</td>
                      <td className="wi-src"><span className="mono wi-id">{r.id}</span> {r.english && <span>{r.english.slice(0, 140)}</span>}</td>
                      <td className="wi-small">
                        {r.match ? <><span className={`chip ${r.match.how === 'guess' ? 'warning' : 'accent'}`}>{{ id: 'By id', exact: 'Exact', likely: 'Likely', guess: 'A guess' }[r.match.how]}</span> {r.match.reason}</> : <span className="muted">No match</span>}
                        {(r.decision === 'unmatched' || r.match?.how === 'guess' || r.decision === 'new-message' || r.decision === 'alternative' || r.decision === 'skip') && r.match?.how !== 'id' && r.match?.how !== 'exact' && r.match?.how !== 'likely' && (
                          <Decision row={r.index} guess={r.match?.how === 'guess'} value={decisions[r.index]} sections={sections} onChange={(d) => setDecisions((m) => { const n = { ...m }; if (d) n[r.index] = d; else delete n[r.index]; return n; })} />
                        )}
                      </td>
                      <td className="wi-small">
                        {r.changes.map((ch, i) => <div key={i} data-testid="wi-change" data-kind={ch.kind}>{ch.kind === 'draft' ? `${languageName(ch.locale!)} draft for “${ch.title}”: ${ch.to.slice(0, 100)}${ch.from ? ` (was the draft “${ch.from.slice(0, 60)}”)` : ''}` : ch.kind === 'english' ? `English of “${ch.title}” becomes: ${ch.to.slice(0, 100)}` : ch.kind === 'new-message' ? `New message “${ch.title}”` : `New alternative ${ch.title}`}</div>)}
                        {r.unchanged > 0 && <div className="muted">{r.unchanged} already the same</div>}
                        {r.skipped.map((s, i) => <div key={i} className="muted" data-testid="wi-skipped">Skipped{s.locale ? ` (${languageName(s.locale)})` : ''}: {s.reason}</div>)}
                        {r.problems.map((p, i) => <div key={i} className="wi-problem" data-testid="wi-problem">{p}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visible.length === 0 && <p className="muted wi-none" data-testid="wi-none">No rows in this view.</p>}
              {visible.length > SHOW_MAX && <p className="muted wi-none">Showing the first {SHOW_MAX} of {visible.length} rows. Every row is imported.</p>}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Decision({ row, guess, value, sections, onChange }: { row: number; guess: boolean; value: RowDecision | undefined; sections: Array<{ id: string; name: string }>; onChange: (d: RowDecision | null) => void }) {
  const kind = value?.kind ?? (guess ? 'skip' : 'skip');
  return (
    <div className="wi-decision">
      <select className="select" value={kind} aria-label={`What to do with row ${row + 1}`} onChange={(e) => {
        const k = e.target.value as RowDecision['kind'];
        onChange(k === 'skip' ? null : k === 'alternative' ? { kind: 'alternative', nodeId: sections[0]?.id ?? '' } : { kind: k } as RowDecision);
      }} data-testid="wi-decision">
        <option value="skip">Skip it</option>
        {guess && <option value="accept">Use the guess</option>}
        <option value="new-message">Add as a new message</option>
        {sections.length > 0 && <option value="alternative">Add as an alternative of…</option>}
      </select>
      {value?.kind === 'alternative' && (
        <select className="select" value={value.nodeId} aria-label="The message it is an alternative of" onChange={(e) => onChange({ kind: 'alternative', nodeId: e.target.value })} data-testid="wi-alt-target">
          {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
    </div>
  );
}
