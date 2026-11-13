import {
  SOURCE_LANGUAGE, WORDING_RULE_SCOPE_LABEL, applyCommand, channelConfig, languageShortName, libraryOwnership, linkOfKind,
  localizeProject, projectLanguages, requiredNodeIds, setChannelString, translatableStrings,
  type ChannelConfig, type Command, type DocNode, type LibraryLink, type Project, type WordingRule, type WordingRuleScope,
} from '@iss/model';
import type { Finding } from '@iss/resolver';
import { readingLevel } from './writing';

/**
 * The wording checker (wave 2, section 4): ONE pure function over every text a customer can read, against the wording
 * rules in force — the house rules the document links to from the library, then the document's own rules.
 *
 * Pure and deterministic: no network, clock, randomness or `Intl`. It reads only the project (and, while someone types,
 * the one text being typed); it never reads a customer's data and never changes anything. Data placeholders
 * (`{{...}}`, `{name}`) and link addresses are not wording: they are masked before matching, keeping positions.
 *
 * Which texts: messages and their alternatives (content parts), notices and disclosures, labels and headings (labels,
 * table titles and column headings, chart and link text, headers and footers, message headings), the body text of
 * rich-text components, and the email and SMS wording. The studio's own fixed wording (page numbers, web controls) is not
 * the document's wording and is not checked. Each rule is checked in the English source unless it names a language;
 * then only in that language (approved translations). Reading level and tone are English only.
 */

/* ------------------------------------------------------------------ shapes */

/** The kind of text a rule can be limited to (`anywhere` covers them all). */
export type WordingTextScope = Exclude<WordingRuleScope, 'anywhere'>;

export interface WordingLinkRef { linkId: string; itemId: string; title: string; version: number }

/** A rule as it applies to a document: where it comes from (the house rules of a library item, or the document's own). */
export interface RuleInForce {
  rule: WordingRule;
  origin: 'house' | 'own';
  /** The library item and version for a house rule (null when the house rules are not linked any more). */
  link: WordingLinkRef | null;
  /** Unique in the document: `house:<id>` or `own:<id>`. */
  key: string;
  /** "Banned word or phrase “delinquent”". */
  label: string;
}

/** One text a customer can read, in one language. */
export interface WordingText {
  /** A content part id (`payment-reminder`), a string id (`@node/label`, `@title/<part>`, `@email/subject`, `@sms/text`) or `typing`. */
  id: string;
  locale: string;
  scope: WordingTextScope;
  /** "Payment reminder", "New balance · label", "Email · subject line". */
  title: string;
  text: string;
  /** The component that shows it, when there is one. */
  nodeId?: string;
  /** The content part (message or disclosure), when it is one. */
  partId?: string;
  /** Shown by a required component (mandatory content). */
  required?: boolean;
  /** The library link it comes from: read-only in the document. */
  linked?: WordingLinkRef | null;
}

export interface WordingOccurrence { start: number; end: number; match: string }

export interface WordingFinding {
  /** Stable: `<rule key>@<text id or "document">@<language>`. */
  id: string;
  ruleKey: string;
  ruleId: string;
  origin: 'house' | 'own';
  kind: WordingRule['kind'];
  severity: 'must' | 'should';
  ruleLabel: string;
  /** The house rules' library item, for a house rule. */
  ruleLink: WordingLinkRef | null;
  note?: string;
  /** The text (null for a required phrase missing from the whole document). */
  textId: string | null;
  textTitle: string | null;
  locale: string;
  scope: WordingTextScope | null;
  nodeId?: string;
  partId?: string;
  /** For a required phrase: the phrase that is missing. */
  phrase?: string;
  /** The first exact match and its position in the text (characters). */
  match?: string;
  start?: number;
  end?: number;
  /** Every match in this text. */
  occurrences: WordingOccurrence[];
  /** The mechanical fix, when the rule gives one: write this instead of each match (case adapted to each match). */
  replacement?: string;
  /** For reading level: the grade the text reads at. */
  grade?: number;
  /** Plain words: what is wrong and what the rule asks. */
  message: string;
  /** The text comes from the library: the document cannot change it. */
  linked?: WordingLinkRef | null;
}

