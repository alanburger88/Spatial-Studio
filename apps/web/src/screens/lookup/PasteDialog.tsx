import { useMemo, useState } from 'react';
import { LOOKUP_TABLE_MAX_ROWS, parseLookupPaste, type LookupRow, type LookupTable } from '@iss/model';
import { Dialog } from '../../ui/common';
import { cellValue, gridColumns, valueText } from './model';

/**
 * Paste rows from a spreadsheet. Shows what will be added, and every problem by row and column (the engine's paste
 * reader), before anything is applied.
 */
export function PasteDialog({ table, initialText, locale, onApply, onClose }: { table: LookupTable; initialText: string; locale: string; onApply: (rows: LookupRow[], mode: 'add' | 'replace') => void; onClose: () => void }) {
  const [text, setText] = useState(initialText);
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [skip, setSkip] = useState(false);
  const cols = useMemo(() => gridColumns(table), [table]);
  const parsed = useMemo(() => parseLookupPaste(table, text), [table, text]);
  const total = (mode === 'add' ? table.rows.length : 0) + parsed.rows.length;
  const over = total > LOOKUP_TABLE_MAX_ROWS;
  const hasProblems = parsed.problems.length > 0;
  const canApply = parsed.rows.length > 0 && !over && (!hasProblems || skip);
  const hint = cols.map((c) => c.role === 'value' ? c.head : c.role === 'key-text' ? c.head : `${c.head} ${c.role === 'key-from' ? 'from' : 'until'}`).join(' | ');
  return (
    <Dialog title="Paste rows from a spreadsheet" onClose={onClose} labelledBy="lk-paste-title"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!canApply} onClick={() => onApply(parsed.rows, mode)} data-testid="lk-paste-apply">
          {parsed.rows.length === 0 ? 'Nothing to add' : mode === 'add' ? `Add ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'}` : `Replace with ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'}`}
        </button></>}>
      <div className="lk-paste" data-testid="lk-paste">
        <p className="muted">Copy cells from a spreadsheet and paste them here. The columns, in order, are: <span className="mono">{hint}</span>. A range takes two cells (from and until; leave one empty for no limit). Amounts are in dollars, dates are YYYY-MM-DD, yes or no as yes/no. A first row of column names is skipped.</p>
        <div className="field"><label htmlFor="lk-paste-text">Pasted rows</label>
          <textarea id="lk-paste-text" className="textarea mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} data-testid="lk-paste-text" spellCheck={false} /></div>
        <div className="row lk-paste-mode" role="radiogroup" aria-label="What to do with the rows">
          <label><input type="radio" name="lk-paste-mode" checked={mode === 'add'} onChange={() => setMode('add')} /> Add after the {table.rows.length} existing row{table.rows.length === 1 ? '' : 's'}</label>
          <label><input type="radio" name="lk-paste-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} data-testid="lk-paste-replace" /> Replace all existing rows</label>
        </div>
        {text.trim() && (
          <div className="lk-paste-result" aria-live="polite">
            <p data-testid="lk-paste-summary"><strong>{parsed.rows.length}</strong> row{parsed.rows.length === 1 ? '' : 's'} will be added{parsed.headerSkipped ? '; the heading row is skipped' : ''}{hasProblems ? <>; <strong>{parsed.problems.length}</strong> problem{parsed.problems.length === 1 ? '' : 's'} found</> : ''}.{over && ` A table holds at most ${LOOKUP_TABLE_MAX_ROWS.toLocaleString('en-US')} rows; this would make ${total.toLocaleString('en-US')}.`}</p>
            {hasProblems && (
              <>
                <ul className="lk-paste-problems" data-testid="lk-paste-problems">
                  {parsed.problems.slice(0, 20).map((p, i) => <li key={i} data-row={p.row} data-column={p.column ?? ''}><span className="chip error">Row {p.row}{p.column ? `, column ${p.column}` : ''}</span> {p.message}</li>)}
                  {parsed.problems.length > 20 && <li className="muted">and {parsed.problems.length - 20} more</li>}
                </ul>
                <label className="lk-skip"><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} data-testid="lk-paste-skip" /> Skip the rows with problems and add the others</label>
              </>
            )}
            {parsed.rows.length > 0 && (
              <div className="lk-preview-wrap">
                <table className="table lk-preview" data-testid="lk-paste-preview">
                  <caption className="muted">First {Math.min(6, parsed.rows.length)} of the rows that will be added</caption>
                  <thead><tr>{cols.map((c) => <th key={c.id} scope="col">{c.head}<span className="muted"> {c.sub}</span></th>)}</tr></thead>
                  <tbody>{parsed.rows.slice(0, 6).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.id}>{valueText(c.kind, cellValue(r, c), locale) || <span className="muted">{c.role === 'value' ? 'empty' : 'no limit'}</span>}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
