import {
  CALC_PREFIX, DOCUMENT_DATE_PATH, buildContext, calcTypeOfField, checkExpr, dayFromNumber, dayNumber, evaluateCalculations, exprDependencies, getPath, isIsoDay,
  projectFields, rowFieldsOf, exprScopeOf, itemFieldDefs, scopeFieldIndex,
  type CalcType, type CalcValue, type CalculatedField, type Expr, type ExprScope, type FieldDef, type LookupTable, type Missing, type Predicate, type Project, type SyntheticRecord,
} from '@iss/model';
import { formatCents, formatDate, formatNumber } from '@iss/resolver';

/** Pure helpers behind the Calculations screen: which choices a step offers, what a new step starts as, and values for every customer. */

/** What a step must give: one of the five kinds, or text, a number or a date that JOIN can put into text. */
export type Expected = CalcType | 'joinable';

export type KindId =
  | 'field' | 'calc' | 'issueDate' | 'constNumber' | 'constMoney' | 'constText' | 'constDate' | 'constBool'
  | 'add' | 'sub' | 'mul' | 'div' | 'round' | 'min' | 'max' | 'abs'
  | 'days' | 'addDays' | 'earlier' | 'later' | 'join'
  | 'count' | 'sum' | 'smallest' | 'largest' | 'if' | 'lookup';

export const KIND_LABEL: Record<KindId, string> = {
  field: 'A data field', calc: 'Another calculation', issueDate: 'The document’s date',
  constNumber: 'A number', constMoney: 'An amount', constText: 'Fixed text', constDate: 'A fixed date', constBool: 'Yes or no',
  add: 'Add', sub: 'Subtract', mul: 'Multiply', div: 'Divide', round: 'Round', min: 'Smallest of', max: 'Largest of', abs: 'Without its sign',
  days: 'Days between two dates', addDays: 'A date plus days', earlier: 'The earlier of two dates', later: 'The later of two dates', join: 'Join text',
  count: 'Number of rows in a list', sum: 'Total of a list column', smallest: 'Smallest in a list column', largest: 'Largest in a list column',
  if: 'If … otherwise', lookup: 'A value from a lookup table',
};

export function kindOf(e: Expr): KindId {
  switch (e.op) {
    case 'field': return e.path.startsWith(CALC_PREFIX) ? 'calc' : e.path === DOCUMENT_DATE_PATH ? 'issueDate' : 'field';
    case 'number': return 'constNumber';
    case 'money': return 'constMoney';
    case 'text': return 'constText';
    case 'date': return 'constDate';
    case 'bool': return 'constBool';
    default: return e.op;
  }
}

/** What the screen needs to know about the document to offer choices. */
export interface Ctx {
  project: Project;
  scope: ExprScope;
  /** The calculation being edited (it cannot read itself, directly or through others). */
  selfKey: string | null;
  fields: FieldDef[];
  lists: FieldDef[];
  tables: LookupTable[];
}

export function makeCtx(project: Project, selfKey: string | null): Ctx {
  // Richer data shapes (wave 5): a calculation that belongs to a list offers the fields of one item first; every
  // calculation can count or add up a list inside the items (for the item, or across every item).
  const list = (project.calculatedFields ?? []).find((c) => c.key === selfKey)?.list;
  const all = list ? [...scopeFieldIndex(project, list).values()] : projectFields(project);
  const fields = list ? [...all.filter((f) => f.item === list), ...all.filter((f) => f.item !== list)] : all;
  const nested = itemFieldDefs(project.customFields).filter((f) => f.type === 'array' && !fields.some((x) => x.path === f.path));
  return { project, scope: exprScopeOf(project, list), selfKey, fields, lists: [...fields, ...nested].filter((f) => f.type === 'array' && (f.itemFields?.length ?? 0) > 0 && !f.calculated), tables: project.lookupTables ?? [] };
}

const fits = (t: CalcType | null, want: Expected): boolean => !!t && (want === 'joinable' ? t === 'text' || t === 'number' || t === 'date' : t === want);

/** Data fields a step of this kind of value can read. */
export function pickableFields(ctx: Ctx, want: Expected): FieldDef[] {
  return ctx.fields.filter((f) => !f.calculated && !f.documentDate && f.type !== 'array' && fits(calcTypeOfField(f), want));
}

