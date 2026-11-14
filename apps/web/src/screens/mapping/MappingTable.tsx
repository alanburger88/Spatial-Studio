import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { TARGET_KIND_LABEL, type MappingEntry, type TargetMapping } from '@iss/model';
import type { MappingCheck, MappingRow } from '@iss/scenarios';
import { useStudio } from '../../state/store';
import { Tech } from '../../ui/common';
import { ROW_HEIGHT, TYPE_WORDS, stampNow, useWindow } from './model';

export type RowFilter = 'all' | 'open' | 'problems';
export interface MappingTableHandle { goTo(path: string): void }

const STATUS: Record<MappingRow['status'], { label: string; chip: string }> = {
  mapped: { label: 'Mapped', chip: 'accent' },
  'not-needed': { label: 'Not needed', chip: 'info' },
  unmapped: { label: 'Not mapped', chip: 'error' },
  optional: { label: 'Optional', chip: '' },
};

/** The chosen mapping, one row per document field: target field (picked from the imported list or typed), its type, notes, or "not needed". */
export const MappingTable = forwardRef<MappingTableHandle, { mapping: TargetMapping; check: MappingCheck; canEdit: boolean }>(function MappingTable({ mapping, check, canEdit }, ref) {
  const [filter, setFilter] = useState<RowFilter>('all');
  const [q, setQ] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const problemPaths = useMemo(() => new Set(check.findings.filter((f) => f.severity === 'problem').flatMap((f) => f.paths)), [check]);
  // Rows marked in colour: a clash or a target mapped twice (a field not mapped yet is shown by its status only).
  const badPaths = useMemo(() => new Set(check.findings.filter((f) => f.kind === 'type-clash' || f.kind === 'mapped-twice').flatMap((f) => f.paths)), [check]);
  const rows = useMemo(() => check.rows.filter((r) => {
    if (filter === 'open' && r.status !== 'unmapped') return false;
    if (filter === 'problems' && !problemPaths.has(r.path)) return false;
    return !q || `${r.label} ${r.path} ${r.entry?.target ?? ''}`.toLowerCase().includes(q.toLowerCase());
  }), [check, filter, q, problemPaths]);
  const win = useWindow(rows.length, 84);
  useImperativeHandle(ref, () => ({
    goTo(path: string) {
      setFilter('all'); setQ('');
      const i = check.rows.findIndex((r) => r.path === path);
      setFlash(path);
      requestAnimationFrame(() => {
        if (win.ref.current && i >= 0 && win.windowed) win.ref.current.scrollTop = Math.max(0, i * (84) - 60);
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(`[data-testid="map-row"][data-path="${CSS.escape(path)}"]`);
          el?.scrollIntoView({ block: 'center' });
          el?.querySelector<HTMLInputElement>('input')?.focus();
        });
      });
    },
  }), [check.rows, win]);
  const listId = `mp-targets-${mapping.id}`;
  const shown = rows.slice(win.start, win.end);
  return (
    <div className="mp-mapping" data-testid="map-table-wrap">
      <div className="mp-toolbar">
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')} data-testid="map-filter-all">All {check.rows.length}</button>
          <button type="button" aria-pressed={filter === 'open'} onClick={() => setFilter('open')} data-testid="map-filter-open">Not mapped {check.counts.unmapped}</button>
          <button type="button" aria-pressed={filter === 'problems'} onClick={() => setFilter('problems')} data-testid="map-filter-problems">With a problem {problemPaths.size}</button>
        </div>
        <label className="mp-search"><span className="sr-only">Search fields</span><input className="input" type="search" placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)} data-testid="map-search" /></label>
      </div>
      <datalist id={listId}>{(mapping.targetFields ?? []).map((t) => <option key={t.name} value={t.name}>{[t.type, t.description].filter(Boolean).join(' · ')}</option>)}</datalist>
      <div className="mp-scroll" ref={win.ref}>
        <table className="table mp-table mp-edit" aria-label={`Mapping: ${mapping.name}`} data-testid="map-table">
          <thead><tr><th scope="col">Document field</th><th scope="col">Target field and type</th><th scope="col">Format and note</th><th scope="col">Not needed by the target</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {win.before > 0 && <tr aria-hidden="true" style={{ height: win.before }} />}
            {shown.map((r) => <Row key={r.path} row={r} mapping={mapping} listId={listId} canEdit={canEdit} problem={badPaths.has(r.path)} flash={flash === r.path} />)}
            {win.after > 0 && <tr aria-hidden="true" style={{ height: win.after }} />}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted mp-none" data-testid="map-none">{filter === 'open' ? 'Every field that must be mapped is mapped or marked not needed.' : 'No field matches.'}</p>}
      </div>
    </div>
  );
});

