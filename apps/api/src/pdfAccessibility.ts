import { effectivePageDesign, pagedProfileOf, type Project } from '@iss/model';
import type { Finding, RBlock, RInline, RNode, Resolution } from '@iss/resolver';
import { renderPagedDocument, usesPageDesign } from '@iss/renderers';
import type { Composer } from './composer';
import { runVeraPdf, VERAPDF_NOT_INSTALLED, type VeraPdfResult } from './verapdf';

/**
 * "Checked by the studio": the studio opens the PDF it produced and checks what a person using a screen reader depends
 * on (docs/design/WAVE2B_PAGES_LIBRARY_WORDING.md section 2; every check, and what it can and cannot see, is described
 * in docs/design/PDF_ACCESSIBILITY.md).
 *
 * `checkPdfAccessibility` is a function of the PDF bytes and of what the studio knows about the document (its parts
 * per page from the composed pages, their names and descriptions, the brand colours). It reads the PDF with pdf.js
 * (the structure tree, the mark info, the document information, the viewer preferences, the annotations and the
 * drawing operations of every page) and never changes it. A check that cannot be done reliably says "not checked";
 * it never passes. This is not PDF/UA validation: that is veraPDF's job (see `verapdf.ts`).
 */

export const PDF_A11Y_CHECKER_VERSION = 'iss-pdf-a11y/1';

export type PdfCheckId = 'tagged' | 'title' | 'language' | 'headings' | 'tables' | 'pictures' | 'links' | 'lists' | 'reading-order' | 'contrast' | 'untagged-text';
export type PdfCheckStatus = 'passed' | 'failed' | 'not-checked';

/** The checks, in the order they are shown, with their names in plain words. */
export const PDF_CHECKS: ReadonlyArray<{ id: PdfCheckId; label: string }> = [
  { id: 'tagged', label: 'Tagged, with a structure tree' },
  { id: 'title', label: 'Has a title' },
  { id: 'language', label: 'Says its language' },
  { id: 'headings', label: 'Headings exist and their levels do not skip' },
  { id: 'tables', label: 'Every table has header cells' },
  { id: 'pictures', label: 'Every picture has a description or is decoration' },
  { id: 'links', label: 'Links have readable text' },
  { id: 'lists', label: 'Lists are tagged as lists' },
  { id: 'reading-order', label: 'Reading order follows the document' },
  { id: 'contrast', label: 'Text contrast meets WCAG AA' },
  { id: 'untagged-text', label: 'All text is in the tags' },
];

export interface PdfCheck { id: PdfCheckId; label: string; status: PdfCheckStatus; /** One or two plain sentences: what was found, or why it was not checked. */ detail: string; failures: number }

/** A part of the document as the studio composed it on one page. */
export interface PdfPart {
  nodeId: string;
  /** The component's name, for messages. */
  name: string;
  type: string;
  page: number;
  /** Its text on this page, as laid out (what the PDF should contain for it). Empty for pictures and shapes. */
  text: string;
  /** Position in the expected reading order of this page (0 = first). */
  order: number;
  /** Where it sits: a fixed item or flowing content. */
  placement: 'fixed' | 'flow';
  decorative?: boolean;
  /** Descriptions the studio gives its pictures (image description, chart summary, QR code description). */
  descriptions?: string[];
  /** An image whose description is missing in the document (and is not marked as decoration). */
  missingDescription?: boolean;
  /** The items of each list it contains, as plain text. */
  lists?: string[][];
  /** The table continues from an earlier page. */
  continued?: boolean;
}

export interface PdfColourName { hex: string; name: string; where: 'brand' | 'style' }

export interface PdfA11yContext {
  /** The document's language (BCP 47), e.g. `en-US`. */
  locale: string;
  /** The document's parts per page in the expected reading order. Without them the reading order is not checked and findings name pages only. */
  parts?: PdfPart[];
  /** When the document requires an accessible PDF, failures are blocking. */
  required?: boolean;
  /** Colours the document chose (brand, text styles), to say where a low contrast comes from. */
  colours?: PdfColourName[];
  /**
   * Pages that have a page background (page design). On them, text drawn outside the tags before any tagged text is
   * taken to be part of the background (a picture such as a logo mark can contain text): it is decoration, not checked.
   */
  backgroundPages?: number[];
}

export type PdfA11yFinding = Finding & { source: 'accessibility'; details: { check: PdfCheckId; title: string; fix: string; [k: string]: unknown } };

export interface PdfKnownLimit { id: 'pdfua-identifier' | 'artifacts' | 'link-descriptions'; text: string }

export interface PdfA11yReport {
  level: 'studio';
  checker: string;
  reader: string;
  pageCount: number;
  title: string | null;
  language: string | null;
  required: boolean;
  checks: PdfCheck[];
  findings: PdfA11yFinding[];
  summary: { ran: number; passed: number; failed: number; notChecked: number };
  /** What the composing browser cannot write, so a PDF/UA validator is expected to report it whatever the document does. */
  knownLimits: PdfKnownLimit[];
}

/* ------------------------------------------------------------------ the document's parts (from the composed pages) */

/** What the composer reads from the composed pages: each component's text per page, in page order. */
export interface ComposedPartText { page: number; nodeId: string; text: string; fixed: boolean }

/** Runs in the composed page (before the PDF is printed): the text of every top-level component on every page. */
export const PDF_PARTS_JS = String.raw`
(function () {
  var out = [];
  // Text that is not drawn (visually hidden summaries) or hidden from assistive technology is not in the PDF tags.
  var hide = document.createElement('style');
  hide.textContent = '.iss-sr,[aria-hidden="true"]{display:none!important}';
  document.head.appendChild(hide);
  document.querySelectorAll('#iss-pages > .page').forEach(function (pg, i) {
    var seen = {};
    pg.querySelectorAll('.iss-fixed[data-node-id], .iss-block[data-node-id]').forEach(function (el) {
      var id = el.getAttribute('data-node-id');
      var text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      var key = id + (el.classList.contains('iss-fixed') ? '|f' : '|b');
      if (seen[key] !== undefined) { out[seen[key]].text += ' ' + text; return; }
      seen[key] = out.length;
      out.push({ page: i + 1, nodeId: id, text: text, fixed: el.classList.contains('iss-fixed') });
    });
  });
  hide.parentNode.removeChild(hide);
  return out;
})()
`;

