import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AVAILABLE_LANGUAGES, checkTokens, languageName, languageShortName, projectLanguages, toTranslationCsv, translationStatus, usageEntryFromResolution, type TranslationRow, type TranslationUsageEntry } from '@iss/model';
import { resolve } from '@iss/resolver';
import { ScreenHeader, Loading, Empty, Tech, Dialog } from '../ui/common';
import { fieldLabel, localeLabel } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useStudio, setPreviewLanguage } from '../state/store';
import { api } from '../api/client';
import './Translations.css';

type StatusFilter = 'all' | 'missing' | 'draft' | 'approved';
type GroupFilter = 'all' | 'messages' | 'labels' | 'channels';
type GroupKey = Exclude<GroupFilter, 'all'>;
const STATUS_LABEL = { approved: 'Approved', draft: 'Draft', missing: 'Missing' } as const;
const STATUS_GLYPH = { approved: '✓', draft: '✎', missing: '○' } as const;
const USED_LABEL: Record<string, string> = { variant: 'Variant text', disclosure: 'Disclosure', section: 'Conditional section', node: 'Document text', required: 'Required by rule' };
const GROUPS: Array<{ key: GroupKey; label: string; testid: string }> = [
  { key: 'messages', label: 'Messages & disclosures', testid: 'tr-group-messages' },
  { key: 'labels', label: 'Labels & headings', testid: 'tr-group-labels' },
  { key: 'channels', label: 'Email & SMS', testid: 'tr-group-channels' },
];
const groupOf = (r: TranslationRow): GroupKey => r.group ?? 'messages';
const groupLabel = (g: GroupKey) => GROUPS.find((x) => x.key === g)!.label;
/** "Spanish (US)" for the sample language (kept as before), the built-in name for every other one. */
const langLabel = (c: string) => (c === 'es-US' ? localeLabel(c) : languageName(c));
const langKey = (projectId: string) => `iss.tr.lang.${projectId}`;
const readLang = (projectId: string): string | null => { try { return localStorage.getItem(langKey(projectId)); } catch { return null; } };
const writeLang = (projectId: string, code: string) => { try { localStorage.setItem(langKey(projectId), code); } catch { /* remembering the choice is optional */ } };

type TranslateResponse = Awaited<ReturnType<typeof api.translate>>;
interface AiResult extends TranslateResponse { applied: number; forLocale: string }

