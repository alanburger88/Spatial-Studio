import { CALC_PREFIX, DOCUMENT_DATE_PATH, type FieldDef } from './fields';
import { dayWords } from './isoDate';
import type { CalculatedField, EffectivePeriod, Expr, LookupTable, Predicate, Project, Scalar } from './types';

/**
 * The plain-words reader of a calculation: "The number of days from “Payment due date” to the document’s date."
 *
 * FIXED STUDIO WORDING, in English: it explains a calculation to the person building the document (the Calculations
 * tab, the data dictionary of a release package). It is never customer-visible document text and is not translated;
 * documents show calculated VALUES, formatted in the document language by the resolver's formatters.
 */

export interface WordsScope {
  fields: ReadonlyMap<string, FieldDef>;
  calcs?: ReadonlyArray<Pick<CalculatedField, 'key' | 'label'>>;
  tables?: ReadonlyArray<Pick<LookupTable, 'id' | 'title' | 'columns' | 'keys'>>;
}

export function wordsScopeOf(project: Pick<Project, 'calculatedFields' | 'lookupTables'>, fields: ReadonlyMap<string, FieldDef>): WordsScope {
  return { fields, calcs: project.calculatedFields ?? [], tables: project.lookupTables ?? [] };
}

const q = (s: string) => `“${s}”`;
const listOf = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const grouped = (n: number): string => { const [i, f] = String(Math.abs(n)).split('.'); return `${n < 0 ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`; };
/** An amount in fixed studio English ($1,234.50). */
export const moneyWords = (cents: number): string => `${cents < 0 ? '−' : ''}$${grouped(Math.floor(Math.abs(cents) / 100))}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

function pathName(scope: WordsScope, path: string): string {
  if (path === DOCUMENT_DATE_PATH) return 'the document’s date';
  if (path.startsWith(CALC_PREFIX)) { const k = path.slice(CALC_PREFIX.length); return q(scope.calcs?.find((c) => c.key === k)?.label ?? k); }
  const f = scope.fields.get(path);
  return q(f?.label ?? path);
}

function scalarWords(v: Scalar, f: FieldDef | undefined): string {
  if (v === null) return 'empty';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return f?.type === 'cents' && Number.isInteger(v) ? moneyWords(v) : grouped(v);
  return f?.type === 'date' ? dayWords(v) : q(v);
}

const OP_WORDS: Record<string, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };
const DATE_OP_WORDS: Record<string, string> = { eq: 'is', ne: 'is not', gt: 'is after', gte: 'is on or after', lt: 'is before', lte: 'is on or before' };

/** A condition in plain words. `fields` gives names (and, for a row condition, the list's columns). */
export function conditionInWords(p: Predicate, scope: WordsScope, fields: ReadonlyMap<string, FieldDef> = scope.fields): string {
  const name = (path: string) => (fields === scope.fields ? pathName(scope, path) : q(fields.get(path)?.label ?? path));
  switch (p.op) {
    case 'and': return p.args.length ? listOf(p.args.map((a) => (a.op === 'or' ? `(${conditionInWords(a, scope, fields)})` : conditionInWords(a, scope, fields)))) : 'always';
    case 'or': return p.args.length ? p.args.map((a) => conditionInWords(a, scope, fields)).join(' or ') : 'never';
    case 'not': return `not (${conditionInWords(p.arg, scope, fields)})`;
    case 'isNull': return `${name(p.path)} is empty`;
    case 'notNull': return `${name(p.path)} has a value`;
    case 'in': { const f = fields.get(p.path); return `${name(p.path)} is ${p.value.length === 1 ? scalarWords(p.value[0], f) : `one of ${listOf(p.value.map((v) => scalarWords(v, f)))}`}`; }
    default: {
      const f = fields.get(p.path) ?? (p.path === DOCUMENT_DATE_PATH ? ({ type: 'date' } as FieldDef) : undefined);
      const words = f?.type === 'date' ? DATE_OP_WORDS : OP_WORDS;
      return `${name(p.path)} ${words[p.op]} ${scalarWords(p.value, f)}`;
    }
  }
}

const BINARY: Record<string, string> = { add: 'plus', sub: 'minus', mul: 'times', div: 'divided by' };

/** A calculation in plain words, without a capital or a full stop (see `formulaInWords`). */
export function exprWords(e: Expr, scope: WordsScope): string {
  const w = (x: Expr) => exprWords(x, scope);
  const group = (x: Expr, parent: Expr['op']) => ((parent === 'mul' || parent === 'div') && (x.op === 'add' || x.op === 'sub') ? `(${w(x)})` : w(x));
  const listName = (list: string) => pathName(scope, list);
  const column = (list: string, col: string) => q(scope.fields.get(list)?.itemFields?.find((c) => c.key === col)?.label ?? col);
  const rowFields = (list: string): Map<string, FieldDef> => new Map((scope.fields.get(list)?.itemFields ?? []).map((c) => [c.key, { path: c.key, type: c.type, label: c.label } as FieldDef]));
  const where = (list: string, p?: Predicate) => (p ? ` where ${conditionInWords(p, scope, rowFields(list))}` : '');
  switch (e.op) {
    case 'field': return pathName(scope, e.path);
    case 'number': return grouped(e.value);
    case 'money': return moneyWords(e.cents);
    case 'text': return q(e.value);
    case 'date': return dayWords(e.value);
    case 'bool': return e.value ? 'yes' : 'no';
    case 'issueDate': return 'the document’s date';
    case 'add': case 'sub': case 'mul': case 'div': return `${group(e.a, e.op)} ${BINARY[e.op]} ${group(e.b, e.op)}`;
    case 'round': {
      const how = e.places === 0 ? 'rounded to a whole number' : `rounded to ${e.places} decimal place${e.places === 1 ? '' : 's'}`;
      return `${w(e.arg)}, ${how}`;
    }
    case 'min': return `the smallest of ${listOf(e.args.map(w))}`;
    case 'max': return `the largest of ${listOf(e.args.map(w))}`;
    case 'abs': return `${w(e.arg)} without its sign`;
    case 'days': return `the number of days from ${w(e.from)} to ${w(e.to)}`;
    case 'addDays': {
      if (e.days.op === 'number') return e.days.value < 0 ? `${grouped(-e.days.value)} day${e.days.value === -1 ? '' : 's'} before ${w(e.date)}` : `${grouped(e.days.value)} day${e.days.value === 1 ? '' : 's'} after ${w(e.date)}`;
      return `${w(e.date)} moved by ${w(e.days)} days`;
    }
    case 'earlier': return `the earlier of ${w(e.a)} and ${w(e.b)}`;
    case 'later': return `the later of ${w(e.a)} and ${w(e.b)}`;
    case 'join': return `${listOf(e.parts.map(w))} joined${e.sep ? ` with ${q(e.sep)} between them` : ' together'}`;
    case 'count': return `the number of rows in ${listName(e.list)}${where(e.list, e.where)}`;
    case 'sum': return `the total of ${column(e.list, e.column)} in ${listName(e.list)}${where(e.list, e.where)}`;
    case 'smallest': return `the smallest ${column(e.list, e.column)} in ${listName(e.list)}${where(e.list, e.where)}`;
    case 'largest': return `the largest ${column(e.list, e.column)} in ${listName(e.list)}${where(e.list, e.where)}`;
    case 'if': return `if ${conditionInWords(e.when, scope)}, ${w(e.then)}; otherwise ${w(e.else)}`;
    case 'lookup': {
      const t = scope.tables?.find((x) => x.id === e.table);
      const col = t?.columns.find((c) => c.key === e.column)?.label ?? e.column;
      const keys = e.keys.map((k, i) => `${t?.keys[i] ? `${q(t.keys[i].label)} ` : ''}${w(k)}`);
      return `${q(col)} from the table ${q(t?.title ?? e.table)} for ${listOf(keys)}`;
    }
  }
}

/** A calculation as one sentence: "The number of days from “Payment due date” to the document’s date." */
export function formulaInWords(e: Expr, scope: WordsScope): string {
  const s = exprWords(e, scope);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** An effective period in plain words: "from 1 Jan 2027 until 31 Mar 2027 (not included)". */
export function periodInWords(p: EffectivePeriod | undefined): string {
  if (!p || (!p.from && !p.until)) return 'always';
  if (p.from && p.until) return `from ${dayWords(p.from)}, until ${dayWords(p.until)} (not included)`;
  return p.from ? `from ${dayWords(p.from)}` : `until ${dayWords(p.until!)} (not included)`;
}
