import { getPath } from './data';
import { CALC_FIELD_TYPE, CALC_PREFIX, DOCUMENT_DATE_PATH, projectFieldIndex, type FieldDef } from './fields';
import { addDaysToIso, daysBetweenIso, isIsoDay } from './isoDate';
import { lookupRowFor } from './lookup';
import { validatePredicate } from './validate';
import type { CalcType, CalculatedField, Expr, LookupTable, Predicate, Project } from './types';

/**
 * Calculated fields: the type check and the pure evaluator of the expression tree (`Expr`).
 *
 * - Money is whole cents. A multiplication or division that gives an amount must sit inside ROUND, which says how it
 *   rounds (half away from zero, to a stated number of places); multiplying by a whole-number constant needs no ROUND.
 * - Dates are ISO days with no time of day, no time zone and no clock (`isoDate.ts`).
 * - A value that cannot be worked out is "missing" with a reason, never a guess.
 * No `Intl`, no clock, no randomness: the browser, the server and the runnable package always agree.
 */

export const CALC_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
/** Most calculated fields one project may have. */
export const CALC_MAX = 100;
/** Most operations in one calculation, and how deep they may nest. */
export const EXPR_MAX_NODES = 200;
export const EXPR_MAX_DEPTH = 24;
export const NUMBER_PLACES_MAX = 6;
export const MONEY_PLACES_MAX = 2;
export const JOIN_MAX_PARTS = 20;
export const TEXT_CONSTANT_MAX = 500;
/** The largest number a calculation works with (well inside exact whole numbers). */
export const NUMBER_LIMIT = 1e15;

export const CALC_TYPE_WORDS: Record<CalcType, string> = { number: 'a number', money: 'an amount', date: 'a date', text: 'text', bool: 'yes or no' };

/** The kind of value a data field holds in a calculation (null for a list). */
export function calcTypeOfField(f: Pick<FieldDef, 'type'>): CalcType | null {
  switch (f.type) {
    case 'cents': return 'money';
    case 'int': case 'points': case 'number': return 'number';
    case 'date': return 'date';
    case 'string': case 'enum': return 'text';
    case 'bool': return 'bool';
    default: return null;
  }
}

/* ------------------------------------------------------------------ walking the tree */

/** The children of a node with the name of the slot each sits in (`a`, `b`, `args.0`, `then`, …). */
export function exprChildren(e: Expr): Array<[string, Expr]> {
  switch (e.op) {
    case 'add': case 'sub': case 'mul': case 'div': case 'earlier': case 'later': return [['a', e.a], ['b', e.b]];
    case 'round': case 'abs': return [['arg', e.arg]];
    case 'min': case 'max': return e.args.map((x, i) => [`args.${i}`, x]);
    case 'days': return [['from', e.from], ['to', e.to]];
    case 'addDays': return [['date', e.date], ['days', e.days]];
    case 'join': return e.parts.map((x, i) => [`parts.${i}`, x]);
    case 'if': return [['then', e.then], ['else', e.else]];
    case 'lookup': return e.keys.map((x, i) => [`keys.${i}`, x]);
    default: return [];
  }
}

/** The node at a slot path such as `a.args.1` (empty = the root). */
export function exprAt(e: Expr, path: string): Expr | null {
  if (!path) return e;
  const parts = path.split('.');
  let cur: Expr | null = e;
  for (let i = 0; i < parts.length && cur; i++) {
    const slot = /^\d+$/.test(parts[i + 1] ?? '') ? `${parts[i]}.${parts[++i]}` : parts[i];
    cur = exprChildren(cur).find(([k]) => k === slot)?.[1] ?? null;
  }
  return cur;
}

export function predicateLeafPaths(p: Predicate | undefined): string[] {
  if (!p) return [];
  if (p.op === 'and' || p.op === 'or') return p.args.flatMap(predicateLeafPaths);
  if (p.op === 'not') return predicateLeafPaths(p.arg);
  return [(p as { path: string }).path];
}

export interface ExprDependencies {
  /** Data fields read directly (including in IF conditions); not calculated fields. */
  fields: string[];
  /** Keys of the calculated fields it reads. */
  calcs: string[];
  /** Lists it counts or sums. */
  lists: string[];
  tables: string[];
  usesIssueDate: boolean;
}

/** Everything a calculation reads. */
export function exprDependencies(e: Expr): ExprDependencies {
  const fields = new Set<string>(), calcs = new Set<string>(), lists = new Set<string>(), tables = new Set<string>();
  let usesIssueDate = false;
  const path = (p: string) => {
    if (p.startsWith(CALC_PREFIX)) calcs.add(p.slice(CALC_PREFIX.length));
    else if (p === DOCUMENT_DATE_PATH) usesIssueDate = true;
    else fields.add(p);
  };
  const walk = (x: Expr) => {
    switch (x.op) {
      case 'field': path(x.path); break;
      case 'issueDate': usesIssueDate = true; break;
      case 'count': case 'sum': case 'smallest': case 'largest': lists.add(x.list); break;
      case 'if': predicateLeafPaths(x.when).forEach(path); break;
      case 'lookup': tables.add(x.table); break;
    }
    exprChildren(x).forEach(([, c]) => walk(c));
  };
  walk(e);
  return { fields: [...fields], calcs: [...calcs], lists: [...lists], tables: [...tables], usesIssueDate };
}