/** Something the checker could not judge, said rather than passed or failed. */
export interface WordingNote { ruleKey: string; textId?: string; locale?: string; message: string }

export interface WordingCheck {
  rules: RuleInForce[];
  findings: WordingFinding[];
  notes: WordingNote[];
  /** How many texts were looked at (all languages). */
  textsChecked: number;
}

/* ------------------------------------------------------------------ rules in force */

const q = (s: string): string => `“${s}”`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function wordingRuleLabel(r: WordingRule): string {
  switch (r.kind) {
    case 'banned': return `Banned: ${q(r.phrase ?? '')}`;
    case 'preferred': return `Write ${q(r.replacement ?? '')}, not ${q(r.phrase ?? '')}`;
    case 'required': return `Required: ${q(r.phrase ?? '')}`;
    case 'reading-level': return `Reading level: grade ${r.limit} or easier`;
    case 'sentence-length': return `Sentences of ${r.limit} words at most`;
    case 'tone': return 'Tone: no demand for money where the document is not a bill';
  }
}

/** The house rules (from the library link, or kept after unlinking), then the document's own rules. */
export function wordingRulesInForce(project: Pick<Project, 'houseWordingRules' | 'wordingRules' | 'libraryLinks'>): RuleInForce[] {
  const l = linkOfKind(project as Project, 'wording-rules');
  const link: WordingLinkRef | null = l ? { linkId: l.linkId, itemId: l.itemId, title: l.title, version: l.version } : null;
  return [
    ...(project.houseWordingRules ?? []).map((rule) => ({ rule, origin: 'house' as const, link, key: `house:${rule.id}`, label: wordingRuleLabel(rule) })),
    ...(project.wordingRules ?? []).map((rule) => ({ rule, origin: 'own' as const, link: null, key: `own:${rule.id}`, label: wordingRuleLabel(rule) })),
  ];
}

/* ------------------------------------------------------------------ the texts a customer reads */

const linkRef = (l: LibraryLink | undefined): WordingLinkRef | null => (l ? { linkId: l.linkId, itemId: l.itemId, title: l.title, version: l.version } : null);

/** Content parts a node shows, with the node that shows each (the first one). */
function partsShown(project: Project): Map<string, DocNode> {
  const by = new Map<string, DocNode>();
  const add = (id: string, n: DocNode) => { if (!by.has(id)) by.set(id, n); };
  for (const n of project.nodes) {
    for (const v of n.variantIds ?? []) add(v, n);
    if (n.contentPartId) add(n.contentPartId, n);
    if (project.contentParts.some((c) => c.id === n.id)) add(n.id, n);
  }
  const root = project.nodes.find((n) => n.id === project.rootNodeId);
  for (const r of project.rules) if (r.then.op === 'showSection' && root) add(r.then.targetNodeId, root);
  return by;
}

function scopeOfString(id: string, kind: string, node: DocNode | undefined): WordingTextScope {
  if (id.startsWith('@sms/')) return 'sms';
  if (id.startsWith('@email/')) return 'email';
  if (id.startsWith('@title/')) return 'labels';
  if (node?.type === 'disclosure') return 'disclosures';
  if (node?.type === 'header-footer') return 'labels';
  return kind === 'label' ? 'labels' : 'messages';
}

const hasWords = (s: string | undefined): s is string => !!s && /\p{L}/u.test(mask(s));

/**
 * Every text a customer can read, in the source language and in each of `locales` (approved translations only).
 * The order is the order of Content & Translations: messages first, then labels, headings, then email and SMS.
 */
