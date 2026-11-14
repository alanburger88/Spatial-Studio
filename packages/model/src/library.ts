import { CATALOG_BY_TYPE } from './catalog';
import { canonicalJson, digestOf, sha256Hex } from './digest';
import { isSupportedLanguage, SOURCE_LANGUAGE } from './languages';
import { validateLookupTable } from './lookup';
import { isSafeUrl, sanitizeRichDoc } from './rich';
import type {
  BrandKit, ContentPart, DocNode, GlossaryEntry, LibraryKind, LibraryLink, LibraryTarget, Locale, LookupTable, Project, StringTranslation,
  WordingRule, WordingRuleKind, WordingRuleScope,
} from './types';

/**
 * The shared library (wave 2, phase 4): one place for what many documents share — a brand, building blocks, wording,
 * a glossary, the house wording rules, lookup tables. Items live on the server in numbered versions; an approved
 * version is frozen. A document LINKS to an item at an approved version and holds a copy of its content, so the
 * resolver, the renderers, releases and the runnable package never read the library.
 *
 * Everything here is pure. Content from a client or a file is untrusted: `checkLibraryContent` validates and cleans
 * it for each kind, and the server stores only what it returns.
 */

export const LIBRARY_KINDS: readonly LibraryKind[] = ['brand', 'block', 'wording', 'glossary', 'wording-rules', 'lookup-table'];
export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = {
  brand: 'Brand', block: 'Building block', wording: 'Wording', glossary: 'Glossary', 'wording-rules': 'Wording rules', 'lookup-table': 'Lookup table',
};
/** What each kind holds, in one sentence (the Library screen and its help). */
export const LIBRARY_KIND_HINT: Record<LibraryKind, string> = {
  brand: 'Colours, font and logo',
  block: 'A header, a footer, a contact panel or any section of a page, with its wording and translations',
  wording: 'A required notice or a common message, with its approved translations',
  glossary: 'Preferred translations of recurring terms',
  'wording-rules': 'The house rules for wording',
  'lookup-table': 'A table, such as a rate by tier, used by several documents',
};
export const isLibraryKind = (v: unknown): v is LibraryKind => typeof v === 'string' && (LIBRARY_KINDS as readonly string[]).includes(v);

export const LIBRARY_TITLE_MAX = 80;
export const LIBRARY_DESCRIPTION_MAX = 300;
export const LIBRARY_NOTE_MAX = 200;
/** The content of one version, as JSON text (a brand logo is the largest thing an item normally holds). */
export const LIBRARY_CONTENT_MAX_CHARS = 1_500_000;
export const LIBRARY_BLOCK_MAX_NODES = 200;
export const LIBRARY_BLOCK_MAX_PARTS = 100;
export const LIBRARY_LINKS_MAX = 100;
export const WORDING_RULES_MAX = 200;
export const LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const LIBRARY_LINK_ID_PATTERN = /^lk[a-z0-9]{6}$/;

/* ------------------------------------------------------------------ content per kind */

/** A self-contained fragment: a component subtree (root first), the wording it uses and the translations of its texts. */
export interface LibraryBlockContent {
  nodes: DocNode[];
  contentParts: ContentPart[];
  /** Approved translations of the block's texts, keyed by string id (`@<nodeId>/<field>`, `@title/<partId>`). */
  strings?: Record<string, { approved: Record<Locale, string> }>;
}
/** One message, notice or disclosure with its approved translations (and the translations of its heading). */
export interface LibraryWordingContent {
  part: { id: string; title: string; type: 'text' | 'disclosure'; approvedLocales: Record<Locale, string> };
  titleTranslations?: Record<Locale, string>;
}
export interface LibraryGlossaryContent { entries: Record<Locale, GlossaryEntry[]> }
export interface LibraryWordingRulesContent { rules: WordingRule[] }
export interface LibraryContentByKind {
  brand: BrandKit;
  block: LibraryBlockContent;
  wording: LibraryWordingContent;
  glossary: LibraryGlossaryContent;
  'wording-rules': LibraryWordingRulesContent;
  'lookup-table': LookupTable;
}
export type LibraryContent = LibraryContentByKind[LibraryKind];

/* ------------------------------------------------------------------ server-side item shapes (shared with the studio) */

export interface LibraryActor { id: string; name: string }
export interface LibraryVersionInfo {
  version: number;
  state: 'draft' | 'approved';
  note: string;
  createdAt: string;
  createdBy: LibraryActor | null;
  updatedAt: string;
  approvedAt: string | null;
  approvedBy: LibraryActor | null;
  fingerprint: string;
}
/** Where an item was first taken from (a document and the thing in it), so that document can link to it once approved. */
export interface LibrarySource { projectId: string; projectTitle: string; ref: string }
export interface LibraryItemInfo {
  id: string;
  kind: LibraryKind;
  title: string;
  description: string;
  createdAt: string;
  createdBy: LibraryActor | null;
  source: LibrarySource | null;
  /** The latest approved version (null: none approved yet). */
  latest: number | null;
  /** The draft waiting for approval, if any (there is at most one). */
  draft: number | null;
  versions: LibraryVersionInfo[];
}
/** One document that links to an item. */
export interface LibraryUsage { projectId: string; title: string; linkId: string; version: number; behind: boolean }

/* ------------------------------------------------------------------ validation (untrusted content) */

const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const FONTS = ['Arial', 'Georgia', 'Verdana', 'Trebuchet MS'];
const HTML = /<\s*\/?\s*[a-z]/i;
const q = (s: string) => `“${s}”`;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function checkTranslations(raw: unknown, what: string, max: number, problems: string[], requireSource: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) { problems.push(`${what}: the translations cannot be read.`); return out; }
  for (const [loc, text] of Object.entries(raw)) {
    if (!isSupportedLanguage(loc)) { problems.push(`${what}: ${loc} is not a supported language.`); continue; }
    if (typeof text !== 'string' || text.length > max) { problems.push(`${what}: the ${loc} text must be text of at most ${max} characters.`); continue; }
    if (HTML.test(text)) { problems.push(`${what}: raw HTML is not allowed.`); continue; }
    if (text.trim()) out[loc] = text;
  }
  if (requireSource && !out[SOURCE_LANGUAGE]) problems.push(`${what} needs its English text.`);
  return out;
}

