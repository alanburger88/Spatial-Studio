import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { COMPONENT_CATALOG, CATALOG_BY_TYPE, defaultNode, dropRejection, newNodeId, nodeMap, parentOf, type ComponentType, type DocNode, type Project } from '@iss/model';
import { renderInteractiveHtml } from '@iss/renderers';
import type { RNode, Resolution } from '@iss/resolver';
import { useResolution, useStudio } from '../state/store';
import { ScreenHeader } from '../ui/common';
import { C, Icon } from '../ui/icons';
import { PagePreview, PT, PAGE_W_PT, type NodeInteraction } from '../doc/PagePreview';
import { Inspector } from './design/Inspector';
import { RichTextEditor } from './design/RichTextEditor';
import './DesignStudio.css';

type Drag = { kind: 'component'; type: ComponentType } | { kind: 'node'; id: string };
type Mark = { id: string; pos: 'before' | 'after' | 'into' };
const INTO_TYPES = new Set(['disclosure', 'header-footer', 'variant-set', 'conditional-region', 'container']);

let dragging: Drag | null = null;

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
  const [paletteQuery, setPaletteQuery] = useState('');
  const [mark, setMark] = useState<Mark | null>(null);
  const [reject, setReject] = useState<{ nodeId: string; reason: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transient, setTransient] = useState<NodeInteraction['transient']>({});
  const [zoom, setZoom] = useState<number | null>(null);
  const [grid, setGrid] = useState(false);
  const [snap, setSnap] = useState(true);
  const [device, setDevice] = useState<1200 | 768 | 390>(1200);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(900);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = Math.max(0.5, Math.min(1.15, (stageW - 64) / (PAGE_W_PT * PT)));
  const scale = zoom ?? fit;
  const selected = ctx.selectedNodeId;
  const map = useMemo(() => nodeMap(project), [project]);
  const selNode = selected ? map.get(selected) : undefined;
  const isHtml = ctx.profileId === 'html-responsive';

  useEffect(() => { if (reject) { const t = setTimeout(() => setReject(null), 4500); return () => clearTimeout(t); } }, [reject]);

  /* -------------------------------------------------------- insertion */
  const insert = useCallback((type: ComponentType, parentId: string, index?: number, fixedAt?: { x: number; y: number }) => {
    const id = newNodeId(type, new Set(map.keys()));
    const node: DocNode = defaultNode(type, id, project.documentType);
    if (fixedAt) node.layout = { ...node.layout, paged: { mode: 'fixed', xPt: Math.round(Math.min(612 - 170, Math.max(0, fixedAt.x))), yPt: Math.round(Math.min(792 - 50, Math.max(0, fixedAt.y))), wPt: 160, hPt: 40, pages: 'first' } };
    const r = dispatch({ type: 'INSERT_NODE', node, parentId, index });
    if (r.ok) { select(id); toast({ kind: 'success', title: `${CATALOG_BY_TYPE[type].label} inserted`, message: `${id} added to ${parentId}. One undo step.` }); }
    else setReject({ nodeId: parentId, reason: r.message });
    return r;
  }, [map, project.documentType, dispatch, select, toast]);

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
    onSelect: (id) => { if (editingId && editingId !== id) setEditingId(null); select(id); },
    onDoubleClick: (id) => { if (map.get(id)?.type === 'rich-text') { select(id); setEditingId(id); } },
    onNodeDragStart: (id, e) => { dragging = { kind: 'node', id }; e.dataTransfer.setData('application/x-iss-node', id); e.dataTransfer.effectAllowed = 'move'; select(id); },
    onDragOverNode: (id, e) => {
      if (!dragging) return;
      e.preventDefault();
      const m = markFor(id, e);
      const p = plan(project, id, m.pos, dragging);
      if ('reject' in p) { setReject({ nodeId: m.pos === 'into' ? id : (parentOf(project, id)?.id ?? id), reason: p.reject }); setMark(null); e.dataTransfer.dropEffect = 'none'; }
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
      const flowW = 532;
      let last: any = null;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / unit, dy = (ev.clientY - start.y) / unit;
        if (handle === 'move') last = { xPt: snapTo(Math.max(0, Math.min(612 - (start.pl.wPt ?? 0), (start.pl.xPt ?? 0) + dx))), yPt: snapTo(Math.max(0, Math.min(792 - (start.pl.hPt ?? 0), (start.pl.yPt ?? 0) + dy))) };
        else if (handle === 'resize') last = { wPt: snapTo(Math.max(8, Math.min(612 - (start.pl.xPt ?? 0), (start.pl.wPt ?? 100) + dx))), hPt: snapTo(Math.max(4, Math.min(792 - (start.pl.yPt ?? 0), (start.pl.hPt ?? 20) + dy))) };
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

  if (!res) return <section className="screen" data-testid="design-canvas"><ScreenHeader id="S02" title="2D Design Studio" subtitle="Select a synthetic record that matches this project." /></section>;
  const palette = COMPONENT_CATALOG.filter((c) => !paletteQuery || c.label.toLowerCase().includes(paletteQuery.toLowerCase()) || c.code.toLowerCase().includes(paletteQuery.toLowerCase()));
  const canExplode = selNode && (selNode.type === 'variant-set' || selNode.type === 'conditional-region');

  return (
    <section className="screen design" aria-label="2D Design Studio">
      <ScreenHeader id="S02" title="2D Design Studio" subtitle="Edit accurate page geometry and responsive profiles on one semantic component tree. Every edit is a typed, undoable model command."
        badge={<span className="chip accent">Author</span>}
        actions={<button className="btn primary" disabled={!canExplode} onClick={() => navigate(`/studio/${project.projectId}/exploded/${selNode!.id}`)} data-testid="explore-variants"><Icon.exploded /> Explore variants</button>}
      />
      <div className="screen-body workbench">
        <aside className="panel" aria-label="Components and layers">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={leftTab === 'palette'} onClick={() => setLeftTab('palette')}>Components</button>
            <button role="tab" aria-selected={leftTab === 'layers'} onClick={() => setLeftTab('layers')}>Layers</button>
          </div>
          {leftTab === 'palette' ? (
            <div className="panel-body" data-testid="component-palette">
              <input className="input" placeholder="Search 15 components…" value={paletteQuery} onChange={(e) => setPaletteQuery(e.target.value)} aria-label="Search components" style={{ width: '100%', marginBottom: 8 }} />
              <ul className="palette" aria-label="Component palette (drag onto the page, or press Insert)">
                {palette.map((c) => {
                  const Ico = C[c.type];
                  return (
                    <li key={c.type}>
                      <div className="palette-item" draggable onDragStart={(e) => { dragging = { kind: 'component', type: c.type }; e.dataTransfer.setData('application/x-iss-component', c.type); e.dataTransfer.effectAllowed = 'copy'; }} onDragEnd={() => { dragging = null; setMark(null); }} data-testid={`palette-${c.type}`} title={c.description}>
                        <span className="palette-icon"><Ico /></span>
                        <span className="grow"><span className="palette-label">{c.label}</span><span className="palette-code">{c.code}{c.deep ? ' · deep' : ''}</span></span>
                        <button className="btn sm ghost" onClick={() => insertViaKeyboard(c.type)} aria-label={`Insert ${c.label}`} data-testid={`insert-${c.type}`}><Icon.plus width={14} height={14} /></button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="muted" style={{ fontSize: 11.5 }}>Drop into the flow region, onto a section, or into the page-1 header zone for a fixed anchor. Invalid targets explain why and leave the model unchanged.</p>
            </div>
          ) : (
            <div className="panel-body" data-testid="layers-tree"><LayersTree project={project} res={res} selected={selected} onSelect={(id) => select(id)} /></div>
          )}
        </aside>

        <div className="stage design-stage" ref={stageRef}>
          <div className="stage-grid" />
          <div className="stage-toolbar">
            <span className="chip">{isHtml ? 'Interactive HTML profile' : 'Page 1 · US Letter portrait · paged profile'}</span>
            <span className="chip mono">{Math.round(scale * 100)}%</span>
            {!isHtml && <>
              <button className="btn sm icon" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.4, scale - 0.1))}>−</button>
              <button className="btn sm icon" aria-label="Zoom in" onClick={() => setZoom(Math.min(1.6, scale + 0.1))}>+</button>
              <button className="btn sm" onClick={() => setZoom(null)}>Fit</button>
              <button className="btn sm" aria-pressed={grid} onClick={() => setGrid(!grid)}>Grid</button>
              <button className="btn sm" aria-pressed={snap} onClick={() => setSnap(!snap)}>Snap 2pt</button>
            </>}
            {isHtml && <div className="segmented" role="group" aria-label="Device width">{([1200, 768, 390] as const).map((w) => <button key={w} aria-pressed={device === w} onClick={() => setDevice(w)}>{w === 1200 ? 'Desktop' : w === 768 ? 'Tablet' : 'Mobile'}</button>)}</div>}
            <span style={{ flex: 1 }} />
            {canExplode && <span className="chip variant">Pull handle on {selNode!.id} opens the Exploded view</span>}
          </div>
          <div className="design-scroll" data-testid="design-canvas" tabIndex={0} onKeyDown={onCanvasKey} aria-label="Page canvas. Arrow keys move fixed anchors (Shift = 10 pt), Alt+arrows reorder flow components, Delete removes, Enter edits text." onClick={() => { setEditingId(null); }}>
            {isHtml ? <HtmlProfileCanvas res={res} project={project} width={device} selected={selected} onSelect={(id) => select(id)} />
              : <PagePreview res={res} project={project} scale={scale} ia={ia} showGrid={grid} onPageDragOver={onPageDragOver} onPageDrop={onPageDrop} onBackgroundClick={() => { setEditingId(null); }} />}
          </div>
        </div>

        <Inspector project={project} res={res} nodeId={selected} onEditText={(id) => { select(id); setEditingId(id); }} />
      </div>
    </section>
  );
}

function LayersTree({ project, res, selected, onSelect }: { project: Project; res: Resolution; selected: string | null; onSelect: (id: string) => void }) {
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
          <span className="grow layer-name">{n.name ?? n.id}</span>
          {n.layout?.paged?.mode === 'fixed' && <span className="layer-tag">fixed</span>}
          {(n.type === 'variant-set' || n.type === 'conditional-region') && <span className="layer-count">{n.variantIds?.length ?? 0}</span>}
          {visible.get(id) === false && <span className="layer-tag" title="Not rendered in this scenario">hidden</span>}
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
      style.textContent = `[data-node-id]{cursor:pointer}[data-node-id].iss-sel{outline:3px solid #4EAF60;outline-offset:3px;border-radius:12px}`;
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
  return (
    <div className="html-canvas" style={{ width }}>
      <iframe ref={ref} title="Interactive HTML profile preview" srcDoc={html} sandbox="allow-scripts allow-same-origin" style={{ width, height: 1100 }} data-testid="html-profile-frame" />
    </div>
  );
}
