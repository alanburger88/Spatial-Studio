import { useMemo, useRef, useState } from 'react';
import { TARGET_KIND_LABEL, type Command, type Project, type TargetMapping } from '@iss/model';
import { readTargetFieldList, suggestTargetMatches, type DataDictionary } from '@iss/scenarios';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import { stampNow } from './model';

const HOW: Record<string, string> = { exact: 'Exact', likely: 'Likely', guess: 'A guess' };

/**
 * "Import the target's field list": a CSV (name, type, description; heading variants are recognised and named), then the
 * suggested matches with the customer import's matcher. Exact and likely matches are ticked; a guess is only offered.
 * Applying stores the list and the ticked matches as one undoable step.
 */
export function ImportTargetList({ project, mapping, dict, onClose }: { project: Project; mapping: TargetMapping; dict: DataDictionary; onClose: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const read = useMemo(() => (text.trim() ? readTargetFieldList(text) : null), [text]);
  const suggestions = useMemo(() => (read ? suggestTargetMatches(project, mapping, read.fields, dict) : []), [read, project, mapping, dict]);
  const labels = useMemo(() => new Map(dict.fields.flatMap((f) => [[f.path, f.label] as const, ...(f.columns ?? []).map((c) => [`${f.path}[].${c.key}`, `${f.label} · ${c.label}`] as const)])), [dict]);
  const isOn = (path: string, pre: boolean) => picked[path] ?? pre;
  const chosen = suggestions.filter((s) => isOn(s.path, s.preselected));

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { setError('The file is larger than 2 MB.'); return; }
    setError(null); setFileName(f.name); setPicked({}); setText(await f.text());
  };
  const apply = () => {
    if (!read?.fields.length) return;
    const stamp = stampNow();
    const commands: Command[] = [{ type: 'IMPORT_TARGET_FIELDS', mappingId: mapping.id, fields: read.fields, stamp }];
    if (chosen.length) commands.push({ type: 'SET_MAPPING_ENTRIES', mappingId: mapping.id, entries: chosen.map((s) => ({ path: s.path, target: s.target })), stamp });
    const label = `Import ${read.fields.length} target field${read.fields.length === 1 ? '' : 's'}${chosen.length ? ` and map ${chosen.length}` : ''} for “${mapping.name}”`;
    const r = useStudio.getState().dispatch({ type: 'BATCH', label, commands });
    if (!r.ok) { setError(r.message); return; }
    useStudio.getState().toast({ kind: 'success', title: 'Target field list imported', message: `${label}. Undo with Ctrl+Z.` });
    onClose();
  };

  return (
    <Dialog title="Import the target’s field list" onClose={onClose} labelledBy="mp-import-title"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={apply} disabled={!read?.fields.length} data-testid="map-import-apply">{read?.fields.length ? `Import ${read.fields.length} fields${chosen.length ? ` and map ${chosen.length}` : ''}` : 'Import'}</button></>}>
      <div className="mp-import" data-testid="map-import">
        <p className="muted">A CSV file with one row per field of the target system: its name, and if you have them its type and a description. Common headings such as “Field name”, “Data type” and “Definition” are recognised. Nothing changes until you import.</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="map-import-choose">Choose a CSV file…</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} data-testid="map-import-file" aria-label="Choose the target's field list" />
          {fileName && <span className="muted">{fileName}</span>}
        </div>
        <details className="mp-paste">
          <summary>Or paste the list</summary>
          <textarea className="textarea" rows={5} value={text} onChange={(e) => { setText(e.target.value); setFileName(null); setPicked({}); }} placeholder={'name,type,description\nACCT_NO,VARCHAR(20),Account number'} aria-label="Target field list as CSV" data-testid="map-import-text" />
        </details>
        {error && <p className="callout error" role="alert" data-testid="map-import-error">{error}</p>}
        {read && (
          <>
            <p data-testid="map-import-columns">
              {read.columns.name ? <>Read <strong>{read.fields.length}</strong> fields: names from “{read.columns.name}”{read.columns.type ? <>, types from “{read.columns.type}”</> : ', no type column'}{read.columns.description ? <>, descriptions from “{read.columns.description}”</> : ''}.</>
                : <>No heading was recognised, so each row’s first cell is read as a field name ({read.fields.length} fields).</>}
              {read.ignored.length > 0 && <> Not used: {read.ignored.map((h) => `“${h}”`).join(', ')}.</>}
            </p>
            {read.types.length > 0 && <p className="mp-small" data-testid="map-import-types">How the types are read: {read.types.map((t) => `${t.type} → ${TARGET_KIND_LABEL[t.readAs]}`).join('; ')}.</p>}
            {read.problems.length > 0 && <ul className="callout warning mp-problems">{read.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            <h3 className="section-title">Suggested matches <span className="chip count">{suggestions.length}</span></h3>
            {suggestions.length === 0 ? <p className="muted" data-testid="map-import-nosugg">No target field looks like a field of this document that is not mapped yet. You can still import the list and choose from it in the table.</p> : (
              <table className="table mp-table" data-testid="map-import-suggestions">
                <thead><tr><th scope="col">Use</th><th scope="col">Document field</th><th scope="col">Target field</th><th scope="col">How sure</th></tr></thead>
                <tbody>
                  {suggestions.map((s) => (
                    <tr key={s.path} data-testid="map-sugg-row" data-confidence={s.confidence} data-path={s.path}>
                      <td><input type="checkbox" checked={isOn(s.path, s.preselected)} onChange={(e) => setPicked((p) => ({ ...p, [s.path]: e.target.checked }))} aria-label={`Map ${labels.get(s.path) ?? s.path} to ${s.target}`} data-testid="map-sugg-use" /></td>
                      <td>{labels.get(s.path) ?? s.path}</td>
                      <td className="mono">{s.target}{s.targetType ? <span className="muted"> ({s.targetType})</span> : null}</td>
                      <td><span className={`chip ${s.confidence === 'guess' ? 'warning' : 'accent'}`}>{HOW[s.confidence]}</span> <span className="mp-small muted">{s.reason}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