function checkBrand(raw: unknown, problems: string[]): BrandKit | null {
  if (!isObj(raw)) { problems.push('The brand cannot be read.'); return null; }
  if (!HEX.test(raw.primary ?? '') || !HEX.test(raw.accent ?? '') || (raw.text !== undefined && !HEX.test(raw.text))) problems.push('Brand colours must be 6-digit hex values such as #4EAF60.');
  if (raw.fontFamily !== undefined && !FONTS.includes(raw.fontFamily)) problems.push(`The brand font must be one of ${FONTS.join(', ')}.`);
  if (raw.logoDataUri !== undefined && (typeof raw.logoDataUri !== 'string' || !SAFE_IMAGE.test(raw.logoDataUri))) problems.push('The brand logo must be a PNG, JPEG or WebP image stored with the brand.');
  if (raw.logoDataUri && !(typeof raw.logoAlt === 'string' && raw.logoAlt.trim())) problems.push('A brand logo needs alternative text.');
  if (raw.logoAlt !== undefined && !isText(raw.logoAlt, 200)) problems.push('The logo description is limited to 200 characters.');
  if (problems.length) return null;
  return { primary: raw.primary, accent: raw.accent, ...(raw.text ? { text: raw.text } : {}), ...(raw.fontFamily ? { fontFamily: raw.fontFamily } : {}), ...(raw.logoDataUri ? { logoDataUri: raw.logoDataUri, logoAlt: String(raw.logoAlt).trim() } : {}) };
}

function checkPart(raw: unknown, problems: string[]): ContentPart | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !LIBRARY_ID_PATTERN.test(raw.id)) { problems.push(`A message has no valid id (${String(isObj(raw) ? raw.id : raw).slice(0, 40)}).`); return null; }
  const what = `The message ${q(raw.id)}`;
  if (!isText(raw.title, 120) || !raw.title.trim()) problems.push(`${what} needs a title (max 120 characters).`);
  if (raw.type !== 'text' && raw.type !== 'disclosure') problems.push(`${what} must be a message or a disclosure.`);
  const approvedLocales = checkTranslations(raw.approvedLocales, what, 4000, problems, true);
  return { id: raw.id, version: 1, title: String(raw.title ?? '').trim(), approvedLocales, syntheticDemoOnly: raw.syntheticDemoOnly !== false, type: raw.type === 'disclosure' ? 'disclosure' : 'text' };
}

/** Every content-part id a node refers to (the wording it shows). */
export function partRefsOf(n: DocNode): string[] {
  return [...new Set([...(n.contentPartId ? [n.contentPartId] : []), ...(n.variantIds ?? []), ...(n.fallbackVariantId ? [n.fallbackVariantId] : [])])];
}

function checkBlock(raw: unknown, problems: string[]): LibraryBlockContent | null {
  if (!isObj(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.contentParts ?? [])) { problems.push('The building block cannot be read.'); return null; }
  if (!raw.nodes.length) { problems.push('A building block needs at least one component.'); return null; }
  if (raw.nodes.length > LIBRARY_BLOCK_MAX_NODES) { problems.push(`A building block holds at most ${LIBRARY_BLOCK_MAX_NODES} components.`); return null; }
  if ((raw.contentParts ?? []).length > LIBRARY_BLOCK_MAX_PARTS) { problems.push(`A building block holds at most ${LIBRARY_BLOCK_MAX_PARTS} messages.`); return null; }
  const nodes: DocNode[] = [];
  const ids = new Set<string>();
  for (const n of raw.nodes as unknown[]) {
    if (!isObj(n) || typeof n.id !== 'string' || !LIBRARY_ID_PATTERN.test(n.id)) { problems.push('A component of the block has no valid id.'); continue; }
    if (ids.has(n.id)) { problems.push(`Two components of the block share the id ${q(n.id)}.`); continue; }
    if (typeof n.type !== 'string' || !(n.type in CATALOG_BY_TYPE)) { problems.push(`The component ${q(n.id)} is of an unknown kind.`); continue; }
    ids.add(n.id);
    const node = JSON.parse(JSON.stringify(n)) as DocNode;
    if (node.content !== undefined) node.content = sanitizeRichDoc(node.content).doc;
    if (node.action && !isSafeUrl(node.action.url)) problems.push(`The link in ${q(n.name ?? n.id)} is not a safe https:// address.`);
    if (node.qr && !isSafeUrl(node.qr.url)) problems.push(`The QR destination in ${q(n.name ?? n.id)} is not a safe https:// address.`);
    const src = node.image?.src;
    if (src !== undefined && !(typeof src === 'string' && (SAFE_IMAGE.test(src) || /^asset:[a-z0-9-]+$/.test(src)))) problems.push(`The image ${q(n.name ?? n.id)} must be stored with the block (PNG, JPEG or WebP).`);
    if (node.children !== undefined && (!Array.isArray(node.children) || node.children.some((c) => typeof c !== 'string'))) problems.push(`The component ${q(n.id)} has a broken list of contents.`);
    nodes.push(node);
  }
  if (problems.length) return null;
  // One tree: the first component is the root and every other one is reached from it exactly once.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([nodes[0].id]);
  const walk = (id: string, depth: number) => {
    if (depth > 40) { problems.push('The building block is nested too deeply.'); return; }
    for (const c of byId.get(id)?.children ?? []) {
      if (!byId.has(c)) { problems.push(`The component ${q(id)} contains ${q(c)}, which is not in the block.`); continue; }
      if (seen.has(c)) { problems.push(`The component ${q(c)} appears twice in the block.`); continue; }
      seen.add(c); walk(c, depth + 1);
    }
  };
  walk(nodes[0].id, 0);
  for (const n of nodes) if (!seen.has(n.id)) problems.push(`The component ${q(n.id)} is not inside the block's first component.`);
  const parts: ContentPart[] = [];
  const partIds = new Set<string>();
  for (const p of raw.contentParts ?? []) {
    const part = checkPart(p, problems);
    if (!part) continue;
    if (partIds.has(part.id)) problems.push(`Two messages of the block share the id ${q(part.id)}.`);
    partIds.add(part.id); parts.push(part);
  }
  for (const n of nodes) for (const ref of partRefsOf(n)) if (!partIds.has(ref)) problems.push(`${q(n.name ?? n.id)} uses the message ${q(ref)}, which is not in the block.`);
  let strings: LibraryBlockContent['strings'];
  if (raw.strings !== undefined) {
    if (!isObj(raw.strings)) problems.push('The translations of the block cannot be read.');
    else {
      strings = {};
      for (const [id, t] of Object.entries(raw.strings)) {
        const m = /^@([^/]+)\/(.+)$/.exec(id);
        const owner = m ? (m[1] === 'title' ? partIds.has(m[2]) : ids.has(m[1])) : false;
        if (!owner) { problems.push(`The block has a translation for ${q(id.slice(0, 60))}, which is not one of its texts.`); continue; }
        const approved = checkTranslations(isObj(t) ? t.approved : null, `The translation of ${q(id.slice(0, 60))}`, 4000, problems, false);
        delete approved[SOURCE_LANGUAGE];
        if (Object.keys(approved).length) strings[id] = { approved };
      }
      if (!Object.keys(strings).length) strings = undefined;
    }
  }
  if (problems.length) return null;
  return { nodes, contentParts: parts, ...(strings ? { strings } : {}) };
}

