import {
  applyCommand, applyJourney, buildContext, deepClone, getPath, inEffect, notInEffectWords, projectFieldIndex,
  type DocNode, type FieldDef, type Predicate, type Project, type Rule, type Scalar, type SyntheticRecord, type TestCase,
} from '@iss/model';
// Richer data shapes (wave 5): conditions about the items of a list.
import { allFieldIndex, isItemPath, itemPrefix, itemsLead, repeatListAt, scopeCtx, setPath, type ItemsCondition } from '@iss/model';
import { evaluatePredicate } from '@iss/resolver';
import { formatCents, formatDate, resolve, type Finding, type RNode, type Resolution } from '@iss/resolver';
import { captureExpectation, nextTestId } from '../testCases';
import type { CoverageGap } from './types';

/**
 * Coverage: rules, message versions and sections that no synthetic customer exercises, each with a what-if that reaches
 * it (confirmed by the real resolver) and a ready-to-pin test. Pure and deterministic; nothing is applied.
 *
 * How a scenario is found: the conditions that must hold are taken from the rule (and, for a message or section, from
 * the rule or inline condition that selects it, plus "no higher-priority rule matches"), brought into "any of these
 * combinations" form, and for each candidate customer the fewest field changes that satisfy one combination are derived
 * from the field types. Candidates are tried closest-first, with and without journey steps, and a scenario is accepted
 * only after `resolve` confirms the target is reached.
 */

/* ------------------------------------------------------------------ conditions as "any of these combinations" */

type LitKind = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'null' | 'notnull' | 'items';
/** `items` (wave 5): a condition about the items of a list (`items`), required to hold or, with `neg`, not to hold. */
interface Lit { path: string; kind: LitKind; value?: Scalar; values?: Scalar[]; items?: ItemsCondition; neg?: boolean }
type Conj = Lit[];

const MAX_CONJ = 256;
const TRUE: Predicate = { op: 'and', args: [] };
const and = (args: Predicate[]): Predicate => (args.length === 1 ? args[0] : { op: 'and', args });
const or = (args: Predicate[]): Predicate => (args.length === 1 ? args[0] : { op: 'or', args });
const not = (arg: Predicate): Predicate => ({ op: 'not', arg });

