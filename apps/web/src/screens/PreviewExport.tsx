import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { resolve } from '@iss/resolver';
import type { ProfileId } from '@iss/model';
import { api, ApiFailure, type BatchDto, type BatchItemDto, type BinaryResult, type ScenarioRequest } from '../api/client';
import { useStudio, useScenarioRequest, useIsDirty } from '../state/store';
import { ScreenHeader, Empty, Proof, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import './PreviewExport.css';

type Tab = 'pdf' | 'html' | 'afp' | 'batch';
type Device = 'desktop' | 'tablet' | 'mobile';
const DEVICES: Record<Device, { label: string; width: number }> = { desktop: { label: 'Desktop 1200', width: 1200 }, tablet: { label: 'Tablet 768', width: 768 }, mobile: { label: 'Mobile 390', width: 390 } };
const AFP_LABEL = 'AFP simulation only — no MO:DCA / AFP print stream generated';

interface Issue { code?: string; severity?: string; message?: string; nodeId?: string }
interface Job<T> { status: 'idle' | 'running' | 'done' | 'error'; result?: T; runId?: string; error?: { code: string; message: string; issues: Issue[] }; startedAt?: number }
interface HtmlResult { bin: BinaryResult; text: string }
interface Session {
  pdf: Job<BinaryResult>; html: Job<HtmlResult>; afp: Job<any>; parity: Job<any>;
}
/** Results survive switching screens within the browser session (blob URLs stay valid). */
const cache = new Map<string, Session>();
const emptySession = (): Session => ({ pdf: { status: 'idle' }, html: { status: 'idle' }, afp: { status: 'idle' }, parity: { status: 'idle' } });

const short = (s?: string | null, n = 10) => (s ? s.slice(0, n) : '—');
const parseTime = (iso: string) => new Date(iso.includes('Z') || iso.includes('+') ? iso : iso.replace(' ', 'T') + 'Z');
const fmtTime = (iso: string) => { const d = parseTime(iso); return isNaN(+d) ? iso : d.toLocaleString(); };
function relTime(iso: string): string {
  const d = parseTime(iso); if (isNaN(+d)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - +d) / 1000));
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}
const pretty = (v: unknown): string => (v === undefined ? '— (not extracted)' : JSON.stringify(v, null, 2));
const NOUN: Record<string, [string, string]> = {
  'selected-variants': ['variant', 'variants'], money: ['amount', 'amounts'], 'member-liability': ['guarded item', 'guarded items'], disclosures: ['disclosure', 'disclosures'],
  'required-nodes': ['required node', 'required nodes'], 'table-rows': ['table', 'tables'], 'table-totals': ['table total', 'table totals'], identity: ['identity field', 'identity fields'], actions: ['action', 'actions'],
};
const sizeOf = (v: unknown): number => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : v === undefined || v === null ? 0 : 1);
/** Human summary derived only from the check's own values. */
export function paritySummary(c: any): string {
  const [one, many] = NOUN[c.id] ?? ['value', 'values'];
  const n = sizeOf(c.expected);
  const base = `${n} ${n === 1 ? one : many}`;
  if (c.status === 'match') return `${base} · identical`;
  if (c.status === 'allowed-difference') return `${base} · allowed difference`;
  const who = [JSON.stringify(c.pdf) !== JSON.stringify(c.expected) ? 'PDF' : '', JSON.stringify(c.html) !== JSON.stringify(c.expected) ? 'HTML' : ''].filter(Boolean).join(' and ') || 'output';
  let keys = '';
  const e = c.expected;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    const bad = Object.keys(e).filter((k) => JSON.stringify((c.pdf ?? {})[k]) !== JSON.stringify(e[k]) || JSON.stringify((c.html ?? {})[k]) !== JSON.stringify(e[k]));
    if (bad.length) keys = `: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ` +${bad.length - 3}` : ''}`;
  }
  return `${who} differ from expected${keys}`;
}

function toError(e: unknown): { code: string; message: string; issues: Issue[] } {
  if (e instanceof ApiFailure) return { code: e.code, message: e.message, issues: e.body?.error?.issues ?? [] };
  return { code: 'UNKNOWN', message: String(e), issues: [] };
}

function useElapsed(since?: number, active?: boolean) {
  const [, setT] = useState(0);
  useEffect(() => { if (!active) return; const iv = setInterval(() => setT((x) => x + 1), 200); return () => clearInterval(iv); }, [active]);
  return since && active ? ((Date.now() - since) / 1000).toFixed(1) : '0.0';
}