function checkWording(raw: unknown, problems: string[]): LibraryWordingContent | null {
  if (!isObj(raw) || !isObj(raw.part)) { problems.push('The wording cannot be read.'); return null; }
  const part = checkPart(raw.part, problems);
  let titleTranslations: Record<string, string> | undefined;
  if (raw.titleTranslations !== undefined) {
    titleTranslations = checkTranslations(raw.titleTranslations, 'The heading', 200, problems, false);
    delete titleTranslations[SOURCE_LANGUAGE];
    if (!Object.keys(titleTranslations).length) titleTranslations = undefined;
  }
  if (problems.length || !part) return null;
  return { part: { id: part.id, title: part.title, type: part.type, approvedLocales: part.approvedLocales as Record<string, string> }, ...(titleTranslations ? { titleTranslations } : {}) };
}

function checkGlossary(raw: unknown, problems: string[]): LibraryGlossaryContent | null {
  if (!isObj(raw) || !isObj(raw.entries)) { problems.push('The glossary cannot be read.'); return null; }
  const entries: Record<string, GlossaryEntry[]> = {};
  for (const [loc, list] of Object.entries(raw.entries)) {
    if (!isSupportedLanguage(loc) || loc === SOURCE_LANGUAGE) { problems.push(`${loc} is not a target language a glossary can be kept for.`); continue; }
    if (!Array.isArray(list) || list.length > 200) { problems.push(`The ${loc} glossary must be a list of at most 200 terms.`); continue; }
    const seen = new Set<string>();
    const clean: GlossaryEntry[] = [];
    for (const e of list) {
      const source = typeof e?.source === 'string' ? e.source.trim() : '', target = typeof e?.target === 'string' ? e.target.trim() : '';
      if (!source || !target) { problems.push('Every glossary term needs the English term and its translation.'); break; }
      if (source.length > 80 || target.length > 80 || (e.note !== undefined && !isText(e.note, 200))) { problems.push('Glossary terms are limited to 80 characters and notes to 200.'); break; }
      if (/[<>{}]/.test(source + target)) { problems.push('Glossary terms cannot contain <, >, { or }.'); break; }
      if (seen.has(source.toLowerCase())) { problems.push(`${q(source)} is listed twice in the ${loc} glossary.`); break; }
      seen.add(source.toLowerCase());
      clean.push({ source, target, ...(typeof e.note === 'string' && e.note.trim() ? { note: e.note.trim() } : {}) });
    }
    if (clean.length) entries[loc] = clean;
  }
  if (!problems.length && !Object.keys(entries).length) problems.push('A glossary needs at least one term.');
  return problems.length ? null : { entries };
}

const WORDING_RULE_KINDS: readonly WordingRuleKind[] = ['banned', 'required', 'preferred', 'reading-level', 'sentence-length', 'tone'];
const WORDING_RULE_SCOPES: readonly WordingRuleScope[] = ['anywhere', 'messages', 'disclosures', 'labels', 'email', 'sms'];
export const WORDING_RULE_KIND_LABEL: Record<WordingRuleKind, string> = {
  banned: 'Banned word or phrase', required: 'Required phrase', preferred: 'Preferred spelling or term', 'reading-level': 'Reading level', 'sentence-length': 'Sentence length', tone: 'Tone',
};