const inlineText = (xs: RInline[] | undefined): string => (xs ?? []).map((i) => (i.kind === 'break' ? ' ' : i.text ?? '')).join('');
function listsOf(n: RNode): string[][] {
  const out: string[][] = [];
  const blocks: RBlock[] = [...(n.text ?? [])];
  for (const b of blocks) if ((b.kind === 'ul' || b.kind === 'ol') && b.items?.length) out.push(b.items.map(inlineText));
  for (const c of n.children ?? []) if (c.visible) out.push(...listsOf(c));
  return out;
}
const nodeName = (project: Project, id: string): string => {
  const n = project.nodes.find((x) => x.id === id);
  if (n?.name && n.name !== n.id) return n.name;
  const s = id.replace(/[-_.]/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
};
function descriptionsOf(project: Project, n: RNode): { descriptions: string[]; missing: boolean } {
  const d: string[] = [];
  let missing = false;
  const walk = (x: RNode) => {
    if (!x.visible) return;
    if (x.type === 'image' && x.image) {
      const useBrand = !!project.brand?.logoDataUri && x.image.src.startsWith('asset:');
      const alt = (useBrand ? project.brand!.logoAlt ?? x.image.alt : x.image.alt) ?? '';
      if (alt.trim()) d.push(alt.trim());
      else if (!x.decorative) missing = true;
    }
    if (x.type === 'chart' && x.chart?.summary) d.push(x.chart.summary);
    if (x.type === 'qr-code' && x.qr?.url) d.push(`QR code for ${x.qr.url}`);
    x.children.forEach(walk);
  };
  walk(n);
  return { descriptions: d, missing };
}

/**
 * The document's parts per page, in the order a person reads the page: fixed items above the bottom of the flow area
 * from top to bottom (left to right when side by side), the flowing content in the order it was placed, then fixed
 * items at or below the bottom of the flow area from top to bottom. This order comes from where things are on the
 * page, not from the order of the page source, so it can disagree with the tags.
 */
export function pdfPartsOf(res: Resolution, project: Project, composed: { pages: Array<{ index: number; nodeIds: string[]; fixedNodeIds: string[]; flowTopPt?: number; flowBottomPt: number }>; parts: ComposedPartText[] }): PdfPart[] {
  const byId = new Map(res.root.children.map((n) => [n.id, n]));
  const out: PdfPart[] = [];
  for (const pg of composed.pages) {
    const textOf = (id: string, fixed: boolean) => composed.parts.filter((p) => p.page === pg.index && p.nodeId === id && p.fixed === fixed).map((p) => p.text).join(' ').trim();
    const fixed = pg.fixedNodeIds.map((id) => ({ id, pl: byId.get(id)?.layout?.paged })).filter((f) => !!byId.get(f.id));
    const sortVisual = (xs: typeof fixed) => [...xs].sort((a, b) => {
      const ay = a.pl?.yPt ?? 0, by = b.pl?.yPt ?? 0, ah = a.pl?.hPt ?? 0, bh = b.pl?.hPt ?? 0;
      const sameRow = ay < by + bh && by < ay + ah; // side by side: left to right
      return sameRow && Math.abs(ay - by) < Math.min(ah, bh) / 2 ? (a.pl?.xPt ?? 0) - (b.pl?.xPt ?? 0) : ay - by;
    });
    const above = sortVisual(fixed.filter((f) => (f.pl?.yPt ?? 0) < pg.flowBottomPt - 0.01));
    const below = sortVisual(fixed.filter((f) => (f.pl?.yPt ?? 0) >= pg.flowBottomPt - 0.01));
    let order = 0;
    const push = (id: string, placement: 'fixed' | 'flow') => {
      const n = byId.get(id);
      if (!n) return;
      const { descriptions, missing } = descriptionsOf(project, n);
      const lists = listsOf(n);
      const earlier = placement === 'flow' && n.type === 'repeating-table' && composed.pages.some((q) => q.index < pg.index && q.nodeIds.includes(id));
      out.push({
        nodeId: id, name: nodeName(project, id), type: n.type, page: pg.index, text: textOf(id, placement === 'fixed'), order: order++, placement,
        ...(n.decorative ? { decorative: true } : {}), ...(descriptions.length ? { descriptions } : {}), ...(missing ? { missingDescription: true } : {}),
        ...(lists.length ? { lists } : {}), ...(earlier ? { continued: true } : {}),
      });
    };
    above.forEach((f) => push(f.id, 'fixed'));
    pg.nodeIds.forEach((id) => push(id, 'flow'));
    below.forEach((f) => push(f.id, 'fixed'));
  }
  return out;
}

/** Colours the document chose itself, named for messages ("the brand text colour"). */
export function documentColours(project: Project): PdfColourName[] {
  const out: PdfColourName[] = [];
  const b = project.brand;
  if (b) {
    if (b.text) out.push({ hex: b.text, name: 'the brand text colour', where: 'brand' });
    out.push({ hex: b.primary, name: 'the brand primary colour', where: 'brand' });
    out.push({ hex: b.accent, name: 'the brand accent colour', where: 'brand' });
  }
  for (const s of project.styles ?? []) if (s.color) out.push({ hex: s.color, name: `the colour of the text style “${s.name}”`, where: 'style' });
  return out;
}

/* ------------------------------------------------------------------ colour and contrast (WCAG 2.x) */

type RGB = [number, number, number];
const hex = (c: RGB): string => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const lin = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
export const luminance = (c: RGB): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** The WCAG contrast ratio of two colours (1 to 21). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const blend = (under: RGB, over: RGB, alpha: number): RGB => [0, 1, 2].map((i) => under[i] * (1 - alpha) + over[i] * alpha) as RGB;
const parseHex = (s: string): RGB | null => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.trim()); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null; };

/* ------------------------------------------------------------------ reading the PDF */

type Mat = [number, number, number, number, number, number];
const ID: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
type Box = [number, number, number, number];
function boxOf(m: Mat, b: Box): Box {
  const pts = [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[0], b[3]), apply(m, b[2], b[3])];
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}
const inter = (a: Box | null, b: Box): Box => (a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b);
const inside = (b: Box, x: number, y: number) => x >= b[0] - 0.01 && x <= b[2] + 0.01 && y >= b[1] - 0.01 && y <= b[3] + 0.01;

/** Something drawn on the page. `image`: a picture; its colours are read from its pixels when pdf.js gives them (`img`, `inv` maps the page to the picture). */
interface Layer { box: Box; kind: 'fill' | 'image' | 'shading'; colors: RGB[]; alpha: number; img?: Img | null; inv?: Mat }
/** Decoded picture data as pdf.js gives it (kind 1: 1 bit grey, 2: RGB, 3: RGBA). */
interface Img { width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray }

const invert = (m: Mat): Mat | null => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
/** The darkest and the lightest opaque pixel of a region of a picture (u, v in 0..1, v up), or null when it cannot be read. */
function pictureExtremes(img: Img, u0: number, v0: number, u1: number, v1: number): RGB[] | null {
  const { width: w, height: h, kind, data } = img;
  if (!w || !h || !data || (kind !== 2 && kind !== 3)) return null;
  const x0 = Math.max(0, Math.floor(Math.min(u0, u1) * w)), x1 = Math.min(w - 1, Math.ceil(Math.max(u0, u1) * w));
  const y0 = Math.max(0, Math.floor((1 - Math.max(v0, v1)) * h)), y1 = Math.min(h - 1, Math.ceil((1 - Math.min(v0, v1)) * h));
  if (x1 < x0 || y1 < y0) return null;
  const bpp = kind === 3 ? 4 : 3;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 40000)));
  let lo: RGB | null = null, hi: RGB | null = null, loL = 2, hiL = -1;
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    const o = (y * w + x) * bpp;
    if (bpp === 4 && data[o + 3] < 128) continue;
    const c: RGB = [data[o], data[o + 1], data[o + 2]];
    const l = luminance(c);
    if (l < loL) { loL = l; lo = c; }
    if (l > hiL) { hiL = l; hi = c; }
  }
  return lo && hi ? [lo, hi] : [];
}
interface Glyph { text: string; x: number; y: number; color: RGB; alpha: number; sizePt: number; bold: boolean; mcid: number | null; tag: string | null; layers: number; /** On a page with a background: drawn outside the tags before any tagged text, so part of the background. */ background: boolean }
interface PageRead { mcText: Map<number, string>; mcTag: Map<number, string>; glyphs: Glyph[]; layers: Layer[]; untaggedText: string; backgroundText: string; unmarkedDrawings: number }

interface StructNode { role: string; alt?: string; children: Array<StructNode | { type: string; id: string }> }
interface El { role: string; alt: string | null; page: number; start: number; end: number; text: string; kids: El[]; parent: El | null; contentIds: number[] }
interface PageTree { page: number; T: string; els: El[]; mcPos: Map<number, number> }

const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

async function loadPdfjs(): Promise<any> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

