import {
  AVAILABLE_LANGUAGES, SOURCE_LANGUAGE, amountToCents, centsToAmount, checkSetupSpec, customFieldDefs, isSupportedLanguage, languageShortName, parseCsv, projectFieldIndex, validateRecordShape,
  type CustomField, type Project, type SetupColumn, type SetupColumnType, type SetupField, type SetupFieldType, type SetupSection, type SetupSpec,
} from '@iss/model';
import { matchColumns } from './importMapping';

/**
 * Setting a new document up from a person's own sample data, without a model: read the file, guess a data field for
 * every column from its name and its values, and lay out a simple page. Also the other direction: turn the same rows
 * into customer records for a project whose fields are already decided (by the built-in reader, a model or a person).
 *
 * Everything here is pure and deterministic. Every guess is reported in plain words, and nothing is stored.
 */

/** One row of sample data: a flat object. A value is a text, a number, yes/no, or (a list) an array of flat objects. */
export type SampleRow = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const q = (s: string): string => `“${s}”`;
const listOf = (items: string[], max = 6): string => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/* ------------------------------------------------------------------ reading a file */

/** Nested objects become dotted column names (`plan.name`); an array of objects stays a list of flat rows. */
function flatten(o: Record<string, unknown>, prefix: string, out: SampleRow, depth = 0): SampleRow {
  for (const [k, v] of Object.entries(o)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && depth < 3) flatten(v, name, out, depth + 1);
    else if (Array.isArray(v) && v.some(isObj)) out[name] = v.filter(isObj).map((row) => flatten(row, '', {}, 3));
    else out[name] = v;
  }
  return out;
}

/**
 * Reads supplied sample data: CSV text (a heading row, then one row per customer) or JSON (an array of objects, an
 * object holding one under `records`, `customers`, `rows` or `data`, or one object). Never throws.
 */
export function readSampleData(format: unknown, data: unknown): { rows: SampleRow[] } | { error: string } {
  if (format === 'csv') {
    if (typeof data !== 'string') return { error: 'A CSV file is expected as text.' };
    const cells = parseCsv(data);
    if (cells.length < 2) return { error: 'The CSV file needs a heading row and at least one row of data.' };
    const header = cells[0].map((h) => h.trim().replace(/^﻿/, ''));
    if (!header.some(Boolean)) return { error: 'The first row of the CSV file has no column headings.' };
    return { rows: cells.slice(1).map((row) => { const o: SampleRow = {}; header.forEach((h, i) => { if (h) o[h] = row[i] ?? ''; }); return o; }) };
  }
  if (format !== 'json') return { error: 'The sample data must be CSV or JSON.' };
  let parsed = data;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { return { error: 'The file is not valid JSON.' }; } }
  if (isObj(parsed)) {
    const inner = ['records', 'customers', 'rows', 'data'].map((k) => (parsed as Record<string, unknown>)[k]).find(Array.isArray);
    parsed = inner ?? [parsed];
  }
  if (!Array.isArray(parsed)) return { error: 'The JSON file must hold a list of customers (an array of objects).' };
  const rows = parsed.filter(isObj).map((o) => flatten(o, '', {}));
  if (!rows.length) return { error: 'No customers were found in the file.' };
  return { rows };
}

/* ------------------------------------------------------------------ names */

/** The words of a column name: `monthly_fee`, `monthlyFee`, `plan.name` and "Monthly Fee" all split the same way. */
function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
const squash = (s: string): string => words(s).join('');
/** Leading words that only say whose name or language it is ("customer first name", "member.language"). */
const SCOPE = new Set(['customer', 'member', 'client', 'user', 'recipient', 'subscriber', 'account', 'contact']);
const UPPER = new Set(['id', 'url', 'vat', 'iban', 'sms', 'pin']);

/** What a person would call the column: "monthlyFeeCents" → "Monthly fee", "plan.name" → "Plan name", "memberId" → "Member ID". */
export function columnLabel(column: string): string {
  let w = words(column);
  if (w.length > 1 && w[w.length - 1] === 'cents') w = w.slice(0, -1);
  const text = w.map((x) => (UPPER.has(x) ? x.toUpperCase() : x)).join(' ');
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 60) || 'Field';
}

