import { describe, expect, it } from 'vitest';
import { applyCommand, type LibraryWordingContent, type Project } from '@iss/model';
import { seedProjects } from '../../model/src/fixtures';
import {
  approvedTranslationsOf, findDuplicateWording, normalizeWording, placeholderNames, plainWording, sharedTranslations, wordSimilarity, wordingDiff,
  type DuplicateDocumentInput, type DuplicateLibraryInput,
} from '../src/index';

const [card, eob] = seedProjects();
const NOTICE = 'Interest is charged on any balance you carry past the due date; see the terms for the current rate.';
const NEAR = 'Interest is charged on any balance you carry past the due date; see the terms for the annual rate.';

/** A copy of the card statement as another saved document, with some message texts replaced (English and translations). */
function doc(projectId: string, texts: Record<string, string | Record<string, string>> = {}, base: Project = card): DuplicateDocumentInput {
  const p: Project = JSON.parse(JSON.stringify(base));
  p.projectId = projectId;
  for (const [id, t] of Object.entries(texts)) {
    const part = p.contentParts.find((c) => c.id === id)!;
    part.approvedLocales = typeof t === 'string' ? { 'en-US': t } : { ...t };
  }
  return { projectId, title: `Document ${projectId}`, project: p };
}
const lib = (itemId: string, text: string | Record<string, string>, state: 'approved' | 'draft' = 'approved', type: 'text' | 'disclosure' = 'disclosure'): DuplicateLibraryInput => ({
  itemId, title: `Item ${itemId}`, version: 1, state, content: { part: { id: itemId, title: `Item ${itemId}`, type, approvedLocales: typeof text === 'string' ? { 'en-US': text } : text } } as LibraryWordingContent,
});
const groupWith = (scan: ReturnType<typeof findDuplicateWording>, needle: string) => scan.groups.filter((g) => g.members.some((m) => m.plain.includes(needle)));

describe('normalising', () => {
  it('ignores case, spacing, punctuation, quote style and rich-text formatting; placeholders are slots', () => {
    const a = normalizeWording('Your “statement” is READY —   see {{card.dueDate}}.');
    expect(a).toBe('your statement is ready see {}');
    expect(normalizeWording('your "statement" is ready, see {{ customer.date }}')).toBe(a);
    expect(normalizeWording("**Your** *‘statement’* is [ready](https://example.com/x) see {due}")).toBe(a);
    expect(normalizeWording('# Your statement\n\n- is ready\n- see {{x}}')).toBe(a);
    // apostrophes inside a word: both styles are the same word
    expect(normalizeWording('Don’t miss it')).toBe(normalizeWording("don't miss it"));
    expect(plainWording('**Bold** and [a link](https://x.example) and *italic*')).toBe('Bold and a link and italic');
    expect(placeholderNames('Due {{card.dueDate}} for {name}')).toEqual(['card.dueDate', 'name']);
  });

  it('word similarity and the differing words', () => {
    expect(wordSimilarity(normalizeWording(NOTICE), normalizeWording(NEAR))).toBeCloseTo(1 - 2 / 38, 5);
    const d = wordingDiff(NEAR, NOTICE);
    expect(d.pieces.filter((p) => p.changed).map((p) => p.text)).toEqual(['annual']);
    expect(d.missing).toEqual(['current']);
    expect(d.pieces.map((p) => p.text).join('')).toBe(NEAR);
  });
});

