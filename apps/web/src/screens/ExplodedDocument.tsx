import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { nodeMap, type Project } from '@iss/model';
import { blocksHtml } from '@iss/renderers';
import { describePredicate, explainNode, indexTree, type RNode, type RVariant, type Resolution } from '@iss/resolver';
import { personaLabel, useResolution, useScenarioEngine, useStudio } from '../state/store';
import { Dialog, Empty, ScreenHeader } from '../ui/common';
import { Icon } from '../ui/icons';
import { PagePreview } from '../doc/PagePreview';
import './ExplodedDocument.css';

/**
 * S03 Exploded Document — the signature 2.5D view.
 * Depth meaning (exactly one): Z = alternative resolved outcomes of ONE component. Not pages, not time.
 * Every panel is a projection of a real variant in the canonical model; its state comes from the live resolver
 * and its reach from resolving every seeded record. Camera movement never changes the document.
 */

interface Reach { count: number; total: number; recordIds: string[]; personas: Array<[string, number]> }

function useVariantReach(nodeId: string | undefined): Map<string, Reach> | null {
  const engine = useScenarioEngine();
  const cursor = useStudio((s) => s.ctx.journeyCursor);
  return useMemo(() => {
    if (!engine || !nodeId) return null;
    const scen = engine.universe({ journeyCursors: [cursor] });
    const out = new Map<string, Reach>();
    for (const s of scen) {
      const r = engine.resolveScenario(s);
      const n = indexTree(r.root).get(nodeId);
      const sel = n?.variants?.unresolved ? ['(unresolved)'] : n?.visible ? n?.variants?.selected ?? [] : ['(not rendered)'];
      for (const v of sel) {
        const e = out.get(v) ?? { count: 0, total: scen.length, recordIds: [], personas: [] };
        e.count++; e.recordIds.push(s.recordId);
        const pid = (r.effectiveRecord as any).personaId ?? (r.effectiveRecord as any).claims?.[0]?.status ?? '—';
        const pe = e.personas.find((p) => p[0] === pid); if (pe) pe[1]++; else e.personas.push([pid, 1]);
        out.set(v, e);
      }
    }
    for (const e of out.values()) e.personas.sort((a, b) => b[1] - a[1]);
    return out;
  }, [engine, nodeId, cursor]);
}

type PanelState = 'selected' | 'outranked' | 'tie' | 'idle' | 'fallback-idle';

function stateOf(v: RVariant, unresolved: boolean): PanelState {
  if (v.selected) return 'selected';
  if (unresolved && v.matched) return 'tie';
  if (v.matched) return 'outranked';
  return v.isFallback ? 'fallback-idle' : 'idle';
}

const STATE_LABEL: Record<PanelState, string> = { selected: 'Active in this scenario', outranked: 'Matched · outranked', tie: 'Matched · priority tie', idle: 'Not matched', 'fallback-idle': 'Fallback · standing by' };

