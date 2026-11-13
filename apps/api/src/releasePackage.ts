import { createHash } from 'node:crypto';
import {
  DERIVED_FIELDS_VERSION, DOCUMENT_TYPE_LABEL, RECORD_ID_PREFIX, SOURCE_LANGUAGE, addDaysToIso, buildContext, dateBoundaries, dayWords, defaultFormatterFor, digestOf, evaluateCalculations, exprDependencies,
  formulaInWords, getPath, languageName, lookupTableProblems, printFormula, projectFieldIndex, wordsScopeOf,
  projectContentDigest, projectFields, projectFileContentOf, projectLanguages, releaseId, releasePackageName, tokensIn, tokensInText, translatableStrings, translationStatus,
  type DocNode, type FieldDef, type Predicate, type Project, type ReleasePackageSummary, type SyntheticRecord, type TestCase,
} from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { indexTree, predicatePaths, resolve, type Resolution } from '@iss/resolver';
import { BRAND_FONTS, DOC_FONT, SCREEN_FONT, checkChannelParity, compareManifests, imageSrc, renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms, type ExtractedManifest } from '@iss/renderers';
import { baselineCustomer, documentDateBoundaries, documentTimeline, planTestData, runTestCase } from '@iss/scenarios';
import type { Composer } from './composer';
import type { PinnedCustomerRef, StoredRelease } from './db';
import { ZIP_FIXED_DATE, zipFiles } from './zip';

/**
 * The release package: one ZIP per release, the contract between the studio and whatever produces the documents.
 * The format is described file by file in docs/design/RELEASE_PACKAGE.md; change that document with this code.
 *
 * Rules this builder keeps:
 *  - It is a function of the release alone (its frozen project and what was recorded when it was created). It reads
 *    nothing else from the studio, so the same release gives the same package whenever it is built.
 *  - No file states when it was built. The one output that is not naturally repeatable, the PDF, is normalised
 *    (see `normalisePdf`).
 *  - Only synthetic customers: the built-in sample customers and customers the engine generates from them or from the
 *    document's own field definitions. Never an imported, supplied or edited customer.
 *  - Approved wording only. An unapproved translation is left out and listed as missing.
 *  - It gives the event loop back between steps, so other requests are never held up for longer than one composition.
 */

export const PACKAGE_FORMAT = 'iss-release-package';
/** Raised when a reader of the previous version could misread the package; additions that old readers can ignore do not raise it. */
export const PACKAGE_FORMAT_VERSION = 1;
export const SCENARIO_CAP = 24;
export const REFERENCE_CAP = 8;

/* ------------------------------------------------------------------ composition (replaceable in tests) */

/** The two things that need a browser. Tests replace this to stay fast. */
export interface PackageComposer {
  /** The PDF of a paged document, its page count and the facts read back from its pages. */
  pdf(html: string): Promise<{ pdf: Buffer; pageCount: number; facts: ExtractedManifest | null }>;
  /** The facts read back from the interactive web page. */
  html(html: string): Promise<{ facts: ExtractedManifest | null }>;
}

const withoutText = (m: ExtractedManifest): ExtractedManifest => { const { text: _text, ...rest } = m; return rest; };

/** The studio's own page composer (headless Chromium), as every other export uses it. */
export function chromiumPackageComposer(composer: Composer): PackageComposer {
  return {
    async pdf(html) { const c = await composer.composePaged(html, { pdf: true }); return { pdf: c.pdf!, pageCount: c.metrics.pageCount, facts: withoutText(c.extracted) }; },
    async html(html) { const h = await composer.inspectHtml(html); return { facts: withoutText(h.extracted) }; },
  };
}

/**
 * Makes a composed PDF repeatable without changing what it shows. Two things differ between two compositions of the
 * same document: the creation and modification dates, and the ids the browser gives the accessibility-structure
 * elements. The dates are set to the release's approval time and the structure ids are renumbered in their existing
 * order. Both replacements keep every byte offset, so the file stays valid.
 */
export function normalisePdf(pdf: Buffer, approvedAt: string): Buffer {
  const stamp = approvedAt.replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
  let s = pdf.toString('latin1');
  s = s.replace(/\/(CreationDate|ModDate) \(D:\d{14}([^)]*)\)/g, (_m, key: string, zone: string) => `/${key} (D:${stamp}${/^[+-]\d\d'\d\d'$/.test(zone) ? "+00'00'" : zone})`);
  const ids = [...new Set(s.match(/\(node\d{8}\)/g) ?? [])].sort();
  const renumbered = new Map(ids.map((id, i) => [id, `(node${String(i + 1).padStart(8, '0')})`]));
  s = s.replace(/\(node\d{8}\)/g, (m) => renumbered.get(m) ?? m);
  return Buffer.from(s, 'latin1');
}

const pdfProducer = (pdf: Buffer): string | null => /\/Producer \(([^)]{1,80})\)/.exec(pdf.toString('latin1'))?.[1] ?? null;
const pdfFonts = (pdf: Buffer): string[] => [...new Set([...pdf.toString('latin1').matchAll(/\/BaseFont \/(?:[A-Z]{6}\+)?([A-Za-z0-9_-]{1,80})/g)].map((m) => m[1]))].sort();