export function PreviewExport() {
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const records = useStudio((s) => s.records);
  const baseReq = useScenarioRequest();
  const projectId = project.projectId;

  const [tab, setTab] = useState<Tab>('pdf');
  const [session, setSession] = useState<Session>(() => cache.get(projectId) ?? emptySession());
  const [device, setDevice] = useState<Device>('desktop');
  const [history, setHistory] = useState<any[] | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [histTick, setHistTick] = useState(0);
  const seq = useRef({ pdf: 0, html: 0, afp: 0, parity: 0 });

  useEffect(() => { setSession(cache.get(projectId) ?? emptySession()); }, [projectId]);
  const update = useCallback(<K extends keyof Session>(k: K, job: Session[K]) => {
    setSession((s) => { const n = { ...s, [k]: job }; cache.set(projectId, n); return n; });
  }, [projectId]);

  useEffect(() => {
    let live = true;
    api.artifacts({ projectId }).then((r) => { if (live) { setHistory(r.artifacts); setHistoryErr(null); } }, (e) => { if (live) setHistoryErr(toError(e).message); });
    return () => { live = false; };
  }, [projectId, histTick]);

  const profileReq = (p?: ProfileId): ScenarioRequest | null => (baseReq ? { ...baseReq, ...(p ? { outputContext: { profileId: p } } : {}) } : null);

  /** Expected run id per output profile for the live (possibly unsaved) model and scenario. */
  const expected = useMemo(() => {
    const rec = records.find((r) => r.recordId === ctx.recordId);
    const out: Record<string, string | null> = { 'paged-pdf': null, 'html-responsive': null, 'paged-afp-sim': null };
    if (!rec || rec.documentType !== project.documentType) return out;
    for (const p of Object.keys(out) as ProfileId[]) {
      try { out[p] = resolve({ project, record: rec, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor, profileId: p }).runId; } catch { out[p] = null; }
    }
    return out;
  }, [project, records, ctx.recordId, ctx.overrides, ctx.journeyCursor]);

  /* ---------------- actions */
  const runPdf = async (allowDraft = false) => {
    const req = profileReq('paged-pdf'); if (!req) return;
    const my = ++seq.current.pdf;
    update('pdf', { ...session.pdf, status: 'running', startedAt: Date.now(), error: undefined });
    try {
      const bin = await api.composePdf({ ...req, ...(allowDraft ? { allowDraft: true } : {}) });
      if (seq.current.pdf !== my) return;
      update('pdf', { status: 'done', result: bin, runId: bin.runId });
      setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.pdf !== my) return;
      update('pdf', { status: 'error', error: toError(e) });
    }
  };
  const runHtml = async (allowDraft = false) => {
    const req = profileReq('html-responsive'); if (!req) return;
    const my = ++seq.current.html;
    update('html', { ...session.html, status: 'running', startedAt: Date.now(), error: undefined });
    try {
      const bin = await api.composeHtml({ ...req, ...(allowDraft ? { allowDraft: true } : {}) });
      const text = await bin.blob.text();
      if (seq.current.html !== my) return;
      update('html', { status: 'done', result: { bin, text }, runId: bin.runId });
      setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.html !== my) return;
      update('html', { status: 'error', error: toError(e) });
    }
  };
  const runAfp = async () => {
    const req = profileReq('paged-afp-sim'); if (!req) return;
    const my = ++seq.current.afp;
    update('afp', { ...session.afp, status: 'running', startedAt: Date.now(), error: undefined });
    try {
      const sim = await api.afpSim(req);
      if (seq.current.afp !== my) return;
      update('afp', { status: 'done', result: sim, runId: sim.runId });
      setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.afp !== my) return;
      update('afp', { status: 'error', error: toError(e), result: session.afp.result });
    }
  };
  const runParity = async () => {
    const req = profileReq(); if (!req) return;
    const my = ++seq.current.parity;
    update('parity', { ...session.parity, status: 'running', startedAt: Date.now(), error: undefined });
    try {
      const r = await api.parity(req);
      if (seq.current.parity !== my) return;
      update('parity', { status: 'done', result: r, runId: r.runId });
      setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.parity !== my) return;
      update('parity', { status: 'error', error: toError(e), result: session.parity.result });
    }
  };
  const cancel = (k: keyof Session) => { seq.current[k]++; update(k, { ...session[k], status: session[k].result ? 'done' : 'idle' } as any); };

  const stale = {
    pdf: !!session.pdf.runId && !!expected['paged-pdf'] && session.pdf.runId !== expected['paged-pdf'],
    html: !!session.html.runId && !!expected['html-responsive'] && session.html.runId !== expected['html-responsive'],
    afp: !!session.afp.runId && !!expected['paged-afp-sim'] && session.afp.runId !== expected['paged-afp-sim'],
  };
  const tabs: Array<{ id: Tab; label: string; chip?: ReactNode; stale: boolean }> = [
    { id: 'pdf', label: 'PDF (real)', stale: stale.pdf },
    { id: 'html', label: 'HTML (real)', stale: stale.html },
    { id: 'afp', label: 'AFP (simulated)', stale: stale.afp, chip: <span className="chip sim">SIMULATION</span> },
    { id: 'batch', label: 'Batch', stale: false },
  ];
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    if (e.key === 'ArrowRight') { setTab(tabs[(i + 1) % tabs.length].id); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setTab(tabs[(i + tabs.length - 1) % tabs.length].id); e.preventDefault(); }
  };

  if (!baseReq) return <section className="screen" data-testid="outputs-view"><ScreenHeader id="S10" title="Preview & Export" subtitle="" /><Empty title="No scenario" message="No matching fixture for this project." /></section>;

  const isEob = project.documentType === 'eob';
  return (
    <section className="screen" data-testid="outputs-view">
      <ScreenHeader
        id="S10" title="Preview & Export"
        subtitle="Real PDF and interactive HTML composed from the same resolved semantic tree; AFP is a feasibility simulation only."
        badge={<span className="chip">{ctx.recordId}{ctx.journeyCursor != null ? ` · journey ${ctx.journeyCursor}` : ''}{Object.keys(ctx.overrides).length ? ' · overrides' : ''}</span>}
      />
      <div className="screen-body ox-body">
        <div className="panel ox-main">
          <div className="tabs ox-tabs" role="tablist" aria-label="Output type" onKeyDown={onTabKey}>
            {tabs.map((t) => (
              <button key={t.id} role="tab" id={`ox-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`ox-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
                {t.label} {t.chip}{t.stale && <span className="chip warning" style={{ marginLeft: 6 }}>stale</span>}
              </button>
            ))}
          </div>
          <div className="ox-panel" key={tab} role="tabpanel" id={`ox-panel-${tab}`} aria-labelledby={`ox-tab-${tab}`}>
            {tab === 'pdf' && <PdfTab job={session.pdf} stale={stale.pdf} onRun={runPdf} onCancel={() => cancel('pdf')} isEob={isEob} />}
            {tab === 'html' && <HtmlTab job={session.html} stale={stale.html} onRun={runHtml} onCancel={() => cancel('html')} device={device} setDevice={setDevice} isEob={isEob} />}
            {tab === 'afp' && <AfpTab job={session.afp} stale={stale.afp} onRun={runAfp} onCancel={() => cancel('afp')} />}
            {tab === 'batch' && <BatchTab />}
          </div>
        </div>

        <div className="ox-side">
          <ParityPanel job={session.parity} onRun={runParity} />
          <section className="panel ox-history" aria-label="Export history">
            <div className="panel-head">Export history <span className="sub">{history ? `${history.length} artifacts` : ''}</span>
              <span className="right"><button className="btn sm ghost" onClick={() => setHistTick((t) => t + 1)} aria-label="Refresh export history"><Icon.reset /></button></span>
            </div>
            <div className="panel-body ox-hist-body" data-testid="export-history">
              {historyErr ? <div className="callout error" style={{ margin: 10 }}>{historyErr}</div>
                : !history ? <div className="empty" role="status"><span className="spinner" /></div>
                : history.length === 0 ? <div className="empty"><strong>No exports yet</strong><span>Generate a PDF, HTML or AFP simulation report to start the history.</span></div>
                : (
                  <ul className="ox-hist-list">
                    {history.map((a) => <HistoryRow key={a.artifactId} a={a} />)}
                  </ul>
                )}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function HistoryRow({ a }: { a: any }) {
  const [copied, setCopied] = useState(false);
  const kindLabel = a.kind === 'afp-sim' ? 'AFP sim' : String(a.kind).toUpperCase();
  const copy = async () => { try { await navigator.clipboard.writeText(a.sha256); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard unavailable */ } };
  const detail = [a.recordId, a.kind === 'afp-sim' ? 'simulation report (JSON)' : a.pageCount != null ? `${a.pageCount} page${a.pageCount === 1 ? '' : 's'}` : a.size ? `${(a.size / 1024).toFixed(1)} KB` : ''].filter(Boolean).join(' · ');
  return (
    <li className="ox-hist-row" data-testid="history-row">
      <span className={'chip ox-kind' + (a.kind === 'afp-sim' ? ' sim' : a.kind === 'pdf' ? ' accent' : ' info')}>{kindLabel}</span>
      <span className="ox-file">
        <a href={api.artifactUrl(a.artifactId)} download={a.filename} title={`Download ${a.filename}`}><Icon.download /><span className="ox-fname">{a.filename}</span></a>
        <small title={detail}>{detail}</small>
      </span>
      <span className="ox-hist-meta">
        <span className="ox-hash"><code title={a.sha256}>{short(a.sha256, 8)}</code>
          <button className="btn sm ghost icon" onClick={copy} aria-label={`Copy SHA-256 of ${a.filename}`} title={copied ? 'Copied' : 'Copy SHA-256'}>{copied ? <Icon.validate /> : <Icon.copy />}</button></span>
        <time dateTime={a.createdAt} title={fmtTime(a.createdAt)}>{relTime(a.createdAt)}</time>
      </span>
    </li>
  );
}

/* ------------------------------------------------------------ shared job UI */

function JobBar({ job, label, onRun, onCancel, testId, runLabel, extra }: { job: Job<any>; label: string; onRun: () => void; onCancel: () => void; testId: string; runLabel: string; extra?: ReactNode }) {
  const running = job.status === 'running';
  const el = useElapsed(job.startedAt, running);
  return (
    <div className="ox-jobbar">
      <button className="btn primary" onClick={onRun} disabled={running} data-testid={testId}>{running ? <span className="spinner" /> : <Icon.outputs />} {runLabel}</button>
      {running && <><span className="chip info" role="status" aria-live="polite">Composing {label}… {el} s</span><button className="btn sm ghost" onClick={onCancel}>Cancel</button></>}
      {extra}
    </div>
  );
}

function IssuesBlock({ job, onDraft, kind }: { job: Job<any>; onDraft?: () => void; kind: string }) {
  if (job.status !== 'error' || !job.error) return null;
  const e = job.error;
  const blocked = e.code === 'BLOCKING_DIAGNOSTICS';
  return (
    <div className="callout error ox-issues" role="alert" data-testid={blocked ? 'blocking-issues' : 'compose-error'}>
      <strong>{blocked ? `${kind} export blocked` : `${kind} composition failed`} <span className="mono">({e.code})</span></strong>
      <span>{e.message}</span>
      {e.issues.length > 0 && (
        <ul>
          {e.issues.map((i, k) => <li key={k}><span className="sev">{i.severity ?? 'issue'}</span> <strong>{i.code}</strong>{i.nodeId ? ` · ${i.nodeId}` : ''} — {i.message}</li>)}
        </ul>
      )}
      <div className="row" style={{ gap: 8 }}>
        {blocked && onDraft && <button className="btn sm danger" onClick={onDraft} data-testid="export-draft">Export watermarked draft</button>}
        {!blocked && <span className="muted">Use the export button again to retry.</span>}
      </div>
    </div>
  );
}

function Pending({ what, stale }: { what: string; stale?: boolean }) {
  return (
    <div className="ox-pending">
      <div className="ox-pending-ico"><Icon.outputs /></div>
      <strong>{stale ? 'Preview is stale' : 'Not composed yet'}</strong>
      <span>{stale ? 'The model or scenario changed since this file was generated.' : `Generate the ${what} to see the real file for the current scenario.`}</span>
    </div>
  );
}

/* ------------------------------------------------------------ PDF */

function PdfTab({ job, stale, onRun, onCancel, isEob }: { job: Job<BinaryResult>; stale: boolean; onRun: (d?: boolean) => void; onCancel: () => void; isEob: boolean }) {
  const r = job.result;
  return (
    <>
      <JobBar job={job} label="PDF" onRun={() => onRun(false)} onCancel={onCancel} testId="export-pdf" runLabel={r ? 'Regenerate PDF' : 'Generate PDF'}
        extra={r && <a className="btn" href={r.url} download={r.filename} data-testid="download-pdf"><Icon.download /> Download PDF</a>} />
      {stale && r && <div className="callout warning ox-stale" data-testid="stale-pdf">Stale preview — the model or scenario changed since this PDF was exported. Regenerate to refresh.</div>}
      <IssuesBlock job={job} kind="PDF" onDraft={() => onRun(true)} />
      {r ? (
        <>
          <div className="ox-strip">
            <span className={'chip ' + (r.draft ? 'error' : 'accent')}>{r.draft ? 'Watermarked draft' : 'Clean export'}</span>
            <span>Pages <strong data-testid="pdf-page-count">{r.pageCount ?? '—'}</strong> composed · <strong data-testid="pdf-verified-count">{r.pdfPageCount ?? '—'}</strong> verified</span>
            {isEob && <span className="muted">Carries “THIS IS NOT A BILL”.</span>}
            <Proof label="Proof">
              <span className="ox-proof">Run <code>{r.runId}</code> · digest <code title={r.contentDigest}>{short(r.contentDigest, 16)}…</code> · SHA-256 <code title={r.sha256}>{short(r.sha256, 16)}…</code> · <code>{r.filename}</code></span>
            </Proof>
          </div>
          <div className={'ox-viewer' + (stale ? ' is-stale' : '')} data-testid="pdf-preview">
            <iframe src={r.url} title="Generated PDF preview" />
            {stale && <div className="ox-stale-veil">STALE</div>}
          </div>
          <p className="muted ox-foot">If the embedded viewer is blocked by the browser, <a href={r.url} target="_blank" rel="noreferrer">open the PDF in a new tab</a>.</p>
        </>
      ) : job.status !== 'running' && job.status !== 'error' ? <Pending what="PDF" /> : null}
    </>
  );
}

/* ------------------------------------------------------------ HTML */

function HtmlTab({ job, stale, onRun, onCancel, device, setDevice, isEob }: { job: Job<HtmlResult>; stale: boolean; onRun: (d?: boolean) => void; onCancel: () => void; device: Device; setDevice: (d: Device) => void; isEob: boolean }) {
  const r = job.result;
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth)); ro.observe(el); setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, [r]);
  const w = DEVICES[device].width;
  const scale = Math.min(1, (avail - 24) / w);
  const H = 640;
  return (
    <>
      <JobBar job={job} label="HTML" onRun={() => onRun(false)} onCancel={onCancel} testId="export-html" runLabel={r ? 'Regenerate HTML' : 'Generate HTML'}
        extra={<>
          {r && <a className="btn" href={r.bin.url} download={r.bin.filename} data-testid="download-html"><Icon.download /> Download HTML</a>}
          <div className="segmented" role="group" aria-label="Device width">
            {(Object.keys(DEVICES) as Device[]).map((d) => <button key={d} aria-pressed={device === d} onClick={() => setDevice(d)} data-testid={`device-${d}`}>{DEVICES[d].label}</button>)}
          </div>
        </>} />
      {stale && r && <div className="callout warning ox-stale" data-testid="stale-html">Stale preview — the model or scenario changed since this HTML was exported. Regenerate to refresh.</div>}
      <IssuesBlock job={job} kind="HTML" onDraft={() => onRun(true)} />
      {r ? (
        <>
          <div className="ox-strip">
            <span className={'chip ' + (r.bin.draft ? 'error' : 'accent')}>{r.bin.draft ? 'Watermarked draft' : 'Clean export'}</span>
            <span>{(r.bin.blob.size / 1024).toFixed(1)} KB · shown at {w}px</span>
            <span className="muted">{isEob ? 'Carries “THIS IS NOT A BILL”. ' : ''}Sorting and filtering work in the file; totals never change.</span>
            <Proof label="Proof">
              <span className="ox-proof">Run <code>{r.bin.runId}</code> · digest <code title={r.bin.contentDigest}>{short(r.bin.contentDigest, 16)}…</code> · SHA-256 <code title={r.bin.sha256}>{short(r.bin.sha256, 16)}…</code> · <code>{r.bin.filename}</code></span>
            </Proof>
          </div>
          <div className={'ox-viewer ox-html' + (stale ? ' is-stale' : '')} ref={box} style={{ height: H + 24 }} data-testid="html-preview">
            <div className="ox-device" style={{ width: w * scale, height: H }}>
              <iframe title={`Interactive HTML preview at ${w}px`} sandbox="allow-scripts allow-popups" srcDoc={r.text}
                style={{ width: w, height: H / scale, transform: `scale(${scale})`, transformOrigin: '0 0' }} data-testid="html-iframe" />
            </div>
            {stale && <div className="ox-stale-veil">STALE</div>}
          </div>
        </>
      ) : job.status !== 'running' && job.status !== 'error' ? <Pending what="interactive HTML" /> : null}
    </>
  );
}