const FIRST = new Set(['firstname', 'givenname', 'forename', 'fname']);
const LAST = new Set(['lastname', 'familyname', 'surname', 'lname']);
const FULL = new Set(['name', 'fullname']);
const LANGUAGE = new Set(['language', 'lang', 'locale', 'preferredlanguage', 'preferredlocale']);
const SOURCE_ID = new Set(['recordid', 'sourceid']);
type CustomerRole = 'firstName' | 'lastName' | 'fullName' | 'language' | 'sourceId';
function customerRole(column: string): CustomerRole | null {
  const w = words(column);
  const s = (w.length > 1 && SCOPE.has(w[0]) ? w.slice(1) : w).join('');
  return FIRST.has(s) ? 'firstName' : LAST.has(s) ? 'lastName' : FULL.has(s) ? 'fullName' : LANGUAGE.has(s) ? 'language' : SOURCE_ID.has(s) ? 'sourceId' : null;
}
const ROLE_LABEL: Record<CustomerRole, string> = { firstName: 'First name', lastName: 'Last name', fullName: 'First and last name', language: 'Language', sourceId: 'Your own record ID' };

/** The head word of a name says it is money: "monthly fee", "amount due", "balance" (but not "total visits"). */
const MONEY = new Set(['fee', 'fees', 'amount', 'price', 'cost', 'costs', 'total', 'subtotal', 'balance', 'due', 'paid', 'owed', 'charge', 'charges', 'premium', 'salary', 'wage', 'deposit', 'refund', 'discount', 'tax', 'rent', 'payment', 'payout', 'credit', 'debit', 'income', 'revenue', 'bill']);
/** A name that identifies something is kept as text even when it is all digits. */
const IDENTIFIER = new Set(['id', 'number', 'no', 'nr', 'code', 'zip', 'postcode', 'phone', 'mobile', 'ref', 'reference', 'account', 'iban']);
const saysCents = (column: string): boolean => /cents?$/i.test(column.replace(/[^A-Za-z]+$/, ''));
const moneyName = (column: string): boolean => { const w = words(column).filter((x) => x !== 'cents' && x !== 'cent'); return w.length > 0 && MONEY.has(w[w.length - 1]); };
const identifierName = (column: string): boolean => { const w = words(column); return w.length > 0 && (IDENTIFIER.has(w[w.length - 1]) || w[0] === 'id'); };

/* ------------------------------------------------------------------ values */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.+\-Z]*)?$/;
function isoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = ISO_DATE.exec(v.trim());
  if (!m) return null;
  const mo = Number(m[2]), d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : typeof v === 'string' && /^(true|yes|y)$/i.test(v.trim()) ? true : typeof v === 'string' && /^(false|no|n)$/i.test(v.trim()) ? false : null);
const asInt = (v: unknown): number | null => (typeof v === 'number' ? (Number.isInteger(v) ? v : null) : typeof v === 'string' && /^-?\d{1,13}$/.test(v.trim()) ? Number(v.trim()) : null);
const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const hasCurrencySign = (v: unknown): boolean => typeof v === 'string' && /[$€£]/.test(v);
const hasDecimals = (v: unknown): boolean => (typeof v === 'number' ? !Number.isInteger(v) : typeof v === 'string' && /\.\d/.test(v));

/**
 * How the amounts of one column are written. Whole cents only when the column name says so ("feeCents") and every
 * value is a whole number; otherwise currency units, with or without decimals (49 and 49.00 are both $49.00).
 */
export type AmountUnit = 'cents' | 'units';
const amountUnit = (column: string, values: unknown[]): AmountUnit => (saysCents(column) && values.every((v) => empty(v) || asInt(v) !== null) ? 'cents' : 'units');
const centsOf = (v: unknown, unit: AmountUnit): number | null => (unit === 'cents' ? asInt(v) : amountToCents(typeof v === 'string' ? v.trim() : v));

