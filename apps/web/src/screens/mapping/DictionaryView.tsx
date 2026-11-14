import { useMemo, useState } from 'react';
import type { DataDictionary } from '@iss/scenarios';
import { Tech } from '../../ui/common';
import { TYPE_WORDS, exampleText, useWindow, ROW_HEIGHT } from './model';

type Field = DataDictionary['fields'][number];

/** Where a field is used, in a few words. */
function usedWords(f: Field): string {
  const u = f.usedIn;
  const parts = [
    u.rules.length ? `${u.rules.length} rule${u.rules.length === 1 ? '' : 's'}` : '',
    u.bindings.length ? u.bindings.slice(0, 2).join(', ') + (u.bindings.length > 2 ? ` and ${u.bindings.length - 2} more` : '') : '',
    u.tokens.length ? `wording in ${u.tokens.slice(0, 2).join(', ')}${u.tokens.length > 2 ? ` and ${u.tokens.length - 2} more` : ''}` : '',
    u.conditions.length ? `conditions on ${u.conditions.slice(0, 2).join(', ')}` : '',
    u.journey.length ? 'journey steps' : '',
    (u as { calculatedFields?: string[] }).calculatedFields?.length ? 'a calculation' : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : f.required ? 'Required by the data contract' : '—';
}

/** The document's data dictionary, the same function as the release package's data/dictionary.json. */
export function DictionaryView({ dict }: { dict: DataDictionary }) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const fields = useMemo(() => dict.fields.filter((f) => (all || f.needed) && (!q || `${f.label} ${f.path}`.toLowerCase().includes(q.toLowerCase()))), [dict, all, q]);
  const win = useWindow(fields.length);
  const shown = fields.slice(win.start, win.end);
  return (
    <div className="mp-dict" data-testid="map-dictionary">
      <div className="mp-toolbar">
        <p className="muted mp-lead">Every field this document reads, with its type, an example from a synthetic customer and where it is used. The same list is in each release package as <code>data/dictionary.json</code>.</p>
        <label className="mp-search"><span className="sr-only">Search fields</span><input className="input" type="search" placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)} data-testid="map-dict-search" /></label>
        <label className="mp-check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="map-dict-all" /> Every field the data may carry ({dict.fields.length})</label>
        <span className="chip count" data-testid="map-dict-count">{fields.length} field{fields.length === 1 ? '' : 's'}</span>
      </div>
      <div className="mp-scroll" ref={win.ref}>
        <table className="table mp-table" aria-label="Data dictionary">
          <thead><tr><th scope="col">Field</th><th scope="col">Type and format</th><th scope="col">Example (synthetic)</th><th scope="col">Where it is used</th><th scope="col">Calculated</th></tr></thead>
          <tbody>
            {win.before > 0 && <tr aria-hidden="true" style={{ height: win.before }} />}
            {shown.map((f) => {
              const calc = (f as { calculation?: { inWords: string } }).calculation;
              const from = (f as { calculatedFrom?: string[] }).calculatedFrom;
              return (
                <tr key={f.path} data-testid="map-dict-row" data-path={f.path} style={win.windowed ? { height: ROW_HEIGHT } : undefined}>
                  <td><strong>{f.label}</strong>{f.required && <span className="chip mp-req">Required</span>}<Tech><div className="mono mp-path">{f.path}</div></Tech></td>
                  <td><span>{TYPE_WORDS[f.type] ?? f.type}</span><div className="muted mp-small">{f.format}{f.allowedValues ? `: ${f.allowedValues.join(', ')}` : ''}</div></td>
                  <td className="mp-example">{exampleText(f.example, f.type)}</td>
                  <td className="mp-small">{usedWords(f)}</td>
                  <td className="mp-small">{f.calculated ? <><span className="chip info">Calculated</span> {calc?.inWords ?? (from?.length ? `From ${from.join(', ')}` : '')}</> : 'No'}</td>
                </tr>
              );
            })}
            {win.after > 0 && <tr aria-hidden="true" style={{ height: win.after }} />}
          </tbody>
        </table>
        {fields.length === 0 && <p className="muted" data-testid="map-dict-none">No field matches.</p>}
      </div>
    </div>
  );
}
