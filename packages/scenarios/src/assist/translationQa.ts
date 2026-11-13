import { languageShortName, translationStatus, type GlossaryEntry, type Project, type TranslationRow } from '@iss/model';
import type { TranslationFlag } from './types';

/**
 * Built-in translation check. Compares each translation (the draft when there is one, otherwise the approved text)
 * with its English source and flags what a reviewer should look at: text that may not fit, glossary terms not used,
 * one term translated two ways, text left in English, different numbers, different end punctuation and, for the text
 * message, characters outside the standard SMS alphabet. It never judges meaning (that needs a model) and never
 * changes a translation: it flags, a person decides.
 */

/* ------------------------------------------------------------------ text helpers */

/** GSM 03.38 basic character set and extension table (same alphabet as the SMS renderer; that package is not a dependency here). */
const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '\f^{}\\[~]|€';
const GSM = new Set([...GSM_BASIC, ...GSM_EXT]);

const TOKENS = /\{\{[^{}]*\}\}|\{\w+\}/g;
const ADDRESSES = /\]\([^)]*\)|\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/[^\s)]*/gi;
/** The wording only: no data tokens, placeholders or web addresses. */
const wording = (s: string): string => s.replace(TOKENS, ' ').replace(ADDRESSES, ' ');
/** For comparing words: lower case, accents folded, so "Descripción" and "descripcion" are the same. */
const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const letterWords = (s: string): string[] => wording(s).match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? [];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWholeWord = (text: string, term: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
const quote = (s: string, max = 60): string => `“${s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s}”`;
/** A text reduced to what makes it "the same text": case, surrounding space and end punctuation set aside. */
const sameKey = (s: string): string => fold(s.trim().replace(/\s+/g, ' ').replace(/[\s.:;!?…]+$/, '').replace(/^[¿¡\s]+/, ''));

const isLabel = (id: string): boolean => id.includes('/label') || id.includes('/col.') || id.includes('/caption') || id.includes('.title') || id.startsWith('@title/');

/** Draft when there is one, otherwise the approved text; null when the text has no translation yet. */
function shownText(row: TranslationRow): string | null {
  const d = row.status.draftText, a = row.status.approvedText;
  return d?.trim() ? d : a?.trim() ? a : null;
}

/* ------------------------------------------------------------------ single-text checks */

function lengthFlag(row: TranslationRow, t: string, lang: string): Omit<TranslationFlag, 'textId' | 'source'> | null {
  const s = row.sourceText.trim().length, n = t.trim().length;
  if (!s || n - s < 20) return null;
  if (isLabel(row.partId)) {
    if (n <= s * 1.6) return null;
    return { kind: 'length', severity: 'warning', message: `The ${lang} text is ${n} characters and the English is ${s}. It may not fit in the space this label or heading has.` };
  }
  if (n <= s * 2.2) return null;
  return { kind: 'length', severity: 'info', message: `The ${lang} text is ${n} characters, more than twice the English (${s}). It may not fit where the English does.` };
}

function glossaryFlag(row: TranslationRow, t: string, glossary: GlossaryEntry[]): Omit<TranslationFlag, 'textId' | 'source'> | null {
  if (!glossary.length) return null;
  const english = wording(row.sourceText), translated = fold(wording(t));
  const missed = glossary.filter((g) => g.source?.trim() && g.target?.trim() && hasWholeWord(english, g.source.trim()) && !translated.includes(fold(g.target.trim())));
  if (!missed.length) return null;
  const terms = missed.slice(0, 3).map((g) => `“${g.source.trim()}” as “${g.target.trim()}”`).join(', ');
  const more = missed.length > 3 ? ` and ${missed.length - 3} more` : '';
  return { kind: 'glossary', severity: 'warning', message: `The glossary says to translate ${terms}${more}, but this text does not use ${missed.length === 1 ? 'that wording' : 'those wordings'}.` };
}

/** Common words that show a capitalised heading is wording, not somebody's name. */
const COMMON_EN = new Set(['account', 'balance', 'payment', 'summary', 'date', 'amount', 'due', 'minimum', 'statement', 'claim', 'claims', 'plan', 'paid', 'member', 'service', 'status', 'details', 'key', 'facts', 'previous', 'purchases', 'credit', 'available', 'period', 'reference', 'description', 'billed', 'allowed', 'network', 'terms', 'explained', 'rewards', 'team', 'relationship', 'transactions', 'transaction', 'guide', 'notice', 'fees', 'interest', 'limit', 'number', 'name', 'address', 'total', 'page', 'document', 'header', 'sections', 'message', 'notices', 'filter', 'responsibility', 'deductible', 'appeal', 'update', 'covered', 'services', 'instructions', 'reminder', 'support', 'assistance', 'requested', 'arrangement', 'active', 'disclosures', 'demonstration', 'the', 'your', 'our', 'this', 'new', 'show', 'sort', 'clear', 'skip', 'not', 'all', 'more', 'for', 'and', 'with']);

function untranslatedFlag(row: TranslationRow, t: string, project: Project, lang: string): Omit<TranslationFlag, 'textId' | 'source'> | null {
  const english = row.sourceText.trim().replace(/\s+/g, ' ');
  if (t.trim().replace(/\s+/g, ' ') !== english) return null;
  // Names, numbers and data tokens are the same in every language: only real wording counts.
  const issuer = new Set([...letterWords(project.issuer?.name ?? ''), ...letterWords(project.issuer?.product ?? '')].map(fold));
  const words = letterWords(english).filter((w) => w.length > 1 && !issuer.has(fold(w)));
  if (words.length < 2) return null;
  const looksLikeName = words.length <= 3 && words.every((w) => /^\p{Lu}/u.test(w) && !COMMON_EN.has(w.toLowerCase())) && !/[.!?:]$/.test(english);
  if (looksLikeName) return null;
  return { kind: 'untranslated', severity: 'warning', message: `The ${lang} text is the same as the English. It may not have been translated.` };
}

/** Every run of digits outside data tokens and web addresses. Grouping marks differ by language ("1,000" and "1.000"), runs do not. */
const numbersOf = (s: string): string[] => (wording(s).match(/\d+/g) ?? []).sort();

function numberFlag(row: TranslationRow, t: string): Omit<TranslationFlag, 'textId' | 'source'> | null {
  const a = numbersOf(row.sourceText), b = numbersOf(t);
  if (a.join('|') === b.join('|')) return null;
  const rest = [...b];
  const missing: string[] = [];
  for (const n of a) { const i = rest.indexOf(n); if (i >= 0) rest.splice(i, 1); else missing.push(n); }
  const parts = [missing.length ? `${missing.slice(0, 4).join(', ')} ${missing.length === 1 ? 'is' : 'are'} in the English but not in the translation` : '', rest.length ? `${rest.slice(0, 4).join(', ')} ${rest.length === 1 ? 'is' : 'are'} only in the translation` : ''].filter(Boolean);
  return { kind: 'number-mismatch', severity: 'warning', message: `The numbers differ from the English: ${parts.join('; ')}.` };
}

/** The mark a text ends with, looking past closing quotes, brackets and markup. */
function endMark(s: string): string {
  const t = s.replace(TOKENS, 'x').trim().replace(/[\s"'”’»)\]*_]+$/, '');
  const last = t.slice(-1);
  if (last === '?' || last === '？') return '?';
  if (last === '!' || last === '！') return '!';
  if (last === ':' || last === '：') return ':';
  return '';
}
const MARK_NAME: Record<string, string> = { '?': 'a question mark', '!': 'an exclamation mark', ':': 'a colon' };

function punctuationFlag(row: TranslationRow, t: string): Omit<TranslationFlag, 'textId' | 'source'> | null {
  const want = endMark(row.sourceText);
  if (!want || endMark(t) === want) return null;
  return { kind: 'punctuation', severity: 'info', message: `The English ends with ${MARK_NAME[want]}, but the translation does not.` };
}

function smsFlag(row: TranslationRow, t: string): Omit<TranslationFlag, 'textId' | 'source'> | null {
  if (row.partId !== '@sms/text') return null;
  const odd = [...new Set([...t.replace(TOKENS, '')].filter((ch) => !GSM.has(ch)))];
  if (!odd.length) return null;
  const shown = odd.slice(0, 6).map((ch) => (ch.trim() ? `“${ch}”` : 'a special space')).join(', ');
  return { kind: 'sms-encoding', severity: 'warning', message: `The text message uses ${shown}${odd.length > 6 ? ' and others' : ''}, which ${odd.length === 1 ? 'is' : 'are'} not in the standard SMS alphabet. The message is then sent in parts of 70 characters instead of 160 and may cost more.` };
}

/* ------------------------------------------------------------------ one term, two translations */

interface Shown { row: TranslationRow; text: string }

/**
 * Deliberately conservative, two cases only:
 *  1. the SAME English text (apart from case and end punctuation) has different translations;
 *  2. an English word of five letters or more that is itself a whole text (a label such as "Claim") has one
 *     translation there, at least two other texts containing the word use that translation, and this text does not.
 */
function inconsistentFlags(shown: Shown[], glossary: GlossaryEntry[], lang: string): Map<string, Omit<TranslationFlag, 'textId' | 'source'>> {
  const out = new Map<string, Omit<TranslationFlag, 'textId' | 'source'>>();

  // 1. same English, different translation
  const groups = new Map<string, Shown[]>();
  for (const s of shown) {
    const k = sameKey(wording(s.row.sourceText).trim() ? s.row.sourceText : '');
    if (!k || !/\p{L}{2}/u.test(k)) continue;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const split = new Set<string>();
  for (const [k, members] of groups) {
    if (members.length < 2) continue;
    const byRendering = new Map<string, Shown[]>();
    for (const m of members) { const r = sameKey(m.text); byRendering.set(r, [...(byRendering.get(r) ?? []), m]); }
    if (byRendering.size < 2) continue;
    split.add(k);
    // The most used rendering (the first one on a tie) is the reference; the others are flagged.
    const ordered = [...byRendering.values()].sort((a, b) => b.length - a.length);
    const ref = ordered[0][0];
    for (const others of ordered.slice(1)) for (const m of others) {
      out.set(m.row.partId, { kind: 'inconsistent-term', severity: 'warning', message: `The same English text ${quote(m.row.sourceText.trim())} is translated as ${quote(ref.text.trim())} in “${ref.row.title}” and as ${quote(m.text.trim())} here. Use one ${lang} wording for both.` });
    }
  }

  // 2. a one-word label sets the term; texts that contain the word should use it
  const glossarySources = new Set(glossary.map((g) => fold(g.source ?? '').trim()));
  for (const anchor of shown) {
    const word = anchor.row.sourceText.trim().replace(/[.:]$/, '');
    if (!/^\p{L}{5,}$/u.test(word)) continue;
    const k = sameKey(word);
    if (split.has(k) || glossarySources.has(fold(word))) continue;
    if (groups.get(k)?.[0] !== anchor) continue; // one anchor per word
    const rendering = anchor.text.trim().replace(/[.:]$/, '');
    const renderingWords = letterWords(rendering);
    if (!renderingWords.length || renderingWords.length > 3 || fold(rendering) === fold(word)) continue;
    const main = fold(renderingWords.slice().sort((a, b) => b.length - a.length)[0]);
    if (main.length < 4) continue;
    const stem = main.slice(0, Math.max(4, main.length - 2));
    const containing = shown.filter((s) => sameKey(s.row.sourceText) !== k && hasWholeWord(wording(s.row.sourceText), word));
    const agree = containing.filter((s) => fold(wording(s.text)).includes(stem));
    const differ = containing.filter((s) => !fold(wording(s.text)).includes(stem));
    if (agree.length < 2 || differ.length > agree.length) continue;
    for (const d of differ) {
      if (out.has(d.row.partId)) continue;
      out.set(d.row.partId, { kind: 'inconsistent-term', severity: 'info', message: `“${word}” is translated as ${quote(rendering)} in “${anchor.row.title}” and in ${agree.length} other ${agree.length === 1 ? 'text' : 'texts'}, but this text reads ${quote(d.text.trim())} and does not use that word. Check that the term is translated the same way throughout.` });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ api */

const KIND_ORDER: TranslationFlag['kind'][] = ['glossary', 'inconsistent-term', 'length', 'meaning', 'number-mismatch', 'punctuation', 'sms-encoding', 'untranslated'];

/**
 * Flags for the translations of `locale`, in the order of the texts in Content & Translations and, per text, by kind
 * (alphabetical). At most one flag of a kind per text. `opts.ids` limits the result to those texts; consistency is
 * still judged against all texts of the language.
 */
export function checkTranslations(project: Project, locale: string, opts: { ids?: string[] } = {}): TranslationFlag[] {
  const rows = translationStatus(project, locale).rows;
  const lang = languageShortName(locale);
  const glossary = project.glossary?.[locale] ?? [];
  const shown: Shown[] = [];
  for (const row of rows) { const text = shownText(row); if (text !== null) shown.push({ row, text }); }
  const inconsistent = inconsistentFlags(shown, glossary, lang);
  const only = opts.ids ? new Set(opts.ids) : null;

  const flags: TranslationFlag[] = [];
  for (const { row, text } of shown) {
    if (only && !only.has(row.partId)) continue;
    const found = [
      glossaryFlag(row, text, glossary),
      inconsistent.get(row.partId) ?? null,
      lengthFlag(row, text, lang),
      numberFlag(row, text),
      punctuationFlag(row, text),
      smsFlag(row, text),
      untranslatedFlag(row, text, project, lang),
    ].filter((f): f is Omit<TranslationFlag, 'textId' | 'source'> => f !== null);
    found.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    for (const f of found) flags.push({ textId: row.partId, ...f, source: 'builtin' });
  }
  return flags;
}

/**
 * The project's preferred terms for `locale` as plain instruction lines for a model prompt:
 * `Translate “statement” as “estado de cuenta”`. Empty when the language has no glossary.
 */
export function glossaryInstructions(project: Project, locale: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const g of project.glossary?.[locale] ?? []) {
    const source = g.source?.trim(), target = g.target?.trim();
    if (!source || !target || seen.has(source.toLowerCase())) continue;
    seen.add(source.toLowerCase());
    lines.push(`Translate “${source}” as “${target}”${g.note?.trim() ? ` (${g.note.trim()})` : ''}`);
  }
  return lines;
}
