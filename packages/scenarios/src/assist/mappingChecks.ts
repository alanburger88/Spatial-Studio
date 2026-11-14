import {
  DOCUMENT_TYPE_LABEL, LIST_COLUMN_MARK, TARGET_KIND_LABEL, cleanTargetFields, mappingSlugs, parseCsv, targetTypeKind, typeClash,
  type FieldType, type MappingEntry, type Project, type TargetField, type TargetKind, type TargetMapping,
} from '@iss/model';
import { dataDictionary, type DataDictionary } from './dataDictionary';
import { matchNames } from './importMapping';
import type { ColumnMatch } from './types';

/**
 * Checks of a mapping of a document's data fields to a target system (wave 3, section 3). Pure: no clock, no network.
 * Reads the document's data dictionary (the same function as the release package's `data/dictionary.json`), so the
 * screen, the checks and the package agree on which fields the document reads.
 *
 * The rule for what must be mapped: every field the document reads or its data contract requires (`needed` in the
 * dictionary), except the kind of document (fixed by the template); for a list that is mapped, every column the document
 * reads. Calculated fields are listed with their formula in plain words: the target must supply or compute them, so
 * mapping one is optional (it says the target supplies it). Complete = nothing unmapped, no target field mapped from two
 * document fields, and no type clash.
 */

export type MappingRowStatus = 'mapped' | 'not-needed' | 'unmapped' | 'optional';

export interface MappingRow {
  path: string;
  label: string;
  type: FieldType;
  format: string;
  calculated: boolean;
  /** Read by the document or required by its data contract (a column: read by the document). */
  needed: boolean;
  /** Must be mapped or marked "not needed" for the mapping to be complete. */
  required: boolean;
  /** Columns: the list they belong to. */
  list?: string;
  example: unknown;
  entry: MappingEntry | null;
  status: MappingRowStatus;
  /** The target's type (the entry's own, else the target list's) and how the studio reads it. */
  targetType: string | null;
  targetKind: TargetKind | null;
  clash: string | null;
}

export type MappingFindingKind = 'unmapped' | 'mapped-twice' | 'type-clash' | 'calculated' | 'lookup-table' | 'document-date' | 'stale-entry' | 'not-in-target-list' | 'amount-format';

export interface MappingFinding {
  kind: MappingFindingKind;
  /** `problem` stops the mapping being complete; `note` is for the person and the target system to know. */
  severity: 'problem' | 'note';
  /** The rows it is about (for links to them). */
  paths: string[];
  message: string;
}

export interface MappingCheck {
  mappingId: string;
  complete: boolean;
  counts: { required: number; mapped: number; notNeeded: number; unmapped: number; clashes: number; mappedTwice: number; optionalMapped: number };
  rows: MappingRow[];
  findings: MappingFinding[];
  /** Calculated fields the document reads, with what they are worked out from, in plain words. */
  calculated: Array<{ path: string; label: string; inWords: string; formula: string | null }>;
  /** Lookup tables the document reads (through its calculations). */
  lookupTables: Array<{ id: string; title: string; usedBy: string[] }>;
  /** Where the document's date comes from, in plain words (null when the document does not use dates). */
  documentDate: string | null;
}

const q = (s: string) => `“${s}”`;
const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The rows of a mapping: one per field of the dictionary (not the kind of document), with each list's columns after it. */
function rowsOf(dict: DataDictionary): Array<Omit<MappingRow, 'entry' | 'status' | 'targetType' | 'targetKind' | 'clash' | 'required'> & { listNeeded?: boolean; columnUsed?: boolean }> {
  const out: Array<Omit<MappingRow, 'entry' | 'status' | 'targetType' | 'targetKind' | 'clash' | 'required'> & { listNeeded?: boolean; columnUsed?: boolean }> = [];
  for (const f of dict.fields) {
    if (f.path === 'documentType') continue;
    out.push({ path: f.path, label: f.label, type: f.type, format: f.format, calculated: f.calculated, needed: f.needed, example: f.example });
    for (const c of f.columns ?? []) {
      const first = Array.isArray(f.example) ? (f.example[0] as Record<string, unknown> | undefined) : undefined;
      out.push({ path: `${f.path}${LIST_COLUMN_MARK}${c.key}`, label: `${f.label} · ${c.label}`, type: c.type as FieldType, format: c.format, calculated: false, needed: f.needed && c.used, list: f.path, example: first?.[c.key] ?? null, listNeeded: f.needed, columnUsed: c.used });
    }
  }
  return out;
}

