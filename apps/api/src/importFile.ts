import { paperOf, type FileKind, type FileReading, type IgnoredPart, type ReadBlock, type ReadImage } from '@iss/scenarios';
import { DocxRefusal, readDocx } from './docx';

/**
 * "Rebuild from a file" (wave 3, section 1): reads an existing PDF or Word (.docx) file ON THE STUDIO'S MACHINE into a
 * plain description of its text and layout (`FileReading`, in the scenarios package).
 *
 * The file is untrusted. It is parsed, never executed: PDF scripts, attachments, form fields and links, and Word macros,
 * embedded files, external links, tracked changes and comments are never run or followed; they are counted and
 * reported. Pictures are noted by position and size; their pixels are not read. The file lives in memory only, for the
 * length of the request: it is never written to disk, never stored and never logged. Its name never reaches the server.
 *
 * Limits: 10 MB, 20 pages, and a time limit. A PDF without a text layer (a scan) is refused with a plain explanation:
 * the studio does not do character recognition.
 */
export const IMPORT_FILE_LIMITS = { bytes: 10 * 1024 * 1024, pages: 20, files: 3, timeoutMs: 20_000 } as const;

export type FileRefusalCode = 'FILE_TOO_LARGE' | 'FILE_KIND' | 'FILE_DAMAGED' | 'FILE_TOO_MANY_PAGES' | 'FILE_SCANNED' | 'FILE_NO_TEXT' | 'FILE_PASSWORD' | 'FILE_TOO_SLOW' | 'FILE_UNSAFE';
export class FileRefusal extends Error {
  constructor(public code: FileRefusalCode, message: string, public status = 422) { super(message); }
}

/** What the bytes are, whatever the file was called: a PDF starts with `%PDF-`; a .docx is a ZIP with Word's document part. */
export function sniffKind(buf: Buffer): FileKind | null {
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return 'docx';
  return null;
}

/** Reads one file within the limits, or throws a `FileRefusal` with a plain message. */
export async function readImportFile(buf: Buffer, opts: { timeoutMs?: number } = {}): Promise<FileReading> {
  if (buf.length > IMPORT_FILE_LIMITS.bytes) throw new FileRefusal('FILE_TOO_LARGE', 'The file is larger than 10 MB. Use a smaller file, or fewer pages of it.', 413);
  if (!buf.length) throw new FileRefusal('FILE_DAMAGED', 'The file is empty.');
  const kind = sniffKind(buf);
  if (!kind) throw new FileRefusal('FILE_KIND', 'This is not a PDF or a Word (.docx) file. The studio reads PDF files and Word files saved as .docx (not the older .doc).', 415);
  if (kind === 'docx') {
    let reading: FileReading;
    try { reading = readDocx(buf); }
    catch (e) {
      if (e instanceof DocxRefusal) throw new FileRefusal(e.code === 'NOT_DOCX' ? 'FILE_KIND' : e.code === 'DOCX_UNSAFE' ? 'FILE_UNSAFE' : e.code === 'DOCX_TOO_LARGE' ? 'FILE_TOO_LARGE' : 'FILE_DAMAGED', e.message, e.code === 'NOT_DOCX' ? 415 : e.code === 'DOCX_TOO_LARGE' ? 413 : 422);
      throw new FileRefusal('FILE_DAMAGED', 'The Word file is damaged and could not be read.');
    }
    if (reading.pages > IMPORT_FILE_LIMITS.pages) throw new FileRefusal('FILE_TOO_MANY_PAGES', `The Word file has ${reading.pages} pages. The studio reads at most ${IMPORT_FILE_LIMITS.pages}: use a shorter sample of the document.`);
    if (!reading.blocks.length) throw new FileRefusal('FILE_NO_TEXT', 'The Word file has no text the studio could read.');
    return reading;
  }
  return readPdf(buf, opts.timeoutMs ?? IMPORT_FILE_LIMITS.timeoutMs);
}

/* ------------------------------------------------------------------ PDF */

type Mat = [number, number, number, number, number, number];
const ID: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

