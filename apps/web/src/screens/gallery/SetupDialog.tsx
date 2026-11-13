import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ACCENT_PATTERN, ISSUER_NAME_MAX, ISSUER_NAME_MIN, NEUTRAL_ACCENT, SETUP_LIMITS, type Project, type SetupField, type SetupSection, type SetupSpec } from '@iss/model';
import { resolve, type Resolution } from '@iss/resolver';
import { baselineCustomer, readSampleData, type SetupOutline } from '@iss/scenarios';
import { api, ApiFailure, type SetupProposal, type SetupSampleData } from '../../api/client';
import { NeedsAi, SourceChip, useAiLive } from '../../assist/common';
import { PagePreview } from '../../doc/PagePreview';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import './SetupDialog.css';

/* ------------------------------------------------------------------ constants */

const DESCRIPTION_MAX = 2000;
const FILE_MAX_BYTES = 8 * 1024 * 1024;
const NOTES_SHOWN = 6;
const TITLE_MAX = SETUP_LIMITS.title;

const EXAMPLES: Array<{ id: string; title: string; name: string; text: string }> = [
  {
    id: 'renewal', title: 'Membership renewal notice', name: 'Membership renewal notice',
    text: 'A membership renewal notice for our gym. It shows the plan name, the monthly fee and the renewal date, then lists the extras charged this month (what it was, the date and the amount) in a table with the total. Members whose payment failed get a message asking them to update their payment details; everyone else gets a thank-you for staying with us.',
  },
  {
    id: 'bill', title: 'Utility bill', name: 'Water and energy bill',
    text: 'A monthly utility bill. It shows the account number, the billing period, the amount due and the due date, and a table of the meters read (meter, previous reading, current reading, amount). Customers whose balance is overdue see a firm payment reminder with the late fee; customers who pay by direct debit see a note that nothing needs to be done.',
  },
  {
    id: 'appointment', title: 'Appointment reminder', name: 'Appointment reminder',
    text: 'An appointment reminder from a dental clinic. It shows the patient name, the appointment date and time, the dentist and the clinic address. Patients who still owe a balance are reminded to bring a payment method, and patients booked for a first visit are told to arrive 15 minutes early and bring their insurance card.',
  },
];

/* ------------------------------------------------------------------ helpers */

/** Wording a person can edit: the setup text of a section that has one, with `{Field label}` mentions as written. */
const EDITABLE_TEXT: ReadonlyArray<SetupSection['type']> = ['heading', 'paragraph', 'notice'];
const TEXT_LIMIT: Record<string, number> = { heading: SETUP_LIMITS.heading, paragraph: SETUP_LIMITS.paragraph, notice: SETUP_LIMITS.notice };

type FieldEntry = { key: number; spec: SetupField; outline: SetupOutline['fields'][number] };
type SectionEntry = { key: number; spec: SetupSection; outline: SetupOutline['sections'][number] };

let keySeed = 0;
const entriesOf = (p: SetupProposal): { fields: FieldEntry[]; sections: SectionEntry[]; base: SetupSpec } => ({
  fields: p.spec.fields.map((spec, i) => ({ key: ++keySeed, spec, outline: p.outline.fields[i] })),
  sections: p.spec.sections.map((spec, i) => ({ key: ++keySeed, spec, outline: p.outline.sections[i] })),
  base: p.spec,
});

const errText = (e: unknown): string => (e instanceof ApiFailure ? e.message : String((e as Error)?.message ?? e));

