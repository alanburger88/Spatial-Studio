import { buildContext, projectFieldIndex, setPath, type Predicate, type Project, type Rule, type Scalar, type SyntheticRecord } from '@iss/model';
import { evaluatePredicate, predicatePaths, resolve } from '@iss/resolver';

/**
 * Decision-table analysis for one exclusive group (or the independent add-on rules). Pure and deterministic.
 * Two evidence bases are kept apart everywhere: what is *seen in the synthetic records* and what is a *possible
 * combination* from a small generated domain (every enum / yes-no value, numeric boundaries of the conditions ±1).
 */

export const ADDON_GROUP = '__addons__';
export const MAX_DOMAIN = 20000;

export type Combo = Record<string, Scalar>;

export interface DecisionGroup { id: string; kind: 'exclusive' | 'addons'; ruleIds: string[] }

export interface Overlap {
  /** The two rules that can both match at the same priority (a blocking tie when it happens). */
  ruleIds: [string, string];
  priority: number;
  /** Synthetic records on which both rules match right now. */
  recordIds: string[];
  /** A possible combination where both match (always present when the overlap exists in the generated domain). */
  example?: Combo;
}

export interface Shadowed {
  ruleId: string;
  /** Higher-priority rules that always match whenever this rule does. */
  beatenBy: string[];
  matchesInRecords: number;
  matchesInDomain: number;
}

export interface GapSummary {
  /** Possible combinations (from the generated domain) with no matching rule. */
  possible: number;
  examples: Combo[];
  /** Synthetic records where no exclusive rule matches right now. */
  recordIds: string[];
  blocking: boolean;
}

export interface DecisionTableAnalysis {
  groupId: string;
  kind: 'exclusive' | 'addons';
  /** Rules in display order: exclusive = highest priority first; add-ons = model order. */
  ruleIds: string[];
  /** Every field path used by any condition in the group, in first-use order. */
  fields: string[];
  evaluated: number;
  /** Synthetic records each rule wins (exclusive: selected; add-ons: applied). From the resolver. */
  wins: Record<string, number>;
  fallbackVariantId?: string;
  fallbackWins: number;
  /** Records where the group resolves to nothing (tie or no match without fallback). */
  unresolved: number;
  domainSize: number;
  domainCapped: boolean;
  overlaps: Overlap[];
  shadowed: Shadowed[];
  gaps: GapSummary;
  /** Number of blocking issues found (overlaps + blocking gaps). */
  blocking: number;
}

export const ruleGroup = (r: Rule): string | null => {
  if (r.mode === 'exclusive') return r.exclusiveGroup ?? ('targetNodeId' in r.then ? r.then.targetNodeId : null);
  if (r.mode === 'additive') return ADDON_GROUP;
  return null;
};

