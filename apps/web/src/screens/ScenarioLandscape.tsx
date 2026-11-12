import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { buildLandscape, dimensionValue, journeyStates, OUTPUT_PROFILES, primaryVariantSet, type DimensionId, type LandscapeCluster } from '@iss/scenarios';
import { ScreenHeader, Loading, Empty } from '../ui/common';
import { Icon } from '../ui/icons';
import { useStudio, useScenarioEngine } from '../state/store';
import './ScenarioLandscape.css';

type Metric = 'ruleComplexity' | 'exceptionCount';
const METRIC_LABEL: Record<Metric, string> = { ruleComplexity: 'Rule complexity', exceptionCount: 'Exception count' };
const METRIC_HELP: Record<Metric, string> = {
  ruleComplexity: 'distinct rules that matched across the cluster',
  exceptionCount: 'warning and blocking findings across the cluster',
};
const SEV_ICON = { ok: '✓', warning: '▲', blocking: '■' } as const;
const SEV_TEXT = { ok: 'No findings', warning: 'Warnings', blocking: 'Blocking' } as const;
const PLANE_W = 600, PLANE_H = 270, PLANE_TILT = 54;

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(n / d < 0.1 ? 1 : 0)}%` : '0%');

export function ScenarioLandscape() {
  const { project: projectId } = useParams();
  const navigate = useNavigate();
  const project = useStudio((s) => s.project);
  const profileId = useStudio((s) => s.ctx.profileId);
  const engine = useScenarioEngine();

  const [includeJourney, setIncludeJourney] = useState(false);
  const [filters, setFilters] = useState<Partial<Record<DimensionId, string>>>({});
  const [defectsOnly, setDefectsOnly] = useState(false);
  const [metric, setMetric] = useState<Metric>('ruleComplexity');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; below: boolean } | null>(null);

  const facetDims = useMemo<Array<{ dim: DimensionId; label: string }>>(() => {
    if (!project) return [];
    return project.documentType === 'eob'
      ? [{ dim: 'claimStatus', label: 'Claim status' }, { dim: 'networkStatus', label: 'Network status' }, { dim: 'language', label: 'Language' }]
      : [{ dim: 'persona', label: 'Persona' }, { dim: 'paymentStatus', label: 'Payment status' }, { dim: 'language', label: 'Language' }, { dim: 'accountTier', label: 'Account tier' }];
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
  const selected = all.find((c) => c.clusterId === selectedId) ?? null;
  const sum = all.reduce((s, c) => s + c.count, 0);
  const maxCount = Math.max(1, ...visible.map((c) => c.count));
  const metricVal = (c: LandscapeCluster) => c.metrics[metric];
  const maxMetric = Math.max(0, ...visible.map(metricVal));
  const defectClusters = all.filter(hasDefects).length;
  const outputLabel = OUTPUT_PROFILES.find((o) => o.id === profileId)?.label ?? profileId;
  const journeyN = journeyStates(project).length;
  const base = `/studio/${projectId ?? project.projectId}`;

  const groupOf = (c: LandscapeCluster) => (pvs ? c.signature.variants[pvs] ?? 'unresolved' : 'all');
  const groups = [...new Set(visible.map(groupOf))].map((g) => ({ name: g, items: visible.filter((c) => groupOf(c) === g) }));

  const adoptScenario = (c: LandscapeCluster) => {
    const st = useStudio.getState();
    st.setRecord(c.representative.recordId);
    st.setJourneyCursor(c.representative.journeyCursor);
    st.setProfile(c.representative.profileId);
  };
  const openScenario = (c: LandscapeCluster) => { adoptScenario(c); navigate(`${base}/design`); };
  const openExploded = (c: LandscapeCluster) => { adoptScenario(c); navigate(`${base}/exploded${pvs ? `/${pvs}` : ''}`); };
  const openValidate = (c: LandscapeCluster) => { adoptScenario(c); navigate(`${base}/validate`); };

  // Plane geometry. Column/row come from the engine (column = primary variant, row = size rank). Tall columns wrap into
  // sub-columns of ROWS_PER_SUB so dense landscapes stay legible; the mapping is a pure function of (col, row).
  const ROWS_PER_SUB = 4;
  const colIds = [...new Set(visible.map((c) => c.position.col))].sort((a, b) => a - b);
  const subCols = new Map(colIds.map((col) => [col, Math.ceil((Math.max(...visible.filter((c) => c.position.col === col).map((c) => c.position.row)) + 1) / ROWS_PER_SUB)]));
  const totalSub = Math.max(1, [...subCols.values()].reduce((a, b) => a + b, 0));
  const subOffset = new Map<number, number>(); { let acc = 0; for (const col of colIds) { subOffset.set(col, acc); acc += subCols.get(col)!; } }
  const rowsShown = Math.max(1, Math.min(ROWS_PER_SUB, Math.max(0, ...visible.map((c) => c.position.row)) + 1));
  const cell = (c: LandscapeCluster) => ({
    x: (((subOffset.get(c.position.col) ?? 0) + Math.floor(c.position.row / ROWS_PER_SUB) + 0.5) / totalSub) * PLANE_W,
    y: (((c.position.row % ROWS_PER_SUB) + 0.5) / rowsShown) * PLANE_H,
  });
  const maxD = Math.max(56, Math.min(104, Math.min(PLANE_W / totalSub, (PLANE_H / rowsShown) * Math.sin((PLANE_TILT * Math.PI) / 180)) * 1.1));
  const diam = (c: LandscapeCluster) => Math.max(34, Math.min(maxD, (maxD / Math.sqrt(maxCount)) * Math.sqrt(c.count)));
  const elev = (c: LandscapeCluster) => Math.sin((PLANE_TILT * Math.PI) / 180) * (diam(c) / 2) + 22 + (maxMetric ? (metricVal(c) / maxMetric) * 54 : 0);

  const showTip = (c: LandscapeCluster, el: HTMLElement) => {
    setHoverId(c.clusterId);
    const s = stageRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (s) { const above = r.top - s.top; setTip({ x: Math.max(110, Math.min(s.width - 110, r.left - s.left + r.width / 2)), y: above > 150 ? above : r.bottom - s.top, below: above <= 150 }); }
  };
  const hideTip = () => { setHoverId(null); setTip(null); };
  const hovered = all.find((c) => c.clusterId === hoverId) ?? null;

  const setFilter = (dim: DimensionId, v: string) => { setFilters((f) => { const n = { ...f }; if (v) n[dim] = v; else delete n[dim]; return n; }); setSelectedId(null); };

  return (
    <section className="screen" data-testid="landscape-view">
      <ScreenHeader
        id="S05"
        title="Scenario Landscape"
        subtitle="Outcome clusters from real resolution of seeded records: grouped by selected variants, visible sections, journey state and output."
        badge={<span className="chip accent" data-testid="landscape-coverage-chip"><Icon.landscape width={13} height={13} /> {landscape.evaluated} evaluated / {landscape.plannedSize} planned</span>}
      />
      <div className="screen-body ls-body">
        {/* ------------------------------------------------------------ filters */}
        <aside className="panel ls-filters" aria-label="Landscape filters">
          <div className="panel-head">Landscape filters</div>
          <div className="panel-body">
            <button className="btn ls-defects" aria-pressed={defectsOnly} onClick={() => { setDefectsOnly((v) => !v); setSelectedId(null); }} data-testid="landscape-show-defects">
              <Icon.warning width={15} height={15} /> Show defects only
              <span className="ls-defects-n">{defectClusters}</span>
            </button>
            <p className="ls-hint">{defectsOnly ? `Showing the ${visible.length} of ${all.length} clusters that have recorded findings.` : 'Filter to clusters with at least one recorded warning or blocking finding.'}</p>

            <div className="section-title ls-sec">Scenario filters</div>
            {facetDims.map((f) => (
              <div className="field" key={f.dim}>
                <label htmlFor={`ls-f-${f.dim}`}>{f.label}</label>
                <select id={`ls-f-${f.dim}`} className="select" data-testid={`landscape-filter-${f.dim}`} value={filters[f.dim] ?? ''} onChange={(e) => setFilter(f.dim, e.target.value)}>
                  <option value="">All</option>
                  {(facetOptions[f.dim] ?? []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
              </div>
            ))}
            {Object.keys(filters).length > 0 && <button className="btn sm" onClick={() => { setFilters({}); setSelectedId(null); }}>Clear filters</button>}

            <div className="section-title ls-sec">Journey states</div>
            <label className="ls-toggle">
              <input type="checkbox" checked={includeJourney} onChange={(e) => { setIncludeJourney(e.target.checked); setSelectedId(null); }} data-testid="landscape-include-journey" />
              <span>Include journey states</span>
            </label>
            <p className="ls-hint">{includeJourney ? `Adds ${journeyN - 1} generated journey positions per record: ${journeyN} states × seeded records. These are generated combinations, not extra fixtures.` : 'Off: one baseline scenario per seeded record.'}</p>

            <div className="section-title ls-sec">Output target</div>
            <p className="ls-hint" style={{ marginTop: 0 }}>{outputLabel}{profileId === 'paged-afp-sim' ? ' (simulation only)' : ''}. Change it from the top bar.</p>
          </div>
        </aside>

        {/* ------------------------------------------------------------ stage + table */}
        <div className="ls-center">
          <div className="ls-coverage" data-testid="landscape-coverage">
            <div className="ls-cov-main">
              <strong data-testid="landscape-evaluated">{landscape.evaluated} scenarios evaluated / {landscape.plannedSize} planned</strong>
              <span className="ls-cov-bar" aria-hidden="true"><span style={{ width: `${landscape.plannedSize ? (landscape.evaluated / landscape.plannedSize) * 100 : 0}%` }} /></span>
              <span className={`ls-recon ${landscape.reconciles && sum === landscape.evaluated ? 'ok' : 'bad'}`} data-testid="landscape-reconcile">
                {landscape.reconciles && sum === landscape.evaluated ? '✓' : '⚠'} Σ clusters = {sum}{landscape.reconciles && sum === landscape.evaluated ? ' reconciles' : ` does not match ${landscape.evaluated}`}
              </span>
            </div>
            <div className="ls-cov-basis" data-testid="landscape-count-basis">{landscape.countBasis}. Synthetic scenario counts, not customer analytics.</div>
          </div>

          <div className="stage ls-stage" ref={stageRef} aria-label="Scenario landscape, 2.5D view">
            <div className="stage-grid" />
            <div className="stage-toolbar">
              <span className="chip">Cluster = resolved outcome signature</span>
              <span className="ls-metric">
                <span className="ls-metric-l" id="ls-metric-label">Height</span>
                <span className="segmented" role="group" aria-labelledby="ls-metric-label">
                  {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => <button key={m} aria-pressed={metric === m} onClick={() => setMetric(m)} data-testid={`landscape-metric-${m}`}>{METRIC_LABEL[m]}</button>)}
                </span>
              </span>
            </div>

            {visible.length === 0 ? (
              <div className="ls-empty"><Empty title={defectsOnly ? 'No clusters with recorded findings' : 'No matching fixture'} message={defectsOnly ? 'Every cluster in the current selection resolves without warnings or blocking findings.' : 'The active filters leave no scenarios. Clear a filter to repopulate the landscape.'} /></div>
            ) : (
              <div className="ls-viewport">
                <div className="ls-plane" style={{ width: PLANE_W, height: PLANE_H, transform: `rotateX(${PLANE_TILT}deg)` }} data-testid="landscape-plane">
                  <div className="ls-plane-grid" style={{ backgroundSize: `${PLANE_W / totalSub}px ${PLANE_H / rowsShown}px` }} />
                  {visible.map((c) => {
                    const p = cell(c), d = diam(c), e = elev(c);
                    const sel = selectedId === c.clusterId;
                    return (
                      <div key={c.clusterId} className={`ls-node sev-${c.severity}${sel ? ' selected' : ''}`} style={{ left: p.x, top: p.y }}>
                        <span className="ls-shadow" style={{ width: d, height: d }} />
                        <span className="ls-lift" style={{ transform: `translateZ(${e}px) rotateX(${-PLANE_TILT}deg)` }}>
                          <span className="ls-stem" style={{ height: e * Math.cos((PLANE_TILT * Math.PI) / 180) / Math.cos(0) * 1 }} />
                          <button
                            className="ls-bubble"
                            style={{ width: d, height: d }}
                            data-testid="landscape-cluster"
                            data-cluster={c.clusterId}
                            aria-pressed={sel}
                            aria-label={`${c.label}: ${c.count} scenarios, ${pct(c.count, landscape.universeSize)} of universe, ${SEV_TEXT[c.severity]}, ${METRIC_LABEL[metric]} ${metricVal(c)}`}
                            onClick={() => setSelectedId(c.clusterId)}
                            onMouseEnter={(ev) => showTip(c, ev.currentTarget)}
                            onMouseLeave={hideTip}
                            onFocus={(ev) => showTip(c, ev.currentTarget)}
                            onBlur={hideTip}
                          >
                            <span className="ls-bn" style={{ fontSize: Math.max(14, Math.min(24, d * 0.3)) }}>{c.count}</span>
                            <span className="ls-sevicon" aria-hidden="true">{SEV_ICON[c.severity]}</span>
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tip && hovered && (
              <div className={`ls-tip${tip.below ? ' below' : ''}`} role="tooltip" style={{ left: tip.x, top: tip.y }} data-testid="landscape-tooltip">
                <strong>{hovered.label}</strong>
                <dl>
                  <dt>Scenarios</dt><dd>{hovered.count} ({pct(hovered.count, landscape.universeSize)})</dd>
                  <dt>{METRIC_LABEL[metric]}</dt><dd>{metricVal(hovered)}</dd>
                  <dt>Severity</dt><dd>{SEV_ICON[hovered.severity]} {SEV_TEXT[hovered.severity]}</dd>
                  <dt>Blocking / warning</dt><dd>{hovered.blockingScenarios} / {hovered.warningScenarios}</dd>
                </dl>
              </div>
            )}

          </div>

          <div className="ls-legend" data-testid="landscape-legend">
              <div className="ls-leg-item" title="Bubble area is proportional to scenario count; the smallest bubbles keep a minimum size for legibility."><span className="ls-leg-title">Size</span> area ∝ scenarios (max {maxCount})</div>
              <div className="ls-leg-item" data-testid="landscape-height-legend"><span className="ls-leg-title">Height</span> {METRIC_LABEL[metric].toLowerCase()} ({METRIC_HELP[metric].replace('distinct rules that matched across the cluster','distinct rules matched').replace('warning and blocking findings across the cluster','findings')}), 0 to {maxMetric}</div>
              <div className="ls-leg-item">
                <span className="ls-leg-title">Severity</span>
                <span className="ls-sevkey ok">✓ none</span><span className="ls-sevkey warning">▲ warning</span><span className="ls-sevkey blocking">■ blocking</span>
              </div>
            </div>

          <div className="panel ls-table-panel">
            <div className="panel-head">
              <span>Outcome clusters</span>
              <span className="sub">{visible.length} of {all.length} clusters · grouped by selected {pvs ? 'primary variant' : 'outcome'} · keyboard alternative to the landscape</span>
            </div>
            <div className="ls-table-scroll">
              <table className="table ls-table" data-testid="landscape-cluster-list">
                <caption className="sr-only">Scenario clusters grouped by primary variant with counts, share of the evaluated universe, severity, contributing rules and an open action</caption>
                <thead>
                  <tr><th scope="col">Cluster signature</th><th scope="col" className="num">Scenarios</th><th scope="col" className="num">% of universe</th><th scope="col">Severity</th><th scope="col">Contributing rules</th><th scope="col"><span className="sr-only">Action</span></th></tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.name}>
                    <tr className="ls-group"><th colSpan={6} scope="colgroup"><span className="mono">{g.name}</span><span className="muted"> · {g.items.length} {g.items.length === 1 ? 'cluster' : 'clusters'} · {g.items.reduce((s, c) => s + c.count, 0)} scenarios</span></th></tr>
                    {g.items.map((c) => (
                      <tr key={c.clusterId} className={selectedId === c.clusterId ? 'selected' : ''} onClick={() => setSelectedId(c.clusterId)} data-testid="landscape-row">
                        <td>
                          <button className="rowlink ls-rowlink" onClick={(e) => { e.stopPropagation(); setSelectedId(c.clusterId); }} aria-pressed={selectedId === c.clusterId}>{c.label}</button>
                          <div className="ls-sig">{c.signature.journey} · {OUTPUT_PROFILES.find((o) => o.id === c.signature.output)?.label ?? c.signature.output}</div>
                        </td>
                        <td className="num"><strong>{c.count}</strong></td>
                        <td className="num">{pct(c.count, landscape.universeSize)}</td>
                        <td><span className={`ls-sev ${c.severity}`}><span aria-hidden="true">{SEV_ICON[c.severity]}</span> {SEV_TEXT[c.severity]}{hasDefects(c) ? ` (${c.blockingScenarios + c.warningScenarios})` : ''}</span></td>
                        <td className="ls-rules">{c.contributingRuleIds.slice(0, 5).map((r) => <span className="chip variant" key={r}>{r}</span>)}{c.contributingRuleIds.length > 5 && <span className="muted"> +{c.contributingRuleIds.length - 5}</span>}</td>
                        <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); openScenario(c); }} aria-label={`Open scenario for ${c.label}`} data-testid="landscape-open-row">Open</button></td>
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
        <aside className="panel ls-inspector" aria-label="Selected cluster" data-testid="landscape-inspector">
          <div className="panel-head">Selected outcome</div>
          <div className="panel-body">
            {!selected ? (
              <Empty title="Select a cluster" message="Choose a bubble or a table row to see the exact count, contributing rules, representative fixtures and issues." />
            ) : (
              <div className="ls-insp">
                <h2 className="ls-insp-title">{selected.label}</h2>
                <div className={`ls-sev big ${selected.severity}`}><span aria-hidden="true">{SEV_ICON[selected.severity]}</span> {SEV_TEXT[selected.severity]}</div>
                <div className="ls-insp-count">
                  <span className="ls-insp-num" data-testid="landscape-cluster-count">{selected.count}</span>
                  <span>scenarios · {pct(selected.count, landscape.universeSize)} of {landscape.universeSize}<br /><span className="muted">{selected.recordIds.length} distinct seeded records</span></span>
                </div>
                <dl className="kv ls-kv">
                  <dt>Rule complexity</dt><dd>{selected.metrics.ruleComplexity}</dd>
                  <dt>Exceptions</dt><dd>{selected.metrics.exceptionCount}</dd>
                  <dt>Blocking scenarios</dt><dd>{selected.blockingScenarios}</dd>
                  <dt>Warning scenarios</dt><dd>{selected.warningScenarios}</dd>
                  <dt>Evaluated</dt><dd>{landscape.evaluated} / {landscape.plannedSize}</dd>
                </dl>

                <div className="section-title">Signature</div>
                <ul className="ls-plain">
                  {Object.entries(selected.signature.variants).map(([k, v]) => <li key={k}><span className="muted mono">{k}</span> <span className="chip variant">{v ?? 'unresolved'}</span></li>)}
                  {selected.signature.sections.length > 0 && <li><span className="muted">Sections</span> {selected.signature.sections.map((x) => <span className="chip" key={x}>{x}</span>)}</li>}
                  <li><span className="muted">Journey</span> {selected.signature.journey}</li>
                  <li><span className="muted">Output</span> {OUTPUT_PROFILES.find((o) => o.id === selected.signature.output)?.label ?? selected.signature.output}{selected.signature.output === 'paged-afp-sim' && <> <span className="chip sim">SIMULATION ONLY</span></>}</li>
                </ul>

                <div className="section-title">Contributing rules</div>
                <div className="ls-chipwrap">{selected.contributingRuleIds.length ? selected.contributingRuleIds.map((r) => <span className="chip variant" key={r}>{r}</span>) : <span className="muted">None matched</span>}</div>

                <div className="section-title">Representative customers</div>
                <div className="ls-chipwrap">
                  {selected.recordIds.slice(0, 6).map((id) => <span className="chip mono" key={id}>{id}</span>)}
                  {selected.recordIds.length > 6 && <span className="muted">+{selected.recordIds.length - 6} more</span>}
                </div>
                <p className="ls-hint">Representative scenario: <span className="mono">{selected.representative.recordId}</span></p>

                <div className="section-title">Issue codes</div>
                {Object.keys(selected.findingCodes).length === 0 ? <p className="muted">No blocking or warning findings.</p> : (
                  <ul className="ls-plain">{Object.entries(selected.findingCodes).sort((a, b) => b[1] - a[1]).map(([code, n]) => <li key={code}><span className="mono">{code}</span> <span className="muted">×{n}</span></li>)}</ul>
                )}

                <div className="section-title">Positioning</div>
                <p className="ls-hint" data-testid="landscape-positioning" style={{ marginTop: 0 }}>{landscape.positioning} This cluster: column {selected.position.col + 1}, row {selected.position.row + 1}.</p>

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
