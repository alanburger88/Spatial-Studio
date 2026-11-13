import {
  buildContext, canonicalJson, customFieldDefs, deepClone, deepPatch, getPath, languageName, projectFieldIndex, projectFields, projectLanguages,
  SOURCE_LANGUAGE, validateRecordShape,
  type DocNode, type FieldDef, type Predicate, type Project, type Rule, type Scalar, type SyntheticRecord,
} from '@iss/model';
import { evaluatePredicate, predicatePaths, resolve, type Resolution } from '@iss/resolver';
import { coverageKit, type CoverageConj, type CoverageEnv } from './coverage';
import type { GeneratedCustomer, TestDataOptions, TestDataPlan, TestDataTarget } from './types';

/**
 * Test customers: a small set of synthetic customer records that exercises every outcome of a document once (each rule,
 * message version, optional section shown and hidden, document language) and the values around every threshold a
 * condition uses. Pure and deterministic; nothing is stored.
 *
 * It reuses the coverage search: what must hold for a target comes from the rules, the fewest field changes that make
 * it hold are derived from the field types, and the closest starting customer is changed. The difference is that the
 * result is a REAL record, reached as issued: no what-if on top, no journey step. Every customer is checked against the
 * customer data contract and confirmed with the resolver before it is returned.
 */

const { Env, targetsOf, dnf, shiftDay, show, contradiction, treeOf, stepLabel, blockingKey, listOf, q, and, not, TRUE } = coverageKit;
const FALSE: Predicate = { op: 'or', args: [] };

const DEFAULT_MAX = 200;
/** Starting customers the search looks at for one target (the same bound the coverage check uses). */
const SEARCH_WIDTH = 12;
/** Records tried for one edge value before a customer with a blocking issue is accepted. */
const EDGE_TRIES = 8;
const FIRST_DATE = '2026-01-01';
const NUMERIC = new Set<FieldDef['type']>(['int', 'cents', 'points']);

/* 23 given × 19 family names: customer i takes GIVEN[i % 23] and FAMILY[i % 19], which is a different pair for 437 customers. */
const GIVEN = ['Avery', 'Bianca', 'Callum', 'Daniela', 'Elliot', 'Farah', 'Gideon', 'Hannah', 'Imani', 'Julian', 'Keiko', 'Lucas', 'Maya', 'Nolan', 'Olivia', 'Priya', 'Quentin', 'Rosa', 'Samuel', 'Thandi', 'Victor', 'Willa', 'Zane'];
const FAMILY = ['Abbott', 'Bennett', 'Castillo', 'Dlamini', 'Eriksen', 'Fraser', 'Gupta', 'Hughes', 'Ibarra', 'Jensen', 'Kowalski', 'Lindgren', 'Moreno', 'Nakamura', 'Okafor', 'Petrov', 'Quinn', 'Romero', 'Sato'];

type Change = [string, unknown];
const isBlocking = (res: Resolution): boolean => res.findings.some((f) => f.severity === 'blocking');
const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);
const plain = (label: string): string => label.replace(/\s*\([^)]*\)/g, '').trim();
/** A validation message without the field path in brackets. */
const withoutPaths = (message: string): string => message.replace(/\s\([A-Za-z_]\w*(?:\.[\w[\]]+)+\)/g, '');

/* ------------------------------------------------------------------ a starting record from the field definitions */

function fallbackValue(f: Pick<FieldDef, 'type' | 'label' | 'enumValues' | 'example'>, nthDate: number): unknown {
  const example = f.example?.trim() ?? '';
  switch (f.type) {
    case 'int': case 'cents': case 'points':
      // Zero unless an example says otherwise: every balance check of the form "total = sum of parts" holds for it.
      return /^-?\d+$/.test(example) ? Number(example) : 0;
    case 'bool': return /^(true|yes)$/i.test(example);
    case 'date': return shiftDay(example, 0) ?? shiftDay(FIRST_DATE, nthDate * 10);
    case 'enum': return f.enumValues?.length ? (f.enumValues.includes(example) ? example : f.enumValues[0]) : example || 'Sample';
    case 'array': return [];
    default: return example || `Sample ${plain(f.label).toLowerCase()}`;
  }
}

