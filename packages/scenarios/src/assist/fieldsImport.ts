import {
  CUSTOM_FIELD_KEY, DOCUMENT_TYPE_LABEL, fieldsFor, parseCsv, validateCustomFields,
  type Command, type CustomField, type Project,
} from '@iss/model';

/**
 * "Import fields…" (wave 3, section 4): create or extend a document's own data fields from a data dictionary (CSV:
 * name, type, description, example; header variants tolerated). Pure: it proposes fields with their types checked,
 * finds clashes with existing fields, and gives ONE command (`SET_CUSTOM_FIELDS` with the existing fields and the new
 * ones) for the screen to apply as one undoable step. Examples can make one synthetic customer (`exampleCustomer`),
 * which the screen adds through the existing customer route. Only documents with their own data ("Your own data"):
 * the built-in kinds have fixed fields, and this says so.
 */

export const FIELDS_IMPORT_MAX = 200;

type OwnType = Exclude<CustomField['type'], 'list'>;
export interface ProposedField {
  /** Line in the file (the heading is line 1). */
  line: number;
  name: string;
  description: string | null;
  /** The type as written in the file. */
  typeWritten: string;
  /** What the studio reads it as, and why when it is not obvious. */
  type: OwnType;
  typeNote: string | null;
  field: CustomField;
  /** The example as a value of the field (null when none, or when it does not fit; `exampleProblem` says why). */
  example: string | number | boolean | null;
  exampleProblem: string | null;
  /** Why it is not added (a clash or a problem), or null when it is. */
  skip: string | null;
}

export interface FieldsImportPlan {
  /** Why the import is not offered for this document (null when it is). */
  refused: string | null;
  columns: { name: string | null; label: string | null; type: string | null; description: string | null; example: string | null; required: string | null };
  ignored: string[];
  problems: string[];
  proposals: ProposedField[];
  /** The full list of data fields after the import (existing first, then the new ones). */
  fields: CustomField[];
  command: Command | null;
  label: string;
  /** One synthetic customer from the examples (all fields with an example), or null with the reason. */
  exampleCustomer: { record: { customer: { givenName: string; familyName: string; locale: string }; custom: Record<string, unknown> } } | null;
  exampleCustomerNote: string;
}

/** Why a document cannot import a field list (null when it can). Plain words for the screen. */
export function fieldsImportRefusal(project: Pick<Project, 'documentType'>): string | null {
  if (project.documentType === 'custom') return null;
  return `This document is a ${DOCUMENT_TYPE_LABEL[project.documentType].toLowerCase()}: its data fields are the studio’s built-in ones, fixed so that its sample customers and rules keep working. Importing a field list is offered for documents with their own data (“${DOCUMENT_TYPE_LABEL.custom}”).`;
}