/** What the target says a field's type is: the entry's own type, else the type in the target's field list. */
function targetTypeOf(entry: MappingEntry | null, byName: Map<string, TargetField>): string | null {
  if (!entry?.target) return null;
  return entry.targetType ?? byName.get(entry.target.toLowerCase())?.type ?? null;
}

export function mappingChecks(project: Project, mapping: TargetMapping, dict: DataDictionary = dataDictionary(project)): MappingCheck {
  const entries = new Map(mapping.entries.map((e) => [e.path, e]));
  const targets = mapping.targetFields ?? [];
  const byName = new Map(targets.map((t) => [t.name.toLowerCase(), t]));
  const base = rowsOf(dict);
  const listDecision = new Map<string, MappingEntry | undefined>();
  for (const r of base) if (!r.list && r.type === 'array') listDecision.set(r.path, entries.get(r.path));

  const rows: MappingRow[] = base.map(({ listNeeded: _ln, columnUsed: _cu, ...r }) => {
    const entry = entries.get(r.path) ?? null;
    // A column needs a decision when its list is needed, is not marked "not needed", and the document reads the column.
    const required = r.list ? r.needed && !listDecision.get(r.list)?.notNeeded : !r.calculated && r.needed;
    const targetType = targetTypeOf(entry, byName);
    const targetKind = entry?.target ? targetTypeKind(targetType ?? undefined) : null;
    const clash = entry?.target && targetKind ? typeClash(r.type, targetKind) : null;
    const status: MappingRowStatus = entry?.target ? 'mapped' : entry?.notNeeded ? 'not-needed' : required ? 'unmapped' : 'optional';
    return { ...r, required, entry, status, targetType, targetKind, clash };
  });

  const findings: MappingFinding[] = [];
  const problem = (kind: MappingFindingKind, paths: string[], message: string) => findings.push({ kind, severity: 'problem', paths, message });
  const note = (kind: MappingFindingKind, paths: string[], message: string) => findings.push({ kind, severity: 'note', paths, message });

  for (const r of rows) if (r.status === 'unmapped') problem('unmapped', [r.path], `${q(r.label)} is ${r.list ? 'a column the document reads' : r.calculated ? 'read by the document' : 'read by the document or required by its data'} but is not mapped. Choose the target field, or mark it “not needed by the target” with a reason.`);
  // One target field from two document fields (the columns of one list are compared among themselves).
  const byTarget = new Map<string, MappingRow[]>();
  for (const r of rows) if (r.entry?.target) { const k = `${r.list ?? ''}|${r.entry.target.toLowerCase()}`; byTarget.set(k, [...(byTarget.get(k) ?? []), r]); }
  let mappedTwice = 0;
  for (const group of byTarget.values()) if (group.length > 1) { mappedTwice++; problem('mapped-twice', group.map((r) => r.path), `The target field ${q(group[0].entry!.target!)} is mapped from ${listWords(group.map((r) => q(r.label)))}. A target field takes one document field.`); }
  for (const r of rows) if (r.clash) problem('type-clash', [r.path], `${q(r.label)} → ${q(r.entry!.target!)}: ${r.clash} The target’s type ${q(r.targetType ?? '')} is read as ${TARGET_KIND_LABEL[r.targetKind!]}.`);
  for (const r of rows) if (r.entry?.target && r.type === 'cents' && (r.targetKind === 'money' || r.targetKind === 'decimal' || r.targetKind === 'number') && !r.entry.format) note('amount-format', [r.path], `${q(r.label)} is given in whole cents; ${q(r.entry.target)} is ${TARGET_KIND_LABEL[r.targetKind]}. Say in the format note whether the target expects cents or dollars.`);
  if (targets.length) for (const r of rows) if (r.entry?.target && !byName.has(r.entry.target.toLowerCase())) note('not-in-target-list', [r.path], `${q(r.label)} goes to ${q(r.entry.target)}, which is not in the target’s field list.`);
  const known = new Set(rows.map((r) => r.path));
  for (const e of mapping.entries) if (!known.has(e.path)) problem('stale-entry', [e.path], `The mapping names ${q(e.path)}, which is no longer a data field of this document. Clear it.`);

  // Calculated fields: the target must supply or compute them.
  const dictByPath = new Map(dict.fields.map((f) => [f.path, f]));
  const labelOf = (p: string) => (p === 'document.date' ? 'the document’s date' : dictByPath.get(p)?.label ?? p);
  const calculated = dict.fields.filter((f) => f.calculated && f.needed && f.path !== 'documentType').map((f) => {
    const c = (f as { calculation?: { inWords: string; formula: string } }).calculation;
    const from = (f as { calculatedFrom?: string[] }).calculatedFrom ?? [];
    const inWords = c?.inWords ?? ((f as { documentDate?: string }).documentDate ? `The document’s date, ${(f as { documentDate?: string }).documentDate}.` : from.length ? `Worked out by the studio from ${listWords(from.map((p) => q(labelOf(p))))}.` : 'Worked out by the studio.');
    return { path: f.path, label: f.label, inWords, formula: c?.formula ?? null };
  });
  for (const c of calculated) {
    const r = rows.find((x) => x.path === c.path);
    note('calculated', [c.path], `${q(c.label)} is calculated: ${c.inWords} The target must supply or compute this${r?.entry?.target ? ` (mapped to ${q(r.entry.target)}: the target supplies it)` : ''}.`);
  }
  const lookupTables = (dict.lookupTables ?? []).filter((t) => t.usedBy.some((p) => dictByPath.get(p)?.needed)).map((t) => ({ id: t.id, title: t.title, usedBy: t.usedBy }));
  for (const t of lookupTables) note('lookup-table', t.usedBy, `The document reads the lookup table ${q(t.title)} (through ${listWords(t.usedBy.map((p) => q(labelOf(p))))}). The target must hold the same table or supply the values.`);
  const documentDate = project.documentDate ? (project.documentDate.source === 'run' ? 'given for each run (not part of the customer’s data)' : `taken from ${q(labelOf(project.documentDate.path))}`) : null;
  if (documentDate) note('document-date', project.documentDate?.source === 'field' ? [project.documentDate.path] : ['document.date'], `The document’s date is ${documentDate}. Periods and date calculations depend on it.`);

  const clashes = rows.filter((r) => r.clash).length;
  const unmapped = rows.filter((r) => r.status === 'unmapped').length;
  return {
    mappingId: mapping.id,
    complete: unmapped === 0 && clashes === 0 && mappedTwice === 0,
    counts: {
      required: rows.filter((r) => r.required).length,
      mapped: rows.filter((r) => r.required && r.status === 'mapped').length,
      notNeeded: rows.filter((r) => r.status === 'not-needed').length,
      unmapped, clashes, mappedTwice,
      optionalMapped: rows.filter((r) => !r.required && r.status === 'mapped').length,
    },
    rows, findings, calculated, lookupTables, documentDate,
  };
}

