import {
  AVAILABLE_LANGUAGES, CHANNEL_TOKENS, SOURCE_LANGUAGE, TRANSLATION_MAX_CHARS, checkTokens, isSupportedLanguage, languageName, languageShortName, libraryOwnership, parseCsv,
  projectFieldIndex, projectLanguages, tokensOfText, translatableStrings,
  type Command, type ContentPart, type DocNode, type Project,
} from '@iss/model';

/**
 * "Import wording…" (wave 3, section 4): bring a wording table into a document's messages and translations. Pure: it
 * reads a file into a table, and plans what would change; the screen shows the plan (the dry run) and applies its
 * commands as ONE undoable step. Nothing here approves anything: imported translations are drafts with origin
 * "imported". Linked library wording, protected disclosures and approved translations are never overwritten silently:
 * they are listed as skipped with the reason.
 *
 * Reads, as the exact inverse of what the studio writes:
 *  - the Content & Translations export (`toTranslationCsv`: partId, title, mandatory, status, en-US, <locale>);
 *  - the release package's wording files (`wording/<locale>.csv`, `wording/en-US.csv` and `wording/<locale>.xlf`, XLIFF 2.0
 *    with the studio's text id in `unit/@name`);
 *  - a plain CSV: an id column and/or an English column, and one column per language (detected; the person confirms).
 * A file is untrusted input: it is parsed, never executed; XML with a DOCTYPE or entity declarations is refused.
 */

export const WORDING_IMPORT_MAX_ROWS = 5000;
export const WORDING_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export type WordingFileKind = 'xliff' | 'studio-csv' | 'package-csv' | 'source-csv' | 'plain-csv';
export const WORDING_FILE_LABEL: Record<WordingFileKind, string> = {
  xliff: 'XLIFF file exported by the studio',
  'studio-csv': 'Translations spreadsheet exported from Content & Translations',
  'package-csv': 'Wording spreadsheet from a release package',
  'source-csv': 'English wording list from a release package',
  'plain-csv': 'Spreadsheet (CSV)',
};
export type ColumnRole = 'id' | 'english' | 'title' | 'language' | 'ignore';
export interface WordingColumn { index: number; heading: string; role: ColumnRole; locale?: string; why: string }
export interface WordingTable { kind: WordingFileKind; columns: WordingColumn[]; rows: string[][]; problems: string[] }

/* ------------------------------------------------------------------ reading a file */

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unXml(s: string): { text: string; inline: boolean } {
  let inline = false;
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const noTags = noCdata.replace(/<[^>]*>/g, () => { inline = true; return ''; });
  const text = noTags.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return XML_ENTITIES[e] ?? m;
  });
  return { text, inline };
}
const attr = (tag: string, name: string): string | null => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag); return m ? unXml(m[2] ?? m[3] ?? '').text : null; };

function readXliff(xml: string): WordingTable {
  const problems: string[] = [];
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { kind: 'xliff', columns: [], rows: [], problems: ['The XML file declares a document type or entities, which the studio does not read. Export it again without them.'] };
  const root = /<xliff\b[^>]*>/i.exec(xml)?.[0] ?? '';
  const trg = attr(root, 'trgLang') ?? attr(/<file\b[^>]*>/i.exec(xml)?.[0] ?? '', 'target-language');
  const src = attr(root, 'srcLang') ?? attr(/<file\b[^>]*>/i.exec(xml)?.[0] ?? '', 'source-language');
  if (src && src !== SOURCE_LANGUAGE) problems.push(`The file’s source language is ${src}; the studio’s is ${SOURCE_LANGUAGE}. The source texts are read as English.`);
  const rows: string[][] = [];
  let inline = 0;
  // XLIFF 2.0 units (the studio's own), and XLIFF 1.2 trans-units for good measure.
  const unitRe = /<(unit|trans-unit)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const m of xml.matchAll(unitRe)) {
    const tag = `<${m[1]}${m[2]}>`;
    const id = attr(tag, 'name') ?? attr(tag, 'resname') ?? attr(tag, 'id') ?? '';
    const source = /<source\b[^>]*>([\s\S]*?)<\/source>/.exec(m[3]);
    const target = /<target\b[^>]*>([\s\S]*?)<\/target>/.exec(m[3]);
    const s = source ? unXml(source[1]) : { text: '', inline: false };
    const t = target ? unXml(target[1]) : { text: '', inline: false };
    if (s.inline || t.inline) inline++;
    rows.push([id, s.text, t.text]);
    if (rows.length > WORDING_IMPORT_MAX_ROWS) break;
  }
  if (!rows.length) problems.push('No texts were found in the XLIFF file.');
  if (inline) problems.push(`${inline} text${inline === 1 ? '' : 's'} had inline markup, which was removed.`);
  const locale = trg && isSupportedLanguage(trg) ? trg : null;
  if (!locale) problems.push(trg ? `The file’s target language ${trg} is not one the studio supports.` : 'The file does not say its target language.');
  return {
    kind: 'xliff',
    columns: [
      { index: 0, heading: 'unit name', role: 'id', why: 'The studio’s text id (unit name).' },
      { index: 1, heading: 'source', role: 'english', why: 'The English source text.' },
      { index: 2, heading: trg ? `target (${trg})` : 'target', role: locale ? 'language' : 'ignore', ...(locale ? { locale } : {}), why: locale ? `The ${languageName(locale)} translation.` : 'No supported target language.' },
    ],
    rows: rows.slice(0, WORDING_IMPORT_MAX_ROWS),
    problems,
  };
}