/** Checks one rule and returns it cleaned (only the fields its kind uses), or the problems. */
export function checkWordingRule(raw: unknown): { rule: WordingRule | null; problems: string[] } {
  const p: string[] = [];
  if (!isObj(raw)) return { rule: null, problems: ['A wording rule cannot be read.'] };
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = id ? `Wording rule ${q(id)}` : 'A wording rule';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) p.push(`${name} needs an id of lower-case letters, digits or dashes (max 40).`);
  if (!WORDING_RULE_KINDS.includes(raw.kind)) p.push(`${name} must be one of: ${WORDING_RULE_KINDS.join(', ')}.`);
  if (raw.severity !== 'must' && raw.severity !== 'should') p.push(`${name} must be a “must” or a “should”.`);
  const kind = raw.kind as WordingRuleKind;
  const phraseOk = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[<>{}]/.test(v);
  const needsPhrase = kind === 'banned' || kind === 'required' || kind === 'preferred';
  if (needsPhrase && !phraseOk(raw.phrase)) p.push(`${name} needs the phrase it is about (max 200 characters, no <, >, { or }).`);
  if (!needsPhrase && raw.phrase !== undefined) p.push(`${name} does not take a phrase.`);
  if (kind === 'preferred' && !phraseOk(raw.replacement)) p.push(`${name} needs the preferred form.`);
  if (kind === 'banned' && raw.replacement !== undefined && !phraseOk(raw.replacement)) p.push(`${name}: the replacement must be text (max 200 characters).`);
  if (kind !== 'banned' && kind !== 'preferred' && raw.replacement !== undefined) p.push(`${name} does not take a replacement.`);
  if (raw.appliesTo !== undefined && !WORDING_RULE_SCOPES.includes(raw.appliesTo)) p.push(`${name} applies to one of: ${WORDING_RULE_SCOPES.join(', ')}.`);
  if (kind === 'reading-level' && !(Number.isInteger(raw.limit) && raw.limit >= 1 && raw.limit <= 18)) p.push(`${name} needs a grade from 1 to 18.`);
  if (kind === 'sentence-length' && !(Number.isInteger(raw.limit) && raw.limit >= 5 && raw.limit <= 100)) p.push(`${name} needs a number of words from 5 to 100.`);
  if (kind !== 'reading-level' && kind !== 'sentence-length' && raw.limit !== undefined) p.push(`${name} does not take a limit.`);
  if (raw.language !== undefined && (typeof raw.language !== 'string' || !isSupportedLanguage(raw.language))) p.push(`${name}: ${String(raw.language)} is not a supported language.`);
  if ((kind === 'reading-level' || kind === 'tone') && raw.language !== undefined && raw.language !== SOURCE_LANGUAGE) p.push(`${name} can only check English.`);
  if (raw.note !== undefined && !isText(raw.note, 300)) p.push(`${name}: the note is limited to 300 characters.`);
  const known = new Set(['id', 'kind', 'severity', 'phrase', 'replacement', 'appliesTo', 'limit', 'language', 'note']);
  const extra = Object.keys(raw).filter((k) => !known.has(k));
  if (extra.length) p.push(`${name} has fields a wording rule does not have (${extra.slice(0, 3).join(', ')}).`);
  if (p.length) return { rule: null, problems: p };
  const rule: WordingRule = {
    id, kind, severity: raw.severity,
    ...(needsPhrase ? { phrase: raw.phrase.trim() } : {}),
    ...(raw.replacement !== undefined ? { replacement: String(raw.replacement).trim() } : {}),
    ...(raw.appliesTo !== undefined ? { appliesTo: raw.appliesTo } : {}),
    ...(raw.limit !== undefined ? { limit: raw.limit } : {}),
    ...(raw.language !== undefined ? { language: raw.language } : {}),
    ...(typeof raw.note === 'string' && raw.note.trim() ? { note: raw.note.trim() } : {}),
  };
  return { rule, problems: [] };
}

/** Problems with a list of house wording rules (empty = valid). Ids must be unique; at most `WORDING_RULES_MAX`. */
export function validateWordingRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['The wording rules must be a list.'];
  if (raw.length > WORDING_RULES_MAX) return [`A list of wording rules holds at most ${WORDING_RULES_MAX} rules.`];
  const out: string[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    const c = checkWordingRule(r);
    out.push(...c.problems);
    if (c.rule) { if (ids.has(c.rule.id)) out.push(`Two wording rules share the id ${q(c.rule.id)}.`); ids.add(c.rule.id); }
  }
  return out.slice(0, 20);
}

/* ------------------------------------------------------------------ house rules and the document's own (section 4) */

/** Where a rule applies, in words ("Messages", "Anywhere a customer reads"). */
export const WORDING_RULE_SCOPE_LABEL: Record<WordingRuleScope, string> = {
  anywhere: 'Anywhere a customer reads', messages: 'Messages and alternatives', disclosures: 'Notices and disclosures', labels: 'Labels and headings', email: 'Email', sms: 'Text message',
};
export const WORDING_RULE_KINDS_LIST = WORDING_RULE_KINDS;
export const WORDING_RULE_SCOPES_LIST = WORDING_RULE_SCOPES;

/** What makes two rules "the same rule": the kind, the phrase (ignoring case and spacing) and the language. */
export function wordingRuleKey(r: Pick<WordingRule, 'kind' | 'phrase' | 'language'>): string {
  return [r.kind, (r.phrase ?? '').trim().replace(/\s+/g, ' ').toLowerCase(), r.language ?? ''].join('|');
}

/** The house rule an own rule would weaken: a "must" with the same kind and phrase that the own rule makes a "should". */
export function weakenedHouseRule(project: Pick<Project, 'houseWordingRules'>, rule: Pick<WordingRule, 'kind' | 'phrase' | 'language' | 'severity'>): WordingRule | null {
  if (rule.severity !== 'should') return null;
  const key = wordingRuleKey(rule);
  return (project.houseWordingRules ?? []).find((h) => h.severity === 'must' && wordingRuleKey(h) === key) ?? null;
}

/**
 * Why an own wording rule cannot be added (or replace the own rule `replacing`), in plain words, or null. Checks the
 * rule itself, a unique id (among the house rules too), and that it does not weaken a house "must" rule.
 */
export function ownWordingRuleProblem(project: Pick<Project, 'houseWordingRules' | 'wordingRules'>, raw: unknown, replacing?: string): string | null {
  const c = checkWordingRule(raw);
  if (!c.rule) return c.problems[0];
  const rule = c.rule;
  const own = project.wordingRules ?? [];
  if (own.some((r) => r.id === rule.id && r.id !== replacing)) return `This document already has a wording rule with the id ${q(rule.id)}.`;
  if ((project.houseWordingRules ?? []).some((r) => r.id === rule.id)) return `The id ${q(rule.id)} is used by a house rule. Give this rule another id.`;
  if (replacing === undefined && own.length >= WORDING_RULES_MAX) return `A document can have at most ${WORDING_RULES_MAX} wording rules of its own.`;
  const weak = weakenedHouseRule(project, rule);
  if (weak) {
    const what = weak.phrase ? `${q(weak.phrase)} (${WORDING_RULE_KIND_LABEL[weak.kind].toLowerCase()})` : `the ${WORDING_RULE_KIND_LABEL[weak.kind].toLowerCase()} rule`;
    return `The house rules make ${what} a “must”. A document’s own rule can add to the house rules but cannot weaken them, so it cannot make this a “should”.`;
  }
  return null;
}

