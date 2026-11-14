import {
  SOURCE_LANGUAGE, buildContext, getPath, isIsoDay, languageName, languageShortName, projectFieldIndex, projectLanguages,
  type FieldDef, type ProfileId, type Project, type Rule, type SyntheticRecord,
} from '@iss/model';
import type { RNode, Resolution, TraceEntry } from '@iss/resolver';
import { ScenarioEngine, dimensionValue } from '../index';
import { customerBlockers, documentBlockers } from './blockers';
import { explainNode } from './explain';
import type { BlockerKind } from './types';
import { conditionWords, countWords, listWords, nodeWords, ruleWords, valueWords } from './writing';

/**
 * "Ask about all customers" (wave 4, item 7): a STRUCTURED question about every customer of the document, and the
 * engine's answer to it. Pure and deterministic (no network, clock, randomness or `Intl`).
 *
 * The answer always comes from the engine: every customer of the document is resolved with the same `ScenarioEngine`
 * the Cube and the Landscape use, and an outcome counts exactly as coverage counts it (a rule in the run's matched
 * rules; a message alternative or section in the resolved tree, visible). Blockers are the Blockers screen's own
 * (`documentBlockers`, or the result the screen already holds). A reader (built in, or a model on the server) only turns
 * a sentence into a `BaseQuestion`; `checkBaseQuestion` refuses anything that names what the document does not have.
 */

/* ------------------------------------------------------------------ the question */

/** What a customer can "get". */
export type QueryTarget =
  /** The rule's condition holds for the customer (it is among the run's matched rules), whether or not it won. */
  | { kind: 'rule'; ruleId: string }
  /** One message alternative of a component is shown. */
  | { kind: 'alternative'; nodeId: string; variantId: string }
  /** A section (or any named component that can be left out) is shown. */
  | { kind: 'section'; nodeId: string }
  /** The customer is stopped: by any blocker, by a kind of blocker, or by one blocker. */
  | { kind: 'blocker'; blockerKind?: BlockerKind; blockerId?: string }
  /** The customer's language. */
  | { kind: 'language'; locale: string };

export type FieldOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export interface FieldCondition { path: string; op: FieldOp; value: string | number | boolean }

export interface BaseQuestion {
  /** `who` lists the customers, `how-many` leads with the count, `why` explains one customer. */
  ask: 'who' | 'how-many' | 'why';
  target: QueryTarget;
  /** "…but not Y": customers who also get this are left out. */
  butNot?: QueryTarget;
  /** Only customers whose data meets this condition. */
  where?: FieldCondition;
  /** Only customers whose language is this one ("…in Spanish"). */
  language?: string;
  /** `why`: the customer's record id (or `CUSTOMER_PLACEHOLDER` from a model, resolved by the studio). */
  customer?: string;
  /** "As issued on": the document's date for a document that uses dates. */
  issuedOn?: string;
}

/** What a model writes where the question named a customer; the studio puts the customer in after the model answered. */
export const CUSTOMER_PLACEHOLDER = '<customer>';

export const BLOCKER_KINDS: readonly BlockerKind[] = ['wording', 'rules', 'layout', 'data-fields', 'customer-data'];
export const BLOCKER_KIND_WORDS: Record<BlockerKind, string> = {
  wording: 'a wording or translation blocker', rules: 'a rules blocker', layout: 'a layout or page blocker', 'data-fields': 'a data field blocker', 'customer-data': 'a problem in the customer’s own data',
};
const OPS: readonly FieldOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];

/* ------------------------------------------------------------------ the document's own names */

export interface QueryVocabulary {
  rules: Array<{ id: string; title: string; /** What the rule does to the document, when it chooses a message or shows a section. */ gives: QueryTarget | null }>;
  /** Components with message alternatives (and conditional sections with more than one text). */
  messages: Array<{ nodeId: string; name: string; alternatives: Array<{ id: string; title: string }> }>;
  /** Components that can be left out: conditional sections, components with their own condition, sections a rule shows, and message components. */
  sections: Array<{ nodeId: string; name: string; /** The text a one-text section shows (it names the section too). */ texts: Array<{ id: string; title: string }> }>;
  /** Fields a condition can test: labels and types (never a customer's value). */
  fields: Array<{ path: string; label: string; type: FieldDef['type']; enumValues?: string[] }>;
  languages: Array<{ code: string; name: string }>;
}

const humanise = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** The rules, messages, sections, fields and languages of a document: the only words a question can name. */
export function queryVocabulary(project: Project): QueryVocabulary {
  const docType = project.documentType;
  const rules = project.rules.filter((r) => r.scope === docType && r.enabled !== false);
  const partTitle = (id: string): string => project.contentParts.find((c) => c.id === id)?.title?.trim() || humanise(id);
  const shown = new Set(rules.flatMap((r) => (r.then.op === 'showSection' ? [r.then.targetNodeId] : [])));
  const messages: QueryVocabulary['messages'] = [];
  const sections: QueryVocabulary['sections'] = [];
  for (const n of project.nodes) {
    const parts = (n.variantIds ?? []).filter((id) => project.contentParts.some((c) => c.id === id));
    const name = nodeWords(project, n.id);
    if (n.type === 'variant-set' || (n.type === 'conditional-region' && parts.length > 1)) messages.push({ nodeId: n.id, name, alternatives: parts.map((id) => ({ id, title: partTitle(id) })) });
    if (n.type === 'variant-set' || n.type === 'conditional-region' || !!n.visibleWhen || shown.has(n.id)) {
      sections.push({ nodeId: n.id, name, texts: n.type === 'conditional-region' && parts.length === 1 ? [{ id: parts[0], title: partTitle(parts[0]) }] : [] });
    }
  }
  const gives = (r: Rule): QueryTarget | null => (r.then.op === 'selectVariant' ? { kind: 'alternative', nodeId: r.then.targetNodeId, variantId: r.then.variantId } : r.then.op === 'showSection' ? { kind: 'section', nodeId: r.then.targetNodeId } : null);
  const fields = [...projectFieldIndex(project).values()]
    .filter((f) => f.type !== 'array' && !f.calculated && f.path !== 'document.date' && f.path !== 'documentType' && f.path !== 'recordId')
    .map((f) => ({ path: f.path, label: f.label || humanise(f.path), type: f.type, ...(f.enumValues?.length ? { enumValues: [...f.enumValues] } : {}) }));
  const languages = [SOURCE_LANGUAGE, ...projectLanguages(project).filter((l) => l !== SOURCE_LANGUAGE)].map((code) => ({ code, name: languageShortName(code) }));
  return { rules: rules.map((r) => ({ id: r.id, title: ruleWords(project, r), gives: gives(r) })), messages, sections, fields, languages };
}

