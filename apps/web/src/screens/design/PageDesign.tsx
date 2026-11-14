import { useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import {
  effectivePageDesign, fixedItemTemplates, MIN_FLOW_PT, PAGE_TEMPLATE_LABEL, PAPER_IDS, PAPER_SIZES, pagedProfileOf,
  type FlowArea, type PageBackground, type PageDesignPatch, type PageTemplate, type PageTemplateId, type PaperSize, type Project,
} from '@iss/model';
import { pageDesignFindings } from '@iss/renderers';
import { useStudio } from '../../state/store';
import { nodeTitle } from '../../ui/plain';
import { PT } from '../../doc/PagePreview';
import { AssetLibraryDialog } from './AssetLibrary';
import { CommitInput, Field } from './Inspector';
import './PageDesign.css';

/**
 * Page design in Design Studio (roadmap wave 2): the Page panel (paper, orientation, margins, page templates, columns,
 * background) and the zone handles drawn on the page canvas (flow area edges per page template, and the letterhead
 * zone of the first page). Every change is one SET_PAGE_DESIGN command, so it is one undo step.
 *
 * The letterhead zone is the part of the first page above its flow area, between the margins. Its bottom edge is the
 * top of the first page's flow area: moving one moves the other.
 */

type Edge = 'top' | 'bottom' | 'left' | 'right';
const SNAP_PT = 6;
const round1 = (n: number) => Math.round(n * 10) / 10;

function templatesOf(project: Project): NonNullable<PageDesignPatch['pageTemplates']> {
  return JSON.parse(JSON.stringify(pagedProfileOf(project)?.pageTemplates ?? {}));
}

/** One undoable command: the page templates with one template changed. */
export function templatePatch(project: Project, id: PageTemplateId, change: (t: PageTemplate) => PageTemplate): PageDesignPatch {
  const all = templatesOf(project);
  const t = change({ ...(all[id] ?? {}) });
  if (t.columns === 1) { delete t.columns; delete t.columnGapPt; }
  all[id] = t;
  // A First or Following template with nothing of its own is the same as no template (the document keeps today's pages).
  for (const k of ['first', 'following'] as const) if (all[k] && !Object.keys(all[k]!).length) delete all[k];
  return { pageTemplates: Object.keys(all).length ? all : null };
}

/** The flow area with one edge moved to `value`, kept on the page and at least the minimum size. */
export function moveEdge(area: FlowArea, edge: Edge, value: number, page: { widthPt: number; heightPt: number }): FlowArea {
  const right = area.xPt + area.wPt, bottom = area.yPt + area.hPt;
  switch (edge) {
    case 'top': { const y = Math.max(0, Math.min(value, bottom - MIN_FLOW_PT)); return { ...area, yPt: round1(y), hPt: round1(bottom - y) }; }
    case 'bottom': { const b = Math.min(page.heightPt, Math.max(value, area.yPt + MIN_FLOW_PT)); return { ...area, hPt: round1(b - area.yPt) }; }
    case 'left': { const x = Math.max(0, Math.min(value, right - MIN_FLOW_PT)); return { ...area, xPt: round1(x), wPt: round1(right - x) }; }
    case 'right': { const r = Math.min(page.widthPt, Math.max(value, area.xPt + MIN_FLOW_PT)); return { ...area, wPt: round1(r - area.xPt) }; }
  }
}

const edgeValue = (a: FlowArea, e: Edge) => (e === 'top' ? a.yPt : e === 'bottom' ? a.yPt + a.hPt : e === 'left' ? a.xPt : a.xPt + a.wPt);

/** Lines an edge snaps to: the margins and the edges of the fixed items on this page template. */
function snapLines(project: Project, template: PageTemplateId, horizontal: boolean): Array<{ at: number; what: string }> {
  const d = effectivePageDesign(pagedProfileOf(project));
  const out = horizontal
    ? [{ at: d.margins.top, what: 'top margin' }, { at: d.heightPt - d.margins.bottom, what: 'bottom margin' }]
    : [{ at: d.margins.left, what: 'left margin' }, { at: d.widthPt - d.margins.right, what: 'right margin' }];
  for (const n of project.nodes) {
    const p = n.layout?.paged;
    if (p?.mode !== 'fixed' || !fixedItemTemplates(p.pages).includes(template)) continue;
    const name = n.name ?? n.id;
    if (horizontal) out.push({ at: p.yPt ?? 0, what: `top of ${name}` }, { at: (p.yPt ?? 0) + (p.hPt ?? 0), what: `bottom of ${name}` });
    else out.push({ at: p.xPt ?? 0, what: `left of ${name}` }, { at: (p.xPt ?? 0) + (p.wPt ?? 0), what: `right of ${name}` });
  }
  return out;
}

export function snapValue(project: Project, template: PageTemplateId, edge: Edge, raw: number, snap: boolean): { value: number; to: string | null } {
  if (!snap) return { value: Math.round(raw), to: null };
  const lines = snapLines(project, template, edge === 'top' || edge === 'bottom');
  let best: { at: number; what: string } | null = null;
  for (const l of lines) if (Math.abs(l.at - raw) <= SNAP_PT && (!best || Math.abs(l.at - raw) < Math.abs(best.at - raw))) best = l;
  return best ? { value: round1(best.at), to: best.what } : { value: Math.round(raw), to: null };
}

/* ------------------------------------------------------------------ zones on the canvas */

const EDGE_WORD: Record<Edge, string> = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' };

/** Flow area (and letterhead zone) outlines with draggable, keyboard-operable edges. Drawn in page points inside the scaled page. */
export function PageZones({ project, template, scale, snap }: { project: Project; template: PageTemplateId; scale: number; snap: boolean }) {
  const dispatch = useStudio((s) => s.dispatch);
  const design = useMemo(() => effectivePageDesign(pagedProfileOf(project)), [project]);
  const tpl = (template === 'last' ? design.last : null) ?? (template === 'following' || template === 'last' ? design.following : design.first);
  const [live, setLive] = useState<{ area: FlowArea; to: string | null; edge: Edge } | null>(null);
  const [said, setSaid] = useState('');
  const area = live?.area ?? tpl.flow;
  const page = { widthPt: design.widthPt, heightPt: design.heightPt };
  const tname = PAGE_TEMPLATE_LABEL[template];

  const commit = (next: FlowArea, note?: string) => {
    if (next.xPt === tpl.flow.xPt && next.yPt === tpl.flow.yPt && next.wPt === tpl.flow.wPt && next.hPt === tpl.flow.hPt) return;
    const r = dispatch({ type: 'SET_PAGE_DESIGN', patch: templatePatch(project, template, (t) => ({ ...t, flowArea: next })) });
    if (r.ok) setSaid(`${tname} flow area: ${Math.round(next.xPt)}, ${Math.round(next.yPt)} pt, ${Math.round(next.wPt)} × ${Math.round(next.hPt)} pt${note ? `, snapped to the ${note}` : ''}.`);
  };

  const onDown = (edge: Edge, e: RPointerEvent<HTMLButtonElement>) => {
    e.preventDefault(); e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, v: edgeValue(tpl.flow, edge) };
    const unit = PT * scale;
    let last: { area: FlowArea; to: string | null; edge: Edge } | null = null;
    const move = (ev: PointerEvent) => {
      const delta = edge === 'top' || edge === 'bottom' ? (ev.clientY - start.y) / unit : (ev.clientX - start.x) / unit;
      const s = snapValue(project, template, edge, start.v + delta, snap);
      last = { area: moveEdge(tpl.flow, edge, s.value, page), to: s.to, edge };
      setLive(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      if (last) commit(last.area, last.to ?? undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKey = (edge: Edge, e: RKeyboardEvent<HTMLButtonElement>) => {
    const vertical = edge === 'top' || edge === 'bottom';
    const dir = vertical ? (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0) : (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault(); e.stopPropagation();
    if (!dir) return;
    commit(moveEdge(tpl.flow, edge, edgeValue(tpl.flow, edge) + dir * (e.shiftKey ? 10 : 1), page));
  };

  const handle = (edge: Edge, label: string) => {
    const v = Math.round(edgeValue(area, edge));
    const style = edge === 'top' ? { left: `${area.xPt + area.wPt / 2}pt`, top: `${area.yPt}pt` }
      : edge === 'bottom' ? { left: `${area.xPt + area.wPt / 2}pt`, top: `${area.yPt + area.hPt}pt` }
      : edge === 'left' ? { left: `${area.xPt}pt`, top: `${area.yPt + area.hPt / 2}pt` }
      : { left: `${area.xPt + area.wPt}pt`, top: `${area.yPt + area.hPt / 2}pt` };
    return (
      <button type="button" key={edge} className={`pz-handle pz-handle-${edge}`} style={{ ...style, ['--pz-inv' as string]: String(1 / scale) }}
        aria-label={`${label}, ${v} pt from the ${edge === 'top' || edge === 'bottom' ? 'top' : 'left'} of the page. Arrow keys move it 1 pt, Shift+arrow 10 pt.`}
        title={`${label}: ${v} pt. Drag, or use the arrow keys.`}
        data-testid={`zone-${template === 'first' && edge === 'top' ? 'letterhead-bottom' : `flow-${edge}`}`}
        onPointerDown={(e) => onDown(edge, e)} onKeyDown={(e) => onKey(edge, e)} onClick={(e) => e.stopPropagation()} />
    );
  };
  const letterhead = template === 'first' && area.yPt > design.margins.top + 4;
  return (
    <div className="pz" aria-label={`${tname} zones`} role="group">
      {letterhead && (
        <div className="pz-letterhead" style={{ left: `${design.margins.left}pt`, top: `${design.margins.top}pt`, width: `${design.widthPt - design.margins.left - design.margins.right}pt`, height: `${area.yPt - design.margins.top}pt` }} aria-hidden="true">
          <span className="pz-tag" style={{ ['--pz-inv' as string]: String(1 / scale) }}>Letterhead zone</span>
        </div>
      )}
      <div className={`pz-flow${live ? ' is-live' : ''}`} style={{ left: `${area.xPt}pt`, top: `${area.yPt}pt`, width: `${area.wPt}pt`, height: `${area.hPt}pt` }} aria-hidden="true" data-testid="zone-flow">
        <span className="pz-tag pz-tag-flow" style={{ ['--pz-inv' as string]: String(1 / scale) }}>{tname} flow area</span>
      </div>
      {handle('top', template === 'first' ? 'Letterhead zone bottom edge and flow area top edge' : `${tname} flow area top edge`)}
      {handle('bottom', `${tname} flow area bottom edge`)}
      {handle('left', `${tname} flow area left edge`)}
      {handle('right', `${tname} flow area right edge`)}
      {live && <div className="pz-readout" style={{ left: `${area.xPt}pt`, top: `${area.yPt + area.hPt}pt`, ['--pz-inv' as string]: String(1 / scale) }}>{Math.round(area.xPt)}, {Math.round(area.yPt)} · {Math.round(area.wPt)} × {Math.round(area.hPt)} pt{live.to ? ` · snapped to the ${live.to}` : ''}</div>}
      <span className="sr-only" role="status" aria-live="polite">{said}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ Page panel */

const MARGIN_LABEL = ['Top', 'Right', 'Bottom', 'Left'] as const;

export function PagePanel({ project, template, onTemplate, onSelectNode, onClose }: { project: Project; template: PageTemplateId; onTemplate: (t: PageTemplateId) => void; onSelectNode: (id: string) => void; onClose: () => void }) {
  const dispatch = useStudio((s) => s.dispatch);
  const profile = pagedProfileOf(project);
  const design = useMemo(() => effectivePageDesign(profile), [profile]);
  const [picking, setPicking] = useState(false);
  const findings = useMemo(() => pageDesignFindings(project), [project]);
  const headingRef = useRef<HTMLDivElement>(null);
  const set = (patch: PageDesignPatch) => dispatch({ type: 'SET_PAGE_DESIGN', patch });
  const tpl = (template === 'last' ? design.last : null) ?? (template === 'following' || template === 'last' ? design.following : design.first);
  const own = profile?.pageTemplates?.[template];
  const setTpl = (change: (t: PageTemplate) => PageTemplate) => set(templatePatch(project, template, change));
  const setArea = (k: keyof FlowArea, v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    setTpl((t) => ({ ...t, flowArea: { ...tpl.flow, [k]: n } }));
  };
  const setBg = (bg: PageBackground | undefined) => setTpl((t) => { const n = { ...t }; if (bg) n.background = bg; else delete n.background; return n; });
  const margins = profile?.pageMarginsMm ?? [14, 14, 14, 14];
  const fixedHere = project.nodes.filter((n) => n.layout?.paged?.mode === 'fixed' && fixedItemTemplates(n.layout.paged.pages).includes(template));
  const bg = tpl.background;
  const tname = PAGE_TEMPLATE_LABEL[template];

  return (
    <aside className="panel pg-panel" aria-label="Page design" data-testid="page-panel" data-side="right" data-side-title="Page">
      <div className="panel-head" ref={headingRef}>Page <span className="sub">{PAPER_SIZES[design.paper].label} · {design.orientation}</span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={onClose} data-testid="close-page-panel">Back to the inspector</button>
      </div>
      <div className="panel-body pg-body">
        <p className="muted pg-note">The page design belongs to the PDF and the AFP simulation. The web page, email and SMS do not change.</p>

        <section className="pg-sec" aria-labelledby="pg-paper-h">
          <h3 className="insp-h" id="pg-paper-h">Paper</h3>
          <div className="pg-paper">
            <Field label="Size">
              <select className="select" value={design.paper} onChange={(e) => set({ paper: e.target.value as PaperSize })} data-testid="page-paper">
                {PAPER_IDS.map((id) => <option key={id} value={id}>{PAPER_SIZES[id].label}</option>)}
              </select>
            </Field>
            <div className="field"><span className="pg-label" id="pg-orient">Orientation</span>
              <div className="segmented" role="group" aria-labelledby="pg-orient">
                {(['portrait', 'landscape'] as const).map((o) => <button key={o} aria-pressed={design.orientation === o} onClick={() => set({ orientation: o })} data-testid={`page-orientation-${o}`}>{o === 'portrait' ? 'Portrait' : 'Landscape'}</button>)}
              </div>
            </div>
          </div>
          <p className="muted pg-hint">{Math.round(design.widthPt)} × {Math.round(design.heightPt)} pt. Changing the paper moves the flow areas and the fixed items with the page edges they sit against.</p>
          <div className="pg-label">Margins (mm)</div>
          <div className="layout-grid pg-margins">
            {MARGIN_LABEL.map((label, i) => (
              <Field key={label} label={label}>
                <CommitInput type="number" value={margins[i]} testId={`page-margin-${label.toLowerCase()}`} ariaLabel={`${label} margin in millimetres`}
                  onCommit={(v) => { const n = Number(v); if (!Number.isFinite(n)) return; const m = [...margins] as [number, number, number, number]; m[i] = n; set({ pageMarginsMm: m }); }} />
              </Field>
            ))}
          </div>
        </section>

        <section className="pg-sec" aria-labelledby="pg-tpl-h">
          <h3 className="insp-h" id="pg-tpl-h">Page templates</h3>
          <TemplateSwitch project={project} template={template} onTemplate={onTemplate} />
          <label className="row pg-check"><input type="checkbox" checked={!!design.last} data-testid="page-last-toggle"
            onChange={(e) => { const all = templatesOf(project); if (e.target.checked) all.last = {}; else delete all.last; set({ pageTemplates: Object.keys(all).length ? all : null }); if (!e.target.checked && template === 'last') onTemplate('following'); }} />
            Use a different last page (for a payment slip or a closing panel)</label>

          <h4 className="pg-sub">{tname}: flow area (pt)</h4>
          <div className="layout-grid">
            {([['xPt', 'Left'], ['yPt', 'Top'], ['wPt', 'Width'], ['hPt', 'Height']] as const).map(([k, label]) => (
              <Field key={k} label={label}><CommitInput type="number" value={round1(tpl.flow[k])} onCommit={(v) => setArea(k, v)} testId={`page-flow-${k.replace('Pt', '')}`} ariaLabel={`${tname} flow area ${label.toLowerCase()} in points`} /></Field>
            ))}
          </div>
          {own?.flowArea && <button className="btn sm ghost" onClick={() => setTpl((t) => { const n = { ...t }; delete n.flowArea; return n; })} data-testid="page-flow-reset">Back to the standard flow area</button>}
          {template === 'first' && <p className="muted pg-hint">The letterhead zone is the space above this flow area: drag its bottom edge on the page, or set the top here.</p>}

          <h4 className="pg-sub">Columns</h4>
          <div className="layout-grid">
            <Field label="Columns">
              <select className="select" value={tpl.columns} onChange={(e) => setTpl((t) => ({ ...t, columns: Number(e.target.value) }))} data-testid="page-columns">
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Gap (pt)"><CommitInput type="number" value={tpl.columnGapPt} onCommit={(v) => { const n = Number(v); if (Number.isFinite(n)) setTpl((t) => ({ ...t, columnGapPt: n })); }} testId="page-gap" ariaLabel="Gap between columns in points" /></Field>
          </div>
          {tpl.columns > 1 && <p className="muted pg-hint">Content fills one column, then the next, then the next page. Columns are not balanced. A component set to span the columns runs across them (Inspector, Layout).</p>}

          <h4 className="pg-sub">Background</h4>
          <div className="segmented" role="group" aria-label={`${tname} background`}>
            <button aria-pressed={!bg} onClick={() => setBg(undefined)} data-testid="page-bg-none">None</button>
            <button aria-pressed={bg?.kind === 'tint'} onClick={() => setBg({ kind: 'tint', color: bg?.color ?? '#F1F5F9', opacityPct: bg?.opacityPct ?? 100 })} data-testid="page-bg-tint">Tint</button>
            <button aria-pressed={bg?.kind === 'image'} onClick={() => setPicking(true)} data-testid="page-bg-image">Image…</button>
          </div>
          {bg && (
            <div className="layout-grid" style={{ marginTop: 8 }}>
              {bg.kind === 'tint' && <Field label="Colour"><CommitInput value={bg.color} onCommit={(v) => setBg({ ...bg, color: v.trim() })} testId="page-bg-color" ariaLabel="Tint colour as a hex value such as #F1F5F9" /></Field>}
              {bg.kind === 'image' && (
                <Field label="Fit">
                  <select className="select" value={bg.fit ?? 'cover'} onChange={(e) => setBg({ ...bg, fit: e.target.value as 'cover' | 'contain' })} data-testid="page-bg-fit"><option value="cover">Cover the page</option><option value="contain">Fit inside the page</option></select>
                </Field>
              )}
              <Field label="Opacity (%)"><CommitInput type="number" value={bg.opacityPct} onCommit={(v) => { const n = Number(v); if (Number.isFinite(n)) setBg({ ...bg, opacityPct: n }); }} testId="page-bg-opacity" ariaLabel="Background opacity in percent" /></Field>
            </div>
          )}
          <p className="muted pg-hint">A background is decoration: screen readers skip it, and it is never in the web page, email or SMS.</p>

          <h4 className="pg-sub">Fixed items on {tname.toLowerCase()}</h4>
          {fixedHere.length ? (
            <ul className="list-rows pg-fixed">{fixedHere.map((n) => <li key={n.id}><button className="pg-fixed-btn" onClick={() => onSelectNode(n.id)}>{n.name ?? nodeTitle(project, n.id)}<span className="muted"> · {n.layout?.paged?.pages === 'all' ? 'all pages' : n.layout?.paged?.pages === 'following' ? 'following pages' : n.layout?.paged?.pages === 'last' ? 'last page' : 'first page'}</span></button></li>)}</ul>
          ) : <p className="muted">None. Set a fixed item’s pages in the Inspector, Layout.</p>}
        </section>

        <section className="pg-sec" aria-labelledby="pg-a11y-h">
          <h3 className="insp-h" id="pg-a11y-h">Accessible PDF</h3>
          <label className="row pg-check"><input type="checkbox" checked={!!project.accessiblePdfRequired} data-testid="accessible-pdf-required"
            onChange={(e) => dispatch({ type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: e.target.checked })} />
            Accessible PDF is required</label>
          <p className="muted pg-hint">{project.accessiblePdfRequired
            ? 'A PDF that fails one of the studio’s accessibility checks stops the document: the full check lists it on the Blockers screen.'
            : 'Off: the studio’s PDF accessibility checks still run (Validate & Compare, and the full check), but what they find is a warning.'} The studio’s checks are not validation against PDF/UA; veraPDF does that when it is installed.</p>
        </section>

        {findings.length > 0 && (
          <section className="pg-sec" aria-label="Page design problems">
            {findings.map((f, i) => <div key={i} className={`callout ${f.severity === 'blocking' ? 'error' : 'warning'}`} data-testid="page-finding">{f.message}</div>)}
          </section>
        )}
      </div>
      {picking && <AssetLibraryDialog onClose={() => setPicking(false)} onPick={(a) => { setPicking(false); setBg({ kind: 'image', image: a.dataUri, fit: bg?.kind === 'image' ? bg.fit ?? 'cover' : 'cover', opacityPct: bg?.kind === 'image' ? bg.opacityPct : 15 }); }} />}
    </aside>
  );
}

/** First page / Following pages / Last page: which page template the canvas and the Page panel show. */
export function TemplateSwitch({ project, template, onTemplate, compact }: { project: Project; template: PageTemplateId; onTemplate: (t: PageTemplateId) => void; compact?: boolean }) {
  const hasLast = !!pagedProfileOf(project)?.pageTemplates?.last;
  const ids: PageTemplateId[] = ['first', 'following', 'last'];
  return (
    <div className={`segmented${compact ? ' ds-group' : ''}`} role="group" aria-label="Page template">
      {ids.map((id) => (
        <button key={id} aria-pressed={template === id} disabled={id === 'last' && !hasLast} onClick={() => onTemplate(id)} data-testid={`page-template-${id}`}
          title={id === 'last' && !hasLast ? 'Turn on a different last page in the Page panel first' : `Show the ${PAGE_TEMPLATE_LABEL[id].toLowerCase()} template`}>
          {compact ? (id === 'first' ? 'First' : id === 'following' ? 'Following' : 'Last') : PAGE_TEMPLATE_LABEL[id]}
        </button>
      ))}
    </div>
  );
}
