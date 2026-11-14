import { crc32, inflateRawSync } from 'node:zlib';
import { paperOf, type FileReading, type IgnoredPart, type ReadBlock, type ReadImage } from '@iss/scenarios';
import { zipEntries, type ZipEntry } from './zip';

/**
 * A small, strict reader for the parts of a Word (.docx) file that "Rebuild from a file" needs: paragraphs with their
 * style and heading level, runs with bold and italic, lists, tables, the section's page size, and a note of pictures
 * and of everything it leaves out. No dependency; nothing is executed or followed.
 *
 * A .docx file is a ZIP of XML parts. Only `word/document.xml`, `word/styles.xml`, `word/_rels/document.xml.rels`,
 * `docProps/app.xml` and `[Content_Types].xml` are unpacked, each within a size limit (a "ZIP bomb" is refused before
 * and while it is unpacked). The XML reader refuses a DOCTYPE, so no entity is ever expanded. The names of the other
 * parts are only looked at, to report macros, embedded files, comments, headers and footers.
 */

export class DocxRefusal extends Error {
  constructor(public code: 'NOT_DOCX' | 'DOCX_DAMAGED' | 'DOCX_TOO_LARGE' | 'DOCX_UNSAFE', message: string) { super(message); }
}

/* ------------------------------------------------------------------ limits */

/** Largest unpacked size of one XML part that is read. */
export const DOCX_PART_MAX = 16 * 1024 * 1024;
/** Largest unpacked size of all parts together, as the archive declares them. */
export const DOCX_TOTAL_MAX = 64 * 1024 * 1024;
const ENTRIES_MAX = 2000;
const NODES_MAX = 400_000;
const DEPTH_MAX = 256;

/* ------------------------------------------------------------------ XML */

export interface XNode { name: string; attrs: Record<string, string>; children: Array<XNode | string> }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? all;
  });
}
/** The name without its namespace prefix: `w:p` → `p`. */
export const local = (name: string): string => name.slice(name.indexOf(':') + 1);

/** Parses XML into a light tree. Strict: unbalanced tags, a DOCTYPE or too deep or too large a document are refused. */
export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0;
  let nodes = 0;
  const bad = (why: string): never => { throw new DocxRefusal('DOCX_DAMAGED', `The Word file is damaged: ${why}.`); };
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { const t = xml.slice(i); if (t.trim()) stack[stack.length - 1].children.push(decode(t)); break; }
    if (lt > i) stack[stack.length - 1].children.push(decode(xml.slice(i, lt)));
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt); if (e < 0) bad('an unfinished declaration'); i = e + 2; continue; }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); if (e < 0) bad('an unfinished comment'); i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt); if (e < 0) bad('an unfinished text section'); stack[stack.length - 1].children.push(xml.slice(lt + 9, e)); i = e + 3; continue; }
    if (xml.startsWith('<!', lt)) throw new DocxRefusal('DOCX_UNSAFE', 'The Word file declares its own XML document type, which the studio does not accept.');
    const gt = xml.indexOf('>', lt);
    if (gt < 0) bad('an unfinished tag');
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name || !stack.length) bad('tags that do not match');
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) bad('a tag without a name');
    const node: XNode = { name: m![1], attrs: {}, children: [] };
    for (const a of body.slice(m![1].length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
    if (++nodes > NODES_MAX) throw new DocxRefusal('DOCX_TOO_LARGE', 'The Word file has too many parts in its text to read.');
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) { stack.push(node); if (stack.length > DEPTH_MAX) bad('too deeply nested parts'); }
  }
  if (stack.length !== 1) bad('tags that are not closed');
  return root;
}

const kids = (n: XNode): XNode[] => n.children.filter((c): c is XNode => typeof c !== 'string');
const kid = (n: XNode | undefined, name: string): XNode | undefined => (n ? kids(n).find((c) => local(c.name) === name) : undefined);
const attr = (n: XNode | undefined, name: string): string | undefined => {
  if (!n) return undefined;
  for (const [k, v] of Object.entries(n.attrs)) if (local(k) === name) return v;
  return undefined;
};
/** Every descendant with this local name (not looking inside a match). */
function findAll(n: XNode, name: string, out: XNode[] = []): XNode[] {
  for (const c of kids(n)) { if (local(c.name) === name) out.push(c); else findAll(c, name, out); }
  return out;
}

/* ------------------------------------------------------------------ ZIP, within limits */