/* ------------------------------------------------------------------ checking a question */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A question read by the built-in reader or a model, cleaned and checked against the document: every rule, message,
 * section, field, language and customer it names must exist. Anything else is refused with the reason, never repaired.
 */
export function checkBaseQuestion(project: Project, raw: unknown, opts: { records?: SyntheticRecord[]; /** A model's question may name `CUSTOMER_PLACEHOLDER`. */ allowPlaceholder?: boolean } = {}): { question: BaseQuestion | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(raw)) return { question: null, problems: ['The question is not in the expected shape.'] };
  const vocab = queryVocabulary(project);
  const ask = raw.ask;
  if (ask !== 'who' && ask !== 'how-many' && ask !== 'why') problems.push('“ask” must be who, how-many or why.');
  const target = checkTarget(vocab, raw.target, 'target', problems);
  const butNot = raw.butNot === undefined || raw.butNot === null ? undefined : checkTarget(vocab, raw.butNot, 'butNot', problems) ?? undefined;
  let where: FieldCondition | undefined;
  if (raw.where !== undefined && raw.where !== null) {
    const w = raw.where;
    const field = isObj(w) ? vocab.fields.find((f) => f.path === w.path) : undefined;
    if (!isObj(w) || !field) problems.push('The condition names a field this document does not have.');
    else if (!OPS.includes(w.op as FieldOp)) problems.push('The condition’s comparison is not one of is, is not, more than, at least, less than, at most.');
    else {
      const value = fieldValue(field, w.value);
      if (value === null) problems.push(`The condition’s value does not fit the field “${field.label}”.`);
      else if ((w.op === 'gt' || w.op === 'gte' || w.op === 'lt' || w.op === 'lte') && typeof value === 'boolean') problems.push(`“${field.label}” is yes or no; it cannot be more or less.`);
      else where = { path: field.path, op: w.op as FieldOp, value };
    }
  }
  let language: string | undefined;
  if (raw.language !== undefined && raw.language !== null && raw.language !== '') {
    if (typeof raw.language === 'string' && vocab.languages.some((l) => l.code === raw.language)) language = raw.language;
    else problems.push('The language is not one of this document’s languages.');
  }
  let customer: string | undefined;
  if (raw.customer !== undefined && raw.customer !== null && raw.customer !== '') {
    if (opts.allowPlaceholder && raw.customer === CUSTOMER_PLACEHOLDER) customer = CUSTOMER_PLACEHOLDER;
    else if (typeof raw.customer === 'string' && (opts.records ?? []).some((r) => r.recordId === raw.customer && r.documentType === project.documentType)) customer = raw.customer;
    else problems.push('The question names a customer this document does not have.');
  }
  if (ask === 'why' && !customer) problems.push('“Why” needs one customer.');
  if (ask !== 'why' && customer) problems.push('Only a “why” question is about one customer.');
  let issuedOn: string | undefined;
  if (raw.issuedOn !== undefined && raw.issuedOn !== null && raw.issuedOn !== '') {
    if (!isIsoDay(raw.issuedOn)) problems.push('“As issued on” must be a date written YYYY-MM-DD.');
    else if (!project.documentDate) problems.push('This document does not depend on a date, so “as issued on” does not apply.');
    else issuedOn = raw.issuedOn;
  }
  if (butNot && target && targetKey(butNot) === targetKey(target)) problems.push('“But not” names the same thing as the question.');
  if (problems.length || !target) return { question: null, problems };
  return { question: { ask: ask as BaseQuestion['ask'], target, ...(butNot ? { butNot } : {}), ...(where ? { where } : {}), ...(language ? { language } : {}), ...(customer ? { customer } : {}), ...(issuedOn ? { issuedOn } : {}) }, problems: [] };
}

function checkTarget(vocab: QueryVocabulary, t: unknown, name: string, problems: string[]): QueryTarget | null {
  if (!isObj(t)) { problems.push(`“${name}” is missing.`); return null; }
  switch (t.kind) {
    case 'rule':
      if (vocab.rules.some((r) => r.id === t.ruleId)) return { kind: 'rule', ruleId: String(t.ruleId) };
      problems.push('The question names a rule this document does not have.'); return null;
    case 'alternative': {
      const m = vocab.messages.find((x) => x.nodeId === t.nodeId);
      if (m && m.alternatives.some((a) => a.id === t.variantId)) return { kind: 'alternative', nodeId: m.nodeId, variantId: String(t.variantId) };
      // A one-text section named by its text is that section.
      const s = vocab.sections.find((x) => x.nodeId === t.nodeId && x.texts.some((tx) => tx.id === t.variantId));
      if (s) return { kind: 'section', nodeId: s.nodeId };
      problems.push('The question names a message this document does not have.'); return null;
    }
    case 'section':
      if (vocab.sections.some((s) => s.nodeId === t.nodeId)) return { kind: 'section', nodeId: String(t.nodeId) };
      problems.push('The question names a section this document does not have.'); return null;
    case 'blocker': {
      const k = t.blockerKind;
      if (k !== undefined && k !== null && k !== '' && !BLOCKER_KINDS.includes(k as BlockerKind)) { problems.push('The question names a kind of blocker that does not exist.'); return null; }
      const id = typeof t.blockerId === 'string' && t.blockerId ? t.blockerId : undefined;
      if (id && !/^[a-z0-9-]+(~[A-Za-z0-9_.+@:-]+)*$/.test(id)) { problems.push('The blocker is not one the studio names.'); return null; }
      return { kind: 'blocker', ...(k ? { blockerKind: k as BlockerKind } : {}), ...(id ? { blockerId: id } : {}) };
    }
    case 'language':
      if (vocab.languages.some((l) => l.code === t.locale)) return { kind: 'language', locale: String(t.locale) };
      problems.push('The language is not one of this document’s languages.'); return null;
    default:
      problems.push(`“${name}” is not a rule, message, section, blocker or language.`); return null;
  }
}

