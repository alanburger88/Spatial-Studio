import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { checkTokens, toTranslationCsv, translationStatus, usageEntryFromResolution, type Locale, type TranslationRow, type TranslationUsageEntry } from '@iss/model';
import { resolve } from '@iss/resolver';
import { ScreenHeader, Loading, Empty, Tech } from '../ui/common';
import { fieldLabel, localeLabel } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useStudio } from '../state/store';
import { api } from '../api/client';
import './Translations.css';

const LOCALE: Locale = 'es-US';
type StatusFilter = 'all' | 'missing' | 'draft' | 'approved';
const STATUS_LABEL = { approved: 'Approved', draft: 'Draft', missing: 'Missing' } as const;
const STATUS_GLYPH = { approved: '✓', draft: '✎', missing: '○' } as const;
const USED_LABEL: Record<string, string> = { variant: 'Variant text', disclosure: 'Disclosure', section: 'Conditional section', node: 'Document text', required: 'Required by rule' };

const tok = (t: string) => `{{${t}}}`;

/** English source with data tokens shown as small chips: the field's label in Business view, the path in Technical view / tooltip. */
function Highlighted({ text }: { text: string }) {
  const project = useStudio((s) => s.project);
  const technical = useStudio((s) => s.viewMode) === 'technical';
  const parts = text.split(/(\{\{\s*[\w.]+\s*\}\})/g);
  return <>{parts.map((p, i) => {
    if (!/^\{\{/.test(p)) return <Fragment key={i}>{p}</Fragment>;
    const path = p.replace(/[{}\s]/g, '');
    const label = project ? fieldLabel(project, path) : path;
    return <mark className="tr-token" key={i} data-token={p} title={technical ? `Shows the value of ${label}` : path}>{technical ? p : label}</mark>;
  })}</>;
}

export function Translations() {
  const { project: projectId } = useParams();
  const navigate = useNavigate();
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const technical = useStudio((s) => s.viewMode) === 'technical';

  const [status, setStatus] = useState<StatusFilter>('all');
  const [mandatoryOnly, setMandatoryOnly] = useState(false);
  const [q, setQ] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [importMsg, setImportMsg] = useState<null | { drafts: number; skipped: number; rows: number; errors: Array<{ row: number; partId: string; message: string }>; fileName: string }>(null);
  const [busy, setBusy] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { Object.values(timers.current).forEach(clearTimeout); }, []);

  // What the real resolver shows each synthetic record. Drafts and approvals never change selection, so only structure invalidates this.
  const usage = useMemo<TranslationUsageEntry[] | undefined>(() => {
    if (!project || !records.length) return undefined;
    return records.filter((r) => r.documentType === project.documentType).map((record) => usageEntryFromResolution(project, record, resolve({ project, record }) as any));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.rules, project?.nodes, project?.journey, project?.contentParts.length, records]);

  const st = useMemo(() => (project ? translationStatus(project, LOCALE, usage) : null), [project, usage]);

  if (!project || !st) return <section className="screen" data-testid="translations-view"><Loading label="Loading content…" /></section>;

  const s = st.summary;
  const valueOf = (r: TranslationRow) => edits[r.partId] ?? r.status.draftText ?? r.status.approvedText ?? '';
  const dirty = (r: TranslationRow) => edits[r.partId] !== undefined && edits[r.partId] !== (r.status.draftText ?? r.status.approvedText ?? '');
  const needle = q.trim().toLowerCase();
  const rows = st.rows.filter((r) => {
    if (status !== 'all' && r.status.status !== status) return false;
    if (mandatoryOnly && !r.status.mandatory) return false;
    if (needle && !`${r.title} ${r.partId} ${r.sourceText} ${r.status.draftText ?? ''} ${r.status.approvedText ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });

  const clearEdit = (id: string) => setEdits((e) => { const n = { ...e }; delete n[id]; return n; });
  const setErr = (id: string, msg: string | null) => setErrors((e) => { const n = { ...e }; if (msg) n[id] = msg; else delete n[id]; return n; });

  const stopTimer = (id: string) => { if (timers.current[id]) { clearTimeout(timers.current[id]); delete timers.current[id]; } };
  const saveDraft = (r: TranslationRow, quiet = false, textOverride?: string): boolean => {
    stopTimer(r.partId);
    const text = textOverride ?? valueOf(r);
    const res = useStudio.getState().dispatch({ type: 'SET_TRANSLATION_DRAFT', partId: r.partId, locale: LOCALE, text: text.trim() ? text : null });
    if (!res.ok) { setErr(r.partId, res.message); return false; }
    if (!quiet) setErr(r.partId, null);
    clearEdit(r.partId);
    if (text.trim()) setSaved((x) => ({ ...x, [r.partId]: true }));
    return true;
  };
  /** Autosave: when the box loses focus or typing pauses for ~1 s, store the text as a draft (same command as the old Save draft). */
  const autosave = (r: TranslationRow, text: string) => {
    if (text === (r.status.draftText ?? r.status.approvedText ?? '')) { stopTimer(r.partId); clearEdit(r.partId); return; }
    saveDraft(r, false, text);
  };
  const approve = (r: TranslationRow) => {
    const st0 = useStudio.getState();
    stopTimer(r.partId);
    if (dirty(r) && !saveDraft(r, true)) return;
    const res = st0.dispatch({ type: 'APPROVE_TRANSLATION', partId: r.partId, locale: LOCALE });
    if (!res.ok) { setErr(r.partId, res.message); return; }
    setErr(r.partId, null); clearEdit(r.partId);
  };
  const discard = (r: TranslationRow) => {
    if (r.status.draftText) useStudio.getState().dispatch({ type: 'SET_TRANSLATION_DRAFT', partId: r.partId, locale: LOCALE, text: null });
    stopTimer(r.partId); clearEdit(r.partId); setErr(r.partId, null); setSaved((x) => ({ ...x, [r.partId]: false }));
  };
  const insertTokens = (r: TranslationRow, missing: string[]) => {
    const cur = valueOf(r);
    setEdits((e) => ({ ...e, [r.partId]: `${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${missing.map(tok).join(' ')}` }));
  };

  const exportCsv = () => {
    const csv = toTranslationCsv(project, LOCALE, usage);
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${project.projectId}-translations-${LOCALE}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const csv = await file.text();
      const r = await api.importTranslations(project.projectId, { locale: LOCALE, csv, project });
      let applied = 0;
      const errs = [...r.errors];
      for (const d of r.drafts) {
        const res = useStudio.getState().dispatch({ type: 'SET_TRANSLATION_DRAFT', partId: d.partId, locale: LOCALE, text: d.text });
        if (res.ok) applied++; else errs.push({ row: 0, partId: d.partId, code: 'REJECTED', message: res.message });
      }
      setEdits({});
      setImportMsg({ drafts: applied, skipped: r.skipped, rows: r.rows, errors: errs, fileName: file.name });
    } catch (e: any) {
      setImportMsg({ drafts: 0, skipped: 0, rows: 0, errors: [{ row: 0, partId: '', message: e?.message ?? 'Import failed.' }], fileName: file.name });
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const seeInContext = (r: TranslationRow) => {
    const st1 = useStudio.getState();
    const sees = usage?.filter((u) => u.locale === LOCALE && u.partIds.includes(r.partId)) ?? [];
    const rec = sees[0]?.recordId ?? usage?.find((u) => u.locale === LOCALE)?.recordId ?? records.find((x) => (x.customer as any)?.locale === LOCALE)?.recordId;
    if (rec) st1.setRecord(rec);
    const node = r.nodeIds.find((id) => project.nodes.some((n) => n.id === id)) ?? null;
    st1.select(node, r.usedAs.includes('variant') ? r.partId : null);
    navigate(`/studio/${projectId ?? project.projectId}/design`);
  };

  const req = technical ? 'mandatory' : 'required';
  const Req = technical ? 'Mandatory' : 'Required';
  const pct = s.total ? Math.round((s.approved / s.total) * 100) : 0;
  const hasEs = records.some((r) => (r.customer as any)?.locale === LOCALE);

  return (
    <section className="screen" data-testid="translations-view">
      <ScreenHeader
        id="S13"
        title="Content & Translations"
        subtitle="Every approved text the document uses, with its Spanish translation status. Only approved translations are ever shown to customers; runtime machine translation is not permitted."
      />
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden data-testid="tr-import-file" aria-label="Choose a translations CSV file" onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="screen-body tr-body">
        <div className="tr-summary" data-testid="tr-summary" role="status">
          <div className="tr-summary-text">
            <strong>{localeLabel(LOCALE)}{technical && <> <span className="chip code">{LOCALE}</span></>}: {s.approved} of {s.total} approved</strong>
            {s.drafts > 0 && <span> · {s.drafts} {s.drafts === 1 ? 'draft' : 'drafts'} waiting for approval</span>}
            {s.mandatoryMissing > 0 && <span> · {s.mandatoryMissing} {req} still missing</span>}
            {s.usageKnown && s.mandatoryMissing > 0 && <span className={`tr-affects${s.affectedRecords ? ' bad' : ''}`}> · {s.affectedRecords ? <>{s.affectedRecords} synthetic Spanish-speaking {s.affectedRecords === 1 ? 'customer is' : 'customers are'} blocked until they are</> : <>no synthetic Spanish-speaking customers are affected</>}</span>}
            {s.mandatoryMissing === 0 && s.usageKnown && <span className="tr-affects ok"> · ✓ All {req} text is approved{hasEs ? ' for synthetic Spanish-speaking customers' : ''}</span>}
            <button className="btn sm tr-only-req" onClick={() => { setMandatoryOnly(true); setStatus('all'); }} aria-pressed={mandatoryOnly} hidden={!s.mandatoryMissing || mandatoryOnly}>Show {req} only</button>
          </div>
          <div className="tr-bar" role="progressbar" aria-label={`${localeLabel(LOCALE)} texts approved`} aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.approved} aria-valuetext={`${s.approved} of ${s.total} approved`}>
            <span className="tr-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {importMsg && (
          <div className={`callout ${importMsg.errors.length ? 'warning' : 'accent'} tr-import-result`} data-testid="tr-import-result" role="status">
            <div className="tr-import-head">
              <strong>Imported “{importMsg.fileName}”: {importMsg.drafts} {importMsg.drafts === 1 ? 'draft' : 'drafts'} created, {importMsg.errors.length} {importMsg.errors.length === 1 ? 'error' : 'errors'}, {importMsg.skipped} skipped.</strong>
              <button className="btn sm ghost" onClick={() => setImportMsg(null)} aria-label="Dismiss import result"><Icon.close width={12} height={12} /></button>
            </div>
            <span>Imported rows are drafts only; review and approve each one. Undo reverts them one at a time.</span>
            {importMsg.errors.length > 0 && <ul className="tr-import-errors">{importMsg.errors.slice(0, 8).map((e, i) => <li key={i}>{e.row ? `Row ${e.row}` : 'File'}{e.partId ? ` · ${e.partId}` : ''}: {e.message}</li>)}{importMsg.errors.length > 8 && <li>…and {importMsg.errors.length - 8} more.</li>}</ul>}
          </div>
        )}

        <div className="tr-filters" role="group" aria-label="Translation filters">
          <span className="segmented" role="group" aria-label="Status">
            {(['all', 'missing', 'draft', 'approved'] as const).map((k) => (
              <button key={k} aria-pressed={status === k} onClick={() => setStatus(k)} data-testid={`tr-filter-${k}`}>{k === 'all' ? `All ${s.total}` : `${STATUS_LABEL[k]} ${k === 'missing' ? s.missing : k === 'draft' ? s.drafts : s.approved}`}</button>
            ))}
          </span>
          <label className="tr-check"><input type="checkbox" checked={mandatoryOnly} onChange={(e) => setMandatoryOnly(e.target.checked)} data-testid="tr-filter-mandatory" /> {Req} only</label>
          <label className="tr-search"><span className="sr-only">Search texts</span><input className="input" type="search" placeholder="Search texts" value={q} onChange={(e) => setQ(e.target.value)} data-testid="tr-search" /></label>
          <span className="tr-io">
            <button className="btn sm" onClick={exportCsv} data-testid="tr-export"><Icon.download width={14} height={14} /> Export for translators (CSV)</button>
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="tr-import">Import translations (CSV)</button>
          </span>
          <span className="muted tr-count">{rows.length} of {s.total} texts</span>
        </div>

        <div className="panel tr-table-panel">
          <div className="tr-scroll">
            {rows.length === 0 ? <Empty title="No matching text" message="Change the filters to see more content parts." /> : (
              <table className="table tr-table" data-testid="tr-table">
                <caption className="sr-only">Content parts with English source text, Spanish translation editor and status</caption>
                <thead><tr><th scope="col">English (source, read-only)</th><th scope="col">{localeLabel(LOCALE)}{technical ? ` (${LOCALE})` : ''}</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const val = valueOf(r);
                    const tc = val.trim() ? checkTokens(r.sourceText, val) : { ok: true, missing: [] as string[], extra: [] as string[] };
                    const err = errors[r.partId];
                    const d = dirty(r);
                    const active = focusId === r.partId || d || !!r.status.draftText || !!err;
                    const canApprove = !!val.trim() && (r.status.pendingDraft || d || r.status.status === 'draft');
                    return (
                      <tr key={r.partId} data-testid="tr-row" data-part={r.partId} data-status={r.status.status} data-mandatory={r.status.mandatory ? 'true' : 'false'}>
                        <td className="tr-src">
                          <div className="tr-title">
                            <strong title={r.title}>{r.title}</strong>
                            {r.status.mandatory && <span className="chip error tr-mand" title={r.status.mandatoryReasons.join('; ')} data-testid="tr-mandatory">{Req}</span>}
                            <Tech><span className="chip code" title="Content part id and version">{r.partId} · v{r.version}</span></Tech>
                          </div>
                          <p className="tr-en" lang="en-US"><Highlighted text={r.sourceText} /></p>
                          <div className="tr-meta">
                            <span>{USED_LABEL[r.usedAs[0]] ?? 'Document text'}</span>
                            {r.seenByRecords !== null && <span>Seen by {r.seenByRecords} synthetic {r.seenByRecords === 1 ? 'record' : 'records'}</span>}
                            {r.status.affectedRecordIds.length > 0 && <span className="tr-warn">▲ Blocks {r.status.affectedRecordIds.length} synthetic Spanish-speaking {r.status.affectedRecordIds.length === 1 ? 'customer' : 'customers'}</span>}
                          </div>
                        </td>
                        <td className="tr-edit">
                          <textarea className="textarea tr-input" lang="es-US" rows={2} value={val} placeholder="Escribe la traducción…" aria-label={`Spanish translation of ${r.title}`} data-testid="tr-draft-input"
                            onFocus={() => setFocusId(r.partId)}
                            onBlur={(e) => { setFocusId((f) => (f === r.partId ? null : f)); autosave(r, e.target.value); }}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEdits((x) => ({ ...x, [r.partId]: v })); setErr(r.partId, null); setSaved((x) => ({ ...x, [r.partId]: false }));
                              stopTimer(r.partId);
                              timers.current[r.partId] = setTimeout(() => autosave(r, v), 1000);
                            }} />
                          {!tc.ok && (
                            <div className="tr-tokenerr" role="alert" data-testid="tr-token-warning">
                              ▲ {tc.missing.length > 0 && <>Missing {tc.missing.map((t) => <code key={t}>{tok(t)}</code>)} </>}{tc.extra.length > 0 && <>Unexpected {tc.extra.map((t) => <code key={t}>{tok(t)}</code>)} </>}
                              {tc.missing.length > 0 && <button className="btn sm" onClick={() => insertTokens(r, tc.missing)} data-testid="tr-insert-tokens">Insert missing tokens</button>}
                            </div>
                          )}
                          {err && <div className="tr-error" role="alert" data-testid="tr-error">■ {err}</div>}
                        </td>
                        <td className="tr-status-td">
                          <span className={`chip tr-status ${r.status.status === 'approved' ? 'accent' : r.status.status === 'draft' ? 'warning' : 'error'}`} data-testid="tr-status" data-status={r.status.status}><span aria-hidden="true">{STATUS_GLYPH[r.status.status]}</span> {STATUS_LABEL[r.status.status]}</span>
                          {r.status.status === 'approved' && r.status.pendingDraft && <span className="tr-pending">+ unapproved edit</span>}
                          <span className="tr-pending tr-saved" data-testid="tr-saved" aria-live="polite">{d ? 'Saving…' : saved[r.partId] && r.status.draftText ? 'Draft saved' : ''}</span>
                          {active && (
                            <span className="tr-actions">
                              <button className="btn sm primary" onClick={() => approve(r)} disabled={!canApprove} data-testid="tr-approve">Approve</button>
                              <button className="btn sm ghost" onClick={() => discard(r)} disabled={!r.status.draftText && !d} data-testid="tr-discard">Discard draft</button>
                            </span>
                          )}
                          <button className="btn sm ghost tr-ctx" onClick={() => seeInContext(r)} disabled={!hasEs} data-testid="tr-context" title={hasEs ? 'Open 2D Design with a Spanish-language synthetic record' : 'No Spanish-language synthetic record is available'}>See in context <Icon.external width={12} height={12} /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