function readPart(zip: Buffer, e: ZipEntry): string {
  if (e.size > DOCX_PART_MAX) throw new DocxRefusal('DOCX_TOO_LARGE', 'A part of the Word file is unusually large when unpacked, so the file was not read.');
  if (e.offset + 30 > zip.length || zip.readUInt32LE(e.offset) !== 0x04034b50) throw new DocxRefusal('DOCX_DAMAGED', 'The Word file is damaged.');
  const start = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
  if (start + e.compressedSize > zip.length) throw new DocxRefusal('DOCX_DAMAGED', 'The Word file is damaged (a part is cut short).');
  const body = zip.subarray(start, start + e.compressedSize);
  let data: Buffer;
  if (e.method === 0) data = Buffer.from(body);
  else if (e.method === 8) {
    // The output is capped at what the archive declared: a part that unpacks to more is refused, whatever its header says.
    try { data = inflateRawSync(body, { maxOutputLength: Math.max(1, e.size) }); }
    catch (err: any) { throw err?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength|buffer/i.test(String(err?.message)) ? new DocxRefusal('DOCX_TOO_LARGE', 'A part of the Word file unpacks to more than it says, so the file was not read.') : new DocxRefusal('DOCX_DAMAGED', 'The Word file is damaged (a part cannot be unpacked).'); }
  } else throw new DocxRefusal('DOCX_DAMAGED', 'The Word file uses a way of packing the studio does not read.');
  if (data.length !== e.size || (crc32(data) >>> 0) !== e.crc) throw new DocxRefusal('DOCX_DAMAGED', 'The Word file is damaged (a part does not match its checksum).');
  return data.toString('utf8');
}

/* ------------------------------------------------------------------ the document */

const EMU_PER_PT = 12700;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Style { name: string; basedOn?: string; outline?: number; bold?: boolean; italic?: boolean; list?: boolean }

function readStyles(xml: string | null): Map<string, Style> {
  const out = new Map<string, Style>();
  if (!xml) return out;
  for (const s of findAll(parseXml(xml), 'style')) {
    const id = attr(s, 'styleId');
    if (!id) continue;
    const pPr = kid(s, 'pPr'), rPr = kid(s, 'rPr');
    const ol = attr(kid(pPr, 'outlineLvl'), 'val');
    out.set(id, {
      name: attr(kid(s, 'name'), 'val') ?? id,
      basedOn: attr(kid(s, 'basedOn'), 'val'),
      outline: ol !== undefined && /^\d$/.test(ol) ? Number(ol) : undefined,
      bold: onOff(kid(rPr, 'b')), italic: onOff(kid(rPr, 'i')),
      list: !!kid(pPr, 'numPr'),
    });
  }
  return out;
}
/** `<w:b/>` is on; `<w:b w:val="0"/>` or "false" is off; absent is undefined. */
function onOff(n: XNode | undefined): boolean | undefined {
  if (!n) return undefined;
  const v = attr(n, 'val');
  return !(v === '0' || v === 'false' || v === 'off');
}
function styleChain(styles: Map<string, Style>, id: string | undefined): Style[] {
  const out: Style[] = [];
  for (let s = id ? styles.get(id) : undefined, k = 0; s && k < 20; s = s.basedOn ? styles.get(s.basedOn) : undefined, k++) out.push(s);
  return out;
}
function headingLevel(chain: Style[], own: number | undefined): number | null {
  if (own !== undefined && own < 9) return own + 1;
  for (const s of chain) {
    const m = /^heading\s*([1-9])$/i.exec(s.name) ?? /^Heading([1-9])$/.exec(s.name);
    if (m) return Number(m[1]);
    if (/^title$/i.test(s.name)) return 1;
    if (/^subtitle$/i.test(s.name)) return 2;
    if (s.outline !== undefined && s.outline < 9) return s.outline + 1;
  }
  return null;
}

interface Counters { tracked: number; comments: number; fields: number; textBoxes: number; images: ReadImage[]; page: number; nestedTables: number; forms: number }

interface Para { text: string; bold: boolean; italic: boolean; level: number | null; list: boolean; small: boolean }

