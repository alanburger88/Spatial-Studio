import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LookupRow, LookupTable } from '@iss/model';
import { Icon } from '../../ui/icons';
import { blankRow, cellInvalid, cellValue, gridColumns, parseCell, valueText, withCell, type GridCol } from './model';

/**
 * The rows of a table as a grid that is fully keyboard-operable and renders only the rows in view, so a table of
 * thousands of rows stays quick. Arrow keys move, Enter (or typing) edits, Enter saves the cell and moves down,
 * Escape cancels, Tab moves right. Ctrl+Enter adds a row below, Ctrl+Delete removes the row, Delete empties the cell,
 * and pasting from a spreadsheet opens the paste preview.
 */

export const ROW_HEIGHT = 36;
const OVERSCAN = 6;
const MAX_ROWS = 5000;

export interface RowProblem { severity: 'error' | 'warning'; messages: string[] }

interface Active { r: number; c: number }
interface Editing { r: number; c: number; text: string; error?: string; typed?: boolean }

interface RowProps {
  row: LookupRow; r: number; cols: GridCol[]; top: number; activeC: number; editing: Editing | null; problem?: RowProblem; locale: string;
  api: { select: (r: number, c: number) => void; startEdit: (r: number, c: number, text?: string) => void; setText: (t: string) => void; commit: (move: 'down' | 'right' | 'none') => void; cancel: () => void; remove: (r: number) => void };
  disabled: boolean;
}

const GridRow = memo(function GridRow({ row, r, cols, top, activeC, editing, problem, locale, api, disabled }: RowProps) {
  return (
    <div role="row" aria-rowindex={r + 2} className={`lk-row${problem ? ` ${problem.severity}` : ''}`} style={{ top, height: ROW_HEIGHT }} data-testid={`lk-row-${r}`}>
      <div role="rowheader" className="lk-rowhead" title={problem?.messages.join(' ')}>
        <span className="lk-rownum">{r + 1}</span>
        {problem && <span className={`lk-flag ${problem.severity}`}><Icon.warning width={12} height={12} aria-hidden="true" /><span className="lk-sr">{problem.severity === 'error' ? 'Problem' : 'Warning'}: {problem.messages[0]}</span></span>}
      </div>
      {cols.map((c, ci) => {
        const isActive = activeC === ci;
        const isEditing = editing !== null && editing.c === ci;
        const raw = cellValue(row, c);
        const text = valueText(c.kind, raw, locale);
        const bad = cellInvalid(row, c);
        const open = (c.role === 'key-from' || c.role === 'key-until') && raw === undefined;
        return (
          <div key={c.id} role="gridcell" aria-colindex={ci + 2} aria-invalid={bad || undefined} aria-readonly={disabled || undefined}
            tabIndex={isActive && !isEditing ? 0 : -1} data-cell={`${r}:${ci}`} data-testid={`lk-cell-${r}-${ci}`}
            className={`lk-cell${isActive ? ' active' : ''}${bad ? ' bad' : ''}${c.kind === 'number' || c.kind === 'money' ? ' num' : ''}`}
            onMouseDown={() => { if (!isEditing) api.select(r, ci); }} onDoubleClick={() => !disabled && api.startEdit(r, ci)}>
            {isEditing ? (
              <input className="lk-input" autoFocus aria-label={`${c.head} ${c.sub}, row ${r + 1}`} value={editing!.text} aria-invalid={!!editing!.error || undefined}
                data-testid="lk-input"
                onChange={(e) => api.setText(e.target.value)}
                onFocus={(e) => { const el = e.target; if (editing!.typed) el.setSelectionRange(el.value.length, el.value.length); else el.select(); }}
                onBlur={() => api.commit('none')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); api.commit('down'); }
                  else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); api.commit('right'); }
                  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.cancel(); }
                }} />
            ) : (
              <span className={open ? 'lk-open' : undefined}>{open ? 'no limit' : text}</span>
            )}
          </div>
        );
      })}
    </div>
  );
});

