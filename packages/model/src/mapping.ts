import { projectFields, type FieldType } from './fields';
import type { MappingEntry, MappingStamp, Project, TargetField, TargetMapping } from './types';

/**
 * Mapping a document's data fields to the system that produces it (wave 3, section 3; decision D100). Neutral: no target
 * system is named, so a mapping is a named profile a person fills in or imports. Pure helpers only: the commands that
 * change a mapping are in `commands.ts` (`applyMappingCommand`), the checks in `@iss/scenarios` (`mappingChecks`).
 */

export const MAPPINGS_MAX = 20;
export const MAPPING_NAME_MAX = 80;
export const MAPPING_SYSTEM_MAX = 80;
export const MAPPING_DESCRIPTION_MAX = 300;
export const TARGET_FIELDS_MAX = 2000;
export const TARGET_NAME_MAX = 120;
export const TARGET_TYPE_MAX = 60;
export const TARGET_DESCRIPTION_MAX = 300;
export const MAPPING_NOTE_MAX = 300;
export const MAPPING_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** The path of a list's column in a mapping entry: `card.transactions[].amountCents`. */
export const LIST_COLUMN_MARK = '[].';

/** How the studio reads a target system's type, whatever words the target uses for it. */
export type TargetKind = 'text' | 'integer' | 'decimal' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'list' | 'unknown';
export const TARGET_KIND_LABEL: Record<TargetKind, string> = {
  text: 'text', integer: 'whole number', decimal: 'decimal number', number: 'number', money: 'money amount', date: 'date', datetime: 'date and time', boolean: 'yes or no', list: 'list', unknown: 'not recognised',
};

/** The words each kind is recognised by (the first word of the type, lower case, without sizes such as `(10,2)`). */
const KIND_WORDS: Array<[TargetKind, string[]]> = [
  ['list', ['list', 'array', 'table', 'collection', 'repeating', 'repeat', 'group', 'rows', 'occurs', 'sequence', 'set']],
  ['datetime', ['datetime', 'timestamp', 'datetime2', 'datetimeoffset', 'instant', 'smalldatetime']],
  ['date', ['date', 'day']],
  ['boolean', ['boolean', 'bool', 'bit', 'flag', 'yesno', 'yes/no', 'logical', 'indicator']],
  ['money', ['money', 'currency', 'amount', 'smallmoney']],
  ['integer', ['integer', 'int', 'bigint', 'smallint', 'tinyint', 'long', 'short', 'int32', 'int64', 'whole', 'count', 'cents', 'serial']],
  ['decimal', ['decimal', 'numeric', 'dec', 'float', 'double', 'real', 'float64', 'float32', 'single']],
  ['number', ['number', 'num', 'numerical']],
  ['text', ['text', 'string', 'str', 'varchar', 'varchar2', 'nvarchar', 'nvarchar2', 'char', 'nchar', 'character', 'clob', 'nclob', 'alphanumeric', 'alpha', 'enum', 'code', 'choice', 'picklist', 'xs:string', 'uuid', 'guid', 'email', 'phone']],
];

/**
 * The kind a target type is read as. Type names are matched on their first word, ignoring case, sizes (`VARCHAR(40)`)
 * and an XML-schema prefix (`xs:date`); `NUMBER(10,2)` and `NUMERIC(…,n>0)` are decimals, `NUMBER(10)` a whole number.
 * An empty or unrecognised type is `unknown` (never a clash).
 */