/** A free id for a new own rule of this kind ("banned-2"), never one a house rule uses. */
export function nextWordingRuleId(project: Pick<Project, 'houseWordingRules' | 'wordingRules'>, kind: WordingRuleKind): string {
  const used = new Set([...(project.houseWordingRules ?? []), ...(project.wordingRules ?? [])].map((r) => r.id));
  for (let i = 1; ; i++) { const id = `${kind}-${i}`; if (!used.has(id)) return id; }
}

/**
 * Only an admin sets whether a house rule is a "must" or a "should". For anyone else, every rule that was already in
 * `base` (the latest approved version, or the draft being edited) keeps its severity, and a new rule must be a "should"
 * (an admin can raise it). Null when the change is allowed. The server enforces it; the Library screen explains it.
 */
export function wordingSeverityProblem(base: readonly WordingRule[] | null, next: readonly WordingRule[], isAdmin: boolean): string | null {
  if (isAdmin) return null;
  const before = new Map((base ?? []).map((r) => [r.id, r.severity]));
  for (const r of next) {
    const was = before.get(r.id);
    if (was !== undefined && was !== r.severity) return `Only an admin can change whether a rule is a “must” or a “should” (${q(r.phrase ?? r.id)} was a “${was}”).`;
    if (was === undefined && r.severity === 'must') return `Only an admin can make a rule a “must” (${q(r.phrase ?? r.id)}). Save it as a “should”; an admin can raise it.`;
  }
  return null;
}

function checkWordingRules(raw: unknown, problems: string[]): LibraryWordingRulesContent | null {
  if (!isObj(raw)) { problems.push('The wording rules cannot be read.'); return null; }
  const errs = validateWordingRules(raw.rules);
  if (errs.length) { problems.push(...errs); return null; }
  return { rules: (raw.rules as unknown[]).map((r) => checkWordingRule(r).rule!) };
}

/**
 * Validates untrusted content for a kind and returns it cleaned (only what the kind holds), or every problem found.
 * Used by the server before anything is stored, and by the link commands. Never throws.
 */
export function checkLibraryContent<K extends LibraryKind>(kind: K, raw: unknown): { ok: true; content: LibraryContentByKind[K] } | { ok: false; problems: string[] } {
  if (!isLibraryKind(kind)) return { ok: false, problems: [`${String(kind)} is not a kind of library item.`] };
  let size: number;
  try { size = canonicalJson(raw ?? null).length; } catch { return { ok: false, problems: ['The content cannot be read.'] }; }
  if (size > LIBRARY_CONTENT_MAX_CHARS) return { ok: false, problems: [`The content is too large (${Math.round(size / 1000)} kB; the most is ${LIBRARY_CONTENT_MAX_CHARS / 1000} kB).`] };
  const problems: string[] = [];
  let content: unknown = null;
  switch (kind) {
    case 'brand': content = checkBrand(raw, problems); break;
    case 'block': content = checkBlock(raw, problems); break;
    case 'wording': content = checkWording(raw, problems); break;
    case 'glossary': content = checkGlossary(raw, problems); break;
    case 'wording-rules': content = checkWordingRules(raw, problems); break;
    case 'lookup-table': {
      const errs = validateLookupTable(raw as LookupTable);
      if (errs.length) problems.push(...errs);
      else { const t = raw as LookupTable; content = JSON.parse(JSON.stringify({ id: t.id, title: t.title.trim(), ...(t.description?.trim() ? { description: t.description.trim() } : {}), keys: t.keys, columns: t.columns, rows: t.rows, ...(t.defaultRow ? { defaultRow: t.defaultRow } : {}) })); }
      break;
    }
  }
  if (problems.length || !content) return { ok: false, problems: problems.length ? problems.slice(0, 20) : ['The content cannot be read.'] };
  return { ok: true, content: content as LibraryContentByKind[K] };
}

/** The fingerprint a link records: the digest of the version's content as the library holds it. */
export const libraryContentFingerprint = (content: unknown): string => digestOf(content);

/* ------------------------------------------------------------------ taking content from a document ("Add to library") */

/** Names in a document a library item can be made from. `ref` is a node id, a part id or a table id; ignored for the others. */
export function libraryContentFromProject(project: Project, kind: LibraryKind, ref?: string): { content: LibraryContent; title: string } | { error: string } {
  switch (kind) {
    case 'brand':
      return project.brand ? { content: JSON.parse(JSON.stringify(project.brand)), title: `${project.issuer.name} brand` } : { error: 'This document has no brand kit yet. Set its colours first.' };
    case 'glossary': {
      const entries = project.glossary ?? {};
      return Object.values(entries).some((l) => l?.length) ? { content: { entries: JSON.parse(JSON.stringify(entries)) }, title: `${project.title} glossary` } : { error: 'This document’s glossary is empty.' };
    }
    case 'wording-rules': {
      // The rules in force: the house rules the document follows, then its own (an own rule never shares a house rule's id).
      const rules = [...(project.houseWordingRules ?? []), ...(project.wordingRules ?? [])];
      return rules.length ? { content: { rules: JSON.parse(JSON.stringify(rules)) }, title: 'House wording rules' } : { error: 'This document has no wording rules.' };
    }
    case 'lookup-table': return lookupTableLibraryContent(project, ref ?? '');
    case 'wording': {
      const part = project.contentParts.find((c) => c.id === ref);
      if (!part) return { error: `There is no message ${ref}.` };
      const titles = project.strings?.[`@title/${part.id}`]?.approved;
      const content: LibraryWordingContent = { part: { id: part.id, title: part.title, type: part.type, approvedLocales: { ...(part.approvedLocales as Record<string, string>) } }, ...(titles && Object.keys(titles).length ? { titleTranslations: { ...titles } } : {}) };
      return { content, title: part.title };
    }
    case 'block': {
      const byId = new Map(project.nodes.map((n) => [n.id, n]));
      const root = byId.get(ref ?? '');
      if (!root) return { error: `There is no component ${ref}.` };
      if (root.id === project.rootNodeId) return { error: 'The whole document cannot be a building block. Choose one of its components.' };
      const ids: string[] = [];
      const walk = (id: string) => { ids.push(id); for (const c of byId.get(id)?.children ?? []) walk(c); };
      walk(root.id);
      const nodes = ids.map((id) => {
        const n = JSON.parse(JSON.stringify(byId.get(id)!)) as DocNode;
        // Where the block sits on the page belongs to each document that uses it.
        if (id === root.id) delete n.layout;
        return n;
      });
      const partIds = new Set(nodes.flatMap(partRefsOf));
      const contentParts = project.contentParts.filter((c) => partIds.has(c.id)).map((c) => ({ id: c.id, version: 1, title: c.title, approvedLocales: { ...c.approvedLocales }, syntheticDemoOnly: c.syntheticDemoOnly, type: c.type }));
      const strings: Record<string, { approved: Record<string, string> }> = {};
      for (const [id, t] of Object.entries(project.strings ?? {})) {
        const m = /^@([^/]+)\/(.+)$/.exec(id);
        const mine = m && (m[1] === 'title' ? partIds.has(m[2]) : ids.includes(m[1]));
        if (mine && t.approved && Object.keys(t.approved).length) strings[id] = { approved: { ...t.approved } };
      }
      return { content: withoutLinkPrefix({ nodes, contentParts: contentParts as ContentPart[], ...(Object.keys(strings).length ? { strings } : {}) }), title: root.name ?? root.label ?? root.id };
    }
  }
}