export function exprSize(e: Expr): { nodes: number; depth: number } {
  let nodes = 0;
  const depth = (x: Expr): number => { nodes++; return 1 + Math.max(0, ...exprChildren(x).map(([, c]) => depth(c))); };
  const d = depth(e);
  return { nodes, depth: d };
}

/* ------------------------------------------------------------------ type check */

/** What the type check needs to know about the project. */
export interface ExprScope {
  /** The project's fields (including `calc.*` and `document.date` when the project has them). */
  fields: Map<string, FieldDef>;
  /** Calculated field types by key (a calculation being edited is checked with its declared type). */
  calcTypes: Map<string, CalcType>;
  tables: Map<string, LookupTable>;
  /** The project says where its date comes from. */
  hasDocumentDate: boolean;
}

export function exprScopeOf(project: Pick<Project, 'documentType' | 'customFields' | 'calculatedFields' | 'lookupTables' | 'documentDate'>): ExprScope {
  return {
    fields: projectFieldIndex(project),
    calcTypes: new Map((project.calculatedFields ?? []).map((c) => [c.key, c.type])),
    tables: new Map((project.lookupTables ?? []).map((t) => [t.id, t])),
    hasDocumentDate: !!project.documentDate,
  };
}

/** One problem in a calculation, at a slot path of the tree (see `exprChildren`). */
export interface ExprProblem { at: string; message: string }

const q = (s: string) => `“${s}”`;

/** The columns of a list as fields a row condition can test (by column key). */
export function rowFieldsOf(scope: ExprScope, list: string): Map<string, FieldDef> | null {
  const f = scope.fields.get(list);
  if (!f || f.type !== 'array') return null;
  return new Map((f.itemFields ?? []).map((c) => {
    const twin = list === 'claims' ? scope.fields.get(`claim.${c.key}`) : undefined;
    const enumValues = c.type === 'enum' ? twin?.enumValues : undefined;
    return [c.key, { path: c.key, type: c.type === 'enum' && !enumValues ? 'string' : c.type, label: c.label, ...(enumValues ? { enumValues } : {}) } as FieldDef];
  }));
}

/**
 * The kind of value a calculation gives, and every problem in it (in plain words, with where it is). `type` is null
 * when the problems leave it unknown.
 */
