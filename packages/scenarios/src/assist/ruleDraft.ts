import {
  deepClone, languageName, languageShortName, projectFieldIndex, validateRule,
  type FieldDef, type Predicate, type Project, type Rule, type RuleAction, type Scalar,
} from '@iss/model';
import type { AssistSource, RuleDraft } from './types';

/**
 * "Describe the rule": turns a plain sentence (built-in parser) or a model's JSON (validator) into a DRAFT rule.
 * Pure and deterministic. Nothing here applies a rule: the studio shows the draft, its plain restatement and its
 * impact, and a person saves it through UPSERT_RULE.
 *
 * The parser is deliberately narrow: it understands "if <conditions>, show <version or section>" and
 * "show <version or section> to customers who <conditions>". Anything it guessed or could not use is listed in
 * `uncertain`; when the target or every condition is unknown it returns no rule at all.
 */

/* ------------------------------------------------------------------ plain wording (mirrors apps/web/src/ui/plain.ts) */

type Fields = Map<string, FieldDef>;

const humanise = (s: string): string => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').toLowerCase();
const quoted = (s: string): string => `“${s}”`;
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** "Missed payments" → "missed payments"; acronyms such as "ID" stay as they are. */
const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function listText(items: string[], conj: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
}

/** At most `max` names, then "and 2 more". */
function shortList(items: string[], max = 3): string {
  if (items.length <= max + 1) return listText(items);
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

function moneyText(cents: number): string {
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = abs % 100;
  return `${cents < 0 ? '-' : ''}$${whole}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

function fieldLabelOf(fields: Fields, path: string): string {
  return fields.get(path)?.label ?? humanise(path.split('.').slice(-1)[0]);
}

function valueText(field: FieldDef | undefined, v: unknown): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v === null || v === undefined) return 'empty';
  if (typeof v === 'number') return field?.type === 'cents' ? moneyText(v) : String(v);
  if (typeof v === 'string') {
    if (field?.type === 'enum' && languageName(v) !== v) return quoted(languageName(v));
    return quoted(field && field.type !== 'enum' ? v : humanise(v));
  }
  return String(v);
}

const OP_WORDS: Record<string, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };

function predicateSentence(fields: Fields, p: Predicate, nested = false): string {
  switch (p.op) {
    case 'and': {
      const parts: string[] = [];
      for (let i = 0; i < p.args.length; i++) {
        const a = p.args[i], b = p.args[i + 1];
        // "at least a and at most b" on one field reads better as "between a and b".
        if (b && a.op === 'gte' && b.op === 'lte' && a.path === b.path && typeof a.value === 'number' && typeof b.value === 'number') {
          const f = fields.get(a.path);
          parts.push(`${lowerFirst(fieldLabelOf(fields, a.path))} is between ${valueText(f, a.value)} and ${valueText(f, b.value)}`);
          i++;
        } else parts.push(predicateSentence(fields, a, true));
      }
      const s = parts.join(' and ');
      return nested && p.args.length > 1 ? `(${s})` : s;
    }
    case 'or': {
      const s = p.args.map((a) => predicateSentence(fields, a, true)).join(' or ');
      return nested && p.args.length > 1 ? `(${s})` : s;
    }
    case 'not': return `not (${predicateSentence(fields, p.arg)})`;
    case 'isNull': return `${lowerFirst(fieldLabelOf(fields, p.path))} is empty`;
    case 'notNull': return `${lowerFirst(fieldLabelOf(fields, p.path))} is present`;
    case 'in': return `${lowerFirst(fieldLabelOf(fields, p.path))} is one of ${p.value.map((v) => valueText(fields.get(p.path), v)).join(', ')}`;
    default: return `${lowerFirst(fieldLabelOf(fields, p.path))} ${OP_WORDS[p.op]} ${valueText(fields.get(p.path), p.value)}`;
  }
}

function nodeTitle(project: Project, id: string): string {
  const n = project.nodes.find((x) => x.id === id);
  if (n) return n.name ?? humanise(id);
  return project.contentParts.find((x) => x.id === id)?.title ?? humanise(id);
}

function versionTitle(project: Project, variantId: string): string {
  return project.contentParts.find((x) => x.id === variantId)?.title ?? humanise(variantId);
}

function actionSentence(project: Project, a: RuleAction): string {
  switch (a.op) {
    case 'selectVariant': return `show ${quoted(versionTitle(project, a.variantId))} in ${nodeTitle(project, a.targetNodeId)}`;
    case 'showSection': return `include the ${quoted(nodeTitle(project, a.targetNodeId))} section`;
    case 'requireNodes': return `require ${a.nodeIds.map((id) => quoted(nodeTitle(project, id))).join(', ')}`;
    case 'setApprovedLocale': return `use the approved ${languageName(a.locale)} wording`;
    case 'setPresentationHint': return `apply the ${quoted(humanise(a.hint))} presentation`;
  }
}

function displayTitle(project: Project, rule: Rule): string {
  return rule.title?.trim() ? rule.title.trim() : capitalise(actionSentence(project, rule.then));
}

const groupOf = (r: Rule): string | null => (r.mode !== 'exclusive' ? null : r.exclusiveGroup ?? ('targetNodeId' in r.then ? r.then.targetNodeId : null));

/** How narrow a condition is: every "and" adds, an "or" is only as narrow as its widest branch. */
function specificity(p: Predicate): number {
  switch (p.op) {
    case 'and': return p.args.reduce((s, a) => s + specificity(a), 0);
    case 'or': return p.args.length ? Math.min(...p.args.map(specificity)) : 0;
    case 'not': return specificity(p.arg);
    default: return 1;
  }
}

function restate(project: Project, rule: Rule, tense: 'present' | 'future'): string {
  const fields = projectFieldIndex(project);
  let s = `When ${predicateSentence(fields, rule.when)}, ${actionSentence(project, rule.then)}.`;
  const group = groupOf(rule);
  if (group) {
    const others = project.rules.filter((r) => r.id !== rule.id && r.enabled !== false && groupOf(r) === group);
    const over = others.filter((r) => r.priority < rule.priority).sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
    const under = others.filter((r) => r.priority > rule.priority).sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
    const ties = others.filter((r) => r.priority === rule.priority);
    const names = (rs: Rule[]) => shortList(rs.map((r) => quoted(displayTitle(project, r))));
    const win = tense === 'future' ? 'will win over' : 'wins over';
    const lose = tense === 'future' ? 'lose to' : 'loses to';
    if (over.length && under.length) s += ` It ${win} ${names(over)}, and ${lose} ${names(under)}.`;
    else if (over.length) s += ` It ${win} ${names(over)}.`;
    else if (under.length) s += ` It ${tense === 'future' ? 'will lose to' : 'loses to'} ${names(under)}.`;
    if (ties.length) s += ` It has the same priority as ${names(ties)}, so neither wins when both apply.`;
  }
  if (rule.enabled === false) s += ' This rule is switched off.';
  return s;
}

/** The rule in plain words, with what it wins over and loses to among the rules for the same component. */
export function restateRule(project: Project, rule: Rule): string {
  return restate(project, rule, 'present');
}

/** Next free rule id in the studio's R## style. */
export function nextRuleId(project: Project): string {
  const used = new Set(project.rules.map((r) => r.id));
  let n = 0;
  for (const id of used) { const m = /^R(\d{1,9})$/.exec(id); if (m) n = Math.max(n, Number(m[1])); }
  let id = '';
  do { n += 1; id = `R${String(n).padStart(2, '0')}`; } while (used.has(id));
  return id;
}

/* ------------------------------------------------------------------ targets and vocabulary */

interface VersionTarget { nodeId: string; nodeName: string; variantId: string; title: string }
interface SectionTarget { nodeId: string; name: string; titles: string[] }

/** Components whose versions a rule chooses between (variant sets and conditional regions that are not rule-driven sections). */
function variantSetsOf(project: Project): Array<{ nodeId: string; name: string; versions: Array<{ id: string; title: string }> }> {
  return project.nodes
    .filter((n) => n.type === 'variant-set' || (n.type === 'conditional-region' && !n.ruleDriven))
    .map((n) => ({ nodeId: n.id, name: n.name ?? humanise(n.id), versions: (n.variantIds ?? []).map((id) => ({ id, title: versionTitle(project, id) })) }));
}

/** Optional sections a rule switches on (rule-driven conditional regions). */
function sectionsOf(project: Project): SectionTarget[] {
  return project.nodes
    .filter((n) => n.type === 'conditional-region' && n.ruleDriven)
    .map((n) => ({ nodeId: n.id, name: n.name ?? humanise(n.id), titles: (n.variantIds ?? []).map((id) => versionTitle(project, id)) }));
}

/** The vocabulary a model needs to write a rule for this project (fields with labels/types/values, targets with names): compact JSON-serialisable. */
export function ruleVocabulary(project: Project): {
  fields: Array<{ path: string; label: string; type: string; values?: string[] }>;
  variantSets: Array<{ nodeId: string; name: string; versions: Array<{ id: string; title: string }> }>;
  sections: Array<{ nodeId: string; name: string }>;
  exampleRule: Rule;
} {
  const fields = [...projectFieldIndex(project).values()]
    .filter((f) => f.type !== 'array')
    .map((f) => ({ path: f.path, label: f.label, type: f.type, ...(f.enumValues?.length ? { values: [...f.enumValues] } : {}) }));
  const variantSets = variantSetsOf(project);
  const sections = sectionsOf(project).map((s) => ({ nodeId: s.nodeId, name: s.name }));
  return { fields, variantSets, sections, exampleRule: exampleRuleOf(project) };
}

function exampleRuleOf(project: Project): Rule {
  const sets = new Set(variantSetsOf(project).map((s) => s.nodeId));
  const secs = new Set(sectionsOf(project).map((s) => s.nodeId));
  const usable = (r: Rule) => r.scope === project.documentType && ((r.then.op === 'selectVariant' && sets.has(r.then.targetNodeId)) || (r.then.op === 'showSection' && secs.has(r.then.targetNodeId)));
  const existing = project.rules.find((r) => usable(r) && r.then.op === 'selectVariant' && r.when.op === 'and')
    ?? project.rules.find((r) => usable(r) && r.then.op === 'selectVariant')
    ?? project.rules.find(usable);
  if (existing) return canonicalRule({ ...deepClone(existing), id: existing.id });
  // A project without usable rules: build the smallest valid one from its own vocabulary.
  const fields = [...projectFieldIndex(project).values()];
  const f = fields.find((x) => x.type === 'enum' && !x.derived && x.path !== 'documentType' && x.enumValues?.length) ?? fields.find((x) => x.path === 'documentType');
  const when: Predicate = f ? { op: 'eq', path: f.path, value: f.path === 'documentType' ? project.documentType : f.enumValues![0] } : { op: 'eq', path: 'documentType', value: project.documentType };
  const set = variantSetsOf(project).find((s) => s.versions.length);
  const sec = sectionsOf(project)[0];
  const id = nextRuleId(project);
  if (set) return { id, scope: project.documentType, mode: 'exclusive', priority: 100, when, then: { op: 'selectVariant', targetNodeId: set.nodeId, variantId: set.versions[0].id }, version: 1, exclusiveGroup: set.nodeId, enabled: true, title: `Show ${set.versions[0].title}` };
  return { id, scope: project.documentType, mode: 'additive', priority: 30, when, then: { op: 'showSection', targetNodeId: sec?.nodeId ?? project.rootNodeId }, version: 1, enabled: true, title: `Show ${sec?.name ?? 'section'}` };
}

/** Same property order as the seeded rules, optional properties only when present. */
function canonicalRule(r: Rule): Rule {
  const out: Rule = { id: r.id, scope: r.scope, mode: r.mode, priority: r.priority, when: r.when, then: r.then, version: r.version };
  if (r.exclusiveGroup !== undefined) out.exclusiveGroup = r.exclusiveGroup;
  out.enabled = r.enabled !== false;
  if (r.title !== undefined) out.title = r.title;
  if (r.description !== undefined) out.description = r.description;
  return out;
}

/* ------------------------------------------------------------------ priority placement */

/**
 * A priority for a new exclusive rule: above the rules for the same component with fewer conditions, below those with
 * more, and never equal to an existing one. `conflict` = the existing order does not follow specificity, so both could not hold.
 */
function placePriority(project: Project, group: string, spec: number, selfId?: string): { priority: number; conflict: boolean } {
  const sib = project.rules.filter((r) => r.id !== selfId && groupOf(r) === group);
  if (!sib.length) return { priority: 100, conflict: false };
  const used = new Set(sib.map((r) => r.priority));
  const less = sib.filter((r) => specificity(r.when) < spec).map((r) => r.priority);
  const more = sib.filter((r) => specificity(r.when) > spec).map((r) => r.priority);
  const lo = less.length ? Math.max(...less) : -1;
  const hi = more.length ? Math.min(...more) : 10001;
  // Nearest unused integer to `prefer` strictly between `from` and `to`.
  const free = (from: number, to: number, prefer: number): number | null => {
    if (to - from < 2) return null;
    const start = Math.min(to - 1, Math.max(from + 1, prefer));
    for (let d = 0; d <= to - from; d++) for (const c of [start - d, start + d]) if (c > from && c < to && c >= 0 && c <= 10000 && !used.has(c)) return c;
    return null;
  };
  if (lo < hi) {
    const top = Math.max(...sib.map((r) => r.priority));
    const prefer = more.length ? (hi - 50 > lo ? hi - 50 : Math.floor((lo + hi) / 2)) : Math.max(lo, top) + 100;
    const p = free(lo, hi, prefer);
    if (p !== null) return { priority: p, conflict: false };
  }
  const p = free(lo, 10001, lo + 100) ?? free(-1, 10001, 5000);
  return { priority: p ?? 0, conflict: true };
}

function additivePriority(project: Project): number {
  const counts = new Map<number, number>();
  for (const r of project.rules) if (r.mode === 'additive') counts.set(r.priority, (counts.get(r.priority) ?? 0) + 1);
  let best = 30, n = 0;
  for (const [p, c] of counts) if (c > n || (c === n && p < best)) { best = p; n = c; }
  return best;
}

function draftTitle(project: Project, when: Predicate, then: RuleAction): string {
  const what = then.op === 'selectVariant' ? `show ${quoted(versionTitle(project, then.variantId))}` : then.op === 'showSection' ? `show ${quoted(nodeTitle(project, then.targetNodeId))}` : actionSentence(project, then);
  let cond = capitalise(predicateSentence(projectFieldIndex(project), when));
  const max = 110 - what.length;
  if (cond.length > max) cond = `${cond.slice(0, Math.max(20, max - 1)).trimEnd()}…`;
  return `${cond} — ${what}`;
}

function buildRule(project: Project, when: Predicate, then: RuleAction, priority: number | null, extra: { title?: string; description?: string; enabled?: boolean }): { rule: Rule; conflict: boolean } {
  let conflict = false;
  let p = priority;
  if (then.op === 'selectVariant') {
    if (p === null) { const placed = placePriority(project, then.targetNodeId, specificity(when)); p = placed.priority; conflict = placed.conflict; }
  } else if (p === null) p = additivePriority(project);
  const rule: Rule = { id: nextRuleId(project), scope: project.documentType, mode: then.op === 'selectVariant' ? 'exclusive' : 'additive', priority: p, when, then, version: 1 };
  if (then.op === 'selectVariant') rule.exclusiveGroup = then.targetNodeId;
  rule.enabled = extra.enabled !== false;
  rule.title = extra.title ?? draftTitle(project, when, then);
  if (extra.description) rule.description = extra.description;
  return { rule, conflict };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ tokens */

interface Tok {
  /** Lower-case word. */
  w: string;
  /** Stemmed (plural-insensitive) form used for matching. */
  t: string;
  /** Position in the original sentence. */
  s: number;
  e: number;
  /** An "and"/"or" that belongs to a phrase ("two or more", "between 1 and 3") and does not join conditions. */
  prot?: boolean;
}

function stem(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') ? w.slice(0, -1) : w;
}

const TOKEN = /\d{4}-\d{2}-\d{2}|(?<![a-z0-9])-?\$?\d+(?:,\d{3})*(?:\.\d+)?(?:k\b)?|>=|<=|!=|<>|==|[≥≤≠><=+$%,;:]|[a-zà-ÿ]+(?:'[a-z]+)?/g;

function tokenize(text: string): Tok[] {
  // Same length as the input so token positions index the original text.
  let norm = '';
  for (const ch of text) {
    const c = ch === '’' || ch === '‘' ? "'" : ch === ' ' ? ' ' : ch;
    const l = c.toLowerCase();
    norm += l.length === c.length ? l : c;
  }
  const out: Tok[] = [];
  for (const m of norm.matchAll(TOKEN)) {
    let w = m[0];
    const s = m.index ?? 0, e = s + w.length;
    if (w.endsWith("n't")) {
      const base = w.slice(0, -3);
      if (base) out.push({ w: base, t: stem(base), s, e });
      out.push({ w: 'not', t: 'not', s, e });
      continue;
    }
    if (/^[a-z]/.test(w)) w = w.replace(/'s$/, '').replace(/'/g, '');
    if (w) out.push({ w, t: stem(w), s, e });
  }
  return out;
}

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean).map(stem));
const phrase = (s: string): string[] => s.split(/\s+/).filter(Boolean).map((w) => (w === '*' ? w : stem(w.toLowerCase())));
const sliceText = (ctx: { text: string }, toks: Tok[]): string => (toks.length ? ctx.text.slice(toks[0].s, toks[toks.length - 1].e).trim() : '');

const SHOW_VERBS = new Set(['show', 'use', 'send', 'select', 'display', 'include', 'give', 'present', 'choose']);
const LEADS = new Set(['if', 'when', 'whenever', 'once', 'where']);
const CONNECTORS = new Set(['when', 'whenever', 'if', 'once', 'where', 'unless']);
const CUSTOMER_NOUNS = words('customer member cardholder people person anyone everyone those client patient account holder user someone anybody everybody');
const DETERMINERS = words('the a an all any every each our');
const RELATIVES = words('who whose with that where when if which having');
const TYPE_NOUNS = words('message version variant text wording section block panel paragraph content copy part option alternative box area component');
const STOP = words(`the a an customer cardholder member client patient person people account holder provider their they them he she his her its it who whom whose that which this these those
  has have had having is are was were be been being am does do did with of in on at for to by from there here currently now already ever still yet value number count total amount sum equal equals set as than then
  any some own also just please should would will can may must get got gets receive received receives prefer prefers preferred want wants speak speaks speaking use uses using mark marked flag flagged made make
  we our us you your i my me claim statement card plan document policy only s`);
const NEGATIONS = words('not never without no non neither nor none');
const TRUTHY = words('yes true');
const FALSY = words('false off');
/** Words an alias may skip between its own words: "liability is confirmed", "assistance was not requested". */
const ALIAS_GAP = words('is are was were has have been be the a an of not never yet already now currently');

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const own = <T,>(o: Record<string, T>, k: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const isNumberWord = (w: string): boolean => own(NUMBER_WORDS, w) !== undefined;
const isDigits = (t: Tok): boolean => /^-?\$?\d/.test(t.w) && !/^\d{4}-\d{2}-\d{2}$/.test(t.w);
const isNumberTok = (t: Tok | undefined): boolean => !!t && (isDigits(t) || isNumberWord(t.w) || t.w === 'hundred' || t.w === 'thousand');
const UNIT_MONEY = words('dollar dollars usd buck bucks');
const UNIT_OTHER = words('cent cents point points pts pt percent');

type CmpOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
const COMPARATORS: Array<{ toks: string[]; op: CmpOp }> = ([
  ['greater than or equal to', 'gte'], ['more than or equal to', 'gte'], ['at least', 'gte'], ['or more', 'gte'], ['or greater', 'gte'], ['or higher', 'gte'], ['or above', 'gte'], ['or over', 'gte'],
  ['and above', 'gte'], ['and over', 'gte'], ['and up', 'gte'], ['minimum of', 'gte'], ['on or after', 'gte'], ['or later', 'gte'], ['>=', 'gte'], ['≥', 'gte'], ['+', 'gte'],
  ['less than or equal to', 'lte'], ['fewer than or equal to', 'lte'], ['at most', 'lte'], ['or less', 'lte'], ['or fewer', 'lte'], ['or lower', 'lte'], ['or below', 'lte'], ['or under', 'lte'],
  ['and below', 'lte'], ['and under', 'lte'], ['up to', 'lte'], ['maximum of', 'lte'], ['on or before', 'lte'], ['or earlier', 'lte'], ['<=', 'lte'], ['≤', 'lte'],
  ['more than', 'gt'], ['greater than', 'gt'], ['higher than', 'gt'], ['bigger than', 'gt'], ['larger than', 'gt'], ['later than', 'gt'], ['in excess of', 'gt'], ['over', 'gt'], ['above', 'gt'], ['exceed', 'gt'], ['exceeding', 'gt'], ['after', 'gt'], ['>', 'gt'],
  ['less than', 'lt'], ['fewer than', 'lt'], ['lower than', 'lt'], ['smaller than', 'lt'], ['earlier than', 'lt'], ['under', 'lt'], ['below', 'lt'], ['before', 'lt'], ['<', 'lt'],
  ['other than', 'ne'], ['different from', 'ne'], ['anything but', 'ne'], ['except', 'ne'], ['!=', 'ne'], ['<>', 'ne'], ['≠', 'ne'],
  ['equal to', 'eq'], ['exactly', 'eq'], ['=', 'eq'], ['==', 'eq'],
] as Array<[string, CmpOp]>).map(([p, op]) => ({ toks: phrase(p), op })).sort((a, b) => b.toks.length - a.toks.length);
const NEGATE: Record<CmpOp, CmpOp> = { eq: 'ne', ne: 'eq', gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt' };
/** Words that turn a preceding "or"/"and" into part of a comparison ("two or more", "5 and above"). */
const OR_TAILS = new Set(['more', 'fewer', 'less', 'greater', 'higher', 'above', 'below', 'over', 'under', 'lower', 'later', 'earlier', 'equal']);
const AND_TAILS = new Set(['above', 'over', 'up', 'below', 'under']);

/* ------------------------------------------------------------------ field and value vocabulary of the parser */

/** Extra ways people name the sample fields. Only used when the project has the field. `*` = a few words in between. */
const FIELD_SYNONYMS: Record<string, string[]> = {
  'card.missedPayments': ['missed * payment', 'payment missed', 'missed payment count', 'number of missed payment', 'late payment'],
  'card.paymentStatus': ['payment status', 'payment state', 'account status', 'account standing'],
  'card.assistanceRequested': [
    'assistance requested', 'assistance request', 'help requested', 'support requested', 'payment assistance requested',
    ...['asked for', 'requested', 'applied for', 'asking for', 'requesting'].flatMap((v) => ['assistance', 'help', 'support', 'payment assistance', 'payment help', 'payment support', 'hardship assistance'].map((n) => `${v} ${n}`)),
  ],
  'card.arrangementStatus': ['arrangement status', 'arrangement', 'payment arrangement', 'payment arrangement status', 'payment plan', 'repayment plan', 'repayment arrangement'],
  'card.tier': ['account tier', 'tier', 'account level', 'account type', 'card tier', 'customer tier'],
  'card.channelPreference': ['channel preference', 'channel', 'preferred channel', 'delivery preference', 'delivery channel', 'delivery method', 'contact preference'],
  'card.rewardsBalance': ['rewards balance', 'rewards', 'rewards points', 'points', 'loyalty points', 'rewards point balance'],
  'customer.locale': ['preferred locale', 'locale', 'language', 'preferred language'],
  'card.newBalanceCents': ['new balance', 'statement balance', 'current balance', 'closing balance', 'outstanding balance'],
  'card.previousBalanceCents': ['previous balance', 'prior balance', 'last balance', 'opening balance'],
  'card.minimumDueCents': ['minimum payment due', 'minimum payment', 'minimum due', 'minimum amount due'],
  'card.creditLimitCents': ['credit limit'],
  'card.purchasesCents': ['purchases', 'spending', 'spend'],
  'card.paymentsCreditsCents': ['payments and credits', 'payments made', 'payments received'],
  'card.interestFeesCents': ['fees and interest', 'interest and fees', 'fees', 'interest', 'fees charged', 'interest charged'],
  'customer.accessibility.largeText': ['large text', 'large print', 'larger text', 'large text preference'],
  'customer.accessibility.highContrast': ['high contrast', 'high contrast preference'],
  'customer.givenName': ['given name', 'first name'],
  'customer.familyName': ['family name', 'last name', 'surname'],
  'claim.status': ['claim status', 'status of claim', 'claim state'],
  'claim.network': ['network status', 'network', 'provider network'],
  'claim.deductibleAppliedCents': ['deductible applied', 'deductible', 'deductible amount', 'applied to deductible'],
  'claim.liabilityConfirmed': ['member liability confirmed', 'liability confirmed', 'liability', 'member liability', 'responsibility confirmed', 'confirmed liability', 'confirmed responsibility'],
  'claim.patientResponsibilityCents': ['member responsibility', 'patient responsibility', 'responsibility', 'member share', 'member owes', 'patient owes'],
  'claim.billedCents': ['billed amount', 'billed', 'amount billed', 'provider billed'],
  'claim.allowedCents': ['allowed amount', 'allowed', 'amount allowed', 'plan allowed'],
  'claim.planPaidCents': ['plan paid', 'paid by plan', 'plan payment'],
  'claim.amountUnderReviewCents': ['amount under review'],
  'claim.contractualAdjustmentCents': ['contractual adjustment', 'adjustment'],
  'claim.claimId': ['claim id', 'claim number'],
  'claim.service': ['service description', 'service'],
  'member.planName': ['plan name', 'plan'],
  'member.memberId': ['member id', 'member number'],
};

/** Everyday words for the sample fields' allowed values. Only used when the field has that value. */
const VALUE_SYNONYMS: Record<string, Record<string, string[]>> = {
  'card.paymentStatus': { current: ['up to date', 'on time', 'paid up', 'in good standing'], overdue: ['past due', 'late', 'behind', 'in arrears', 'delinquent'] },
  'card.tier': { premium: ['premier'], standard: ['regular', 'basic'] },
  'card.arrangementStatus': { approved: ['active', 'agreed', 'in place'] },
  'card.channelPreference': { digital: ['online', 'paperless'], print: ['paper', 'post', 'printed', 'mail'], email: ['e mail'] },
  'claim.status': { 'processed-covered': ['covered', 'processed and covered'], 'denied-pending-review': ['denied', 'rejected', 'declined'], 'appeal-filed': ['appealed', 'under appeal', 'on appeal'], 'appeal-resolved': ['resolved'] },
};

/** Fields a sentence can never usefully test. */
const NOT_FOR_RULES = new Set(['documentType', 'recordId']);

interface Alias { toks: string[]; paths: string[]; weak: boolean }
interface ValuePhrase { toks: string[]; path: string; value: string }
interface Vocab { fields: Fields; usable: FieldDef[]; aliases: Alias[]; values: ValuePhrase[]; /** Phrases that contain "and"/"or" and must not be split. */ glued: string[][] }

function buildVocab(project: Project): Vocab {
  const fields = projectFieldIndex(project);
  const usable = [...fields.values()].filter((f) => !f.derived && f.type !== 'array' && !NOT_FOR_RULES.has(f.path));
  const byPhrase = new Map<string, Alias>();
  const add = (text: string, path: string, weak: boolean) => {
    const toks = phrase(text.toLowerCase().replace(/[^a-z0-9*à-ÿ]+/g, ' ').trim());
    if (!toks.length || toks.every((t) => t === '*')) return;
    const key = toks.join(' ');
    const a = byPhrase.get(key);
    if (!a) byPhrase.set(key, { toks, paths: [path], weak });
    else if (a.weak && !weak) { a.paths = [path]; a.weak = false; }
    else if (a.weak === weak && !a.paths.includes(path)) a.paths.push(path);
  };
  const heads = new Map<string, string[]>();
  for (const f of usable) {
    const bare = f.label.replace(/\([^)]*\)/g, ' ').trim();
    add(f.label, f.path, false);
    add(bare, f.path, false);
    const last = humanise(f.path.split('.').slice(-1)[0]);
    add(last, f.path, false);
    add(last.replace(/ cents$/, ''), f.path, false);
    for (const s of own(FIELD_SYNONYMS, f.path) ?? []) add(s, f.path, false);
    const bw = bare.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (bw.length >= 2) heads.set(bw[bw.length - 1], [...(heads.get(bw[bw.length - 1]) ?? []), f.path]);
  }
  // A head noun shared by several fields ("balance", "status") is an ambiguous way to name any of them.
  for (const [head, paths] of heads) if (paths.length >= 2) for (const p of paths) add(head, p, true);

  const values: ValuePhrase[] = [];
  const addValue = (text: string, path: string, value: string) => {
    const toks = phrase(text.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ').trim());
    if (toks.length && !values.some((v) => v.path === path && v.value === value && v.toks.join(' ') === toks.join(' '))) values.push({ toks, path, value });
  };
  for (const f of usable) {
    if (f.type !== 'enum') continue;
    for (const v of f.enumValues ?? []) {
      addValue(v, f.path, v);
      if (languageName(v) !== v) { addValue(languageName(v), f.path, v); addValue(languageShortName(v), f.path, v); }
      for (const s of own(own(VALUE_SYNONYMS, f.path) ?? {}, v) ?? []) addValue(s, f.path, v);
    }
  }
  const aliases = [...byPhrase.values()];
  const glued = [...aliases.map((a) => a.toks), ...values.map((v) => v.toks)].filter((t) => t.includes('and') || t.includes('or'));
  return { fields, usable, aliases, values, glued };
}

/* ------------------------------------------------------------------ condition clauses */

interface Ctx { text: string; vocab: Vocab }
interface Mention { idx: number[]; paths: string[]; weak: boolean; text: string }

function matchAlias(a: string[], toks: Tok[], start: number): number[] | null {
  const idx: number[] = [];
  let p = start;
  for (let k = 0; k < a.length; k++) {
    if (a[k] === '*') {
      const next = a[k + 1];
      let found = -1;
      for (let q = p; q < Math.min(toks.length, p + 6); q++) if (toks[q].t === next) { found = q; break; }
      if (found < 0) return null;
      p = found;
      continue;
    }
    let q = p, skipped = 0;
    while (k > 0 && q < toks.length && toks[q].t !== a[k] && ALIAS_GAP.has(toks[q].t) && skipped < 3) { q++; skipped++; }
    if (q >= toks.length || toks[q].t !== a[k]) return null;
    idx.push(q);
    p = q + 1;
  }
  return idx;
}

function findMentions(ctx: Ctx, toks: Tok[]): Mention[] {
  const all: Mention[] = [];
  for (const a of ctx.vocab.aliases) for (let i = 0; i < toks.length; i++) {
    const idx = matchAlias(a.toks, toks, i);
    if (!idx) continue;
    const same = all.find((m) => m.weak === a.weak && m.idx.join() === idx.join());
    if (same) { for (const p of a.paths) if (!same.paths.includes(p)) same.paths.push(p); }
    else all.push({ idx, paths: [...a.paths], weak: a.weak, text: idx.map((j) => toks[j].w).join(' ') });
  }
  // A shorter name inside a longer one ("balance" in "rewards balance") is not a separate mention.
  return all.filter((m) => !all.some((o) => o.idx.length > m.idx.length && m.idx.every((i) => o.idx.includes(i))));
}

interface Quantity { value: number; money: boolean; unit: 'cents' | 'points' | 'percent' | null; idx: number[] }

function findQuantities(toks: Tok[], used: boolean[]): Quantity[] {
  const out: Quantity[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (used[i]) continue;
    const t = toks[i];
    let q: Quantity | null = null;
    if (isDigits(t)) {
      const raw = t.w.replace(/[$,]/g, '');
      const k = raw.endsWith('k');
      q = { value: Number(k ? raw.slice(0, -1) : raw) * (k ? 1000 : 1), money: t.w.includes('$') || (i > 0 && toks[i - 1].w === '$'), unit: null, idx: [i] };
      if (i > 0 && toks[i - 1].w === '$' && !used[i - 1]) q.idx.push(i - 1);
    } else if (isNumberWord(t.w) || t.w === 'hundred' || t.w === 'thousand') {
      let total = 0, cur = 0, j = i;
      for (; j < toks.length && !used[j]; j++) {
        const w = toks[j].w;
        if (isNumberWord(w)) cur += NUMBER_WORDS[w];
        else if (w === 'hundred') cur = (cur || 1) * 100;
        else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; }
        else break;
      }
      q = { value: total + cur, money: false, unit: null, idx: [] };
      for (let x = i; x < j; x++) q.idx.push(x);
      i = j - 1;
    }
    if (!q) continue;
    const next = toks[i + 1];
    if (next && !used[i + 1]) {
      if (UNIT_MONEY.has(next.t)) { q.money = true; q.idx.push(i + 1); }
      else if (next.w === '%' || next.t === 'percent') { q.unit = 'percent'; q.idx.push(i + 1); }
      else if (UNIT_OTHER.has(next.t)) { q.unit = next.t === 'cent' ? 'cents' : 'points'; q.idx.push(i + 1); }
    }
    for (const x of q.idx) used[x] = true;
    out.push(q);
  }
  return out;
}

interface Parsed { pred: Predicate; path: string; op: string; notes: string[] }
type ClauseTry = { ok: true; parsed: Parsed } | { ok: false; reason: string };
const no = (reason: string): ClauseTry => ({ ok: false, reason });

function findValuePhrases(ctx: Ctx, toks: Tok[], used: boolean[], path?: string): Array<ValuePhrase & { idx: number[] }> {
  const out: Array<ValuePhrase & { idx: number[] }> = [];
  for (const v of ctx.vocab.values) {
    if (path && v.path !== path) continue;
    for (let i = 0; i + v.toks.length <= toks.length; i++) {
      let ok = true;
      for (let k = 0; k < v.toks.length; k++) if (used[i + k] || toks[i + k].t !== v.toks[k]) { ok = false; break; }
      if (ok) out.push({ ...v, idx: v.toks.map((_, k) => i + k) });
    }
  }
  return out.sort((a, b) => b.idx.length - a.idx.length || a.idx[0] - b.idx[0]);
}

function toNumber(field: FieldDef, q: Quantity, notes: string[]): number | string {
  const label = field.label;
  if (q.unit === 'percent') return `${label} cannot be compared with a percentage.`;
  if (field.type === 'cents') {
    if (q.unit === 'points') return `${label} is an amount of money, not points.`;
    if (q.unit === 'cents') return Number.isInteger(q.value) ? q.value : `${label} needs a whole number of cents.`;
    const cents = Math.round(q.value * 100);
    if (Math.abs(q.value * 100 - cents) > 1e-6) return `${label} needs an amount with at most two decimals.`;
    if (!q.money) notes.push(`I read ${q.value} as ${moneyText(cents)} for ${lowerFirst(label)}; say “$” or “dollars” to be sure.`);
    return cents;
  }
  if (q.money || q.unit === 'cents') return `${label} is a ${field.type === 'points' ? 'number of points' : 'count'}, not an amount of money.`;
  if (!Number.isInteger(q.value)) return `${label} needs a whole number.`;
  return q.value;
}

/** Reads the comparison and value for one field from the words of a clause that are not the field's own name. */
function parseRemainder(ctx: Ctx, field: FieldDef, rest: Tok[]): ClauseTry {
  const used: boolean[] = rest.map(() => false);
  const notes: string[] = [];
  const label = field.label;
  let enumHit: (ValuePhrase & { idx: number[] }) | undefined;
  if (field.type === 'enum') {
    enumHit = findValuePhrases(ctx, rest, used, field.path)[0];
    if (enumHit) for (const i of enumHit.idx) used[i] = true;
  }
  // "between a and b"
  const betweenAt = rest.findIndex((t, i) => !used[i] && t.w === 'between');
  if (betweenAt >= 0) used[betweenAt] = true;
  // comparison words
  const ops: CmpOp[] = [];
  for (const c of COMPARATORS) {
    for (let i = 0; i + c.toks.length <= rest.length; i++) {
      let ok = true;
      for (let k = 0; k < c.toks.length; k++) if (used[i + k] || rest[i + k].t !== c.toks[k]) { ok = false; break; }
      if (!ok) continue;
      for (let k = 0; k < c.toks.length; k++) used[i + k] = true;
      if (!ops.includes(c.op)) ops.push(c.op);
    }
  }
  const strong = ops.filter((o) => o !== 'eq');
  if (strong.length > 1) return no(`there are two different comparisons for ${lowerFirst(label)}`);
  let op: CmpOp = strong[0] ?? 'eq';
  const compared = strong.length > 0;
  let neg = false;
  const flip = (i: number) => { used[i] = true; neg = !neg; };
  rest.forEach((t, i) => { if (!used[i] && (t.prot ? false : NEGATIONS.has(t.t))) flip(i); });
  const leftovers = (): string[] => rest.filter((t, i) => !used[i] && !STOP.has(t.t) && !/^[,;:]$/.test(t.w)).map((t) => t.w);
  const done = (pred: Predicate, path: string, o: string): ClauseTry => {
    const left = leftovers();
    if (left.length) notes.push(`I did not use ${quoted(left.join(' '))}.`);
    return { ok: true, parsed: { pred, path, op: o, notes } };
  };

  if (field.type === 'cents' || field.type === 'int' || field.type === 'points') {
    const qs = findQuantities(rest, used);
    if (betweenAt >= 0) {
      const andAt = rest.findIndex((t, i) => !used[i] && t.w === 'and' && t.prot);
      if (andAt >= 0) used[andAt] = true;
      if (qs.length !== 2 || neg || compared) return no(`“between” needs two numbers for ${lowerFirst(label)}`);
      const a = toNumber(field, qs[0], notes), b = toNumber(field, qs[1].money || qs[1].unit ? qs[1] : { ...qs[1], money: qs[0].money, unit: qs[0].unit }, notes);
      if (typeof a === 'string') return no(a);
      if (typeof b === 'string') return no(b);
      if (a > b) return no(`“between” needs the smaller number first for ${lowerFirst(label)}`);
      return done({ op: 'and', args: [{ op: 'gte', path: field.path, value: a }, { op: 'lte', path: field.path, value: b }] }, field.path, 'between');
    }
    if (qs.length > 1) return no(`there is more than one number for ${lowerFirst(label)}`);
    if (!qs.length) {
      if (compared) return no(`I could not find the number to compare ${lowerFirst(label)} with`);
      const left = leftovers();
      if (left.length) return no(`I could not find a number for ${lowerFirst(label)} in ${quoted(left.join(' '))}`);
      // "has rewards" / "has no rewards"
      return done({ op: neg ? 'eq' : 'gt', path: field.path, value: 0 }, field.path, neg ? 'eq' : 'gt');
    }
    const n = toNumber(field, qs[0], notes);
    if (typeof n === 'string') return no(n);
    if (neg) op = NEGATE[op];
    return done({ op, path: field.path, value: n }, field.path, op);
  }

  if (betweenAt >= 0) return no(`“between” only works with numbers, and ${lowerFirst(label)} is not a number`);

  if (field.type === 'enum') {
    if (op !== 'eq' && op !== 'ne') return no(`${label} can only be compared with “is” or “is not”`);
    if (!enumHit) {
      const left = leftovers();
      const allowed = (field.enumValues ?? []).map((v) => quoted(humanise(v))).join(', ');
      if (left.length || !(field.enumValues ?? []).includes('none')) return no(left.length ? `${quoted(left.join(' '))} is not one of the ${label} values (${allowed})` : `I could not find which ${label} value is meant (${allowed})`);
      // "has no arrangement" / "has an arrangement"
      const o = neg !== (op === 'ne') ? 'eq' : 'ne';
      notes.push(`I read this as ${lowerFirst(label)} ${o === 'eq' ? 'is' : 'is not'} “none”.`);
      return done({ op: o, path: field.path, value: 'none' }, field.path, o);
    }
    if (neg) op = NEGATE[op];
    return done({ op, path: field.path, value: enumHit.value }, field.path, op);
  }

  if (field.type === 'bool') {
    if (op !== 'eq' && op !== 'ne') return no(`${label} is yes or no, so it cannot be “more” or “less”`);
    rest.forEach((t, i) => { if (!used[i] && TRUTHY.has(t.t)) used[i] = true; else if (!used[i] && FALSY.has(t.t)) flip(i); });
    const value = !(neg !== (op === 'ne'));
    return done({ op: 'eq', path: field.path, value }, field.path, 'eq');
  }

  if (field.type === 'date') {
    const at = rest.findIndex((t, i) => !used[i] && /^\d{4}-\d{2}-\d{2}$/.test(t.w));
    if (at < 0) return no(`${label} needs a date written like 2026-11-25`);
    const [, mm, dd] = rest[at].w.split('-').map(Number);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return no(`${quoted(rest[at].w)} is not a date`);
    used[at] = true;
    if (neg) op = NEGATE[op];
    return done({ op, path: field.path, value: rest[at].w }, field.path, op);
  }

  // Free text: everything after "is" (original spelling kept).
  if (op !== 'eq' && op !== 'ne') return no(`${label} is text, so it can only be compared with “is” or “is not”`);
  let from = 0;
  rest.forEach((t, i) => { if (used[i] || ['is', 'are', 'equals', 'equal', 'called', 'named'].includes(t.w)) from = i + 1; });
  const valueToks = rest.slice(from).filter((t) => !/^[,;:]$/.test(t.w));
  if (!valueToks.length) return no(`I could not find the text to compare ${lowerFirst(label)} with`);
  const value = sliceText(ctx, valueToks).replace(/^["“”']+|["“”']+$/g, '');
  if (!value || codeLike(value)) return no(`the text for ${lowerFirst(label)} cannot be used`);
  for (let i = from; i < rest.length; i++) used[i] = true;
  if (neg) op = NEGATE[op];
  return done({ op, path: field.path, value }, field.path, op);
}

interface PrevClause { path: string; op: string }

function parseClause(ctx: Ctx, toks: Tok[], prev: PrevClause | null): ClauseTry {
  const fields = ctx.vocab.fields;
  const mentions = findMentions(ctx, toks);
  interface Hit { parsed: Parsed; weak: boolean; len: number; alias: string }
  const hits: Hit[] = [];
  const reasons: string[] = [];
  for (const m of mentions) for (const path of m.paths) {
    const field = fields.get(path);
    if (!field) continue;
    const r = parseRemainder(ctx, field, toks.filter((_, i) => !m.idx.includes(i)));
    if (r.ok) hits.push({ parsed: r.parsed, weak: m.weak, len: m.idx.length, alias: m.text });
    else reasons.push(r.reason);
  }
  if (hits.length) {
    const strong = hits.some((h) => !h.weak) ? hits.filter((h) => !h.weak) : hits;
    const clean = strong.some((h) => !h.parsed.notes.length) ? strong.filter((h) => !h.parsed.notes.length) : strong;
    const longest = Math.max(...clean.map((h) => h.len));
    const best = clean.filter((h) => h.len === longest).filter((h, i, a) => a.findIndex((x) => sameJson(x.parsed.pred, h.parsed.pred)) === i);
    if (best.length === 1) return { ok: true, parsed: best[0].parsed };
    const names = [...new Set(best.map((h) => fieldLabelOf(fields, h.parsed.path)))];
    return no(`${quoted(best[0].alias)} could mean ${listText(names, 'or')}; say which one`);
  }

  // No field named: a value that only one field can have ("is premium", "prefers Spanish", "out of network").
  const used = toks.map(() => false);
  const found = findValuePhrases(ctx, toks, used);
  if (found.length) {
    const top = found.filter((v) => v.idx.length === found[0].idx.length);
    const inherit = prev && (prev.op === 'eq' || prev.op === 'ne') ? top.find((v) => v.path === prev.path) : undefined;
    const paths = [...new Set(top.map((v) => v.path))];
    if (!inherit && paths.length > 1) {
      return no(`${quoted(top[0].idx.map((i) => toks[i].w).join(' '))} could be a value of ${listText(paths.map((p) => fieldLabelOf(fields, p)), 'or')}; name the field`);
    }
    const pick = inherit ?? top[0];
    const field = fields.get(pick.path)!;
    const r = parseRemainder(ctx, field, toks);
    if (r.ok && inherit && prev!.op === 'ne' && r.parsed.op === 'eq') {
      // "is not A or B" means neither.
      return { ok: true, parsed: { ...r.parsed, pred: { op: 'ne', path: field.path, value: pick.value }, op: 'ne-list' } };
    }
    return r;
  }

  // "… is at least 2 and less than 5": the second half is about the same field.
  if (prev && (toks.some((t) => isNumberTok(t)) || COMPARATORS.some((c) => c.op !== 'eq' && toks.some((_, i) => c.toks.every((x, k) => toks[i + k]?.t === x))))) {
    const field = fields.get(prev.path);
    if (field) return parseRemainder(ctx, field, toks);
  }
  return no(reasons[0] ?? 'it does not name a field I know');
}

interface Conditions { when: Predicate | null; notes: string[]; total: number; understood: number }

function parseConditions(ctx: Ctx, input: Tok[]): Conditions {
  const toks = input.map((t) => ({ ...t }));
  // Protect "and"/"or" that belong to a phrase rather than joining two conditions.
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].w;
    if (w === 'between') { for (let j = i + 1; j < Math.min(toks.length, i + 8); j++) if (toks[j].w === 'and') { toks[j].prot = true; break; } }
    if (w !== 'or' && w !== 'and') continue;
    const next = toks[i + 1]?.w ?? '';
    const afterNumber = isNumberTok(toks[i - 1]) || ((UNIT_MONEY.has(toks[i - 1]?.t ?? '') || UNIT_OTHER.has(toks[i - 1]?.t ?? '')) && isNumberTok(toks[i - 2]));
    if (w === 'or' && ((afterNumber && OR_TAILS.has(next)) || (toks[i - 1]?.w === 'on' && (next === 'after' || next === 'before')) || (toks[i - 1]?.w === 'than' && next === 'equal'))) toks[i].prot = true;
    if (w === 'and' && afterNumber && AND_TAILS.has(next)) toks[i].prot = true;
  }
  for (const g of ctx.vocab.glued) for (let i = 0; i + g.length <= toks.length; i++) {
    if (g.every((x, k) => toks[i + k].t === x)) g.forEach((x, k) => { if (x === 'and' || x === 'or') toks[i + k].prot = true; });
  }

  const clauses: Tok[][] = [[]];
  const joins: Array<'and' | 'or' | ','> = [];
  for (const t of toks) {
    const j = t.prot ? null : t.w === 'and' || t.w === 'but' || t.w === 'plus' ? 'and' : t.w === 'or' ? 'or' : t.w === ',' || t.w === ';' ? ',' : null;
    if (!j) { clauses[clauses.length - 1].push(t); continue; }
    if (!clauses[clauses.length - 1].length) { if (j !== ',' && joins.length) joins[joins.length - 1] = j; continue; }
    clauses.push([]);
    joins.push(j);
  }
  if (!clauses[clauses.length - 1].length) { clauses.pop(); joins.pop(); }
  const explicit = [...new Set(joins.filter((j) => j !== ','))];
  const listJoin: 'and' | 'or' = explicit.length === 1 ? (explicit[0] as 'and' | 'or') : 'and';

  const notes: string[] = [];
  const parts: Array<{ pred: Predicate; join: 'and' | 'or' }> = [];
  let prev: PrevClause | null = null;
  let understood = 0;
  clauses.forEach((c, i) => {
    let join: 'and' | 'or' = i === 0 ? 'and' : joins[i - 1] === ',' ? listJoin : (joins[i - 1] as 'and' | 'or');
    const r = parseClause(ctx, c, prev);
    const text = sliceText(ctx, c);
    if (!r.ok) { notes.push(`I did not understand ${quoted(text)} (${r.reason}), so it is not part of the draft.`); return; }
    understood += 1;
    for (const n of r.parsed.notes) notes.push(`In ${quoted(text)}: ${n}`);
    if (r.parsed.op === 'ne-list') join = 'and';
    parts.push({ pred: r.parsed.pred, join });
    prev = { path: r.parsed.path, op: r.parsed.op === 'ne-list' ? 'ne' : r.parsed.op };
  });
  if (!parts.length) return { when: null, notes, total: clauses.length, understood };

  // "and" binds tighter than "or".
  const groups: Predicate[][] = [[]];
  parts.forEach((p, i) => { if (i > 0 && p.join === 'or') groups.push([]); groups[groups.length - 1].push(p.pred); });
  const flat = (ps: Predicate[]): Predicate[] => ps.flatMap((p) => (p.op === 'and' ? p.args : [p]));
  const ands: Predicate[] = groups.map((g) => (g.length === 1 ? g[0] : { op: 'and', args: flat(g) }));
  const when: Predicate = ands.length === 1 ? ands[0] : { op: 'or', args: ands };
  if (groups.length > 1 && groups.some((g) => g.length > 1)) {
    notes.push(`The sentence mixes “and” and “or”. I grouped it as: ${predicateSentence(ctx.vocab.fields, when)}. Check that this is the grouping you mean.`);
  }
  return { when, notes, total: clauses.length, understood };
}

/* ------------------------------------------------------------------ what to show */

type TargetResult =
  | { ok: true; action: RuleAction; notes: string[] }
  | { ok: false; reason: string };

const nameToks = (s: string): string[] => tokenize(s).map((t) => t.t).filter((t) => /^[a-z0-9à-ÿ]/.test(t));
const stripTypeNouns = (t: string[]): string[] => { const out = [...t]; while (out.length > 1 && TYPE_NOUNS.has(out[out.length - 1])) out.pop(); return out; };
const containsRun = (hay: string[], needle: string[]): boolean => needle.length > 0 && hay.some((_, i) => needle.every((x, k) => hay[i + k] === x));

function availableTargets(project: Project): string {
  const sets = variantSetsOf(project).filter((s) => s.versions.length).map((s) => `a version of ${s.name} (${s.versions.map((v) => v.title).join(', ')})`);
  const secs = sectionsOf(project).map((s) => s.name);
  const parts = [...sets];
  if (secs.length) parts.push(`the section${secs.length === 1 ? '' : 's'} ${listText(secs)}`);
  return parts.length ? `You can show ${listText(parts, 'or')}.` : 'This document has no versions or optional sections for a rule to show.';
}

function resolveTarget(project: Project, ctx: Ctx, input: Tok[]): TargetResult {
  let toks = input.filter((t) => !/^[,;:]$/.test(t.w));
  const ARTICLES = new Set(['the', 'a', 'an', 'our', 'this', 'that', 'its', 'only', 'also', 'always']);
  const PRONOUNS = new Set(['them', 'him', 'her', 'everyone']);
  const OBJECTS = new Set(['customer', 'customers', 'member', 'members', 'cardholder', 'cardholders', 'people']);
  for (let again = true; again && toks.length > 1;) {
    again = false;
    if (ARTICLES.has(toks[0].w) || PRONOUNS.has(toks[0].w)) { toks = toks.slice(1); again = true; }
    // "give the customer the payment reminder"
    else if (OBJECTS.has(toks[0].w) && toks.length > 2 && ARTICLES.has(toks[1].w)) { toks = toks.slice(2); again = true; }
  }
  const TRAILING = new Set(['instead', 'too', 'please', 'only', 'always']);
  while (toks.length > 1 && TRAILING.has(toks[toks.length - 1].w)) toks = toks.slice(0, -1);
  if (!toks.length) return { ok: false, reason: 'the sentence does not say what to show' };
  const said = sliceText(ctx, toks);

  const sets = variantSetsOf(project);
  const secs = sectionsOf(project);
  interface Cand { key: string; action: RuleAction; names: string[][]; label: string; nodeId: string }
  const cands: Cand[] = [];
  for (const s of sets) for (const v of s.versions) {
    cands.push({ key: `v:${s.nodeId}:${v.id}`, action: { op: 'selectVariant', targetNodeId: s.nodeId, variantId: v.id }, names: [nameToks(v.title), nameToks(v.id)], label: `${quoted(v.title)} in ${s.name}`, nodeId: s.nodeId });
  }
  for (const s of secs) {
    const node = project.nodes.find((n) => n.id === s.nodeId);
    cands.push({ key: `s:${s.nodeId}`, action: { op: 'showSection', targetNodeId: s.nodeId }, names: [nameToks(s.name), nameToks(s.nodeId), ...s.titles.map(nameToks), ...(node?.variantIds ?? []).map(nameToks)], label: `the ${quoted(s.name)} section`, nodeId: s.nodeId });
  }

  // "… in Payment guidance": an explicit component narrows the search.
  let pool = cands;
  let words = toks.map((t) => t.t);
  for (let i = toks.length - 2; i > 0; i--) {
    if (!['in', 'within', 'for', 'of', 'on', 'from'].includes(toks[i].w)) continue;
    let comp = toks.slice(i + 1).map((t) => t.t);
    while (comp.length > 1 && DETERMINERS.has(comp[0])) comp = comp.slice(1);
    comp = stripTypeNouns(comp);
    const nodes = [...sets.map((s) => ({ id: s.nodeId, name: s.name })), ...secs.map((s) => ({ id: s.nodeId, name: s.name }))]
      .filter((n) => sameJson(nameToks(n.name), comp) || sameJson(nameToks(n.id), comp));
    if (nodes.length === 1) { pool = cands.filter((c) => c.nodeId === nodes[0].id); words = toks.slice(0, i).map((t) => t.t); break; }
  }
  const variants = [words, stripTypeNouns(words)].filter((w, i, a) => i === 0 || !sameJson(w, a[0]));
  const dedupe = (cs: Cand[]): Cand[] => cs.filter((c, i, a) => a.findIndex((x) => x.key === c.key) === i);

  const exact = dedupe(pool.filter((c) => c.names.some((n) => variants.some((v) => sameJson(n, v)))));
  if (exact.length === 1) return { ok: true, action: exact[0].action, notes: [] };
  if (exact.length > 1) return { ok: false, reason: `${quoted(said)} could be ${listText(exact.map((c) => c.label), 'or')}; say which one` };

  const core = variants[variants.length - 1].filter((w) => !DETERMINERS.has(w));
  const partial = dedupe(pool.filter((c) => c.names.some((n) => containsRun(n, core) || containsRun(core, n))));
  if (partial.length === 1) return { ok: true, action: partial[0].action, notes: [`I matched ${quoted(said)} to ${partial[0].label}; check that this is the one you mean.`] };
  if (partial.length > 1) return { ok: false, reason: `${quoted(said)} could be ${listText(partial.map((c) => c.label), 'or')}; say which one` };
  return { ok: false, reason: `${quoted(said)} is not a version or section of this document` };
}

/* ------------------------------------------------------------------ sentence → draft */

interface SentenceParse {
  when: Predicate | null;
  action: RuleAction | null;
  notes: string[];
  /** Why there is no rule (already worded for the person). */
  problem: string | null;
  unsupported: boolean;
}

function parseSentence(project: Project, sentence: string): SentenceParse {
  const text = typeof sentence === 'string' ? sentence.slice(0, 600) : '';
  const ctx: Ctx = { text, vocab: buildVocab(project) };
  let toks = tokenize(text);
  while (toks.length && /^[,;:]$/.test(toks[toks.length - 1].w)) toks = toks.slice(0, -1);
  while (toks.length && ['please', 'then', 'also', 'and', 'always', ','].includes(toks[0].w)) toks = toks.slice(1);
  const fail = (problem: string, extra: Partial<SentenceParse> = {}): SentenceParse => ({ when: null, action: null, notes: [], problem, unsupported: false, ...extra });
  if (!toks.length) return fail('There is no sentence to read.');

  // Things the rule model cannot express: say so instead of guessing.
  const ws = toks.map((t) => t.w);
  const hideAt = ws.findIndex((w, i) => ['hide', 'hides', 'hidden', 'remove', 'removes', 'suppress', 'omit', 'exclude', 'drop']
    .includes(w) || ((w === 'not' || w === 'never' || w === 'stop') && SHOW_VERBS.has((ws[i + 1] ?? '').replace(/ing$/, ''))));
  if (hideAt >= 0) {
    return fail('Rules can only choose what to show (a version of a message, or an optional section); there is no “hide” rule. Describe who should see it instead.', { unsupported: true, notes: ['“Hide” is not supported: a rule can only show a version or a section.'] });
  }
  if (ws.includes('unless')) return fail('“Unless” is not supported. Say who should get it as a positive condition.', { unsupported: true, notes: ['“Unless” is not supported.'] });
  if (['otherwise', 'else'].includes(ws[0]) || (ws[0] === 'by' && ws[1] === 'default')) {
    return fail('A rule needs a condition. What is shown when no rule applies is the fallback version of the component, which is set on the component itself.', { unsupported: true, notes: ['A default without a condition is the component’s fallback version, not a rule.'] });
  }

  let cond: Tok[] = [];
  let target: Tok[] = [];
  if (SHOW_VERBS.has(toks[0].w)) {
    // "show <target> when|if|to customers who <conditions>"
    let at = -1, condFrom = -1;
    let lead: Tok[] = [];
    for (let i = 1; i < toks.length && at < 0; i++) {
      const w = toks[i].w;
      if (CONNECTORS.has(w)) { at = i; condFrom = i + 1; }
      else if (w === 'as' && toks[i + 1]?.w === 'soon' && toks[i + 2]?.w === 'as') { at = i; condFrom = i + 3; }
      else if (w === 'to' || w === 'for') {
        for (let j = i + 1; j <= Math.min(toks.length - 1, i + 5); j++) {
          if (toks[j].w === 'and' || toks[j].w === 'or' || toks[j].w === ',') break;
          if (!CUSTOMER_NOUNS.has(toks[j].t)) continue;
          at = i;
          lead = toks.slice(i + 1, j).filter((t) => !DETERMINERS.has(t.t));
          condFrom = j + 1;
          break;
        }
      }
    }
    if (at < 0) {
      const t = resolveTarget(project, ctx, toks.slice(1));
      return fail(t.ok ? 'I understood what to show, but not which customers should get it. Add a condition, for example “… when payment status is overdue”.' : `I could not tell who should get it, and ${t.reason}.`, { action: t.ok ? t.action : null });
    }
    target = toks.slice(1, at);
    let rest = toks.slice(condFrom);
    while (rest.length && RELATIVES.has(rest[0].t)) rest = rest.slice(1);
    const joiner: Tok[] = lead.length && rest.length ? [{ w: 'and', t: 'and', s: rest[0].s, e: rest[0].s }] : [];
    cond = [...lead, ...joiner, ...rest];
  } else {
    // "if|when <conditions>, [then] show <target>"
    let from = 0;
    if (LEADS.has(toks[0].w)) from = 1;
    else if (toks[0].w === 'as' && toks[1]?.w === 'soon' && toks[2]?.w === 'as') from = 3;
    else if ((toks[0].w === 'for' || toks[0].w === 'to') && toks.slice(1, 6).some((t) => CUSTOMER_NOUNS.has(t.t))) from = 1;
    let verbAt = toks.findIndex((t, i) => i > from && SHOW_VERBS.has(t.w) && [',', 'then', 'please', 'always', ':'].includes(toks[i - 1].w));
    if (verbAt < 0) verbAt = toks.findIndex((t, i) => i > from && SHOW_VERBS.has(t.w));
    if (verbAt < 0) {
      return fail('I could not find what to show. Start with “If …” and end with “show …”.');
    }
    cond = toks.slice(from, verbAt);
    while (cond.length && [',', ':', 'then', 'please', 'always', 'we', 'should', 'must', 'will', 'also'].includes(cond[cond.length - 1].w)) cond = cond.slice(0, -1);
    target = toks.slice(verbAt + 1);
  }

  const t = resolveTarget(project, ctx, target);
  const c = parseConditions(ctx, cond);
  const notes = [...c.notes, ...(t.ok ? t.notes : [])];
  if (!t.ok) return { when: c.when, action: null, notes, problem: `I could not tell what to show: ${t.reason}.`, unsupported: false };
  if (!c.when) return { when: null, action: t.action, notes, problem: cond.length ? 'I understood what to show, but none of the conditions.' : 'I understood what to show, but the sentence has no condition.', unsupported: false };
  return { when: c.when, action: t.action, notes, problem: null, unsupported: false };
}

/** A sentence the parser is known to understand for this project (taken from one of its own rules when possible). */
function exampleSentence(project: Project): string {
  const fields = projectFieldIndex(project);
  const say = (when: Predicate, then: RuleAction): string | null => {
    const cond = predicateSentence(fields, when).replace(/[“”]/g, '');
    const what = then.op === 'selectVariant' ? `show ${versionTitle(project, then.variantId)}` : then.op === 'showSection' ? `show the ${nodeTitle(project, then.targetNodeId)} section` : null;
    if (!what) return null;
    const s = `If ${cond}, ${what}`;
    const p = parseSentence(project, s);
    return !p.problem && sameJson(p.when, when) && sameJson(p.action, then) ? s : null;
  };
  for (const r of project.rules) {
    if (r.scope !== project.documentType || r.enabled === false) continue;
    const s = say(r.when, r.then);
    if (s) return s;
  }
  const vocab = buildVocab(project);
  const set = variantSetsOf(project).find((x) => x.versions.length);
  const sec = sectionsOf(project)[0];
  const then: RuleAction | null = set ? { op: 'selectVariant', targetNodeId: set.nodeId, variantId: set.versions[0].id } : sec ? { op: 'showSection', targetNodeId: sec.nodeId } : null;
  if (then) for (const f of vocab.usable) {
    const when: Predicate | null = f.type === 'enum' && f.enumValues?.length ? { op: 'eq', path: f.path, value: f.enumValues[0] } : f.type === 'bool' ? { op: 'eq', path: f.path, value: true } : f.type === 'int' ? { op: 'gte', path: f.path, value: 1 } : null;
    const s = when ? say(when, then) : null;
    if (s) return s;
  }
  return 'If <field> is <value>, show <version or section name>';
}

/** Built-in parser: a plain sentence → a draft rule, restated in plain words, with everything guessed or unused listed. */
export function draftRuleFromSentence(project: Project, sentence: string): RuleDraft {
  const source: AssistSource = 'builtin';
  const p = parseSentence(project, sentence);
  const fields = projectFieldIndex(project);
  const uncertain = [...p.notes];
  const refuse = (problem: string): RuleDraft => {
    const understood: string[] = [];
    if (p.when) understood.push(`the condition (${predicateSentence(fields, p.when)})`);
    if (p.action && p.problem !== null && !/^I understood what to show/.test(problem)) understood.push(`what to show (${actionSentence(project, p.action)})`);
    const parts = [`No rule was drafted. ${problem}`];
    if (understood.length) parts.push(`I did understand ${listText(understood)}.`);
    if (!p.action && !p.unsupported) parts.push(availableTargets(project));
    parts.push(`A sentence that works: “${exampleSentence(project)}”.`);
    if (!uncertain.length) uncertain.push(problem);
    return { rule: null, restatement: parts.join(' '), uncertain, source };
  };
  if (p.problem || !p.when || !p.action) return refuse(p.problem ?? 'The sentence could not be read as a rule.');

  const description = `Drafted from: “${String(sentence).replace(/\s+/g, ' ').trim().slice(0, 240)}”`;
  const { rule, conflict } = buildRule(project, p.when, p.action, null, { description: codeLike(description) ? undefined : description });
  const errors = validateRule(rule, project);
  if (errors.length) { uncertain.push(...errors); return refuse('The rule I built from the sentence is not valid for this project.'); }
  if (conflict) uncertain.push('The existing priorities do not follow “more specific wins”, so I placed this rule above the less specific ones; check what it wins over.');
  let restatement = restate(project, rule, 'future');
  const twin = project.rules.find((r) => sameJson(r.when, rule.when) && sameJson(r.then, rule.then));
  if (twin) restatement += ` Note: the existing rule ${quoted(displayTitle(project, twin))} already has the same condition and outcome.`;
  return { rule, restatement, uncertain, source };
}

/* ------------------------------------------------------------------ untrusted JSON → draft */

const RULE_KEYS = new Set(['id', 'scope', 'mode', 'priority', 'when', 'then', 'version', 'exclusiveGroup', 'enabled', 'title', 'description']);
const COMPARE_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Text that looks like markup, a template or code rather than a name or a value. */
function codeLike(s: string): boolean {
  return /[<>{}`\\\u0000-\u001f\u007f]|=>|\$\(|;\s*\S|javascript:|__proto__|\b[A-Za-z_$][\w$]*\(/.test(s);
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string, reasons: string[]): boolean {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) reasons.push(`${where} has ${extra.length === 1 ? 'a property' : 'properties'} that a rule cannot have: ${extra.map((k) => quoted(k.slice(0, 40))).join(', ')}.`);
  return !extra.length;
}

function checkValue(field: FieldDef, v: unknown, reasons: string[]): v is Scalar {
  const label = field.label;
  switch (field.type) {
    case 'cents': case 'int': case 'points':
      if (typeof v !== 'number' || !Number.isInteger(v)) { reasons.push(`${label} must be compared with a whole number${field.type === 'cents' ? ' of cents' : ''}, not ${describe(v)}.`); return false; }
      return true;
    case 'bool':
      if (typeof v !== 'boolean') { reasons.push(`${label} must be compared with true or false, not ${describe(v)}.`); return false; }
      return true;
    case 'enum':
      if (typeof v !== 'string' || !(field.enumValues ?? []).includes(v)) { reasons.push(`${describe(v)} is not a ${label} value (${(field.enumValues ?? []).join(', ')}).`); return false; }
      return true;
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) { reasons.push(`${label} must be compared with a date written like 2026-11-25, not ${describe(v)}.`); return false; }
      return true;
    case 'string':
      if (typeof v !== 'string' || !v.length || v.length > 200 || codeLike(v)) { reasons.push(`${label} must be compared with plain text.`); return false; }
      return true;
    default:
      reasons.push(`${label} is a list and cannot be compared directly.`);
      return false;
  }
}