export function Grid({ table, onChange, rowProblems, locale, disabled, onPaste, focusRow }: {
  table: LookupTable;
  onChange: (rows: LookupRow[]) => void;
  rowProblems: Map<number, RowProblem>;
  locale: string;
  disabled: boolean;
  onPaste: (text: string) => void;
  /** Move to a row (1-based) from outside, for "go to row" in the problem list. The tick makes the same row work twice. */
  focusRow: { row: number; tick: number } | null;
}) {
  const cols = useMemo(() => gridColumns(table), [table.keys, table.columns]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = table.rows;
  const n = rows.length;
  const box = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(360);
  const [active, setActive] = useState<Active>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [status, setStatus] = useState('');
  const editingRef = useRef(editing); editingRef.current = editing;
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const tableRef = useRef(table); tableRef.current = table;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setViewH(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the active cell on the table when rows or columns go away.
  const r = Math.min(active.r, Math.max(0, n - 1));
  const c = Math.min(active.c, Math.max(0, cols.length - 1));

  const bodyH = Math.max(1, viewH - ROW_HEIGHT);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(n, Math.ceil((scrollTop + bodyH) / ROW_HEIGHT) + OVERSCAN);

  const reveal = useCallback((row: number) => {
    const el = box.current;
    if (!el) return;
    const top = row * ROW_HEIGHT, bottom = top + ROW_HEIGHT, h = el.clientHeight - ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + h) el.scrollTop = bottom - h;
    setScrollTop(el.scrollTop);
  }, []);

  const moveTo = useCallback((nr: number, nc: number, focus = true) => {
    const rr = Math.max(0, Math.min(rowsRef.current.length - 1, nr));
    const cc = Math.max(0, Math.min(cols.length - 1, nc));
    setActive({ r: rr, c: cc });
    reveal(rr);
    wantFocus.current = focus;
  }, [cols.length, reveal]);

  // Focus the active cell once it is on the page.
  useEffect(() => {
    if (!wantFocus.current || editing) return;
    // The wanted cell as asked for (not clamped): when a row has just been added it exists one render later.
    const el = box.current?.querySelector<HTMLElement>(`[data-cell="${active.r}:${active.c}"]`);
    if (el) { reveal(active.r); el.focus({ preventScroll: true }); wantFocus.current = false; }
  });

  useEffect(() => { if (focusRow && focusRow.row >= 1 && focusRow.row <= rowsRef.current.length) moveTo(focusRow.row - 1, 0); }, [focusRow]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = useCallback((rr: number, cc: number, text?: string) => {
    if (disabled) return;
    const col = cols[cc];
    const row = rowsRef.current[rr];
    if (!col || !row) return;
    setActive({ r: rr, c: cc });
    setEditing({ r: rr, c: cc, typed: text !== undefined, text: text ?? (col.kind === 'money' ? valueText(col.kind, cellValue(row, col), locale).replace(/^\$/, '') : valueText(col.kind, cellValue(row, col), locale)) });
  }, [cols, disabled, locale]);

  const commit = useCallback((move: 'down' | 'right' | 'none') => {
    const ed = editingRef.current;
    if (!ed) return;
    const col = cols[ed.c];
    const row = rowsRef.current[ed.r];
    if (!col || !row) { setEditing(null); return; }
    const parsed = parseCell(col, ed.text);
    if (!parsed.ok) {
      if (move === 'none') { setEditing(null); setStatus(`Row ${ed.r + 1}, ${col.head}: not saved. ${parsed.message}`); return; }
      setEditing({ ...ed, error: parsed.message });
      setStatus(`Row ${ed.r + 1}, ${col.head}: ${parsed.message}`);
      return;
    }
    const next = withCell(row, col, parsed.value);
    if (JSON.stringify(next) !== JSON.stringify(row)) { const copy = rowsRef.current.slice(); copy[ed.r] = next; onChange(copy); }
    setEditing(null);
    setStatus('');
    if (move === 'down') moveTo(ed.r + 1, ed.c);
    else if (move === 'right') { if (ed.c + 1 < cols.length) moveTo(ed.r, ed.c + 1); else moveTo(ed.r + 1, 0); }
  }, [cols, moveTo, onChange]);

  const addRow = useCallback((at: number) => {
    const t = tableRef.current;
    if (t.rows.length >= MAX_ROWS) { setStatus(`A table holds at most 5,000 rows.`); return; }
    const copy = t.rows.slice();
    copy.splice(at, 0, blankRow({ ...t, rows: at === t.rows.length ? t.rows : t.rows.slice(0, at) }));
    onChange(copy);
    setStatus(`Row ${at + 1} added.`);
    // The new row exists one render later, so the position is set as it is (moveTo clamps to the rows it can see).
    setActive({ r: at, c: 0 });
    wantFocus.current = true;
  }, [onChange]);

  const removeRow = useCallback((at: number) => {
    const t = tableRef.current;
    if (!t.rows[at]) return;
    onChange(t.rows.filter((_, i) => i !== at));
    setStatus(`Row ${at + 1} removed.`);
    setActive((a) => ({ ...a, r: Math.max(0, Math.min(a.r, t.rows.length - 2)) }));
    wantFocus.current = true;
  }, [onChange]);

  const api = useMemo(() => ({
    select: (rr: number, cc: number) => { setActive({ r: rr, c: cc }); wantFocus.current = false; },
    startEdit, setText: (text: string) => setEditing((e) => (e ? { ...e, text, error: undefined } : e)), commit, cancel: () => { setEditing(null); wantFocus.current = true; }, remove: removeRow,
  }), [startEdit, commit, removeRow]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const pageRows = Math.max(1, Math.floor(bodyH / ROW_HEIGHT) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveTo(r + 1, c); return;
      case 'ArrowUp': e.preventDefault(); moveTo(r - 1, c); return;
      case 'ArrowRight': e.preventDefault(); moveTo(r, c + 1); return;
      case 'ArrowLeft': e.preventDefault(); moveTo(r, c - 1); return;
      case 'PageDown': e.preventDefault(); moveTo(r + pageRows, c); return;
      case 'PageUp': e.preventDefault(); moveTo(r - pageRows, c); return;
      case 'Home': e.preventDefault(); moveTo(ctrl ? 0 : r, 0); return;
      case 'End': e.preventDefault(); moveTo(ctrl ? n - 1 : r, cols.length - 1); return;
      case 'Enter':
        e.preventDefault();
        if (ctrl) { if (!disabled) addRow(r + 1); } else startEdit(r, c);
        return;
      case 'F2': e.preventDefault(); startEdit(r, c); return;
      case 'Delete':
        if (disabled || !rows[r]) return;
        e.preventDefault();
        if (ctrl) removeRow(r);
        else { const col = cols[c]; const parsed = parseCell(col, ''); if (parsed.ok) { const copy = rows.slice(); copy[r] = withCell(rows[r], col, parsed.value); onChange(copy); } }
        return;
      default:
        // Typing a character starts editing the cell with it, like a spreadsheet.
        if (!ctrl && !e.altKey && e.key.length === 1 && !disabled && rows[r]) { e.preventDefault(); startEdit(r, c, e.key); }
    }
  };

  const present = useMemo(() => {
    const set = new Set<number>();
    for (let i = first; i < last; i++) set.add(i);
    if (n > 0) set.add(r);
    return [...set].sort((a, b) => a - b);
  }, [first, last, n, r]);

  return (
    <div className="lk-gridwrap" data-testid="lk-grid-wrap">
      <div className="lk-toolbar">
        <button type="button" className="btn sm" disabled={disabled || n >= MAX_ROWS} onClick={() => addRow(n)} data-testid="lk-add-row"><Icon.plus /> Add a row</button>
        <button type="button" className="btn sm" disabled={disabled || n >= MAX_ROWS || n === 0} onClick={() => addRow(r + 1)} data-testid="lk-insert-row">Insert below row {n ? r + 1 : ''}</button>
        <button type="button" className="btn sm danger" disabled={disabled || n === 0} onClick={() => removeRow(r)} data-testid="lk-remove-row"><Icon.trash /> Remove row {n ? r + 1 : ''}</button>
        <span className="muted lk-count" data-testid="lk-rowcount">{n.toLocaleString('en-US')} row{n === 1 ? '' : 's'} of at most 5,000</span>
      </div>
      <div ref={box} className="lk-grid" role="grid" aria-label={`Rows of ${table.title}`} aria-rowcount={n + 1} aria-colcount={cols.length + 1} data-testid="lk-grid"
        onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)} onKeyDown={onKeyDown}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (!editing && t && !disabled) { e.preventDefault(); onPaste(t); } }}>
        <div role="row" aria-rowindex={1} className="lk-row lk-headrow" style={{ height: ROW_HEIGHT }}>
          <div role="columnheader" className="lk-rowhead lk-hcell">#</div>
          {cols.map((col, ci) => <div key={col.id} role="columnheader" aria-colindex={ci + 2} className="lk-cell lk-hcell" title={`${col.head}, ${col.sub}`}><strong>{col.head}</strong><span className="muted">{col.sub}</span></div>)}
        </div>
        <div className="lk-body" role="rowgroup" style={{ height: n * ROW_HEIGHT }}>
          {present.map((i) => <GridRow key={i} row={rows[i]} r={i} cols={cols} top={i * ROW_HEIGHT} activeC={i === r ? c : -1} editing={editing && editing.r === i ? editing : null} problem={rowProblems.get(i + 1)} locale={locale} api={api} disabled={disabled} />)}
        </div>
        {n === 0 && <div className="lk-none muted">No rows yet. Choose “Add a row”, or paste rows from a spreadsheet.</div>}
      </div>
      <p className="lk-hint muted">Arrow keys move. Enter or typing edits a cell; Enter saves it and moves down, Escape cancels. Ctrl+Enter adds a row below, Ctrl+Delete removes the row, Delete empties the cell. Paste rows from a spreadsheet with Ctrl+V.</p>
      <p className="lk-sr" role="status" aria-live="polite" data-testid="lk-status">{status}</p>
      {editing?.error && <p className="cb-problem" role="alert">{editing.error}</p>}
    </div>
  );
}
