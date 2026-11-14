import { amountToCents, SETUP_LIMITS, type SetupColumn, type SetupColumnType, type SetupField, type SetupMessageVersion, type SetupSection, type SetupSpec } from '@iss/model';
import { alignSamples, type AlignedRow, type SampleAlignment } from './alignSamples';
import { FILE_KIND_LABEL, PAPER_LABEL, blockText, type FileReading, type ReadBlock, type ReadImage } from './fileReading';
import { DETAIL_KIND_LABEL, markPersonalDetails, marksAt, replaceMarks, type DetailMark } from './personalDetails';

/**
 * "Rebuild from a file": everything after the reading, as pure functions.
 *
 *  - `fileSamples` marks the likely personal details of each reading and compares the samples.
 *  - `sendOutline` is EXACTLY the text that would be sent to a model: the text and layout of the samples, with the marked
 *    values replaced by placeholders when the person chooses that. Never a file name, never image content. The server
 *    computes it again from the files before any model call and refuses when it differs from what the person saw.
 *  - `setupSpecFromFile` is the built-in proposal: headings, text blocks and tables become sections, marked values data
 *    fields, without rules. Without AI it is the proposal; with AI it is not used.
 *  - `notBroughtAcross` is the report of what the studio cannot take over from the file.
 */
export interface FileSample { reading: FileReading; marks: DetailMark[] }
export interface FileSamples { samples: FileSample[]; alignment: SampleAlignment | null }

/** The marks of each reading (ids unique across samples: `s1m3`) and, with two or more samples, how they compare. */
export function fileSamples(readings: FileReading[]): FileSamples {
  const samples = readings.map((reading, i) => ({ reading, marks: markPersonalDetails(reading.blocks, { prefix: `s${i + 1}` }) }));
  const alignment = samples.length > 1 ? alignSamples(samples.map((s) => ({ blocks: s.reading.blocks, marks: s.marks }))) : null;
  return { samples, alignment };
}

export interface SendChoice {
  /** Replace each marked value with its placeholder before sending. */
  placeholders: boolean;
  /** Mark ids the person said are not customer data: their values stay as they are. */
  unmarked?: Iterable<string>;
}

/** The longest outline the studio sends; anything after it is left out and the outline says so. */
export const SEND_OUTLINE_MAX = 60_000;