function Row({ row, mapping, listId, canEdit, problem, flash }: { row: MappingRow; mapping: TargetMapping; listId: string; canEdit: boolean; problem: boolean; flash: boolean }) {
  const e = row.entry;
  const [target, setTarget] = useState(e?.target ?? '');
  const [type, setType] = useState(e?.targetType ?? '');
  const [note, setNote] = useState(e?.format ?? '');
  const [reason, setReason] = useState(e?.notNeeded?.reason ?? '');
  const [notNeeded, setNotNeeded] = useState(!!e?.notNeeded);
  useEffect(() => { setTarget(e?.target ?? ''); setType(e?.targetType ?? ''); setNote(e?.format ?? ''); setReason(e?.notNeeded?.reason ?? ''); setNotNeeded(!!e?.notNeeded); }, [e]);
  const commit = (patch: Partial<{ target: string; type: string; note: string; reason: string; notNeeded: boolean }> = {}) => {
    const v = { target, type, note, reason, notNeeded, ...patch };
    const entry: MappingEntry = { path: row.path };
    if (v.notNeeded) { if (!v.reason.trim()) return; entry.notNeeded = { reason: v.reason }; }
    else if (v.target.trim()) entry.target = v.target;
    if (!v.notNeeded && v.type.trim()) entry.targetType = v.type;
    if (v.note.trim()) entry.format = v.note;
    if (e?.note) entry.note = e.note;
    const same = JSON.stringify({ t: e?.target ?? '', y: e?.targetType ?? '', f: e?.format ?? '', n: e?.notNeeded?.reason ?? null }) === JSON.stringify({ t: entry.target ?? '', y: entry.targetType ?? '', f: entry.format ?? '', n: entry.notNeeded?.reason ?? null });
    if (same) return;
    const st = useStudio.getState();
    if (!entry.target && !entry.notNeeded && !entry.format && !entry.targetType) { if (e) st.dispatch({ type: 'CLEAR_MAPPING_ENTRY', mappingId: mapping.id, path: row.path, stamp: stampNow() }); return; }
    st.dispatch({ type: 'SET_MAPPING_ENTRY', mappingId: mapping.id, entry, stamp: stampNow() });
  };
  const onKey = (ev: React.KeyboardEvent<HTMLInputElement>) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') { setTarget(e?.target ?? ''); setType(e?.targetType ?? ''); setNote(e?.format ?? ''); setReason(e?.notNeeded?.reason ?? ''); } };
  const fromList = !type && row.targetType ? row.targetType : null;
  const s = STATUS[row.status];
  return (
    <tr data-testid="map-row" data-path={row.path} data-status={row.status} className={`${problem ? 'mp-problem' : ''}${flash ? ' mp-flash' : ''}${row.list ? ' mp-col' : ''}`}>
      <th scope="row" className="mp-fieldcell">
        <span className="mp-label">{row.list && <span aria-hidden="true">↳ </span>}{row.label}</span>
        <span className="muted mp-small">{TYPE_WORDS[row.type] ?? row.type}{row.calculated ? ' · calculated' : ''}{row.required ? '' : row.calculated ? '' : ' · optional'}</span>
        <Tech><span className="mono mp-path">{row.path}</span></Tech>
      </th>
      <td className="mp-tcell"><input className="input" list={listId} value={target} disabled={!canEdit || notNeeded} placeholder={notNeeded ? '—' : 'Target field'} aria-label={`Target field for ${row.label}`} onChange={(ev) => setTarget(ev.target.value)} onBlur={() => commit()} onKeyDown={onKey} maxLength={120} data-testid="map-target-input" />
        <input className="input mp-typein" value={type} disabled={!canEdit || notNeeded} placeholder={fromList ?? 'Type (optional)'} aria-label={`Target type for ${row.label}`} onChange={(ev) => setType(ev.target.value)} onBlur={() => commit()} onKeyDown={onKey} maxLength={60} data-testid="map-type-input" />
        {row.targetKind && <span className={`mp-small ${row.clash ? 'mp-bad' : 'muted'}`} data-testid="map-type-read">{fromList ? 'From the list: ' : ''}read as {TARGET_KIND_LABEL[row.targetKind]}</span>}
      </td>
      <td><input className="input" value={note} disabled={!canEdit} placeholder={row.type === 'cents' ? 'e.g. ÷ 100' : 'Format, note'} aria-label={`Format note for ${row.label}`} onChange={(ev) => setNote(ev.target.value)} onBlur={() => commit()} onKeyDown={onKey} maxLength={300} data-testid="map-format-input" /></td>
      <td className="mp-nn">
        <label className="mp-check"><input type="checkbox" checked={notNeeded} disabled={!canEdit} onChange={(ev) => { const on = ev.target.checked; setNotNeeded(on); if (!on) commit({ notNeeded: false }); }} data-testid="map-notneeded" /> <span className="sr-only">{row.label} is </span>Not needed</label>
        {notNeeded && <input className="input" value={reason} autoFocus={!e?.notNeeded} disabled={!canEdit} placeholder="Why (required)" aria-label={`Why the target does not need ${row.label}`} onChange={(ev) => setReason(ev.target.value)} onBlur={() => commit()} onKeyDown={onKey} maxLength={300} data-testid="map-reason-input" />}
      </td>
      <td>
        <span className={`chip ${s.chip}`} data-testid="map-status">{s.label}</span>
        {row.clash && <span className="chip error" title={row.clash} data-testid="map-clash">Type clash</span>}
      </td>
    </tr>
  );
}
