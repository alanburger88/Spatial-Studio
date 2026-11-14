import type { ComparisonOp, ItemsMatch, Predicate, Scalar } from '@iss/model';

/**
 * The one-level shape both condition builders edit (the rule editor's, in RulesData, and the calculation builder's,
 * in calc/ConditionEditor): all or any of several tests, each optionally negated. Anything deeper is shown elsewhere
 * (the rule editor's Advanced tab, the calculation's formula view). Pure; the two builders keep their own controls,
 * words and test IDs.
 */

export type LeafOp = ComparisonOp | 'in' | 'isNull' | 'notNull';
/** A test about the items of a list (wave 5): `path` is the list; `where` is the test on one item. */
export interface ItemsCond { match: ItemsMatch; count?: number; where: Predicate }
export interface Cond { path: string; op: LeafOp; value: Scalar | Scalar[]; neg: boolean; items?: ItemsCond }
export interface Visual { combiner: 'and' | 'or'; conds: Cond[] }

function leafOf(p: Predicate, items = false): Cond | null {
  switch (p.op) {
    case 'and': case 'or': case 'not': return null;
    case 'items': return items ? { path: p.path, op: 'eq', value: null, neg: false, items: { match: p.match, ...(p.count !== undefined ? { count: p.count } : {}), where: p.where } } : null;
    case 'isNull': case 'notNull': return { path: p.path, op: p.op, value: null, neg: false };
    case 'in': return { path: p.path, op: 'in', value: p.value, neg: false };
    default: return { path: p.path, op: p.op, value: p.value, neg: false };
  }
}
function condOf(p: Predicate, items = false): Cond | null {
  if (p.op === 'not') { const c = leafOf(p.arg, items); return c ? { ...c, neg: true } : null; }
  return leafOf(p, items);
}
/**
 * One level of AND/OR over leaf conditions (optionally negated), or null when the condition is deeper. With `items`
 * (the rule editor, wave 5), a condition about the items of a list is one of the leaves.
 */
export function toVisual(p: Predicate, opts: { items?: boolean } = {}): Visual | null {
  const items = !!opts.items;
  if (p.op === 'and' || p.op === 'or') {
    const conds = p.args.map((a) => condOf(a, items));
    return conds.length && conds.every(Boolean) ? { combiner: p.op, conds: conds as Cond[] } : null;
  }
  const c = condOf(p, items);
  return c ? { combiner: 'and', conds: [c] } : null;
}
function leafPredicate(c: Cond): Predicate {
  let leaf: Predicate;
  if (c.items) leaf = { op: 'items', path: c.path, match: c.items.match, ...(c.items.match === 'atLeast' ? { count: c.items.count ?? 1 } : {}), where: c.items.where };
  else if (c.op === 'isNull' || c.op === 'notNull') leaf = { op: c.op, path: c.path };
  else if (c.op === 'in') leaf = { op: 'in', path: c.path, value: Array.isArray(c.value) ? c.value : [] };
  else leaf = { op: c.op, path: c.path, value: Array.isArray(c.value) ? null : c.value };
  return c.neg ? { op: 'not', arg: leaf } : leaf;
}
export function fromVisual(v: Visual): Predicate {
  const leaves = v.conds.map(leafPredicate);
  return leaves.length === 1 ? leaves[0] : { op: v.combiner, args: leaves };
}