const r0 = (n: number) => String(Math.round(n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const activeMarks = (marks: DetailMark[], unmarked: Set<string>) => marks.filter((m) => !unmarked.has(m.id));

function lineOf(b: ReadBlock, i: number, marks: DetailMark[], placeholders: boolean): string {
  return placeholders ? replaceMarks(b.lines[i], marksAt(marks, b.id, i)) : b.lines[i];
}

function blockHead(b: ReadBlock, n: number, kind: FileReading['kind']): string {
  const parts = [`#${n}`, kind === 'pdf' || b.page > 1 ? `p${b.page}` : ''];
  parts.push(b.kind === 'heading' ? `heading ${b.level ?? 1}` : b.kind === 'table' ? 'table' : b.kind === 'list' ? `list of ${plural(b.lines.length, 'item')}` : b.small ? 'small print' : 'paragraph');
  if (b.kind === 'table') {
    const rows = b.rows ?? [];
    parts.push(`${plural(rows[0]?.length ?? 0, 'column')} × ${plural(rows.length, 'row')}${b.headerRow ? ', first row names the columns' : ''}`);
  }
  if (b.sizePt) parts.push(`${r0(b.sizePt)} pt`);
  if (b.bold) parts.push('bold');
  if (b.italic) parts.push('italic');
  if (b.box) parts.push(`top ${r0(b.box.y)}, left ${r0(b.box.x)}, width ${r0(b.box.w)}`);
  return `[${parts.filter(Boolean).join(' · ')}]`;
}

function imageLine(img: ReadImage): string {
  return `[p${img.page} · image · ${r0(img.widthPt)} × ${r0(img.heightPt)} pt${img.box ? ` · top ${r0(img.box.y)}, left ${r0(img.box.x)}` : ''} · picture not read]`;
}

function blockLines(b: ReadBlock, n: number, reading: FileReading, marks: DetailMark[], placeholders: boolean): string[] {
  const out: string[] = [];
  const head = blockHead(b, n, reading.kind);
  if (b.kind === 'table') {
    out.push(head);
    const rows = b.rows ?? [];
    const header = b.headerRow ? rows[0] : null;
    if (header) out.push(`    | ${header.join(' | ')} |`);
    const body = header ? rows.slice(1) : rows;
    if (placeholders) {
      // A table's rows are one customer's data: with placeholders, the rows are not sent, only what each column holds.
      const names = (header ?? body[0] ?? []).map((h, c) => `{{${header ? (h.trim() || `Column ${c + 1}`) : `Column ${c + 1}`}}}`);
      if (body.length) out.push(`    | ${names.join(' | ')} |`, `    (${plural(body.length, 'row')} of data, replaced by placeholders)`);
    } else for (const row of body) out.push(`    | ${row.join(' | ')} |`);
    return out;
  }
  if (b.kind === 'list') {
    out.push(head);
    b.lines.forEach((_, i) => out.push(`    - ${lineOf(b, i, marks, placeholders)}`));
    return out;
  }
  out.push(`${head} ${lineOf(b, 0, marks, placeholders)}`);
  for (let i = 1; i < b.lines.length; i++) out.push(`    ${lineOf(b, i, marks, placeholders)}`);
  return out;
}

function sampleHeader(r: FileReading, i: number, total: number): string {
  const paper = r.paper.size ? `${PAPER_LABEL[r.paper.size]} ${r.paper.landscape ? 'landscape' : 'portrait'}` : 'a page size of its own';
  return `Sample ${i + 1}${total > 1 ? ` of ${total}` : ''}: a ${FILE_KIND_LABEL[r.kind]} file, ${r.kind === 'docx' ? 'about ' : ''}${plural(r.pages, 'page')}, ${paper} (${r0(r.paper.widthPt)} × ${r0(r.paper.heightPt)} pt).${r.bodySizePt ? ` Most text is ${r0(r.bodySizePt)} pt.` : ''}`;
}

/** One sample's text and layout, block by block, with its pictures noted (position and size only). */
function sampleOutline(s: FileSample, i: number, total: number, marks: DetailMark[], placeholders: boolean): string[] {
  const r = s.reading;
  const out = [sampleHeader(r, i, total)];
  const pages = Math.max(r.pages, ...r.blocks.map((b) => b.page), 1);
  for (let p = 1; p <= pages; p++) {
    r.blocks.forEach((b, k) => { if (b.page === p) out.push(...blockLines(b, k + 1, r, marks, placeholders)); });
    for (const img of r.images.filter((x) => x.page === p)) out.push(imageLine(img));
  }
  return out;
}

function rowText(row: AlignedRow, k: number, samples: FileSample[], unmarked: Set<string>, placeholders: boolean): string {
  const id = row.blocks[k];
  const b = id ? samples[k].reading.blocks.find((x) => x.id === id) : undefined;
  if (!b) return '';
  if (b.kind === 'table') return (b.rows?.[0] ?? []).join(' | ');
  const marks = activeMarks(samples[k].marks, unmarked);
  return b.lines.map((_, i) => lineOf(b, i, marks, placeholders)).join(' / ');
}

function comparisonLines(fs: FileSamples, unmarked: Set<string>, placeholders: boolean): string[] {
  const a = fs.alignment;
  if (!a || a.samples < 2) return [];
  const first = fs.samples[0].reading.blocks;
  const out = [`Comparison of the ${a.samples} samples, block by block (#n is the block of sample 1 listed above):`];
  a.rows.forEach((row, ri) => {
    const where = row.blocks[0] ? `#${first.findIndex((b) => b.id === row.blocks[0]) + 1}` : `Row ${ri + 1} (not in sample 1)`;
    const inSamples = row.blocks.map((b, k) => (b ? k + 1 : 0)).filter(Boolean);
    switch (row.kind) {
      case 'same': out.push(`${where} (${row.blockKind}): the same wording in every sample.`); break;
      case 'values': {
        if (row.blockKind === 'table') { out.push(`${where} (table): the same columns in every sample; the rows differ.`); break; }
        const tpl = row.template ?? '';
        out.push(`${where} (${row.blockKind}): only values differ. Wording: ${tpl}`);
        for (const sl of row.slots ?? []) out.push(`    {{${sl.name}}}: ${placeholders ? 'differs between the samples (values not sent)' : sl.values.map((v, k) => `sample ${k + 1}: ${v || '(nothing)'}`).join('; ')}`);
        break;
      }
      case 'different':
        out.push(`${where} (${row.blockKind}): the wording differs.`);
        row.blocks.forEach((_, k) => out.push(`    Sample ${k + 1}: ${rowText(row, k, fs.samples, unmarked, placeholders)}`));
        break;
      case 'partial':
        out.push(`${where} (${row.blockKind}): only in sample${inSamples.length === 1 ? '' : 's'} ${inSamples.join(' and ')}.`);
        if (!row.blocks[0]) inSamples.forEach((k) => out.push(`    Sample ${k}: ${rowText(row, k - 1, fs.samples, unmarked, placeholders)}`));
        break;
    }
  });
  return out;
}

/**
 * Exactly what would be sent to a model: the samples' text and layout (sample 1 in full, the others as a comparison
 * with sample 1), pictures as position and size only, and with placeholders the marked values replaced.
 */
export function sendOutline(fs: FileSamples, choice: SendChoice): string {
  const unmarked = new Set(choice.unmarked ?? []);
  const total = fs.samples.length;
  const lines: string[] = [
    `A document to rebuild, read from ${total === 1 ? 'one sample' : `${total} samples of the same document`}. Positions and sizes are in points, measured from the top-left corner of the page.`,
    choice.placeholders
      ? 'Values that look like one customer’s data are replaced by placeholders in double braces, such as {{Amount due}}; {{First name}} and {{Last name}} stand for the customer’s name.'
      : 'The text is as it is in the file; the person confirmed that the file holds no real customer data.',
    '',
  ];
  if (fs.samples[0]) lines.push(...sampleOutline(fs.samples[0], 0, total, activeMarks(fs.samples[0].marks, unmarked), choice.placeholders));
  const cmp = comparisonLines(fs, unmarked, choice.placeholders);
  if (cmp.length) lines.push('', ...cmp);
  let text = lines.join('\n');
  if (text.length > SEND_OUTLINE_MAX) text = `${text.slice(0, SEND_OUTLINE_MAX)}\n(The rest is not sent: the outline is limited to 60,000 characters.)`;
  return text;
}

/* ------------------------------------------------------------------ the built-in proposal */

const DATE_ONLY = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.](?:\d{4}|\d{2})|\d{1,2}(?:st|nd|rd|th)?\s+\p{L}{3,9}\.?,?\s+\d{4}|\p{L}{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})$/u;
const asAmount = (v: string) => amountToCents(v.trim().replace(/^(?:R|USD|EUR|GBP|ZAR|CAD|AUD)\s?/i, '').replace(/\s?(?:CR|DR)$/i, '').replace(/(\d) (?=\d{3}\b)/g, '$1').replace(/[€£¥₹]/, '$'));
function typeOfValues(values: string[]): SetupColumnType {
  const vs = values.map((v) => v.trim()).filter(Boolean);
  if (!vs.length) return 'text';
  if (vs.every((v) => /^-?\d{1,9}$/.test(v))) return 'number';
  if (vs.every((v) => /[.,$€£¥₹R]|\d{4,}/.test(v) && asAmount(v) !== null && !/^\d{4}$/.test(v))) return 'amount';
  if (vs.every((v) => DATE_ONLY.test(v))) return 'date';
  return 'text';
}
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max).trimEnd() : s);
const cleanLabel = (s: string) => s.replace(/[{}<>\[\]]/g, '').replace(/\s+/g, ' ').trim();