export function checkExpr(e: Expr, scope: ExprScope): { type: CalcType | null; problems: ExprProblem[] } {
  const problems: ExprProblem[] = [];
  const bad = (at: string, message: string): null => { problems.push({ at, message }); return null; };
  const size = exprSize(e);
  if (size.nodes > EXPR_MAX_NODES) return { type: null, problems: [{ at: '', message: `This calculation has ${size.nodes} steps; the most is ${EXPR_MAX_NODES}. Split it into smaller calculations.` }] };
  if (size.depth > EXPR_MAX_DEPTH) return { type: null, problems: [{ at: '', message: `This calculation nests ${size.depth} levels deep; the most is ${EXPR_MAX_DEPTH}. Split it into smaller calculations.` }] };
  const join = (at: string, slot: string) => (at ? `${at}.${slot}` : slot);
  const numberish = (t: CalcType | null) => t === 'number' || t === 'money';

  const walk = (x: Expr, at: string, rounded: boolean): CalcType | null => {
    if (!x || typeof x !== 'object' || typeof (x as { op?: unknown }).op !== 'string') return bad(at, 'This step is not a calculation step.');
    switch (x.op) {
      case 'field': {
        if (typeof x.path !== 'string') return bad(at, 'A field must be named.');
        if (x.path.startsWith(CALC_PREFIX)) {
          const t = scope.calcTypes.get(x.path.slice(CALC_PREFIX.length));
          return t ?? bad(at, `There is no calculated field ${q(x.path.slice(CALC_PREFIX.length))}.`);
        }
        if (x.path === DOCUMENT_DATE_PATH) return scope.hasDocumentDate ? 'date' : bad(at, 'This document does not have a date yet. Choose where its date comes from first.');
        const f = scope.fields.get(x.path);
        if (!f) return bad(at, `${q(x.path)} is not a data field of this document.`);
        const t = calcTypeOfField(f);
        return t ?? bad(at, `${q(f.label)} is a list. Use COUNT, SUM, SMALLEST or LARGEST to read it.`);
      }
      case 'number':
        if (typeof x.value !== 'number' || !Number.isFinite(x.value) || Math.abs(x.value) > NUMBER_LIMIT) return bad(at, `A number must be between −${NUMBER_LIMIT} and ${NUMBER_LIMIT}.`);
        return 'number';
      case 'money':
        if (!Number.isSafeInteger(x.cents) || Math.abs(x.cents) > NUMBER_LIMIT) return bad(at, 'An amount must be a whole number of cents.');
        return 'money';
      case 'text':
        if (typeof x.value !== 'string') return bad(at, 'Text must be written in quotes.');
        if (x.value.length > TEXT_CONSTANT_MAX) return bad(at, `Fixed text is limited to ${TEXT_CONSTANT_MAX} characters.`);
        return 'text';
      case 'date': return isIsoDay(x.value) ? 'date' : bad(at, `${q(String(x.value))} is not a date. Write dates as YYYY-MM-DD, for example 2027-01-31.`);
      case 'bool': return typeof x.value === 'boolean' ? 'bool' : bad(at, 'Yes or no must be TRUE or FALSE.');
      case 'issueDate': return scope.hasDocumentDate ? 'date' : bad(at, 'This document does not have a date yet. Choose where its date comes from first.');
      case 'add': case 'sub': {
        const a = walk(x.a, join(at, 'a'), rounded), b = walk(x.b, join(at, 'b'), rounded);
        if (!a || !b) return null;
        const word = x.op === 'add' ? 'added' : 'subtracted';
        if (a === 'date' || b === 'date') return bad(at, x.op === 'add' ? 'Dates cannot be added. Use ADD_DAYS to move a date by a number of days.' : 'Dates cannot be subtracted. Use DAYS for the number of days between two dates, or ADD_DAYS with a negative number.');
        if (a === 'text' || b === 'text') return bad(at, `Text cannot be ${word}. Use JOIN to put text together.`);
        if (a === 'bool' || b === 'bool') return bad(at, `Yes or no cannot be ${word}.`);
        if (a !== b) return bad(at, `An amount and a plain number cannot be ${word}. Multiply the number by an amount, or use amounts on both sides.`);
        return a;
      }
      case 'mul': case 'div': {
        const a = walk(x.a, join(at, 'a'), rounded), b = walk(x.b, join(at, 'b'), rounded);
        if (!a || !b) return null;
        if (!numberish(a) || !numberish(b)) return bad(at, x.op === 'mul' ? 'Only numbers and amounts can be multiplied.' : 'Only numbers and amounts can be divided.');
        let t: CalcType;
        if (x.op === 'mul') {
          if (a === 'money' && b === 'money') return bad(at, 'Two amounts cannot be multiplied. Multiply an amount by a number.');
          t = a === 'money' || b === 'money' ? 'money' : 'number';
        } else {
          if (a === 'number' && b === 'money') return bad(at, 'A number cannot be divided by an amount.');
          t = a === 'money' && b === 'number' ? 'money' : 'number';
        }
        if (t === 'money' && !rounded) {
          const wholeFactor = x.op === 'mul' && [x.a, x.b].some((s) => s.op === 'number' && Number.isInteger(s.value));
          if (!wholeFactor) return bad(at, `Say how this amount is rounded: put the ${x.op === 'mul' ? 'multiplication' : 'division'} inside ROUND(…, 2) (to the cent) or ROUND(…, 0) (to the dollar).`);
        }
        return t;
      }
      case 'round': {
        const t = walk(x.arg, join(at, 'arg'), true);
        if (!t) return null;
        if (!numberish(t)) return bad(at, 'Only numbers and amounts can be rounded.');
        const max = t === 'money' ? MONEY_PLACES_MAX : NUMBER_PLACES_MAX;
        if (!Number.isInteger(x.places) || x.places < 0 || x.places > max) return bad(at, t === 'money' ? 'An amount rounds to 0, 1 or 2 places (2 is to the cent).' : `A number rounds to 0 to ${NUMBER_PLACES_MAX} places.`);
        return t;
      }
      case 'min': case 'max': {
        if (!Array.isArray(x.args) || x.args.length < 2 || x.args.length > JOIN_MAX_PARTS) return bad(at, `${x.op.toUpperCase()} needs 2 to ${JOIN_MAX_PARTS} values.`);
        const ts = x.args.map((y, i) => walk(y, join(at, `args.${i}`), rounded));
        if (ts.some((t) => !t)) return null;
        if (!ts.every((t) => numberish(t))) return bad(at, `${x.op.toUpperCase()} compares numbers or amounts. For dates use EARLIER or LATER.`);
        if (new Set(ts).size > 1) return bad(at, `${x.op.toUpperCase()} cannot compare amounts with plain numbers.`);
        return ts[0];
      }
      case 'abs': {
        const t = walk(x.arg, join(at, 'arg'), rounded);
        if (!t) return null;
        return numberish(t) ? t : bad(at, 'ABS works on numbers and amounts.');
      }
      case 'days': {
        const a = walk(x.from, join(at, 'from'), rounded), b = walk(x.to, join(at, 'to'), rounded);
        if (!a || !b) return null;
        return a === 'date' && b === 'date' ? 'number' : bad(at, 'DAYS needs two dates.');
      }
      case 'addDays': {
        const a = walk(x.date, join(at, 'date'), rounded), b = walk(x.days, join(at, 'days'), rounded);
        if (!a || !b) return null;
        if (a !== 'date') return bad(at, 'ADD_DAYS needs a date first.');
        return b === 'number' ? 'date' : bad(at, 'ADD_DAYS needs a number of days second.');
      }
      case 'earlier': case 'later': {
        const a = walk(x.a, join(at, 'a'), rounded), b = walk(x.b, join(at, 'b'), rounded);
        if (!a || !b) return null;
        return a === 'date' && b === 'date' ? 'date' : bad(at, `${x.op.toUpperCase()} needs two dates.`);
      }
      case 'join': {
        if (typeof x.sep !== 'string' || x.sep.length > 20) return bad(at, 'The text between the parts is limited to 20 characters.');
        if (!Array.isArray(x.parts) || x.parts.length < 1 || x.parts.length > JOIN_MAX_PARTS) return bad(at, `JOIN needs 1 to ${JOIN_MAX_PARTS} parts.`);
        const ts = x.parts.map((y, i) => walk(y, join(at, `parts.${i}`), rounded));
        if (ts.some((t) => !t)) return null;
        const i = ts.findIndex((t) => t === 'money' || t === 'bool');
        if (i >= 0) return bad(join(at, `parts.${i}`), ts[i] === 'money' ? 'JOIN cannot put an amount into text: an amount is shown in the document’s language where it is used.' : 'JOIN cannot put yes or no into text.');
        return 'text';
      }
      case 'count': case 'sum': case 'smallest': case 'largest': {
        const rows = rowFieldsOf(scope, x.list);
        if (!rows) return bad(at, scope.fields.has(x.list) ? `${q(scope.fields.get(x.list)!.label)} is not a list.` : `${q(x.list)} is not a list of this document.`);
        if (x.where) {
          const errs = validatePredicate(x.where, rows);
          if (errs.length) return bad(at, `The row condition is not valid: ${errs[0]}`);
        }
        if (x.op === 'count') return 'number';
        const col = rows.get(x.column);
        if (!col) return bad(at, `${q(scope.fields.get(x.list)!.label)} has no column ${q(x.column)}.`);
        const t = calcTypeOfField(col);
        if (x.op === 'sum') return numberish(t) ? t : bad(at, `SUM adds up numbers or amounts; ${q(col.label)} is ${t ? CALC_TYPE_WORDS[t] : 'not a value'}.`);
        return numberish(t) || t === 'date' ? t : bad(at, `${x.op.toUpperCase()} works on numbers, amounts or dates; ${q(col.label)} is ${t ? CALC_TYPE_WORDS[t] : 'not a value'}.`);
      }
      case 'if': {
        const errs = validatePredicate(x.when, scope.fields);
        const unknownDate = predicateLeafPaths(x.when).includes(DOCUMENT_DATE_PATH) && !scope.hasDocumentDate;
        const a = walk(x.then, join(at, 'then'), rounded), b = walk(x.else, join(at, 'else'), rounded);
        if (errs.length) return bad(at, `The condition is not valid: ${errs[0]}`);
        if (unknownDate) return bad(at, 'This document does not have a date yet. Choose where its date comes from first.');
        for (const p of predicateLeafPaths(x.when)) if (scope.fields.get(p)?.type === 'array') return bad(at, `The condition tests a list; use ${p}.count.`);
        if (!a || !b) return null;
        return a === b ? a : bad(at, `Both results of IF must be the same kind of value (here ${CALC_TYPE_WORDS[a]} and ${CALC_TYPE_WORDS[b]}).`);
      }
      case 'lookup': {
        const table = scope.tables.get(x.table);
        const ts = (Array.isArray(x.keys) ? x.keys : []).map((y, i) => walk(y, join(at, `keys.${i}`), rounded));
        if (!table) return bad(at, `There is no lookup table ${q(String(x.table))}.`);
        const col = table.columns.find((c) => c.key === x.column);
        if (!col) return bad(at, `The table ${q(table.title)} has no column ${q(String(x.column))}.`);
        if (ts.length !== table.keys.length) return bad(at, `The table ${q(table.title)} is looked up by ${table.keys.length} value${table.keys.length === 1 ? '' : 's'} (${table.keys.map((k) => q(k.label)).join(', ')}); this gives ${ts.length}.`);
        if (ts.some((t) => !t)) return null;
        for (const [i, k] of table.keys.entries()) {
          const want: CalcType = k.match === 'text' ? 'text' : k.match === 'date-range' ? 'date' : k.unit === 'money' ? 'money' : 'number';
          if (ts[i] !== want) return bad(join(at, `keys.${i}`), `${q(k.label)} of ${q(table.title)} is looked up by ${CALC_TYPE_WORDS[want]}, not ${CALC_TYPE_WORDS[ts[i]!]}.`);
        }
        return col.type;
      }
      default:
        return bad(at, `Unknown calculation step ${q(String((x as { op: string }).op))}.`);
    }
  };
  const type = walk(e, '', false);
  return { type: problems.length ? null : type, problems };
}