/** Writes one contract field into a record (`claim.*` is the first claim of an EOB). */
function setField(record: Record<string, unknown>, path: string, value: unknown): void {
  if (record.documentType === 'eob' && path.startsWith('claim.')) {
    const claims = Array.isArray(record.claims) ? (record.claims as Array<Record<string, unknown>>) : (record.claims = [] as Array<Record<string, unknown>>);
    if (!claims.length) claims.push({});
    claims[0][path.slice(6)] = value;
    return;
  }
  const parts = path.split('.');
  let t = record;
  for (const p of parts.slice(0, -1)) { if (!t[p] || typeof t[p] !== 'object' || Array.isArray(t[p])) t[p] = {}; t = t[p] as Record<string, unknown>; }
  t[parts[parts.length - 1]] = value;
}

/** Three rows for a list field, built from its columns. */
function sampleRows(f: FieldDef, fields: Map<string, FieldDef>): Array<Record<string, unknown>> {
  return [1, 2, 3].map((n) => Object.fromEntries((f.itemFields ?? []).map((it) => {
    // A claim row shares its allowed values with the single-claim field of the same name.
    const twin = f.path === 'claims' ? fields.get(`claim.${it.key}`) : undefined;
    const value = it.type === 'string' ? `Sample ${plain(it.label).toLowerCase()} ${n}`
      : it.type === 'date' ? shiftDay(FIRST_DATE, n - 1)
      : fallbackValue({ type: it.type, label: it.label, enumValues: twin?.enumValues }, 0);
    return [it.key, value];
  })));
}

/**
 * Makes a record complete for the project's data contract. With `everything` it fills every field (a starting record for
 * a document that has no samples yet); otherwise only what the contract requires and the record lacks.
 */
function completed(project: Project, source: SyntheticRecord | null, locales: string[]): SyntheticRecord {
  const defs = projectFields(project);
  const fields = new Map(defs.map((f) => [f.path, f]));
  const everything = source === null;
  const record = (source ? deepClone(source) : { recordId: 'BASELINE' }) as unknown as Record<string, unknown>;
  record.documentType = project.documentType;
  if (!record.customer || typeof record.customer !== 'object') record.customer = {};
  const stored = defs.filter((f) => !f.derived && f.path !== 'recordId' && f.path !== 'documentType');
  // Lists first: the single-claim fields of an EOB live in the first row of its claims.
  for (const f of stored.filter((x) => x.type === 'array')) {
    const cur = getPath(record, f.path) as unknown;
    if (!Array.isArray(cur) || (f.path === 'claims' && !cur.length)) setField(record, f.path, everything || f.path === 'claims' ? sampleRows(f, fields) : []);
  }
  let nthDate = 0;
  let ctx = buildContext(record as unknown as SyntheticRecord);
  for (const f of stored.filter((x) => x.type !== 'array')) {
    const ordinal = f.type === 'date' ? nthDate++ : 0;
    const cur = getPath(ctx, f.path) as unknown;
    if ((cur !== null && cur !== '') || !(everything || f.required)) continue;
    setField(record, f.path, fallbackValue(f, ordinal));
    ctx = buildContext(record as unknown as SyntheticRecord);
  }
  const customer = record.customer as Record<string, unknown>;
  if (typeof customer.locale !== 'string' || !locales.includes(customer.locale)) customer.locale = SOURCE_LANGUAGE;
  return record as unknown as SyntheticRecord;
}

/* ------------------------------------------------------------------ conditions */

interface Leaf { node: Predicate; path: string; op: string; values: Scalar[] }

function leavesOf(p: Predicate, out: Leaf[] = []): Leaf[] {
  switch (p.op) {
    case 'and': case 'or': p.args.forEach((a) => leavesOf(a, out)); break;
    case 'not': leavesOf(p.arg, out); break;
    case 'isNull': case 'notNull': out.push({ node: p, path: p.path, op: p.op, values: [] }); break;
    case 'in': out.push({ node: p, path: p.path, op: p.op, values: Array.isArray(p.value) ? p.value : [] }); break;
    default: out.push({ node: p, path: p.path, op: p.op, values: [p.value] });
  }
  return out;
}

/** The condition with one of its comparisons replaced by "true" or "false". */
function replaced(p: Predicate, leaf: Predicate, by: Predicate): Predicate {
  if (p === leaf) return by;
  if (p.op === 'and' || p.op === 'or') return { op: p.op, args: p.args.map((a) => replaced(a, leaf, by)) };
  if (p.op === 'not') return { op: 'not', arg: replaced(p.arg, leaf, by) };
  return p;
}