function describe(v: unknown): string {
  if (typeof v === 'string') return quoted(v.slice(0, 40));
  if (v === null) return 'nothing';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return Array.isArray(v) ? 'a list' : `a ${typeof v}`;
}

function checkPredicate(raw: unknown, fields: Fields, reasons: string[], budget: { left: number }, depth = 0): Predicate | null {
  if (depth > 8) { reasons.push('The condition is nested too deeply.'); return null; }
  if ((budget.left -= 1) < 0) { if (budget.left === -1) reasons.push('The condition has too many parts.'); return null; }
  if (!isPlainObject(raw) || typeof raw.op !== 'string') { reasons.push('Every part of the condition must be an object with an “op”.'); return null; }
  const op = raw.op;
  const fieldOf = (): FieldDef | null => {
    if (typeof raw.path !== 'string') { reasons.push(`A ${quoted(op)} condition needs a field path.`); return null; }
    const f = fields.get(raw.path);
    if (!f) { reasons.push(`Unknown field ${quoted(raw.path.slice(0, 60))}.`); return null; }
    if (f.type === 'array') { reasons.push(`${f.label} is a list and cannot be compared directly.`); return null; }
    return f;
  };
  if (op === 'and' || op === 'or') {
    if (!onlyKeys(raw, ['op', 'args'], `An ${quoted(op)} condition`, reasons)) return null;
    if (!Array.isArray(raw.args) || !raw.args.length || raw.args.length > 20) { reasons.push(`An ${quoted(op)} condition needs a list of 1–20 conditions.`); return null; }
    const args = raw.args.map((a) => checkPredicate(a, fields, reasons, budget, depth + 1));
    return args.every((a): a is Predicate => a !== null) ? { op, args } : null;
  }
  if (op === 'not') {
    if (!onlyKeys(raw, ['op', 'arg'], 'A “not” condition', reasons)) return null;
    const arg = checkPredicate(raw.arg, fields, reasons, budget, depth + 1);
    return arg ? { op, arg } : null;
  }
  if (op === 'isNull' || op === 'notNull') {
    if (!onlyKeys(raw, ['op', 'path'], `An ${quoted(op)} condition`, reasons)) return null;
    const f = fieldOf();
    return f ? { op, path: f.path } : null;
  }
  if (op === 'in') {
    if (!onlyKeys(raw, ['op', 'path', 'value'], 'An “in” condition', reasons)) return null;
    const f = fieldOf();
    if (!f) return null;
    if (!Array.isArray(raw.value) || !raw.value.length || raw.value.length > 50) { reasons.push(`An “in” condition on ${f.label} needs a list of 1–50 values.`); return null; }
    const value: Scalar[] = [];
    for (const v of raw.value) { if (!checkValue(f, v, reasons)) return null; value.push(v); }
    return { op, path: f.path, value };
  }
  if (COMPARE_OPS.has(op)) {
    if (!onlyKeys(raw, ['op', 'path', 'value'], `A ${quoted(op)} condition`, reasons)) return null;
    const f = fieldOf();
    if (!f) return null;
    if (!checkValue(f, raw.value, reasons)) return null;
    if ((f.type === 'enum' || f.type === 'bool' || f.type === 'string') && op !== 'eq' && op !== 'ne') { reasons.push(`${f.label} can only be compared with “eq” or “ne”, not ${quoted(op)}.`); return null; }
    return { op: op as CmpOp, path: f.path, value: raw.value };
  }
  reasons.push(`Unsupported operator ${quoted(op.slice(0, 40))}. Conditions use eq, ne, gt, gte, lt, lte, in, isNull, notNull, and, or, not.`);
  return null;
}

