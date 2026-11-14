import { allFieldIndex, itemsLead, languageName, projectFieldIndex, type Predicate, type Project, type Rule, type RuleAction, type Scalar } from '@iss/model';
import { formatCents, formatDate } from '@iss/resolver';

/**
 * Writing helpers of the assistant's built-in engines: the reading level of an English text, and the small set of
 * plain-word phrasings (field, value, condition, rule, lists and counts) the other engines share so that a rule or a
 * component is always named the same way. Pure: nothing here reads the clock, the network or `Intl`.
 */

/* ------------------------------------------------------------------ reading level */

const EN_COMMON = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'be', 'been', 'this', 'that', 'your', 'you', 'we', 'our', 'it', 'not', 'with', 'by', 'at', 'has', 'have', 'will', 'if', 'as', 'from', 'can', 'may', 'do', 'does', 'please', 'any', 'all', 'no']);
const OTHER_COMMON = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'que', 'es', 'una', 'un', 'para', 'con', 'por', 'su', 'sus', 'se', 'esta', 'este', 'usted', 'ya', 'y', 'en', 'al', 'lo', 'como',
  'le', 'les', 'des', 'et', 'est', 'votre', 'vos', 'pour', 'avec', 'dans', 'une', 'du', 'sur', 'pas', 'nous', 'vous',
  'der', 'die', 'das', 'und', 'ist', 'ihr', 'ihre', 'nicht', 'mit', 'auf', 'ein', 'eine', 'wir', 'sie', 'zu', 'den',
  'o', 'os', 'as', 'da', 'um', 'uma', 'seu', 'sua', 'com', 'em', 'para', 'voce', 'het', 'een', 'van', 'uw', 'niet', 'op', 'il', 'di', 'che', 'per', 'non', 'della', 'och', 'att', 'er',
]);

