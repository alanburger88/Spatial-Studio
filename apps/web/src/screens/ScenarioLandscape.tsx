import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { buildLandscape, dimensionValue, journeyStates, OUTPUT_PROFILES, primaryVariantSet, type DimensionId, type LandscapeCluster } from '@iss/scenarios';
import { ScreenHeader, Loading, Empty, Tech } from '../ui/common';
import { recordSummary } from '../shell/RecordPicker';
import { Icon } from '../ui/icons';
import { nodeTitle, ruleTitle as plainRuleTitle } from '../ui/plain';
import { useStudio, useScenarioEngine } from '../state/store';
import './ScenarioLandscape.css';

const SEV_ICON = { ok: '✓', warning: '▲', blocking: '■' } as const;
const SEV_TEXT = { ok: 'No findings', warning: 'Warnings', blocking: 'Blocking' } as const;
const MAX_D = 96, MIN_D = 40;

type View = 'flat' | '2.5d';
type Metric = 'ruleComplexity' | 'exceptionCount';
const VIEW_KEY = 'iss.landscapeView';
const readView = (): View => { try { return localStorage.getItem(VIEW_KEY) === '2.5d' ? '2.5d' : 'flat'; } catch { return 'flat'; } };
/** Mean page count would require composing every scenario's PDF, so it is deliberately not offered. */
const METRIC_LABEL: Record<Metric, string> = { ruleComplexity: 'Rule complexity', exceptionCount: 'Exception count' };
const METRIC_HELP: Record<Metric, string> = {
  ruleComplexity: 'distinct rules matched by the cluster’s synthetic scenarios',
  exceptionCount: 'warning and blocking findings across the cluster’s synthetic scenarios',
};
/** 2.5D geometry (px). Oblique projection: things further back (higher on screen) shift right by SKEW per px. */
const GUTTER = 132, HEAD_H = 40, ROW_H = 106, SKEW = 0.18, MIN_COL_W = 96, STALK_MAX = 32;

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(n / d < 0.1 ? 1 : 0)}%` : '0%');
const humanCode = (c: string) => { const t = c.replace(/[-_.]+/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };

export function ScenarioLandscape() {
  const { project: projectId } = useParams();
  const navigate = useNavigate();
  const project = useStudio((s) => s.project);
  const profileId = useStudio((s) => s.ctx.profileId);
  const technical = useStudio((s) => s.viewMode) === 'technical';
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const engine = useScenarioEngine();

  const [includeJourney, setIncludeJourney] = useState(false);
  const [filters, setFilters] = useState<Partial<Record<DimensionId, string>>>({});
  const [defectsOnly, setDefectsOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View>(readView);
  const [metric, setMetric] = useState<Metric>('ruleComplexity');
  const [planeEl, setPlaneEl] = useState<HTMLDivElement | null>(null);
  const [planeW, setPlaneW] = useState(900);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };
  useEffect(() => {
    if (!planeEl) return;
    const measure = () => setPlaneW(planeEl.clientWidth);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(planeEl);
    return () => ro.disconnect();
  }, [planeEl]);
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const facetDims = useMemo<Array<{ dim: DimensionId; label: string }>>(() => {
    if (!project) return [];
    return project.documentType === 'eob'
      ? [{ dim: 'claimStatus', label: 'Claim status' }, { dim: 'networkStatus', label: 'Network' }, { dim: 'language', label: 'Language' }]
      : [{ dim: 'persona', label: 'Persona' }, { dim: 'paymentStatus', label: 'Payment' }, { dim: 'language', label: 'Language' }, { dim: 'accountTier', label: 'Tier' }];
  }, [project]);

  const facetOptions = useMemo(() => {
    const out: Record<string, Array<{ key: string; label: string }>> = {};
    if (!engine || !project) return out;
    const base = engine.universe();
    for (const f of facetDims) {
      const seen = new Map<string, string>();
      for (const s of base) { const v = dimensionValue(f.dim, s, engine.resolveScenario(s), project); if (!seen.has(v.key)) seen.set(v.key, v.label); }
      out[f.dim] = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true })).map(([key, label]) => ({ key, label }));
    }
    return out;
  }, [engine, project, facetDims]);

  const landscape = useMemo(() => (engine ? buildLandscape(engine, { includeJourney, profileId, filters }) : null), [engine, includeJourney, profileId, filters]);

  if (!project || !engine || !landscape) return <section className="screen" data-testid="landscape-view"><Loading label="Resolving scenario clusters…" /></section>;

  const pvs = primaryVariantSet(project);
  const all = landscape.clusters;
  const hasDefects = (c: LandscapeCluster) => c.blockingScenarios + c.warningScenarios > 0;
  const visible = defectsOnly ? all.filter(hasDefects) : all;
  const sum = all.reduce((s, c) => s + c.count, 0);
  const reconciled = landscape.reconciles && sum === landscape.evaluated;
  const maxCount = Math.max(1, ...visible.map((c) => c.count));
  const defectClusters = all.filter(hasDefects).length;
  const outputLabel = OUTPUT_PROFILES.find((o) => o.id === profileId)?.label ?? profileId;
  const journeyN = journeyStates(project).length;
  const base = `/studio/${projectId ?? project.projectId}`;

  /** Business: plain names of the selected variant and sections; Technical: the engine's raw signature label. */
  const variantName = (v: string | null | undefined) => (!v || v === 'unresolved' ? 'No variant selected' : nodeTitle(project, v));
  const plainLabel = (c: LandscapeCluster) => [variantName(pvs ? c.signature.variants[pvs] : null), ...c.signature.sections.map((x) => nodeTitle(project, x))].join(' + ');
  const labelOf = (c: LandscapeCluster) => (technical ? c.label : plainLabel(c));
  const extrasOf = (c: LandscapeCluster) => (c.signature.sections.length ? c.signature.sections.map((x) => (technical ? x : nodeTitle(project, x))).join(' + ') : 'Standard');
  const outputOf = (id: string) => OUTPUT_PROFILES.find((o) => o.id === id)?.label ?? id;

  const groupOf = (c: LandscapeCluster) => (pvs ? c.signature.variants[pvs] ?? 'unresolved' : 'all');
  const groups = [...new Set(visible.map(groupOf))].map((g) => ({ id: g, name: pvs ? (technical ? g : variantName(g)) : 'All clusters', items: visible.filter((c) => groupOf(c) === g) }));
  // Default selection (local state): first cluster with blocking findings, else the largest. Re-evaluated whenever the selection leaves the visible set.
  const ordered = groups.flatMap((g) => g.items);
  const defaultCluster = ordered.find((c) => c.blockingScenarios > 0) ?? [...ordered].sort((a, b) => b.count - a.count)[0] ?? null;
  const selected = visible.find((c) => c.clusterId === selectedId) ?? defaultCluster;
  const selId = selected?.clusterId ?? null;
  const recLabel = (id: string) => { const r = records.find((x) => x.recordId === id); return r ? recordSummary(r, personas) : null; };
  /** Rules cell: Business shows the first rule's plain title + number chip + "+N more"; Technical keeps compact number chips. */
  const rulesCell = (ids: string[]) => {
    if (ids.length === 0) return <span className="muted">None</span>;
    const full = ids.map((r) => `${ruleTitleOf(r)} (${r})`).join('\n');
    if (technical) return <span title={full}>{ids.slice(0, 4).map((r) => <span className="chip code" key={r} title={ruleTitleOf(r)}>{r}</span>)}{ids.length > 4 && <span className="muted"> +{ids.length - 4}</span>}</span>;
    return <span className="ls-rule1" title={full}><span>{ruleTitleOf(ids[0])}</span> <span className="chip code">{ids[0]}</span>{ids.length > 1 && <span className="muted"> +{ids.length - 1} more</span>}</span>;
  };
  const ruleTitleOf = (id: string) => { const r = project.rules.find((x) => x.id === id); return r ? plainRuleTitle(project, r) : id; };

  const adoptScenario = (c: LandscapeCluster) => {
    const st = useStudio.getState();
    st.setRecord(c.representative.recordId);
    st.setJourneyCursor(c.representative.journeyCursor);
    st.setProfile(c.representative.profileId);
  };
  const openScenario = (c: LandscapeCluster) => { adoptScenario(c); navigate(`${base}/design`); };
  const openExploded = (c: LandscapeCluster) => { adoptScenario(c); navigate(`${base}/exploded${pvs ? `/${pvs}` : ''}`); };
  const openValidate = (c: LandscapeCluster) => { adoptScenario(c); navigate(`${base}/validate`); };

  const diam = (c: LandscapeCluster) => Math.max(MIN_D, MAX_D * Math.sqrt(c.count / maxCount));

  const showTip = (c: LandscapeCluster, el: HTMLElement) => {
    setHoverId(c.clusterId);
    const s = chartRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (s) { const above = r.top - s.top; setTip({ x: Math.max(110, Math.min(s.width - 110, r.left - s.left + r.width / 2)), y: above > 130 ? above : r.bottom - s.top, below: above <= 130 }); }
  };
  const hideTip = () => { setHoverId(null); setTip(null); };
  const hovered = all.find((c) => c.clusterId === hoverId) ?? null;

  const setFilter = (dim: DimensionId, v: string) => { setFilters((f) => { const n = { ...f }; if (v) n[dim] = v; else delete n[dim]; return n; }); setSelectedId(null); };

  /* ------------------------------------------------------------ 2.5D plane */
  const metricVal = (c: LandscapeCluster) => c.metrics[metric];
  const maxMetric = Math.max(0, ...visible.map(metricVal));
  const colIds = groups.map((g) => g.id);
  const secKey = (c: LandscapeCluster) => JSON.stringify([Object.entries(c.signature.variants).filter(([k]) => k !== pvs).map(([, v]) => v ?? 'unresolved'), c.signature.sections, includeJourney ? c.signature.journey : '']);
  const secLabel = (c: LandscapeCluster) => {
    const bits = [
      ...Object.entries(c.signature.variants).filter(([k]) => k !== pvs).map(([k, v]) => (technical ? `${k}: ${v ?? 'unresolved'}` : variantName(v))),
      ...c.signature.sections.map((x) => (technical ? x : nodeTitle(project, x))),
      ...(includeJourney ? [c.signature.journey] : []),
    ];
    return bits.length ? bits.join(' + ') : 'Standard';
  };
  const rowDefs = [...new Map(visible.map((c) => [secKey(c), secLabel(c)])).entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
  const nCols = Math.max(1, colIds.length), nRows = Math.max(1, rowDefs.length);
  const planeH = HEAD_H + nRows * ROW_H + 10;
  const rightPad = Math.round(planeH * SKEW);
  const colW = Math.max(MIN_COL_W, (planeW - GUTTER - rightPad - 12) / nCols);
  const innerW = GUTTER + nCols * colW + rightPad + 12;
  /** Oblique projection x shift for a screen y. */
  const sx = (x: number, y: number) => x + (planeH - y) * SKEW;
  const maxD25 = Math.min(colW * 0.8, 88);
  const diam25 = (c: LandscapeCluster) => Math.max(34, maxD25 * Math.sqrt(c.count / maxCount));
  const stalk = (c: LandscapeCluster) => 6 + (maxMetric ? (metricVal(c) / maxMetric) * STALK_MAX : 0);
  const plane25 = (
    <div className="stage ls25-stage" aria-label="Scenario landscape, 2.5D view">
      <div className="ls25-legend" data-testid="landscape-legend">
        <div className="ls25-leg" title="Platform and bubble size grow with the number of synthetic scenarios in the cluster."><strong>Size</strong> platform and bubble = synthetic scenarios (largest {maxCount})</div>
        <div className="ls25-leg" data-testid="landscape-height-legend" title="Mean page count is not offered: it would require composing every scenario’s PDF."><strong>Height</strong> {METRIC_LABEL[metric].toLowerCase()}: {METRIC_HELP[metric]}, 0 to {maxMetric}</div>
        <div className="ls25-leg"><strong>Severity</strong> <span className="ls-sevkey ok">✓ none</span><span className="ls-sevkey warning">▲ warning</span><span className="ls-sevkey blocking">■ blocking</span></div>
        <div className="ls25-leg muted">Columns = {pvs ? (technical ? pvs : 'primary variant') : 'all clusters'}; rows = other variants, sections{includeJourney ? ' and journey state' : ''}.</div>
      </div>
      <div className="ls25-scroll" ref={setPlaneEl}>
        <div className="ls25-plane" data-testid="landscape-plane" role="group" aria-label="Scenario clusters on a tilted plane: columns are the primary variant, rows the secondary signature" style={{ width: innerW, height: planeH }}>
          <div className="ls25-floor" style={{ left: GUTTER, top: HEAD_H, width: nCols * colW, height: nRows * ROW_H, transform: `skewX(${-Math.atan(SKEW) * 180 / Math.PI}deg)`, transformOrigin: '0 100%' }}>
            {rowDefs.flatMap((_, r) => colIds.map((_c, ci) => <span key={`${r}-${ci}`} className="ls25-tile" style={{ left: ci * colW, top: r * ROW_H, width: colW, height: ROW_H }} />))}
          </div>
          {groups.map((g, ci) => (
            <div key={g.id} className={`ls25-colhead${technical ? ' mono' : ''}`} style={{ left: sx(GUTTER + ci * colW, HEAD_H - 2), width: colW }} title={`${g.name} · ${g.items.reduce((a, c) => a + c.count, 0)} synthetic scenarios`}>
              <strong>{g.name}</strong><span>{g.items.reduce((a, c) => a + c.count, 0)} synthetic</span>
            </div>
          ))}
          {rowDefs.map(([k, label], r) => (
            <div key={k} className="ls25-rowhead" style={{ top: HEAD_H + r * ROW_H, height: ROW_H, width: GUTTER - 10 }} title={label}><span>{label}</span></div>
          ))}
          {visible.map((c) => {
            const ci = Math.max(0, colIds.indexOf(groupOf(c))), ri = Math.max(0, rowDefs.findIndex(([k]) => k === secKey(c)));
            const D = diam25(c), H = stalk(c), B = Math.max(28, Math.min(44, D * 0.55));
            const cyBase = HEAD_H + ri * ROW_H + ROW_H - 14;
            const cx = sx(GUTTER + ci * colW + colW / 2, cyBase) - 2;
            const sel = selId === c.clusterId;
            return (
              <div key={c.clusterId} className={`ls25-node sev-${c.severity}${sel ? ' selected' : ''}`} style={{ left: cx, top: cyBase }}>
                <span className="ls25-platform" style={{ width: D, height: D * 0.4 }} aria-hidden="true" />
                <span className="ls25-stalk" style={{ height: H }} aria-hidden="true" />
                <button
                  className="ls25-bubble"
                  style={{ width: B, height: B, bottom: H }}
                  data-testid="landscape-cluster"
                  data-cluster={c.clusterId}
                  aria-pressed={sel}
                  aria-label={`${labelOf(c)}: ${c.count} synthetic scenarios, ${pct(c.count, landscape.universeSize)} of universe, ${SEV_TEXT[c.severity]}, ${METRIC_LABEL[metric]} ${metricVal(c)}`}
                  onClick={() => setSelectedId(c.clusterId)}
                  onMouseEnter={(ev) => showTip(c, ev.currentTarget)} onMouseLeave={hideTip}
                  onFocus={(ev) => showTip(c, ev.currentTarget)} onBlur={hideTip}
                >
                  <span className="ls25-n" style={{ fontSize: Math.max(13, Math.min(20, B * 0.4)) }}>{c.count}</span>
                  <span className="ls-sevicon" aria-hidden="true">{SEV_ICON[c.severity]}</span>
                </button>
                <span className="ls25-mval" style={{ bottom: H + B / 2 - 7, marginLeft: B / 2 + 5 }} aria-hidden="true" title={`${METRIC_LABEL[metric]} ${metricVal(c)}`}>↑{metricVal(c)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <section className="screen" data-testid="landscape-view">
      <ScreenHeader
        id="S05"
        title="Scenario Landscape"
        subtitle="Outcome clusters from real resolution of seeded records: grouped by selected variants, visible sections, journey state and output."
      />
      <div className="screen-body ls-body">
        {/* ------------------------------------------------------------ chart + table */}
        <div className="ls-center">
          <div className="ls-filters" aria-label="Landscape filters">
            {facetDims.map((f) => (
              <div className="ls-field" key={f.dim}>
                <label htmlFor={`ls-f-${f.dim}`}>{f.label}</label>
                <select id={`ls-f-${f.dim}`} className="select" data-testid={`landscape-filter-${f.dim}`} value={filters[f.dim] ?? ''} onChange={(e) => setFilter(f.dim, e.target.value)}>
                  <option value="">All</option>
                  {(facetOptions[f.dim] ?? []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </div>
            ))}
            {Object.keys(filters).length > 0 && <button className="btn sm" onClick={() => { setFilters({}); setSelectedId(null); }}>Clear filters</button>}
          </div>

          <div className="ls-status" data-testid="landscape-coverage">
            <strong data-testid="landscape-evaluated">{landscape.evaluated} synthetic scenarios<Tech> evaluated / {landscape.plannedSize} planned</Tech></strong>
            <span className="ls-sep" aria-hidden="true">·</span>
            <span>{outputLabel}{profileId === 'paged-afp-sim' ? ' (simulation only)' : ''}</span>
            <span className="ls-sep" aria-hidden="true">·</span>
            <span className={`ls-recon ${reconciled ? 'ok' : 'bad'}`} data-testid="landscape-reconcile">
              {reconciled ? '✓' : '⚠'} Σ clusters = {sum}{reconciled ? ' reconciles' : ` does not match ${landscape.evaluated}`}
            </span>
            <Tech><span className="ls-basis" data-testid="landscape-count-basis" title={landscape.countBasis}>{landscape.countBasis}</span></Tech>
            <span className="ls-status-actions">
            <span className="ls-viewsw"><span className="ls-viewsw-l" id="ls-view-label">View</span>
              <span className="segmented" role="group" aria-labelledby="ls-view-label">
                <button aria-pressed={view === 'flat'} onClick={() => setView('flat')} data-testid="landscape-view-flat">Flat</button>
                <button aria-pressed={view === '2.5d'} onClick={() => setView('2.5d')} data-testid="landscape-view-25d">2.5D</button>
              </span>
            </span>
            <label className="ls-toggle" title={includeJourney ? `Adds ${journeyN - 1} generated journey positions per record (${journeyN} states × seeded records); these are generated combinations, not extra fixtures.` : 'Off: one baseline scenario per seeded record.'}>
              <input type="checkbox" checked={includeJourney} onChange={(e) => { setIncludeJourney(e.target.checked); setSelectedId(null); }} data-testid="landscape-include-journey" />
              <span>Include journey states</span>
            </label>
            <button className="btn sm ls-defects" aria-pressed={defectsOnly} onClick={() => { setDefectsOnly((v) => !v); setSelectedId(null); }} data-testid="landscape-show-defects" title={defectsOnly ? `Showing the ${visible.length} of ${all.length} clusters that have recorded findings.` : 'Show only clusters with at least one recorded warning or blocking finding.'}>
              <Icon.warning width={14} height={14} /> Defects only <span className="ls-defects-n">{defectClusters}</span>
            </button>
            </span>
          </div>

          <div className="panel ls-chart-panel" ref={chartRef}>
            <div className="panel-head">
              <span>Clusters by {pvs ? (technical ? pvs : 'selected variant') : 'outcome'}</span>
              {view === 'flat' && <span className="sub" data-testid="landscape-legend">Bubble size = synthetic scenarios (largest {maxCount})</span>}
              {view === '2.5d' && (
                <span className="ls-metric">
                  <span className="ls-viewsw-l" id="ls-metric-label">Height</span>
                  <span className="segmented" role="group" aria-labelledby="ls-metric-label" title="Mean page count is not offered: it would require composing every scenario’s PDF.">
                    {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => <button key={m} aria-pressed={metric === m} onClick={() => setMetric(m)} data-testid={`landscape-metric-${m}`}>{METRIC_LABEL[m]}</button>)}
                  </span>
                </span>
              )}
              <span className="right ls-sevkeys" aria-label="Severity colour key" hidden={view === '2.5d'}>
                <span className="ls-sevkey ok">✓ none</span><span className="ls-sevkey warning">▲ warning</span><span className="ls-sevkey blocking">■ blocking</span>
              </span>
            </div>
            {visible.length === 0 ? (
              <div className="ls-empty"><Empty title={defectsOnly ? 'No clusters with recorded findings' : 'No matching fixture'} message={defectsOnly ? 'Every cluster in the current selection resolves without warnings or blocking findings.' : 'The active filters leave no scenarios. Clear a filter to repopulate the landscape.'} /></div>
            ) : view === '2.5d' ? plane25 : (
              <div className="ls-chart" data-testid="landscape-chart" role="group" aria-label="Scenario clusters grouped by primary variant">
                {groups.map((g) => (
                  <section className="ls-group-card" key={g.id} aria-label={g.name} style={{ flex: `${g.items.length} 1 ${Math.max(190, g.items.length * 86)}px` }}>
                    <header className="ls-group-head">
                      <span className={`ls-group-name${technical ? ' mono' : ''}`} title={g.name}>{g.name}</span>
                      <span className="muted">{g.items.length} {g.items.length === 1 ? 'cluster' : 'clusters'} · {g.items.reduce((s, c) => s + c.count, 0)} scenarios</span>
                    </header>
                    <div className="ls-bubbles">
                      {g.items.map((c) => {
                        const d = diam(c), sel = selId === c.clusterId;
                        return (
                          <div className="ls-bubble-cell" key={c.clusterId} style={{ width: Math.max(d, 84) }}>
                            <button
                              className={`ls-bubble sev-${c.severity}${sel ? ' selected' : ''}`}
                              style={{ width: d, height: d }}
                              data-testid="landscape-cluster"
                              data-cluster={c.clusterId}
                              aria-pressed={sel}
                              aria-label={`${labelOf(c)}: ${c.count} scenarios, ${pct(c.count, landscape.universeSize)} of universe, ${SEV_TEXT[c.severity]}`}
                              onClick={() => setSelectedId(c.clusterId)}
                              onMouseEnter={(ev) => showTip(c, ev.currentTarget)}
                              onMouseLeave={hideTip}
                            >
                              <span className="ls-bn" style={{ fontSize: Math.max(14, Math.min(26, d * 0.3)) }}>{c.count}</span>
                              <span className="ls-sevicon" aria-hidden="true">{SEV_ICON[c.severity]}</span>
                            </button>
                            <span className={`ls-cap${technical ? ' mono' : ''}`} title={labelOf(c)}>{extrasOf(c)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {tip && hovered && (
              <div className={`ls-tip${tip.below ? ' below' : ''}`} role="tooltip" style={{ left: tip.x, top: tip.y }} data-testid="landscape-tooltip">
                <strong>{labelOf(hovered)}</strong>
                <dl>
                  <dt>Scenarios</dt><dd>{hovered.count} ({pct(hovered.count, landscape.universeSize)})</dd>
                  <dt>Severity</dt><dd>{SEV_ICON[hovered.severity]} {SEV_TEXT[hovered.severity]}</dd>
                  <dt>Blocking / warning</dt><dd>{hovered.blockingScenarios} / {hovered.warningScenarios}</dd>
                  <dt>{view === '2.5d' ? METRIC_LABEL[metric] : 'Rules matched'}</dt><dd>{view === '2.5d' ? metricVal(hovered) : hovered.metrics.ruleComplexity}</dd>
                </dl>
              </div>
            )}
          </div>

          <div className="panel ls-table-panel">
            <div className="panel-head">
              <span>Outcome clusters</span>
              <span className="sub">{visible.length} of {all.length} · keyboard alternative to the chart</span>
            </div>
            <div className="ls-table-scroll">
              <table className="table ls-table" data-testid="landscape-cluster-list">
                <caption className="sr-only">Scenario clusters grouped by primary variant with counts, share of the evaluated universe, severity, contributing rules and an open action</caption>
                <thead>
                  <tr><th scope="col">Cluster</th><th scope="col" className="num">Scenarios</th><th scope="col" className="num">Share</th><th scope="col">Severity</th><th scope="col">Rules</th><th scope="col"><span className="sr-only">Action</span></th></tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.id}>
                    <tr className="ls-group"><th colSpan={6} scope="colgroup"><span className={technical ? 'mono' : ''}>{g.name}</span><span className="muted"> · {g.items.length} {g.items.length === 1 ? 'cluster' : 'clusters'} · {g.items.reduce((s, c) => s + c.count, 0)} scenarios</span></th></tr>
                    {g.items.map((c) => (
                      <tr key={c.clusterId} className={selId === c.clusterId ? 'selected' : ''} onClick={() => setSelectedId(c.clusterId)} data-testid="landscape-row">
                        <td className="ls-name-td">
                          <button className="rowlink ls-rowlink" onClick={(e) => { e.stopPropagation(); setSelectedId(c.clusterId); }} aria-pressed={selId === c.clusterId} title={labelOf(c)}>{labelOf(c)}</button>
                          <span className="ls-sig">{c.signature.journey} · {outputOf(c.signature.output)}</span>
                        </td>
                        <td className="num"><strong>{c.count}</strong></td>
                        <td className="num">{pct(c.count, landscape.universeSize)}</td>
                        <td><span className={`ls-sev ${c.severity}`}><span aria-hidden="true">{SEV_ICON[c.severity]}</span> {SEV_TEXT[c.severity]}{hasDefects(c) ? ` (${c.blockingScenarios + c.warningScenarios})` : ''}</span></td>
                        <td className="ls-rules">{rulesCell(c.contributingRuleIds)}</td>
                        <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); openScenario(c); }} aria-label={`Open scenario for ${labelOf(c)}`} data-testid="landscape-open-row">Open</button></td>
                      </tr>
                    ))}
                  </tbody>
                ))}
                {groups.length === 0 && <tbody><tr><td colSpan={6} className="muted">{defectsOnly ? 'No clusters with recorded findings.' : 'No clusters match the active filters.'}</td></tr></tbody>}
              </table>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------ inspector */}
        <aside className="panel ls-inspector" aria-label="Selected cluster" data-testid="landscape-inspector" data-side="right" data-side-title="Outcome">
          <div className="panel-head">Selected outcome</div>
          <div className="panel-body">
            {!selected ? (
              <Empty title="No clusters to show" message="No scenario cluster matches the current filters." />
            ) : (
              <div className="ls-insp">
                <h2 className="ls-insp-title">{labelOf(selected)}</h2>
                <div className={`ls-sev big ${selected.severity}`}><span aria-hidden="true">{SEV_ICON[selected.severity]}</span> {SEV_TEXT[selected.severity]}</div>
                <div className="ls-insp-count">
                  <span className="ls-insp-num" data-testid="landscape-cluster-count">{selected.count}</span>
                  <span>scenarios · {pct(selected.count, landscape.universeSize)} of {landscape.universeSize}<br /><span className="muted">{selected.recordIds.length} distinct synthetic records</span></span>
                </div>
                <dl className="kv ls-kv">
                  <dt>Blocking scenarios</dt><dd>{selected.blockingScenarios}</dd>
                  <dt>Warning scenarios</dt><dd>{selected.warningScenarios}</dd>
                  <Tech><dt>Rule complexity</dt><dd>{selected.metrics.ruleComplexity}</dd>
                  <dt>Exceptions</dt><dd>{selected.metrics.exceptionCount}</dd>
                  <dt>Evaluated</dt><dd>{landscape.evaluated} / {landscape.plannedSize}</dd></Tech>
                </dl>

                <div className="section-title">Signature</div>
                <ul className="list-rows ls-plain">
                  {Object.entries(selected.signature.variants).map(([k, v]) => <li key={k}><span className="muted">{technical ? <span className="mono">{k}</span> : 'Variant'}</span> <span title={v ?? undefined}>{technical ? v ?? 'unresolved' : variantName(v)}</span></li>)}
                  {selected.signature.sections.length > 0 && <li><span className="muted">Sections</span> {selected.signature.sections.map((x) => <span key={x} title={x}>{technical ? x : nodeTitle(project, x)}</span>)}</li>}
                  <li><span className="muted">Journey</span> {selected.signature.journey}</li>
                  <li><span className="muted">Output</span> {outputOf(selected.signature.output)}{selected.signature.output === 'paged-afp-sim' && <> <span className="chip sim">SIMULATION ONLY</span></>}</li>
                </ul>

                <div className="section-title">Contributing rules</div>
                {selected.contributingRuleIds.length === 0 ? <p className="muted">None matched</p> : (
                  <ul className="list-rows ls-rulelist">{selected.contributingRuleIds.map((r) => <li key={r}><span>{ruleTitleOf(r)}</span><span className="chip code">{r}</span></li>)}</ul>
                )}

                <div className="section-title">Representative customers</div>
                <ul className="list-rows ls-plain">
                  {selected.recordIds.slice(0, 6).map((id) => { const s = recLabel(id); return <li key={id}><span title={id}>{s ? s.name : id}{s?.tag && <span className="muted"> · {s.tag}</span>}</span>{(technical || !s) && <span className="chip code">{id}</span>}</li>; })}
                  {selected.recordIds.length > 6 && <li className="muted">+{selected.recordIds.length - 6} more</li>}
                </ul>
                <p className="ls-hint">Representative scenario: {(() => { const id = selected.representative.recordId; const s = recLabel(id); return technical || !s ? <span className="chip code">{id}</span> : <span title={id}>{s.name}</span>; })()}</p>

                <div className="section-title">Issues</div>
                {Object.keys(selected.findingCodes).length === 0 ? <p className="muted">No blocking or warning findings.</p> : (
                  <ul className="list-rows ls-plain">{Object.entries(selected.findingCodes).sort((a, b) => b[1] - a[1]).map(([code, n]) => <li key={code}><span className={technical ? 'mono' : ''} title={code}>{technical ? code : humanCode(code)}</span> <span className="muted">×{n}</span></li>)}</ul>
                )}

                <Tech>
                  <div className="section-title">Positioning</div>
                  <p className="ls-hint" data-testid="landscape-positioning" style={{ marginTop: 0 }}>{view === '2.5d' ? 'In 2.5D: column = selected primary variant (variant-set order), row = secondary signature (other variants + visible sections' + (includeJourney ? ' + journey state' : '') + ', sorted by name); platform and bubble size = synthetic scenario count; stalk height = the chosen metric.' : landscape.positioning} This cluster: column {selected.position.col + 1}, flat row {selected.position.row + 1}.</p>
                </Tech>

                <div className="ls-actions">
                  <button className="btn primary" onClick={() => openScenario(selected)} data-testid="landscape-open-scenario">Open scenario</button>
                  <div className="row">
                    <button className="btn" onClick={() => openExploded(selected)} disabled={!pvs} data-testid="landscape-open-exploded">Open exploded component</button>
                  </div>
                  <button className="btn" onClick={() => openValidate(selected)} data-testid="landscape-show-in-validate">Show defects in Validate</button>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