/** Calculations a step can read: of the right kind, and not the one being edited nor any that reads it. */
export function pickableCalcs(ctx: Ctx, want: Expected): CalculatedField[] {
  const all = ctx.project.calculatedFields ?? [];
  const byKey = new Map(all.map((c) => [c.key, c]));
  const readsSelf = (key: string, seen = new Set<string>()): boolean => {
    if (key === ctx.selfKey) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return exprDependencies(byKey.get(key)?.expr ?? { op: 'number', value: 0 }).calcs.some((k) => readsSelf(k, seen));
  };
  return all.filter((c) => c.key !== ctx.selfKey && fits(c.type, want) && !readsSelf(c.key));
}

export function listColumns(list: FieldDef | undefined, want: CalcType[]): Array<{ key: string; label: string; type: CalcType }> {
  return (list?.itemFields ?? []).flatMap((c) => { const t = calcTypeOfField(c); return t && want.includes(t) ? [{ key: c.key, label: c.label, type: t }] : []; });
}

/** The list columns each aggregate can read. */
const AGG_TYPES: Record<'sum' | 'smallest' | 'largest', CalcType[]> = { sum: ['number', 'money'], smallest: ['number', 'money', 'date'], largest: ['number', 'money', 'date'] };

export function listsFor(ctx: Ctx, kind: 'sum' | 'smallest' | 'largest', t: CalcType): FieldDef[] {
  return ctx.lists.filter((l) => listColumns(l, [t]).length > 0 && AGG_TYPES[kind].includes(t));
}

export function tablesFor(ctx: Ctx, t: CalcType): LookupTable[] {
  return ctx.tables.filter((tb) => tb.columns.some((c) => c.type === t));
}

/** The choices a step offers, for the kind of value it must give. Only valid ones. */
export function kindsFor(want: Expected, ctx: Ctx): KindId[] {
  const out: KindId[] = [];
  const t = want;
  if (pickableFields(ctx, t).length) out.push('field');
  if (pickableCalcs(ctx, t).length) out.push('calc');
  if ((t === 'date' || t === 'joinable') && ctx.project.documentDate) out.push('issueDate');
  if (t === 'number' || t === 'joinable') out.push('constNumber');
  if (t === 'money') out.push('constMoney');
  if (t === 'text' || t === 'joinable') out.push('constText');
  if (t === 'date' || t === 'joinable') out.push('constDate');
  if (t === 'bool') out.push('constBool');
  if (t === 'number' || t === 'money') out.push('add', 'sub', 'mul', 'div', 'round', 'min', 'max', 'abs');
  if (t === 'number') out.push('days');
  if (t === 'date') out.push('addDays', 'earlier', 'later');
  if (t === 'text') out.push('join');
  if (t === 'number' && ctx.lists.length) out.push('count');
  if (t === 'number' || t === 'money') { if (listsFor(ctx, 'sum', t).length) out.push('sum'); }
  if (t === 'number' || t === 'money' || t === 'date') { if (listsFor(ctx, 'smallest', t).length) out.push('smallest', 'largest'); }
  if (t !== 'joinable') out.push('if');
  if (t !== 'joinable' && tablesFor(ctx, t).length) out.push('lookup');
  return out;
}

const constOf = (t: Expected): Expr => (t === 'money' ? { op: 'money', cents: 0 } : t === 'text' ? { op: 'text', value: '' } : t === 'date' ? { op: 'date', value: '2026-01-01' } : t === 'bool' ? { op: 'bool', value: false } : { op: 'number', value: 0 });

/** A simple value of this kind: the first data field that fits, else the first calculation, else a constant. */
export function seed(t: Expected, ctx: Ctx): Expr {
  const f = pickableFields(ctx, t)[0];
  if (f) return { op: 'field', path: f.path };
  const c = pickableCalcs(ctx, t)[0];
  if (c) return { op: 'field', path: `${CALC_PREFIX}${c.key}` };
  return constOf(t);
}

/** A condition to start from: the first field, compared in the way that suits its kind. */
export function seedCondition(fields: FieldDef[]): Predicate {
  const f = fields.find((x) => x.type === 'bool') ?? fields.find((x) => x.type === 'enum') ?? fields.find((x) => ['int', 'points', 'cents', 'number'].includes(x.type)) ?? fields[0];
  if (!f) return { op: 'and', args: [] };
  switch (f.type) {
    case 'bool': return { op: 'eq', path: f.path, value: true };
    case 'enum': return { op: 'eq', path: f.path, value: f.enumValues?.[0] ?? '' };
    case 'int': case 'points': case 'cents': case 'number': return { op: 'gte', path: f.path, value: 0 };
    case 'date': return { op: 'gte', path: f.path, value: '2026-01-01' };
    default: return { op: 'eq', path: f.path, value: '' };
  }
}

