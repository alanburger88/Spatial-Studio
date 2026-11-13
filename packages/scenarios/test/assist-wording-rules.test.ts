import { describe, expect, it } from 'vitest';
import { applyCommand, diffProjects, projectFileProblems, type Command, type Project, type WordingRule } from '@iss/model';
import { RECORDS, seedProjects } from '../../model/src/fixtures';
import {
  adaptCase, checkWording, documentBlockers, findPhrase, fixImpact, mask, proposeFixes, safeFixPlan, sentencesOf, setTextCommands, summarizeChanges,
  wordingEditEffect, wordingFindings, wordingFixFor, wordingReleaseRecord, wordingRulesInForce, wordingTexts, type RuleInForce,
} from '../src/index';

const [card, eob] = seedProjects();
const run = (p: Project, ...cs: Command[]): Project => cs.reduce((acc, c) => { const r = applyCommand(acc, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const refused = (p: Project, c: Command) => { const r = applyCommand(p, c); return r.ok ? null : r; };
const own = (p: Project, ...rules: WordingRule[]): Project => run(p, ...rules.map((rule) => ({ type: 'ADD_WORDING_RULE', rule }) as Command));
const house = (p: Project, rules: WordingRule[], version = 1): Project => run(p, { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-rules', kind: 'wording-rules', title: 'House rules' }, version, content: { rules } });
const rule = (r: Partial<WordingRule> & Pick<WordingRule, 'id' | 'kind'>): WordingRule => ({ severity: 'must', ...r }) as WordingRule;
/** One text checked as if typed, with these rules. */
const typed = (p: Project, text: string, rules: WordingRule[], scope: 'messages' | 'labels' | 'email' | 'sms' | 'disclosures' = 'messages', locale = 'en-US') =>
  checkWording(p, { rules: rules.map((r): RuleInForce => ({ rule: r, origin: 'own', link: null, key: `own:${r.id}`, label: r.id })), text: { text, scope, locale } });
const setPart = (p: Project, id: string, text: string): Project => run(p, { type: 'UPSERT_CONTENT_PART', part: { ...p.contentParts.find((c) => c.id === id)!, approvedLocales: { ...p.contentParts.find((c) => c.id === id)!.approvedLocales, 'en-US': text } } });

describe('the checker, rule by rule', () => {
  it('a banned phrase: whole words, ignoring case, placeholders skipped, every position, the replacement in the case of the match', () => {
    const banned = [rule({ id: 'b', kind: 'banned', phrase: 'past due', replacement: 'overdue' })];
    const text = 'Past due: your account is PAST   DUE. {{card.pastDue}} is not wording; pastdue and past dues are not matches.';
    const f = typed(card, text, banned).findings;
    expect(f).toHaveLength(1);
    expect(f[0].occurrences.map((o) => [o.start, o.end, o.match])).toEqual([[0, 8, 'Past due'], [26, 36, 'PAST   DUE']]);
    expect(f[0].replacement).toBe('overdue');
    expect(f[0].severity).toBe('must');
    expect(adaptCase('Past due', 'overdue')).toBe('Overdue');
    expect(adaptCase('PAST DUE', 'overdue')).toBe('OVERDUE');
    expect(typed(card, 'Nothing here is pastdue.', banned).findings).toEqual([]);
    // a phrase inside a placeholder or a link address is never reported
    expect(findPhrase('Hello {{past due}} and [pay](https://x.example/past-due)', 'past due')).toEqual([]);
    expect(mask('Hi {{a.b}} [x](https://y.z)').length).toBe('Hi {{a.b}} [x](https://y.z)'.length);
  });

  it('a preferred spelling: the other form found with its replacement, never inside the preferred form itself', () => {
    const pref = [rule({ id: 'p', kind: 'preferred', severity: 'should', phrase: 'account', replacement: 'your account' })];
    expect(typed(card, 'Check your account and the account summary.', pref).findings[0].occurrences.map((o) => o.start)).toEqual([27]);
    const email = [rule({ id: 'e', kind: 'preferred', severity: 'should', phrase: 'e-mail', replacement: 'email' })];
    const f = typed(card, 'We sent an E-mail. Our email is fine.', email).findings;
    expect(f.map((x) => [x.match, x.replacement])).toEqual([['E-mail', 'email']]);
    expect(f[0].severity).toBe('should');
  });

  it('sentence length: each long sentence with its position; placeholders are not words', () => {
    const sl = [rule({ id: 's', kind: 'sentence-length', limit: 6 })];
    const text = 'Short one. This sentence has far more than six words in it. {{a}} {{b}} {{c}} {{d}} {{e}} {{f}} {{g}} ok.';
    const f = typed(card, text, sl).findings;
    expect(f).toHaveLength(1);
    expect(f[0].occurrences).toEqual([{ start: 11, end: 59, match: 'This sentence has far more than six words in it.' }]);
    expect(sentencesOf(text).map((s) => s.words)).toEqual([2, 10, 1]);
  });

  it('reading level: a grade above the limit is a finding; a text too short to judge says so and is neither passed nor failed', () => {
    const rl = [rule({ id: 'r', kind: 'reading-level', limit: 6 })];
    const hard = 'Notwithstanding the aforementioned contractual stipulations, remuneration obligations remain enforceable irrespective of subsequent administrative reconsiderations.';
    const f = typed(card, hard, rl);
    expect(f.findings[0].kind).toBe('reading-level');
    expect(f.findings[0].grade).toBeGreaterThan(6);
    const short = typed(card, 'Pay by Friday.', rl);
    expect(short.findings).toEqual([]);
    expect(short.notes[0].message).toMatch(/too short to judge/);
    expect(typed(card, 'We will send you a short note when your card is ready to use at any shop.', rl).findings).toEqual([]);
  });

  it('tone: the existing "demand for money" check, only where the document is not a bill, and never in required notices', () => {
    const tone = [rule({ id: 't', kind: 'tone' })];
    expect(typed(eob, 'The amount due is shown below.', tone).findings[0].match).toBe('amount due');
    const statement = typed(card, 'The amount due is shown below.', tone);
    expect(statement.findings).toEqual([]);
    expect(statement.notes[0].message).toMatch(/a statement is a bill/);
    // In the document: the not-a-bill banner (required) is not judged
    const p = own(eob, rule({ id: 't', kind: 'tone' }));
    expect(checkWording(p).findings.filter((x) => x.partId === 'not-a-bill-banner')).toEqual([]);
  });

  it('required phrases: by kind of text or anywhere, as written ignoring case and spacing; a document-level finding saying where', () => {
    const p = own(card, rule({ id: 'q', kind: 'required', phrase: 'Dispute   rights', appliesTo: 'disclosures' }));
    const f = checkWording(p).findings.filter((x) => x.kind === 'required');
    expect(f).toHaveLength(1);
    expect(f[0].textId).toBeNull();
    expect(f[0].message).toMatch(/in a notice or disclosure/);
    // present in a message is not enough for a disclosure rule …
    const inMessage = setPart(p, 'payment-standard', 'Your dispute rights are explained below.');
    expect(checkWording(inMessage).findings.some((x) => x.kind === 'required')).toBe(true);
    // … but satisfies an "anywhere" rule, ignoring case and spacing
    const anywhere = run(inMessage, { type: 'UPDATE_WORDING_RULE', ruleId: 'q', rule: rule({ id: 'q', kind: 'required', phrase: 'DISPUTE rights' }) });
    expect(checkWording(anywhere).findings.some((x) => x.kind === 'required')).toBe(false);
    // the disclosure satisfies the disclosure rule
    const inDisclosure = run(p, { type: 'UPSERT_CONTENT_PART', advanced: true, reason: 'test', part: { ...p.contentParts.find((c) => c.id === 'sample-disclosure-set')!, approvedLocales: { 'en-US': 'Your Dispute Rights: write to us within 60 days.' } } });
    expect(checkWording(inDisclosure).findings.some((x) => x.kind === 'required')).toBe(false);
    // one text being typed is never judged on a required phrase
    expect(typed(card, 'Hello', [rule({ id: 'q', kind: 'required', phrase: 'dispute rights' })]).findings).toEqual([]);
  });

  it('languages: a rule without a language checks the English source; a rule that names a language checks only its approved translations', () => {
    const translated = run(card, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-reminder', locale: 'es-US', text: 'Su pago está atrasado.' }, { type: 'APPROVE_TRANSLATION', partId: 'payment-reminder', locale: 'es-US' });
    const p = own(translated, rule({ id: 'es', kind: 'banned', phrase: 'atrasado', replacement: 'pendiente', language: 'es-US' }), rule({ id: 'en', kind: 'banned', phrase: 'pago' }));
    const f = checkWording(p).findings;
    expect(f.map((x) => [x.ruleId, x.textId, x.locale])).toEqual([['es', 'payment-reminder', 'es-US']]);
    expect(wordingTexts(p, ['es-US']).every((t) => t.locale === 'es-US')).toBe(true);
    // the fix of a translation is a draft for a person to approve
    const fix = wordingFixFor(p, f[0].id, 'text');
    expect(fix && 'commands' in fix ? fix.commands[0] : null).toMatchObject({ type: 'SET_TRANSLATION_DRAFT', locale: 'es-US', text: 'Su pago está pendiente.' });
  });

  it('every text a customer reads is checked: messages, labels, headings, email and SMS (never the studio’s fixed wording)', () => {
    const ids = wordingTexts(card).map((t) => `${t.scope}:${t.id}`);
    for (const x of ['messages:payment-reminder', 'disclosures:sample-disclosure-set', 'labels:@billing-summary/label', 'labels:@title/payment-reminder', 'labels:@transaction-table/caption', 'email:@email/subject', 'sms:@sms/text']) expect(ids).toContain(x);
    expect(ids.some((x) => x.includes('@sys/'))).toBe(false);
    // a document without rules: nothing checked, no findings
    expect(checkWording(card)).toEqual({ rules: [], findings: [], notes: [], textsChecked: 0 });
    expect(wordingFindings(card)).toEqual([]);
  });
});

describe('house rules and the document’s own', () => {
  const H = [rule({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent', replacement: 'past due' }), rule({ id: 'short', kind: 'sentence-length', severity: 'should', limit: 30 })];

  it('the rules in force are the linked house rules followed by the document’s own; house rules are read-only', () => {
    const p = own(house(card, H), rule({ id: 'kindly', kind: 'banned', severity: 'should', phrase: 'kindly' }));
    expect(wordingRulesInForce(p).map((r) => r.key)).toEqual(['house:no-delinquent', 'house:short', 'own:kindly']);
    expect(wordingRulesInForce(p)[0].link).toMatchObject({ itemId: 'house-rules', version: 1 });
    expect(refused(p, { type: 'REMOVE_WORDING_RULE', ruleId: 'no-delinquent' })?.message).toMatch(/house rule: it comes from the library/);
    expect(refused(p, { type: 'UPDATE_WORDING_RULE', ruleId: 'short', rule: { ...H[1], limit: 40 } })?.message).toMatch(/house rule/);
    expect(projectFileProblems(JSON.parse(JSON.stringify(p)))).toEqual([]);
  });

  it('an own rule cannot weaken a house “must” (same phrase and kind, lower severity), but can add to them', () => {
    const p = house(card, H);
    const weak = refused(p, { type: 'ADD_WORDING_RULE', rule: rule({ id: 'soft', kind: 'banned', severity: 'should', phrase: '  Delinquent ' }) });
    expect(weak?.message).toMatch(/cannot weaken them, so it cannot make this a “should”/);
    expect(refused(p, { type: 'ADD_WORDING_RULE', rule: rule({ id: 'no-delinquent', kind: 'banned', phrase: 'arrears' }) })?.message).toMatch(/used by a house rule/);
    // the same phrase as a "must" (no weaker), a stricter limit and a new phrase are all fine
    const q = own(p, rule({ id: 'also', kind: 'banned', phrase: 'delinquent' }), rule({ id: 'stricter', kind: 'sentence-length', limit: 20 }), rule({ id: 'arrears', kind: 'banned', phrase: 'arrears' }));
    expect(q.wordingRules).toHaveLength(3);
  });

  it('each own-rule change is one undoable step: add, change, move, remove (validated)', () => {
    let p = own(card, rule({ id: 'a', kind: 'banned', phrase: 'a1' }), rule({ id: 'b', kind: 'banned', phrase: 'b1' }));
    const v = p.modelVersion;
    p = run(p, { type: 'MOVE_WORDING_RULE', ruleId: 'b', index: 0 });
    expect(p.wordingRules!.map((r) => r.id)).toEqual(['b', 'a']);
    expect(p.modelVersion).toBe(v + 1);
    p = run(p, { type: 'UPDATE_WORDING_RULE', ruleId: 'a', rule: rule({ id: 'a', kind: 'preferred', severity: 'should', phrase: 'a1', replacement: 'a2' }) });
    expect(p.wordingRules![1]).toEqual({ id: 'a', kind: 'preferred', severity: 'should', phrase: 'a1', replacement: 'a2' });
    expect(refused(p, { type: 'ADD_WORDING_RULE', rule: { id: 'x', kind: 'banned', severity: 'must' } as WordingRule })?.message).toMatch(/needs the phrase/);
    expect(refused(p, { type: 'ADD_WORDING_RULE', rule: rule({ id: 'a', kind: 'banned', phrase: 'z' }) })?.message).toMatch(/already has a wording rule/);
    p = run(p, { type: 'REMOVE_WORDING_RULE', ruleId: 'a' }, { type: 'REMOVE_WORDING_RULE', ruleId: 'b' });
    expect(p.wordingRules).toBeUndefined();
  });

  it('linking drops own rules that are now house rules; unlinking makes the house rules the document’s own', () => {
    const p = own(card, H[0], rule({ id: 'short', kind: 'banned', phrase: 'kindly' }));
    const linked = house(p, H);
    expect(linked.wordingRules).toEqual([{ id: 'short-2', kind: 'banned', severity: 'must', phrase: 'kindly' }]);
    const unlinked = run(linked, { type: 'UNLINK_LIBRARY_ITEM', linkId: linked.libraryLinks![0].linkId });
    expect(unlinked.houseWordingRules).toBeUndefined();
    expect(unlinked.wordingRules!.map((r) => r.id)).toEqual(['no-delinquent', 'short', 'short-2']);
  });

  it('the project diff, the change summary and project files cover the own rules', () => {
    const a = own(card, rule({ id: 'a', kind: 'banned', phrase: 'kindly' }));
    const b = run(a, { type: 'UPDATE_WORDING_RULE', ruleId: 'a', rule: rule({ id: 'a', kind: 'banned', severity: 'should', phrase: 'kindly' }) }, { type: 'ADD_WORDING_RULE', rule: rule({ id: 'b', kind: 'tone' }) });
    const d = diffProjects(a, b);
    expect(d.wordingRules).toEqual({ added: [{ id: 'b', kind: 'tone', severity: 'must' }], removed: [], changed: [{ id: 'a', kind: 'banned', severity: 'should', phrase: 'kindly', fields: ['severity'], severityChange: { from: 'must', to: 'should' } }] });
    expect(d.summary.counts.wordingRules).toBe(2);
    expect(diffProjects(card, card).wordingRules).toBeUndefined();
    const s = summarizeChanges(a, b, RECORDS);
    expect(s.sections.find((x) => x.area === 'wording')!.items).toEqual(expect.arrayContaining(['Wording rule added: Tone (must)', 'Wording rule changed: Banned word or phrase “kindly” (should), now a “should” (was a “must”)']));
    const bad = JSON.parse(JSON.stringify(a));
    bad.wordingRules = [{ id: 'x', kind: 'banned', severity: 'often', phrase: 'p' }];
    expect(projectFileProblems(bad).map((x) => x.message).join(' ')).toMatch(/own wording rules are not valid/);
  });
});

describe('into the studio’s findings', () => {
  const withDelinquent = setPart(setPart(card, 'payment-reminder', 'Your account is delinquent. A delinquent account pays fees.'), 'payment-support-offer', 'If your account is delinquent, review assistance options.');

  it('a “must” is one blocker per rule and text, with who reads it, the suggested fix and its effect; a “should” only warns', () => {
    const p = own(withDelinquent, rule({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent', replacement: 'past due' }), rule({ id: 'kindly', kind: 'banned', severity: 'should', phrase: 'review' }));
    const f = wordingFindings(p);
    expect(f.filter((x) => x.severity === 'blocking').map((x) => x.nodeId)).toEqual(['payment-reminder', 'payment-support-offer']);
    expect(f.filter((x) => x.severity === 'warning').length).toBeGreaterThan(0);
    const result = documentBlockers(p, RECORDS);
    const w = result.blockers.filter((b) => b.code === 'WORDING_BANNED');
    expect(w.map((b) => b.id)).toEqual(expect.arrayContaining(['wording-banned~payment-reminder~own:no-delinquent@payment-reminder', 'wording-banned~payment-support-offer~own:no-delinquent@payment-support-offer']));
    expect(w).toHaveLength(2); // the "should" rule is not a blocker
    expect(w.every((b) => b.kind === 'wording')).toBe(true);
    const reminder = w.find((b) => b.about.message?.id === 'payment-reminder')!;
    expect(reminder.title).toBe('“Payment reminder” breaks a wording rule: Banned: “delinquent”');
    expect(reminder.customerCount).toBeGreaterThan(0); // the customers who get that alternative
    const [one, all] = reminder.fixes.filter((x) => x.kind === 'change');
    expect(one.title).toBe('Replace “delinquent” with “past due” in “Payment reminder”');
    expect(one.risk).toBe('review'); // replacing a banned word can change the meaning
    expect(all.title).toBe('Replace “delinquent” with “past due” in 2 texts');
    const impact = fixImpact(p, all, RECORDS, { finding: reminder.finding });
    expect(impact.resolves).toBe(true);
    expect(impact.summary).toMatch(/^Replaces 3 occurrences in 2 texts; changes what \d+ of \d+ synthetic customers read\.$/);
    expect(impact.changedCustomers).toBeGreaterThan(0);
    // fixing it clears the blockers
    const fixed = run(p, { type: 'BATCH', label: all.title, commands: all.commands! });
    expect(documentBlockers(fixed, RECORDS).blockers.some((b) => b.code === 'WORDING_BANNED')).toBe(false);
    expect(fixed.contentParts.find((c) => c.id === 'payment-reminder')!.approvedLocales['en-US']).toBe('Your account is past due. A past due account pays fees.');
  });

  it('“Fix all safe issues” takes only a preferred spelling (mechanical, low risk), never a banned word or a rewrite', () => {
    const p = own(withDelinquent, rule({ id: 'pref', kind: 'preferred', severity: 'should', phrase: 'assistance', replacement: 'help' }), rule({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent', replacement: 'past due' }), rule({ id: 'sl', kind: 'sentence-length', limit: 5 }));
    const plan = safeFixPlan(p, RECORDS);
    const titles = plan.items.map((i) => i.proposal.title);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => /“assistance” with “help”/i.test(t))).toBe(true);
    expect(plan.items.every((i) => i.proposal.risk === 'safe')).toBe(true);
    const after = run(p, plan.batch!);
    expect(after.contentParts.find((c) => c.id === 'payment-reminder')!.approvedLocales['en-US']).toContain('delinquent');
    expect(checkWording(after).findings.some((x) => x.ruleId === 'pref')).toBe(false);
  });

  it('a text linked from the library that breaks a rule points to the library item, never offers an edit', () => {
    const linked = run(withDelinquent, { type: 'LINK_LIBRARY_ITEM', item: { id: 'late-notice', kind: 'wording', title: 'Late notice' }, version: 2, content: { part: { id: 'late', title: 'Payment reminder', type: 'text', approvedLocales: { 'en-US': 'You are delinquent.' } } }, placement: { partId: 'payment-reminder' } });
    const p = own(linked, rule({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent', replacement: 'past due' }));
    const f = checkWording(p).findings.find((x) => x.textId === 'payment-reminder')!;
    expect(f.linked).toMatchObject({ itemId: 'late-notice', version: 2 });
    expect(wordingFixFor(p, f.id, 'text')).toEqual({ reason: 'It comes from the library (“Late notice”, version 2): change it there, or unlink it.' });
    const finding = wordingFindings(p).find((x) => x.nodeId === 'payment-reminder')!;
    expect(finding.message).toMatch(/comes from the library \(“Late notice”, version 2\)/);
    const fixes = proposeFixes(p, finding, { records: RECORDS });
    expect(fixes.map((x) => x.kind)).toEqual(['link']);
    expect(fixes[0].title).toMatch(/in the library/);
    expect(setTextCommands(p, [{ textId: 'payment-reminder', locale: 'en-US', text: 'x' }])).toMatchObject({ reason: expect.stringMatching(/library/) });
  });

  it('labels, headings, email and SMS texts are changed through the right command; a disclosure is left to a person', () => {
    const p = own(card, rule({ id: 'pref', kind: 'preferred', severity: 'should', phrase: 'statement', replacement: 'summary' }));
    for (const id of ['@sms/text', '@email/subject', '@billing-summary/label', '@title/payment-reminder']) {
      const r = setTextCommands(p, [{ textId: id, locale: 'en-US', text: 'New words' }]);
      expect('commands' in r ? r.commands[0].type : r.reason, id).toBe(id.startsWith('@sms') || id.startsWith('@email') ? 'SET_CHANNELS' : id.startsWith('@title') ? 'UPSERT_CONTENT_PART' : 'UPDATE_NODE');
    }
    const after = run(p, { type: 'BATCH', label: 'x', commands: (setTextCommands(p, [{ textId: '@billing-summary/label', locale: 'en-US', text: 'Balance now' }]) as { commands: Command[] }).commands });
    expect(after.nodes.find((n) => n.id === 'billing-summary')!.label).toBe('Balance now');
    expect(setTextCommands(p, [{ textId: 'sample-disclosure-set', locale: 'en-US', text: 'x' }])).toMatchObject({ reason: expect.stringMatching(/approved disclosure text/) });
    const e = wordingEditEffect(p, after, 'own:pref');
    expect(e).toEqual({ occurrences: 0, texts: 0, read: [] });
  });

  it('the release record: the rules in force (house item and version, own rules) and that the approved content had no “must” finding', () => {
    expect(wordingReleaseRecord(card)).toBeNull();
    const p = own(house(card, [rule({ id: 'kindly', kind: 'banned', phrase: 'kindly' })], 3), rule({ id: 'pref', kind: 'preferred', severity: 'should', phrase: 'statement', replacement: 'summary' }));
    const rec = wordingReleaseRecord(p)!;
    expect(rec.house).toMatchObject({ itemId: 'house-rules', title: 'House rules', version: 3, rules: 1 });
    expect(rec.own.map((r) => r.id)).toEqual(['pref']);
    expect(rec.mustFindings).toBe(0);
    expect(rec.shouldFindings).toBeGreaterThan(0);
  });

  it('the two sample documents resolve and are blocked exactly as before when they have no wording rules', () => {
    for (const p of [card, eob]) expect(documentBlockers(p, RECORDS).blockers.some((b) => b.kind === 'wording' && b.code.startsWith('WORDING_'))).toBe(false);
  });
});
