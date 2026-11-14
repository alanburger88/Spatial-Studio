import { CUSTOM_FIELD_KEY, CUSTOM_GROUP_MAX_FIELDS, CUSTOM_LIST_MAX_COLUMNS, type CustomField, type CustomListColumn } from '@iss/model';
import { Icon } from '../../ui/icons';

/**
 * Richer data shapes (wave 5): the fields of a group and the columns of a list, edited the same way. A list's columns
 * may be a group of fields or a list of its own (one level: the inner list's columns and a group's fields are simple).
 * Pure presentation: the data fields editor keeps the rows and saves them with one command.
 */

export interface SubRow { key: string; label: string; type: string; _new?: boolean; fields?: SubRow[]; itemFields?: SubRow[] }

export const SHAPE_TYPE_LABEL: Record<string, string> = { string: 'Text', int: 'Whole number', cents: 'Amount', bool: 'Yes / no', date: 'Date', group: 'Group of fields', list: 'List inside each item' };
const SIMPLE = ['string', 'int', 'cents', 'date'];
const MEMBER = ['string', 'int', 'cents', 'date', 'bool'];

export const blankSub = (): SubRow => ({ key: '', label: '', type: 'string', _new: true });

function camel(label: string): string {
  const words = label.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const s = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  return /^[a-zA-Z]/.test(s) ? s.slice(0, 40) : '';
}
const move = <T,>(list: T[], from: number, to: number): T[] => { if (to < 0 || to >= list.length) return list; const next = [...list]; const [it] = next.splice(from, 1); next.splice(to, 0, it); return next; };

/** Rows of the editor → the model's columns or group fields (keys and labels trimmed, editor-only marks dropped). */
export function cleanSub(rows: SubRow[]): CustomListColumn[] {
  return rows.map((r) => {
    const out: CustomListColumn = { key: r.key.trim(), label: r.label.trim(), type: r.type as CustomListColumn['type'] };
    if (r.type === 'group') out.fields = (r.fields ?? []).map((m) => ({ key: m.key.trim(), label: m.label.trim(), type: m.type as 'string' }));
    if (r.type === 'list') out.itemFields = cleanSub(r.itemFields ?? []);
    return out;
  });
}

/** The model's columns or group fields → rows of the editor. */
export function subRowsOf(cols: Array<{ key: string; label: string; type: string; fields?: unknown[]; itemFields?: unknown[] }> | undefined): SubRow[] {
  return (cols ?? []).map((c) => ({ key: c.key, label: c.label, type: c.type, ...(c.fields ? { fields: subRowsOf(c.fields as SubRow[]) } : {}), ...(c.itemFields ? { itemFields: subRowsOf(c.itemFields as SubRow[]) } : {}) }));
}

/**
 * The columns of a list (`kind: 'columns'`, with group and list columns when `nested`) or the fields of a group
 * (`kind: 'members'`). `depth` 1 is the first level inside a field.
 */