interface Run { x: number; x1: number; y: number; size: number; text: string; bold: boolean; italic: boolean }
interface Seg { x: number; x1: number; text: string; bold: boolean; italic: boolean; chars: number; boldChars: number }
interface Line { page: number; y: number; size: number; segs: Seg[] }
interface PLine { page: number; y: number; x: number; x1: number; size: number; text: string; bold: boolean; italic: boolean }

const BULLET = /^(?:[•◦▪‣·●○■□–*-]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/;
const BULLET_ONLY = /^(?:[•◦▪‣·●○■□–*-]|\d{1,2}[.)])$/;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stripSubset = (name: string) => name.replace(/^[A-Z]{6}\+/, '');

async function loadPdfjs(): Promise<any> { return import('pdfjs-dist/legacy/build/pdf.mjs'); }

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new FileRefusal('FILE_TOO_SLOW', 'The file took too long to read, so the studio stopped. Try a shorter sample of the document.')); }, ms); }),
  ]);
}

async function readPdf(buf: Buffer, timeoutMs: number): Promise<FileReading> {
  const pdfjs = await loadPdfjs();
  let task: any;
  let doc: any;
  const work = (async () => {
    try {
      task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0, stopAtErrors: false, disableAutoFetch: true });
      doc = await task.promise;
    } catch (e: any) {
      if (e?.name === 'PasswordException') throw new FileRefusal('FILE_PASSWORD', 'The PDF is protected with a password. Save a copy without a password and use that.');
      throw new FileRefusal('FILE_DAMAGED', 'The PDF is damaged and could not be read.');
    }
    if (doc.numPages > IMPORT_FILE_LIMITS.pages) throw new FileRefusal('FILE_TOO_MANY_PAGES', `The PDF has ${doc.numPages} pages. The studio reads at most ${IMPORT_FILE_LIMITS.pages}: use a shorter sample of the document.`);
    return await readPdfDoc(doc);
  })();
  try { return await withTimeout(work, timeoutMs, () => { void task?.destroy?.().catch?.(() => undefined); }); }
  catch (e) { if (e instanceof FileRefusal) throw e; throw new FileRefusal('FILE_DAMAGED', 'The PDF could not be read.'); }
  finally { await (doc?.destroy?.() ?? Promise.resolve()).catch(() => undefined); }
}