/** The text of a paragraph (or run container), with what it contains counted. Deleted text is left out. */
function runText(n: XNode, styleBold: boolean | undefined, styleItalic: boolean | undefined, c: Counters, acc: { text: string; boldChars: number; italicChars: number; chars: number; pageBreakAfter: number }): void {
  for (const ch of kids(n)) {
    const name = local(ch.name);
    switch (name) {
      case 'del': case 'moveFrom': c.tracked++; break; // deleted: not part of the text as it now reads
      case 'ins': case 'moveTo': c.tracked++; runText(ch, styleBold, styleItalic, c, acc); break;
      case 'pPrChange': case 'rPrChange': case 'sectPrChange': case 'tblPrChange': c.tracked++; break;
      case 'commentRangeStart': case 'commentReference': if (name === 'commentReference') c.comments++; break;
      case 'fldSimple': c.fields++; runText(ch, styleBold, styleItalic, c, acc); break;
      case 'instrText': c.fields++; break;
      case 'hyperlink': case 'smartTag': case 'customXml': case 'sdt': case 'sdtContent': case 'bdo': case 'dir': runText(ch, styleBold, styleItalic, c, acc); break;
      case 'AlternateContent': { const choice = kid(ch, 'Choice') ?? kid(ch, 'Fallback'); if (choice) runText(choice, styleBold, styleItalic, c, acc); break; }
      case 'r': {
        const rPr = kid(ch, 'rPr');
        const bold = onOff(kid(rPr, 'b')) ?? styleBold ?? false;
        const italic = onOff(kid(rPr, 'i')) ?? styleItalic ?? false;
        for (const part of kids(ch)) {
          const pn = local(part.name);
          let t = '';
          if (pn === 't') t = part.children.filter((x): x is string => typeof x === 'string').join('');
          else if (pn === 'tab' || pn === 'ptab') t = ' ';
          else if (pn === 'br' || pn === 'cr') { if (attr(part, 'type') === 'page') acc.pageBreakAfter++; else t = '\n'; }
          else if (pn === 'noBreakHyphen') t = '-';
          else if (pn === 'sym') t = ' ';
          else if (pn === 'instrText') c.fields++;
          else if (pn === 'drawing' || pn === 'pict' || pn === 'object' || pn === 'AlternateContent') drawing(part, c);
          if (t) {
            acc.text += t;
            const visible = t.replace(/\s/g, '').length;
            acc.chars += visible;
            if (bold) acc.boldChars += visible;
            if (italic) acc.italicChars += visible;
          }
        }
        break;
      }
      default: break;
    }
  }
}

/** A picture: its size is noted, never its content. A text box is counted (its text is not read). */
function drawing(n: XNode, c: Counters): void {
  if (findAll(n, 'txbxContent').length) { c.textBoxes++; return; }
  if (local(n.name) === 'object') { c.images.push({ page: c.page, widthPt: 0, heightPt: 0 }); return; }
  const ext = findAll(n, 'extent')[0];
  const cx = Number(attr(ext, 'cx')), cy = Number(attr(ext, 'cy'));
  if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) { c.images.push({ page: c.page, widthPt: Math.round((cx / EMU_PER_PT) * 10) / 10, heightPt: Math.round((cy / EMU_PER_PT) * 10) / 10 }); return; }
  const style = findAll(n, 'shape')[0]?.attrs.style ?? '';
  const w = /width:\s*([\d.]+)pt/.exec(style), h = /height:\s*([\d.]+)pt/.exec(style);
  c.images.push({ page: c.page, widthPt: w ? Number(w[1]) : 0, heightPt: h ? Number(h[1]) : 0 });
}

function paragraph(p: XNode, styles: Map<string, Style>, c: Counters): Para & { pageBreaks: number } {
  const pPr = kid(p, 'pPr');
  const chain = styleChain(styles, attr(kid(pPr, 'pStyle'), 'val'));
  const sBold = chain.map((s) => s.bold).find((x) => x !== undefined);
  const sItalic = chain.map((s) => s.italic).find((x) => x !== undefined);
  const acc = { text: '', boldChars: 0, italicChars: 0, chars: 0, pageBreakAfter: 0 };
  runText(p, sBold, sItalic, c, acc);
  if (attr(kid(pPr, 'pageBreakBefore'), 'val') !== '0' && kid(pPr, 'pageBreakBefore')) c.page++;
  const ownOutline = attr(kid(pPr, 'outlineLvl'), 'val');
  const level = headingLevel(chain, ownOutline !== undefined && /^\d$/.test(ownOutline) ? Number(ownOutline) : undefined);
  const list = !!kid(pPr, 'numPr') || chain.some((s) => s.list || /list/i.test(s.name));
  const small = chain.some((s) => /footnote|small|caption|fine ?print|disclaimer/i.test(s.name));
  return {
    text: acc.text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim(),
    bold: acc.chars > 0 && acc.boldChars / acc.chars >= 0.6, italic: acc.chars > 0 && acc.italicChars / acc.chars >= 0.6,
    level, list, small, pageBreaks: acc.pageBreakAfter,
  };
}

