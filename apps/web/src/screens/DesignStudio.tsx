import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import { LibraryBlockButton } from './library/InsertBlock';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { COMPONENT_CATALOG, CATALOG_BY_TYPE, defaultNode, dropRejection, effectivePageDesign, newNodeId, nodeMap, PAPER_SIZES, pagedProfileOf, parentOf, type ComponentType, type DocNode, type PageTemplateId, type Project } from '@iss/model';
import { renderInteractiveHtml } from '@iss/renderers';
import type { RNode, Resolution } from '@iss/resolver';
import { useResolution, useStudio } from '../state/store';
import { ScreenHeader, Tech, Named } from '../ui/common';
import { nodeTitle } from '../ui/plain';
import { C, Icon } from '../ui/icons';
import { PagePreview, PT, type NodeInteraction } from '../doc/PagePreview';
import { Inspector } from './design/Inspector';
import { PagePanel, PageZones, TemplateSwitch } from './design/PageDesign';
import { RichTextEditor } from './design/RichTextEditor';
import { StylesBrandDialog } from './design/StylesBrand';
import './DesignStudio.css';
import { useVariantMarks } from './variants/useVariant'; // variants (wave 5)

const SCROLL_PAD_X = 20, SCROLL_PAD_Y = 16;
type Drag = { kind: 'component'; type: ComponentType } | { kind: 'node'; id: string };
type Mark = { id: string; pos: 'before' | 'after' | 'into' };
const INTO_TYPES = new Set(['disclosure', 'header-footer', 'variant-set', 'conditional-region', 'container']);

let dragging: Drag | null = null;

const LS_HIDDEN = 'iss.design.showHidden';
const LS_HINT = 'iss.design.pullHintSeen';
const LS_PALETTE = 'iss.paletteCollapsed';
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

function plan(project: Project, targetId: string, mark: Mark['pos'], drag: Drag): { parentId: string; index: number } | { reject: string } {
  const type: ComponentType = drag.kind === 'component' ? drag.type : nodeMap(project).get(drag.id)!.type;
  if (mark === 'into') {
    const why = dropRejection(project, targetId, type);
    if (why) return { reject: why };
    return { parentId: targetId, index: nodeMap(project).get(targetId)?.children?.length ?? 0 };
  }
  const parent = parentOf(project, targetId);
  if (!parent) return { reject: 'Cannot place a component outside the document.' };
  const why = dropRejection(project, parent.id, type);
  if (why) return { reject: why };
  let index = parent.children!.indexOf(targetId) + (mark === 'after' ? 1 : 0);
  if (drag.kind === 'node') {
    if (drag.id === targetId) return { reject: 'Drop position unchanged.' };
    const cur = parent.children!.indexOf(drag.id);
    if (cur >= 0 && cur < index) index -= 1;
  }
  return { parentId: parent.id, index };
}