/** A value as the field holds it: a whole number, yes/no, one of the listed values or a date. Null when it does not fit. */
function fieldValue(f: QueryVocabulary['fields'][number], v: unknown): string | number | boolean | null {
  switch (f.type) {
    case 'int': case 'cents': case 'points': {
      // Whole numbers only; an amount is in cents, as the field holds it.
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
      return Number.isSafeInteger(n) ? n : null;
    }
    case 'bool': return v === true || v === 'true' || v === 'yes' ? true : v === false || v === 'false' || v === 'no' ? false : null;
    case 'enum': return typeof v === 'string' && (f.enumValues ?? []).includes(v) ? v : null;
    case 'date': return isIsoDay(v) ? v : null;
    default: return typeof v === 'string' && v.length <= 200 ? v : null;
  }
}

export function targetKey(t: QueryTarget): string {
  switch (t.kind) {
    case 'rule': return `rule:${t.ruleId}`;
    case 'alternative': return `alt:${t.nodeId}/${t.variantId}`;
    case 'section': return `section:${t.nodeId}`;
    case 'blocker': return `blocker:${t.blockerKind ?? ''}:${t.blockerId ?? ''}`;
    case 'language': return `language:${t.locale}`;
  }
}

/* ------------------------------------------------------------------ the question in words */

const q = (s: string): string => `“${s}”`;
const partTitleOf = (project: Project, id: string): string => project.contentParts.find((c) => c.id === id)?.title?.trim() || humanise(id);
const ruleOf = (project: Project, id: string): Rule | undefined => project.rules.find((r) => r.id === id);
const OP_WORDS: Record<FieldOp, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };

/** A blocker's plain title from a list the caller holds, else its id. */
export type BlockerTitles = ReadonlyArray<{ id: string; title: string }>;

/** What a customer gets, as a phrase: “Payment support” in Payment guidance; the section “Concentration notice”. */
export function targetWords(project: Project, t: QueryTarget, blockers?: BlockerTitles): string {
  switch (t.kind) {
    case 'rule': { const r = ruleOf(project, t.ruleId); return `a match for the rule ${q(r ? ruleWords(project, r) : t.ruleId)} (${t.ruleId})`; }
    case 'alternative': return `${q(partTitleOf(project, t.variantId))} in ${nodeWords(project, t.nodeId)}`;
    case 'section': return `the section ${q(nodeWords(project, t.nodeId))}`;
    case 'blocker': {
      if (t.blockerId) return `stopped by the blocker: ${blockers?.find((b) => b.id === t.blockerId)?.title ?? t.blockerId}`;
      return t.blockerKind ? `stopped by ${BLOCKER_KIND_WORDS[t.blockerKind]}` : 'stopped';
    }
    case 'language': return `a document in ${languageShortName(t.locale)}`;
  }
}

/** The question as the studio understood it, in one sentence, so a wrong reading is visible. */
export function questionWords(project: Project, question: BaseQuestion, opts: { customerName?: string; blockers?: BlockerTitles } = {}): string {
  const t = question.target;
  const isStopped = t.kind === 'blocker';
  // "stopped" / "stopped by a rules blocker" / "matches the rule …" / "“Payment support” in Payment guidance"
  const what = targetWords(project, t, opts.blockers);
  const rule = what.replace(/^a match for /, '');
  let s: string;
  if (question.ask === 'why') {
    const who = opts.customerName ?? (question.customer === CUSTOMER_PLACEHOLDER ? 'the customer you named' : question.customer ?? 'this customer');
    s = isStopped ? `Is ${who} ${what}, and why?` : t.kind === 'rule' ? `Does ${who} match ${rule}, and why?` : `Why does ${who} get ${what}?`;
    return s;
  }
  const lead = question.ask === 'how-many' ? 'How many customers' : 'Which customers';
  s = isStopped ? `${lead} are ${what}${question.ask === 'who' && !t.blockerId ? ', and by what' : ''}` : t.kind === 'rule' ? `${lead} match ${rule}` : `${lead} get ${what}`;
  if (question.language) s += `, among customers whose language is ${languageShortName(question.language)}`;
  if (question.butNot) s += question.butNot.kind === 'blocker' ? `, but are not ${targetWords(project, question.butNot, opts.blockers)}` : `, but not ${targetWords(project, question.butNot, opts.blockers).replace(/^a match for /, 'a match for ')}`;
  if (question.where) s += `, where ${conditionWords(project, { op: question.where.op, path: question.where.path, value: question.where.value } as never)}`;
  if (question.issuedOn) s += `, as issued on ${question.issuedOn}`;
  return `${s}?`;
}

/* ------------------------------------------------------------------ the answer */

export interface AnswerReason {
  /** A plain sentence: which rule (and its condition), the fallback, a section's own condition, a blocker. */
  text: string;
  count: number;
  recordIds: string[];
  ruleIds: string[];
}