function cellText(tc: XNode, styles: Map<string, Style>, c: Counters): string {
  const parts: string[] = [];
  for (const ch of kids(tc)) {
    const n = local(ch.name);
    if (n === 'p') { const p = paragraph(ch, styles, c); if (p.text) parts.push(p.text.replace(/\n/g, ' ')); }
    else if (n === 'tbl') { c.nestedTables++; for (const inner of findAll(ch, 'tc')) { const t = cellText(inner, styles, c); if (t) parts.push(t); } }
    else if (n === 'sdt') { const content = kid(ch, 'sdtContent'); if (content) { const t = cellText(content, styles, c); if (t) parts.push(t); } }
  }
  return parts.join(' ');
}

/**
 * Reads a .docx file. Throws `DocxRefusal` with a plain message when it is not one, is damaged, or is too large when
 * unpacked. `maxPages`: a file that says it has more pages is refused by the caller from `pages`.
 */
export function readDocx(buf: Buffer): FileReading {
  let entries: ZipEntry[];
  try { entries = zipEntries(buf); } catch { throw new DocxRefusal('NOT_DOCX', 'This is not a Word (.docx) file, or it is damaged.'); }
  if (entries.length > ENTRIES_MAX) throw new DocxRefusal('DOCX_TOO_LARGE', 'The Word file holds too many parts to read.');
  const declared = entries.reduce((s, e) => s + e.size, 0);
  if (declared > DOCX_TOTAL_MAX) throw new DocxRefusal('DOCX_TOO_LARGE', 'The Word file is unusually large when unpacked, so it was not read.');
  const byName = new Map(entries.map((e) => [e.name, e]));
  const part = (name: string): string | null => { const e = byName.get(name); return e ? readPart(buf, e) : null; };
  const types = part('[Content_Types].xml');
  const doc = part('word/document.xml');
  if (!types || !doc) throw new DocxRefusal('NOT_DOCX', 'This is not a Word (.docx) file: it has no document text.');

  // What the studio never runs or follows: counted from the names of the parts and the relationships.
  const ignored: IgnoredPart[] = [];
  const ignore = (kind: IgnoredPart['kind'], count: number, text: string) => { if (count > 0) ignored.push({ kind, count, text }); };
  const names = entries.map((e) => e.name);
  const macro = names.some((n) => /vbaProject\.bin$|vbaData\.xml$/i.test(n)) || /macroEnabled/i.test(types);
  ignore('macro', macro ? 1 : 0, 'The file contains macros. They were ignored and never run.');
  ignore('activeX', names.filter((n) => /^word\/activeX\/activeX\d+\.xml$/i.test(n)).length, 'ActiveX controls in the file were ignored and never run.');
  ignore('embedded', names.filter((n) => /^word\/embeddings\//i.test(n)).length, 'Files embedded in the document were ignored and not opened.');
  const rels = part('word/_rels/document.xml.rels');
  const relNodes = rels ? findAll(parseXml(rels), 'Relationship') : [];
  const external = relNodes.filter((r) => r.attrs.TargetMode === 'External');
  ignore('link', external.length, `${plural(external.length, 'link')} to outside the file (web addresses, linked pictures or templates) ${external.length === 1 ? 'was' : 'were'} not followed and not brought across.`);
  ignore('other', relNodes.filter((r) => /aFChunk|attachedTemplate|subDocument/i.test(r.attrs.Type ?? '')).length, 'Parts that pull in other documents (attached templates, sub-documents, imported chunks) were ignored.');
  const headersFooters = names.filter((n) => /^word\/(header|footer)\d*\.xml$/i.test(n)).length;
  ignore('headerFooter', headersFooters, 'Page headers and footers were not read. Add a header or footer in the Design Studio.');

  const styles = readStyles(part('word/styles.xml'));
  const fonts = new Set<string>();
  for (const f of findAll(parseXml(part('word/fontTable.xml') ?? '<x/>'), 'font')) { const n = attr(f, 'name'); if (n && fonts.size < 12) fonts.add(n); }

  const root = parseXml(doc);
  const body = findAll(root, 'body')[0];
  if (!body) throw new DocxRefusal('NOT_DOCX', 'This is not a Word (.docx) file: it has no document body.');
  const c: Counters = { tracked: 0, comments: 0, fields: 0, textBoxes: 0, images: [], page: 1, nestedTables: 0, forms: 0 };
  const blocks: ReadBlock[] = [];
  let listOpen: ReadBlock | null = null;
  const push = (b: Omit<ReadBlock, 'id'>) => { const block = { id: `b${blocks.length + 1}`, ...b } as ReadBlock; blocks.push(block); return block; };
  let lastSect: XNode | undefined;

  const walk = (container: XNode) => {
    for (const el of kids(container)) {
      const name = local(el.name);
      if (name === 'p') {
        const p = paragraph(el, styles, c);
        const sect = kid(kid(el, 'pPr'), 'sectPr');
        if (sect) lastSect = sect;
        if (!p.text) { listOpen = null; c.page += p.pageBreaks; continue; }
        const lines = p.text.split('\n').map((l) => l.trim()).filter(Boolean);
        if (p.level) {
          listOpen = null;
          push({ kind: 'heading', page: c.page, level: Math.min(3, p.level) as 1 | 2 | 3, lines: [lines.join(' ')], ...(p.bold ? { bold: true } : {}), ...(p.italic ? { italic: true } : {}) });
        } else if (p.list) {

          if (listOpen && listOpen.page === c.page) listOpen.lines.push(lines.join(' '));
          else listOpen = push({ kind: 'list', page: c.page, lines: [lines.join(' ')] });
        } else {
          listOpen = null;
          push({ kind: 'paragraph', page: c.page, lines, ...(p.bold ? { bold: true } : {}), ...(p.italic ? { italic: true } : {}), ...(p.small ? { small: true } : {}) });
        }
        c.page += p.pageBreaks;
      } else if (name === 'tbl') {
        listOpen = null;
        const rows = kids(el).filter((r) => local(r.name) === 'tr').map((tr) => kids(tr).filter((x) => local(x.name) === 'tc' || local(x.name) === 'sdt').map((tc) => cellText(local(tc.name) === 'sdt' ? kid(tc, 'sdtContent') ?? tc : tc, styles, c)));
        const used = rows.filter((r) => r.some((x) => x.trim()));
        if (!used.length) continue;
        const width = Math.max(...used.map((r) => r.length));
        const square = used.map((r) => [...r, ...new Array(width - r.length).fill('')]);
        const firstRowHeader = !!kid(kid(kids(el).find((r) => local(r.name) === 'tr'), 'trPr'), 'tblHeader') || (square.length > 1 && square[0].every((x) => x.trim() && !/\d/.test(x)));
        if (width === 1 && square.length <= 2) {
          // A one-cell "table" is a box around text: read it as text.
          push({ kind: 'paragraph', page: c.page, lines: square.map((r) => r[0]).filter(Boolean) });
          continue;
        }
        push({ kind: 'table', page: c.page, lines: [], rows: square, headerRow: firstRowHeader });
      } else if (name === 'sdt') {
        const content = kid(el, 'sdtContent');
        if (content) walk(content);
      } else if (name === 'sectPr') lastSect = el;
      else if (name === 'customXml' || name === 'ins' || name === 'moveTo') { if (name !== 'customXml') c.tracked++; walk(el); }
      else if (name === 'del' || name === 'moveFrom') c.tracked++;
      else if (name === 'altChunk') ignore('other', 1, 'A part brought in from another document was ignored.');
    }
  };
  walk(body);

  ignore('trackedChange', c.tracked, 'The file has tracked changes. The text is read as it now reads (deleted text left out); the change marks were ignored.');
  const commentParts = names.filter((n) => /^word\/comments(Extended|Ids|Extensible)?\.xml$/i.test(n)).length;
  ignore('comment', c.comments || (commentParts ? 1 : 0), 'Comments in the file were ignored.');
  ignore('field', c.fields, 'Fields that Word works out (such as dates, page numbers or merge fields) were read as the text they last showed.');
  ignore('textBox', c.textBoxes, `${plural(c.textBoxes, 'text box', 'text boxes')} in the file ${c.textBoxes === 1 ? 'was' : 'were'} not read. Add that text in the Design Studio.`);
  if (c.nestedTables) ignore('other', c.nestedTables, 'Tables inside tables were read as text in their cell.');

  // The page size of the (last) section, in twentieths of a point.
  const pg = kid(lastSect, 'pgSz');
  const w = Number(attr(pg, 'w')) / 20, h = Number(attr(pg, 'h')) / 20;
  const paper = paperOf(Number.isFinite(w) && w > 0 ? w : 612, Number.isFinite(h) && h > 0 ? h : 792);
  // How many pages Word last counted, when it says; otherwise the explicit page breaks.
  const app = part('docProps/app.xml');
  const said = app ? Number(/<Pages>(\d+)<\/Pages>/.exec(app)?.[1]) : NaN;
  const pages = Number.isFinite(said) && said > 0 ? Math.max(said, c.page) : c.page;

  const notes: string[] = [];
  if (!blocks.length) notes.push('The file has no text the studio could read.');
  return { kind: 'docx', pages, paper, blocks, images: c.images, ignored, notes, fonts: [...fonts] };
}
