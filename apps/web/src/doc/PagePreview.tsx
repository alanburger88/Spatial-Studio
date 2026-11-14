import { memo, useMemo, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { effectivePageDesign, fixedItemTemplates, PAGE_TEMPLATE_LABEL, pagedProfileOf, type PageTemplateId, type Project } from '@iss/model';
import { imageSrc, nodeInnerHtml, documentCss, type RenderMode } from '@iss/renderers';
import type { RNode, Resolution } from '@iss/resolver';
import './PagePreview.css';

/**
 * React projection of page 1 of the paged profile, built from the same resolved tree (RCT) and the same
 * node renderer used by the PDF composer. Node wrappers carry stable semantic IDs for selection.
 * Pagination of overflowing flow content is NOT simulated here: the composer (Page Stack / exports)
 * is the authority for page breaks; the editor marks where page 1 ends.
 */

export const PT = 4 / 3; // px per pt at 100%
export const PAGE_W_PT = 612;
export const PAGE_H_PT = 792;
export const TABLE_PREVIEW_ROWS = 14;

export interface NodeInteraction {
  selectedId: string | null;
  highlightIds?: string[];
  editable?: boolean;
  dropMark?: { id: string; pos: 'before' | 'after' | 'into' } | null;
  renderAdornment?: (node: RNode) => ReactNode;
  dropReject?: { nodeId: string; reason: string } | null;
  dropLine?: { parentId: string; index: number } | null;
  editingId?: string | null;
  renderEditor?: (node: RNode) => ReactNode;
  onSelect?: (id: string, e: MouseEvent) => void;
  onDoubleClick?: (id: string) => void;
  onDragOverNode?: (id: string, e: DragEvent<HTMLDivElement>) => void;
  onDropNode?: (id: string, e: DragEvent<HTMLDivElement>) => void;
  onNodePointerDown?: (id: string, e: React.PointerEvent<HTMLDivElement>, handle?: string) => void;
  onNodeDragStart?: (id: string, e: DragEvent<HTMLDivElement>) => void;
  /** How resolved-hidden nodes are drawn: 'ghost' (default, dashed placeholder in the page) or 'marker' (margin tab only). */
  hiddenMode?: 'ghost' | 'marker';
  transient?: Record<string, { xPt?: number; yPt?: number; wPt?: number; hPt?: number; widthPct?: number }>;
}

/** Plain-language tooltip for a hidden node: "Name — hidden for this customer (rule R06 not matched)". */
export function hiddenTip(n: RNode): string {
  const rules = /\(([A-Z]+\d+(?:,\s*[A-Z]+\d+)*)\)/.exec(n.hiddenReason ?? '')?.[1];
  const why = rules ? `rule ${rules} not matched` : (n.hiddenReason ?? 'not selected').replace(/\.$/, '');
  return `${n.name} — hidden for this customer (${why})`;
}

function HiddenMarks({ nodes, ia, inRow }: { nodes: RNode[]; ia: NodeInteraction; inRow?: boolean }) {
  return (
    <div className={`pv-hmark-group${inRow ? ' in-row' : ''}`}>
      <div className="pv-hmark-stack">
        {nodes.map((n) => <HiddenMarkButton key={n.id} n={n} ia={ia} />)}
      </div>
    </div>
  );
}

function HiddenMarkButton({ n, ia, className = '', style }: { n: RNode; ia: NodeInteraction; className?: string; style?: CSSProperties }) {
  const tip = hiddenTip(n);
  const selected = ia.selectedId === n.id;
  return (
    <button type="button" className={`pv-hmark ${className}${selected ? ' is-selected' : ''}`} title={tip} aria-label={tip} aria-pressed={selected} style={style}
      data-testid={`hidden-marker-${n.id}`} data-hidden-node={n.id}
      onClick={(e) => { e.stopPropagation(); ia.onSelect?.(n.id, e); }}>⊘</button>
  );
}

/** Children list; in 'marker' mode consecutive hidden nodes collapse into one margin marker stack. */
function renderNodes(list: RNode[], mode: RenderMode, ia: NodeInteraction, depth: number, inRow?: boolean): ReactNode[] {
  if (ia.hiddenMode !== 'marker') return list.map((c) => <NodeBox key={c.id} n={c} mode={mode} ia={ia} depth={depth} inRow={inRow} />);
  const out: ReactNode[] = [];
  let run: RNode[] = [];
  const flush = () => { if (run.length) { out.push(<HiddenMarks key={`hm-${run[0].id}`} nodes={run} ia={ia} inRow={inRow} />); run = []; } };
  for (const c of list) {
    if (!c.visible) { run.push(c); continue; }
    flush();
    out.push(<NodeBox key={c.id} n={c} mode={mode} ia={ia} depth={depth} inRow={inRow} />);
  }
  flush();
  return out;
}

function limitTable(n: RNode): RNode {
  if (!n.table || n.table.rows.length <= TABLE_PREVIEW_ROWS) return n;
  return { ...n, table: { ...n.table, rows: n.table.rows.slice(0, TABLE_PREVIEW_ROWS) } };
}

const NodeHtml = memo(function NodeHtml({ html }: { html: string }) {
  return <div className="pv-inner" dangerouslySetInnerHTML={{ __html: html }} />;
});

function NodeBox({ n, mode, ia, depth, inRow }: { n: RNode; mode: RenderMode; ia: NodeInteraction; depth: number; inRow?: boolean }) {
  const pl = n.layout?.paged;
  // A component of a later item of a repeating section (wave 5) is the same component of the document: selecting it selects that component.
  const own = n.instanceOf ?? n.id;
  const t = ia.transient?.[own];
  const selected = ia.selectedId === own;
  const cls = ['pv-node', `pv-${n.type}`];
  if (selected) cls.push('is-selected');
  if (ia.highlightIds?.includes(n.id)) cls.push('is-highlight');
  if (!n.visible) cls.push('is-hidden');
  if (ia.dropMark?.id === n.id) cls.push(ia.dropMark.pos === 'into' ? 'is-drop' : `is-drop-${ia.dropMark.pos}`);
  if (ia.dropReject?.nodeId === n.id) cls.push('is-reject');
  if (n.required) cls.push('is-required');
  const style: CSSProperties = {};
  if (inRow) {
    const w = t?.widthPct ?? pl?.widthPct;
    if (w && w < 100) style.flex = `0 0 calc(${w}% - 6pt)`;
  } else if (pl?.mode !== 'fixed') {
    const w = t?.widthPct ?? pl?.widthPct ?? 100;
    style.width = `${w}%`;
    style.marginLeft = pl?.align === 'center' ? `${(100 - w) / 2}%` : pl?.align === 'right' ? `${100 - w}%` : 0;
    style.marginTop = `${depth === 0 ? (pl?.spaceBeforePt ?? 8) : 0}pt`;
  }
  const label = `${n.name} (${n.id})${n.repeatItem ? ` — item ${n.repeatItem.index} of ${n.repeatItem.count}` : ''}${n.visible ? '' : ' — not rendered in this scenario'}`;
  let inner: ReactNode;
  if (ia.editingId === n.id && ia.renderEditor) inner = ia.renderEditor(n);
  else if (!n.visible) inner = <div className="pv-ghost"><span className="pv-ghost-name">{n.name}</span><span className="pv-ghost-why">Hidden for this customer · {n.hiddenReason}</span></div>;
  else if (n.type === 'container' && n.repeat) {
    // A repeating section: its content once per item, each item marked (studio marks, never in the outputs).
    const items = new Map<number, RNode[]>();
    for (const c of n.children) { const i = c.repeatItem?.index ?? 1; items.set(i, [...(items.get(i) ?? []), c]); }
    // The first item is shown in full (it is where the layout is edited); each later item shows its first component
    // and how many more it repeats, so the page stays readable. The PDF and the web page show every item in full.
    inner = <div className="iss-container pv-repeat" data-testid={`repeat-${n.id}`}>{[...items.keys()].sort((a, b) => a - b).map((i) => {
      const kids = items.get(i)!;
      const shown = i === 1 ? kids : kids.slice(0, 1);
      const more = kids.length - shown.length;
      return (
        <div key={i} className={`pv-repeat-item${i > 1 ? ' is-repeat' : ''}`} data-repeat-item={i}>
          <div className="pv-repeat-label" aria-hidden="true">{n.repeat!.label} · item {i} of {n.repeat!.count}{i > 1 ? ` · repeated${more ? ` (+${more} more component${more === 1 ? '' : 's'})` : ''}` : ' · laid out here'}</div>
          {renderNodes(shown, mode, ia, depth + 1, false)}
        </div>
      );
    })}{!n.children.length && <div className="pv-empty-container">Empty repeating section — drop components here</div>}</div>;
  } else if (n.type === 'container') {
    const row = pl?.direction === 'row';
    inner = <div className={`iss-container${row ? ' iss-row' : ''}`}>{renderNodes(n.children, mode, ia, depth + 1, row)}{!n.children.length && <div className="pv-empty-container">Empty section — drop components here</div>}</div>;
  } else {
    const shown = limitTable(n);
    inner = <NodeHtml html={nodeInnerHtml(shown, mode, () => '')} />;
    if (n.table && n.table.rows.length > TABLE_PREVIEW_ROWS) inner = <>{inner}<div className="pv-more">+ {n.table.rows.length - TABLE_PREVIEW_ROWS} more rows · the composer paginates all {n.table.rows.length} rows{n.table.continuation ? ' with continuation' : ' — continuation disabled'}</div></>;
  }
  return (
    <div
      className={cls.join(' ')}
      style={style}
      data-testid={`node-${n.id}`}
      data-node-id={n.id}
      role="button"
      tabIndex={-1}
      aria-label={label}
      aria-pressed={selected}
      draggable={!!ia.editable && pl?.mode !== 'fixed' && ia.editingId !== n.id && !n.instanceOf}
      onDragStart={(e) => { e.stopPropagation(); ia.onNodeDragStart?.(own, e); }}
      onClick={(e) => { e.stopPropagation(); ia.onSelect?.(own, e); }}
      onDoubleClick={(e) => { e.stopPropagation(); if (!n.instanceOf) ia.onDoubleClick?.(n.id); }}
      onDragOver={(e) => { if (ia.onDragOverNode) { e.stopPropagation(); ia.onDragOverNode(own, e); } }}
      onDrop={(e) => { if (ia.onDropNode) { e.stopPropagation(); ia.onDropNode(own, e); } }}
    >
      {inner}
      {ia.dropReject?.nodeId === n.id && <div className="pv-reject-msg" role="alert">⛔ {ia.dropReject.reason}</div>}
      {selected && ia.renderAdornment?.(n)}
      {selected && ia.editable && pl?.mode !== 'fixed' && depth === 0 && <div className="pv-handle pv-handle-e" onPointerDown={(e) => { e.stopPropagation(); ia.onNodePointerDown?.(n.id, e, 'flow-width'); }} aria-hidden="true" />}
    </div>
  );
}

function FixedBox({ n, mode, ia }: { n: RNode; mode: RenderMode; ia: NodeInteraction }) {
  const pl = n.layout!.paged!;
  if (!n.visible && ia.hiddenMode === 'marker') return <HiddenMarkButton n={n} ia={ia} className="pv-hmark-fixed" style={{ top: `${pl.yPt ?? 0}pt` }} />;
  const t = ia.transient?.[n.id];
  const x = t?.xPt ?? pl.xPt ?? 0, y = t?.yPt ?? pl.yPt ?? 0, w = t?.wPt ?? pl.wPt ?? 100, h = t?.hPt ?? pl.hPt ?? 20;
  const selected = ia.selectedId === n.id;
  const cls = ['pv-node', 'pv-fixed', `pv-${n.type}`];
  if (selected) cls.push('is-selected');
  if (!n.visible) cls.push('is-hidden');
  if (ia.dropReject?.nodeId === n.id) cls.push('is-reject');
  if (n.required) cls.push('is-required');
  return (
    <div
      className={cls.join(' ')}
      style={{ left: `${x}pt`, top: `${y}pt`, width: `${w}pt`, height: `${h}pt` }}
      data-testid={`node-${n.id}`}
      data-node-id={n.id}
      role="button" tabIndex={-1}
      aria-label={`${n.name} (${n.id}) fixed at ${Math.round(x)},${Math.round(y)} pt`}
      aria-pressed={selected}
      onClick={(e) => { e.stopPropagation(); ia.onSelect?.(n.id, e); }}
      onDoubleClick={(e) => { e.stopPropagation(); ia.onDoubleClick?.(n.id); }}
      onPointerDown={(e) => { if (ia.editable && selected && ia.editingId !== n.id) ia.onNodePointerDown?.(n.id, e, 'move'); }}
      onDragOver={(e) => { if (ia.onDragOverNode) { e.stopPropagation(); ia.onDragOverNode(n.id, e); } }}
      onDrop={(e) => { if (ia.onDropNode) { e.stopPropagation(); ia.onDropNode(n.id, e); } }}
    >
      {ia.editingId === n.id && ia.renderEditor ? ia.renderEditor(n) : n.visible ? <NodeHtml html={nodeInnerHtml(n, mode, () => '')} /> : <div className="pv-ghost"><span className="pv-ghost-name">{n.name}</span></div>}
      {ia.dropReject?.nodeId === n.id && <div className="pv-reject-msg" role="alert">⛔ {ia.dropReject.reason}</div>}
      {selected && ia.editable && (
        <>
          <div className="pv-handle pv-handle-se" onPointerDown={(e) => { e.stopPropagation(); ia.onNodePointerDown?.(n.id, e, 'resize'); }} aria-hidden="true" />
          <div className="pv-coords">{Math.round(x)}, {Math.round(y)} pt · {Math.round(w)}×{Math.round(h)}</div>
        </>
      )}
    </div>
  );
}

export interface PagePreviewProps {
  res: Resolution;
  project: Project;
  scale: number;
  ia: NodeInteraction;
  showGuides?: boolean;
  showGrid?: boolean;
  onPageDragOver?: (e: DragEvent<HTMLDivElement>, region: 'fixed' | 'flow', ptX: number, ptY: number) => void;
  onPageDrop?: (e: DragEvent<HTMLDivElement>, region: 'fixed' | 'flow', ptX: number, ptY: number) => void;
  onBackgroundClick?: () => void;
  pageRef?: React.Ref<HTMLDivElement>;
  dropLineY?: number | null;
  /** Which page template to show (default: First page). Following and Last pages show their fixed items and flow area; the composer places the flowing content. */
  template?: PageTemplateId;
  /** Drawn on top of the page in page points (zone handles of the Design Studio). */
  overlay?: ReactNode;
}

/** Renders one page template (default page 1: fixed anchors + flow region) at `scale`, at the paper size of the paged profile. */
export function PagePreview({ res, project, scale, ia, showGuides = true, showGrid = false, onPageDragOver, onPageDrop, onBackgroundClick, pageRef, dropLineY, template = 'first', overlay }: PagePreviewProps) {
  const design = useMemo(() => effectivePageDesign(pagedProfileOf(project)), [project]);
  const tpl = (template === 'last' ? design.last : null) ?? (template === 'following' ? design.following : template === 'last' ? design.following : design.first);
  const area = tpl.flow;
  const flow = { firstPageTopPt: area.yPt, bottomPt: area.yPt + area.hPt };
  const left = area.xPt;
  const width = area.wPt;
  const margins = design.margins;
  const pageW = design.widthPt, pageH = design.heightPt;
  const mode: RenderMode = useMemo(() => ({ target: 'paged', project }), [project]);
  const css = useMemo(() => documentCss(project.issuer?.accent ?? '#277656', project), [project]);
  const fixed = res.root.children.filter((n) => n.layout?.paged?.mode === 'fixed' && fixedItemTemplates(n.layout.paged.pages).includes(template));
  const flowNodes = template === 'first' ? res.root.children.filter((n) => n.layout?.paged?.mode !== 'fixed') : [];
  const bg = tpl.background;
  const bgSrc = bg?.kind === 'image' ? imageSrc(bg.image ?? '', project.issuer?.accent ?? '#277656') : null;
  const bgStyle: CSSProperties | null = !bg ? null : bg.kind === 'tint'
    ? { background: bg.color, opacity: bg.opacityPct / 100 }
    : bgSrc ? { backgroundImage: `url("${bgSrc}")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center', backgroundSize: bg.fit === 'contain' ? 'contain' : 'cover', opacity: bg.opacityPct / 100 } : null;
  const colW = (area.wPt - (tpl.columns - 1) * tpl.columnGapPt) / tpl.columns;
  const toPt = (e: DragEvent<HTMLDivElement>) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / (PT * scale), y: (e.clientY - r.top) / (PT * scale) };
  };
  return (
    <div className="pv-wrap" style={{ width: pageW * PT * scale, minHeight: pageH * PT * scale }} data-template={template} data-paper={design.paper} data-orientation={design.orientation}>
      <style>{css}</style>
      <div
        className={`pv-page${showGrid ? ' show-grid' : ''}`}
        ref={pageRef}
        style={{ transform: `scale(${scale})`, width: `${pageW}pt`, minHeight: `${pageH}pt` }}
        onClick={() => onBackgroundClick?.()}
        onDragOver={(e) => { const p = toPt(e); onPageDragOver?.(e, p.y < flow.firstPageTopPt ? 'fixed' : 'flow', p.x, p.y); }}
        onDrop={(e) => { const p = toPt(e); onPageDrop?.(e, p.y < flow.firstPageTopPt ? 'fixed' : 'flow', p.x, p.y); }}
        data-testid="page-surface"
      >
        {bgStyle && <div className="pv-bg" style={bgStyle} aria-hidden="true" data-testid="page-background" />}
        {showGuides && <div className="pv-margin" style={{ left: `${margins.left}pt`, width: `${pageW - margins.left - margins.right}pt`, top: `${margins.top}pt`, height: `${pageH - margins.top - margins.bottom}pt` }} aria-hidden="true" />}
        {fixed.map((n) => <FixedBox key={n.id} n={n} mode={mode} ia={ia} />)}
        <div className="pv-flow" style={{ left: `${left}pt`, top: `${flow.firstPageTopPt}pt`, width: `${width}pt`, minHeight: `${flow.bottomPt - flow.firstPageTopPt}pt` }} data-testid="flow-region" data-columns={tpl.columns}>
          {showGuides && <div className="pv-flow-label" aria-hidden="true">{template === 'first' ? 'Flow region · continues on following pages' : `${PAGE_TEMPLATE_LABEL[template]} · flow area`}{tpl.columns > 1 ? ` · ${tpl.columns} columns` : ''}</div>}
          {showGuides && tpl.columns > 1 && Array.from({ length: tpl.columns }, (_, i) => <div key={i} className="pv-col-guide" style={{ left: `${i * (colW + tpl.columnGapPt)}pt`, width: `${colW}pt` }} aria-hidden="true" />)}
          {template === 'first'
            ? (tpl.columns > 1 ? <div className="pv-flow-cols" style={{ width: `${colW}pt` }}>{renderNodes(flowNodes, mode, ia, 0)}</div> : renderNodes(flowNodes, mode, ia, 0))
            : showGuides && <div className="pv-flow-note">Content continues here from the page before. Page Composition Stack shows the composed pages.</div>}
          {dropLineY !== null && dropLineY !== undefined && <div className="pv-dropline" style={{ top: dropLineY }} />}
        </div>
        {showGuides && template === 'first' && <div className="pv-pagebreak" style={{ top: `${flow.bottomPt}pt` }} aria-hidden="true"><span>End of page 1 flow region · composer paginates the rest</span></div>}
        {overlay}
      </div>
    </div>
  );
}