/** The studio's language code for what a file calls a language ("es", "es-us", "Spanish"), or null. */
function localeOf(v: unknown): string | null {
  const s = asText(v).toLowerCase().replace(/_/g, '-');
  if (!s) return null;
  const codes = [SOURCE_LANGUAGE, ...AVAILABLE_LANGUAGES.map((l) => l.code)];
  const exact = codes.find((c) => c.toLowerCase() === s);
  if (exact) return exact;
  const byLanguage = codes.filter((c) => c.toLowerCase().startsWith(`${s}-`) || languageShortName(c).toLowerCase() === s);
  return byLanguage.find((c) => c.endsWith('-US')) ?? byLanguage[0] ?? null;
}

/* ------------------------------------------------------------------ what each column is */

interface Guess { type: SetupFieldType; choices?: string[]; unit?: AmountUnit; example?: string; why?: string }

function guessScalar(column: string, values: unknown[]): Guess {
  const present = values.filter((v) => !empty(v));
  const label = columnLabel(column);
  if (!present.length) return { type: 'text', why: `${q(label)} has no values in the data, so it is set up as text.` };
  if (present.every((v) => asBool(v) !== null)) return { type: 'yesNo', example: asBool(present[0]) ? 'yes' : 'no' };
  if (present.every((v) => isoDate(v) !== null)) return { type: 'date', example: isoDate(present[0])! };
  const numeric = present.every((v) => (typeof v === 'number' ? Number.isFinite(v) : amountToCents(asText(v)) !== null));
  if (numeric && !identifierName(column)) {
    const unit = amountUnit(column, present);
    const signs = present.some(hasCurrencySign);
    // Money is written with two decimals: 12.50, 3.99 (a rating such as 4.5 is not).
    const twoPlaces = present.some((v) => /\.\d{2}$/.test(asText(v))) && present.every((v) => !hasDecimals(v) || /\.\d{1,2}$/.test(asText(v)));
    if (unit === 'cents') {
      const c = asInt(present[0])!;
      return { type: 'amount', unit, example: centsToAmount(c), why: `${q(label)} is read as an amount in whole cents, because the column name says cents (${asText(present[0])} is $${centsToAmount(c)}).` };
    }
    if (signs || moneyName(column) || twoPlaces) {
      const c = amountToCents(typeof present[0] === 'string' ? present[0].trim() : present[0]);
      if (c !== null && present.every((v) => amountToCents(typeof v === 'string' ? v.trim() : v) !== null)) {
        const reason = signs ? 'its values carry a currency sign' : moneyName(column) ? 'its name says money' : 'its values have two decimals';
        return { type: 'amount', unit: 'units', example: centsToAmount(c), why: `${q(label)} is read as an amount in dollars, not cents, because ${reason} (${asText(present[0])} is $${centsToAmount(c)}). If the values are whole cents, end the column name with “cents”.` };
      }
    }
    if (present.every((v) => asInt(v) !== null)) return { type: 'number', example: String(asInt(present[0])) };
    return { type: 'text', example: asText(present[0]).slice(0, 80), why: `${q(label)} holds numbers with decimals that do not look like money. A number field holds whole numbers only, so it is set up as text.` };
  }
  const texts = present.map(asText);
  const distinct = [...new Set(texts)];
  if (!identifierName(column) && distinct.length >= 2 && distinct.length <= 8 && distinct.length < texts.length && distinct.every((t) => t.length <= 30)) {
    return { type: 'choice', choices: distinct, example: texts[0], why: `${q(label)} has ${distinct.length} different values in the data (${listOf(distinct)}), so it is set up as a choice.` };
  }
  return { type: 'text', example: texts[0].slice(0, 80), ...(numeric ? { why: `${q(label)} looks like an identifier, so it is kept as text.` } : {}) };
}

interface Column { column: string; label: string; role: CustomerRole | 'field' | 'list' | 'ignored'; guess?: Guess; listColumns?: Array<{ column: string; label: string; type: SetupColumnType; unit?: AmountUnit }>; why?: string }