/* ------------------------------------------------------------------ the project's calculations as a whole */

/** Calculated fields in the order they can be worked out (each after those it reads), or the keys in a cycle. */
export function calcOrder(calcs: CalculatedField[]): { order: string[]; cycle: string[] | null } {
  const byKey = new Map(calcs.map((c) => [c.key, c]));
  const deps = new Map(calcs.map((c) => [c.key, exprDependencies(c.expr).calcs.filter((k) => byKey.has(k))]));
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  let cycle: string[] | null = null;
  const visit = (k: string, stack: string[]) => {
    if (cycle) return;
    const s = state.get(k);
    if (s === 'done') return;
    if (s === 'visiting') { cycle = [...stack.slice(stack.indexOf(k)), k]; return; }
    state.set(k, 'visiting');
    for (const d of deps.get(k) ?? []) visit(d, [...stack, k]);
    state.set(k, 'done');
    order.push(k);
  };
  for (const c of calcs) visit(c.key, []);
  return { order: cycle ? [] : order, cycle };
}

/**
 * Every problem with a project's calculated fields, in plain words: keys, labels, types, the expressions themselves
 * and calculations that depend on themselves (directly or through others).
 */
export function validateCalculatedFields(project: Pick<Project, 'documentType' | 'customFields' | 'lookupTables' | 'documentDate'>, calcs: CalculatedField[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(calcs)) return ['The list of calculated fields cannot be read.'];
  if (calcs.length > CALC_MAX) errors.push(`A document can have at most ${CALC_MAX} calculated fields.`);
  const seen = new Set<string>();
  const labels = new Set<string>();
  for (const c of calcs) {
    if (!c || typeof c !== 'object') { errors.push('A calculated field cannot be read.'); continue; }
    if (!CALC_KEY_PATTERN.test(c.key ?? '')) errors.push(`Key ${q(String(c.key))} must start with a letter and use only letters and digits (max 40).`);
    if (seen.has(c.key)) errors.push(`The key ${q(c.key)} is used by two calculated fields.`);
    seen.add(c.key);
    if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 60) errors.push(`Calculated field ${q(String(c.key))} needs a name (max 60 characters).`);
    else if (labels.has(c.label.trim().toLowerCase())) errors.push(`Two calculated fields are called ${q(c.label.trim())}.`);
    else labels.add(c.label.trim().toLowerCase());
    if (!(c.type in CALC_FIELD_TYPE)) errors.push(`Calculated field ${q(c.label ?? c.key)} must give a number, an amount, a date, text or yes or no.`);
    if (c.description !== undefined && (typeof c.description !== 'string' || c.description.length > 300)) errors.push(`The description of ${q(c.label ?? c.key)} is limited to 300 characters.`);
  }
  if (errors.length) return errors;
  const scope = exprScopeOf({ ...project, calculatedFields: calcs });
  const std = new Set([...scope.fields.values()].filter((f) => !f.calculated).map((f) => f.label.toLowerCase()));
  for (const c of calcs) {
    if (std.has(c.label.trim().toLowerCase())) errors.push(`${q(c.label)} is already the name of a data field.`);
    const { type, problems } = checkExpr(c.expr, scope);
    if (problems.length) { errors.push(`${q(c.label)}: ${problems[0].message}`); continue; }
    if (type && type !== c.type) errors.push(`${q(c.label)} is set to give ${CALC_TYPE_WORDS[c.type]}, but its calculation gives ${CALC_TYPE_WORDS[type]}.`);
  }
  const { cycle } = calcOrder(calcs);
  if (cycle) {
    const name = (k: string) => q(calcs.find((c) => c.key === k)?.label ?? k);
    errors.push(cycle.length === 2 ? `${name(cycle[0])} uses itself. A calculation cannot depend on its own result.` : `These calculations depend on each other in a circle: ${cycle.map(name).join(' → ')}. A calculation cannot depend on its own result.`);
  }
  return errors;
}

