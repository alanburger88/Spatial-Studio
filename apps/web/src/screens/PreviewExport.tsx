import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { resolve, type SemanticManifest } from '@iss/resolver';
import { compareManifests, type ExtractedManifest } from '@iss/renderers';
import type { ProfileId } from '@iss/model';
import { api, ApiFailure, type BatchDto, type BatchItemDto, type BinaryResult, type ScenarioRequest } from '../api/client';
import { useStudio, useScenarioRequest, useIsDirty } from '../state/store';
import { ScreenHeader, Empty, Proof, Tech, Named } from '../ui/common';
import { Icon } from '../ui/icons';
import './PreviewExport.css';

type Tab = 'pdf' | 'html' | 'email' | 'sms' | 'afp' | 'batch';
type Device = 'desktop' | 'tablet' | 'mobile';
const DEVICES: Record<Device, { label: string; width: number; id: 'phone' | 'tablet' | 'desktop' }> = { mobile: { label: 'Phone', width: 390, id: 'phone' }, tablet: { label: 'Tablet', width: 768, id: 'tablet' }, desktop: { label: 'Desktop', width: 1200, id: 'desktop' } };
const AFP_LABEL = 'AFP simulation only — no MO:DCA / AFP print stream generated';

interface Issue { code?: string; severity?: string; message?: string; nodeId?: string }
interface Job<T> { status: 'idle' | 'running' | 'done' | 'error'; result?: T; runId?: string; /** run id this job was requested for (stops auto-retry loops) */ forRun?: string; builtAt?: number; error?: { code: string; message: string; issues: Issue[] }; startedAt?: number }
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

