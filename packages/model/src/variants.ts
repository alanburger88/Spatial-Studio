import { canonicalJson, digestOf } from './digest';
import { projectContentDigest } from './commands';
import { richToPlain } from './rich';
import { diffProjects, layoutText, type ProjectDiff } from './diff';
import { allFieldIndex } from './fields';
import { itemsLead } from './shapes';
import { languageName, SOURCE_LANGUAGE } from './languages';
import { translatableStrings } from './strings';
import { validateRule } from './validate';
import { VARIANT_LOCKED_KEYS, variantLockProblem } from './variantLock';
import type { DocNode, Predicate, Project, Rule, RuleAction, VariantOf, VariantPurpose } from './types';

/**
 * Variants by brand or region (wave 5, section 1). Pure functions only: no store, no clock, no network.
 *
 *  - `compareWithBase(base, variant)`: what differs (the variant against the base at the version it follows).
 *  - `diffProjects(baseThen, baseNow)` (from `diff.ts`): what the base has changed since.
 *  - `mergeVariantUpdate({ ancestor, base, variant })`: the update, a three-way merge (ancestor: the base at the followed
 *    version; theirs: the base now; ours: the variant) giving the new variant and a report in three groups.
 *  - `useBaseAgain(variant, base, differenceId)`: drops one difference.
 *  - `makeVariant(base, …)`: a new variant, an exact copy of the base's saved version that follows it.
 *
 * Everything is compared and merged by structure, not by a list of known fields, so a field added to the project or to
 * a component later is compared and merged like the rest: a list of objects with a unique `id`, `key`, `eventId` or
 * `linkId` is merged item by item; any other object key by key; anything else as one value. Three things are coarser
 * on purpose: a rule is one value (a decision is not half one side's and half the other's), a component's
 * `children` follow the base's order with the variant's own components kept where they were, and the `version`
 * counters of rules and messages are not compared (they are worked out again).
 */

export type VariantGroup = 'brand' | 'wording' | 'rules' | 'sections' | 'tables' | 'other';
export const VARIANT_GROUPS: readonly VariantGroup[] = ['brand', 'wording', 'rules', 'sections', 'tables', 'other'];
export const VARIANT_GROUP_LABEL: Record<VariantGroup, string> = { brand: 'Brand', wording: 'Wording', rules: 'Rules', sections: 'Sections', tables: 'Tables', other: 'Other' };

/** One step of an address in a project: an object key, or an item of a list found by its id (`key` names the id field). */
export type VariantPathStep = string | { id: string; key: string };

/** One difference between a variant and its base. `base`/`variant` are short readable values (null: not there). */
export interface VariantDifference {
  /** Stable address, e.g. `nodes[greeting].content`, `rules[R05]`, `brand.accent`. */
  id: string;
  path: VariantPathStep[];
  group: VariantGroup;
  label: string;
  /** `added`: only in the variant (its own); `removed`: only in the base (hidden or removed in the variant). */
  kind: 'changed' | 'added' | 'removed';
  base: string | null;
  variant: string | null;
  nodeId?: string;
  /** Bookkeeping that follows from another difference (which English a translation was written from): kept, counted and merged, but not listed for people. */
  quiet?: true;
}

export interface CompareOptions {
  /**
   * The variant's copies of the base's own customers (base record id → the variant's record id), for a document with its
   * own data: a pinned test that uses the variant's copy of a customer is the same test.
   */
  customers?: Record<string, string>;
}

/* ------------------------------------------------------------------ structure */