const tok = (t: string) => `{{${t}}}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

function AddLanguageDialog({ existing, onPick, onClose }: { existing: string[]; onPick: (code: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const options = AVAILABLE_LANGUAGES.filter((l) => !existing.includes(l.code) && (!needle || `${l.name} ${l.endonym} ${l.code}`.toLowerCase().includes(needle)));
  return (
    <Dialog title="Add a language" onClose={onClose} labelledBy="tr-add-language-title">
      <div className="tr-addlang" data-testid="tr-add-language-dialog">
        <p className="muted tr-addlang-note">Pick a language to translate into. Only left-to-right languages are offered. Nothing is translated until you ask for a draft or type one.</p>
        <label className="tr-search"><span className="sr-only">Search languages</span>
          <input className="input" type="search" placeholder="Search by name, native name or code" value={q} onChange={(e) => setQ(e.target.value)} data-testid="tr-language-search" autoFocus />
        </label>
        <div className="list-rows tr-langlist" role="list">
          {options.length === 0 && <p className="muted tr-addlang-empty">No language matches “{q}”.</p>}
          {options.map((l) => (
            <button key={l.code} type="button" role="listitem" className="tr-langopt" onClick={() => onPick(l.code)} data-testid="tr-language-option" data-code={l.code}>
              <span><strong>{l.name}</strong>{l.endonym !== l.name && <span className="muted"> · {l.endonym}</span>}</span>
              <span className="chip code">{l.code}</span>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

export function Translations() {
  const { project: projectId } = useParams();
  const navigate = useNavigate();
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const technical = useStudio((s) => s.viewMode) === 'technical';

  const langs = project ? projectLanguages(project) : [];
  const [pref, setPref] = useState<string | null>(() => (projectId ? readLang(projectId) : null));
  const LOCALE: string = pref && langs.includes(pref) ? pref : langs[0] ?? '';

  const [status, setStatus] = useState<StatusFilter>('all');
  const [group, setGroup] = useState<GroupFilter>('all');
  const [mandatoryOnly, setMandatoryOnly] = useState(false);
  const [q, setQ] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [importMsg, setImportMsg] = useState<null | { drafts: number; skipped: number; rows: number; errors: Array<{ row: number; partId: string; message: string }>; fileName: string }>(null);
  const [busy, setBusy] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [aiBusy, setAiBusy] = useState<string | null>(null); // 'all' or the id of the row being drafted
  const [aiResult, setAiResult] = useState<AiResult | null>(null);
  const [aiStatus, setAiStatus] = useState<{ mode: 'external' | 'offline'; label: string; model?: string } | null>(null);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'add' | 'remove' | 'approve'>(null);
  const [langError, setLangError] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { Object.values(timers.current).forEach(clearTimeout); }, []);
  useEffect(() => { api.assistantStatus().then(setAiStatus).catch(() => setAiStatus(null)); }, []);
  // Switching language: nothing typed for the previous language may leak into the next one.
  useEffect(() => {
    Object.values(timers.current).forEach(clearTimeout); timers.current = {};
    setEdits({}); setErrors({}); setSaved({}); setAiResult(null); setFocusId(null); setLangError(null);
  }, [LOCALE]);

  // What the real resolver shows each synthetic record. Drafts and approvals never change selection, so only structure invalidates this.
  const usage = useMemo<TranslationUsageEntry[] | undefined>(() => {
    if (!project || !records.length) return undefined;
    return records.filter((r) => r.documentType === project.documentType).map((record) => usageEntryFromResolution(project, record, resolve({ project, record }) as any));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.rules, project?.nodes, project?.journey, project?.contentParts.length, records]);

  const st = useMemo(() => (project && LOCALE ? translationStatus(project, LOCALE, usage) : null), [project, usage, LOCALE]);

  if (!project) return <section className="screen" data-testid="translations-view"><Loading label="Loading content…" /></section>;

  const dispatch = useStudio.getState().dispatch;
  const chooseLanguage = (code: string) => { setPref(code); writeLang(project.projectId, code); };

  const addLanguage = (code: string) => {
    const res = dispatch({ type: 'ADD_LANGUAGE', locale: code });
    if (!res.ok) { setLangError(res.message); setDialog(null); return; }
    setDialog(null); chooseLanguage(code);
  };
  const removeLanguage = () => {
    const res = dispatch({ type: 'REMOVE_LANGUAGE', locale: LOCALE });
    setDialog(null);
    if (!res.ok) { setLangError(res.message); return; }
    setLangError(null);
  };

  const languageBar = (
    <div className="tr-langbar" data-testid="tr-language-bar">
      <div className="tr-tabs" role="tablist" aria-label="Languages">
        {langs.map((c) => (
          <button key={c} role="tab" aria-selected={c === LOCALE} className="tr-tab" onClick={() => chooseLanguage(c)} data-testid={`tr-lang-${c}`} title={technical ? c : undefined}>
            {langLabel(c)}{technical && <span className="chip code">{c}</span>}
          </button>
        ))}
      </div>
      <button className="btn sm" onClick={() => setDialog('add')} data-testid="tr-add-language"><Icon.plus width={14} height={14} /> Add language</button>
      {LOCALE && <button className="btn sm ghost" onClick={() => setDialog('remove')} data-testid="tr-remove-language" title={`Remove ${langLabel(LOCALE)} from this project`}>Remove {languageShortName(LOCALE)}</button>}
      <span className="muted tr-langnote">English is the source language.</span>
    </div>
  );

  const dialogs = (
    <>
      {dialog === 'add' && <AddLanguageDialog existing={langs} onPick={addLanguage} onClose={() => setDialog(null)} />}
      {dialog === 'remove' && LOCALE && (
        <Dialog title={`Remove ${langLabel(LOCALE)}?`} onClose={() => setDialog(null)} labelledBy="tr-remove-title"
          footer={<><button className="btn" onClick={() => setDialog(null)} data-testid="tr-remove-language-cancel">Keep language</button><button className="btn danger" onClick={removeLanguage} data-testid="tr-remove-language-confirm">Remove {languageShortName(LOCALE)}</button></>}>
          <p>The language leaves this project’s list, so customers can no longer be sent a document in it.</p>
          <p className="muted">Translations you have already written are kept and come back if you add {languageShortName(LOCALE)} again.</p>
        </Dialog>
      )}
    </>
  );

  if (!LOCALE || !st) {
    return (
      <section className="screen" data-testid="translations-view">
        <ScreenHeader id="S13" title="Content & Translations" subtitle="Every approved text the document uses, with its translation status per language. Only approved translations are ever shown to customers; runtime machine translation is not permitted." />
        <div className="screen-body tr-body">
          {languageBar}
          {langError && <div className="callout warning" role="alert" data-testid="tr-language-error">{langError}</div>}
          <Empty title="No target language yet" message="Add a language to start translating the English text." />
        </div>
        {dialogs}
      </section>
    );
  }

  const s = st.summary;
  const langShort = languageShortName(LOCALE);
  const valueOf = (r: TranslationRow) => edits[r.partId] ?? r.status.draftText ?? r.status.approvedText ?? '';
  const dirty = (r: TranslationRow) => edits[r.partId] !== undefined && edits[r.partId] !== (r.status.draftText ?? r.status.approvedText ?? '');
  const needle = q.trim().toLowerCase();
  const groupCount = (g: GroupKey) => st.rows.filter((r) => groupOf(r) === g).length;
  const rank = (r: TranslationRow) => GROUPS.findIndex((g) => g.key === groupOf(r));
  const rows = st.rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r).filter((r) => {
    if (group !== 'all' && groupOf(r) !== group) return false;
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
    // A person's text never carries an origin: that is what removes the "AI draft" / "Sample draft" mark.
    const res = dispatch({ type: 'SET_TRANSLATION_DRAFT', partId: r.partId, locale: LOCALE, text: text.trim() ? text : null });
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
    stopTimer(r.partId);
    if (dirty(r) && !saveDraft(r, true)) return;
    const res = dispatch({ type: 'APPROVE_TRANSLATION', partId: r.partId, locale: LOCALE });
    if (!res.ok) { setErr(r.partId, res.message); return; }
    setErr(r.partId, null); clearEdit(r.partId);
  };
  const discard = (r: TranslationRow) => {
    if (r.status.draftText) dispatch({ type: 'SET_TRANSLATION_DRAFT', partId: r.partId, locale: LOCALE, text: null });
    stopTimer(r.partId); clearEdit(r.partId); setErr(r.partId, null); setSaved((x) => ({ ...x, [r.partId]: false }));
  };
  const insertTokens = (r: TranslationRow, missing: string[]) => {
    const cur = valueOf(r);
    setEdits((e) => ({ ...e, [r.partId]: `${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${missing.map(tok).join(' ')}` }));
  };

  /** AI first pass (or the bundled sample drafts): only ever saves drafts; a person reviews and approves. */
  const runTranslate = async (ids?: string[]) => {
    if (aiBusy) return;
    const forLocale = LOCALE;
    setAiBusy(ids ? ids[0] : 'all');
    try {
      const r = await api.translate(project.projectId, { locale: forLocale, ...(ids ? { ids } : {}), project });
      setLastProvider(r.providerStatus);
      let applied = 0;
      if (r.mode !== 'unavailable' && r.drafts.length) {
        const res = dispatch({ type: 'SET_TRANSLATION_DRAFTS', locale: forLocale, items: r.drafts.map((d) => ({ id: d.id, text: d.text })), origin: r.mode });
        if (res.ok) {
          applied = r.drafts.length;
          for (const d of r.drafts) { stopTimer(d.id); clearEdit(d.id); setErr(d.id, null); }
        }
      }
      setAiResult({ ...r, applied, forLocale });
    } catch (e: any) {
      useStudio.getState().toast({ kind: 'error', title: 'Could not draft translations', message: e?.message ?? 'The translation request failed.' });
      setAiResult(null);
    } finally { setAiBusy(null); }
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
        const res = dispatch({ type: 'SET_TRANSLATION_DRAFT', partId: d.partId, locale: LOCALE, text: d.text });
        if (res.ok) applied++; else errs.push({ row: 0, partId: d.partId, code: 'REJECTED', message: res.message });
      }
      setEdits({});
      setImportMsg({ drafts: applied, skipped: r.skipped, rows: r.rows, errors: errs, fileName: file.name });
    } catch (e: any) {
      setImportMsg({ drafts: 0, skipped: 0, rows: 0, errors: [{ row: 0, partId: '', message: e?.message ?? 'Import failed.' }], fileName: file.name });
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const hasLocaleRecord = records.some((r) => (r.customer as any)?.locale === LOCALE);
  const seeInContext = (r: TranslationRow) => {
    const st1 = useStudio.getState();
    const sees = usage?.filter((u) => u.locale === LOCALE && u.partIds.includes(r.partId)) ?? [];
    const rec = sees[0]?.recordId ?? usage?.find((u) => u.locale === LOCALE)?.recordId ?? records.find((x) => (x.customer as any)?.locale === LOCALE)?.recordId;
    if (rec) st1.setRecord(rec); else setPreviewLanguage(LOCALE);
    const node = r.nodeIds.find((id) => project.nodes.some((n) => n.id === id)) ?? null;
    st1.select(node, r.usedAs.includes('variant') && r.kind !== 'string' ? r.partId : null);
    navigate(`/studio/${projectId ?? project.projectId}/design`);
  };
  const previewInLanguage = () => {
    setPreviewLanguage(LOCALE);
    navigate(`/studio/${projectId ?? project.projectId}/outputs`);
  };

  // Drafts a person can approve in one go: stored drafts whose data fields match English.
  const draftRows = st.rows.filter((r) => r.status.draftText?.trim() && (r.status.status === 'draft' || r.status.pendingDraft));
  const approvable = draftRows.filter((r) => r.status.tokenCheck.ok);
  const approvableUntouched = approvable.filter((r) => r.origin).length;
  const blockedDrafts = draftRows.length - approvable.length;
  const approveAll = () => {
    Object.keys(timers.current).forEach(stopTimer);
    const res = dispatch({ type: 'APPROVE_TRANSLATIONS', locale: LOCALE, ids: approvable.map((r) => r.partId) });
    setDialog(null);
    if (res.ok) { setEdits({}); setErrors({}); } else setLangError(res.message);
  };

  const req = technical ? 'mandatory' : 'required';
  const Req = technical ? 'Mandatory' : 'Required';
  const pct = s.total ? Math.round((s.approved / s.total) * 100) : 0;
  const missingNow = st.rows.filter((r) => r.status.status === 'missing').length;
  const liveOn = aiStatus ? aiStatus.mode === 'external' : lastProvider ? /live|external|ready|ok/i.test(lastProvider) && !/no |not |off|unavail/i.test(lastProvider) : null;

  let lastGroup: GroupKey | null = null;

  return (
    <section className="screen" data-testid="translations-view">
      <ScreenHeader
        id="S13"
        title="Content & Translations"
        subtitle="Every text a customer reads, with its translation status per language. An AI first pass or the bundled sample drafts only ever create drafts: a person edits and approves them. Only approved translations are shown to customers; runtime machine translation is not permitted."
      />
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden data-testid="tr-import-file" aria-label="Choose a translations CSV file" onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="screen-body tr-body">
        {languageBar}
        {langError && <div className="callout warning tr-langerror" role="alert" data-testid="tr-language-error">{langError} <button className="btn sm ghost" onClick={() => setLangError(null)} aria-label="Dismiss message"><Icon.close width={12} height={12} /></button></div>}

        <div className="tr-summary" data-testid="tr-summary" role="status">
          <div className="tr-summary-text">
            <strong>{langLabel(LOCALE)}{technical && <> <span className="chip code">{LOCALE}</span></>}: {s.approved} of {s.total} approved</strong>
            {s.drafts > 0 && <span> · {s.drafts} {s.drafts === 1 ? 'draft' : 'drafts'} waiting for approval</span>}
            {s.mandatoryMissing > 0 && <span> · {s.mandatoryMissing} {req} still missing</span>}
            {s.usageKnown && s.mandatoryMissing > 0 && <span className={`tr-affects${s.affectedRecords ? ' bad' : ''}`}> · {s.affectedRecords ? <>{s.affectedRecords} synthetic {langShort}-speaking {s.affectedRecords === 1 ? 'customer is' : 'customers are'} blocked until they are</> : <>no synthetic {langShort}-speaking customers are affected</>}</span>}
            {s.mandatoryMissing === 0 && s.usageKnown && <span className="tr-affects ok"> · ✓ All {req} text is approved{hasLocaleRecord ? ` for synthetic ${langShort}-speaking customers` : ''}</span>}
            <button className="btn sm tr-only-req" onClick={() => { setMandatoryOnly(true); setStatus('all'); }} aria-pressed={mandatoryOnly} hidden={!s.mandatoryMissing || mandatoryOnly}>Show {req} only</button>
          </div>
          <div className="tr-bar" role="progressbar" aria-label={`${langLabel(LOCALE)} texts approved`} aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.approved} aria-valuetext={`${s.approved} of ${s.total} approved`}>
            <span className="tr-bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div className="tr-ai" data-testid="tr-ai">
          <div className="tr-ai-actions">
            <button className="btn primary" onClick={() => runTranslate()} disabled={!!aiBusy} aria-busy={aiBusy === 'all'} data-testid="tr-ai-draft-all">
              {aiBusy === 'all' ? <><span className="spinner" aria-hidden="true" /> Drafting…</> : <><Icon.ai width={14} height={14} /> Draft missing with AI</>}
            </button>
            <button className="btn" onClick={() => setDialog('approve')} disabled={approvable.length === 0 && blockedDrafts === 0} data-testid="tr-approve-all">Approve reviewed drafts…</button>
            <button className="btn" onClick={previewInLanguage} data-testid="tr-preview-language">Preview in {langShort}</button>
            <span className="muted tr-ai-status" data-testid="tr-ai-status" data-live={liveOn === null ? 'unknown' : liveOn ? 'on' : 'off'} title={lastProvider ?? undefined}>
              {liveOn === null ? 'Checking whether live AI is on…' : liveOn ? `Live AI is on${aiStatus?.model ? ` (${aiStatus.model})` : ''}.` : 'Live AI is off: no AI key is set. The two sample projects can load labelled sample drafts for Spanish.'}
            </span>
          </div>
          <p className="muted tr-ai-note">Drafts are never approved automatically. {missingNow > 0 ? `${plural(missingNow, 'text')} still ${missingNow === 1 ? 'has' : 'have'} no ${langShort} text. ` : ''}Previews show drafts with a marker; exports use approved text only.</p>
          {aiResult && aiResult.forLocale === LOCALE && (
            <div className="callout tr-ai-result" role="status" data-testid="tr-ai-result" data-mode={aiResult.mode}>
              <div className="tr-import-head">
                <strong>{aiResult.mode === 'unavailable' ? 'No drafts were created' : aiResult.mode === 'sample' ? `${plural(aiResult.applied, 'sample draft')} added` : `${plural(aiResult.applied, 'AI draft')} added`}</strong>
                <button className="btn sm ghost" onClick={() => setAiResult(null)} aria-label="Dismiss result"><Icon.close width={12} height={12} /></button>
              </div>
              <p className="tr-ai-message">{aiResult.message}</p>
              {aiResult.mode !== 'unavailable' && aiResult.applied > 0 && <p className="muted">{aiResult.mode === 'sample' ? 'Sample drafts are unreviewed. ' : 'AI drafts are unreviewed. '}Read each one, edit if needed, then approve it.</p>}
              {aiResult.skipped.length > 0 && (aiResult.skipped.length > 5
                ? <details className="tr-skipped"><summary>{plural(aiResult.skipped.length, 'text')} skipped</summary><ul>{aiResult.skipped.map((k) => <li key={k.id}><span className="chip code">{k.id}</span> {k.reason}</li>)}</ul></details>
                : <ul className="tr-skipped">{aiResult.skipped.map((k) => <li key={k.id}><span className="chip code">{k.id}</span> {k.reason}</li>)}</ul>)}
            </div>
          )}
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
          <span className="segmented" role="group" aria-label="Kind of text">
            <button aria-pressed={group === 'all'} onClick={() => setGroup('all')} data-testid="tr-group-all">All {st.rows.length}</button>
            {GROUPS.map((g) => <button key={g.key} aria-pressed={group === g.key} onClick={() => setGroup(g.key)} data-testid={g.testid}>{g.label} {groupCount(g.key)}</button>)}
          </span>
        </div>
        <div className="tr-filters" role="group" aria-label="Status and search filters">
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
          {rows.length === 0 ? <Empty title="No matching text" message="Change the filters to see more texts." /> : (
            <table className="table tr-table" data-testid="tr-table">
              <caption className="sr-only">Texts with English source, {langLabel(LOCALE)} translation editor and status</caption>
              <thead><tr><th scope="col">English (source, read-only)</th><th scope="col">{langLabel(LOCALE)}{technical ? ` (${LOCALE})` : ''}</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const g = groupOf(r);
                  const head = group === 'all' && g !== lastGroup;
                  lastGroup = g;
                  const val = valueOf(r);
                  const tc = val.trim() ? checkTokens(r.sourceText, val) : { ok: true, missing: [] as string[], extra: [] as string[] };
                  const err = errors[r.partId];
                  const d = dirty(r);
                  const active = focusId === r.partId || d || !!r.status.draftText || !!err;
                  const canApprove = !!val.trim() && (r.status.pendingDraft || d || r.status.status === 'draft');
                  const lines = Math.min(10, Math.max(2, r.sourceText.split('\n').length + Math.floor(r.sourceText.length / 70), val.split('\n').length));
                  const aiHere = aiBusy === r.partId;
                  return (
                    <Fragment key={r.partId}>
                      {head && <tr className="tr-grouphead"><th colSpan={3} scope="colgroup">{groupLabel(g)} <span className="chip count">{groupCount(g)}</span></th></tr>}
                      <tr data-testid="tr-row" data-part={r.partId} data-status={r.status.status} data-group={g} data-mandatory={r.status.mandatory ? 'true' : 'false'}>
                        <td className="tr-src">
                          <div className="tr-title">
                            <strong title={r.title}>{r.title}</strong>
                            {r.status.mandatory && <span className="chip error tr-mand" title={r.status.mandatoryReasons.join('; ')} data-testid="tr-mandatory">{Req}</span>}
                            <Tech><span className="chip code" title={r.kind === 'string' ? 'Text id' : 'Content part id and version'}>{r.kind === 'string' ? r.partId : `${r.partId} · v${r.version}`}</span></Tech>
                          </div>
                          <p className="tr-en" lang="en-US"><Highlighted text={r.sourceText} /></p>
                          <div className="tr-meta">
                            <span>{r.kind === 'string' ? (g === 'channels' ? 'Email or SMS text' : 'Label or heading') : USED_LABEL[r.usedAs[0]] ?? 'Document text'}</span>
                            {r.seenByRecords !== null && <span>Seen by {r.seenByRecords} synthetic {r.seenByRecords === 1 ? 'record' : 'records'}</span>}
                            {r.status.affectedRecordIds.length > 0 && <span className="tr-warn">▲ Blocks {r.status.affectedRecordIds.length} synthetic {langShort}-speaking {r.status.affectedRecordIds.length === 1 ? 'customer' : 'customers'}</span>}
                          </div>
                        </td>
                        <td className="tr-edit">
                          <textarea className="textarea tr-input" lang={LOCALE} rows={lines} value={val} placeholder="Type the translation…" aria-label={`${langLabel(LOCALE)} translation of ${r.title}`} data-testid="tr-draft-input"
                            onFocus={() => setFocusId(r.partId)}
                            onBlur={(e) => { setFocusId((f) => (f === r.partId ? null : f)); autosave(r, e.target.value); }}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEdits((x) => ({ ...x, [r.partId]: v })); setErr(r.partId, null); setSaved((x) => ({ ...x, [r.partId]: false }));
                              stopTimer(r.partId);
                              timers.current[r.partId] = setTimeout(() => autosave(r, v), 1000);
                            }} />
                          {r.origin && !d && (
                            <div className="tr-originline">
                              <span className="chip info tr-origin" data-testid="tr-origin" data-origin={r.origin}>{r.origin === 'ai' ? 'AI draft' : 'Sample draft'} · not reviewed</span>
                              <span className="muted">{r.origin === 'ai' ? 'Written by AI.' : 'From the bundled sample set.'} Read it, edit if needed, then approve.</span>
                            </div>
                          )}
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
                          {r.sourceChanged && <span className="tr-srcchanged"><span className="chip warning" data-testid="tr-source-changed">English changed</span><span className="tr-pending">The English text changed after this was approved. Re-check the translation.</span></span>}
                          <span className="tr-pending tr-saved" data-testid="tr-saved" aria-live="polite">{d ? 'Saving…' : saved[r.partId] && r.status.draftText ? 'Draft saved' : ''}</span>
                          {active && (
                            <span className="tr-actions">
                              <button className="btn sm primary" onClick={() => approve(r)} disabled={!canApprove} data-testid="tr-approve">Approve</button>
                              <button className="btn sm ghost" onClick={() => discard(r)} disabled={!r.status.draftText && !d} data-testid="tr-discard">Discard draft</button>
                            </span>
                          )}
                          {r.status.status === 'missing' && !d && (
                            <button className="btn sm ghost tr-ctx" onClick={() => runTranslate([r.partId])} disabled={!!aiBusy} aria-busy={aiHere} data-testid="tr-ai-draft-row">{aiHere ? <><span className="spinner" aria-hidden="true" /> Drafting…</> : <><Icon.ai width={12} height={12} /> Draft with AI</>}</button>
                          )}
                          <button className="btn sm ghost tr-ctx" onClick={() => seeInContext(r)} data-testid="tr-context" title={hasLocaleRecord ? `Open 2D Design with a ${langShort}-language synthetic record` : `Open 2D Design previewing ${langShort}`}>See in context <Icon.external width={12} height={12} /></button>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {dialogs}
      {dialog === 'approve' && (
        <Dialog title="Approve reviewed drafts" onClose={() => setDialog(null)} labelledBy="tr-approve-all-title"
          footer={<><button className="btn" onClick={() => setDialog(null)} data-testid="tr-approve-all-cancel">Cancel</button><button className="btn primary" onClick={approveAll} disabled={approvable.length === 0} data-testid="tr-approve-all-apply">Approve {plural(approvable.length, 'draft')}</button></>}>
          <div data-testid="tr-approve-all-confirm" className="tr-confirm">
            <p><strong>{plural(approvable.length, 'draft')}</strong> in {langLabel(LOCALE)} will be approved and become the text customers see.</p>
            {approvableUntouched > 0 && <p className="tr-confirm-warn">{approvableUntouched} of them {approvableUntouched === 1 ? 'is an' : 'are'} untouched {approvableUntouched === 1 ? 'AI or sample draft' : 'AI or sample drafts'} that nobody has edited. Make sure you have read {approvableUntouched === 1 ? 'it' : 'them'}.</p>}
            {blockedDrafts > 0 && <p className="muted">{plural(blockedDrafts, 'draft')} with a data-field mismatch {blockedDrafts === 1 ? 'is' : 'are'} left out. Fix {blockedDrafts === 1 ? 'it' : 'them'} first.</p>}
            <p className="muted">One undo step reverts the whole approval.</p>
          </div>
        </Dialog>
      )}
    </section>
  );
}
