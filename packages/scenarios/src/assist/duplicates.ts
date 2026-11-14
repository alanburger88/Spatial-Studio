import { SOURCE_LANGUAGE, projectLanguages, shortDigest, type LibraryWordingContent, type Project } from '@iss/model';
import { wordingTexts, type WordingLinkRef, type WordingTextScope } from './wordingRules';

/**
 * Duplicate wording across documents (wave 3, section 2): ONE pure function that finds texts which are the same or nearly
 * the same in many documents and in the library's wording items, so they can be kept once in the shared library.
 *
 * Pure and deterministic: no network, clock, randomness or `Intl`. The same input in any order gives the same groups.
 * It compares WORDS, not meaning: two sentences that say the same thing in different words are not found.
 *
 * - Texts: the ones the wording checker reads (`wordingTexts`): messages and their alternatives, notices and disclosures,
 *   and, when asked, labels and headings and the email and SMS wording. English is compared with English, and each
 *   approved translation with the same language. Texts with fewer than `minWords` words are skipped and counted.
 * - Normalising: case, spacing, punctuation and quote style are ignored, and so is rich-text formatting (bold, italic,
 *   headings, bullets, link addresses). A data placeholder (`{{card.dueDate}}`, `{name}`) is a slot, whatever its name:
 *   two texts that differ only in their placeholders' names are the same wording, and that is reported.
 * - Exact: the same words in the same order. Near: a word-level similarity of at least `threshold` (default 0.85),
 *   `2 × (words in common, in order) / (words in both texts)`.
 * - Scale: identical texts are collapsed first; near pairs are found with a length filter and an index of each text's
 *   rarest words (a pair that could reach the threshold must share one of them), so not every pair is compared.
 */

/* ------------------------------------------------------------------ shapes */

export type DuplicateKind = WordingTextScope;
export const DUPLICATE_KINDS: readonly DuplicateKind[] = ['messages', 'disclosures', 'labels', 'email', 'sms'];
/** Labels and email/SMS wording are off by default: short labels such as "Total" are the same everywhere and are noise. */
export const DEFAULT_DUPLICATE_KINDS: readonly DuplicateKind[] = ['messages', 'disclosures'];
export const DUPLICATE_KIND_LABEL: Record<DuplicateKind, string> = { messages: 'Messages', disclosures: 'Notices and disclosures', labels: 'Labels and headings', email: 'Email wording', sms: 'Text message wording' };
export const DEFAULT_DUPLICATE_THRESHOLD = 0.85;
export const MIN_DUPLICATE_THRESHOLD = 0.5;
export const DEFAULT_DUPLICATE_MIN_WORDS = 4;

/** One saved document to scan. */
export interface DuplicateDocumentInput { projectId: string; title: string; project: Project }
/** One wording item of the library (its latest approved version, or its draft when none is approved yet). */
export interface DuplicateLibraryInput { itemId: string; title: string; version: number; state: 'approved' | 'draft'; content: LibraryWordingContent }

export interface DuplicateOptions {
  /** Near-duplicate similarity from 0.5 to 1 (1 = exact only). Default 0.85. */
  threshold?: number;
  /** Kinds of text compared. Default messages and disclosures. */
  kinds?: readonly DuplicateKind[];
  /** Only this language (default: every language). */
  language?: string | null;
  /** Texts with fewer words are skipped (default 4). */
  minWords?: number;
}

export interface DiffPiece { text: string; changed: boolean }