interface Builder {
  fields: SetupField[];
  byLabel: Map<string, SetupField>;
  sections: SetupSection[];
  cut: number;
}
function addField(b: Builder, field: SetupField): string {
  const key = field.label.toLowerCase();
  const had = b.byLabel.get(key);
  if (had) return had.label;
  if (b.fields.length >= SETUP_LIMITS.fields) return '';
  b.fields.push(field);
  b.byLabel.set(key, field);
  return field.label;
}
const NAME_MENTION: Record<string, string> = { 'first name': '{First name}', 'last name': '{Last name}' };

/** The wording of a line with its marks as mentions of data fields (`{Amount due}`) or of the customer's name. */
function mention(b: Builder, text: string, marks: DetailMark[]): string {
  return replaceMarks(text, marks, (m) => {
    if (m.kind === 'name') return m.placeholder.replace(/\{\{([^{}]+)\}\}/g, (_, n: string) => NAME_MENTION[n.toLowerCase()] ?? `{${n}}`);
    const label = addField(b, { label: clip(cleanLabel(m.field), SETUP_LIMITS.label), type: m.type });
    return label ? `{${label}}` : m.text;
  });
}

function tableSection(b: Builder, block: ReadBlock, name: string, notes: string[]): void {
  const rows = (block.rows ?? []).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return;
  const width = Math.max(...rows.map((r) => r.length));
  const header = block.headerRow ? rows[0] : null;
  let body = header ? rows.slice(1) : rows;
  // A last row that says "Total" is the sum the studio works out, not a row of data.
  const totalRow = body.length > 1 && /^\s*(?:sub\s?)?total\b/i.test(body[body.length - 1].find((c) => c.trim()) ?? '') ? body[body.length - 1] : null;
  if (totalRow) body = body.slice(0, -1);
  const used = new Set<string>();
  let columns: SetupColumn[] = Array.from({ length: width }, (_, c) => {
    let label = clip(cleanLabel(header?.[c] ?? ''), SETUP_LIMITS.label) || `Column ${c + 1}`;
    for (let k = 2; used.has(label.toLowerCase()); k++) label = `${clip(cleanLabel(header?.[c] ?? ''), SETUP_LIMITS.label - 3) || 'Column'} ${k}`;
    used.add(label.toLowerCase());
    return { label, type: typeOfValues(body.map((r) => r[c] ?? '')) };
  });
  if (columns.length > SETUP_LIMITS.columns) { notes.push(`The table ${name} has ${columns.length} columns; a list holds at most ${SETUP_LIMITS.columns}, so the last ${columns.length - SETUP_LIMITS.columns} were left out.`); columns = columns.slice(0, SETUP_LIMITS.columns); }
  const label = addField(b, { label: name, type: 'list', columns });
  if (!label) return;
  const totalCol = totalRow ? columns.findIndex((c, i) => c.type === 'amount' && (totalRow[i] ?? '').trim()) : -1;
  b.sections.push({ type: 'table', list: label, columns: columns.map((c) => c.label), ...(totalCol >= 0 ? { totalColumn: columns[totalCol].label } : {}) });
}