/**
 * For the Lookup tables screen (its owner wires the button): the content of a library item made from one of the
 * document's lookup tables, and a title for it. Send it to `api.createLibraryItem({ kind: 'lookup-table', … })`.
 */
export function lookupTableLibraryContent(project: Project, tableId: string): { content: LookupTable; title: string } | { error: string } {
  const t = (project.lookupTables ?? []).find((x) => x.id === tableId);
  if (!t) return { error: `There is no lookup table ${tableId}.` };
  return { content: JSON.parse(JSON.stringify(t)), title: t.title };
}

/* ------------------------------------------------------------------ placing content in a document */

/** The document id of a block's node or message: the library id with the link's prefix (shortened by a digest when too long). */
export function blockId(prefix: string, id: string): string {
  const full = `${prefix}${id}`;
  return full.length <= 64 ? full : `${prefix}${sha256Hex(id).slice(0, 64 - prefix.length)}`;
}
/** The prefix a block inserted by a link gets: derived from the link id, so ids stay the same across updates. */
export const blockPrefixFor = (linkId: string): string => `${linkId}-`;

/** A deterministic, unused link id for a new link. */
export function nextLinkId(project: Project, itemId: string): string {
  const used = new Set((project.libraryLinks ?? []).map((l) => l.linkId));
  for (let i = 0; ; i++) {
    const id = `lk${sha256Hex(`${itemId}|${project.projectId}|${project.modelVersion}|${i}`).replace(/[^a-z0-9]/g, '').slice(0, 6)}`;
    if (!used.has(id)) return id;
  }
}

/** A block with every node and message id renamed (and every reference to one). */
function renameBlock(content: LibraryBlockContent, m: (id: string) => string): LibraryBlockContent {
  const nodes = content.nodes.map((src) => {
    const n = JSON.parse(JSON.stringify(src)) as DocNode;
    n.id = m(n.id);
    if (n.children) n.children = n.children.map(m);
    if (n.contentPartId) n.contentPartId = m(n.contentPartId);
    if (n.variantIds) n.variantIds = n.variantIds.map(m);
    if (n.fallbackVariantId) n.fallbackVariantId = m(n.fallbackVariantId);
    if (n.variantConditions) n.variantConditions = Object.fromEntries(Object.entries(n.variantConditions).map(([k, v]) => [m(k), v]));
    if (n.variantPeriods) n.variantPeriods = Object.fromEntries(Object.entries(n.variantPeriods).map(([k, v]) => [m(k), v]));
    return n;
  });
  const contentParts = content.contentParts.map((p) => ({ ...JSON.parse(JSON.stringify(p)), id: m(p.id) }) as ContentPart);
  const strings: NonNullable<LibraryBlockContent['strings']> = {};
  for (const [id, t] of Object.entries(content.strings ?? {})) {
    const mm = /^@([^/]+)\/(.+)$/.exec(id)!;
    strings[mm[1] === 'title' ? `@title/${m(mm[2])}` : `@${m(mm[1])}/${mm[2]}`] = { approved: { ...t.approved } };
  }
  return { nodes, contentParts, ...(content.strings ? { strings } : {}) };
}

/** The block's nodes, messages and translations with document ids. Styles the document does not have are dropped. */
export function mapBlock(content: LibraryBlockContent, prefix: string, project: Project): { nodes: DocNode[]; parts: ContentPart[]; strings: Record<string, StringTranslation> } {
  const renamed = renameBlock(content, (id) => blockId(prefix, id));
  const styles = new Set((project.styles ?? []).map((s) => s.id));
  for (const n of renamed.nodes) if (n.styleId && !styles.has(n.styleId)) delete n.styleId;
  return { nodes: renamed.nodes, parts: renamed.contentParts.map((p) => ({ ...p, version: 1 })), strings: renamed.strings ?? {} };
}

/**
 * A block taken from a document that once inserted it from the library carries the link's prefix on every id. The prefix
 * is taken off again, so a new version made from that document keeps the library's ids (and every other document's).
 */
function withoutLinkPrefix(content: LibraryBlockContent): LibraryBlockContent {
  const m = /^(lk[a-z0-9]{6}-)/.exec(content.nodes[0]?.id ?? '');
  if (!m) return content;
  const prefix = m[1];
  const all = [...content.nodes.map((n) => n.id), ...content.contentParts.map((p) => p.id)];
  if (!all.every((id) => id.startsWith(prefix) && LIBRARY_ID_PATTERN.test(id.slice(prefix.length)))) return content;
  return renameBlock(content, (id) => id.slice(prefix.length));
}

