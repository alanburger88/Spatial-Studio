import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { resolve } from '@iss/resolver';
import type { ProfileId } from '@iss/model';
import { api, ApiFailure, type BinaryResult, type ScenarioRequest } from '../api/client';
import { useStudio, useScenarioRequest } from '../state/store';
import { ScreenHeader, Empty } from '../ui/common';
import { Icon } from '../ui/icons';
import './PreviewExport.css';

type Tab = 'pdf' | 'html' | 'afp';
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
const fmtTime = (iso: string) => { const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso.replace(' ', 'T') + 'Z'); return isNaN(+d) ? iso : d.toLocaleString(); };
function val(v: unknown): string { if (v === undefined) return '—'; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 30 ? s.slice(0, 28) + '…' : s; }

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
  ];
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    if (e.key === 'ArrowRight') { setTab(tabs[(i + 1) % 3].id); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setTab(tabs[(i + 2) % 3].id); e.preventDefault(); }
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
          </div>
        </div>

        <div className="ox-side">
          <ParityPanel job={session.parity} onRun={runParity} />
          <section className="panel ox-history" aria-label="Export history">
            <div className="panel-head">Export history <span className="sub">{history ? `${history.length} artifacts` : ''}</span>
              <span className="right"><button className="btn sm ghost" onClick={() => setHistTick((t) => t + 1)} aria-label="Refresh export history"><Icon.reset /></button></span>
            </div>
            <div className="panel-body" style={{ padding: 0 }} data-testid="export-history">
              {historyErr ? <div className="callout error" style={{ margin: 10 }}>{historyErr}</div>
                : !history ? <div className="empty" role="status"><span className="spinner" /></div>
                : history.length === 0 ? <div className="empty"><strong>No exports yet</strong><span>Generate a PDF, HTML or AFP simulation report to start the history.</span></div>
                : (
                  <table className="table ox-hist-table">
                    <thead><tr><th>Kind</th><th>File</th><th className="num">Pages</th><th>sha256</th><th>Run</th><th>Time</th></tr></thead>
                    <tbody>
                      {history.map((a) => (
                        <tr key={a.artifactId}>
                          <td><span className={'chip' + (a.kind === 'afp-sim' ? ' sim' : a.kind === 'pdf' ? ' accent' : ' info')}>{a.kind === 'afp-sim' ? 'AFP sim' : a.kind.toUpperCase()}</span></td>
                          <td className="ox-file"><a href={api.artifactUrl(a.artifactId)} download={a.filename} title={`Download ${a.filename}`}><Icon.download /> {a.filename}</a>{a.kind === 'afp-sim' && <small>simulation report (JSON), not an AFP file</small>}</td>
                          <td className="num">{a.pageCount ?? '—'}</td>
                          <td className="mono" title={a.sha256}>{short(a.sha256, 8)}</td>
                          <td className="mono" title={a.runId}>{short(a.runId?.replace('run-', ''), 8)}</td>
                          <td>{fmtTime(a.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          </section>
        </div>
      </div>
    </section>
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

function Meta({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="ox-meta">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
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
          <Meta rows={[
            ['Pages (composer)', <span data-testid="pdf-page-count">{r.pageCount ?? '—'}</span>],
            ['Pages (PDF verified)', <span data-testid="pdf-verified-count">{r.pdfPageCount ?? '—'}</span>],
            ['Run ID', <span className="mono">{r.runId}</span>],
            ['Content digest', <span className="mono" title={r.contentDigest}>{short(r.contentDigest, 16)}…</span>],
            ['SHA-256', <span className="mono" title={r.sha256}>{short(r.sha256, 16)}…</span>],
            ['File', <span className="mono">{r.filename}</span>],
            ['Status', r.draft ? <span className="chip error">Watermarked draft</span> : <span className="chip accent">Clean export</span>],
          ]} />
          {isEob && <div className="callout accent ox-note">EOB output carries “THIS IS NOT A BILL” (rendered by the paged composer).</div>}
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
          <Meta rows={[
            ['Run ID', <span className="mono">{r.bin.runId}</span>],
            ['Content digest', <span className="mono" title={r.bin.contentDigest}>{short(r.bin.contentDigest, 16)}…</span>],
            ['SHA-256', <span className="mono" title={r.bin.sha256}>{short(r.bin.sha256, 16)}…</span>],
            ['File', <span className="mono">{r.bin.filename}</span>],
            ['Size', `${(r.bin.blob.size / 1024).toFixed(1)} KB`],
          ]} />
          <div className="callout ox-note"><Icon.info /> Sorting, filtering and expandable details work inside the exported file; totals and rule decisions never change. Responsive layout is shown at {w}px.</div>
          {isEob && <div className="callout accent ox-note">EOB output carries “THIS IS NOT A BILL” (rendered by the HTML renderer).</div>}
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
      <div className="panel-head">Semantic parity <span className="sub">PDF vs HTML</span>
        <span className="right">
          {rep && <span className={'chip ' + (rep.ok ? 'accent' : 'error')} data-testid="parity-status">{rep.ok ? 'OK — all blocking checks match' : 'Mismatch'}</span>}
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
              <table className="table ox-par-table">
                <thead><tr><th>Check</th><th>Expected</th><th>PDF</th><th>HTML</th><th>Status</th><th>Blocking</th></tr></thead>
                <tbody>
                  {rep.checks.map((c: any) => (
                    <tr key={c.id} className={c.status === 'mismatch' ? 'selected' : ''}>
                      <td><strong>{c.label}</strong>{c.note && <small className="ox-note-s">{c.note}</small>}</td>
                      <td className="mono ox-val" title={JSON.stringify(c.expected)}>{val(c.expected)}</td>
                      <td className="mono ox-val" title={JSON.stringify(c.pdf)}>{val(c.pdf)}</td>
                      <td className="mono ox-val" title={JSON.stringify(c.html)}>{val(c.html)}</td>
                      <td><span className={'chip ' + (c.status === 'match' ? 'accent' : 'error')}>{c.status === 'match' ? '✓ match' : '✕ mismatch'}</span></td>
                      <td>{c.blocking ? 'blocking' : 'advisory'}</td>
                    </tr>
                  ))}
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
