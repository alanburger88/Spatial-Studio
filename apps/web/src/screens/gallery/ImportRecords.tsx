import { useEffect, useMemo, useRef, useState } from 'react';
import { buildContext, DOCUMENT_TYPE_LABEL, getPath, parseCsv, projectFields, type DocumentType, type FieldDef, type Project, type SyntheticRecord } from '@iss/model';
import { matchColumns, type ColumnMatch } from '@iss/scenarios';
import { api, ApiFailure, type ImportResult } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import { Icon } from '../../ui/icons';

/** CSV template: every importable contract path for the document type plus one example row from a seeded record. */
function csvTemplate(fields: FieldDef[], example?: SyntheticRecord): string {
  const cols = fields.filter((f) => !f.derived && f.type !== 'array' && f.path !== 'documentType' && f.path !== 'recordId').map((f) => f.path);
  const header = ['recordId', ...cols];
  const q = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [header.join(',')];
  if (example) { const ctx = buildContext(example); lines.push(['EXAMPLE-1', ...cols.map((c) => q(getPath(ctx, c)))].join(',')); }
  return lines.join('\r\n') + '\r\n';
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const IGNORE = '';
const SOURCE_ID = '__recordId';

/** Best-effort automatic match of a CSV header to a data-contract path (exact path, label, or last path segment). */
function autoMatch(header: string, fields: FieldDef[]): string {
  const h = header.trim();
  if (/^record ?id$|^id$|^customer ?id$/i.test(h)) return SOURCE_ID;
  const exact = fields.find((f) => f.path === h); if (exact) return exact.path;
  const n = norm(h);
  const byLabel = fields.find((f) => norm(f.label) === n); if (byLabel) return byLabel.path;
  const byLeaf = fields.filter((f) => norm(f.path.split('.').slice(-1)[0]) === n); if (byLeaf.length === 1) return byLeaf[0].path;
  return IGNORE;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Import customers. From the gallery the person picks the kind of document and the project whose data fields apply; from a
 * project (`projectId`) the project is fixed. A document with its own data always stores them as that project's own
 * customers; for the two sample kinds they are shared unless "keep for this project only" is ticked.
 */
export function ImportDialog({ onClose, onDone, projectId }: { onClose: () => void; onDone: () => void; projectId?: string }) {
  const known = useStudio.getState().projects.find((p) => p.projectId === projectId);
  const [docType, setDocType] = useState<DocumentType>(known?.documentType ?? 'credit-statement');
  const [format, setFormat] = useState<'json' | 'csv'>('csv');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const projects = useStudio((st) => st.projects);
  const targets = projects.filter((p) => (projectId ? p.projectId === projectId : p.documentType === docType));
  const [targetId, setTargetId] = useState<string>('');
  const [projectOnly, setProjectOnly] = useState(false);
  const own = docType === 'custom';
  const [target, setTarget] = useState<Project | null>(null);
  useEffect(() => {
    const id = targetId && targets.some((t) => t.projectId === targetId) ? targetId : targets[0]?.projectId ?? '';
    if (id !== targetId) { setTargetId(id); return; }
    if (!id) { setTarget(null); return; }
    let live = true;
    api.project(id).then(({ project }) => { if (live) setTarget(project); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docType, targetId, projects]);
  const allFields = useMemo(() => projectFields(target ?? { documentType: docType }), [target, docType]);
  const fields = useMemo(() => allFields.filter((f) => !f.derived && f.path !== 'documentType' && f.path !== 'recordId'), [allFields]);
  const csvRows = useMemo(() => (format === 'csv' && text.trim() ? parseCsv(text) : []), [format, text]);
  const headers = csvRows[0] ?? [];
  const [mapping, setMapping] = useState<string[]>([]);
  // Assistant column matching (built-in): exact and likely matches are pre-selected; a guess is only offered, never applied silently.
  const matches: ColumnMatch[] = useMemo(() => (headers.length ? matchColumns(headers.map((h) => h.replace(/^\uFEFF/, '')), csvRows.slice(1, 26), target ?? { documentType: docType }) : []), [headers.join('\u0001'), csvRows, target, docType]);
  useEffect(() => {
    const usable = new Set(fields.filter((f) => f.type !== 'array').map((f) => f.path));
    setMapping(headers.map((h, i) => {
      const own = autoMatch(h.replace(/^\uFEFF/, ''), fields);
      if (own !== IGNORE) return own;
      const m = matches[i];
      return m?.path && usable.has(m.path) && (m.confidence === 'exact' || m.confidence === 'likely') ? m.path : IGNORE;
    }));
    setCheck(null);
    // Keyed by what the columns and fields ARE, not by object identity: the document is re-read in the background
    // (for example when the project list refreshes), and that must not throw away a match the person chose by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers.join('\u0001'), fields.map((f) => `${f.path}:${f.type}`).join('\u0001'), matches.map((m) => `${m.path ?? ''}:${m.confidence}`).join('\u0001')]);
  const downloadMapped = () => {
    const url = URL.createObjectURL(new Blob([mappedCsv()], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'customers-renamed.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const mapped = mapping.filter((m) => m !== IGNORE).length;
  const dupTargets = mapping.filter((m, i) => m && mapping.indexOf(m) !== i);
  const missingRequired = fields.filter((f) => f.required && f.type !== 'array' && !mapping.includes(f.path)).map((f) => f.label);
  /** Rewrites the CSV with mapped data-contract headers, dropping ignored columns. */
  const mappedCsv = () => {
    const keep = mapping.map((m, i) => [m, i] as const).filter(([m]) => m !== IGNORE);
    return csvRows.map((row, r) => keep.map(([m, i]) => csvCell(r === 0 ? (m === SOURCE_ID ? 'recordId' : m) : row[i] ?? '')).join(',')).join('\r\n') + '\r\n';
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name); setCheck(null); setErr(null);
    setFormat(/\.json$/i.test(f.name) ? 'json' : 'csv');
    setText(await f.text());
  };
  const call = async (dryRun: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.importRecords({ documentType: docType, format, data: format === 'csv' ? mappedCsv() : text, dryRun, projectId: targetId || undefined, ...(!own && projectOnly && targetId ? { scope: 'project' as const } : {}) });
      if (dryRun) setCheck(r);
      else {
        useStudio.getState().toast({ kind: r.rejected.length ? 'warning' : 'success', title: `Imported ${r.imported.length} record${r.imported.length === 1 ? '' : 's'}`, message: r.rejected.length ? `${r.rejected.length} row(s) were rejected.` : `${r.imported.map((x) => x.recordId).join(', ').slice(0, 120)}` });
        onDone();
      }
    } catch (e) { setErr(e instanceof ApiFailure ? e.message : String((e as Error).message ?? e)); setCheck(null); }
    finally { setBusy(false); }
  };
  const downloadTemplate = async () => {
    // A document with its own data has no shared sample to take an example row from.
    const { record } = own ? { record: undefined } : await fetch(`/api/v1/records/${docType === 'eob' ? 'EOB-0001' : 'CARD-0001'}`).then((r) => r.json()).catch(() => ({ record: undefined }));
    const blob = new Blob([csvTemplate(allFields, record)], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${docType}-import-template.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <Dialog title="Import scenario records" onClose={onClose} labelledBy="import-title"
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => call(true)} disabled={busy || !text.trim() || (own && !targetId) || (format === 'csv' && (!mapped || dupTargets.length > 0))} data-testid="import-check">Check file</button>
        <button className="btn primary" onClick={() => call(false)} disabled={busy || !check || !check.imported.length || (own && !targetId)} data-testid="import-commit">Import {check ? check.imported.length : ''} record{check?.imported.length === 1 ? '' : 's'}</button>
      </>}>
      <div className="imp">
        <p className="callout warning imp-warn"><strong>Use synthetic or anonymised data only.</strong> Imported records stay on this computer (the local <span className="mono">.data</span> folder) and are never sent to any external service.</p>
        {!projectId && (
          <div className="field">
            <span className="label">Document type</span>
            <div className="seg" role="group" aria-label="Document type">
              <button type="button" aria-pressed={docType === 'credit-statement'} onClick={() => { setDocType('credit-statement'); setCheck(null); }}>Credit-card statement</button>
              <button type="button" aria-pressed={docType === 'eob'} onClick={() => { setDocType('eob'); setCheck(null); }}>Healthcare EOB</button>
              <button type="button" aria-pressed={docType === 'custom'} onClick={() => { setDocType('custom'); setCheck(null); }} data-testid="import-type-custom">{DOCUMENT_TYPE_LABEL.custom}</button>
            </div>
          </div>
        )}
        {own && !targets.length && <p className="callout warning" data-testid="import-no-project">There is no project with your own data yet. Start one from New project → Blank project, then import its customers.</p>}
        <div className="field">
          <span className="label">File (.csv or .json)</span>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon.download style={{ transform: 'rotate(180deg)' }} /> Choose file…</button>
            <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
            <span className="muted">{fileName ?? 'No file chosen'}</span>
            <button type="button" className="btn ghost sm" onClick={downloadTemplate} style={{ marginLeft: 'auto' }}><Icon.download /> CSV template</button>
          </div>
          <span className="hint">CSV: any column names — you match them to data fields below (amounts in whole cents, dates YYYY-MM-DD). JSON: the same shape as the sample records.{own && ' For your own data, a JSON record carries its values under “custom” and a list as an array of rows; a CSV row cannot hold a list.'}</span>
        </div>
        <details className="imp-paste">
          <summary>…or paste data</summary>
          <div className="row" style={{ margin: '6px 0' }}>
            <div className="seg" role="group" aria-label="Pasted format">
              <button type="button" aria-pressed={format === 'csv'} onClick={() => { setFormat('csv'); setCheck(null); }}>CSV</button>
              <button type="button" aria-pressed={format === 'json'} onClick={() => { setFormat('json'); setCheck(null); }}>JSON</button>
            </div>
          </div>
          <textarea className="textarea mono" rows={6} value={text} onChange={(e) => { setText(e.target.value); setFileName(null); setCheck(null); }} aria-label="Pasted records" data-testid="import-text" />
        </details>
        {(own ? targets.length > 0 && !projectId : targets.length > 1 && !projectId) && (
          <div className="field">
            <label htmlFor="imp-target">{own ? 'Customers for' : 'Use data fields of'}</label>
            <select id="imp-target" className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="import-target">
              {targets.map((t) => <option key={t.projectId} value={t.projectId}>{t.title}</option>)}
            </select>
            <span className="hint">{own ? 'These customers belong to this project alone.' : <>Its custom fields can be imported too. Records are shared by every {docType === 'eob' ? 'EOB' : 'credit-card'} project{projectOnly ? ', unless you keep them for this project only' : ''}.</>}</span>
          </div>
        )}
        {!own && !!targetId && (
          <label className="np-check" data-testid="import-project-only-label"><input type="checkbox" checked={projectOnly} onChange={(e) => { setProjectOnly(e.target.checked); setCheck(null); }} data-testid="import-project-only" /> Keep these customers for {targets.find((t) => t.projectId === targetId)?.title ?? 'this project'} only</label>
        )}
        {format === 'csv' && headers.length > 0 && (
          <div className="imp-map" data-testid="import-mapping">
            <div className="row"><strong>Match columns</strong><span className="muted">{mapped} of {headers.length} columns used</span><span className="chip" title="Suggested by the studio from the column names and the first rows. No AI model was used.">Built-in matching</span><button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={downloadMapped} disabled={!mapped} data-testid="import-rename-download" title="Download this file with the column names replaced by the matched data fields; unmatched columns are left out"><Icon.download width={13} height={13} /> Rename columns and download</button></div>
            <div className="imp-map-scroll">
              <table className="table">
                <thead><tr><th>Your column</th><th>First value</th><th>Data field</th><th>Match</th></tr></thead>
                <tbody>
                  {headers.map((h, i) => (
                    <tr key={i}>
                      <td><strong>{h || <em className="faint">(blank)</em>}</strong></td>
                      <td className="faint imp-sample" title={csvRows[1]?.[i] ?? ''}>{csvRows[1]?.[i] ?? ''}</td>
                      <td>
                        <select className="select" value={mapping[i] ?? IGNORE} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Data field for column ${h}`} data-testid={`map-${i}`}>
                          <option value={IGNORE}>— Ignore —</option>
                          <option value={SOURCE_ID}>Your record ID (kept for reference)</option>
                          {fields.filter((f) => f.type !== 'array').map((f) => <option key={f.path} value={f.path}>{f.label}{f.path.startsWith('custom.') ? ' (custom)' : ''}</option>)}
                          {fields.filter((f) => f.type === 'array').map((f) => <option key={f.path} value={f.path}>{f.label} (list: JSON only)</option>)}
                        </select>
                      </td>
                      <td className="imp-match" data-testid={`match-${i}`} data-confidence={matches[i]?.confidence ?? 'none'}>
                        {(() => {
                          const m = matches[i];
                          const chosen = mapping[i] ?? IGNORE;
                          const label = (path: string) => fields.find((f) => f.path === path)?.label ?? path;
                          if (!m) return null;
                          const agrees = !!m.path && chosen === m.path;
                          return (
                            <>
                              {m.confidence === 'exact' && agrees && <span className="chip ok">Exact</span>}
                              {m.confidence === 'likely' && agrees && <span className="chip info">Likely</span>}
                              {m.confidence === 'guess' && <span className="chip warning">Guess</span>}
                              {(m.confidence === 'none' || (!agrees && m.confidence !== 'guess')) && chosen === IGNORE && <span className="chip">Not matched</span>}
                              {m.confidence === 'guess' && m.path && !agrees && <button type="button" className="btn sm ghost" onClick={() => setMapping((mm) => mm.map((x, j) => (j === i ? m.path! : x)))} data-testid={`match-use-${i}`}>Use “{label(m.path)}”</button>}
                              <span className="faint imp-match-why">{m.reason}</span>
                              {m.sampleProblem && agrees && <span className="imp-match-warn" data-testid={`match-problem-${i}`}>▲ {m.sampleProblem}</span>}
                            </>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {dupTargets.length > 0 && <p className="callout error">Two columns are matched to the same field. Each field can be used once.</p>}
            {missingRequired.length > 0 && <p className="callout warning">Not matched yet (required): {missingRequired.slice(0, 6).join(', ')}{missingRequired.length > 6 ? ` +${missingRequired.length - 6} more` : ''}. Rows without them will be rejected.</p>}
          </div>
        )}
        {err && <p className="callout error" role="alert" data-testid="import-error">{err}</p>}
        {check && (
          <div className="imp-result" data-testid="import-result" aria-live="polite">
            <p><span className="sev ok">✓ {check.imported.length} valid</span>{check.rejected.length > 0 && <> · <span className="sev blocking">{check.rejected.length} rejected</span></>} <span className="muted">of {check.total} row{check.total === 1 ? '' : 's'}</span></p>
            {check.scope === 'project' && check.imported.length > 0 && <p className="muted" data-testid="import-result-scope">They will belong to this project alone.</p>}
            {check.imported.length > 0 && <p className="muted">{check.imported[0].recordId ? `They will be added as ${check.imported[0].recordId}${check.imported.length > 1 ? ` – ${check.imported[check.imported.length - 1].recordId}` : ''}.` : 'They will get their own IDs when imported.'}</p>}
            {check.rejected.length > 0 && (
              <ul className="imp-rejects">
                {check.rejected.slice(0, 8).map((r) => <li key={r.row}><strong>Row {r.row}{r.sourceId ? ` (${r.sourceId})` : ''}</strong>: {r.errors.slice(0, 3).join(' ')}{r.errors.length > 3 ? ` (+${r.errors.length - 3} more)` : ''}</li>)}
                {check.rejected.length > 8 && <li className="muted">…and {check.rejected.length - 8} more rows.</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