const ID_HEADS = new Set(['partid', 'part id', 'id', 'text id', 'textid', 'string id', 'key', 'identifier', 'message id', 'messageid', 'unit', 'resname', 'name']);
const EN_HEADS = new Set(['en-us', 'en_us', 'en', 'english', 'english (us)', 'english (united states)', 'source', 'source text', 'en-gb', 'text']);
const TITLE_HEADS = new Set(['title', 'heading', 'label', 'description', 'name of text']);

/** The language a column heading names (a code, `es_US`, a name, a short name or the language's own name), preferring the document's own languages. */
export function headingLocale(heading: string, prefer: readonly string[] = []): string | null {
  const h = heading.replace(/^﻿/, '').trim();
  if (!h) return null;
  const code = h.replace('_', '-');
  const exact = AVAILABLE_LANGUAGES.find((l) => l.code.toLowerCase() === code.toLowerCase());
  if (exact) return exact.code;
  const low = h.toLowerCase();
  const hits = AVAILABLE_LANGUAGES.filter((l) => l.name.toLowerCase() === low || l.endonym.toLowerCase() === low || languageShortName(l.code).toLowerCase() === low || l.code.split('-')[0].toLowerCase() === low);
  if (!hits.length) return null;
  // The document's own languages first, then the plain form ("French (France)" before "Canadian French").
  const rank = (l: { code: string; name: string }) => (prefer.includes(l.code) ? 0 : l.name.toLowerCase() === low ? 1 : l.name.toLowerCase().startsWith(`${low} (`) ? 2 : 3);
  return [...hits].sort((a, b) => rank(a) - rank(b))[0].code;
}

function readCsv(text: string, project: Project): WordingTable {
  const all = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  if (!all.length) return { kind: 'plain-csv', columns: [], rows: [], problems: ['The file is empty.'] };
  const head = all[0].map((h) => h.replace(/^﻿/, '').trim());
  const low = head.map((h) => h.toLowerCase());
  const has = (...hs: string[]) => hs.every((x) => low.includes(x.toLowerCase()));
  const kind: WordingFileKind = has('partId', 'title', 'mandatory', 'status', SOURCE_LANGUAGE) ? 'studio-csv'
    : has('id', 'kind', 'title', 'mandatory', 'status', 'sourceChanged', SOURCE_LANGUAGE) ? 'package-csv'
      : has('id', 'kind', 'title', 'mandatory', SOURCE_LANGUAGE) && head.length === 5 ? 'source-csv' : 'plain-csv';
  const langs = projectLanguages(project);
  let idSeen = false, enSeen = false, titleSeen = false;
  const columns: WordingColumn[] = head.map((h, index) => {
    const l = h.toLowerCase();
    if (!idSeen && ID_HEADS.has(l)) { idSeen = true; return { index, heading: h, role: 'id', why: 'Read as the text id.' }; }
    if (!enSeen && EN_HEADS.has(l)) { enSeen = true; return { index, heading: h, role: 'english', why: 'Read as the English text.' }; }
    if (!titleSeen && TITLE_HEADS.has(l)) { titleSeen = true; return { index, heading: h, role: 'title', why: 'Read as a title (used only for new messages).' }; }
    const locale = headingLocale(h, langs);
    if (locale === SOURCE_LANGUAGE && !enSeen) { enSeen = true; return { index, heading: h, role: 'english', why: 'Read as the English text.' }; }
    if (locale && locale !== SOURCE_LANGUAGE) return { index, heading: h, role: 'language', locale, why: `Read as ${languageName(locale)}.` };
    return { index, heading: h, role: 'ignore', why: kind === 'plain-csv' ? 'Not recognised: ignored unless you choose what it is.' : 'Information only (not imported).' };
  });
  const problems: string[] = [];
  const rows = all.slice(1);
  if (rows.length > WORDING_IMPORT_MAX_ROWS) problems.push(`Only the first ${WORDING_IMPORT_MAX_ROWS.toLocaleString('en-US')} rows are read.`);
  if (!columns.some((c) => c.role === 'id' || c.role === 'english')) problems.push('No column was recognised as the text id or the English text. Choose one below.');
  if (!columns.some((c) => c.role === 'language') && !columns.some((c) => c.role === 'english')) problems.push('No language column was recognised. Choose one below.');
  return { kind, columns, rows: rows.slice(0, WORDING_IMPORT_MAX_ROWS), problems };
}