export interface BaseAnswer {
  question: BaseQuestion;
  /** The question as the studio understood it. */
  understood: string;
  /** Customers of the document that were checked. */
  total: number;
  /** How many customers the answer is about. */
  count: number;
  recordIds: string[];
  /** "7 of 70 synthetic customers get “Payment support” in Payment guidance." */
  headline: string;
  /** Why, grouped: one line per rule (with its condition), fallback or blocker, with how many customers. */
  reasons: AnswerReason[];
  /** A short reason per customer, for the list. */
  perCustomer: Record<string, string>;
  /** What narrowed the answer ("but not", the condition, the language) and on what it was worked out. */
  notes: string[];
  /** For a `why` question: one customer, from the engine's trace. */
  why?: { recordId: string; gets: boolean; headline: string; steps: string[]; ruleIds: string[] };
  /** For a blocker question: the blockers that stop these customers, most customers first. */
  byBlocker?: Array<{ id: string; title: string; kind: BlockerKind; count: number; recordIds: string[] }>;
  basis: { profileId: ProfileId; journeyCursor: number | null; issueDate: string | null };
}

/** The blockers a caller already holds (the Blockers screen's own result): the answer then counts exactly what it shows. */
export interface HeldBlockers {
  checked: number;
  blockers: ReadonlyArray<{ id: string; kind: BlockerKind; title: string; recordIds: string[]; /** Customers not set aside as known data problems. */ openRecordIds?: string[] }>;
}

export interface AnswerOptions {
  profileId?: ProfileId;
  journeyCursor?: number | null;
  /** "As issued on" from the top bar; a question's own `issuedOn` takes precedence. */
  issueDate?: string | null;
  blockers?: HeldBlockers;
  /** Reuse an engine (the screen's, already warm). Ignored when the question's date differs from the engine's. */
  engine?: ScenarioEngine;
}

const treeOf = (res: Resolution): Map<string, RNode> => {
  const m = new Map<string, RNode>();
  const walk = (n: RNode): void => { m.set(n.id, n); n.children.forEach(walk); };
  walk(res.root);
  return m;
};

interface Row { recordId: string; res: Resolution; tree: Map<string, RNode>; locale: string; ctx: unknown }

/** Works out the answer from every customer of the document. Throws only for a question that did not pass `checkBaseQuestion`. */
export function answerBaseQuestion(project: Project, records: SyntheticRecord[], question: BaseQuestion, opts: AnswerOptions = {}): BaseAnswer {
  const issueDate = project.documentDate ? (question.issuedOn ?? opts.issueDate ?? null) : null;
  const profileId: ProfileId = opts.profileId ?? 'paged-pdf';
  const journeyCursor = opts.journeyCursor ?? null;
  const engine = opts.engine && opts.engine.project === project && opts.engine.records === records && (opts.engine.issueDate ?? null) === issueDate ? opts.engine : new ScenarioEngine(project, records, issueDate);
  const rows: Row[] = engine.universe({ journeyCursors: [journeyCursor], profiles: [profileId] }).map((s) => {
    const res = engine.resolveScenario(s);
    return { recordId: s.recordId, res, tree: treeOf(res), locale: dimensionValue('language', s, res, project).key, ctx: null };
  });
  const total = rows.length;
  const basis = { profileId, journeyCursor, issueDate };

  /* Blockers: the caller's (the screen's), or worked out here with the same function and the same day. */
  let held: HeldBlockers | null = opts.blockers ?? null;
  const needsBlockers = question.target.kind === 'blocker' || question.butNot?.kind === 'blocker';
  if (needsBlockers && (!held || question.issuedOn)) {
    const r = documentBlockers(project, records, { profileId, journeyCursor, ...(issueDate ? { issueDate } : {}) });
    held = { checked: r.checked, blockers: r.blockers.map((b) => ({ id: b.id, kind: b.kind, title: b.title, recordIds: b.recordIds })) };
  }
  const stoppedBy = (t: Extract<QueryTarget, { kind: 'blocker' }>) => (held?.blockers ?? []).filter((b) => (!t.blockerKind || b.kind === t.blockerKind) && (!t.blockerId || b.id === t.blockerId));
  const stoppedSet = (t: Extract<QueryTarget, { kind: 'blocker' }>): Set<string> => new Set(stoppedBy(t).flatMap((b) => b.openRecordIds ?? b.recordIds));

  const holds = (t: QueryTarget, row: Row, stopped?: Set<string>): boolean => {
    switch (t.kind) {
      case 'rule': return row.res.result.matchedRuleIds.includes(t.ruleId);
      case 'alternative': { const n = row.tree.get(t.nodeId); return !!n && n.visible && (n.variants?.selected ?? []).includes(t.variantId); }
      case 'section': return row.tree.get(t.nodeId)?.visible === true;
      case 'blocker': return !!stopped?.has(row.recordId);
      case 'language': return row.locale === t.locale;
    }
  };
  const targetStopped = question.target.kind === 'blocker' ? stoppedSet(question.target) : undefined;
  const butNotStopped = question.butNot?.kind === 'blocker' ? stoppedSet(question.butNot) : undefined;

  const notes: string[] = [];
  let pool = rows;
  if (question.where) {
    const w = question.where;
    pool = pool.filter((r) => compare(getPath(buildContext(r.res.effectiveRecord as SyntheticRecord), w.path), w.op, w.value));
    notes.push(`Only customers whose ${conditionWords(project, { op: w.op, path: w.path, value: w.value } as never)} are counted: ${pool.length} of ${countWords(total, 'synthetic customer')}.`);
  }
  if (question.language) {
    const before = pool.length;
    pool = pool.filter((r) => r.locale === question.language);
    notes.push(`Only customers whose language is ${languageShortName(question.language)} are counted: ${pool.length} of ${before === total ? countWords(total, 'synthetic customer') : before}.`);
  }

  const understood = questionWords(project, question, { blockers: held?.blockers });

  /* ---- why: one customer */
  if (question.ask === 'why') {
    const row = rows.find((r) => r.recordId === question.customer);
    const rec = records.find((r) => r.recordId === question.customer);
    const name = rec ? `${rec.customer.givenName} ${rec.customer.familyName}`.trim() || rec.recordId : question.customer ?? 'this customer';
    if (!row || !rec) {
      return { question, understood, total, count: 0, recordIds: [], headline: `${name} is not a customer of this document.`, reasons: [], perCustomer: {}, notes, basis };
    }
    const why = whyOne(project, question.target, row, rec, holds(question.target, row, targetStopped), { profileId, journeyCursor, issueDate }, held);
    return {
      question, understood: questionWords(project, question, { customerName: name, blockers: held?.blockers }), total, count: why.gets ? 1 : 0, recordIds: why.gets ? [row.recordId] : [],
      headline: why.headline, reasons: [], perCustomer: {}, notes, why: { recordId: row.recordId, ...why }, basis,
    };
  }

  /* ---- who / how many */
  let hits = pool.filter((r) => holds(question.target, r, targetStopped));
  if (question.butNot) {
    const before = hits.length;
    hits = hits.filter((r) => !holds(question.butNot!, r, butNotStopped));
    const left = before - hits.length;
    const one = left === 1;
    const also = question.butNot.kind === 'blocker' ? `${one ? 'is' : 'are'} also ${targetWords(project, question.butNot, held?.blockers)}` : `also ${one ? 'gets' : 'get'} ${targetWords(project, question.butNot, held?.blockers)}`;
    const firstVerb = question.target.kind === 'blocker' ? (one ? 'is stopped' : 'are stopped') : question.target.kind === 'rule' ? (one ? 'matches' : 'match') : (one ? 'gets it' : 'get it');
    notes.push(left ? `${countWords(left, 'customer')} who ${firstVerb} ${also}, so ${one ? 'is' : 'are'} left out.` : `Nobody who ${question.target.kind === 'blocker' ? 'is stopped' : question.target.kind === 'rule' ? 'matches' : 'gets it'} ${question.butNot.kind === 'blocker' ? `is also ${targetWords(project, question.butNot, held?.blockers)}` : `also gets ${targetWords(project, question.butNot, held?.blockers)}`}.`);
  }
  if (journeyCursor !== null) notes.push(`Worked out at journey step ${journeyCursor + 1}, the step chosen in the top bar.`);
  if (issueDate) notes.push(`Worked out as issued on ${issueDate}.`);

  const recordIds = hits.map((r) => r.recordId);
  const { reasons, perCustomer, byBlocker } = reasonsFor(project, question.target, hits, held);
  const n = hits.length;
  const tw = targetWords(project, question.target, held?.blockers);
  const one = n === 1;
  const pred = question.target.kind === 'blocker' ? `${one ? 'is' : 'are'} ${tw}` : question.target.kind === 'rule' ? `${one ? 'matches' : 'match'} ${tw.replace(/^a match for /, '')}` : `${one ? 'gets' : 'get'} ${tw}`;
  const headline = `${n} of ${countWords(total, 'synthetic customer')} ${pred}.`;
  return { question, understood, total, count: n, recordIds, headline, reasons, perCustomer, notes, ...(byBlocker ? { byBlocker } : {}), basis };
}