/** Who reads a value: a rule, an inline message condition or a visibility condition. */
interface Owner {
  key: string;
  pred: Predicate;
  /** Conditions that take the decision away when they hold: higher-priority rules, earlier branches. */
  rivals: Predicate[];
  /** What the document did, in plain words. */
  observe: (res: Resolution) => string;
}

/* ------------------------------------------------------------------ what is planned */

interface Goal {
  target: TestDataTarget;
  label: string;
  alts: Predicate[];
  reached: (res: Resolution) => boolean;
  /** A weaker way to count the target as reached (a rule that matches without deciding the message). */
  weak?: { alts: Predicate[]; reached: (res: Resolution) => boolean; accept: boolean };
  core: Predicate | null;
  never?: string;
  /** The check the chosen customer passed. */
  check: (res: Resolution) => boolean;
  /** Reason when its own search found nothing (filled lazily). */
  why: () => string;
}

interface Edge {
  target: TestDataTarget;
  owner: Owner | null;
  leaf: Predicate | null;
  /** The path that is set (a list's row count for an empty list). */
  path: string;
  value: unknown;
  readers: Owner[];
  /** Set when no customer can be built at all. */
  never?: string;
}

interface Entry {
  record: SyntheticRecord;
  ctx: unknown;
  blocked: boolean;
  changes: number;
  label: string;
  goals: Goal[];
  edges: Edge[];
}

const LABEL_ORDER: Array<TestDataTarget['kind']> = ['variant', 'section-shown', 'rule', 'language', 'section-hidden'];

/**
 * Plans test customers for a project.
 *
 * `baseRecords` are the starting points (those of the project's document type; the closest one is changed as little as
 * possible). When there are none, a starting record is built from the project's field definitions alone.
 */