/** Identity and bookkeeping: never a difference. A variant's title is its own name, like its id. */
const IDENTITY = new Set(['projectId', 'title', 'modelVersion', 'lastSavedAt', 'variantOf', 'derivedFrom', 'fromTemplate', 'importedFrom']);
/** A component's properties that are one value even though they are objects (rich text, its place on the page). */
const ATOMIC_PROPS = new Set(['content', 'layout']);
const KEY_FIELDS = ['id', 'key', 'eventId', 'linkId'];
/** Lists of items that are each one value. */
const ATOMIC_ITEMS = new Set(['rules']);
/** Counters bumped on every edit: not differences, worked out again by the merge. */
const COUNTERS: Record<string, string> = { rules: 'version', contentParts: 'version' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** The id field shared by every item of these lists (null: not lists of items with ids). */
function keyField(...lists: unknown[]): string | null {
  const arrays = lists.filter(Array.isArray) as unknown[][];
  if (arrays.length !== lists.filter((l) => l !== undefined).length) return null;
  const full = arrays.filter((a) => a.length);
  if (!full.length) return null;
  for (const k of KEY_FIELDS) {
    if (full.every((a) => a.every((e) => isObj(e) && typeof e[k] === 'string') && new Set(a.map((e) => (e as Obj)[k])).size === a.length)) return k;
  }
  return null;
}
/** Lists of unique ids (children, alternatives, languages…). */
function isIdList(...lists: unknown[]): boolean {
  const defined = lists.filter((l) => l !== undefined);
  return defined.length > 0 && defined.every((a) => Array.isArray(a) && a.every((x) => typeof x === 'string') && new Set(a).size === a.length) && defined.some((a) => (a as unknown[]).length > 0);
}
const stepText = (s: VariantPathStep) => (typeof s === 'string' ? s : `[${s.id}]`);
export const variantPathId = (path: VariantPathStep[]): string => path.map((s, i) => (typeof s === 'string' && i > 0 ? `.${s}` : stepText(s))).join('');
const rootOf = (path: VariantPathStep[]) => (typeof path[0] === 'string' ? path[0] : '');
const strip = (root: string, e: unknown): unknown => {
  const c = COUNTERS[root];
  if (!c || !isObj(e)) return e;
  const { [c]: _v, ...rest } = e;
  return rest;
};
const byKey = (list: unknown, key: string): Map<string, Obj> => new Map(((list as Obj[] | undefined) ?? []).map((e) => [String(e[key]), e]));

/* ------------------------------------------------------------------ words */

const NODE_WORDS: Record<string, string> = {
  content: 'text', label: 'label', name: 'name', caption: 'caption', headerFooter: 'text', action: 'link', qr: 'QR code', explanation: 'explanation',
  fallbackText: 'text when empty', a11y: 'description for screen readers', image: 'image', chart: 'chart', columns: 'columns', layout: 'position and size',
  visibleWhen: 'condition', variantConditions: 'conditions of its alternatives', variantPeriods: 'periods of its alternatives', effective: 'period',
  ruleDriven: 'shown only by a rule', fallbackVariantId: 'alternative shown when no rule applies', variantIds: 'alternatives', children: 'order of its contents',
  binding: 'data field', formatter: 'format', styleId: 'text style', shape: 'shape', totalFrom: 'footer total',
};
const TEXT_PROPS = new Set(['content', 'label', 'caption', 'headerFooter', 'action', 'qr', 'explanation', 'fallbackText', 'a11y', 'image', 'chart', 'columns']);
const COND_PROPS = new Set(['visibleWhen', 'variantConditions', 'variantPeriods', 'effective', 'ruleDriven']);
const SECTION_PROPS = new Set(['variantIds', 'children', 'fallbackVariantId', '#order']);
const BRAND_WORDS: Record<string, string> = { primary: 'main colour', accent: 'accent colour', text: 'text colour', fontFamily: 'font', logoDataUri: 'logo', logoAlt: 'logo description' };
const TOP_WORDS: Record<string, string> = {
  title: 'Document title', channels: 'Email and SMS', glossary: 'Glossary', languages: 'Languages', testCases: 'Pinned test', journey: 'Journey',
  mappings: 'Mapping', wordingRules: 'Wording rule', houseWordingRules: 'House wording rule', libraryLinks: 'Library link', styles: 'Text style',
  accessiblePdfRequired: 'Accessible PDF is required', translationOrigins: 'Who drafted a translation', issuer: 'Issuer', brand: 'Brand',
  customFields: 'Data field', calculatedFields: 'Calculation', documentDate: 'The document’s date', presentationProfiles: 'Page design',
};
const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function groupOf(path: VariantPathStep[]): VariantGroup {
  const root = rootOf(path);
  if (root === 'brand' || root === 'issuer' || root === 'styles') return 'brand';
  if (root === 'rules') return 'rules';
  if (root === 'lookupTables') return 'tables';
  if (['contentParts', 'strings', 'translationOrigins', 'channels', 'glossary', 'languages', 'title', 'wordingRules', 'houseWordingRules'].includes(root)) return 'wording';
  if (root === 'nodes') {
    const prop = path[2];
    if (prop === undefined || typeof prop !== 'string') return 'sections';
    if (TEXT_PROPS.has(prop)) return 'wording';
    if (COND_PROPS.has(prop)) return 'rules';
    if (SECTION_PROPS.has(prop)) return 'sections';
    return 'other';
  }
  return 'other';
}

/** Names of things, looked up in any of the projects given (the variant first). */
class Namer {
  private strings: Map<string, string> | null = null;
  constructor(private projects: Project[]) {}
  node(id: string) { for (const p of this.projects) { const n = p.nodes.find((x) => x.id === id); if (n) return n.name ?? n.label ?? n.id; } return id; }
  part(id: string) { for (const p of this.projects) { const c = p.contentParts.find((x) => x.id === id); if (c) return c.title; } return id; }
  rule(id: string) { for (const p of this.projects) { const r = p.rules.find((x) => x.id === id); if (r) return r.title ? `Rule ${id} “${r.title}”` : `Rule ${id}`; } return `Rule ${id}`; }
  /** The value columns of a lookup table that hold money (in cents). */
  moneyColumns(id: string): Set<string> { for (const p of this.projects) { const t = p.lookupTables?.find((x) => x.id === id); if (t) return new Set(t.columns.filter((c) => c.type === 'money').map((c) => c.key)); } return new Set(); }
  table(id: string) { for (const p of this.projects) { const t = p.lookupTables?.find((x) => x.id === id); if (t) return t.title; } return id; }
  link(id: string) { for (const p of this.projects) { const l = p.libraryLinks?.find((x) => x.linkId === id); if (l) return `“${l.title}”`; } return id; }
  test(id: string) { for (const p of this.projects) { const t = p.testCases?.find((x) => x.id === id); if (t) return `${id} “${t.name}”`; } return id; }
  private fields: Map<string, string> | null = null;
  /** The name people use for a data field or calculation (its label), not its path. */
  field(path: string) {
    if (!this.fields) { this.fields = new Map(); for (const p of [...this.projects].reverse()) for (const [k, f] of allFieldIndex(p)) if (f.label) this.fields.set(k, f.label); }
    return this.fields.get(path) ?? humanize(path.split('.').slice(-1)[0].replace(/\[\]$/, ''));
  }
  /** Wording as a person reads it: bold marks left out, a placeholder shown as the field's name in square brackets. */
  words(s: string) { return s.replace(/\*\*/g, '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, path: string) => `[${this.field(path)}]`); }
  text(id: string) {
    if (!this.strings) { this.strings = new Map(); for (const p of [...this.projects].reverse()) for (const s of translatableStrings(p)) this.strings.set(s.id, s.title); }
    return this.strings.get(id) ?? id;
  }
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const scalarWords = (v: unknown) => (v === true ? 'yes' : v === false ? 'no' : v === null || v === undefined ? 'empty' : typeof v === 'string' ? `“${v}”` : String(v));
/** A condition in plain words, with the fields' names: "Change in use is at least 25". */
function conditionWords(p: Predicate | undefined, names: Namer): string {
  if (!p) return 'always';
  switch (p.op) {
    case 'and': return p.args.length ? p.args.map((a) => (a.op === 'or' ? `(${conditionWords(a, names)})` : conditionWords(a, names))).join(' and ') : 'always';
    case 'or': return p.args.length ? p.args.map((a) => (a.op === 'and' ? `(${conditionWords(a, names)})` : conditionWords(a, names))).join(' or ') : 'never';
    case 'not': return `it is not true that ${conditionWords(p.arg, names)}`;
    case 'items': return `${itemsLead(p.match, p.count, names.field(p.path))} ${conditionWords(p.where, names)}`;
    case 'isNull': return `${names.field(p.path)} is empty`;
    case 'notNull': return `${names.field(p.path)} has a value`;
    case 'in': return `${names.field(p.path)} is one of ${p.value.map(scalarWords).join(', ')}`;
    default: {
      const words: Record<string, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };
      return `${names.field(p.path)} ${words[p.op]} ${scalarWords(p.value)}`;
    }
  }
}
function actionWords(a: RuleAction, names: Namer): string {
  switch (a.op) {
    case 'selectVariant': return `show “${names.part(a.variantId)}” in ${names.node(a.targetNodeId)}`;
    case 'showSection': return `show the section “${names.node(a.targetNodeId)}”`;
    case 'requireNodes': return `always include ${a.nodeIds.map((id) => `“${names.node(id)}”`).join(', ')}`;
    case 'setApprovedLocale': return `use the approved ${languageName(a.locale)} wording`;
    case 'setPresentationHint': return `apply the presentation “${humanize(a.hint)}”`;
  }
}
function ruleText(r: Rule, names: Namer): string {
  return `${r.enabled === false ? 'Switched off. ' : ''}When ${conditionWords(r.when, names)}: ${actionWords(r.then, names)}${r.effective ? ` (${r.effective.from ? `from ${r.effective.from}` : ''}${r.effective.from && r.effective.until ? ' ' : ''}${r.effective.until ? `until ${r.effective.until}` : ''})` : ''}`;
}
/** A table's rows in words. `money` names the value columns held in cents, shown as an amount (15.00, not 1500). */
function rowsText(rows: unknown, money: ReadonlySet<string> = new Set()): string {
  if (!Array.isArray(rows)) return clip(canonicalJson(rows ?? null));
  const cell = (v: unknown) => (isObj(v) ? `${v.from ?? '…'}–${v.until ?? '…'}` : String(v));
  const value = ([k, v]: [string, unknown]) => (money.has(k) && typeof v === 'number' ? (v / 100).toFixed(2) : cell(v));
  return clip(rows.map((r) => (isObj(r) ? `${Object.values((r.keys as Obj) ?? {}).map(cell).join(', ')} → ${Object.entries((r.values as Obj) ?? {}).map(value).join(', ')}` : String(r))).join('; '));
}
/** A value in a few readable words. */
function valueText(path: VariantPathStep[], v: unknown, names: Namer): string | null {
  if (v === undefined || v === null) return null;
  const root = rootOf(path);
  const last = path[path.length - 1];
  // A message's alternatives by their names, not their ids.
  if (root === 'nodes' && (last === 'variantIds' || last === 'fallbackVariantId')) return Array.isArray(v) ? v.map((id) => names.part(String(id))).join(', ') || '(none)' : names.part(String(v));
  // Text in a few words: bold marks (**) are left out so the words read as the customer reads them.
  if (typeof v === 'string') return v.startsWith('data:image/') ? 'an image' : clip(names.words(v));
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
  if (root === 'rules' && isObj(v) && 'when' in v) return ruleText(v as unknown as Rule, names);
  if (root === 'nodes') {
    if (path.length === 2 && isObj(v)) { const n = v as unknown as DocNode; const t = n.content ? names.words(richToPlain(n.content)) : ''; return clip(`${n.name ?? n.id}${t ? `: ${t}` : ''}`); }
    if (last === 'content' && isObj(v)) return clip(names.words(richToPlain(v as never)));
    if (last === 'layout') return layoutText(v as never);
    if (last === 'visibleWhen' || (path[2] === 'variantConditions' && path.length === 4)) return conditionWords(v as never, names);
  }
  if (root === 'contentParts' && path.length === 2 && isObj(v)) return clip(`${v.title}: ${names.words(String(Object.values((v.approvedLocales as Obj) ?? {})[0] ?? ''))}`);
  if (root === 'lookupTables') {
    const money = names.moneyColumns(typeof path[1] === 'object' ? path[1].id : '');
    if (last === 'rows') return rowsText(v, money);
    if (path.length === 2 && isObj(v)) return `${v.title} (${(v.rows as unknown[])?.length ?? 0} rows): ${rowsText(v.rows, money)}`;
  }
  if (root === 'strings' && isObj(v)) {
    // The translations of one text: each language with its words, approved first.
    const parts: string[] = [];
    for (const [kind, word] of [['approved', ''], ['draft', ' (draft)']] as const) for (const [loc, t] of Object.entries((v[kind] as Obj) ?? {})) if (typeof t === 'string') parts.push(`${languageName(loc)}${word}: ${names.words(t)}`);
    if (parts.length) return clip(parts.join(' · '));
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ') || '(none)';
  if (root === 'brand' && isObj(v)) return clip(Object.entries(v).map(([k, x]) => `${BRAND_WORDS[k] ?? humanize(k)} ${typeof x === 'string' && x.startsWith('data:image/') ? 'an image' : String(x)}`).join(', '));
  if (isObj(v) && typeof v.title === 'string') return clip(v.title);
  if (isObj(v) && typeof v.name === 'string') return clip(v.name);
  return clip(canonicalJson(v), 160);
}
/** What a difference is about, in words. */
function labelOf(path: VariantPathStep[], names: Namer): string {
  const root = rootOf(path);
  const item = typeof path[1] === 'object' ? path[1].id : null;
  const rest = path.slice(2).map((s) => (typeof s === 'string' ? s : s.id));
  if (root === 'nodes' && item) {
    const [prop, key] = rest;
    if (prop === undefined) return names.node(item);
    const words = NODE_WORDS[prop] ?? humanize(prop);
    return `${names.node(item)}: ${words}${key ? ` (${prop === 'variantConditions' || prop === 'variantPeriods' ? names.part(key) : humanize(key)})` : ''}`;
  }
  if (root === 'contentParts' && item) {
    const [prop, loc] = rest;
    if (prop === 'approvedLocales' && loc) return `“${names.part(item)}” in ${languageName(loc)}`;
    if (prop === 'draftLocales' && loc) return `“${names.part(item)}”: ${languageName(loc)} draft`;
    if (prop === 'title') return `“${names.part(item)}”: heading`;
    return prop ? `“${names.part(item)}”: ${humanize(prop)}` : `Message “${names.part(item)}”`;
  }
  if (root === 'rules' && item) return names.rule(item);
  if (root === 'lookupTables' && item) {
    const [prop] = rest;
    return `Lookup table “${names.table(item)}”${prop ? `: ${prop === 'rows' ? 'values' : humanize(prop)}` : ''}`;
  }
  if (root === 'strings' && typeof path[1] === 'string') {
    const [kind, loc] = path.slice(2) as string[];
    const what = names.text(path[1]);
    if (kind === 'approved' && loc) return `${what} in ${languageName(loc)}`;
    if (kind === 'draft' && loc) return `${what}: ${languageName(loc)} draft`;
    if (kind === 'basedOn' && loc) return `${what}: the English its ${languageName(loc)} was written from`;
    return what;
  }
  if (root === 'brand' && typeof path[1] === 'string') return `Brand: ${BRAND_WORDS[path[1]] ?? humanize(path[1])}`;
  if (root === 'libraryLinks' && item) return `Library link ${names.link(item)}${rest.length ? `: ${rest.map(humanize).join(' › ')}` : ''}`;
  if (root === 'testCases' && item) return `Pinned test ${names.test(item)}${rest.length ? `: ${rest.map(humanize).join(' › ')}` : ''}`;
  if (root === 'channels') return `${path[1] === 'sms' ? 'SMS' : 'Email'}: ${path.slice(2).map((s) => (typeof s === 'string' ? humanize(s) : s.id)).join(' › ') || 'wording'}`;
  const head = TOP_WORDS[root] ?? humanize(root);
  const tail = path.slice(1).map((s) => (typeof s === 'string' ? (s === '#order' ? 'order' : humanize(s)) : s.id));
  return tail.length ? `${head}: ${tail.join(' › ')}` : head;
}
/** Which English a translation was written from: it follows from the wording differences beside it. */
const isQuiet = (path: VariantPathStep[]) => rootOf(path) === 'strings' && path[2] === 'basedOn';
const nodeOf = (path: VariantPathStep[]) => (rootOf(path) === 'nodes' && typeof path[1] === 'object' ? path[1].id : undefined);

/* ------------------------------------------------------------------ customers of a variant */

function withCustomers(p: Project, map: Record<string, string> | undefined): Project {
  if (!map || !p.testCases?.length || !p.testCases.some((t) => map[t.recordId])) return p;
  return { ...p, testCases: p.testCases.map((t) => (map[t.recordId] ? { ...t, recordId: map[t.recordId] } : t)) };
}

/* ------------------------------------------------------------------ what differs */

/**
 * What differs between `variant` and `base` (the base at the version the variant follows), grouped as design rule 4
 * groups them. Identity and bookkeeping (ids, version numbers, where it came from) are not differences.
 */
export function compareWithBase(base: Project, variant: Project, opts: CompareOptions = {}): VariantDifference[] {
  const b = withCustomers(base, opts.customers);
  const names = new Namer([variant, base]);
  const out: VariantDifference[] = [];
  const emit: Emit = (path, from, to) => {
    const kind = from === undefined ? 'added' : to === undefined ? 'removed' : 'changed';
    const nodeId = nodeOf(path);
    out.push({ id: variantPathId(path), path, group: groupOf(path), label: labelOf(path, names), kind, base: valueText(path, from, names), variant: valueText(path, to, names), ...(nodeId ? { nodeId } : {}), ...(isQuiet(path) ? { quiet: true as const } : {}) });
  };
  for (const k of keysOf(b as unknown as Obj, variant as unknown as Obj)) if (!IDENTITY.has(k)) walk((b as unknown as Obj)[k], (variant as unknown as Obj)[k], [k], emit);
  return out;
}

type Emit = (path: VariantPathStep[], from: unknown, to: unknown) => void;

/** Every difference from `x` to `y` at `path`, at the finest grain the comparison uses. */
function walk(x: unknown, y: unknown, path: VariantPathStep[], emit: Emit): void {
  if (same(x, y)) return;
  const root = rootOf(path);
  const last = path[path.length - 1];
  if (root === 'nodes' && path.length === 3 && typeof last === 'string' && ATOMIC_PROPS.has(last)) { emit(path, x, y); return; }
  // An item of a list by id.
  if (typeof path[path.length - 1] === 'object' && isObj(x) && isObj(y)) {
    const kf = (path[path.length - 1] as { key: string }).key;
    if (ATOMIC_ITEMS.has(root)) { if (!same(strip(root, x), strip(root, y))) emit(path, x, y); return; }
    for (const k of keysOf(x, y)) {
      if (k === kf || k === COUNTERS[root]) continue;
      if (root === 'nodes' && k === 'children') {
        // Children come and go with the components themselves; only a change of order among shared ones is a difference.
        const xs = ((x.children as string[]) ?? []), ys = ((y.children as string[]) ?? []);
        const a = xs.filter((c) => ys.includes(c)), bb = ys.filter((c) => xs.includes(c));
        if (!same(a, bb)) emit([...path, 'children'], a, bb);
        continue;
      }
      const xv = x[k], yv = y[k];
      if (same(xv, yv)) continue;
      if (isObj(xv) && isObj(yv) && !ATOMIC_PROPS.has(k)) { for (const kk of keysOf(xv, yv)) if (!same(xv[kk], yv[kk])) emit([...path, k, kk], xv[kk], yv[kk]); }
      else emit([...path, k], xv, yv);
    }
    return;
  }
  const kf = keyField(x, y);
  if (kf) {
    const xs = x as Obj[] | undefined, ys = y as Obj[] | undefined;
    const X = byKey(xs, kf), Y = byKey(ys, kf);
    for (const [id, e] of Y) walk(X.get(id), e, [...path, { id, key: kf }], emit);
    for (const [id, e] of X) if (!Y.has(id)) emit([...path, { id, key: kf }], e, undefined);
    if (root !== 'nodes') {
      const common = (l: Obj[] | undefined, other: Map<string, Obj>) => (l ?? []).map((e) => String(e[kf])).filter((id) => other.has(id));
      if (!same(common(xs, Y), common(ys, X))) emit([...path, '#order'], common(xs, Y), common(ys, X));
    }
    return;
  }
  if (isObj(x) && isObj(y)) { for (const k of keysOf(x, y)) walk(x[k], y[k], [...path, k], emit); return; }
  emit(path, x, y);
}
const keysOf = (...objs: Array<Obj | undefined>): string[] => [...new Set(objs.flatMap((o) => (o ? Object.keys(o) : [])))];

/** The differences counted per group (for a summary). */
export function differenceCounts(diffs: VariantDifference[]): Record<VariantGroup, number> & { total: number } {
  const c = Object.fromEntries(VARIANT_GROUPS.map((g) => [g, 0])) as Record<VariantGroup, number>;
  for (const d of diffs) c[d.group] += 1;
  return { ...c, total: diffs.length };
}

/** Whether the variant's rules differ from the base's (design rule 6: the base's tests do not prove such a variant). */
export function variantRulesDiffer(base: Project, variant: Project): boolean {
  return compareWithBase(base, variant).some((d) => d.group === 'rules');
}

/* ------------------------------------------------------------------ the update: a three-way merge */

/** One entry of an update report. `baseBefore`: the base at the version followed; `baseNow`: the base now; `yours`: the variant. */
export interface UpdateEntry {
  id: string;
  group: VariantGroup;
  label: string;
  baseBefore: string | null;
  baseNow: string | null;
  yours: string | null;
  /** Why it is in this group, in plain words (kept as yours and needs a look). */
  note?: string;
  nodeId?: string;
  /** What the base did: added it, removed it, or changed it. */
  change: 'added' | 'removed' | 'changed';
}

export interface VariantUpdate {
  /** The variant with the update applied (following the base's newer version). */
  project: Project;
  fromVersion: number;
  toVersion: number;
  /** The base changed something the variant had not touched: it comes in. */
  comesIn: UpdateEntry[];
  /** Both changed the same thing: the variant's value stays; the base's new value is shown beside it. */
  kept: UpdateEntry[];
  /** The base removed or restructured something the variant changed or added to (or the change could not be applied cleanly). */
  needsLook: UpdateEntry[];
  /** What the base changed between the two versions (the same comparison as a version's change summary). */
  baseChanges: ProjectDiff;
}

interface MergeCtx {
  names: Namer;
  comesIn: UpdateEntry[];
  kept: UpdateEntry[];
  needsLook: UpdateEntry[];
  /** Addresses whose value came in from the base (to undo one that turns out not to work). */
  incoming: Set<string>;
}

function entry(ctx: MergeCtx, path: VariantPathStep[], o: unknown, t: unknown, v: unknown, note?: string): UpdateEntry {
  const nodeId = nodeOf(path);
  const change = o === undefined && t !== undefined ? 'added' : t === undefined && o !== undefined ? 'removed' : 'changed';
  return { id: variantPathId(path), group: groupOf(path), label: labelOf(path, ctx.names), baseBefore: valueText(path, o, ctx.names), baseNow: valueText(path, t, ctx.names), yours: valueText(path, v, ctx.names), ...(note ? { note } : {}), ...(nodeId ? { nodeId } : {}), change };
}
/** What the base changed at `path` comes in, reported change by change (the variant's value there is the base's old one, or `v` when given). */
const comeIn = (ctx: MergeCtx, path: VariantPathStep[], o: unknown, t: unknown, v: unknown, note?: string) => {
  walk(o, t, path, (p, a, b) => { ctx.comesIn.push(entry(ctx, p, a, b, same(v, o) ? a : getAt(v, p.slice(path.length)), note)); ctx.incoming.add(variantPathId(p)); });
};
const keep = (ctx: MergeCtx, path: VariantPathStep[], o: unknown, t: unknown, v: unknown, note: string) => { ctx.kept.push(entry(ctx, path, o, t, v, note)); };
const look = (ctx: MergeCtx, path: VariantPathStep[], o: unknown, t: unknown, v: unknown, note: string) => { ctx.needsLook.push(entry(ctx, path, o, t, v, note)); };

const KEPT_BOTH = 'You changed this too, so your value stays. The base’s new value is shown beside it.';
const KEPT_HIDDEN = 'You removed or hid this, so it stays that way. The base changed it.';

/**
 * Merges a list of unique ids: what either side added is in, what either side removed is out. The base's order is
 * the backbone (the variant's, when only the variant reordered); the other side's additions sit after the item they
 * followed. `present` limits the result (for children: the components that are in the merged document).
 */
function mergeIds(o: string[], t: string[], v: string[], present?: (id: string) => boolean): string[] {
  // With `present`, it alone decides what is in (a component the base removed may be kept); otherwise removals win.
  const gone = new Set(present ? [] : [...o.filter((x) => !t.includes(x)), ...o.filter((x) => !v.includes(x))]);
  const all = new Set([...v, ...t, ...o].filter((x) => !gone.has(x) && (!present || present(x))));
  const common = (l: string[]) => l.filter((x) => o.includes(x) && t.includes(x) && v.includes(x));
  const variantReordered = !same(common(o), common(v)) && same(common(o), common(t));
  const [first, second] = variantReordered ? [v, t] : [t, v];
  const out = first.filter((x) => all.has(x));
  const place = (list: string[]) => {
    list.forEach((x, i) => {
      if (!all.has(x) || out.includes(x)) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) { const k = out.indexOf(list[j]); if (k >= 0) { at = k + 1; break; } }
      out.splice(at, 0, x);
    });
  };
  place(second);
  place([...all]);
  return out;
}

/** Three-way merge of one value at `path`. Returns the merged value (undefined: absent). */
function mergeValue(o: unknown, t: unknown, v: unknown, path: VariantPathStep[], ctx: MergeCtx, locked = false): unknown {
  if (locked) {
    if (!same(v, o) && !same(v, t)) look(ctx, path, o, t, v, 'This belongs to the base, so the base’s value is used. Your own change to it is replaced.');
    else if (!same(t, o)) comeIn(ctx, path, o, t, v);
    return clone(t);
  }
  if (same(t, o)) return clone(v);
  if (same(v, o)) { comeIn(ctx, path, o, t, v); return clone(t); }
  if (same(v, t)) return clone(v);
  const kf = keyField(o, t, v);
  if (kf) return mergeItems(o as Obj[] | undefined, t as Obj[] | undefined, v as Obj[] | undefined, kf, path, ctx);
  if (isIdList(o, t, v)) {
    const merged = mergeIds((o as string[]) ?? [], (t as string[]) ?? [], (v as string[]) ?? []);
    comeIn(ctx, path, o, t, v, 'Merged with your own changes to the list.');
    return merged;
  }
  if (isObj(o) && isObj(t) && isObj(v)) return mergeObject(o, t, v, path, ctx);
  if (v === undefined) { keep(ctx, path, o, t, v, KEPT_HIDDEN); return undefined; }
  if (t === undefined) { look(ctx, path, o, t, v, 'The base removed this, but you had changed it. Yours is kept: check whether it still belongs.'); return clone(v); }
  keep(ctx, path, o, t, v, KEPT_BOTH);
  return clone(v);
}

function mergeObject(o: Obj, t: Obj, v: Obj, path: VariantPathStep[], ctx: MergeCtx): Obj {
  const out: Obj = {};
  for (const k of keysOf(v, t, o)) {
    const m = mergeValue(o[k], t[k], v[k], [...path, k], ctx);
    if (m !== undefined) out[k] = m;
  }
  return out;
}

/** One item of a list present on all three sides. */
function mergeItem(o: Obj, t: Obj, v: Obj, path: VariantPathStep[], kf: string, ctx: MergeCtx, lockLayout: boolean): Obj {
  const root = rootOf(path);
  const counter = COUNTERS[root];
  if (ATOMIC_ITEMS.has(root)) {
    const so = strip(root, o), st = strip(root, t), sv = strip(root, v);
    let m: Obj;
    if (same(st, so)) m = clone(v);
    else if (same(sv, so)) { comeIn(ctx, path, o, t, v); m = clone(t); }
    else if (same(sv, st)) m = clone(v);
    else { keep(ctx, path, o, t, v, KEPT_BOTH); m = clone(v); }
    if (counter) m[counter] = Math.max(Number(t[counter]) || 0, Number(v[counter]) || 0);
    return m;
  }
  const out: Obj = {};
  // A message: when you rewrote its English, the base's new translations of it do not come in (they were written for
  // the base's English); when the base rewrote the English under your own translation, your translation needs a look.
  const loc = (x: Obj) => (isObj(x.approvedLocales) ? (x.approvedLocales as Obj) : {});
  const youChangedSource = root === 'contentParts' && !same(loc(v)[SOURCE_LANGUAGE], loc(o)[SOURCE_LANGUAGE]);
  const baseChangedSource = root === 'contentParts' && !same(loc(t)[SOURCE_LANGUAGE], loc(o)[SOURCE_LANGUAGE]);
  for (const k of keysOf(v, t, o)) {
    if (k === counter) continue;
    if (root === 'nodes' && k === 'children') { out.children = v.children ?? t.children; continue; } // worked out afterwards
    const at = [...path, k];
    if (root === 'contentParts' && k === 'approvedLocales' && isObj(o[k]) && isObj(t[k]) && isObj(v[k]) && (youChangedSource || baseChangedSource)) {
      const ol = o[k] as Obj, tl = t[k] as Obj, vl = v[k] as Obj;
      const m: Obj = {};
      for (const l of keysOf(vl, tl, ol)) {
        const lp = [...at, l];
        let val: unknown;
        if (l !== SOURCE_LANGUAGE && youChangedSource && !same(tl[l], ol[l]) && !same(vl[l], tl[l])) { keep(ctx, lp, ol[l], tl[l], vl[l], 'You rewrote the English of this message, so your translation stays. The base’s new translation is shown beside it.'); val = clone(vl[l]); }
        else val = mergeValue(ol[l], tl[l], vl[l], lp, ctx);
        if (l !== SOURCE_LANGUAGE && baseChangedSource && !youChangedSource && !same(vl[l], ol[l]) && same(tl[l], ol[l]) && vl[l] !== undefined) look(ctx, lp, ol[l], tl[l], vl[l], 'The base changed the English of this message. Your translation was written for the old English: check it.');
        if (val !== undefined) m[l] = val;
      }
      out[k] = m;
      continue;
    }
    const lockedHere = lockLayout && k === 'layout';
    const ov = o[k], tv = t[k], vv = v[k];
    let m: unknown;
    if (!lockedHere && !ATOMIC_PROPS.has(k) && !same(tv, ov) && !same(vv, ov) && !same(vv, tv) && isObj(ov) && isObj(tv) && isObj(vv) && keyField(ov, tv, vv) === null) {
      // A component's own settings (a chart, a link, alternatives' conditions): one level, key by key.
      const mm: Obj = {};
      for (const kk of keysOf(vv, tv, ov)) { const x = mergeValue(ov[kk], tv[kk], vv[kk], [...at, kk], ctx); if (x !== undefined) mm[kk] = x; }
      m = mm;
    } else if (!lockedHere && !same(tv, ov) && !same(vv, ov) && !same(vv, tv) && !isIdList(ov, tv, vv)) {
      if (vv === undefined) { keep(ctx, at, ov, tv, vv, KEPT_HIDDEN); m = undefined; }
      else { keep(ctx, at, ov, tv, vv, KEPT_BOTH); m = clone(vv); }
    } else m = mergeValue(ov, tv, vv, at, ctx, lockedHere);
    if (m !== undefined) out[k] = m;
  }
  if (counter) {
    const sv = strip(root, v), st = strip(root, t), sm = strip(root, out);
    const top = Math.max(Number(t[counter]) || 0, Number(v[counter]) || 0);
    out[counter] = same(sm, sv) || same(sm, st) ? top : top + 1;
  }
  out[kf] = v[kf];
  return out;
}

/** Items of a list by id (not the document's components, which `mergeNodes` handles). */
function mergeItems(o: Obj[] | undefined, t: Obj[] | undefined, v: Obj[] | undefined, kf: string, path: VariantPathStep[], ctx: MergeCtx): Obj[] {
  const O = byKey(o, kf), T = byKey(t, kf), V = byKey(v, kf);
  const result = new Map<string, Obj>();
  for (const id of new Set([...V.keys(), ...T.keys(), ...O.keys()])) {
    const at = [...path, { id, key: kf }];
    const x = O.get(id), y = T.get(id), z = V.get(id);
    if (x && y && z) result.set(id, mergeItem(x, y, z, at, kf, ctx, false));
    else if (x && y && !z) { if (!same(strip(rootOf(path), x), strip(rootOf(path), y))) keep(ctx, at, x, y, z, KEPT_HIDDEN); }
    else if (x && !y && z) {
      if (same(strip(rootOf(path), x), strip(rootOf(path), z))) comeIn(ctx, at, x, y, z);
      else { look(ctx, at, x, y, z, 'The base removed this, but you had changed it. Yours is kept: check whether it still belongs.'); result.set(id, clone(z)); }
    } else if (!x && y && z) {
      if (!same(y, z)) look(ctx, at, x, y, z, 'The base added something with the same id as one you added. Yours is kept and the base’s is not brought in.');
      result.set(id, clone(z));
    } else if (!x && y && !z) { comeIn(ctx, at, x, y, z); result.set(id, clone(y)); }
    else if (!x && !y && z) result.set(id, clone(z));
  }
  const ids = (l: Obj[] | undefined) => (l ?? []).map((e) => String(e[kf]));
  return mergeIds(ids(o), ids(t), ids(v), (id) => result.has(id)).map((id) => result.get(id)!);
}

const parentsOf = (nodes: DocNode[]) => { const m = new Map<string, string>(); for (const n of nodes) for (const c of n.children ?? []) m.set(c, n.id); return m; };

/**
 * The document's components. A base component keeps the base's place, size and order (the lock); the variant's own
 * components stay where they were, after the component they followed. A component the base removed is kept (and needs
 * a look) when the variant changed it, put something of its own in it, or a rule of the merged document still shows it.
 */
function mergeNodes(O: Project, T: Project, V: Project, rules: Rule[], ctx: MergeCtx): { nodes: DocNode[]; baseNodeIds: string[] } {
  const path: VariantPathStep[] = ['nodes'];
  const kf = 'id';
  const om = new Map(O.nodes.map((n) => [n.id, n])), tm = new Map(T.nodes.map((n) => [n.id, n])), vm = new Map(V.nodes.map((n) => [n.id, n]));
  const vBase = new Set(V.variantOf?.baseNodeIds ?? O.nodes.map((n) => n.id));
  const targeted = new Set(rules.flatMap((r) => ('targetNodeId' in r.then ? [r.then.targetNodeId] : r.then.op === 'requireNodes' ? r.then.nodeIds : [])));
  const result = new Map<string, DocNode>();
  const clash = new Set<string>();
  const ownChildIn = (id: string) => (vm.get(id)?.children ?? []).some((c) => !om.has(c) || !vBase.has(c));
  const noKids = (n: DocNode | undefined) => (n ? strip('nodes', { ...n, children: undefined }) : n);
  for (const id of new Set([...vm.keys(), ...tm.keys(), ...om.keys()])) {
    const at = [...path, { id, key: kf }];
    const x = om.get(id), y = tm.get(id), z = vm.get(id);
    if (x && y && z) result.set(id, mergeItem(x as unknown as Obj, y as unknown as Obj, z as unknown as Obj, at, kf, ctx, vBase.has(id)) as unknown as DocNode);
    else if (x && y && !z) { if (!same(noKids(x), noKids(y))) keep(ctx, at, x, y, z, 'You hid this component in your variant, so it stays hidden. The base changed it.'); }
    else if (x && !y && z) {
      const changed = !same(noKids(x), noKids(z));
      if (changed || ownChildIn(id) || targeted.has(id)) {
        look(ctx, at, x, y, z, changed ? 'The base removed this component, but you had changed it. It is kept in your variant as your own: check whether it still belongs.' : ownChildIn(id) ? 'The base removed this component, but you had put your own content in it. It is kept in your variant as your own: check whether it still belongs.' : 'The base removed this component, but a rule of your variant still shows it. It is kept as your own: check the rule.');
        result.set(id, clone(z));
      } else comeIn(ctx, at, x, y, z);
    } else if (!x && y && z) {
      if (!same(y, z)) { look(ctx, at, x, y, z, 'The base added a component with the same id as one you added. Yours is kept and the base’s is not brought in.'); clash.add(id); }
      result.set(id, clone(z));
    } else if (!x && y && !z) { comeIn(ctx, at, x, y, z); result.set(id, clone(y)); }
    else if (!x && !y && z) result.set(id, clone(z));
  }
  // Where each component sits: a base component where the base has it; the variant's own (and kept) ones where they were.
  const tp = parentsOf(T.nodes), vp = parentsOf(V.nodes);
  const fromBase = (id: string) => tm.has(id) && !clash.has(id);
  const parentOf = (id: string) => (fromBase(id) ? tp.get(id) : vp.get(id));
  // A kept component's container must be kept too (the variant had it, so it can be taken from the variant).
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...result.keys()]) {
      const p = parentOf(id);
      if (p && !result.has(p) && vm.has(p)) {
        look(ctx, [...path, { id: p, key: kf }], om.get(p), tm.get(p), vm.get(p), 'Kept because something of your variant is inside it.');
        result.set(p, clone(vm.get(p)!));
        changed = true;
      }
    }
  }
  for (const n of result.values()) {
    const tKids = (fromBase(n.id) ? tm.get(n.id)?.children : undefined) ?? [];
    const vKids = vm.get(n.id)?.children ?? [];
    const mine = (c: string) => result.has(c) && parentOf(c) === n.id;
    const kids = mergeIds([], tKids, vKids, mine);
    // A base component stays in the base's order (mergeIds keeps the base as the backbone when it changed).
    if (kids.length || n.children) n.children = kids;
  }
  const order = mergeIds(O.nodes.map((n) => n.id), T.nodes.map((n) => n.id), V.nodes.map((n) => n.id), (id) => result.has(id));
  return { nodes: order.map((id) => result.get(id)!), baseNodeIds: T.nodes.map((n) => n.id).filter((id) => !clash.has(id)) };
}

