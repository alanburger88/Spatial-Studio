import { SOURCE_LANGUAGE, isIsoDay, languageShortName, type Project, type SyntheticRecord } from '@iss/model';
import { BLOCKER_KINDS, checkBaseQuestion, languageWords, queryVocabulary, targetKey, type BaseQuestion, type FieldCondition, type FieldOp, type QueryTarget, type QueryVocabulary } from './baseQuery';
import type { BlockerKind } from './types';

/**
 * The built-in reader for "Ask about all customers": turns the common English forms into a `BaseQuestion` without any
 * model. Pure and deterministic.
 *
 *  - "who gets X", "which customers get X", "who sees X", "customers who get X", "list who gets X"
 *  - "how many (customers) get X"
 *  - "who gets X but not Y" (also "and not Y", "but don't get Y")
 *  - "why does <customer> get X" (also "why doesn't …", "why is <customer> stopped")
 *  - "who is stopped" / "who is blocked", "… and by what", "… by <kind of blocker or a blocker's title>", "how many are stopped"
 *  - "… in Spanish" (customers whose language it is), "who gets Spanish"
 *  - "… where <field> is <value>" (also "is not", "is at least", "more than", "less than", "at most")
 *  - "… as issued on 2026-12-01"
 *  - "who matches rule R03"
 *
 * X is matched against the document's rule titles, messages and their alternatives, section names and kinds of blocker,
 * ignoring case, quotes and small differences. When X could be more than one thing the reader ASKS (the candidates
 * become buttons); it never guesses silently. Requests to change something are refused; a sentence it cannot read is
 * returned as `unknown`, which a model may try (the studio decides).
 */

export interface ReaderChoice { label: string; question: BaseQuestion }
export type ReadResult =
  | { status: 'understood'; question: BaseQuestion }
  | { status: 'ask'; message: string; choices: ReaderChoice[] }
  | { status: 'refused'; message: string }
  | { status: 'unknown'; message: string };

export interface ReaderOptions {
  records?: readonly SyntheticRecord[];
  /** The document's blockers (ids and plain titles), so "stopped by <a blocker>" can name one. */
  blockers?: ReadonlyArray<{ id: string; title: string; kind: BlockerKind }>;
}

export const READER_FORMS: readonly string[] = [
  'Who gets X?', 'How many get X?', 'Who gets X but not Y?', 'Why does <customer> get X?', 'Who is stopped, and by what?', 'Who gets X in Spanish?', 'Who sees <section>?',
];

const MAX_LEN = 300;

