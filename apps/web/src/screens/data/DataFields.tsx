import { useMemo, useState } from 'react';
import { CUSTOM_FIELD_KEY, customFieldUsage, fieldsFor, tokensIn, type CustomField, type Predicate, type Project } from '@iss/model';
import { useStudio } from '../../state/store';
import { Dialog, Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import './DataFields.css';

const TYPE_LABEL: Record<string, string> = { string: 'Text', int: 'Whole number', cents: 'Money (cents)', points: 'Points', bool: 'Yes / no', date: 'Date', enum: 'Choice', array: 'List' };

/** Where each field path is used: rule conditions and component bindings/tokens. */
function usageIndex(project: Project): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  const add = (path: string, where: string) => { if (!map.has(path)) map.set(path, new Set()); map.get(path)!.add(where); };
  const walk = (p: Predicate, where: string): void => {
    if ('args' in p) p.args.forEach((a) => walk(a, where));
    else if ('arg' in p) walk(p.arg, where);
    else add(p.path, where);
  };
  for (const r of project.rules) walk(r.when, r.title ? `${r.id} ${r.title}` : r.id);
  for (const n of project.nodes) {
    if (n.binding) add(n.binding, n.name ?? n.id);
    tokensIn(n.content).forEach((p) => add(p, n.name ?? n.id));
  }
  return new Map([...map].map(([k, v]) => [k, [...v]]));
}

interface Row extends CustomField { _new?: boolean; _values?: string }

const blank = (): Row => ({ key: '', label: '', type: 'string', _new: true, _values: '' });

/**
 * The project's data contract: the standard fields of its document type (read-only, with where each is used)
 * and project-level custom fields (add/edit/remove; saved with the model as one undoable command).
 */