/**
 * The update: the variant brought up to the base's newer version. `ancestor` is the base at the version the variant
 * follows, `base` the base's newer saved version, `variant` the variant as it is now (its working version). Pure and
 * deterministic: the same three documents always give the same result.
 */
export function mergeVariantUpdate(a: { ancestor: Project; base: Project; variant: Project; customers?: Record<string, string> }): VariantUpdate {
  const V = a.variant;
  if (!V.variantOf) throw new Error('Only a variant can be updated from its base.');
  const O = withCustomers(a.ancestor, a.customers), T = withCustomers(a.base, a.customers);
  const ctx: MergeCtx = { names: new Namer([V, T, O]), comesIn: [], kept: [], needsLook: [], incoming: new Set() };
  const out: Obj = {};
  const o = O as unknown as Obj, t = T as unknown as Obj, v = V as unknown as Obj;
  // Rules first: whether a component the base removed is still shown by a rule decides whether it is kept.
  const rules = (mergeValue(o.rules, t.rules, v.rules, ['rules'], ctx) as Rule[] | undefined) ?? [];
  for (const k of keysOf(v, t, o)) {
    if (IDENTITY.has(k) || k === 'nodes' || k === 'rules') continue;
    const m = mergeValue(o[k], t[k], v[k], [k], ctx, VARIANT_LOCKED_KEYS.has(k));
    if (m !== undefined) out[k] = m;
  }
  const { nodes, baseNodeIds } = mergeNodes(O, T, V, rules, ctx);
  const variantOf: VariantOf = { ...V.variantOf, modelVersion: a.base.modelVersion, contentDigest: projectContentDigest(a.base), baseTitle: a.base.title, baseNodeIds };
  let project = { ...(Object.fromEntries(Object.keys(v).filter((k) => IDENTITY.has(k)).map((k) => [k, v[k]]))), ...out, nodes, rules, variantOf } as unknown as Project;
  // Keep the variant's key order (then the base's new keys), so an update that changes nothing reads the same.
  project = Object.fromEntries(keysOf(v, project as unknown as Obj).filter((k) => (project as unknown as Obj)[k] !== undefined).map((k) => [k, (project as unknown as Obj)[k]])) as unknown as Project;
  // A wording the base rewrote under the variant's own translation of it (texts kept with components) needs a look.
  for (const e of ctx.comesIn) {
    if (!e.nodeId || e.group !== 'wording') continue;
    const prefix = `@${e.nodeId}/`;
    for (const [id, s] of Object.entries(V.strings ?? {})) {
      if (!id.startsWith(prefix)) continue;
      for (const [l, text] of Object.entries(s.approved ?? {})) if (!same(text, O.strings?.[id]?.approved?.[l])) look(ctx, ['strings', id, 'approved', l], O.strings?.[id]?.approved?.[l], T.strings?.[id]?.approved?.[l], text, 'The base changed the English of this text. Your translation was written for the old English: check it.');
    }
  }
  // A rule that came in from the base but no longer works in the variant (it shows something you hid): it does not come in.
  for (let i = 0; i < project.rules.length; i++) {
    const r = project.rules[i];
    const problems = validateRule(r, project);
    if (!problems.length) continue;
    const at = ['rules', { id: r.id, key: 'id' }] as VariantPathStep[];
    if (ctx.incoming.has(variantPathId(at))) {
      const mine = V.rules.find((x) => x.id === r.id);
      ctx.comesIn = ctx.comesIn.filter((e) => e.id !== variantPathId(at));
      look(ctx, at, O.rules.find((x) => x.id === r.id), a.base.rules.find((x) => x.id === r.id), mine, `The base’s change to this rule does not work in your variant (${problems[0]}), so it was not brought in.`);
      project = { ...project, rules: mine ? project.rules.map((x) => (x.id === r.id ? mine : x)) : project.rules.filter((x) => x.id !== r.id) };
      i = -1;
    }
  }
  for (const r of project.rules) { const p = validateRule(r, project); if (p.length) look(ctx, ['rules', { id: r.id, key: 'id' }], undefined, undefined, r, `This rule will not work after the update: ${p[0]}`); }
  const lock = variantLockProblem(withCustomers(a.base, a.customers), project, project.variantOf);
  if (lock) look(ctx, ['nodes'], undefined, undefined, undefined, lock.message);
  return { project, fromVersion: V.variantOf.modelVersion, toVersion: a.base.modelVersion, comesIn: ctx.comesIn, kept: ctx.kept, needsLook: ctx.needsLook, baseChanges: diffProjects(a.ancestor, a.base) };
}