/** "Label: value" on every line, each value one mark: a summary of key figures. */
function keyFigures(b: Builder, block: ReadBlock, marks: DetailMark[]): boolean {
  if (block.kind !== 'paragraph' || block.lines.length < 2 || block.lines.length > SETUP_LIMITS.keyFigures) return false;
  const fields: string[] = [];
  for (let i = 0; i < block.lines.length; i++) {
    const line = block.lines[i];
    const ms = marksAt(marks, block.id, i).filter((m) => m.kind !== 'name' && m.kind !== 'address');
    if (ms.length !== 1 || line.slice(ms[0].end).trim() || !/[:–-]\s*$/.test(line.slice(0, ms[0].start))) return false;
    fields.push(ms[0].field);
  }
  const labels = fields.map((f, i) => addField(b, { label: clip(cleanLabel(f), SETUP_LIMITS.label), type: marksAt(marks, block.id, i).find((m) => m.kind !== 'name')!.type })).filter(Boolean);
  if (!labels.length) return false;
  b.sections.push({ type: 'keyFigures', fields: labels });
  return true;
}

function push(b: Builder, s: SetupSection) {
  if (b.sections.length >= SETUP_LIMITS.sections) { b.cut += 1; return; }
  b.sections.push(s);
}

function blockSection(b: Builder, block: ReadBlock, marks: DetailMark[], tableName: () => string, notes: string[]): void {
  if (b.sections.length >= SETUP_LIMITS.sections) { b.cut += 1; return; }
  const text = (lines: string[], markLines = true) => lines.map((l, i) => (markLines ? mention(b, l, marksAt(marks, block.id, i)) : l));
  switch (block.kind) {
    case 'heading': push(b, { type: 'heading', text: clip(text(block.lines).join(' '), SETUP_LIMITS.heading) }); break;
    case 'list': push(b, { type: 'paragraph', text: text(block.lines).map((l) => `- ${l}`).join('\n') }); break;
    case 'table': tableSection(b, block, tableName(), notes); break;
    default:
      if (keyFigures(b, block, marks)) break;
      push(b, block.small && blockText(block).length >= 40 ? { type: 'notice', text: text(block.lines).join('\n') } : { type: 'paragraph', text: text(block.lines).join('\n') });
  }
}

