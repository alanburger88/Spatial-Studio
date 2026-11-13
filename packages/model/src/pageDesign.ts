import type { FlowArea, PagedLayout, PageBackground, PageTemplate, PageTemplateId, PaperSize, PresentationProfile, Project } from './types';

/**
 * Page design (wave 2): paper, orientation, margins and the three page templates (First page, Following pages and an
 * optional Last page) of the paged outputs. Pure helpers shared by the commands, the page composer, the Design Studio
 * canvas, Page Composition Stack and the AFP simulation, so every one of them reads the same geometry.
 *
 * How older documents map onto it, without changing any of them:
 * - no `paper` / `orientation`  → US Letter portrait (612 × 792 pt);
 * - `pageMarginsMm` (top, right, bottom, left) → the left and right edges of every flow area, as before;
 * - `flowRegion.firstPageTopPt / otherPagesTopPt / bottomPt` → the top and bottom of the First page and Following
 *   pages flow areas, as before (default 184 / 84 / 738 pt);
 * - fixed items with `pages: 'first' | 'following' | 'all'` keep their meaning; `'last'` is new.
 * A page template's own `flowArea`, once set, takes precedence over that derived area. A document without
 * `pageTemplates.last` has no Last page template.
 */

export interface PaperInfo { id: PaperSize; label: string; widthPt: number; heightPt: number; css: string; landscapeCss: string }

export const PAPER_SIZES: Record<PaperSize, PaperInfo> = {
  'US-Letter': { id: 'US-Letter', label: 'US Letter', widthPt: 612, heightPt: 792, css: '8.5in 11in', landscapeCss: '11in 8.5in' },
  A4: { id: 'A4', label: 'A4', widthPt: 595.28, heightPt: 841.89, css: '210mm 297mm', landscapeCss: '297mm 210mm' },
  'US-Legal': { id: 'US-Legal', label: 'US Legal', widthPt: 612, heightPt: 1008, css: '8.5in 14in', landscapeCss: '14in 8.5in' },
};
export const PAPER_IDS = Object.keys(PAPER_SIZES) as PaperSize[];
export const PAGE_TEMPLATE_IDS: readonly PageTemplateId[] = ['first', 'following', 'last'];
export const PAGE_TEMPLATE_LABEL: Record<PageTemplateId, string> = { first: 'First page', following: 'Following pages', last: 'Last page' };

/** The flow region every document had before page templates (US Letter). */
export const LEGACY_FLOW_REGION = { firstPageTopPt: 184, otherPagesTopPt: 84, bottomPt: 738 } as const;
export const DEFAULT_MARGINS_MM: [number, number, number, number] = [14, 14, 14, 14];
/** Minimum lines left behind / carried over when a text component may split and no number is given. */
export const DEFAULT_MIN_LINES = 2;
export const MAX_COLUMNS = 3;
export const MIN_FLOW_PT = 72;
export const MIN_COLUMN_PT = 72;

const isPaper = (v: unknown): v is PaperSize => typeof v === 'string' && v in PAPER_SIZES;

/** The paged profile a project composes with (`paged-pdf`, or the first paged profile). */
export function pagedProfileOf(project: Pick<Project, 'presentationProfiles'>, profileId?: string): PresentationProfile | undefined {
  return project.presentationProfiles.find((p) => p.id === (profileId ?? 'paged-pdf')) ?? project.presentationProfiles.find((p) => p.kind === 'paged');
}

/** Page width and height in pt, orientation applied. */
export function pageSizePt(profile: Partial<PresentationProfile> | undefined): { widthPt: number; heightPt: number; css: string; paper: PaperInfo; landscape: boolean } {
  const paper = PAPER_SIZES[isPaper(profile?.paper) ? profile!.paper! : 'US-Letter'];
  const landscape = profile?.orientation === 'landscape';
  return landscape
    ? { widthPt: paper.heightPt, heightPt: paper.widthPt, css: paper.landscapeCss, paper, landscape }
    : { widthPt: paper.widthPt, heightPt: paper.heightPt, css: paper.css, paper, landscape };
}