export function DesignStudio() {
  const navigate = useNavigate();
  const project = useStudio((s) => s.project)!;
  const ctx = useStudio((s) => s.ctx);
  const res = useResolution();
  const { dispatch, select, toast } = useStudio.getState();
  const [leftTab, setLeftTab] = useState<'palette' | 'layers'>('palette');
  // Variants (wave 5): components that differ from the base carry a mark; the inspector says what stays the base's.
  const variantMarks = useVariantMarks(project);
  // "Open it in the base" (from a variant) lands here with ?node=<id>: select that component once.
  const [search] = useSearchParams();
  const askedNode = search.get('node');
  useEffect(() => { if (askedNode && project.nodes.some((n) => n.id === askedNode)) useStudio.getState().select(askedNode); }, [askedNode, project.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [paletteQuery, setPaletteQuery] = useState('');
  const [mark, setMark] = useState<Mark | null>(null);
  const [reject, setReject] = useState<{ nodeId: string; reason: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transient, setTransient] = useState<NodeInteraction['transient']>({});
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitMode, setFitMode] = useState<'width' | 'page'>('width');
  const [stylesOpen, setStylesOpen] = useState(false);
  const [grid, setGrid] = useState(false);
  const [snap, setSnap] = useState(true);
  const [device, setDevice] = useState<1200 | 768 | 390>(1200);
  const [showHidden, setShowHidden] = useState(() => lsGet(LS_HIDDEN) === '1');
  // Page design: which page template the canvas shows, and whether the Page panel replaces the inspector.
  const [pageTemplateRaw, setPageTemplate] = useState<PageTemplateId>('first');
  const [pagePanel, setPagePanel] = useState(false);
  const design = useMemo(() => effectivePageDesign(pagedProfileOf(project)), [project]);
  const pageTemplate: PageTemplateId = pageTemplateRaw === 'last' && !design.last ? 'first' : pageTemplateRaw;
  const PAGE_W_PT = design.widthPt, PAGE_H_PT = design.heightPt;
  // The component list starts closed on laptop-sized windows (under 1500px) so the page shows near full size; an explicit choice is remembered and wins.
  const [paletteCollapsed, setPaletteCollapsed] = useState(() => { const v = lsGet(LS_PALETTE); return v === '1' || (v !== '0' && typeof window !== 'undefined' && window.innerWidth < 1500); });
  const [hintSeen, setHintSeen] = useState(() => lsGet(LS_HINT) === '1');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 700, h: 600 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!res]);
  // Fit: page width by default (readable text, scroll vertically); "Whole page" shows the full sheet. Recomputed from the measured canvas.
  const availW = Math.max(200, box.w - 2 * SCROLL_PAD_X), availH = Math.max(200, box.h - 2 * SCROLL_PAD_Y);
  const fitW = availW / (PAGE_W_PT * PT), fitPage = availH / (PAGE_H_PT * PT);
  const fit = Math.max(0.4, Math.min(1.15, fitMode === 'page' ? Math.min(fitW, fitPage) : fitW));
  const scale = zoom ?? fit;
  const selected = ctx.selectedNodeId;
  const map = useMemo(() => nodeMap(project), [project]);
  const selNode = selected ? map.get(selected) : undefined;
  // Never open the inspector empty: show the most useful component (first variant/conditional section, else first block) without touching the shared selection.
  const inspectNodeId = useMemo(() => {
    if (selected && map.has(selected)) return selected;
    const kids = (map.get(project.rootNodeId)?.children ?? []).map((id) => map.get(id)).filter((n): n is DocNode => !!n);
    return (kids.find((n) => n.type === 'variant-set' || n.type === 'conditional-region') ?? kids[0])?.id ?? null;
  }, [selected, map, project.rootNodeId]);
  const isHtml = ctx.profileId === 'html-responsive';

  useEffect(() => { if (reject) { const t = setTimeout(() => setReject(null), 4500); return () => clearTimeout(t); } }, [reject]);

  /* -------------------------------------------------------- insertion */
  const insert = useCallback((type: ComponentType, parentId: string, index?: number, fixedAt?: { x: number; y: number }) => {
    const id = newNodeId(type, new Set(map.keys()));
    const node: DocNode = defaultNode(type, id, project.documentType, project);
    if (fixedAt) node.layout = { ...node.layout, paged: { mode: 'fixed', xPt: Math.round(Math.min(PAGE_W_PT - 170, Math.max(0, fixedAt.x))), yPt: Math.round(Math.min(PAGE_H_PT - 50, Math.max(0, fixedAt.y))), wPt: 160, hPt: 40, pages: pageTemplate === 'first' ? 'first' : pageTemplate } };
    const r = dispatch({ type: 'INSERT_NODE', node, parentId, index });
    if (r.ok) { select(id); toast({ kind: 'success', title: `${CATALOG_BY_TYPE[type].label} inserted`, message: `${id} added to ${parentId}. One undo step.` }); }
    else setReject({ nodeId: parentId, reason: r.message });
    return r;
  }, [map, project, dispatch, select, toast, PAGE_W_PT, PAGE_H_PT, pageTemplate]);

  const insertViaKeyboard = (type: ComponentType) => {
    // Keyboard alternative to drag: insert after the selected flow node (or into a selected section).
    const target = selNode;
    if (target?.type === 'container') return insert(type, target.id);
    if (target && target.id !== project.rootNodeId) {
      const p = parentOf(project, target.id);
      if (p) return insert(type, p.id, p.children!.indexOf(target.id) + 1);
    }
    return insert(type, project.rootNodeId);
  };

  /* -------------------------------------------------------- canvas DnD */
  const markFor = (id: string, e: DragEvent<HTMLDivElement>): Mark => {
    const node = map.get(id)!;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const parent = parentOf(project, id);
    const row = parent?.layout?.paged?.direction === 'row';
    const f = row ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    if (INTO_TYPES.has(node.type) && f > 0.22 && f < 0.78) return { id, pos: 'into' };
    return { id, pos: f < 0.5 ? 'before' : 'after' };
  };
  const ia: NodeInteraction = {
    selectedId: selected,
    editable: !isHtml,
    dropMark: mark,
    dropReject: reject,
    editingId,
    transient,
    onSelect: (id) => { if (editingId && editingId !== id) setEditingId(null); setPagePanel(false); select(id); },
    onDoubleClick: (id) => { if (map.get(id)?.type === 'rich-text') { select(id); setEditingId(id); } },
    onNodeDragStart: (id, e) => { dragging = { kind: 'node', id }; e.dataTransfer.setData('application/x-iss-node', id); e.dataTransfer.effectAllowed = 'move'; select(id); },
    onDragOverNode: (id, e) => {
      if (!dragging) return;
      e.preventDefault();
      const m = markFor(id, e);
      const p = plan(project, id, m.pos, dragging);
      if ('reject' in p) { setReject({ nodeId: m.pos === 'into' ? id : (parentOf(project, id)?.id ?? id), reason: p.reject }); setMark(null); }
      else { setReject(null); setMark(m); e.dataTransfer.dropEffect = dragging.kind === 'node' ? 'move' : 'copy'; }
    },
    onDropNode: (id, e) => {
      e.preventDefault();
      const d = dragging; dragging = null; setMark(null);
      if (!d) return;
      const m = markFor(id, e);
      const p = plan(project, id, m.pos, d);
      if ('reject' in p) {
        setReject({ nodeId: m.pos === 'into' ? id : (parentOf(project, id)?.id ?? id), reason: p.reject });
        useStudio.setState({ lastRejection: { code: 'INVALID_DROP_TARGET', message: p.reject, nodeId: id, at: Date.now() } });
        toast({ kind: 'error', title: 'Drop blocked — model unchanged', message: p.reject });
        return;
      }
      setReject(null);
      if (d.kind === 'component') insert(d.type, p.parentId, p.index);
      else dispatch({ type: 'MOVE_NODE', nodeId: d.id, parentId: p.parentId, index: p.index });
    },
    onNodePointerDown: (id, e, handle) => {
      const node = map.get(id);
      if (!node || node.locked) { if (node?.locked) toast({ kind: 'warning', title: `${id} is locked` }); return; }
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, pl: { ...(node.layout?.paged ?? { mode: 'flow' as const }) } };
      const unit = PT * scale;
      const snapTo = (v: number) => (snap ? Math.round(v / 2) * 2 : Math.round(v));
      const flowW = design.first.flow.wPt;
      let last: any = null;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / unit, dy = (ev.clientY - start.y) / unit;
        if (handle === 'move') last = { xPt: snapTo(Math.max(0, Math.min(PAGE_W_PT - (start.pl.wPt ?? 0), (start.pl.xPt ?? 0) + dx))), yPt: snapTo(Math.max(0, Math.min(PAGE_H_PT - (start.pl.hPt ?? 0), (start.pl.yPt ?? 0) + dy))) };
        else if (handle === 'resize') last = { wPt: snapTo(Math.max(8, Math.min(PAGE_W_PT - (start.pl.xPt ?? 0), (start.pl.wPt ?? 100) + dx))), hPt: snapTo(Math.max(4, Math.min(PAGE_H_PT - (start.pl.yPt ?? 0), (start.pl.hPt ?? 20) + dy))) };
        else if (handle === 'flow-width') last = { widthPct: Math.max(10, Math.min(100, Math.round(((start.pl.widthPct ?? 100) + (dx / flowW) * 100) / 5) * 5)) };
        setTransient({ [id]: last });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setTransient({});
        if (last) dispatch({ type: 'SET_LAYOUT', nodeId: id, profile: 'paged', layout: last });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    hiddenMode: showHidden ? 'ghost' : 'marker',
    renderEditor: (n: RNode) => (
      <RichTextEditor
        value={map.get(n.id)?.content}
        onCommit={(doc) => { setEditingId(null); dispatch({ type: 'UPDATE_NODE', nodeId: n.id, patch: { content: doc } }); }}
        onCancel={() => setEditingId(null)}
      />
    ),
    renderAdornment: (n) => (n.type === 'variant-set' || n.type === 'conditional-region') ? (
      <button className="pull-handle" aria-label="Pull out alternatives into 2.5D" title="Pull out alternatives (Exploded Document)" onClick={(e) => { e.stopPropagation(); navigate(`/studio/${project.projectId}/exploded/${n.id}`); }}>
        <Icon.explode width={16} height={16} />
      </button>
    ) : null,
  };

  const onPageDragOver = (e: DragEvent<HTMLDivElement>, region: 'fixed' | 'flow') => {
    if (!dragging) return;
    e.preventDefault();
    setMark(null);
    if (dragging.kind === 'component' && region === 'fixed') { setReject(null); e.dataTransfer.dropEffect = 'copy'; }
  };
  const onPageDrop = (e: DragEvent<HTMLDivElement>, region: 'fixed' | 'flow', x: number, y: number) => {
    e.preventDefault();
    const d = dragging; dragging = null; setMark(null);
    if (!d) return;
    if (d.kind === 'component') {
      if (region === 'fixed') insert(d.type, project.rootNodeId, undefined, { x, y });
      else insert(d.type, project.rootNodeId);
    } else {
      const root = map.get(project.rootNodeId)!;
      dispatch({ type: 'MOVE_NODE', nodeId: d.id, parentId: root.id, index: root.children!.length });
    }
  };

  /* -------------------------------------------------------- keyboard */
  const onCanvasKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (editingId || !selNode) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    const pl = selNode.layout?.paged;
    const step = e.shiftKey ? 10 : 1;
    const parent = parentOf(project, selNode.id);
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); dispatch({ type: 'DELETE_NODE', nodeId: selNode.id }); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); dispatch({ type: 'DUPLICATE_NODE', nodeId: selNode.id, newId: `${selNode.id.slice(0, 40)}-copy-${Date.now().toString(36).slice(-4)}` }); return; }
    if (e.key === 'Enter' && selNode.type === 'rich-text') { e.preventDefault(); setEditingId(selNode.id); return; }
    if (e.key === 'Escape') { select(null); return; }
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault();
    if (pl?.mode === 'fixed') {
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      dispatch({ type: 'SET_LAYOUT', nodeId: selNode.id, profile: 'paged', layout: { xPt: Math.max(0, (pl.xPt ?? 0) + dx), yPt: Math.max(0, (pl.yPt ?? 0) + dy) } });
    } else if (e.altKey && parent && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const i = parent.children!.indexOf(selNode.id) + (e.key === 'ArrowUp' ? -1 : 1);
      if (i >= 0 && i < parent.children!.length) dispatch({ type: 'MOVE_NODE', nodeId: selNode.id, parentId: parent.id, index: i });
    } else if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      dispatch({ type: 'SET_LAYOUT', nodeId: selNode.id, profile: 'paged', layout: { widthPct: Math.max(10, Math.min(100, (pl?.widthPct ?? 100) + (e.key === 'ArrowLeft' ? -5 : 5))) } });
    } else if (parent && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const i = parent.children!.indexOf(selNode.id) + (e.key === 'ArrowUp' ? -1 : 1);
      const sib = parent.children![i];
      if (sib) select(sib);
    }
  };

  if (!res) return <section className="screen" data-testid="design-canvas"><ScreenHeader id="S02" title="Design Studio" subtitle="Select a synthetic record that matches this project." /></section>;
  const palette = COMPONENT_CATALOG.filter((c) => !paletteQuery || c.label.toLowerCase().includes(paletteQuery.toLowerCase()) || c.code.toLowerCase().includes(paletteQuery.toLowerCase()));
  const canExplode = selNode && (selNode.type === 'variant-set' || selNode.type === 'conditional-region');
  let hiddenCount = 0;
  const countHidden = (n: RNode, parentVisible: boolean) => { if (!n.visible && parentVisible) hiddenCount++; n.children.forEach((c) => countHidden(c, n.visible)); };
  countHidden(res.root, true);
  const emptyPage = (map.get(project.rootNodeId)?.children?.length ?? 0) === 0;
  /** "Add your first component": opens the component list (and puts the cursor in its search). */
  const openComponentList = () => {
    setLeftTab('palette');
    if (paletteCollapsed) { setPaletteCollapsed(false); lsSet(LS_PALETTE, '0'); }
    setTimeout(() => document.querySelector<HTMLElement>('[data-testid="component-palette"] input')?.focus(), 60);
  };
  const togglePalette = () => { const v = !paletteCollapsed; setPaletteCollapsed(v); lsSet(LS_PALETTE, v ? '1' : '0'); };
  const toggleHidden = () => { const v = !showHidden; setShowHidden(v); lsSet(LS_HIDDEN, v ? '1' : '0'); };
  const dismissHint = () => { setHintSeen(true); lsSet(LS_HINT, '1'); };
  const goExplode = () => { dismissHint(); navigate(`/studio/${project.projectId}/exploded/${selNode!.id}`); };

  return (
    <section className="screen design" aria-label="Design Studio">
      <ScreenHeader id="S02" title="Design Studio" subtitle="Edit accurate page geometry and responsive profiles on one semantic component tree. Every edit is a typed, undoable model command. Select a variant or conditional section and use its pull handle, or Explore variants, to open the Exploded view."
        actions={<>
          <button className="btn" onClick={() => setStylesOpen(true)} data-testid="open-styles" title="Text styles and brand kit">Styles & brand</button>
          <button className="btn primary" disabled={!canExplode} onClick={goExplode} data-testid="explore-variants" title={canExplode ? 'Open the selected section in the Exploded view' : 'Select a variant set or conditional section first'}><Icon.exploded /> Explore variants</button>
        </>}
      />
      <div className={`screen-body workbench${paletteCollapsed ? ' no-left' : ''}`}>
        {!paletteCollapsed && (
        <aside className="panel ds-left" aria-label="Components and layers" data-side="left" data-side-title="Components">
          <div className="ds-left-head">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={leftTab === 'palette'} onClick={() => setLeftTab('palette')}>Components</button>
              <button role="tab" aria-selected={leftTab === 'layers'} onClick={() => setLeftTab('layers')}>Layers</button>
            </div>
            <button className="btn sm ghost icon ds-collapse" onClick={togglePalette} aria-expanded={true} aria-label="Hide components and layers" title="Hide the component list and layer tree to give the page more room" data-testid="toggle-palette"><Icon.chevron width={14} height={14} style={{ transform: 'rotate(180deg)' }} /></button>
          </div>
          {leftTab === 'palette' ? (
            <div className="panel-body" data-testid="component-palette">
              <input className="input ds-search" placeholder={`Search ${COMPONENT_CATALOG.length} components…`} value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)} aria-label="Search components" />
              <ul className="palette list-rows" aria-label="Component palette (drag onto the page, or press Insert)">
                {palette.map((c) => {
                  const Ico = C[c.type];
                  return (
                    <li key={c.type}>
                      <div className="palette-item" draggable onDragStart={(e) => { dragging = { kind: 'component', type: c.type }; e.dataTransfer.setData('application/x-iss-component', c.type); e.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={() => { dragging = null; setMark(null); }} data-testid={`palette-${c.type}`} title={`${c.description} (${c.code}${c.deep ? ', deep' : ''})`}>
                        <span className="palette-icon"><Ico width={14} height={14} /></span>
                        <span className="palette-label grow">{c.label}<Tech><span className="palette-code">{c.code}</span></Tech></span>
                        <button className="btn sm ghost icon" onClick={() => insertViaKeyboard(c.type)} aria-label={`Insert ${c.label}`} title={`Insert ${c.label} after the selection`} data-testid={`insert-${c.type}`}><Icon.plus width={14} height={14} /></button>
                      </div>
                    </li>
                  );
                })}
                {!palette.length && <li className="muted" style={{ fontSize: 12 }}>No component matches “{paletteQuery}”.</li>}
              </ul>
              <p className="muted palette-note">Drag onto the page, or use + to insert after the selection.</p>
              <LibraryBlockButton project={project} selectedId={selected} />
            </div>
          ) : (
            <div className="panel-body flush" data-testid="layers-tree"><LayersTree project={project} res={res} selected={selected} onSelect={(id) => select(id)} marks={variantMarks} /></div>
          )}
        </aside>
        )}

        <div className="design-stage">
          <div className="ds-toolbar" role="toolbar" aria-label="Canvas">
            {paletteCollapsed && <button className="btn sm" onClick={togglePalette} aria-expanded={false} aria-label="Show components and layers" title="Show the component list and the layer tree" data-testid="toggle-palette"><Icon.chevron width={14} height={14} /> Components &amp; layers</button>}
            <span className="chip count" title={isHtml ? 'Interactive HTML profile' : `${PAPER_SIZES[design.paper].label} ${design.orientation} · paged profile · ${pageTemplate === 'first' ? 'page 1 of the composed document' : `the ${pageTemplate} page template`}`} data-testid="canvas-paper">{isHtml ? 'Interactive HTML' : `${pageTemplate === 'first' ? 'Page 1' : pageTemplate === 'following' ? 'Following' : 'Last'} · ${design.paper === 'US-Letter' ? 'Letter' : PAPER_SIZES[design.paper].label}${design.orientation === 'landscape' ? ' landscape' : ''}`}</span>
            {!isHtml && <>
              <TemplateSwitch project={project} template={pageTemplate} onTemplate={setPageTemplate} compact />
              <button className="btn sm ds-page-btn" aria-pressed={pagePanel} onClick={() => setPagePanel(!pagePanel)} data-testid="open-page-panel" title="Paper, margins, page templates, columns and backgrounds">Page setup</button>
              <div className="segmented ds-group" role="group" aria-label="Zoom">
                <button aria-label="Zoom out" onClick={() => setZoom(Math.max(0.4, scale - 0.1))}>−</button>
                <span className="ds-zoom" data-testid="zoom-value" title={zoom === null ? (fitMode === 'page' ? 'Fit: whole page' : 'Fit: page width') : 'Manual zoom'} aria-live="polite">{Math.round(scale * 100)}%</span>
                <button aria-label="Zoom in" onClick={() => setZoom(Math.min(1.6, scale + 0.1))}>+</button>
                <button aria-pressed={zoom === null && fitMode === 'width'} onClick={() => { setFitMode('width'); setZoom(null); }} title="Fit the page width (scroll down for the rest)" data-testid="fit-width">Width</button>
                <button aria-pressed={zoom === null && fitMode === 'page'} onClick={() => { setFitMode('page'); setZoom(null); }} title="Show the whole page" data-testid="fit-page">Page</button>
              </div>
              <div className="segmented ds-group" role="group" aria-label="Canvas options">
                <button aria-pressed={grid} onClick={() => setGrid(!grid)}>Grid</button>
                <button aria-pressed={snap} onClick={() => setSnap(!snap)} title="Snap moves and resizes to 2 pt">Snap</button>
                <button aria-pressed={showHidden} onClick={toggleHidden} data-testid="toggle-hidden-sections" aria-label="Show hidden sections" title={`Show hidden sections as ghosts in the page (${hiddenCount} hidden for this customer). Off: shown as ⊘ margin markers.`}>⊘ Hidden{hiddenCount ? ` · ${hiddenCount}` : ''}</button>
              </div>
            </>}
            {isHtml && <div className="segmented" role="group" aria-label="Device shape and width">{([[390, 'phone', 'Phone'], [768, 'tablet', 'Tablet'], [1200, 'desktop', 'Desktop']] as const).map(([w, id, label]) => <button key={w} aria-pressed={device === w} onClick={() => setDevice(w)} title={`${label} · ${w}px wide`} data-testid={`html-device-${id}`}>{label}</button>)}</div>}
            <span style={{ flex: 1, order: 7 }} />
            {canExplode && !hintSeen && <span className="ds-break" />}
            {canExplode && !hintSeen && (
              <span className="chip variant ds-hint" role="status">
                Pull handle on <Named name={nodeTitle(project, selNode!.id)} code={selNode!.id} /> opens the Exploded view
                <button className="ds-hint-x" aria-label="Dismiss hint" onClick={dismissHint}>✕</button>
              </span>
            )}
          </div>
          <div className="design-scroll" ref={scrollRef} data-testid="design-canvas" tabIndex={0} onKeyDown={onCanvasKey} aria-label="Page canvas. Arrow keys move fixed anchors (Shift = 10 pt), Alt+arrows reorder flow components, Delete removes, Enter edits text." onClick={() => { setEditingId(null); }}>
            {emptyPage && (
              <div className="ds-empty" data-testid="design-empty" role="status" onClick={(e) => e.stopPropagation()}>
                <strong>This page is empty</strong>
                <span>Add a heading, a field with your customer’s data, a table or a message. Everything you add can use the data fields of this document.</span>
                <button className="btn primary" onClick={openComponentList} data-testid="design-empty-add"><Icon.plus /> Add your first component</button>
              </div>
            )}
            {isHtml ? <HtmlProfileCanvas res={res} project={project} width={device} selected={selected} onSelect={(id) => select(id)} />
              : <PagePreview res={res} project={project} scale={scale} ia={ia} showGrid={grid} onPageDragOver={onPageDragOver} onPageDrop={onPageDrop} onBackgroundClick={() => { setEditingId(null); }} template={pageTemplate}
                  overlay={pagePanel ? <PageZones project={project} template={pageTemplate} scale={scale} snap={snap} /> : null} />}
          </div>
        </div>

        {stylesOpen && <StylesBrandDialog onClose={() => setStylesOpen(false)} />}
        {pagePanel && !isHtml
          ? <PagePanel project={project} template={pageTemplate} onTemplate={setPageTemplate} onSelectNode={(id) => { setPagePanel(false); select(id); }} onClose={() => setPagePanel(false)} />
          : <Inspector project={project} res={res} nodeId={inspectNodeId} onEditText={(id) => { select(id); setEditingId(id); }} variantMarks={variantMarks} />}
      </div>
    </section>
  );
}


