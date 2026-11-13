import { applyJourney, deepClone, projectFieldIndex, type DocNode, type FieldDef, type Predicate, type Project, type Rule, type Scalar, type SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import { ruleWording } from './ruleDraft';
import type { FixProposal, RuleObservation } from './types';

/**
 * "Review my rules": overlaps, rules no customer reaches, missing fallbacks and unclear priorities, each with a
 * suggested change where one can be computed. Pure and deterministic: every synthetic record of the project's
 * document type is resolved once as it stands and once per journey step, and all counts come from those runs.
 *
 * "Customers" always means the synthetic records as they stand today. What happens at journey steps is reported
 * separately ("after the journey step …") and never raises a count or a severity on its own, except that a tie
 * seen only along the journey is still a warning.
 */

const q = (s: string): string => `“${s}”`;
const people = (n: number): string => `${n} synthetic customer${n === 1 ? '' : 's'}`;
const SEVERITY_RANK: Record<RuleObservation['severity'], number> = { blocking: 0, warning: 1, info: 2 };
const KIND_RANK: Record<RuleObservation['kind'], number> = { tie: 0, shadowed: 1, 'no-fallback': 2, unreachable: 3, overlap: 4, gap: 5, disabled: 6 };

/* ------------------------------------------------------------------ can two conditions hold together? */

type CmpOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
interface Atom {
  path: string;
  kind: 'cmp' | 'in' | 'notIn' | 'null' | 'notNull';
  op?: CmpOp;
  value?: Scalar;
  values?: Scalar[];
  /** Comes from a negation, which is also true when the field is empty. */
  orNull?: boolean;
}
const NEGATE: Record<CmpOp, CmpOp> = { eq: 'ne', ne: 'eq', gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt' };
const DNF_LIMIT = 256;

/** Disjunctive normal form (a list of "all of these" groups), or null when the condition is too large to analyse. */
function dnf(p: Predicate, negated: boolean): Atom[][] | null {
  switch (p.op) {
    case 'not': return dnf(p.arg, !negated);
    case 'and':
    case 'or': {
      const parts = p.args.map((a) => dnf(a, negated));
      if (parts.some((x) => x === null)) return null;
      const all = parts as Atom[][][];
      if ((p.op === 'or') !== negated) {
        const out = all.flat();
        return out.length > DNF_LIMIT ? null : out;
      }
      let acc: Atom[][] = [[]];
      for (const part of all) {
        const next: Atom[][] = [];
        for (const a of acc) for (const b of part) next.push([...a, ...b]);
        if (next.length > DNF_LIMIT) return null;
        acc = next;
      }
      return acc;
    }
    case 'isNull':
    case 'notNull': return [[{ path: p.path, kind: (p.op === 'isNull') !== negated ? 'null' : 'notNull' }]];
    case 'in': return [[negated ? { path: p.path, kind: 'notIn', values: p.value, orNull: true } : { path: p.path, kind: 'in', values: p.value }]];
    default: return [[negated ? { path: p.path, kind: 'cmp', op: NEGATE[p.op], value: p.value, orNull: true } : { path: p.path, kind: 'cmp', op: p.op, value: p.value }]];
  }
}

function holds(v: Scalar, a: Atom): boolean {
  if (a.kind === 'in') return (a.values ?? []).includes(v);
  if (a.kind === 'notIn') return !(a.values ?? []).includes(v);
  if (a.kind !== 'cmp') return true;
  const w = a.value as Scalar;
  switch (a.op) {
    case 'eq': return v === w;
    case 'ne': return v !== w;
    case 'gt': return w !== null && v !== null && v > w;
    case 'gte': return w !== null && v !== null && v >= w;
    case 'lt': return w !== null && v !== null && v < w;
    case 'lte': return w !== null && v !== null && v <= w;
    default: return true;
  }
}

/** Can one value of a field satisfy all of these at once? Answers "yes" whenever it cannot prove otherwise. */
function fieldConsistent(atoms: Atom[], field: FieldDef | undefined): boolean {
  const wantsNull = atoms.some((a) => a.kind === 'null');
  const needsValue = atoms.some((a) => a.kind === 'notNull' || ((a.kind === 'cmp' || a.kind === 'in') && !a.orNull));
  if (wantsNull) return !needsValue;
  if (!needsValue) return true;
  const tests = atoms.filter((a) => a.kind === 'cmp' || a.kind === 'in' || a.kind === 'notIn');
  // Finite candidates: an exact value, an "in" list, or the field's own value list.
  const exact = tests.filter((a) => a.kind === 'cmp' && a.op === 'eq').map((a) => a.value as Scalar);
  const lists = tests.filter((a) => a.kind === 'in').map((a) => a.values ?? []);
  const domain: Scalar[] | null = exact.length ? [exact[0]] : lists.length ? lists[0] : field?.type === 'bool' ? [true, false] : field?.type === 'enum' && field.enumValues ? field.enumValues : null;
  if (domain) return domain.some((v) => tests.every((a) => holds(v, a)));
  // Ranges.
  const integer = field?.type === 'int' || field?.type === 'cents' || field?.type === 'points';
  let lo: number | string | null = null, hi: number | string | null = null, loStrict = false, hiStrict = false;
  for (const a of tests) {
    if (a.kind !== 'cmp' || (typeof a.value !== 'number' && typeof a.value !== 'string')) continue;
    const v = a.value;
    if ((a.op === 'gt' || a.op === 'gte') && (lo === null || v > lo || (v === lo && a.op === 'gt'))) { lo = v; loStrict = a.op === 'gt'; }
    if ((a.op === 'lt' || a.op === 'lte') && (hi === null || v < hi || (v === hi && a.op === 'lt'))) { hi = v; hiStrict = a.op === 'lt'; }
  }
  if (lo === null || hi === null) return true;
  if (typeof lo !== typeof hi) return true;
  if (integer && typeof lo === 'number' && typeof hi === 'number') {
    const from = loStrict ? lo + 1 : lo, to = hiStrict ? hi - 1 : hi;
    if (from > to) return false;
    if (to - from > 200) return true;
    for (let v = from; v <= to; v++) if (tests.every((a) => holds(v, a))) return true;
    return false;
  }
  return lo < hi || (lo === hi && !loStrict && !hiStrict);
}

function canHoldTogether(project: Project, a: Predicate, b: Predicate): boolean {
  const da = dnf(a, false), db = dnf(b, false);
  if (!da || !db || da.length * db.length > DNF_LIMIT * 4) return true;
  const fields = projectFieldIndex(project);
  for (const x of da) for (const y of db) {
    const byPath = new Map<string, Atom[]>();
    for (const atom of [...x, ...y]) byPath.set(atom.path, [...(byPath.get(atom.path) ?? []), atom]);
    let ok = true;
    for (const [path, atoms] of byPath) if (!fieldConsistent(atoms, fields.get(path))) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ what the resolver does for every customer */

interface Seen {
  total: number;
  /** Rule → customers who match it as they stand today. */
  match: Map<string, Set<string>>;
  win: Map<string, Set<string>>;
  /** Rule → customers who match it at a journey step but not today, with the first such step. */
  matchLater: Map<string, Map<string, number>>;
  winLater: Map<string, Map<string, number>>;
  /** "A|B" (project order) → customers who match both rules of one exclusive group. */
  both: Map<string, Set<string>>;
  bothLater: Map<string, Map<string, number>>;
  /** Losing rule → the rule(s) that came out above it → customers. */
  beatenBy: Map<string, Map<string, Set<string>>>;
  /** Rules that were at the top of a tie for at least one customer today. */
  tiedTop: Set<string>;
  fallback: Map<string, Set<string>>;
  unmatched: Map<string, Set<string>>;
  unmatchedLater: Map<string, Map<string, number>>;
}

const addTo = (m: Map<string, Set<string>>, k: string, id: string): void => { const s = m.get(k); if (s) s.add(id); else m.set(k, new Set([id])); };
const addLater = (m: Map<string, Map<string, number>>, k: string, id: string, step: number): void => {
  const s = m.get(k) ?? new Map<string, number>();
  if (!s.has(id)) s.set(id, step);
  m.set(k, s);
};
const pairKey = (a: string, b: string): string => `${a}|${b}`;

function observe(project: Project, records: SyntheticRecord[]): Seen {
  const seen: Seen = {
    total: 0, match: new Map(), win: new Map(), matchLater: new Map(), winLater: new Map(), both: new Map(), bothLater: new Map(),
    beatenBy: new Map(), tiedTop: new Set(), fallback: new Map(), unmatched: new Map(), unmatchedLater: new Map(),
  };
  const order = new Map(project.rules.map((r, i) => [r.id, i]));
  const exclusive = project.rules.filter((r) => r.scope === project.documentType && r.enabled !== false && r.mode === 'exclusive');
  const groups = new Map<string, Rule[]>();
  for (const r of exclusive) { const g = ruleWording.group(r); if (g) groups.set(g, [...(groups.get(g) ?? []), r]); }
  const targets = project.nodes.filter((n) => n.type === 'variant-set' || n.type === 'conditional-region');
  const steps = project.journey?.events?.length ?? 0;

  for (const record of records) {
    if (record.documentType !== project.documentType) continue;
    seen.total += 1;
    const id = record.recordId;
    // A journey step that leaves the customer's data exactly as an earlier state resolves identically: resolve each state once.
    const states = new Set<string>();
    for (let step = -1; step < steps; step++) {
      const today = step < 0;
      const state = JSON.stringify(applyJourney(record, project.journey.events, today ? null : step).record);
      if (states.has(state)) continue;
      states.add(state);
      const res = resolve({ project, record, overrides: {}, journeyCursor: today ? null : step });
      const matched = new Set(res.trace.filter((t) => t.kind === 'rule' && t.matched).map((t) => t.ruleId));
      for (const ruleId of matched) {
        if (today) addTo(seen.match, ruleId, id);
        else if (!seen.match.get(ruleId)?.has(id)) addLater(seen.matchLater, ruleId, id, step);
      }
      for (const [, rules] of groups) {
        const hits = rules.filter((r) => matched.has(r.id)).sort((a, b) => b.priority - a.priority || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        if (!hits.length) continue;
        for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
          const [a, b] = (order.get(hits[i].id) ?? 0) < (order.get(hits[j].id) ?? 0) ? [hits[i], hits[j]] : [hits[j], hits[i]];
          const key = pairKey(a.id, b.id);
          if (today) addTo(seen.both, key, id);
          else if (!seen.both.get(key)?.has(id)) addLater(seen.bothLater, key, id, step);
        }
        const top = hits.filter((r) => r.priority === hits[0].priority);
        if (top.length === 1) {
          if (today) addTo(seen.win, top[0].id, id);
          else if (!seen.win.get(top[0].id)?.has(id)) addLater(seen.winLater, top[0].id, id, step);
        } else if (today) for (const r of top) seen.tiedTop.add(r.id);
        if (today) for (const loser of hits.slice(top.length)) for (const winner of top) {
          const m = seen.beatenBy.get(loser.id) ?? new Map<string, Set<string>>();
          addTo(m, winner.id, id);
          seen.beatenBy.set(loser.id, m);
        }
      }
      for (const node of targets) {
        const noRule = !(groups.get(node.id) ?? []).some((r) => matched.has(r.id));
        if (!noRule) continue;
        if (node.fallbackVariantId) {
          if (today && res.findings.some((f) => f.code === 'FALLBACK_SELECTED' && f.nodeId === node.id)) addTo(seen.fallback, node.id, id);
        } else if (today) addTo(seen.unmatched, node.id, id);
        else if (!seen.unmatched.get(node.id)?.has(id)) addLater(seen.unmatchedLater, node.id, id, step);
      }
    }
  }
  return seen;
}

/* ------------------------------------------------------------------ observations */

export function reviewRules(project: Project, records: SyntheticRecord[]): RuleObservation[] {
  const seen = observe(project, records);
  const out: RuleObservation[] = [];
  const title = (r: Rule): string => q(ruleWording.title(project, r));
  const component = (nodeId: string): string => ruleWording.component(project, nodeId);
  const versionOf = (r: Rule): string => (r.then.op === 'selectVariant' ? q(ruleWording.version(project, r.then.variantId)) : 'its version');
  const ofAll = (n: number): string => `${n} of ${seen.total} synthetic customers`;
  const count = (m: Map<string, Set<string>>, k: string): number => m.get(k)?.size ?? 0;
  /** Customers for whom something happens at a journey step but not today, and where along the journey it first happens. */
  const later = (m: Map<string, Map<string, number>>, k: string): { n: number; when: string } => {
    const s = m.get(k);
    if (!s?.size) return { n: 0, when: '' };
    const first = Math.min(...s.values());
    const e = project.journey.events[first];
    return { n: s.size, when: `along the journey (first after the step ${q(e?.label ?? e?.eventType ?? `step ${first + 1}`)})` };
  };
  const mine = project.rules.filter((r) => r.scope === project.documentType);
  const enabled = mine.filter((r) => r.enabled !== false);
  const groups = new Map<string, Rule[]>();
  for (const r of enabled) { const g = ruleWording.group(r); if (g) groups.set(g, [...(groups.get(g) ?? []), r]); }
  /** Every priority in use for a component, whether the rule is switched on or not (a new priority must not meet any of them). */
  const usedPriorities = (group: string, except: string): number[] => mine.filter((r) => r.id !== except && ruleWording.group(r) === group).map((r) => r.priority);

  const reprioritise = (rule: Rule, priority: number, code: string, explanation: string, riskReason: string): FixProposal => {
    const up = priority > rule.priority;
    return {
      id: `rule-review/${code}/${rule.id}/priority-${priority}`,
      findingCode: code,
      title: `${up ? 'Raise' : 'Lower'} the priority of ${title(rule)}`,
      explanation,
      kind: 'change',
      commands: [{ type: 'UPSERT_RULE', rule: { ...deepClone(rule), priority } }],
      risk: 'review',
      riskReason,
      source: 'builtin',
    };
  };

  /* ---- ties, overlaps and shadowed rules: pairs of exclusive rules for the same component */
  const shadowed = new Set<string>();
  for (const [group, rules] of groups) {
    for (const r of rules) {
      const m = count(seen.match, r.id);
      if (!m || count(seen.win, r.id) || seen.tiedTop.has(r.id)) continue;
      const by = [...(seen.beatenBy.get(r.id) ?? new Map<string, Set<string>>()).entries()]
        .map(([id, s]) => ({ rule: rules.find((x) => x.id === id), n: s.size }))
        .filter((x): x is { rule: Rule; n: number } => !!x.rule)
        .sort((a, b) => b.n - a.n || (a.rule.id < b.rule.id ? -1 : 1));
      if (!by.length) continue;
      shadowed.add(r.id);
      const wonLater = later(seen.winLater, r.id);
      const obs: RuleObservation = {
        id: `rule-review/shadowed/${r.id}`,
        kind: 'shadowed',
        severity: 'warning',
        ruleIds: [r.id, ...by.map((x) => x.rule.id)],
        title: by.length === 1 ? `${title(r)} never applies: ${title(by[0].rule)} always wins` : `${title(r)} never applies: other rules always win`,
        detail: `${ofAll(m)} match ${title(r)}, but every one of them also matches a rule for ${component(group)} with a higher priority: ${by.map((x) => `${title(x.rule)} (${people(x.n)})`).join(', ')}. So nobody receives ${versionOf(r)} because of this rule.`
          + (wonLater.n ? ` It does win ${wonLater.when}.` : ''),
      };
      const top = by.reduce((a, b) => (b.rule.priority > a.rule.priority ? b : a)).rule;
      if (by.every((x) => ruleWording.specificity(r.when) > ruleWording.specificity(x.rule.when))) {
        const used = usedPriorities(group, r.id);
        const above = Math.min(10001, ...used.filter((p) => p > top.priority));
        if (above - top.priority >= 2) {
          const p = top.priority + Math.min(10, Math.floor((above - top.priority) / 2));
          obs.proposal = reprioritise(r, p, 'RULE_SHADOWED',
            `${title(r)} has more conditions than the rule${by.length === 1 ? '' : 's'} that outrank it, so it is the more specific one. Raising its priority from ${r.priority} to ${p} lets it win for the ${people(m)} who match it; they would then get ${versionOf(r)}.`,
            `Changes which version ${people(m)} receive.`);
        }
      }
      out.push(obs);
    }

    for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i], b = rules[j];
      const key = pairKey(a.id, b.id);
      const c = count(seen.both, key);
      const l = later(seen.bothLater, key);
      if (a.priority === b.priority) {
        const possible = c > 0 || l.n > 0 || canHoldTogether(project, a.when, b.when);
        if (!possible) continue;
        // The more specific rule should win; if they are equally specific, the one fewer customers match.
        const sa = ruleWording.specificity(a.when), sb = ruleWording.specificity(b.when);
        const ma = count(seen.match, a.id), mb = count(seen.match, b.id);
        const winner = sa !== sb ? (sa > sb ? a : b) : ma !== mb ? (ma < mb ? a : b) : a;
        const loser = winner === a ? b : a;
        const why = sa !== sb ? `${title(winner)} has more conditions, so it is the more specific rule.` : `The two rules are equally specific, so this is only a suggestion; if ${title(loser)} should win instead, change that rule's priority.`;
        const used = usedPriorities(group, winner.id);
        const above = Math.min(10001, ...used.filter((p) => p > winner.priority));
        const below = Math.max(-1, ...usedPriorities(group, loser.id).filter((p) => p < loser.priority));
        const effect = c ? ` The ${people(c)} who match both would then get ${versionOf(winner)} instead of a blocked document.` : '';
        const risk = c ? `Changes which version ${people(c)} receive.` : 'Changes which rule wins when a customer matches both.';
        let proposal: FixProposal | undefined;
        if (above - winner.priority >= 2) {
          const p = winner.priority + Math.min(10, Math.floor((above - winner.priority) / 2));
          proposal = reprioritise(winner, p, 'EXCLUSIVE_PRIORITY_TIE', `${why} Raising its priority from ${winner.priority} to ${p} makes it win whenever both rules match, without changing its order against any other rule.${effect}`, risk);
        } else if (loser.priority - below >= 2) {
          const p = loser.priority - Math.min(10, Math.floor((loser.priority - below) / 2));
          proposal = reprioritise(loser, p, 'EXCLUSIVE_PRIORITY_TIE', `${why} Lowering the priority of ${title(loser)} from ${loser.priority} to ${p} makes ${title(winner)} win whenever both rules match, without changing the order against any other rule.${effect}`, risk);
        }
        const base = `Both rules choose a version of ${component(group)} and have the same priority, so neither can win when a customer matches both.`;
        out.push({
          id: `rule-review/tie/${a.id}+${b.id}`,
          kind: 'tie',
          severity: c ? 'blocking' : 'warning',
          ruleIds: [a.id, b.id],
          title: c ? `${title(a)} and ${title(b)} tie for ${people(c)}` : l.n ? `${title(a)} and ${title(b)} would tie later in the journey` : `${title(a)} and ${title(b)} have the same priority`,
          detail: c ? `${base} ${ofAll(c)} match both today, and their document is blocked until one rule is given a different priority.${l.n ? ` ${people(l.n)} more would be affected ${l.when}.` : ''}`
            : l.n ? `${base} No synthetic customer matches both today, but ${people(l.n)} would ${l.when}, and their document would then be blocked.`
              : `${base} No synthetic customer matches both today, but nothing in the two conditions rules it out; such a customer's document would be blocked.`,
          ...(proposal ? { proposal } : {}),
        });
        continue;
      }
      if (!c && !l.n) continue;
      const high = a.priority > b.priority ? a : b, low = high === a ? b : a;
      if (shadowed.has(low.id)) continue;
      const sameOutcome = high.then.op === 'selectVariant' && low.then.op === 'selectVariant' && high.then.variantId === low.then.variantId;
      const outcome = sameOutcome ? `both choose ${versionOf(high)}, so the result is the same either way` : `they get ${versionOf(high)} rather than ${versionOf(low)}`;
      const decided = [...(seen.both.get(key) ?? [])].filter((id) => seen.win.get(high.id)?.has(id)).length;
      out.push({
        id: `rule-review/overlap/${a.id}+${b.id}`,
        kind: 'overlap',
        severity: 'info',
        ruleIds: [high.id, low.id],
        title: c ? `${title(high)} wins over ${title(low)} for ${people(c)}` : `${title(high)} would win over ${title(low)} later in the journey`,
        detail: c ? `${ofAll(c)} match both rules for ${component(group)}. ${title(high)} has the higher priority, so ${outcome}.`
          + (decided < c ? ` For ${c - decided} of them another rule with an even higher priority decides.` : '')
          + (l.n ? ` ${people(l.n)} more match both ${l.when}.` : '')
          : `No synthetic customer matches both rules for ${component(group)} today, but ${people(l.n)} do ${l.when}. ${title(high)} has the higher priority, so ${outcome.replace(/^they get/, 'they would get')}.`,
      });
    }
  }

  /* ---- rules nobody reaches */
  for (const r of enabled) {
    if (count(seen.match, r.id)) continue;
    const condition = ruleWording.condition(project, r.when);
    if (!canHoldTogether(project, r.when, r.when)) {
      out.push({
        id: `rule-review/unreachable/${r.id}`, kind: 'unreachable', severity: 'warning', ruleIds: [r.id],
        title: `${title(r)} can never apply`,
        detail: `Its conditions contradict each other (when ${condition}), so no customer can ever match it. Correct the condition or remove the rule.`,
      });
      continue;
    }
    const l = later(seen.matchLater, r.id);
    out.push({
      id: `rule-review/unreachable/${r.id}`, kind: 'unreachable', severity: 'info', ruleIds: [r.id],
      title: `No customer matches ${title(r)} today`,
      detail: l.n
        ? `None of the ${people(seen.total)} matches this rule as their data stands (when ${condition}). ${people(l.n)} would match it ${l.when}. Coverage can build a scenario that reaches it.`
        : `None of the ${people(seen.total)} matches this rule, today or at any journey step (when ${condition}). That does not make the rule wrong: the sample data may simply not include such a customer. Coverage can build a scenario that reaches it.`,
    });
  }

  /* ---- components without a fallback, and customers who fall back */
  for (const node of project.nodes) {
    if (node.type !== 'variant-set' && node.type !== 'conditional-region') continue;
    const targeting = mine.filter((r) => r.then.op === 'selectVariant' && r.then.targetNodeId === node.id);
    const name = component(node.id);
    if (node.fallbackVariantId) {
      const c = count(seen.fallback, node.id);
      if (c) out.push({
        id: `rule-review/gap/${node.id}`, kind: 'gap', severity: 'info', ruleIds: [],
        title: `${people(c)} get the fallback in ${name}`,
        detail: `${ofAll(c)} match none of the rules for ${name}, so they receive the fallback version ${q(ruleWording.version(project, node.fallbackVariantId))}. That is fine when it is the intended default; if some of them need their own message, add a rule for them.`,
      });
      continue;
    }
    // A section that is switched on by a rule or by its own conditions is optional by design: no fallback is needed.
    const optional = node.type === 'conditional-region' && (node.ruleDriven || Object.keys(node.variantConditions ?? {}).length > 0 || !targeting.length);
    if (optional) continue;
    const c = count(seen.unmatched, node.id);
    const l = later(seen.unmatchedLater, node.id);
    const blocks = node.type === 'variant-set';
    const proposal = fallbackProposal(project, node, targeting, c + l.n);
    out.push({
      id: `rule-review/no-fallback/${node.id}`,
      kind: 'no-fallback',
      severity: blocks && c ? 'blocking' : blocks ? 'warning' : 'info',
      ruleIds: targeting.map((r) => r.id),
      title: `${name} has no fallback version`,
      detail: (blocks
        ? c ? `${ofAll(c)} match none of the rules for ${name}, and no fallback version is set, so their document is blocked.`
          : `Every synthetic customer currently matches a rule for ${name}, but a customer who matches none would get a blocked document, because no fallback version is set.`
        : `${ofAll(c)} match none of the rules for ${name}; with no fallback version they simply do not get this part. If that is intended, nothing needs to change.`)
        + (l.n ? ` ${people(l.n)} more would match no rule ${l.when}.` : ''),
      ...(proposal ? { proposal } : {}),
    });
  }

  /* ---- rules that are switched off */
  for (const r of mine) {
    if (r.enabled !== false) continue;
    out.push({
      id: `rule-review/disabled/${r.id}`, kind: 'disabled', severity: 'info', ruleIds: [r.id],
      title: `${title(r)} is switched off`,
      detail: `It stays in the project but is never applied (when ${ruleWording.condition(project, r.when)}). Switch it on again in Rules if it should apply, or delete it if it is no longer needed.`,
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || cmp(a.ruleIds[0] ?? '', b.ruleIds[0] ?? '')
    || KIND_RANK[a.kind] - KIND_RANK[b.kind]
    || cmp(a.id, b.id));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Fallback = the version the lowest-priority rule for the component shows, else its first version. */
function fallbackProposal(project: Project, node: DocNode, targeting: Rule[], affected: number): FixProposal | undefined {
  const versions = node.variantIds ?? [];
  if (!versions.length) return undefined;
  const name = ruleWording.component(project, node.id);
  const lowest = targeting
    .filter((r) => r.then.op === 'selectVariant' && versions.includes(r.then.variantId))
    .sort((a, b) => a.priority - b.priority || cmp(a.id, b.id))[0];
  const variantId = lowest && lowest.then.op === 'selectVariant' ? lowest.then.variantId : versions[0];
  const version = q(ruleWording.version(project, variantId));
  const why = lowest ? `It is the version shown by the lowest-priority rule, ${q(ruleWording.title(project, lowest))}, which makes it the most general message.` : 'It is the first version of the component.';
  const base = { id: `rule-review/no-fallback/${node.id}/${variantId}`, findingCode: 'VARIANT_SET_WITHOUT_FALLBACK', source: 'builtin' as const };
  if (node.locked) {
    return {
      ...base, title: `Set a fallback version for ${name}`, kind: 'link', risk: 'review', riskReason: 'The component is locked.',
      explanation: `${name} is locked, so it cannot be changed from here. Unlock it in Design and choose a fallback version; ${version} would be the natural choice. ${why}`,
      link: { view: 'design', nodeId: node.id, label: `Open ${name}` },
    };
  }
  return {
    ...base,
    title: `Make ${version} the fallback version of ${name}`,
    explanation: `Customers who match no rule for ${name} would then get ${version} instead of ${node.type === 'variant-set' ? 'a blocked document' : 'nothing'}. ${why}`,
    kind: 'change',
    commands: [{ type: 'UPDATE_NODE', nodeId: node.id, patch: { fallbackVariantId: variantId } }],
    risk: affected ? 'review' : 'safe',
    riskReason: affected ? `${people(affected)} who match no rule (today or along the journey) would start receiving ${version}.` : 'Every synthetic customer already matches a rule, so nobody’s document changes.',
    source: 'builtin',
  };
}