/* ------------------------------------------------------------------ small helpers */

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// eslint-disable-next-line no-control-regex
const xmlSafe = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
const escXml = (s: unknown): string => xmlSafe(String(s ?? '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csvCell = (v: unknown): string => { const t = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const csv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const nodeNameOf = (project: Project) => { const m = new Map(project.nodes.map((n) => [n.id, n])); return (id: string): string => { const n = m.get(id); return n?.name ?? n?.label ?? id; }; };
const customerName = (r: Pick<SyntheticRecord, 'customer'>): string => `${r.customer.givenName} ${r.customer.familyName}`.trim();
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * What identifies a customer's data, whatever id the studio stored it under. Used to prove that a pinned test's
 * generated customer is one the engine reproduces from synthetic data alone.
 */
export function customerDigest(record: Omit<SyntheticRecord, 'recordId'> | SyntheticRecord): string {
  const { recordId: _id, projectId: _p, generated: _g, ...data } = record as SyntheticRecord;
  return digestOf(data);
}

/* ------------------------------------------------------------------ the template */

/**
 * `template.json`: the approved version as a studio project file. It keeps the document's id, title and version
 * number, and leaves out two things: the bookkeeping of the one document it was (when it was saved, what it was
 * copied, started or imported from) and every unapproved translation draft. A release carries approved wording only,
 * and drafts never change what the engine produces.
 */
export function releaseTemplate(frozen: Project): Project {
  const t = projectFileContentOf(frozen) as Project & Record<string, unknown>;
  t.contentParts = t.contentParts.map((c) => { const { draftLocales: _drafts, ...rest } = c; return rest; });
  if (t.strings) {
    const strings: NonNullable<Project['strings']> = {};
    for (const [id, s] of Object.entries(t.strings)) {
      const { draft: _draft, ...rest } = s;
      if (Object.keys(rest.approved ?? {}).length) strings[id] = rest;
    }
    if (Object.keys(strings).length) t.strings = strings; else delete t.strings;
  }
  // Only ever describes drafts (who produced one that nobody has edited or approved yet).
  delete t.translationOrigins;
  return t;
}

/* ------------------------------------------------------------------ wording */

export interface WordingRow { id: string; kind: 'message' | 'label' | 'email-sms' | 'fixed'; title: string; mandatory: boolean; source: string; target: string | null; status: 'approved' | 'missing'; sourceChanged: boolean }

/** Every customer-visible text with its approved translation for `locale` (never a draft). */
export function wordingRows(project: Project, locale: string): WordingRow[] {
  return translationStatus(project, locale).rows.map((r) => {
    const approved = r.status.status === 'approved' && !!r.status.approvedText?.trim();
    return {
      id: r.partId, kind: r.kind === 'part' ? 'message' : r.fixed ? 'fixed' : r.group === 'channels' ? 'email-sms' : 'label',
      title: r.title, mandatory: r.status.mandatory, source: r.sourceText, target: approved ? r.status.approvedText! : null, status: approved ? 'approved' : 'missing', sourceChanged: !!r.sourceChanged,
    };
  });
}

/** XLIFF 2.0: one unit per text; `name` carries the studio's text id; a text without an approved translation has no target. */
export function wordingXliff(rows: WordingRow[], locale: string, about: string): string {
  const units = rows.map((r, i) => [
    `    <unit id="u${i + 1}" name="${escXml(r.id)}">`,
    '      <notes>',
    `        <note category="title">${escXml(r.title)}</note>`,
    `        <note category="kind">${r.kind}</note>`,
    ...(r.mandatory ? ['        <note category="mandatory">A document that needs this text cannot be produced in this language without it.</note>'] : []),
    ...(r.sourceChanged ? ['        <note category="warning">The English text changed after this translation was approved.</note>'] : []),
    '      </notes>',
    `      <segment state="${r.target === null ? 'initial' : 'final'}">`,
    `        <source>${escXml(r.source)}</source>`,
    ...(r.target === null ? [] : [`        <target>${escXml(r.target)}</target>`]),
    '      </segment>',
    '    </unit>',
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${SOURCE_LANGUAGE}" trgLang="${escXml(locale)}">`,
    '  <file id="wording" original="template.json" xml:space="preserve">',
    '    <notes>',
    `      <note category="release">${escXml(about)}</note>`,
    '      <note category="rule">Targets are approved translations only. A unit without a target has no approved translation: the English text is shown. Data tokens such as {{card.dueDate}} and placeholders such as {page} must stay exactly as they are.</note>',
    '    </notes>',
    ...units,
    '  </file>',
    '</xliff>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ data dictionary */

/** What each calculated field of the built-in kinds is worked out from (see `buildContext`); a row count comes from its list. */
const CALCULATED_FROM: Record<string, string[]> = {
  'card.availableCreditCents': ['card.creditLimitCents', 'card.newBalanceCents'],
  'card.transactionsTotalCents': ['card.transactions'],
};

const FORMAT_OF: Record<FieldDef['type'], string> = {
  string: 'Text',
  cents: 'Whole number of cents (integer, never a decimal amount)',
  date: 'ISO 8601 date, YYYY-MM-DD',
  int: 'Whole number',
  bool: 'true or false',
  enum: 'One of the allowed values',
  array: 'List of rows',
  points: 'Whole number of points',
  number: 'Number (may have decimals; calculated fields only)',
};

interface FieldUse { rules: Map<string, string>; conditions: Set<string>; bindings: Set<string>; tokens: Set<string>; journey: Set<string>; columns: Set<string> }

/** Where every data field is read: rule conditions, conditions on components, bindings, text tokens and journey steps. */
function fieldUsage(project: Project): { used: Map<string, FieldUse>; unknown: Array<{ path: string; where: string }> } {
  const known = new Set(projectFields(project).map((f) => f.path));
  const used = new Map<string, FieldUse>();
  const unknown: Array<{ path: string; where: string }> = [];
  const at = (path: string, where: string): FieldUse | null => {
    if (!known.has(path)) { if (!unknown.some((u) => u.path === path && u.where === where)) unknown.push({ path, where }); return null; }
    let u = used.get(path);
    if (!u) { u = { rules: new Map(), conditions: new Set(), bindings: new Set(), tokens: new Set(), journey: new Set(), columns: new Set() }; used.set(path, u); }
    return u;
  };
  const called = (n: DocNode): string => n.name ?? n.label ?? n.id;
  const condition = (p: Predicate | undefined, where: string) => { for (const path of predicatePaths(p)) at(path, where)?.conditions.add(where); };
  for (const r of project.rules) for (const path of predicatePaths(r.when)) at(path, `rule ${r.id}`)?.rules.set(r.id, r.title ?? `Rule ${r.id}`);
  for (const n of project.nodes) {
    condition(n.visibleWhen, called(n));
    for (const p of Object.values(n.variantConditions ?? {})) condition(p, called(n));
    if (n.binding) {
      const u = at(n.binding, called(n));
      u?.bindings.add(called(n));
      for (const c of n.columns ?? []) u?.columns.add(c.key);
      for (const k of [n.chart?.groupBy, n.chart?.valueKey]) if (k) u?.columns.add(k);
    }
    for (const s of n.chart?.series ?? []) at(s.path, called(n))?.bindings.add(called(n));
    for (const path of tokensIn(n.content)) at(path, called(n))?.tokens.add(called(n));
    for (const text of [n.action?.url, n.qr?.url]) for (const path of tokensInText(text ?? '')) at(path, called(n))?.tokens.add(called(n));
  }
  // Every other text a customer reads (labels, table titles, email and SMS wording) and every message, in every approved language.
  const channelOnly = new Set(['issuer.name', 'issuer.product', 'keyFacts', 'link']);
  const byNode = new Map(project.nodes.map((n) => [n.id, called(n)]));
  for (const s of translatableStrings(project)) {
    const where = (s.nodeId && byNode.get(s.nodeId)) || s.title;
    for (const path of tokensInText(s.source)) if (!channelOnly.has(path)) at(path, where)?.tokens.add(where);
  }
  // Messages and notices the document actually uses (a project may carry others it never shows).
  const usedParts = new Set(translationStatus(project, SOURCE_LANGUAGE).rows.filter((r) => r.kind === 'part').map((r) => r.partId));
  for (const c of project.contentParts) if (usedParts.has(c.id)) for (const text of Object.values(c.approvedLocales)) for (const path of tokensInText(text ?? '')) at(path, c.title)?.tokens.add(c.title);
  for (const e of project.journey?.events ?? []) {
    const step = e.label ?? e.eventType;
    for (const x of e.effects ?? []) at(x.path, step)?.journey.add(step);
    for (const x of e.preconditions ?? []) at(x.path, step)?.journey.add(step);
  }
  return { used, unknown };
}

export function dataDictionary(project: Project) {
  const { used, unknown } = fieldUsage(project);
  const sample = buildContext({ ...baselineCustomer(project).record, recordId: `${RECORD_ID_PREFIX[project.documentType] ?? 'REC'}-0000` } as SyntheticRecord) as Record<string, unknown>;
  // The document's date and calculated values of the synthetic example customer (as issued on the first boundary, when the date is given for the run).
  const exampleDate = project.documentDate ? (project.documentDate.source === 'field' ? (getPath(sample, project.documentDate.path) as string | null) : dateBoundaries(project)[0]?.date ?? null) : null;
  if (project.documentDate) sample.document = { date: exampleDate };
  if (project.calculatedFields?.length) evaluateCalculations(project, sample, exampleDate);
  const fields = projectFields(project);
  const calcs = new Map((project.calculatedFields ?? []).map((c) => [`calc.${c.key}`, c]));
  const words = wordsScopeOf(project, projectFieldIndex(project));
  // A calculated field needs the fields it is calculated from (a row count needs its list; the document's date its source field).
  const sourcesOf = (f: FieldDef): string[] => {
    if (!f.derived) return [];
    const calc = calcs.get(f.path);
    if (calc) { const d = exprDependencies(calc.expr); return [...d.fields, ...d.lists, ...d.calcs.map((k) => `calc.${k}`), ...(d.usesIssueDate ? ['document.date'] : [])]; }
    if (f.documentDate) return project.documentDate?.source === 'field' ? [project.documentDate.path] : [];
    return CALCULATED_FROM[f.path] ?? (f.path.endsWith('.count') ? [f.path.slice(0, -'.count'.length)] : []);
  };
  const neededFor = new Map<string, string[]>();
  // Needed through a chain of calculations too (a calculation used by the template needs what its inputs need).
  const need = (f: FieldDef, seen = new Set<string>()) => { for (const src of sourcesOf(f)) { if (seen.has(src)) continue; seen.add(src); neededFor.set(src, [...new Set([...(neededFor.get(src) ?? []), f.path])]); const g = fields.find((x) => x.path === src); if (g?.derived) need(g, seen); } };
  for (const f of fields) if (used.has(f.path)) need(f);
  const out = fields.map((f) => {
    const u = used.get(f.path);
    const example = f.type === 'array' ? ((getPath(sample, f.path) as unknown[] | null) ?? []).slice(0, 1) : f.example ?? (getPath(sample, f.path) as unknown) ?? null;
    return {
      path: f.path, label: f.label, type: f.type, format: FORMAT_OF[f.type], formatter: defaultFormatterFor(f.type),
      required: !!f.required,
      /** Calculated by the engine from other fields; never supplied. */
      calculated: !!f.derived,
      ...(f.derived ? { calculatedFrom: sourcesOf(f) } : {}),
      // One of the template's own calculated fields: what it gives and how, as a formula and in plain words (studio English).
      ...(calcs.has(f.path) ? { calculation: { gives: calcs.get(f.path)!.type, formula: printFormula(calcs.get(f.path)!.expr, projectFieldIndex(project)), inWords: formulaInWords(calcs.get(f.path)!.expr, words), ...(calcs.get(f.path)!.description ? { description: calcs.get(f.path)!.description } : {}) } } : {}),
      ...(f.documentDate ? { documentDate: project.documentDate?.source === 'run' ? 'given for each run (--issue-date, or "issueDate" with a customer)' : `taken from ${project.documentDate?.source === 'field' ? project.documentDate.path : 'the data'}, unless a date is given for the run` } : {}),
      ...(f.enumValues?.length ? { allowedValues: f.enumValues } : {}),
      ...(f.itemFields?.length ? { columns: f.itemFields.map((c) => ({ key: c.key, label: c.label, type: c.type, format: FORMAT_OF[c.type], used: !!u?.columns.has(c.key) })) } : {}),
      example,
      /** The template reads it, the data contract requires it, or a calculated field the template reads is worked out from it. */
      needed: !!u || !!f.required || neededFor.has(f.path),
      usedIn: {
        rules: [...(u?.rules ?? [])].map(([id, title]) => ({ id, title })),
        conditions: [...(u?.conditions ?? [])],
        bindings: [...(u?.bindings ?? [])],
        tokens: [...(u?.tokens ?? [])],
        journey: [...(u?.journey ?? [])],
        ...(neededFor.has(f.path) ? { calculatedFields: neededFor.get(f.path)! } : {}),
      },
    };
  });
  return {
    formatVersion: 1,
    documentKind: project.documentType,
    calculatedFieldsVersion: DERIVED_FIELDS_VERSION,
    note: `Every field a customer record of this document may carry. "needed" marks the ones this template reads or the data contract requires. Amounts are integer cents; dates are ISO 8601. Examples are synthetic.${project.documentType === 'eob' ? ' Fields that start with "claim." describe the claim the document is about: the first row of "claims".' : ''}`,
    fields: out,
    /** Tokens in the wording that are not data fields of this document (none in a document that passed the studio's checks). */
    unknownReferences: unknown,
    // Additions for documents with calculations, lookup tables or dates (absent otherwise; older readers ignore them).
    ...(project.documentDate ? { documentDate: project.documentDate.source === 'run' ? { source: 'run', note: 'The document’s date is given for each run: --issue-date, or "issueDate" next to a customer’s "data". A document that needs it and has none is stopped.' } : { source: 'field', path: project.documentDate.path, note: 'The document’s date is taken from this field of each customer, unless a date is given for the run.' } } : {}),
    ...(project.lookupTables?.length ? { lookupTables: project.lookupTables.map((t) => ({
      id: t.id, title: t.title, ...(t.description ? { description: t.description } : {}),
      keys: t.keys, columns: t.columns, rows: t.rows, whenNoRowMatches: t.defaultRow ? { defaultRow: t.defaultRow } : 'the value is missing',
      problems: lookupTableProblems(t).map((x) => x.message),
      usedBy: (project.calculatedFields ?? []).filter((c) => exprDependencies(c.expr).tables.includes(t.id)).map((c) => `calc.${c.key}`),
    })) } : {}),
  };
}

/* ------------------------------------------------------------------ assets and fonts */

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

export function packageAssets(project: Project) {
  const accent = project.issuer?.accent ?? '#277656';
  const byPath = new Map<string, { path: string; data: Buffer; mime: string; builtIn: string | null; usedBy: Array<{ what: string; name: string }> }>();
  const add = (src: string | undefined, what: string, name: string) => {
    if (!src) return;
    const builtIn = src.startsWith('asset:') ? src.slice(6) : null;
    const uri = imageSrc(src, accent);
    const m = uri ? /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(uri) : null;
    if (!m || !EXT[m[1]]) return;
    const data = Buffer.from(m[2], 'base64');
    const path = `assets/${sha256(data)}.${EXT[m[1]]}`;
    const e = byPath.get(path) ?? { path, data, mime: m[1], builtIn, usedBy: [] };
    e.usedBy.push({ what, name });
    byPath.set(path, e);
  };
  for (const n of project.nodes) add(n.image?.src, 'component', n.name ?? n.id);
  add(project.brand?.logoDataUri, 'brand logo', project.issuer?.name ?? project.title);
  // Page backgrounds of the page design (both paged profiles carry the same design; the PDF one is read).
  const paged = project.presentationProfiles.find((p) => p.id === 'paged-pdf');
  for (const [id, name] of [['first', 'First page'], ['following', 'Following pages'], ['last', 'Last page']] as const) {
    const bg = paged?.pageTemplates?.[id]?.background;
    if (bg?.kind === 'image') add(bg.image, 'page background', name);
  }
  const assets = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const index = {
    formatVersion: 1,
    convention: 'template.json is self-sufficient: every image a person uploaded is stored inside it as a data URI. The same images are provided here as files, named by the SHA-256 of their bytes, so they can be loaded into an asset store. A built-in mark is referenced from template.json by name ("asset:<name>") and drawn by the engine in the issuer colour; it is provided here as the SVG the engine draws.',
    assets: assets.map((a) => ({ path: a.path, sha256: sha256(a.data), bytes: a.data.length, mime: a.mime, ...(a.builtIn ? { builtIn: a.builtIn, referencedAs: `asset:${a.builtIn}` } : {}), usedBy: a.usedBy })),
  };
  return { assets, index };
}

export function packageFonts(project: Project, referencePdfFonts: string[]) {
  const brand = project.brand?.fontFamily && BRAND_FONTS[project.brand.fontFamily] ? project.brand.fontFamily : null;
  const first = (stack: string) => stack.split(',')[0].trim().replace(/^"|"$/g, '');
  return {
    formatVersion: 1,
    note: 'Font files are not redistributed. Install or license the first family of each stack; the later families are the fallbacks the studio itself used when the first was not installed.',
    fonts: [
      { use: 'Printed document (PDF)', family: first(brand ? BRAND_FONTS[brand] : DOC_FONT), stack: brand ? BRAND_FONTS[brand] : DOC_FONT, chosenBy: brand ? 'brand kit' : 'default' },
      { use: 'Web page (HTML)', family: first(brand ? BRAND_FONTS[brand] : SCREEN_FONT), stack: brand ? BRAND_FONTS[brand] : SCREEN_FONT, chosenBy: brand ? 'brand kit' : 'default' },
      { use: 'Email', family: 'Arial', stack: 'Arial, Helvetica, sans-serif', chosenBy: 'default' },
    ],
    /** The fonts actually embedded in this package's reference PDFs, as composed on the studio's machine. */
    referencePdfFonts,
  };
}

/* ------------------------------------------------------------------ test scenarios */

interface Candidate {
  source: 'pinned-test' | 'generated';
  name: string;
  covers: string[];
  customer: { id: string; name: string; kind: 'sample' | 'generated'; why: string | null; record: SyntheticRecord };
  overrides: Record<string, unknown>;
  journeyCursor: number | null;
  test?: TestCase;
  /** The document's date the scenario is produced as issued on (given for the run). */
  issueDate?: string | null;
  /** A scenario on one side of a date boundary: the boundary day, and which side. */
  boundary?: { date: string; side: 'before' | 'on' };
}

export interface PlannedScenario extends Candidate { id: string; res: Resolution; keys: string[]; produced: boolean; reference: boolean }

const EXCLUDED_WHY: Record<'imported' | 'supplied' | 'missing' | 'not-reproduced' | 'unknown', string> = {
  imported: 'It uses an imported customer. Imported customers never leave the studio.',
  supplied: 'It uses a customer that was supplied for this document or edited by a person. Those never leave the studio.',
  missing: 'The customer it used no longer existed when the release was made.',
  'not-reproduced': 'It uses a generated customer that the engine could not reproduce from synthetic data alone, so it cannot be shown to be synthetic.',
  unknown: 'The release did not record which customer it used.',
};

/** What a scenario shows, as keys that can be counted: each message chosen, each optional section shown or hidden, each rule applied, the language. */
function outcomeKeys(project: Project, res: Resolution): string[] {
  const tree = indexTree(res.root);
  const keys: string[] = [`language:${res.locale}`];
  for (const [set, part] of Object.entries(res.result.selectedVariants)) keys.push(`message:${set}=${part ?? 'none'}`);
  for (const n of optionalSections(project)) keys.push(`section:${n.id}=${tree.get(n.id)?.visible ? 'shown' : 'hidden'}`);
  for (const id of res.result.matchedRuleIds) keys.push(`rule:${id}`);
  if (res.findings.some((f) => f.severity === 'blocking')) keys.push('blocked');
  return keys;
}

/** Sections a customer may or may not get: conditional regions, rule-driven sections and anything with its own condition. */
const optionalSections = (project: Project): DocNode[] => project.nodes.filter((n) => n.type === 'conditional-region' || n.ruleDriven || !!n.visibleWhen);

export interface ScenarioPlan {
  scenarios: PlannedScenario[];
  customers: Candidate['customer'][];
  excluded: Array<{ test: string; reason: string }>;
  omitted: string[];
  notReached: Array<{ outcome: string; reason: string }>;
  coverage: { outcomes: { total: number; reached: number } };
  cap: number;
  referenceCap: number;
  outcomesSeen: number;
  outcomesInReference: number;
}

/**
 * Chooses the scenarios of a release: its pinned tests first (those whose customer is synthetic), then one generated
 * customer per outcome the engine can reach (every rule, message version, optional section and language once), up to
 * `cap`. Then picks up to `referenceCap` of them for reference outputs, each time taking the scenario that shows the
 * most outcomes not shown yet.
 */
export async function planScenarios(project: Project, pinned: PinnedCustomerRef[], cap: number, referenceCap: number): Promise<ScenarioPlan> {
  const samples = RECORDS.filter((r) => r.documentType === project.documentType);
  const prefix = RECORD_ID_PREFIX[project.documentType] ?? 'REC';
  const plan = planTestData(project, samples, { outcomes: true, edges: false });
  await tick();

  // A pinned test on a generated customer is kept only when the engine, starting from synthetic data alone, generates that very customer again.
  const reproducible = new Map<string, Omit<SyntheticRecord, 'recordId'>>();
  if (pinned.some((p) => p.kind === 'generated')) {
    const full = planTestData(project, samples, { outcomes: true, edges: true });
    await tick();
    for (const c of [...plan.customers, ...full.customers, baselineCustomer(project)]) {
      const record = { ...c.record, documentType: project.documentType };
      reproducible.set(customerDigest(record), record);
    }
  }

  const candidates: Candidate[] = [];
  const excluded: ScenarioPlan['excluded'] = [];
  const refs = new Map(pinned.map((p) => [p.testId, p]));
  for (const test of project.testCases ?? []) {
    const ref = refs.get(test.id);
    const overrides = test.overrides ?? {};
    const journeyCursor = test.journeyCursor ?? null;
    const dated = test.issueDate && project.documentDate ? { issueDate: test.issueDate } : {};
    if (!ref || ref.recordId !== test.recordId) { excluded.push({ test: test.name, reason: EXCLUDED_WHY.unknown }); continue; }
    if (ref.kind === 'sample') {
      const record = samples.find((r) => r.recordId === ref.recordId);
      if (!record) { excluded.push({ test: test.name, reason: EXCLUDED_WHY.missing }); continue; }
      candidates.push({ source: 'pinned-test', name: test.name, covers: [], customer: { id: record.recordId, name: customerName(record), kind: 'sample', why: null, record }, overrides, journeyCursor, test, ...dated });
    } else if (ref.kind === 'generated') {
      const fresh = ref.digest ? reproducible.get(ref.digest) : undefined;
      if (!fresh) { excluded.push({ test: test.name, reason: EXCLUDED_WHY['not-reproduced'] }); continue; }
      const record = { recordId: ref.recordId, ...fresh } as SyntheticRecord;
      candidates.push({ source: 'pinned-test', name: test.name, covers: [], customer: { id: record.recordId, name: customerName(record), kind: 'generated', why: null, record }, overrides, journeyCursor, test, ...dated });
    } else excluded.push({ test: test.name, reason: EXCLUDED_WHY[ref.kind] });
  }
  const pinnedPlain = new Set(candidates.filter((c) => !Object.keys(c.overrides).length && c.journeyCursor === null).map((c) => `${c.issueDate ?? ''}|${customerDigest(c.customer.record)}`));
  const generated: Candidate[] = [];
  plan.customers.forEach((c, i) => {
    const record = { recordId: `${prefix}-9${String(i + 1).padStart(4, '0')}`, ...c.record, documentType: project.documentType } as SyntheticRecord;
    if (pinnedPlain.has(`${c.issueDate ?? ''}|${customerDigest(record)}`)) return;
    const covers = plan.targets.filter((t) => c.targets.includes(t.id)).map((t) => t.title);
    generated.push({ source: 'generated', name: c.label, covers, customer: { id: record.recordId, name: customerName(record), kind: 'generated', why: c.label, record }, overrides: {}, journeyCursor: null, ...(c.issueDate ? { issueDate: c.issueDate } : {}) });
  });
  // A document that changes on a date: one scenario on each side of every boundary (the day before, and the day itself),
  // for a customer the change reaches (the first customer when it reaches none of them), after the pinned tests.
  if (project.documentDate) {
    const pool = [...generated.map((g) => g.customer), ...samples.map((r) => ({ id: r.recordId, name: customerName(r), kind: 'sample' as const, why: null, record: r }))];
    const timeline = documentTimeline(project, pool.map((c) => c.record));
    for (const b of timeline) {
      const who = pool.find((c) => c.record.recordId === b.reached[0]) ?? pool[0];
      if (!who) continue;
      const what = b.changes.map((c) => c.words).join('; ');
      for (const side of ['before', 'on'] as const) {
        const day = side === 'before' ? b.dayBefore : b.date;
        candidates.push({ source: 'generated', name: `${side === 'before' ? 'The day before' : 'On'} ${dayWords(b.date)}`, covers: [`${side === 'before' ? 'Before' : 'From'} ${dayWords(b.date)}: ${what}`], customer: who, overrides: {}, journeyCursor: null, issueDate: day, boundary: { date: b.date, side } });
      }
    }
  }
  candidates.push(...generated);

  const included = candidates.slice(0, Math.max(0, cap));
  const omitted = candidates.slice(included.length).map((c) => c.name);
  const scenarios: PlannedScenario[] = [];
  const used = new Set<string>();
  for (const [i, c] of included.entries()) {
    const res = resolve({ project, record: c.customer.record, overrides: c.overrides, journeyCursor: c.journeyCursor, profileId: 'paged-pdf', ...(c.issueDate ? { issueDate: c.issueDate } : {}) });
    let id = `s${String(i + 1).padStart(2, '0')}${slug(c.name) ? `-${slug(c.name)}` : ''}`;
    if (used.has(id)) id = `s${String(i + 1).padStart(2, '0')}`;
    used.add(id);
    scenarios.push({ ...c, id, res, keys: outcomeKeys(project, res), produced: !res.findings.some((f) => f.severity === 'blocking'), reference: false });
    if (i % 4 === 3) await tick();
  }

  // Reference subset: first both sides of every date boundary (within the cap), then a greedy cover of the outcomes seen,
  // over the scenarios a document is actually produced for.
  const seen = new Set(scenarios.flatMap((s) => s.keys.filter((k) => k !== 'blocked')));
  const shown = new Set<string>();
  const pool = scenarios.filter((s) => s.produced);
  let taken = 0;
  for (const s of scenarios.filter((x) => x.boundary)) {
    if (taken >= referenceCap) break;
    s.reference = true;
    s.keys.forEach((k) => shown.add(k));
    taken++;
    const at = pool.indexOf(s);
    if (at >= 0) pool.splice(at, 1);
  }
  for (let n = taken; n < referenceCap && pool.length; n++) {
    let best = -1, gain = -1;
    pool.forEach((s, i) => { const g = s.keys.filter((k) => !shown.has(k)).length; if (g > gain) { gain = g; best = i; } });
    if (gain <= 0 && n > 0 && n > taken) break;
    const [pick] = pool.splice(best, 1);
    pick.reference = true;
    pick.keys.forEach((k) => shown.add(k));
  }

  const customers = new Map<string, Candidate['customer']>();
  for (const s of scenarios) if (!customers.has(s.customer.id)) customers.set(s.customer.id, s.customer);
  return {
    scenarios, customers: [...customers.values()], excluded, omitted,
    notReached: plan.targets.filter((t) => t.customer === null).map((t) => ({ outcome: t.title, reason: t.reason ?? 'No customer reaches it.' })),
    coverage: { outcomes: plan.summary.outcomes }, cap, referenceCap,
    outcomesSeen: seen.size, outcomesInReference: [...shown].filter((k) => seen.has(k)).length,
  };
}

/** What the engine works out for one scenario, with names beside every id. */
export function expectedOutcome(project: Project, res: Resolution) {
  const name = nodeNameOf(project);
  const partTitle = (id: string | null): string | null => (id ? project.contentParts.find((c) => c.id === id)?.title ?? id : null);
  const tree = indexTree(res.root);
  const m = res.semanticManifest;
  const blocking = res.findings.filter((f) => f.severity === 'blocking');
  return {
    /** false = the document has a blocking issue and is not produced. */
    produced: blocking.length === 0,
    language: res.locale,
    messages: Object.entries(res.result.selectedVariants).map(([set, part]) => ({ sectionId: set, section: name(set), chosenId: part, chosen: partTitle(part) })),
    sections: optionalSections(project).map((n) => ({ id: n.id, name: name(n.id), shown: !!tree.get(n.id)?.visible })),
    rulesApplied: res.result.matchedRuleIds.map((id) => ({ id, title: project.rules.find((r) => r.id === id)?.title ?? `Rule ${id}` })),
    requiredNotices: m.disclosures.map((d) => ({ id: d.nodeId, name: name(d.nodeId), contentPartId: d.contentPartId, version: d.version, contentHash: d.contentHash })),
    amounts: Object.entries(m.money).map(([id, cents]) => ({ id, name: name(id), cents })),
    amountsNotDetermined: m.guardedLiabilityNodeIds.map((id) => ({ id, name: name(id) })),
    tables: Object.entries(m.tableRows).map(([id, rows]) => ({ id, name: name(id), rows, totalCents: m.tableTotalsCents[id] ?? null })),
    links: m.actions.map((a) => ({ id: a.nodeId, name: name(a.nodeId), url: a.url })),
    identity: m.identity,
    facts: m.facts,
    blocking: blocking.map((f) => ({ code: f.code, where: f.nodeId ? name(f.nodeId) : null, message: f.message })),
    runId: res.runId,
    contentDigest: res.contentDigest,
    // Additions for documents with dates and calculations (absent otherwise).
    ...(res.documentDate ? { issueDate: res.documentDate.date, issueDateGiven: res.documentDate.given } : {}),
    ...(res.calculated ? { calculated: Object.fromEntries(Object.entries(res.calculated).map(([k, c]) => [`calc.${k}`, c.value])) } : {}),
  };
}

/* ------------------------------------------------------------------ README */

function readmeHtml(a: { title: string; kind: string; number: number; approver: string | null; approvedAt: string; fileName: string; languages: ReleasePackageSummary['languages']; plan: ScenarioPlan; references: PlannedScenario[]; known?: StoredRelease['knownDataProblems']; dates?: string }): string {
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const knownRows = (a.known ?? []).map((k) => row([escHtml(k.blocker), 'id' in k.customer ? `${k.customer.kind === 'sample' ? 'Sample customer' : 'Generated customer'} <code>${escHtml(k.customer.id)}</code>` : 'One customer who is not synthetic (no id or name recorded)', escHtml(k.reason), escHtml(k.markedBy ?? '—')])).join('\n');
  const scenarioRows = a.plan.scenarios.map((s) => row([
    escHtml(s.name), escHtml(s.customer.name), s.source === 'pinned-test' ? 'Pinned test' : 'Generated by the studio',
    s.produced ? 'Document produced' : 'Not produced (blocking issue)', s.reference ? `<code>reference/${escHtml(s.id)}/</code>` : '—',
  ])).join('\n');
  const languageRows = a.languages.map((l) => row([escHtml(l.name), String(l.texts), String(l.approved), String(l.missing), `<code>wording/${escHtml(l.locale)}.xlf</code>`])).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(a.title)} — release ${a.number}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:860px;margin:32px auto;padding:0 20px;line-height:1.5}
h1{font-size:24px;margin-bottom:4px}h2{font-size:18px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
code{background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:13px}.lead{color:#4b5563}.note{background:#f9fafb;border-left:4px solid #9ca3af;padding:8px 12px}
</style>
</head>
<body>
<h1>${escHtml(a.title)} — release ${a.number}</h1>
<p class="lead">${escHtml(a.kind)}. Approved${a.approver ? ` by ${escHtml(a.approver)}` : ''} on ${escHtml(when(a.approvedAt))}. Package file: <code>${escHtml(a.fileName)}</code>.</p>

<h2>What this is</h2>
<p>This package is one frozen release of a document template, handed over from InfoSlips Spatial Studio, where it was designed, tested, translated and approved. It holds everything needed to build the same document in another system and to prove that the build is right. Nothing in a release ever changes: a change to the document is a new release with the next number.</p>
<p class="note">Every customer in this package is synthetic: a built-in sample customer or one the studio generated to exercise a rule. No real customer data is included.</p>

<h2>What is inside</h2>
<table>
<tr><th>File</th><th>What it holds</th></tr>
${row(['<code>manifest.json</code>', 'The release number, who approved it and when, the versions of the engine and renderers, and the SHA-256 and size of every other file.'])}
${row(['<code>template.json</code>', 'The template itself: layout, components, rules, wording, translations, email and SMS wording, styles, brand and pinned tests.'])}
${row(['<code>wording/</code>', 'Every text a customer can read: the English source list, and for each other language an XLIFF file and a spreadsheet with the approved translations.'])}
${row(['<code>data/dictionary.json</code>', 'Every data field: its path, label, type, format, whether it is required, an example, and where the template uses it.'])}
${row(['<code>assets/</code>', 'The images as files, and the list of fonts the document needs. Font files are not included.'])}
${row(['<code>tests/scenarios.json</code>', 'Named synthetic customers with the outcome the engine works out for each: messages chosen, sections shown or hidden, language, amounts, and any blocking issue.'])}
${row(['<code>reference/</code>', 'For some of the scenarios, the outputs the studio produced: PDF, web page, email (HTML and text), SMS, and the facts they carry.'])}
</table>

<h2>Scenarios</h2>
<p>${a.plan.scenarios.length} scenario${a.plan.scenarios.length === 1 ? '' : 's'}, ${a.references.length} with reference outputs. The limit is ${a.plan.cap} scenarios and ${a.plan.referenceCap} sets of reference outputs${a.plan.omitted.length ? `; ${a.plan.omitted.length} more could have been included and ${a.plan.omitted.length === 1 ? 'is' : 'are'} named in the manifest` : ''}.${a.plan.excluded.length ? ` ${a.plan.excluded.length} pinned test${a.plan.excluded.length === 1 ? ' was' : 's were'} left out because ${a.plan.excluded.length === 1 ? 'its customer is' : 'their customers are'} not synthetic.` : ''}</p>
<table>
<tr><th>Scenario</th><th>Customer</th><th>Where it comes from</th><th>Result</th><th>Reference outputs</th></tr>
${scenarioRows}
</table>

${knownRows ? `<h2>Known data problems</h2>
<p>When this release was approved, an approver set aside these customers' data problems, each for one customer and with a reason. The document itself had no blocker.</p>
<table>
<tr><th>Problem</th><th>Customer</th><th>Reason</th><th>Set aside by</th></tr>
${knownRows}
</table>

` : ''}${a.dates ?? ''}<h2>Languages</h2>
${a.languages.length ? `<table>
<tr><th>Language</th><th>Texts</th><th>Approved</th><th>Not translated</th><th>File</th></tr>
${languageRows}
</table>
<p>Only approved translations are included. A text without one is left untranslated in the file and listed under that language in the manifest; the document shows its English text.</p>` : '<p>This document is in English only. <code>wording/en-US.csv</code> lists every text.</p>'}

<h2>How to verify a build against this package</h2>
<ol>
<li><strong>Check the package.</strong> Compute the SHA-256 of every file and compare it with <code>contents</code> in <code>manifest.json</code>.</li>
<li><strong>Build the template</strong> from <code>template.json</code>, the wording files, the data dictionary and the assets.</li>
<li><strong>Run every scenario.</strong> For each entry in <code>tests/scenarios.json</code>, give your build the customer data under <code>data</code> and compare what it decides with <code>expected</code>: the same messages, the same sections shown and hidden, the same language, the same amounts in cents, and the same blocking issues. A scenario marked as not produced must not produce a document.</li>
<li><strong>Compare the outputs.</strong> For each folder under <code>reference/</code>, compare your PDF, web page, email and SMS with the ones provided, using <code>facts.json</code> as the list of what must agree.</li>
</ol>

<h2>What “matching” means</h2>
<p>Two outputs match when they carry the same facts, not when they look identical. These must be the same in every output:</p>
<ul>
<li>the message chosen for each message section;</li>
<li>every amount, compared in whole cents;</li>
<li>amounts that are not determined yet (for example a member’s liability under review) are shown as not determined, never as a figure;</li>
<li>every required notice: the same notice, the same version and the same wording (compared by content hash);</li>
<li>every required section is present;</li>
<li>the number of rows in each table, and each table total;</li>
<li>who the document is for (name, and account or member number where shown);</li>
<li>where each link leads.</li>
</ul>
<p>These may differ: layout, page count, fonts actually used, interactivity (sorting, filtering, expanding), and a link printed as a web address or QR code instead of a button. Email and SMS are checked for the amounts, dates, chosen messages, notices and links they contain. <code>facts.json</code> records the result of these same checks for the studio’s own outputs.</p>

<h2>What is not included</h2>
<ul>
<li>Customer data of any kind.</li>
<li>Draft wording and unapproved translations.</li>
<li>Which stage the release is at (Test or Production) and who received it: the studio keeps that record, because it changes while the release does not.</li>
<li>A mapping of the data fields to a particular system’s field names.</li>
<li>A shared library. Everything the template uses is inside <code>template.json</code>.</li>
<li>Font files. <code>assets/fonts.json</code> names the fonts.</li>
<li>An AFP print stream. The studio’s AFP output is a simulation and is not part of a release.</li>
<li>The engine itself. This package describes the template; it does not run it.</li>
</ul>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ the package */

export interface PackageFile { path: string; sha256: string; bytes: number; role: string }
export interface BuiltPackage { fileName: string; zip: Buffer; sha256: string; files: PackageFile[]; manifest: Record<string, unknown>; summary: ReleasePackageSummary }
export interface PackageOptions {
  composer: PackageComposer;
  /** Format constants; tests lower them to stay fast. */
  scenarioCap?: number;
  referenceCap?: number;
  onProgress?: (p: { step: string; done: number; total: number }) => void;
}

const CONTENT_TYPES: Record<string, string> = { json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xlf: 'application/xliff+xml; charset=utf-8', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
export const packageContentType = (path: string): string => CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

export async function buildReleasePackage(release: StoredRelease, frozen: Project, opts: PackageOptions): Promise<BuiltPackage> {
  const progress = opts.onProgress ?? (() => undefined);
  const template = releaseTemplate(frozen);
  const files: Array<{ path: string; data: Buffer; role: string }> = [];
  const add = (path: string, role: string, data: string | Buffer) => { files.push({ path, role, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data }); };

  progress({ step: 'Reading the template', done: 0, total: 1 });
  add('template.json', 'template', json(template));

  /* wording */
  const about = `${release.title}, release ${release.number}`;
  const sourceRows = wordingRows(template, SOURCE_LANGUAGE);
  add(`wording/${SOURCE_LANGUAGE}.csv`, 'wording-source', csv([['id', 'kind', 'title', 'mandatory', SOURCE_LANGUAGE], ...sourceRows.map((r) => [r.id, r.kind, r.title, r.mandatory ? 'yes' : 'no', r.source])]));
  const targets: Array<ReleasePackageSummary['languages'][number] & { missingIds: string[] }> = [];
  for (const locale of projectLanguages(template)) {
    const rows = wordingRows(template, locale);
    add(`wording/${locale}.xlf`, 'wording', wordingXliff(rows, locale, about));
    add(`wording/${locale}.csv`, 'wording', csv([['id', 'kind', 'title', 'mandatory', 'status', 'sourceChanged', SOURCE_LANGUAGE, locale], ...rows.map((r) => [r.id, r.kind, r.title, r.mandatory ? 'yes' : 'no', r.status, r.sourceChanged ? 'yes' : 'no', r.source, r.target ?? ''])]));
    const missingIds = rows.filter((r) => r.target === null).map((r) => r.id);
    targets.push({ locale, name: languageName(locale), texts: rows.length, approved: rows.length - missingIds.length, missing: missingIds.length, missingIds });
  }
  await tick();

  /* data and assets */
  add('data/dictionary.json', 'data-dictionary', json(dataDictionary(template)));
  const { assets, index } = packageAssets(template);
  for (const a of assets) add(a.path, 'asset', a.data);
  add('assets/index.json', 'asset-index', json(index));
  await tick();

  /* scenarios */
  progress({ step: 'Working out the test scenarios', done: 0, total: 1 });
  const plan = await planScenarios(template, release.pinned, opts.scenarioCap ?? SCENARIO_CAP, opts.referenceCap ?? REFERENCE_CAP);
  const references = plan.scenarios.filter((s) => s.reference);
  const stepLabel = (cursor: number | null): string | null => { if (cursor === null) return null; const e = template.journey.events[cursor]; return e ? e.label ?? e.eventType : null; };
  add('tests/scenarios.json', 'tests', json({
    formatVersion: 1,
    release: { id: release.id, number: release.number, title: release.title },
    syntheticOnly: true,
    note: 'Each scenario names a synthetic customer and what the engine works out for it. "data" is the customer data the document is produced from (after the scenario’s what-if values and journey step); "expected" is what any build must decide for that data. To reproduce a scenario in the studio’s own engine, resolve template.json for the customer under "customers" with the scenario’s overrides and journey step.',
    cap: plan.cap,
    counts: { scenarios: plan.scenarios.length, pinnedTests: plan.scenarios.filter((s) => s.source === 'pinned-test').length, generated: plan.scenarios.filter((s) => s.source === 'generated').length, omittedByCap: plan.omitted.length, pinnedTestsExcluded: plan.excluded.length, withReference: references.length },
    outcomes: { ...plan.coverage.outcomes, notReached: plan.notReached },
    omittedByCap: plan.omitted,
    pinnedTestsExcluded: plan.excluded,
    customers: plan.customers.map((c) => ({ id: c.id, name: c.name, kind: c.kind, ...(c.why ? { generatedTo: c.why } : {}), record: c.record })),
    scenarios: plan.scenarios.map((s) => ({
      id: s.id, name: s.name, source: s.source,
      ...(s.test ? { pinnedTest: { id: s.test.id, name: s.test.name } } : {}),
      ...(s.covers.length ? { covers: s.covers } : {}),
      customerId: s.customer.id, customerName: s.customer.name,
      overrides: s.overrides, journeyCursor: s.journeyCursor, journeyStep: stepLabel(s.journeyCursor),
      ...(s.issueDate ? { issueDate: s.issueDate } : {}),
      ...(s.boundary ? { dateBoundary: s.boundary } : {}),
      data: s.res.effectiveRecord,
      expected: expectedOutcome(template, s.res),
      ...(s.test ? { pinnedExpectation: { ...s.test.expect, holds: runTestCase(template, [s.customer.record], s.test).pass } } : {}),
      reference: s.reference ? `reference/${s.id}/` : null,
    })),
  }));
  await tick();

  /* reference outputs */
  let producer: string | null = null;
  const fonts = new Set<string>();
  for (const [i, s] of references.entries()) {
    progress({ step: 'Composing the reference outputs', done: i, total: references.length });
    const dir = `reference/${s.id}`;
    const paged = await opts.composer.pdf(renderPagedDocument(s.res, template, { profileId: 'paged-pdf', watermark: '' }));
    await tick();
    const pdf = normalisePdf(paged.pdf, release.approvedAt);
    producer ??= pdfProducer(pdf);
    pdfFonts(pdf).forEach((f) => fonts.add(f));
    const html = renderInteractiveHtml(s.res, template);
    const web = await opts.composer.html(html);
    await tick();
    const email = renderEmail(s.res, template);
    const sms = renderSms(s.res, template);
    const out = { pdf, html: Buffer.from(html, 'utf8'), emailHtml: Buffer.from(email.html, 'utf8'), emailText: Buffer.from(email.text, 'utf8'), sms: Buffer.from(sms.text, 'utf8') };
    add(`${dir}/document.pdf`, 'reference-pdf', out.pdf);
    add(`${dir}/document.html`, 'reference-html', out.html);
    add(`${dir}/email.html`, 'reference-email-html', out.emailHtml);
    add(`${dir}/email.txt`, 'reference-email-text', out.emailText);
    add(`${dir}/sms.txt`, 'reference-sms', out.sms);
    add(`${dir}/facts.json`, 'reference-facts', json({
      formatVersion: 1,
      scenario: { id: s.id, name: s.name },
      customer: { id: s.customer.id, name: s.customer.name },
      runId: s.res.runId, contentDigest: s.res.contentDigest, projectDigest: s.res.projectDigest, engine: s.res.engineVersion, language: s.res.locale,
      /** The facts every output of this scenario must carry. */
      expected: s.res.semanticManifest,
      outputs: {
        'document.pdf': { sha256: sha256(out.pdf), bytes: out.pdf.length, pages: paged.pageCount, facts: paged.facts },
        'document.html': { sha256: sha256(out.html), bytes: out.html.length, facts: web.facts },
        'email.html': { sha256: sha256(out.emailHtml), bytes: out.emailHtml.length, subject: email.subject, preheader: email.preheader },
        'email.txt': { sha256: sha256(out.emailText), bytes: out.emailText.length },
        'sms.txt': { sha256: sha256(out.sms), bytes: out.sms.length, encoding: sms.encoding, characters: sms.length, segments: sms.segments },
      },
      /** The studio's own parity checks on these outputs: what "matching" means. Null when the facts could not be read back from the pages. */
      parity: {
        documents: paged.facts && web.facts ? compareManifests(s.res.semanticManifest, paged.facts, web.facts) : null,
        channels: checkChannelParity(s.res, email, sms),
      },
    }));
  }
  add('assets/fonts.json', 'fonts', json(packageFonts(template, [...fonts].sort())));

  /* README, then the manifest that lists everything */
  progress({ step: 'Packing', done: 0, total: 1 });
  const fileName = releasePackageName(release.documentId, release.number);
  const languages = targets.map(({ missingIds: _m, ...l }) => l);
  const boundaries = template.documentDate ? documentDateBoundaries(template) : [];
  const sideOf = (date: string, side: 'before' | 'on') => plan.scenarios.find((x) => x.boundary?.date === date && x.boundary.side === side);
  const datesHtml = template.documentDate ? `<h2>Dates</h2>
<p>${template.documentDate.source === 'run' ? 'This document’s date is given for each run (as “issued on”); a document that needs it and has none is not produced.' : `This document’s date is taken from the customer’s data (<code>${escHtml(template.documentDate.path)}</code>), unless a date is given for the run.`} What the document says changes on these days. “From” a day means from that day on; a period ends the day before its “until” day. Each day has a scenario for the day before and for the day itself${boundaries.length ? '' : ' (there are none)'}.</p>
${boundaries.length ? `<table>
<tr><th>Day</th><th>What changes</th><th>Scenarios</th></tr>
${boundaries.map((b) => `<tr><td>${escHtml(dayWords(b.date))}</td><td>${b.changes.map((c) => escHtml(c.words)).join('<br>')}</td><td>${[sideOf(b.date, 'before'), sideOf(b.date, 'on')].map((x) => (x ? `<code>${escHtml(x.id)}</code>${x.reference ? ' (reference outputs)' : ''}` : '—')).join(', ')}</td></tr>`).join('\n')}
</table>` : ''}

` : '';
  add('README.html', 'readme', readmeHtml({ title: release.title, kind: DOCUMENT_TYPE_LABEL[release.documentType], number: release.number, approver: release.approvedBy?.name ?? null, approvedAt: release.approvedAt, fileName, languages, plan, references, known: release.knownDataProblems, dates: datesHtml }));

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const contents: PackageFile[] = files.map((f) => ({ path: f.path, sha256: sha256(f.data), bytes: f.data.length, role: f.role }));
  const manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    release: { id: releaseId(release.documentId, release.number), number: release.number, origin: release.origin, createdAt: release.createdAt },
    document: { id: release.documentId, title: release.title, kind: release.documentType, kindLabel: DOCUMENT_TYPE_LABEL[release.documentType], modelVersion: release.modelVersion, issuer: template.issuer?.name ?? null },
    approvedBy: release.approvedBy ? { name: release.approvedBy.name } : null,
    approvedAt: release.approvedAt,
    /** The studio's digest of the approved content (the value its version history shows). */
    contentDigest: release.contentDigest,
    /** The engine's digest of template.json's content; every facts.json repeats it as `projectDigest`. */
    templateDigest: projectContentDigest(template),
    versions: { schema: template.schemaVersion, engine: release.versions.engine, pagedRenderer: release.versions.pagedRenderer, htmlRenderer: release.versions.htmlRenderer, emailRenderer: release.versions.emailRenderer, smsRenderer: release.versions.smsRenderer, pdfProducer: producer },
    languages: { source: SOURCE_LANGUAGE, targets: targets.map((t) => ({ locale: t.locale, name: t.name, texts: t.texts, approved: t.approved, missing: t.missingIds })) },
    tests: { cap: plan.cap, scenarios: plan.scenarios.length, pinnedTests: plan.scenarios.filter((s) => s.source === 'pinned-test').length, generated: plan.scenarios.filter((s) => s.source === 'generated').length, omittedByCap: plan.omitted, pinnedTestsExcluded: plan.excluded, outcomes: plan.coverage.outcomes },
    reference: { cap: plan.referenceCap, scenarios: references.map((s) => s.id), outcomesShown: plan.outcomesInReference, outcomesSeen: plan.outcomesSeen, files: ['document.pdf', 'document.html', 'email.html', 'email.txt', 'sms.txt', 'facts.json'] },
    /**
     * Customers' data problems an approver set aside when this release was approved, each with the reason (an addition
     * to format 1: readers that do not know it ignore it). Never customer data: a built-in sample or engine-generated
     * customer is named by id; any other customer has no id or name. Absent on releases made before it was recorded.
     */
    ...(release.knownDataProblems ? { knownDataProblems: release.knownDataProblems } : {}),
    /**
     * For a document that uses dates (an addition to format 1: readers that do not know it ignore it): where its date
     * comes from, and every day on which what it says changes, with the scenarios on each side of the day.
     */
    ...(template.documentDate ? { documentDate: template.documentDate, dateBoundaries: boundaries.map((b) => ({ date: b.date, changes: b.changes.map(({ words: w, ...c }) => ({ ...c, words: w })), scenarios: { dayBefore: sideOf(b.date, 'before')?.id ?? null, onTheDay: sideOf(b.date, 'on')?.id ?? null } })) } : {}),
    syntheticOnly: true,
    notIncluded: ['customer data', 'draft wording and unapproved translations', 'stage and handover record', 'data/mapping-<ccm>.json', 'library/', 'font files', 'AFP print stream', 'the engine'],
    /** Every file in the package except this one. A reader must ignore roles and paths it does not know. */
    contents,
  };
  const all = [{ path: 'manifest.json', data: Buffer.from(json(manifest), 'utf8') }, ...files];
  await tick();
  const zip = zipFiles(all.map((f) => ({ name: f.path, data: f.data, date: ZIP_FIXED_DATE })));
  return {
    fileName, zip, sha256: sha256(zip), files: contents, manifest,
    summary: { scenarios: plan.scenarios.length, references: references.length, pinnedExcluded: plan.excluded.length, languages },
  };
}