/** The fields a condition of a step may test: not lists, and no calculation that would read itself. */
export function conditionFields(ctx: Ctx): FieldDef[] {
  const ok = new Set((ctx.project.calculatedFields ?? []).filter((c) => pickableCalcs(ctx, c.type).some((x) => x.key === c.key)).map((c) => c.key));
  return ctx.fields.filter((f) => f.type !== 'array' && (!f.calculated || ok.has(f.path.slice(CALC_PREFIX.length))));
}

/** What a new step of this kind starts as. */
export function defaultFor(kind: KindId, want: Expected, ctx: Ctx): Expr {
  const t = want;
  switch (kind) {
    case 'field': { const f = pickableFields(ctx, t)[0]; return f ? { op: 'field', path: f.path } : seed(t, ctx); }
    case 'calc': { const c = pickableCalcs(ctx, t)[0]; return c ? { op: 'field', path: `${CALC_PREFIX}${c.key}` } : seed(t, ctx); }
    case 'issueDate': return { op: 'issueDate' };
    case 'constNumber': return { op: 'number', value: 0 };
    case 'constMoney': return { op: 'money', cents: 0 };
    case 'constText': return { op: 'text', value: '' };
    case 'constDate': return { op: 'date', value: '2026-01-01' };
    case 'constBool': return { op: 'bool', value: false };
    case 'add': case 'sub': return { op: kind, a: seed(t, ctx), b: constOf(t) };
    case 'mul': case 'div': {
      const raw: Expr = { op: kind, a: seed(t, ctx), b: { op: 'number', value: 1 } };
      // An amount times or divided by a number must say how it rounds.
      return t === 'money' ? { op: 'round', places: 2, arg: raw } : raw;
    }
    case 'round': return { op: 'round', places: t === 'money' ? 2 : 0, arg: seed(t, ctx) };
    case 'min': case 'max': return { op: kind, args: [seed(t, ctx), constOf(t)] };
    case 'abs': return { op: 'abs', arg: seed(t, ctx) };
    case 'days': return { op: 'days', from: seed('date', ctx), to: ctx.project.documentDate ? { op: 'issueDate' } : constOf('date') };
    case 'addDays': return { op: 'addDays', date: seed('date', ctx), days: { op: 'number', value: 7 } };
    case 'earlier': case 'later': return { op: kind, a: seed('date', ctx), b: constOf('date') };
    case 'join': return { op: 'join', sep: ' ', parts: [seed('joinable', ctx), seed('joinable', ctx)] };
    case 'count': return { op: 'count', list: ctx.lists[0]?.path ?? '' };
    case 'sum': case 'smallest': case 'largest': {
      const ty = (t === 'joinable' ? 'number' : t) as CalcType;
      const list = listsFor(ctx, kind, ty)[0];
      return { op: kind, list: list?.path ?? '', column: listColumns(list, [ty])[0]?.key ?? '' };
    }
    case 'if': {
      const alt = t === 'joinable' ? 'text' : t;
      return { op: 'if', when: seedCondition(conditionFields(ctx)), then: seed(alt, ctx), else: constOf(alt) };
    }
    case 'lookup': {
      const ty = (t === 'joinable' ? 'text' : t) as CalcType;
      const table = tablesFor(ctx, ty)[0];
      return {
        op: 'lookup', table: table?.id ?? '', column: table?.columns.find((c) => c.type === ty)?.key ?? '',
        keys: (table?.keys ?? []).map((k) => (k.match === 'text' ? seed('text', ctx) : k.match === 'date-range' ? (ctx.project.documentDate ? { op: 'issueDate' } as Expr : seed('date', ctx)) : seed(k.unit === 'money' ? 'money' : 'number', ctx))),
      };
    }
  }
}

/** The name of a step's place in its parent ("First value", "Otherwise"). */
export function slotLabel(parent: Expr | null, slot: string, ctx: Ctx): string {
  if (!parent) return 'Result';
  const n = Number(slot.split('.')[1]);
  switch (parent.op) {
    case 'add': return slot === 'a' ? 'First value' : 'Plus';
    case 'sub': return slot === 'a' ? 'Start with' : 'Minus';
    case 'mul': return slot === 'a' ? 'Multiply' : 'Times';
    case 'div': return slot === 'a' ? 'Divide' : 'By';
    case 'round': return 'Value to round';
    case 'min': case 'max': return `Value ${n + 1}`;
    case 'abs': return 'Value';
    case 'days': return slot === 'from' ? 'From date' : 'To date';
    case 'addDays': return slot === 'date' ? 'Date' : 'Number of days';
    case 'earlier': case 'later': return slot === 'a' ? 'First date' : 'Second date';
    case 'join': return `Part ${n + 1}`;
    case 'if': return slot === 'then' ? 'Then' : 'Otherwise';
    case 'lookup': return ctx.tables.find((t) => t.id === parent.table)?.keys[n]?.label ?? `Key ${n + 1}`;
    default: return slot;
  }
}