async function readPdfDoc(doc: any): Promise<FileReading> {
  const pdfjsOps = (await loadPdfjs()).OPS;
  const ignored: IgnoredPart[] = [];
  const ignore = (kind: IgnoredPart['kind'], count: number, text: string) => { if (count > 0) ignored.push({ kind, count, text }); };
  // Never run: document-level scripts, attachments, form fields. Only counted.
  const js = await doc.getJSActions().catch(() => null);
  ignore('script', js ? Object.keys(js).length : 0, 'The PDF contains scripts. They were ignored and never run.');
  const attachments = await doc.getAttachments().catch(() => null);
  ignore('embedded', attachments ? Object.keys(attachments).length : 0, 'Files attached to the PDF were ignored and not opened.');
  const fields = await doc.getFieldObjects().catch(() => null);
  ignore('form', fields ? Object.keys(fields).length : 0, 'Form fields in the PDF were ignored; only the text printed on the page was read.');

  const runs: Array<Run & { page: number }> = [];
  const images: ReadImage[] = [];
  const fonts = new Set<string>();
  const counts = { links: 0, scripts: 0, comments: 0, attached: 0, widgets: 0, media: 0, rotated: 0 };
  const textlessPages: number[] = [];
  let first: { w: number; h: number } | null = null;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const view: number[] = Array.isArray(page.view) ? page.view.map(Number) : [0, 0, 612, 792];
    const [vx, , vw, vh] = [view[0], view[1], view[2] - view[0], view[3] - view[1]];
    const top = view[3];
    first ??= { w: vw, h: vh };
    // The operator list loads the fonts (for their names) and says where pictures are drawn. Pixels are never decoded here.
    const ol = await page.getOperatorList();
    let ctm: Mat = ID;
    const stack: Mat[] = [];
    for (let k = 0; k < ol.fnArray.length; k++) {
      const fn = ol.fnArray[k], a = ol.argsArray[k];
      if (fn === pdfjsOps.save) stack.push(ctm);
      else if (fn === pdfjsOps.restore) ctm = stack.pop() ?? ctm;
      else if (fn === pdfjsOps.transform) ctm = mul(a as Mat, ctm);
      else if (fn === pdfjsOps.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0]) && a[0].length === 6) ctm = mul(a[0] as Mat, ctm); }
      else if (fn === pdfjsOps.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === pdfjsOps.paintImageXObject || fn === pdfjsOps.paintInlineImageXObject || fn === pdfjsOps.paintImageXObjectRepeat) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
        if (w >= 4 && h >= 4) images.push({ page: i, widthPt: Math.round(w * 10) / 10, heightPt: Math.round(h * 10) / 10, box: { x: Math.round((Math.min(...xs) - vx) * 10) / 10, y: Math.round((top - Math.max(...ys)) * 10) / 10, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 } });
      }
    }
    const fontInfo = (id: string): { name: string; bold: boolean; italic: boolean } => {
      try {
        const f = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
        const name = stripSubset(String(f?.name ?? f?.loadedName ?? ''));
        return { name, bold: !!f?.bold || !!f?.black || /bold|black|heavy|semibold|demi/i.test(name), italic: !!f?.italic || /italic|oblique/i.test(name) };
      } catch { return { name: '', bold: false, italic: false }; }
    };
    const tc = await page.getTextContent();
    let pageChars = 0;
    for (const it of tc.items as Array<{ str?: string; transform?: number[]; width?: number; fontName?: string }>) {
      const str = typeof it.str === 'string' ? it.str : '';
      if (!str.trim() || !Array.isArray(it.transform)) continue;
      const t = it.transform;
      if (Math.abs(t[1]) > Math.abs(t[0]) * 0.1 || Math.abs(t[2]) > Math.abs(t[3]) * 0.1) { counts.rotated++; continue; }
      const size = Math.abs(t[3]) || Math.hypot(t[2], t[3]);
      if (!(size > 0.5)) continue;
      const f = fontInfo(String(it.fontName ?? ''));
      if (f.name && fonts.size < 12) fonts.add(f.name.replace(/[-,](Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|MT|PSMT)+$/i, '') || f.name);
      const x = t[4] - vx;
      runs.push({ page: i, x, x1: x + Math.max(0, Number(it.width) || 0), y: top - t[5], size, text: str, bold: f.bold, italic: f.italic });
      pageChars += str.replace(/\s/g, '').length;
    }
    if (!pageChars) textlessPages.push(i);
    const annots = (await page.getAnnotations().catch(() => [])) as Array<Record<string, any>>;
    for (const a of annots) {
      const sub = String(a.subtype ?? '');
      if (sub === 'Link') { if (a.url || a.unsafeUrl) counts.links++; else if (a.action || a.actions || a.jsActions) counts.scripts++; }
      else if (sub === 'FileAttachment') counts.attached++;
      else if (sub === 'Widget') counts.widgets++;
      else if (/^(Movie|Sound|Screen|RichMedia|3D)$/.test(sub)) counts.media++;
      else if (sub && sub !== 'Link') counts.comments++;
      if (a.actions && typeof a.actions === 'object' && Object.keys(a.actions).length && sub !== 'Link') counts.scripts++;
    }
    page.cleanup?.();
  }

  ignore('link', counts.links, `${plural(counts.links, 'link')} to outside the file ${counts.links === 1 ? 'was' : 'were'} not followed and not brought across.`);
  ignore('script', counts.scripts, 'Actions attached to parts of the PDF were ignored and never run.');
  ignore('embedded', counts.attached, 'Files attached to the PDF’s pages were ignored and not opened.');
  ignore('comment', counts.comments, 'Comments and other notes added on top of the pages were ignored.');
  ignore('other', counts.media, 'Sound, video or 3D content in the PDF was ignored.');
  if (counts.widgets && !ignored.some((x) => x.kind === 'form')) ignore('form', counts.widgets, 'Form fields in the PDF were ignored; only the text printed on the page was read.');

  const chars = runs.reduce((s, r) => s + r.text.replace(/\s/g, '').length, 0);
  if (chars < 20) {
    if (images.length) throw new FileRefusal('FILE_SCANNED', 'This PDF has no text layer: its pages are pictures, as in a scan. The studio does not read text from pictures. Use the PDF that was produced by the system that made the document, or the Word file it came from.');
    throw new FileRefusal('FILE_NO_TEXT', 'This PDF has no text the studio can read.');
  }

  const notes: string[] = [];
  if (textlessPages.length) notes.push(`${textlessPages.length === 1 ? `Page ${textlessPages[0]} has` : `Pages ${textlessPages.join(', ')} have`} no text (they may be pictures of pages), so nothing was read from ${textlessPages.length === 1 ? 'it' : 'them'}.`);
  if (counts.rotated) notes.push('Text set at an angle (for example sideways in a margin) was not read.');

  const body = bodySize(runs);
  const { blocks, tableNotes } = layout(runs, body);
  notes.push(...tableNotes);
  return { kind: 'pdf', pages: doc.numPages, paper: paperOf(first?.w ?? 612, first?.h ?? 792), blocks, images, ignored, notes, fonts: [...fonts], bodySizePt: body };
}