function describeColumns(rows: SampleRow[]): Column[] {
  const names: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
  const taken = new Set<CustomerRole>();
  return names.map((column): Column => {
    const values = rows.map((r) => r[column]);
    const label = columnLabel(column);
    if (values.some(Array.isArray)) {
      const items = values.flatMap((v) => (Array.isArray(v) ? v.filter(isObj) : []));
      if (!items.length) return { column, label, role: 'ignored', why: `${q(label)} holds plain lists of values, which a document cannot show, so it is left out.` };
      const keys: string[] = [];
      for (const it of items) for (const k of Object.keys(it)) if (!keys.includes(k)) keys.push(k);
      const listColumns = keys.slice(0, 8).map((k) => {
        const g = guessScalar(k, items.map((it) => it[k]));
        const type: SetupColumnType = g.type === 'amount' || g.type === 'date' || g.type === 'number' ? g.type : 'text';
        return { column: k, label: columnLabel(k), type, ...(g.unit ? { unit: g.unit } : {}) };
      });
      return { column, label, role: 'list', listColumns, ...(keys.length > 8 ? { why: `${q(label)} has ${keys.length} columns; a list can have 8, so only the first 8 are used.` } : {}) };
    }
    const role = customerRole(column);
    if (role && !taken.has(role)) { taken.add(role); return { column, label, role }; }
    return { column, label, role: 'field', guess: guessScalar(column, values) };
  });
}

/* ------------------------------------------------------------------ a setup from the data */

export interface SetupFromData { spec: SetupSpec; notes: string[] }

/** Which of the scalar fields are worth a place in the summary: amounts and dates first, free text last. */
const FIGURE_RANK: Record<SetupFieldType, number> = { amount: 0, date: 1, number: 2, choice: 3, yesNo: 4, text: 5, list: 9 };

/**
 * A document setup from sample data alone. Data fields come from the column names (or JSON keys) and their values; the
 * columns that hold the customer's name or language are used for that instead of becoming fields. The page is simple
 * on purpose: a heading, a greeting, up to six key figures and one table per list. No messages and no rules: data
 * cannot say when wording should differ.
 */
