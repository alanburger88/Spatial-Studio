import { getPath } from './data';
import { itemPrefix } from './fields';
import type { ItemsCondition, ItemsMatch, Predicate } from './types';

/**
 * Richer data shapes (wave 5, section 2): reading the items of a list.
 *
 * A path inside one item of a list is written with `[]` after the list: `custom.accounts[].number`,
 * `custom.accounts[].holder.name`, `custom.accounts[].transactions`. The engine reads such a path in an **item scope**:
 * a shallow copy of the customer's context in which `custom.accounts[]` is that one item (`scopeCtx`). So every reader
 * that already follows dotted paths (`getPath`, rule conditions, wording tokens) works inside an item unchanged, and a
 * path with `[]` read outside any item is simply empty.
 *
 * Read outside an item scope, a list inside a list (`custom.accounts[].transactions`) is the rows of that list in all
 * items, one after another (`readList`): that is how a calculation of the whole document sums or counts across them.
 *
 * Pure: no clock, network or `Intl`.
 */

type Ctx = Record<string, unknown>;
/** Calculated values that belong to a list, per customer context: list → one record of values per item. */
const ITEM_CALCS = new WeakMap<object, Map<string, Array<Record<string, unknown>>>>();
/** Why such values are missing, per customer context: list → one record of reasons per item. */
const ITEM_MISSING = new WeakMap<object, Map<string, Array<Record<string, unknown>>>>();
/** In an item scope: why a calculation of that item is missing, by key. */
const SCOPE_MISSING = new WeakMap<object, Record<string, unknown>>();

/** Records the values (and the reasons for missing ones) of the calculations that belong to lists, for a customer's context. */
export function setItemCalculations(ctx: object, values: Map<string, Array<Record<string, unknown>>>, missing: Map<string, Array<Record<string, unknown>>>): void {
  ITEM_CALCS.set(ctx, values);
  ITEM_MISSING.set(ctx, missing);
}

/** The values of the calculations that belong to `list`, per item (as worked out by `evaluateCalculations`), or null. */
export function itemCalculations(ctx: object, list: string): Array<Record<string, unknown>> | null {
  return ITEM_CALCS.get(ctx)?.get(list) ?? null;
}

/** In an item scope: why a calculation of the current item is missing (null when it is not). */
export function itemCalculationMissing<T>(ctx: object, key: string): T | null {
  return (SCOPE_MISSING.get(ctx)?.[key] as T | undefined) ?? null;
}

/**
 * A copy of `ctx` in which the item path `<list>[]` is `item` (number `index` of the list, from 0). The calculations
 * that belong to the list are read as `calc.<key>` there. Nothing of `ctx` is changed.
 */
export function scopeCtx(ctx: Ctx, list: string, item: unknown, index: number): Ctx {
  const parts = list.split('.');
  const key = parts.pop()!;
  const out: Ctx = { ...ctx };
  let src: unknown = ctx;
  let dst: Ctx = out;
  for (const p of parts) {
    const v = src && typeof src === 'object' ? (src as Ctx)[p] : undefined;
    const copy: Ctx = v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Ctx) } : {};
    dst[p] = copy;
    dst = copy;
    src = v;
  }
  dst[`${key}[]`] = item;
  const calcs = ITEM_CALCS.get(ctx);
  const missing = ITEM_MISSING.get(ctx);
  if (calcs) ITEM_CALCS.set(out, calcs);
  if (missing) ITEM_MISSING.set(out, missing);
  const values = calcs?.get(list)?.[index];
  if (values) {
    out.calc = { ...((ctx.calc as Ctx | undefined) ?? {}), ...values };
    SCOPE_MISSING.set(out, missing?.get(list)?.[index] ?? {});
  } else if (SCOPE_MISSING.has(ctx)) SCOPE_MISSING.set(out, SCOPE_MISSING.get(ctx)!);
  return out;
}

/** Whether `ctx` is the scope of one item of `list` (its `<list>[]` is set). */
export const inItemScope = (ctx: unknown, list: string): boolean => getPath(ctx, itemPrefix(list)) !== null;

/**
 * The scopes of the items of `list` as seen from `ctx`: in the scope of an outer item, that item's own rows; otherwise
 * every item (the rows of a list inside a list in all outer items, in order). Rows that are not objects are skipped.
 */
export function itemContexts(ctx: Ctx, list: string): Ctx[] {
  const v = getPath(ctx, list);
  if (Array.isArray(v)) return v.flatMap((item, i) => (item && typeof item === 'object' ? [scopeCtx(ctx, list, item, i)] : []));
  const at = list.lastIndexOf('[]');
  if (at < 0) return [];
  const outer = list.slice(0, at);
  if (inItemScope(ctx, outer)) return [];
  return itemContexts(ctx, outer).flatMap((oc) => itemContexts(oc, list));
}

/** The rows of a list as seen from `ctx` (see `itemContexts`): null when the customer has no such list at all. */
export function readList(ctx: Ctx, list: string): unknown[] | null {
  const v = getPath(ctx, list);
  if (Array.isArray(v)) return v;
  const at = list.lastIndexOf('[]');
  if (at < 0) return null;
  const outer = list.slice(0, at);
  if (inItemScope(ctx, outer)) return null;
  const rest = list.slice(at + 3);
  return itemContexts(ctx, outer).flatMap((oc) => {
    const rows = getPath(oc, `${itemPrefix(outer)}.${rest}`);
    return Array.isArray(rows) ? rows : [];
  });
}

/**
 * Decides an items condition from what each item gives (`true`, `false` or a reason it could not be decided, such as a
 * missing calculated value). Every and none hold for an empty list.
 */
export function decideItems<M>(match: ItemsMatch, count: number | undefined, results: Array<boolean | M>): boolean | M {
  let yes = 0, no = 0;
  let unknown: M | null = null;
  for (const r of results) { if (r === true) yes++; else if (r === false) no++; else unknown ??= r; }
  switch (match) {
    case 'any': return yes > 0 ? true : unknown ?? false;
    case 'every': return no > 0 ? false : unknown ?? true;
    case 'none': return yes > 0 ? false : unknown ?? true;
    case 'atLeast': {
      const n = Math.max(1, Math.floor(count ?? 1));
      if (yes >= n) return true;
      return results.length - no < n ? false : unknown ?? false;
    }
  }
}

/** Every condition inside an items condition, and their lists (for "where is this field used"). */
export function itemsConditionPaths(p: ItemsCondition, leaf: (q: Predicate) => string[]): string[] {
  return [p.path, ...leaf(p.where)];
}

/** Plain words for how many items must match: "any", "every", "no", "at least 2". */
export const ITEMS_MATCH_WORDS: Record<ItemsMatch, string> = { any: 'any', every: 'every', none: 'no', atLeast: 'at least' };
export const ITEMS_MATCH_LIST: readonly ItemsMatch[] = ['any', 'every', 'none', 'atLeast'];
/** The formula word of each kind of items condition. */
export const ITEMS_FORMULA_WORD: Record<ItemsMatch, string> = { any: 'ANY', every: 'EVERY', none: 'NONE', atLeast: 'AT_LEAST' };