export function ExplodedDocument() {
  const navigate = useNavigate();
  const params = useParams();
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const personas = useStudio((s) => s.personas);
  const reducedMotion = useStudio((s) => s.reducedMotion);
  const res = useResolution();
  const { select, setCtx, setRecord } = useStudio.getState();
  const fallbackNode = project.nodes.find((n) => n.type === 'variant-set')?.id;
  const nodeId = params.nodeId ?? ctx.selectedNodeId ?? fallbackNode;
  const node = nodeId ? nodeMap(project).get(nodeId) : undefined;
  const rnode = res && nodeId ? indexTree(res.root).get(nodeId) : undefined;
  const reach = useVariantReach(node && (node.type === 'variant-set' || node.type === 'conditional-region') ? node.id : undefined);

  const [exploded, setExploded] = useState(reducedMotion);
  const [collapsing, setCollapsing] = useState(false);
  const [tilt, setTilt] = useState(10);
  const [yaw, setYaw] = useState(-16);
  const [depth, setDepth] = useState(70);
  const [flat, setFlat] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [compare, setCompare] = useState<string[] | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Array<{ id: string; d: string; state: PanelState }>>([]);
  const [box, setBox] = useState({ w: 640, h: 600 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the canonical selection on the exploded node (AT-12: same semantic node across views).
  useEffect(() => { if (nodeId && ctx.selectedNodeId !== nodeId) select(nodeId, ctx.selectedVariantId); }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reducedMotion) { setExploded(true); return; } setExploded(false); const t = setTimeout(() => setExploded(true), 60); return () => clearTimeout(t); }, [nodeId, reducedMotion]);

  const variants = rnode?.variants?.items ?? [];
  const activeId = ctx.selectedVariantId && variants.some((v) => v.id === ctx.selectedVariantId) ? ctx.selectedVariantId : variants.find((v) => v.selected)?.id ?? variants[0]?.id ?? null;
  useEffect(() => { const i = variants.findIndex((v) => v.id === activeId); if (i >= 0) setFocusIdx(i); }, [activeId, variants.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------- connectors */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    const src = stage.querySelector('.ex-paper [data-node-id="' + nodeId + '"]') as HTMLElement | null;
    if (!src) { setLines([]); return; }
    const s = src.getBoundingClientRect();
    const sx = s.right - sr.left, sy = s.top + s.height / 2 - sr.top;
    const out: Array<{ id: string; d: string; state: PanelState }> = [];
    stage.querySelectorAll<HTMLElement>('.ex-panel').forEach((p) => {
      const r = p.getBoundingClientRect();
      const tx = r.left - sr.left, ty = r.top + r.height / 2 - sr.top;
      const mx = (sx + tx) / 2;
      out.push({ id: p.dataset.variant!, state: p.dataset.state as PanelState, d: `M${sx.toFixed(1)},${sy.toFixed(1)} C${mx.toFixed(1)},${sy.toFixed(1)} ${mx.toFixed(1)},${ty.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}` });
    });
    setLines(out);
  }, [nodeId]);
  useLayoutEffect(() => {
    if (flat) return;
    let raf = 0; const start = performance.now();
    const loop = () => { measure(); if (performance.now() - start < 900) raf = requestAnimationFrame(loop); };
    loop();
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); };
  }, [measure, exploded, tilt, yaw, depth, flat, variants.length, activeId, res?.runId]);

  const collapse = () => {
    if (reducedMotion) { navigate(`/studio/${project.projectId}/design`); return; }
    setCollapsing(true); setExploded(false);
    setTimeout(() => navigate(`/studio/${project.projectId}/design`), 420);
  };

  const chooseVariant = (id: string) => setCtx({ selectedNodeId: nodeId!, selectedVariantId: id });

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!variants.length) return;
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const i = (focusIdx + 1) % variants.length; setFocusIdx(i); (stageRef.current?.querySelector(`[data-variant="${variants[i].id}"]`) as HTMLElement | null)?.focus(); }
    if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); const i = (focusIdx - 1 + variants.length) % variants.length; setFocusIdx(i); (stageRef.current?.querySelector(`[data-variant="${variants[i].id}"]`) as HTMLElement | null)?.focus(); }
    if (e.key === 'Escape') collapse();
  };

  if (!res) return <section className="screen" data-testid="exploded-view"><ScreenHeader id="S03" title="Exploded Document" subtitle="No resolvable scenario." /></section>;
  if (!node || !rnode) return (
    <section className="screen" data-testid="exploded-view">
      <ScreenHeader id="S03" title="Exploded Document" subtitle="Select a Conditional Region or Variant Set in the designer, then choose Explore variants." />
      <Empty title="Nothing to explode" message={`Component “${nodeId}” does not exist in ${project.title}.`}><button className="btn" onClick={() => navigate(`/studio/${project.projectId}/design`)}>Back to designer</button></Empty>
    </section>
  );
  const explodable = node.type === 'variant-set' || node.type === 'conditional-region';
  const active = variants.find((v) => v.id === activeId);
  const explanation = explainNode(res, node.id);
  const winner = res.trace.find((t) => t.targetNodeId === node.id && t.outcome === 'selected' && t.kind === 'rule');
  const n = variants.length;
  const paperScale = Math.max(0.26, Math.min(0.44, (box.h - 150) / 1056, (box.w * 0.42) / 816));
  const paperW = 816 * paperScale, paperH = 1056 * paperScale;
  const paperX = Math.max(16, box.w * 0.04), paperY = Math.max(64, (box.h - paperH) / 2 + 20);
  const panelW = Math.max(220, Math.min(290, box.w - paperX - paperW * 0.82 - 40));
  const px0 = paperX + paperW * 0.78, px1 = Math.max(px0, box.w - panelW - 24);
  const py0 = 92, py1 = Math.max(py0, box.h - 150);

  return (
    <section className="screen exploded" data-testid="exploded-view" aria-label="Exploded Document">
      <ScreenHeader id="S03" title="Exploded Document" subtitle="Pull one conditional component into space: every named alternative, why it appears, and who receives it — derived live from the model and rules."
        badge={<span className="chip accent">Signature 2.5D</span>}
        actions={<>
          <button className="btn" onClick={() => setFlat(!flat)} aria-pressed={flat} data-testid="flat-alternative"><Icon.list /> Flat alternative</button>
          <button className="btn" disabled={n < 2} onClick={() => setCompare([activeId ?? variants[0].id, variants.find((v) => v.id !== activeId)?.id ?? variants[1].id])} data-testid="compare-variants"><Icon.compare /> Compare</button>
          <button className="btn primary" onClick={collapse} data-testid="collapse-exploded"><Icon.collapse /> Collapse to page</button>
        </>}
      />
      <div className="screen-body workbench">
        <aside className="panel" aria-label="Variants list">
          <div className="panel-head">Alternatives <span className="sub">{n} named · Z-axis</span></div>
          <div className="panel-body">
            <ol className="ex-list" data-testid="variant-list" aria-label={`Variants of ${node.id}`}>
              {variants.map((v, i) => {
                const st = stateOf(v, !!rnode.variants?.unresolved);
                const r = reach?.get(v.id);
                return (
                  <li key={v.id}>
                    <button className={`ex-list-item st-${st}${v.id === activeId ? ' focused' : ''}`} onClick={() => chooseVariant(v.id)} aria-current={v.id === activeId} data-testid={`variant-item-${v.id}`}>
                      <span className="ex-z">Z{i + 1}</span>
                      <span className="grow">
                        <span className="ex-list-title">{v.title}</span>
                        <span className="ex-list-meta">{STATE_LABEL[st]} · {(v.candidateRuleIds.join(', ') || (v.isFallback ? 'fallback' : node.ruleDriven ? 'section rule' : 'inline'))}{r ? ` · ${r.count}/${r.total}` : ''}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="section-title">Scenario</div>
            <div className="kv">
              <dt>Record</dt><dd>{res.recordId}</dd>
              <dt>Persona</dt><dd>{personaLabel(personas, (res.effectiveRecord as any).personaId)}</dd>
              <dt>Journey</dt><dd>{ctx.journeyCursor === null ? 'Baseline' : project.journey.events[ctx.journeyCursor]?.label}</dd>
              <dt>Run</dt><dd className="mono">{res.runId}</dd>
            </div>
            <p className="muted" style={{ fontSize: 11.5 }}>Change the record in the top bar and watch the active marker move — panels are not re-cloned, only re-resolved.</p>
          </div>
        </aside>

        <div className={`stage ex-stage${flat ? ' is-flat' : ''}`} ref={stageRef} onKeyDown={onKey}>
          <div className="stage-grid" />
          <div className="stage-toolbar">
            <span className="chip variant" data-testid="z-axis-legend">Z-axis = alternative resolved outcomes of {node.id} · not pages, not time</span>
            <span style={{ flex: 1 }} />
            {!flat && <div className="ex-camera" role="group" aria-label="Camera (does not change the document)">
              <label>Tilt <input type="range" min={0} max={18} value={tilt} onChange={(e) => setTilt(+e.target.value)} aria-label="Tilt degrees" /></label>
              <label>Turn <input type="range" min={-28} max={0} value={yaw} onChange={(e) => setYaw(+e.target.value)} aria-label="Turn degrees" /></label>
              <label>Depth <input type="range" min={30} max={120} value={depth} onChange={(e) => setDepth(+e.target.value)} aria-label="Depth separation" /></label>
              <button className="btn sm" onClick={() => { setTilt(10); setYaw(-16); setDepth(70); }}><Icon.reset width={14} height={14} /> Reset camera</button>
            </div>}
          </div>

          {!explodable ? (
            <Empty title="Not a conditional component" message={`${node.name} (${node.type}) has a single outcome. Explode a Variant Set (C11) or Conditional Region (C10).`} />
          ) : flat ? (
            <div className="ex-flat" role="list" aria-label="Flat variant comparison">
              {variants.map((v) => <VariantCard key={v.id} v={v} st={stateOf(v, !!rnode.variants?.unresolved)} reach={reach?.get(v.id)} personas={personas} active={v.id === activeId} onChoose={() => chooseVariant(v.id)} onPreview={(rid) => setRecord(rid)} project={project} res={res} node={rnode} flat />)}
            </div>
          ) : (
            <div className="ex-scene" style={{ perspective: '1700px' }}>
              <svg className="ex-lines" aria-hidden="true">
                <defs>
                  <linearGradient id="exg" x1="0" x2="1"><stop offset="0" stopColor="#4EAF60" stopOpacity=".9" /><stop offset="1" stopColor="#DBE64C" stopOpacity=".55" /></linearGradient>
                </defs>
                {exploded && lines.map((l) => <path key={l.id} d={l.d} className={`ex-line st-${l.state}`} stroke={l.state === 'selected' ? '#4EAF60' : 'url(#exg)'} />)}
              </svg>
              <div className="ex-world" style={{ transform: `rotateX(${tilt}deg) rotateY(${yaw}deg)` }}>
                <div className="ex-paper" style={{ left: paperX, top: paperY, width: paperW, height: paperH }} aria-label={`Source page with ${node.id} highlighted`}>
                  <PagePreview res={res} project={project} scale={paperScale} showGuides={false} ia={{ selectedId: node.id, highlightIds: [node.id], onSelect: () => undefined }} />
                  <div className="ex-paper-label">Context plane · page 1 · {res.recordId}</div>
                </div>
                {variants.map((v, i) => {
                  const st = stateOf(v, !!rnode.variants?.unresolved);
                  const spread = n > 1 ? i / (n - 1) : 0.5;
                  const x = px0 + (px1 - px0) * (0.15 + 0.85 * spread);
                  const y = py0 + (py1 - py0) * spread;
                  const z = (i + 1) * depth * 0.75;
                  const style = exploded && !collapsing
                    ? { transform: `translate3d(${x}px, ${y}px, ${z}px)`, opacity: 1, transitionDelay: reducedMotion ? '0ms' : `${80 + i * 55}ms` }
                    : { transform: `translate3d(${paperX + paperW * 0.6}px, ${paperY + paperH * 0.42}px, 0px) scale(.5)`, opacity: 0, transitionDelay: reducedMotion ? '0ms' : `${(n - i) * 30}ms` };
                  return (
                    <div key={v.id} className={`ex-panel st-${st}${v.id === activeId ? ' focused' : ''}`} style={{ ...style, width: panelW }} data-variant={v.id} data-state={st}
                      role="button" tabIndex={0} aria-pressed={v.id === activeId}
                      aria-label={`Z${i + 1} ${v.title}: ${STATE_LABEL[st]}. Rules ${v.candidateRuleIds.join(', ') || 'none'}. Reach ${reach?.get(v.id)?.count ?? 0} of ${reach?.get(v.id)?.total ?? 0} seeded records.`}
                      onClick={() => chooseVariant(v.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseVariant(v.id); } }}
                      onFocus={() => setFocusIdx(i)} data-testid={`panel-${v.id}`}>
                      <VariantCard v={v} st={st} reach={reach?.get(v.id) ?? (reach ? { count: 0, total: [...reach.values()][0]?.total ?? 0, recordIds: [], personas: [] } : undefined)} personas={personas} active={v.id === activeId} onChoose={() => chooseVariant(v.id)} onPreview={(rid) => setRecord(rid)} project={project} res={res} node={rnode} zIndex={i + 1} compact={v.id !== activeId} />
                    </div>
                  );
                })}
              </div>
              {n === 1 && <div className="ex-note">Single named outcome — shown without a misleading explosion.</div>}
            </div>
          )}
        </div>

        <aside className="panel ex-insp" aria-label="Exploded inspector">
          <div className="panel-head">Node selection</div>
          <div className="panel-body">
            <div className="field"><span className="label">Selected component</span><div className="ex-selected" data-testid="selected-node">{node.id} · {node.type === 'variant-set' ? 'C11 Variant Set' : 'C10 Conditional Region'}</div></div>
            <div className="field"><span className="label">Inspecting variant</span><div className="ex-selected variant" data-testid="selected-variant">{active ? `${active.title} (${active.id})` : '—'}</div></div>
            {rnode.variants?.unresolved && <div className="callout error" role="alert"><strong>Unresolved.</strong> {res.findings.find((f) => f.nodeId === node.id && f.severity === 'blocking')?.message}</div>}
            {!rnode.visible && <div className="callout warning">Not rendered in this scenario: {rnode.hiddenReason}</div>}
            <div className="section-title">Decision trace</div>
            <div className="callout accent ex-explain" data-testid="exploded-explanation">{explanation.summary}</div>
            {active && <table className="table" style={{ marginTop: 8 }}>
              <thead><tr><th>Rule</th><th>Outcome</th><th>Inputs</th></tr></thead>
              <tbody>
                {res.trace.filter((t) => active.candidateRuleIds.includes(t.ruleId) || active.ruleIds.includes(t.ruleId)).map((t) => (
                  <tr key={t.ruleId}><td><strong>{t.ruleId}</strong><div className="mono muted">{describePredicate(t.expression)}</div></td><td><span className={`chip ${t.outcome === 'selected' || t.outcome === 'applied' ? 'accent' : t.outcome === 'tie' ? 'error' : t.outcome === 'outranked' ? 'variant' : ''}`}>{t.outcome}</span></td><td className="mono" style={{ fontSize: 11 }}>{Object.entries(t.predicateInputs).map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(' ')}</td></tr>
                ))}
                {!active.candidateRuleIds.length && <tr><td colSpan={3} className="muted">{active.isFallback ? 'Named fallback: used only when no rule matches.' : 'Selected by inline condition / section rule.'}</td></tr>}
              </tbody>
            </table>}
            <div className="row wrap" style={{ marginTop: 10 }}>
              <button className="btn primary" data-testid="open-rule-trace" onClick={() => navigate(`/studio/${project.projectId}/rules-data?rule=${(active?.candidateRuleIds[0]) ?? winner?.ruleId ?? ''}`)}><Icon.rules /> Inspect rule</button>
              <button className="btn" onClick={() => navigate(`/studio/${project.projectId}/design`)} data-testid="edit-variant"><Icon.design /> Edit variant</button>
            </div>
            {active && reach?.get(active.id) && <>
              <div className="section-title">Synthetic reach</div>
              <div className="kv"><dt>Seeded records</dt><dd>{reach.get(active.id)!.count} of {reach.get(active.id)!.total}</dd><dt>Top personas</dt><dd>{reach.get(active.id)!.personas.slice(0, 3).map(([p, c]) => `${personaLabel(personas, p).split(' · ')[1] ?? p} (${c})`).join(', ')}</dd></div>
              <p className="muted" style={{ fontSize: 11 }}>Synthetic fixture counts, not real customer analytics.</p>
            </>}
          </div>
        </aside>
      </div>
      {compare && <CompareDialog project={project} res={res} node={rnode} ids={compare} onChange={setCompare} onClose={() => setCompare(null)} />}
    </section>
  );
}

function VariantCard({ v, st, reach, personas, active, onChoose, onPreview, project, res, node, flat, zIndex, compact }: { v: RVariant; st: PanelState; reach?: Reach; personas: any[]; active: boolean; onChoose: () => void; onPreview: (recordId: string) => void; project: Project; res: Resolution; node: RNode; flat?: boolean; zIndex?: number; compact?: boolean }) {
  const traceRules = v.candidateRuleIds.map((id) => res.trace.find((t) => t.ruleId === id)).filter(Boolean);
  const pct = reach ? Math.round((100 * reach.count) / Math.max(1, reach.total)) : 0;
  const rep = reach?.recordIds.find((id) => id !== res.recordId);
  return (
    <div className={`ex-card${flat ? ' flat' : ''}${compact ? ' compact' : ''}`} role={flat ? 'listitem' : undefined} onClick={flat ? onChoose : undefined}>
      <div className="ex-card-head">
        {zIndex && <span className="ex-z">Z{zIndex}</span>}
        <span className="ex-card-title">{v.title}</span>
        <span className={`ex-state st-${st}`}>{st === 'selected' ? '● Active' : st === 'outranked' ? '◐ Outranked' : st === 'tie' ? '⚠ Tie' : st === 'fallback-idle' ? '○ Fallback' : '○ Idle'}</span>
      </div>
      <div className="ex-paperlet" dangerouslySetInnerHTML={{ __html: blocksHtml(v.text) }} />
      <div className="ex-chips">
        {traceRules.map((t) => <span key={t!.ruleId} className={`chip ${t!.matched ? (t!.outcome === 'selected' ? 'accent' : t!.outcome === 'tie' ? 'error' : 'variant') : ''}`} title={describePredicate(t!.expression)}>{t!.ruleId} · {describePredicate(t!.expression).slice(0, 34)}</span>)}
        {v.isFallback && <span className="chip">fallback</span>}
        {v.missingLocale && <span className="chip warning">translation missing</span>}
        {v.source === 'section-rule' && <span className="chip info">section rule</span>}
      </div>
      <div className="ex-reach">
        <span className="ex-reach-bar"><span style={{ width: `${pct}%` }} /></span>
        <span>{reach ? `${reach.count}/${reach.total} seeded · ${pct}%` : 'reach —'}</span>
      </div>
      <div className="ex-card-foot">
        <span className="muted">{reach?.personas.slice(0, 2).map(([p]) => personaLabel(personas, p).split(' · ')[1] ?? p).join(' · ') || 'No seeded record receives this'}</span>
        {rep && st !== 'selected' && <button className="btn sm" onClick={(e) => { e.stopPropagation(); onPreview(rep); }} title={`Switch scenario to ${rep}`}>Preview as {rep}</button>}
        {v.contentVersion !== null && <span className="mono faint">v{v.contentVersion}</span>}
      </div>
    </div>
  );
}

function CompareDialog({ project, res, node, ids, onChange, onClose }: { project: Project; res: Resolution; node: RNode; ids: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const items = node.variants?.items ?? [];
  const pick = (i: number, id: string) => onChange(ids.map((x, j) => (j === i ? id : x)));
  return (
    <Dialog title={<>Compare variants · {node.id}</>} onClose={onClose}>
      <div className="ex-compare">
        {ids.map((id, i) => {
          const v = items.find((x) => x.id === id)!;
          return (
            <div key={i} className="ex-compare-col">
              <select className="select" value={id} onChange={(e) => pick(i, e.target.value)} aria-label={`Variant ${i + 1}`}>{items.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
              <div className="ex-paperlet big" dangerouslySetInnerHTML={{ __html: blocksHtml(v.text) }} />
              <div className="kv"><dt>Content</dt><dd className="mono">{v.id}@v{v.contentVersion}</dd><dt>State</dt><dd>{STATE_LABEL[stateOf(v, !!node.variants?.unresolved)]}</dd><dt>Rules</dt><dd>{v.candidateRuleIds.join(', ') || (v.isFallback ? 'fallback' : '—')}</dd></div>
              {v.candidateRuleIds.map((rid) => { const r = project.rules.find((x) => x.id === rid)!; return <div key={rid} className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>{rid} (p{r.priority}): {describePredicate(r.when)}</div>; })}
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Run {res.runId}. Comparing never changes the model; edit content in the designer.</p>
    </Dialog>
  );
}