export function targetTypeKind(raw: string | undefined): TargetKind {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return 'unknown';
  const size = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(t);
  const base = t.replace(/\(.*$/, '').trim().replace(/^(xs|xsd):/, '');
  if (/\[\]$/.test(base)) return 'list';
  if (/^date[\s_-]*time/.test(base)) return 'datetime';
  const word = base.split(/[\s_-]+/)[0] ?? '';
  if ((word === 'number' || word === 'numeric' || word === 'decimal') && size) return size[2] !== undefined && Number(size[2]) > 0 ? 'decimal' : word === 'number' ? 'integer' : 'decimal';
  for (const [kind, words] of KIND_WORDS) if (words.includes(word)) return kind;
  return 'unknown';
}

/** Target kinds each type of document field agrees with. Everything else is a type clash. */
const AGREES: Record<FieldType, TargetKind[]> = {
  string: ['text'],
  enum: ['text'],
  cents: ['integer', 'money', 'decimal', 'number'],
  int: ['integer', 'number', 'decimal'],
  points: ['integer', 'number', 'decimal'],
  number: ['number', 'decimal'],
  date: ['date', 'datetime'],
  bool: ['boolean'],
  array: ['list'],
};
const DOC_WORDS: Record<FieldType, string> = {
  string: 'Text', enum: 'A choice of fixed values', cents: 'An amount in whole cents', int: 'A whole number', points: 'A whole number of points', number: 'A number', date: 'A date', bool: 'A yes-or-no value', array: 'A list',
};
const TARGET_WORDS: Record<TargetKind, string> = {
  text: 'a text field', integer: 'a whole-number field', decimal: 'a decimal field', number: 'a number field', money: 'a money field', date: 'a date field', datetime: 'a date-and-time field', boolean: 'a yes-or-no field', list: 'a list', unknown: 'a field of an unrecognised type',
};

/**
 * The rule set for types, in plain words, for the screen and the documentation. A clash is a document field whose type
 * the target's type cannot carry without a conversion the mapping does not describe.
 */
export const TYPE_RULES: string[] = [
  'Text and choices go to a text field.',
  'An amount in whole cents goes to a whole-number, money, decimal or number field (never text, a date or yes-or-no). Say in the format note whether the target expects cents or dollars.',
  'A whole number or points go to a whole-number, number or decimal field.',
  'A date goes to a date or date-and-time field (never a number or text).',
  'A yes-or-no value goes to a yes-or-no field.',
  'A list goes to a list, and a single value never goes to a list.',
  'A target type the studio does not recognise is never a clash; it is shown as not recognised.',
];

/** Why a document field of this type cannot go to a target of this kind, or null when they agree. */
export function typeClash(docType: FieldType, target: TargetKind): string | null {
  if (target === 'unknown') return null;
  if (AGREES[docType]?.includes(target)) return null;
  if (docType !== 'array' && target === 'list') return `A single value is mapped to a list.`;
  if (docType === 'array') return `A list is mapped to a single value (${TARGET_WORDS[target]}).`;
  return `${DOC_WORDS[docType] ?? 'This value'} is mapped to ${TARGET_WORDS[target]}.`;
}

/** Whether `path` is a list column path (`<list path>[].<column key>`), and its parts. */
export function listColumnOf(path: string): { list: string; column: string } | null {
  const i = path.indexOf(LIST_COLUMN_MARK);
  return i > 0 ? { list: path.slice(0, i), column: path.slice(i + LIST_COLUMN_MARK.length) } : null;
}

/** Every path a mapping entry may name in this document, with its type: each data field, and each column of each list. */
export function mappablePaths(project: Pick<Project, 'documentType' | 'customFields' | 'calculatedFields' | 'documentDate'>): Map<string, { type: FieldType; label: string }> {
  const out = new Map<string, { type: FieldType; label: string }>();
  for (const f of projectFields(project)) {
    out.set(f.path, { type: f.type, label: f.label });
    for (const c of f.itemFields ?? []) out.set(`${f.path}${LIST_COLUMN_MARK}${c.key}`, { type: c.type, label: `${f.label} · ${c.label}` });
  }
  return out;
}

const str = (v: unknown): v is string => typeof v === 'string';
const isoTime = (v: unknown): boolean => str(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function textProblem(v: unknown, what: string, max: number, required: boolean): string | null {
  if (v === undefined || v === null) return required ? `${what} is required.` : null;
  if (!str(v)) return `${what} must be text.`;
  if (required && !v.trim()) return `${what} is required.`;
  if (v.length > max) return `${what} is limited to ${max} characters.`;
  if (CONTROL.test(v)) return `${what} contains characters that cannot be stored.`;
  if (/[<>]/.test(v)) return `${what} cannot contain < or >.`;
  return null;
}

export function stampProblem(s: unknown): string | null {
  if (s === undefined) return null;
  if (!s || typeof s !== 'object') return 'Who changed the mapping, and when, cannot be read.';
  const x = s as MappingStamp;
  return textProblem(x.by, 'The name of who changed it', 80, true) ?? (isoTime(x.at) ? null : 'When it was changed must be a UTC time (YYYY-MM-DDTHH:MM:SSZ).');
}

/** Problems with a target field list (empty = fine). Names are unique ignoring case. */
export function targetFieldsProblems(fields: unknown): string[] {
  if (!Array.isArray(fields)) return ['The target field list cannot be read.'];
  if (fields.length > TARGET_FIELDS_MAX) return [`A target field list can have at most ${TARGET_FIELDS_MAX} fields.`];
  const out: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f: TargetField, i) => {
    if (!f || typeof f !== 'object') { out.push(`Target field ${i + 1} cannot be read.`); return; }
    const p = textProblem(f.name, `The name of target field ${i + 1}`, TARGET_NAME_MAX, true) ?? textProblem(f.type, `The type of “${f.name}”`, TARGET_TYPE_MAX, false) ?? textProblem(f.description, `The description of “${f.name}”`, TARGET_DESCRIPTION_MAX, false);
    if (p) { out.push(p); return; }
    const k = clean(f.name).toLowerCase();
    if (seen.has(k)) out.push(`The target field “${clean(f.name)}” is listed twice.`);
    seen.add(k);
  });
  return out.slice(0, 10);
}