/** Margins in pt, rounded exactly as the composer always has: top, right, bottom, left. */
export function marginsPt(profile: Partial<PresentationProfile> | undefined): { top: number; right: number; bottom: number; left: number } {
  const m = profile?.pageMarginsMm ?? DEFAULT_MARGINS_MM;
  const pt = (mm: number) => Math.round((mm * 72) / 25.4);
  return { top: pt(m[0]), right: pt(m[1]), bottom: pt(m[2]), left: pt(m[3]) };
}

/** One page template with every value worked out. */
export interface EffectiveTemplate {
  id: PageTemplateId;
  flow: FlowArea;
  columns: number;
  columnGapPt: number;
  background: PageBackground | null;
  /** True when the flow area comes from `flowRegion` and the margins (nothing set on the template itself). */
  derived: boolean;
}

export interface EffectivePageDesign {
  widthPt: number;
  heightPt: number;
  /** CSS `@page` size. */
  css: string;
  paper: PaperSize;
  orientation: 'portrait' | 'landscape';
  margins: { top: number; right: number; bottom: number; left: number };
  first: EffectiveTemplate;
  following: EffectiveTemplate;
  last: EffectiveTemplate | null;
}

/** The page design of a paged profile with every default applied. A profile with no new fields gives exactly today's pages. */
export function effectivePageDesign(profile: Partial<PresentationProfile> | undefined): EffectivePageDesign {
  const size = pageSizePt(profile);
  const margins = marginsPt(profile);
  const region = profile?.flowRegion ?? LEGACY_FLOW_REGION;
  const widthPt = size.widthPt - margins.left - margins.right;
  const derivedFlow = (top: number): FlowArea => ({ xPt: margins.left, yPt: top, wPt: widthPt, hPt: region.bottomPt - top });
  const make = (id: PageTemplateId, t: PageTemplate | undefined, fallback: FlowArea): EffectiveTemplate => ({
    id,
    flow: t?.flowArea ? { ...t.flowArea } : fallback,
    columns: Math.max(1, Math.min(MAX_COLUMNS, Math.round(t?.columns ?? 1))),
    columnGapPt: t?.columnGapPt ?? 18,
    background: t?.background ?? null,
    derived: !t?.flowArea,
  });
  const tpl = profile?.pageTemplates;
  const first = make('first', tpl?.first, derivedFlow(region.firstPageTopPt));
  const following = make('following', tpl?.following, derivedFlow(region.otherPagesTopPt));
  const last = tpl?.last ? make('last', tpl.last, { ...following.flow }) : null;
  return { widthPt: size.widthPt, heightPt: size.heightPt, css: size.css, paper: size.paper.id, orientation: size.landscape ? 'landscape' : 'portrait', margins, first, following, last };
}

/** True when the profile uses nothing beyond what every document had before page templates. */
export function isLegacyPageDesign(profile: Partial<PresentationProfile> | undefined): boolean {
  return (!profile?.paper || profile.paper === 'US-Letter') && profile?.orientation !== 'landscape' && !profile?.pageTemplates;
}

/** Which page templates a fixed item belongs to. */
export function fixedItemTemplates(pages: PagedLayout['pages']): PageTemplateId[] {
  switch (pages ?? 'first') {
    case 'all': return ['first', 'following', 'last'];
    case 'following': return ['following', 'last'];
    case 'last': return ['last'];
    default: return ['first'];
  }
}

/* ------------------------------------------------------------------ validation */

const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const BUILT_IN_IMAGE = /^asset:[a-z0-9-]+$/;
/** Largest background image kept in a document (the same limit the composer applies to every embedded image). */
export const BACKGROUND_IMAGE_MAX_CHARS = 400_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Why a background is not acceptable (null when it is). Untrusted input: checks every field. */
export function backgroundProblem(bg: unknown, where: string): string | null {
  if (!bg || typeof bg !== 'object' || Array.isArray(bg)) return `${where}: the background cannot be read.`;
  const b = bg as Record<string, unknown>;
  if (b.kind !== 'image' && b.kind !== 'tint') return `${where}: a background is an image or a tint.`;
  if (!finite(b.opacityPct) || b.opacityPct < 0 || b.opacityPct > 100) return `${where}: background opacity must be 0–100%.`;
  if (b.kind === 'tint' && (typeof b.color !== 'string' || !HEX.test(b.color))) return `${where}: a tint needs a 6-digit hex colour such as #F1F5F9.`;
  if (b.kind === 'image') {
    if (typeof b.image !== 'string' || !(SAFE_IMAGE.test(b.image) || BUILT_IN_IMAGE.test(b.image))) return `${where}: a background image must be a PNG, JPEG or WebP image from the image library.`;
    if (b.image.length > BACKGROUND_IMAGE_MAX_CHARS) return `${where}: the background image is too large. Use a smaller image from the image library.`;
    if (b.fit !== undefined && b.fit !== 'cover' && b.fit !== 'contain') return `${where}: the image is fitted by covering the page or by fitting inside it.`;
  }
  return null;
}