export function planTestData(project: Project, baseRecords: SyntheticRecord[], opts: TestDataOptions): TestDataPlan {
  const docType = project.documentType;
  const fields = projectFieldIndex(project);
  const extra = customFieldDefs(project.customFields);
  const locales = [...new Set([SOURCE_LANGUAGE, ...projectLanguages(project)])];
  const max = Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max as number)) : DEFAULT_MAX;

  const own = baseRecords.filter((r) => r.documentType === docType);
  const bases = own.length ? own.map((r) => completed(project, r, locales)) : [completed(project, null, locales)];
  // As issued: the search must not lean on journey steps, so it sees the project without them.
  const issued: Project = { ...project, journey: { ...project.journey, snapshotPolicy: 'issued-is-immutable', events: [] } };
  const env: CoverageEnv = new Env(issued, bases, SEARCH_WIDTH);
  let journeyEnv: CoverageEnv | null = null;

  /** First problem the customer import would report for this record, or null. */
  const invalid = (record: SyntheticRecord): string | null => {
    const errors = validateRecordShape(deepClone(record), docType, extra);
    if (errors.length) return withoutPaths(errors[0]);
    return locales.includes(record.customer.locale) ? null : `${languageName(record.customer.locale)} is not a language of this project.`;
  };
  const resolutions = new Map<string, Resolution>();
  const resolved = (record: SyntheticRecord): Resolution => {
    const key = canonicalJson(record);
    let res = resolutions.get(key);
    if (!res) { res = resolve({ project: issued, record }); resolutions.set(key, res); }
    return res;
  };
  const baseBlocked = bases.map((record, i) => {
    const res = resolved(record);
    env.baseBlocking[i] = new Set(res.findings.filter((f) => f.severity === 'blocking').map(blockingKey));
    return env.baseBlocking[i].size > 0;
  });

  const kit = targetsOf(project, { matched: new Set(), selected: new Set(), shown: new Set() });
  const { rules, nodeTitle, partTitle, ruleTitle } = kit;
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const label = (path: string): string => plain(fields.get(path)?.label ?? path);

  /* --- reasons */
  const calculated = (preds: Predicate[]): string | null => {
    for (const path of preds.flatMap((p) => predicatePaths(p))) {
      const f = fields.get(path);
      if (f?.derived && !env.overridable(path)) return `It depends on ${q(plain(f.label))}, which is calculated from other fields and cannot be set on a customer, and no starting customer has a value that fits.`;
    }
    return null;
  };
  const journeyOnly = (alts: Predicate[], reached: (res: Resolution) => boolean): string | null => {
    if (!(project.journey?.events ?? []).length) return null;
    journeyEnv ??= new Env(project, bases, SEARCH_WIDTH);
    const hit = journeyEnv.search(alts, (res) => res.journeyCursor !== null && reached(res)).hit;
    return hit && hit.cursor !== null ? `It is only reached at the journey step ${q(stepLabel(project, hit.cursor))}, not on a document as issued, so no customer record is created for it.` : null;
  };
  const LIMIT = 'No customer reached it within the search limit.';

  /* ------------------------------------------------------------------ outcomes */

  /** The coverage search, accepting only records the customer import would accept. */
  const attempt = (alts: Predicate[], reached: (res: Resolution) => boolean): { record: SyntheticRecord | null; res: Resolution | null; changes: number; satisfiable: boolean; rejected: string | null } => {
    let rejected: string | null = null;
    const found = env.search(alts, (res) => {
      if (!reached(res)) return false;
      const problem = invalid(res.effectiveRecord);
      if (problem) { rejected ??= problem; return false; }
      return true;
    });
    return { record: found.hit?.res.effectiveRecord ?? null, res: found.hit?.res ?? null, changes: found.hit?.changes.length ?? 0, satisfiable: found.satisfiable, rejected };
  };

  const goals: Goal[] = [];
  const goal = (g: Omit<Goal, 'check' | 'why'>): void => { goals.push({ ...g, check: g.reached, why: () => LIMIT }); };
  const reasonFor = (g: Goal, strong: ReturnType<typeof attempt>, weak: ReturnType<typeof attempt> | null): string => {
    if (g.target.kind === 'variant' && weak?.record) return 'The rule that selects this message can match, but another rule or an earlier condition always takes precedence, so the message is never chosen.';
    if (strong.rejected || weak?.rejected) {
      if (g.target.kind === 'language') {
        const allowed = (fields.get('customer.locale')?.enumValues ?? []).map(languageName);
        return `A customer record can only name ${listOf(allowed)} as the preferred language, and no rule switches a document to ${languageName(g.target.targetId)}.`;
      }
      return `The only customers that reach it have a value the customer data contract does not accept. ${strong.rejected ?? weak?.rejected}`;
    }
    if (!strong.satisfiable && !weak?.satisfiable) {
      if (g.target.kind === 'section-hidden') return 'Nothing hides this section: every customer gets it.';
      if (g.core && env.combos([g.core]).length) return 'Whenever its own condition holds, another rule or an earlier condition takes precedence, so it is never chosen.';
      const why = g.core ? contradiction(env, g.core) : null;
      return why ? `${why} No customer can ever match.` : 'The conditions can never all be true for this document, so no customer can match.';
    }
    return calculated([...g.alts, ...(g.weak?.alts ?? [])]) ?? journeyOnly(g.alts, g.reached) ?? LIMIT;
  };

  if (opts.outcomes) {
    for (const t of kit.targets) {
      if (t.kind === 'rule') {
        const title = `Rule ${q(t.title)} applies`;
        goal({ target: { id: t.id, kind: 'rule', targetId: t.targetId, title, customer: null }, label: title, alts: t.alts, reached: t.reached, core: t.core, never: t.never, ...(t.weak.length ? { weak: { alts: t.weak, reached: t.touched, accept: true } } : {}) });
      } else if (t.kind === 'variant') {
        const nodeId = t.id.slice('variant:'.length, t.id.lastIndexOf('/'));
        goal({
          target: { id: t.id, kind: 'variant', targetId: t.targetId, title: `Message ${q(partTitle(t.targetId))} is chosen in ${q(nodeTitle(nodeId))}`, customer: null },
          label: `Reaches ${q(partTitle(t.targetId))}`, alts: t.alts, reached: t.reached, core: t.core, never: t.never,
          ...(t.weak.length ? { weak: { alts: t.weak, reached: t.touched, accept: false } } : {}),
        });
      } else {
        goal({ target: { id: `section-shown:${t.targetId}`, kind: 'section-shown', targetId: t.targetId, title: `Section ${q(t.title)} is shown`, customer: null }, label: `Shows ${q(t.title)}`, alts: t.alts, reached: t.reached, core: t.core, never: t.never });
        goal({
          target: { id: `section-hidden:${t.targetId}`, kind: 'section-hidden', targetId: t.targetId, title: `Section ${q(t.title)} is hidden`, customer: null },
          label: `Without ${q(t.title)}`, alts: [t.core ? not(t.core) : TRUE], reached: (res) => !treeOf(res).get(t.targetId)?.visible, core: t.core ? not(t.core) : null,
        });
      }
    }
    // Document languages: the customer's own language when it is one of the project's, unless a rule sets another.
    const setters = rules.filter((r) => r.mode === 'additive' && r.then.op === 'setApprovedLocale');
    const localeOf = (r: Rule): string => (r.then.op === 'setApprovedLocale' ? r.then.locale : '');
    for (const locale of locales) {
      const prefers: Predicate = { op: 'eq', path: 'customer.locale', value: locale };
      const alts = [and([prefers, ...setters.filter((r) => localeOf(r) !== locale).map((r) => not(r.when))]), ...setters.filter((r) => localeOf(r) === locale).map((r) => r.when)];
      const title = `Document in ${languageName(locale)}`;
      goal({ target: { id: `language:${locale}`, kind: 'language', targetId: locale, title, customer: null }, label: title, alts, reached: (res) => res.locale === locale, core: prefers });
    }
  }

  /* one candidate customer per target, then the fewest candidates that cover everything */
  interface Candidate { record: SyntheticRecord; res: Resolution; changes: number; covers: number[] }
  const candidates = new Map<string, Candidate>();
  goals.forEach((g) => {
    if (g.never) { const never = g.never; g.why = () => never; return; }
    const strong = attempt(g.alts, g.reached);
    let found = strong;
    let weak: ReturnType<typeof attempt> | null = null;
    if (!strong.record && g.weak) {
      weak = attempt(g.weak.alts, g.weak.reached);
      if (weak.record && g.weak.accept) { found = weak; g.check = g.weak.reached; }
    }
    if (!found.record || !found.res) { g.why = () => reasonFor(g, strong, weak); return; }
    const key = canonicalJson(found.record);
    if (!candidates.has(key)) candidates.set(key, { record: found.record, res: found.res, changes: found.changes, covers: [] });
  });
  const pool = [...candidates.values()];
  for (const c of pool) c.covers = goals.flatMap((g, i) => (!g.never && g.check(c.res) ? [i] : []));

  const entries: Entry[] = [];
  const open = new Set(pool.flatMap((c) => c.covers));
  const unused = new Set(pool.map((_, i) => i));
  while (open.size) {
    let best = -1;
    let gain = 0;
    for (const i of unused) {
      const n = pool[i].covers.filter((x) => open.has(x)).length;
      if (n > gain || (n === gain && n > 0 && pool[i].changes < pool[best].changes)) { best = i; gain = n; }
    }
    if (best < 0) break;
    unused.delete(best);
    const c = pool[best];
    const mine = c.covers.filter((x) => open.has(x)).map((x) => goals[x]);
    c.covers.forEach((x) => open.delete(x));
    const first = [...mine].sort((a, b) => LABEL_ORDER.indexOf(a.target.kind) - LABEL_ORDER.indexOf(b.target.kind))[0];
    entries.push({ record: c.record, ctx: buildContext(c.record), blocked: isBlocking(c.res), changes: c.changes, label: first.label, goals: mine, edges: [] });
  }

  /* ------------------------------------------------------------------ edges */

  const owners: Owner[] = [];
  if (opts.edges) {
    const sectionSays = (res: Resolution, id: string): string => `${treeOf(res).get(id)?.visible ? 'Shows' : 'Hides'} ${q(nodeTitle(id))}`;
    const messageSays = (res: Resolution, nodeId: string): string => {
      const n = treeOf(res).get(nodeId);
      if (n?.variants?.unresolved) return `No message is chosen in ${q(nodeTitle(nodeId))}`;
      const chosen = n?.visible ? n.variants?.selected ?? [] : [];
      return chosen.length ? `Gets ${listOf(chosen.map((v) => q(partTitle(v))))}` : `Hides ${q(nodeTitle(nodeId))}`;
    };
    for (const r of rules) {
      const then = r.then;
      owners.push({
        key: r.id, pred: r.when, rivals: kit.rivals(r).map((x) => x.when),
        observe: (res) => (then.op === 'selectVariant' ? messageSays(res, then.targetNodeId)
          : then.op === 'showSection' ? sectionSays(res, then.targetNodeId)
          : `Rule ${q(ruleTitle(r))} ${res.result.matchedRuleIds.includes(r.id) ? 'applies' : 'does not apply'}`),
      });
    }
    const exclusiveOn = (n: DocNode): Predicate[] => rules.filter((r) => r.mode === 'exclusive' && (r.exclusiveGroup ?? ('targetNodeId' in r.then ? r.then.targetNodeId : '')) === n.id).map((r) => r.when);
    for (const n of project.nodes) {
      if (n.visibleWhen) owners.push({ key: `${n.id}:visibleWhen`, pred: n.visibleWhen, rivals: [], observe: (res) => sectionSays(res, n.id) });
      if (n.type !== 'conditional-region' || n.ruleDriven) continue;
      const conds = kit.conditionsOf(n);
      conds.forEach(([v, cond], k) => owners.push({
        key: `${n.id}:${v}`, pred: cond, rivals: [...(n.policy === 'additive' ? [] : conds.slice(0, k).map(([, c]) => c)), ...exclusiveOn(n)],
        observe: (res) => messageSays(res, n.id),
      }));
    }
  }

  const edges: Edge[] = [];
  const edgeIds = new Set<string>();
  const readers = new Map<string, Array<{ owner: Owner; leaf: Predicate }>>();
  const settable = (path: string): boolean => path !== 'documentType' && path !== 'recordId' && fields.has(path);
  for (const owner of owners) {
    for (const leaf of leavesOf(owner.pred)) {
      const f = fields.get(leaf.path);
      if (!f || !settable(leaf.path)) continue;
      readers.set(leaf.path, [...(readers.get(leaf.path) ?? []), { owner, leaf: leaf.node }]);
      const add = (suffix: string, title: string, value: unknown, never?: string): void => {
        const id = `edge:${owner.key}:${leaf.path}:${suffix}`;
        if (edgeIds.has(id)) return;
        edgeIds.add(id);
        const calc = f.derived && !env.overridable(leaf.path) ? `${plain(f.label)} is calculated from other fields and cannot be set on a customer.` : undefined;
        edges.push({ target: { id, kind: 'edge', targetId: leaf.path, title, customer: null }, owner, leaf: leaf.node, path: leaf.path, value, readers: [owner], never: never ?? calc });
      };
      const name = plain(f.label);
      const counted = f.type === 'int' || f.type === 'points';
      for (const v of leaf.values) {
        if (v === null) continue;
        if (leaf.op !== 'in' && NUMERIC.has(f.type) && typeof v === 'number' && Number.isInteger(v)) {
          add(`below:${v}`, `${name} just below ${show(f, v)}`, v - 1, counted && v - 1 < 0 ? `${name} cannot be less than 0, so there is no value just below ${show(f, v)}.` : undefined);
          add(`on:${v}`, `${name} exactly ${show(f, v)}`, v, counted && v < 0 ? `${name} cannot be less than 0.` : undefined);
          add(`above:${v}`, `${name} just above ${show(f, v)}`, v + 1, counted && v + 1 < 0 ? `${name} cannot be less than 0.` : undefined);
        } else if (leaf.op !== 'in' && f.type === 'date' && typeof v === 'string' && shiftDay(v, 0)) {
          add(`below:${v}`, `${name} just before ${show(f, v)}`, shiftDay(v, -1));
          add(`on:${v}`, `${name} exactly ${show(f, v)}`, shiftDay(v, 0));
          add(`above:${v}`, `${name} just after ${show(f, v)}`, shiftDay(v, 1));
        } else if (f.type === 'bool' || typeof v === 'boolean') {
          for (const b of [true, false]) add(`is:${b}`, `${name} is ${show(f, b)}`, b);
        } else add(`is:${String(v)}`, `${name} is ${show(f, v)}`, v);
      }
    }
  }
  // One customer with each optional field a condition reads left empty (a list: no rows).
  for (const [path, who] of readers) {
    const f = fields.get(path)!;
    const list = f.type === 'array' ? f : path.endsWith('.count') ? fields.get(path.slice(0, -6)) : undefined;
    const isList = list?.type === 'array';
    const subject = isList ? list! : f;
    if (subject.required) continue;
    const id = `empty:${subject.path}`;
    if (edgeIds.has(id)) continue;
    edgeIds.add(id);
    const setPath = isList ? `${subject.path}.count` : path;
    const never = !isList && f.derived ? `${plain(f.label)} is calculated from other fields, so it cannot be left empty on a customer.` : undefined;
    edges.push({
      target: { id, kind: 'empty', targetId: subject.path, title: `${plain(subject.label)} is ${show(subject, isList ? [] : null)}`, customer: null },
      owner: who[0].owner, leaf: who[0].leaf, path: setPath, value: isList ? 0 : null, readers: [...new Set(who.map((w) => w.owner))], never,
    });
  }

  /** Combinations of the other conditions, without anything they say about the field that is being set. */
  const contexts = (preds: Predicate[], path: string): CoverageConj[] => {
    const out: CoverageConj[] = [];
    const seen = new Set<string>();
    for (const p of preds) {
      for (const conj of dnf(p, false, () => true)) {
        const rest = conj.filter((l) => l.path !== path);
        const key = JSON.stringify(rest);
        if (seen.has(key) || !env.satisfiable(rest)) continue;
        seen.add(key);
        out.push(rest);
        if (out.length >= SEARCH_WIDTH) return out;
      }
    }
    return out;
  };
  /** 2 = the value decides the outcome and nothing overrules it; 1 = it decides this condition; 0 = it does not. */
  const decides = (e: Edge, ctx: unknown): number => {
    if (!e.owner || !e.leaf) return 0;
    if (evaluatePredicate(replaced(e.owner.pred, e.leaf, TRUE), ctx) === evaluatePredicate(replaced(e.owner.pred, e.leaf, FALSE), ctx)) return 0;
    return e.owner.rivals.some((p) => evaluatePredicate(p, ctx)) ? 1 : 2;
  };

  const build = (e: Edge): { record: SyntheticRecord; res: Resolution; changes: number } | { reason: string } => {
    if (!e.owner || !e.leaf) return { reason: LIMIT };
    const yes = replaced(e.owner.pred, e.leaf, TRUE);
    const no = replaced(e.owner.pred, e.leaf, FALSE);
    const decisive = [and([yes, not(no)]), and([not(yes), no])];
    // Best first: the other conditions hold and no rival overrules; the other conditions hold; any customer.
    const levels = [...(e.owner.rivals.length ? [decisive.map((d) => and([d, ...e.owner!.rivals.map(not)]))] : []), decisive, [TRUE]];
    let rejected: string | null = null;
    for (const preds of levels) {
      const conjs = contexts(preds, e.path);
      const options: Array<{ i: number; changes: Change[]; distance: number }> = [];
      bases.forEach((_, i) => {
        const ctx = env.baseCtx(i);
        let plan: Change[] | null = null;
        for (const conj of conjs) { const p = env.plan(conj, ctx); if (p && (!plan || p.length < plan.length)) plan = p; }
        if (!plan) return;
        const cur = getPath(ctx, e.path) as unknown;
        const distance = typeof cur === 'number' && typeof e.value === 'number' ? Math.abs(cur - e.value) : 0;
        options.push({ i, changes: same(cur, e.value) ? plan : [...plan, [e.path, e.value]], distance });
      });
      // Fewest changes; then the customer whose own value is nearest (the rest of its data tends to fit); then one without issues.
      options.sort((a, b) => a.changes.length - b.changes.length || a.distance - b.distance || Number(baseBlocked[a.i]) - Number(baseBlocked[b.i]) || a.i - b.i);
      let fallback: { record: SyntheticRecord; res: Resolution; changes: number } | null = null;
      let tried = 0;
      for (const o of options) {
        if (tried >= EDGE_TRIES) break;
        const patch = env.toOverrides(bases[o.i], o.changes);
        if (!patch) continue;
        const record = deepPatch(bases[o.i], patch.overrides);
        if (!same(getPath(buildContext(record), e.path), e.value)) continue;
        const problem = invalid(record);
        if (problem) { rejected ??= problem; continue; }
        tried++;
        const res = resolved(record);
        const built = { record, res, changes: o.changes.length };
        if (!isBlocking(res)) return built;
        fallback ??= built;
      }
      if (fallback) return fallback;
    }
    return { reason: rejected ? `The customer data contract does not accept a record with this value. ${rejected}` : calculated([e.owner.pred]) ?? 'No starting customer could be given this value.' };
  };

  const edgeReasons = new Map<Edge, string>();
  for (const e of edges) {
    if (e.never) { edgeReasons.set(e, e.never); continue; }
    const built = build(e);
    const fresh = 'record' in built ? { ...built, ctx: buildContext(built.record) } : null;
    const need = fresh ? decides(e, fresh.ctx) : 0;
    // An existing customer that already has the value, in a situation at least as telling, is the edge customer.
    const reuse = entries.find((x) => same(getPath(x.ctx, e.path), e.value) && decides(e, x.ctx) >= need && (!fresh || !x.blocked || isBlocking(fresh.res)));
    if (reuse) reuse.edges.push(e);
    else if (fresh) entries.push({ record: fresh.record, ctx: fresh.ctx, blocked: isBlocking(fresh.res), changes: fresh.changes, label: e.target.title, goals: [], edges: [e] });
    else if ('reason' in built) edgeReasons.set(e, built.reason);
  }

  /* ------------------------------------------------------------------ the plan: cap, names, final check */

  const capped = entries.length > max;
  const kept = entries.slice(0, max);
  // A condition that reads a name decides it; otherwise every customer gets a name of its own.
  const read = new Set([...project.rules.map((r) => r.when), ...project.nodes.flatMap((n) => [...(n.visibleWhen ? [n.visibleWhen] : []), ...Object.values(n.variantConditions ?? {})])].flatMap((p) => predicatePaths(p)));
  const customers: GeneratedCustomer[] = [];
  const placed = new Map<TestDataTarget, number>();
  const observed = new Map<TestDataTarget, string>();
  const failed = new Set<TestDataTarget>();
  kept.forEach((entry, n) => {
    const { recordId: _id, personaId: _persona, imported: _imported, sourceId: _source, ...rest } = deepClone(entry.record);
    const record: Omit<SyntheticRecord, 'recordId'> = { ...rest, documentType: docType };
    if (!read.has('customer.givenName')) record.customer.givenName = GIVEN[n % GIVEN.length];
    if (!read.has('customer.familyName')) record.customer.familyName = FAMILY[n % FAMILY.length];
    // The record as it will be stored, as issued: no what-if, no journey step.
    const issuedRecord: SyntheticRecord = { ...record, recordId: `TEST-${String(n + 1).padStart(4, '0')}` };
    const res = invalid(issuedRecord) ? null : resolve({ project, record: issuedRecord });
    const ctx = buildContext(issuedRecord);
    const index = customers.length;
    const targets: string[] = [];
    for (const g of entry.goals) {
      if (res && g.check(res)) { placed.set(g.target, index); targets.push(g.target.id); } else failed.add(g.target);
    }
    for (const e of entry.edges) {
      if (res && same(getPath(ctx, e.path), e.value)) {
        placed.set(e.target, index);
        targets.push(e.target.id);
        observed.set(e.target, [...new Set(e.readers.map((o) => o.observe(res)))].slice(0, 3).join('; '));
      } else failed.add(e.target);
    }
    if (targets.length) customers.push({ record, label: entry.label, targets });
  });

  const dropped = new Set(entries.slice(max).flatMap((x) => [...x.goals.map((g) => g.target.id), ...x.edges.map((e) => e.target.id)]));
  const finish = (target: TestDataTarget, why: () => string): TestDataTarget => {
    const at = placed.get(target);
    if (at !== undefined) return { ...target, customer: at, ...(observed.has(target) ? { observed: observed.get(target) } : {}) };
    if (dropped.has(target.id)) return { ...target, customer: null, reason: `Left out: the limit of ${max} ${max === 1 ? 'customer' : 'customers'} was reached.` };
    return { ...target, customer: null, reason: failed.has(target) ? 'The customer built for it did not reach it when the finished record was checked.' : why() };
  };
  const outcomeTargets = goals.map((g) => finish(g.target, g.why));
  const edgeTargets = edges.map((e) => finish(e.target, () => edgeReasons.get(e) ?? LIMIT));
  const targets = [...outcomeTargets, ...edgeTargets];
  const count = (list: TestDataTarget[]): { total: number; reached: number } => ({ total: list.length, reached: list.filter((t) => t.customer !== null).length });
  return {
    customers, targets,
    summary: { outcomes: count(outcomeTargets), edges: count(edgeTargets), unreachable: targets.filter((t) => t.customer === null && !dropped.has(t.id)).length, capped },
  };
}
