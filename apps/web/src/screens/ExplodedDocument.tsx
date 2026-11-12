import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { nodeMap, type Project } from '@iss/model';
import { blocksHtml } from '@iss/renderers';
import { describePredicate, explainNode, indexTree, type RNode, type RVariant, type Resolution, type TraceEntry } from '@iss/resolver';
import { personaLabel, useResolution, useScenarioEngine, useStudio } from '../state/store';
import { Dialog, Empty, Proof, ScreenHeader } from '../ui/common';
import { Icon } from '../ui/icons';
import { fieldLabel, nodeTitle, predicateSentence, ruleSentence, ruleTitle } from '../ui/plain';
import { PagePreview } from '../doc/PagePreview';
import './ExplodedDocument.css';

/**
 * S03 Exploded Document — the signature 2.5D view.
 * Depth meaning (exactly one): Z = alternative resolved outcomes of ONE component. Not pages, not time.
 * Every panel is a projection of a real variant in the canonical model; its state comes from the live resolver
 * and its reach from resolving every seeded record. Camera movement never changes the document.
 *
 * Layout guarantee: panels are stacked on a measured vertical stride (each panel's own height + GAP), so no
 * panel ever covers another panel's text. Depth is expressed by a horizontal fan, per-panel perspective tilt and
 * shading — never by overlapping. When the stack is taller than the stage, the stage scrolls.
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
const STATE_SHORT: Record<PanelState, string> = { selected: 'Active', outranked: 'Outranked', tie: 'Tie', idle: 'Idle', 'fallback-idle': 'Fallback' };
const STATE_MARK: Record<PanelState, string> = { selected: '●', outranked: '◐', tie: '⚠', idle: '○', 'fallback-idle': '◌' };
const OUTCOME_PLAIN: Record<TraceEntry['outcome'], string> = { selected: 'Chosen', outranked: 'Matched · lower priority', tie: 'Matched · tie', applied: 'Applied', required: 'Required', 'not-matched': 'Not matched', disabled: 'Switched off', 'out-of-scope': 'Not in scope' };
const outcomeChip = (o: TraceEntry['outcome']) => (o === 'selected' || o === 'applied' ? 'accent' : o === 'tie' ? 'error' : o === 'outranked' ? 'variant' : '');

/** Readable default camera: gentle tilt/turn, small depth fan. Reset camera returns here. */
const READABLE = { tilt: 4, yaw: -12, depth: 14 } as const;
const PAD = 16, LINK = 34, GAP = 12, EST_H = 112;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Business-view explanation, re-worded from the same trace the resolver produced (never invents outcomes). */
function plainExplanation(project: Project, res: Resolution, node: RNode): string {
  const name = nodeTitle(project, node.id);
  const parts: string[] = [];
  if (!node.visible) parts.push(`${name} is not shown in this scenario${node.hiddenReason ? `: ${node.hiddenReason}` : '.'}`);
  else if (node.variants?.unresolved) parts.push(`${name} is unresolved: rules tie at the same priority, so no message is chosen.`);
  else {
    const v = node.variants?.items.find((x) => x.selected);
    const winner = res.trace.find((t) => t.outcome === 'selected' && t.targetNodeId === node.id && t.kind === 'rule');
    if (v && winner) {
      parts.push(`“${v.title}” is shown because ${winner.ruleId} matched: ${predicateSentence(project, winner.expression)}.`);
      const outranked = res.trace.filter((t) => t.outcome === 'outranked' && t.targetNodeId === node.id);
      if (outranked.length) parts.push(`${outranked.map((t) => t.ruleId).join(', ')} also matched, but ${winner.ruleId} has higher priority.`);
    } else if (v?.source === 'fallback') parts.push(`“${v.title}” is the fallback: none of the targeting rules matched this customer.`);
    else if (v?.source === 'section-rule') parts.push(`“${v.title}” is shown by ${v.ruleIds.join(', ')}.`);
    else if (v) parts.push(`“${v.title}” is shown by its own condition.`);
    else parts.push(`No message is selected for ${name}.`);
  }
  if (node.dataLineage.length) parts.push(`Uses: ${[...new Set(node.dataLineage.map((p) => fieldLabel(project, p)))].join(', ')}.`);
  return parts.join(' ');
}