/* ------------------------------------------------------------------ evaluation */

export type CalcValue = number | string | boolean;

export type MissingCode = 'input-missing' | 'division-by-zero' | 'no-lookup-row' | 'no-lookup-value' | 'no-date' | 'not-whole-days' | 'out-of-range' | 'invalid';

/** Why a calculation has no value for a customer. `path` names the data field or calculation at the root of it. */
export interface Missing {
  code: MissingCode;
  /** Plain words, fixed studio English, without the customer's values. */
  message: string;
  path?: string;
  /** Calculated fields it passed through on its way, innermost first. */
  via?: string[];
}

export type Evaluated = { ok: true; value: CalcValue } | { ok: false; missing: Missing };

/** One step of a calculation for one customer: the slot path, and its value or why it is missing. */
export interface EvalStep { at: string; value: CalcValue | null; missing?: Missing }

export interface EvalEnv {
  /** The customer's data as the engine reads it (`buildContext`); calculated values are under `calc`. */
  ctx: unknown;
  /** Calculated fields already worked out that are missing, by key. */
  calcMissing: ReadonlyMap<string, Missing>;
  /** The document's date, or null when there is none. */
  issueDate: string | null;
  tables: ReadonlyMap<string, LookupTable>;
  fields: ReadonlyMap<string, FieldDef>;
  /** Calculated field names by key (for reasons). */
  calcLabels: ReadonlyMap<string, string>;
  /** Calculated field types by key (to know whether ROUND works on an amount). */
  calcTypes?: ReadonlyMap<string, CalcType>;
  /** When given, every step's value is recorded here (the step-by-step view). */
  steps?: EvalStep[];
}

/** Rounds half away from zero to `places` decimals (exact for the decimals a person writes). */
export function roundHalfUp(x: number, places: number): number {
  const f = 10 ** places;
  const y = Number((Math.abs(x) * f).toPrecision(15));
  const r = Math.floor(y + 0.5) / f;
  return x < 0 ? -r : r;
}

const fieldName = (env: Pick<EvalEnv, 'fields' | 'calcLabels'>, path: string): string => {
  if (path.startsWith(CALC_PREFIX)) return env.calcLabels.get(path.slice(CALC_PREFIX.length)) ?? path;
  return env.fields.get(path)?.label ?? path;
};

/**
 * Three-valued test of a rule condition: true, false, or missing when it reads a calculated field that is missing and
 * the answer depends on it. Data fields keep the resolver's two-valued meaning (an empty value compares as false).
 * `isMissing` says whether a path is a missing calculated field.
 */