/** Every reason a profile's page design cannot be used. Untrusted input (project files) goes through this too. */
export function pageDesignProblems(profile: Partial<PresentationProfile>): string[] {
  const out: string[] = [];
  if (profile.paper !== undefined && !isPaper(profile.paper)) out.push('Paper must be US Letter, A4 or US Legal.');
  if (profile.orientation !== undefined && profile.orientation !== 'portrait' && profile.orientation !== 'landscape') out.push('Orientation must be portrait or landscape.');
  const m = profile.pageMarginsMm;
  if (m !== undefined && (!Array.isArray(m) || m.length !== 4 || m.some((x) => !finite(x) || x < 0 || x > 60))) out.push('Margins must be four numbers from 0 to 60 mm (top, right, bottom, left).');
  if (out.length) return out;
  const size = pageSizePt(profile);
  const mg = marginsPt(profile);
  if (mg.left + mg.right > size.widthPt - MIN_FLOW_PT || mg.top + mg.bottom > size.heightPt - MIN_FLOW_PT) out.push('The margins leave too little of the page to print on.');
  const tpl = profile.pageTemplates as unknown;
  if (tpl !== undefined) {
    if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) return [...out, 'The page templates cannot be read.'];
    for (const key of Object.keys(tpl)) if (!(PAGE_TEMPLATE_IDS as readonly string[]).includes(key)) out.push(`Unknown page template “${key.slice(0, 30)}”.`);
    for (const id of PAGE_TEMPLATE_IDS) {
      const t = (tpl as Record<string, unknown>)[id];
      if (t === undefined) continue;
      const name = PAGE_TEMPLATE_LABEL[id];
      if (!t || typeof t !== 'object' || Array.isArray(t)) { out.push(`${name}: the page template cannot be read.`); continue; }
      const tt = t as Record<string, unknown>;
      if (tt.columns !== undefined && (!finite(tt.columns) || !Number.isInteger(tt.columns) || tt.columns < 1 || tt.columns > MAX_COLUMNS)) out.push(`${name}: columns must be 1, 2 or 3.`);
      if (tt.columnGapPt !== undefined && (!finite(tt.columnGapPt) || tt.columnGapPt < 0 || tt.columnGapPt > 72)) out.push(`${name}: the gap between columns must be 0–72 pt.`);
      if (tt.background !== undefined) { const p = backgroundProblem(tt.background, name); if (p) out.push(p); }
      if (tt.flowArea !== undefined) {
        const f = tt.flowArea as Record<string, unknown>;
        if (!f || typeof f !== 'object' || !['xPt', 'yPt', 'wPt', 'hPt'].every((k) => finite(f[k]))) { out.push(`${name}: the flow area needs a position and a size in points.`); continue; }
        const a = f as unknown as FlowArea;
        if (a.xPt < 0 || a.yPt < 0 || a.xPt + a.wPt > size.widthPt + 0.01 || a.yPt + a.hPt > size.heightPt + 0.01) out.push(`${name}: the flow area must stay on the ${size.paper.label} page (${Math.round(size.widthPt)} × ${Math.round(size.heightPt)} pt).`);
        if (a.wPt < MIN_FLOW_PT || a.hPt < MIN_FLOW_PT) out.push(`${name}: the flow area must be at least ${MIN_FLOW_PT} × ${MIN_FLOW_PT} pt.`);
      }
    }
  }
  if (out.length) return out;
  // The derived areas (from flowRegion) must fit the page too, and each column must be wide enough to read.
  const eff = effectivePageDesign(profile);
  for (const t of [eff.first, eff.following, eff.last]) {
    if (!t) continue;
    const name = PAGE_TEMPLATE_LABEL[t.id];
    if (t.derived && (t.flow.yPt + t.flow.hPt > eff.heightPt + 0.01 || t.flow.hPt < MIN_FLOW_PT)) out.push(`${name}: the flow area does not fit the ${eff.orientation} ${PAPER_SIZES[eff.paper].label} page. Set its top and height.`);
    const colW = (t.flow.wPt - (t.columns - 1) * t.columnGapPt) / t.columns;
    if (colW < MIN_COLUMN_PT) out.push(`${name}: each of the ${t.columns} columns would be only ${Math.max(0, Math.round(colW))} pt wide; at least ${MIN_COLUMN_PT} pt is needed.`);
  }
  return out;
}