function checkAction(project: Project, raw: unknown, reasons: string[]): RuleAction | null {
  if (!isPlainObject(raw) || typeof raw.op !== 'string') { reasons.push('The rule needs a “then” object that says what to show.'); return null; }
  if (raw.op === 'selectVariant') {
    if (!onlyKeys(raw, ['op', 'targetNodeId', 'variantId'], 'The action', reasons)) return null;
    const set = variantSetsOf(project).find((s) => s.nodeId === raw.targetNodeId);
    if (typeof raw.targetNodeId !== 'string' || !set) { reasons.push(`Unknown component ${describe(raw.targetNodeId)}: a version can only be chosen in ${listText(variantSetsOf(project).map((s) => s.nodeId), 'or') || 'a variant set'}.`); return null; }
    if (typeof raw.variantId !== 'string' || !set.versions.some((v) => v.id === raw.variantId)) { reasons.push(`Unknown version ${describe(raw.variantId)} in ${set.name} (${set.versions.map((v) => v.id).join(', ')}).`); return null; }
    return { op: 'selectVariant', targetNodeId: raw.targetNodeId, variantId: raw.variantId };
  }
  if (raw.op === 'showSection') {
    if (!onlyKeys(raw, ['op', 'targetNodeId'], 'The action', reasons)) return null;
    const secs = sectionsOf(project);
    if (typeof raw.targetNodeId !== 'string' || !secs.some((s) => s.nodeId === raw.targetNodeId)) { reasons.push(`Unknown section ${describe(raw.targetNodeId)}: the optional sections are ${listText(secs.map((s) => s.nodeId)) || 'none'}.`); return null; }
    return { op: 'showSection', targetNodeId: raw.targetNodeId };
  }
  reasons.push(`Only rules that show a version (“selectVariant”) or an optional section (“showSection”) can be drafted, not ${quoted(raw.op.slice(0, 40))}.`);
  return null;
}