function compare(v: unknown, op: FieldOp, want: string | number | boolean): boolean {
  if (v === undefined || v === null) return false;
  if (op === 'eq') return v === want;
  if (op === 'ne') return v !== want;
  if (typeof v !== typeof want || typeof v === 'boolean') return false;
  const a = v as number | string, b = want as number | string;
  return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
}

/** "the rule “Two or more missed payments — offer support” (R03), which applies when missed payments is at least 2". */
function ruleClause(project: Project, id: string): string {
  const r = ruleOf(project, id);
  if (!r) return `the rule ${id}`;
  return `the rule ${q(ruleWords(project, r))} (${r.id}), which applies when ${conditionWords(project, r.when)}`;
}

/** Why a shown alternative or section is shown for one customer, as a groupable key and sentence. */
function shownBecause(project: Project, row: Row, nodeId: string, variantId?: string): { key: string; text: string; short: string; ruleIds: string[] } {
  const node = row.tree.get(nodeId);
  const item = node?.variants?.items.find((v) => (variantId ? v.id === variantId : v.selected));
  const nodeName = nodeWords(project, nodeId);
  if (item && item.selected) {
    if ((item.source === 'rule' || item.source === 'section-rule') && item.ruleIds.length) {
      const ids = [...item.ruleIds].sort();
      return { key: `rule:${ids.join('+')}`, text: `Chosen by ${ids.map((id) => ruleClause(project, id)).join('; and by ')}.`, short: ids.map((id) => { const r = ruleOf(project, id); return r ? ruleWords(project, r) : id; }).join(', '), ruleIds: ids };
    }
    if (item.source === 'inline') {
      const t = row.res.trace.find((x) => x.kind === 'inline-condition' && x.ruleId === `${nodeId}:${item.id}`);
      return { key: `inline:${item.id}`, text: `Shown when ${t ? conditionWords(project, t.expression) : 'its own condition holds'} (a condition set on ${nodeName}, not a rule).`, short: 'its own condition', ruleIds: [] };
    }
    if (item.source === 'fallback' || item.isFallback) return { key: 'fallback', text: `The fallback of ${nodeName}: no rule chose another message.`, short: 'the fallback', ruleIds: [] };
  }
  // A section shown by a rule, or by its own condition.
  const by = row.res.trace.filter((t) => t.kind === 'rule' && t.matched && t.targetNodeId === nodeId && t.action?.op === 'showSection');
  if (by.length) {
    const ids = by.map((t) => t.ruleId).sort();
    return { key: `rule:${ids.join('+')}`, text: `Shown by ${ids.map((id) => ruleClause(project, id)).join('; and by ')}.`, short: ids.map((id) => { const r = ruleOf(project, id); return r ? ruleWords(project, r) : id; }).join(', '), ruleIds: ids };
  }
  const own = row.res.trace.find((t) => t.ruleId === `${nodeId}:visibleWhen`);
  if (own) return { key: 'own', text: `Shown when ${conditionWords(project, own.expression)} (the section’s own condition, not a rule).`, short: 'its own condition', ruleIds: [] };
  return { key: 'always', text: `${nodeName} is part of the document whenever the parts around it are shown; no condition of its own decides it.`, short: 'no condition', ruleIds: [] };
}

