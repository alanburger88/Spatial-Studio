import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ISSUER_NAME_MAX, ISSUER_NAME_MIN, SETUP_LIMITS } from '@iss/model';
import {
  ALIGN_KIND_LABEL, DETAIL_KIND_LABEL, FILE_KIND_LABEL, PAPER_LABEL, blockText, sendOutline,
  type DetailMark, type FileSamples, type NotBroughtItem, type ReadBlock,
} from '@iss/scenarios';
import { api, ApiFailure, type RebuildReading, type SetupProposal } from '../../api/client';
import { NeedsAi, useAiLive } from '../../assist/common';
import { Dialog } from '../../ui/common';
import { SetupDialog } from './SetupDialog';
import './SetupDialog.css';
import './RebuildDialog.css';

/**
 * "Rebuild from a file" (wave 3, section 1): choose one to three PDF or Word files of a document you already send →
 * what was found (blocks, tables, pictures, likely personal details, what was ignored, where samples differ) → what will
 * be sent (the exact outline, the placeholder choice and the confirmation, or "Continue without AI") → the ordinary
 * setup review (SetupDialog) with the report of what was not brought across → create.
 *
 * The files stay in this browser tab; the server reads them for each request and keeps nothing. Their names never
 * leave the browser.
 */
const MAX_FILES = 3;
const MAX_BYTES = 10 * 1024 * 1024;
const TITLE_MAX = SETUP_LIMITS.title;

interface Chosen { key: number; name: string; size: number; data: string }
type Step = 'choose' | 'found' | 'send';

