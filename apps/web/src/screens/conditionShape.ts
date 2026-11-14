import type { ComparisonOp, Predicate, Scalar } from '@iss/model';

/**
 * The one-level shape both condition builders edit (the rule editor's, in RulesData, and the calculation builder's,
 * in calc/ConditionEditor): all or any of several tests, each optionally negated. Anything deeper is shown elsewhere
 * (the rule editor's Advanced tab, the calculation's formula view). Pure; the two builders keep their own controls,
 * words and test IDs.
 */

export type LeafOp = ComparisonOp | 'in' | 'isNull' | 'notNull';
export interface Cond { path: string; op: LeafOp; value: Scalar | Scalar[]; neg: boolean }
export interface Visual { combiner: 'and' | 'or'; conds: Cond[] }

function leafOf(p: Predicate): Cond | null {
  switch (p.op) {
    case 'and': case 'or': case 'not': return null;
    case 'isNull': case 'notNull': return { path: p.path, op: p.op, value: null, neg: false };
    case 'in': return { path: p.path, op: 'in', value: p.value, neg: false };
    case 'items': return null;
    default: return { path: p.path, op: p.op, value: p.value, neg: false };
  }
}
function condOf(p: Predicate): Cond | null {
  if (p.op === 'not') { const c = leafOf(p.arg); return c ? { ...c, neg: true } : null; }
  return leafOf(p);
}
/** One level of AND/OR over leaf conditions (optionally negated), or null when the condition is deeper. */
export function toVisual(p: Predicate): Visual | null {
  if (p.op === 'and' || p.op === 'or') {
    const conds = p.args.map(condOf);
    return conds.length && conds.every(Boolean) ? { combiner: p.op, conds: conds as Cond[] } : null;
  }
  const c = condOf(p);
  return c ? { combiner: 'and', conds: [c] } : null;
}
function leafPredicate(c: Cond): Predicate {
  let leaf: Predicate;
  if (c.op === 'isNull' || c.op === 'notNull') leaf = { op: c.op, path: c.path };
  else if (c.op === 'in') leaf = { op: 'in', path: c.path, value: Array.isArray(c.value) ? c.value : [] };
  else leaf = { op: c.op, path: c.path, value: Array.isArray(c.value) ? null : c.value };
  return c.neg ? { op: 'not', arg: leaf } : leaf;
}
export function fromVisual(v: Visual): Predicate {
  const leaves = v.conds.map(leafPredicate);
  return leaves.length === 1 ? leaves[0] : { op: v.combiner, args: leaves };
}