export function setupSpecFromData(rows: SampleRow[], opts: { title?: string; issuerName?: string } = {}): SetupFromData {
  const notes: string[] = [];
  const columns = describeColumns(Array.isArray(rows) ? rows.filter(isObj) : []);
  const fields: SetupField[] = [];
  const seen = new Set<string>();
  for (const c of columns) {
    if (c.role === 'ignored') { if (c.why) notes.push(c.why); continue; }
    if (c.role !== 'field' && c.role !== 'list') continue;
    const key = c.label.toLowerCase();
    if (seen.has(key)) { notes.push(`The columns called ${q(c.label)} appear more than once; only the first is used.`); continue; }
    seen.add(key);
    if (c.role === 'list') {
      const cols: SetupColumn[] = [];
      for (const lc of c.listColumns ?? []) if (!cols.some((x) => x.label.toLowerCase() === lc.label.toLowerCase())) cols.push({ label: lc.label, type: lc.type });
      fields.push({ label: c.label, type: 'list', columns: cols });
      if (c.why) notes.push(c.why);
      for (const lc of c.listColumns ?? []) if (lc.type === 'amount') notes.push(`${q(lc.label)} in ${q(c.label)} is read as an amount in ${lc.unit === 'cents' ? 'whole cents, because the column name says cents' : 'dollars, not cents'}.`);
      continue;
    }
    const g = c.guess!;
    fields.push({ label: c.label, type: g.type, ...(g.choices ? { choices: g.choices } : {}), ...(g.example ? { example: g.example } : {}) });
    if (g.why) notes.push(g.why);
  }

  const named = columns.filter((c) => c.role === 'firstName' || c.role === 'lastName' || c.role === 'fullName');
  if (named.length) notes.unshift(`${listOf(named.map((c) => q(c.column)))} ${named.length === 1 ? 'is' : 'are'} used as the customer’s name, not as ${named.length === 1 ? 'a data field' : 'data fields'}.`);
  else notes.unshift('The data has no column for the customer’s name, so the customers are called Customer 1, Customer 2 and so on.');
  const lang = columns.find((c) => c.role === 'language');
  if (lang) notes.splice(1, 0, `${q(lang.column)} is used as the customer’s language, not as a data field.`);
  const own = columns.find((c) => c.role === 'sourceId');
  if (own) notes.push(`${q(own.column)} is kept as your own record ID for each customer, not as a data field.`);

  const title = (opts.title ?? '').trim() || 'New document';
  const scalars = fields.filter((f) => f.type !== 'list');
  const figures = scalars.map((f, i) => ({ f, i })).sort((a, b) => FIGURE_RANK[a.f.type] - FIGURE_RANK[b.f.type] || a.i - b.i).slice(0, 6).sort((a, b) => a.i - b.i).map((x) => x.f.label);
  const sections: SetupSection[] = [{ type: 'heading', text: title }, { type: 'paragraph', text: 'Hello {First name} {Last name},' }];
  if (figures.length) sections.push({ type: 'keyFigures', fields: figures });
  for (const f of fields.filter((x) => x.type === 'list')) {
    const total = (f.columns ?? []).find((c) => c.type === 'amount');
    sections.push({ type: 'table', list: f.label, columns: (f.columns ?? []).map((c) => c.label), ...(total ? { totalColumn: total.label } : {}) });
    if (total) notes.push(`The table ${q(f.label)} adds up ${q(total.label)}. Remove the total if a sum makes no sense there.`);
  }
  const rest = scalars.filter((f) => !figures.includes(f.label));
  if (rest.length) notes.push(`${rest.length} data field${rest.length === 1 ? ' is' : 's are'} not on the page yet (${listOf(rest.map((f) => f.label))}). ${rest.length === 1 ? 'It is' : 'They are'} set up as data, ready to be placed.`);
  notes.push('No messages or rules were set up: the data alone does not say when wording should differ between customers.');

  const n = Array.isArray(rows) ? rows.length : 0;
  const checked = checkSetupSpec({
    title, issuerName: (opts.issuerName ?? '').trim(),
    summary: `Set up from ${n} sample ${n === 1 ? 'customer' : 'customers'}: ${fields.length} data field${fields.length === 1 ? '' : 's'}.`,
    fields, sections,
  });
  return { spec: checked.spec, notes: [...notes, ...checked.notes] };
}

/** What a model is told about supplied data: field names, the types guessed and the values of choices. Never a row, never an example value. */
export interface DataShape { fields: Array<{ label: string; type: SetupFieldType; choices?: string[]; columns?: SetupColumn[] }>; customerName: boolean; customerLanguage: boolean; rows: number }
export function dataShapeOf(rows: SampleRow[]): DataShape {
  const { spec } = setupSpecFromData(rows);
  const columns = describeColumns(rows.filter(isObj));
  return {
    fields: spec.fields.map((f) => ({ label: f.label, type: f.type, ...(f.choices ? { choices: f.choices } : {}), ...(f.columns ? { columns: f.columns } : {}) })),
    customerName: columns.some((c) => c.role === 'firstName' || c.role === 'lastName' || c.role === 'fullName'),
    customerLanguage: columns.some((c) => c.role === 'language'),
    rows: rows.length,
  };
}

/* ------------------------------------------------------------------ customers from the rows */

export interface RowMatch {
  column: string;
  /** What the column is used for, by the name a person reads (a data field's label, "First name", "Language"), or null when it is not used. */
  field: string | null;
  confidence: 'exact' | 'likely' | 'guess' | 'none';
  reason: string;
}
export interface RowsAsRecords {
  /** One record per row, in order, shaped like a customer of the project (`customer`, `custom`); not yet checked against the data fields. */
  records: Array<Record<string, unknown>>;
  matching: RowMatch[];
  notes: string[];
}

type Target = { kind: CustomerRole } | { kind: 'field'; field: CustomField };

function convert(value: unknown, type: CustomField['type'], unit: AmountUnit, choices?: string[]): unknown {
  switch (type) {
    case 'cents': return centsOf(value, unit) ?? value;
    case 'int': return asInt(value) ?? value;
    case 'bool': return asBool(value) ?? value;
    case 'date': return isoDate(value) ?? value;
    case 'enum': { const s = asText(value); return (choices ?? []).find((c) => c.toLowerCase() === s.toLowerCase()) ?? s; }
    default: return asText(value);
  }
}