function reasonsFor(project: Project, t: QueryTarget, hits: Row[], held: HeldBlockers | null): { reasons: AnswerReason[]; perCustomer: Record<string, string>; byBlocker?: BaseAnswer['byBlocker'] } {
  const groups = new Map<string, AnswerReason>();
  const perCustomer: Record<string, string> = {};
  const add = (key: string, text: string, recordId: string, ruleIds: string[]) => {
    const g = groups.get(key) ?? { text, count: 0, recordIds: [], ruleIds };
    g.count++; g.recordIds.push(recordId); groups.set(key, g);
  };
  switch (t.kind) {
    case 'alternative':
    case 'section':
      for (const row of hits) {
        const b = shownBecause(project, row, t.nodeId, t.kind === 'alternative' ? t.variantId : undefined);
        add(b.key, b.text, row.recordId, b.ruleIds);
        perCustomer[row.recordId] = b.short;
      }
      break;
    case 'rule': {
      const r = ruleOf(project, t.ruleId);
      for (const row of hits) {
        const entry: TraceEntry | undefined = row.res.trace.find((x) => x.kind === 'rule' && x.ruleId === t.ruleId);
        const outcome = entry?.outcome ?? 'applied';
        const won = outcome === 'selected' || outcome === 'applied' || outcome === 'required';
        const text = outcome === 'outranked' ? `${sentenceCase(ruleClause(project, t.ruleId))}, matches, but a rule with a higher priority decides ${r && 'targetNodeId' in r.then ? nodeWords(project, r.then.targetNodeId) : 'the outcome'}.`
          : outcome === 'tie' ? `${sentenceCase(ruleClause(project, t.ruleId))}, matches, but ties with another rule of the same priority (a blocker).`
            : `${sentenceCase(ruleClause(project, t.ruleId))}, matches${r ? ` and does what it says: ${actionLine(project, r)}` : ''}.`;
        add(`rule:${outcome}`, text, row.recordId, [t.ruleId]);
        perCustomer[row.recordId] = won ? 'matches and applies' : outcome === 'tie' ? 'matches, ties' : 'matches, outranked';
      }
      break;
    }
    case 'language': {
      const setters = project.rules.filter((r) => r.then.op === 'setApprovedLocale' && r.then.locale === t.locale);
      for (const row of hits) {
        const matched = setters.filter((r) => row.res.result.matchedRuleIds.includes(r.id)).map((r) => r.id);
        const text = matched.length ? `Their language is ${languageShortName(t.locale)}, and ${matched.map((id) => ruleClause(project, id)).join('; and ')}, uses the approved ${languageShortName(t.locale)} wording.` : `Their language is ${languageShortName(t.locale)} (from the customer’s data).`;
        add(`lang:${matched.join('+')}`, text, row.recordId, matched);
        perCustomer[row.recordId] = `language ${languageShortName(t.locale)}`;
      }
      break;
    }
    case 'blocker': {
      const list = (held?.blockers ?? []).filter((b) => (!t.blockerKind || b.kind === t.blockerKind) && (!t.blockerId || b.id === t.blockerId));
      const ids = new Set(hits.map((h) => h.recordId));
      const byBlocker = list.map((b) => { const who = (b.openRecordIds ?? b.recordIds).filter((r) => ids.has(r)); return { id: b.id, title: b.title, kind: b.kind, count: who.length, recordIds: who }; })
        .filter((b) => b.count > 0).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
      for (const b of byBlocker) groups.set(b.id, { text: `Stopped by: ${b.title}.`, count: b.count, recordIds: b.recordIds, ruleIds: [] });
      for (const row of hits) perCustomer[row.recordId] = byBlocker.filter((b) => b.recordIds.includes(row.recordId)).map((b) => b.title).join('; ');
      return { reasons: [...groups.values()], perCustomer, byBlocker };
    }
  }
  return { reasons: [...groups.values()].sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : 1)), perCustomer };
}

const sentenceCase = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
function actionLine(project: Project, r: Rule): string {
  const a = r.then;
  switch (a.op) {
    case 'selectVariant': return `${q(partTitleOf(project, a.variantId))} in ${nodeWords(project, a.targetNodeId)}`;
    case 'showSection': return `show the section ${q(nodeWords(project, a.targetNodeId))}`;
    case 'requireNodes': return 'it requires its sections';
    case 'setApprovedLocale': return `the approved ${languageShortName(a.locale)} wording`;
    case 'setPresentationHint': return `the presentation ${q(humanise(a.hint))}`;
  }
}