export function predicateTri(p: Predicate, ctx: unknown, isMissing: (path: string) => Missing | null, inputs?: Record<string, unknown>): boolean | Missing {
  switch (p.op) {
    case 'and': {
      let miss: Missing | null = null;
      for (const a of p.args) { const r = predicateTri(a, ctx, isMissing, inputs); if (r === false) return false; if (r !== true) miss ??= r; }
      return miss ?? true;
    }
    case 'or': {
      let miss: Missing | null = null;
      for (const a of p.args) { const r = predicateTri(a, ctx, isMissing, inputs); if (r === true) return true; if (r !== false) miss ??= r; }
      return miss ?? false;
    }
    case 'not': { const r = predicateTri(p.arg, ctx, isMissing, inputs); return typeof r === 'boolean' ? !r : r; }
    case 'isNull': { const v = getPath(ctx, p.path); if (inputs) inputs[p.path] = v; return v === null; }
    case 'notNull': { const v = getPath(ctx, p.path); if (inputs) inputs[p.path] = v; return v !== null; }
    case 'in': {
      const v = getPath(ctx, p.path); if (inputs) inputs[p.path] = v;
      const m = isMissing(p.path); if (m) return m;
      return v !== null && p.value.includes(v);
    }
    default: {
      const v = getPath(ctx, p.path); if (inputs) inputs[p.path] = v;
      const m = isMissing(p.path); if (m) return m;
      const val = p.value;
      if (v === null) return false;
      switch (p.op) {
        case 'eq': return v === val;
        case 'ne': return v !== val;
        case 'gt': return val !== null && v > val;
        case 'gte': return val !== null && v >= val;
        case 'lt': return val !== null && v < val;
        case 'lte': return val !== null && v <= val;
      }
    }
  }
  return false;
}

const missing = (code: MissingCode, message: string, path?: string): Evaluated => ({ ok: false, missing: { code, message, ...(path ? { path } : {}) } });

