import { CALC_PREFIX, DOCUMENT_DATE_PATH } from './fields';
import { exprChildren, exprDependencies, predicateLeafPaths } from './expressions';
import { dayWords, isIsoDay } from './isoDate';
import type { DocNode, EffectivePeriod, Expr, Project, Rule } from './types';

/**
 * Effective dates: rules, alternatives (variants) and conditional sections in effect only in a period, decided by the
 * document's own date. "From" is the first day it applies; "until" is the first day it no longer applies. Pure.
 */

/** Why a period is not valid, or null. */
export function periodProblem(p: unknown): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'A period needs a “from” date, an “until” date or both.';
  const r = p as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== 'from' && k !== 'until');
  if (extra.length) return `A period has only “from” and “until” (not ${extra.join(', ')}).`;
  if (r.from === undefined && r.until === undefined) return 'A period needs a “from” date, an “until” date or both.';
  for (const k of ['from', 'until'] as const) if (r[k] !== undefined && !isIsoDay(r[k])) return `The “${k}” date ${JSON.stringify(r[k])} is not a date. Write dates as YYYY-MM-DD.`;
  if (typeof r.from === 'string' && typeof r.until === 'string' && !(r.from < r.until)) return `The period must end after it starts: “until” (${dayWords(r.until)}) is the first day it no longer applies, so it must be later than “from” (${dayWords(r.from)}).`;
  return null;
}

/** Whether something with this period is in effect on `day`. No period: always. A period but no day: not in effect. */
export function inEffect(p: EffectivePeriod | undefined, day: string | null): boolean {
  if (!p) return true;
  if (!day) return false;
  if (p.from && day < p.from) return false;
  if (p.until && day >= p.until) return false;
  return true;
}

/** Why something is not in effect, in plain words: "Not in effect on 12 Dec 2026: starts 1 Jan 2027." */
export function notInEffectWords(p: EffectivePeriod, day: string | null): string {
  if (!day) return 'Not in effect: this customer’s document has no date, and this applies only in a period.';
  if (p.from && day < p.from) return `Not in effect on ${dayWords(day)}: starts ${dayWords(p.from)}.`;
  if (p.until && day >= p.until) return `Not in effect on ${dayWords(day)}: ended ${dayWords(p.until)} (its last day was the day before).`;
  return `In effect on ${dayWords(day)}.`;
}

/** Which nodes may carry an effective period of their own: conditional sections. */
export function isConditionalSection(n: DocNode): boolean {
  return n.type === 'conditional-region' || !!n.visibleWhen || !!n.ruleDriven;
}

const usesDatePath = (paths: string[]) => paths.includes(DOCUMENT_DATE_PATH);

/** How a project uses the document's date. Cached per project object (projects are immutable values). */
export interface DocumentDateUse {
  /** Rules, alternatives and sections with a period. */
  periods: number;
  /** Calculated fields that read the document's date (directly or through another calculation). */
  calcs: string[];
  /** `document.date` read in a condition or in wording. */
  referenced: boolean;
  /** Anything at all depends on the date. */
  uses: boolean;
}
const USE = new WeakMap<object, DocumentDateUse>();

export function documentDateUse(project: Project): DocumentDateUse {
  const hit = USE.get(project);
  if (hit) return hit;
  let periods = 0;
  for (const r of project.rules) if (r.effective) periods++;
  for (const n of project.nodes) { if (n.effective) periods++; periods += Object.keys(n.variantPeriods ?? {}).length; }
  const calcs = project.calculatedFields ?? [];
  const direct = new Set(calcs.filter((c) => exprDependencies(c.expr).usesIssueDate).map((c) => c.key));
  // Through other calculations.
  for (let changed = true; changed;) {
    changed = false;
    for (const c of calcs) if (!direct.has(c.key) && exprDependencies(c.expr).calcs.some((k) => direct.has(k))) { direct.add(c.key); changed = true; }
  }
  const referenced = project.rules.some((r) => usesDatePath(predicateLeafPaths(r.when)))
    || project.nodes.some((n) => usesDatePath(predicateLeafPaths(n.visibleWhen)) || Object.values(n.variantConditions ?? {}).some((p) => usesDatePath(predicateLeafPaths(p))) || n.binding === DOCUMENT_DATE_PATH)
    || JSON.stringify([project.nodes, project.contentParts, project.channels ?? null, project.strings ?? null]).includes(DOCUMENT_DATE_PATH);
  const out: DocumentDateUse = { periods, calcs: calcs.filter((c) => direct.has(c.key)).map((c) => c.key), referenced, uses: !!project.documentDate && (periods > 0 || direct.size > 0 || referenced) };
  USE.set(project, out);
  return out;
}

/** One thing that starts or stops applying on a day. */
export interface DateBoundaryItem {
  kind: 'rule' | 'variant' | 'section' | 'lookup-row';
  /** Rule id, variant id, node id, or `<tableId>#<row>` (1-based). */
  id: string;
  /** The part a variant belongs to, or the table of a lookup row. */
  nodeId?: string;
  change: 'starts' | 'ends';
}
export interface DateBoundary { date: string; items: DateBoundaryItem[] }

/** Lookup tables keyed by the document's date (a date-range key looked up with ISSUE_DATE() or document.date). */
function tablesKeyedByDate(project: Project): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (e: Expr) => {
    if (e.op === 'lookup') {
      const t = (project.lookupTables ?? []).find((x) => x.id === e.table);
      e.keys.forEach((k, i) => { if (t?.keys[i]?.match === 'date-range' && (k.op === 'issueDate' || (k.op === 'field' && k.path === DOCUMENT_DATE_PATH))) { const s = out.get(e.table) ?? new Set<string>(); s.add(t.keys[i].key); out.set(e.table, s); } });
    }
    exprChildren(e).forEach(([, c]) => walk(c));
  };
  for (const c of project.calculatedFields ?? []) walk(c.expr);
  return out;
}

/**
 * Every day on which something about the document changes, in date order: rules, alternatives and sections starting
 * or ending, and rows of lookup tables keyed by the document's date. A release states these.
 */
export function dateBoundaries(project: Project): DateBoundary[] {
  const by = new Map<string, DateBoundaryItem[]>();
  const add = (p: EffectivePeriod | undefined, item: Omit<DateBoundaryItem, 'change'>) => {
    if (!p) return;
    if (p.from) by.set(p.from, [...(by.get(p.from) ?? []), { ...item, change: 'starts' }]);
    if (p.until) by.set(p.until, [...(by.get(p.until) ?? []), { ...item, change: 'ends' }]);
  };
  for (const r of project.rules) add(r.effective, { kind: 'rule', id: r.id });
  for (const n of project.nodes) {
    add(n.effective, { kind: 'section', id: n.id });
    for (const [v, p] of Object.entries(n.variantPeriods ?? {})) add(p, { kind: 'variant', id: v, nodeId: n.id });
  }
  for (const [tableId, keys] of tablesKeyedByDate(project)) {
    const t = project.lookupTables!.find((x) => x.id === tableId)!;
    t.rows.forEach((row, i) => { for (const k of keys) { const cell = row.keys[k]; if (cell && typeof cell === 'object') add({ from: typeof cell.from === 'string' ? cell.from : undefined, until: typeof cell.until === 'string' ? cell.until : undefined }, { kind: 'lookup-row', id: `${tableId}#${i + 1}`, nodeId: tableId }); } });
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, items]) => ({ date, items }));
}

/** Every rule that has a period. */
export const datedRules = (project: Project): Rule[] => project.rules.filter((r) => !!r.effective);
export const isCalcPath = (path: string) => path.startsWith(CALC_PREFIX);