/** One use of a text: in a document (a message, notice, label …) or a library wording item. */
export interface DuplicateMember {
  /** Unique: `doc:<projectId>:<textId>:<locale>` or `lib:<itemId>:<locale>`. */
  key: string;
  source: 'document' | 'library';
  projectId?: string;
  projectTitle?: string;
  itemId?: string;
  itemTitle?: string;
  itemVersion?: number;
  itemState?: 'approved' | 'draft';
  /** The text's id in the document (content part or string id), or the library item's part id. */
  textId: string;
  /** "Payment reminder", "New balance · label". */
  title: string;
  kind: DuplicateKind;
  locale: string;
  nodeId?: string;
  partId?: string;
  /** The text as stored. */
  text: string;
  /** The text without formatting, as a person reads it (placeholders kept). */
  plain: string;
  /** Which wording of the group it has (0 = the group's most used wording). */
  form: number;
  /** Similarity to the group's most used wording (1 = the same words). */
  similarity: number;
  /** `plain` in pieces, with the words that differ from the most used wording marked. */
  pieces: DiffPiece[];
  /** Words of the most used wording that this text does not have. */
  missing: string[];
  /** Its placeholders have other names than those of the suggested text (same slots). */
  placeholderNamesDiffer: boolean;
  /** The library item this document text is linked from (read-only in the document). */
  linked: WordingLinkRef | null;
  /** A document text that is a message or notice itself, so a library wording item can be linked in its place. */
  linkable: boolean;
}

export interface DuplicateLibraryRef { itemId: string; title: string; version: number; state: 'approved' | 'draft' | 'linked' }

export interface DuplicateGroup {
  /** Stable for the same wording: `<locale>:<digest of the most used wording>`. */
  id: string;
  locale: string;
  /** exact: every text has the same words; near: some differ by a few words. */
  match: 'exact' | 'near';
  /** Every text has the same words and only placeholder names differ between some of them. */
  placeholderNamesOnly: boolean;
  /** How many different documents use it. */
  documents: number;
  /** How many different wordings the group has (1 for an exact group). */
  forms: number;
  /** The lowest similarity of a text to the most used wording. */
  lowestSimilarity: number;
  kinds: DuplicateKind[];
  members: DuplicateMember[];
  /** The member whose text is suggested to keep: the most used wording, then deterministic tie-breaks. */
  suggested: string;
  /** Library items in the group, as members or linked from a member. */
  library: DuplicateLibraryRef[];
  /** Every document text in the group is already linked from the same library item. */
  allLinked: boolean;
}

export interface DuplicateScan {
  threshold: number;
  minWords: number;
  kinds: DuplicateKind[];
  language: string | null;
  groups: DuplicateGroup[];
  coverage: {
    documents: number;
    libraryItems: number;
    /** Texts compared (all languages). */
    texts: number;
    /** Texts skipped for being shorter than `minWords` words. */
    skippedShort: number;
    languages: string[];
    /** Pairs of different wordings whose similarity was worked out (the rest were ruled out by the filters). */
    pairsCompared: number;
  };
}

/* ------------------------------------------------------------------ normalising */