/** Groups of the project that have a decision table: each exclusive group, then the add-on rules. */
export function decisionGroups(project: Project): DecisionGroup[] {
  const out = new Map<string, DecisionGroup>();
  for (const r of project.rules) {
    if (r.scope !== project.documentType) continue;
    const g = ruleGroup(r);
    if (!g) continue;
    const e = out.get(g) ?? { id: g, kind: g === ADDON_GROUP ? 'addons' as const : 'exclusive' as const, ruleIds: [] };
    e.ruleIds.push(r.id);
    out.set(g, e);
  }
  return [...out.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exclusive' ? -1 : 1));
}

/** Rules of a group in display order (exclusive: highest priority first, ties by id). */
export function groupRules(project: Project, groupId: string): Rule[] {
  const rules = project.rules.filter((r) => r.scope === project.documentType && ruleGroup(r) === groupId);
  return groupId === ADDON_GROUP ? rules : [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

/** Top-level conjuncts of a condition (flattened `and`). */
export function conjuncts(p: Predicate): Predicate[] {
  return p.op === 'and' ? p.args.flatMap(conjuncts) : [p];
}

/** The parts of a rule's condition that concern one field: leaf comparisons, or a complex sub-expression. */
export function termsOnField(rule: Rule, path: string): Predicate[] {
  return conjuncts(rule.when).filter((t) => predicatePaths(t).includes(path));
}

/** Every field used by any condition of the rules, in first-use order. */
export function fieldsOf(rules: Rule[]): string[] {
  const seen: string[] = [];
  for (const r of rules) for (const p of predicatePaths(r.when)) if (!seen.includes(p)) seen.push(p);
  return seen;
}

/* ------------------------------------------------------------ domain */

function literalsOf(p: Predicate, path: string, out: Scalar[]) {
  if (p.op === 'and' || p.op === 'or') { p.args.forEach((a) => literalsOf(a, path, out)); return; }
  if (p.op === 'not') { literalsOf(p.arg, path, out); return; }
  if ((p as { path: string }).path !== path) return;
  if (p.op === 'in') out.push(...p.value);
  else if (p.op !== 'isNull' && p.op !== 'notNull') out.push((p as { value: Scalar }).value);
}

function domainFor(project: Project, rules: Rule[], path: string): Scalar[] {
  const def = projectFieldIndex(project).get(path);
  const lits: Scalar[] = [];
  for (const r of rules) literalsOf(r.when, path, lits);
  const uniq = (xs: Scalar[]) => [...new Set(xs)];
  if (def?.type === 'bool') return [true, false];
  if (def?.type === 'enum') return uniq([...(def.enumValues ?? []), ...lits.filter((l): l is string => typeof l === 'string')]);
  const nums = lits.filter((l): l is number => typeof l === 'number');
  if (nums.length || def?.type === 'int' || def?.type === 'cents') {
    const vals = new Set<number>();
    for (const n of nums) for (const d of [-1, 0, 1]) if (n + d >= 0 || n < 0) vals.add(n + d);
    if (!vals.size) vals.add(0);
    return [...vals].sort((a, b) => a - b);
  }
  if (lits.some((l) => typeof l === 'boolean')) return [true, false];
  return uniq([...lits, '(any other value)']);
}

function ctxOf(combo: Combo): unknown {
  const ctx: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(combo)) {
    if (path.endsWith('.count') && typeof v === 'number') setPath(ctx, path.slice(0, -6), Array.from({ length: v }, () => null) as never);
    else setPath(ctx, path, v);
  }
  return ctx;
}

function generateDomain(project: Project, rules: Rule[], fields: string[]): { combos: Combo[]; size: number; capped: boolean } {
  const doms = fields.map((f) => domainFor(project, rules, f));
  const size = doms.reduce((n, d) => n * Math.max(d.length, 1), 1);
  const combos: Combo[] = [];
  const idx = fields.map(() => 0);
  const total = Math.min(size, MAX_DOMAIN);
  for (let i = 0; i < total; i++) {
    const c: Combo = {};
    fields.forEach((f, k) => { c[f] = doms[k][idx[k]]; });
    combos.push(c);
    for (let k = fields.length - 1; k >= 0; k--) { if (++idx[k] < doms[k].length) break; idx[k] = 0; }
  }
  return { combos, size, capped: size > MAX_DOMAIN };
}

/* --------------------------------------------------------- analysis */

const matches = (r: Rule, ctx: unknown) => r.enabled !== false && evaluatePredicate(r.when, ctx);

export function analyseDecisionTable(project: Project, groupId: string, allRecords: SyntheticRecord[]): DecisionTableAnalysis {
  const rules = groupRules(project, groupId);
  const kind = groupId === ADDON_GROUP ? 'addons' : 'exclusive';
  const records = allRecords.filter((r) => r.documentType === project.documentType);
  const fields = fieldsOf(rules);
  const node = kind === 'exclusive' ? project.nodes.find((n) => n.id === groupId) : undefined;
  const base: DecisionTableAnalysis = {
    groupId, kind, ruleIds: rules.map((r) => r.id), fields, evaluated: records.length, wins: Object.fromEntries(rules.map((r) => [r.id, 0])),
    fallbackVariantId: node?.fallbackVariantId, fallbackWins: 0, unresolved: 0, domainSize: 0, domainCapped: false,
    overlaps: [], shadowed: [], gaps: { possible: 0, examples: [], recordIds: [], blocking: false }, blocking: 0,
  };

  // Wins: the real resolver, every synthetic record, default scenario.
  const recCtx = records.map((rec) => buildContext(rec));
  for (const rec of records) {
    const res = resolve({ project, record: rec, overrides: {}, journeyCursor: null });
    if (kind === 'addons') {
      for (const t of res.trace) if (t.kind === 'rule' && t.outcome === 'applied' && base.wins[t.ruleId] !== undefined) base.wins[t.ruleId]++;
      continue;
    }
    const won = res.trace.find((t) => t.kind === 'rule' && t.outcome === 'selected' && t.targetNodeId === groupId);
    if (won) base.wins[won.ruleId] = (base.wins[won.ruleId] ?? 0) + 1;
    else if (res.result.selectedVariants[groupId]) base.fallbackWins++;
    else base.unresolved++;
  }
  if (kind === 'addons') return base;

  const enabled = rules.filter((r) => r.enabled !== false);
  const { combos, size, capped } = generateDomain(project, rules, fields);
  base.domainSize = size;
  base.domainCapped = capped;
  const domCtx = combos.map(ctxOf);

  const hitsRec = recCtx.map((c) => enabled.filter((r) => matches(r, c)));
  const hitsDom = domCtx.map((c) => enabled.filter((r) => matches(r, c)));

  // (a) overlaps: equal-priority pairs that can both match.
  for (let i = 0; i < enabled.length; i++) for (let j = i + 1; j < enabled.length; j++) {
    const a = enabled[i], b = enabled[j];
    if (a.priority !== b.priority) continue;
    const recordIds = records.filter((_, k) => hitsRec[k].includes(a) && hitsRec[k].includes(b)).map((r) => r.recordId);
    const at = hitsDom.findIndex((h) => h.includes(a) && h.includes(b));
    if (recordIds.length || at >= 0) base.overlaps.push({ ruleIds: [a.id, b.id], priority: a.priority, recordIds, example: at >= 0 ? combos[at] : undefined });
  }

  // (b) shadowed: matches somewhere but a strictly higher-priority rule always matches too.
  for (const r of enabled) {
    const beaten = (h: Rule[]) => h.some((o) => o !== r && o.priority > r.priority);
    const recM = hitsRec.filter((h) => h.includes(r)), domM = hitsDom.filter((h) => h.includes(r));
    if (!recM.length && !domM.length) continue;
    if (recM.every(beaten) && domM.every(beaten)) {
      const by = new Set<string>();
      for (const h of [...recM, ...domM]) for (const o of h) if (o !== r && o.priority > r.priority) by.add(o.id);
      base.shadowed.push({ ruleId: r.id, beatenBy: [...by], matchesInRecords: recM.length, matchesInDomain: domM.length });
    }
  }

  // (c) gaps: nothing matches; fallback applies (informational) or there is none (blocking).
  const blocking = !node?.fallbackVariantId;
  const gapDom = combos.filter((_, k) => !hitsDom[k].length);
  base.gaps = { possible: gapDom.length, examples: gapDom.slice(0, 6), recordIds: records.filter((_, k) => !hitsRec[k].length).map((r) => r.recordId), blocking };
  base.blocking = base.overlaps.length + (blocking && (gapDom.length || base.gaps.recordIds.length) ? 1 : 0);
  return base;
}