/**
 * Turns sample rows into customer records for `project`. A column is used when its name is the name of a data field
 * (however it is written), when it is the customer's name or language, or when the column matcher is confident;
 * a mere guess is reported and not used. Values are converted to what the field holds (an amount to whole cents,
 * yes/no, a date); a value that cannot be converted is left as it is, so the record check can say what is wrong with it.
 */
export function recordsFromRows(rows: SampleRow[], project: Pick<Project, 'documentType' | 'customFields'>): RowsAsRecords {
  const notes: string[] = [];
  const names: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
  const fields = project.customFields ?? [];
  const isList = (column: string) => rows.some((r) => Array.isArray(r[column]));
  const sameName = (column: string, f: { key: string; label: string }) => { const s = squash(columnLabel(column)); return s === squash(f.label) || s === squash(f.key).replace(/cents$/, '') || squash(column) === squash(f.key); };

  const targets = new Map<string, Target>();
  const matching = new Map<string, RowMatch>();
  const usedFields = new Set<string>();
  const usedRoles = new Set<string>();
  const use = (column: string, t: Target, confidence: RowMatch['confidence'], reason: string) => {
    targets.set(column, t);
    if (t.kind === 'field') usedFields.add(t.field.key); else usedRoles.add(t.kind);
    matching.set(column, { column, field: t.kind === 'field' ? t.field.label : ROLE_LABEL[t.kind], confidence, reason });
  };
  // 1. The same name as a data field.
  for (const column of names) {
    const f = fields.find((x) => !usedFields.has(x.key) && (x.type === 'list') === isList(column) && sameName(column, x));
    if (f) use(column, { kind: 'field', field: f }, 'exact', `Same name as the field ${q(f.label)}.`);
  }
  // 2. The customer's name, language and your own record id.
  for (const column of names) {
    if (targets.has(column) || isList(column)) continue;
    const role = customerRole(column);
    if (role && !usedRoles.has(role)) use(column, { kind: role }, 'exact', role === 'language' ? 'Used as the customer’s language.' : role === 'sourceId' ? 'Kept as your own record ID.' : 'Used as the customer’s name.');
  }
  // 3. Everything else: the column matcher. Only what it is confident about is used.
  const open = names.filter((c) => !targets.has(c) && !isList(c));
  const ROLE_OF: Record<string, CustomerRole> = { 'customer.givenName': 'firstName', 'customer.familyName': 'lastName', 'customer.locale': 'language', recordId: 'sourceId' };
  matchColumns(open, [], project).forEach((m, i) => {
    const column = open[i];
    const f = m.path?.startsWith('custom.') ? fields.find((x) => `custom.${x.key}` === m.path && x.type !== 'list') : undefined;
    const role = m.path ? ROLE_OF[m.path] : undefined;
    const confident = m.confidence === 'exact' || m.confidence === 'likely';
    if (confident && f && !usedFields.has(f.key)) use(column, { kind: 'field', field: f }, m.confidence, m.reason);
    else if (confident && role && !usedRoles.has(role)) use(column, { kind: role }, m.confidence, m.reason);
    else if (m.confidence === 'guess' && (f || role)) matching.set(column, { column, field: null, confidence: 'guess', reason: `${m.reason} A guess is not used on its own: rename the column or the field so they match.` });
    else matching.set(column, { column, field: null, confidence: 'none', reason: f || role ? m.reason : 'No data field has this name, so the column is not used.' });
  });
  for (const column of names) if (!matching.has(column)) matching.set(column, { column, field: null, confidence: 'none', reason: isList(column) ? 'No list field has this name, so the column is not used.' : 'No data field has this name, so the column is not used.' });

  /** Decided once per column from all of its values, so every row is read the same way. */
  const units = new Map<string, AmountUnit>();
  const unitOf = (id: string, column: string, values: () => unknown[]): AmountUnit => { if (!units.has(id)) units.set(id, amountUnit(column, values())); return units.get(id)!; };
  const hasName = usedRoles.has('firstName') || usedRoles.has('lastName') || usedRoles.has('fullName');
  if (!hasName) notes.push('The data has no column for the customer’s name, so the customers are called Customer 1, Customer 2 and so on.');
  let unknownLanguage = 0;
  const records = rows.map((row, i) => {
    const customer: Record<string, unknown> = { locale: SOURCE_LANGUAGE };
    const custom: Record<string, unknown> = {};
    const record: Record<string, unknown> = { customer, custom };
    for (const [column, t] of targets) {
      const v = row[column];
      if (empty(v)) continue;
      if (t.kind === 'field') {
        const field = t.field;
        if (field.type !== 'list') { custom[field.key] = convert(v, field.type, unitOf(column, column, () => rows.map((r) => r[column])), field.enumValues); continue; }
        const cols = field.itemFields ?? [];
        custom[field.key] = Array.isArray(v) ? v.map((item) => {
          if (!isObj(item)) return item;
          const out: Record<string, unknown> = {};
          for (const [k, cell] of Object.entries(item)) {
            const col = cols.find((c) => sameName(k, c));
            if (col && !empty(cell)) out[col.key] = convert(cell, col.type, unitOf(`${column}/${k}`, k, () => rows.flatMap((r) => (Array.isArray(r[column]) ? (r[column] as unknown[]).filter(isObj).map((it) => it[k]) : []))));
          }
          return out;
        }) : v;
      } else if (t.kind === 'firstName') customer.givenName = asText(v);
      else if (t.kind === 'lastName') customer.familyName = asText(v);
      else if (t.kind === 'fullName') {
        const parts = asText(v).split(/\s+/).filter(Boolean);
        if (customer.givenName === undefined) customer.givenName = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
        if (customer.familyName === undefined && parts.length > 1) customer.familyName = parts[parts.length - 1];
      } else if (t.kind === 'language') {
        const code = localeOf(v);
        if (code && isSupportedLanguage(code)) customer.locale = code; else unknownLanguage++;
      } else if (t.kind === 'sourceId') record.recordId = asText(v);
    }
    if (!hasName) { customer.givenName = 'Customer'; customer.familyName = String(i + 1); }
    // A name in one part only ("Cher", or a file with first names alone): the other part is a dash, so the record is complete.
    else { if (empty(customer.givenName)) customer.givenName = '-'; if (empty(customer.familyName)) customer.familyName = '-'; }
    return record;
  });
  if (unknownLanguage) notes.push(`${unknownLanguage} customer${unknownLanguage === 1 ? ' has' : 's have'} a language the studio does not know; English is used for ${unknownLanguage === 1 ? 'that customer' : 'them'}.`);
  const amounts = [...targets].filter(([, t]) => t.kind === 'field' && t.field.type === 'cents');
  for (const [column, t] of amounts) if (t.kind === 'field') notes.push(unitOf(column, column, () => rows.map((r) => r[column])) === 'cents' ? `${q(column)} is read as whole cents for ${q(t.field.label)}, because the column name says cents.` : `${q(column)} is read as dollars for ${q(t.field.label)} (49 or 49.00 is $49.00).`);
  return { records, matching: names.map((c) => matching.get(c)!), notes };
}

/** What is wrong with one customer record, in plain words with field names instead of paths. Empty when it fits the project's data fields. */
export function recordProblems(record: unknown, project: Pick<Project, 'documentType' | 'customFields'>): string[] {
  const fields = projectFieldIndex(project);
  return validateRecordShape(record, project.documentType, customFieldDefs(project.customFields)).map((message) => {
    const row = /^([A-Za-z0-9_.]+)\[(\d+)\]\.([A-Za-z0-9_]+): (.*)$/.exec(message);
    if (row) {
      const list = fields.get(row[1]);
      return `${list?.label ?? 'A list'}, row ${Number(row[2]) + 1}, ${list?.itemFields?.find((c) => c.key === row[3])?.label ?? 'a column'}: ${row[4]}`;
    }
    return message.replace(/\s\([A-Za-z_]\w*(?:\.[\w[\]]+)+\)/g, '');
  });
}