describe('finding duplicate wording', () => {
  it('exact groups across documents (ignoring case and punctuation) and a near-duplicate joined to them', () => {
    const scan = findDuplicateWording([
      doc('a', { 'sample-disclosure-set': NOTICE }),
      doc('b', { 'sample-disclosure-set': NOTICE.toUpperCase().replace(/;/g, ' —') }),
      doc('c', { 'sample-disclosure-set': NEAR }),
    ]);
    const [g] = groupWith(scan, 'see the terms');
    expect(g.match).toBe('near');
    expect(g.documents).toBe(3);
    expect(g.forms).toBe(2);
    expect(g.members.map((m) => [m.projectId, m.form, m.kind, m.locale])).toEqual([['a', 0, 'disclosures', 'en-US'], ['b', 0, 'disclosures', 'en-US'], ['c', 1, 'disclosures', 'en-US']]);
    expect(g.suggested).toBe('doc:a:sample-disclosure-set:en-US');
    const c = g.members[2];
    expect(c.similarity).toBeCloseTo(0.947, 3);
    expect(c.pieces.filter((p) => p.changed).map((p) => p.text)).toEqual(['annual']);
    expect(c.missing).toEqual(['current']);
    expect(c.linkable).toBe(true);
    expect(c.title).toBe(card.contentParts.find((x) => x.id === 'sample-disclosure-set')!.title);
    // The other texts are copies of the same document: exact groups of two (a and b), with c's own copy joining them.
    const others = scan.groups.filter((x) => x.id !== g.id);
    expect(others.length).toBeGreaterThan(5);
    expect(others.every((x) => x.match === 'exact' && x.documents === 3)).toBe(true);
    // Sorted by how many documents a group spans
    expect(scan.groups.map((x) => x.documents)).toEqual([...scan.groups.map((x) => x.documents)].sort((p, q) => q - p));
  });

  it('the threshold decides what is near; 1 means exact only; it is stated in the result', () => {
    const docs = [doc('a', { 'sample-disclosure-set': NOTICE }), doc('b', { 'sample-disclosure-set': NEAR })];
    expect(findDuplicateWording(docs).threshold).toBe(0.85);
    expect(groupWith(findDuplicateWording(docs), 'see the terms')).toHaveLength(1);
    expect(groupWith(findDuplicateWording(docs, [], { threshold: 0.96 }), 'see the terms')).toHaveLength(0);
    expect(groupWith(findDuplicateWording(docs, [], { threshold: 1 }), 'see the terms')).toHaveLength(0);
    expect(findDuplicateWording(docs, [], { threshold: 0.1 }).threshold).toBe(0.5);
    // A text with a few words changed in a short sentence is further apart
    const short = [doc('a', { 'payment-reminder': 'We noticed your scheduled payment has not yet arrived.' }), doc('b', { 'payment-reminder': 'We saw your planned payment has not arrived.' })];
    const sim = wordSimilarity(normalizeWording('We noticed your scheduled payment has not yet arrived.'), normalizeWording('We saw your planned payment has not arrived.'));
    expect(groupWith(findDuplicateWording(short, [], { threshold: 0.85 }), 'has not')).toHaveLength(0);
    expect(groupWith(findDuplicateWording(short, [], { threshold: Math.floor(sim * 100) / 100 }), 'has not')).toHaveLength(1);
  });

  it('placeholders are compared by position; a difference only in their names is said', () => {
    const scan = findDuplicateWording([
      doc('a', { 'payment-standard': 'Your payment of {{card.minimumDueCents}} is due on {{card.dueDate}}.' }),
      doc('b', { 'payment-standard': 'Your payment of {{card.minimum}} is due on {{card.due}}.' }),
      doc('c', { 'payment-standard': 'Your payment of {{card.minimumDueCents}} is due on {{card.dueDate}}.' }),
    ]);
    const [g] = groupWith(scan, 'Your payment of');
    expect(g.match).toBe('exact');
    expect(g.placeholderNamesOnly).toBe(true);
    expect(g.members.map((m) => [m.projectId, m.placeholderNamesDiffer])).toEqual([['a', false], ['b', true], ['c', false]]);
    // a placeholder is not a word: moving it changes the wording
    const moved = findDuplicateWording([doc('a', { 'payment-standard': 'Pay {{x}} now please before the due date.' }), doc('b', { 'payment-standard': 'Pay now {{x}} please before the due date.' })], [], { threshold: 1 });
    expect(groupWith(moved, 'Pay')).toHaveLength(0);
  });

  it('keeps languages apart: English with English, each approved translation with its own language', () => {
    const es = 'Se cobran intereses sobre cualquier saldo después de la fecha de vencimiento.';
    const scan = findDuplicateWording([
      doc('a', { 'sample-disclosure-set': { 'en-US': NOTICE, 'es-US': es } }),
      doc('b', { 'sample-disclosure-set': { 'en-US': NOTICE, 'es-US': es } }),
      doc('c', { 'sample-disclosure-set': { 'en-US': 'Something entirely different is written here for the readers.', 'es-US': es } }),
    ]);
    const en = groupWith(scan, 'see the terms');
    const spanish = groupWith(scan, 'Se cobran');
    expect(en.map((g) => [g.locale, g.documents])).toEqual([['en-US', 2]]);
    expect(spanish.map((g) => [g.locale, g.documents])).toEqual([['es-US', 3]]);
    expect(scan.coverage.languages).toEqual(['en-US', 'es-US']);
    expect(findDuplicateWording(scan.groups.length ? [doc('a', { 'sample-disclosure-set': { 'en-US': NOTICE, 'es-US': es } }), doc('b', { 'sample-disclosure-set': { 'en-US': NOTICE, 'es-US': es } })] : [], [], { language: 'es-US' }).groups.every((g) => g.locale === 'es-US')).toBe(true);
  });

  it('kinds: messages and disclosures by default; labels and email/SMS only when asked; short texts skipped and counted', () => {
    const docs = [doc('a'), doc('b')];
    const def = findDuplicateWording(docs);
    expect(new Set(def.groups.flatMap((g) => g.kinds))).toEqual(new Set(['messages', 'disclosures']));
    expect(def.kinds).toEqual(['messages', 'disclosures']);
    const all = findDuplicateWording(docs, [], { kinds: ['labels', 'email', 'sms'] });
    expect(new Set(all.groups.flatMap((g) => g.kinds))).toEqual(new Set(['labels', 'email', 'sms']));
    // "New balance: {{…}}" has two words: skipped and counted, never grouped
    expect(def.coverage.skippedShort).toBeGreaterThan(0);
    expect(def.groups.some((g) => g.members.some((m) => m.textId === 'billing-summary'))).toBe(false);
    const fewer = findDuplicateWording(docs, [], { minWords: 1 });
    expect(fewer.coverage.skippedShort).toBe(0);
    expect(fewer.groups.some((g) => g.members.some((m) => m.textId === 'billing-summary'))).toBe(true);
    expect(def.coverage.texts + def.coverage.skippedShort).toBe(fewer.coverage.texts);
  });

  it('a library item is a member; a text linked from the library says so; a group of linked texts says it is all linked', () => {
    const plainItem = lib('interest-notice', NOTICE);
    const linkedDoc = (id: string) => {
      const d = doc(id);
      const r = applyCommand(d.project, { type: 'LINK_LIBRARY_ITEM', item: { id: 'interest-notice', kind: 'wording', title: 'Interest notice' }, version: 1, content: plainItem.content, placement: { partId: 'sample-disclosure-set' } });
      if (!r.ok) throw new Error(r.message);
      return { ...d, project: r.project };
    };
    const scan = findDuplicateWording([linkedDoc('a'), doc('b', { 'sample-disclosure-set': NOTICE }), doc('c', { 'sample-disclosure-set': NEAR })], [plainItem]);
    const [g] = groupWith(scan, 'see the terms');
    expect(g.members.find((m) => m.source === 'library')).toMatchObject({ itemId: 'interest-notice', itemState: 'approved', linkable: false });
    // the library's own text is suggested when it is of the most used wording
    expect(g.suggested).toBe('lib:interest-notice:en-US');
    expect(g.members.find((m) => m.projectId === 'a')!.linked).toMatchObject({ itemId: 'interest-notice', version: 1 });
    expect(g.members.find((m) => m.projectId === 'b')!.linked).toBeNull();
    expect(g.library).toEqual([{ itemId: 'interest-notice', title: 'Item interest-notice', version: 1, state: 'approved' }]);
    expect(g.allLinked).toBe(false);
    const done = findDuplicateWording([linkedDoc('a'), linkedDoc('b')], [plainItem]);
    expect(groupWith(done, 'see the terms')[0].allLinked).toBe(true);
    // one document alone with nothing to share is not a group
    expect(groupWith(findDuplicateWording([doc('a', { 'sample-disclosure-set': NOTICE }), doc('b')]), 'see the terms')).toEqual([]);
    expect(groupWith(findDuplicateWording([doc('a', { 'sample-disclosure-set': NOTICE }), doc('b')], [lib('x', NOTICE, 'draft')]), 'see the terms')[0].library[0].state).toBe('draft');
  });

  it('suggests the most used wording; ties are broken the same way every time', () => {
    const scan = findDuplicateWording([
      doc('a', { 'sample-disclosure-set': NEAR }), doc('b', { 'sample-disclosure-set': NOTICE }), doc('c', { 'sample-disclosure-set': NOTICE }),
    ]);
    expect(groupWith(scan, 'see the terms')[0].suggested).toBe('doc:b:sample-disclosure-set:en-US');
    // one each: the tie goes to the wording that sorts first, then the first document by id
    const tie = findDuplicateWording([doc('z', { 'sample-disclosure-set': NOTICE }), doc('y', { 'sample-disclosure-set': NEAR })]);
    const tg = groupWith(tie, 'see the terms')[0];
    const firstForm = [normalizeWording(NOTICE), normalizeWording(NEAR)].sort()[0];
    expect(normalizeWording(tg.members.find((m) => m.key === tg.suggested)!.text)).toBe(firstForm);
  });

  it('is deterministic: the same input in another order gives the same groups', () => {
    const docs = [doc('a', { 'sample-disclosure-set': NOTICE }), doc('b', { 'sample-disclosure-set': NEAR }), doc('c'), doc('e', {}, eob), doc('f', {}, eob)];
    const items = [lib('x', NOTICE), lib('y', 'The plan has processed the listed service.', 'approved', 'text')];
    const one = findDuplicateWording(docs, items);
    const two = findDuplicateWording([...docs].reverse(), [...items].reverse());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.groups.find((g) => g.members.some((m) => m.itemId === 'y'))!.documents).toBe(2);
  });
});