/* ------------------------------------------------------------------ text helpers */

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'your', 'our', 'my', 'their', 'this', 'that', 'is', 'are', 'it', 'its', 'and', 'in', 'on', 'with', 'by', 'from', 'at', 'or']);
export function normalise(s: string): string {
  return s.toLowerCase()
    .replace(/[“”"‘’`´]/g, ' ').replace(/'s\b/g, '').replace(/'/g, ' ')
    .replace(/[—–_\-/:;,.!?()[\]{}+&]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const stem = (w: string): string => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('es') && /(ss|sh|ch|x)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const tokens = (s: string): string[] => normalise(s).split(' ').filter((w) => w && !STOP.has(w)).map(stem);
const stripArticles = (s: string): string => s.replace(/^(?:the|a|an|our|their|his|her|its)\s+/i, '').trim();

function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const sameWord = (a: string, b: string): boolean => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b, a.length >= 8 && b.length >= 8 ? 2 : 1) <= (a.length >= 8 && b.length >= 8 ? 2 : 1));

/** How well a phrase names something: 1 for the same words, less for fewer shared words; 0 when the phrase's words are not (nearly all) in the name. */
export function nameScore(phrase: string, name: string): number {
  const a = normalise(stripArticles(phrase)), b = normalise(stripArticles(name));
  if (!a || !b) return 0;
  if (a === b) return 1;
  const qa = tokens(a), nb = tokens(b);
  if (!qa.length || !nb.length) return 0;
  if (qa.join(' ') === nb.join(' ')) return 0.98;
  const used = new Set<number>();
  let hit = 0;
  for (const w of qa) { const j = nb.findIndex((x, k) => !used.has(k) && sameWord(w, x)); if (j >= 0) { used.add(j); hit++; } }
  const coverage = hit / qa.length, precision = hit / nb.length;
  if (coverage < 0.75) return 0;
  return Math.round((0.55 * coverage + 0.4 * precision) * 1000) / 1000;
}

/* ------------------------------------------------------------------ what X can be */

interface Candidate { target: QueryTarget; label: string; names: string[]; /** Prefer what customers get over the rule that chose it. */ rank: number }

function candidatesOf(project: Project, vocab: QueryVocabulary, opts: ReaderOptions): Candidate[] {
  const out: Candidate[] = [];
  const humanId = (id: string) => id.replace(/[-_.]+/g, ' ');
  for (const m of vocab.messages) {
    for (const a of m.alternatives) out.push({ target: { kind: 'alternative', nodeId: m.nodeId, variantId: a.id }, label: `“${a.title}” in ${m.name}`, names: [a.title, humanId(a.id)], rank: 0 });
  }
  for (const s of vocab.sections) out.push({ target: { kind: 'section', nodeId: s.nodeId }, label: `the section “${s.name}”`, names: [s.name, humanId(s.nodeId), ...s.texts.flatMap((t) => [t.title, humanId(t.id)])], rank: 1 });
  for (const r of vocab.rules) out.push({ target: { kind: 'rule', ruleId: r.id }, label: `the rule “${r.title}” (${r.id})`, names: [r.title], rank: 2 });
  for (const b of opts.blockers ?? []) out.push({ target: { kind: 'blocker', blockerId: b.id }, label: `the blocker “${b.title}”`, names: [b.title], rank: 3 });
  void project;
  return out;
}

const KIND_WORDS: Array<[RegExp, BlockerKind]> = [
  [/^(?:wording|translations?|texts?|wording (?:and|or) translations?|missing translations?|language)$/, 'wording'],
  [/^rules?$/, 'rules'],
  [/^(?:layout|pages?|layout and pages|page layout)$/, 'layout'],
  [/^(?:data fields?|fields?)$/, 'data-fields'],
  [/^(?:(?:the )?customer'?s? (?:own )?data|their (?:own )?data|data|bad data|wrong data|customer data)$/, 'customer-data'],
];

type Match = { status: 'one'; target: QueryTarget } | { status: 'many'; candidates: Candidate[] } | { status: 'none' };

/** X against the document's names: one, several (to ask about), or none. */
function matchThing(project: Project, vocab: QueryVocabulary, raw: string, opts: ReaderOptions): Match {
  const x = stripArticles(raw.trim().replace(/^[“"'‘]+|[”"'’]+$/g, '').trim());
  if (!x) return { status: 'none' };
  // A rule by its number: "rule R03", "R03".
  const byId = /^(?:the\s+)?(?:rule\s+)?([A-Za-z]{1,3}\d{1,4})$/.exec(x);
  if (byId) { const r = vocab.rules.find((y) => y.id.toLowerCase() === byId[1].toLowerCase()); if (r) return { status: 'one', target: { kind: 'rule', ruleId: r.id } }; }
  // A language: "Spanish", "the Spanish version", "Spanish documents".
  const lang = languageOf(vocab, x.replace(/\s+(?:version|documents?|wording|text|letters?)$/i, ''));
  if (lang) return { status: 'one', target: { kind: 'language', locale: lang } };
  const cands = candidatesOf(project, vocab, opts);
  // "the past due message", "the payment support text": a generic last word people add that the name may not have
  // counts a little less than the words as typed.
  const bare = x.replace(/\s+(?:message|messages|text|wording|version|letter|one)$/i, '').trim();
  const scoreOf = (n: string) => Math.max(nameScore(x, n), bare && bare !== x ? nameScore(bare, n) * 0.97 : 0);
  const scored = cands.map((c) => ({ c, score: Math.max(...c.names.map(scoreOf)) })).filter((s) => s.score >= 0.6);
  if (!scored.length) return { status: 'none' };
  // One entry per outcome; then a rule gives way to what it chooses or shows when both are named about as well.
  const best = new Map<string, { c: Candidate; score: number }>();
  for (const s of scored) { const k = targetKey(s.c.target); const cur = best.get(k); if (!cur || s.score > cur.score) best.set(k, s); }
  let list = [...best.values()].sort((a, b) => b.score - a.score || a.c.rank - b.c.rank);
  const top = list[0].score;
  const keys = new Set(list.map((s) => targetKey(s.c.target)));
  list = list.filter((s) => {
    if (s.c.target.kind !== 'rule') return true;
    const ruleId = s.c.target.ruleId;
    const gives = vocab.rules.find((r) => r.id === ruleId)?.gives;
    if (!gives) return true;
    // a rule that chooses a one-text section's text gives that section
    const giveKey = targetKey(gives);
    return !(keys.has(giveKey) && (best.get(giveKey)!.score >= s.score - 0.15));
  });
  // A section and the only alternative it is made of are the same thing to a reader.
  const close = list.filter((s) => s.score >= top - 0.06);
  if (close.length === 1 || (close[0].score === 1 && close.filter((s) => s.score === 1).length === 1)) return { status: 'one', target: close[0].c.target };
  return { status: 'many', candidates: close.slice(0, 6).map((s) => s.c) };
}

function languageOf(vocab: QueryVocabulary, phrase: string): string | null {
  const p = normalise(stripArticles(phrase));
  if (!p) return null;
  for (const l of vocab.languages) if (languageWords(l.code).some((w) => normalise(w) === p)) return l.code;
  if (p === 'english') return SOURCE_LANGUAGE;
  return null;
}

/** "Spanish" not in this document: said, rather than ignored. */
function knownLanguageWord(phrase: string): string | null {
  const p = normalise(phrase);
  return /^(spanish|french|german|italian|portuguese|chinese|japanese|korean|vietnamese|arabic|russian|polish|dutch|hindi|tagalog|english)$/.test(p) ? p : null;
}

/* ------------------------------------------------------------------ customers */

function matchCustomer(raw: string, project: Project, records: readonly SyntheticRecord[]): { status: 'one'; recordId: string } | { status: 'many'; recordIds: string[] } | { status: 'none' } {
  const want = normalise(raw.replace(/'s$/i, ''));
  if (!want) return { status: 'none' };
  const mine = records.filter((r) => r.documentType === project.documentType);
  const byId = mine.find((r) => r.recordId.toLowerCase() === raw.trim().toLowerCase());
  if (byId) return { status: 'one', recordId: byId.recordId };
  const full = mine.filter((r) => normalise(`${r.customer.givenName} ${r.customer.familyName}`) === want);
  if (full.length === 1) return { status: 'one', recordId: full[0].recordId };
  if (full.length > 1) return { status: 'many', recordIds: full.map((r) => r.recordId) };
  const part = mine.filter((r) => normalise(r.customer.givenName ?? '') === want || normalise(r.customer.familyName ?? '') === want);
  if (part.length === 1) return { status: 'one', recordId: part[0].recordId };
  if (part.length > 1) return { status: 'many', recordIds: part.map((r) => r.recordId) };
  return { status: 'none' };
}
const customerLabel = (r: SyntheticRecord): string => `${r.customer.givenName} ${r.customer.familyName}`.trim() || r.recordId;

/* ------------------------------------------------------------------ conditions on a field */

const OP_PATTERNS: Array<[RegExp, FieldOp]> = [
  [/\s+(?:is|are)\s+(?:at least|no less than)\s+/, 'gte'], [/\s+(?:is|are)\s+(?:at most|no more than)\s+/, 'lte'],
  [/\s+(?:is|are)\s+(?:more than|greater than|over|above)\s+|\s+(?:over|above|more than|>)\s+/, 'gt'],
  [/\s+(?:is|are)\s+(?:less than|under|below|fewer than)\s+|\s+(?:under|below|less than|<)\s+/, 'lt'],
  [/\s+(?:is not|isn't|are not|aren't|!=)\s+/, 'ne'], [/\s+(?:is|are|equals|=)\s+/, 'eq'],
];

function readCondition(vocab: QueryVocabulary, raw: string): FieldCondition | null {
  const s = ` ${raw.trim()} `;
  for (const [re, op] of OP_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const left = s.slice(0, m.index).trim(), right = s.slice(m.index + m[0].length).trim().replace(/^[“"'‘]+|[”"'’]+$/g, '');
    const field = [...vocab.fields].map((f) => ({ f, score: Math.max(nameScore(left, f.label), nameScore(left, f.path.split('.').slice(-1)[0].replace(/([a-z])([A-Z])/g, '$1 $2'))) })).filter((x) => x.score >= 0.75).sort((a, b) => b.score - a.score)[0]?.f;
    if (!field || !right) return null;
    let value: string | number | boolean | null = null;
    switch (field.type) {
      case 'int': case 'points': value = /^-?\d+$/.test(right.replace(/,/g, '')) ? Number(right.replace(/,/g, '')) : null; break;
      case 'cents': { const m2 = /^\$?\s*(-?\d[\d,]*)(?:\.(\d{1,2}))?$/.exec(right); value = m2 ? Number(m2[1].replace(/,/g, '')) * 100 + (m2[2] ? Number(m2[2].padEnd(2, '0')) * Math.sign(Number(m2[1].replace(/,/g, '')) || 1) : 0) : null; break; }
      case 'bool': value = /^(yes|true|on)$/i.test(right) ? true : /^(no|false|off)$/i.test(right) ? false : null; break;
      case 'enum': { const want = normalise(right); value = (field.enumValues ?? []).find((v) => normalise(v) === want) ?? null; break; }
      case 'date': value = isIsoDay(right) ? right : null; break;
      default: value = right;
    }
    if (value === null) return null;
    return { path: field.path, op, value };
  }
  return null;
}

/* ------------------------------------------------------------------ the reader */

const ACTION = /^(?:please\s+|can you\s+|could you\s+)?(?:delete|remove|approve|reject|change|set|send|export|publish|edit|update|add|create|rename|disable|enable|assign|mark|fix|undo|save|email|text|translate)\b/i;
const GET = String.raw`(?:get|gets|getting|got|receive|receives|received|see|sees|saw|seeing|are shown|is shown|are sent|is sent|are given|is given|have|has|read|reads|are in|is in)`;

/** Reads one sentence. `opts.records` lets "why does <customer> …" find the customer; nothing here leaves the studio. */
export function readBaseQuestion(project: Project, sentence: string, opts: ReaderOptions = {}): ReadResult {
  const vocab = queryVocabulary(project);
  let s = String(sentence ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { status: 'refused', message: 'Type a question about the customers, for example “Who is stopped?”.' };
  if (s.length > MAX_LEN) return { status: 'refused', message: `Keep the question to ${MAX_LEN} characters.` };
  if (ACTION.test(s)) return { status: 'refused', message: 'This box answers questions about who gets what. It does not change, approve or send anything; do that on the screen where it is done.' };
  s = s.replace(/[?.!\s]+$/g, '').replace(/^(?:tell me|show me|list|find|please)\s+/i, '').replace(/^(?:all\s+)?(?:the\s+)?customers\s+(?:who|that)\s+/i, 'who ');
  // "…, and why" at the end adds nothing the answer does not already give.
  s = s.replace(/,?\s+and\s+why$/i, '').replace(/^and\s+/i, '');

  const base: Partial<BaseQuestion> = {};
  // "as issued on 2026-12-01" / "issued on …" / "on 2026-12-01"
  const dated = /\s*,?\s*(?:as\s+)?(?:issued\s+)?(?:on|as of)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(s);
  if (dated) {
    if (!isIsoDay(dated[1])) return { status: 'refused', message: `${dated[1]} is not a date.` };
    if (!project.documentDate) return { status: 'refused', message: 'This document does not depend on a date, so “as issued on” does not apply. Ask without the date.' };
    base.issuedOn = dated[1];
    s = (s.slice(0, dated.index) + s.slice(dated.index + dated[0].length)).trim();
  }
  // "… where missed payments is at least 2"
  const whereAt = /\s+(?:where|whose|when|if|with)\s+(.+)$/i.exec(s);
  if (whereAt) {
    const cond = readCondition(vocab, whereAt[1]);
    if (cond) { base.where = cond; s = s.slice(0, whereAt.index).trim(); }
  }
  // "… in Spanish"
  const inLang = /\s+in\s+([A-Za-z() -]+?)\s*$/i.exec(s);
  if (inLang) {
    const code = languageOf(vocab, inLang[1]);
    if (code) { base.language = code; s = s.slice(0, inLang.index).trim(); }
    else if (knownLanguageWord(inLang[1])) return { status: 'refused', message: `This document has no ${inLang[1].trim()} version. Its languages are ${vocab.languages.map((l) => l.name).join(' and ')}.` };
  }

  /* ---- why */
  const whyStopped = /^why\s+(?:is|was|are)\s+(.+?)\s+(?:stopped|blocked|held back)(?:\s+by\s+(.+))?$/i.exec(s);
  const why = whyStopped ? null : new RegExp(String.raw`^why\s+(?:(?:does|do|did|is|was|would)(?:n't|\s+not)?|doesn't|don't|didn't|isn't)\s+(.+?)\s+(?:${GET}|be\s+shown|get\s+shown|match|matches)\s+(.+)$`, 'i').exec(s);
  if (why || whyStopped) {
    const who = (why ? why[1] : whyStopped![1]).trim();
    const c = matchCustomer(who, project, opts.records ?? []);
    if (c.status === 'none') return { status: 'refused', message: `No customer of this document is called “${who}”. Use the name as Data Explorer shows it, or the customer’s id.` };
    let target: QueryTarget;
    if (whyStopped) {
      const by = whyStopped[2] ? stopTarget(project, vocab, whyStopped[2], opts) : { status: 'one' as const, target: { kind: 'blocker' } as QueryTarget };
      if (by.status !== 'one') return by.status === 'many' ? ask(project, by.candidates, (t) => ({ ask: 'why', target: t, ...base }), opts, c) : unknown(`“${whyStopped[2]}” is not a kind of blocker or a blocker of this document.`);
      target = by.target;
    } else {
      const m = matchThing(project, vocab, why![2], opts);
      if (m.status === 'none') return unknown(`“${why![2].trim()}” does not name a rule, message, section or language of this document.`);
      if (m.status === 'many') return ask(project, m.candidates, (t) => ({ ask: 'why', target: t, ...base }), opts, c);
      target = m.target;
    }
    if (c.status === 'many') {
      const recs = (opts.records ?? []).filter((r) => c.recordIds.includes(r.recordId));
      return { status: 'ask', message: `More than one customer is called “${who}”. Which one?`, choices: recs.slice(0, 8).map((r) => ({ label: `${customerLabel(r)} (${r.recordId})`, question: { ask: 'why', target, ...base, customer: r.recordId } as BaseQuestion })) };
    }
    return done(project, { ask: 'why', target, ...base, customer: c.recordId }, opts);
  }

  /* ---- who is stopped */
  const stopped = /^(?:who|which customers?|which ones?|what customers?|how many(?:\s+customers|\s+people)?)\s+(?:is|are|can't be|cannot be|can not be|could not be)\s+(stopped|blocked|held back|issued|not issued|not able to be issued)(?:\s*,?\s*(?:and\s+)?(?:by what|why|what stops them|what blocks them))?(?:\s+by\s+(.+?))?(?:\s*,?\s*and\s+(?:by what|why))?$/i.exec(s);
  if (stopped) {
    const howMany = /^how many/i.test(s);
    if (/^(?:issued)$/i.test(stopped[1]) && !/can't|cannot|can not|could not/i.test(s)) return unknown('Ask “who is stopped?” to see who cannot be issued the document.');
    if (stopped[2]) {
      const by = stopTarget(project, vocab, stopped[2], opts);
      if (by.status === 'many') return ask(project, by.candidates, (t) => ({ ask: howMany ? 'how-many' : 'who', target: t, ...base }), opts);
      if (by.status === 'none') return unknown(`“${stopped[2]}” is not a kind of blocker or a blocker of this document.`);
      return done(project, { ask: howMany ? 'how-many' : 'who', target: by.target, ...base }, opts);
    }
    return done(project, { ask: howMany ? 'how-many' : 'who', target: { kind: 'blocker' }, ...base }, opts);
  }

  /* ---- who gets / how many get */
  const lead = new RegExp(String.raw`^(?:(how many)(?:\s+(?:customers|people|of them|synthetic customers|records|clients|members|cardholders))?|who|whom|which(?:\s+customers?|\s+ones?|\s+people)?|what\s+customers?)\s+(?:will\s+|would\s+|do\s+|does\s+|can\s+)?(${GET}|match|matches|qualify for|qualifies for|speak|speaks|prefer|prefers)\s+(.+)$`, 'i').exec(s);
  if (lead) {
    const howMany = !!lead[1];
    let rest = lead[3].trim();
    if (/^(?:match|matches)$/i.test(lead[2])) rest = rest.replace(/^(?:the\s+)?rule\s+/i, '');
    // "… but not Y"
    const split = /\s+(?:but\s+not|and\s+not|but\s+(?:don't|do not|doesn't|does not|never)\s+(?:get|see|receive))\s+/i.exec(rest);
    const xRaw = split ? rest.slice(0, split.index) : rest;
    const yRaw = split ? rest.slice(split.index + split[0].length) : null;
    const mx = matchThing(project, vocab, xRaw, opts);
    if (mx.status === 'none') return unknown(`“${stripArticles(xRaw.trim())}” does not name a rule, message, section or language of this document.`);
    const askOf = howMany ? 'how-many' as const : 'who' as const;
    if (mx.status === 'many') {
      // Ask about X first; "but not Y" is kept when Y is clear.
      const my = yRaw ? matchThing(project, vocab, yRaw, opts) : null;
      return ask(project, mx.candidates, (t) => ({ ask: askOf, target: t, ...(my?.status === 'one' ? { butNot: my.target } : {}), ...base }), opts);
    }
    if (yRaw) {
      const my = matchThing(project, vocab, yRaw, opts);
      if (my.status === 'none') return unknown(`“${stripArticles(yRaw.trim())}” does not name a rule, message, section or language of this document.`);
      if (my.status === 'many') return ask(project, my.candidates, (t) => ({ ask: askOf, target: mx.target, butNot: t, ...base }), opts, undefined, 'but not');
      if (targetKey(my.target) === targetKey(mx.target)) return unknown('“But not” names the same thing as the question, so nobody could match.');
      return done(project, { ask: askOf, target: mx.target, butNot: my.target, ...base }, opts);
    }
    return done(project, { ask: askOf, target: mx.target, ...base }, opts);
  }

  // "who is in Spanish", "who reads Spanish"
  const langOnly = /^(?:who|which customers?|how many(?:\s+customers)?)\s+(?:is|are|speaks?|reads?|prefers?)\s+(?:in\s+)?([A-Za-z() -]+)$/i.exec(s);
  if (langOnly) {
    const code = languageOf(vocab, langOnly[1]);
    if (code) return done(project, { ask: /^how many/i.test(s) ? 'how-many' : 'who', target: { kind: 'language', locale: code }, ...base }, opts);
  }
  if (base.language && /^(?:who|which customers?|how many(?:\s+customers)?)(?:\s+(?:is|are))?$/i.test(s)) {
    return done(project, { ask: /^how many/i.test(s) ? 'how-many' : 'who', target: { kind: 'language', locale: base.language }, ...base, language: undefined }, opts);
  }
  return unknown('The built-in reader did not understand this sentence.');
}

function stopTarget(project: Project, vocab: QueryVocabulary, raw: string, opts: ReaderOptions): Match {
  const p = normalise(stripArticles(raw.replace(/\s+(?:blockers?|problems?|issues?)$/i, '')));
  for (const [re, kind] of KIND_WORDS) if (re.test(p)) return { status: 'one', target: { kind: 'blocker', blockerKind: kind } };
  const titles = (opts.blockers ?? []).map((b) => ({ b, score: nameScore(raw, b.title) })).filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score);
  if (!titles.length) return { status: 'none' };
  const close = titles.filter((t) => t.score >= titles[0].score - 0.06);
  if (close.length === 1) return { status: 'one', target: { kind: 'blocker', blockerId: close[0].b.id } };
  void project; void vocab; void BLOCKER_KINDS;
  return { status: 'many', candidates: close.slice(0, 6).map((t) => ({ target: { kind: 'blocker', blockerId: t.b.id }, label: `the blocker “${t.b.title}”`, names: [t.b.title], rank: 3 })) };
}

function done(project: Project, q: BaseQuestion, opts: ReaderOptions): ReadResult {
  const clean = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined));
  const checked = checkBaseQuestion(project, clean, { records: opts.records ? [...opts.records] : [] });
  if (!checked.question) return { status: 'unknown', message: checked.problems.join(' ') };
  return { status: 'understood', question: checked.question };
}

function ask(project: Project, candidates: Candidate[], make: (t: QueryTarget) => Partial<BaseQuestion>, opts: ReaderOptions, customer?: { status: 'one'; recordId: string } | { status: 'many'; recordIds: string[] }, which = ''): ReadResult {
  const choices: ReaderChoice[] = [];
  for (const c of candidates) {
    const q = { ...make(c.target), ...(customer?.status === 'one' ? { customer: customer.recordId } : customer?.status === 'many' ? { customer: customer.recordIds[0] } : {}) };
    const r = done(project, q as BaseQuestion, opts);
    if (r.status === 'understood') choices.push({ label: sentenceCaseLabel(c.label), question: r.question });
  }
  if (!choices.length) return unknown('The words could name several things, and none of them fits the rest of the question.');
  if (choices.length === 1) return { status: 'understood', question: choices[0].question };
  return { status: 'ask', message: `${which ? `“${which}” could mean` : 'This could mean'} more than one thing in this document. Which one?`, choices };
}
const sentenceCaseLabel = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

function unknown(message: string): ReadResult { return { status: 'unknown', message }; }

/** For the help line under the box: the languages a question can name besides English. */
export function readerLanguages(project: Project): string[] {
  return queryVocabulary(project).languages.filter((l) => l.code !== SOURCE_LANGUAGE).map((l) => languageShortName(l.code));
}