export function DataFieldsDialog({ onClose }: { onClose: () => void }) {
  const project = useStudio((s) => s.project)!;
  const usage = useMemo(() => usageIndex(project), [project]);
  const customUse = useMemo(() => new Map(customFieldUsage(project).map((u) => [u.path, u.where])), [project]);
  const [tab, setTab] = useState<'custom' | 'standard'>((project.customFields?.length ?? 0) > 0 ? 'custom' : 'standard');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[]>(() => (project.customFields ?? []).map((f) => ({ ...f, _values: (f.enumValues ?? []).join(', ') })));
  const [error, setError] = useState<string | null>(null);
  const standard = fieldsFor(project.documentType).filter((f) => !q || `${f.label} ${f.path}`.toLowerCase().includes(q.toLowerCase()));
  const original = JSON.stringify(project.customFields ?? []);
  const toFields = (): CustomField[] => rows.map(({ _new, _values, ...f }) => {
    const out: CustomField = { key: f.key.trim(), label: f.label.trim(), type: f.type };
    if (f.type === 'enum') out.enumValues = (_values ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (f.required) out.required = true;
    if (f.dimension) out.dimension = true;
    if (f.example?.trim()) out.example = f.example.trim();
    return out;
  });
  const dirty = JSON.stringify(toFields()) !== original;
  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = () => {
    setError(null);
    const res = useStudio.getState().dispatch({ type: 'SET_CUSTOM_FIELDS', fields: toFields() });
    if (res.ok) { useStudio.getState().toast({ kind: 'success', title: 'Data fields updated', message: 'Saved to the model — undo with Ctrl+Z; Save to keep.' }); onClose(); }
    else setError(res.message);
  };

  return (
    <Dialog title="Data fields" onClose={onClose} labelledBy="data-fields-title"
      footer={tab === 'custom' ? <>
        <span className="muted df-foot-note">Changes apply to the model (undoable). Use <strong>Save</strong> in the top bar to keep them.</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={!dirty} data-testid="save-data-fields">Apply changes</button>
      </> : undefined}>
      <div className="df" data-testid="data-fields">
        <div className="seg" role="tablist" aria-label="Field groups">
          <button role="tab" aria-selected={tab === 'custom'} aria-pressed={tab === 'custom'} onClick={() => setTab('custom')} data-testid="df-tab-custom">Your fields ({rows.length})</button>
          <button role="tab" aria-selected={tab === 'standard'} aria-pressed={tab === 'standard'} onClick={() => setTab('standard')} data-testid="df-tab-standard">Standard fields ({fieldsFor(project.documentType).length})</button>
        </div>

        {tab === 'standard' && (
          <>
            <input className="input" placeholder="Search fields…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search standard fields" />
            <div className="df-table-wrap">
              <table className="table df-table">
                <thead><tr><th>Field</th><th>Type</th><th>Used by</th></tr></thead>
                <tbody>
                  {standard.map((f) => {
                    const used = usage.get(f.path) ?? [];
                    return (
                      <tr key={f.path}>
                        <td><strong>{f.label}</strong>{f.required && <span className="chip df-req">required</span>}{f.derived && <span className="chip">calculated</span>}<div className="mono faint">{f.path}</div></td>
                        <td>{TYPE_LABEL[f.type] ?? f.type}{f.enumValues && <div className="faint df-vals" title={f.enumValues.join(', ')}>{f.enumValues.join(' · ')}</div>}</td>
                        <td className="faint" title={used.join(', ')}>{used.length ? `${used.length}: ${used.slice(0, 2).join(', ')}${used.length > 2 ? '…' : ''}` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'custom' && (
          <>
            <p className="muted df-intro">Add fields your own data carries (for example a segment or a campaign code). Rules, text tokens and imports can then use them as <span className="mono">custom.&lt;key&gt;</span>. Imported CSVs supply values in a column with that name.</p>
            {rows.length === 0 && <p className="df-empty">No custom fields yet.</p>}
            <ul className="df-rows">
              {rows.map((r, i) => {
                const path = `custom.${r.key.trim()}`;
                const inUse = !r._new ? customUse.get(path) ?? [] : [];
                const keyOk = !r.key || CUSTOM_FIELD_KEY.test(r.key);
                return (
                  <li key={i} className="df-row" data-testid="df-row">
                    <div className="field"><label htmlFor={`df-label-${i}`}>Label</label>
                      <input id={`df-label-${i}`} className="input" value={r.label} maxLength={60} placeholder="e.g. Customer segment"
                        onChange={(e) => set(i, { label: e.target.value, ...(r._new && (!r.key || r.key === camel(r.label)) ? { key: camel(e.target.value) } : {}) })} data-testid="df-label" />
                    </div>
                    <div className="field"><label htmlFor={`df-key-${i}`}>Key</label>
                      <input id={`df-key-${i}`} className="input mono" value={r.key} maxLength={40} disabled={!r._new} aria-invalid={!keyOk} placeholder="segment"
                        onChange={(e) => set(i, { key: e.target.value })} data-testid="df-key" />
                      <span className={`hint${keyOk ? '' : ' df-bad'}`}>{keyOk ? <Tech><span className="mono">{path}</span></Tech> : 'Letters and digits only, starting with a letter.'}</span>
                    </div>
                    <div className="field"><label htmlFor={`df-type-${i}`}>Type</label>
                      <select id={`df-type-${i}`} className="select" value={r.type} disabled={inUse.length > 0} onChange={(e) => set(i, { type: e.target.value as CustomField['type'] })} data-testid="df-type">
                        {(['string', 'enum', 'int', 'cents', 'bool', 'date'] as const).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                      </select>
                    </div>
                    {r.type === 'enum' && (
                      <div className="field df-wide"><label htmlFor={`df-vals-${i}`}>Allowed values (comma-separated)</label>
                        <input id={`df-vals-${i}`} className="input" value={r._values ?? ''} placeholder="gold, silver, bronze" onChange={(e) => set(i, { _values: e.target.value })} data-testid="df-values" />
                      </div>
                    )}
                    <div className="df-flags">
                      <label><input type="checkbox" checked={!!r.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required in imports</label>
                      {(r.type === 'enum' || r.type === 'bool') && <label><input type="checkbox" checked={!!r.dimension} onChange={(e) => set(i, { dimension: e.target.checked })} /> Use as a filter</label>}
                    </div>
                    <div className="df-row-end">
                      {inUse.length > 0 && <span className="faint df-use" title={inUse.join(', ')}>Used by {inUse.length}</span>}
                      <button className="btn ghost sm icon" aria-label={`Remove ${r.label || 'field'}`} title={inUse.length ? `In use by ${inUse.join(', ')} — remove those references first` : 'Remove field'} disabled={inUse.length > 0} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Icon.trash /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <button className="btn sm" onClick={() => setRows((r) => [...r, blank()])} data-testid="df-add"><Icon.plus /> Add field</button>
            {error && <p className="callout error" role="alert" data-testid="df-error">{error}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

function camel(label: string): string {
  const words = label.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const s = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  return /^[a-zA-Z]/.test(s) ? s.slice(0, 40) : '';
}