export interface FileSetup { spec: SetupSpec; notes: string[] }

/**
 * The built-in reading of the samples as a document setup: headings, text blocks and lists become sections, tables
 * list fields shown as tables, marked values data fields (amounts and dates typed as such). Where several samples are
 * compared, wording that is the same everywhere is fixed (marks there are ignored), values that differ become data
 * fields, and wording that differs becomes a message whose versions are chosen by a stand-in choice field. No rules
 * are invented. Example values are never taken from the file: it may hold real customer data.
 */
export function setupSpecFromFile(fs: FileSamples, opts: { title?: string; issuerName?: string; unmarked?: Iterable<string> } = {}): FileSetup {
  const unmarked = new Set(opts.unmarked ?? []);
  const notes: string[] = [];
  const b: Builder = { fields: [], byLabel: new Map(), sections: [], cut: 0 };
  const first = fs.samples[0];
  if (!first) return { spec: { title: opts.title || 'Rebuilt document', issuerName: opts.issuerName ?? '', summary: '', fields: [], sections: [] }, notes };
  let tables = 0;
  let messages = 0;
  const nameOfTable = (blocks: ReadBlock[], block: ReadBlock) => () => {
    tables += 1;
    const i = blocks.indexOf(block);
    const prev = i > 0 ? blocks[i - 1] : null;
    const heading = prev?.kind === 'heading' ? cleanLabel(blockText(prev)) : '';
    let label = heading && heading.length <= 40 && !/\{/.test(heading) ? heading : `Table ${tables}`;
    for (let k = 2; b.byLabel.has(label.toLowerCase()); k++) label = `${heading && heading.length <= 36 ? heading : 'Table'} ${k}`;
    return label;
  };

  const rows = fs.alignment && fs.alignment.samples > 1 ? fs.alignment.rows : null;
  if (!rows) {
    const marks = activeMarks(first.marks, unmarked);
    for (const block of first.reading.blocks) blockSection(b, block, marks, nameOfTable(first.reading.blocks, block), notes);
  } else {
    for (const row of rows) {
      const k = row.blocks.findIndex(Boolean);
      const sample = fs.samples[k];
      const block = sample.reading.blocks.find((x) => x.id === row.blocks[k])!;
      const marks = activeMarks(sample.marks, unmarked);
      if (row.kind === 'same' && block.kind !== 'table') {
        // The same wording in every sample is fixed wording, even where it looked like a personal detail.
        blockSection(b, block, [], nameOfTable(sample.reading.blocks, block), notes);
      } else if (row.kind === 'values' && row.template && block.kind !== 'table') {
        for (const sl of row.slots ?? []) if (!b.byLabel.has(sl.name.toLowerCase())) addField(b, { label: clip(cleanLabel(sl.name), SETUP_LIMITS.label), type: typeOfValues(sl.values) });
        // Name placeholders become the customer's name; every other placeholder a mention of its data field.
        for (const m of marks.filter((x) => x.blockId === block.id && x.kind !== 'name')) addField(b, { label: clip(cleanLabel(m.field), SETUP_LIMITS.label), type: m.type });
        const text = row.template.replace(/\{\{([^{}]+)\}\}/g, (_, n: string) => NAME_MENTION[n.toLowerCase()] ?? `{${n}}`);
        push(b, block.kind === 'heading' ? { type: 'heading', text: clip(text, SETUP_LIMITS.heading) } : { type: 'paragraph', text });
      } else if (row.kind === 'different' && block.kind !== 'table') {
        messages += 1;
        const name = `Message ${messages}`;
        const texts: string[] = [];
        row.blocks.forEach((id, s) => {
          const bl = id ? fs.samples[s].reading.blocks.find((x) => x.id === id) : undefined;
          if (!bl) return;
          const t = bl.lines.map((l, i) => mention(b, l, marksAt(activeMarks(fs.samples[s].marks, unmarked), bl.id, i))).join('\n');
          if (!texts.includes(t)) texts.push(t);
        });
        const letters = texts.map((_, i) => String.fromCharCode(65 + i));
        const choice = addField(b, { label: `${name} version`, type: 'choice', choices: letters });
        const versions: SetupMessageVersion[] = texts.map((t, i) => (i === 0 || !choice
          ? { title: `Version ${letters[i]}`, text: t, fallback: true }
          : { title: `Version ${letters[i]}`, text: t, when: { field: choice, test: 'is', value: letters[i] } }));
        push(b, { type: 'messages', name, versions: choice ? versions : versions.slice(0, 1) });
        notes.push(`${name}: its wording differs between the samples. Who gets which version cannot be read from them, so the choice field “${name} version” stands in for the rule. Replace it with a condition on real data.`);
      } else {
        blockSection(b, block, marks, nameOfTable(sample.reading.blocks, block), notes);
        if (row.kind === 'partial') notes.push(`A ${row.blockKind} that is not in every sample is shown to every customer. Add a condition if only some customers should see it.`);
      }
    }
  }
  if (b.cut) notes.push(`${plural(b.cut, 'more block was', 'more blocks were')} left out: a setup holds at most ${SETUP_LIMITS.sections} sections.`);

  const firstHeading = first.reading.blocks.find((x) => x.kind === 'heading');
  const headingTitle = firstHeading ? clip(cleanLabel(blockText(firstHeading)).replace(/\{[^}]*\}/g, '').trim(), 80) : '';
  const title = opts.title?.trim() || (headingTitle.length >= 2 ? headingTitle : 'Rebuilt document');
  const r = first.reading;
  const spec: SetupSpec = {
    title,
    issuerName: opts.issuerName?.trim() ?? '',
    summary: `A document rebuilt from ${fs.samples.length === 1 ? `a ${FILE_KIND_LABEL[r.kind]} file` : `${fs.samples.length} sample files`}.`,
    fields: b.fields,
    sections: b.sections,
    ...(r.paper.size ? { paper: r.paper.size } : {}),
  };
  return { spec, notes };
}