/** Re-render every 20 s so "Built 2 min ago" stays honest. */
function useNow(): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setN(Date.now()), 20000); return () => clearInterval(h); }, []);
  return n;
}
function relMs(ms: number | undefined, now: number): string {
  if (!ms) return 'just now';
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
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
  const sessionRef = useRef(session);
  sessionRef.current = session;

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
  const { expected, manifest } = useMemo(() => {
    const rec = records.find((r) => r.recordId === ctx.recordId);
    const out: Record<string, string | null> = { 'paged-pdf': null, 'html-responsive': null, 'paged-afp-sim': null };
    let manifest: SemanticManifest | null = null;
    if (!rec || rec.documentType !== project.documentType) return { expected: out, manifest };
    for (const p of Object.keys(out) as ProfileId[]) {
      try { const r = resolve({ project, record: rec, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor, profileId: p }); out[p] = r.runId; if (p === 'paged-pdf') manifest = r.semanticManifest; } catch { out[p] = null; }
    }
    return { expected: out, manifest };
  }, [project, records, ctx.recordId, ctx.overrides, ctx.journeyCursor]);
  const wantPdf = expected['paged-pdf'], wantHtml = expected['html-responsive'], wantAfp = expected['paged-afp-sim'];
  const pairKey = wantPdf && wantHtml ? `${wantPdf}|${wantHtml}` : null;

  /* ---------------- actions
     The server stores artifacts by content hash (INSERT OR IGNORE), so rebuilding an unchanged run never adds a
     history entry. The browser additionally keeps finished builds per project and only rebuilds when the run changes. */
  /** PDF bytes are not reproducible (embedded timestamps), so every compose adds a history entry. Automatic builds
   *  therefore reuse a clean artifact already stored for this exact run and only compose when none exists. */
  const reusePdf = async (runId: string): Promise<BinaryResult | null> => {
    try {
      const a = (await api.artifacts({ runId })).artifacts.find((x) => x.kind === 'pdf' && !x.meta?.draft);
      if (!a) return null;
      const r = await fetch(api.artifactUrl(a.artifactId));
      if (!r.ok) return null;
      const blob = await r.blob();
      return { blob, url: URL.createObjectURL(blob), filename: a.filename, runId: a.runId, artifactId: a.artifactId, pageCount: a.pageCount ?? undefined, pdfPageCount: a.meta?.metrics?.pdfPageCount, contentDigest: a.meta?.contentDigest ?? '', sha256: a.sha256, draft: false };
    } catch { return null; }
  };
  const runPdf = async (allowDraft = false, auto = false) => {
    const req = profileReq('paged-pdf'); if (!req) return;
    const my = ++seq.current.pdf; const forRun = wantPdf ?? undefined;
    update('pdf', { ...sessionRef.current.pdf, status: 'running', forRun, startedAt: Date.now(), error: undefined });
    try {
      const reused = auto && !allowDraft && wantPdf ? await reusePdf(wantPdf) : null;
      const bin = reused ?? await api.composePdf({ ...req, ...(allowDraft ? { allowDraft: true } : {}) });
      if (seq.current.pdf !== my) return;
      update('pdf', { status: 'done', result: bin, runId: bin.runId, forRun, builtAt: Date.now() });
      if (!reused) setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.pdf !== my) return;
      update('pdf', { status: 'error', error: toError(e), forRun });
    }
  };
  const runHtml = async (allowDraft = false) => {
    const req = profileReq('html-responsive'); if (!req) return;
    const my = ++seq.current.html; const forRun = wantHtml ?? undefined;
    update('html', { ...sessionRef.current.html, status: 'running', forRun, startedAt: Date.now(), error: undefined });
    try {
      const bin = await api.composeHtml({ ...req, ...(allowDraft ? { allowDraft: true } : {}) });
      const text = await bin.blob.text();
      if (seq.current.html !== my) return;
      update('html', { status: 'done', result: { bin, text }, runId: bin.runId, forRun, builtAt: Date.now() });
      setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.html !== my) return;
      update('html', { status: 'error', error: toError(e), forRun });
    }
  };
  const runAfp = async () => {
    const req = profileReq('paged-afp-sim'); if (!req) return;
    const my = ++seq.current.afp; const forRun = wantAfp ?? undefined;
    update('afp', { ...sessionRef.current.afp, status: 'running', forRun, startedAt: Date.now(), error: undefined });
    try {
      const sim = await api.afpSim(req);
      if (seq.current.afp !== my) return;
      update('afp', { status: 'done', result: sim, runId: sim.runId, forRun, builtAt: Date.now() });
      setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.afp !== my) return;
      update('afp', { status: 'error', error: toError(e), result: sessionRef.current.afp.result, forRun });
    }
  };
  /** Automatic parity: compare the resolver manifest with the facts extracted from the stored PDF and HTML artifacts of
   *  this run (same compareManifests the API uses). Falls back to the server check if those facts are unavailable. */
  const runParityAuto = async () => {
    const pdfJob = sessionRef.current.pdf.result, htmlJob = sessionRef.current.html.result;
    if (!manifest || !wantPdf || !wantHtml || !pdfJob || !htmlJob) return runParity();
    const my = ++seq.current.parity; const forRun = pairKey ?? undefined;
    update('parity', { ...sessionRef.current.parity, status: 'running', forRun, startedAt: Date.now(), error: undefined });
    try {
      const [pl, hl] = await Promise.all([api.artifacts({ runId: wantPdf }), api.artifacts({ runId: wantHtml })]);
      const pa = pl.artifacts.find((x) => x.artifactId === pdfJob.artifactId), ha = hl.artifacts.find((x) => x.artifactId === htmlJob.bin.artifactId);
      if (my !== seq.current.parity) return;
      if (!pa?.meta?.extracted || !ha?.meta?.extracted) { seq.current.parity--; return runParity(); }
      const report = compareManifests(manifest, pa.meta.extracted as ExtractedManifest, ha.meta.extracted as ExtractedManifest);
      update('parity', { status: 'done', result: { runId: wantPdf, draft: !!pa.meta.draft, report, pdf: { pageCount: pa.pageCount, pdfPageCount: pa.meta?.metrics?.pdfPageCount }, source: 'artifacts' }, runId: wantPdf, forRun, builtAt: Date.now() });
    } catch (e) {
      if (seq.current.parity !== my) return;
      update('parity', { status: 'error', error: toError(e), forRun });
    }
  };
  const runParity = async () => {
    const req = profileReq(); if (!req) return;
    const my = ++seq.current.parity; const forRun = pairKey ?? undefined;
    update('parity', { ...sessionRef.current.parity, status: 'running', forRun, startedAt: Date.now(), error: undefined });
    try {
      const r = await api.parity(req);
      if (seq.current.parity !== my) return;
      update('parity', { status: 'done', result: { ...r, source: 'server' }, runId: r.runId, forRun, builtAt: Date.now() });
      setHistTick((t) => t + 1);
    } catch (e) {
      if (seq.current.parity !== my) return;
      update('parity', { status: 'error', error: toError(e), result: sessionRef.current.parity.result, forRun });
    }
  };
  const cancel = (k: keyof Session) => { seq.current[k]++; const j = sessionRef.current[k]; update(k, { ...j, status: j.result ? 'done' : 'idle' } as any); };

  /* ---------------- automatic builds: the open tab first, PDF and HTML always (the parity panel needs both) */
  const latest = useRef({ runPdf, runHtml, runAfp, runParity, runParityAuto });
  latest.current = { runPdf, runHtml, runAfp, runParity, runParityAuto };
  useEffect(() => {
    const need = (w: string | null, j: Job<any>) => !!w && j.forRun !== w;
    const order: Array<'pdf' | 'html'> = tab === 'html' ? ['html', 'pdf'] : ['pdf', 'html'];
    const items: Array<'pdf' | 'html' | 'afp'> = [
      ...order.filter((k) => (k === 'pdf' ? need(wantPdf, session.pdf) : need(wantHtml, session.html))),
      ...(tab === 'afp' && need(wantAfp, session.afp) ? ['afp' as const] : []),
    ];
    if (!items.length) return;
    const t = setTimeout(() => { for (const k of items) { if (k === 'pdf') void latest.current.runPdf(false, true); else if (k === 'html') void latest.current.runHtml(); else void latest.current.runAfp(); } }, 300);
    return () => clearTimeout(t);
  }, [tab, projectId, wantPdf, wantHtml, wantAfp, session.pdf.forRun, session.html.forRun, session.afp.forRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const bothReady = session.pdf.status === 'done' && session.pdf.runId === wantPdf && session.html.status === 'done' && session.html.runId === wantHtml;
  useEffect(() => {
    if (!pairKey || !bothReady || session.parity.forRun === pairKey) return;
    void latest.current.runParityAuto();
  }, [pairKey, bothReady, session.parity.forRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = useNow();
  const stale = {
    pdf: !!session.pdf.runId && !!wantPdf && session.pdf.runId !== wantPdf,
    html: !!session.html.runId && !!wantHtml && session.html.runId !== wantHtml,
    afp: !!session.afp.runId && !!wantAfp && session.afp.runId !== wantAfp,
  };
  const tabs: Array<{ id: Tab; label: string; chip?: ReactNode; stale: boolean }> = [
    { id: 'pdf', label: 'PDF (real)', stale: stale.pdf },
    { id: 'html', label: 'HTML (real)', stale: stale.html },
    { id: 'email', label: 'Email', stale: false },
    { id: 'sms', label: 'SMS', stale: false },
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
  const rec = records.find((r) => r.recordId === ctx.recordId);
  const who = rec ? `${rec.customer.givenName} ${rec.customer.familyName}` : ctx.recordId;
  const nameOfRecord = (id?: string) => { const r = records.find((x) => x.recordId === id); return r ? `${r.customer.givenName} ${r.customer.familyName}` : id ?? ''; };
  const currentRuns = new Set([wantPdf, wantHtml, wantAfp].filter(Boolean) as string[]);
  const parityWait = !bothReady && session.parity.status !== 'done'
    ? (session.pdf.status === 'error' || session.html.status === 'error' ? 'blocked' : 'building') as 'blocked' | 'building'
    : null;
  return (
    <section className="screen" data-testid="outputs-view">
      <ScreenHeader
        id="S10" title="Preview & Export"
        subtitle="Real PDF and interactive HTML composed from the same resolved semantic tree, built automatically for the current customer and scenario; AFP is a feasibility simulation only."
        badge={<span className="chip" data-testid="outputs-scenario"><Named name={who} code={ctx.recordId} />{ctx.journeyCursor != null ? ` · journey step ${ctx.journeyCursor}` : ''}{Object.keys(ctx.overrides).length ? ' · scenario changes' : ''}</span>}
      />
      <div className="screen-body ox-body">
        <div className="panel ox-main">
          <div className="tabs ox-tabs" role="tablist" aria-label="Output type" onKeyDown={onTabKey}>
            {tabs.map((t) => (
              <button key={t.id} role="tab" id={`ox-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`ox-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
                {t.label} {t.chip}{t.stale && <span className="chip warning" style={{ marginLeft: 6 }}>out of date</span>}
              </button>
            ))}
          </div>
          <div className="ox-panel" key={tab} role="tabpanel" id={`ox-panel-${tab}`} aria-labelledby={`ox-tab-${tab}`}>
            {tab === 'pdf' && <PdfTab job={session.pdf} want={wantPdf} now={now} who={who} stale={stale.pdf} onRun={runPdf} onCancel={() => cancel('pdf')} isEob={isEob} />}
            {tab === 'html' && <HtmlTab job={session.html} want={wantHtml} now={now} who={who} stale={stale.html} onRun={runHtml} onCancel={() => cancel('html')} device={device} setDevice={setDevice} isEob={isEob} />}
            {tab === 'email' && <EmailTab req={profileReq('html-responsive')!} isEob={isEob} />}
            {tab === 'sms' && <SmsTab req={profileReq('html-responsive')!} isEob={isEob} />}
            {tab === 'afp' && <AfpTab job={session.afp} want={wantAfp} now={now} who={who} stale={stale.afp} onRun={runAfp} onCancel={() => cancel('afp')} />}
            {tab === 'batch' && <BatchTab />}
          </div>
        </div>

        <aside className="ox-side" data-side="right" data-side-title="Parity & history" aria-label="Parity and export history">
          <ParityPanel job={session.parity} pairKey={pairKey} now={now} wait={parityWait} onRun={runParity} />
          <section className="panel ox-history" aria-label="Export history">
            <div className="panel-head">Export history <span className="chip count">{history ? `${history.length}` : '…'}</span>
              <span className="right"><button className="btn sm ghost" onClick={() => setHistTick((t) => t + 1)} aria-label="Refresh export history"><Icon.reset /></button></span>
            </div>
            <div className="panel-body flush ox-hist-body" data-testid="export-history">
              {historyErr ? <div className="callout error" style={{ margin: 10 }}>{historyErr}</div>
                : !history ? <div className="empty" role="status"><span className="spinner" /></div>
                : history.length === 0 ? <div className="empty"><strong>No exports yet</strong><span>Previews are saved here as they are built.</span></div>
                : (
                  <ul className="ox-hist-list list-rows">
                    {history.map((a) => <HistoryRow key={a.artifactId} a={a} who={nameOfRecord(a.recordId)} current={currentRuns.has(a.runId)} />)}
                  </ul>
                )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function HistoryRow({ a, who, current }: { a: any; who: string; current: boolean }) {
  const [copied, setCopied] = useState(false);
  const kindLabel = a.kind === 'afp-sim' ? 'AFP sim' : String(a.kind).toUpperCase();
  const copy = async () => { try { await navigator.clipboard.writeText(a.sha256); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard unavailable */ } };
  const detail = [a.kind === 'afp-sim' ? 'simulation report' : a.pageCount != null ? `${a.pageCount} page${a.pageCount === 1 ? '' : 's'}` : a.size ? `${(a.size / 1024).toFixed(1)} KB` : ''].filter(Boolean).join(' · ');
  return (
    <li className="ox-hist-row" data-testid="history-row" aria-current={current ? 'true' : undefined}>
      <span className={'chip ox-kind' + (a.kind === 'afp-sim' ? ' sim' : a.kind === 'pdf' ? ' accent' : ' info')}>{kindLabel}</span>
      <span className="ox-file">
        <a href={api.artifactUrl(a.artifactId)} download={a.filename} title={`Download ${a.filename}`}><Icon.download /><span className="ox-fname"><Named name={who} code={a.recordId} />{detail ? ` · ${detail}` : ''}</span></a>
        <Tech><small title={a.filename}>{a.filename}</small></Tech>
      </span>
      <span className="ox-hist-meta">
        <time dateTime={a.createdAt} title={fmtTime(a.createdAt)}>{current ? 'current run' : relTime(a.createdAt)}</time>
        <Tech><span className="ox-hash"><span className="chip code" title={a.sha256}>{short(a.sha256, 8)}</span>
          <button className="btn sm ghost icon" onClick={copy} aria-label={`Copy SHA-256 of ${a.filename}`} title={copied ? 'Copied' : 'Copy SHA-256'}>{copied ? <Icon.validate /> : <Icon.copy />}</button></span></Tech>
      </span>
    </li>
  );
}

/* ------------------------------------------------------------ shared job UI */

/** One-line freshness: "Built 2 min ago · up to date" / "Out of date — rebuilding…". */
function Fresh({ job, want, now, testId }: { job: Job<any>; want: string | null; now: number; testId?: string }) {
  const hasResult = !!job.result;
  const current = !!want && job.runId === want;
  let text: string; let old = false;
  if (job.status === 'running') { text = hasResult && !current ? 'Out of date — rebuilding…' : hasResult ? 'Rebuilding…' : 'Building…'; old = hasResult && !current; }
  else if (job.status === 'error') { text = hasResult && !current ? 'Out of date — build failed' : 'Build failed'; old = true; }
  else if (hasResult && current) text = `Built ${relMs(job.builtAt, now)} · up to date`;
  else if (hasResult) { text = 'Out of date — rebuilding…'; old = true; }
  else text = 'Not built yet';
  return <span className={'ox-fresh' + (old ? ' old' : '')} role="status" data-testid={old && testId ? testId : undefined}>{text}</span>;
}

function JobBar({ job, label, onRun, onCancel, testId, runLabel, extra, fresh }: { job: Job<any>; label: string; onRun: () => void; onCancel: () => void; testId: string; runLabel: string; extra?: ReactNode; fresh?: ReactNode }) {
  const running = job.status === 'running';
  const el = useElapsed(job.startedAt, running);
  return (
    <div className="ox-jobbar">
      <button className="btn primary" onClick={onRun} disabled={running} data-testid={testId}>{running ? <span className="spinner" /> : <Icon.outputs />} {runLabel}</button>
      {fresh}
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

/** Progress placeholder while an automatic build is queued or running (never a "not composed" dead end). */
function Pending({ what, who, job }: { what: string; who: string; job: Job<any> }) {
  const cancelled = job.status === 'idle' && !!job.forRun;
  return (
    <div className="ox-pending" role="status" data-testid="ox-building">
      {cancelled ? <Icon.outputs /> : <span className="spinner" />}
      <strong>{cancelled ? `${what} build cancelled` : `Building the ${what} for ${who}…`}</strong>
      <span>{cancelled ? 'Use the build button to try again.' : 'It appears here as soon as it is ready.'}</span>
    </div>
  );
}

/* ------------------------------------------------------------ PDF */

function PdfTab({ job, want, now, who, stale, onRun, onCancel, isEob }: { job: Job<BinaryResult>; want: string | null; now: number; who: string; stale: boolean; onRun: (d?: boolean) => void; onCancel: () => void; isEob: boolean }) {
  const r = job.result;
  return (
    <>
      <JobBar job={job} label="PDF" onRun={() => onRun(false)} onCancel={onCancel} testId="export-pdf" runLabel={r ? 'Rebuild PDF' : 'Build PDF'} fresh={<Fresh job={job} want={want} now={now} testId="stale-pdf" />}
        extra={r && <a className="btn" href={r.url} download={r.filename} data-testid="download-pdf"><Icon.download /> Download PDF</a>} />
      <IssuesBlock job={job} kind="PDF" onDraft={() => onRun(true)} />
      {r ? (
        <>
          <div className="ox-strip">
            <span className={'chip ' + (r.draft ? 'error' : 'accent')}>{r.draft ? 'Watermarked draft' : 'Clean export'}</span>
            <span>Pages <strong data-testid="pdf-page-count">{r.pageCount ?? '—'}</strong> composed · <strong data-testid="pdf-verified-count">{r.pdfPageCount ?? '—'}</strong> verified</span>
            {isEob && <span className="muted">Carries “THIS IS NOT A BILL”.</span>}
            <Proof label="Proof">
              <span className="ox-proof">Run <span className="chip code">{r.runId}</span> · digest <span className="chip code" title={r.contentDigest}>{short(r.contentDigest, 16)}…</span> · SHA-256 <span className="chip code" title={r.sha256}>{short(r.sha256, 16)}…</span> · <span className="chip code">{r.filename}</span></span>
            </Proof>
          </div>
          <div className={'ox-viewer' + (stale ? ' is-stale' : '')} data-testid="pdf-preview">
            <iframe src={r.url} title="Generated PDF preview" />
            {stale && <div className="ox-stale-veil">OUT OF DATE</div>}
          </div>
          <p className="muted ox-foot">If the embedded viewer is blocked by the browser, <a href={r.url} target="_blank" rel="noreferrer">open the PDF in a new tab</a>.</p>
        </>
      ) : job.status !== 'error' ? <Pending what="PDF" who={who} job={job} /> : null}
    </>
  );
}

/* ------------------------------------------------------------ HTML */

function HtmlTab({ job, want, now, who, stale, onRun, onCancel, device, setDevice, isEob }: { job: Job<HtmlResult>; want: string | null; now: number; who: string; stale: boolean; onRun: (d?: boolean) => void; onCancel: () => void; device: Device; setDevice: (d: Device) => void; isEob: boolean }) {
  const r = job.result;
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth)); ro.observe(el); setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, [r]);
  const w = DEVICES[device].width;
  const kind = DEVICES[device].id;
  const bezel = kind === 'desktop' ? 0 : kind === 'phone' ? 12 : 14;
  const barH = kind === 'desktop' ? 34 : 0;
  const scale = Math.min(1, (avail - 24 - bezel * 2 - 2) / w);
  const H = kind === 'phone' ? 700 : 640; // visible screen height in px; the page scrolls inside the frame
  return (
    <>
      <JobBar job={job} label="HTML" onRun={() => onRun(false)} onCancel={onCancel} testId="export-html" runLabel={r ? 'Rebuild HTML' : 'Build HTML'} fresh={<Fresh job={job} want={want} now={now} testId="stale-html" />}
        extra={<>
          {r && <a className="btn" href={r.bin.url} download={r.bin.filename} data-testid="download-html"><Icon.download /> Download HTML</a>}
          <div className="segmented" role="group" aria-label="Device width">
            {(Object.keys(DEVICES) as Device[]).map((d) => <button key={d} aria-pressed={device === d} onClick={() => setDevice(d)} title={`${DEVICES[d].label} · ${DEVICES[d].width}px wide`} data-testid={`html-device-${DEVICES[d].id}`}><span data-testid={`device-${d}`}>{DEVICES[d].label}</span></button>)}
          </div>
        </>} />
      <IssuesBlock job={job} kind="HTML" onDraft={() => onRun(true)} />
      {r ? (
        <>
          <div className="ox-strip">
            <span className={'chip ' + (r.bin.draft ? 'error' : 'accent')}>{r.bin.draft ? 'Watermarked draft' : 'Clean export'}</span>
            <span>{(r.bin.blob.size / 1024).toFixed(1)} KB · shown at {w}px</span>
            <span className="muted">{isEob ? 'Carries “THIS IS NOT A BILL”. ' : ''}Sorting and filtering work in the file; totals never change.</span>
            <Proof label="Proof">
              <span className="ox-proof">Run <span className="chip code">{r.bin.runId}</span> · digest <span className="chip code" title={r.bin.contentDigest}>{short(r.bin.contentDigest, 16)}…</span> · SHA-256 <span className="chip code" title={r.bin.sha256}>{short(r.bin.sha256, 16)}…</span> · <span className="chip code">{r.bin.filename}</span></span>
            </Proof>
          </div>
          <div className={'ox-viewer ox-html' + (stale ? ' is-stale' : '')} ref={box} style={{ height: H + barH + bezel * 2 + 28 }} data-testid="html-preview">
            <div className={`ox-device ox-device--${kind}`} data-device={kind} style={{ padding: bezel }}>
              {kind === 'desktop' && <div className="ox-device-bar" aria-hidden="true"><i /><i /><i /><span>Interactive HTML · {w}px wide</span></div>}
              {kind === 'phone' && <span className="ox-device-notch" aria-hidden="true" />}
              <div className="ox-device-screen" style={{ width: w * scale, height: H }}>
                <iframe title={`Interactive HTML preview at ${w}px`} sandbox="allow-scripts allow-popups" srcDoc={r.text}
                  style={{ width: w, height: H / scale, transform: `scale(${scale})`, transformOrigin: '0 0' }} data-testid="html-iframe" />
              </div>
            </div>
            {stale && <div className="ox-stale-veil">OUT OF DATE</div>}
          </div>
        </>
      ) : job.status !== 'error' ? <Pending what="interactive HTML" who={who} job={job} /> : null}
    </>
  );
}

/* ------------------------------------------------------------ Email & SMS channels */

type EmailDto = Awaited<ReturnType<typeof api.composeEmail>>;
type SmsDto = Awaited<ReturnType<typeof api.composeSms>>;
type ParityDto = EmailDto['parity'];

/** Composes a channel for the live (possibly unsaved) model; recomposes when the model or scenario changes. */
function useChannel<T>(call: (req: ScenarioRequest) => Promise<T>, req: ScenarioRequest) {
  const [state, setState] = useState<{ status: 'running' | 'done' | 'error'; data?: T; error?: { code: string; message: string; issues: Issue[] } }>({ status: 'running' });
  const [draft, setDraft] = useState(false);
  const key = JSON.stringify(req) + (draft ? '#draft' : '');
  const latest = useRef(0);
  useEffect(() => {
    const my = ++latest.current;
    setState((s) => ({ ...s, status: 'running', error: undefined }));
    const t = setTimeout(() => {
      call(draft ? { ...req, allowDraft: true } : req).then(
        (data) => { if (latest.current === my) setState({ status: 'done', data }); },
        (e) => { if (latest.current === my) setState({ status: 'error', error: toError(e) }); },
      );
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ...state, draft, setDraft };
}

function ChannelIssues({ error, onDraft }: { error?: { code: string; message: string; issues: Issue[] }; onDraft: () => void }) {
  if (!error) return null;
  const blocked = error.code === 'BLOCKING_DIAGNOSTICS';
  return (
    <div className="callout error ox-issues" role="alert" data-testid={blocked ? 'blocking-issues' : 'compose-error'}>
      <strong>{blocked ? 'Channel export blocked' : 'Channel composition failed'} <span className="mono">({error.code})</span></strong>
      <span>{error.message}</span>
      {error.issues.length > 0 && <ul>{error.issues.map((i, k) => <li key={k}><span className="sev">{i.severity ?? 'issue'}</span> <strong>{i.code}</strong>{i.nodeId ? ` · ${i.nodeId}` : ''} — {i.message}</li>)}</ul>}
      {blocked && <div className="row" style={{ gap: 8 }}><button className="btn sm danger" onClick={onDraft}>Compose draft anyway</button></div>}
    </div>
  );
}

function ParityChips({ parity, testId }: { parity: ParityDto; testId: string }) {
  const shown = parity.checks.filter((c) => c.status !== 'not-applicable');
  return (
    <div className="ch-parity" data-testid={testId} role="group" aria-label="Parity with the semantic manifest">
      <span className={'chip ' + (parity.ok ? 'accent' : 'error')} data-testid={`${testId}-overall`}>{parity.ok ? 'Parity: matches manifest' : 'Parity: MISMATCH'}</span>
      {shown.map((c) => (
        <span key={c.id} className={'chip ' + (c.status === 'match' ? 'info' : 'error')} title={c.label + (c.status === 'mismatch' ? ` — ${JSON.stringify(c.email ?? c.sms ?? '')}` : '')}>
          {c.status === 'match' ? '✓' : '✗'} {c.label.split(' (')[0]}
        </span>
      ))}
      {parity.checks.length > shown.length && <span className="muted ch-na">{parity.checks.length - shown.length} not applicable to this document</span>}
    </div>
  );
}

function Warnings({ items, testId }: { items: string[]; testId: string }) {
  if (!items.length) return null;
  return (
    <ul className="ch-warnings" aria-label="Channel warnings">
      {items.map((w, i) => <li key={i} className="callout warning" data-testid={testId}><span className="sev">warning</span> {w}</li>)}
    </ul>
  );
}

const CH_WIDTH = { desktop: 600, mobile: 360 } as const;

function EmailTab({ req, isEob }: { req: ScenarioRequest; isEob: boolean }) {
  const { status, data, error, setDraft } = useChannel(api.composeEmail, req);
  const [view, setView] = useState<'desktop' | 'mobile'>('desktop');
  const [plain, setPlain] = useState(false);
  const blobUrl = useMemo(() => (data ? URL.createObjectURL(new Blob([data.html], { type: 'text/html;charset=utf-8' })) : null), [data]);
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);
  const w = CH_WIDTH[view];
  return (
    <div className="ch" data-testid="email-tab">
      <ChannelIssues error={error} onDraft={() => setDraft(true)} />
      {status === 'running' && !data && <div className="empty" role="status"><span className="spinner" /> Composing email…</div>}
      {data && (
        <>
          <dl className="ch-head">
            <dt>Subject</dt><dd data-testid="email-subject">{data.subject}</dd>
            <dt>Preheader</dt><dd data-testid="email-preheader" className="muted">{data.preheader}</dd>
          </dl>
          <div className="ox-jobbar">
            <div className="segmented" role="group" aria-label="Email preview width">
              <button aria-pressed={view === 'desktop'} onClick={() => setView('desktop')} data-testid="email-view-desktop">Desktop 600</button>
              <button aria-pressed={view === 'mobile'} onClick={() => setView('mobile')} data-testid="email-view-mobile">Mobile 360</button>
            </div>
            <button className="btn" aria-pressed={plain} onClick={() => setPlain((p) => !p)} data-testid="email-text-toggle">{plain ? 'Show HTML' : 'Plain text'}</button>
            {blobUrl && <a className="btn" href={blobUrl} download={data.filename} data-testid="email-download"><Icon.download /> Download .html</a>}
            {status === 'running' && <span className="chip info" role="status">Refreshing…</span>}
          </div>
          <ParityChips parity={data.parity} testId="email-parity" />
          <div className="ox-viewer ox-html ch-stage" data-testid="email-preview">
            {plain
              ? <pre className="ch-plain" data-testid="email-text" tabIndex={0} aria-label="Plain-text alternative">{data.text}</pre>
              : <iframe title={`Email preview at ${w}px`} sandbox="" srcDoc={data.html} style={{ width: w }} data-testid="email-iframe" />}
          </div>
          <Warnings items={data.warnings} testId="email-warning" />
          <div className="ox-strip">
            <span className="muted">{isEob ? 'Carries “THIS IS NOT A BILL”. ' : ''}Scripts, forms and external assets are never included; the preview is sandboxed.</span>
            <Proof label="Proof"><span className="ox-proof">Run <span className="chip code">{data.runId}</span> · artifact <span className="chip code">{data.artifactId}</span> · SHA-256 <span className="chip code" title={data.sha256}>{short(data.sha256, 16)}…</span> · <span className="chip code">{data.locale}</span></span></Proof>
          </div>
        </>
      )}
    </div>
  );
}

function SmsTab({ req, isEob }: { req: ScenarioRequest; isEob: boolean }) {
  const { status, data, error, setDraft } = useChannel(api.composeSms, req);
  const pieces = useMemo(() => {
    if (!data) return [];
    const bad = new Map(data.nonGsm.map((n) => [n.index, n]));
    const out: Array<{ t: string; bad?: { char: string; codePoint: string } }> = [];
    let i = 0;
    for (const ch of data.text) { const b = bad.get(i); out.push(b ? { t: ch, bad: b } : { t: ch }); i += ch.length; }
    return out;
  }, [data]);
  const limit = data ? (data.segments <= 1 ? data.perSegment : data.perSegment * data.segments) : 160;
  return (
    <div className="ch" data-testid="sms-tab">
      <ChannelIssues error={error} onDraft={() => setDraft(true)} />
      {status === 'running' && !data && <div className="empty" role="status"><span className="spinner" /> Composing SMS…</div>}
      {data && (
        <>
          <div className="ch-sms-wrap">
            <div className="ch-phone" role="img" aria-label="Phone preview of the SMS">
              <div className="ch-phone-bar">Text message · now</div>
              <p className="ch-bubble" data-testid="sms-text" aria-label="SMS text">
                {pieces.map((p, i) => p.bad ? <mark key={i} className="ch-nongsm" title={`Non-GSM character ${p.bad.codePoint}`} data-testid="sms-nongsm">{p.t}</mark> : <span key={i}>{p.t}</span>)}
              </p>
            </div>
            <div className="ch-sms-side">
              <p className="ch-counter" data-testid="sms-counter" aria-live="polite">{data.length} / {limit} · {data.segments} segment{data.segments === 1 ? '' : 's'} · {data.encoding}</p>
              <p className="muted ch-fine">{data.encoding === 'GSM-7' ? 'GSM-7: 160 characters in one segment, 153 per segment when concatenated.' : 'UCS-2: 70 characters in one segment, 67 per segment when concatenated.'} {isEob ? 'This message does not imply a bill.' : ''}</p>
              {data.nonGsm.length > 0 && <p className="ch-fine">Non-GSM: {[...new Set(data.nonGsm.map((n) => `${n.char} ${n.codePoint}`))].join(', ')}</p>}
              <ParityChips parity={data.parity} testId="sms-parity" />
              <Warnings items={data.warnings} testId="sms-warning" />
              {status === 'running' && <span className="chip info" role="status">Refreshing…</span>}
              <Proof label="Proof"><span className="ox-proof">Run <span className="chip code">{data.runId}</span> · <span className="chip code">{data.locale}</span></span></Proof>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ AFP simulation */

function AfpTab({ job, want, now, who, stale, onRun, onCancel }: { job: Job<any>; want: string | null; now: number; who: string; stale: boolean; onRun: () => void; onCancel: () => void }) {
  const s = job.result;
  return (
    <>
      <div className="ox-afp-banner" role="note" data-testid="afp-sim-label">
        <Icon.warning /> <strong>{AFP_LABEL}</strong>
        <span>Conceptual feasibility report derived from the real paged composition. No .afp file is produced or offered.</span>
      </div>
      <JobBar job={job} label="AFP simulation" onRun={onRun} onCancel={onCancel} testId="view-afp-simulation" runLabel={s ? 'Refresh AFP simulation' : 'View AFP simulation'} fresh={<Fresh job={job} want={want} now={now} testId="stale-afp" />} />
      <IssuesBlock job={job} kind="AFP simulation" />
      {s ? (
        <div className="ox-afp">
          <div className="ox-afp-grid">
            <section className="ox-card"><h3>Media</h3>
              <dl className="kv"><dt>Paper</dt><dd>{s.media?.paper}</dd><dt>Size</dt><dd>{s.media?.widthPt} × {s.media?.heightPt} pt</dd><dt>Duplex</dt><dd>{String(s.media?.duplex)}</dd><dt>Margins (mm)</dt><dd>{(s.media?.marginsMm ?? []).join(' / ')}</dd><dt>Pages</dt><dd>{s.pageCount ?? '—'}</dd><dt>AFP bytes generated</dt><dd data-testid="afp-bytes">{s.afpBytesGenerated}</dd></dl>
            </section>
            <section className="ox-card"><h3>Form definition / page definition (concept)</h3>
              <dl className="kv"><dt>FORMDEF</dt><dd><span className="chip code">{s.formdef}</span></dd><dt>PAGEDEF</dt><dd><span className="chip code">{s.pagedef}</span></dd>{/* run id is shown in Technical view only */}</dl>
              <Tech><dl className="kv"><dt>Run ID</dt><dd><span className="chip code">{s.runId}</span></dd></dl></Tech>
              <h4>Continuation regions</h4>
              {(s.continuationRegions ?? []).map((c: any, i: number) => <dl key={i} className="kv"><dt>{c.name}</dt><dd>first {c.firstPageTopPt} · others {c.otherPagesTopPt} · bottom {c.bottomPt} pt</dd></dl>)}
            </section>
            <section className="ox-card"><h3>Font map</h3>
              {Object.keys(s.fontMap ?? {}).length === 0 ? <span className="muted">None defined.</span> : <dl className="kv">{Object.entries(s.fontMap).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{String(v)}</dd></Fragment>)}</dl>}
              <h4>Overlays</h4>
              <div className="ox-chips">{(s.overlays ?? []).length ? s.overlays.map((o: string) => <span key={o} className="chip">{o}</span>) : <span className="muted">None.</span>}</div>
            </section>
            <section className="ox-card"><h3>Resource checklist</h3>
              <ul className="ox-check">
                {(s.checklist ?? []).map((c: any, i: number) => <li key={i}><span className={'chip ' + (c.ok ? 'accent' : 'sim')}>{c.ok ? 'ok' : 'concept'}</span> {c.item}{c.note ? <small> — {c.note}</small> : null}</li>)}
                {(s.resources ?? []).map((r: any) => <li key={r.name}><span className="chip sim">{r.status}</span> <span className="mono">{r.name}</span></li>)}
              </ul>
            </section>
          </div>
          <section className="ox-card"><h3>Page sequence</h3>
            <table className="table ox-seq">
              <thead><tr><th>Sheet</th><th>Side</th><th>Page</th><th>Nodes</th><th>Continued tables</th></tr></thead>
              <tbody>{(s.pageSequence ?? []).map((p: any) => <tr key={p.page}><td>{p.sheet}</td><td>{p.side}</td><td>{p.page}</td><td>{(p.nodeIds ?? []).join(', ')}</td><td>{(p.continuedTables ?? []).join(', ') || '—'}</td></tr>)}</tbody>
            </table>
          </section>
          {(s.warnings ?? []).length > 0 && <div className="callout warning"><ul className="ox-warn">{s.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></div>}
        </div>
      ) : job.status !== 'error' ? <Pending what="AFP simulation report" who={who} job={job} /> : null}
    </>
  );
}

/* ------------------------------------------------------------ parity */

function ParityPanel({ job, pairKey, now, wait, onRun }: { job: Job<any>; pairKey: string | null; now: number; wait: 'building' | 'blocked' | null; onRun: () => void }) {
  const r = job.result;
  const running = job.status === 'running';
  const el = useElapsed(job.startedAt, running);
  const rep = r?.report;
  const outdated = !!rep && !!pairKey && job.forRun !== pairKey;
  return (
    <section className="panel ox-parity" data-testid="semantic-parity" aria-label="Semantic parity">
      <div className="panel-head">Semantic parity
        <span className="right">
          {rep && <span className={'chip ' + (rep.ok ? 'accent' : 'error')} data-testid="parity-status">{rep.ok ? 'OK — all match' : 'Mismatch'}</span>}
          <button className="btn sm primary" onClick={onRun} disabled={running} data-testid="run-parity">{running ? <><span className="spinner" /> {el} s</> : rep ? 'Re-run parity' : 'Run parity check'}</button>
        </span>
      </div>
      <div className="panel-body flush">
        {rep && <div className={'ox-fresh ox-fresh-row' + (outdated || running ? ' old' : '')} role="status">{running ? 'Checking the PDF against the HTML…' : outdated ? 'Out of date — re-checking…' : `Checked ${relMs(job.builtAt, now)} · up to date`}{!running && !outdated && r.source === 'artifacts' ? ' · from the built PDF and HTML' : ''}</div>}
        <IssuesBlock job={job} kind="Parity" />
        {!rep ? (job.status === 'error' ? null : (
          <p className="ox-par-wait" role="status">
            {running ? <><span className="spinner" /> Comparing money, variants, disclosures, tables and identity between the real PDF and HTML…</>
              : wait === 'blocked' ? 'The PDF or HTML could not be built for this scenario, so there is nothing to compare yet. Fix the blocking problem shown in the preview, or build a watermarked draft.'
              : <><span className="spinner" /> Waiting for the PDF and HTML to finish building, then the check runs automatically.</>}
          </p>
        )) : (
          <>
            <div className="ox-par-sum">
              <span className="chip count">{rep.checks.length} checks</span>
              <span className="chip accent">{rep.checks.filter((c: any) => c.status === 'match').length} match</span>
              <span className={'chip ' + (rep.checks.some((c: any) => c.status === 'mismatch') ? 'error' : 'count')}>{rep.checks.filter((c: any) => c.status === 'mismatch').length} mismatch</span>
              <span className="chip count">PDF {r.pdf?.pdfPageCount ?? r.pdf?.pageCount} pp</span>
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

export const BLOCK_WORDS: Record<string, string> = {
  BALANCE_RECONCILIATION_FAILED: 'Balances do not add up', CLAIM_RECONCILIATION_FAILED: 'Claim amounts do not add up',
  INCONSISTENT_PAYMENT_STATE: 'Payment state is inconsistent', UNCONFIRMED_DEBT_LANGUAGE: 'Debt wording used without confirmed debt',
  UNCONFIRMED_MEMBER_LIABILITY: 'Member liability not confirmed', REQUIRED_NODE_MISSING: 'A required section is missing',
  REQUIRED_TRANSLATION_MISSING: 'A required translation is missing', NO_VARIANT_MATCH: 'No wording matches this customer',
  EXCLUSIVE_PRIORITY_TIE: 'Two rules tie for the same spot', MISSING_CONTENT_PART: 'Content is missing', NULL_BINDING: 'A data field is empty',
  INVALID_BINDING: 'A data field is invalid', IMAGE_ALT_MISSING: 'An image has no description', UNSAFE_URL: 'A link is not allowed',
  RECORD_TYPE_MISMATCH: 'Record does not fit this document', UNKNOWN_VARIANT: 'Unknown wording variant', UNKNOWN_SECTION: 'Unknown section',
};
export const blockWord = (c: string) => BLOCK_WORDS[c] ?? c.toLowerCase().replace(/_/g, ' ');
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
            <div className="bx-tile"><b>{batch.done ? fmtDur((batch.durationMs ?? 0) / batch.done) : '—'}</b><span>Avg per record</span></div>
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