const COMPLEMENT: Record<string, LitKind> = { eq: 'ne', ne: 'eq', gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt' };

/** Mirrors the resolver: every comparison is false on an empty value, so "not (x = 1)" is "x is something else" OR "x is empty". */
function holds(l: Lit, v: unknown): boolean {
  if (v === undefined) v = null;
  switch (l.kind) {
    case 'items': return true; // decided on the whole customer (`itemsHold`), never on one value
    case 'null': return v === null;
    case 'notnull': return v !== null;
    case 'in': return v !== null && (l.values ?? []).includes(v as Scalar);
    case 'nin': return v !== null && !(l.values ?? []).includes(v as Scalar);
    case 'eq': return v !== null && v === l.value;
    case 'ne': return v !== null && v !== l.value;
    default: {
      const val = l.value;
      if (v === null || val === null || val === undefined || typeof v !== typeof val) return false;
      const a = v as number | string, b = val as number | string;
      return l.kind === 'gt' ? a > b : l.kind === 'gte' ? a >= b : l.kind === 'lt' ? a < b : a <= b;
    }
  }
}

function dnf(p: Predicate, neg: boolean, keep: (c: Conj) => boolean): Conj[] {
  switch (p.op) {
    case 'and':
    case 'or': {
      const kids = p.args.map((a) => dnf(a, neg, keep));
      if ((p.op === 'and') === neg) return kids.flat().slice(0, MAX_CONJ);
      let acc: Conj[] = [[]];
      for (const k of kids) {
        const next: Conj[] = [];
        for (const a of acc) for (const b of k) { if (next.length >= MAX_CONJ) break; const c = [...a, ...b]; if (keep(c)) next.push(c); }
        acc = next;
      }
      return acc;
    }
    case 'not': return dnf(p.arg, !neg, keep);
    case 'isNull': return [[{ path: p.path, kind: neg ? 'notnull' : 'null' }]];
    case 'notNull': return [[{ path: p.path, kind: neg ? 'null' : 'notnull' }]];
    case 'in': return neg ? [[{ path: p.path, kind: 'nin', values: p.value }], [{ path: p.path, kind: 'null' }]] : [[{ path: p.path, kind: 'in', values: p.value }]];
    case 'items': return [[{ path: p.path, kind: 'items', items: p, neg }]];
    default: return neg ? [[{ path: p.path, kind: COMPLEMENT[p.op], value: p.value }], [{ path: p.path, kind: 'null' }]] : [[{ path: p.path, kind: p.op, value: p.value }]];
  }
}

/* ------------------------------------------------------------------ values a field can take */

function shiftDay(iso: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** A small, ordered set of values worth trying for one field: for whole numbers a solution, if any, sits next to a bound or an excluded value. */
function valuesFor(field: FieldDef, lits: Lit[], current: unknown): unknown[] {
  const mentioned = lits.flatMap((l) => (l.values ? l.values : l.value !== undefined ? [l.value] : []));
  let out: unknown[];
  switch (field.type) {
    case 'int': case 'cents': case 'points': {
      const nums = mentioned.filter((v): v is number => typeof v === 'number');
      const all = [...new Set([...nums.flatMap((n) => [n, n + 1, n - 1]), 0, 1])].filter((n) => Number.isInteger(n));
      const cur = typeof current === 'number' ? current : null;
      const rank = (n: number): number => (n < 0 ? 1e15 : 0) + (cur === null ? Math.abs(n) : Math.abs(n - cur));
      out = all.sort((a, b) => rank(a) - rank(b) || a - b);
      break;
    }
    case 'bool': out = [true, false]; break;
    case 'enum': out = [...(field.enumValues ?? []), ...mentioned.filter((v) => typeof v === 'string' && !(field.enumValues ?? []).includes(v))]; break;
    case 'date': {
      const dates = mentioned.filter((v): v is string => typeof v === 'string');
      out = [...new Set([...dates.flatMap((d) => [d, shiftDay(d, 1), shiftDay(d, -1)]), '2026-01-01'])].filter((d): d is string => !!d);
      break;
    }
    case 'array': out = [[]]; break;
    default: out = [...new Set([...mentioned.filter((v) => typeof v === 'string'), field.example ?? 'Sample', 'Sample', 'Sample B'])];
  }
  if (lits.some((l) => l.kind === 'null')) out.push(null);
  return out;
}

/* ------------------------------------------------------------------ conditions about the items of a list (wave 5) */

/** Whether a component inside a repeating section is shown for at least one item (its own id or `<id>~<n>`). */
function shownForAnItem(res: Resolution, nodeId: string): boolean {
  for (const n of treeOf(res).values()) if ((n.instanceOf ?? n.id) === nodeId && n.visible) return true;
  return false;
}

/** Whether an items condition holds (or, negated, does not hold) for a customer. */
function itemsHold(l: Lit, ctx: unknown): boolean {
  return evaluatePredicate(l.items!, ctx) !== !!l.neg;
}

/** A plain row for a list: every field of an item with a neutral value (text, zero, the first choice, no inner rows). */
function sampleItem(fields: Map<string, FieldDef>, list: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const pre = `${itemPrefix(list)}.`;
  for (const f of fields.values()) {
    if (f.item !== list || f.derived || f.calculated || !f.path.startsWith(pre)) continue;
    const rel = f.path.slice(pre.length);
    const v = f.type === 'array' ? [] : f.type === 'string' ? 'Sample' : f.type === 'date' ? '2026-01-01' : f.type === 'bool' ? false : f.type === 'enum' ? f.enumValues?.[0] ?? null : 0;
    setPath(row, rel, v as Scalar);
  }
  return row;
}

/**
 * The fewest changes to a top-level list that make its items conditions hold: "every", "none" and "fewer than n" hold
 * for an empty list; "any" and "at least n" change the first items (adding rows when there are too few) until enough
 * meet the condition. Null when a condition reads something the items cannot be given (a calculated value, say).
 */
function solveItems(project: Project, lits: Lit[], ctx: unknown): unknown[] | null {
  const list = lits[0].path;
  if (isItemPath(list)) return null;
  const fields = allFieldIndex(project);
  const cur = getPath(ctx, list);
  let rows: Array<Record<string, unknown>> = Array.isArray(cur) ? deepClone(cur) as Array<Record<string, unknown>> : [];
  for (const l of lits) {
    const p = l.items!;
    const notWhere: Predicate = { op: 'not', arg: p.where };
    const need = p.match === 'any' ? (l.neg ? null : { k: 1, where: p.where })
      : p.match === 'none' ? (l.neg ? { k: 1, where: p.where } : null)
      : p.match === 'every' ? (l.neg ? { k: 1, where: notWhere } : null)
      : (l.neg ? null : { k: Math.max(1, p.count ?? 1), where: p.where });
    if (!need) { rows = []; continue; }
    while (rows.length < need.k) rows.push(rows.length ? deepClone(rows[rows.length - 1]) : sampleItem(fields, list));
    for (let i = 0; i < need.k; i++) {
      const solved = solveItem(fields, list, need.where, rows[i], ctx, i);
      if (!solved) return null;
      rows[i] = solved;
    }
  }
  return rows;
}

/** One item changed so that it meets `where` (tried one "all of these" combination at a time). */
function solveItem(fields: Map<string, FieldDef>, list: string, where: Predicate, item: Record<string, unknown>, ctx: unknown, index: number): Record<string, unknown> | null {
  const pre = `${itemPrefix(list)}.`;
  const holdsIn = (row: Record<string, unknown>) => evaluatePredicate(where, scopeCtx(ctx as Record<string, unknown>, list, row, index));
  if (holdsIn(item)) return item;
  for (const conj of dnf(where, false, () => true).slice(0, 12)) {
    const row = deepClone(item);
    let ok = true;
    const by = new Map<string, Lit[]>();
    for (const l of conj) by.set(l.path, [...(by.get(l.path) ?? []), l]);
    for (const [path, ls] of by) {
      if (!path.startsWith(pre)) { if (!ls.every((l) => holds(l, getPath(ctx, path)))) { ok = false; break; } continue; }
      const rel = path.slice(pre.length);
      const count = rel.endsWith('.count') ? fields.get(path.slice(0, -6)) : undefined;
      if (count?.type === 'array') {
        const n = valuesFor({ path, type: 'int', label: '' }, ls, getPath(row, rel)).find((v) => ls.every((l) => holds(l, v)));
        if (typeof n !== 'number' || n < 0 || n > 500) { ok = false; break; }
        const arr = Array.isArray(getPath(row, rel.slice(0, -6))) ? getPath(row, rel.slice(0, -6)) as unknown[] : [];
        resize(arr, n, count);
        setPath(row, rel.slice(0, -6), arr as unknown as Scalar);
        continue;
      }
      const f = fields.get(path);
      if (!f || f.derived || f.calculated) { ok = false; break; }
      const v = valuesFor(f, ls, getPath(row, rel)).find((x) => ls.every((l) => holds(l, x)));
      if (v === undefined) { ok = false; break; }
      setPath(row, rel, v as Scalar);
    }
    if (ok && holdsIn(row)) return row;
  }
  return null;
}

/* ------------------------------------------------------------------ the search environment */

interface Hit { record: SyntheticRecord; overrides: Record<string, unknown>; cursor: number | null; changes: Array<[string, unknown]>; res: Resolution; newBlocking: Finding[] }
interface SearchResult { hit: Hit | null; satisfiable: boolean; tried: number }

const blockingKey = (f: Finding): string => `${f.code}|${f.nodeId ?? ''}|${f.locale ?? ''}`;
const customerName = (r: SyntheticRecord): string => `${r.customer.givenName} ${r.customer.familyName}`.trim() || r.recordId;
const q = (s: string): string => `“${s}”`;
const listOf = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const humanise = (s: string): string => { const t = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').trim().toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : t; };
const groupOf = (r: Rule): string => r.exclusiveGroup ?? ('targetNodeId' in r.then ? r.then.targetNodeId : '');

class Env {
  readonly recs: SyntheticRecord[];
  readonly fields: Map<string, FieldDef>;
  readonly events: Project['journey']['events'];
  readonly baseBlocking: Array<Set<string>> = [];
  private readonly states = new Map<number, Array<{ cursor: number | null; ctx: unknown }>>();
  private readonly base = new Map<number, unknown>();

  constructor(readonly project: Project, records: SyntheticRecord[], readonly maxCandidates: number, readonly issueDate: string | null = null) {
    this.recs = records.filter((r) => r.documentType === project.documentType);
    this.fields = projectFieldIndex(project);
    this.events = project.journey?.events ?? [];
  }

  /** The customer as issued. */
  baseCtx(i: number): unknown {
    if (!this.base.has(i)) this.base.set(i, buildContext(this.recs[i]));
    return this.base.get(i);
  }

  /** Requirement combinations that some customer could satisfy. */
  combos(preds: Predicate[]): Conj[] {
    return preds.flatMap((p) => dnf(p, false, this.satisfiable)).filter(this.satisfiable).slice(0, 12);
  }

  /** Baseline plus every journey step that actually changes this customer's data. */
  statesOf(i: number): Array<{ cursor: number | null; ctx: unknown }> {
    let s = this.states.get(i);
    if (!s) {
      const seen = new Set<string>();
      s = [];
      for (const cursor of [null, ...this.events.map((_, k) => k)]) {
        const rec = applyJourney(this.recs[i], this.events, cursor).record;
        const print = JSON.stringify(rec);
        if (seen.has(print)) continue;
        seen.add(print);
        s.push({ cursor, ctx: buildContext(rec) });
      }
      this.states.set(i, s);
    }
    return s;
  }

  /** A field a what-if can set. The document type and record id cannot change; derived values need a known recipe. */
  overridable(path: string): boolean {
    const f = this.fields.get(path);
    if (!f || path === 'documentType' || path === 'recordId') return false;
    if (path.endsWith('.count')) return this.fields.get(path.slice(0, -6))?.type === 'array';
    return !f.derived || path === 'card.availableCreditCents';
  }

  byPath(conj: Conj): Map<string, Lit[]> {
    const m = new Map<string, Lit[]>();
    for (const l of conj) m.set(l.path, [...(m.get(l.path) ?? []), l]);
    return m;
  }

  /** Can this combination hold for some customer at all (ignoring which customer)? */
  satisfiable = (conj: Conj): boolean => {
    for (const [path, lits] of this.byPath(conj)) {
      if (lits.some((l) => l.kind === 'items')) continue; // decided per customer
      if (path === 'documentType') { if (!lits.every((l) => holds(l, this.project.documentType))) return false; continue; }
      const f = this.fields.get(path);
      if (!f || !this.overridable(path)) continue; // decided per customer
      if (!valuesFor(f, lits, null).some((v) => lits.every((l) => holds(l, v)))) return false;
    }
    return true;
  };

  /** The fewest field changes that make this combination hold for a customer in a given state; null when it cannot. */
  plan(conj: Conj, ctx: unknown): Array<[string, unknown]> | null {
    const changes: Array<[string, unknown]> = [];
    for (const [path, lits] of this.byPath(conj)) {
      if (lits.some((l) => l.kind === 'items')) {
        // Richer data shapes (wave 5): the list is changed as a whole so that enough of its items meet the condition.
        if (lits.every((l) => l.kind !== 'items' || itemsHold(l, ctx))) continue;
        const rows = solveItems(this.project, lits.filter((l) => l.kind === 'items'), ctx);
        if (!rows) return null;
        changes.push([path, rows]);
        continue;
      }
      const cur = getPath(ctx, path) as unknown;
      if (lits.every((l) => holds(l, cur))) continue;
      const f = this.fields.get(path);
      if (!f || !this.overridable(path)) return null;
      const v = valuesFor(f, lits, cur).find((x) => lits.every((l) => holds(l, x)));
      if (v === undefined) return null;
      changes.push([path, v]);
    }
    return changes;
  }

  /**
   * Field changes as a what-if patch on the source record (arrays replace wholesale; `claim.*` is the first claim).
   * `told` lists what is really set, for the explanation: a derived value is reached through the field it is computed from.
   */
  toOverrides(record: SyntheticRecord, changes: Array<[string, unknown]>): { overrides: Record<string, unknown>; told: Array<[string, unknown]> } | null {
    const out: Record<string, unknown> = {};
    const told: Array<[string, unknown]> = [];
    const put = (path: string, value: unknown): void => {
      const parts = path.split('.');
      let t = out;
      for (const p of parts.slice(0, -1)) { if (!t[p] || typeof t[p] !== 'object' || Array.isArray(t[p])) t[p] = {}; t = t[p] as Record<string, unknown>; }
      t[parts[parts.length - 1]] = value;
    };
    const arrays = new Map<string, unknown[]>();
    const arrayOf = (path: string): unknown[] => {
      let a = arrays.get(path);
      if (!a) { const cur = getPath(record, path) as unknown; a = Array.isArray(cur) ? deepClone(cur) as unknown[] : []; arrays.set(path, a); }
      return a;
    };
    const ordered = [...changes].sort((a, b) => Number(b[0].endsWith('.count')) - Number(a[0].endsWith('.count')) || (a[0] < b[0] ? -1 : 1));
    for (const [path, value] of ordered) {
      const f = this.fields.get(path);
      if (path.endsWith('.count') && this.fields.get(path.slice(0, -6))?.type === 'array') {
        if (typeof value !== 'number' || value < 0 || value > 500) return null;
        resize(arrayOf(path.slice(0, -6)), value, this.fields.get(path.slice(0, -6))!);
      } else if (this.project.documentType === 'eob' && path.startsWith('claim.')) {
        const claims = arrayOf('claims');
        if (!claims.length) claims.push({});
        (claims[0] as Record<string, unknown>)[path.slice(6)] = value;
      } else if (path === 'card.availableCreditCents') {
        const balance = getPath(record, 'card.newBalanceCents') as unknown;
        if (typeof balance !== 'number' || typeof value !== 'number') return null;
        put('card.creditLimitCents', balance + value);
        told.push(['card.creditLimitCents', balance + value]);
        continue;
      } else if (f?.type === 'array') arrays.set(path, Array.isArray(value) ? value : []);
      else put(path, value);
      told.push([path, value]);
    }
    for (const [path, arr] of arrays) put(path, arr);
    return { overrides: out, told };
  }

  /** Try the given requirement alternatives, cheapest change first, and return the first scenario `resolve` confirms (preferring one without blocking issues). */
  search(preds: Predicate[], confirmed: (res: Resolution) => boolean): SearchResult {
    const conjs = this.combos(preds);
    if (!conjs.length) return { hit: null, satisfiable: false, tried: 0 };
    // Closest customers first. Among equally close ones, customers that need a DIFFERENT field changed come before
    // more of the same, so the bounded search does not spend itself on one kind of what-if.
    const kinds = new Map<string, number>();
    const candidates = this.recs.map((_, i) => {
      let cost = 99;
      let kind = '';
      for (const c of conjs) { const plan = this.plan(c, this.baseCtx(i)); if (plan && plan.length < cost) { cost = plan.length; kind = plan.map(([path]) => path).sort().join('+'); } }
      const blocked = this.baseBlocking[i]?.size ? 1 : 0;
      const group = `${cost}|${blocked}|${kind}`;
      const nth = kinds.get(group) ?? 0;
      kinds.set(group, nth + 1);
      return { i, cost, blocked, nth };
    }).sort((a, b) => a.cost - b.cost || a.blocked - b.blocked || a.nth - b.nth || a.i - b.i).slice(0, this.maxCandidates);
    interface Attempt { i: number; rank: number; cursor: number | null; changes: Array<[string, unknown]>; overrides: Record<string, unknown>; ci: number }
    const attempts: Attempt[] = [];
    const seen = new Set<string>();
    candidates.forEach((cand, rank) => {
      for (const state of this.statesOf(cand.i)) {
        conjs.forEach((conj, ci) => {
          const changes = this.plan(conj, state.ctx);
          const patch = changes && this.toOverrides(this.recs[cand.i], changes);
          if (!changes || !patch) return;
          const key = `${cand.i}|${state.cursor}|${JSON.stringify(patch.overrides)}`;
          if (seen.has(key)) return;
          seen.add(key);
          attempts.push({ i: cand.i, rank, cursor: state.cursor, changes: patch.told, overrides: patch.overrides, ci });
        });
      }
    });
    const step = (c: number | null): number => (c === null ? -1 : c);
    attempts.sort((a, b) => a.changes.length - b.changes.length || step(a.cursor) - step(b.cursor) || a.rank - b.rank || a.ci - b.ci);
    const budget = Math.max(8, this.maxCandidates * 2);
    let best: { hit: Hit; score: number } | null = null;
    let tried = 0;
    for (const a of attempts.slice(0, budget)) {
      tried++;
      const record = this.recs[a.i];
      const res = resolve({ project: this.project, record, overrides: a.overrides, journeyCursor: a.cursor, ...(this.issueDate ? { issueDate: this.issueDate } : {}) });
      if (!confirmed(res)) continue;
      const blocking = res.findings.filter((f) => f.severity === 'blocking');
      const newBlocking = blocking.filter((f) => !this.baseBlocking[a.i]?.has(blockingKey(f)));
      const hit: Hit = { record, overrides: a.overrides, cursor: a.cursor, changes: a.changes, res, newBlocking };
      const score = newBlocking.length ? 2 : blocking.length ? 1 : 0;
      if (score === 0) return { hit, satisfiable: true, tried };
      if (!best || score < best.score) best = { hit, score };
    }
    return { hit: best?.hit ?? null, satisfiable: true, tried };
  }
}

function resize(arr: unknown[], n: number, def: FieldDef): void {
  if (n <= arr.length) { arr.length = n; return; }
  const sample = (): Record<string, unknown> => Object.fromEntries((def.itemFields ?? []).map((f) => [f.key, f.type === 'string' ? 'Sample' : f.type === 'date' ? '2026-01-01' : f.type === 'cents' || f.type === 'int' || f.type === 'points' ? 0 : null]));
  const template = arr.length ? arr[arr.length - 1] : sample();
  for (let k = arr.length + 1; k <= n; k++) {
    const row = deepClone(template) as Record<string, unknown>;
    for (const idKey of ['id', 'claimId']) if (typeof row?.[idKey] === 'string') row[idKey] = `${row[idKey] as string}-${k}`;
    arr.push(row);
  }
}

/* ------------------------------------------------------------------ wording */

function show(field: FieldDef | undefined, v: unknown): string {
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (field?.type === 'cents' && typeof v === 'number') return formatCents(v);
  if (field?.type === 'date' && typeof v === 'string') return formatDate(v);
  if (Array.isArray(v)) return v.length ? `${v.length} rows` : 'an empty list';
  return typeof v === 'string' ? q(v) : String(v);
}

const LIT_WORDS: Record<LitKind, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', in: 'is one of', nin: 'is none of', null: 'is empty', notnull: 'is filled in', items: 'meets' };
function describeLit(fields: Map<string, FieldDef>, l: Lit): string {
  const f = fields.get(l.path);
  const label = f?.label ?? l.path;
  if (l.kind === 'items') return `${l.neg ? 'not ' : ''}${itemsLead(l.items!.match, l.items!.count, label).replace(/,$/, '')} the condition holds`;
  if (l.kind === 'null' || l.kind === 'notnull') return `${label} ${LIT_WORDS[l.kind]}`;
  const value = l.values ? l.values.map((v) => show(f, v)).join(', ') : show(f, l.value);
  return `${label} ${LIT_WORDS[l.kind]} ${value}`;
}

function stepLabel(project: Project, cursor: number): string {
  const e = project.journey.events[cursor];
  return e ? `${e.day ? `Day ${e.day} · ` : ''}${e.label ?? humanise(e.eventType)}` : `step ${cursor + 1}`;
}

function explain(env: Env, hit: Hit): string {
  const who = customerName(hit.record);
  const sets = hit.changes.map(([path, v]) => `${env.fields.get(path)?.label ?? path} to ${show(env.fields.get(path), v)}`);
  const at = hit.cursor !== null ? `the journey step ${q(stepLabel(env.project, hit.cursor))}` : '';
  let text = sets.length && at ? `Start from ${who}, set ${listOf(sets)} and go to ${at}.`
    : sets.length ? `Start from ${who} and set ${listOf(sets)}.`
    : at ? `${who} reaches this at ${at} without any change to the data.`
    : `${who} reaches this without any change.`;
  if (hit.newBlocking.length) text += ` Note: this what-if also raises ${hit.newBlocking.length === 1 ? 'a blocking issue' : `${hit.newBlocking.length} blocking issues`} that the customer does not have today (${hit.newBlocking[0].message}), so the pinned test will not expect a clean document.`;
  else if (hit.res.findings.some((f) => f.severity === 'blocking')) text += ' Note: this customer already has a blocking issue today, so the pinned test will not expect a clean document.';
  return text;
}

/** Why a requirement can never hold: the first field whose conditions exclude each other. */
function contradiction(env: Env, p: Predicate): string | null {
  for (const conj of dnf(p, false, () => true).slice(0, 4)) {
    for (const [path, lits] of env.byPath(conj)) {
      const f = env.fields.get(path);
      const impossible = path === 'documentType' ? !lits.every((l) => holds(l, env.project.documentType)) : !!f && env.overridable(path) && !valuesFor(f, lits, null).some((v) => lits.every((l) => holds(l, v)));
      if (impossible) return lits.length > 1 ? `The conditions contradict each other: ${listOf(lits.map((l) => describeLit(env.fields, l)))} cannot all be true at once.` : `The condition can never be true for this document: ${describeLit(env.fields, lits[0])}.`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ targets */

interface Target {
  kind: CoverageGap['kind'];
  targetId: string;
  id: string;
  title: string;
  testName: string;
  /** Requirement alternatives under which the target is really reached (chosen / shown), best first. */
  alts: Predicate[];
  reached: (res: Resolution) => boolean;
  /** Weaker requirement: the rule matches (it may still lose). */
  weak: Predicate[];
  touched: (res: Resolution) => boolean;
  /** The plain condition, for explaining a contradiction. */
  core: Predicate | null;
  /** Set when nothing in the model can ever reach the target. */
  never?: string;
}

function treeOf(res: Resolution): Map<string, RNode> {
  const m = new Map<string, RNode>();
  const walk = (n: RNode): void => { m.set(n.id, n); n.children.forEach(walk); };
  walk(res.root);
  return m;
}

/**
 * Every rule, message version and section of the project as a target, with the conditions under which it is reached.
 * `covered` lists what is already exercised and is left out; pass empty sets for all of them.
 */
function targetsOf(project: Project, covered: { matched: Set<string>; selected: Set<string>; shown: Set<string> }) {
  const { matched, selected, shown } = covered;
  const docType = project.documentType;
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const parts = new Map(project.contentParts.map((c) => [c.id, c]));
  const rules = project.rules.filter((r) => r.scope === docType && r.enabled !== false);
  const nodeTitle = (id: string): string => { const n = nodes.get(id); return n ? (n.name && n.name !== n.id ? n.name : humanise(id)) : parts.get(id)?.title ?? humanise(id); };
  const partTitle = (id: string): string => parts.get(id)?.title ?? nodeTitle(id);
  const ruleTitle = (r: Rule): string => r.title ?? `Rule ${r.id}`;

  /* --- requirements */
  const rivals = (r: Rule): Rule[] => (r.mode !== 'exclusive' ? [] : rules.filter((x) => x.id !== r.id && x.mode === 'exclusive' && groupOf(x) === groupOf(r) && x.priority >= r.priority));
  const winning = (r: Rule): Predicate => and([r.when, ...rivals(r).map((x) => not(x.when))]);
  const selectorsOf = (nodeId: string, variantId?: string): Rule[] => rules.filter((r) => r.then.op === 'selectVariant' && r.then.targetNodeId === nodeId && (variantId === undefined || r.then.variantId === variantId))
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
  const showersOf = (id: string): Rule[] => rules.filter((r) => r.mode === 'additive' && r.then.op === 'showSection' && r.then.targetNodeId === id);
  const noRuleOn = (nodeId: string): Predicate[] => rules.filter((r) => r.mode === 'exclusive' && groupOf(r) === nodeId).map((r) => not(r.when));
  const conditionsOf = (n: DocNode): Array<[string, Predicate]> => (n.variantIds ?? []).flatMap((v) => (n.variantConditions?.[v] ? [[v, n.variantConditions[v]] as [string, Predicate]] : []));
  const ancestorsVisible = (id: string): Predicate[] => {
    const out: Predicate[] = [];
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const parent = project.nodes.find((n) => n.children?.includes(cur));
      if (!parent) break;
      if (parent.visibleWhen) out.push(parent.visibleWhen);
      cur = parent.id;
    }
    return out;
  };
  const selectedIn = (res: Resolution, nodeId: string, variantId: string): boolean => { const n = treeOf(res).get(nodeId); return !!n?.visible && !!n.variants?.selected.includes(variantId); };

  const targets: Target[] = [];

  for (const r of [...rules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (matched.has(r.id)) continue;
    const isMatched = (res: Resolution): boolean => res.result.matchedRuleIds.includes(r.id);
    const exclusive = r.mode === 'exclusive';
    targets.push({
      kind: 'rule', targetId: r.id, id: `rule:${r.id}`, title: ruleTitle(r), testName: `Reaches ${q(ruleTitle(r))}`,
      alts: [exclusive ? winning(r) : r.when],
      reached: (res) => isMatched(res) && (!exclusive || res.trace.some((t) => t.ruleId === r.id && t.outcome === 'selected')),
      weak: exclusive ? [r.when] : [], touched: isMatched, core: r.when,
    });
  }

  const variantTargets: Target[] = [];
  for (const n of project.nodes) {
    if (n.type !== 'variant-set' && !(n.type === 'conditional-region' && (n.variantIds ?? []).length > 1)) continue;
    const conds = conditionsOf(n);
    const guard = [...(n.visibleWhen ? [n.visibleWhen] : []), ...ancestorsVisible(n.id)];
    for (const v of n.variantIds ?? []) {
      if (selected.has(`${n.id}/${v}`)) continue;
      const selectors = selectorsOf(n.id, v);
      const alts: Predicate[] = selectors.map(winning);
      const cond = n.variantConditions?.[v];
      const usesConditions = n.type === 'conditional-region' && !n.ruleDriven && conds.length > 0;
      if (usesConditions && cond) {
        const earlier = n.policy === 'additive' ? [] : conds.slice(0, conds.findIndex(([id]) => id === v)).map(([, c]) => not(c));
        alts.push(and([cond, ...earlier, ...noRuleOn(n.id)]));
      }
      if (n.type === 'conditional-region' && n.ruleDriven) {
        if ((n.fallbackVariantId ?? n.variantIds?.[0]) === v && showersOf(n.id).length) alts.push(and([or(showersOf(n.id).map((r) => r.when)), ...noRuleOn(n.id)]));
      } else if (n.fallbackVariantId === v) {
        alts.push(and([...(usesConditions ? conds.map(([, c]) => not(c)) : []), ...noRuleOn(n.id)]));
      }
      const title = `${partTitle(v)} (${nodeTitle(n.id)})`;
      variantTargets.push({
        kind: 'variant', targetId: v, id: `variant:${n.id}/${v}`, title, testName: `Shows ${q(partTitle(v))} in ${nodeTitle(n.id)}`,
        alts: alts.map((a) => and([a, ...guard])), reached: (res) => selectedIn(res, n.id, v),
        weak: selectors.map((s) => s.when), touched: (res) => selectors.some((s) => res.result.matchedRuleIds.includes(s.id)),
        core: selectors[0]?.when ?? cond ?? null,
        ...(alts.length ? {} : { never: 'No rule or condition selects this message and it is not the fallback, so no customer can receive it.' }),
      });
    }
  }
  targets.push(...variantTargets.sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : a.id < b.id ? -1 : 1)));

  const sectionTargets: Target[] = [];
  for (const n of project.nodes) {
    if (n.type !== 'conditional-region' && !n.visibleWhen) continue;
    if (shown.has(n.id)) continue;
    let own: Predicate | null = TRUE;
    let never: string | undefined;
    if (n.type === 'conditional-region') {
      const selectors = selectorsOf(n.id).map((r) => r.when);
      const conds = conditionsOf(n).map(([, c]) => c);
      if (n.ruleDriven) {
        const any = [...showersOf(n.id).map((r) => r.when), ...selectors];
        if (any.length) own = or(any); else { own = null; never = 'No rule shows this section, so no customer can see it.'; }
      } else if (!n.fallbackVariantId) {
        const any = [...conds, ...selectors];
        if (any.length) own = or(any); else { own = null; never = 'This section has no condition, no rule and no fallback message, so it is never shown.'; }
      }
    }
    const whole = own ? and([own, ...(n.visibleWhen ? [n.visibleWhen] : []), ...ancestorsVisible(n.id)]) : null;
    // Inside a repeating section (wave 5) the component is shown when it is shown for at least one item.
    const inList = project.nodes.some((x) => x.repeat) ? repeatListAt(project, n.id) : null;
    const pred: Predicate | null = whole && inList ? { op: 'items', path: inList, match: 'any', where: whole } : whole;
    sectionTargets.push({
      kind: 'section', targetId: n.id, id: `section:${n.id}`, title: nodeTitle(n.id), testName: `Shows ${q(nodeTitle(n.id))}`,
      alts: pred ? [pred] : [], reached: (res) => (inList ? shownForAnItem(res, n.id) : !!treeOf(res).get(n.id)?.visible), weak: [], touched: () => false, core: pred,
      ...(never ? { never } : {}),
    });
  }
  // Sections that exist only as wording and are added to the document by a rule.
  for (const id of [...new Set(rules.filter((r) => r.then.op === 'showSection').map((r) => (r.then as { targetNodeId: string }).targetNodeId))]) {
    if (nodes.has(id) || !parts.has(id) || shown.has(id)) continue;
    const pred = or(showersOf(id).map((r) => r.when));
    sectionTargets.push({
      kind: 'section', targetId: id, id: `section:${id}`, title: partTitle(id), testName: `Shows ${q(partTitle(id))}`,
      alts: showersOf(id).length ? [pred] : [], reached: (res) => !!treeOf(res).get(id)?.visible, weak: [], touched: () => false, core: pred,
      ...(showersOf(id).length ? {} : { never: 'No rule shows this section, so no customer can see it.' }),
    });
  }
  targets.push(...sectionTargets.sort((a, b) => (a.targetId < b.targetId ? -1 : 1)));

  return { targets, rules, rivals, selectorsOf, conditionsOf, nodeTitle, partTitle, ruleTitle };
}

/**
 * Rules, message versions and sections that no synthetic customer exercises, each with a confirmed what-if and a ready-to-pin test.
 *
 * A target counts as covered when some customer reaches it as issued (baseline). `opts.journeySteps: true` also counts a
 * customer reaching it at any journey step as covered. Either way the scenario search uses journey steps.
 */
export function coverageGaps(project: Project, records: SyntheticRecord[], opts?: { maxCandidates?: number; journeySteps?: boolean; /** "As issued on": the document's date (documents that use dates). */ issueDate?: string | null }): CoverageGap[] {
  const issueDate = project.documentDate && opts?.issueDate ? opts.issueDate : null;
  const env = new Env(project, records, Math.max(1, Math.floor(opts?.maxCandidates ?? 12)), issueDate);

  /* --- what the synthetic customers reach today */
  const matched = new Set<string>();
  const selected = new Set<string>();
  const shown = new Set<string>();
  const cursors: Array<number | null> = opts?.journeySteps ? [null, ...env.events.map((_, i) => i)] : [null];
  env.recs.forEach((record, i) => {
    for (const cursor of cursors) {
      const res = resolve({ project, record, journeyCursor: cursor, ...(issueDate ? { issueDate } : {}) });
      if (cursor === null) env.baseBlocking[i] = new Set(res.findings.filter((f) => f.severity === 'blocking').map(blockingKey));
      res.result.matchedRuleIds.forEach((id) => matched.add(id));
      for (const n of treeOf(res).values()) {
        if (!n.visible) continue;
        shown.add(n.id);
        for (const v of n.variants?.selected ?? []) selected.add(`${n.id}/${v}`);
      }
    }
  });

  const { targets, selectorsOf, ruleTitle } = targetsOf(project, { matched, selected, shown });

  /* --- a scenario and a test for each gap */
  const pinned: TestCase[] = [];
  const scenarioOf = (hit: Hit): NonNullable<CoverageGap['scenario']> => ({ recordId: hit.record.recordId, overrides: hit.overrides, journeyCursor: hit.cursor, explanation: explain(env, hit) });
  const limitNote = (tried: number): string => `No what-if reached it within the search limit (${tried} ${tried === 1 ? 'scenario' : 'scenarios'} tried on up to ${env.maxCandidates} customers, with and without journey steps).`;
  /** Who beat the rule in a confirmed scenario where it matched but was not chosen. */
  const beatenBy = (res: Resolution, ruleIds: string[]): string => {
    const mine = res.trace.filter((t) => ruleIds.includes(t.ruleId) && t.matched);
    const group = new Set(mine.map((t) => t.targetNodeId));
    const tie = mine.some((t) => t.outcome === 'tie');
    const winners = res.trace.filter((t) => t.kind === 'rule' && group.has(t.targetNodeId) && !ruleIds.includes(t.ruleId) && (tie ? t.outcome === 'tie' : t.outcome === 'selected'))
      .map((t) => q(ruleTitle(project.rules.find((r) => r.id === t.ruleId) ?? ({ id: t.ruleId } as Rule))));
    return winners.length ? `${listOf(winners)} ${tie ? 'has the same priority, so neither is chosen' : 'has a higher priority and wins'}` : 'another rule decides the outcome';
  };

  return targets.map((t): CoverageGap => {
    const base = { id: t.id, kind: t.kind, targetId: t.targetId, title: t.title };
    if (t.never) return { ...base, scenario: null, reason: t.never };
    const strong = env.search(t.alts, t.reached);
    if (strong.hit) {
      const hit = strong.hit;
      const testCase: TestCase = { id: nextTestId([...(project.testCases ?? []), ...pinned]), name: t.testName, recordId: hit.record.recordId, overrides: hit.overrides, journeyCursor: hit.cursor, ...(issueDate ? { issueDate } : {}), expect: captureExpectation(project, hit.record, hit.overrides, hit.cursor, issueDate) };
      const gap: CoverageGap = { ...base, scenario: scenarioOf(hit) };
      if (applyCommand(project, { type: 'UPSERT_TEST_CASE', testCase }).ok) { pinned.push(testCase); gap.testCase = testCase; }
      return gap;
    }
    const weak = t.weak.length ? env.search(t.weak, t.touched) : null;
    if (weak?.hit) {
      const ids = t.kind === 'rule' ? [t.targetId] : selectorsOf(t.id.slice('variant:'.length, t.id.lastIndexOf('/')), t.targetId).map((r) => r.id);
      const loses = beatenBy(weak.hit.res, ids);
      const always = strong.satisfiable ? 'In every what-if that was tried' : 'Whenever it matches';
      if (t.kind === 'rule') return { ...base, scenario: scenarioOf(weak.hit), reason: `The rule can match, but its message is never chosen. ${always}, ${loses}. No test is offered, because it would pin the wrong outcome.` };
      return { ...base, scenario: null, reason: `The rule that selects this message can match, but the message is never chosen. ${always}, ${loses}.` };
    }
    if (!strong.satisfiable && !(weak?.satisfiable)) {
      const why = t.core ? contradiction(env, t.core) : null;
      if (t.core && env.combos([t.core]).length) return { ...base, scenario: null, reason: 'Whenever its own condition holds, another rule or an earlier condition takes precedence, so it can never be chosen.' };
      return { ...base, scenario: null, reason: why ? `${why} No customer can ever match.` : 'The conditions can never all be true for this document, so no customer can match.' };
    }
    return { ...base, scenario: null, reason: notInEffect(t) ?? limitNote(strong.tried + (weak?.tried ?? 0)) };
  });

  /** For a document checked "as issued on" a day: a rule, message or section that is not in effect that day. */
  function notInEffect(t: { kind: string; id: string; targetId: string }): string | null {
    if (!project.documentDate || !issueDate) return null;
    if (t.kind === 'rule') { const r = project.rules.find((x) => x.id === t.targetId); return r?.effective && !inEffect(r.effective, issueDate) ? notInEffectWords(r.effective, issueDate) : null; }
    if (t.kind === 'variant') {
      const nodeId = t.id.slice('variant:'.length, t.id.lastIndexOf('/'));
      const node = project.nodes.find((n) => n.id === nodeId);
      const p = node?.variantPeriods?.[t.targetId];
      if (p && !inEffect(p, issueDate)) return notInEffectWords(p, issueDate);
      const selectors = selectorsOf(nodeId, t.targetId);
      if (selectors.length && selectors.every((r) => r.effective && !inEffect(r.effective, issueDate))) return `Every rule that chooses it is out of effect on that day. ${notInEffectWords(selectors[0].effective!, issueDate)}`;
      return null;
    }
    const node = project.nodes.find((n) => n.id === t.targetId);
    return node?.effective && !inEffect(node.effective, issueDate) ? notInEffectWords(node.effective, issueDate) : null;
  }
}

/* ------------------------------------------------------------------ shared with the test-data engine */

/**
 * The search machinery above, for `testData.ts`: conditions as combinations, the fewest field changes that satisfy one,
 * and every target of a project with its requirements. One name, so the assistant's public surface stays small.
 */
export const coverageKit = { Env, targetsOf, dnf, holds, shiftDay, show, describeLit, contradiction, treeOf, stepLabel, blockingKey, humanise, listOf, q, and, or, not, TRUE };
export type CoverageEnv = Env;
export type { Conj as CoverageConj, Hit as CoverageHit, Lit as CoverageLit, Target as CoverageTarget };