/* ------------------------------------------------------------------ use the base's again */

function getAt(root: unknown, path: VariantPathStep[]): unknown {
  let cur = root;
  for (const s of path) {
    if (cur === undefined || cur === null) return undefined;
    if (typeof s === 'string') cur = (cur as Obj)[s];
    else cur = (cur as Obj[]).find((e) => isObj(e) && e[s.key] === s.id);
  }
  return cur;
}

/** Puts `value` at `path` (undefined removes it). The containers on the way must exist. */
function setAt(root: Obj, path: VariantPathStep[], value: unknown, baseList?: Obj[]): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (typeof last === 'string') {
    if (!isObj(parent)) throw new Error('missing container');
    if (value === undefined) delete parent[last]; else parent[last] = value;
    return;
  }
  const list = parent as Obj[];
  if (!Array.isArray(list)) throw new Error('missing list');
  const i = list.findIndex((e) => e[last.key] === last.id);
  if (value === undefined) { if (i >= 0) list.splice(i, 1); return; }
  if (i >= 0) { list[i] = value as Obj; return; }
  // Back where the base has it: after the nearest item before it in the base that the variant also has.
  const order = (baseList ?? []).map((e) => e[last.key]);
  let at = 0;
  for (let j = order.indexOf(last.id) - 1; j >= 0; j--) { const k = list.findIndex((e) => e[last.key] === order[j]); if (k >= 0) { at = k + 1; break; } }
  list.splice(at, 0, value as Obj);
}