describe('keeping a wording in the library', () => {
  it('shares a translation only when every member has the same approved one', () => {
    expect(sharedTranslations([{ 'es-US': 'Hola mundo', 'fr-CA': 'Bonjour' }, { 'es-US': ' Hola mundo ', 'fr-CA': 'Salut' }, { 'es-US': 'Hola mundo' }])).toEqual({ 'es-US': 'Hola mundo' });
    expect(sharedTranslations([{ 'es-US': 'Hola' }, {}])).toEqual({});
    expect(sharedTranslations([])).toEqual({});
    const p = doc('a', { 'sample-disclosure-set': { 'en-US': NOTICE, 'es-US': 'Aviso' } }).project;
    expect(approvedTranslationsOf(p, 'sample-disclosure-set')).toEqual({ 'es-US': 'Aviso' });
  });
});

describe('scale', () => {
  it('5,000 texts are grouped without comparing every pair', () => {
    // A deterministic generator (no randomness in the engine; this only makes test data).
    let seed = 12345;
    const next = () => { seed = (seed * 48271) % 2147483647; return seed; };
    const vocab = Array.from({ length: 2000 }, (_, i) => `w${i.toString(36)}`);
    const common = ['the', 'your', 'a', 'of', 'to', 'and', 'is', 'for', 'on', 'in'];
    const sentence = () => Array.from({ length: 12 + (next() % 30) }, () => (next() % 3 === 0 ? common[next() % common.length] : vocab[next() % vocab.length])).join(' ');
    const items: DuplicateLibraryInput[] = [];
    const planted: string[] = [];
    for (let i = 0; i < 4900; i++) items.push(lib(`t${i}`, sentence(), 'approved', 'text'));
    // 50 planted pairs: 25 exact copies and 25 with one word changed in a long sentence
    for (let i = 0; i < 50; i++) {
      const base = (items[i * 7].content.part.approvedLocales as Record<string, string>)['en-US'];
      const words = base.split(' ');
      if (i % 2 && words.length >= 25) words[3] = 'changed';
      const text = i % 2 && words.length < 25 ? base : words.join(' ');
      items.push(lib(`p${i}`, text, 'approved', 'text'));
      planted.push(`t${i * 7}`);
    }
    for (let i = 0; i < 50; i++) items.push(lib(`q${i}`, sentence(), 'approved', 'text'));
    expect(items.length).toBe(5000);
    const t0 = performance.now();
    const scan = findDuplicateWording([], items);
    const ms = performance.now() - t0;
    console.log(`duplicates: 5,000 texts in ${Math.round(ms)} ms, ${scan.coverage.pairsCompared} pairs compared of ${(5000 * 4999) / 2}, ${scan.groups.length} groups`);
    expect(scan.coverage.texts).toBe(5000);
    for (const id of planted) expect(scan.groups.some((g) => g.members.some((m) => m.itemId === id)), id).toBe(true);
    expect(scan.groups.length).toBe(50);
    expect(scan.coverage.pairsCompared).toBeLessThan(5000);
    expect(ms).toBeLessThan(5000);
  });

  it('the filters never miss a pair: the same groups as comparing every pair', () => {
    let seed = 777;
    const next = () => { seed = (seed * 48271) % 2147483647; return seed; };
    const vocab = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const bases = Array.from({ length: 40 }, () => Array.from({ length: 6 + (next() % 20) }, () => vocab[next() % vocab.length]));
    const texts = Array.from({ length: 300 }, (_, i) => {
      const ws = [...bases[i % bases.length]];
      for (let k = next() % 5; k > 0; k--) { const at = next() % ws.length; if (next() % 3 === 0) ws.splice(at, 1); else ws[at] = vocab[next() % vocab.length]; }
      return ws.join(' ');
    });
    for (const t of [0.6, 0.75, 0.85, 0.95]) {
      const items = texts.map((x, i) => lib(`b${i}`, x, 'approved', 'text'));
      const scan = findDuplicateWording([], items, { threshold: t, minWords: 1 });
      // brute force over the distinct wordings
      const forms = [...new Set(texts.map(normalizeWording))].sort();
      const parent = forms.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let a = 0; a < forms.length; a++) for (let b = a + 1; b < forms.length; b++) if (wordSimilarity(forms[a], forms[b]) >= t - 1e-9) parent[find(a)] = find(b);
      const want = new Map<number, string[]>();
      texts.forEach((x, i) => { const r = find(forms.indexOf(normalizeWording(x))); want.set(r, [...(want.get(r) ?? []), `b${i}`]); });
      const expected = [...want.values()].filter((l) => l.length > 1).map((l) => l.sort().join(',')).sort();
      const got = scan.groups.map((g) => g.members.map((m) => m.itemId!).sort().join(',')).sort();
      expect(got, `threshold ${t}`).toEqual(expected);
    }
  });

  it('200 saved documents of two kinds (texts collected from each document)', () => {
    const docs = Array.from({ length: 200 }, (_, i) => doc(`d${String(i).padStart(3, '0')}`, i % 2 && i % 3 === 0 ? { 'sample-disclosure-set': i % 4 === 1 ? NOTICE : NEAR } : {}, i % 2 ? card : eob));
    const t0 = performance.now();
    const scan = findDuplicateWording(docs);
    const ms = performance.now() - t0;
    console.log(`duplicates: 200 documents, ${scan.coverage.texts} texts in ${Math.round(ms)} ms`);
    expect(groupWith(scan, 'see the terms')[0].documents).toBe(33);
    expect(ms).toBeLessThan(10000);
  });
});