/**
 * Checks untrusted JSON (a model's answer) and turns it into a draft. Nothing is repaired: an unknown field, target,
 * operator or property, a value of the wrong type or text that looks like code rejects the whole suggestion.
 * The id is always assigned here and the scope is the project's. `priority`, `mode`, `exclusiveGroup`, `version`,
 * `enabled` and `title` may be left out (they follow from the rest); when present they must be right.
 */
export function validateRuleDraft(project: Project, raw: unknown, source: AssistSource): RuleDraft {
  const reasons: string[] = [];
  const refuse = (): RuleDraft => ({ rule: null, restatement: 'No rule was drafted: the suggested rule could not be used as it is.', uncertain: reasons, source });
  if (!isPlainObject(raw)) { reasons.push('The suggestion is not a rule object.'); return refuse(); }
  const extra = Object.keys(raw).filter((k) => !RULE_KEYS.has(k));
  if (extra.length) reasons.push(`The suggestion has ${extra.length === 1 ? 'a property' : 'properties'} that a rule cannot have: ${extra.map((k) => quoted(k.slice(0, 40))).join(', ')}.`);
  if (raw.id !== undefined && typeof raw.id !== 'string') reasons.push('The rule id must be text (it is replaced by the next free id anyway).');
  if (raw.scope !== undefined && raw.scope !== project.documentType) reasons.push(`The rule is written for ${describe(raw.scope)}, but this document is a ${project.documentType}.`);

  const then = checkAction(project, raw.then, reasons);
  const when = raw.when === undefined ? (reasons.push('The rule needs a “when” condition.'), null) : checkPredicate(raw.when, projectFieldIndex(project), reasons, { left: 60 });
  const mode = then?.op === 'selectVariant' ? 'exclusive' : 'additive';
  if (then && raw.mode !== undefined && raw.mode !== mode) reasons.push(`A ${then.op} rule must have mode ${quoted(mode)}, not ${describe(raw.mode)}.`);
  if (then && raw.exclusiveGroup !== undefined && (then.op !== 'selectVariant' || raw.exclusiveGroup !== then.targetNodeId)) {
    reasons.push(then.op === 'selectVariant' ? `exclusiveGroup must be ${quoted(then.targetNodeId)}, the component the rule chooses a version in.` : 'A rule that shows a section has no exclusiveGroup.');
  }
  let priority: number | null = null;
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== 'number' || !Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > 10000) reasons.push('Priority must be a whole number from 0 to 10000 (or left out, to have it placed automatically).');
    else {
      priority = raw.priority;
      const tied = then?.op === 'selectVariant' ? project.rules.filter((r) => groupOf(r) === then.targetNodeId && r.priority === priority) : [];
      if (tied.length) reasons.push(`Priority ${priority} is already used by ${shortList(tied.map((r) => quoted(displayTitle(project, r))))} for the same component, which would be a tie. Leave the priority out to have it placed automatically.`);
    }
  }
  if (raw.version !== undefined && (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1)) reasons.push('Version must be a whole number (a new rule starts at 1).');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') reasons.push('“enabled” must be true or false.');
  for (const key of ['title', 'description'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim() || v.length > (key === 'title' ? 140 : 600)) reasons.push(`The ${key} must be a short text.`);
    else if (codeLike(v)) reasons.push(`The ${key} contains markup or code-like text, which is not allowed.`);
  }
  if (reasons.length || !then || !when) return refuse();

  const { rule } = buildRule(project, when, then, priority, {
    title: typeof raw.title === 'string' ? raw.title.trim() : undefined,
    description: typeof raw.description === 'string' ? raw.description.trim() : undefined,
    enabled: raw.enabled !== false,
  });
  const errors = validateRule(rule, project);
  if (errors.length) { reasons.push(...errors); return refuse(); }
  return { rule, restatement: restate(project, rule, 'future'), uncertain: [], source };
}

/** Wording and ordering helpers shared with the rule review (one object so the assist index gains a single name). */
export const ruleWording = {
  title: displayTitle,
  condition: (project: Project, p: Predicate): string => predicateSentence(projectFieldIndex(project), p),
  version: versionTitle,
  component: nodeTitle,
  specificity,
  group: groupOf,
};