export function wordingTexts(project: Project, locales: string[] = [SOURCE_LANGUAGE]): WordingText[] {
  const own = project.libraryLinks?.length ? libraryOwnership(project) : null;
  const required = requiredNodeIds(project);
  const shown = partsShown(project);
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const strings = translatableStrings(project).filter((s) => s.kind !== 'system');
  const out: WordingText[] = [];
  for (const locale of locales) {
    const en = locale === SOURCE_LANGUAGE;
    for (const part of project.contentParts) {
      const node = shown.get(part.id);
      if (!node) continue;
      const text = part.approvedLocales[locale];
      if (!hasWords(text)) continue;
      out.push({
        id: part.id, locale, scope: part.type === 'disclosure' || node.type === 'disclosure' ? 'disclosures' : 'messages', title: part.title, text,
        nodeId: node.id, partId: part.id, required: required.has(node.id) || required.has(part.id), linked: own ? linkRef(own.parts.get(part.id)) : null,
      });
    }
    for (const s of strings) {
      const text = en ? s.source : project.strings?.[s.id]?.approved?.[locale];
      if (!hasWords(text)) continue;
      const titlePart = /^@title\/(.+)$/.exec(s.id)?.[1];
      const node = s.nodeId ? nodes.get(s.nodeId) : titlePart ? shown.get(titlePart) : undefined;
      out.push({
        id: s.id, locale, scope: scopeOfString(s.id, s.kind, node), title: s.title, text,
        ...(node ? { nodeId: node.id } : {}), ...(titlePart ? { partId: titlePart } : {}),
        required: !!node && required.has(node.id), linked: own ? linkRef(own.textOf(s.id)) : null,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ matching */

/** The text with placeholders, link addresses and markup markers replaced by spaces: same length, same positions. */
export function mask(text: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return text
    .replace(/\{\{[^{}]*\}\}/g, blank)
    .replace(/\{\w+\}/g, blank)
    .replace(/\]\([^)]*\)/g, (m) => ` ${' '.repeat(m.length - 1)}`)
    .replace(/\bhttps?:\/\/[^\s)]+/gi, blank)
    .replace(/\bwww\.[^\s)]+/gi, blank)
    .replace(/[*`[\]]/g, ' ')
    .replace(/^(\s*)(#{1,6}|[-•])(?=\s)/gm, (m, a: string, b: string) => a + ' '.repeat(b.length));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A phrase as whole words, ignoring case; any run of spaces in the phrase matches any run of spaces. */
export function phrasePattern(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Every whole-word match of `phrase` in `text` (placeholders skipped). A match that is part of `except` is not counted. */
export function findPhrase(text: string, phrase: string, except?: string): WordingOccurrence[] {
  const masked = mask(text);
  const out: WordingOccurrence[] = [];
  const re = phrasePattern(phrase);
  // A preferred form that contains the other ("account" → "your account") must not match inside itself.
  const k = except ? except.toLowerCase().indexOf(phrase.trim().toLowerCase()) : -1;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (k >= 0 && except && masked.slice(m.index - k, m.index - k + except.length).toLowerCase() === except.toLowerCase()) continue;
    out.push({ start: m.index, end: m.index + m[0].length, match: text.slice(m.index, m.index + m[0].length) });
  }
  return out;
}

/** The replacement written the way the match was: all capitals, a capital first letter, or as the rule gives it. */
export function adaptCase(match: string, replacement: string): string {
  const letters = match.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return replacement.toUpperCase();
  if (/^\p{Lu}/u.test(match) && /^\p{Ll}/u.test(replacement)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/** `text` with every given occurrence replaced (case adapted). */
export function replaceOccurrences(text: string, occurrences: readonly WordingOccurrence[], replacement: string): string {
  let out = text;
  for (const o of [...occurrences].sort((a, b) => b.start - a.start)) out = out.slice(0, o.start) + adaptCase(o.match, replacement) + out.slice(o.end);
  return out;
}

/** `text` with every whole-word use of `phrase` replaced by `replacement` (placeholders untouched). */
export function replacePhrase(text: string, phrase: string, replacement: string): string {
  return replaceOccurrences(text, findPhrase(text, phrase, replacement), replacement);
}

const normal = (s: string): string => mask(s).replace(/\s+/g, ' ').trim().toLowerCase();
/** A required phrase is present as written, ignoring case and spacing (as whole words). */
export function hasRequiredPhrase(text: string, phrase: string): boolean {
  return phrasePattern(phrase.toLowerCase()).test(normal(text));
}

/** Sentences of a text with their positions (placeholders and markup kept out of the word count). */
export function sentencesOf(text: string): Array<{ start: number; end: number; text: string; words: number }> {
  const masked = mask(text);
  const out: Array<{ start: number; end: number; text: string; words: number }> = [];
  const re = /[^.!?\n]+(?:[.!?]+|$)/gm;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const lead = /^\s*/.exec(m[0])![0].length;
    const start = m.index + lead, end = m.index + m[0].trimEnd().length;
    if (end <= start) continue;
    const words = (masked.slice(start, end).match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) ?? []).length;
    if (words) out.push({ start, end, text: text.slice(start, end), words });
  }
  return out;
}

/** The phrases the existing "reads as a demand for money" check looks for (the resolver's EOB check, same list). */
const DEMAND = /\b(you owe|owed|amount due|balance due|pay this amount|amount you owe|payment due now)\b/gi;
/** A reading level is only judged on a text of at least this many words. */
export const READING_LEVEL_MIN_WORDS = 12;

/* ------------------------------------------------------------------ the checker */

const applies = (r: WordingRule, t: Pick<WordingText, 'scope' | 'locale'>): boolean =>
  (r.appliesTo ?? 'anywhere') === 'anywhere' || r.appliesTo === t.scope ? (r.language ?? SOURCE_LANGUAGE) === t.locale : false;

/** Whether the tone rule means anything for this kind of document (the resolver's check only runs on explanations of benefits). */
export function toneApplies(project: Pick<Project, 'documentType'>): boolean { return project.documentType === 'eob'; }

const where = (t: WordingText): string => `${q(t.title)}${t.locale === SOURCE_LANGUAGE ? '' : ` (${languageShortName(t.locale)})`}`;

function textFindings(r: RuleInForce, t: WordingText, project: Pick<Project, 'documentType'>, notes: WordingNote[]): WordingFinding | null {
  const rule = r.rule;
  const base = {
    id: `${r.key}@${t.id}@${t.locale}`, ruleKey: r.key, ruleId: rule.id, origin: r.origin, kind: rule.kind, severity: rule.severity, ruleLabel: r.label, ruleLink: r.link,
    ...(rule.note ? { note: rule.note } : {}), textId: t.id, textTitle: t.title, locale: t.locale, scope: t.scope,
    ...(t.nodeId ? { nodeId: t.nodeId } : {}), ...(t.partId ? { partId: t.partId } : {}), linked: t.linked ?? null,
  };
  const withOcc = (occ: WordingOccurrence[], message: string, extra: Partial<WordingFinding> = {}): WordingFinding =>
    ({ ...base, match: occ[0].match, start: occ[0].start, end: occ[0].end, occurrences: occ, message, ...extra });
  switch (rule.kind) {
    case 'banned': {
      const occ = findPhrase(t.text, rule.phrase!, rule.replacement);
      if (!occ.length) return null;
      const times = occ.length > 1 ? ` (${occ.length} times)` : '';
      return withOcc(occ, `${where(t)} uses ${q(occ[0].match)}${times}, which the wording rules do not allow.${rule.replacement ? ` Write ${q(adaptCase(occ[0].match, rule.replacement))} instead.` : ''}`, rule.replacement ? { replacement: rule.replacement } : {});
    }
    case 'preferred': {
      const occ = findPhrase(t.text, rule.phrase!, rule.replacement);
      if (!occ.length) return null;
      return withOcc(occ, `${where(t)} writes ${q(occ[0].match)}${occ.length > 1 ? ` (${occ.length} times)` : ''}; the wording rules prefer ${q(adaptCase(occ[0].match, rule.replacement!))}.`, { replacement: rule.replacement });
    }
    case 'sentence-length': {
      const long = sentencesOf(t.text).filter((s) => s.words > rule.limit!);
      if (!long.length) return null;
      const occ = long.map((s) => ({ start: s.start, end: s.end, match: s.text }));
      const most = Math.max(...long.map((s) => s.words));
      return withOcc(occ, `${where(t)} has ${long.length === 1 ? `a sentence of ${most} words` : `${long.length} sentences longer than ${rule.limit} words (the longest has ${most})`}; the wording rules allow ${rule.limit} at most.`);
    }
    case 'reading-level': {
      const rl = readingLevel(t.text);
      if (!rl || rl.words < READING_LEVEL_MIN_WORDS) {
        notes.push({ ruleKey: r.key, textId: t.id, locale: t.locale, message: `${where(t)} is too short to judge its reading level (fewer than ${READING_LEVEL_MIN_WORDS} words), so it is neither passed nor failed.` });
        return null;
      }
      if (rl.grade <= rule.limit!) return null;
      const about = Math.round(rl.grade);
      return { ...base, match: t.text, start: 0, end: t.text.length, occurrences: [{ start: 0, end: t.text.length, match: t.text }], grade: rl.grade, message: `${where(t)} reads at about grade ${about}; the wording rules ask for grade ${rule.limit} or easier. Shorter sentences and plainer words help.` };
    }
    case 'tone': {
      if (!toneApplies(project) || t.required) return null;
      const masked = mask(t.text);
      const occ: WordingOccurrence[] = [];
      for (const m of masked.matchAll(DEMAND)) occ.push({ start: m.index!, end: m.index! + m[0].length, match: t.text.slice(m.index!, m.index! + m[0].length) });
      if (!occ.length) return null;
      return withOcc(occ, `${where(t)} says ${q(occ[0].match)}, which reads as a demand for money. An explanation of benefits is not a bill, so the wording must be neutral.`);
    }
    case 'required': return null;
  }
}

const SCOPE_WORDS: Record<WordingRuleScope, string> = { anywhere: 'anywhere in the document', messages: 'in a message', disclosures: 'in a notice or disclosure', labels: 'in a label or heading', email: 'in the email', sms: 'in the text message' };

/**
 * Checks wording against the rules in force (or `opts.rules`). Without `opts.text` it checks every text a customer reads
 * (and required phrases across the document); with it, only that one text, as the person types it (required phrases are a
 * document-level rule and are not judged on one text). Findings are in the order of the rules, then of the texts.
 */
export function checkWording(project: Project, opts: { text?: { text: string; scope: WordingTextScope; locale?: string; id?: string; title?: string }; rules?: RuleInForce[] } = {}): WordingCheck {
  const rules = opts.rules ?? wordingRulesInForce(project);
  if (!rules.length) return { rules, findings: [], notes: [], textsChecked: 0 };
  const notes: WordingNote[] = [];
  const findings: WordingFinding[] = [];
  let texts: WordingText[];
  if (opts.text) {
    texts = hasWords(opts.text.text) ? [{ id: opts.text.id ?? 'typing', locale: opts.text.locale ?? SOURCE_LANGUAGE, scope: opts.text.scope, title: opts.text.title ?? 'This text', text: opts.text.text }] : [];
  } else {
    const named = new Set(rules.map((r) => r.rule.language).filter((l): l is string => !!l && l !== SOURCE_LANGUAGE && projectLanguages(project).includes(l)));
    texts = wordingTexts(project, [SOURCE_LANGUAGE, ...named]);
  }
  for (const r of rules) {
    if ((r.rule.kind === 'tone') && !toneApplies(project)) {
      notes.push({ ruleKey: r.key, message: project.documentType === 'credit-statement' ? 'The tone rule is not checked here: a statement is a bill, so asking for payment is expected.' : 'The tone rule is checked only on explanations of benefits (documents that are not bills); this document’s kind does not say whether it is a bill.' });
      continue;
    }
    if (r.rule.kind === 'required') {
      if (opts.text) continue;
      const lang = r.rule.language ?? SOURCE_LANGUAGE;
      const pool = texts.filter((t) => applies(r.rule, t));
      if (pool.some((t) => hasRequiredPhrase(t.text, r.rule.phrase!))) continue;
      const scope = r.rule.appliesTo ?? 'anywhere';
      findings.push({
        id: `${r.key}@document@${lang}`, ruleKey: r.key, ruleId: r.rule.id, origin: r.origin, kind: 'required', severity: r.rule.severity, ruleLabel: r.label, ruleLink: r.link,
        ...(r.rule.note ? { note: r.rule.note } : {}), textId: null, textTitle: null, locale: lang, scope: scope === 'anywhere' ? null : scope, occurrences: [], phrase: r.rule.phrase,
        message: `The document must include ${q(r.rule.phrase!)} ${SCOPE_WORDS[scope]}${lang === SOURCE_LANGUAGE ? '' : ` (${languageShortName(lang)})`}, and no text ${scope === 'anywhere' ? 'has it' : `of that kind (${WORDING_RULE_SCOPE_LABEL[scope].toLowerCase()}) has it`}. It is matched as written, ignoring case and spacing.`,
      });
      continue;
    }
    if ((r.rule.kind === 'reading-level' || r.rule.kind === 'tone') && r.rule.language && r.rule.language !== SOURCE_LANGUAGE) continue;
    let short = 0;
    for (const t of texts) {
      if (!applies(r.rule, t)) continue;
      const before = notes.length;
      const f = textFindings(r, t, project, notes);
      if (!opts.text && notes.length > before) { short += notes.length - before; notes.length = before; }
      if (f) findings.push(f);
    }
    if (short) notes.push({ ruleKey: r.key, message: `${plural(short, 'text')} ${short === 1 ? 'is' : 'are'} too short to judge the reading level (fewer than ${READING_LEVEL_MIN_WORDS} words), so ${short === 1 ? 'it is' : 'they are'} neither passed nor failed.` });
  }
  return { rules, findings, notes, textsChecked: texts.length };
}

/* ------------------------------------------------------------------ into the studio's findings */

export const WORDING_CODE: Record<WordingRule['kind'], string> = {
  banned: 'WORDING_BANNED', required: 'WORDING_REQUIRED', preferred: 'WORDING_PREFERRED', 'reading-level': 'WORDING_READING_LEVEL', 'sentence-length': 'WORDING_SENTENCE_LENGTH', tone: 'WORDING_TONE',
};
export const isWordingCode = (code: string): boolean => code.startsWith('WORDING_');

/**
 * The checker's findings as studio findings: a "must" is blocking, a "should" a warning. `details.check` makes each rule and
 * text its own root cause (`blockerIdOf`); `details` carries ids, the match and its position, never a customer's data.
 */
export function wordingFindings(project: Project, check: WordingCheck = checkWording(project)): Finding[] {
  const readBy = (w: WordingFinding): string[] => readByOf(project, w);
  return check.findings.map((w) => ({
    code: WORDING_CODE[w.kind],
    severity: w.severity === 'must' ? 'blocking' : 'warning',
    ...(w.nodeId ?? w.partId ? { nodeId: w.partId ?? w.nodeId } : {}),
    ...(w.locale !== SOURCE_LANGUAGE ? { locale: w.locale } : {}),
    source: 'rules-static',
    message: `${w.message}${w.linked ? ` This text comes from the library (${q(w.linked.title)}, version ${w.linked.version}): change it there, or unlink it.` : ''}`,
    suggestion: w.replacement ? `Write ${q(w.replacement)} instead.` : w.kind === 'required' ? `Add ${q(w.phrase ?? '')} where it is expected.` : 'Reword it; “Suggest compliant wording” can propose a rewrite.',
    details: {
      check: `${w.ruleKey}@${w.textId ?? 'document'}`, findingId: w.id, wordingRule: w.ruleId, origin: w.origin, ruleLabel: w.ruleLabel, mustOrShould: w.severity,
      textId: w.textId, textTitle: w.textTitle, scope: w.scope, occurrences: w.occurrences.length, readBy: readBy(w),
      ...(w.match !== undefined && w.kind !== 'reading-level' ? { match: w.match.slice(0, 200), start: w.start, end: w.end } : {}),
      ...(w.replacement ? { replacement: w.replacement } : {}), ...(w.grade !== undefined ? { grade: w.grade } : {}),
      ...(w.linked ? { libraryItem: w.linked.itemId, libraryTitle: w.linked.title, libraryVersion: w.linked.version } : {}),
      ...(w.ruleLink ? { houseItem: w.ruleLink.itemId, houseVersion: w.ruleLink.version } : {}),
    },
  }));
}

/** Counts by rule for the "Check wording" summary: findings per rule in force, must first. */
export function wordingSummary(check: WordingCheck): Array<{ rule: RuleInForce; findings: WordingFinding[] }> {
  return check.rules.map((rule) => ({ rule, findings: check.findings.filter((f) => f.ruleKey === rule.key) }))
    .sort((a, b) => (a.rule.rule.severity === b.rule.rule.severity ? 0 : a.rule.rule.severity === 'must' ? -1 : 1));
}

/** What the release records: the rules in force (house item and version, own rules) and the counts the approved content had. */
export function wordingReleaseRecord(project: Project): { house: WordingLinkRef & { rules: number } | null; houseKept: number; own: WordingRule[]; mustFindings: number; shouldFindings: number; textsChecked: number } | null {
  const rules = wordingRulesInForce(project);
  if (!rules.length) return null;
  const check = checkWording(project, { rules });
  const house = rules.filter((r) => r.origin === 'house');
  const link = house[0]?.link ?? null;
  return {
    house: link ? { ...link, rules: house.length } : null,
    houseKept: link ? 0 : house.length,
    own: (project.wordingRules ?? []).map((r) => ({ ...r })),
    mustFindings: check.findings.filter((f) => f.severity === 'must').length,
    shouldFindings: check.findings.filter((f) => f.severity === 'should').length,
    textsChecked: check.textsChecked,
  };
}

/* ------------------------------------------------------------------ mechanical fixes */

/**
 * The commands that write new wording into texts, one undoable step when wrapped in a BATCH. English source texts change
 * the model (a message's approved English, a label, a heading, an email or SMS text); a translation becomes a draft for a
 * person to approve. Returns the reason instead when a text cannot be changed here (library, disclosure, unknown).
 */
export function setTextCommands(project: Project, edits: ReadonlyArray<{ textId: string; locale: string; text: string }>): { commands: Command[] } | { reason: string } {
  const commands: Command[] = [];
  let running = project;
  const own = project.libraryLinks?.length ? libraryOwnership(project) : null;
  for (const e of edits) {
    const linked = own?.textOf(e.textId);
    if (linked) return { reason: `It comes from the library (${q(linked.title)}, version ${linked.version}): change it there, or unlink it.` };
    let cmd: Command | null = null;
    if (e.locale !== SOURCE_LANGUAGE) cmd = { type: 'SET_TRANSLATION_DRAFT', partId: e.textId, locale: e.locale, text: e.text };
    else if (!e.textId.startsWith('@')) {
      const part = running.contentParts.find((c) => c.id === e.textId);
      if (!part) return { reason: 'That message is no longer in the document.' };
      if (part.type === 'disclosure' || running.nodes.some((n) => n.type === 'disclosure' && n.contentPartId === part.id && n.protected)) return { reason: `${q(part.title)} is approved disclosure text: it is changed with “New approved version” and a reason, by a person.` };
      cmd = { type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: { ...part.approvedLocales, [SOURCE_LANGUAGE]: e.text } } };
    } else if (e.textId.startsWith('@title/')) {
      const part = running.contentParts.find((c) => c.id === e.textId.slice(7));
      if (!part) return { reason: 'That heading is no longer in the document.' };
      if (part.type === 'disclosure') return { reason: `${q(part.title)} is approved disclosure text: it is changed with “New approved version” and a reason, by a person.` };
      cmd = { type: 'UPSERT_CONTENT_PART', part: { ...part, title: e.text } };
    } else if (e.textId.startsWith('@email/') || e.textId.startsWith('@sms/')) {
      const c = channelConfig(running);
      const next: ChannelConfig = { email: { ...c.email, sections: c.email.sections.map((s) => ({ ...s })) }, sms: { ...c.sms } };
      setChannelString(next, e.textId, e.text);
      cmd = { type: 'SET_CHANNELS', channels: next };
    } else {
      // A node's own text: the slot is written by the same code that writes translations (`localizeProject`).
      const nodeId = /^@([^/]+)\//.exec(e.textId)?.[1];
      const node = running.nodes.find((n) => n.id === nodeId);
      if (!node) return { reason: 'That text is no longer in the document.' };
      const FAKE = 'zz-ZZ';
      const probe = localizeProject({ ...running, strings: { [e.textId]: { approved: { [FAKE]: e.text } } } } as Project, FAKE);
      const after = probe.project.nodes.find((n) => n.id === nodeId)!;
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(after)) if (JSON.stringify((after as any)[k]) !== JSON.stringify((node as any)[k])) patch[k] = (after as any)[k];
      if (!Object.keys(patch).length) continue;
      cmd = { type: 'UPDATE_NODE', nodeId: node.id, patch: patch as never };
    }
    const r = applyCommand(running, cmd);
    if (!r.ok) return { reason: r.message };
    running = r.project;
    commands.push(cmd);
  }
  return { commands };
}

/** The mechanical fix of a finding: replace its matches with the rule's replacement in this text, or in every text that breaks the same rule. */
export function wordingFixFor(project: Project, findingId: string, scope: 'text' | 'all', check: WordingCheck = checkWording(project)): { commands: Command[]; texts: number; occurrences: number; title: string } | { reason: string } | null {
  const f = check.findings.find((x) => x.id === findingId);
  if (!f || !f.replacement || !f.textId) return null;
  const all = scope === 'all' ? check.findings.filter((x) => x.ruleKey === f.ruleKey && x.textId && x.replacement) : [f];
  const texts = new Map(wordingTexts(project, [...new Set(all.map((x) => x.locale))]).map((t) => [`${t.id}@${t.locale}`, t]));
  const edits: Array<{ textId: string; locale: string; text: string }> = [];
  let occurrences = 0;
  for (const x of all) {
    const t = texts.get(`${x.textId}@${x.locale}`);
    if (!t || x.linked) continue;
    edits.push({ textId: t.id, locale: t.locale, text: replaceOccurrences(t.text, x.occurrences, f.replacement) });
    occurrences += x.occurrences.length;
  }
  if (!edits.length) return { reason: f.linked ? `It comes from the library (${q(f.linked.title)}, version ${f.linked.version}): change it there, or unlink it.` : 'There is nothing to replace.' };
  const r = setTextCommands(project, edits);
  if ('reason' in r) return r;
  const n = edits.length;
  return { commands: r.commands, texts: n, occurrences, title: scope === 'all' && n > 1 ? `Replace ${q(f.match!)} with ${q(f.replacement)} in ${plural(n, 'text')}` : `Replace ${q(f.match!)} with ${q(adaptCase(f.match!, f.replacement))} in ${q(f.textTitle!)}` };
}

/** What a change did to the wording a rule is about: how many matches went and in how many texts (for a fix's effect). */
export function wordingEditEffect(before: Project, after: Project, ruleKey: string): { occurrences: number; texts: number; read: Array<{ ids: string[]; locale: string }> } {
  const b = checkWording(before).findings.filter((f) => f.ruleKey === ruleKey);
  const a = new Map(checkWording(after).findings.filter((f) => f.ruleKey === ruleKey).map((f) => [f.id, f.occurrences.length]));
  let occurrences = 0, texts = 0;
  const read: Array<{ ids: string[]; locale: string }> = [];
  for (const f of b) {
    const left = a.get(f.id) ?? 0;
    if (left < f.occurrences.length) { occurrences += f.occurrences.length - left; texts++; read.push({ ids: readByOf(before, f), locale: f.locale }); }
  }
  return { occurrences, texts, read };
}

/** Who reads a finding's text: the chosen alternative itself, or the component that shows it; nothing named = every customer. */
function readByOf(project: Project, w: WordingFinding): string[] {
  const node = project.nodes.find((n) => n.id === w.nodeId);
  return w.partId && (node?.variantIds ?? []).includes(w.partId) ? [w.partId] : w.nodeId ? [w.nodeId] : [];
}