/** Rewrites every mention of a data field (`{Old}` in wording, and the places that name a field) after a rename. */
function renameField(base: SetupSpec, sections: SectionEntry[], from: string, to: string): { base: SetupSpec; sections: SectionEntry[] } {
  const sub = (s: string) => s.split(`{${from}}`).join(`{${to}}`);
  const fix = (s: SetupSection): SetupSection => {
    switch (s.type) {
      case 'heading': case 'paragraph': case 'notice': return { ...s, text: sub(s.text) };
      case 'keyFigures': return { ...s, fields: s.fields.map((f) => (f === from ? to : f)) };
      case 'table': return { ...s, list: s.list === from ? to : s.list };
      case 'messages': return { ...s, versions: s.versions.map((v) => ({ ...v, text: sub(v.text), ...(v.when ? { when: { ...v.when, field: v.when.field === from ? to : v.when.field } } : {}) })) };
      default: return s;
    }
  };
  return {
    base: { ...base, ...(base.email ? { email: { subject: sub(base.email.subject), intro: sub(base.email.intro) } } : {}), ...(base.sms ? { sms: sub(base.sms) } : {}) },
    sections: sections.map((e) => ({ ...e, spec: fix(e.spec) })),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ small parts */

/** A text field that commits on Enter or when it loses focus, so a half-typed name never breaks the places that use it. */
function CommitInput({ value, label, onCommit, maxLength, testId }: { value: string; label: string; onCommit: (v: string) => void; maxLength: number; testId?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { const v = draft.trim().replace(/\s+/g, ' '); if (v && v !== value) onCommit(v); else setDraft(value); };
  return <input className="input sd-inline" value={draft} maxLength={maxLength} aria-label={label} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape' && draft !== value) { e.stopPropagation(); setDraft(value); } }} data-testid={testId} />;
}

/** The new document as a page, drawn from the proposal's project and its starting customer. Costs one resolve in the browser. */
function ProposalThumb({ project }: { project: Project }) {
  const res = useMemo<Resolution | null>(() => {
    try { return resolve({ project, record: { ...baselineCustomer(project).record, recordId: 'REC-0000' } }); } catch { return null; }
  }, [project]);
  if (!res) return <p className="muted sd-thumb-none">A page preview could not be drawn for this setup.</p>;
  return (
    <div className="sd-thumb" data-testid="setup-thumb" role="img" aria-label="What the first page of the new document looks like with a starting customer">
      <div className="sd-paper"><PagePreview res={res} project={project} scale={0.28} showGuides={false} ia={{ selectedId: null }} /></div>
    </div>
  );
}

/* ------------------------------------------------------------------ the dialog */

export function SetupDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const aiLive = useAiLive();
  const rootRef = useRef<HTMLDivElement>(null);

  // Step 1
  const [step, setStep] = useState<'describe' | 'review'>('describe');
  const [title, setTitle] = useState('');
  const [issuer, setIssuer] = useState('');
  const [accent, setAccent] = useState('');
  const [description, setDescription] = useState('');
  const [dataText, setDataText] = useState('');
  const [dataName, setDataName] = useState<string | null>(null);
  const [dataFormat, setDataFormat] = useState<'csv' | 'json'>('csv');
  const [fileErr, setFileErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Drafting
  const [busy, setBusy] = useState<null | 'draft' | 'recheck' | 'create'>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<{ message: string; notes: string[]; providerStatus: string } | null>(null);

  // Step 2
  const [proposal, setProposal] = useState<SetupProposal | null>(null);
  const [base, setBase] = useState<SetupSpec | null>(null);
  const [fields, setFields] = useState<FieldEntry[]>([]);
  const [sections, setSections] = useState<SectionEntry[]>([]);
  const [changed, setChanged] = useState(false);
  const [customers, setCustomers] = useState<'generate' | 'supplied' | 'both'>('generate');
  const [allNotes, setAllNotes] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /* ---- data */
  const hasData = dataText.trim().length > 0;
  const parsed = useMemo(() => (hasData ? readSampleData(dataFormat, dataText) : null), [hasData, dataFormat, dataText]);
  const dataRows = parsed && 'rows' in parsed ? parsed.rows.length : 0;
  const dataError = parsed && 'error' in parsed ? parsed.error : dataRows > 500 ? 'At most 500 customers can be supplied at once.' : null;
  const dataOk = hasData && !dataError;
  const sampleData: SetupSampleData | undefined = dataOk ? { format: dataFormat, data: dataText } : undefined;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileErr(null);
    if (f.size > FILE_MAX_BYTES) { setFileErr(`“${f.name}” is larger than 8 MB. Use a smaller file.`); return; }
    try {
      const text = await f.text();
      setDataFormat(/\.json$/i.test(f.name) ? 'json' : 'csv');
      setDataName(f.name);
      setDataText(text);
    } catch (e) { setFileErr(`“${f.name}” could not be read: ${errText(e)}`); }
  };
  const clearData = () => { setDataText(''); setDataName(null); setFileErr(null); if (fileRef.current) fileRef.current.value = ''; };
  const pasteData = (text: string) => { setDataText(text); setDataName(null); setDataFormat(/^\s*[[{]/.test(text) ? 'json' : 'csv'); };

  /* ---- step 1 validity */
  const titleTrim = title.trim().replace(/\s+/g, ' ');
  const titleOk = titleTrim.length >= 2 && titleTrim.length <= TITLE_MAX;
  const issuerTrim = issuer.trim().replace(/\s+/g, ' ');
  const issuerOk = !issuerTrim || (issuerTrim.length >= ISSUER_NAME_MIN && issuerTrim.length <= ISSUER_NAME_MAX);
  const accentOk = !accent || ACCENT_PATTERN.test(accent);
  const descTrim = description.trim();
  const needsKey = aiLive === false;
  const canDraft = titleOk && issuerOk && accentOk && description.length <= DESCRIPTION_MAX && !(hasData && dataError) && (dataOk || (!!descTrim && !needsKey)) && !busy;
  const draftBlock = !titleOk ? 'Give the document a name of 2–80 characters.' : !issuerOk ? `The issuer name must be ${ISSUER_NAME_MIN}–${ISSUER_NAME_MAX} characters.` : !accentOk ? 'Use a 6-digit hex colour such as #1F4E79.' : description.length > DESCRIPTION_MAX ? 'The description is too long.' : hasData && dataError ? dataError : !dataOk && !descTrim ? 'Describe the document or supply sample data.' : !dataOk && needsKey ? 'A description needs an AI key. Supply sample data to continue without one.' : null;

  /* ---- applying a result */
  const take = (p: SetupProposal) => {
    const e = entriesOf(p);
    setProposal(p); setBase(e.base); setFields(e.fields); setSections(e.sections); setChanged(false);
    setAllNotes(false); setErr(null); setUnavailable(null);
  };
  const workingSpec = useMemo<SetupSpec | null>(() => (base ? { ...base, fields: fields.map((f) => f.spec), sections: sections.map((s) => s.spec) } : null), [base, fields, sections]);

  const body = () => ({ title: titleTrim, ...(issuerTrim ? { issuerName: issuerTrim } : {}), ...(accent ? { accent: accent.toLowerCase() } : {}), ...(sampleData ? { sampleData } : {}) });

  const draft = async () => {
    if (!canDraft) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy('draft'); setErr(null); setUnavailable(null);
    try {
      const r = await api.draftSetup({ ...body(), ...(descTrim ? { description: descTrim } : {}) }, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.mode === 'unavailable') { setUnavailable({ message: r.message, notes: r.notes, providerStatus: r.providerStatus }); return; }
      const fresh = !proposal;
      take(r);
      if (fresh) setCustomers(r.customers.supplied && r.customers.supplied.accepted > 0 ? 'supplied' : 'generate');
      else setCustomers((c) => (c !== 'generate' && !(r.customers.supplied && r.customers.supplied.accepted > 0) ? 'generate' : c));
      setStep('review');
    } catch (e) { if (!ctl.signal.aborted) setErr(errText(e)); }
    finally { if (abortRef.current === ctl) abortRef.current = null; setBusy(null); }
  };
  const cancelDraft = () => { abortRef.current?.abort(); abortRef.current = null; setBusy(null); };

  const recheck = async () => {
    if (!workingSpec || !proposal) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy('recheck'); setErr(null);
    try {
      const r = await api.draftSetup({ ...body(), spec: workingSpec, source: proposal.source }, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.mode === 'unavailable') { setErr(r.message); return; }
      take(r);
      setCustomers((c) => (c !== 'generate' && !(r.customers.supplied && r.customers.supplied.accepted > 0) ? 'generate' : c));
    } catch (e) { if (!ctl.signal.aborted) setErr(errText(e)); }
    finally { if (abortRef.current === ctl) abortRef.current = null; setBusy(null); }
  };

  const create = async () => {
    if (!workingSpec || !proposal || changed || busy) return;
    setBusy('create'); setErr(null);
    try {
      const r = await api.createSetup({ spec: workingSpec, title: titleTrim, ...(issuerTrim ? { issuerName: issuerTrim } : {}), ...(accent ? { accent: accent.toLowerCase() } : {}), customers, ...(customers !== 'generate' && sampleData ? { sampleData } : {}), source: proposal.source });
      await useStudio.getState().loadProjects();
      useStudio.getState().toast({ kind: 'success', title: 'Document created', message: `“${r.project.title}” was set up with ${r.customers.total} customer${r.customers.total === 1 ? '' : 's'} to preview with.` });
      onClose();
      navigate(`/studio/${r.project.projectId}/design`);
    } catch (e) { setErr(errText(e)); setBusy(null); }
  };

  /* ---- edits (each marks the proposal as changed) */
  const touch = () => { setChanged(true); setErr(null); };
  const removeField = (key: number) => { setFields((fs) => fs.filter((f) => f.key !== key)); touch(); };
  const renameFieldTo = (key: number, label: string) => {
    const cur = fields.find((f) => f.key === key);
    if (!base || !cur || cur.spec.label === label) return;
    if (fields.some((f) => f.key !== key && f.spec.label.toLowerCase() === label.toLowerCase())) { setErr(`There is already a data field called “${label}”.`); return; }
    const out = renameField(base, sections, cur.spec.label, label);
    setBase(out.base); setSections(out.sections);
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, spec: { ...f.spec, label } } : f)));
    touch();
  };
  const removeSection = (key: number) => { setSections((ss) => ss.filter((s) => s.key !== key)); touch(); };
  const moveSection = (key: number, by: -1 | 1) => {
    setSections((ss) => { const i = ss.findIndex((s) => s.key === key); const j = i + by; if (i < 0 || j < 0 || j >= ss.length) return ss; const next = ss.slice(); [next[i], next[j]] = [next[j], next[i]]; return next; });
    touch();
  };
  const editSection = (key: number, fn: (s: SetupSection) => SetupSection) => { setSections((ss) => ss.map((e) => (e.key === key ? { ...e, spec: fn(e.spec) } : e))); touch(); };

  /* ---- closing with unsaved work */
  const dirty = !!(title || issuer || accent || description || dataText || proposal);
  const requestClose = () => { if (busy === 'create') return; if (dirty) setConfirmDiscard(true); else onClose(); };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  const stableClose = useCallback(() => closeRef.current(), []);

  useEffect(() => {
    const body = rootRef.current?.closest('.body');
    if (body) body.scrollTop = 0;
    rootRef.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
  }, [step]);

  const supplied = proposal?.customers.supplied ?? null;
  const suppliedUsable = !!supplied && supplied.accepted > 0;
  const noKeyForDescription = needsKey && !!descTrim;

  /* ------------------------------------------------------------------ footer */
  const footer = confirmDiscard
    ? (
      <div className="sd-discard" role="alertdialog" aria-labelledby="sd-discard-q" data-testid="setup-discard-confirm">
        <span id="sd-discard-q"><strong>Discard this setup?</strong> What you typed and any proposal will be lost. Nothing has been created.</span>
        <button type="button" className="btn" onClick={() => setConfirmDiscard(false)} data-testid="setup-keep">Keep editing</button>
        <button type="button" className="btn danger" onClick={onClose} data-testid="setup-discard">Discard</button>
      </div>
    )
    : step === 'describe'
      ? (
        <>
          {draftBlock && !busy && <span className="sd-foot-note muted" data-testid="setup-draft-why">{draftBlock}</span>}
          <button type="button" className="btn" onClick={stableClose} data-testid="setup-cancel">Cancel</button>
          {proposal && <button type="button" className="btn" onClick={() => setStep('review')} data-testid="setup-to-review">Return to the proposal</button>}
          <button type="button" className="btn primary" onClick={draft} disabled={!canDraft} title={draftBlock ?? undefined} data-testid="setup-draft">{busy === 'draft' ? 'Drafting…' : proposal ? 'Draft the setup again' : 'Draft the setup'}</button>
        </>
      )
      : (
        <>
          {changed && <span className="sd-foot-note" data-testid="setup-unchecked">You changed the setup. Check your changes before creating.</span>}
          <button type="button" className="btn" onClick={() => { setStep('describe'); setErr(null); }} disabled={!!busy} data-testid="setup-back">Back to the description</button>
          <button type="button" className="btn" onClick={draft} disabled={!canDraft} title={changed ? 'Drafts a new proposal from your description and replaces your edits' : draftBlock ?? 'Run the assistant again with the same description'} data-testid="setup-draft-again">{busy === 'draft' ? 'Drafting…' : 'Draft again'}</button>
          <button type="button" className="btn primary" onClick={create} disabled={!workingSpec || changed || !!busy || (customers !== 'generate' && !suppliedUsable)} title={changed ? 'Check your changes first' : undefined} data-testid="setup-create">{busy === 'create' ? 'Creating…' : 'Create the document'}</button>
        </>
      );

  /* ------------------------------------------------------------------ step 1 */
  const describe: ReactNode = (
    <div className="sd-step" data-testid="setup-step-describe" hidden={step !== 'describe'}>
      <h3 className="sd-h" tabIndex={-1} data-step-heading>1. Describe the document</h3>
      <div className="sd-grid">
        <div className="field">
          <label htmlFor="sd-title">Name of the document</label>
          <input id="sd-title" className="input" value={title} maxLength={TITLE_MAX} aria-invalid={!!title && !titleOk} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Membership renewal notice" data-testid="setup-title" />
          <span className="hint">2–{TITLE_MAX} characters.</span>
        </div>
        <div className="field">
          <label htmlFor="sd-issuer">Who it is from <span className="muted">(optional)</span></label>
          <input id="sd-issuer" className="input" value={issuer} maxLength={ISSUER_NAME_MAX + 20} aria-invalid={!issuerOk} onChange={(e) => setIssuer(e.target.value)} placeholder="e.g. Northside Gym" data-testid="setup-issuer" />
          <span className={`hint${issuerOk ? '' : ' sd-bad'}`}>{issuerOk ? 'Left empty, the assistant picks a name and you can change it later.' : `The name must be ${ISSUER_NAME_MIN}–${ISSUER_NAME_MAX} characters.`}</span>
        </div>
        <div className="field">
          <label htmlFor="sd-accent">Brand colour <span className="muted">(optional)</span></label>
          <div className="row np-accent">
            <input id="sd-accent" type="color" className="np-swatch" value={ACCENT_PATTERN.test(accent) ? accent.toLowerCase() : NEUTRAL_ACCENT} onChange={(e) => setAccent(e.target.value)} data-testid="setup-accent" />
            <input className="input mono np-hex" aria-label="Brand colour as a hex value" value={accent} maxLength={7} placeholder="Not set" aria-invalid={!accentOk} onChange={(e) => setAccent(e.target.value && !e.target.value.startsWith('#') ? `#${e.target.value}` : e.target.value)} data-testid="setup-accent-hex" />
            {accent && <button type="button" className="btn ghost sm" onClick={() => setAccent('')}>Clear</button>}
          </div>
          <span className={`hint${accentOk ? '' : ' sd-bad'}`}>{accentOk ? 'Used for headings and accents.' : 'Use a 6-digit hex value such as #1F4E79.'}</span>
        </div>
      </div>

      <div className="field">
        <div className="sd-label-row">
          <label htmlFor="sd-description">What is it for and what does it show?</label>
          <span className={`sd-count${description.length > DESCRIPTION_MAX ? ' sd-bad' : ''}`} data-testid="setup-description-count" aria-live="off">{description.length.toLocaleString('en-US')} / {DESCRIPTION_MAX.toLocaleString('en-US')}</span>
        </div>
        <textarea id="sd-description" className="textarea sd-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby="sd-privacy" placeholder="Say who receives it, which details it shows (fields), any table it needs, and what changes for some customers (a condition)." data-testid="setup-description" />
        {needsKey && <NeedsAi message="A description needs an AI key. Sample data alone works: the studio sets the document up from your data without a model." />}
        <div className="sd-examples" role="group" aria-label="Example descriptions to start from">
          <span className="muted sd-ex-lbl">Start from an example:</span>
          {EXAMPLES.map((x) => (
            <button key={x.id} type="button" className="btn sm" onClick={() => { setDescription(x.text); if (!title.trim()) setTitle(x.name); }} data-testid={`setup-example-${x.id}`}>{x.title}</button>
          ))}
        </div>
      </div>

      <div className="field sd-data">
        <span className="label" id="sd-data-label">Sample data <span className="muted">(optional)</span></span>
        <p className="hint">A CSV or JSON file with one row per customer, up to 8 MB and {500} customers. With it the document gets its fields from your columns and the customers to preview with.</p>
        <div className="row wrap sd-data-row" role="group" aria-labelledby="sd-data-label">
          <label className="btn sm sd-file">
            Choose a file
            <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" className="sd-file-input" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="setup-data-file" />
          </label>
          {dataOk && <span className="chip accent sd-data-chip" data-testid="setup-data-summary">{dataName ? <span className="sd-fname" title={dataName}>{dataName}</span> : 'Pasted data'} · {dataFormat.toUpperCase()} · {dataRows} row{dataRows === 1 ? '' : 's'}</span>}
          {hasData && <button type="button" className="btn ghost sm" onClick={clearData} data-testid="setup-data-clear">Remove data</button>}
        </div>
        {fileErr && <p className="callout error" role="alert" data-testid="setup-file-error">{fileErr}</p>}
        {hasData && dataError && <p className="callout error" role="alert" data-testid="setup-data-error">{dataError}</p>}
        {!dataName && (
          <details className="sd-paste" open={hasData || undefined}>
            <summary>Paste data instead</summary>
            <label htmlFor="sd-data-text" className="sr-only">Pasted sample data (CSV or JSON)</label>
            <textarea id="sd-data-text" className="textarea mono sd-paste-area" rows={5} value={dataText} onChange={(e) => pasteData(e.target.value)} placeholder={'[{"name": "Ana Silva", "amount": 49.5, "due": "2026-12-01"}]'} spellCheck={false} data-testid="setup-data-text" />
          </details>
        )}
      </div>

      <p className="sd-privacy callout" id="sd-privacy" data-testid="setup-privacy">Your description is sent to the AI model. From your data only the column names, their types and the distinct choice values are sent, never the rows.</p>

      {busy === 'draft' && (
        <div className="sd-busy callout" role="status" aria-live="polite" data-testid="setup-busy">
          <span className="spinner" aria-hidden="true" />
          <span><strong>The assistant is drafting your setup…</strong> With a live model this can take about 20 seconds. Nothing is created.</span>
          <button type="button" className="btn sm" onClick={cancelDraft} data-testid="setup-cancel-draft">Cancel</button>
        </div>
      )}
      {unavailable && (
        <div className="callout warning sd-unavailable" role="status" data-testid="setup-unavailable">
          <p><strong>{unavailable.message}</strong></p>
          {unavailable.notes.length > 0 && <ul>{unavailable.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <p className="muted">Nothing was drafted and nothing was created. {noKeyForDescription ? 'Supply sample data to continue without an AI key.' : ''}</p>
        </div>
      )}
      {err && step === 'describe' && <p className="callout error" role="alert" data-testid="setup-error">{err}</p>}
    </div>
  );

  /* ------------------------------------------------------------------ step 2 */
  const review: ReactNode = proposal && workingSpec ? (
    <div className="sd-step" data-testid="setup-step-review" hidden={step !== 'review'}>
      <h3 className="sd-h" tabIndex={-1} data-step-heading>2. Review the proposal</h3>
      <div className="sd-head">
        <SourceChip source={proposal.source} />
        <p className="sd-message" data-testid="setup-message">{proposal.message}</p>
        <p className="sd-nothing muted"><strong>Nothing is created until you choose Create.</strong> {proposal.providerStatus}</p>
      </div>

      {proposal.notes.length > 0 && (
        <section className="sd-block" data-testid="setup-notes" aria-labelledby="sd-notes-h">
          <h4 id="sd-notes-h" className="sd-bh">What was assumed or left out</h4>
          <ul className="sd-notes">
            {(allNotes ? proposal.notes : proposal.notes.slice(0, NOTES_SHOWN)).map((n, i) => <li key={i}>{n}</li>)}
          </ul>
          {proposal.notes.length > NOTES_SHOWN && <button type="button" className="btn ghost sm" onClick={() => setAllNotes(!allNotes)} aria-expanded={allNotes} data-testid="setup-notes-toggle">{allNotes ? 'Show fewer' : `Show all ${proposal.notes.length}`}</button>}
        </section>
      )}

      <div className="sd-cols">
        <div className="sd-outline">
          <section className="sd-block" data-testid="setup-fields" aria-labelledby="sd-fields-h">
            <h4 id="sd-fields-h" className="sd-bh">Data fields <span className="chip count">{fields.length}</span></h4>
            {fields.length === 0 ? <p className="muted">No data fields. The customer’s name and language are always there.</p> : (
              <ul className="sd-rows">
                {fields.map((f) => (
                  <li key={f.key} className="sd-row sd-field" data-testid="setup-field" data-label={f.spec.label}>
                    <div className="sd-row-main">
                      <CommitInput value={f.spec.label} label={`Name of the data field “${f.spec.label}”`} maxLength={SETUP_LIMITS.label} onCommit={(v) => renameFieldTo(f.key, v)} testId="setup-field-label" />
                      <span className="chip">{f.outline.kind}</span>
                      {f.outline.required && <span className="chip accent">Required</span>}
                      {f.outline.detail && <span className="muted sd-detail">{f.outline.detail}</span>}
                    </div>
                    <button type="button" className="btn ghost sm" onClick={() => removeField(f.key)} aria-label={`Remove the data field “${f.spec.label}”`} data-testid="setup-field-remove">Remove</button>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">You can rename or remove a field. Anything that uses a removed field is adjusted or dropped when you check your changes.</p>
          </section>

          <section className="sd-block" data-testid="setup-sections" aria-labelledby="sd-sections-h">
            <h4 id="sd-sections-h" className="sd-bh">Sections in order <span className="chip count">{sections.length}</span></h4>
            {sections.length === 0 ? <p className="muted">No sections.</p> : (
              <ol className="sd-rows sd-sections">
                {sections.map((s, i) => {
                  const spec = s.spec;
                  const textual = EDITABLE_TEXT.includes(spec.type);
                  return (
                    <li key={s.key} className="sd-row sd-section" data-testid="setup-section" data-kind={s.outline.kind}>
                      <div className="sd-section-body">
                        <div className="row wrap sd-section-head">
                          <span className="chip">{s.outline.kind}</span>
                          {spec.type === 'messages' && <strong>{spec.name}</strong>}
                          {!textual && spec.type !== 'messages' && <span className="sd-detail">{s.outline.text}</span>}
                        </div>
                        {spec.type === 'heading' && (
                          <input className="input" value={spec.text} maxLength={TEXT_LIMIT.heading} aria-label={`Heading text, section ${i + 1}`} onChange={(e) => editSection(s.key, (x) => ({ ...x, text: e.target.value } as SetupSection))} data-testid="setup-section-text" />
                        )}
                        {(spec.type === 'paragraph' || spec.type === 'notice') && (
                          <textarea className="textarea" rows={3} value={spec.text} maxLength={TEXT_LIMIT[spec.type]} aria-label={`${s.outline.kind} text, section ${i + 1}`} onChange={(e) => editSection(s.key, (x) => ({ ...x, text: e.target.value } as SetupSection))} data-testid="setup-section-text" />
                        )}
                        {spec.type === 'messages' && (
                          <ul className="sd-versions">
                            {spec.versions.map((v, k) => {
                              const o = s.outline.versions?.find((x) => x.title === v.title);
                              return (
                                <li key={k} className="sd-version" data-testid="setup-version">
                                  <div className="row wrap"><strong>{v.title}</strong>{(o?.fallback ?? v.fallback) ? <span className="chip">Fallback</span> : null}</div>
                                  <p className="sd-when" data-testid="setup-version-when">{o ? o.shownWhen : v.fallback ? 'Shown when no other version applies.' : 'Shown when its condition holds.'}</p>
                                  <textarea className="textarea" rows={2} value={v.text} maxLength={SETUP_LIMITS.versionText} aria-label={`Wording of the version “${v.title}” of ${spec.name}`} onChange={(e) => editSection(s.key, (x) => (x.type === 'messages' ? { ...x, versions: x.versions.map((y, j) => (j === k ? { ...y, text: e.target.value } : y)) } : x))} data-testid="setup-version-text" />
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      <div className="sd-row-actions">
                        <button type="button" className="btn ghost sm" onClick={() => moveSection(s.key, -1)} disabled={i === 0} aria-label={`Move section ${i + 1} up`} data-testid="setup-section-up">Up</button>
                        <button type="button" className="btn ghost sm" onClick={() => moveSection(s.key, 1)} disabled={i === sections.length - 1} aria-label={`Move section ${i + 1} down`} data-testid="setup-section-down">Down</button>
                        <button type="button" className="btn ghost sm" onClick={() => removeSection(s.key)} aria-label={`Remove section ${i + 1} (${s.outline.kind})`} data-testid="setup-section-remove">Remove</button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="hint">Data fields appear as {'{Field label}'} in the wording and stay that way.</p>
          </section>

          {(base?.email || base?.sms) && (
            <section className="sd-block" data-testid="setup-channels" aria-labelledby="sd-ch-h">
              <h4 id="sd-ch-h" className="sd-bh">Email and text message</h4>
              {base.email && <p><span className="muted">Email subject:</span> {base.email.subject}<br /><span className="muted">Email intro:</span> {base.email.intro}</p>}
              {base.sms && <p><span className="muted">Text message:</span> {base.sms}</p>}
              <p className="hint">The email and text wording cannot be edited here. You can edit it in the studio after the document is created.</p>
            </section>
          )}
        </div>

        <aside className="sd-side" aria-label="Preview of the new document">
          <ProposalThumb project={proposal.project} />
          <p className="muted sd-thumb-cap">First page, drawn with a starting customer. It is the proposal as checked{changed ? ' (before your latest changes)' : ''}.</p>
        </aside>
      </div>

      {changed && (
        <div className="callout accent sd-changed" role="status" data-testid="setup-changed">
          <span><strong>Changed.</strong> The studio has not checked your edits yet. Check them to update the outline, notes and preview.</span>
          <button type="button" className="btn primary sm" onClick={recheck} disabled={!!busy} data-testid="setup-recheck">{busy === 'recheck' ? 'Checking…' : 'Check my changes'}</button>
        </div>
      )}

      <section className="sd-block" data-testid="setup-customers" aria-labelledby="sd-cust-h">
        <h4 id="sd-cust-h" className="sd-bh">Customers to preview with</h4>
        <div className="sd-radios" role="radiogroup" aria-labelledby="sd-cust-h">
          <label className="sd-radio"><input type="radio" name="sd-customers" checked={customers === 'generate'} onChange={() => setCustomers('generate')} data-testid="setup-customers-generate" /> <span>Generate test customers for me ({proposal.customers.generated.count})</span></label>
          {supplied && (
            <>
              <label className="sd-radio"><input type="radio" name="sd-customers" checked={customers === 'supplied'} disabled={!suppliedUsable} onChange={() => setCustomers('supplied')} data-testid="setup-customers-supplied" /> <span>Use my data ({supplied.accepted} of {supplied.total} rows fit)</span></label>
              <label className="sd-radio"><input type="radio" name="sd-customers" checked={customers === 'both'} disabled={!suppliedUsable} onChange={() => setCustomers('both')} data-testid="setup-customers-both" /> <span>Both</span></label>
            </>
          )}
        </div>
        {supplied && (
          <>
            {supplied.rejectedCount > 0 && (
              <div className="callout warning sd-rejected" data-testid="setup-rejected">
                <strong>{supplied.rejectedCount} row{supplied.rejectedCount === 1 ? ' does' : 's do'} not fit and will not be used.</strong>
                <ul>
                  {supplied.rejected.slice(0, 5).map((r) => <li key={r.row}>Row {r.row}: {r.reasons.join('; ')}</li>)}
                </ul>
                {supplied.rejectedCount > 5 && <p className="muted">Showing the first 5 of {supplied.rejectedCount}.</p>}
              </div>
            )}
            {supplied.matching.length > 0 && (
              <div className="sd-match-wrap">
                <table className="table sd-match" data-testid="setup-matching">
                  <caption className="sd-caption">How your columns are used</caption>
                  <thead><tr><th scope="col">Column</th><th scope="col">Used as</th><th scope="col">How sure</th><th scope="col">Why</th></tr></thead>
                  <tbody>
                    {supplied.matching.map((m) => (
                      <tr key={m.column} data-testid="setup-match-row">
                        <td className="mono">{m.column}</td>
                        <td>{m.field ?? <span className="muted">Not used</span>}</td>
                        <td><span className={`chip${m.confidence === 'exact' || m.confidence === 'likely' ? ' accent' : m.confidence === 'guess' ? ' warning' : ''}`}>{m.confidence === 'none' ? 'none' : m.confidence}</span></td>
                        <td className="muted">{m.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {supplied.notes.length > 0 && <ul className="sd-notes muted">{supplied.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            {!suppliedUsable && <p className="callout warning">None of your rows fit, so only generated customers can be used.</p>}
          </>
        )}
      </section>

      <section className="sd-block" data-testid="setup-preview" aria-labelledby="sd-prev-h">
        <h4 id="sd-prev-h" className="sd-bh">What the first customer gets</h4>
        <p><strong data-testid="setup-preview-customer">{proposal.preview.customer.name}</strong> <span className="chip">{proposal.preview.customer.origin === 'supplied' ? 'From your data' : 'Generated'}</span></p>
        {proposal.preview.messages.length === 0
          ? <p className="muted">This document has no messages that differ between customers.</p>
          : <ul className="sd-notes">{proposal.preview.messages.map((m, i) => <li key={i}>{m.section}: {m.version ? <strong>{m.version}</strong> : <span className="muted">no version applies</span>}</li>)}</ul>}
        {proposal.preview.blocking.length > 0
          ? <div className="callout error" role="alert" data-testid="setup-blocking"><strong>Something blocks this document:</strong><ul>{proposal.preview.blocking.map((b, i) => <li key={i}>{b.message}</li>)}</ul></div>
          : <p className="muted" data-testid="setup-no-blocking">Nothing blocks the document for this customer.</p>}
      </section>

      {err && <p className="callout error" role="alert" data-testid="setup-error">{err}</p>}
    </div>
  ) : null;

  return (
    <Dialog title="Describe your document" onClose={stableClose} labelledBy="setup-dialog-title" footer={footer}>
      <div className="sd-root" ref={rootRef} data-testid="setup-dialog" data-step={step}>
        <p className="sd-steps muted" aria-label="Progress">Step {step === 'describe' ? 1 : 2} of 2 · <strong>{step === 'describe' ? 'Describe' : 'Review'}</strong></p>
        {describe}
        {review}
      </div>
    </Dialog>
  );
}
