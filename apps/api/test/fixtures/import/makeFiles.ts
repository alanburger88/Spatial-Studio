/**
 * Small PDF and Word (.docx) files for the "Rebuild from a file" tests, built here from scratch so that every byte is
 * known and every value is invented. Nothing in them belongs to a real person or organisation.
 *
 * The PDF writer draws text in the standard Helvetica fonts (no font files embedded) and pictures as tiny RGB images;
 * the Word writer packs hand-written WordprocessingML with the studio's own ZIP writer.
 */
import { zipFiles, ZIP_FIXED_DATE } from '../../../src/zip';

/* ------------------------------------------------------------------ PDF */

export interface PdfText { x: number; /** From the top of the page, to the baseline. */ y: number; size: number; text: string; bold?: boolean; italic?: boolean }
export interface PdfImage { x: number; y: number; w: number; h: number }
export interface PdfPage { width?: number; height?: number; texts?: PdfText[]; images?: PdfImage[]; links?: string[]; comment?: boolean }
export interface PdfOptions { javascript?: boolean; attachment?: boolean; formField?: boolean }

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf(pages: PdfPage[], opts: PdfOptions = {}): Buffer {
  const objs: Array<Buffer | null> = [];
  const reserve = () => { objs.push(null); return objs.length; };
  const set = (n: number, body: string | Buffer) => { objs[n - 1] = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'); };
  const add = (body: string | Buffer) => { const n = reserve(); set(n, body); return n; };
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

  const catalog = reserve();
  const pagesObj = reserve();
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
  const img = add(stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', Buffer.from([30, 80, 120, 200, 200, 200, 200, 200, 200, 30, 80, 120])));
  const kids: number[] = [];
  const fieldIds: number[] = [];
  for (const p of pages) {
    const w = p.width ?? 612, h = p.height ?? 792;
    const ops: string[] = [];
    for (const im of p.images ?? []) ops.push(`q ${im.w} 0 0 ${im.h} ${im.x} ${h - im.y - im.h} cm /Im1 Do Q`);
    for (const t of p.texts ?? []) ops.push(`BT /${t.bold ? 'F2' : t.italic ? 'F3' : 'F1'} ${t.size} Tf 1 0 0 1 ${t.x} ${h - t.y} Tm (${esc(t.text)}) Tj ET`);
    const content = add(stream('', Buffer.from(ops.join('\n'), 'latin1')));
    const annots: number[] = [];
    for (const url of p.links ?? []) annots.push(add(`<< /Type /Annot /Subtype /Link /Rect [50 50 200 70] /Border [0 0 0] /A << /S /URI /URI (${esc(url)}) >> >>`));
    if (p.comment) annots.push(add('<< /Type /Annot /Subtype /Text /Rect [300 700 320 720] /Contents (A note) >>'));
    if (opts.formField && !fieldIds.length) { const f = add('<< /Type /Annot /Subtype /Widget /FT /Tx /T (field1) /Rect [300 100 450 120] /V (typed) >>'); annots.push(f); fieldIds.push(f); }
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> /XObject << /Im1 ${img} 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
  }
  set(pagesObj, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const names: string[] = [];
  if (opts.javascript) { const js = add('<< /S /JavaScript /JS (app.alert\\(1\\);) >>'); names.push(`/JavaScript << /Names [(start) ${js} 0 R] >>`); }
  if (opts.attachment) {
    const ef = add(stream('/Type /EmbeddedFile', Buffer.from('invented attachment', 'latin1')));
    const spec = add(`<< /Type /Filespec /F (note.txt) /UF (note.txt) /EF << /F ${ef} 0 R >> >>`);
    names.push(`/EmbeddedFiles << /Names [(note.txt) ${spec} 0 R] >>`);
  }
  const acro = fieldIds.length ? ` /AcroForm << /Fields [${fieldIds.map((f) => `${f} 0 R`).join(' ')}] >>` : '';
  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R${names.length ? ` /Names << ${names.join(' ')} >>` : ''}${acro} >>`);

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o!, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(offset);
    parts.push(b);
    offset += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`), `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`].join('');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** A one-page statement (A4) with a heading, an address block, a salutation, key figures, a table with a total, small print and a logo. */
export function statementPdf(v: { name: string; street: string; city: string; member: string; due: string; date: string; rows: Array<[string, string, string]>; total: string; message: string; extra?: string } = INVENTED[0]): Buffer {
  const W = 595.28, H = 841.89;
  const t: PdfText[] = [
    { x: 56, y: 70, size: 18, text: 'Membership statement', bold: true },
    { x: 56, y: 120, size: 10, text: v.name }, { x: 56, y: 133, size: 10, text: v.street }, { x: 56, y: 146, size: 10, text: v.city },
    { x: 56, y: 190, size: 10, text: `Dear ${v.name.replace(/^(Ms|Mr|Mx) /, '')},` },
    { x: 56, y: 215, size: 10, text: `Member number: ${v.member}` }, { x: 56, y: 228, size: 10, text: `Amount due: ${v.due}` }, { x: 56, y: 241, size: 10, text: `Due date: ${v.date}` },
    { x: 56, y: 270, size: 13, text: 'Charges this month', bold: true },
    { x: 56, y: 295, size: 10, text: 'Date', bold: true }, { x: 200, y: 295, size: 10, text: 'Description', bold: true }, { x: 420, y: 295, size: 10, text: 'Amount', bold: true },
  ];
  v.rows.forEach((r, i) => { const y = 310 + i * 14; t.push({ x: 56, y, size: 10, text: r[0] }, { x: 200, y, size: 10, text: r[1] }, { x: 420, y, size: 10, text: r[2] }); });
  const ty = 310 + v.rows.length * 14;
  t.push({ x: 56, y: ty, size: 10, text: 'Total' }, { x: 420, y: ty, size: 10, text: v.total });
  t.push({ x: 56, y: ty + 40, size: 10, text: v.message });
  if (v.extra) t.push({ x: 56, y: ty + 60, size: 10, text: v.extra });
  t.push({ x: 56, y: 790, size: 7, text: 'Fees are charged monthly in advance. You can cancel at any time from your account page or at the front desk.' });
  return makePdf([{ width: W, height: H, texts: t, images: [{ x: 420, y: 40, w: 120, h: 40 }] }]);
}

/** Invented customers for the samples (no real person). */
export const INVENTED = [
  { name: 'Ms Jane Example', street: '12 Sample Street', city: 'Springfield, IL 62704', member: '4410 2201', due: '$54.50', date: '2026-12-01', rows: [['2026-11-01', 'Membership', '$49.00'], ['2026-11-03', 'Towel hire', '$5.50']] as Array<[string, string, string]>, total: '$54.50', message: 'Thank you for staying with us.' },
  { name: 'Mr Ben Sample', street: '7 Example Road', city: 'Shelbyville, IL 62565', member: '4410 9988', due: '$120.00', date: '2026-12-15', rows: [['2026-11-01', 'Membership', '$120.00']] as Array<[string, string, string]>, total: '$120.00', message: 'Your last payment failed. Please update your payment details before the due date.' },
  { name: 'Mx Cy Placeholder', street: '3 Test Lane', city: 'Ogdenville, IL 62701', member: '4410 5150', due: '$49.00', date: '2027-01-02', rows: [['2026-11-01', 'Membership', '$49.00']] as Array<[string, string, string]>, total: '$49.00', message: 'Thank you for staying with us.', extra: 'Your locker rental ends this month.' },
];

/** A PDF whose page is only a picture: what a scan looks like. */
export const scannedPdf = () => makePdf([{ images: [{ x: 0, y: 0, w: 612, h: 792 }] }]);

/* ------------------------------------------------------------------ Word */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const w = {
  p: (text: string, o: { style?: string; bold?: boolean; italic?: boolean; list?: boolean } = {}) =>
    `<w:p>${o.style || o.list ? `<w:pPr>${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr>` : ''}<w:r>${o.bold || o.italic ? `<w:rPr>${o.bold ? '<w:b/>' : ''}${o.italic ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${x(text)}</w:t></w:r></w:p>`,
  /** A paragraph of several runs: [text, bold]. */
  runs: (parts: Array<[string, boolean]>) => `<w:p>${parts.map(([t, b]) => `<w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`).join('')}</w:p>`,
  lines: (lines: string[]) => `<w:p>${lines.map((l, i) => `<w:r>${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${x(l)}</w:t></w:r>`).join('')}</w:p>`,
  table: (rows: string[][], header = true) => `<w:tbl><w:tblPr/>${rows.map((r, i) => `<w:tr>${i === 0 && header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${r.map((c) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${x(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`,
  picture: (wPt: number, hPt: number) => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${Math.round(wPt * 12700)}" cy="${Math.round(hPt * 12700)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"/></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  link: (text: string) => `<w:p><w:hyperlink r:id="rIdLink1"><w:r><w:t>${x(text)}</w:t></w:r></w:hyperlink></w:p>`,
  tracked: (kept: string, deleted: string) => `<w:p><w:r><w:t xml:space="preserve">${x(kept)} </w:t></w:r><w:del w:id="1" w:author="Editor" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>${x(deleted)}</w:delText></w:r></w:del></w:p>`,
  commented: (text: string) => `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>${x(text)}</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`,
  pageBreak: () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
  /** A4 portrait, in twentieths of a point. */
  sectA4: () => '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
  sectLetter: () => '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="FinePrint"><w:name w:val="Fine print"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

export interface DocxOptions {
  /** Extra relationships (an external hyperlink is added as rIdLink1 when `externalLink` is set). */
  externalLink?: boolean;
  macros?: boolean;
  embedded?: boolean;
  comments?: boolean;
  header?: boolean;
  /** Pages as Word last counted them (docProps/app.xml). */
  pages?: number;
  /** Replace the document part (for damaged or hostile files). */
  documentXml?: string;
  extraParts?: Array<{ name: string; data: Buffer }>;
}

export function makeDocx(bodyXml: string, o: DocxOptions = {}): Buffer {
  const doc = o.documentXml ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${o.externalLink ? '<Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/account" TargetMode="External"/>' : ''}
</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.${o.macros ? 'ms-word.document.macroEnabled.main+xml' : 'openxmlformats-officedocument.wordprocessingml.document.main+xml'}"/></Types>`;
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(types) },
    { name: 'word/document.xml', data: Buffer.from(doc) },
    { name: 'word/styles.xml', data: Buffer.from(STYLES) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(rels) },
  ];
  if (o.pages) files.push({ name: 'docProps/app.xml', data: Buffer.from(`<?xml version="1.0"?><Properties><Pages>${o.pages}</Pages></Properties>`) });
  if (o.macros) files.push({ name: 'word/vbaProject.bin', data: Buffer.from('invented macro bytes, never run') });
  if (o.embedded) files.push({ name: 'word/embeddings/oleObject1.bin', data: Buffer.from('invented embedded file') });
  if (o.comments) files.push({ name: 'word/comments.xml', data: Buffer.from(`<w:comments ${W_NS}/>`) });
  if (o.header) files.push({ name: 'word/header1.xml', data: Buffer.from(`<w:hdr ${W_NS}><w:p><w:r><w:t>Invented header</w:t></w:r></w:p></w:hdr>`) });
  files.push(...(o.extraParts ?? []));
  return zipFiles(files.map((f) => ({ ...f, date: ZIP_FIXED_DATE })));
}

/** A one-letter Word file with every feature the reader knows: headings, bold runs, a list, a table, a picture, A4. */
export function letterDocx(o: DocxOptions = {}): Buffer {
  return makeDocx([
    w.p('Policy renewal', { style: 'Title' }),
    w.lines(['Ms Jane Example', '12 Sample Street', 'Springfield, IL 62704']),
    w.p('Dear Jane Example,'),
    w.runs([['Your policy ', false], ['PX-12345', true], [' renews on 1 March 2027.', false]]),
    w.p('What is covered', { style: 'Heading1' }),
    w.p('Home contents', { list: true }), w.p('Accidental damage', { list: true }), w.p('Legal help', { list: true }),
    w.p('Your premium', { style: 'Heading2' }),
    w.table([['Month', 'Premium'], ['March 2027', '$31.20'], ['April 2027', '$31.20']]),
    w.picture(144, 48),
    w.p('Premiums are collected monthly by debit order.', { style: 'FinePrint', italic: true }),
    w.sectA4(),
  ].join(''), o);
}