function readOperators(pdfjs: any, ol: { fnArray: number[]; argsArray: any[] }, fontBold: (id: string) => boolean, pattern: (id: string) => unknown, image: (id: string) => Img | null, hasBackground: boolean): PageRead {
  const O = pdfjs.OPS;
  /** `paint`: the fill is a pattern (gradient stops, or null when its colours cannot be known). */
  interface GS { ctm: Mat; fill: RGB; paint: RGB[] | null | undefined; ca: number; clip: Box | null; group: number }
  let gs: GS = { ctm: ID, fill: [0, 0, 0], paint: undefined, ca: 1, clip: null, group: 1 };
  const stopsOf = (ir: unknown): RGB[] | null => (Array.isArray(ir) && ir[0] === 'RadialAxial' && Array.isArray(ir[3]) ? (ir[3] as Array<[number, string]>).map((x) => parseHex(String(x[1]))).filter((c): c is RGB => !!c) : null);
  let seenTaggedText = false;
  const stack: GS[] = [];
  const groupStack: GS[] = [];
  let tm: Mat = ID, tlm: Mat = ID, font = '', size = 0, leading = 0;
  let lastPath: Box | null = null;
  const mc: Array<{ tag: string; mcid: number | null }> = [];
  const out: PageRead = { mcText: new Map(), mcTag: new Map(), glyphs: [], layers: [], untaggedText: '', backgroundText: '', unmarkedDrawings: 0 };
  const curMc = () => { for (let i = mc.length - 1; i >= 0; i--) if (mc[i].mcid !== null) return mc[i]; return null; };
  const paint = (layer: Layer) => { out.layers.push(layer); if (!mc.length) out.unmarkedDrawings++; };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    switch (fn) {
      case O.save: stack.push({ ...gs }); break;
      case O.restore: gs = stack.pop() ?? gs; break;
      case O.transform: gs.ctm = mul(a as Mat, gs.ctm); break;
      case O.setFillRGBColor: gs.fill = [a[0], a[1], a[2]]; gs.paint = undefined; break;
      case O.setFillColorN: {
        let colors: RGB[] | null = a?.[0] === 'Shading' ? stopsOf(pattern(String(a[1]))) : null;
        // A tiling pattern made of pictures (how this browser draws CSS gradients): the extremes of those pictures.
        if (a?.[0] === 'TilingPattern' && a[2]?.fnArray) {
          const ids = (a[2].fnArray as number[]).map((f, k) => (f === O.paintImageXObject ? String(a[2].argsArray[k]?.[0]) : null)).filter((x): x is string => !!x);
          const all = ids.map((id) => { const im = image(id); return im ? pictureExtremes(im, 0, 0, 1, 1) : null; });
          colors = ids.length && all.every((c) => !!c && c.length) ? all.flat() as RGB[] : null;
        }
        gs.paint = colors && colors.length ? colors : null;
        break;
      }
      case O.setFillTransparent: gs.fill = [255, 255, 255]; gs.ca = 0; break;
      case O.setGState: for (const [k, v] of a[0] ?? []) if (k === 'ca') gs.ca = Number(v); break;
      case O.paintFormXObjectBegin: stack.push({ ...gs }); if (Array.isArray(a?.[0]) && a[0].length === 6) gs.ctm = mul(a[0] as Mat, gs.ctm); break;
      case O.paintFormXObjectEnd: gs = stack.pop() ?? gs; break;
      case O.beginGroup: groupStack.push({ ...gs }); gs = { ...gs, group: gs.group * gs.ca, ca: 1 }; break;
      case O.endGroup: gs = groupStack.pop() ?? gs; break;
      case O.constructPath: {
        const mm = a?.[2] as number[] | undefined;
        lastPath = mm && mm.every((v) => Number.isFinite(v)) ? boxOf(gs.ctm, [mm[0], mm[1], mm[2], mm[3]]) : null;
        break;
      }
      case O.clip: case O.eoClip: if (lastPath) gs.clip = inter(gs.clip, lastPath); break;
      case O.fill: case O.eoFill: case O.fillStroke: case O.eoFillStroke: case O.closeFillStroke: case O.closeEOFillStroke:
        if (lastPath) paint({ box: gs.clip ? inter(gs.clip, lastPath) : lastPath, kind: gs.paint === undefined ? 'fill' : gs.paint ? 'shading' : 'image', colors: gs.paint === undefined ? [gs.fill] : gs.paint ?? [], alpha: gs.ca * gs.group });
        break;
      case O.shadingFill: {
        const stops = stopsOf(typeof a?.[0] === 'string' ? pattern(a[0]) : a?.[0]) ?? [];
        if (gs.clip) paint({ box: gs.clip, kind: stops.length ? 'shading' : 'image', colors: stops, alpha: gs.ca * gs.group });
        break;
      }
      case O.paintImageXObject: case O.paintImageXObjectRepeat:
        paint({ box: boxOf(gs.ctm, [0, 0, 1, 1]), kind: 'image', colors: [], alpha: gs.ca * gs.group, img: typeof a?.[0] === 'string' ? image(a[0]) : null, inv: invert(gs.ctm) ?? undefined });
        break;
      case O.paintInlineImageXObject:
        paint({ box: boxOf(gs.ctm, [0, 0, 1, 1]), kind: 'image', colors: [], alpha: gs.ca * gs.group, img: a?.[0] && typeof a[0] === 'object' ? (a[0] as Img) : null, inv: invert(gs.ctm) ?? undefined });
        break;
      case O.paintImageMaskXObject: case O.paintSolidColorImageMask: case O.paintImageMaskXObjectGroup:
        paint({ box: boxOf(gs.ctm, [0, 0, 1, 1]), kind: 'fill', colors: [gs.fill], alpha: gs.ca * gs.group });
        break;
      case O.beginMarkedContent: mc.push({ tag: String(a?.[0] ?? ''), mcid: null }); break;
      case O.beginMarkedContentProps: {
        const tag = String(a?.[0] ?? '');
        const mcid = typeof a?.[1] === 'number' ? a[1] : null;
        mc.push({ tag, mcid });
        if (mcid !== null) { out.mcTag.set(mcid, tag); if (!out.mcText.has(mcid)) out.mcText.set(mcid, ''); }
        break;
      }
      case O.endMarkedContent: mc.pop(); break;
      case O.beginText: tm = ID; tlm = ID; break;
      case O.setFont: font = String(a[0]); size = Number(a[1]); break;
      case O.setLeading: leading = Number(a[0]); break;
      case O.setTextMatrix: tm = [a[0], a[1], a[2], a[3], a[4], a[5]]; tlm = tm; break;
      case O.moveText: tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm; break;
      case O.setLeadingMoveText: leading = -a[1]; tlm = mul([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm; break;
      case O.nextLine: tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
      case O.showText: case O.showSpacedText: case O.nextLineShowText: case O.nextLineSetSpacingShowText: {
        const glyphs = (fn === O.showText || fn === O.showSpacedText ? a[0] : a[a.length - 1]) as unknown[];
        const text = (Array.isArray(glyphs) ? glyphs : []).map((g: any) => (g && typeof g === 'object' ? g.unicode ?? '' : '')).join('');
        if (!text) break;
        const m = mul(tm, gs.ctm);
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const sizePt = Math.abs(size) * scale;
        const [x, y] = apply(m, Math.abs(size) * 0.25, Math.abs(size) * 0.3);
        const cur = curMc();
        const background = hasBackground && !mc.length && !seenTaggedText;
        if (cur) { out.mcText.set(cur.mcid!, (out.mcText.get(cur.mcid!) ?? '') + text); if (text.trim()) seenTaggedText = true; }
        else if (background) out.backgroundText += text;
        else if (!mc.length) out.untaggedText += text;
        out.glyphs.push({ text, x, y, color: gs.paint ? gs.paint[0] : gs.fill, alpha: gs.ca * gs.group, sizePt, bold: fontBold(font), mcid: cur?.mcid ?? null, tag: cur?.tag ?? (mc.length ? mc[mc.length - 1].tag : null), layers: out.layers.length, background });
        break;
      }
      default: break;
    }
  }
  return out;
}

function buildTree(page: number, root: StructNode | null, read: PageRead): PageTree {
  const tree: PageTree = { page, T: '', els: [], mcPos: new Map() };
  const walk = (n: StructNode, parent: El | null) => {
    const el: El = { role: n.role, alt: typeof n.alt === 'string' ? n.alt : null, page, start: tree.T.length, end: 0, text: '', kids: [], parent, contentIds: [] };
    if (n.role !== 'Root') tree.els.push(el);
    parent?.kids.push(el);
    for (const c of n.children ?? []) {
      if ('role' in c) { walk(c as StructNode, el); continue; }
      const m = /_mc(\d+)$/.exec((c as { id: string }).id ?? '');
      if (!m) continue;
      const mcid = Number(m[1]);
      el.contentIds.push(mcid);
      if (!tree.mcPos.has(mcid)) tree.mcPos.set(mcid, tree.T.length);
      tree.T += norm(read.mcText.get(mcid) ?? '');
    }
    el.end = tree.T.length;
    return el;
  };
  if (root) walk(root, null);
  for (const el of tree.els) el.text = tree.T.slice(el.start, el.end);
  return tree;
}

/** Where each part of a page is in the page's tags (the reading order of the tags). */
function locateParts(tree: PageTree, parts: PdfPart[]): Map<PdfPart, { start: number; end: number }> {
  const claimed: Array<{ start: number; end: number }> = [];
  const at = new Map<PdfPart, { start: number; end: number }>();
  const ordered = parts.filter((p) => norm(p.text).length >= 2).sort((a, b) => norm(b.text).length - norm(a.text).length);
  for (const p of ordered) {
    const full = norm(p.text);
    const key = full.slice(0, 48);
    let pos = tree.T.indexOf(key);
    while (pos >= 0) {
      const len = tree.T.startsWith(full, pos) ? full.length : key.length;
      if (!claimed.some((c) => pos < c.end && pos + len > c.start)) { const r = { start: pos, end: pos + len }; claimed.push(r); at.set(p, r); break; }
      pos = tree.T.indexOf(key, pos + 1);
    }
  }
  return at;
}

/** Longest increasing subsequence (indexes) of the given positions. */
function lis(xs: number[]): Set<number> {
  const prev: number[] = new Array(xs.length).fill(-1);
  const tails: number[] = [];
  xs.forEach((x, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[tails[mid]] < x) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { keep.add(k); k = prev[k]; }
  return keep;
}

const HEADING = /^H([1-6])?$/;
const VAGUE_LINK = /^(click here|click|here|link|this link|more|read more|learn more|details|this|go|open)$/i;
const BULLET = /^[•◦▪‣·–*-]\s+\S|^\d{1,2}[.)]\s+\S/;

const q = (s: string): string => `“${s}”`;
const short = (s: string, n = 60): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Checks a PDF the studio produced. `ctx.parts` (from `pdfPartsOf`) lets the checks name the part of the document and
 * check the reading order; without them findings name pages and the reading order is not checked.
 */
export async function checkPdfAccessibility(pdf: Uint8Array, ctx: PdfA11yContext): Promise<PdfA11yReport> {
  const required = !!ctx.required;
  const severity: Finding['severity'] = required ? 'blocking' : 'warning';
  const findings: PdfA11yFinding[] = [];
  const checks = new Map<PdfCheckId, PdfCheck>();
  const label = (id: PdfCheckId) => PDF_CHECKS.find((c) => c.id === id)!.label;
  const set = (id: PdfCheckId, status: PdfCheckStatus, detail: string) => { checks.set(id, { id, label: label(id), status, detail, failures: findings.filter((f) => f.details.check === id).length }); };
  const fail = (check: PdfCheckId, code: string, a: { title: string; message: string; fix: string; nodeId?: string; page?: number; extra?: Record<string, unknown> }) => {
    findings.push({ code, severity, source: 'accessibility', message: `${a.message} ${a.fix}`, suggestion: a.fix, ...(a.nodeId ? { nodeId: a.nodeId } : {}), ...(a.page ? { page: a.page } : {}), details: { check, title: a.title, fix: a.fix, ...(a.extra ?? {}) } });
  };
  const parts = ctx.parts ?? null;
  const knownLimits: PdfKnownLimit[] = [];
  let pdfjs: any;
  let doc: any;
  try {
    pdfjs = await loadPdfjs();
    doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false }).promise;
  } catch (e) {
    for (const c of PDF_CHECKS) checks.set(c.id, { id: c.id, label: c.label, status: 'not-checked', detail: `The PDF could not be opened (${e instanceof Error ? e.message : String(e)}).`, failures: 0 });
    return finish();
  }

  try {
    const pageCount: number = doc.numPages;
    const markInfo = await doc.getMarkInfo().catch(() => null);
    const meta = await doc.getMetadata().catch(() => ({ info: {}, metadata: null }));
    const prefs = await doc.getViewerPreferences().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const pages: Array<{ tree: PageTree; read: PageRead; links: Array<{ url: string; contents: string }> }> = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const ol = await page.getOperatorList();
      const objs = await resolveObjects(pdfjs, page, ol);
      const read = readOperators(pdfjs, ol, (id) => {
        try { const f = page.commonObjs.has(id) ? page.commonObjs.get(id) : null; return /bold|black|heavy|semibold|demi/i.test(String(f?.name ?? '')); } catch { return false; }
      }, (id) => objs.get(id) ?? null, (id) => { const im = objs.get(id); return im && typeof im === 'object' && 'data' in (im as object) ? (im as Img) : null; }, (ctx.backgroundPages ?? []).includes(i));
      const struct = (await page.getStructTree().catch(() => null)) as StructNode | null;
      const tree = buildTree(i, struct, read);
      const annots = (await page.getAnnotations().catch(() => [])) as Array<{ subtype?: string; url?: string; unsafeUrl?: string; dest?: unknown; contentsObj?: { str?: string } }>;
      const links = annots.filter((a) => a.subtype === 'Link').map((a) => ({ url: String(a.url ?? a.unsafeUrl ?? ''), contents: String(a.contentsObj?.str ?? '') }));
      pages.push({ tree, read, links });
      page.cleanup?.();
    }
    const partsOn = (p: number) => (parts ?? []).filter((x) => x.page === p);
    const located = new Map<number, Map<PdfPart, { start: number; end: number }>>();
    for (const pg of pages) located.set(pg.tree.page, locateParts(pg.tree, partsOn(pg.tree.page)));
    /** The part of the document an element or a position of a page belongs to (null when it cannot be told). */
    const partAt = (page: number, pos: number, empty = false): PdfPart | null => {
      const m = located.get(page);
      if (!m) return null;
      for (const [p, r] of m) if (empty ? pos > r.start && pos <= r.end : pos >= r.start && pos < r.end) return p;
      if (empty) for (const [p, r] of m) if (pos === r.start) return p;
      return null;
    };
    const partOf = (el: El): PdfPart | null => {
      if (el.alt) {
        const want = norm(el.alt);
        const hit = partsOn(el.page).find((p) => (p.descriptions ?? []).some((d) => norm(d) === want));
        if (hit) return hit;
      }
      return el.end > el.start ? partAt(el.page, el.start) : partAt(el.page, el.start, true);
    };
    const where = (p: PdfPart | null, page: number) => (p ? `${q(p.name)} on page ${page}` : `page ${page}`);
    const allEls = pages.flatMap((p) => p.tree.els);

    /* tagged */
    const hasTree = pages.some((p) => p.tree.els.length > 0);
    if (markInfo?.Marked === true && hasTree) set('tagged', 'passed', `The PDF says it is tagged and has a structure tree on ${pageCount === 1 ? 'its page' : `all ${pageCount} pages`}.`);
    else {
      fail('tagged', 'PDF_A11Y_NOT_TAGGED', { title: 'The PDF is not tagged', message: markInfo?.Marked !== true ? 'The PDF does not say it is tagged, so assistive technology cannot rely on its structure.' : 'The PDF has no structure tree, so a screen reader has nothing to follow.', fix: 'The studio composes tagged PDFs; compose the PDF again from the studio and check again.' });
      set('tagged', 'failed', 'The PDF is not tagged or has no structure tree.');
    }
    const untagged = !hasTree;
    const needTags = (id: PdfCheckId, what: string) => { set(id, 'not-checked', `Not checked: without tags there is no ${what} to check.`); };

    /* title */
    const title = typeof info.Title === 'string' ? info.Title.trim() : '';
    if (!title || /\.(pdf|html?)$/i.test(title) || /^untitled$/i.test(title)) {
      fail('title', 'PDF_A11Y_NO_TITLE', { title: 'The PDF has no title', message: title ? `The PDF title is ${q(title)}, which is a file name, not a title.` : 'The PDF has no title, so a screen reader announces its file name instead.', fix: 'Give the document a name in the studio; the title is taken from the issuer and the document.' });
      set('title', 'failed', 'The PDF has no usable title.');
    } else if (prefs?.DisplayDocTitle !== true) {
      fail('title', 'PDF_A11Y_TITLE_NOT_SHOWN', { title: 'The PDF title is not shown', message: `The PDF has the title ${q(title)} but does not ask readers to show it instead of the file name.`, fix: 'This is set by the studio’s composer; report it as a studio problem.' });
      set('title', 'failed', `Title ${q(title)}, but readers are not asked to show it.`);
    } else set('title', 'passed', `Title ${q(title)}, shown by readers instead of the file name.`);

    /* language */
    const lang = typeof info.Language === 'string' ? info.Language.trim() : '';
    const primary = (s: string) => s.toLowerCase().split('-')[0];
    if (!lang || !/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i.test(lang)) {
      fail('language', 'PDF_A11Y_NO_LANGUAGE', { title: 'The PDF does not say its language', message: lang ? `The PDF gives ${q(lang)} as its language, which is not a language code.` : 'The PDF does not say which language it is in, so a screen reader may read it with the wrong voice.', fix: 'The language comes from the document’s language; compose the PDF again from the studio.' });
      set('language', 'failed', 'No language is set in the PDF.');
    } else if (ctx.locale && primary(lang) !== primary(ctx.locale)) {
      fail('language', 'PDF_A11Y_WRONG_LANGUAGE', { title: 'The PDF says the wrong language', message: `The PDF says it is in ${q(lang)} but the document is in ${q(ctx.locale)}.`, fix: 'Compose the PDF again from the studio for this customer’s language.' });
      set('language', 'failed', `The PDF says ${lang}; the document is ${ctx.locale}.`);
    } else set('language', 'passed', `The PDF says it is in ${lang}.`);

    /* headings */
    if (untagged) needTags('headings', 'heading');
    else {
      const heads = allEls.filter((e) => HEADING.test(e.role));
      if (!heads.length) {
        fail('headings', 'PDF_A11Y_NO_HEADINGS', { title: 'The PDF has no headings', message: 'The PDF has no headings, so a screen reader cannot jump from section to section.', fix: 'Give the document a title with a heading (for example a rich text with a heading as its first line).' });
        set('headings', 'failed', 'No headings were found in the tags.');
      } else {
        let prev = 0;
        const levels: number[] = [];
        for (const h of heads) {
          const level = Number(HEADING.exec(h.role)![1] ?? 1);
          levels.push(level);
          if (level > prev + 1) {
            const p = partOf(h);
            const shown = textOfEl(pages, h);
            fail('headings', 'PDF_A11Y_HEADING_SKIPPED', {
              title: prev === 0 ? 'The first heading is not a main heading' : 'A heading level is skipped',
              message: prev === 0 ? `The first heading of the PDF, ${q(short(shown))} in ${where(p, h.page)}, is level ${level}; a document starts with a level 1 heading.` : `The heading ${q(short(shown))} in ${where(p, h.page)} is level ${level} right after a level ${prev} heading, so a level is skipped.`,
              fix: prev === 0 ? (p ? `Make the first heading of ${q(p.name)} the document’s main (level 1) heading.` : 'Make the first heading a level 1 heading.') : p ? `Make ${q(p.name)} use a heading one level below the heading before it (a level ${prev + 1} heading).` : `Use a level ${prev + 1} heading there.`,
              nodeId: p?.nodeId, page: h.page, extra: { level, previous: prev },
            });
          }
          prev = level;
        }
        const skipped = findings.filter((f) => f.details.check === 'headings').length;
        set('headings', skipped ? 'failed' : 'passed', skipped ? `${skipped} heading${skipped === 1 ? ' skips' : 's skip'} a level (levels in order: ${levels.join(', ')}).` : `${heads.length} heading${heads.length === 1 ? '' : 's'}, levels in order: ${levels.join(', ')}.`);
      }
    }

    /* tables */
    if (untagged) needTags('tables', 'table');
    else {
      const tables = allEls.filter((e) => e.role === 'Table');
      let bad = 0;
      for (const t of tables) {
        const rows: El[] = [];
        const collect = (e: El) => { for (const k of e.kids) { if (k.role === 'TR') rows.push(k); else if (k.role === 'THead' || k.role === 'TBody' || k.role === 'TFoot') collect(k); } };
        collect(t);
        const cells = (r: El) => r.kids.filter((k) => k.role === 'TH' || k.role === 'TD');
        const dataRows = rows.filter((r) => cells(r).some((c) => c.role === 'TD'));
        if (!dataRows.length) continue;
        const headerRow = rows.some((r) => cells(r).length > 0 && cells(r).every((c) => c.role === 'TH'));
        const rowHeads = dataRows.every((r) => cells(r)[0]?.role === 'TH');
        if (headerRow || rowHeads) continue;
        bad++;
        const p = partOf(t);
        const continued = !!p?.continued;
        fail('tables', 'PDF_A11Y_TABLE_NO_HEADERS', {
          title: continued ? 'A table continues without its header row' : 'A table has no header cells',
          message: continued ? `The part of ${where(p, t.page)} that continues from the page before has no header row, so a screen reader cannot say which column a value is in.` : `The table in ${where(p, t.page)} has no header cells, so a screen reader cannot say which column a value is in.`,
          fix: continued ? `Turn on “Repeat the header row on each page” for ${q(p!.name)}.` : p ? `Give ${q(p.name)} column headings.` : 'Give the table column headings.',
          nodeId: p?.nodeId, page: t.page, extra: { continued },
        });
      }
      set('tables', bad ? 'failed' : 'passed', !tables.length ? 'There are no tables in this PDF.' : bad ? `${bad} of ${tables.length} table parts have no header cells.` : `${tables.length} table part${tables.length === 1 ? '' : 's'}, each with header cells. Which cells the headers apply to (scope) is written by the browser and is not read by this check.`);
    }

    /* pictures */
    if (untagged) needTags('pictures', 'picture');
    else {
      const figures = allEls.filter((e) => e.role === 'Figure');
      let bad = 0;
      for (const f of figures) {
        if (f.alt?.trim()) continue;
        bad++;
        const p = partOf(f);
        fail('pictures', 'PDF_A11Y_FIGURE_NO_ALT', {
          title: 'A picture has no description', message: `A picture in ${where(p, f.page)} is tagged as a figure but has no description, so a screen reader cannot say what it shows.`,
          fix: p && p.type === 'image' ? `Describe ${q(p.name)}, or mark it as decoration if it carries no information.` : p ? `Give ${q(p.name)} a description.` : 'Give the picture a description, or mark it as decoration.',
          nodeId: p?.nodeId, page: f.page,
        });
      }
      const missing = new Map<string, PdfPart>();
      for (const p of parts ?? []) if (p.missingDescription && !missing.has(p.nodeId)) missing.set(p.nodeId, p);
      for (const p of missing.values()) {
        bad++;
        fail('pictures', 'PDF_A11Y_IMAGE_NO_DESCRIPTION', {
          title: 'A picture has no description', message: `${q(p.name)} (page ${p.page}) has no description and is not marked as decoration, so the PDF leaves it out of the tags as if it were decoration.`,
          fix: `Describe ${q(p.name)}, or mark it as decoration if it carries no information.`, nodeId: p.nodeId, page: p.page,
        });
      }
      const decoration = pages.reduce((s, p) => s + p.read.unmarkedDrawings, 0);
      set('pictures', bad ? 'failed' : 'passed', `${figures.length} described picture${figures.length === 1 ? '' : 's'}${bad ? `; ${bad} without a description` : ''}.${parts ? '' : ' Pictures the document has without a description were not looked for (the composed pages were not given).'} Decoration is left out of the tags${decoration ? '' : ' (none was drawn)'}.`);
    }

    /* links */
    if (untagged) needTags('links', 'link');
    else {
      const linkEls = allEls.filter((e) => e.role === 'Link');
      const annots = pages.flatMap((p) => p.links.map((l) => ({ ...l, page: p.tree.page })));
      let bad = 0;
      for (const l of linkEls) {
        const shown = textOfEl(pages, l).trim();
        if (shown && !VAGUE_LINK.test(shown)) continue;
        bad++;
        const p = partOf(l);
        fail('links', 'PDF_A11Y_LINK_TEXT', {
          title: 'A link has no readable text', message: shown ? `The link ${q(shown)} in ${where(p, l.page)} does not say where it goes.` : `A link in ${where(p, l.page)} has no text, so a screen reader cannot say where it goes.`,
          fix: p ? `Change the link text in ${q(p.name)} to say where it goes.` : 'Change the link text to say where it goes.', nodeId: p?.nodeId, page: l.page,
        });
      }
      if (annots.length > linkEls.length) {
        bad++;
        fail('links', 'PDF_A11Y_LINK_NOT_TAGGED', { title: 'A link is not in the tags', message: `${annots.length - linkEls.length} link${annots.length - linkEls.length === 1 ? ' is' : 's are'} clickable in the PDF but not in the tags, so a screen reader does not announce ${annots.length - linkEls.length === 1 ? 'it' : 'them'}.`, fix: 'This is a studio composer problem; report it.' });
      }
      if (annots.length && annots.some((a) => !a.contents.trim())) knownLimits.push({ id: 'link-descriptions', text: 'Links in the PDF have no separate description (the link annotation’s Contents); the composing browser does not write one. Their text is in the tags.' });
      set('links', bad ? 'failed' : 'passed', !linkEls.length && !annots.length ? 'There are no links in this PDF.' : bad ? `${bad} of ${linkEls.length} links have no readable text or are not tagged.` : `${linkEls.length} link${linkEls.length === 1 ? '' : 's'}, each with readable text.`);
    }

    /* lists */
    if (untagged) needTags('lists', 'list');
    else {
      const lists = allEls.filter((e) => e.role === 'L');
      let bad = 0;
      for (const l of lists) {
        if (l.kids.some((k) => k.role === 'LI')) continue;
        bad++;
        const p = partOf(l);
        fail('lists', 'PDF_A11Y_LIST_STRUCTURE', { title: 'A list has no list items', message: `A list in ${where(p, l.page)} has no items tagged as list items.`, fix: 'This is a studio composer problem; report it.', nodeId: p?.nodeId, page: l.page });
      }
      const items = allEls.filter((e) => e.role === 'LI').map((e) => e.text);
      const reported = new Set<string>();
      for (const p of parts ?? []) {
        for (const list of p.lists ?? []) {
          const missingItem = list.find((it) => norm(it).length >= 2 && !items.some((t) => t.includes(norm(it).slice(0, 40))));
          if (!missingItem) continue;
          // An item may simply be on another page: only report when no page of the part has it in a list.
          if (!pages.some((pg) => pg.tree.T.includes(norm(missingItem).slice(0, 40)))) continue;
          const key = `${p.nodeId}|${missingItem}`;
          if (reported.has(p.nodeId) || reported.has(key)) continue;
          reported.add(p.nodeId);
          bad++;
          fail('lists', 'PDF_A11Y_LIST_NOT_TAGGED', { title: 'A list is not tagged as a list', message: `The list in ${where(p, p.page)} (starting ${q(short(missingItem, 40))}) is not tagged as a list, so a screen reader does not announce it as one.`, fix: `Use the list button in the text editor of ${q(p.name)} rather than typed bullets.`, nodeId: p.nodeId, page: p.page });
        }
      }
      // Paragraphs that look like list items (typed bullets or numbers), two or more in a row, outside any list.
      for (const pg of pages) {
        const ps = pg.tree.els.filter((e) => e.role === 'P' && !ancestor(e, 'L'));
        for (let i = 0; i + 1 < ps.length; i++) {
          const a = textOfEl(pages, ps[i]).trim(), b = textOfEl(pages, ps[i + 1]).trim();
          if (!BULLET.test(a) || !BULLET.test(b) || ps[i].parent !== ps[i + 1].parent) continue;
          const p = partOf(ps[i]);
          if (p && reported.has(p.nodeId)) continue;
          if (p) reported.add(p.nodeId);
          bad++;
          fail('lists', 'PDF_A11Y_LIST_NOT_TAGGED', { title: 'A list is typed as paragraphs', message: `${where(p, pg.tree.page)} has lines starting with typed bullets or numbers (${q(short(a, 40))}) that are not tagged as a list.`, fix: p ? `Use the list button in the text editor of ${q(p.name)} rather than typed bullets.` : 'Use a real list rather than typed bullets.', nodeId: p?.nodeId, page: pg.tree.page });
          break;
        }
      }
      set('lists', bad ? 'failed' : 'passed', bad ? `${bad} list${bad === 1 ? ' is' : 's are'} not tagged as a list.` : lists.length ? `${lists.length} list${lists.length === 1 ? '' : 's'}, tagged as lists with list items.` : 'There are no lists in this PDF, and no typed bullets were found.');
    }

    /* reading order */
    if (untagged) needTags('reading-order', 'reading order');
    else if (!parts) set('reading-order', 'not-checked', 'Not checked: the order of the document’s parts on each page was not given (the PDF was checked without its composed pages).');
    else {
      let bad = 0, placed = 0;
      const unplacedNames: string[] = [];
      for (const pg of pages) {
        const m = located.get(pg.tree.page)!;
        const ps = partsOn(pg.tree.page).filter((p) => norm(p.text).length >= 2);
        for (const p of ps) if (!m.has(p) && !unplacedNames.includes(p.name)) unplacedNames.push(p.name);
        const seq = ps.filter((p) => m.has(p)).sort((a, b) => a.order - b.order);
        placed += seq.length;
        const keep = lis(seq.map((p) => m.get(p)!.start));
        seq.forEach((p, i) => {
          if (keep.has(i)) return;
          bad++;
          const pos = m.get(p)!.start;
          const before = seq.find((o, j) => keep.has(j) && o.order > p.order && m.get(o)!.start < pos);
          const after = seq.find((o, j) => keep.has(j) && o.order < p.order && m.get(o)!.start > pos);
          const msg = after ? `On page ${pg.tree.page}, ${q(p.name)} is read before ${q(after.name)}, although it comes after it on the page.` : before ? `On page ${pg.tree.page}, ${q(p.name)} is read after ${q(before.name)}, although it comes before it on the page.` : `On page ${pg.tree.page}, ${q(p.name)} is read out of order.`;
          const other = after ?? before;
          fail('reading-order', 'PDF_A11Y_READING_ORDER', {
            title: 'The reading order differs from the page', message: msg,
            fix: p.placement === 'fixed' ? `Move ${q(p.name)} in the list of components so it is listed where it is read on the page.` : `Move ${q(p.name)} in the list of components, or move it on the page, so the two agree.`,
            nodeId: p.nodeId, page: pg.tree.page, extra: { ...(other ? { otherNodeId: other.nodeId, readBefore: !!after } : {}), placement: p.placement, ...(other ? { otherPlacement: other.placement } : {}) },
          });
        });
      }
      if (!placed) set('reading-order', 'not-checked', 'Not checked: the text of the document’s parts could not be found in the tags.');
      else set('reading-order', bad ? 'failed' : 'passed', `${placed} part${placed === 1 ? '' : 's'} with text compared with where they are on the page${bad ? `; ${bad} read out of order` : ', all read in order'}.${unplacedNames.length ? ` Not compared, because their text could not be found in the tags as laid out: ${unplacedNames.slice(0, 3).map(q).join(', ')}${unplacedNames.length > 3 ? ` and ${unplacedNames.length - 3} more` : ''}.` : ''}`);
    }

    /* contrast */
    {
      const colours = (ctx.colours ?? []).map((c) => ({ ...c, rgb: parseHex(c.hex) })).filter((c) => !!c.rgb);
      interface Run { page: number; part: PdfPart | null; fg: RGB; bg: RGB; ratio: number; need: number; text: string; large: boolean }
      const failed = new Map<string, Run>();
      let checkedGlyphs = 0, overPictures = 0, inFigures = 0, inBackground = 0;
      const overPicturePages = new Set<number>();
      for (const pg of pages) {
        const layers = pg.read.layers;
        for (const g of pg.read.glyphs) {
          if (!g.text.trim() || g.alpha <= 0.01) continue;
          if (g.tag === 'Figure') { inFigures++; continue; }
          if (g.background) { inBackground++; continue; }
          let bgs: RGB[] = [[255, 255, 255]];
          let unknown = false;
          for (let li = 0; li < g.layers; li++) {
            const L = layers[li];
            if (!inside(L.box, g.x, g.y) || L.alpha <= 0.001) continue;
            let colors = L.colors;
            if (L.kind === 'image') {
              // The pixels around the character, when the picture can be read; otherwise the background is unknown.
              const r = Math.max(1, g.sizePt * 0.5);
              const a = L.img && L.inv ? apply(L.inv, g.x - r, g.y - r) : null, b = L.img && L.inv ? apply(L.inv, g.x + r, g.y + r) : null;
              const px = L.img && a && b ? pictureExtremes(L.img, a[0], a[1], b[0], b[1]) : null;
              if (!px) { unknown = true; continue; }
              if (!px.length) continue; // transparent there
              colors = px;
            }
            const next: RGB[] = [];
            for (const under of bgs) for (const c of colors) next.push(blend(under, c, Math.min(1, L.alpha)));
            bgs = next.slice(0, 8);
            if (L.alpha >= 0.999 && L.kind === 'fill') unknown = false;
          }
          if (unknown) { overPictures++; overPicturePages.add(pg.tree.page); continue; }
          checkedGlyphs++;
          const large = g.sizePt >= 18 || (g.bold && g.sizePt >= 14);
          const need = large ? 3 : 4.5;
          let worst: { ratio: number; fg: RGB; bg: RGB } | null = null;
          for (const bg of bgs) {
            const fg = g.alpha < 0.999 ? blend(bg, g.color, g.alpha) : g.color;
            const ratio = contrastRatio(fg, bg);
            if (!worst || ratio < worst.ratio) worst = { ratio, fg, bg };
          }
          if (!worst || worst.ratio >= need - 0.005) continue;
          const pos = g.mcid !== null ? pg.tree.mcPos.get(g.mcid) : undefined;
          const part = pos !== undefined ? partAt(pg.tree.page, pos) : null;
          const key = `${pg.tree.page}|${part?.nodeId ?? ''}|${hex(worst.fg)}|${hex(worst.bg)}`;
          const r = failed.get(key);
          if (r) { if (r.text.length < 60) r.text += g.text; }
          else failed.set(key, { page: pg.tree.page, part, fg: worst.fg, bg: worst.bg, ratio: worst.ratio, need, text: g.text, large });
        }
      }
      // One finding per part and pair of colours (the first page it appears on).
      const seen = new Set<string>();
      for (const r of failed.values()) {
        const k = `${r.part?.nodeId ?? `page-${r.page}`}|${hex(r.fg)}|${hex(r.bg)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const named = colours.find((c) => hex(c.rgb!) === hex(r.fg)) ?? colours.find((c) => hex(c.rgb!) === hex(r.bg));
        const fix = named ? `Change ${named.name} in Styles & brand to a darker or lighter colour that reaches ${r.need}:1.` : r.part ? `Change the colours of ${q(r.part.name)} so the text reaches ${r.need}:1.` : `Change the colours so the text reaches ${r.need}:1.`;
        fail('contrast', 'PDF_A11Y_LOW_CONTRAST', {
          title: 'Text is hard to read against its background',
          message: `Text in ${where(r.part, r.page)} (${q(short(r.text.trim(), 30))}, ${hex(r.fg)} on ${hex(r.bg)}) has a contrast of ${r.ratio.toFixed(2)}:1; ${r.large ? 'large ' : ''}text needs at least ${r.need}:1.`,
          fix, nodeId: r.part?.nodeId, page: r.page, extra: { ratio: Math.round(r.ratio * 100) / 100, need: r.need, foreground: hex(r.fg), background: hex(r.bg), ...(named ? { colour: named.where } : {}) },
        });
      }
      const bad = seen.size;
      const notes = [inFigures ? 'Text that is part of a picture or logo is not checked.' : '', inBackground ? 'Text drawn as part of a page background is decoration and is not checked.' : '', overPictures ? `Text over a picture (${overPictures} characters on page${overPicturePages.size === 1 ? '' : 's'} ${[...overPicturePages].join(', ')}) could not be checked.` : ''].filter(Boolean).join(' ');
      if (!checkedGlyphs && !bad) set('contrast', 'not-checked', `Not checked: no text could be measured. ${notes}`.trim());
      else if (bad) set('contrast', 'failed', `${bad} text colour${bad === 1 ? '' : 's'} below the WCAG AA ratio (4.5:1, or 3:1 for large text). ${notes}`.trim());
      else if (overPictures) set('contrast', 'not-checked', `The text that could be measured meets the WCAG AA ratio, but not all of it could be measured. ${notes}`.trim());
      else set('contrast', 'passed', `All ${checkedGlyphs} characters measured meet the WCAG AA ratio (4.5:1, or 3:1 for large text) against what is drawn behind them. ${notes}`.trim());
    }

    /* untagged text */
    {
      let bad = 0;
      for (const pg of pages) {
        const t = pg.read.untaggedText.replace(/\s+/g, ' ').trim();
        if (!t) continue;
        bad++;
        const nt = norm(t).slice(0, 30);
        const p = partsOn(pg.tree.page).find((x) => nt && norm(x.text).includes(nt)) ?? null;
        fail('untagged-text', 'PDF_A11Y_UNTAGGED_TEXT', { title: 'Some text is not in the tags', message: `On page ${pg.tree.page}, text (${q(short(t, 50))}) is drawn outside the tags, so a screen reader does not read it.`, fix: p ? `Check that ${q(p.name)} is not hidden from assistive technology.` : 'Check that this text is not hidden from assistive technology.', nodeId: p?.nodeId, page: pg.tree.page });
      }
      set('untagged-text', bad ? 'failed' : 'passed', bad ? `Text outside the tags on ${bad} page${bad === 1 ? '' : 's'}.` : 'Every piece of text is inside the tags.');
    }

    /* what this browser cannot write */
    knownLimits.unshift({ id: 'pdfua-identifier', text: 'The PDF does not declare PDF/UA conformance: the composing browser writes no PDF/UA identifier (and no XMP metadata). A veraPDF run is expected to report this until the studio has its own PDF writer.' });
    const unmarked = pages.reduce((s, p) => s + p.read.unmarkedDrawings, 0);
    if (unmarked) knownLimits.splice(1, 0, { id: 'artifacts', text: `Decoration (page backgrounds, rules, decorative pictures) is drawn outside the tags, so screen readers skip it, but it is not marked as an artifact: the composing browser never writes artifact marks (${unmarked} drawing${unmarked === 1 ? '' : 's'} in this PDF). A strict PDF/UA validator is expected to report this.` });

    return finish(pageCount, title || null, lang || null);
  } finally {
    await doc?.destroy?.().catch?.(() => undefined);
  }

  function finish(pageCount = 0, title: string | null = null, language: string | null = null): PdfA11yReport {
    const list = PDF_CHECKS.map((c) => checks.get(c.id) ?? { id: c.id, label: c.label, status: 'not-checked' as const, detail: 'Not checked.', failures: 0 });
    for (const c of list) c.failures = findings.filter((f) => f.details.check === c.id).length;
    return {
      level: 'studio', checker: PDF_A11Y_CHECKER_VERSION, reader: 'pdf.js 4.9.155', pageCount, title, language, required,
      checks: list, findings,
      summary: { ran: list.filter((c) => c.status !== 'not-checked').length, passed: list.filter((c) => c.status === 'passed').length, failed: list.filter((c) => c.status === 'failed').length, notChecked: list.filter((c) => c.status === 'not-checked').length },
      knownLimits,
    };
  }
}

/**
 * Pictures and gradients a page draws are decoded by pdf.js after the operator list is made; they are waited for here
 * (each for a short time at most) so the contrast check can read their colours. One that does not arrive stays unknown.
 */
async function resolveObjects(pdfjs: any, page: any, ol: { fnArray: number[]; argsArray: any[] }): Promise<Map<string, unknown>> {
  const O = pdfjs.OPS;
  const ids = new Set<string>();
  ol.fnArray.forEach((f, k) => {
    const a = ol.argsArray[k];
    if ((f === O.paintImageXObject || f === O.paintImageXObjectRepeat) && typeof a?.[0] === 'string') ids.add(a[0]);
    if (f === O.shadingFill && typeof a?.[0] === 'string') ids.add(a[0]);
    if (f === O.setFillColorN && a?.[0] === 'Shading') ids.add(String(a[1]));
    if (f === O.setFillColorN && a?.[0] === 'TilingPattern' && a[2]?.fnArray) (a[2].fnArray as number[]).forEach((g, j) => { if (g === O.paintImageXObject && typeof a[2].argsArray[j]?.[0] === 'string') ids.add(a[2].argsArray[j][0]); });
  });
  const out = new Map<string, unknown>();
  await Promise.all([...ids].map((id) => new Promise<void>((done) => {
    const store = page.objs.has(id) || !page.commonObjs.has(id) ? page.objs : page.commonObjs;
    const t = setTimeout(done, 1500);
    try { store.get(id, (v: unknown) => { clearTimeout(t); out.set(id, v); done(); }); } catch { clearTimeout(t); done(); }
  })));
  return out;
}

function ancestor(e: El, role: string): boolean { for (let p = e.parent; p; p = p.parent) if (p.role === role) return true; return false; }

/** The readable text of an element (as drawn, with spaces), from its marked contents. */
function textOfEl(pages: Array<{ tree: PageTree; read: PageRead }>, e: El): string {
  const pg = pages.find((p) => p.tree.page === e.page);
  if (!pg) return '';
  const ids: number[] = [];
  const walk = (x: El) => { ids.push(...x.contentIds); x.kids.forEach(walk); };
  walk(e);
  return ids.map((id) => pg.read.mcText.get(id) ?? '').join('').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ one document, as the studio exports it */

/** The two levels of proof for one composed PDF, and when they were made. */
export interface PdfAccessibilityResult {
  /** When the checks ran (ISO time). */
  checkedAt: string;
  recordId: string;
  /** "Checked by the studio": always present. */
  studio: PdfA11yReport;
  /** "Validated by veraPDF": its result, `not-installed`, or `not-run` when it was not asked for. */
  verapdf: VeraPdfResult | { status: 'not-run'; message: string };
}

/** Pages of a composition that carry a page background (page design), from the page template each page used. */
export function backgroundPagesOf(project: Project, res: Resolution, pages: Array<{ index: number; template?: string }>): number[] {
  if (!usesPageDesign(res, project)) return [];
  const d = effectivePageDesign(pagedProfileOf(project, 'paged-pdf'));
  return pages.filter((p) => (p.template === 'last' ? d.last?.background : p.template === 'following' ? d.following.background : d.first.background)).map((p) => p.index);
}

/**
 * Composes the document's PDF exactly as the export does (paged-pdf, no watermark) and checks it: the studio's checks
 * always; veraPDF too when `verapdf` is asked for and it is installed. Failures are blocking when the document requires
 * an accessible PDF (`project.accessiblePdfRequired`), warnings otherwise.
 */
export async function checkDocumentPdf(composer: Composer, res: Resolution, project: Project, opts: { verapdf?: boolean; env?: NodeJS.ProcessEnv; verapdfTimeoutMs?: number } = {}): Promise<PdfAccessibilityResult> {
  const comp = await composer.composePaged(renderPagedDocument(res, project, { profileId: 'paged-pdf', watermark: '' }), { pdf: true, parts: true });
  const pages = comp.metrics.pages as unknown as Array<{ index: number; nodeIds: string[]; fixedNodeIds: string[]; flowBottomPt: number; template?: string }>;
  const studio = await checkPdfAccessibility(comp.pdf!, {
    locale: res.locale, required: !!project.accessiblePdfRequired, colours: documentColours(project),
    parts: pdfPartsOf(res, project, { pages, parts: comp.parts ?? [] }), backgroundPages: backgroundPagesOf(project, res, pages),
  });
  const verapdf = opts.verapdf ? await runVeraPdf(comp.pdf!, { env: opts.env, timeoutMs: opts.verapdfTimeoutMs }) : { status: 'not-run' as const, message: 'veraPDF was not asked to run for this check.' };
  return { checkedAt: new Date().toISOString(), recordId: res.recordId, studio, verapdf };
}

/** The level of proof reached, in the words the screens use. Never says more than was run. */
export function proofLevelOf(r: Pick<PdfAccessibilityResult, 'verapdf'>): { level: 'studio' | 'verapdf'; label: string } {
  return r.verapdf.status === 'ran' ? { level: 'verapdf', label: 'Validated by veraPDF' } : { level: 'studio', label: 'Checked by the studio' };
}
export { VERAPDF_NOT_INSTALLED };