/** Reads a wording file (XLIFF or CSV). Never throws; problems are listed. */
export function readWordingFile(text: string, project: Project): WordingTable {
  if (text.length > WORDING_IMPORT_MAX_BYTES) return { kind: 'plain-csv', columns: [], rows: [], problems: ['The file is larger than 5 MB.'] };
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('<')) return /<xliff\b/i.test(t) ? readXliff(t) : { kind: 'xliff', columns: [], rows: [], problems: ['The XML file is not an XLIFF file.'] };
  return readCsv(t, project);
}

/* ------------------------------------------------------------------ matching rows to texts */

interface Text { id: string; title: string; english: string; kind: 'part' | 'string'; part?: ContentPart; fixed?: boolean; channel?: boolean }

function textsOf(project: Project): Text[] {
  const out: Text[] = project.contentParts.map((p) => ({ id: p.id, title: p.title, english: p.approvedLocales[SOURCE_LANGUAGE] ?? '', kind: 'part' as const, part: p }));
  for (const s of translatableStrings(project)) out.push({ id: s.id, title: s.title, english: s.source, kind: 'string', ...(s.kind === 'system' ? { fixed: true } : {}), ...(s.kind === 'channel' ? { channel: true } : {}) });
  return out;
}

const normal = (s: string): string => s.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\{\{\s*([\w.]+)\s*\}\}/g, '{{$1}}')
  .toLowerCase().replace(/[^\p{L}\p{N}{}.]+/gu, ' ').replace(/(^|\s)\.+|\.+(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string): string[] => normal(s).split(' ').filter((w) => w.length > 0);
function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const rest = [...b];
  let shared = 0;
  for (const w of a) { const i = rest.indexOf(w); if (i >= 0) { rest.splice(i, 1); shared++; } }
  return (2 * shared) / (a.length + b.length);
}

export type MatchHow = 'id' | 'exact' | 'likely' | 'guess';
export interface WordingMatch { ids: string[]; title: string; how: MatchHow; reason: string }

/** Finds the texts a row is about: by id first, then by its English text (exact, likely, guess). */
export function matchWordingRow(texts: readonly Text[], id: string, english: string): WordingMatch | null {
  const byId = id ? texts.find((t) => t.id === id) : undefined;
  if (byId) return { ids: [byId.id], title: byId.title, how: 'id', reason: `Same id as “${byId.title}”.` };
  const en = english.trim();
  if (!en) return null;
  const exact = texts.filter((t) => t.english === en);
  if (exact.length) return { ids: exact.map((t) => t.id), title: exact[0].title, how: 'exact', reason: exact.length === 1 ? `The same English as “${exact[0].title}”.` : `The same English as ${exact.length} texts, starting with “${exact[0].title}”: all of them get it.` };
  const n = normal(en);
  const likely = n ? texts.filter((t) => t.english && normal(t.english) === n) : [];
  if (likely.length) return { ids: likely.map((t) => t.id), title: likely[0].title, how: 'likely', reason: `The same English as “${likely[0].title}” once case, spacing and punctuation are set aside.` };
  const w = words(en);
  if (w.length < 3) return null;
  const scored = texts.filter((t) => t.english).map((t) => ({ t, s: dice(w, words(t.english)) })).filter((x) => x.s >= 0.75).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored.length > 1 && scored[0].s - scored[1].s < 0.03)) return null;
  return { ids: [scored[0].t.id], title: scored[0].t.title, how: 'guess', reason: `A guess: the English is close to “${scored[0].t.title}” (${Math.round(scored[0].s * 100)}% of the words in common). Check it.` };
}

