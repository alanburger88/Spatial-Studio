import {
  addDaysToIso, buildContext, canonicalJson, customFieldDefs, dateBoundaries, deepClone, deepPatch, exprChildren, exprDependencies, getPath, isIsoDay, languageName, projectFieldIndex, projectFields, projectLanguages,
  SOURCE_LANGUAGE, validateRecordShape, type Expr,
  type DocNode, type FieldDef, type Predicate, type Project, type Rule, type Scalar, type SyntheticRecord,
} from '@iss/model';
import { predicatePaths, resolve, type Resolution } from '@iss/resolver';
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

const { Env, targetsOf, dnf, holds, shiftDay, show, contradiction, treeOf, stepLabel, blockingKey, listOf, q, and, or, not, TRUE } = coverageKit;
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
function sampleRows(f: Pick<FieldDef, 'path' | 'itemFields' | 'innerLists'>, fields: Map<string, FieldDef>, count = 3): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, k) => k + 1).map((n) => {
    const row = Object.fromEntries((f.itemFields ?? []).map((it) => {
      // A claim row shares its allowed values with the single-claim field of the same name.
      const twin = f.path === 'claims' ? fields.get(`claim.${it.key}`) : undefined;
      const value = it.type === 'string' ? `Sample ${plain(it.label).toLowerCase()} ${n}`
        : it.type === 'date' ? shiftDay(FIRST_DATE, n - 1)
        : fallbackValue({ type: it.type, label: it.label, enumValues: twin?.enumValues }, 0);
      return [it.key, value];
    }));
    // Richer data shapes (wave 5): a group in the row is an object of its fields; a list inside the row gets one row,
    // none and four rows in the first three items (none, one and many).
    if (!f.innerLists && !(f.itemFields ?? []).some((it) => it.key.includes('.'))) return row;
    const shaped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) setField(shaped, key, value);
    for (const inner of f.innerLists ?? []) shaped[inner.key] = sampleRows({ path: `${f.path}[].${inner.key}`, itemFields: inner.itemFields }, fields, [1, 0, 4][(n - 1) % 3]);
    return shaped;
  });
}

/**
 * A starting record that is complete for the project's data contract. Without a source record every field is filled (a
 * document that has no samples yet); with one, only what the contract requires and the record lacks. The preferred
 * language is English unless it is one of the project's languages.
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

/**
 * One complete customer built from the project's field definitions alone: every field filled in, English, three rows in
 * every list. What a project with no customers of its own can always be previewed with (a document with its own data
 * has no shared sample customers to fall back on). Pure and deterministic.
 */
export function baselineCustomer(project: Project): GeneratedCustomer {
  const locales = [...new Set([SOURCE_LANGUAGE, ...projectLanguages(project)])];
  const { recordId: _id, ...rest } = completed(project, null, locales);
  const record: Omit<SyntheticRecord, 'recordId'> = { ...rest, documentType: project.documentType, customer: { ...rest.customer, givenName: GIVEN[0], familyName: FAMILY[0] } };
  return { record, label: 'Starting customer: every field filled in', targets: [] };
}

/* ------------------------------------------------------------------ conditions */

interface Leaf { node: Predicate; path: string; op: string; values: Scalar[] }