/* ------------------------------------------------------------------ suggested matches */

export interface TargetSuggestion { path: string; target: string; targetType: string | null; confidence: ColumnMatch['confidence']; reason: string; preselected: boolean }

/**
 * Matches a target's field list to the document's fields with the customer import's matcher: exact and likely matches
 * are pre-selected; a guess is only offered. Fields already decided on are left alone (not suggested).
 */
export function suggestTargetMatches(project: Project, mapping: TargetMapping, fields: TargetField[], dict: DataDictionary = dataDictionary(project)): TargetSuggestion[] {
  const decided = new Set(mapping.entries.map((e) => e.path));
  const candidates = rowsOf(dict).filter((r) => !decided.has(r.path)).map((r) => ({ path: r.path, label: r.label }));
  if (!candidates.length || !fields.length) return [];
  const matches = matchNames(fields.map((f) => f.name), candidates);
  return matches.flatMap((m, i): TargetSuggestion[] => (m.path && m.confidence !== 'none'
    ? [{ path: m.path, target: fields[i].name, targetType: fields[i].type ?? null, confidence: m.confidence, reason: m.reason, preselected: m.confidence === 'exact' || m.confidence === 'likely' }]
    : []));
}

/* ------------------------------------------------------------------ the target's field list from a CSV */