/** What each child slot of a step must give. */
export function childWant(parent: Expr, slot: string, want: Expected, ctx: Ctx): Expected {
  switch (parent.op) {
    case 'add': case 'sub': case 'round': case 'min': case 'max': case 'abs': return want;
    case 'mul': case 'div': return want === 'money' && slot === 'b' ? 'number' : want;
    case 'days': case 'earlier': case 'later': return 'date';
    case 'addDays': return slot === 'date' ? 'date' : 'number';
    case 'join': return 'joinable';
    case 'if': return want;
    case 'lookup': {
      const k = ctx.tables.find((t) => t.id === parent.table)?.keys[Number(slot.split('.')[1])];
      return !k ? 'text' : k.match === 'text' ? 'text' : k.match === 'date-range' ? 'date' : k.unit === 'money' ? 'money' : 'number';
    }
    default: return want;
  }
}

/** Replaces the node at a slot path with another and returns the new tree (the original is not changed). */
export function replaceAt(e: Expr, path: string, next: Expr): Expr {
  if (!path) return next;
  const parts = path.split('.');
  const go = (x: Expr, i: number): Expr => {
    const slot = /^\d+$/.test(parts[i + 1] ?? '') ? `${parts[i]}.${parts[i + 1]}` : parts[i];
    const used = slot.includes('.') ? 2 : 1;
    const child = (c: Expr): Expr => (i + used >= parts.length ? next : go(c, i + used));
    const copy = JSON.parse(JSON.stringify(x)) as Record<string, any>;
    if (slot.includes('.')) { const [k, idx] = slot.split('.'); copy[k][Number(idx)] = child(copy[k][Number(idx)]); }
    else copy[slot] = child(copy[slot]);
    return copy as Expr;
  };
  return go(e, 0);
}

/* ------------------------------------------------------------------ values */

/** A value of a kind as the document would show it (amounts, dates and numbers in the document language). */
export function formatCalcValue(type: CalcType | null, v: CalcValue | null, locale: string): string {
  if (v === null || v === undefined) return '';
  switch (type) {
    case 'money': return typeof v === 'number' ? formatCents(v, locale) : String(v);
    case 'date': return typeof v === 'string' ? formatDate(v, locale) : String(v);
    case 'number': return typeof v === 'number' ? formatNumber(v, locale) : String(v);
    case 'bool': return v === true ? 'Yes' : v === false ? 'No' : String(v);
    default: return String(v);
  }
}

/** What a calculation's type is called on screen. */
export const TYPE_NAME: Record<CalcType, string> = { number: 'Number', money: 'Amount', date: 'Date', text: 'Text', bool: 'Yes or no' };

/** The date a document is issued on for a customer: from the customer's date field, else the one given for this preview. */
export function issueDateFor(project: Pick<Project, 'documentDate'>, ctx: unknown, given: string | null): string | null {
  const src = project.documentDate;
  if (!src) return null;
  // As the resolver does: a day given for the preview wins over the customer's own date.
  if (given && isIsoDay(given)) return given;
  if (src.source === 'field') { const v = getPath(ctx, src.path); return isIsoDay(v) ? v : null; }
  return null;
}

export interface CustomerValue { recordId: string; value: CalcValue | null; missing?: Missing }

/** Every calculation worked out for every customer (the engine's own function, once per customer). */
export function evaluateForCustomers(project: Project, records: SyntheticRecord[], given: string | null): Map<string, Record<string, CustomerValue>> {
  const out = new Map<string, Record<string, CustomerValue>>();
  for (const key of (project.calculatedFields ?? []).map((c) => c.key)) out.set(key, {});
  if (!project.calculatedFields?.length) return out;
  for (const r of records) {
    const ctx = buildContext(r) as Record<string, unknown>;
    const issue = issueDateFor(project, ctx, given);
    if (project.documentDate) ctx.document = { date: issue };
    const res = evaluateCalculations(project, ctx, issue);
    for (const [key, byRecord] of out) {
      const v = res.values[key];
      byRecord[r.recordId] = v === null || v === undefined ? { recordId: r.recordId, value: null, missing: res.missing[key] } : { recordId: r.recordId, value: v };
    }
  }
  return out;
}