/* ------------------------------------------------------------------ what is not brought across */

export type NotBroughtTopic = 'images' | 'fonts' | 'layout' | 'rules' | 'tables' | 'safety' | 'other';
export interface NotBroughtItem { topic: NotBroughtTopic; text: string }
export const NOT_BROUGHT_TOPIC_LABEL: Record<NotBroughtTopic, string> = { images: 'Pictures', fonts: 'Fonts and colours', layout: 'Layout', rules: 'Alternatives and rules', tables: 'Tables', safety: 'Left out for safety', other: 'Other' };

function where(img: ReadImage, r: FileReading): string {
  if (!img.box) return `on page ${img.page}`;
  const v = img.box.y + img.box.h / 2 < r.paper.heightPt / 3 ? 'top' : img.box.y + img.box.h / 2 > (r.paper.heightPt * 2) / 3 ? 'bottom' : 'middle';
  const h = img.box.x + img.box.w / 2 < r.paper.widthPt / 3 ? ' left' : img.box.x + img.box.w / 2 > (r.paper.widthPt * 2) / 3 ? ' right' : '';
  return `at the ${v}${h} of page ${img.page}`;
}

/**
 * What the proposal does not take over from the file, in plain words: pictures, fonts, exact positions and colours,
 * alternatives and rules that the samples cannot show, parts left out for safety, and anything else the reading noted.
 * It never quotes the file's text, so it can be kept with the document.
 */