/** Works out one calculation for one customer. Pure. */
export function evaluateExpr(e: Expr, env: EvalEnv): Evaluated {
  const rec = (at: string, r: Evaluated): Evaluated => {
    env.steps?.push(r.ok ? { at, value: r.value } : { at, value: null, missing: r.missing });
    return r;
  };
  const join = (at: string, slot: string) => (at ? `${at}.${slot}` : slot);
  const num = (v: number, at: string): Evaluated => (Number.isFinite(v) && Math.abs(v) <= NUMBER_LIMIT ? { ok: true, value: v } : rec(at, missing('out-of-range', 'The result is too large to work with.')));

  const readPath = (path: string): Evaluated => {
    if (path === DOCUMENT_DATE_PATH) return env.issueDate ? { ok: true, value: env.issueDate } : missing('no-date', 'The document has no date for this customer.');
    if (path.startsWith(CALC_PREFIX)) {
      const key = path.slice(CALC_PREFIX.length);
      const m = env.calcMissing.get(key);
      if (m) return { ok: false, missing: { ...m, via: [...(m.via ?? []), key] } };
    }
    const v = getPath(env.ctx, path);
    if (v === null || v === undefined || v === '') return missing('input-missing', `${q(fieldName(env, path))} is missing.`, path);
    if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') return missing('invalid', `${q(fieldName(env, path))} is not a single value.`, path);
    return { ok: true, value: v };
  };

  const ev = (x: Expr, at: string): Evaluated => {
    const go = (slot: string, y: Expr) => ev(y, join(at, slot));
    let r: Evaluated;
    switch (x.op) {
      case 'field': {
        r = readPath(x.path);
        const t = x.path.startsWith(CALC_PREFIX) ? null : env.fields.get(x.path)?.type;
        if (r.ok && (t === 'cents' || t === 'int' || t === 'points') && !Number.isInteger(r.value)) r = missing('invalid', `${q(fieldName(env, x.path))} is not a whole number.`, x.path);
        else if (r.ok && t === 'date' && !isIsoDay(r.value)) r = missing('invalid', `${q(fieldName(env, x.path))} is not a date.`, x.path);
        break;
      }
      case 'number': r = { ok: true, value: x.value }; break;
      case 'money': r = { ok: true, value: x.cents }; break;
      case 'text': case 'date': case 'bool': r = { ok: true, value: x.value }; break;
      case 'issueDate': r = env.issueDate ? { ok: true, value: env.issueDate } : missing('no-date', 'The document has no date for this customer.'); break;
      case 'add': case 'sub': case 'mul': case 'div': {
        const a = go('a', x.a); if (!a.ok) { r = a; break; }
        const b = go('b', x.b); if (!b.ok) { r = b; break; }
        const av = a.value as number, bv = b.value as number;
        if (x.op === 'div' && bv === 0) { r = missing('division-by-zero', x.b.op === 'field' ? `${q(fieldName(env, x.b.path))} is zero, and nothing can be divided by zero.` : 'It divides by zero.', x.b.op === 'field' ? x.b.path : undefined); break; }
        r = num(x.op === 'add' ? av + bv : x.op === 'sub' ? av - bv : x.op === 'mul' ? av * bv : av / bv, at);
        break;
      }
      case 'round': {
        const a = go('arg', x.arg); if (!a.ok) { r = a; break; }
        // An amount is cents: rounding to `places` dollar decimals rounds to a multiple of 10^(2 − places) cents.
        const money = checkMoneyOf(x.arg, env);
        r = num(money ? roundHalfUp((a.value as number) / 10 ** (2 - x.places), 0) * 10 ** (2 - x.places) : roundHalfUp(a.value as number, x.places), at);
        break;
      }
      case 'min': case 'max': {
        const vals: number[] = [];
        let fail: Evaluated | null = null;
        for (const [i, y] of x.args.entries()) { const v = go(`args.${i}`, y); if (!v.ok) { fail = v; break; } vals.push(v.value as number); }
        r = fail ?? { ok: true, value: x.op === 'min' ? Math.min(...vals) : Math.max(...vals) };
        break;
      }
      case 'abs': { const a = go('arg', x.arg); r = a.ok ? { ok: true, value: Math.abs(a.value as number) } : a; break; }
      case 'days': {
        const a = go('from', x.from); if (!a.ok) { r = a; break; }
        const b = go('to', x.to); if (!b.ok) { r = b; break; }
        r = { ok: true, value: daysBetweenIso(a.value as string, b.value as string) };
        break;
      }
      case 'addDays': {
        const a = go('date', x.date); if (!a.ok) { r = a; break; }
        const b = go('days', x.days); if (!b.ok) { r = b; break; }
        const n = b.value as number;
        if (!Number.isInteger(n)) { r = missing('not-whole-days', 'A date can only be moved by a whole number of days.'); break; }
        if (Math.abs(n) > 3_000_000) { r = missing('out-of-range', 'The date would be out of range.'); break; }
        const d = addDaysToIso(a.value as string, n);
        r = isIsoDay(d) ? { ok: true, value: d } : missing('out-of-range', 'The date would be out of range.');
        break;
      }
      case 'earlier': case 'later': {
        const a = go('a', x.a); if (!a.ok) { r = a; break; }
        const b = go('b', x.b); if (!b.ok) { r = b; break; }
        const [p, s] = [a.value as string, b.value as string];
        r = { ok: true, value: x.op === 'earlier' ? (p <= s ? p : s) : (p >= s ? p : s) };
        break;
      }
      case 'join': {
        const out: string[] = [];
        let fail: Evaluated | null = null;
        for (const [i, y] of x.parts.entries()) { const v = go(`parts.${i}`, y); if (!v.ok) { fail = v; break; } out.push(String(v.value)); }
        r = fail ?? { ok: true, value: out.join(x.sep) };
        break;
      }
      case 'count': case 'sum': case 'smallest': case 'largest': {
        const list = getPath(env.ctx, x.list);
        const rows: Array<Record<string, unknown>> = Array.isArray(list) ? list.filter((row) => row && typeof row === 'object') : [];
        const never = (): null => null;
        const kept = x.where ? rows.filter((row) => predicateTri(x.where!, row, never) === true) : rows;
        if (x.op === 'count') { r = { ok: true, value: kept.length }; break; }
        const vals = kept.map((row) => row[x.column]).filter((v) => v !== null && v !== undefined && v !== '');
        if (x.op === 'sum') {
          const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
          r = num(nums.reduce((s, v) => s + v, 0), at);
          break;
        }
        const listName = fieldName(env, x.list);
        if (!vals.length) { r = missing('input-missing', `${q(listName)} has no ${x.where ? 'matching ' : ''}rows with a value to compare.`, x.list); break; }
        const sorted = (vals as Array<number | string>).slice().sort((p, s) => (p < s ? -1 : p > s ? 1 : 0));
        r = { ok: true, value: x.op === 'smallest' ? sorted[0] : sorted[sorted.length - 1] };
        break;
      }
      case 'if': {
        const cond = predicateTri(x.when, env.ctx, (path) => {
          if (path === DOCUMENT_DATE_PATH) return env.issueDate ? null : { code: 'no-date', message: 'The document has no date for this customer.' };
          if (!path.startsWith(CALC_PREFIX)) return null;
          const key = path.slice(CALC_PREFIX.length);
          const m = env.calcMissing.get(key);
          return m ? { ...m, via: [...(m.via ?? []), key] } : null;
        });
        if (typeof cond !== 'boolean') { r = { ok: false, missing: cond }; break; }
        r = cond ? go('then', x.then) : go('else', x.else);
        break;
      }
      case 'lookup': {
        const table = env.tables.get(x.table);
        if (!table) { r = missing('invalid', `The lookup table ${q(x.table)} does not exist.`); break; }
        const keys: CalcValue[] = [];
        let fail: Evaluated | null = null;
        for (const [i, y] of x.keys.entries()) { const v = go(`keys.${i}`, y); if (!v.ok) { fail = v; break; } keys.push(v.value); }
        if (fail) { r = fail; break; }
        const row = lookupRowFor(table, keys);
        const values = row?.values ?? table.defaultRow;
        if (!values) { r = missing('no-lookup-row', `No row of the table ${q(table.title)} matches this customer, and the table has no default row.`); break; }
        const v = values[x.column];
        const col = table.columns.find((c) => c.key === x.column);
        r = v === null || v === undefined || v === '' ? missing('no-lookup-value', `The ${row ? 'matching' : 'default'} row of ${q(table.title)} has no value for ${q(col?.label ?? x.column)}.`) : { ok: true, value: v as CalcValue };
        break;
      }
      default:
        r = missing('invalid', 'This calculation step is not known.');
    }
    return rec(at, r);
  };
  try {
    return ev(e, '');
  } catch {
    return missing('invalid', 'This calculation could not be worked out.');
  }
}