/* ------------------------------------------------------------------ changes */

/** What `SET_PAGE_DESIGN` may change. `pageTemplates` replaces the templates as a whole; `null` removes them. */
export interface PageDesignPatch {
  paper?: PaperSize;
  orientation?: 'portrait' | 'landscape';
  pageMarginsMm?: [number, number, number, number];
  pageTemplates?: PresentationProfile['pageTemplates'] | null;
}

/**
 * The page templates refitted to another paper or orientation: every flow area keeps its distance from the top of the
 * page and from the bottom, and spans the page between the margins. Templates given in `explicit` keep a flow area
 * they set themselves (it is already in the new page's coordinates).
 */
export function refitTemplates(profile: Partial<PresentationProfile>, next: Partial<PresentationProfile>, explicit?: PresentationProfile['pageTemplates']): NonNullable<PresentationProfile['pageTemplates']> {
  const before = effectivePageDesign(profile);
  const after = pageSizePt(next);
  const mg = marginsPt(next);
  const fit = (t: EffectiveTemplate): FlowArea => {
    const gapBelow = Math.max(0, before.heightPt - (t.flow.yPt + t.flow.hPt));
    const y = Math.min(t.flow.yPt, Math.max(0, after.heightPt - MIN_FLOW_PT - gapBelow));
    return { xPt: mg.left, yPt: round1(y), wPt: round1(after.widthPt - mg.left - mg.right), hPt: round1(Math.max(MIN_FLOW_PT, after.heightPt - gapBelow - y)) };
  };
  const tpl = explicit ?? profile.pageTemplates ?? {};
  const keep = (t: EffectiveTemplate, own: PageTemplate | undefined): PageTemplate => ({ ...(own ?? {}), flowArea: explicit && own?.flowArea ? { ...own.flowArea } : fit(t) });
  const hasLast = explicit ? !!explicit.last : !!before.last;
  return {
    first: keep(before.first, tpl.first),
    following: keep(before.following, tpl.following),
    ...(hasLast ? { last: keep(before.last ?? before.following, tpl.last) } : {}),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** True when a change gives the pages another size (paper or orientation). */
export function pagePaperChanged(profile: Partial<PresentationProfile> | undefined, patch: PageDesignPatch): boolean {
  return (patch.paper !== undefined && patch.paper !== (profile?.paper ?? 'US-Letter')) || (patch.orientation !== undefined && patch.orientation !== (profile?.orientation ?? 'portrait'));
}

/** The profile after a page design change (not validated). */
export function applyPageDesignPatch(profile: PresentationProfile, patch: PageDesignPatch): PresentationProfile {
  const next: PresentationProfile = { ...profile };
  if (patch.paper !== undefined) next.paper = patch.paper;
  if (patch.orientation !== undefined) { if (patch.orientation === 'portrait') delete next.orientation; else next.orientation = patch.orientation; }
  if (patch.pageMarginsMm !== undefined) next.pageMarginsMm = [...patch.pageMarginsMm] as [number, number, number, number];
  const given = patch.pageTemplates ? (JSON.parse(JSON.stringify(patch.pageTemplates)) as NonNullable<PresentationProfile['pageTemplates']>) : undefined;
  if (patch.pageTemplates === null || (given && !Object.keys(given).length)) delete next.pageTemplates;
  else if (pagePaperChanged(profile, patch)) next.pageTemplates = refitTemplates(profile, next, given);
  else if (given) next.pageTemplates = given;
  return next;
}

/**
 * Fixed items moved onto pages of another size: an item in the lower half keeps its distance from the bottom edge, an
 * item in the right half its distance from the right edge, and an item that ran from margin to margin still does.
 * Locked items stay where they are. Returns only the items that move.
 */
export function refitFixedLayouts(project: Project, before: Partial<PresentationProfile> | undefined, after: Partial<PresentationProfile>): Array<{ nodeId: string; layout: { xPt: number; yPt: number; wPt: number; hPt: number } }> {
  const a = pageSizePt(before), b = pageSizePt(after);
  if (a.widthPt === b.widthPt && a.heightPt === b.heightPt) return [];
  const ma = marginsPt(before), mb = marginsPt(after);
  const out: Array<{ nodeId: string; layout: { xPt: number; yPt: number; wPt: number; hPt: number } }> = [];
  for (const n of project.nodes) {
    const p = n.layout?.paged;
    if (p?.mode !== 'fixed' || n.locked) continue;
    let x = p.xPt ?? 0, y = p.yPt ?? 0, w = p.wPt ?? 100;
    const h = p.hPt ?? 20;
    const rightGap = a.widthPt - (x + w);
    if (x <= ma.left + 2 && rightGap <= ma.right + 2 && rightGap >= -0.5) { x = Math.min(x, mb.left); w = b.widthPt - x - Math.max(0, Math.min(rightGap, mb.right)); }
    else if (x + w / 2 > a.widthPt / 2) x = b.widthPt - Math.max(0, rightGap) - w;
    if (y + h / 2 > a.heightPt / 2) y = b.heightPt - Math.max(0, a.heightPt - (y + h)) - h;
    x = Math.max(0, x);
    w = Math.max(8, Math.min(w, b.widthPt - x));
    y = Math.max(0, Math.min(y, b.heightPt - h));
    const next = { xPt: round1(x), yPt: round1(y), wPt: round1(w), hPt: h };
    if (next.xPt !== (p.xPt ?? 0) || next.yPt !== (p.yPt ?? 0) || next.wPt !== (p.wPt ?? 100)) out.push({ nodeId: n.id, layout: next });
  }
  return out;
}

/** Plain words for a page design change (the undo label). */
export function pageDesignLabel(before: PresentationProfile | undefined, patch: PageDesignPatch): string {
  const parts: string[] = [];
  if (patch.paper !== undefined && patch.paper !== (before?.paper ?? 'US-Letter')) parts.push(`paper ${PAPER_SIZES[patch.paper]?.label ?? patch.paper}`);
  if (patch.orientation !== undefined && patch.orientation !== (before?.orientation ?? 'portrait')) parts.push(patch.orientation);
  if (patch.pageMarginsMm !== undefined) parts.push('margins');
  if (patch.pageTemplates !== undefined) parts.push('page templates');
  return parts.length ? `Page design: ${parts.join(', ')}` : 'Page design';
}

/** Fixed items that reach outside the page (after a paper or orientation change). */
export function fixedItemsOffPage(project: Project): Array<{ nodeId: string; name: string }> {
  const size = pageSizePt(pagedProfileOf(project));
  return project.nodes
    .filter((n) => n.layout?.paged?.mode === 'fixed')
    .filter((n) => { const p = n.layout!.paged!; return (p.xPt ?? 0) + (p.wPt ?? 0) > size.widthPt + 0.01 || (p.yPt ?? 0) + (p.hPt ?? 0) > size.heightPt + 0.01; })
    .map((n) => ({ nodeId: n.id, name: n.name ?? n.id }));
}

/** Problems with the new per-component page settings (keep together, breaks, spanning, lines). */
export function pagedFlowProblems(l: Record<string, unknown>): string | null {
  if (l.breakBefore !== undefined && l.breakBefore !== 'page' && l.breakBefore !== 'column') return 'A component starts on a new page or a new column.';
  for (const k of ['minLinesLeft', 'minLinesCarried']) {
    const v = l[k];
    if (v !== undefined && (!finite(v) || !Number.isInteger(v) || v < 1 || v > 10)) return 'The number of lines kept together must be 1 to 10.';
  }
  for (const k of ['keepTogether', 'spanColumns', 'splitText']) if (l[k] !== undefined && typeof l[k] !== 'boolean') return `${k} must be on or off.`;
  return null;
}