/* ------------------------------------------------------------------ the plan (dry run) */

/** What to do with one row: take its match (a guess must be accepted), skip it, or make it a new message or an alternative of a message. */
export type RowDecision = { kind: 'accept' } | { kind: 'skip' } | { kind: 'new-message' } | { kind: 'alternative'; nodeId: string };

export interface WordingImportOptions {
  /** The columns as the person confirmed them (default: as read). */
  columns?: WordingColumn[];
  /** Per row (0-based index into the table's rows): the person's decision. Default: accept id, exact and likely matches; skip the rest. */
  decisions?: Record<number, RowDecision>;
  /** Change the English of messages matched by id when the file's English differs (default true). */
  applyEnglish?: boolean;
  /** Add a draft beside an approved translation the file changes (default false: listed as skipped). */
  draftOverApproved?: boolean;
}

export interface PlannedChange { kind: 'draft' | 'english' | 'new-message' | 'alternative' | 'language'; id: string; title: string; locale?: string; from: string | null; to: string }
export interface PlanRow {
  /** 0-based index into the table's rows; `line` is the line in the file (CSV: header is line 1). */
  index: number;
  line: number;
  id: string;
  english: string;
  match: WordingMatch | null;
  decision: RowDecision['kind'] | 'unmatched';
  changes: PlannedChange[];
  skipped: Array<{ locale?: string; reason: string }>;
  unchanged: number;
  /** Placeholder and other problems, per row. */
  problems: string[];
}
export interface WordingPlan {
  rows: PlanRow[];
  languages: Array<{ locale: string; name: string; added: boolean; drafts: number }>;
  counts: { rows: number; drafts: number; english: number; newMessages: number; alternatives: number; languagesAdded: number; skipped: number; unchanged: number; unmatched: number; problems: number };
  /** The change as ONE command (a batch when it has several steps), or null when there is nothing to change. */
  command: Command | null;
  label: string;
  /** Problems that stop the whole import (empty = it can be applied). */
  blocking: string[];
}

