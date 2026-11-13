import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolve } from '@iss/resolver';
import { api, ApiFailure, type ComposedPages } from '../api/client';
import { useStudio, useScenarioRequest, personaLabel } from '../state/store';
import { recordSummary } from '../shell/RecordPicker';
import { ScreenHeader, Loading, ErrorState, Empty, Tech, Proof } from '../ui/common';
import { nodeTitle } from '../ui/plain';
import { Icon } from '../ui/icons';
import { pageBoxFromCss } from '../doc/pageBox';
import './PageStack.css';

type Mode = 'scenario' | 'time' | 'persona';
type Layout = 'stack' | 'fan';
type Diag = ComposedPages['diagnostics'][number];
type PageInfo = ComposedPages['pages'][number];

// Page size in px: read from the composed CSS, so another paper size or orientation is drawn as composed.

/* ------------------------------------------------------------ helpers */

/** 250 synthetic transactions summing exactly to purchasesCents (integer cents, fixtures/expected_scenarios.json card-250-rows). */
export function stressTransactions(purchasesCents: number, n = 250) {
  const base = Math.floor(purchasesCents / n);
  const extra = purchasesCents - base * n;
  return Array.from({ length: n }, (_, i) => ({
    id: `STRESS-${String(i + 1).padStart(4, '0')}`,
    date: '2026-10-15',
    merchant: `Synthetic transaction ${String(i + 1).padStart(3, '0')}`,
    amountCents: base + (i < extra ? 1 : 0),
  }));
}

function isStress(overrides: Record<string, unknown>): boolean {
  const tx = (overrides as any)?.card?.transactions;
  return Array.isArray(tx) && tx.length === 250 && String(tx[0]?.id ?? '').startsWith('STRESS-');
}

function pageSpan(pages: number[]): string {
  if (!pages.length) return '—';
  const out: string[] = [];
  let s = pages[0], p = pages[0];
  for (const n of [...pages.slice(1), Infinity]) {
    if (n === p + 1) { p = n; continue; }
    out.push(s === p ? `${s}` : `${s}–${p}`);
    s = p = n;
  }
  return 'p' + out.join(', ');
}

function nodePages(c: ComposedPages): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const p of c.pages) for (const id of p.nodeIds) { const a = m.get(id) ?? []; a.push(p.index); m.set(id, a); }
  return m;
}

function tableRowsTotal(c: ComposedPages, id: string): number {
  return c.pages.reduce((a, p) => a + (p.tables[id]?.rows ?? 0), 0);
}

function sevClass(d: Diag): 'error' | 'warning' { return d.severity === 'blocking' || d.severity === 'error' ? 'error' : 'warning'; }

function fixCss(css: string): string {
  return css.replace(/:root/g, ':host').replace(/(^|[\s,}])body\{/g, '$1:host{');
}

/* ------------------------------------------------------------ real composed page in a shadow root */

function PageFrame({ css, html, scale, highlight, onNode, label }: { css: string; html: string; scale: number; highlight?: string | null; onNode?: (id: string) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const hl = highlight && /^[\w.-]+$/.test(highlight) ? `[data-node-id="${highlight}"]{outline:3px solid #4EAF60!important;outline-offset:2px;background-color:rgba(78,175,96,.10)}` : '';
    root.innerHTML = `<style>${fixCss(css)}:host{display:block;background:transparent!important}.page{box-shadow:none!important;margin:0!important}${onNode ? '[data-node-id]{cursor:pointer}' : ''}${hl}</style>${html}`;
  }, [css, html, highlight, onNode]);
  useEffect(() => {
    const host = ref.current;
    if (!host || !onNode) return;
    const h = (e: Event) => {
      for (const el of e.composedPath()) {
        const id = (el as HTMLElement).getAttribute?.('data-node-id');
        if (id) { onNode(id); return; }
      }
    };
    host.addEventListener('click', h);
    return () => host.removeEventListener('click', h);
  }, [onNode]);
  const box = useMemo(() => pageBoxFromCss(css), [css]);
  return (
    <div className="ps-frame" style={{ width: box.w * scale, height: box.h * scale }} role="img" aria-label={label}>
      <div ref={ref} className="ps-frame-host" style={{ width: box.w, height: box.h, transform: `scale(${scale})` }} />
    </div>
  );
}

