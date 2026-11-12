import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { buildCube, dimensionValue, DIMENSIONS, journeyStates, MAX_CATEGORIES_PER_AXIS, OUTPUT_PROFILES, type CubeCell, type CubeResult, type DimensionId } from '@iss/scenarios';
import { ScreenHeader, Loading, ErrorState, Empty, Tech } from '../ui/common';
import { nodeTitle, ruleTitle as plainRuleTitle } from '../ui/plain';
import { Icon } from '../ui/icons';
import { useStudio, useScenarioEngine } from '../state/store';
import './DocumentCube.css';

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;
const AXIS_TESTIDS = ['cube-axis-x', 'cube-axis-y', 'cube-axis-z'] as const;
/** Categorical outcome colours are CSS custom properties (--oc-0..7) defined in DocumentCube.css. */
const OUTCOME_COLORS = Array.from({ length: 8 }, (_, i) => `var(--oc-${i})`);
const VIEW_KEY = 'iss.cube.view';
type CubeView = 'grid' | '3d';
const readView = (): CubeView => { try { return localStorage.getItem(VIEW_KEY) === '3d' ? '3d' : 'grid'; } catch { return 'grid'; } };
const LETTERS = 'ABCDEFGH';
const DEFAULT_YAW = -32;
const DEFAULT_TILT = -20;
const SEP = '␟';
/** Short tick label: "Day 45 · Assistance requested" -> "D45"; long names are cut with an ellipsis (full text stays in the title tooltip). */
const shortLabel = (l: string, max = 12) => { const m = /^Day (\d+)\b/.exec(l); if (m) return `D${m[1]}`; return l.length > max ? `${l.slice(0, max - 1).trimEnd()}…` : l; };
const humanCode = (c: string) => { const t = c.replace(/[-_.]+/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };

type SortKey = 'x' | 'y' | 'z' | 'count' | 'outcome' | 'issues';

const cellKey = (c: { x: string; y: string; z: string }) => [c.x, c.y, c.z].join(SEP);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** z' component of a face normal after the world rotation; > 0 means the face points at the viewer. */
function facingViewer(normal: [number, number, number], yawDeg: number, tiltDeg: number): boolean {
  const y = (yawDeg * Math.PI) / 180, t = (tiltDeg * Math.PI) / 180;
  const [nx, ny, nz] = normal;
  // world = rotateX(tilt) rotateY(yaw): apply Ry first, then Rx
  const z1 = -nx * Math.sin(y) + nz * Math.cos(y);
  const y1 = ny;
  const z2 = y1 * Math.sin(t) + z1 * Math.cos(t);
  return z2 > 0.02;
}

export function DocumentCube() {
  const { project: projectId } = useParams();
  const navigate = useNavigate();
  const project = useStudio((s) => s.project);
  const axes = useStudio((s) => s.ctx.cubeAxes);
  const filters = useStudio((s) => s.ctx.spatialFilters);
  const journeyCursor = useStudio((s) => s.ctx.journeyCursor);
  const profileId = useStudio((s) => s.ctx.profileId);
  const setCtx = useStudio((s) => s.setCtx);
  const viewMode = useStudio((s) => s.viewMode);
  const engine = useScenarioEngine();

  const [offsets, setOffsets] = useState<[number, number, number]>([0, 0, 0]);
  const [axisMsg, setAxisMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [yaw, setYaw] = useState(DEFAULT_YAW);
  const [tilt, setTilt] = useState(DEFAULT_TILT);
  const [zSlice, setZSlice] = useState<string | null>(null);
  const [hideFront, setHideFront] = useState(false);
  const [showEmpty, setShowEmpty] = useState(true);
  const [view, setViewState] = useState<CubeView>(readView);
  const [yKey, setYKey] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'count', dir: -1 });

  const docType = project?.documentType ?? 'credit-statement';
  const validDims = useMemo(() => DIMENSIONS.filter((d) => d.documentTypes.includes(docType)), [docType]);

  const cubeAxes = useMemo<[DimensionId, DimensionId, DimensionId]>(() => (axes.every((a) => validDims.some((d) => d.id === a)) ? axes : ['persona', 'output', 'journey']) as [DimensionId, DimensionId, DimensionId], [axes, validDims]);

  const cube: CubeResult | null = useMemo(() => {
    if (!engine) return null;
    try { return buildCube(engine, cubeAxes, { offsets, filters, journeyCursor, profileId }); } catch { return null; }
  }, [engine, cubeAxes, offsets, filters, journeyCursor, profileId]);

  // Filter facets: every valid dimension not currently on an axis. Options come from resolved scenarios, never invented.
  const facets = useMemo(() => {
    if (!engine || !project) return [];
    const out: Array<{ dim: DimensionId; label: string; options: Array<{ key: string; label: string }> }> = [];
    for (const d of validDims) {
      if (cubeAxes.includes(d.id)) continue;
      let options: Array<{ key: string; label: string }> = [];
      if (d.id === 'journey') options = journeyStates(project).map((j) => ({ key: String(j.cursor ?? 'baseline'), label: j.label }));
      else if (d.id === 'output') options = OUTPUT_PROFILES.map((o) => ({ key: o.id, label: o.label }));
      else {
        const seen = new Map<string, string>();
        for (const s of engine.universe()) { const v = dimensionValue(d.id, s, engine.resolveScenario(s), project); if (!seen.has(v.key)) seen.set(v.key, v.label); }
        options = [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([key, label]) => ({ key, label }));
      }
      out.push({ dim: d.id, label: d.label, options });
    }
    return out;
  }, [engine, project, validDims, cubeAxes]);

  const cellsByKey = useMemo(() => new Map((cube?.cells ?? []).map((c) => [cellKey(c), c])), [cube]);
  const selectedCell: CubeCell | null = selected ? cellsByKey.get(selected) ?? null : null;

  useEffect(() => { if (selected && !cellsByKey.has(selected)) setSelected(null); }, [selected, cellsByKey]);
  useEffect(() => { if (zSlice && cube && !cube.axes[2].categories.some((c) => c.key === zSlice)) setZSlice(null); }, [zSlice, cube]);

  const outcomeIndex = useMemo(() => {
    const names = [...new Set((cube?.cells ?? []).flatMap((c) => Object.keys(c.outcomes)))].sort();
    return new Map(names.map((n, i) => [n, i]));
  }, [cube]);
  const outcomeStyle = (o: string | null) => {
    const i = o ? outcomeIndex.get(o) ?? 0 : 0;
    return { color: OUTCOME_COLORS[i % OUTCOME_COLORS.length], letter: o ? LETTERS[i % LETTERS.length] : '–' };
  };
  const setView = (v: CubeView) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };
  /** Business: plain outcome name (nodeTitle). Technical: the raw variant id. */
  const outcomeName = (o: string | null): string => {
    if (!o) return '';
    if (viewMode === 'technical') return o;
    if (o === 'unresolved') return 'No variant selected';
    if (o === 'n/a') return 'n/a';
    return project ? nodeTitle(project, o) : o;
  };
  const activeY = cube && cube.axes[1].categories.some((k) => k.key === yKey) ? yKey! : cube?.axes[1].categories[0]?.key ?? '';

  if (!project || !engine) return <section className="screen" data-testid="cube-view"><Loading label="Preparing scenario engine…" /></section>;

  const changeAxis = (idx: number, dim: DimensionId) => {
    const clash = cubeAxes.findIndex((a, i) => a === dim && i !== idx);
    if (clash >= 0) {
      setAxisMsg(`${validDims.find((d) => d.id === dim)?.label} is already on the ${AXIS_NAMES[clash]} axis. Each dimension can be used on one axis only; change the ${AXIS_NAMES[clash]} axis first. No change was applied.`);
      return;
    }
    setAxisMsg(null);
    const next = [...cubeAxes] as [DimensionId, DimensionId, DimensionId];
    next[idx] = dim;
    const nextFilters = { ...filters }; delete nextFilters[dim];
    setCtx({ cubeAxes: next, spatialFilters: nextFilters });
    setOffsets((o) => { const n = [...o] as [number, number, number]; n[idx] = 0; return n; });
    setSelected(null); setZSlice(null); setYKey(null);
  };
  const setFilter = (dim: DimensionId, value: string) => {
    const next = { ...filters };
    if (value) next[dim] = value; else delete next[dim];
    setCtx({ spatialFilters: next });
    setOffsets([0, 0, 0]); setSelected(null);
  };
  const page = (idx: number, dir: -1 | 1) => setOffsets((o) => {
    const n = [...o] as [number, number, number];
    const total = cube?.axes[idx].totalCategories ?? 0;
    n[idx] = clamp(n[idx] + dir * MAX_CATEGORIES_PER_AXIS, 0, Math.max(0, total - MAX_CATEGORIES_PER_AXIS));
    return n;
  });

  const openScenario = (cell: CubeCell, then: 'design' | 'exploded' | 'outputs', recordId?: string) => {
    const sc = (recordId ? cell.scenarios.find((s) => s.recordId === recordId) : null) ?? cell.representative;
    if (!sc) return;
    const st = useStudio.getState();
    st.setRecord(sc.recordId);
    st.setJourneyCursor(sc.journeyCursor);
    st.setProfile(sc.profileId);
    const base = `/studio/${projectId ?? project.projectId}`;
    navigate(then === 'design' ? `${base}/design` : then === 'outputs' ? `${base}/outputs` : `${base}/exploded${cube?.primaryVariantSet ? `/${cube.primaryVariantSet}` : ''}`);
  };

  const issuesOf = (c: CubeCell) => c.blocking + c.warnings;
  const rows = (() => {
    const list = (cube?.cells ?? []).filter((c) => showEmpty || c.count > 0);
    const val = (c: CubeCell): string | number => sort.key === 'count' ? c.count : sort.key === 'issues' ? c.blocking * 1000 + c.warnings : sort.key === 'outcome' ? c.dominantOutcome ?? '' : sort.key === 'x' ? cube!.axes[0].categories.findIndex((k) => k.key === c.x) : sort.key === 'y' ? cube!.axes[1].categories.findIndex((k) => k.key === c.y) : cube!.axes[2].categories.findIndex((k) => k.key === c.z);
    return [...list].sort((a, b) => { const va = val(a), vb = val(b); const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb)); return (r || cellKey(a).localeCompare(cellKey(b))) * sort.dir; });
  })();

  const labelOf = (ai: number, key: string) => cube?.axes[ai].categories.find((c) => c.key === key)?.label ?? key;

  const nonEmpty = (cube?.cells ?? []).filter((c) => c.count > 0).length;
  const total = (cube?.cells ?? []).length;

  return (
    <section className="screen" data-testid="cube-view">
      <ScreenHeader
        id="S04"
        title="Document Cube"
        subtitle="Choose three independent dimensions and inspect populated or empty intersections. Every cell is a real resolution of seeded records."
      />
      <div className="screen-body cube-body">
        {/* ---------------------------------------------------------------- config + view */}
        <div className="cube-center">
          <div className="cube-config" aria-label="Cube dimensions">
            {AXIS_NAMES.map((n, i) => {
              const ax = cube?.axes[i];
              return (
                <div className="cube-axis-field" key={n}>
                  <label htmlFor={`cube-ax-${n}`}><span className={`cube-axis-dot ax-${n.toLowerCase()}`} />{n} axis</label>
                  <select id={`cube-ax-${n}`} className="select" data-testid={AXIS_TESTIDS[i]} value={cubeAxes[i]} onChange={(e) => changeAxis(i, e.target.value as DimensionId)} aria-describedby={axisMsg ? 'cube-axis-msg' : undefined}>
                    {validDims.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                  {ax && (
                    <span className="cube-pager" data-testid={`cube-pager-${n.toLowerCase()}`} title={`At most ${MAX_CATEGORIES_PER_AXIS} categories are shown per axis; page or filter to see the rest.`}>
                      <span>{ax.categories.length ? ax.offset + 1 : 0}–{ax.offset + ax.categories.length} of {ax.totalCategories}</span>
                      {ax.totalCategories > MAX_CATEGORIES_PER_AXIS && (
                        <span className="cube-pager-btns">
                          <button className="btn sm icon ghost" aria-label={`${n} axis: previous categories`} disabled={ax.offset === 0} onClick={() => page(i, -1)}><Icon.chevron style={{ transform: 'rotate(180deg)' }} /></button>
                          <button className="btn sm icon ghost" aria-label={`${n} axis: next categories`} disabled={ax.offset + MAX_CATEGORIES_PER_AXIS >= ax.totalCategories} onClick={() => page(i, 1)}><Icon.chevron /></button>
                        </span>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {axisMsg && <div className="callout warning" id="cube-axis-msg" role="alert" data-testid="cube-axis-error">{axisMsg}</div>}

          <div className="cube-viewbar" data-testid="cube-coverage">
            <span className="segmented" role="group" aria-label="Cube view">
              <button aria-pressed={view === 'grid'} onClick={() => setView('grid')} data-testid="cube-view-grid">Grid</button>
              <button aria-pressed={view === '3d'} onClick={() => setView('3d')} data-testid="cube-view-3d">Explore in 3D</button>
            </span>
            {cube && <span className="cube-status">{cube.universeSize} scenarios · {nonEmpty} of {total} intersections populated<Tech> · {cube.universeSize} evaluated / {cube.plannedSize} planned</Tech></span>}
          <details className="cube-filters">
            <summary className="btn sm" data-testid="cube-filters-toggle">Filters{Object.keys(filters).length > 0 ? ` (${Object.keys(filters).length})` : ''}</summary>
            <div className="cube-filters-pop">
              {facets.map((f) => (
                <div className="field" key={f.dim}>
                  <label htmlFor={`cube-f-${f.dim}`}>{f.label}</label>
                  <select id={`cube-f-${f.dim}`} className="select" data-testid={`cube-filter-${f.dim}`} value={filters[f.dim] ?? ''} onChange={(e) => setFilter(f.dim, e.target.value)}>
                    <option value="">All</option>
                    {f.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </div>
              ))}
              {Object.keys(filters).length > 0 && <button className="btn sm" onClick={() => { setCtx({ spatialFilters: {} }); setSelected(null); }}>Clear filters</button>}
            </div>
          </details>
          </div>

          {cube && cube.errors.length === 0 && cube.universeSize > 0 && (
            <div className="cube-legend-bar" data-testid="cube-legend" aria-label="Outcome legend">
                            {[...outcomeIndex.keys()].map((o) => { const st = outcomeStyle(o); return <span key={o} className="cube-leg-item" title={o}><span className="cube-mark" style={{ ['--mk' as string]: st.color }}>{st.letter}</span><span className={viewMode === 'technical' ? 'mono' : ''}>{outcomeName(o)}</span></span>; })}
              <span className="cube-leg-item"><span className="cube-badge" aria-hidden="true">!</span>Blocking</span>
              <span className="cube-leg-item"><span className="cube-mark none" aria-hidden="true">0</span>No records</span>
            </div>
          )}

          {cube && cube.errors.length > 0 && <div className="cube-msg"><ErrorState title="Invalid axis combination" message={cube.errors.join(' ')} /></div>}
          {cube && cube.errors.length === 0 && cube.universeSize === 0 && <div className="cube-msg"><Empty title="No matching fixture" message="The active filters leave no seeded records. Clear a filter to repopulate the cube." /></div>}

          {cube && cube.errors.length === 0 && cube.universeSize > 0 && view === 'grid' && (
            <CubeMatrix cube={cube} activeY={activeY} onY={setYKey} selected={selected} onSelect={(k) => setSelected(k)} outcomeStyle={outcomeStyle} outcomeName={outcomeName} />
          )}

          {cube && cube.errors.length === 0 && cube.universeSize > 0 && view === '3d' && (
            <>
              <div className="stage cube-stage" aria-label="Document cube, three-dimensional view">
                <div className="stage-grid" />
                <CubeScene cube={cube} yaw={yaw} tilt={tilt} zSlice={zSlice} hideFront={hideFront} selected={selected} onSelect={setSelected} outcomeStyle={outcomeStyle} />
              </div>
              <div className="cube-controls" role="group" aria-label="Cube view controls">
                <label className="cube-slider">Yaw<input type="range" min={-55} max={55} value={yaw} onChange={(e) => setYaw(+e.target.value)} aria-label="Rotate cube left or right" data-testid="cube-yaw" /><output>{yaw}°</output></label>
                <label className="cube-slider">Tilt<input type="range" min={-50} max={20} value={tilt} onChange={(e) => setTilt(+e.target.value)} aria-label="Tilt cube up or down" data-testid="cube-tilt" /><output>{tilt}°</output></label>
                <button className="btn sm" onClick={() => { setYaw(DEFAULT_YAW); setTilt(DEFAULT_TILT); }} data-testid="cube-reset-camera"><Icon.reset width={14} height={14} /> Reset camera</button>
                <label className="cube-slicer">Slice Z
                  <select className="select" value={zSlice ?? ''} onChange={(e) => setZSlice(e.target.value || null)} data-testid="cube-zslice" aria-label="Show a single Z layer or all layers">
                    <option value="">All layers</option>
                    {cube?.axes[2].categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
                <button className="btn sm" aria-pressed={hideFront} onClick={() => setHideFront((v) => !v)} data-testid="cube-hide-front">Hide front planes</button>
              </div>
            </>
          )}

          <div className="panel cube-table-panel">
            <div className="panel-head">
              <span>Intersections</span>
              <span className="sub">{nonEmpty} populated of {total} · keyboard alternative to the {view === 'grid' ? 'grid' : '3D view'}</span>
              <span className="right"><label className="cube-check"><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> Include empty</label></span>
            </div>
            <div className="cube-table-scroll">
              <table className="table cube-table" data-testid="cube-flat-table">
                <caption className="sr-only">Cube intersections: category labels, matching scenario count, dominant outcome and issues</caption>
                <thead>
                  <tr>
                    {([['x', cube?.axes[0].label ?? 'X'], ['y', cube?.axes[1].label ?? 'Y'], ['z', cube?.axes[2].label ?? 'Z'], ['count', 'Count'], ['outcome', 'Dominant outcome'], ['issues', 'Issues']] as Array<[SortKey, string]>).map(([k, l]) => (
                      <th key={k} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={k === 'count' ? 'num' : ''}>
                        <button className="cube-sort" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : k === 'count' || k === 'issues' ? -1 : 1 }))}>
                          {AXIS_NAMES[['x', 'y', 'z'].indexOf(k)] ? <span className="cube-th-ax">{k.toUpperCase()}</span> : null}{l}{sort.key === k ? <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span> : null}
                        </button>
                      </th>
                    ))}
                    <th><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const key = cellKey(c);
                    const st = outcomeStyle(c.dominantOutcome);
                    return (
                      <tr key={key} className={selected === key ? 'selected' : c.count === 0 ? 'cube-row-empty' : ''} onClick={() => { setSelected(key); setYKey(c.y); }} data-testid="cube-row">
                        <td title={labelOf(0, c.x)}>{labelOf(0, c.x)}</td><td title={labelOf(1, c.y)}>{labelOf(1, c.y)}</td><td title={labelOf(2, c.z)}>{labelOf(2, c.z)}</td>
                        <td className="num"><strong>{c.count}</strong></td>
                        <td>{c.count === 0 ? <span className="muted">No matching records</span> : <span className="cube-outcome-cell"><span className="cube-mark sm" style={{ ['--mk' as string]: st.color }}>{st.letter}</span><span className={viewMode === 'technical' ? 'mono' : ''}>{outcomeName(c.dominantOutcome)}</span>{c.simulationOnly && <span className="chip sim">SIMULATION ONLY</span>}</span>}</td>
                        <td>{c.blocking > 0 && <span className="chip error">■ {c.blocking} blocking</span>} {c.warnings > 0 && <span className="chip warning">▲ {c.warnings} warning</span>}{issuesOf(c) === 0 && <span className="muted">{c.count ? 'None' : '—'}</span>}</td>
                        <td><button className="btn sm" disabled={!c.representative} onClick={(e) => { e.stopPropagation(); setSelected(key); openScenario(c, 'design'); }} aria-label={`Open ${labelOf(0, c.x)}, ${labelOf(1, c.y)}, ${labelOf(2, c.z)}`}>Open</button></td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && <tr><td colSpan={7} className="muted">No intersections to display.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ---------------------------------------------------------------- inspector */}
        <aside className="panel cube-inspector" aria-label="Selected intersection" data-testid="cube-inspector">
          <div className="panel-head">Selected intersection</div>
          <div className="panel-body">
            {!selectedCell || !cube ? (
              <Empty title="Select a cell" message="Choose a cell in the grid, the 3D cube or a table row to see its matching fixtures, outcomes, rules and issues." />
            ) : (
              <Inspector cell={selectedCell} cube={cube} engineProject={project} engine={engine} outcomeStyle={outcomeStyle} outcomeName={outcomeName} onOpen={openScenario} />
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ scene */

type OutcomeStyleFn = (o: string | null) => { color: string; letter: string };

function CubeScene(props: { cube: CubeResult; yaw: number; tilt: number; zSlice: string | null; hideFront: boolean; selected: string | null; onSelect: (k: string) => void; outcomeStyle: OutcomeStyleFn }) {
  const { cube, yaw, tilt, zSlice, hideFront, selected, onSelect, outcomeStyle } = props;
  const [ax, ay, az] = cube.axes;
  const nx = Math.max(ax.categories.length, 1), ny = Math.max(ay.categories.length, 1), nz = Math.max(az.categories.length, 1);
  const P = 56; // grid pitch: one category = one equal step (discrete grid, not physical distance)
  const W = P * Math.max(nx, 3), H = P * Math.max(ny, 3) * 0.95, D = P * Math.max(nz, 3);
  const px = (i: number) => -W / 2 + (i + 0.5) * (W / nx);
  const py = (j: number) => H / 2 - (j + 0.5) * (H / ny);
  const zPos = (k: number) => D / 2 - (k + 0.5) * (D / nz); // index 0 nearest the viewer, ascending into depth

  const faces: Array<{ id: string; w: number; h: number; cols: number; rows: number; tf: string; normal: [number, number, number] }> = [
    { id: 'back', w: W, h: H, cols: nx, rows: ny, tf: `translateZ(${-D / 2}px)`, normal: [0, 0, -1] },
    { id: 'front', w: W, h: H, cols: nx, rows: ny, tf: `translateZ(${D / 2}px)`, normal: [0, 0, 1] },
    { id: 'left', w: D, h: H, cols: nz, rows: ny, tf: `rotateY(-90deg) translateZ(${W / 2}px)`, normal: [-1, 0, 0] },
    { id: 'right', w: D, h: H, cols: nz, rows: ny, tf: `rotateY(90deg) translateZ(${W / 2}px)`, normal: [1, 0, 0] },
    { id: 'top', w: W, h: D, cols: nx, rows: nz, tf: `rotateX(90deg) translateZ(${H / 2}px)`, normal: [0, -1, 0] },
    { id: 'bottom', w: W, h: D, cols: nx, rows: nz, tf: `rotateX(-90deg) translateZ(${H / 2}px)`, normal: [0, 1, 0] },
  ];
  const bb = (x: number, y: number, z: number, lift = 0) => `translate3d(${x}px, ${y}px, ${z}px) rotateY(${-yaw}deg) rotateX(${-tilt}deg) translateZ(${lift}px)`;
  const sliceZ = zSlice ? az.categories.findIndex((c) => c.key === zSlice) : -1;

  return (
    <div className="cube-viewport" style={{ perspective: 1600 }}>
      <div className="cube-world" style={{ transform: `rotateX(${tilt}deg) rotateY(${yaw}deg)` }} data-testid="cube-3d" aria-hidden="true">
        {faces.map((f) => {
          const front = facingViewer(f.normal, yaw, tilt);
          return <div key={f.id} className={`cube-face${front ? ' front' : ''}${hideFront && front ? ' hidden' : ''}`} style={{ width: f.w, height: f.h, margin: `${-f.h / 2}px 0 0 ${-f.w / 2}px`, backgroundSize: `${f.w / f.cols}px ${f.h / f.rows}px`, transform: f.tf }} />;
        })}
        {/* axis rails */}
        <div className="cube-rail ax-x" style={{ width: W, height: 3, transform: `translate3d(${-W / 2}px, ${H / 2 - 1}px, ${D / 2}px)` }} />
        <div className="cube-rail ax-y" style={{ width: 3, height: H, transform: `translate3d(${-W / 2 - 1}px, ${-H / 2}px, ${D / 2}px)` }} />
        <div className="cube-rail ax-z" style={{ width: D, height: 3, transform: `translate3d(${W / 2}px, ${H / 2 - 1}px, ${-D / 2}px) rotateY(-90deg)`, transformOrigin: '0 0' }} />
        {/* slicer sheet */}
        {sliceZ >= 0 && <div className="cube-sheet" style={{ width: W, height: H, margin: `${-H / 2}px 0 0 ${-W / 2}px`, transform: `translateZ(${zPos(sliceZ)}px)` }} />}

      </div>
      {/* Data layer: same camera as the frame, separate 3D context so wireframe planes can never slice the labels or cells. */}
      <div className="cube-world" style={{ transform: `rotateX(${tilt}deg) rotateY(${yaw}deg)` }} data-testid="cube-3d-data">
        {/* tick labels + axis titles (billboards, always facing the viewer) */}
        {ax.categories.map((c, i) => <div key={`tx${c.key}`} className="cube-tick tx" style={{ transform: bb(px(i), H / 2 + 24 + (nx > 3 && i % 2 ? 24 : 0), D / 2, 70) }} title={c.label}><span>{shortLabel(c.label)}</span></div>)}
        {ay.categories.map((c, j) => <div key={`ty${c.key}`} className="cube-tick ty" style={{ transform: bb(-W / 2 - 12, py(j), D / 2, 70) }} title={c.label}><span>{shortLabel(c.label, 14)}</span></div>)}
        {az.categories.map((c, k) => <div key={`tz${c.key}`} className={`cube-tick tz${sliceZ === k ? ' on' : ''}`} style={{ transform: bb(W / 2 + 14, H / 2 + 14, zPos(k), 70) }} title={c.label}><span>{shortLabel(c.label, 10)}</span></div>)}
        <div className="cube-axis-title ax-x" style={{ transform: bb(-W / 2 + 10, H / 2 + 104, D / 2, 70) }}>X · {ax.label} →</div>
        <div className="cube-axis-title ax-y" style={{ transform: bb(-W / 2 - 4, -H / 2 - 22, D / 2, 70) }}>↑ Y · {ay.label}</div>
        <div className="cube-axis-title ax-z" style={{ transform: bb(W / 2 + 6, H / 2 + 14, D / 2, 70) }}>Z · {az.label} (front → back)</div>

        {/* cells */}
        {cube.cells.map((c) => {
          const i = ax.categories.findIndex((k) => k.key === c.x), j = ay.categories.findIndex((k) => k.key === c.y), k = az.categories.findIndex((kk) => kk.key === c.z);
          const key = cellKey(c);
          const dimmed = sliceZ >= 0 && k !== sliceZ;
          const st = outcomeStyle(c.dominantOutcome);
          const label = `${ax.label} ${labelFor(ax, c.x)}, ${ay.label} ${labelFor(ay, c.y)}, ${az.label} ${labelFor(az, c.z)}: ${c.count === 0 ? 'no matching fixture' : `${c.count} scenarios, dominant outcome ${c.dominantOutcome}${c.blocking ? `, ${c.blocking} blocking` : ''}`}`;
          if (dimmed) return null;
          return (
            <div key={key} className="cube-cell-wrap" style={{ transform: bb(px(i), py(j), zPos(k), 4) }}>
              <button
                className={`cube-cell${c.count === 0 ? ' empty' : ''}${selected === key ? ' selected' : ''}`}
                style={{ ['--mk' as string]: st.color, ...(c.count > 0 ? { opacity: Math.max(0.66, 1 - 0.09 * k) } : {}) }}
                tabIndex={c.count === 0 ? -1 : 0}
                aria-label={label}
                aria-pressed={selected === key}
                title={label}
                data-testid={c.count === 0 ? 'cube-cell-empty' : 'cube-cell'}
                data-cell={key.split(SEP).join('|')}
                onClick={() => onSelect(key)}
              >
                {c.count === 0 ? <span className="cube-zero">·</span> : (<><span className="cube-mark sm">{st.letter}</span><span className="cube-count">{c.count}</span></>)}
                {c.blocking > 0 && <span className="cube-badge" aria-hidden="true">!</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const labelFor = (ax: CubeResult['axes'][number], key: string) => ax.categories.find((c) => c.key === key)?.label ?? key;

/* ------------------------------------------------------------------ matrix (default view) */

function CubeMatrix(props: { cube: CubeResult; activeY: string; onY: (k: string) => void; selected: string | null; onSelect: (k: string) => void; outcomeStyle: OutcomeStyleFn; outcomeName: (o: string | null) => string }) {
  const { cube, activeY, onY, selected, onSelect, outcomeStyle, outcomeName } = props;
  const [ax, ay, az] = cube.axes;
  const byKey = new Map(cube.cells.map((c) => [cellKey(c), c]));
  const yTotal = (k: string) => cube.cells.filter((c) => c.y === k).reduce((n, c) => n + c.count, 0);
  return (
    <div className="cube-matrix-wrap" data-testid="cube-matrix">
      <div className="cube-ytabs" role="tablist" aria-label={`${ay.label} (Y axis)`}>
        <span className="cube-ytabs-l"><span className="cube-axis-dot ax-y" />{ay.label}</span>
        {ay.categories.map((c) => (
          <button key={c.key} role="tab" aria-selected={c.key === activeY} className="cube-ytab" onClick={() => onY(c.key)} title={c.label} data-testid="cube-ytab">
            <span className="cube-ytab-t">{c.label}</span><span className="cube-ytab-n">{yTotal(c.key)}</span>
          </button>
        ))}
      </div>
      <div className="cube-matrix" role="grid" aria-label={`${ax.label} by ${az.label} for ${labelFor(ay, activeY)}`} style={{ gridTemplateColumns: `minmax(110px, 0.9fr) repeat(${Math.max(1, az.categories.length)}, minmax(0, 1fr))` }}>
        <div className="cube-mx-corner" role="presentation"><span><span className="cube-axis-dot ax-x" />{ax.label} ↓</span><span><span className="cube-axis-dot ax-z" />{az.label} →</span></div>
        {az.categories.map((z) => <div key={z.key} className="cube-mx-zh" role="columnheader" title={z.label}>{z.label}</div>)}
        {ax.categories.map((x) => (
          <div className="cube-mx-row" role="row" key={x.key}>
            <div className="cube-mx-xh" role="rowheader" title={x.label}>{x.label}</div>
            {az.categories.map((z) => {
              const key = [x.key, activeY, z.key].join(SEP);
              const c = byKey.get(key);
              if (!c) return <div key={z.key} className="cube-mx-cell empty" role="gridcell" />;
              const st = outcomeStyle(c.dominantOutcome);
              const label = `${ax.label} ${x.label}, ${ay.label} ${labelFor(ay, activeY)}, ${az.label} ${z.label}: ${c.count === 0 ? 'no matching records' : `${c.count} scenarios, dominant outcome ${outcomeName(c.dominantOutcome)}${c.blocking ? `, ${c.blocking} blocking` : ''}`}`;
              return (
                <div key={z.key} role="gridcell" className="cube-mx-gc">
                  <button
                    className={`cube-mx-cell${c.count === 0 ? ' empty' : ''}${selected === key ? ' selected' : ''}`}
                    style={{ ['--mk' as string]: st.color }}
                    aria-label={label} aria-pressed={selected === key} title={label}
                    data-testid={c.count === 0 ? 'cube-cell-empty' : 'cube-cell'}
                    data-cell={key.split(SEP).join('|')}
                    onClick={() => onSelect(key)}
                  >
                    {c.count === 0 ? <span className="cube-mx-none">no matching records</span> : (
                      <>
                        <span className="cube-mx-top"><strong className="cube-mx-n">{c.count}</strong>{c.blocking > 0 && <span className="cube-badge" aria-hidden="true">!</span>}</span>
                        <span className="cube-mx-oc"><span className="cube-mark sm">{st.letter}</span><span className="cube-mx-name">{outcomeName(c.dominantOutcome)}</span></span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- inspector */

function Inspector(props: { cell: CubeCell; cube: CubeResult; engineProject: NonNullable<ReturnType<typeof useStudio.getState>['project']>; engine: NonNullable<ReturnType<typeof useScenarioEngine>>; outcomeStyle: OutcomeStyleFn; outcomeName: (o: string | null) => string; onOpen: (c: CubeCell, then: 'design' | 'exploded' | 'outputs', recordId?: string) => void }) {
  const { cell, cube, engineProject, engine, outcomeStyle, outcomeName, onOpen } = props;
  const technical = useStudio((s) => s.viewMode) === 'technical';
  const labels = cube.axes.map((a, i) => ({ axis: AXIS_NAMES[i], dim: a.label, label: labelFor(a, [cell.x, cell.y, cell.z][i]) }));
  const detail = useMemo(() => {
    const rules = new Map<string, number>();
    const issues = new Map<string, { sev: string; n: number }>();
    for (const s of cell.scenarios) {
      const res = engine.resolveScenario(s);
      res.result.matchedRuleIds.forEach((r) => rules.set(r, (rules.get(r) ?? 0) + 1));
      for (const f of res.findings) { if (f.severity === 'info') continue; const e = issues.get(f.code) ?? { sev: f.severity, n: 0 }; e.n++; issues.set(f.code, e); }
    }
    return { rules: [...rules.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), issues: [...issues.entries()].sort((a, b) => b[1].n - a[1].n) };
  }, [cell, engine]);
  const ruleTitle = (id: string) => { const r = engineProject.rules.find((x) => x.id === id); return r ? plainRuleTitle(engineProject, r) : ''; };
  const rep = cell.representative;

  return (
    <div className="cube-insp" data-testid="cube-selected-cell">
      <dl className="cube-insp-axes">
        {labels.map((l) => <div key={l.axis}><dt><span className={`cube-axis-dot ax-${l.axis.toLowerCase()}`} />{l.axis} · {l.dim}</dt><dd>{l.label}</dd></div>)}
      </dl>
      <div className="cube-insp-count">
        <span className="cube-insp-num" data-testid="cube-cell-count">{cell.count}</span>
        <span>matching {cell.count === 1 ? 'scenario' : 'scenarios'}<br /><span className="muted">{cell.recordIds.length} distinct seeded {cell.recordIds.length === 1 ? 'record' : 'records'}</span></span>
        {cell.simulationOnly && <span className="chip sim" data-testid="cube-sim-only">SIMULATION ONLY</span>}
      </div>

      {cell.count === 0 ? (
        <div className="callout" data-testid="cube-empty-cell"><strong>No matching records</strong><br /><span className="muted">No seeded record resolves to this intersection. Nothing is fabricated; create an edge case from Rules &amp; Data to cover it.</span></div>
      ) : (
        <>
          <div className="section-title">Outcome breakdown</div>
          <ul className="cube-bars">
            {Object.entries(cell.outcomes).sort((a, b) => b[1] - a[1]).map(([o, n]) => { const st = outcomeStyle(o); return (
              <li key={o}><span className="cube-mark sm" style={{ ['--mk' as string]: st.color }}>{st.letter}</span><span className={`cube-bar-name${technical ? ' mono' : ''}`} title={outcomeName(o)}>{outcomeName(o)}</span><span className="cube-bar-track"><span style={{ width: `${(n / cell.count) * 100}%`, background: st.color }} /></span><strong>{n}</strong></li>
            ); })}
          </ul>

          <div className="section-title">Fixtures ({cell.recordIds.length})</div>
          <div className="cube-chips">
            {cell.recordIds.slice(0, 40).map((id) => <button key={id} className="chip cube-chip" onClick={() => onOpen(cell, 'design', id)} title={`Open ${id} in the design studio`}>{id}</button>)}
            {cell.recordIds.length > 40 && <span className="muted">+{cell.recordIds.length - 40} more</span>}
          </div>

          <div className="section-title">Notable rules</div>
          {detail.rules.length === 0 ? <p className="muted">No rules matched.</p> : (
            <ul className="cube-list rules">{detail.rules.slice(0, 6).map(([id, n]) => <li key={id}><span className="cube-list-t cube-rule-t" title={ruleTitle(id)}>{ruleTitle(id) || id}</span><span className="chip variant cube-tag">{id}</span><span className="muted">{n}/{cell.scenarios.length}</span></li>)}</ul>
          )}

          <div className="section-title">Issues</div>
          {detail.issues.length === 0 ? <p className="muted">No blocking or warning findings.</p> : (
            <ul className="cube-list">{detail.issues.map(([code, v]) => <li key={code}><span className={`chip ${v.sev === 'blocking' ? 'error' : 'warning'}`}>{v.sev === 'blocking' ? '■' : '▲'} {v.sev}</span><span className={`cube-list-t${technical ? ' mono' : ''}`} title={code}>{technical ? code : humanCode(code)}</span><span className="muted">×{v.n}</span></li>)}</ul>
          )}
        </>
      )}

      <div className="cube-actions">
        <button className="btn primary" disabled={!rep} onClick={() => onOpen(cell, 'design')} data-testid="cube-open-rep">Open representative scenario</button>
        <div className="row">
          <button className="btn" disabled={!rep || !cube.primaryVariantSet} onClick={() => onOpen(cell, 'exploded')} data-testid="cube-open-exploded">Open in Exploded</button>
          <button className="btn" disabled={!rep} onClick={() => onOpen(cell, 'outputs')} data-testid="cube-open-output">{cell.simulationOnly ? 'Open output (simulation)' : 'Open output'}</button>
        </div>
        {rep && <p className="cube-rep-note">Representative: <span className="mono">{rep.recordId}</span> · {outputLabel(rep.profileId)}{rep.journeyCursor === null ? ' · baseline' : ` · journey event ${rep.journeyCursor + 1}`}</p>}
        {cell.simulationOnly && <p className="cube-rep-note">AFP is a simulation for review only; no AFP file is offered for download.</p>}
      </div>
    </div>
  );
}

const outputLabel = (id: string) => OUTPUT_PROFILES.find((o) => o.id === id)?.label ?? id;