/** Text a customer reads, without data tokens, placeholders, links' addresses and the safe-markup markers. */
function readable(text: string): string {
  return text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\{\w+\}/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\/\S*/g, ' ')
    .replace(/^\s*(?:#{1,6}|[-*•])\s+/gm, '')
    .replace(/\*\*|__|[*_`]/g, '')
    .replace(/[ \t]+/g, ' ');
}

/** Syllables of one English word by the usual vowel-group rule (silent final e, "-es"/"-ed" endings, at least one). */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const core = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = core.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 0);
}

/** True when the text is clearly not English (accented letters, inverted marks, or mostly another language's small words). */
function clearlyNotEnglish(words: string[], text: string): boolean {
  if (/[¿¡ñÑßãõÃÕ]/.test(text)) return true;
  const lower = words.map((w) => w.toLowerCase());
  const en = lower.filter((w) => EN_COMMON.has(w)).length;
  const other = lower.filter((w) => OTHER_COMMON.has(w) && !EN_COMMON.has(w)).length;
  const accented = (text.match(/[áéíóúàèìòùâêîôûäëïöüçÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÇ]/g) ?? []).length;
  if (accented >= 2 && en <= other) return true;
  return other >= 2 && other > en;
}

/**
 * Flesch–Kincaid grade of an ENGLISH text. Data tokens, markup markers and web addresses are left out before counting.
 * Returns null for fewer than three words or for text that is clearly not English (the formula only holds for English).
 * `longSentences` counts sentences of more than 20 words.
 */
export function readingLevel(text: string): { grade: number; label: string; words: number; sentences: number; longSentences: number } | null {
  if (typeof text !== 'string') return null;
  const clean = readable(text);
  const allWords = clean.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g) ?? [];
  if (allWords.length < 3) return null;
  if (clearlyNotEnglish(allWords, clean)) return null;
  const perSentence = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => (s.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g) ?? []).length)
    .filter((n) => n > 0);
  const sentences = Math.max(1, perSentence.length);
  const words = allWords.length;
  const syl = allWords.reduce((s, w) => s + w.split(/['’-]/).reduce((a, part) => a + syllables(part), 0), 0);
  const raw = 0.39 * (words / sentences) + 11.8 * (syl / words) - 15.59;
  const grade = Math.max(0, Math.round(raw * 10) / 10);
  const about = Math.max(1, Math.round(grade));
  const level = grade <= 6.5 ? 'Easy' : grade <= 9.5 ? 'Plain' : grade <= 12.5 ? 'Fairly hard' : 'Hard';
  const label = grade > 16 ? 'Hard (above grade 16)' : `${level} (about grade ${about})`;
  return { grade, label, words, sentences, longSentences: perSentence.filter((n) => n > 20).length };
}

/* ------------------------------------------------------------------ plain words shared by the engines */

type FieldScope = Pick<Project, 'documentType' | 'customFields'>;

const humanise = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** "3 rules", "1 rule". */
export function countWords(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "“A”, “B” and “C”", or with more than `max` items "“A”, “B”, “C” and 9 more labels". Items are used as given. */
export function listWords(items: string[], max = 3, noun = 'more'): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} ${noun === 'more' ? 'more' : `more ${noun}`}`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The label of a data field from the project's data contract ("Missed payments"), never the path. */
export function fieldWords(project: FieldScope, path: string): string {
  // A field of a list's items (wave 5) is named like any other field.
  const f = projectFieldIndex(project).get(path) ?? (path.includes('[]') ? allFieldIndex(project).get(path) : undefined);
  if (f?.label) return f.label;
  const leaf = humanise(path.split('.').slice(-1)[0] ?? path).replace(/ cents$/, '');
  return leaf ? leaf.charAt(0).toUpperCase() + leaf.slice(1) : path;
}

/** A value as a person would say it: yes/no, “overdue”, $45.00, Nov 25, 2026, empty. */
export function valueWords(project: FieldScope, path: string, value: unknown): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === null || value === undefined || value === '') return 'empty';
  const type = projectFieldIndex(project).get(path)?.type;
  if (typeof value === 'number') return type === 'cents' && Number.isInteger(value) ? formatCents(value, 'en-US') : String(value);
  if (typeof value === 'string') return type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatDate(value, 'en-US') : `“${type === 'enum' ? humanise(value) : value}”`;
  if (Array.isArray(value)) return countWords(value.length, 'item');
  return 'a value';
}

const lower1 = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A rule condition in plain words: "missed payments is at least 2 and assistance requested is no". */
export function conditionWords(project: FieldScope, p: Predicate | undefined): string {
  if (!p) return 'always';
  switch (p.op) {
    case 'and': return p.args.length ? p.args.map((a) => (a.op === 'or' ? `(${conditionWords(project, a)})` : conditionWords(project, a))).join(' and ') : 'always';
    case 'or': return p.args.length ? p.args.map((a) => (a.op === 'and' ? `(${conditionWords(project, a)})` : conditionWords(project, a))).join(' or ') : 'never';
    case 'not': return `it is not true that ${conditionWords(project, p.arg)}`;
    case 'items': return `${itemsLead(p.match, p.count, fieldWords(project, p.path))} ${conditionWords(project, p.where)}`;
    case 'isNull': return `${lower1(fieldWords(project, p.path))} is empty`;
    case 'notNull': return `${lower1(fieldWords(project, p.path))} has a value`;
    case 'in': return `${lower1(fieldWords(project, p.path))} is one of ${p.value.map((v: Scalar) => valueWords(project, p.path, v)).join(', ')}`;
    default: {
      const words: Record<string, string> = { eq: 'is', ne: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };
      return `${lower1(fieldWords(project, p.path))} ${words[p.op]} ${valueWords(project, p.path, p.value)}`;
    }
  }
}

/** The name people use for a component, message or disclosure: its name or title, never its id (unless it has neither). */
export function nodeWords(project: Pick<Project, 'nodes' | 'contentParts'>, id: string): string {
  const n = project.nodes.find((x) => x.id === id);
  if (n) return n.name?.trim() || n.label?.trim() || project.contentParts.find((c) => c.id === (n.contentPartId ?? id))?.title || humanise(id);
  return project.contentParts.find((c) => c.id === id)?.title?.trim() || humanise(id);
}

/** What a rule does, in words: "show “Assistance requested” in Payment guidance". */
export function actionWords(project: Pick<Project, 'nodes' | 'contentParts'>, a: RuleAction): string {
  switch (a.op) {
    case 'selectVariant': return `show “${nodeWords({ nodes: [], contentParts: project.contentParts }, a.variantId)}” in ${nodeWords(project, a.targetNodeId)}`;
    case 'showSection': return `show the section “${nodeWords(project, a.targetNodeId)}”`;
    case 'requireNodes': return `always include ${listWords(a.nodeIds.map((id) => `“${nodeWords(project, id)}”`), 4, 'more')}`;
    case 'setApprovedLocale': return `use the approved ${languageName(a.locale)} wording`;
    case 'setPresentationHint': return `apply the presentation “${humanise(a.hint)}”`;
  }
}

/** The rule's own title, or a short description of what it does when it has none. Not quoted. */
export function ruleWords(project: Pick<Project, 'nodes' | 'contentParts'>, rule: Pick<Rule, 'id' | 'title' | 'then'>): string {
  if (rule.title?.trim()) return rule.title.trim();
  const a = actionWords(project, rule.then);
  return a.charAt(0).toUpperCase() + a.slice(1);
}