/** The size most of the text is set in (by characters), rounded to half a point. */
function bodySize(runs: Run[]): number {
  const by = new Map<number, number>();
  for (const r of runs) { const s = Math.round(r.size * 2) / 2; by.set(s, (by.get(s) ?? 0) + r.text.length); }
  let best = 10, n = -1;
  for (const [s, c] of by) if (c > n || (c === n && s < best)) { best = s; n = c; }
  return best;
}

/* ------------------------------------------------------------------ lines, tables, blocks */

function toLines(runs: Array<Run & { page: number }>): Line[] {
  const sorted = [...runs].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const r of sorted) {
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && line.page === r.page && Math.abs(line.y - r.y) <= Math.max(line.size, r.size) * 0.35) { (line as any).runs.push(r); line.size = Math.max(line.size, r.size); continue; }
    lines.push({ page: r.page, y: r.y, size: r.size, segs: [], runs: [r] } as Line & { runs: Run[] });
  }
  for (const l of lines as Array<Line & { runs: Run[] }>) {
    const rs = l.runs.sort((a, b) => a.x - b.x);
    let seg: Seg | null = null;
    for (const r of rs) {
      const gap = seg ? r.x - seg.x1 : 0;
      if (!seg || gap > Math.max(l.size * 1.6, 9)) {
        seg = { x: r.x, x1: r.x1, text: r.text, bold: r.bold, italic: r.italic, chars: r.text.trim().length, boldChars: r.bold ? r.text.trim().length : 0 };
        l.segs.push(seg);
        continue;
      }
      const space = gap > l.size * 0.12 && !/\s$/.test(seg.text) && !/^\s/.test(r.text) ? ' ' : '';
      seg.text += space + r.text;
      seg.x1 = Math.max(seg.x1, r.x1);
      seg.chars += r.text.trim().length;
      if (r.bold) seg.boldChars += r.text.trim().length;
    }
    for (const s of l.segs) { s.text = s.text.replace(/\s+/g, ' ').trim(); s.bold = s.chars > 0 && s.boldChars / s.chars >= 0.6; }
    // A bullet drawn apart from its text belongs to it.
    for (let k = 0; k < l.segs.length - 1; k++) if (BULLET_ONLY.test(l.segs[k].text)) { const nx = l.segs[k + 1]; nx.text = `${l.segs[k].text} ${nx.text}`; nx.x = l.segs[k].x; l.segs.splice(k, 1); }
    l.segs = l.segs.filter((s) => s.text);
  }
  return lines.filter((l) => l.segs.length);
}