/** One customer: does the outcome hold, and why, from the engine's own trace (the same words as "Explain"). */
function whyOne(project: Project, t: QueryTarget, row: Row, rec: SyntheticRecord, gets: boolean, basis: { profileId: ProfileId; journeyCursor: number | null; issueDate: string | null }, held: HeldBlockers | null): { gets: boolean; headline: string; steps: string[]; ruleIds: string[] } {
  const name = `${rec.customer.givenName} ${rec.customer.familyName}`.trim() || rec.recordId;
  switch (t.kind) {
    case 'alternative':
    case 'section': {
      const ex = explainNode(project, row.res, t.kind === 'alternative' ? t.variantId : t.nodeId);
      const what = targetWords(project, t);
      void what;
      return { gets, headline: `${gets ? 'Yes' : 'No'}. ${ex.headline}`, steps: ex.steps, ruleIds: ex.ruleIds };
    }
    case 'rule': {
      const r = ruleOf(project, t.ruleId);
      const e = row.res.trace.find((x) => x.kind === 'rule' && x.ruleId === t.ruleId);
      const facts = e ? Object.entries(e.predicateInputs).map(([path, v]) => `${fieldLabel(project, path)} is ${valueWords(project, path, v)}`) : [];
      const steps = [
        `${sentenceCase(ruleClause(project, t.ruleId))}.`,
        ...(facts.length ? [`For ${name}, ${listWords(facts, 4, 'more values')}.`] : []),
        ...(e && e.matched && e.outcome === 'outranked' ? ['It matches, but a rule with a higher priority decides the outcome.'] : []),
        ...(e && !e.enabled ? ['The rule is switched off.'] : []),
        ...(e?.undecided ? [`It could not be decided: ${e.undecided.reason}`] : []),
      ];
      return { gets, headline: `${gets ? 'Yes' : 'No'}: the rule ${q(r ? ruleWords(project, r) : t.ruleId)} ${gets ? 'matches' : 'does not match'} for ${name}.`, steps, ruleIds: [t.ruleId] };
    }
    case 'language': {
      const lang = row.locale;
      return { gets, headline: `${gets ? 'Yes' : 'No'}: ${name}’s language is ${languageShortName(lang)}.`, steps: [`The language comes from the customer’s data; the document is put together in it when approved wording exists.`], ruleIds: [] };
    }
    case 'blocker': {
      const mine = held ? held.blockers.filter((b) => (b.openRecordIds ?? b.recordIds).includes(rec.recordId) && (!t.blockerKind || b.kind === t.blockerKind) && (!t.blockerId || b.id === t.blockerId)).map((b) => b.title)
        : customerBlockers(project, rec, { profileId: basis.profileId, journeyCursor: basis.journeyCursor, ...(basis.issueDate ? { issueDate: basis.issueDate } : {}) }).filter((b) => (!t.blockerKind || b.kind === t.blockerKind) && (!t.blockerId || b.id === t.blockerId)).map((b) => b.title);
      return { gets: mine.length > 0, headline: mine.length ? `Yes: ${name} is stopped by ${countWords(mine.length, 'blocker')}.` : `No: nothing ${t.blockerKind || t.blockerId ? 'of that kind ' : ''}stops ${name}.`, steps: mine.map((m) => `Stopped by: ${m}.`), ruleIds: [] };
    }
  }
}

const fieldLabel = (project: Project, path: string): string => {
  const f = projectFieldIndex(project).get(path);
  const l = f?.label ?? humanise(path.split('.').slice(-1)[0] ?? path);
  return /^[A-Z][a-z]/.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l;
};

/* ------------------------------------------------------------------ keeping customers out of what a model is sent */

/**
 * Replaces every customer's name and id in a sentence with `CUSTOMER_PLACEHOLDER` (and anything shaped like a customer
 * id), so the sentence can be given to a model. Returns the customers it found, so the studio can put the one the person
 * meant back after the model answered. Names are matched whole-word, ignoring case; longer names first.
 */
export function scrubCustomers(sentence: string, records: readonly SyntheticRecord[]): { text: string; recordIds: string[] } {
  const found = new Set<string>();
  const names: Array<{ s: string; id: string }> = [];
  for (const r of records) {
    const g = (r.customer?.givenName ?? '').trim(), f = (r.customer?.familyName ?? '').trim();
    for (const s of [`${g} ${f}`.trim(), g, f, r.recordId]) if (s.length >= 2) names.push({ s, id: r.recordId });
  }
  names.sort((a, b) => b.s.length - a.s.length);
  let text = sentence;
  for (const { s, id } of names) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'giu');
    if (re.test(text)) { found.add(id); text = text.replace(re, (_m, pre: string) => `${pre}${CUSTOMER_PLACEHOLDER}`); }
  }
  // Anything still shaped like a customer id (CARD-0001, REC-60012) never goes out either.
  text = text.replace(/\b[A-Z]{2,6}-\d{3,7}\b/gi, CUSTOMER_PLACEHOLDER);
  // The same customer named twice ("Jordan … Jordan Lee") is one placeholder each time; possessives stay readable.
  return { text, recordIds: [...found] };
}

/* ------------------------------------------------------------------ what a model may be given, and what it may answer */

/**
 * The ONLY things a model is given about the document: the names of its rules, messages and their alternatives,
 * sections, fields (label and type) and languages, plus the fixed kinds of blocker. No customer, no value, no wording.
 */
export function modelVocabulary(project: Project): {
  rules: Array<{ id: string; title: string }>;
  messages: Array<{ id: string; name: string; alternatives: Array<{ id: string; title: string }> }>;
  sections: Array<{ id: string; name: string }>;
  fields: Array<{ id: string; label: string; type: string }>;
  languages: Array<{ code: string; name: string }>;
  blockerKinds: string[];
} {
  const v = queryVocabulary(project);
  return {
    rules: v.rules.map((r) => ({ id: r.id, title: r.title })),
    messages: v.messages.map((m) => ({ id: m.nodeId, name: m.name, alternatives: m.alternatives.map((a) => ({ id: a.id, title: a.title })) })),
    sections: v.sections.map((s) => ({ id: s.nodeId, name: s.name })),
    fields: v.fields.map((f) => ({ id: f.path, label: f.label, type: f.type })),
    languages: v.languages.map((l) => ({ code: l.code, name: l.name })),
    blockerKinds: [...BLOCKER_KINDS],
  };
}

/** The flat shape a model fills in (every field always present; an empty string means "none"). */
export interface ModelQuestion {
  understood: boolean;
  ask: string;
  target_kind: string; target_id: string;
  but_not_kind: string; but_not_id: string;
  where_field: string; where_op: string; where_value: string;
  language: string;
  names_customer: boolean;
  issued_on: string;
}
export const MODEL_QUESTION_KINDS = ['rule', 'alternative', 'section', 'blocker', 'language'] as const;