const slugId = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const firstWords = (s: string, n = 6): string => { const w = s.replace(/\{\{[^}]*\}\}/g, '').replace(/[#*_[\]()]/g, ' ').trim().split(/\s+/).slice(0, n).join(' '); return w.length > 60 ? `${w.slice(0, 59)}…` : w || 'Imported message'; };

/** Placeholder problems of a text: data tokens that are not fields of the document, and a different set from the English. */
function placeholderProblems(project: Project, text: string, english: string | null, fields: Map<string, unknown>, channel: boolean, what: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) if (!fields.has(m[1]) && !(channel && (CHANNEL_TOKENS as readonly string[]).includes(m[1]))) out.push(`${what} uses {{${m[1]}}}, which is not a data field of this document.`);
  if (english !== null) {
    const c = checkTokens(english, text);
    if (!c.ok) out.push(`${what} does not use the same placeholders as the English${c.missing.length ? ` (missing ${c.missing.map((t) => (t.startsWith('{') ? t : `{{${t}}}`)).join(', ')})` : ''}${c.extra.length ? ` (extra ${c.extra.map((t) => (t.startsWith('{') ? t : `{{${t}}}`)).join(', ')})` : ''}. It can be fixed before it is approved.`);
  }
  if (/<\s*\/?\s*[a-z]/i.test(text)) out.push(`${what} contains HTML, which the studio does not allow.`);
  return [...new Set(out)];
}

export function planWordingImport(project: Project, table: WordingTable, opts: WordingImportOptions = {}): WordingPlan {
  const columns = opts.columns ?? table.columns;
  const idCol = columns.find((c) => c.role === 'id');
  const enCol = columns.find((c) => c.role === 'english');
  const titleCol = columns.find((c) => c.role === 'title');
  const langCols = columns.filter((c) => c.role === 'language' && c.locale && c.locale !== SOURCE_LANGUAGE && isSupportedLanguage(c.locale));
  const blocking: string[] = [];
  if (!idCol && !enCol) blocking.push('Choose which column holds the text id or the English text.');
  const dupLocales = langCols.map((c) => c.locale!).filter((l, i, a) => a.indexOf(l) !== i);
  if (dupLocales.length) blocking.push(`Two columns are read as ${languageName(dupLocales[0])}. Choose one.`);
  const applyEnglish = opts.applyEnglish ?? true;
  const texts = textsOf(project);
  const byId = new Map(texts.map((t) => [t.id, t]));
  const lib = project.libraryLinks?.length ? libraryOwnership(project) : null;
  const fields = projectFieldIndex(project) as Map<string, unknown>;
  const existingLangs = projectLanguages(project);
  const protectedPart = (p: ContentPart) => p.type === 'disclosure' || project.nodes.some((n) => n.type === 'disclosure' && n.contentPartId === p.id && n.protected);
  const draftOf = (t: Text, locale: string): string | undefined => (t.kind === 'part' ? t.part!.draftLocales?.[locale] : project.strings?.[t.id]?.draft?.[locale]);
  const approvedOf = (t: Text, locale: string): string | undefined => (t.kind === 'part' ? t.part!.approvedLocales[locale] : project.strings?.[t.id]?.approved?.[locale]);
  const variantSets = new Map(project.nodes.filter((n) => n.type === 'variant-set' || n.type === 'conditional-region').map((n) => [n.id, n]));

  const usedNodeIds = new Set(project.nodes.map((n) => n.id));
  const usedPartIds = new Set(project.contentParts.map((p) => p.id));
  const freshId = (base: string, taken: Set<string>[]): string => {
    const b = (slugId(base) || 'imported').replace(/^[^a-z0-9]+/, '');
    let id = `msg-${b}`.slice(0, 48).replace(/-+$/, '');
    for (let n = 2; taken.some((t) => t.has(id) || t.has(`${id}-default`)); n++) id = `msg-${b}`.slice(0, 44).replace(/-+$/, '') + `-${n}`;
    taken.forEach((t) => t.add(id));
    return id;
  };

  const drafts = new Map<string, Map<string, string>>(); // locale → id → text
  const englishCmds: Command[] = [];
  const structural: Command[] = [];
  const claimed = new Map<string, number>(); // `${locale}|${id}` → row that set it
  const rows: PlanRow[] = [];
  const lineOffset = table.kind === 'xliff' ? 0 : 2;

  table.rows.forEach((cells, index) => {
    const get = (c: WordingColumn | undefined) => (c ? (cells[c.index] ?? '') : '');
    const id = get(idCol).trim();
    const english = get(enCol);
    const row: PlanRow = { index, line: table.kind === 'xliff' ? index + 1 : index + lineOffset, id, english, match: null, decision: 'unmatched', changes: [], skipped: [], unchanged: 0, problems: [] };
    rows.push(row);
    if (!id && !english.trim()) { row.decision = 'skip'; row.skipped.push({ reason: 'The row has no id and no English text.' }); return; }
    row.match = matchWordingRow(texts, id, english);
    const chosen = opts.decisions?.[index];
    const defaultDecision: PlanRow['decision'] = row.match && row.match.how !== 'guess' ? 'accept' : row.match ? 'unmatched' : 'unmatched';
    row.decision = chosen ? chosen.kind : defaultDecision;
    if (row.decision === 'accept' && !row.match) row.decision = 'unmatched';
    if (row.decision === 'unmatched' || row.decision === 'skip') {
      if (row.decision === 'unmatched') row.skipped.push({ reason: row.match ? 'Only a guess: accept it to use it.' : id ? `No text has the id “${id}” or this English.` : 'No text has this English.' });
      return;
    }
    const translationsOfRow = langCols.map((c) => ({ locale: c.locale!, text: cells[c.index] ?? '' })).filter((x) => x.text.trim());
    for (const x of translationsOfRow) if (x.text.length > TRANSLATION_MAX_CHARS) row.problems.push(`The ${languageShortName(x.locale)} text is longer than ${TRANSLATION_MAX_CHARS.toLocaleString('en-US')} characters and is left out.`);
    const usable = translationsOfRow.filter((x) => x.text.length <= TRANSLATION_MAX_CHARS);

    if (row.decision === 'new-message' || row.decision === 'alternative') {
      if (!english.trim()) { row.skipped.push({ reason: 'A new message needs its English text.' }); row.decision = 'skip'; return; }
      const enProblems = placeholderProblems(project, english, null, fields, false, 'The English');
      if (enProblems.length) { row.problems.push(...enProblems); row.skipped.push({ reason: 'The English text has problems, so no message was made from it.' }); row.decision = 'skip'; return; }
      const title = (get(titleCol).trim() || (id && !id.startsWith('@') ? id : '') || firstWords(english)).slice(0, 80);
      let partId: string;
      if (row.decision === 'new-message') {
        const nodeId = freshId(id || english, [usedNodeIds, usedPartIds]);
        partId = `${nodeId}-default`;
        usedPartIds.add(partId);
        const node: DocNode = { id: nodeId, type: 'variant-set', name: title, layout: { paged: { mode: 'flow', widthPct: 100, align: 'left', spaceBeforePt: 8 }, html: { area: 'main', span: 12 } }, policy: 'exclusive', variantIds: [partId], fallbackVariantId: partId };
        structural.push({ type: 'INSERT_NODE', node, parentId: project.rootNodeId });
        structural.push({ type: 'UPSERT_CONTENT_PART', part: { id: partId, version: 1, title, approvedLocales: { [SOURCE_LANGUAGE]: english }, syntheticDemoOnly: false, type: 'text' } });
        row.changes.push({ kind: 'new-message', id: nodeId, title, from: null, to: english });
      } else {
        const target = variantSets.get((chosen as { nodeId: string }).nodeId);
        if (!target) { row.skipped.push({ reason: 'Choose the message this text is an alternative of.' }); row.decision = 'skip'; return; }
        if (lib?.nodes.has(target.id)) { row.skipped.push({ reason: `“${target.name ?? target.id}” comes from the library: add alternatives there.` }); row.decision = 'skip'; return; }
        partId = freshId(`${target.id}-${id || firstWords(english, 4)}`, [usedNodeIds, usedPartIds]);
        structural.push({ type: 'ADD_VARIANT', nodeId: target.id, variantId: partId, title, text: english });
        row.changes.push({ kind: 'alternative', id: partId, title: `${title} (alternative of “${target.name ?? target.id}”)`, from: null, to: english });
      }
      for (const x of usable) {
        row.problems.push(...placeholderProblems(project, x.text, english, fields, false, `The ${languageShortName(x.locale)} text`));
        (drafts.get(x.locale) ?? drafts.set(x.locale, new Map()).get(x.locale)!).set(partId, x.text);
        row.changes.push({ kind: 'draft', id: partId, title, locale: x.locale, from: null, to: x.text });
      }
      return;
    }

    // accept: the matched texts get the row's translations (and, matched by id, its English).
    for (const tid of row.match!.ids) {
      const t = byId.get(tid)!;
      const linked = lib?.textOf(t.id);
      let source = t.english;
      if (row.match!.how === 'id' && enCol && english.trim() && english !== t.english) {
        const why = linked ? `It comes from the library item “${linked.title}”: change it there.`
          : t.fixed ? 'It is fixed wording the outputs add; its English cannot be changed.'
            : t.kind === 'string' ? 'Its English is edited where it is placed (Layout, Email & SMS); an import changes translations only.'
              : protectedPart(t.part!) ? 'It is approved disclosure text: change it with “New approved version” and a reason.'
                : !applyEnglish ? 'Changing English texts was turned off for this import.' : null;
        const enProblems = why ? [] : placeholderProblems(project, english, null, fields, !!t.channel, 'The English');
        if (why) row.skipped.push({ reason: `English not changed: ${why}` });
        else if (enProblems.length) { row.problems.push(...enProblems); row.skipped.push({ reason: 'English not changed: the new English has problems.' }); }
        else {
          englishCmds.push({ type: 'UPSERT_CONTENT_PART', part: { ...t.part!, approvedLocales: { ...t.part!.approvedLocales, [SOURCE_LANGUAGE]: english } } });
          row.changes.push({ kind: 'english', id: t.id, title: t.title, from: t.english, to: english });
          source = english;
        }
      }
      for (const x of usable) {
        if (linked) { row.skipped.push({ locale: x.locale, reason: `It comes from the library item “${linked.title}”: its translations are changed there.` }); continue; }
        const approved = approvedOf(t, x.locale), draft = draftOf(t, x.locale);
        if (x.text === approved && !draft) { row.unchanged++; continue; }
        if (x.text === draft) { row.unchanged++; continue; }
        if (approved?.trim() && !opts.draftOverApproved) { row.skipped.push({ locale: x.locale, reason: `It has an approved ${languageShortName(x.locale)} translation, which an import never replaces. Turn on “Add changes to approved translations as drafts” to review it as a draft.` }); continue; }
        const key = `${x.locale}|${t.id}`;
        if (claimed.has(key)) { row.skipped.push({ locale: x.locale, reason: `Row ${rows[claimed.get(key)!].line} already gives this text a ${languageShortName(x.locale)} translation.` }); continue; }
        claimed.set(key, index);
        row.problems.push(...placeholderProblems(project, x.text, source, fields, !!t.channel, `The ${languageShortName(x.locale)} text${row.match!.ids.length > 1 ? ` for “${t.title}”` : ''}`));
        (drafts.get(x.locale) ?? drafts.set(x.locale, new Map()).get(x.locale)!).set(t.id, x.text);
        row.changes.push({ kind: 'draft', id: t.id, title: t.title, locale: x.locale, from: draft ?? null, to: x.text });
      }
    }
  });

  const languages = [...drafts.keys()].sort().map((locale) => ({ locale, name: languageName(locale), added: !existingLangs.includes(locale), drafts: drafts.get(locale)!.size }));
  const commands: Command[] = [
    ...languages.filter((l) => l.added).map((l): Command => ({ type: 'ADD_LANGUAGE', locale: l.locale })),
    ...englishCmds,
    ...structural,
    ...languages.map((l): Command => ({ type: 'SET_TRANSLATION_DRAFTS', locale: l.locale, origin: 'imported', items: [...drafts.get(l.locale)!].map(([id, text]) => ({ id, text })) })),
  ];
  if (commands.length > 200) blocking.push(`This import would make ${commands.length} separate changes; the limit for one step is 200. Split the file.`);
  const all = rows.flatMap((r) => r.changes);
  const counts = {
    rows: rows.length,
    drafts: all.filter((c) => c.kind === 'draft').length,
    english: all.filter((c) => c.kind === 'english').length,
    newMessages: all.filter((c) => c.kind === 'new-message').length,
    alternatives: all.filter((c) => c.kind === 'alternative').length,
    languagesAdded: languages.filter((l) => l.added).length,
    skipped: rows.reduce((n, r) => n + r.skipped.length, 0),
    unchanged: rows.reduce((n, r) => n + r.unchanged, 0),
    unmatched: rows.filter((r) => r.decision === 'unmatched').length,
    problems: rows.reduce((n, r) => n + r.problems.length, 0),
  };
  const parts = [counts.drafts ? `${counts.drafts} draft${counts.drafts === 1 ? '' : 's'}` : '', counts.english ? `${counts.english} English change${counts.english === 1 ? '' : 's'}` : '', counts.newMessages ? `${counts.newMessages} new message${counts.newMessages === 1 ? '' : 's'}` : '', counts.alternatives ? `${counts.alternatives} new alternative${counts.alternatives === 1 ? '' : 's'}` : ''].filter(Boolean);
  const label = `Import wording: ${parts.join(', ') || 'no changes'}`;
  return { rows, languages, counts, command: !commands.length || blocking.length ? null : commands.length === 1 ? commands[0] : { type: 'BATCH', label, commands }, label, blocking };
}

/** Every text of the document a row can be matched to (for the screen's "match it to…" picker). */
export function wordingTargets(project: Project): Array<{ id: string; title: string; english: string }> {
  return textsOf(project).map((t) => ({ id: t.id, title: t.title, english: t.english }));
}

/** The document's messages a new alternative can be added to. */
export function messageSections(project: Project): Array<{ id: string; name: string }> {
  return project.nodes.filter((n) => n.type === 'variant-set' || n.type === 'conditional-region').map((n) => ({ id: n.id, name: n.name ?? n.id }));
}

/** Data tokens of a text (for screens that show them). */
export const placeholdersOf = (text: string): string[] => tokensOfText(text);
