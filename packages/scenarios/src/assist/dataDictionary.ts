import {
  DERIVED_FIELDS_VERSION, RECORD_ID_PREFIX, SOURCE_LANGUAGE, buildContext, dateBoundaries, defaultFormatterFor, evaluateCalculations, exprDependencies,
  formulaInWords, getPath, itemFieldDefs, scopeFieldIndex, usesRicherShapes, lookupTableProblems, printFormula, projectFieldIndex, projectFields, tokensIn, tokensInText, translatableStrings, translationStatus, wordsScopeOf,
  type DocNode, type FieldDef, type Predicate, type Project, type SyntheticRecord,
} from '@iss/model';
import { predicatePaths } from '@iss/resolver';
import { baselineCustomer } from './testData';

/**
 * The data dictionary of a document: every field a customer record of it may carry, its type and format, an example
 * from a synthetic customer, and where the document uses it. ONE function for the release package
 * (`data/dictionary.json`) and the studio's Mapping screen, so the two never disagree. Pure.
 * Moved here unchanged from apps/api/src/releasePackage.ts (wave 3), which re-exports it.
 */

/** What each calculated field of the built-in kinds is worked out from (see `buildContext`); a row count comes from its list. */
const CALCULATED_FROM: Record<string, string[]> = {
  'card.availableCreditCents': ['card.creditLimitCents', 'card.newBalanceCents'],
  'card.transactionsTotalCents': ['card.transactions'],
};

export const FORMAT_OF: Record<FieldDef['type'], string> = {
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

export interface FieldUse { rules: Map<string, string>; conditions: Set<string>; bindings: Set<string>; tokens: Set<string>; journey: Set<string>; columns: Set<string> }

/** Where every data field is read: rule conditions, conditions on components, bindings, text tokens and journey steps. */
export function fieldUsage(project: Project): { used: Map<string, FieldUse>; unknown: Array<{ path: string; where: string }> } {
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
  // Only for a document that uses the richer shapes: every other dictionary stays exactly as it was.
  const itemDefs = usesRicherShapes(project) ? itemFieldDefs(project.customFields, project.calculatedFields) : [];
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
      // Richer data shapes (wave 5): lists inside the items of this list, each with its columns.
      ...(f.innerLists?.length ? { innerLists: f.innerLists.map((l) => ({ key: l.key, label: l.label, columns: l.itemFields.map((c) => ({ key: c.key, label: c.label, type: c.type, format: FORMAT_OF[c.type] })) })) } : {}),
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
    // Richer data shapes (wave 5): every field of the items of the lists, as read inside a repeating section (absent otherwise).
    ...(itemDefs.length ? { itemFields: itemDefs.map((f) => ({ path: f.path, label: f.label, type: f.type, format: FORMAT_OF[f.type], list: f.item, calculated: !!f.derived, ...(calcs.has(f.path) ? { calculation: { gives: calcs.get(f.path)!.type, formula: printFormula(calcs.get(f.path)!.expr, scopeFieldIndex(project, f.item)), inWords: formulaInWords(calcs.get(f.path)!.expr, wordsScopeOf(project, scopeFieldIndex(project, f.item))) } } : {}) })) } : {}),
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

/** The data dictionary as `data/dictionary.json` holds it. */
export type DataDictionary = ReturnType<typeof dataDictionary>;
export type DictionaryField = DataDictionary['fields'][number];