const PATH_SHAPE = /^[A-Za-z][A-Za-z0-9_.]{0,150}(\[\]\.[A-Za-z][A-Za-z0-9_]{0,40})?$/;

/**
 * Problems with one entry (null = fine). With `paths` (the commands), the entry must name a field the document has now.
 * Without (a stored or imported project), only its shape is checked: a field removed since is reported by the checks as
 * an entry to clear, so removing a data field never makes a document impossible to save.
 */
export function entryProblem(e: unknown, paths: Map<string, { type: FieldType; label: string }> | null): string | null {
  if (!e || typeof e !== 'object') return 'A mapping entry cannot be read.';
  const x = e as MappingEntry;
  if (!str(x.path) || !PATH_SHAPE.test(x.path)) return `A mapping entry names “${String(x.path).slice(0, 80)}”, which is not a field path.`;
  if (paths && !paths.has(x.path)) return `“${x.path}” is not a data field of this document.`;
  const name = paths?.get(x.path)?.label ?? x.path;
  const t = textProblem(x.target, `The target field for “${name}”`, TARGET_NAME_MAX, false) ?? textProblem(x.targetType, `The target type for “${name}”`, TARGET_TYPE_MAX, false)
    ?? textProblem(x.format, `The format note for “${name}”`, MAPPING_NOTE_MAX, false) ?? textProblem(x.note, `The note for “${name}”`, MAPPING_NOTE_MAX, false);
  if (t) return t;
  if (x.notNeeded !== undefined) {
    if (!x.notNeeded || typeof x.notNeeded !== 'object') return `Why “${name}” is not needed cannot be read.`;
    const r = textProblem(x.notNeeded.reason, `The reason “${name}” is not needed`, MAPPING_NOTE_MAX, true);
    if (r) return r;
    if (x.target?.trim()) return `“${name}” cannot both go to a target field and be not needed.`;
  }
  const extra = Object.keys(x).filter((k) => !['path', 'target', 'targetType', 'format', 'note', 'notNeeded'].includes(k));
  if (extra.length) return `A mapping entry has something the studio does not know (${extra[0].slice(0, 40)}).`;
  return null;
}

/** The entry with empty text left out (null when nothing is left: the entry is cleared). */
export function cleanEntry(e: MappingEntry): MappingEntry | null {
  const out: MappingEntry = { path: e.path };
  if (e.target?.trim()) out.target = clean(e.target);
  if (e.targetType?.trim()) out.targetType = clean(e.targetType);
  if (e.format?.trim()) out.format = e.format.trim();
  if (e.note?.trim()) out.note = e.note.trim();
  if (e.notNeeded) out.notNeeded = { reason: e.notNeeded.reason.trim() };
  return Object.keys(out).length > 1 ? out : null;
}