function leavesOf(p: Predicate, out: Leaf[] = []): Leaf[] {
  switch (p.op) {
    case 'and': case 'or': p.args.forEach((a) => leavesOf(a, out)); break;
    case 'not': leavesOf(p.arg, out); break;
    case 'isNull': case 'notNull': out.push({ node: p, path: p.path, op: p.op, values: [] }); break;
    case 'in': out.push({ node: p, path: p.path, op: p.op, values: Array.isArray(p.value) ? p.value : [] }); break;
    // A condition about the items of a list (wave 5) is reached by the coverage search, not by threshold values.
    case 'items': break;
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
  /** Every condition that reads this value, with the comparison that does. The first one sets the scene. */
  readers: Array<{ owner: Owner; leaf: Predicate }>;
  /** The path that is set (a list's row count for an empty list). */
  path: string;
  value: unknown;
  /** Set when no customer can be built at all. */
  never?: string;
  /** Per level of `scenes`: the combinations of other conditions a customer for this value should satisfy. */
  scenes?: CoverageConj[][];
}

interface Built { record: SyntheticRecord; res: Resolution; changes: number; /** The document's date it was reached on (given for the run). */ issueDate?: string | null }

interface Entry {
  issueDate: string | null;
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
  // The document's date: the "as issued on" day asked for; for a document whose date is given for each run, the day
  // before its first boundary (or a fixed day) when none is asked for. Documents without dates have none.
  const boundaryDays = project.documentDate ? dateBoundaries(project).map((b) => b.date) : [];
  const baseDate: string | null = !project.documentDate ? null
    : opts.issueDate && isIsoDay(opts.issueDate) ? opts.issueDate
    : project.documentDate.source === 'run' ? (boundaryDays[0] ? addDaysToIso(boundaryDays[0], -1) : FIRST_DATE) : null;
  const env: CoverageEnv = new Env(issued, bases, SEARCH_WIDTH, baseDate);
  let journeyEnv: CoverageEnv | null = null;

  /** Why this record cannot be a customer (the first problem the customer import would report, or a language the project does not have), or null. */
  const invalid = (record: SyntheticRecord): string | null => {
    const errors = validateRecordShape(deepClone(record), docType, extra);
    if (errors.length) return `The customer data contract does not accept it: ${withoutPaths(errors[0])}`;
    return locales.includes(record.customer.locale) ? null : `${languageName(record.customer.locale)} is not a language of this project, so no customer is given it as preferred language.`;
  };
  const resolutions = new Map<string, Resolution>();
  const resolved = (record: SyntheticRecord, issueDate: string | null = baseDate): Resolution => {
    const key = `${issueDate ?? ''}|${canonicalJson(record)}`;
    let res = resolutions.get(key);
    if (!res) { res = resolve({ project: issued, record, ...(issueDate ? { issueDate } : {}) }); resolutions.set(key, res); }
    return res;
  };
  const baseBlocked = bases.map((record, i) => {
    const res = resolved(record);
    env.baseBlocking[i] = new Set(res.findings.filter((f) => f.severity === 'blocking').map(blockingKey));
    return env.baseBlocking[i].size > 0;
  });

  const kit = targetsOf(project, { matched: new Set(), selected: new Set(), shown: new Set() });
  const { rules, nodeTitle, partTitle, ruleTitle } = kit;

  /* --- reasons */
  const calculated = (preds: Predicate[]): string | null => {
    for (const path of preds.flatMap((p) => predicatePaths(p))) {
      const f = fields.get(path);
      if (f?.calculated) return `It depends on the calculation ${q(plain(f.label))}. No change to the fields it is worked out from${project.documentDate ? ', or to the document’s date,' : ''} reached it within the search limit.`;
      if (f?.documentDate) return 'It depends on the document’s date, and no date that was tried reached it.';
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

  /**
   * A changed value can break something the document checks about the data: a balance (new balance = previous +
   * purchases − payments + fees) or two fields that must agree (missed payments on an account that is "current").
   * When a built record has a blocking issue its starting customer did not have, one neighbouring field is adjusted (an
   * amount by the same difference, or another allowed value of a choice or yes/no) and the first variant the resolver
   * accepts without a blocking issue, and that still reaches the target, is used instead.
   */
  const settle = (base: number, built: Built, changes: Change[], keeps: (record: SyntheticRecord, res: Resolution) => boolean): Built => {
    if (!isBlocking(built.res) || base < 0 || baseBlocked[base]) return built;
    const before = env.baseCtx(base);
    const now = buildContext(built.record);
    const touched = new Set(changes.map(([path]) => path));
    for (const amounts of [true, false]) {
      for (const [path, value] of changes) {
        const old = getPath(before, path) as unknown;
        const delta = fields.get(path)?.type === 'cents' && typeof value === 'number' && typeof old === 'number' ? value - old : 0;
        const group = path.slice(0, path.lastIndexOf('.') + 1);
        for (const near of fields.values()) {
          if (near.derived || touched.has(near.path) || !near.path.startsWith(group) || near.path.slice(group.length).includes('.')) continue;
          const cur = getPath(now, near.path) as unknown;
          const options: unknown[] = amounts ? (near.type === 'cents' && delta && typeof cur === 'number' ? [cur + delta, cur - delta] : [])
            : near.type === 'enum' ? (near.enumValues ?? []).filter((v) => v !== cur)
            : near.type === 'bool' && typeof cur === 'boolean' ? [!cur] : [];
          for (const option of options) {
            const record = deepClone(built.record);
            setField(record as unknown as Record<string, unknown>, near.path, option);
            if (invalid(record)) continue;
            const res = resolved(record);
            if (!isBlocking(res) && keeps(record, res)) return { record, res, changes: built.changes + 1 };
          }
        }
      }
    }
    return built;
  };

  /* ------------------------------------------------------------------ outcomes */

  /** The coverage search, accepting only records the customer import would accept. */
  const attempt = (alts: Predicate[], reached: (res: Resolution) => boolean): { built: Built | null; satisfiable: boolean; rejected: string | null } => {
    let rejected: string | null = null;
    const found = env.search(alts, (res) => {
      if (!reached(res)) return false;
      const problem = invalid(res.effectiveRecord);
      if (problem) { rejected ??= problem; return false; }
      return true;
    });
    const hit = found.hit;
    const built = hit ? settle(bases.indexOf(hit.record), { record: hit.res.effectiveRecord, res: hit.res, changes: hit.changes.length }, hit.changes, (_, res) => reached(res)) : null;
    return { built, satisfiable: found.satisfiable, rejected };
  };

  const goals: Goal[] = [];
  const goal = (g: Omit<Goal, 'check' | 'why'>): void => { goals.push({ ...g, check: g.reached, why: () => LIMIT }); };
  const reasonFor = (g: Goal, strong: ReturnType<typeof attempt>, weak: ReturnType<typeof attempt> | null): string => {
    if (g.target.kind === 'variant' && weak?.built) return 'The rule that selects this message can match, but another rule or an earlier condition always takes precedence, so the message is never chosen.';
    if (strong.rejected || weak?.rejected) {
      if (g.target.kind === 'language') {
        const allowed = (fields.get('customer.locale')?.enumValues ?? []).map(languageName);
        return `A customer record can only name ${listOf(allowed)} as the preferred language, and no rule switches a document to ${languageName(g.target.targetId)}.`;
      }
      return `No valid customer record reaches it. ${strong.rejected ?? weak?.rejected}`;
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

  /* ------------------------------------------------------------------ calculated fields and dates */

  /**
   * A target that depends on a calculated value or on the document's date cannot be reached by setting one field: the
   * value is worked out. So the inputs of the calculations it reads are varied (one, then two at a time), with values
   * taken from the thresholds the conditions and calculations use, and so is the "as issued on" date (each boundary and
   * the day before). Bounded; the first valid customer the resolver confirms wins, one without a blocking issue first.
   */
  const calcByKey = new Map((project.calculatedFields ?? []).map((c) => [c.key, c]));
  const hasPeriods = boundaryDays.length > 0;
  const depthPaths = (alts: Predicate[]): { inputs: string[]; dated: boolean } | null => {
    const paths = alts.flatMap((p) => predicatePaths(p));
    const seen = new Set<string>();
    const inputs = new Set<string>();
    let dated = hasPeriods;
    const visit = (path: string): void => {
      if (seen.has(path)) return;
      seen.add(path);
      if (path === 'document.date') { dated = true; return; }
      if (path.startsWith('calc.')) {
        const c = calcByKey.get(path.slice(5));
        if (!c) return;
        const d = exprDependencies(c.expr);
        if (d.usesIssueDate) dated = true;
        d.fields.forEach(visit); d.lists.forEach((l) => inputs.add(`${l}.count`)); d.calcs.forEach((k) => visit(`calc.${k}`));
        return;
      }
      const f = fields.get(path);
      if (f && !f.derived && f.type !== 'array' && path !== 'documentType' && path !== 'recordId') inputs.add(path);
    };
    const touchesDepth = paths.some((x) => x.startsWith('calc.') || x === 'document.date');
    if (!touchesDepth && !hasPeriods) return null;
    paths.forEach(visit);
    return { inputs: [...inputs], dated };
  };
  const numbersIn = (alts: Predicate[]): number[] => {
    const out = new Set<number>();
    const fromPred = (p: Predicate): void => {
      if (p.op === 'and' || p.op === 'or') p.args.forEach(fromPred);
      else if (p.op === 'not') fromPred(p.arg);
      else if (p.op === 'in') { for (const v of p.value) if (typeof v === 'number') out.add(v); } else { const v = (p as { value?: unknown }).value; if (typeof v === 'number') out.add(v); }
    };
    const fromExpr = (e: Expr): void => { if (e.op === 'number') out.add(e.value); if (e.op === 'money') out.add(e.cents); if (e.op === 'if') fromPred(e.when); exprChildren(e).forEach(([, c]) => fromExpr(c)); };
    alts.forEach(fromPred);
    for (const c of calcByKey.values()) fromExpr(c.expr);
    return [...out].filter((n) => Number.isFinite(n) && Math.abs(n) < 1e7).slice(0, 12);
  };
  const depthSearch = (g: Goal): Built | null => {
    const depth = depthPaths([...g.alts, ...(g.weak?.alts ?? [])]);
    if (!depth) return null;
    const K = numbersIn(g.alts);
    const days = depth.dated ? [...new Set([...(baseDate ? [baseDate] : []), ...boundaryDays.flatMap((d) => [addDaysToIso(d, -1), d])])].sort() : [baseDate];
    const dayList = days.length ? days : [FIRST_DATE];
    const valuesFor = (path: string): unknown[] => {
      const f = fields.get(path);
      if (path.endsWith('.count')) return [0, 1, 2, 3, 4, ...K.filter((k) => Number.isInteger(k) && k >= 0 && k <= 50).flatMap((k) => [k, k + 1])];
      if (!f) return [];
      const ints = [0, 1, 2, ...K.filter(Number.isInteger).flatMap((k) => [k - 1, k, k + 1])];
      switch (f.type) {
        case 'enum': return f.enumValues ?? [];
        case 'bool': return [true, false];
        case 'int': case 'points': return [...new Set(ints.filter((n) => n >= 0))];
        case 'cents': return [...new Set([...ints, 100, 1000, 10000])];
        case 'date': {
          const around = dayList.filter((d): d is string => !!d);
          const shifts = [0, 1, -1, ...K.filter(Number.isInteger).flatMap((k) => [k, k - 1, k + 1, -k])];
          return [...new Set(around.flatMap((d) => shifts.filter((k) => Math.abs(k) < 4000).map((k) => addDaysToIso(d, k))))].slice(0, 40);
        }
        default: return [];
      }
    };
    const options = depth.inputs.map((path) => ({ path, values: valuesFor(path).slice(0, 40) })).filter((o) => o.values.length);
    const runDay = (d: string | null | undefined): string | null => (project.documentDate?.source === 'run' || (opts.issueDate && project.documentDate) ? d ?? baseDate : null);
    let budget = 900;
    let fallback: Built | null = null;
    const tryRecord = (record: SyntheticRecord, day: string | null, changes: number): Built | null => {
      if (budget-- <= 0) return null;
      if (invalid(record)) return null;
      const res = resolved(record, day);
      if (!g.reached(res)) return null;
      const built: Built = { record, res, changes, issueDate: day };
      if (!isBlocking(res)) return built;
      fallback ??= built;
      return null;
    };
    const withChange = (base: SyntheticRecord, path: string, value: unknown): SyntheticRecord => {
      const record = deepClone(base);
      if (path.endsWith('.count')) {
        const list = path.slice(0, -6);
        const f = fields.get(list);
        const cur = (getPath(record, list) as unknown[] | null) ?? [];
        const rows = Array.from({ length: value as number }, (_, i) => deepClone(cur[i % Math.max(1, cur.length)] ?? sampleRows(f!, fields)[0]));
        setField(record as unknown as Record<string, unknown>, list, rows);
      } else setField(record as unknown as Record<string, unknown>, path, value);
      return record;
    };
    // A document that takes its date from a field gets each day through that field; otherwise it is given for the run.
    const dateField = depth.dated && project.documentDate?.source === 'field' && !opts.issueDate ? project.documentDate.path : null;
    const onDay = (b: SyntheticRecord, d: string | null | undefined): SyntheticRecord => (dateField && d ? withChange(b, dateField, d) : b);
    for (const d of dayList) {
      const day = runDay(d);
      for (const base0 of bases.slice(0, SEARCH_WIDTH)) {
        const base = onDay(base0, d);
        const hit = tryRecord(base, day, 0);
        if (hit) return hit;
        for (const o of options) for (const v of o.values) { const h = tryRecord(withChange(base, o.path, v), day, 1); if (h) return h; if (budget <= 0) return fallback; }
      }
    }
    for (const d of dayList) {
      const day = runDay(d);
      for (const base0 of bases.slice(0, 3)) {
        const base = onDay(base0, d);
        for (let i = 0; i < options.length; i++) for (let j = i + 1; j < options.length; j++) {
          for (const v of options[i].values) for (const w of options[j].values) {
            const h = tryRecord(withChange(withChange(base, options[i].path, v), options[j].path, w), day, 2);
            if (h) return h;
            if (budget <= 0) return fallback;
          }
        }
      }
    }
    return fallback;
  };

  /* one candidate customer per target, then the fewest candidates that cover everything */
  interface Candidate extends Built { covers: number[] }
  const candidates = new Map<string, Candidate>();
  goals.forEach((g) => {
    if (g.never) { const never = g.never; g.why = () => never; return; }
    const strong = attempt(g.alts, g.reached);
    let found = strong;
    let weak: ReturnType<typeof attempt> | null = null;
    if (!strong.built && g.weak) {
      weak = attempt(g.weak.alts, g.weak.reached);
      if (weak.built && g.weak.accept) { found = weak; g.check = g.weak.reached; }
    }
    let built: Built | null = found.built;
    if (!built && (calcByKey.size || project.documentDate)) built = depthSearch(g);
    if (!built) { g.why = () => reasonFor(g, strong, weak); return; }
    const key = `${built.issueDate ?? baseDate ?? ''}|${canonicalJson(built.record)}`;
    if (!candidates.has(key)) candidates.set(key, { ...built, covers: [] });
  });
  const pool = [...candidates.values()];
  for (const c of pool) c.covers = goals.flatMap((g, i) => (!g.never && g.check(c.res) ? [i] : []));

  const entries: Entry[] = [];
  const open = new Set(pool.flatMap((c) => c.covers));
  // Customers without a blocking issue first; one with an issue only for what nothing else reaches.
  for (const blocked of [false, true]) {
    const unused = new Set(pool.flatMap((c, i) => (isBlocking(c.res) === blocked ? [i] : [])));
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
      entries.push({ issueDate: c.issueDate ?? baseDate, record: c.record, ctx: buildContext(c.record), blocked, changes: c.changes, label: first.label, goals: mine, edges: [] });
    }
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
  const edgeById = new Map<string, Edge>();
  const readers = new Map<string, Edge['readers']>();
  const say = (f: FieldDef, v: unknown): string => (f.path === 'customer.locale' && typeof v === 'string' ? languageName(v) : show(f, v));
  for (const owner of owners) {
    for (const leaf of leavesOf(owner.pred)) {
      const f = fields.get(leaf.path);
      if (!f || leaf.path === 'documentType' || leaf.path === 'recordId') continue;
      const reader = { owner, leaf: leaf.node };
      if (!readers.get(leaf.path)?.some((r) => r.owner === owner)) readers.set(leaf.path, [...(readers.get(leaf.path) ?? []), reader]);
      // The same value of the same field is one target, whoever reads it.
      const add = (suffix: string, title: string, value: unknown, never?: string): void => {
        const id = `edge:${leaf.path}:${suffix}`;
        const known = edgeById.get(id);
        if (known) { if (!known.readers.some((r) => r.owner === owner)) known.readers.push(reader); return; }
        const calc = f.derived && !env.overridable(leaf.path) ? `${plain(f.label)} is calculated from other fields and cannot be set on a customer.` : undefined;
        const edge: Edge = { target: { id, kind: 'edge', targetId: leaf.path, title, customer: null }, readers: [reader], path: leaf.path, value, never: never ?? calc };
        edgeById.set(id, edge);
        edges.push(edge);
      };
      const name = plain(f.label);
      const counted = f.type === 'int' || f.type === 'points';
      const below0 = (x: number): string | undefined => (counted && x < 0 ? `${name} cannot be less than 0.` : undefined);
      for (const v of leaf.values) {
        if (v === null) continue;
        if (leaf.op !== 'in' && NUMERIC.has(f.type) && typeof v === 'number' && Number.isInteger(v)) {
          add(`below:${v}`, `${name} just below ${say(f, v)}`, v - 1, counted && v - 1 < 0 ? `${name} cannot be less than 0, so there is no value just below ${say(f, v)}.` : undefined);
          add(`on:${v}`, `${name} exactly ${say(f, v)}`, v, below0(v));
          add(`above:${v}`, `${name} just above ${say(f, v)}`, v + 1, below0(v + 1));
        } else if (leaf.op !== 'in' && f.type === 'date' && typeof v === 'string' && shiftDay(v, 0)) {
          add(`below:${v}`, `${name} just before ${say(f, v)}`, shiftDay(v, -1));
          add(`on:${v}`, `${name} exactly ${say(f, v)}`, shiftDay(v, 0));
          add(`above:${v}`, `${name} just after ${say(f, v)}`, shiftDay(v, 1));
        } else if (f.type === 'bool' || typeof v === 'boolean') {
          for (const b of [true, false]) add(`is:${b}`, `${name} is ${say(f, b)}`, b);
        } else add(`is:${String(v)}`, `${name} is ${say(f, v)}`, v);
      }
    }
  }
  // One customer with each optional field a condition reads left empty (a list: no rows).
  for (const [path, who] of readers) {
    const f = fields.get(path)!;
    const list = f.type === 'array' ? f : path.endsWith('.count') ? fields.get(path.slice(0, -6)) : undefined;
    const subject = list?.type === 'array' ? list : f;
    const isList = subject.type === 'array';
    const id = `empty:${subject.path}`;
    if (subject.required || edgeById.has(id)) continue;
    const never = !isList && f.derived ? `${plain(f.label)} is calculated from other fields, so it cannot be left empty on a customer.` : undefined;
    const edge: Edge = {
      target: { id, kind: 'empty', targetId: subject.path, title: `${plain(subject.label)} is ${show(subject, isList ? [] : null)}`, customer: null },
      readers: who, path: isList ? `${subject.path}.count` : path, value: isList ? 0 : null, never,
    };
    edgeById.set(id, edge);
    edges.push(edge);
  }

  /** Combinations of the other conditions, without anything they say about the field that is being set. */
  const contexts = (pred: Predicate, path: string): CoverageConj[] => {
    const out: CoverageConj[] = [];
    const seen = new Set<string>();
    for (const conj of dnf(pred, false, () => true)) {
      const rest = conj.filter((l) => l.path !== path);
      const key = JSON.stringify(rest);
      if (seen.has(key) || !env.satisfiable(rest)) continue;
      seen.add(key);
      out.push(rest);
      if (out.length >= SEARCH_WIDTH) break;
    }
    return out;
  };
  /**
   * What should hold around the value, best first: for every condition that reads it, the other conditions hold (so the
   * value decides) and no rival overrules; then the same without the rivals; then for the first reader only; then anything.
   */
  const scenesOf = (e: Edge): CoverageConj[][] => {
    const parts = e.readers.map(({ owner, leaf }) => {
      const yes = replaced(owner.pred, leaf, TRUE);
      const no = replaced(owner.pred, leaf, FALSE);
      return { decisive: or([and([yes, not(no)]), and([not(yes), no])]), quiet: owner.rivals.map(not) };
    });
    const preds = [
      and([...parts.map((p) => p.decisive), ...parts.flatMap((p) => p.quiet)]), and(parts.map((p) => p.decisive)),
      and([parts[0].decisive, ...parts[0].quiet]), parts[0].decisive, TRUE,
    ];
    const seen = new Set<string>();
    return preds.filter((p) => { const key = JSON.stringify(p); if (seen.has(key)) return false; seen.add(key); return true; }).map((p) => contexts(p, e.path));
  };

  const build = (e: Edge): (Built & { level: number }) | { reason: string } => {
    const scenes = (e.scenes ??= scenesOf(e));
    let rejected: string | null = null;
    for (let level = 0; level < scenes.length; level++) {
      const options: Array<{ i: number; changes: Change[]; distance: number }> = [];
      bases.forEach((_, i) => {
        const ctx = env.baseCtx(i);
        let plan: Change[] | null = null;
        for (const conj of scenes[level]) { const p = env.plan(conj, ctx); if (p && (!plan || p.length < plan.length)) plan = p; }
        if (!plan) return;
        const cur = getPath(ctx, e.path) as unknown;
        const distance = typeof cur === 'number' && typeof e.value === 'number' ? Math.abs(cur - e.value) : 0;
        options.push({ i, changes: same(cur, e.value) ? plan : [...plan, [e.path, e.value]], distance });
      });
      // Fewest changes; then the customer whose own value is nearest (the rest of its data tends to fit); then one without issues.
      options.sort((a, b) => a.changes.length - b.changes.length || a.distance - b.distance || Number(baseBlocked[a.i]) - Number(baseBlocked[b.i]) || a.i - b.i);
      let fallback: (Built & { level: number }) | null = null;
      let tried = 0;
      for (const o of options) {
        if (tried >= EDGE_TRIES) break;
        const patch = env.toOverrides(bases[o.i], o.changes);
        if (!patch) continue;
        const record = deepPatch(bases[o.i], patch.overrides);
        // The value is there, and what was arranged around it still holds.
        const fitsScene = (r: SyntheticRecord): boolean => { const ctx = buildContext(r); return same(getPath(ctx, e.path), e.value) && scenes[level].some((conj) => conj.every((l) => holds(l, getPath(ctx, l.path)))); };
        if (!same(getPath(buildContext(record), e.path), e.value)) continue;
        const problem = invalid(record);
        if (problem) { rejected ??= problem; continue; }
        tried++;
        const built = { ...settle(o.i, { record, res: resolved(record), changes: o.changes.length }, patch.told, fitsScene), level };
        if (!isBlocking(built.res)) return built;
        fallback ??= built;
      }
      if (fallback) return fallback;
    }
    return { reason: rejected ? `No valid customer record can have this value. ${rejected}` : calculated(e.readers.map((r) => r.owner.pred)) ?? 'No starting customer could be given this value.' };
  };

  const edgeReasons = new Map<Edge, string>();
  for (const e of edges) {
    if (e.never) { edgeReasons.set(e, e.never); continue; }
    const built = build(e);
    const fresh = 'record' in built ? built : null;
    // An existing customer that already has the value, in a setting at least as telling, is the edge customer.
    const fits = (x: Entry): boolean => {
      if (!same(getPath(x.ctx, e.path), e.value)) return false;
      if (!fresh) return true;
      if (x.blocked && !isBlocking(fresh.res)) return false;
      return (e.scenes ?? []).slice(0, fresh.level + 1).some((conjs) => conjs.some((conj) => conj.every((l) => holds(l, getPath(x.ctx, l.path)))));
    };
    const reuse = entries.find((x) => x.issueDate === baseDate && fits(x));
    if (reuse) reuse.edges.push(e);
    else if (fresh) entries.push({ issueDate: baseDate, record: fresh.record, ctx: buildContext(fresh.record), blocked: isBlocking(fresh.res), changes: fresh.changes, label: e.target.title, goals: [], edges: [e] });
    else if ('reason' in built) edgeReasons.set(e, built.reason);
  }

  /* ------------------------------------------------------------------ the plan: cap, names, final check */

  const capped = entries.length > max;
  const kept = entries.slice(0, max);
  // Every customer gets a name of its own, unless a condition reads the name and the customer needs the one it has.
  const read = new Set([...project.rules.map((r) => r.when), ...project.nodes.flatMap((n) => [...(n.visibleWhen ? [n.visibleWhen] : []), ...Object.values(n.variantConditions ?? {})])].flatMap((p) => predicatePaths(p)));
  const readsName = read.has('customer.givenName') || read.has('customer.familyName');
  const customers: GeneratedCustomer[] = [];
  const placed = new Map<TestDataTarget, number>();
  const observed = new Map<TestDataTarget, string>();
  const failed = new Set<TestDataTarget>();
  kept.forEach((entry, n) => {
    /** The finished record, checked as it will be stored and issued: no what-if, no journey step. */
    const finished = (keepReadNames: boolean): { record: Omit<SyntheticRecord, 'recordId'>; goals: Goal[]; edges: Array<[Edge, string]> } => {
      const { recordId: _id, personaId: _persona, imported: _imported, sourceId: _source, ...rest } = deepClone(entry.record);
      const record: Omit<SyntheticRecord, 'recordId'> = { ...rest, documentType: docType };
      if (!(keepReadNames && read.has('customer.givenName'))) record.customer.givenName = GIVEN[n % GIVEN.length];
      if (!(keepReadNames && read.has('customer.familyName'))) record.customer.familyName = FAMILY[n % FAMILY.length];
      const issuedRecord: SyntheticRecord = { ...record, recordId: `TEST-${String(n + 1).padStart(4, '0')}` };
      if (invalid(issuedRecord)) return { record, goals: [], edges: [] };
      const res = resolve({ project, record: issuedRecord, ...(entry.issueDate ? { issueDate: entry.issueDate } : {}) });
      const ctx = buildContext(issuedRecord);
      return {
        record, goals: entry.goals.filter((g) => g.check(res)),
        edges: entry.edges.filter((e) => same(getPath(ctx, e.path), e.value)).map((e) => [e, [...new Set(e.readers.map((r) => r.owner.observe(res)))].slice(0, 3).join('; ')]),
      };
    };
    let done = finished(false);
    if (readsName && done.goals.length + done.edges.length < entry.goals.length + entry.edges.length) done = finished(true);
    const index = customers.length;
    for (const g of entry.goals) { if (done.goals.includes(g)) placed.set(g.target, index); else failed.add(g.target); }
    for (const e of entry.edges) {
      const seen = done.edges.find(([x]) => x === e);
      if (seen) { placed.set(e.target, index); observed.set(e.target, seen[1]); } else failed.add(e.target);
    }
    const targets = [...done.goals.map((g) => g.target.id), ...done.edges.map(([e]) => e.target.id)];
    if (targets.length) customers.push({ record: done.record, label: entry.label, targets, ...(entry.issueDate && project.documentDate ? { issueDate: entry.issueDate } : {}) });
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