/** What a block link occupies in the document now: its nodes (root first), its messages and its translation ids. */
export function blockMembers(project: Project, rootNodeId: string): { nodeIds: string[]; partIds: string[]; stringIds: string[] } {
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const nodeIds: string[] = [];
  const walk = (id: string) => { if (!byId.has(id) || nodeIds.includes(id)) return; nodeIds.push(id); for (const c of byId.get(id)!.children ?? []) walk(c); };
  walk(rootNodeId);
  const partSet = new Set(nodeIds.flatMap((id) => partRefsOf(byId.get(id)!)));
  const partIds = project.contentParts.filter((c) => partSet.has(c.id)).map((c) => c.id);
  const nodeSet = new Set(nodeIds);
  const stringIds = Object.keys(project.strings ?? {}).filter((id) => {
    const mm = /^@([^/]+)\/(.+)$/.exec(id);
    return !!mm && (mm[1] === 'title' ? partSet.has(mm[2]) : nodeSet.has(mm[1]));
  });
  return { nodeIds, partIds, stringIds };
}

/* ------------------------------------------------------------------ linked content is read-only */

const strip = <T extends object>(o: T | undefined, keys: string[]): unknown => {
  if (!o) return null;
  const c: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  for (const k of keys) delete c[k];
  return c;
};

/**
 * Digest of the content a link holds in the document, as the document holds it now. Anything that changes it changes
 * linked content. The block's position and its root's layout belong to the document; version counters do not count.
 */
export function placedDigest(project: Project, link: LibraryLink): string {
  const t = link.target;
  switch (t.kind) {
    case 'brand': return digestOf(project.brand ?? null);
    case 'glossary': return digestOf(project.glossary ?? null);
    case 'wording-rules': return digestOf(project.houseWordingRules ?? null);
    case 'lookup-table': return digestOf((project.lookupTables ?? []).find((x) => x.id === t.tableId) ?? null);
    case 'wording': {
      const part = project.contentParts.find((c) => c.id === t.partId);
      return digestOf({ part: strip(part, ['version']), title: project.strings?.[`@title/${t.partId}`] ?? null });
    }
    case 'block': {
      const mem = blockMembers(project, t.rootNodeId);
      const byId = new Map(project.nodes.map((n) => [n.id, n]));
      return digestOf({
        nodes: mem.nodeIds.map((id) => (id === t.rootNodeId ? strip(byId.get(id), ['layout']) : byId.get(id))),
        parts: mem.partIds.map((id) => strip(project.contentParts.find((c) => c.id === id), ['version'])),
        strings: Object.fromEntries(mem.stringIds.map((id) => [id, project.strings![id]])),
      });
    }
  }
}

/** “Contact panel” (building block, version 3) */
export const linkWords = (link: Pick<LibraryLink, 'title' | 'kind' | 'version'>): string => `“${link.title}” (${LIBRARY_KIND_LABEL[link.kind].toLowerCase()}, version ${link.version})`;

/** The plain refusal when a change would alter linked content. */
export function linkedContentMessage(link: LibraryLink): string {
  return `This change would alter content that comes from the library: ${linkWords(link)}. It is read-only in this document. Unlink it to make it this document’s own, or change it in the library.`;
}

/** The first link whose content differs between two versions of a document (null when none). Links are compared as `before` holds them. */
export function changedLink(before: Project, after: Project): LibraryLink | null {
  for (const link of before.libraryLinks ?? []) if (placedDigest(before, link) !== placedDigest(after, link)) return link;
  return null;
}

/** The node a link's content starts at (for a refusal that points somewhere), when there is one. */
export const linkNodeId = (link: LibraryLink): string | undefined => (link.target.kind === 'block' ? link.target.rootNodeId : undefined);

/* ------------------------------------------------------------------ finding links */

export function linkFor(project: Project, linkId: string): LibraryLink | undefined {
  return (project.libraryLinks ?? []).find((l) => l.linkId === linkId);
}
/** The block link a node belongs to (the root or anything inside it). */
export function linkOfNode(project: Project, nodeId: string): LibraryLink | undefined {
  for (const l of project.libraryLinks ?? []) if (l.target.kind === 'block' && blockMembers(project, l.target.rootNodeId).nodeIds.includes(nodeId)) return l;
  return undefined;
}
/** The link a content part belongs to (a linked wording, or a message inside a linked block). */
export function linkOfPart(project: Project, partId: string): LibraryLink | undefined {
  for (const l of project.libraryLinks ?? []) {
    if (l.target.kind === 'wording' && l.target.partId === partId) return l;
    if (l.target.kind === 'block' && blockMembers(project, l.target.rootNodeId).partIds.includes(partId)) return l;
  }
  return undefined;
}
/** The link that holds a translatable text (`@node/field`, `@title/part`) or a content part, for the translation screens. */
export function linkOfText(project: Project, id: string): LibraryLink | undefined {
  const mm = /^@([^/]+)\/(.+)$/.exec(id);
  if (!mm) return linkOfPart(project, id);
  return mm[1] === 'title' ? linkOfPart(project, mm[2]) : linkOfNode(project, mm[1]);
}
/** Which link owns each linked node and message, computed once (for screens that check many texts). */
export function libraryOwnership(project: Project): { nodes: Map<string, LibraryLink>; parts: Map<string, LibraryLink>; textOf(id: string): LibraryLink | undefined } {
  const nodes = new Map<string, LibraryLink>(), parts = new Map<string, LibraryLink>();
  for (const l of project.libraryLinks ?? []) {
    if (l.target.kind === 'wording') parts.set(l.target.partId, l);
    if (l.target.kind === 'block') { const m = blockMembers(project, l.target.rootNodeId); m.nodeIds.forEach((id) => nodes.set(id, l)); m.partIds.forEach((id) => parts.set(id, l)); }
  }
  const textOf = (id: string) => { const mm = /^@([^/]+)\/(.+)$/.exec(id); return !mm ? parts.get(id) : mm[1] === 'title' ? parts.get(mm[2]) : nodes.get(mm[1]); };
  return { nodes, parts, textOf };
}
export const linkOfKind =(project: Project, kind: 'brand' | 'glossary' | 'wording-rules'): LibraryLink | undefined => (project.libraryLinks ?? []).find((l) => l.target.kind === kind);
export const linkOfTable = (project: Project, tableId: string): LibraryLink | undefined => (project.libraryLinks ?? []).find((l) => l.target.kind === 'lookup-table' && l.target.tableId === tableId);