export function cleanTargetFields(fields: TargetField[]): TargetField[] {
  return fields.map((f) => ({ name: clean(f.name), ...(f.type?.trim() ? { type: clean(f.type) } : {}), ...(f.description?.trim() ? { description: clean(f.description) } : {}) }));
}

/**
 * Problems with a whole mapping (empty = fine): for mappings read from a file or sent by a client. Ids are unique across
 * `others`; every entry names a field of the document, once.
 */
export function mappingProblems(m: unknown, paths: Map<string, { type: FieldType; label: string }> | null = null): string[] {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['A mapping cannot be read.'];
  const x = m as TargetMapping;
  const out: string[] = [];
  if (!str(x.id) || !MAPPING_ID_PATTERN.test(x.id)) out.push('A mapping has no valid id (lower-case letters, digits and dashes).');
  const name = str(x.name) ? x.name.slice(0, 60) : 'a mapping';
  for (const p of [textProblem(x.name, 'The name of a mapping', MAPPING_NAME_MAX, true), textProblem(x.system, `The target system of “${name}”`, MAPPING_SYSTEM_MAX, true), textProblem(x.description, `The description of “${name}”`, MAPPING_DESCRIPTION_MAX, false), stampProblem(x.created), stampProblem(x.changed)]) if (p) out.push(p);
  if (x.targetFields !== undefined) out.push(...targetFieldsProblems(x.targetFields).map((p) => `“${name}”: ${p}`));
  if (!Array.isArray(x.entries)) out.push(`“${name}” has no list of entries.`);
  else {
    if (x.entries.length > 5000) out.push(`“${name}” has too many entries.`);
    const seen = new Set<string>();
    for (const e of x.entries.slice(0, 5000)) {
      const p = entryProblem(e, paths);
      if (p) { out.push(`“${name}”: ${p}`); continue; }
      if (seen.has(e.path)) out.push(`“${name}” decides on “${e.path}” twice.`);
      seen.add(e.path);
    }
  }
  const extra = Object.keys(x).filter((k) => !['id', 'name', 'system', 'description', 'created', 'changed', 'targetFields', 'entries'].includes(k));
  if (extra.length) out.push(`“${name}” has something the studio does not know (${extra[0].slice(0, 40)}).`);
  return out.slice(0, 10);
}

/** Problems with a project's whole list of mappings (for project files and drafts sent by a client). */
export function projectMappingProblems(p: { mappings?: unknown }): string[] {
  if (p.mappings === undefined) return [];
  if (!Array.isArray(p.mappings)) return ['The list of mappings cannot be read.'];
  if (p.mappings.length > MAPPINGS_MAX) return [`A document can have at most ${MAPPINGS_MAX} mappings.`];
  const out: string[] = [];
  const ids = new Set<string>();
  for (const m of p.mappings) {
    out.push(...mappingProblems(m));
    const id = (m as TargetMapping)?.id;
    if (str(id)) { if (ids.has(id)) out.push(`Two mappings share the id “${id}”.`); ids.add(id); }
  }
  return out.slice(0, 10);
}

/** A file-name part for a mapping: its name in lower case, letters and digits joined by dashes (at most 40). */
export function mappingSlug(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'mapping';
}

/** File-name parts for several mappings, in their order: a name that repeats gets `-2`, `-3`… */
export function mappingSlugs(mappings: ReadonlyArray<Pick<TargetMapping, 'id' | 'name'>>): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const m of mappings) {
    const base = mappingSlug(m.name);
    let s = base;
    for (let n = 2; used.has(s); n++) s = `${base}-${n}`;
    used.add(s);
    out.set(m.id, s);
  }
  return out;
}

/** "Mapping for <system>": the name a new mapping gets unless the person gives another. */
export const defaultMappingName = (system: string): string => `Mapping for ${clean(system)}`.slice(0, MAPPING_NAME_MAX);

/** A fresh id for a mapping that is not used in `existing` (deterministic for a given name and list). */
export function nextMappingId(existing: ReadonlyArray<Pick<TargetMapping, 'id'>>, name: string): string {
  const base = `map-${mappingSlug(name).slice(0, 30)}`.replace(/-+$/, '');
  const ids = new Set(existing.map((m) => m.id));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return id;
}