export interface Band { label: string; count: number; from?: number | string; to?: number | string }
export interface Summary {
  withValue: number;
  without: number;
  smallest: CalcValue | null;
  largest: CalcValue | null;
  /** Distinct values (when there are few) or equal bands (numbers, amounts, dates), each with how many customers. */
  bands: Band[];
  bandsKind: 'values' | 'bands';
  /** Customers without a value, grouped by the engine's reason. */
  missing: Array<{ reason: string; code: string; recordIds: string[] }>;
}

export function summarise(type: CalcType, rows: CustomerValue[], locale: string): Summary {
  const have = rows.filter((r) => r.value !== null) as Array<CustomerValue & { value: CalcValue }>;
  const groups = new Map<string, { reason: string; code: string; recordIds: string[] }>();
  for (const r of rows) if (r.value === null) {
    const reason = r.missing?.message ?? 'No value.';
    const g = groups.get(reason) ?? { reason, code: r.missing?.code ?? 'invalid', recordIds: [] };
    g.recordIds.push(r.recordId);
    groups.set(reason, g);
  }
  const base = { withValue: have.length, without: rows.length - have.length, missing: [...groups.values()] };
  if (!have.length) return { ...base, smallest: null, largest: null, bands: [], bandsKind: 'values' };
  const show = (v: CalcValue) => formatCalcValue(type, v, locale);
  const counts = new Map<CalcValue, number>();
  for (const r of have) counts.set(r.value, (counts.get(r.value) ?? 0) + 1);
  const orderable = type === 'number' || type === 'money' || type === 'date';
  const sorted = [...counts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const smallest = orderable ? sorted[0] : null, largest = orderable ? sorted[sorted.length - 1] : null;
  if (!orderable || sorted.length <= 8) {
    const keys = orderable ? sorted : [...counts.keys()].sort((a, b) => (counts.get(b)! - counts.get(a)!) || String(a).localeCompare(String(b)));
    return { ...base, smallest, largest, bandsKind: 'values', bands: keys.slice(0, 12).map((k) => ({ label: show(k), count: counts.get(k)!, from: k as number | string })) };
  }
  // Five equal bands between the smallest and the largest (dates by day number).
  const num = (v: CalcValue): number => (type === 'date' ? dayNumber(v as string) : (v as number));
  const lo = num(sorted[0]), hi = num(sorted[sorted.length - 1]);
  const width = (hi - lo) / 5 || 1;
  const bands: Band[] = Array.from({ length: 5 }, (_, i) => ({ label: '', count: 0, from: lo + width * i, to: i === 4 ? hi : lo + width * (i + 1) }));
  for (const r of have) { const i = Math.min(4, Math.floor((num(r.value) - lo) / width)); bands[i].count++; }
  const at = (n: number): string => show(type === 'date' ? dayFromNumber(Math.round(n)) : type === 'money' ? Math.round(n) : Math.round(n * 100) / 100);
  bands.forEach((b, i) => { b.label = `${at(b.from as number)} to ${at(b.to as number)}${i === 4 ? '' : ' (not included)'}`; });
  return { ...base, smallest, largest, bands, bandsKind: 'bands' };
}

/** What to do about a missing value, by the engine's reason (the same advice the resolver's finding gives). */
export function whatToDo(code: string, label: string): string {
  switch (code) {
    case 'input-missing': return `Fill in the missing value in this customer’s data, or change “${label}” so it copes without it (for example with IF … IS EMPTY).`;
    case 'division-by-zero': return `Change “${label}” so it never divides by zero (for example with an If step), or correct this customer’s data.`;
    case 'no-lookup-row': case 'no-lookup-value': return 'Add a row that covers this customer to the lookup table, or give the table a default row.';
    case 'no-date': return 'Choose where the document’s date comes from (Dates), or give a date for this preview.';
    default: return `Check the calculation “${label}”.`;
  }
}

/** A key for a new calculation or table from its name ("Days to renewal" becomes daysToRenewal). */
export function keyFromLabel(label: string, taken: Set<string>, fallback: string): string {
  const words = label.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  let base = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('').slice(0, 36);
  if (!/^[a-zA-Z]/.test(base)) base = fallback;
  let key = base, n = 2;
  while (taken.has(key)) key = `${base}${n++}`;
  return key;
}

/** Problems of an expression by the step they are at. */
export function problemsBySlot(expr: Expr, scope: ExprScope): { type: CalcType | null; byAt: Map<string, string[]> } {
  const { type, problems } = checkExpr(expr, scope);
  const byAt = new Map<string, string[]>();
  for (const p of problems) byAt.set(p.at, [...(byAt.get(p.at) ?? []), p.message]);
  return { type, byAt };
}

export { rowFieldsOf };

export const CALC_TYPES: CalcType[] = ['number', 'money', 'date', 'text', 'bool'];