export function SubFields({ rows, onChange, kind, nested, owner, depth = 1 }: { rows: SubRow[]; onChange: (rows: SubRow[]) => void; kind: 'columns' | 'members'; nested: boolean; owner: string; depth?: number }) {
  const types = kind === 'members' ? MEMBER : nested ? [...SIMPLE, 'group', 'list'] : SIMPLE;
  const max = kind === 'members' ? CUSTOM_GROUP_MAX_FIELDS : CUSTOM_LIST_MAX_COLUMNS;
  const what = kind === 'members' ? 'field' : 'column';
  const set = (k: number, patch: Partial<SubRow>) => onChange(rows.map((y, j) => (j === k ? { ...y, ...patch } : y)));
  const id = (k: number, f: string) => `df-sub-${owner}-${depth}-${k}-${f}`;
  return (
    <div className="df-list" data-testid={kind === 'members' ? 'df-group' : depth > 1 ? 'df-inner-list' : 'df-list'}>
      <div className="df-list-head"><strong>{kind === 'members' ? 'Fields of the group' : depth > 1 ? 'Columns of the inner list' : 'Columns'}</strong><span className="muted df-hint-count">{rows.length} of {max}.{kind === 'members' ? ' A group holds simple fields: no group or list inside a group.' : depth > 1 ? ' A list inside a list holds simple columns: lists go two levels deep at most.' : ' Each row of the list has a value for every column.'}</span></div>
      <ul className="df-cols">
        {rows.map((c, k) => {
          const keyOk = !c.key || CUSTOM_FIELD_KEY.test(c.key);
          return (
            <li key={k} className="df-col df-col-shaped" data-testid={kind === 'members' ? 'df-member' : 'df-col'}>
              <div className="field"><label htmlFor={id(k, 'label')}>{kind === 'members' ? 'Field label' : 'Column label'}</label>
                <input id={id(k, 'label')} className="input" value={c.label} maxLength={60} placeholder={kind === 'members' ? 'e.g. City' : 'e.g. Price'}
                  onChange={(e) => set(k, { label: e.target.value, ...(c._new && (!c.key || c.key === camel(c.label)) ? { key: camel(e.target.value) } : {}) })} data-testid={kind === 'members' ? 'df-member-label' : 'df-col-label'} />
              </div>
              <div className="field"><label htmlFor={id(k, 'key')}>{kind === 'members' ? 'Field key' : 'Column key'}</label>
                <input id={id(k, 'key')} className="input mono" value={c.key} maxLength={40} disabled={!c._new} aria-invalid={!keyOk} onChange={(e) => set(k, { key: e.target.value })} data-testid={kind === 'members' ? 'df-member-key' : 'df-col-key'} />
                {!keyOk && <span className="hint df-bad">Letters and digits only, starting with a letter.</span>}
              </div>
              <div className="field"><label htmlFor={id(k, 'type')}>{kind === 'members' ? 'Field type' : 'Column type'}</label>
                <select id={id(k, 'type')} className="select" value={c.type} onChange={(e) => {
                  const type = e.target.value;
                  set(k, { type, ...(type === 'group' && !c.fields?.length ? { fields: [blankSub()] } : {}), ...(type === 'list' && !c.itemFields?.length ? { itemFields: [blankSub()] } : {}) });
                }} data-testid={kind === 'members' ? 'df-member-type' : 'df-col-type'}>
                  {types.map((t) => <option key={t} value={t}>{SHAPE_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div className="df-col-end">
                <button type="button" className="btn ghost sm icon" aria-label={`Move ${what} ${c.label || k + 1} up`} disabled={k === 0} onClick={() => onChange(move(rows, k, k - 1))}><Icon.chevron width={14} height={14} style={{ transform: 'rotate(-90deg)' }} /></button>
                <button type="button" className="btn ghost sm icon" aria-label={`Move ${what} ${c.label || k + 1} down`} disabled={k === rows.length - 1} onClick={() => onChange(move(rows, k, k + 1))}><Icon.chevron width={14} height={14} style={{ transform: 'rotate(90deg)' }} /></button>
                <button type="button" className="btn ghost sm icon" aria-label={`Remove ${what} ${c.label || k + 1}`} disabled={rows.length <= 1} title={rows.length <= 1 ? `It needs at least one ${what}` : `Remove ${what}`} onClick={() => onChange(rows.filter((_, j) => j !== k))}><Icon.trash width={14} height={14} /></button>
              </div>
              {c.type === 'group' && <div className="df-sub"><SubFields rows={c.fields ?? []} onChange={(fields) => set(k, { fields })} kind="members" nested={false} owner={`${owner}-${k}`} depth={depth + 1} /></div>}
              {c.type === 'list' && <div className="df-sub"><SubFields rows={c.itemFields ?? []} onChange={(itemFields) => set(k, { itemFields })} kind="columns" nested={false} owner={`${owner}-${k}`} depth={depth + 1} /></div>}
            </li>
          );
        })}
      </ul>
      <div><button type="button" className="btn sm" disabled={rows.length >= max} onClick={() => onChange([...rows, blankSub()])} data-testid={kind === 'members' ? 'df-member-add' : depth > 1 ? 'df-inner-col-add' : 'df-col-add'}><Icon.plus /> Add {what}</button></div>
    </div>
  );
}

/** The shape of the data at a glance: groups and lists with what they hold, as a tree. */
export function ShapeTree({ fields }: { fields: CustomField[] }) {
  const leaf = (c: { label: string; type: string; fields?: Array<{ label: string }>; itemFields?: CustomListColumn[] }, k: number): JSX.Element => (
    <li key={k} role="treeitem" aria-selected={false} aria-expanded={c.fields || c.itemFields ? true : undefined}>
      <span>{c.label || '(no label)'}</span> <span className="faint">{SHAPE_TYPE_LABEL[c.type] === 'List inside each item' ? 'list' : (SHAPE_TYPE_LABEL[c.type] ?? (c.type === 'list' ? 'list' : c.type === 'enum' ? 'choice' : c.type)).toLowerCase()}</span>
      {c.fields && <ul role="group">{c.fields.map((m, j) => <li key={j} role="treeitem" aria-selected={false}>{m.label}</li>)}</ul>}
      {c.itemFields && <ul role="group">{c.itemFields.map(leaf)}</ul>}
    </li>
  );
  if (!fields.some((f) => f.type === 'group' || (f.itemFields ?? []).some((c) => c.type === 'group' || c.type === 'list'))) return null;
  return (
    <details className="df-tree" open data-testid="df-tree">
      <summary>The shape of the data</summary>
      <ul role="tree" aria-label="The shape of the data">{fields.map((f, k) => leaf(f as never, k))}</ul>
    </details>
  );
}