/**
 * A model's answer turned into a `BaseQuestion` and checked against the document (`checkBaseQuestion`): anything it names
 * that the document does not have refuses the whole answer. A customer is only ever `CUSTOMER_PLACEHOLDER`.
 */
export function questionFromModel(project: Project, raw: unknown): { question: BaseQuestion | null; problems: string[] } {
  if (!isObj(raw)) return { question: null, problems: ['The model did not answer in the expected shape.'] };
  const o = raw as Partial<Record<keyof ModelQuestion, unknown>>;
  if (o.understood === false) return { question: null, problems: ['The model could not express this as a question about customers.'] };
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const vocab = queryVocabulary(project);
  const toTarget = (kind: string, id: string, problems: string[]): QueryTarget | null => {
    switch (kind) {
      case 'rule': return { kind: 'rule', ruleId: id };
      case 'section': return { kind: 'section', nodeId: id };
      case 'language': return { kind: 'language', locale: id };
      case 'blocker': return { kind: 'blocker', ...(id ? { blockerKind: id as BlockerKind } : {}) };
      case 'alternative': {
        const owners = vocab.messages.filter((m) => m.alternatives.some((a) => a.id === id));
        if (owners.length === 1) return { kind: 'alternative', nodeId: owners[0].nodeId, variantId: id };
        const sec = vocab.sections.find((s) => s.texts.some((t) => t.id === id));
        if (sec) return { kind: 'section', nodeId: sec.nodeId };
        problems.push('The model named a message this document does not have.');
        return null;
      }
      default: problems.push('The model named something that is not a rule, message, section, blocker or language.'); return null;
    }
  };
  const problems: string[] = [];
  const target = toTarget(str(o.target_kind), str(o.target_id), problems);
  const bk = str(o.but_not_kind);
  const butNot = bk ? toTarget(bk, str(o.but_not_id), problems) : null;
  const wf = str(o.where_field);
  let where: Record<string, unknown> | undefined;
  if (wf) {
    const field = vocab.fields.find((f) => f.path === wf);
    const wv = str(o.where_value);
    where = { path: wf, op: str(o.where_op), value: field && (field.type === 'int' || field.type === 'cents' || field.type === 'points') && /^-?\d+$/.test(wv) ? Number(wv) : wv };
  }
  if (problems.length) return { question: null, problems };
  return checkBaseQuestion(project, {
    ask: str(o.ask), target, ...(butNot ? { butNot } : {}), ...(where ? { where } : {}),
    ...(str(o.language) ? { language: str(o.language) } : {}), ...(o.names_customer === true ? { customer: CUSTOMER_PLACEHOLDER } : {}),
    ...(str(o.issued_on) ? { issuedOn: str(o.issued_on) } : {}),
  }, { allowPlaceholder: true });
}

/* ------------------------------------------------------------------ example questions from the document's own names */

/**
 * A few questions made from the open document's own names, so they always read: the first alternative a rule chooses, the
 * first conditional section, a language, two sections ("but not"), and "who is stopped".
 */
export function exampleQuestions(project: Project, records: SyntheticRecord[] = [], opts: { issueDate?: string | null; engine?: ScenarioEngine } = {}): string[] {
  const vocab = queryVocabulary(project);
  const out: string[] = [];
  // With customers: what some customer gets (and some customer in the other language), so an example rarely answers "0".
  const seen = new Set<string>(), seenOther = new Set<string>();
  const other = vocab.languages.find((l) => l.code !== SOURCE_LANGUAGE);
  if (records.length) {
    const issueDate = project.documentDate ? opts.issueDate ?? null : null;
    const engine = opts.engine && opts.engine.project === project && opts.engine.records === records && (opts.engine.issueDate ?? null) === issueDate ? opts.engine : new ScenarioEngine(project, records, issueDate);
    for (const s of engine.universe()) {
      const res = engine.resolveScenario(s);
      const tree = treeOf(res);
      const locale = dimensionValue('language', s, res, project).key;
      for (const n of tree.values()) {
        if (!n.visible) continue;
        const keys = [`section:${n.id}`, ...(n.variants?.selected ?? []).map((v) => `alt:${n.id}/${v}`)];
        for (const k of keys) { seen.add(k); if (other && locale === other.code) seenOther.add(k); }
      }
    }
  }
  const counted = (k: string, pool: Set<string>) => !records.length || pool.has(k);
  const alts = vocab.rules.flatMap((r) => (r.gives?.kind === 'alternative' ? [r.gives] : [])) as Array<Extract<QueryTarget, { kind: 'alternative' }>>;
  const alt = alts.find((a) => counted(`alt:${a.nodeId}/${a.variantId}`, seen)) ?? alts[0];
  const regions = vocab.sections.filter((s) => project.nodes.find((n) => n.id === s.nodeId)?.type === 'conditional-region');
  const shownSections = regions.filter((s) => counted(`section:${s.nodeId}`, seen));
  if (alt) out.push(`Who gets “${partTitleOf(project, alt.variantId)}”?`);
  const inOther = other ? regions.find((s) => counted(`section:${s.nodeId}`, seenOther)) : undefined;
  if (inOther && other) out.push(`Who gets “${inOther.name}” in ${other.name}?`);
  else if (shownSections[0]) out.push(`How many get “${shownSections[0].name}”?`);
  const pair = shownSections.length >= 2 ? [shownSections[0], shownSections[1]] : regions.length >= 2 ? [regions[0], regions[1]] : null;
  if (pair) out.push(`Who gets “${pair[0].name}” but not “${pair[1].name}”?`);
  out.push('Who is stopped, and by what?');
  return [...new Set(out)];
}

/** A language's names as people write them ("spanish", "spanish (us)", "es-us"). */
export function languageWords(code: string): string[] {
  return [...new Set([languageShortName(code), languageName(code), code].map((s) => s.toLowerCase()))];
}