/* ------------------------------------------------------------ AFP simulation */

function AfpTab({ job, stale, onRun, onCancel }: { job: Job<any>; stale: boolean; onRun: () => void; onCancel: () => void }) {
  const s = job.result;
  return (
    <>
      <div className="ox-afp-banner" role="note" data-testid="afp-sim-label">
        <Icon.warning /> <strong>{AFP_LABEL}</strong>
        <span>Conceptual feasibility report derived from the real paged composition. No .afp file is produced or offered.</span>
      </div>
      <JobBar job={job} label="AFP simulation" onRun={onRun} onCancel={onCancel} testId="view-afp-simulation" runLabel={s ? 'Refresh AFP simulation' : 'View AFP simulation'} />
      {stale && s && <div className="callout warning ox-stale" data-testid="stale-afp">Stale — the model or scenario changed since this simulation was generated.</div>}
      <IssuesBlock job={job} kind="AFP simulation" />
      {s ? (
        <div className="ox-afp">
          <div className="ox-afp-grid">
            <section className="card ox-card"><h3>Media</h3>
              <dl className="kv"><dt>Paper</dt><dd>{s.media?.paper}</dd><dt>Size</dt><dd>{s.media?.widthPt} × {s.media?.heightPt} pt</dd><dt>Duplex</dt><dd>{String(s.media?.duplex)}</dd><dt>Margins (mm)</dt><dd>{(s.media?.marginsMm ?? []).join(' / ')}</dd><dt>Pages</dt><dd>{s.pageCount ?? '—'}</dd><dt>AFP bytes generated</dt><dd data-testid="afp-bytes">{s.afpBytesGenerated}</dd></dl>
            </section>
            <section className="card ox-card"><h3>Form definition / page definition (concept)</h3>
              <dl className="kv"><dt>FORMDEF</dt><dd className="mono">{s.formdef}</dd><dt>PAGEDEF</dt><dd className="mono">{s.pagedef}</dd><dt>Run ID</dt><dd className="mono">{s.runId}</dd></dl>
              <h4>Continuation regions</h4>
              {(s.continuationRegions ?? []).map((c: any, i: number) => <dl key={i} className="kv"><dt>{c.name}</dt><dd>first {c.firstPageTopPt} · others {c.otherPagesTopPt} · bottom {c.bottomPt} pt</dd></dl>)}
            </section>
            <section className="card ox-card"><h3>Font map</h3>
              {Object.keys(s.fontMap ?? {}).length === 0 ? <span className="muted">None defined.</span> : <dl className="kv">{Object.entries(s.fontMap).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{String(v)}</dd></Fragment>)}</dl>}
              <h4>Overlays</h4>
              <div className="ox-chips">{(s.overlays ?? []).length ? s.overlays.map((o: string) => <span key={o} className="chip">{o}</span>) : <span className="muted">None.</span>}</div>
            </section>
            <section className="card ox-card"><h3>Resource checklist</h3>
              <ul className="ox-check">
                {(s.checklist ?? []).map((c: any, i: number) => <li key={i}><span className={'chip ' + (c.ok ? 'accent' : 'sim')}>{c.ok ? 'ok' : 'concept'}</span> {c.item}{c.note ? <small> — {c.note}</small> : null}</li>)}
                {(s.resources ?? []).map((r: any) => <li key={r.name}><span className="chip sim">{r.status}</span> <span className="mono">{r.name}</span></li>)}
              </ul>
            </section>
          </div>
          <section className="card ox-card"><h3>Page sequence</h3>
            <table className="table ox-seq">
              <thead><tr><th>Sheet</th><th>Side</th><th>Page</th><th>Nodes</th><th>Continued tables</th></tr></thead>
              <tbody>{(s.pageSequence ?? []).map((p: any) => <tr key={p.page}><td>{p.sheet}</td><td>{p.side}</td><td>{p.page}</td><td>{(p.nodeIds ?? []).join(', ')}</td><td>{(p.continuedTables ?? []).join(', ') || '—'}</td></tr>)}</tbody>
            </table>
          </section>
          {(s.warnings ?? []).length > 0 && <div className="callout warning"><ul className="ox-warn">{s.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></div>}
        </div>
      ) : job.status !== 'running' && job.status !== 'error' ? <Pending what="AFP simulation report" /> : null}
    </>
  );
}