const SLOT = '{}';
const TOKEN_RE = /\{\{[^{}]*\}\}|\{\w+\}|[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;

/** Rich-text formatting removed (bold, italic, headings, bullets, link addresses); words, punctuation and placeholders kept. */
export function plainWording(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[\s(])\*(?=\S)|(?<=\S)\*(?=[\s).,;:!?]|$)/gm, '$1')
    .replace(/^\s*(#{1,6}|[-•])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Token { start: number; end: number; word: string; slot: string | null }

/** The words of a plain text (lower case, apostrophes dropped), with each placeholder as a slot. */
function tokensOf(plain: string): Token[] {
  const out: Token[] = [];
  for (const m of plain.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const isSlot = raw.startsWith('{');
    out.push({ start: m.index!, end: m.index! + raw.length, word: isSlot ? SLOT : raw.toLowerCase().replace(/['’ʼ]/g, ''), slot: isSlot ? raw.replace(/[{}\s]/g, '') : null });
  }
  return out;
}

/** The normal form of a text: its words in order, placeholders as slots. Two texts with the same normal form are exact duplicates. */
export function normalizeWording(text: string): string {
  return tokensOf(plainWording(text)).map((t) => t.word).join(' ');
}

/** The names of a text's placeholders, in order. */
export function placeholderNames(text: string): string[] {
  return tokensOf(plainWording(text)).filter((t) => t.slot !== null).map((t) => t.slot!);
}

/** Length of the longest common subsequence of two word lists (two rows, so long texts stay cheap in memory). */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Uint32Array(b.length + 1), cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Word-level similarity: 2 × (words in common, in order) / (words in both). 1 = the same words. */
export function wordSimilarity(a: string, b: string): number {
  const x = a ? a.split(' ') : [], y = b ? b.split(' ') : [];
  if (!x.length && !y.length) return 1;
  return (2 * lcsLength(x, y)) / (x.length + y.length);
}

/** Which words of `a` are in a longest common subsequence with `b` (true = kept). */
function keptWords(a: readonly string[], b: readonly string[]): { keptA: boolean[]; keptB: boolean[] } {
  const n = a.length, m = b.length;
  const keptA = new Array<boolean>(n).fill(false), keptB = new Array<boolean>(m).fill(false);
  if (n * m > 4_000_000) return { keptA, keptB };
  const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keptA[i] = true; keptB[j] = true; i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
  }
  return { keptA, keptB };
}

/** The plain text in pieces, with the words that are not in the reference marked as changed, and the reference's missing words. */
export function wordingDiff(text: string, reference: string): { pieces: DiffPiece[]; missing: string[] } {
  const plain = plainWording(text), refPlain = plainWording(reference);
  const tk = tokensOf(plain), rk = tokensOf(refPlain);
  const { keptA, keptB } = keptWords(tk.map((t) => t.word), rk.map((t) => t.word));
  const pieces: DiffPiece[] = [];
  const push = (s: string, changed: boolean) => { if (!s) return; const last = pieces[pieces.length - 1]; if (last && last.changed === changed) last.text += s; else pieces.push({ text: s, changed }); };
  let at = 0;
  tk.forEach((t, i) => {
    const gap = plain.slice(at, t.start);
    // Space between two changed words belongs to the change, so a changed phrase is one piece.
    push(gap, !keptA[i] && i > 0 && !keptA[i - 1] && /^\s+$/.test(gap));
    push(plain.slice(t.start, t.end), !keptA[i]);
    at = t.end;
  });
  push(plain.slice(at), false);
  const missing = rk.filter((_, j) => !keptB[j]).map((t) => refPlain.slice(t.start, t.end));
  return { pieces, missing };
}

/* ------------------------------------------------------------------ collecting the texts */

interface Text {
  key: string;
  source: 'document' | 'library';
  owner: string;
  projectId?: string;
  projectTitle?: string;
  itemId?: string;
  itemTitle?: string;
  itemVersion?: number;
  itemState?: 'approved' | 'draft';
  textId: string;
  title: string;
  kind: DuplicateKind;
  locale: string;
  nodeId?: string;
  partId?: string;
  text: string;
  norm: string;
  words: number;
  linked: WordingLinkRef | null;
  linkable: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function collect(docs: readonly DuplicateDocumentInput[], items: readonly DuplicateLibraryInput[], o: Required<Omit<DuplicateOptions, 'language'>> & { language: string | null }): { texts: Text[]; skipped: number } {
  const kinds = new Set(o.kinds);
  const out: Text[] = [];
  let skipped = 0;
  const add = (t: Omit<Text, 'norm' | 'words'>) => {
    if (!kinds.has(t.kind) || (o.language && t.locale !== o.language)) return;
    const norm = normalizeWording(t.text);
    const words = norm ? norm.split(' ').filter((w) => w !== SLOT).length : 0;
    if (words < o.minWords) { skipped++; return; }
    out.push({ ...t, norm, words });
  };
  for (const d of docs) {
    const locales = [SOURCE_LANGUAGE, ...projectLanguages(d.project)];
    for (const w of wordingTexts(d.project, o.language ? locales.filter((l) => l === o.language) : locales)) {
      add({
        key: `doc:${d.projectId}:${w.id}:${w.locale}`, source: 'document', owner: `doc:${d.projectId}`, projectId: d.projectId, projectTitle: d.title,
        textId: w.id, title: w.title, kind: w.scope, locale: w.locale, ...(w.nodeId ? { nodeId: w.nodeId } : {}), ...(w.partId ? { partId: w.partId } : {}),
        text: w.text, linked: w.linked ?? null, linkable: !!w.partId && w.partId === w.id,
      });
    }
  }
  for (const it of items) {
    const p = it.content.part;
    for (const [locale, text] of Object.entries(p.approvedLocales)) {
      if (typeof text !== 'string' || !text.trim()) continue;
      add({
        key: `lib:${it.itemId}:${locale}`, source: 'library', owner: `lib:${it.itemId}`, itemId: it.itemId, itemTitle: it.title, itemVersion: it.version, itemState: it.state,
        textId: p.id, title: it.title, kind: p.type === 'disclosure' ? 'disclosures' : 'messages', locale, text, linked: null, linkable: false,
      });
    }
  }
  out.sort((a, b) => cmp(a.key, b.key));
  return { texts: out, skipped };
}

/* ------------------------------------------------------------------ finding near pairs */

/**
 * Pairs of different wordings (normal forms) of one language with a similarity of at least `t`.
 * Filters, both exact (no pair that reaches `t` is missed):
 * - length: 2·min/(n+m) ≥ t, so a text is only compared with texts of a similar length;
 * - shared words: a pair reaching `t` shares at least ⌈t·(n+m)/2⌉ words; each text indexes only its rarest
 *   `n − k + 1` words (k: the least it can share with any partner long enough), and two texts that share that many
 *   words always share one of those (the prefix-filter lemma). Words are counted with their occurrence (“the#2”).
 */
function nearPairs(forms: readonly string[], t: number): { pairs: Array<[number, number, number]>; compared: number } {
  const words = forms.map((f) => (f ? f.split(' ') : []));
  const toks = words.map((ws) => { const seen = new Map<string, number>(); return ws.map((w) => { const k = (seen.get(w) ?? 0) + 1; seen.set(w, k); return `${w}#${k}`; }); });
  const freq = new Map<string, number>();
  for (const ts of toks) for (const x of ts) freq.set(x, (freq.get(x) ?? 0) + 1);
  // Every word gets a rank, rarest first (ties by the word), so each text is a sorted list of numbers.
  const rank = new Map([...freq.keys()].sort((a, b) => (freq.get(a)! - freq.get(b)!) || cmp(a, b)).map((x, i) => [x, i] as const));
  const sets = toks.map((ts) => Int32Array.from(ts.map((x) => rank.get(x)!)).sort());
  const ratio = t / (2 - t);
  const overlap = (a: Int32Array, b: Int32Array): number => { let i = 0, j = 0, n = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { n++; i++; j++; } else if (a[i] < b[j]) i++; else j++; } return n; };
  // Shorter texts first; each text probes the index with its prefix (rarest words), then adds its prefix to it.
  const order = forms.map((_, i) => i).sort((a, b) => words[a].length - words[b].length || a - b);
  const index = new Map<number, number[]>();
  const pairs: Array<[number, number, number]> = [];
  let compared = 0;
  for (const i of order) {
    const n = sets[i].length;
    if (!n) continue;
    const mMin = Math.ceil(n * ratio - 1e-9);
    const k = Math.max(1, Math.ceil((t * (n + mMin)) / 2 - 1e-9));
    const prefix = sets[i].subarray(0, Math.max(1, n - k + 1));
    const seen = new Set<number>();
    for (const x of prefix) for (const j of index.get(x) ?? []) {
      if (seen.has(j)) continue;
      seen.add(j);
      const m = sets[j].length;
      // Length filter (j is never longer than i here); then shared words bound the words in common.
      if (m < ratio * n - 1e-9) continue;
      if (overlap(sets[i], sets[j]) < (t * (n + m)) / 2 - 1e-9) continue;
      compared++;
      const s = (2 * lcsLength(words[i], words[j])) / (n + m);
      if (s >= t - 1e-9) pairs.push([Math.min(i, j), Math.max(i, j), s]);
    }
    for (const x of prefix) { const l = index.get(x); if (l) l.push(i); else index.set(x, [i]); }
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { pairs, compared };
}

/* ------------------------------------------------------------------ the scan */

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** Finds groups of the same or nearly the same wording across documents and the library's wording items. Pure. */
export function findDuplicateWording(docs: readonly DuplicateDocumentInput[], items: readonly DuplicateLibraryInput[] = [], options: DuplicateOptions = {}): DuplicateScan {
  const threshold = Math.min(1, Math.max(MIN_DUPLICATE_THRESHOLD, Number.isFinite(options.threshold) ? Number(options.threshold) : DEFAULT_DUPLICATE_THRESHOLD));
  const kinds = DUPLICATE_KINDS.filter((k) => (options.kinds ?? DEFAULT_DUPLICATE_KINDS).includes(k));
  const minWords = Math.max(1, Math.floor(Number.isFinite(options.minWords) ? Number(options.minWords) : DEFAULT_DUPLICATE_MIN_WORDS));
  const language = options.language || null;
  const sortedDocs = [...docs].sort((a, b) => cmp(a.projectId, b.projectId));
  const sortedItems = [...items].sort((a, b) => cmp(a.itemId, b.itemId));
  const { texts, skipped } = collect(sortedDocs, sortedItems, { threshold, kinds, minWords, language });

  const groups: DuplicateGroup[] = [];
  let pairsCompared = 0;
  const locales = [...new Set(texts.map((x) => x.locale))].sort(cmp);
  for (const locale of locales) {
    // 1. identical wording collapses into one form
    const byForm = new Map<string, Text[]>();
    for (const x of texts) if (x.locale === locale) { const l = byForm.get(x.norm); if (l) l.push(x); else byForm.set(x.norm, [x]); }
    const forms = [...byForm.keys()].sort(cmp);
    // 2. near pairs between different forms, joined into groups (union–find, smallest index as the root)
    const parent = forms.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    if (threshold < 1) {
      const near = nearPairs(forms, threshold);
      pairsCompared += near.compared;
      for (const [a, b] of near.pairs) { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
    }
    const comps = new Map<number, number[]>();
    forms.forEach((_, i) => { const r = find(i); const l = comps.get(r); if (l) l.push(i); else comps.set(r, [i]); });
    for (const formIdx of comps.values()) {
      const all = formIdx.flatMap((i) => byForm.get(forms[i])!);
      if (new Set(all.map((x) => x.owner)).size < 2) continue;
      groups.push(buildGroup(locale, formIdx.map((i) => ({ norm: forms[i], texts: byForm.get(forms[i])! }))));
    }
  }
  groups.sort((a, b) => b.documents - a.documents || b.members.length - a.members.length || cmp(a.locale, b.locale) || cmp(a.id, b.id));
  return { threshold, minWords, kinds: [...kinds], language, groups, coverage: { documents: docs.length, libraryItems: items.length, texts: texts.length, skippedShort: skipped, languages: locales, pairsCompared } };
}

/** Uses of a wording: different documents and library items, then texts. */
const usesOf = (texts: readonly Text[]) => new Set(texts.map((x) => x.owner)).size;

function buildGroup(locale: string, forms: Array<{ norm: string; texts: Text[] }>): DuplicateGroup {
  // The most used wording first: most documents and library items, then most texts, then one already in the library, then the normal form.
  const inLib = (f: { texts: Text[] }) => f.texts.some((x) => x.source === 'library');
  forms.sort((a, b) => usesOf(b.texts) - usesOf(a.texts) || b.texts.length - a.texts.length || Number(inLib(b)) - Number(inLib(a)) || cmp(a.norm, b.norm));
  const main = forms[0];
  // The suggested text: of the most used wording, a library item's text first, then the one whose placeholder names most texts share, then by key.
  const nameKey = (x: Text) => placeholderNames(x.text).join('|');
  const nameUses = new Map<string, number>();
  for (const x of main.texts) nameUses.set(nameKey(x), (nameUses.get(nameKey(x)) ?? 0) + 1);
  const suggested = [...main.texts].sort((a, b) => Number(b.source === 'library') - Number(a.source === 'library') || nameUses.get(nameKey(b))! - nameUses.get(nameKey(a))! || cmp(a.key, b.key))[0];
  const refNames = placeholderNames(suggested.text);
  const members: DuplicateMember[] = [];
  forms.forEach((f, fi) => {
    const sim = fi === 0 ? 1 : round(wordSimilarity(f.norm, main.norm));
    for (const x of f.texts) {
      const d = fi === 0 ? { pieces: [{ text: plainWording(x.text), changed: false }], missing: [] } : wordingDiff(x.text, suggested.text);
      const names = placeholderNames(x.text);
      members.push({
        key: x.key, source: x.source,
        ...(x.projectId ? { projectId: x.projectId, projectTitle: x.projectTitle } : {}),
        ...(x.itemId ? { itemId: x.itemId, itemTitle: x.itemTitle, itemVersion: x.itemVersion, itemState: x.itemState } : {}),
        textId: x.textId, title: x.title, kind: x.kind, locale: x.locale, ...(x.nodeId ? { nodeId: x.nodeId } : {}), ...(x.partId ? { partId: x.partId } : {}),
        text: x.text, plain: plainWording(x.text), form: fi, similarity: sim, pieces: d.pieces, missing: d.missing,
        placeholderNamesDiffer: names.length === refNames.length && names.some((n, i) => n !== refNames[i]),
        linked: x.linked, linkable: x.linkable,
      });
    }
  });
  // Members: the suggested text first, then by wording, then documents by title.
  const order = (m: DuplicateMember) => `${m.form.toString().padStart(4, '0')}|${m.source === 'library' ? 0 : 1}|${(m.projectTitle ?? m.itemTitle ?? '').toLowerCase()}|${m.key}`;
  members.sort((a, b) => Number(b.key === suggested.key) - Number(a.key === suggested.key) || cmp(order(a), order(b)));
  const library = new Map<string, DuplicateLibraryRef>();
  for (const m of members) {
    if (m.source === 'library') library.set(m.itemId!, { itemId: m.itemId!, title: m.itemTitle!, version: m.itemVersion!, state: m.itemState! });
    else if (m.linked && !library.has(m.linked.itemId)) library.set(m.linked.itemId, { itemId: m.linked.itemId, title: m.linked.title, version: m.linked.version, state: 'linked' });
  }
  const docMembers = members.filter((m) => m.source === 'document');
  const linkedItems = new Set(docMembers.map((m) => m.linked?.itemId ?? ''));
  const placeholderNamesOnly = forms.length === 1 && members.some((m) => m.placeholderNamesDiffer);
  return {
    id: `${locale}:${shortDigest(main.norm, 12)}`, locale, match: forms.length === 1 ? 'exact' : 'near', placeholderNamesOnly,
    documents: new Set(docMembers.map((m) => m.projectId)).size, forms: forms.length,
    lowestSimilarity: Math.min(...members.map((m) => m.similarity)),
    kinds: DUPLICATE_KINDS.filter((k) => members.some((m) => m.kind === k)),
    members, suggested: suggested.key, library: [...library.values()].sort((a, b) => cmp(a.title, b.title) || cmp(a.itemId, b.itemId)),
    allLinked: docMembers.length > 0 && linkedItems.size === 1 && !linkedItems.has(''),
  };
}

/* ------------------------------------------------------------------ keeping a wording in the library */

/** The approved translations of one document text (a content part or a string), English left out. */
export function approvedTranslationsOf(project: Project, textId: string): Record<string, string> {
  const part = project.contentParts.find((c) => c.id === textId);
  const src = part ? part.approvedLocales : project.strings?.[textId]?.approved ?? {};
  const out: Record<string, string> = {};
  for (const [l, t] of Object.entries(src)) if (l !== SOURCE_LANGUAGE && typeof t === 'string' && t.trim()) out[l] = t;
  return out;
}

/**
 * The translations every member shares: a language is kept only when EVERY member has an approved translation in it
 * and they are all exactly the same text. Anything else is left for a translator to do in the library.
 */
export function sharedTranslations(members: ReadonlyArray<Record<string, string>>): Record<string, string> {
  if (!members.length) return {};
  const out: Record<string, string> = {};
  for (const l of Object.keys(members[0]).sort(cmp)) {
    const first = members[0][l];
    if (members.every((m) => typeof m[l] === 'string' && m[l].trim() === first.trim())) out[l] = first.trim();
  }
  return out;
}