function LayersTree({ project, res, selected, onSelect, marks }: { project: Project; res: Resolution; selected: string | null; onSelect: (id: string) => void; marks?: Map<string, string[]> }) {
  const map = nodeMap(project);
  const visible = useMemo(() => { const m = new Map<string, boolean>(); const walk = (n: RNode) => { m.set(n.id, n.visible); n.children.forEach(walk); }; walk(res.root); return m; }, [res]);
  const render = (id: string, depth: number): JSX.Element | null => {
    const n = map.get(id);
    if (!n) return null;
    const Ico = C[n.type];
    return (
      <li key={id} role="treeitem" aria-selected={selected === id} aria-expanded={n.children?.length ? true : undefined}>
        <button className={`layer${selected === id ? ' active' : ''}${visible.get(id) === false ? ' hidden-node' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(id)} data-testid={`layer-${id}`}
          onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const all = Array.from(document.querySelectorAll<HTMLButtonElement>('.layer')); const i = all.indexOf(e.currentTarget); all[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); } }}>
          <Ico width={15} height={15} />
          <span className="grow layer-name" title={n.id}><Named name={n.name ?? nodeTitle(project, n.id)} code={n.id} /></span>
          {n.layout?.paged?.mode === 'fixed' && <span className="chip">fixed</span>}
          {(n.type === 'variant-set' || n.type === 'conditional-region') && <span className="chip count">{n.variantIds?.length ?? 0}</span>}
          {visible.get(id) === false && <span className="chip" title="Hidden for this customer: no rule or condition shows it">hidden</span>}
          {marks?.has(id) && <span className="chip variant vr-mark" title={`Differs from the base: ${marks.get(id)!.join('; ')}`} data-testid={`layer-differs-${id}`}>differs</span>}
        </button>
        {n.children?.length ? <ul role="group">{n.children.map((c) => render(c, depth + 1))}</ul> : null}
      </li>
    );
  };
  return <ul className="layers" role="tree" aria-label="Document layers">{render(project.rootNodeId, 0)}</ul>;
}

function HtmlProfileCanvas({ res, project, width, selected, onSelect }: { res: Resolution; project: Project; width: number; selected: string | null; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => renderInteractiveHtml(res, project), [res, project]);
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    const onLoad = () => {
      const doc = f.contentDocument;
      if (!doc) return;
      const style = doc.createElement('style');
      const sel = getComputedStyle(document.documentElement).getPropertyValue('--iss-green-medium').trim() || 'currentColor';
      style.textContent = `[data-node-id]{cursor:pointer}[data-node-id].iss-sel{outline:3px solid ${sel};outline-offset:3px;border-radius:12px}`;
      doc.head.appendChild(style);
      doc.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest('[data-node-id]');
        if (el && !(e.target as HTMLElement).closest('a,button,input,summary')) { e.preventDefault(); onSelect(el.getAttribute('data-node-id')!); }
      });
      doc.querySelectorAll(`[data-node-id="${selected}"]`).forEach((el) => el.classList.add('iss-sel'));
    };
    f.addEventListener('load', onLoad);
    return () => f.removeEventListener('load', onLoad);
  }, [html, selected, onSelect]);
  // Device frame: the page keeps the device's true CSS width (so breakpoints behave), is scaled down to fit and scrolls inside the frame.
  const holder = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 1200, h: 800 });
  useEffect(() => {
    const el = holder.current?.parentElement;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el); measure();
    return () => ro.disconnect();
  }, []);
  const kind = width === 390 ? 'phone' : width === 768 ? 'tablet' : 'desktop';
  const bezel = kind === 'desktop' ? 0 : kind === 'phone' ? 12 : 14;
  const barH = kind === 'desktop' ? 34 : 0;
  const scale = Math.min(1, Math.max(0.3, (box.w - 40 - bezel * 2 - 2) / width));
  const screenH = Math.round(Math.min(kind === 'phone' ? 800 : 1000, Math.max(420, box.h - 32 - barH - bezel * 2 - 4)));
  return (
    <div className={`html-canvas html-dev html-dev--${kind}`} ref={holder} data-device={kind} style={{ padding: bezel }}>
      {kind === 'desktop' && <div className="html-dev-bar" aria-hidden="true"><i /><i /><i /><span>Interactive HTML · {width}px wide</span></div>}
      {kind === 'phone' && <span className="html-dev-notch" aria-hidden="true" />}
      <div className="html-dev-screen" style={{ width: width * scale, height: screenH }}>
        <iframe ref={ref} title="Interactive HTML profile preview" srcDoc={html} sandbox="allow-scripts allow-same-origin" style={{ width, height: screenH / scale, transform: `scale(${scale})`, transformOrigin: '0 0' }} data-testid="html-profile-frame" />
      </div>
    </div>
  );
}