/* ------------------------------------------------------------ parity */

function ParityPanel({ job, onRun }: { job: Job<any>; onRun: () => void }) {
  const r = job.result;
  const running = job.status === 'running';
  const el = useElapsed(job.startedAt, running);
  const rep = r?.report;
  return (
    <section className="panel ox-parity" data-testid="semantic-parity" aria-label="Semantic parity">
      <div className="panel-head">Semantic parity
        <span className="right">
          {rep && <span className={'chip ' + (rep.ok ? 'accent' : 'error')} data-testid="parity-status">{rep.ok ? 'OK — all match' : 'Mismatch'}</span>}
          <button className="btn sm primary" onClick={onRun} disabled={running} data-testid="run-parity">{running ? <><span className="spinner" /> {el} s</> : rep ? 'Re-run parity' : 'Run parity check'}</button>
        </span>
      </div>
      <div className="panel-body" style={{ padding: rep ? 0 : 12 }}>
        <IssuesBlock job={job} kind="Parity" />
        {!rep ? (job.status === 'error' ? null : <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Compares money, selected variants, disclosures, table rows and totals, and identity between the real PDF and HTML of this run. Layout differences are expected and listed separately.</p>) : (
          <>
            <div className="ox-par-sum">
              <span className="chip">{rep.checks.length} checks</span>
              <span className="chip accent">{rep.checks.filter((c: any) => c.status === 'match').length} match</span>
              <span className={'chip ' + (rep.checks.some((c: any) => c.status === 'mismatch') ? 'error' : '')}>{rep.checks.filter((c: any) => c.status === 'mismatch').length} mismatch</span>
              <span className="chip">PDF {r.pdf?.pdfPageCount ?? r.pdf?.pageCount} pp</span>
              {r.draft && <span className="chip error">draft run</span>}
            </div>
            <div className="ox-par-scroll">
              <table className="table ox-par-table" data-testid="parity-table">
                <caption className="ox-sr">Semantic parity checks between the PDF and HTML outputs; select a row to see expected, PDF and HTML values.</caption>
                <thead><tr><th scope="col">Check</th><th scope="col">Result</th></tr></thead>
                <tbody>
                  {rep.checks.map((c: any) => <ParityRow key={c.id} c={c} />)}
                </tbody>
              </table>
            </div>
            <div className="ox-allowed"><strong>Allowed differences</strong><ul>{rep.allowedDifferences.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></div>
          </>
        )}
      </div>
    </section>
  );
}

export function ParityRow({ c }: { c: any }) {
  const [open, setOpen] = useState(c.status === 'mismatch');
  const bad = c.status === 'mismatch';
  const id = `ox-par-${c.id}`;
  return (
    <>
      <tr className={'ox-par-row' + (bad ? ' selected' : '')} data-testid={`parity-row-${c.id}`} onClick={() => setOpen((o) => !o)}>
        <td>
          <button className="ox-par-toggle" aria-expanded={open} aria-controls={id} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
            <span className={'ox-chev' + (open ? ' open' : '')} aria-hidden="true"><Icon.chevron /></span>
            <span className="ox-par-text"><strong>{c.label}</strong><small>{paritySummary(c)}</small></span>
          </button>
        </td>
        <td className="ox-par-res">
          <span className={'chip ' + (c.status === 'match' ? 'accent' : c.status === 'mismatch' ? 'error' : 'info')}>{c.status === 'match' ? '✓ match' : c.status === 'mismatch' ? '✕ mismatch' : 'allowed'}</span>
          <small>{c.blocking ? 'blocking' : 'advisory'}</small>
        </td>
      </tr>
      {open && (
        <tr className="ox-par-detail" id={id}>
          <td colSpan={2}>
            {c.note && <p className="ox-note-s">{c.note}</p>}
            {(['expected', 'pdf', 'html'] as const).map((k) => (
              <div key={k} className="ox-par-val"><span>{k === 'expected' ? 'Expected' : k.toUpperCase()}</span><pre className="mono">{pretty(c[k])}</pre></div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}


/* ======================================================================= Batch tab */

const BLOCK_WORDS: Record<string, string> = {
  BALANCE_RECONCILIATION_FAILED: 'Balances do not add up', CLAIM_RECONCILIATION_FAILED: 'Claim amounts do not add up',
  INCONSISTENT_PAYMENT_STATE: 'Payment state is inconsistent', UNCONFIRMED_DEBT_LANGUAGE: 'Debt wording used without confirmed debt',
  UNCONFIRMED_MEMBER_LIABILITY: 'Member liability not confirmed', REQUIRED_NODE_MISSING: 'A required section is missing',
  REQUIRED_TRANSLATION_MISSING: 'A required translation is missing', NO_VARIANT_MATCH: 'No wording matches this customer',
  EXCLUSIVE_PRIORITY_TIE: 'Two rules tie for the same spot', MISSING_CONTENT_PART: 'Content is missing', NULL_BINDING: 'A data field is empty',
  INVALID_BINDING: 'A data field is invalid', IMAGE_ALT_MISSING: 'An image has no description', UNSAFE_URL: 'A link is not allowed',
  RECORD_TYPE_MISMATCH: 'Record does not fit this document', UNKNOWN_VARIANT: 'Unknown wording variant', UNKNOWN_SECTION: 'Unknown section',
};
const blockWord = (c: string) => BLOCK_WORDS[c] ?? c.toLowerCase().replace(/_/g, ' ');
const STATUS_LABEL: Record<BatchItemDto['status'], string> = { pending: 'Waiting', ok: 'Done', draft: 'Draft', blocked: 'Blocked', failed: 'Failed' };
const STATUS_CLASS: Record<BatchItemDto['status'], string> = { pending: '', ok: 'accent', draft: 'warning', blocked: 'error', failed: 'error' };
const fmtMb = (n: number | null | undefined) => (n == null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDur = (ms: number | null | undefined) => { if (ms == null) return '—'; const s = ms / 1000; return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`; };
type Pick = 'all' | 'filter' | 'selected';

function StatusChip({ s }: { s: BatchItemDto['status'] }) {
  return <span className={`chip ${STATUS_CLASS[s]}`} data-status={s}>{STATUS_LABEL[s]}</span>;
}

function BatchTab() {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const dirty = useIsDirty();
  const pool = useMemo(() => records.filter((r) => r.documentType === project.documentType), [records, project.documentType]);
  const noun = project.documentType === 'eob' ? 'members' : 'customers';

  const [pick, setPick] = useState<Pick>('all');
  const [persona, setPersona] = useState('');
  const [claimStatus, setClaimStatus] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [outPdf, setOutPdf] = useState(true);
  const [outHtml, setOutHtml] = useState(true);
  const [drafts, setDrafts] = useState(false);
  const [batch, setBatch] = useState<BatchDto | null>(null);
  const [recent, setRecent] = useState<Array<Omit<BatchDto, 'items'>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState<'all' | BatchItemDto['status']>('all');
  const [now, setNow] = useState(Date.now());
  const liveId = useRef<string | null>(null);

  const nameOf = (r: (typeof pool)[number]) => `${r.customer.givenName} ${r.customer.familyName}`;
  const claimStatuses = useMemo(() => [...new Set(pool.flatMap((r) => (r.claims ?? []).map((c) => String(c.status ?? ''))).filter(Boolean))].sort(), [pool]);
  const personaIds = useMemo(() => [...new Set(pool.map((r) => r.personaId).filter((x): x is string => !!x))].sort(), [pool]);
  const filtered = useMemo(() => pool.filter((r) => (!persona || r.personaId === persona) && (!claimStatus || (r.claims ?? []).some((c) => c.status === claimStatus))), [pool, persona, claimStatus]);
  const visible = useMemo(() => { const q = search.trim().toLowerCase(); return q ? pool.filter((r) => `${nameOf(r)} ${r.recordId} ${r.personaId ?? ''}`.toLowerCase().includes(q)) : pool; }, [pool, search]);
  const targets = pick === 'all' ? pool : pick === 'filter' ? filtered : pool.filter((r) => chosen.has(r.recordId));
  const outputs = [...(outPdf ? ['pdf' as const] : []), ...(outHtml ? ['html' as const] : [])];

  const refreshRecent = useCallback(() => { api.batches().then((r) => setRecent(r.batches), () => undefined); }, []);

  /* poll the running batch every ~700 ms; stop when finished; clean up on unmount */
  const running = batch?.status === 'running';
  const batchId = batch?.batchId;
  useEffect(() => {
    if (!running || !batchId) return;
    let live = true;
    const tick = async () => {
      try {
        const r = await api.batch(batchId);
        if (!live) return;
        setBatch(r.batch);
        if (r.batch.status !== 'running') refreshRecent();
      } catch (e) { if (live) setError(toError(e).message); }
    };
    const iv = window.setInterval(() => { setNow(Date.now()); void tick(); }, 700);
    return () => { live = false; window.clearInterval(iv); };
  }, [running, batchId, refreshRecent]);

  /* resume a batch that is still running (e.g. after switching tabs) and load history */
  useEffect(() => {
    let live = true;
    api.batches().then(async (r) => {
      if (!live) return;
      setRecent(r.batches);
      const run = r.batches.find((b) => b.status === 'running');
      if (run && !liveId.current) { const full = await api.batch(run.batchId); if (live) setBatch(full.batch); }
    }, () => undefined);
    return () => { live = false; };
  }, []);

  const start = async () => {
    setError(null); setStarting(true); setFilter('all');
    try {
      const ids = pick === 'all' ? undefined : targets.map((r) => r.recordId);
      const r = await api.startBatch({ projectId: project.projectId, project, recordIds: ids, outputs, includeBlocked: drafts });
      liveId.current = r.batch.batchId; setBatch(r.batch); setNow(Date.now());
    } catch (e) { setError(toError(e).message); }
    finally { setStarting(false); }
  };
  const cancelRun = async () => { if (!batch) return; try { const r = await api.cancelBatch(batch.batchId); setBatch((b) => (b ? { ...b, status: r.batch?.status ?? b.status } : b)); } catch (e) { setError(toError(e).message); } };
  const openRecent = async (id: string) => { try { setError(null); setBatch((await api.batch(id)).batch); setFilter('all'); } catch (e) { setError(toError(e).message); } };

  const canStart = !running && !starting && targets.length > 0 && outputs.length > 0;
  const startedMs = batch ? Date.parse(batch.startedAt) : 0;
  const elapsed = batch ? (running ? Math.max(0, now - startedMs) : batch.durationMs ?? 0) : 0;
  const remaining = batch && running && batch.done > 0 ? (elapsed / batch.done) * (batch.total - batch.done) : null;
  const count = (st: BatchItemDto['status']) => batch?.items.filter((i) => i.status === st).length ?? 0;
  const totalPages = batch?.items.reduce((a, i) => a + (i.pages ?? 0), 0) ?? 0;
  const finished = batch && batch.status !== 'running';
  const rows = batch ? (running ? batch.items.filter((i) => i.status !== 'pending').slice(-8).reverse() : batch.items.filter((i) => filter === 'all' || i.status === filter)) : [];

  return (
    <div className="bx" data-testid="batch-tab">
      <div className="bx-cols">
        <section className="bx-card" aria-label="Choose what to produce">
          <h2 className="bx-h">Which {noun}?</h2>
          <div className="bx-radios" role="radiogroup" aria-label="Records to include">
            <label><input type="radio" name="bx-pick" checked={pick === 'all'} onChange={() => setPick('all')} disabled={running} /> All {pool.length} {noun}</label>
            <label><input type="radio" name="bx-pick" checked={pick === 'filter'} onChange={() => setPick('filter')} disabled={running} /> Filter by {project.documentType === 'eob' ? 'persona or claim status' : 'persona'}</label>
            <label><input type="radio" name="bx-pick" checked={pick === 'selected'} onChange={() => setPick('selected')} disabled={running} /> Selected {noun}</label>
          </div>
          {pick === 'filter' && (
            <div className="bx-filters">
              <label className="field">Persona
                <select className="select" value={persona} onChange={(e) => setPersona(e.target.value)} disabled={running}>
                  <option value="">Any persona</option>
                  {personaIds.map((id) => <option key={id} value={id}>{personas.find((p) => p.id === id)?.name ?? id}</option>)}
                </select>
              </label>
              {project.documentType === 'eob' && (
                <label className="field">Claim status
                  <select className="select" value={claimStatus} onChange={(e) => setClaimStatus(e.target.value)} disabled={running}>
                    <option value="">Any status</option>
                    {claimStatuses.map((c) => <option key={c} value={c}>{c.replace(/-/g, ' ')}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          {pick === 'selected' && (
            <div className="bx-list-wrap">
              <div className="bx-list-tools">
                <input className="input" type="search" placeholder={`Search ${noun}…`} aria-label={`Search ${noun}`} value={search} onChange={(e) => setSearch(e.target.value)} />
                <button className="btn sm" onClick={() => setChosen((c) => new Set([...c, ...visible.map((r) => r.recordId)]))} disabled={running}>Select shown</button>
                <button className="btn sm ghost" onClick={() => setChosen(new Set())} disabled={running || chosen.size === 0}>Clear</button>
              </div>
              <ul className="bx-list" aria-label={`Select ${noun}`}>
                {visible.map((r) => (
                  <li key={r.recordId}>
                    <label><input type="checkbox" checked={chosen.has(r.recordId)} disabled={running} onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(r.recordId); else n.delete(r.recordId); return n; })} />
                      <span className="bx-nm">{nameOf(r)}</span><span className="muted bx-sub">{r.personaId ? personas.find((p) => p.id === r.personaId)?.name ?? r.personaId : ''}</span><Tech><span className="mono muted bx-sub">{r.recordId}</span></Tech></label>
                  </li>
                ))}
                {visible.length === 0 && <li className="muted bx-none">No {noun} match “{search}”.</li>}
              </ul>
            </div>
          )}
          <p className="bx-count" data-testid="batch-count"><strong>{targets.length}</strong> of {pool.length} {noun} will be produced.</p>
        </section>

        <section className="bx-card" aria-label="Output options">
          <h2 className="bx-h">What to produce</h2>
          <label className="bx-check"><input type="checkbox" checked={outPdf} onChange={(e) => setOutPdf(e.target.checked)} disabled={running} /> PDF</label>
          <label className="bx-check"><input type="checkbox" checked={outHtml} onChange={(e) => setOutHtml(e.target.checked)} disabled={running} /> Interactive HTML</label>
          <p className="muted bx-note">AFP is simulation-only and is not part of batch runs.</p>
          <label className="bx-check"><input type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.target.checked)} disabled={running} /> Include blocked records as watermarked drafts</label>
          <p className="muted bx-note">Off by default: records with blocking problems are skipped and listed in the report.</p>
          <div className="bx-actions">
            <button className="btn primary" onClick={start} disabled={!canStart} data-testid="batch-start">{starting && <span className="spinner" />} Start batch</button>
            {dirty ? <span className="chip warning" data-testid="batch-dirty">Uses your current, unsaved changes</span> : <span className="chip">Uses the saved model v{project.modelVersion}</span>}
            {outputs.length === 0 && <span className="bx-warn" role="status">Choose at least one output.</span>}
          </div>
        </section>
      </div>

      {error && <div className="callout error" role="alert" data-testid="batch-error">{error}</div>}

      {batch && running && (
        <section className="bx-card" data-testid="batch-progress" aria-label="Batch progress">
          <div className="bx-prog-head">
            <strong>Producing {batch.done} of {batch.total}</strong>
            <span className="muted">Elapsed {fmtDur(elapsed)} · {remaining == null ? 'estimating…' : `about ${fmtDur(remaining)} left`}</span>
            <button className="btn sm danger" onClick={cancelRun} data-testid="batch-cancel">Cancel</button>
          </div>
          <div className="bx-bar" role="progressbar" aria-label="Batch progress" aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={batch.done}><div style={{ width: `${batch.total ? (batch.done / batch.total) * 100 : 0}%` }} /></div>
          <table className="table bx-table" aria-label="Latest records">
            <thead><tr><th>Customer</th><th>Status</th><th className="num">Pages</th><th className="num">Time</th></tr></thead>
            <tbody>{rows.map((i) => <tr key={i.recordId}><td>{i.name}</td><td><StatusChip s={i.status} /></td><td className="num">{i.pages ?? '—'}</td><td className="num">{i.ms == null ? '—' : `${i.ms} ms`}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      {batch && finished && (
        <section className="bx-card" data-testid="batch-summary" aria-label="Batch results">
          <div className="bx-prog-head">
            <strong>{batch.status === 'done' ? 'Batch finished' : batch.status === 'cancelled' ? 'Batch cancelled' : 'Batch failed'}</strong>
            <span className="muted">{batch.done} of {batch.total} processed</span>
            {batch.zipBytes != null && <a className="btn primary" href={api.batchZipUrl(batch.batchId)} download data-testid="batch-download"><Icon.download /> Download ZIP ({fmtMb(batch.zipBytes)})</a>}
          </div>
          {batch.error && <div className="callout error" role="alert">{batch.error}</div>}
          <div className="bx-tiles">
            <div className="bx-tile"><b>{count('ok')}</b><span>Produced</span></div>
            <div className="bx-tile"><b>{count('blocked')}</b><span>Blocked</span></div>
            <div className="bx-tile"><b>{count('failed')}</b><span>Failed</span></div>
            <div className="bx-tile"><b>{count('draft')}</b><span>Drafts</span></div>
            <div className="bx-tile"><b>{totalPages}</b><span>Total pages</span></div>
            <div className="bx-tile"><b>{fmtDur(batch.durationMs)}</b><span>Total time</span></div>
            <div className="bx-tile"><b>{batch.done ? fmtDur((batch.durationMs ?? 0) / batch.done) : '—'}</b><span>Average per record</span></div>
          </div>
          <Proof label="Proof">
            <span className="mono">Batch {batch.batchId} · model v{batch.modelVersion} · ZIP SHA-256 {batch.zipSha256 ?? '—'}</span>
          </Proof>
          <div className="bx-filter-row">
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>Show
              <select className="select" value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Filter results by status">
                <option value="all">All ({batch.items.length})</option>
                {(['ok', 'draft', 'blocked', 'failed', 'pending'] as const).map((st) => count(st) > 0 && <option key={st} value={st}>{STATUS_LABEL[st]} ({count(st)})</option>)}
              </select>
            </label>
          </div>
          <div className="bx-results">
            <table className="table bx-table" aria-label="Per-record results">
              <thead><tr><th>Customer</th><th>Status</th><th className="num">Pages</th><th className="num">Time</th><th>Notes</th></tr></thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.recordId} data-testid="batch-row" data-status={i.status}>
                    <td>{i.name}<Tech><div className="mono muted bx-sub">{i.recordId}{i.runId ? ` · ${i.runId}` : ''}</div></Tech></td>
                    <td><StatusChip s={i.status} /></td>
                    <td className="num">{i.pages ?? '—'}</td>
                    <td className="num">{i.ms == null ? '—' : `${i.ms} ms`}</td>
                    <td>
                      {i.blocking.length > 0 && <>{i.blocking.map(blockWord).join('; ')}<Tech><div className="mono bx-sub">{i.blocking.join(' ')}</div></Tech></>}
                      {i.error && <span>{i.error}</span>}
                      {i.warnings > 0 && i.blocking.length === 0 && !i.error && <span className="muted">{i.warnings} warning{i.warnings === 1 ? '' : 's'}</span>}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={5} className="muted">No records with this status.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="bx-card" aria-label="Recent batches" data-testid="batch-recent">
        <h2 className="bx-h">Recent batches</h2>
        {recent.length === 0 ? <p className="muted bx-note">No batches yet. Start one above.</p> : (
          <ul className="bx-recent">
            {recent.map((b) => (
              <li key={b.batchId}>
                <button className="btn sm ghost" onClick={() => openRecent(b.batchId)} aria-label={`Open batch from ${fmtTime(b.startedAt)}`}>{fmtTime(b.startedAt)}</button>
                <span>{b.done} of {b.total} records · {b.outputs.map((o) => o.toUpperCase()).join(' + ')}</span>
                <span className={`chip ${b.status === 'done' ? 'accent' : b.status === 'running' ? 'info' : 'warning'}`}>{b.status === 'done' ? 'Finished' : b.status === 'running' ? 'Running' : b.status === 'cancelled' ? 'Cancelled' : 'Failed'}</span>
                <span className="muted">{fmtDur(b.durationMs)} · {fmtMb(b.zipBytes)}</span>
                <Tech><span className="mono muted">{b.batchId}</span></Tech>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