/**
 * The variant with one difference dropped: the base's value (at the version followed) back in its place. A component
 * the variant hid comes back where the base has it (with what the base has inside it); a component of the variant's
 * own is removed. Refused (with the reason) when that would break something.
 */
export function useBaseAgain(variant: Project, base: Project, differenceId: string, opts: CompareOptions = {}): { project: Project; label: string } | { error: string } {
  if (!variant.variantOf) return { error: 'This document is not a variant.' };
  const d = compareWithBase(base, variant, opts).find((x) => x.id === differenceId);
  if (!d) return { error: 'That difference is no longer there.' };
  const B = withCustomers(base, opts.customers);
  const next = clone(variant) as unknown as Obj;
  const root = rootOf(d.path);
  const baseValue = clone(getAt(B, d.path));
  try {
    if (root === 'nodes' && d.path.length === 2) {
      const id = (d.path[1] as { id: string }).id;
      const nodes = next.nodes as DocNode[];
      if (d.kind === 'added') {
        const gone = new Set([id]);
        for (let more = true; more;) { more = false; for (const n of nodes) if (gone.has(n.id)) for (const c of n.children ?? []) if (!gone.has(c)) { gone.add(c); more = true; } }
        next.nodes = nodes.filter((n) => !gone.has(n.id)).map((n) => (n.children?.some((c) => gone.has(c)) ? { ...n, children: n.children.filter((c) => !gone.has(c)) } : n));
      } else {
        const bp = parentsOf(B.nodes);
        const parentId = bp.get(id);
        const parent = nodes.find((n) => n.id === parentId);
        if (!parent) return { error: `First bring back “${base.nodes.find((n) => n.id === parentId)?.name ?? parentId}”, which holds it.` };
        const have = new Set(nodes.map((n) => n.id));
        const bring: DocNode[] = [];
        const walk = (nid: string) => { const n = B.nodes.find((x) => x.id === nid); if (!n || have.has(nid)) return; bring.push(clone(n)); for (const c of n.children ?? []) walk(c); };
        walk(id);
        for (const n of bring) if (n.children) n.children = n.children.filter((c) => have.has(c) || bring.some((x) => x.id === c));
        const siblings = B.nodes.find((n) => n.id === parentId)!.children ?? [];
        const kids = [...(parent.children ?? [])];
        let at = 0;
        for (let j = siblings.indexOf(id) - 1; j >= 0; j--) { const k = kids.indexOf(siblings[j]); if (k >= 0) { at = k + 1; break; } }
        kids.splice(at, 0, id);
        next.nodes = [...nodes.map((n) => (n.id === parentId ? { ...n, children: kids } : n)), ...bring];
      }
    } else if (d.path[d.path.length - 1] === '#order') {
      const listPath = d.path.slice(0, -1);
      const list = getAt(next, listPath) as Obj[];
      const kf = keyField(list, getAt(B, listPath)) ?? 'id';
      const baseOrder = ((getAt(B, listPath) as Obj[]) ?? []).map((e) => e[kf]);
      const shared = list.filter((e) => baseOrder.includes(e[kf])).sort((x, y) => baseOrder.indexOf(x[kf]) - baseOrder.indexOf(y[kf]));
      let i = 0;
      setAt(next, listPath, list.map((e) => (baseOrder.includes(e[kf]) ? shared[i++] : e)));
    } else {
      const last = d.path[d.path.length - 1];
      const listPath = typeof last === 'object' ? d.path.slice(0, -1) : null;
      // A list or object on the way that the variant does not have yet (a brand kit, a translation of a new language).
      for (let i = 1; i < d.path.length; i++) {
        const step = d.path[i];
        if (typeof step === 'string' && getAt(next, d.path.slice(0, i)) === undefined) setAt(next, d.path.slice(0, i), typeof d.path[i] === 'object' ? [] : {});
      }
      setAt(next, d.path, baseValue, listPath ? (getAt(B, listPath) as Obj[]) : undefined);
      // A translation taken back from the base brings the base's note of which English it was written from.
      if (root === 'strings' && d.path.length === 4 && (d.path[2] === 'approved' || d.path[2] === 'draft')) {
        const origin = [d.path[0], d.path[1], 'basedOn', d.path[3]];
        const from = getAt(B, origin);
        if (from !== undefined && getAt(next, origin.slice(0, 3)) !== undefined) setAt(next, origin, clone(from));
      }
      const counterRoot = COUNTERS[root];
      if (counterRoot && typeof d.path[1] === 'object') {
        const item = getAt(next, d.path.slice(0, 2)) as Obj | undefined;
        const mine = getAt(variant, d.path.slice(0, 2)) as Obj | undefined;
        if (item && mine && d.path.length > 2) item[counterRoot] = (Number(mine[counterRoot]) || 0) + 1;
      }
    }
  } catch {
    return { error: 'The base’s value cannot be put back here.' };
  }
  const project = next as unknown as Project;
  for (const r of project.rules) { const p = validateRule(r, project); if (p.length) return { error: `${p[0]} Change or remove rule ${r.id} first.` }; }
  const lock = variantLockProblem(base, project, project.variantOf);
  if (lock) return { error: lock.message };
  return { project, label: `Use the base’s ${d.label.charAt(0).toLowerCase()}${d.label.slice(1)} again` };
}