export interface TargetListRead {
  fields: TargetField[];
  /** Which column of the file was read as what (null when no column was recognised). */
  columns: { name: string | null; type: string | null; description: string | null };
  /** Headings that were not used. */
  ignored: string[];
  problems: string[];
  /** How each distinct type in the file is read. */
  types: Array<{ type: string; readAs: TargetKind }>;
}

const NAME_HEADS = ['name', 'field', 'fieldname', 'field name', 'column', 'columnname', 'column name', 'element', 'attribute', 'target', 'target field', 'targetfield', 'variable', 'tag', 'xpath', 'path', 'id', 'key', 'property'];
const TYPE_HEADS = ['type', 'datatype', 'data type', 'field type', 'fieldtype', 'format', 'kind', 'data format', 'sql type'];
const DESC_HEADS = ['description', 'desc', 'meaning', 'definition', 'comment', 'comments', 'notes', 'note', 'label', 'title', 'caption'];
const norm = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** Reads a target's field list from CSV (columns name, type, description; header variants tolerated). Pure. */
export function readTargetFieldList(text: string): TargetListRead {
  const rows = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  const empty: TargetListRead = { fields: [], columns: { name: null, type: null, description: null }, ignored: [], problems: [], types: [] };
  if (!rows.length) return { ...empty, problems: ['The file is empty.'] };
  const head = rows[0].map(norm);
  const find = (names: string[], skip: number[]) => { for (const n of names) { const i = head.findIndex((h, j) => !skip.includes(j) && (h === n || h.replace(/ /g, '') === n.replace(/ /g, ''))); if (i >= 0) return i; } return -1; };
  let nameCol = find(NAME_HEADS, []);
  const typeCol = find(TYPE_HEADS, [nameCol]);
  const descCol = find(DESC_HEADS, [nameCol, typeCol]);
  let body = rows.slice(1);
  if (nameCol < 0) {
    // No heading recognised: a single column of names, or the first column, with no heading row.
    nameCol = 0;
    body = rows;
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  const fields: TargetField[] = [];
  body.forEach((r, i) => {
    const name = (r[nameCol] ?? '').trim();
    if (!name) { problems.push(`Row ${i + 2} has no field name and was left out.`); return; }
    if (seen.has(name.toLowerCase())) { problems.push(`${q(name)} is listed more than once; the first is used.`); return; }
    seen.add(name.toLowerCase());
    fields.push({ name, ...(typeCol >= 0 && r[typeCol]?.trim() ? { type: r[typeCol].trim() } : {}), ...(descCol >= 0 && r[descCol]?.trim() ? { description: r[descCol].trim() } : {}) });
  });
  const cleaned = cleanTargetFields(fields.map((f) => ({ name: f.name.slice(0, 120), ...(f.type ? { type: f.type.slice(0, 60) } : {}), ...(f.description ? { description: f.description.replace(/[<>]/g, '').slice(0, 300) } : {}) })).filter((f) => !/[<>]/.test(f.name) && !/[<>]/.test(f.type ?? '')));
  if (cleaned.length < fields.length) problems.push(`${fields.length - cleaned.length} field${fields.length - cleaned.length === 1 ? ' was' : 's were'} left out because the name or type contains < or >.`);
  if (cleaned.length > 2000) problems.push('Only the first 2,000 fields are used.');
  const header = rows[0];
  const used = [nameCol, typeCol, descCol].filter((i) => i >= 0);
  const types = [...new Set(cleaned.map((f) => f.type).filter((t): t is string => !!t))].sort().map((type) => ({ type, readAs: targetTypeKind(type) }));
  return {
    fields: cleaned.slice(0, 2000),
    columns: body === rows ? { name: null, type: null, description: null } : { name: header[nameCol]?.trim() ?? null, type: typeCol >= 0 ? header[typeCol].trim() : null, description: descCol >= 0 ? header[descCol].trim() : null },
    ignored: body === rows ? [] : header.filter((_, i) => !used.includes(i)).map((h) => h.trim()).filter(Boolean),
    problems: problems.slice(0, 20),
    types,
  };
}

/* ------------------------------------------------------------------ the mapping as a file */

const DOC_DATE_NOTE = (project: Project) => (project.documentDate ? (project.documentDate.source === 'run' ? { source: 'run' } : { source: 'field', path: project.documentDate.path }) : null);

/**
 * The mapping as a file: what the release package writes as `data/mapping-<slug>.json` and the screen downloads. A
 * function of the project alone (no clock). Field rows are in data-dictionary order; examples come from the dictionary
 * (synthetic). Documented in docs/design/RELEASE_PACKAGE.md ("Additions for mappings").
 */
export function mappingFile(project: Project, mapping: TargetMapping, dict: DataDictionary = dataDictionary(project), check: MappingCheck = mappingChecks(project, mapping, dict)) {
  return {
    formatVersion: 1,
    mapping: { id: mapping.id, name: mapping.name, system: mapping.system, ...(mapping.description ? { description: mapping.description } : {}), ...(mapping.created ? { created: mapping.created } : {}), ...(mapping.changed ? { changed: mapping.changed } : {}) },
    document: { id: project.projectId, title: project.title, kind: project.documentType, kindLabel: DOCUMENT_TYPE_LABEL[project.documentType] },
    complete: check.complete,
    counts: check.counts,
    note: 'Each row is one field of the studio’s data dictionary (data/dictionary.json) and what the target system calls it. "target" is absent when the target does not need the field ("notNeeded" says why) or when no decision was made. Amounts in the studio are integer cents and dates ISO 8601; "target.format" says how the target writes them. Calculated fields are worked out by the studio: the target must supply or compute them. Examples are synthetic.',
    typeRules: 'Text and choices go to text; amounts in whole cents to a whole-number, money, decimal or number field; whole numbers to a number field; dates to a date or date-and-time field; yes-or-no to yes-or-no; a list to a list.',
    targetFields: mapping.targetFields ?? [],
    fields: check.rows.map((r) => ({
      path: r.path, label: r.label, type: r.type, format: r.format,
      ...(r.list ? { list: r.list } : {}),
      calculated: r.calculated, needed: r.needed, required: r.required, status: r.status,
      example: r.example ?? null,
      ...(r.entry?.target ? { target: { name: r.entry.target, ...(r.targetType ? { type: r.targetType, typeReadAs: r.targetKind } : {}), ...(r.entry.format ? { format: r.entry.format } : {}) } } : {}),
      ...(r.entry?.notNeeded ? { notNeeded: { reason: r.entry.notNeeded.reason } } : {}),
      ...(r.entry?.note ? { note: r.entry.note } : {}),
      ...(r.clash ? { typeClash: r.clash } : {}),
    })),
    calculated: check.calculated.map((c) => ({ ...c, targetMust: 'supply or compute this' })),
    lookupTables: check.lookupTables,
    documentDate: DOC_DATE_NOTE(project),
    findings: check.findings.map((f) => ({ kind: f.kind, severity: f.severity, paths: f.paths, message: f.message })),
  };
}

const csvCell = (v: unknown): string => { const t = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

/** The same mapping as a spreadsheet for people (CRLF rows, quoted cells where needed). */
export function mappingCsv(project: Project, mapping: TargetMapping, dict: DataDictionary = dataDictionary(project), check: MappingCheck = mappingChecks(project, mapping, dict)): string {
  const head = ['path', 'label', 'type', 'calculated', 'required', 'status', 'target', 'targetType', 'format', 'notNeededReason', 'note', 'example'];
  const lines = check.rows.map((r) => [r.path, r.label, r.type, r.calculated ? 'yes' : 'no', r.required ? 'yes' : 'no', r.status, r.entry?.target ?? '', r.targetType ?? '', r.entry?.format ?? '', r.entry?.notNeeded?.reason ?? '', r.entry?.note ?? '', r.example ?? ''].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

/** The file names of a document's mappings, `mapping-<slug>` (a repeated name gets `-2`…). */
export function mappingFileNames(mappings: ReadonlyArray<Pick<TargetMapping, 'id' | 'name'>>): Map<string, string> {
  return new Map([...mappingSlugs(mappings)].map(([id, slug]) => [id, `mapping-${slug}`]));
}