/** How a link stands against the library: up to date, behind a newer approved version, or naming an item this studio does not have. */
export type LinkStatus = 'current' | 'behind' | 'not-in-library';
export function linkStatus(link: LibraryLink, items: ReadonlyArray<Pick<LibraryItemInfo, 'id' | 'latest'>>): LinkStatus {
  const item = items.find((i) => i.id === link.itemId);
  if (!item || item.latest === null) return 'not-in-library';
  return item.latest > link.version ? 'behind' : 'current';
}
export const LINK_STATUS_LABEL: Record<LinkStatus, string> = { current: 'Up to date', behind: 'Update available', 'not-in-library': 'Not in this library' };

/** What came from the library, for a release record and the package manifest (ids, titles, kinds and versions only). */
export function libraryListOf(project: Project): Array<{ itemId: string; title: string; kind: LibraryKind; version: number }> {
  return (project.libraryLinks ?? []).map((l) => ({ itemId: l.itemId, title: l.title, kind: l.kind, version: l.version }))
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.itemId < b.itemId ? -1 : 1));
}

/* ------------------------------------------------------------------ links in a file */

function targetProblem(project: Project, link: LibraryLink): string | null {
  const t = link.target as LibraryTarget & Record<string, unknown>;
  if (!isObj(t) || t.kind !== link.kind) return 'its place in the document cannot be read';
  switch (t.kind) {
    case 'block':
      if (typeof t.idPrefix !== 'string' || !/^([a-z0-9][a-z0-9-]{0,23})?$/.test(t.idPrefix)) return 'its id prefix is not valid';
      return project.nodes.some((n) => n.id === t.rootNodeId) && t.rootNodeId !== project.rootNodeId ? null : 'the component it names is not in the document';
    case 'wording': return project.contentParts.some((c) => c.id === t.partId) ? null : 'the message it names is not in the document';
    case 'lookup-table': return (project.lookupTables ?? []).some((x) => x.id === t.tableId) ? null : 'the lookup table it names is not in the document';
    case 'brand': return project.brand ? null : 'the document has no brand';
    case 'glossary': return null;
    case 'wording-rules': return null;
  }
  return 'its place in the document cannot be read';
}

const targetKey = (t: LibraryTarget): string => (t.kind === 'block' ? `block:${t.rootNodeId}` : t.kind === 'wording' ? `wording:${t.partId}` : t.kind === 'lookup-table' ? `table:${t.tableId}` : t.kind);

/** Problems with the library links and house wording rules of a project read from a file (or sent by a client). Empty = fine. */
export function libraryLinkProblems(raw: unknown): string[] {
  const p = raw as Project & Record<string, any>;
  const out: string[] = [];
  if (p.houseWordingRules !== undefined) for (const e of validateWordingRules(p.houseWordingRules).slice(0, 3)) out.push(`The house wording rules are not valid: ${e}`);
  if (p.wordingRules !== undefined) {
    for (const e of validateWordingRules(p.wordingRules).slice(0, 3)) out.push(`The document’s own wording rules are not valid: ${e}`);
    if (Array.isArray(p.wordingRules) && Array.isArray(p.houseWordingRules)) {
      const house = new Set((p.houseWordingRules as WordingRule[]).map((r) => r?.id));
      const clash = (p.wordingRules as WordingRule[]).find((r) => house.has(r?.id));
      if (clash) out.push(`The document’s own wording rule ${q(String(clash.id))} has the id of a house rule.`);
    }
  }
  if (p.libraryLinks === undefined) return out;
  if (!Array.isArray(p.libraryLinks)) return [...out, 'The list of library links cannot be read.'];
  if (p.libraryLinks.length > LIBRARY_LINKS_MAX) return [...out, `A document can have at most ${LIBRARY_LINKS_MAX} library links.`];
  const ids = new Set<string>(), targets = new Set<string>();
  for (const l of p.libraryLinks as LibraryLink[]) {
    if (!isObj(l) || typeof l.linkId !== 'string' || !LIBRARY_LINK_ID_PATTERN.test(l.linkId)) { out.push('A library link has no valid id.'); continue; }
    const name = `The library link ${q(typeof l.title === 'string' ? l.title.slice(0, 60) : l.linkId)}`;
    if (ids.has(l.linkId)) out.push(`Two library links share the id ${q(l.linkId)}.`);
    ids.add(l.linkId);
    if (typeof l.itemId !== 'string' || !LIBRARY_ID_PATTERN.test(l.itemId)) out.push(`${name} does not name a library item.`);
    if (!isLibraryKind(l.kind)) out.push(`${name} is of an unknown kind.`);
    if (typeof l.title !== 'string' || !l.title.trim() || l.title.length > LIBRARY_TITLE_MAX) out.push(`${name} needs a title (max ${LIBRARY_TITLE_MAX} characters).`);
    if (!Number.isInteger(l.version) || l.version < 1) out.push(`${name} does not say which version it holds.`);
    if (typeof l.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(l.fingerprint)) out.push(`${name} has no valid fingerprint.`);
    const known = new Set(['linkId', 'itemId', 'kind', 'title', 'version', 'fingerprint', 'target']);
    if (Object.keys(l).some((k) => !known.has(k))) out.push(`${name} has fields a library link does not have.`);
    if (isLibraryKind(l.kind) && Array.isArray(p.nodes) && Array.isArray(p.contentParts)) {
      const why = targetProblem(p, l);
      if (why) out.push(`${name} cannot be used: ${why}.`);
      else { const key = targetKey(l.target); if (targets.has(key)) out.push(`Two library links hold the same content (${key.split(':')[0]}).`); targets.add(key); }
    }
  }
  return out.slice(0, 20);
}