/* ------------------------------------------------------------------ making a variant */

/** The pinned tests' customers mapped to the variant's own copies, as `customers` says. */
export function makeVariant(base: Project, o: { projectId: string; title: string; purpose: VariantPurpose; label: string; customers?: Record<string, string> }): Project {
  if (base.variantOf) throw new Error('A variant cannot be the base of another variant.');
  const copy = clone(base) as Project & Obj;
  for (const k of ['lastSavedAt', 'derivedFrom', 'fromTemplate', 'importedFrom']) delete copy[k];
  const variantOf: VariantOf = { projectId: base.projectId, modelVersion: base.modelVersion, contentDigest: projectContentDigest(base), purpose: o.purpose, label: o.label.trim(), baseTitle: base.title, baseNodeIds: base.nodes.map((n) => n.id) };
  return withCustomers({ ...copy, projectId: o.projectId, title: o.title, modelVersion: 1, variantOf }, o.customers);
}

/** Where a variant stands against its base: the version it follows, the base's latest saved version, whether it is behind. */
export function variantStanding(variant: Pick<Project, 'variantOf'>, baseLatestVersion: number | null): { follows: number; latest: number | null; behind: boolean; baseMissing: boolean } | null {
  const v = variant.variantOf;
  if (!v) return null;
  return { follows: v.modelVersion, latest: baseLatestVersion, behind: baseLatestVersion !== null && baseLatestVersion > v.modelVersion, baseMissing: baseLatestVersion === null };
}

/** A release's record of the variant it was made from (design rule 9): ids, the version followed and the differences. */
export interface VariantReleaseRecord {
  baseId: string;
  baseTitle: string;
  baseVersion: number;
  baseDigest: string;
  purpose: VariantPurpose;
  label: string;
  differences: Array<{ id: string; group: VariantGroup; label: string; kind: VariantDifference['kind'] }>;
}

export function variantReleaseRecord(base: Project, variant: Project, opts: CompareOptions = {}): VariantReleaseRecord | null {
  const v = variant.variantOf;
  if (!v) return null;
  return { baseId: v.projectId, baseTitle: v.baseTitle, baseVersion: v.modelVersion, baseDigest: v.contentDigest, purpose: v.purpose, label: v.label, differences: compareWithBase(base, variant, opts).map((d) => ({ id: d.id, group: d.group, label: d.label, kind: d.kind })) };
}

/** A digest of the differences (so a family view can say whether two variants' differences are the same). */
export const differencesDigest = (diffs: VariantDifference[]): string => digestOf(diffs.map((d) => [d.id, d.base, d.variant]));