export function ExplodedDocument() {
  const navigate = useNavigate();
  const params = useParams();
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const personas = useStudio((s) => s.personas);
  const reducedMotion = useStudio((s) => s.reducedMotion);
  const tech = useStudio((s) => s.viewMode) === 'technical';
  const res = useResolution();
  const { select, setCtx, setRecord } = useStudio.getState();
  const fallbackNode = project.nodes.find((n) => n.type === 'variant-set')?.id;
  const nodeId = params.nodeId ?? ctx.selectedNodeId ?? fallbackNode;
  const node = nodeId ? nodeMap(project).get(nodeId) : undefined;
  const rnode = res && nodeId ? indexTree(res.root).get(nodeId) : undefined;
  const reach = useVariantReach(node && (node.type === 'variant-set' || node.type === 'conditional-region') ? node.id : undefined);

  const [exploded, setExploded] = useState(reducedMotion);
  const [settled, setSettled] = useState(reducedMotion);
  const [collapsing, setCollapsing] = useState(false);
  const [tilt, setTilt] = useState<number>(READABLE.tilt);
  const [yaw, setYaw] = useState<number>(READABLE.yaw);
  const [depth, setDepth] = useState<number>(READABLE.depth);
  const [flat, setFlat] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [compare, setCompare] = useState<string[] | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 640, h: 520 });
  const panelEls = useRef(new Map<string, HTMLDivElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [lines, setLines] = useState<Array<{ id: string; d: string; state: PanelState; active: boolean }>>([]);

  // Measure the scrollable scene (not the whole stage): the layout below is computed from it.
  useEffect(() => {
    if (!scene) return;
    const ro = new ResizeObserver(() => setBox({ w: scene.clientWidth, h: scene.clientHeight }));
    ro.observe(scene);
    return () => ro.disconnect();
  }, [scene]);

  // Keep the canonical selection on the exploded node (AT-12: same semantic node across views).
  useEffect(() => { if (nodeId && ctx.selectedNodeId !== nodeId) select(nodeId, ctx.selectedVariantId); }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (reducedMotion) { setExploded(true); setSettled(true); return; }
    setExploded(false); setSettled(false);
    const t = setTimeout(() => setExploded(true), 60);
    const t2 = setTimeout(() => setSettled(true), 900);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [nodeId, reducedMotion]);

  const variants = rnode?.variants?.items ?? [];
  const variantKey = variants.map((v) => v.id).join('|');
  const activeId = ctx.selectedVariantId && variants.some((v) => v.id === ctx.selectedVariantId) ? ctx.selectedVariantId : variants.find((v) => v.selected)?.id ?? variants[0]?.id ?? null;
  useEffect(() => { const i = variants.findIndex((v) => v.id === activeId); if (i >= 0) setFocusIdx(i); }, [activeId, variants.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --------------------------------------------- measured panel heights (untransformed layout height) */
  useLayoutEffect(() => {
    if (flat) return;
    const read = () => setHeights((prev) => {
      let changed = false; const next: Record<string, number> = {};
      panelEls.current.forEach((el, id) => { next[id] = el.offsetHeight; if (prev[id] !== next[id]) changed = true; });
      return changed ? next : prev;
    });
    read();
    const ro = new ResizeObserver(read);
    panelEls.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [flat, variantKey, scene]);

  /* ------------------------------------------------------- geometry */
  const n = variants.length;
  const steps = Math.max(0, n - 1);
  const panelW = Math.round(clamp(box.w * 0.4, 248, 330));
  const paperColW = box.w - PAD * 2 - panelW - depth * steps - LINK;
  const paperScale = clamp(Math.min(paperColW / 816, (box.h - PAD * 2 - 24) / 1056), 0.2, 0.62);
  const paperW = 816 * paperScale, paperH = 1056 * paperScale;
  const compW = paperW + LINK + panelW + depth * steps;
  const left = Math.max(PAD, (box.w - compW) / 2);
  const paperX = left, panelX0 = left + paperW + LINK;
  const hs = variants.map((v) => heights[v.id] ?? EST_H);
  const total = hs.reduce((a, b) => a + b, 0) + GAP * steps;
  const contentH = Math.max(box.h, total + PAD * 2);
  const y0 = (contentH - total) / 2;
  const ys = hs.reduce<number[]>((acc, h, i) => { acc.push(i === 0 ? y0 : acc[i - 1] + hs[i - 1] + GAP); return acc; }, []);
  const paperTop = Math.max(PAD, (box.h - paperH - 24) / 2);

  /* ------------------------------------------------------- connectors */
  const measure = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const wr = world.getBoundingClientRect();
    const src = world.querySelector('.ex-paper [data-node-id="' + nodeId + '"]') as HTMLElement | null;
    if (!src) { setLines([]); return; }
    const s = src.getBoundingClientRect();
    const sx = s.right - wr.left, sy = s.top + s.height / 2 - wr.top;
    const out: Array<{ id: string; d: string; state: PanelState; active: boolean }> = [];
    world.querySelectorAll<HTMLElement>('.ex-panel').forEach((p) => {
      const r = p.getBoundingClientRect();
      const tx = r.left - wr.left + 2, ty = r.top + r.height / 2 - wr.top;
      const mx = (sx + tx) / 2;
      out.push({ id: p.dataset.variant!, state: p.dataset.state as PanelState, active: p.dataset.variant === activeId, d: `M${sx.toFixed(1)},${sy.toFixed(1)} C${mx.toFixed(1)},${sy.toFixed(1)} ${mx.toFixed(1)},${ty.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}` });
    });
    setLines(out);
  }, [nodeId, activeId]);
  useLayoutEffect(() => {
    if (flat) return;
    let raf = 0; const start = performance.now();
    const loop = () => { measure(); if (performance.now() - start < 1000) raf = requestAnimationFrame(loop); };
    loop();
    window.addEventListener('resize', measure);
    scene?.addEventListener('scroll', measure, { passive: true });
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); scene?.removeEventListener('scroll', measure); };
  }, [measure, scene, exploded, tilt, yaw, depth, flat, variantKey, activeId, res?.runId, box.w, box.h, total]);

  // Keep the inspected panel in view when the stack scrolls.
  useEffect(() => {
    if (!scene || flat || !activeId) return;
    const i = variants.findIndex((v) => v.id === activeId);
    if (i < 0) return;
    const top = ys[i] - PAD, bottom = ys[i] + hs[i] + PAD;
    if (top < scene.scrollTop) scene.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
    else if (bottom > scene.scrollTop + scene.clientHeight) scene.scrollTo({ top: bottom - scene.clientHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [activeId, scene, flat]); // eslint-disable-line react-hooks/exhaustive-deps

  const collapse = () => {
    if (reducedMotion) { navigate(`/studio/${project.projectId}/design`); return; }
    setCollapsing(true); setExploded(false); setSettled(false);
    setTimeout(() => navigate(`/studio/${project.projectId}/design`), 420);
  };

  const chooseVariant = (id: string) => setCtx({ selectedNodeId: nodeId!, selectedVariantId: id });
  const focusPanel = (i: number) => { setFocusIdx(i); panelEls.current.get(variants[i].id)?.focus(); };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!variants.length || !(e.target as HTMLElement).classList?.contains('ex-panel')) { if (e.key === 'Escape') collapse(); return; }
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); focusPanel((focusIdx + 1) % variants.length); }
    if (['ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); focusPanel((focusIdx - 1 + variants.length) % variants.length); }
    if (e.key === 'Home') { e.preventDefault(); focusPanel(0); }
    if (e.key === 'End') { e.preventDefault(); focusPanel(variants.length - 1); }
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
  const name = nodeTitle(project, node.id);
  const unresolved = !!rnode.variants?.unresolved;
  const cameraChanged = tilt !== READABLE.tilt || yaw !== READABLE.yaw || depth !== READABLE.depth;
  const activeTrace = active ? res.trace.filter((t) => active.candidateRuleIds.includes(t.ruleId) || active.ruleIds.includes(t.ruleId)) : [];
  const activeReach = active ? reach?.get(active.id) : undefined;
  const previewRecord = active && active.id !== variants.find((v) => v.selected)?.id ? activeReach?.recordIds.find((id) => id !== res.recordId) : undefined;
  const totalSeeded = reach ? [...reach.values()][0]?.total ?? 0 : 0;
  const personaShort = (p: string) => personaLabel(personas, p).split(' · ')[1] ?? p;
  const cx = paperX + paperW * 0.5 - panelW / 2, cy = paperTop + paperH * 0.42;

  return (
    <section className="screen exploded" data-testid="exploded-view" aria-label="Exploded Document">
      <ScreenHeader id="S03" title="Exploded Document" subtitle="Pull one conditional component into space: every named alternative, why it appears, and who receives it — derived live from the model and rules. Depth shows alternative outcomes of one component, not pages or time."
        actions={<>
          <button className="btn" disabled={n < 2} onClick={() => setCompare([activeId ?? variants[0].id, variants.find((v) => v.id !== activeId)?.id ?? variants[1].id])} data-testid="compare-variants"><Icon.compare /> Compare</button>
          <button className="btn primary" onClick={collapse} data-testid="collapse-exploded"><Icon.collapse /> Collapse to page</button>
        </>}
      />
      <div className="screen-body workbench ex-bench">
        <aside className="panel ex-legend" aria-label="Alternatives">
          <div className="panel-head">Alternatives <span className="sub">{n} outcome{n === 1 ? '' : 's'}</span></div>
          <div className="panel-body">
            <ol className="ex-list" data-testid="variant-list" aria-label={`Alternatives of ${name}`}>
              {variants.map((v, i) => {
                const st = stateOf(v, unresolved);
                const r = reach?.get(v.id);
                return (
                  <li key={v.id}>
                    <button className={`ex-list-item st-${st}${v.id === activeId ? ' focused' : ''}`} onClick={() => chooseVariant(v.id)} aria-current={v.id === activeId ? 'true' : undefined} data-testid={`variant-item-${v.id}`}
                      title={`${v.title} — ${STATE_LABEL[st]}`}>
                      <span className="ex-z" aria-hidden="true">Z{i + 1}</span>
                      <span className="ex-list-text">
                        <span className="ex-list-title">{v.title}</span>
                        <span className={`ex-list-meta st-${st}`}><span aria-hidden="true">{STATE_MARK[st]} </span>{STATE_LABEL[st]}</span>
                      </span>
                      <span className="ex-list-reach" aria-label={r ? `${r.count} of ${r.total} seeded records` : 'Reach not computed'}>{r ? r.count : reach ? 0 : '–'}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="section-title">Key</div>
            <ul className="ex-key">
              <li><span className="ex-key-mark st-selected" aria-hidden="true">●</span> Active — solid connector</li>
              <li><span className="ex-key-mark st-outranked" aria-hidden="true">◐</span> Matched, lower priority</li>
              <li><span className="ex-key-mark" aria-hidden="true">○</span> Not matched · <span aria-hidden="true">◌</span> fallback</li>
              <li><span className="ex-key-mark ex-key-num" aria-hidden="true">#</span> Seeded records reached</li>
              <li><span className="ex-z" aria-hidden="true">Z</span> Depth = alternative outcomes</li>
            </ul>
            <div className="section-title">Scenario</div>
            <dl className="kv ex-kv">
              <dt>Record</dt><dd className="mono">{res.recordId}</dd>
              <dt>Persona</dt><dd>{personaLabel(personas, (res.effectiveRecord as any).personaId)}</dd>
              <dt>Journey</dt><dd>{ctx.journeyCursor === null ? 'Baseline' : project.journey.events[ctx.journeyCursor]?.label}</dd>
            </dl>
          </div>
        </aside>

        <div className={`stage ex-stage${flat ? ' is-flat' : ''}${reducedMotion ? ' rm' : ''}`} ref={stageRef} onKeyDown={onKey}>
          <div className="stage-grid" />
          <div className="ex-toolbar">
            <div className="segmented" role="group" aria-label="Layout">
              <button aria-pressed={!flat} onClick={() => setFlat(false)}><Icon.exploded width={14} height={14} /> Spatial</button>
              <button aria-pressed={flat} onClick={() => setFlat(true)} data-testid="flat-alternative"><Icon.list width={14} height={14} /> Flat list</button>
            </div>
            <span className="chip variant ex-axis" data-testid="z-axis-legend" title={`Depth = alternative resolved outcomes of ${name} · not pages, not time`}>Depth = alternatives of {tech ? node.id : name}</span>
            <span className="ex-grow" />
            {!flat && explodable && <>
              <details className="ex-camdetails">
                <summary className="btn sm" aria-label="Camera controls (does not change the document)"><Icon.cube width={14} height={14} /> Camera</summary>
                <div className="ex-camera" role="group" aria-label="Camera (does not change the document)">
                  <label>Tilt <input type="range" min={0} max={12} value={tilt} onChange={(e) => setTilt(+e.target.value)} aria-label="Tilt degrees" /></label>
                  <label>Turn <input type="range" min={-24} max={0} value={yaw} onChange={(e) => setYaw(+e.target.value)} aria-label="Turn degrees" /></label>
                  <label>Depth <input type="range" min={0} max={30} value={depth} onChange={(e) => setDepth(+e.target.value)} aria-label="Depth separation" /></label>
                </div>
              </details>
              <button className="btn sm" onClick={() => { setTilt(READABLE.tilt); setYaw(READABLE.yaw); setDepth(READABLE.depth); }} disabled={!cameraChanged} data-testid="reset-camera" title="Return to the readable default camera"><Icon.reset width={14} height={14} /> Reset camera</button>
            </>}
          </div>

          {!explodable ? (
            <Empty title="Not a conditional component" message={`${node.name} (${node.type}) has a single outcome. Explode a Variant Set or Conditional Region.`} />
          ) : flat ? (
            <div className="ex-flat" role="list" aria-label="Flat variant comparison">
              {variants.map((v, i) => <VariantCard key={v.id} v={v} st={stateOf(v, unresolved)} reach={reach?.get(v.id)} totalSeeded={totalSeeded} active={v.id === activeId} onChoose={() => chooseVariant(v.id)} project={project} res={res} tech={tech} zIndex={i + 1} flat />)}
            </div>
          ) : (
            <div className="ex-scene" ref={setScene}>
              <div className="ex-world" ref={worldRef} style={{ height: contentH }}>
                <svg className="ex-lines" aria-hidden="true" width="100%" height={contentH}>
                  {exploded && lines.map((l) => <path key={l.id} d={l.d} className={`ex-line st-${l.state}${l.active ? ' is-active' : ''}`} />)}
                </svg>
                <div className="ex-paper-rail" style={{ left: paperX, width: paperW }}>
                  <div className="ex-paper" style={{ top: paperTop, width: paperW, height: paperH + 24, '--tilt': `${tilt}deg`, '--yaw': `${-yaw * 0.6}deg` } as CSSProperties}
                    role="img" aria-label={`Page 1 for ${res.recordId} with ${name} highlighted`}>
                    <PagePreview res={res} project={project} scale={paperScale} showGuides={false} ia={{ selectedId: node.id, highlightIds: [node.id], onSelect: () => undefined }} />
                    <div className="ex-paper-label">Page 1 · {res.recordId} · <span className="ex-paper-hl">{name}</span></div>
                  </div>
                </div>
                {variants.map((v, i) => {
                  const st = stateOf(v, unresolved);
                  const r = reach?.get(v.id);
                  const isActive = v.id === activeId;
                  const style = {
                    width: panelW,
                    '--x': `${panelX0 + i * depth}px`, '--y': `${ys[i]}px`, '--cx': `${cx}px`, '--cy': `${cy}px`,
                    '--tilt': `${tilt}deg`, '--yaw': `${yaw}deg`,
                    zIndex: isActive ? n + 2 : n - i,
                    transitionDelay: settled || reducedMotion ? undefined : exploded && !collapsing ? `${80 + i * 55}ms` : `${(n - i) * 30}ms`,
                  } as CSSProperties;
                  return (
                    <div key={v.id} ref={(el) => { if (el) panelEls.current.set(v.id, el); else panelEls.current.delete(v.id); }}
                      className={`ex-panel st-${st}${isActive ? ' focused' : ''}${exploded && !collapsing ? '' : ' is-collapsed'}`} style={style} data-variant={v.id} data-state={st}
                      role="button" tabIndex={i === focusIdx ? 0 : -1} aria-pressed={isActive}
                      aria-label={`Z${i + 1} ${v.title}: ${STATE_LABEL[st]}. Rules ${v.candidateRuleIds.join(', ') || 'none'}. Reach ${r?.count ?? 0} of ${r?.total ?? totalSeeded} seeded records.`}
                      onClick={() => chooseVariant(v.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseVariant(v.id); } }}
                      onFocus={() => setFocusIdx(i)} data-testid={`panel-${v.id}`}>
                      <VariantCard v={v} st={st} reach={r} totalSeeded={totalSeeded} active={isActive} project={project} res={res} tech={tech} zIndex={i + 1} compact={!isActive} />
                    </div>
                  );
                })}
              </div>
              {n === 1 && <div className="ex-note">Single named outcome — shown without a misleading explosion.</div>}
            </div>
          )}
        </div>

        <aside className="panel ex-insp" aria-label="Exploded inspector">
          <div className="panel-head">Selection</div>
          <div className="panel-body">
            <div className="field"><span className="label">Component</span>
              <div className="ex-selected" data-testid="selected-node">
                <span className="ex-sel-name">{name}</span>
                <span className="ex-sel-id mono" title={node.id}>{node.id}</span>
                <span className="ex-sel-type">{tech ? (node.type === 'variant-set' ? 'C11 Variant Set' : 'C10 Conditional Region') : (node.type === 'variant-set' ? 'Variant set' : 'Conditional region')}</span>
              </div>
            </div>
            <div className="field"><span className="label">Inspecting alternative</span>
              <div className="ex-selected variant" data-testid="selected-variant">
                {active ? <><span className="ex-sel-name">{active.title}</span><span className="ex-sel-id mono" title={active.id}>{active.id}</span></> : '—'}
              </div>
            </div>
            {unresolved && <div className="callout error" role="alert"><strong>Unresolved.</strong> {res.findings.find((f) => f.nodeId === node.id && f.severity === 'blocking')?.message}</div>}
            {!rnode.visible && <div className="callout warning">Not rendered in this scenario: {rnode.hiddenReason}</div>}

            <div className="section-title">Why this outcome</div>
            <div className="ex-explain-wrap" data-testid="exploded-explanation">
              <div className="callout accent ex-explain">{tech ? explanation.summary : plainExplanation(project, res, rnode)}</div>
              {active && <>
                <div className="ex-sub">Rules for “{active.title}”</div>
                <ul className="ex-rules">
                  {activeTrace.map((t) => {
                    const rule = project.rules.find((x) => x.id === t.ruleId);
                    const expr = describePredicate(t.expression);
                    const inputs = Object.entries(t.predicateInputs).map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(' ');
                    return (
                      <li key={t.ruleId} className="ex-rule">
                        <div className="ex-rule-head">
                          <span className="ex-rule-id mono">{t.ruleId}</span>
                          <span className="ex-rule-title" title={rule ? ruleTitle(project, rule) : t.ruleId}>{rule ? ruleTitle(project, rule) : t.ruleId}</span>
                          <span className={`chip ${outcomeChip(t.outcome)}`}>{tech ? t.outcome : OUTCOME_PLAIN[t.outcome]}</span>
                        </div>
                        {tech ? <>
                          <div className="ex-mono-line" title={expr}>{expr}</div>
                          {inputs && <div className="ex-mono-line faint" title={inputs}>{inputs}</div>}
                          {t.priority !== undefined && <div className="ex-mono-line faint">priority {t.priority}</div>}
                        </> : <div className="ex-rule-sentence">{rule ? ruleSentence(project, rule) : predicateSentence(project, t.expression)}</div>}
                      </li>
                    );
                  })}
                  {!active.candidateRuleIds.length && <li className="ex-rule muted">{active.isFallback ? 'Named fallback: used only when no rule matches.' : 'Selected by an inline condition or a section rule.'}</li>}
                </ul>
              </>}
              <Proof label="Raw trace">
                {!tech && <p className="ex-raw">{explanation.summary}</p>}
                {active && activeTrace.length > 0 && !tech && <table className="table ex-trace">
                  <thead><tr><th>Rule</th><th>Expression · inputs</th></tr></thead>
                  <tbody>
                    {activeTrace.map((t) => {
                      const expr = describePredicate(t.expression);
                      const inputs = Object.entries(t.predicateInputs).map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(' ');
                      return <tr key={t.ruleId}><td><strong>{t.ruleId}</strong><div className="muted">{t.outcome}</div></td><td><div className="ex-mono-line" title={expr}>{expr}</div><div className="ex-mono-line faint" title={inputs}>{inputs}</div></td></tr>;
                    })}
                  </tbody>
                </table>}
                <dl className="kv ex-kv"><dt>Run</dt><dd className="mono" title={res.runId}>{res.runId}</dd></dl>
              </Proof>
            </div>
            <div className="row wrap ex-actions">
              <button className="btn primary sm" data-testid="open-rule-trace" onClick={() => navigate(`/studio/${project.projectId}/rules-data?rule=${(active?.candidateRuleIds[0]) ?? winner?.ruleId ?? ''}`)}><Icon.rules width={14} height={14} /> Inspect rule</button>
              <button className="btn sm" onClick={() => navigate(`/studio/${project.projectId}/design`)} data-testid="edit-variant"><Icon.design width={14} height={14} /> Edit variant</button>
            </div>
            {active && reach && <>
              <div className="section-title">Reach · seeded records</div>
              <dl className="kv ex-kv">
                <dt>Seeded records</dt><dd>{activeReach?.count ?? 0} of {totalSeeded}</dd>
                <dt>Top personas</dt><dd className="ex-prose">{activeReach?.personas.slice(0, 3).map(([p, c]) => `${personaShort(p)} (${c})`).join(', ') || 'None'}</dd>
              </dl>
              {previewRecord && <button className="btn sm ex-preview" onClick={() => setRecord(previewRecord)} title={`Switch the scenario to ${previewRecord}`}><Icon.eye width={14} height={14} /> Preview as {previewRecord}</button>}
            </>}
          </div>
        </aside>
      </div>
      {compare && <CompareDialog project={project} res={res} node={rnode} ids={compare} tech={tech} onChange={setCompare} onClose={() => setCompare(null)} />}
    </section>
  );
}

function VariantCard({ v, st, reach, totalSeeded, active, onChoose, project, res, tech, flat, zIndex, compact }: { v: RVariant; st: PanelState; reach?: Reach; totalSeeded: number; active: boolean; onChoose?: () => void; project: Project; res: Resolution; tech: boolean; flat?: boolean; zIndex?: number; compact?: boolean }) {
  const traceRules = v.candidateRuleIds.map((id) => res.trace.find((t) => t.ruleId === id)).filter((t): t is TraceEntry => !!t);
  const count = reach?.count ?? 0, tot = reach?.total ?? totalSeeded;
  const pct = Math.round((100 * count) / Math.max(1, tot));
  return (
    <div className={`ex-card${flat ? ' flat' : ''}${compact ? ' compact' : ''}${active ? ' is-active' : ''} st-${st}`} role={flat ? 'listitem' : undefined} onClick={flat ? onChoose : undefined}>
      <div className="ex-card-head">
        {zIndex && <span className="ex-z" aria-hidden="true">Z{zIndex}</span>}
        <span className="ex-card-title" title={v.title}>{v.title}</span>
        <span className={`ex-state st-${st}`}><span aria-hidden="true">{STATE_MARK[st]} </span>{STATE_SHORT[st]}</span>
      </div>
      <div className="ex-paperlet" dangerouslySetInnerHTML={{ __html: blocksHtml(v.text) }} />
      <div className="ex-chips">
        {traceRules.map((t) => {
          const rule = project.rules.find((x) => x.id === t.ruleId);
          const raw = describePredicate(t.expression);
          const plain = predicateSentence(project, t.expression);
          const label = tech ? raw : plain.charAt(0).toUpperCase() + plain.slice(1);
          return <span key={t.ruleId} className={`chip ex-rule-chip ${t.matched ? outcomeChip(t.outcome) || 'variant' : ''}${tech ? ' is-raw' : ''}`} title={`${t.ruleId}: ${rule ? ruleSentence(project, rule) : plain}${tech ? `\n${raw}` : ''}`}><b>{t.ruleId}</b><span className="ex-chip-text">{label}</span></span>;
        })}
        {v.isFallback && <span className="chip">fallback</span>}
        {v.missingLocale && <span className="chip warning">translation missing</span>}
        {v.source === 'section-rule' && <span className="chip info">section rule</span>}
      </div>
      <div className="ex-reach">
        <span className="ex-reach-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        <span>{reach || totalSeeded ? `${count} of ${tot} seeded records · ${pct}%` : 'Reach —'}</span>
        {tech && v.contentVersion !== null && <span className="mono faint">v{v.contentVersion}</span>}
      </div>
    </div>
  );
}

function CompareDialog({ project, res, node, ids, tech, onChange, onClose }: { project: Project; res: Resolution; node: RNode; ids: string[]; tech: boolean; onChange: (ids: string[]) => void; onClose: () => void }) {
  const items = node.variants?.items ?? [];
  const pick = (i: number, id: string) => onChange(ids.map((x, j) => (j === i ? id : x)));
  return (
    <Dialog title={<>Compare alternatives · {nodeTitle(project, node.id)}</>} onClose={onClose}>
      <div className="ex-compare">
        {ids.map((id, i) => {
          const v = items.find((x) => x.id === id)!;
          return (
            <div key={i} className="ex-compare-col">
              <select className="select" value={id} onChange={(e) => pick(i, e.target.value)} aria-label={`Alternative ${i + 1}`}>{items.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>
              <div className="ex-paperlet big" dangerouslySetInnerHTML={{ __html: blocksHtml(v.text) }} />
              <dl className="kv ex-kv">
                {tech && <><dt>Content</dt><dd className="mono" title={`${v.id}@v${v.contentVersion}`}>{v.id}@v{v.contentVersion}</dd></>}
                <dt>State</dt><dd>{STATE_LABEL[stateOf(v, !!node.variants?.unresolved)]}</dd>
                <dt>Rules</dt><dd>{v.candidateRuleIds.join(', ') || (v.isFallback ? 'fallback' : '—')}</dd>
              </dl>
              {v.candidateRuleIds.map((rid) => {
                const r = project.rules.find((x) => x.id === rid);
                if (!r) return null;
                return tech
                  ? <div key={rid} className="ex-mono-line" title={describePredicate(r.when)}>{rid} (p{r.priority}): {describePredicate(r.when)}</div>
                  : <p key={rid} className="ex-rule-sentence">{ruleSentence(project, r)}</p>;
              })}
            </div>
          );
        })}
      </div>
      <Proof label="Run"><p className="muted ex-raw">Run <span className="mono">{res.runId}</span></p></Proof>
      <p className="muted ex-raw">Comparing never changes the model; edit content in the designer.</p>
    </Dialog>
  );
}