/** The column a segment falls in: the one it overlaps most, or the nearest within a small distance. */
function columnOf(cols: Array<{ x: number; x1: number }>, s: Seg, tol: number): number {
  let best = -1, bestOv = 0;
  cols.forEach((c, i) => { const ov = Math.min(c.x1, s.x1) - Math.max(c.x, s.x); if (ov > bestOv) { best = i; bestOv = ov; } });
  if (best >= 0) return best;
  let near = -1, nd = Infinity;
  cols.forEach((c, i) => { const d = Math.min(Math.abs(c.x - s.x), Math.abs(c.x1 - s.x1)); if (d < nd) { near = i; nd = d; } });
  return nd <= tol ? near : -1;
}

function layout(runs: Array<Run & { page: number }>, body: number): { blocks: ReadBlock[]; tableNotes: string[] } {
  const lines = toLines(runs);
  const tableNotes: string[] = [];
  const out: Array<Omit<ReadBlock, 'id'> & { y: number; x: number }> = [];
  const plain: PLine[] = [];
  const asPlain = (l: Line) => { for (const s of l.segs) plain.push({ page: l.page, y: l.y, x: s.x, x1: s.x1, size: l.size, text: s.text, bold: s.bold, italic: s.italic }); };

  // Runs of consecutive lines with two or more segments are tables when their columns line up.
  for (let i = 0; i < lines.length;) {
    if (lines[i].segs.length < 2) { asPlain(lines[i]); i++; continue; }
    let j = i + 1;
    while (j < lines.length && lines[j].page === lines[i].page && lines[j].segs.length >= 2 && lines[j].y - lines[j - 1].y <= Math.max(lines[j].size, lines[j - 1].size) * 2.6) j++;
    const group = lines.slice(i, j);
    if (group.length >= 2) {
      const widest = group.reduce((a, b) => (b.segs.length > a.segs.length ? b : a));
      const cols = widest.segs.map((s) => ({ x: s.x, x1: s.x1 }));
      const tol = widest.size * 1.5;
      const rows: string[][] = [];
      let fit = 0;
      const placed = group.map((l) => {
        const row = new Array<string>(cols.length).fill('');
        let ok = true;
        for (const s of l.segs) { const c = columnOf(cols, s, tol); if (c < 0 || row[c]) ok = false; else row[c] = s.text; }
        if (ok) fit++;
        return { row, ok };
      });
      if (fit / group.length >= 0.8 && fit >= 2) {
        for (const p of placed) rows.push(p.row);
        const header = group[0].segs.every((s) => s.bold) && group.slice(1).some((l) => l.segs.some((s) => !s.bold))
          || (rows.length > 1 && rows[0].every((c) => c && !/\d/.test(c)) && rows.slice(1).some((r) => r.some((c) => /\d/.test(c))));
        const x0 = Math.min(...group.flatMap((l) => l.segs.map((s) => s.x))), x1 = Math.max(...group.flatMap((l) => l.segs.map((s) => s.x1)));
        const box = { x: Math.round(x0 * 10) / 10, y: Math.round((group[0].y - group[0].size) * 10) / 10, w: Math.round((x1 - x0) * 10) / 10, h: Math.round((group[group.length - 1].y - group[0].y + group[0].size * 1.2) * 10) / 10 };
        if (cols.length === 2 && !header && rows.every((r) => r[0] && !/\d/.test(r[0]))) {
          // Labels on the left and values on the right: read as "Label: value" lines.
          out.push({ kind: 'paragraph', page: group[0].page, lines: rows.map((r) => `${r[0].replace(/[:\s]+$/, '')}: ${r[1]}`.trim()), box, sizePt: Math.round(group[0].size * 10) / 10, y: box.y, x: box.x });
        } else out.push({ kind: 'table', page: group[0].page, lines: [], rows, headerRow: header, box, sizePt: Math.round(group[0].size * 10) / 10, y: box.y, x: box.x });
        i = j;
        continue;
      }
      tableNotes.push(`On page ${group[0].page}, some lines are laid out in columns like a table, but its rows and columns could not be told apart reliably, so they were read as text.`);
    }
    for (const l of group) asPlain(l);
    i = j;
  }

  // Text lines into blocks: the same size and weight, left-aligned (or centred together), close one under the other.
  const open: Array<{ lines: PLine[]; closed: boolean }> = [];
  const blocks: Array<{ lines: PLine[] }> = [];
  for (const l of plain.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const isBullet = BULLET.test(l.text);
    const target = open.find((b) => {
      if (b.closed) return false;
      const last = b.lines[b.lines.length - 1];
      if (last.page !== l.page) return false;
      const gap = l.y - last.y;
      if (gap <= 0 || gap > Math.max(last.size, l.size) * 1.75) return false;
      if (Math.abs(last.size - l.size) > 0.6 || last.bold !== l.bold) return false;
      const firstBullet = BULLET.test(b.lines[0].text);
      const dx = l.x - b.lines[0].x;
      // A list takes its next item, or a line indented under the bullet's text; anything else starts a new block.
      if (firstBullet) return isBullet ? Math.abs(dx) <= l.size * 1.5 : dx > 2 && dx <= l.size * 3;
      if (isBullet) return false;
      return Math.abs(dx) <= l.size * 1.5 || Math.abs((l.x + l.x1) / 2 - (last.x + last.x1) / 2) <= l.size;
    });
    // Blocks that this line has moved past are closed.
    for (const b of open) { const last = b.lines[b.lines.length - 1]; if (last.page !== l.page || l.y - last.y > Math.max(last.size, l.size) * 1.75) b.closed = true; }
    if (target) target.lines.push(l);
    else { const b = { lines: [l], closed: false }; open.push(b); blocks.push(b); }
  }

  // Headings: larger than the body text, or bold body-size single lines that do not end like a sentence.
  const sizes = [...new Set(blocks.filter((b) => b.lines[0].size >= body * 1.18).map((b) => Math.round(b.lines[0].size * 2) / 2))].sort((a, b) => b - a);
  for (const b of blocks) {
    const ls = b.lines;
    const text = ls.map((x) => x.text).join(' ');
    const size = ls[0].size;
    const x0 = Math.min(...ls.map((x) => x.x)), x1 = Math.max(...ls.map((x) => x.x1));
    const box = { x: Math.round(x0 * 10) / 10, y: Math.round((ls[0].y - size) * 10) / 10, w: Math.round((x1 - x0) * 10) / 10, h: Math.round((ls[ls.length - 1].y - ls[0].y + size * 1.2) * 10) / 10 };
    const common = { page: ls[0].page, box, sizePt: Math.round(size * 10) / 10, y: box.y, x: box.x, ...(ls[0].bold ? { bold: true } : {}), ...(ls.every((x) => x.italic) ? { italic: true } : {}) };
    const big = size >= body * 1.18;
    const boldHeading = ls[0].bold && ls.length === 1 && size >= body - 0.1 && text.length <= 80 && !/[.:;,]$/.test(text) && !/\d{3,}/.test(text);
    if (ls.length <= 3 && text.length <= 150 && (big || boldHeading)) {
      const level = big ? Math.min(3, sizes.indexOf(Math.round(size * 2) / 2) + 1) : Math.min(3, sizes.length + 1);
      out.push({ kind: 'heading', level: Math.max(1, level) as 1 | 2 | 3, lines: [text], ...common });
    } else if (BULLET.test(ls[0].text)) {
      const items: string[] = [];
      for (const x of ls) { if (BULLET.test(x.text) || !items.length) items.push(x.text.replace(BULLET, '')); else items[items.length - 1] += ` ${x.text}`; }
      out.push({ kind: 'list', lines: items, ...common });
    } else out.push({ kind: 'paragraph', lines: ls.map((x) => x.text), ...common, ...(size <= body * 0.85 ? { small: true } : {}) });
  }

  out.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  return { blocks: out.map(({ y: _y, x: _x, ...b }, i) => ({ id: `b${i + 1}`, ...b } as ReadBlock)), tableNotes: [...new Set(tableNotes)] };
}