/* ------------------------------------------------------------ composition hook (real composer, debounced) */

interface Comp { data: ComposedPages | null; error: ApiFailure | null; loading: boolean; elapsed: number; reload: () => void }

function useComposition(req: any | null): Comp {
  const [data, setData] = useState<ComposedPages | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!req) { setData(null); setError(null); setLoading(false); return; }
    const my = ++seq.current;
    setLoading(true);
    const t0 = Date.now();
    setElapsed(0);
    const iv = setInterval(() => setElapsed(Date.now() - t0), 200);
    const to = setTimeout(() => {
      api.composePages(req).then(
        (d) => { if (seq.current === my) { setData(d); setError(null); setLoading(false); } },
        (e) => { if (seq.current === my) { setError(e instanceof ApiFailure ? e : new ApiFailure(0, 'UNKNOWN', String(e))); setLoading(false); } },
      ).finally(() => clearInterval(iv));
    }, 250);
    return () => { clearTimeout(to); clearInterval(iv); };
  }, [req, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, elapsed, reload };
}

/* ------------------------------------------------------------ 2.5D stack */

function Stack({ comp, layout, separation, selected, onSelect, onDiag, focusNode, nm }: {
  nm: (id: string) => string;
  comp: ComposedPages; layout: Layout; separation: number; selected: number | null;
  onSelect: (n: number) => void; onDiag: (d: Diag) => void; focusNode: string | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const n = comp.snapshot.pages.length;
  // Fan leaves room beside the first page so the following pages show a readable strip; Stack keeps pages larger.
  const scale = n > 10 ? 0.34 : n > 4 ? 0.4 : layout === 'fan' ? 0.42 : 0.5;
  const box = pageBoxFromCss(comp.snapshot.css);
  const pw = box.w * scale, ph = box.h * scale;
  const maxStep = n > 1 ? Math.max(8, (w - pw - 80) / (n - 1)) : 0;
  const step = Math.min(maxStep, 8 + (separation / 100) * (layout === 'fan' ? 260 : 150));
  const total = pw + step * (n - 1);
  const x0 = Math.max(20, (w - total) / 2);
  return (
    <div className="ps-scene" ref={wrap} data-layout={layout}>
      <div className="ps-world" style={{ height: ph + 90 }}>
        {comp.snapshot.pages.map((html, i) => {
          const idx = i + 1;
          const diags = comp.diagnostics.filter((d) => d.page === idx);
                    const rot = layout === 'fan' ? (i - (n - 1) / 2) * Math.min(5, 28 / Math.max(1, n - 1) * 2) : 0;
          const lift = layout === 'fan' ? Math.abs(i - (n - 1) / 2) * 6 : 0;
          return (
            <div
              key={idx}
              className={'ps-card' + (selected === idx ? ' sel' : '') + (diags.length ? ' has-diag' : '')}
              style={{ left: x0 + i * step, top: 40 + lift, width: pw, height: ph, zIndex: selected === idx ? 100 : n - i, transform: `translateZ(${(n - 1 - i) * 4}px) rotate(${rot}deg)` }}
            >
              <button className="ps-card-hit" onClick={() => onSelect(idx)} aria-label={`Open page ${idx} at full size`} aria-pressed={selected === idx} />
              <PageFrame css={comp.snapshot.css} html={html} scale={scale} highlight={focusNode} label={`Composed page ${idx} of ${n}`} />
              <span className="ps-card-num">{idx}</span>
              {diags.length > 0 && (
                <div className="ps-card-diags">
                  {diags.slice(0, 2).map((d, k) => (
                    <button key={k} className={'ps-marker ' + sevClass(d)} onClick={() => onDiag(d)} title={d.message}>
                      <Icon.warning /> <span>{d.code}{d.nodeId ? ` · ${nm(d.nodeId)}` : ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {comp.diagnostics.length > 0 && (
        <div className="ps-diag-strip" aria-label="Page diagnostics">
          {comp.diagnostics.map((d, k) => (
            <button key={k} className={'ps-marker ' + sevClass(d)} onClick={() => onDiag(d)} title={d.message}>
              <Icon.warning /> <span>{d.page ? `Page ${d.page} · ` : ''}{d.code}{d.nodeId ? ` · ${nm(d.nodeId)}` : ''}{d.rowsClipped ? ` · ${d.rowsClipped} rows clipped` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ screen */

export function PageStack() {
  const navigate = useNavigate();
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const dispatch = useStudio((s) => s.dispatch);
  const select = useStudio((s) => s.select);
  const setOverrides = useStudio((s) => s.setOverrides);
  const patchOverrides = useStudio((s) => s.patchOverrides);
  const baseReq = useScenarioRequest();
  const isCard = project.documentType === 'credit-statement';
  const biz = useStudio((s) => s.viewMode) === 'business';
  const nm = (id: string) => (biz ? nodeTitle(project, id) : id);

  const [mode, setMode] = useState<Mode>('scenario');
  const [layout, setLayout] = useState<Layout>('fan');
  const [separation, setSeparation] = useState(55);
  const [selected, setSelected] = useState<number | null>(null);
  /** Page shown in the inspector. Defaults to page 1 so the inspector is never empty; independent of the full-size preview (`selected`). */
  const [inspected, setInspected] = useState<number>(1);
  const [viewSide, setViewSide] = useState<'A' | 'B'>('A');
  const [cmpCursor, setCmpCursor] = useState<number | null | undefined>(undefined);
  const [cmpRecord, setCmpRecord] = useState<string>('');
  const [focusDiag, setFocusDiag] = useState<Diag | null>(null);

  const events = project.journey?.events ?? [];
  const defaultCmpCursor = ctx.journeyCursor == null ? (events.length ? events.length - 1 : null) : null;
  const effCmpCursor = cmpCursor === undefined ? defaultCmpCursor : cmpCursor;
  const otherRecords = useMemo(() => records.filter((r) => r.recordId !== ctx.recordId), [records, ctx.recordId]);
  const effCmpRecord = cmpRecord && otherRecords.some((r) => r.recordId === cmpRecord) ? cmpRecord : otherRecords[0]?.recordId ?? '';

  const tableNode = useMemo(() => project.nodes.find((n) => n.type === 'repeating-table') ?? null, [project]);
  const continuationOn = tableNode ? tableNode.flowContinuation !== false : true;
  const stress = isCard && isStress(ctx.overrides);

  const reqA = useMemo(() => (baseReq ? { ...baseReq, verifyPdf: true, outputContext: { profileId: 'paged-pdf' as const } } : null), [baseReq]);
  const reqB = useMemo(() => {
    if (!baseReq) return null;
    const b = { ...baseReq, verifyPdf: true, outputContext: { profileId: 'paged-pdf' as const } };
    if (mode === 'time') return { ...b, journeyCursor: effCmpCursor };
    if (mode === 'persona' && effCmpRecord) {
      const rec: any = records.find((r) => r.recordId === effCmpRecord);
      const ov = stress && rec?.card ? { card: { transactions: stressTransactions(Number(rec.card.purchasesCents)) } } : {};
      return { ...b, recordId: effCmpRecord, overrides: ov, journeyCursor: null };
    }
    return null;
  }, [baseReq, mode, effCmpCursor, effCmpRecord, records, stress]);

  const A = useComposition(reqA);
  const B = useComposition(reqB);
  const comparing = mode !== 'scenario' && !!reqB;
  const active = comparing && viewSide === 'B' ? B : A;
  const comp = active.data;

  // Expected run id for the live model/scenario (paged profile): marks the displayed composition stale.
  const expectedRunId = useMemo(() => {
    const rec = records.find((r) => r.recordId === ctx.recordId);
    if (!rec || rec.documentType !== project.documentType) return null;
    try { return resolve({ project, record: rec, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor, profileId: 'paged-pdf' }).runId; } catch { return null; }
  }, [project, records, ctx.recordId, ctx.overrides, ctx.journeyCursor]);
  const stale = !!A.data && !!expectedRunId && A.data.runId !== expectedRunId;

  useEffect(() => { setFocusDiag(null); }, [comp?.runId, viewSide]);
  useEffect(() => { if (selected && comp && selected > comp.pageCount) setSelected(null); }, [comp, selected]);
  useEffect(() => { if (comp && comp.pageCount > 0 && inspected > comp.pageCount) setInspected(1); }, [comp, inspected]);
  const openPage = (n: number) => { setSelected(n); setInspected(n); };
  const curPage = comp && comp.pageCount > 0 ? Math.min(Math.max(1, selected ?? inspected), comp.pageCount) : null;

  const toggleStress = () => {
    if (stress) {
      const o: any = JSON.parse(JSON.stringify(ctx.overrides));
      if (o.card) { delete o.card.transactions; if (!Object.keys(o.card).length) delete o.card; }
      setOverrides(o);
    } else {
      const rec: any = records.find((r) => r.recordId === ctx.recordId);
      patchOverrides({ card: { transactions: stressTransactions(Number(rec?.card?.purchasesCents ?? 0)) } });
    }
  };
  const toggleContinuation = () => {
    if (!tableNode) return;
    dispatch({ type: 'UPDATE_NODE', nodeId: tableNode.id, patch: { flowContinuation: !continuationOn } });
  };
  const onDiag = (d: Diag) => { setFocusDiag(d); if (d.nodeId) select(d.nodeId); };
  const selNode = ctx.selectedNodeId;

  const srcName = (id: string) => { if (!biz) return id; const r = records.find((x) => x.recordId === id); return r ? recordSummary(r, personas).name : id; };
  const srcIds = (c: ComposedPages) => (c === A.data ? ctx.recordId : (mode === 'persona' ? effCmpRecord : ctx.recordId));
  const scenarioLabel = (c: ComposedPages) => {
    const isA = c === A.data;
    const parts = [srcName(isA ? ctx.recordId : (mode === 'persona' ? effCmpRecord : ctx.recordId))];
    if (isA) { if (ctx.journeyCursor != null) parts.push(`journey cursor ${ctx.journeyCursor}`); if (stress) parts.push('stress 250 rows'); else if (Object.keys(ctx.overrides).length) parts.push('overrides'); }
    else if (mode === 'time') parts.push(effCmpCursor == null ? 'baseline (no journey events)' : `journey cursor ${effCmpCursor}`);
    else if (mode === 'persona' && stress) parts.push('stress 250 rows');
    return parts.join(' · ');
  };

  if (!baseReq) return <section className="screen" data-testid="page-stack-view"><ScreenHeader id="S06" title="Page Composition Stack" subtitle="" /><Empty title="No scenario" message="No matching fixture for this project." /></section>;

  const pdfOk = comp && comp.pdfPageCount === comp.pageCount;
  const countText = comp
    ? `${comp.pageCount} ${comp.pageCount === 1 ? 'page' : 'pages'} · ${comp.pdfPageCount == null ? 'PDF not verified' : pdfOk ? `PDF verified ${comp.pdfPageCount}` : `PDF counted ${comp.pdfPageCount} — page mismatch`}`
    : A.loading ? 'Composing…' : '—';

  const diagList = comp?.diagnostics ?? [];
  const selPage: PageInfo | null = comp && curPage ? comp.pages[curPage - 1] ?? null : null;

  return (
    <section className="screen" data-testid="page-stack-view">
      <ScreenHeader
        id="S06" title="Page Composition Stack"
        subtitle="Real pages from the headless-Chromium composer, counted again from the generated PDF. Nothing here is estimated."
        badge={<span className={'ps-count' + (comp && !pdfOk ? ' bad' : '')} data-testid="page-count" aria-live="polite">{countText}</span>}
        actions={<button className="btn" onClick={() => { A.reload(); B.reload(); }} disabled={A.loading}><Icon.reset /> Recompose</button>}
      />
      <div className="screen-body ps-body">
        {/* ---------------- controls */}
        <aside className="panel ps-controls" aria-label="Composition controls" data-side="left" data-side-title="Compare">
          <div className="panel-head">Compare</div>
          <div className="panel-body">
            <div className="segmented ps-seg" role="group" aria-label="Compare mode">
              {([['scenario', 'Current scenario'], ['time', 'Same customer through time'], ['persona', 'Different personas']] as const).map(([k, l]) => (
                <button key={k} aria-pressed={mode === k} onClick={() => { setMode(k); setViewSide('A'); }} data-testid={`compare-${k}`}>{l}</button>
              ))}
            </div>
            {mode === 'time' && (
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="ps-cursor">Compare current with journey position</label>
                <select id="ps-cursor" className="select" value={effCmpCursor == null ? '' : String(effCmpCursor)} onChange={(e) => setCmpCursor(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">Baseline (no journey events)</option>
                  {events.map((ev, i) => <option key={ev.eventId} value={i}>{i}: {ev.label ?? ev.eventType}{ev.day != null ? ` (day ${ev.day})` : ''}</option>)}
                </select>
                {events.length === 0 && <span className="muted" style={{ fontSize: 12 }}>This project has no journey events.</span>}
              </div>
            )}
            {mode === 'persona' && (
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="ps-rec">Compare current record with</label>
                <select id="ps-rec" className="select" value={effCmpRecord} onChange={(e) => setCmpRecord(e.target.value)}>
                  {otherRecords.map((r) => <option key={r.recordId} value={r.recordId}>{biz ? recordSummary(r, personas).name : r.recordId} · {r.personaId || project.documentType !== 'custom' ? personaLabel(personas, r.personaId) : r.generated?.label ?? 'Customer'}</option>)}
                </select>
              </div>
            )}

            <div className="section-title">Stress and constraints</div>
            {isCard && (
              <label className="ps-toggle">
                <input type="checkbox" checked={stress} onChange={toggleStress} data-testid="stress-250" />
                <span><strong>Stress: 250 rows</strong><small>{biz ? 'Show this statement with 250 transactions.' : "Scenario override: card.transactions = 250 rows summing to the record's purchases."}</small></span>
              </label>
            )}
            {tableNode && (
              <label className="ps-toggle">
                <input type="checkbox" checked={!continuationOn} onChange={toggleContinuation} data-testid="disable-continuation" />
                <span><strong>Disable continuation</strong><small>{biz ? `Stop “${nodeTitle(project, tableNode.id)}” continuing onto the next page. Undoable.` : `Model edit on “${tableNode.name ?? tableNode.id}” (flowContinuation=false). Undoable from the top bar.`}</small></span>
              </label>
            )}

            <div className="section-title">View</div>
            <div className="segmented ps-seg" role="group" aria-label="Layout">
              <button aria-pressed={layout === 'stack'} onClick={() => setLayout('stack')}>Stack</button>
              <button aria-pressed={layout === 'fan'} onClick={() => setLayout('fan')}>Fan</button>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor="ps-sep">Page separation</label>
              <input id="ps-sep" type="range" min={0} max={100} value={separation} onChange={(e) => setSeparation(Number(e.target.value))} data-testid="separation-slider" />
            </div>

            <div className="callout ps-sibling">
              <span><strong>Interactive HTML</strong> has no pages.</span>
              <button className="btn sm" onClick={() => navigate(`/studio/${project.projectId}/outputs`)}><Icon.external /> Go to outputs</button>
            </div>
          </div>
        </aside>

        {/* ---------------- stage */}
        <div className="stage ps-stage">
          <div className="stage-grid" />
          <div className="ps-stage-inner">
            <div className="ps-strip">
              {comparing && (
                <div className="segmented" role="group" aria-label="Composition shown">
                  <button aria-pressed={viewSide === 'A'} onClick={() => setViewSide('A')}>A · Current</button>
                  <button aria-pressed={viewSide === 'B'} onClick={() => setViewSide('B')}>B · Compared</button>
                </div>
              )}
              <Tech>
                {comp && <span className="chip">run <span className="mono">{comp.runId}</span></span>}
                {comp && <span className="chip">{comp.engine}</span>}
                {comp && <span className="chip">{comp.durationMs} ms</span>}
              </Tech>
              {active.loading && <span className="chip info" role="status"><span className="spinner" /> Composing… {(active.elapsed / 1000).toFixed(1)} s</span>}
              {stale && !A.loading && <span className="chip warning" data-testid="stale-marker">Stale — scenario or model changed since this composition</span>}
              {stale && A.loading && <span className="chip warning">Previous composition (updating)</span>}
              {selected && <button className="btn sm" onClick={() => setSelected(null)}><Icon.stack /> Back to stack</button>}
            </div>

            {comparing && A.data && B.data && <CompareSummary a={A.data} b={B.data} labelA={scenarioLabel(A.data)} labelB={scenarioLabel(B.data)} tableId={tableNode?.id ?? null} nm={nm} />}
            {active.error && !active.loading ? (
              <ErrorState title={`Composition failed (${active.error.code})`} message={active.error.message} onRetry={() => { A.reload(); B.reload(); }} />
            ) : !comp ? (
              <Loading label={`Composing real pages… ${(active.elapsed / 1000).toFixed(1)} s`} />
            ) : selected && comp.snapshot.pages[selected - 1] ? (
              <div className="ps-flat" data-testid="page-flat-preview">
                <div className="ps-flat-bar">
                  <button className="btn sm" disabled={selected <= 1} onClick={() => setSelected(selected - 1)}>Previous</button>
                  <strong>Page {selected} of {comp.pageCount}</strong>
                  <button className="btn sm" disabled={selected >= comp.pageCount} onClick={() => setSelected(selected + 1)}>Next</button>
                  <span className="muted" style={{ fontSize: 12 }}>100% · click a component to select it</span>
                </div>
                <div className="ps-flat-scroll">
                  <div className="ps-flat-paper">
                    <PageFrame css={comp.snapshot.css} html={comp.snapshot.pages[selected - 1]} scale={1} highlight={selNode} onNode={(id) => select(id)} label={`Composed page ${selected}, full size`} />
                    {comp.diagnostics.filter((d) => d.page === selected).map((d, k) => (
                      <button key={k} className={'ps-marker big ' + sevClass(d)} style={{ top: 10 + k * 40 }} onClick={() => onDiag(d)}>
                        <Icon.warning /> <span>{d.code}{d.nodeId ? ` · ${nm(d.nodeId)}` : ''}{d.rowsClipped ? ` · ${d.rowsClipped} rows clipped` : ''}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <Stack comp={comp} layout={layout} separation={separation} selected={curPage} onSelect={openPage} onDiag={onDiag} focusNode={selNode} nm={nm} />
            )}

            {focusDiag && (
              <div className={'callout ' + sevClass(focusDiag) + ' ps-focus'} role="alert">
                <div><strong>{focusDiag.code}</strong>{focusDiag.page ? ` · page ${focusDiag.page}` : ''}{focusDiag.nodeId ? ` · node ${nm(focusDiag.nodeId)}` : ''}<br />{focusDiag.message}</div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => { if (focusDiag.nodeId) select(focusDiag.nodeId); navigate(`/studio/${project.projectId}/design`); }} data-testid="open-flow-constraint">Open flow constraint in designer</button>
                  <button className="btn sm ghost" onClick={() => setFocusDiag(null)} aria-label="Dismiss"><Icon.close /></button>
                </div>
              </div>
            )}

            {comparing && B.error && !B.loading && <div className="callout error">Comparison composition failed ({B.error.code}): {B.error.message}</div>}
          </div>
        </div>

        {/* ---------------- inspector + flat list */}
        <aside className="panel ps-side" aria-label="Page inspector and list" data-side="right" data-side-title="Pages">
          <div className="panel-head">Page inspector</div>
          <div className="ps-inspector" data-testid="page-inspector">
            {!comp ? <span className="muted">No composition yet.</span> : (
              <>
                <dl className="kv">
                  <dt>Page</dt><dd>{curPage ? `${curPage} of ${comp.pageCount}` : `none (${comp.pageCount} total)`}</dd>
                  <dt>Source scenario</dt><dd title={biz ? srcIds(comp) : undefined}>{scenarioLabel(comp)}</dd>
                  <dt>Transactions</dt><dd>{comp.transactionCount ?? '—'}</dd>
                  <dt>Diagnostics</dt><dd>{diagList.length}</dd>
                </dl>
                <Proof label="Run details"><dl className="kv"><dt>Run ID</dt><dd className="mono">{comp.runId}</dd><dt>Composer</dt><dd>{comp.engine} · {comp.durationMs} ms</dd></dl></Proof>
                {selPage ? (
                  <>
                    <div className="section-title">{biz ? 'On page' : 'Nodes on page'} {curPage}</div>
                    <div className="ps-chips">
                      {selPage.nodeIds.map((id) => <button key={id} className={'chip' + (selNode === id ? ' accent' : '')} onClick={() => select(id)} title={id}>{nm(id)}</button>)}
                      {selPage.fixedNodeIds.map((id) => <button key={id} className="chip" onClick={() => select(id)} title={`${id} · fixed (repeating) region`}>{nm(id)} · fixed</button>)}
                    </div>
                    <div className="section-title">Continued components</div>
                    {Object.entries(selPage.tables).length === 0 ? <span className="muted">No tables on this page.</span> : (
                      <ul className="list-rows ps-plain">
                        {Object.entries(selPage.tables).map(([id, t]) => (
                          <li key={id}><button className="rowlink-btn" onClick={() => select(id)} title={id}>{nm(id)}</button>: {rowRange(comp, curPage!, id)}{t.continued ? ' · continued' : ''}{t.headerRepeated ? ' · heading repeated' : ''}<Tech> ({t.firstRowId ?? '—'} → {t.lastRowId ?? '—'})</Tech></li>
                        ))}
                      </ul>
                    )}
                    <div className="section-title">Flow region</div>
                    <dl className="kv"><dt>Top / bottom</dt><dd>{selPage.flowTopPt}–{selPage.flowBottomPt} pt</dd><dt>Used</dt><dd>{selPage.usedPt} pt</dd></dl>
                    {diagList.filter((d) => d.page === curPage).map((d, k) => (
                      <div key={k} className={'callout ' + sevClass(d)} style={{ marginTop: 8 }}><strong>{d.code}</strong> — {d.message}</div>
                    ))}
                  </>
                ) : <p className="muted" style={{ fontSize: 12.5 }}>This composition has no pages.</p>}
              </>
            )}
          </div>

          <div className="panel-head" style={{ borderTop: '1px solid var(--iss-border)' }}>Pages <span className="sub">accessible list</span></div>
          <div className="panel-body flush ps-list-wrap">
            {!comp ? <span className="muted">—</span> : (
              <ol className="list-rows ps-list" data-testid="page-flat-list">
                {comp.pages.map((p) => {
                  const dg = diagList.filter((d) => d.page === p.index);
                  return (
                    <li key={p.index} className={curPage === p.index ? 'selected' : ''}>
                      <button className="ps-list-main" onClick={() => openPage(p.index)} aria-current={curPage === p.index}>
                        <strong>Page {p.index}</strong>
                        <span className="ps-nodes" title={p.nodeIds.join(', ')}>{p.nodeIds.map(nm).join(', ') || '—'}</span>
                        {Object.entries(p.tables).map(([id, t]) => (
                          <span key={id} className="ps-trow">
                            {nm(id)}: {rowRange(comp, p.index, id)}<Tech> ({t.firstRowId ?? '—'}–{t.lastRowId ?? '—'})</Tech>
                            {t.continued && <span className="chip info">continued</span>}
                            {t.headerRepeated && <span className="chip accent">heading repeated</span>}
                          </span>
                        ))}
                      </button>
                      {dg.map((d, k) => (
                        <button key={k} className={'ps-diag-line ' + sevClass(d)} onClick={() => onDiag(d)}>
                          <Icon.warning /> <span><strong>{d.code}</strong>{d.nodeId ? <> · {biz ? `${nm(d.nodeId)} ` : ''}<span className="chip code">{d.nodeId}</span></> : null}{d.rowsClipped ? ` · ${d.rowsClipped} rows clipped` : ''}</span>
                        </button>
                      ))}
                    </li>
                  );
                })}
                {diagList.filter((d) => !d.page).map((d, k) => (
                  <li key={'g' + k}><button className={'ps-diag-line ' + sevClass(d)} onClick={() => onDiag(d)}><Icon.warning /> <span><strong>{d.code}</strong> — {d.message}</span></button></li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ before / after */

/** "rows 1–5 of 250" for the table `id` on page `pageIndex`, derived from per-page row counts. */
function rowRange(c: ComposedPages, pageIndex: number, id: string): string {
  let before = 0;
  for (const p of c.pages) { if (p.index >= pageIndex) break; before += p.tables[id]?.rows ?? 0; }
  const rows = c.pages.find((p) => p.index === pageIndex)?.tables[id]?.rows ?? 0;
  const total = tableRowsTotal(c, id);
  return rows === 0 ? `no rows of ${total}` : `rows ${before + 1}–${before + rows} of ${total}`;
}

function CompareSummary({ a, b, labelA, labelB, tableId, nm }: { nm: (id: string) => string; a: ComposedPages; b: ComposedPages; labelA: string; labelB: string; tableId: string | null }) {
  const pa = nodePages(a), pb = nodePages(b);
  const ids = [...new Set([...pa.keys(), ...pb.keys()])];
  const rows = ids.map((id) => ({ id, pa: pa.get(id) ?? [], pb: pb.get(id) ?? [] }));
  const changed = (r: { pa: number[]; pb: number[] }) => r.pa.join() !== r.pb.join();
  const [all, setAll] = useState(false);
  const isTable = (id: string) => id === tableId || a.pages.some((p) => p.tables[id]) || b.pages.some((p) => p.tables[id]);
  const shown = all ? rows : rows.filter((r) => changed(r) || isTable(r.id));
  const dA = a.diagnostics.length, dB = b.diagnostics.length;
  return (
    <div className="ps-compare" data-testid="compare-summary">
      <div className="ps-cmp-cards">
        <div className="ps-cmp-card"><span className="lbl">A · Current</span><strong>{a.pageCount} pages</strong><small>{labelA}</small><small>PDF counted {a.pdfPageCount ?? '—'} · {dA} diagnostics</small></div>
        <div className="ps-cmp-arrow" aria-hidden="true"><Icon.chevron /></div>
        <div className="ps-cmp-card"><span className="lbl">B · Compared</span><strong>{b.pageCount} pages</strong><small>{labelB}</small><small>PDF counted {b.pdfPageCount ?? '—'} · {dB} diagnostics</small></div>
      </div>
      <table className="table ps-cmp-table">
        <caption className="sr-only">Components by node id, with the pages they occupy in each composition</caption>
        <thead><tr><th>Node</th><th>A pages</th><th>B pages</th><th>Table rows A / B</th><th>Moved</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className={changed(r) ? 'selected' : ''}>
              <td title={r.id}>{nm(r.id)}</td><td>{pageSpan(r.pa)}</td><td>{pageSpan(r.pb)}</td>
              <td>{isTable(r.id) ? `${tableRowsTotal(a, r.id)} / ${tableRowsTotal(b, r.id)}` : '—'}</td>
              <td>{changed(r) ? <span className="chip warning">differs</span> : 'same'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAll(!all)}>{all ? 'Show changed and table nodes only' : `Show all ${rows.length} nodes`} · {rows.filter(changed).length} differ</button>
    </div>
  );
}