const HEADS = {
  name: ['name', 'field', 'field name', 'fieldname', 'key', 'field key', 'column', 'column name', 'element', 'attribute', 'variable', 'path', 'id'],
  label: ['label', 'display name', 'caption', 'title', 'friendly name'],
  type: ['type', 'data type', 'datatype', 'field type', 'fieldtype', 'format', 'kind'],
  description: ['description', 'desc', 'meaning', 'definition', 'comment', 'comments', 'notes', 'note'],
  example: ['example', 'sample', 'example value', 'sample value', 'e.g.', 'eg', 'test value', 'value'],
  required: ['required', 'mandatory', 'is required', 'optional?'],
} as const;
const norm = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** The kind of value a written type means. Unrecognised types are read as text, and the note says so. */
export function ownTypeOf(written: string): { type: OwnType; note: string | null; enumValues?: string[]; list?: true } {
  const t = written.trim();
  const low = t.toLowerCase();
  if (!t) return { type: 'string', note: 'No type was given: read as text.' };
  const values = /^(?:enum|choice|one of|picklist|options?)\s*[:(]?\s*(.+?)\)?$/i.exec(t)?.[1];
  if (/^(enum|choice|one of|picklist|options?)\b/i.test(low)) {
    const list = (values ?? '').split(/[|,;/]/).map((v) => v.trim()).filter(Boolean);
    return list.length ? { type: 'enum', note: null, enumValues: [...new Set(list)] } : { type: 'string', note: `“${t}” is a choice, but no values were listed (write them as “choice: a|b|c”): read as text.` };
  }
  const word = low.replace(/\(.*$/, '').trim().split(/[\s_-]+/)[0] ?? '';
  const size = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(low);
  if (['amount', 'money', 'currency', 'cents', 'price', 'smallmoney'].includes(word)) return { type: 'cents', note: word === 'cents' ? null : `“${t}” is read as an amount, stored in whole cents.` };
  if (['decimal', 'numeric'].includes(word) && size && Number(size[1]) === 2) return { type: 'cents', note: `“${t}” has two decimals: read as an amount, stored in whole cents.` };
  if (['int', 'integer', 'bigint', 'smallint', 'long', 'whole', 'count', 'number', 'num'].includes(word)) return { type: 'int', note: word === 'number' || word === 'num' ? `“${t}” is read as a whole number.` : null };
  if (['decimal', 'numeric', 'float', 'double', 'real'].includes(word)) return { type: 'int', note: `“${t}” may have decimals; the studio’s own fields hold whole numbers, so it is read as a whole number. For money, use the type “amount”.` };
  if (['date'].includes(word)) return { type: 'date', note: null };
  if (['datetime', 'timestamp'].includes(word) || /^date[\s_-]*time/.test(low)) return { type: 'date', note: `“${t}” is read as a date (the time of day is not kept).` };
  if (['bool', 'boolean', 'bit', 'flag', 'yes/no', 'yesno', 'logical'].includes(word)) return { type: 'bool', note: null };
  if (['text', 'string', 'str', 'varchar', 'nvarchar', 'char', 'character', 'alphanumeric', 'clob', 'memo'].includes(word)) return { type: 'string', note: null };
  if (['list', 'array', 'table', 'collection', 'repeating'].includes(word)) return { type: 'string', note: `“${t}” is a list: a list needs its columns, so add it by hand in the data fields editor. It is not added.`, list: true };
  return { type: 'string', note: `“${t}” is not a type the studio knows: read as text.` };
}

const humanise = (name: string): string => {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
};
const camel = (label: string): string => {
  const words = label.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const s = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  return /^[a-zA-Z]/.test(s) ? s.slice(0, 40) : '';
};

/** The example as a value of the field's type (cents, whole numbers, yes/no, an ISO day, a choice), or why it does not fit. */
export function exampleValue(type: OwnType, raw: string, enumValues?: string[]): { value: string | number | boolean | null; problem: string | null; stored: string | null } {
  const v = raw.trim();
  if (!v) return { value: null, problem: null, stored: null };
  switch (type) {
    case 'cents': {
      if (/^-?\d+$/.test(v)) return { value: Number(v), problem: null, stored: v };
      const plain = v.replace(/[$€£,\s]/g, '');
      if (/^-?\d+(\.\d{1,2})?$/.test(plain)) { const cents = Math.round(Number(plain) * 100); return { value: cents, problem: `“${v}” was read as ${cents} cents.`, stored: String(cents) }; }
      return { value: null, problem: `The example “${v}” is not an amount.`, stored: null };
    }
    case 'int': return /^-?\d+$/.test(v) ? { value: Number(v), problem: null, stored: v } : { value: null, problem: `The example “${v}” is not a whole number.`, stored: null };
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(v);
      if (!m) return { value: null, problem: `The example “${v}” is not a date written as YYYY-MM-DD.`, stored: null };
      const day = `${m[1]}-${m[2]}-${m[3]}`;
      const d = new Date(`${day}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return { value: null, problem: `The example “${v}” is not a real date.`, stored: null };
      return { value: day, problem: day === v ? null : `“${v}” was read as the date ${day}.`, stored: day };
    }
    case 'bool': {
      if (/^(true|yes|y|1)$/i.test(v)) return { value: true, problem: null, stored: 'true' };
      if (/^(false|no|n|0)$/i.test(v)) return { value: false, problem: null, stored: 'false' };
      return { value: null, problem: `The example “${v}” is not yes or no.`, stored: null };
    }
    case 'enum': return enumValues?.includes(v) ? { value: v, problem: null, stored: v } : { value: null, problem: `The example “${v}” is not one of the choices (${(enumValues ?? []).join(', ')}).`, stored: null };
    default: return { value: v.slice(0, 200), problem: v.length > 200 ? 'The example was shortened to 200 characters.' : null, stored: v.slice(0, 200) };
  }
}

export function planFieldsImport(project: Project, text: string): FieldsImportPlan {
  const columns: FieldsImportPlan['columns'] = { name: null, label: null, type: null, description: null, example: null, required: null };
  const base: FieldsImportPlan = { refused: fieldsImportRefusal(project), columns, ignored: [], problems: [], proposals: [], fields: project.customFields ?? [], command: null, label: '', exampleCustomer: null, exampleCustomerNote: '' };
  if (base.refused) return base;
  const rows = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return { ...base, problems: ['The file is empty.'] };
  const head = rows[0].map(norm);
  const used = new Set<number>();
  const col = (names: readonly string[]): number => { for (const n of names) { const i = head.findIndex((h, j) => !used.has(j) && (h === n || h.replace(/ /g, '') === n.replace(/ /g, ''))); if (i >= 0) { used.add(i); return i; } } return -1; };
  const nameCol = col(HEADS.name), labelCol = col(HEADS.label), typeCol = col(HEADS.type), descCol = col(HEADS.description), exCol = col(HEADS.example), reqCol = col(HEADS.required);
  const original = rows[0].map((h) => h.replace(/^﻿/, '').trim());
  if (nameCol < 0 && labelCol < 0) return { ...base, problems: [`No column was recognised as the field name. Use a heading such as “name”. Headings found: ${original.join(', ') || 'none'}.`] };
  const at = (i: number) => (i >= 0 ? original[i] : null);
  Object.assign(columns, { name: at(nameCol), label: at(labelCol), type: at(typeCol), description: at(descCol), example: at(exCol), required: at(reqCol) });
  const ignored = original.filter((_, i) => !used.has(i) && original[i]);
  const problems: string[] = [];
  if (typeCol < 0) problems.push('No type column was found: every field is read as text.');
  const body = rows.slice(1);
  if (body.length > FIELDS_IMPORT_MAX) problems.push(`Only the first ${FIELDS_IMPORT_MAX} fields are read.`);

  const existing = project.customFields ?? [];
  const takenKeys = new Map(existing.map((f) => [f.key.toLowerCase(), f.label]));
  const takenLabels = new Map(existing.map((f) => [f.label.trim().toLowerCase(), f.label]));
  const standard = new Map(fieldsFor(project.documentType).map((f) => [f.label.toLowerCase(), f.label]));
  const proposals: ProposedField[] = [];
  body.slice(0, FIELDS_IMPORT_MAX).forEach((r, i) => {
    const line = i + 2;
    const rawName = (nameCol >= 0 ? r[nameCol] : r[labelCol])?.trim() ?? '';
    const rawLabel = labelCol >= 0 ? r[labelCol]?.trim() ?? '' : '';
    const description = descCol >= 0 && r[descCol]?.trim() ? r[descCol].trim().slice(0, 300) : null;
    const typeWritten = typeCol >= 0 ? r[typeCol]?.trim() ?? '' : '';
    const label = (rawLabel || (/[\s]/.test(rawName) ? rawName : humanise(rawName))).replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = camel(nameCol >= 0 && !/\s/.test(rawName) ? humanise(rawName) : label);
    const t = ownTypeOf(typeWritten);
    const field: CustomField = { key, label, type: t.type, ...(t.enumValues ? { enumValues: t.enumValues } : {}) };
    if (reqCol >= 0 && /^(yes|y|true|1|required|mandatory)$/i.test(r[reqCol]?.trim() ?? '')) field.required = true;
    const ex = exampleValue(t.type, exCol >= 0 ? r[exCol] ?? '' : '', t.enumValues);
    if (ex.stored !== null) field.example = ex.stored;
    let skip: string | null = null;
    if (!rawName && !rawLabel) skip = 'The row has no field name.';
    else if (t.list) skip = 'A list needs its columns: add it by hand in the data fields editor.';
    else if (!key || !CUSTOM_FIELD_KEY.test(key)) skip = `“${rawName || rawLabel}” cannot be made into a field name (it must start with a letter).`;
    else if (takenKeys.has(key.toLowerCase())) skip = `It clashes with the existing field “${takenKeys.get(key.toLowerCase())}” (same name).`;
    else if (takenLabels.has(label.toLowerCase())) skip = `It clashes with the existing field “${takenLabels.get(label.toLowerCase())}” (same label).`;
    else if (standard.has(label.toLowerCase())) skip = `“${label}” is already one of the customer fields every document has.`;
    else {
      const errs = validateCustomFields(project.documentType, [field]);
      if (errs.length) skip = errs[0];
    }
    if (!skip) { takenKeys.set(key.toLowerCase(), label); takenLabels.set(label.toLowerCase(), label); }
    proposals.push({ line, name: rawName || rawLabel, description, typeWritten, type: t.type, typeNote: t.note, field, example: ex.value, exampleProblem: ex.problem, skip });
  });

  const added = proposals.filter((p) => !p.skip).map((p) => p.field);
  const fields = [...existing, ...added];
  const errs = added.length ? validateCustomFields(project.documentType, fields) : [];
  if (errs.length) problems.push(...errs.slice(0, 3));
  const label = `Import ${added.length} data field${added.length === 1 ? '' : 's'}`;
  const command: Command | null = added.length && !errs.length ? { type: 'SET_CUSTOM_FIELDS', fields } : null;

  // One synthetic customer from the examples: every field with an example; a required field without one stops it.
  const custom: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'list' || f.example === undefined) continue;
    const v = exampleValue(f.type, f.example, f.enumValues);
    if (v.value !== null) custom[f.key] = v.value;
  }
  const missing = fields.filter((f) => f.required && f.type !== 'list' && custom[f.key] === undefined).map((f) => f.label);
  const exampleCustomer = command && Object.keys(custom).length && !missing.length ? { record: { customer: { givenName: 'Example', familyName: 'Customer', locale: 'en-US' }, custom } } : null;
  const exampleCustomerNote = !command ? 'Nothing to add yet.'
    : missing.length ? `A customer from the examples cannot be made: ${missing.slice(0, 3).map((m) => `“${m}”`).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''} ${missing.length === 1 ? 'is' : 'are'} required and ${missing.length === 1 ? 'has' : 'have'} no example.`
      : !Object.keys(custom).length ? 'No field has an example, so no customer can be made from them.'
        : `One synthetic customer, “Example Customer”, with the examples of ${Object.keys(custom).length} field${Object.keys(custom).length === 1 ? '' : 's'}.`;
  return { ...base, columns, ignored, problems, proposals, fields, command, label, exampleCustomer, exampleCustomerNote };
}