const errText = (e: unknown): string => (e instanceof ApiFailure ? e.message : String((e as Error)?.message ?? e));
const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
let keySeed = 0;

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** One line (or cell) with its marks highlighted; a mark the person turned off is shown plain. */
function Marked({ text, marks, off }: { text: string; marks: DetailMark[]; off: Set<string> }) {
  if (!marks.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    if (m.start < at) continue;
    parts.push(text.slice(at, m.start));
    parts.push(off.has(m.id)
      ? <span key={m.id} className="rb-unmarked" title="Not treated as customer data">{text.slice(m.start, m.end)}</span>
      : <mark key={m.id} className="rb-mark" data-kind={m.kind} title={`${DETAIL_KIND_LABEL[m.kind]}: suggested data field “${m.field}”`} data-testid="rebuild-mark-span">{text.slice(m.start, m.end)}</mark>);
    at = m.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function BlockView({ b, marks, off }: { b: ReadBlock; marks: DetailMark[]; off: Set<string> }) {
  const at = (line: number, cell?: number) => marks.filter((m) => m.blockId === b.id && m.line === line && m.cell === cell);
  const kind = b.kind === 'heading' ? `Heading ${b.level ?? 1}` : b.kind === 'table' ? 'Table' : b.kind === 'list' ? 'List' : b.small ? 'Small print' : 'Text';
  return (
    <li className="rb-block" data-testid="rebuild-found-block" data-kind={b.kind}>
      <div className="rb-block-meta"><span className="chip">{kind}</span><span className="muted">Page {b.page}{b.sizePt ? ` · ${Math.round(b.sizePt)} pt` : ''}{b.bold ? ' · bold' : ''}</span></div>
      {b.kind === 'table' ? (
        <div className="rb-table-wrap">
          <table className="table rb-table">
            <tbody>
              {(b.rows ?? []).map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (b.headerRow && ri === 0 ? <th key={ci} scope="col">{c}</th> : <td key={ci}><Marked text={c} marks={at(ri, ci)} off={off} /></td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : b.kind === 'list' ? (
        <ul className="rb-lines">{b.lines.map((l, i) => <li key={i}><Marked text={l} marks={at(i)} off={off} /></li>)}</ul>
      ) : (
        <div className={`rb-lines${b.kind === 'heading' ? ' rb-heading' : ''}`}>{b.lines.map((l, i) => <div key={i}><Marked text={l} marks={at(i)} off={off} /></div>)}</div>
      )}
    </li>
  );
}

export function RebuildDialog({ onClose }: { onClose: () => void }) {
  const aiLive = useAiLive();
  const rootRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>('choose');
  const [files, setFiles] = useState<Chosen[]>([]);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'read' | 'propose'>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reading, setReading] = useState<RebuildReading | null>(null);
  const [sampleTab, setSampleTab] = useState(0);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [issuer, setIssuer] = useState('');
  const [mode, setMode] = useState<'ai' | 'builtin'>('builtin');
  const [placeholders, setPlaceholders] = useState(true);
  const [consent, setConsent] = useState(false);
  const [unavailable, setUnavailable] = useState<{ reason: 'no-key' | 'failed'; message: string; notes: string[] } | null>(null);
  const [review, setReview] = useState<{ proposal: SetupProposal; report: NotBroughtItem[] } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // A live model is the default path once one is configured; the person can always continue without it.
  useEffect(() => { if (aiLive === true) setMode((m) => (reading ? m : 'ai')); if (aiLive === false) setMode('builtin'); }, [aiLive, reading]);

  const fs: FileSamples | null = reading ? { samples: reading.samples, alignment: reading.alignment } : null;
  const outline = useMemo(() => (fs ? sendOutline(fs, { placeholders, unmarked: off }) : ''), [reading, placeholders, off]); // eslint-disable-line react-hooks/exhaustive-deps
  const allMarks = useMemo(() => reading?.samples.flatMap((s, i) => s.marks.map((m) => ({ m, sample: i }))) ?? [], [reading]);

  /* ---- files */
  const addFiles = async (list: FileList | null) => {
    setFileErr(null);
    if (!list?.length) return;
    const room = MAX_FILES - files.length;
    const picked = [...list];
    if (picked.length > room) { setFileErr(`Choose at most ${MAX_FILES} samples of the same document.`); return; }
    const out: Chosen[] = [];
    for (const f of picked) {
      if (!/\.(pdf|docx)$/i.test(f.name)) { setFileErr(`“${f.name}” is not a PDF or a Word (.docx) file. The studio reads PDF files and Word files saved as .docx (not the older .doc).`); return; }
      if (f.size > MAX_BYTES) { setFileErr(`“${f.name}” is larger than 10 MB. Use a smaller file, or fewer pages of it.`); return; }
      try { out.push({ key: ++keySeed, name: f.name, size: f.size, data: await base64Of(f) }); }
      catch (e) { setFileErr(`“${f.name}” could not be opened: ${errText(e)}`); return; }
    }
    setFiles((cur) => [...cur, ...out]);
    setReading(null);
  };
  const removeFile = (key: number) => { setFiles((cur) => cur.filter((f) => f.key !== key)); setReading(null); setErr(null); };
  const body = () => files.map((f) => ({ data: f.data }));
  /** A refusal names the file it concerns by the name the person sees (the server never learns it). */
  const named = (e: unknown) => {
    const sample = e instanceof ApiFailure ? Number(e.body?.error?.sample) : NaN;
    const msg = errText(e);
    return Number.isFinite(sample) && files[sample - 1] ? `“${files[sample - 1].name}”: ${msg.replace(/^Sample \d+: /, '')}` : msg;
  };

  const read = async () => {
    if (!files.length || busy) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy('read'); setErr(null);
    try {
      const r = await api.readRebuildFiles(body(), ctl.signal);
      if (ctl.signal.aborted) return;
      setReading(r); setOff(new Set()); setSampleTab(0);
      const first = r.samples[0]?.reading.blocks.find((b) => b.kind === 'heading');
      if (!title.trim() && first) setTitle(blockText(first).replace(/\s+/g, ' ').slice(0, TITLE_MAX));
      setStep('found');
    } catch (e) { if (!ctl.signal.aborted) setErr(named(e)); }
    finally { if (abortRef.current === ctl) abortRef.current = null; setBusy(null); }
  };

  /* ---- step 2 validity */
  const titleTrim = title.trim().replace(/\s+/g, ' ');
  const titleOk = titleTrim.length >= 2 && titleTrim.length <= TITLE_MAX;
  const issuerTrim = issuer.trim().replace(/\s+/g, ' ');
  const issuerOk = !issuerTrim || (issuerTrim.length >= ISSUER_NAME_MIN && issuerTrim.length <= ISSUER_NAME_MAX);

  const propose = async (useAi: boolean) => {
    if (busy || !titleOk || !issuerOk || (useAi && !consent)) return;
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy('propose'); setErr(null); setUnavailable(null);
    try {
      const r = await api.proposeRebuild({
        files: body(), useAi, unmarked: [...off], title: titleTrim, ...(issuerTrim ? { issuerName: issuerTrim } : {}),
        ...(useAi ? { placeholders, confirmNoCustomerData: consent, outline } : {}),
      }, ctl.signal);
      if (ctl.signal.aborted) return;
      if (r.mode === 'unavailable') { setUnavailable({ reason: r.reason, message: r.message, notes: r.notes }); return; }
      // The ordinary setup review: the same check, preview and customers as "Describe your document".
      const d = await api.draftSetup({ spec: r.spec, source: r.source, title: titleTrim, ...(issuerTrim ? { issuerName: issuerTrim } : {}) }, ctl.signal);
      if (ctl.signal.aborted) return;
      if (d.mode !== 'proposal') { setErr(d.message); return; }
      setReview({ proposal: { ...d, message: r.message, notes: [...new Set([...r.notes, ...d.notes])] }, report: r.report });
    } catch (e) { if (!ctl.signal.aborted) setErr(named(e)); }
    finally { if (abortRef.current === ctl) abortRef.current = null; setBusy(null); }
  };
  const cancel = () => { abortRef.current?.abort(); abortRef.current = null; setBusy(null); };

  /* ---- closing */
  const dirty = files.length > 0;
  const requestClose = () => { if (dirty) setConfirmDiscard(true); else onClose(); };
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  const stableClose = useCallback(() => closeRef.current(), []);
  const backFromReview = useCallback(() => setReview(null), []);

  useEffect(() => {
    const el = rootRef.current?.closest('.body');
    if (el) el.scrollTop = 0;
    rootRef.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus({ preventScroll: true });
  }, [step, review]);

  if (review) return <SetupDialog onClose={onClose} start={{ proposal: review.proposal, title: titleTrim, ...(issuerTrim ? { issuerName: issuerTrim } : {}), report: review.report, onBack: backFromReview }} />;

  const stepNo = step === 'choose' ? 1 : step === 'found' ? 2 : 3;
  const STEP_NAME: Record<Step, string> = { choose: 'Choose files', found: 'What was found', send: 'What will be sent' };
  const sample = reading?.samples[sampleTab];
  const marksOn = allMarks.filter((x) => !off.has(x.m.id)).length;

  /* ------------------------------------------------------------------ footer */
  const footer = confirmDiscard ? (
    <div className="sd-discard" role="alertdialog" aria-labelledby="rb-discard-q" data-testid="rebuild-discard-confirm">
      <span id="rb-discard-q"><strong>Stop rebuilding?</strong> The files you chose are forgotten. Nothing has been created.</span>
      <button type="button" className="btn" onClick={() => setConfirmDiscard(false)} data-testid="rebuild-keep">Keep going</button>
      <button type="button" className="btn danger" onClick={onClose} data-testid="rebuild-discard">Stop</button>
    </div>
  ) : step === 'choose' ? (
    <>
      <button type="button" className="btn" onClick={stableClose} data-testid="rebuild-cancel">Cancel</button>
      {busy === 'read' ? <button type="button" className="btn" onClick={cancel}>Stop reading</button> : null}
      <button type="button" className="btn primary" onClick={read} disabled={!files.length || !!busy} data-testid="rebuild-read">{busy === 'read' ? 'Reading…' : 'Read the files'}</button>
    </>
  ) : step === 'found' ? (
    <>
      {!titleOk && <span className="sd-foot-note muted">Give the document a name of 2–{TITLE_MAX} characters.</span>}
      <button type="button" className="btn" onClick={() => setStep('choose')} data-testid="rebuild-back">Back</button>
      <button type="button" className="btn primary" onClick={() => setStep('send')} disabled={!titleOk || !issuerOk} data-testid="rebuild-next">Next: what will be sent</button>
    </>
  ) : (
    <>
      {mode === 'ai' && !consent && <span className="sd-foot-note muted" data-testid="rebuild-consent-why">Confirm that the file contains no real customer data to send it, or continue without AI.</span>}
      <button type="button" className="btn" onClick={() => setStep('found')} disabled={!!busy} data-testid="rebuild-back">Back</button>
      {busy === 'propose' ? <button type="button" className="btn" onClick={cancel} data-testid="rebuild-stop">Stop</button> : null}
      {mode === 'ai'
        ? <button type="button" className="btn primary" onClick={() => void propose(true)} disabled={!consent || !!busy || aiLive !== true} data-testid="rebuild-propose">{busy === 'propose' ? 'Waiting for the AI model…' : 'Send to the AI model and propose'}</button>
        : <button type="button" className="btn primary" onClick={() => void propose(false)} disabled={!!busy} data-testid="rebuild-propose">{busy === 'propose' ? 'Proposing…' : 'Propose without AI'}</button>}
    </>
  );

  /* ------------------------------------------------------------------ steps */
  const choose = (
    <div className="sd-step" data-testid="rebuild-step-choose" hidden={step !== 'choose'}>
      <h3 className="sd-h" tabIndex={-1} data-step-heading>1. Choose the file</h3>
      <p className="rb-intro">Choose a PDF or Word (.docx) file of a document you already send. The studio reads its text and layout and proposes a new document: its data fields, sections and tables. Add a second or third sample of the same document, for other customers, to see where the wording varies.</p>
      <div className="row wrap rb-file-row">
        <label className={`btn sm sd-file${files.length >= MAX_FILES ? ' rb-disabled' : ''}`}>
          {files.length ? 'Add another sample' : 'Choose a file'}
          <input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple className="sd-file-input" disabled={files.length >= MAX_FILES || !!busy} onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} data-testid="rebuild-file-input" />
        </label>
        <span className="muted rb-limits">Up to {MAX_FILES} files, 10 MB and 20 pages each.</span>
      </div>
      {files.length > 0 && (
        <ol className="sd-rows rb-files" aria-label="Chosen files">
          {files.map((f, i) => (
            <li key={f.key} className="sd-row" data-testid="rebuild-file">
              <span className="chip count">Sample {i + 1}</span>
              <span className="sd-fname rb-fname" title={f.name}>{f.name}</span>
              <span className="muted">{sizeText(f.size)}</span>
              <button type="button" className="btn ghost sm rb-remove" onClick={() => removeFile(f.key)} disabled={!!busy} aria-label={`Remove “${f.name}”`} data-testid="rebuild-file-remove">Remove</button>
            </li>
          ))}
        </ol>
      )}
      {fileErr && <p className="callout error" role="alert" data-testid="rebuild-file-error">{fileErr}</p>}
      <p className="callout sd-privacy" data-testid="rebuild-privacy">The file is read by the studio, not by an AI model. Nothing is sent anywhere in this step, and the file is not kept: the studio reads it again when it proposes and forgets it afterwards. Pictures are noted by size and position only. A scanned PDF (pictures of pages) cannot be read.</p>
      {busy === 'read' && <div className="sd-busy callout" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><span>Reading the file…</span></div>}
      {err && step === 'choose' && <p className="callout error" role="alert" data-testid="rebuild-error">{err}</p>}
    </div>
  );

  const found = reading && sample ? (
    <div className="sd-step" data-testid="rebuild-step-found" hidden={step !== 'found'}>
      <h3 className="sd-h" tabIndex={-1} data-step-heading>2. What was found</h3>
      <div className="sd-grid rb-names">
        <div className="field">
          <label htmlFor="rb-title">Name of the document</label>
          <input id="rb-title" className="input" value={title} maxLength={TITLE_MAX} aria-invalid={!titleOk} onChange={(e) => setTitle(e.target.value)} data-testid="rebuild-title" />
        </div>
        <div className="field">
          <label htmlFor="rb-issuer">Who it is from <span className="muted">(optional)</span></label>
          <input id="rb-issuer" className="input" value={issuer} maxLength={ISSUER_NAME_MAX + 20} aria-invalid={!issuerOk} onChange={(e) => setIssuer(e.target.value)} data-testid="rebuild-issuer" />
        </div>
      </div>
      {reading.samples.length > 1 && (
        <div className="segmented rb-tabs" role="tablist" aria-label="Samples">
          {reading.samples.map((_, i) => <button key={i} type="button" role="tab" aria-selected={sampleTab === i} className={sampleTab === i ? 'active' : ''} onClick={() => setSampleTab(i)} data-testid="rebuild-sample-tab">Sample {i + 1}</button>)}
        </div>
      )}
      <p className="rb-summary" data-testid="rebuild-summary">
        {files[sampleTab]?.name ? <><span className="sd-fname" title={files[sampleTab].name}>{files[sampleTab].name}</span>: </> : null}
        a {FILE_KIND_LABEL[sample.reading.kind]} file, {sample.reading.kind === 'docx' ? 'about ' : ''}{sample.reading.pages} page{sample.reading.pages === 1 ? '' : 's'}, {sample.reading.paper.size ? PAPER_LABEL[sample.reading.paper.size] : `${Math.round(sample.reading.paper.widthPt)} × ${Math.round(sample.reading.paper.heightPt)} pt`} · {sample.reading.blocks.length} blocks · {sample.reading.blocks.filter((b) => b.kind === 'table').length} tables · {sample.reading.images.length} pictures · {sample.marks.filter((m) => !off.has(m.id)).length} likely personal details
      </p>
      <div className="rb-cols">
        <section className="sd-block" aria-labelledby="rb-blocks-h">
          <h4 id="rb-blocks-h" className="sd-bh">Text, headings and tables, in reading order</h4>
          <ol className="rb-blocks">{sample.reading.blocks.map((b) => <BlockView key={b.id} b={b} marks={sample.marks} off={off} />)}</ol>
        </section>
        <div className="rb-side">
          <section className="sd-block" data-testid="rebuild-marks" aria-labelledby="rb-marks-h">
            <h4 id="rb-marks-h" className="sd-bh">Likely personal details <span className="chip count">{sample.marks.length}</span></h4>
            <p className="hint">Marked because they look like one customer’s data. Untick anything that is the same for every customer (such as your own phone number).</p>
            {sample.marks.length === 0 ? <p className="muted">None found.</p> : (
              <ul className="rb-mark-list">
                {sample.marks.map((m) => (
                  <li key={m.id}>
                    <label className="rb-mark-row">
                      <input type="checkbox" checked={!off.has(m.id)} onChange={(e) => setOff((cur) => { const n = new Set(cur); if (e.target.checked) n.delete(m.id); else n.add(m.id); return n; })} data-testid="rebuild-mark-toggle" />
                      <span><span className="chip">{DETAIL_KIND_LABEL[m.kind]}</span> <span className="rb-mark-text">{m.text}</span> <span className="muted">→ {m.kind === 'name' ? 'the customer’s name' : m.field}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="sd-block" data-testid="rebuild-images" aria-labelledby="rb-img-h">
            <h4 id="rb-img-h" className="sd-bh">Pictures <span className="chip count">{sample.reading.images.length}</span></h4>
            {sample.reading.images.length === 0 ? <p className="muted">None.</p> : <ul className="sd-notes">{sample.reading.images.map((im, i) => <li key={i}>Page {im.page}: {Math.round(im.widthPt)} × {Math.round(im.heightPt)} pt{im.box ? `, ${Math.round(im.box.y)} pt from the top` : ''}. Not read.</li>)}</ul>}
          </section>
          <section className="sd-block" data-testid="rebuild-ignored" aria-labelledby="rb-ign-h">
            <h4 id="rb-ign-h" className="sd-bh">Ignored, and how it was read</h4>
            {sample.reading.ignored.length + sample.reading.notes.length === 0 ? <p className="muted">Nothing was ignored.</p> : <ul className="sd-notes">{[...sample.reading.ignored.map((x) => x.text), ...sample.reading.notes].map((t, i) => <li key={i}>{t}</li>)}</ul>}
          </section>
        </div>
      </div>
      {reading.alignment && reading.alignment.samples > 1 && (
        <section className="sd-block" data-testid="rebuild-compare" aria-labelledby="rb-cmp-h">
          <h4 id="rb-cmp-h" className="sd-bh">Where the samples differ</h4>
          <p className="hint">
            {(['same', 'values', 'different', 'partial'] as const).map((k, i) => <Fragment key={k}>{i ? ' · ' : ''}{ALIGN_KIND_LABEL[k]}: {reading.alignment!.counts[k]}</Fragment>)}
          </p>
          <div className="rb-table-wrap">
            <table className="table rb-compare">
              <thead><tr><th scope="col">Block</th><th scope="col">How the samples compare</th>{reading.samples.map((_, i) => <th key={i} scope="col">Sample {i + 1}</th>)}</tr></thead>
              <tbody>
                {reading.alignment.rows.map((row, ri) => {
                  const k = row.blocks.findIndex(Boolean);
                  const b = reading.samples[k].reading.blocks.find((x) => x.id === row.blocks[k]);
                  const text = b ? (b.kind === 'table' ? `Table: ${(b.rows?.[0] ?? []).join(', ')}` : blockText(b).replace(/\s+/g, ' ')) : '';
                  return (
                    <tr key={ri} data-testid="rebuild-compare-row" data-kind={row.kind}>
                      <td className="rb-clip" title={text}>{text}</td>
                      <td><span className={`chip${row.kind === 'different' ? ' variant' : row.kind === 'partial' ? ' warning' : row.kind === 'values' ? ' info' : ''}`}>{ALIGN_KIND_LABEL[row.kind]}</span>{row.slots?.length ? <span className="muted"> {row.slots.map((s) => s.name).join(', ')}</span> : null}</td>
                      {row.blocks.map((id, i) => <td key={i}>{id ? 'Yes' : <span className="muted">Not there</span>}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  ) : null;

  const send = reading ? (
    <div className="sd-step" data-testid="rebuild-step-send" hidden={step !== 'send'}>
      <h3 className="sd-h" tabIndex={-1} data-step-heading>3. What will be sent</h3>
      <fieldset className="sd-block rb-choice">
        <legend className="sd-bh">How to propose the document</legend>
        <label className="sd-radio"><input type="radio" name="rb-mode" checked={mode === 'ai'} disabled={aiLive !== true} onChange={() => { setMode('ai'); setUnavailable(null); }} data-testid="rebuild-mode-ai" /> <span>With the AI model: it proposes fields, fixed wording, tables and alternatives from the text and layout below.</span></label>
        <label className="sd-radio"><input type="radio" name="rb-mode" checked={mode === 'builtin'} onChange={() => { setMode('builtin'); setUnavailable(null); }} data-testid="rebuild-mode-builtin" /> <span>Continue without AI: the studio’s own reading turns headings, text and tables into sections and the marked details into data fields. Nothing is sent anywhere.</span></label>
        {aiLive === false && <NeedsAi message="No AI key is configured. Continue without AI: the studio’s own reading still proposes the document." />}
      </fieldset>
      {mode === 'ai' && (
        <>
          <fieldset className="sd-block rb-choice">
            <legend className="sd-bh">Personal details</legend>
            <label className="sd-radio"><input type="radio" name="rb-ph" checked={placeholders} onChange={() => setPlaceholders(true)} data-testid="rebuild-placeholders-on" /> <span><strong>Replace marked values with placeholders</strong> (recommended): the {marksOn} marked detail{marksOn === 1 ? '' : 's'} and every table row are sent as placeholders such as {'{{Amount due}}'}.</span></label>
            <label className="sd-radio"><input type="radio" name="rb-ph" checked={!placeholders} onChange={() => setPlaceholders(false)} data-testid="rebuild-placeholders-off" /> <span>Send the text as it is in the file.</span></label>
          </fieldset>
          <section className="sd-block" aria-labelledby="rb-out-h">
            <h4 id="rb-out-h" className="sd-bh">Exactly this is sent to the AI model</h4>
            <p className="hint">Text and layout only: no file name and no pictures. The studio checks again that it sends exactly this.</p>
            <pre className="rb-outline" tabIndex={0} aria-label="The text that will be sent" data-testid="rebuild-outline">{outline}</pre>
          </section>
          <label className="rb-consent callout warning">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="rebuild-consent" />
            <span><strong>This file contains no real customer data.</strong> I have read what will be sent{placeholders ? ' and checked that nothing that identifies a real customer is left' : ''}.</span>
          </label>
        </>
      )}
      {busy === 'propose' && <div className="sd-busy callout" role="status" aria-live="polite" data-testid="rebuild-busy"><span className="spinner" aria-hidden="true" /><span>{mode === 'ai' ? 'The AI model is proposing the document. This can take about half a minute. Nothing is created.' : 'Proposing the document…'}</span></div>}
      {unavailable && (
        <div className="callout warning sd-unavailable" role="status" data-testid="rebuild-unavailable" data-reason={unavailable.reason}>
          <p><strong>{unavailable.message}</strong></p>
          {unavailable.notes.length > 0 && <ul>{unavailable.notes.slice(0, 6).map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <button type="button" className="btn sm" onClick={() => { setMode('builtin'); setUnavailable(null); void propose(false); }} data-testid="rebuild-continue-builtin">Continue without AI</button>
        </div>
      )}
      {err && step === 'send' && <p className="callout error" role="alert" data-testid="rebuild-error">{err}</p>}
    </div>
  ) : null;

  return (
    <Dialog title="Rebuild from a file" onClose={stableClose} labelledBy="rebuild-dialog-title" footer={footer}>
      <div className="sd-root rb-root" ref={rootRef} data-testid="rebuild-dialog" data-step={step}>
        <p className="sd-steps muted" aria-label="Progress">Step {stepNo} of 4 · <strong>{STEP_NAME[step]}</strong></p>
        {choose}
        {found}
        {send}
      </div>
    </Dialog>
  );
}