/** Whether a node gives an amount (decided from the tree and the field types, without a full type check). */
function checkMoneyOf(x: Expr, env: Pick<EvalEnv, 'fields' | 'tables' | 'calcTypes'>): boolean {
  switch (x.op) {
    case 'money': return true;
    case 'field': {
      if (x.path.startsWith(CALC_PREFIX)) return env.calcTypes?.get(x.path.slice(CALC_PREFIX.length)) === 'money';
      return env.fields.get(x.path)?.type === 'cents';
    }
    case 'add': case 'sub': return checkMoneyOf(x.a, env);
    case 'mul': return checkMoneyOf(x.a, env) || checkMoneyOf(x.b, env);
    case 'div': return checkMoneyOf(x.a, env) && !checkMoneyOf(x.b, env);
    case 'round': case 'abs': return checkMoneyOf(x.arg, env);
    case 'min': case 'max': return checkMoneyOf(x.args[0], env);
    case 'if': return checkMoneyOf(x.then, env);
    case 'sum': case 'smallest': case 'largest': {
      const f = env.fields.get(x.list);
      return f?.itemFields?.find((c) => c.key === x.column)?.type === 'cents';
    }
    case 'lookup': return env.tables.get(x.table)?.columns.find((c) => c.key === x.column)?.type === 'money';
    default: return false;
  }
}

/* ------------------------------------------------------------------ all calculations of a project, once per customer */

interface Compiled {
  calcs: CalculatedField[];
  order: CalculatedField[];
  cycle: Set<string>;
  fields: Map<string, FieldDef>;
  tables: Map<string, LookupTable>;
  labels: Map<string, string>;
  calcTypes: Map<string, CalcType>;
}
const COMPILED = new WeakMap<object, Compiled>();

function compiled(project: Pick<Project, 'documentType' | 'customFields' | 'calculatedFields' | 'lookupTables' | 'documentDate'>): Compiled {
  const hit = COMPILED.get(project);
  if (hit) return hit;
  const calcs = Array.isArray(project.calculatedFields) ? project.calculatedFields : [];
  const { order, cycle } = calcOrder(calcs);
  const byKey = new Map(calcs.map((c) => [c.key, c]));
  const c: Compiled = {
    calcs,
    order: cycle ? calcs : order.map((k) => byKey.get(k)!),
    cycle: new Set(cycle ?? []),
    fields: projectFieldIndex(project),
    tables: new Map((project.lookupTables ?? []).map((t) => [t.id, t])),
    labels: new Map(calcs.map((x) => [x.key, x.label])),
    calcTypes: new Map(calcs.map((x) => [x.key, x.type])),
  };
  COMPILED.set(project, c);
  return c;
}

export interface CalcResults {
  /** Every calculated value by key (null when missing), in the project's order. */
  values: Record<string, CalcValue | null>;
  missing: Record<string, Missing>;
  /** The order they were worked out in. */
  order: string[];
}

/**
 * Works out every calculated field of a project for one customer, each once, in dependency order. Writes the values to
 * `ctx.calc` (missing ones as null) so rule conditions and wording read them like data fields. Pure apart from that.
 */
export function evaluateCalculations(project: Pick<Project, 'documentType' | 'customFields' | 'calculatedFields' | 'lookupTables' | 'documentDate'>, ctx: Record<string, unknown>, issueDate: string | null): CalcResults {
  const c = compiled(project);
  const values: Record<string, CalcValue | null> = {};
  const missingBy = new Map<string, Missing>();
  ctx.calc = values;
  if (project.documentDate && !ctx.document) ctx.document = { date: issueDate };
  const env: EvalEnv = { ctx, calcMissing: missingBy, issueDate, tables: c.tables, fields: c.fields, calcLabels: c.labels, calcTypes: c.calcTypes };
  for (const calc of c.order) {
    if (c.cycle.size && c.cycle.has(calc.key)) {
      values[calc.key] = null;
      missingBy.set(calc.key, { code: 'invalid', message: 'It depends on its own result.' });
      continue;
    }
    const r = evaluateExpr(calc.expr, env);
    let value: CalcValue | null = r.ok ? r.value : null;
    let miss: Missing | null = r.ok ? null : r.missing;
    // A value of the wrong kind (only possible in a project that skipped the checks) is missing, never shown.
    if (value !== null && !valueFits(calc.type, value)) { value = null; miss = { code: 'invalid', message: `It did not give ${CALC_TYPE_WORDS[calc.type]}.` }; }
    values[calc.key] = value;
    if (miss) missingBy.set(calc.key, miss);
  }
  const missingOut: Record<string, Missing> = {};
  for (const [k, m] of missingBy) missingOut[k] = m;
  return { values, missing: missingOut, order: c.order.map((x) => x.key) };
}

/** Whether a value is of a calculation type (money: whole cents). */
export function valueFits(type: CalcType, v: unknown): boolean {
  switch (type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'money': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'date': return isIsoDay(v);
    case 'text': return typeof v === 'string';
    case 'bool': return typeof v === 'boolean';
  }
}

/**
 * One calculation worked out step by step for one customer, for the builder and formula views: every step's value
 * (or why it is missing), by slot path. `ctx` must already hold the other calculated values (`evaluateCalculations`).
 */
export function evaluateSteps(project: Pick<Project, 'documentType' | 'customFields' | 'calculatedFields' | 'lookupTables' | 'documentDate'>, expr: Expr, ctx: Record<string, unknown>, issueDate: string | null, calcMissing: Record<string, Missing> = {}): { result: Evaluated; steps: EvalStep[] } {
  const c = compiled(project);
  const steps: EvalStep[] = [];
  const env: EvalEnv = { ctx, calcMissing: new Map(Object.entries(calcMissing)), issueDate, tables: c.tables, fields: c.fields, calcLabels: c.labels, calcTypes: c.calcTypes, steps };
  const result = evaluateExpr(expr, env);
  return { result, steps };
}