export function notBroughtAcross(fs: FileSamples, opts: { unmarked?: Iterable<string> } = {}): NotBroughtItem[] {
  const out: NotBroughtItem[] = [];
  const add = (topic: NotBroughtTopic, text: string) => { if (!out.some((x) => x.text === text)) out.push({ topic, text }); };
  const first = fs.samples[0]?.reading;
  if (!first) return out;
  const n = fs.samples.length;
  const per = (r: FileReading, i: number) => (n > 1 ? `Sample ${i + 1}: ` : '');

  fs.samples.forEach(({ reading: r }, i) => {
    if (r.images.length) {
      const shown = r.images.slice(0, 4).map((img) => `${r0(img.widthPt)} × ${r0(img.heightPt)} pt ${where(img, r)}`);
      add('images', `${per(r, i)}${plural(r.images.length, 'picture')} (${shown.join('; ')}${r.images.length > 4 ? `; and ${r.images.length - 4} more` : ''}) ${r.images.length === 1 ? 'was' : 'were'} noted by position and size only; the pictures themselves were not read. Add a logo or picture in the Design Studio.`);
    }
  });
  const fonts = [...new Set(fs.samples.flatMap((s) => s.reading.fonts))];
  add('fonts', `${fonts.length ? `The file’s fonts (${fonts.slice(0, 5).join(', ')}${fonts.length > 5 ? ` and ${fonts.length - 5} more` : ''}), their sizes` : 'The file’s fonts, their sizes'} and its colours are not copied: the document uses the studio’s text styles and the issuer’s colour.`);
  add('layout', 'Exact positions are not copied: the components follow one another in reading order. Text placed side by side in the file (such as an address next to a date) is placed one under the other.');
  add('layout', 'Heading levels are not kept: every heading is shown at the same size. Change a heading’s style in the Design Studio.');
  if (first.pages > 1) add('layout', 'Page breaks are not copied: the studio composes the pages itself and continues text and tables onto the next page.');
  if (!first.paper.size) add('layout', `The page size (${r0(first.paper.widthPt)} × ${r0(first.paper.heightPt)} pt) is not one the studio offers, so US Letter is used.`);
  else if (first.paper.landscape) add('layout', 'The file is landscape; the document is set up in portrait. Change the orientation in the Design Studio.');

  if (n === 1) add('rules', 'One sample shows one customer’s copy, so wording that differs for other customers, and the rules that choose it, cannot be read from it. Supply two or three samples of the same document to see where the wording varies, then add rules in Rules & data.');
  const a = fs.alignment;
  if (a && a.samples > 1) {
    if (a.counts.different) add('rules', `${plural(a.counts.different, 'block has', 'blocks have')} wording that differs between the samples. Who gets which wording cannot be read from the samples: a choice field stands in for the rule until you add a condition on real data.`);
    if (a.counts.partial) add('rules', `${plural(a.counts.partial, 'block is', 'blocks are')} not in every sample, so ${a.counts.partial === 1 ? 'it' : 'they'} may be shown only to some customers. ${a.counts.partial === 1 ? 'It is' : 'They are'} proposed for every customer; add a condition in Rules & data.`);
    if (!a.counts.different && !a.counts.partial) add('rules', 'The samples differ only in their values, so no alternative wording was found. Rules that apply to customers unlike these samples cannot be read from them.');
  }
  add('rules', 'Amounts the file shows as worked out (totals, balances) are proposed as data fields, not as calculations. Add a calculation in Rules & data where the studio should work them out.');

  fs.samples.forEach(({ reading: r }, i) => {
    for (const note of r.notes) add(/table/i.test(note) ? 'tables' : 'other', `${per(r, i)}${note}`);
    for (const ig of r.ignored) add('safety', `${per(r, i)}${ig.text}`);
  });
  return out;
}

/** Every mark of the samples by kind, for a short summary ("3 amounts, 2 dates"). */
export function markSummary(fs: FileSamples, unmarked: Iterable<string> = []): string {
  const off = new Set(unmarked);
  const counts = new Map<string, number>();
  for (const m of fs.samples.flatMap((s) => s.marks)) if (!off.has(m.id)) counts.set(DETAIL_KIND_LABEL[m.kind].toLowerCase(), (counts.get(DETAIL_KIND_LABEL[m.kind].toLowerCase()) ?? 0) + 1);
  return counts.size ? [...counts].map(([k, c]) => `${c} × ${k}`).join(', ') : 'nothing';
}
