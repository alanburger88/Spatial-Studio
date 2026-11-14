import { describe, expect, it } from 'vitest';
import { applyCommand, channelConfig, digestOf, translationStatus, type Command, type Project } from '@iss/model';
import { resolve } from '@iss/resolver';
import { RECORDS, seedProjects } from '../../model/src/fixtures';
import { SAMPLE_TRANSLATIONS } from '../../../apps/api/src/sampleTranslations';
import { summarizeChanges } from '../src/assist/changeSummary';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const section = (s: ReturnType<typeof summarizeChanges>, area: string) => s.sections.find((x) => x.area === area)?.items ?? [];
const cardRecords = RECORDS.filter((r) => r.documentType === 'credit-statement');
const blocked = (p: Project) => cardRecords.filter((r) => resolve({ project: p, record: r }).findings.some((f) => f.severity === 'blocking')).length;

/** The bundled Spanish sample set, loaded as drafts the way the studio does it. */
function withSpanishDrafts(p: Project): { project: Project; ids: string[] } {
  const sample = SAMPLE_TRANSLATIONS[p.projectId]['es-US'];
  const rows = new Set(translationStatus(p, 'es-US').rows.map((r) => r.partId));
  const ids = Object.keys(sample).filter((id) => rows.has(id));
  return { project: run(p, { type: 'SET_TRANSLATION_DRAFTS', locale: 'es-US', origin: 'sample', items: ids.map((id) => ({ id, text: sample[id] })) }), ids };
}

describe('summarizeChanges', () => {
  it('says "No changes" for two identical versions and for a version that only differs in its counters', () => {
    const s = summarizeChanges(card, structuredClone(card), RECORDS);
    expect(s).toEqual({ headline: 'No changes', sections: [], impact: { changedCustomers: 0, totalCustomers: 70, newlyBlocked: 0, unblocked: 0, examples: [] }, attention: [], source: 'builtin' });
    expect(summarizeChanges(card, { ...card, modelVersion: card.modelVersion + 3, lastSavedAt: '2026-11-13T10:00:00.000Z' }, RECORDS).headline).toBe('No changes');
  });

  it('describes a rule condition edit in one sentence and names the customers it moves', () => {
    const r04 = card.rules.find((r) => r.id === 'R04')!;
    const after = run(card, { type: 'UPSERT_RULE', rule: { ...r04, when: { op: 'and', args: [r04.when, { op: 'eq', path: 'card.tier', value: 'premium' }] } } });
    const s = summarizeChanges(card, after, RECORDS);
    expect(s.headline).toBe('1 rule change');
    expect(section(s, 'rules')).toEqual(['Rule “Customer asked for payment assistance” now also requires that account tier is “premium”']);
    // the six standard-tier customers who asked for assistance fall back to the standard message
    const moved = cardRecords.filter((r) => r.card?.assistanceRequested === true && r.card?.tier === 'standard');
    expect(moved.length).toBe(6);
    expect(s.impact).toMatchObject({ changedCustomers: 6, totalCustomers: 70, newlyBlocked: 0, unblocked: 0 });
    expect(s.impact.examples.length).toBeGreaterThan(0);
    expect(s.impact.examples.length).toBeLessThanOrEqual(5);
    expect(moved.map((r) => r.recordId)).toContain(s.impact.examples[0].recordId);
    expect(s.impact.examples[0].what).toBe('Now gets “Payment instructions” instead of “Assistance requested” in “Payment guidance”');
    expect(s.attention).toEqual(['The rule changes move 6 synthetic customers to a different message: 6 from “Assistance requested” to “Payment instructions” in “Payment guidance”.']);

    // and the other way round: a condition that was dropped
    const back = summarizeChanges(after, card, RECORDS);
    expect(section(back, 'rules')).toEqual(['Rule “Customer asked for payment assistance” no longer requires that account tier is “premium”']);
    expect(back.impact.changedCustomers).toBe(6);
  });

  it('words priority, on/off, new and removed rules', () => {
    let after = run(card, { type: 'UPSERT_RULE', rule: { ...card.rules.find((r) => r.id === 'R02')!, priority: 450 } });
    after = run(after, { type: 'SET_RULE_ENABLED', ruleId: 'R11', enabled: false });
    after = run(after, { type: 'DELETE_RULE', ruleId: 'R06' });
    after = run(after, { type: 'UPSERT_RULE', rule: { id: 'R21', scope: 'credit-statement', mode: 'additive', priority: 30, version: 1, title: 'Standard tier — show rewards', when: { op: 'eq', path: 'card.tier', value: 'standard' }, then: { op: 'showSection', targetNodeId: 'rewards-summary' } } });
    const items = section(summarizeChanges(card, after, RECORDS), 'rules');
    expect(items).toContain('Rule “One missed payment — send a reminder” has priority 450 instead of 200');
    expect(items).toContain('Rule “Has rewards — show rewards summary” is switched off');
    expect(items).toContain('Rule “Premium tier — show relationship team” removed');
    expect(items).toContain('New rule “Standard tier — show rewards”: when account tier is “standard”, show the section “Rewards summary”');
  });

  it('reports drafted and approved Spanish translations per language and the customers they unblock', () => {
    const { project: drafts, ids } = withSpanishDrafts(card);
    const drafted = summarizeChanges(card, drafts, RECORDS);
    expect(drafted.headline).toBe(`${ids.length} translation drafts`);
    expect(section(drafted, 'translations')[0]).toMatch(new RegExp(`^${ids.length} Spanish \\(United States\\) drafts added or edited, not approved yet: “.+”, “.+”, “.+” and ${ids.length - 3} more$`));
    expect(drafted.attention[0]).toMatch(/Spanish \(United States\) drafts in this change are not approved yet/);
    expect(drafted.impact.changedCustomers).toBe(0); // drafts never reach a customer

    const approved = run(drafts, { type: 'APPROVE_TRANSLATIONS', locale: 'es-US', ids });
    const s = summarizeChanges(drafts, approved, RECORDS);
    expect(s.headline).toBe(`${ids.length} translations approved`);
    expect(section(s, 'translations')).toHaveLength(1);
    expect(section(s, 'translations')[0]).toMatch(/^\d+ Spanish \(United States\) translations approved: /);
    const spanish = blocked(drafts) - blocked(approved);
    expect(spanish).toBeGreaterThan(0);
    expect(s.impact).toMatchObject({ unblocked: spanish, newlyBlocked: 0, changedCustomers: spanish });
    expect(s.impact.examples[0].what).toMatch(/^No longer blocked \(before: a required translation of “.+” is missing\)$/);
    expect(s.attention).toHaveLength(1);
    expect(s.attention[0]).toMatch(new RegExp(`^${spanish} synthetic customers who could not get a document before can now, for example `));
  });

  it('flags a translation that went out of date and one that was removed', () => {
    const { project: drafts } = withSpanishDrafts(card);
    const approved = run(drafts, { type: 'APPROVE_TRANSLATIONS', locale: 'es-US', ids: ['@billing-summary/label', 'payment-standard'] });
    const relabelled = run(approved, { type: 'UPDATE_NODE', nodeId: 'billing-summary', patch: { label: 'Balance now' } });
    const s = summarizeChanges(approved, relabelled, RECORDS);
    expect(section(s, 'wording')).toEqual(['The label “New balance” is now “Balance now”']);
    expect(section(s, 'translations')).toEqual(['The English of 1 text changed after its Spanish (United States) translation was approved: “New balance · label”']);
    expect(s.attention.join(' ')).toMatch(/translation may be out of date/);

    const reworded = run(approved, { type: 'UPSERT_CONTENT_PART', part: { ...approved.contentParts.find((c) => c.id === 'payment-standard')!, approvedLocales: { 'en-US': 'Please pay by {{card.dueDate}}.', 'es-US': 'Su pago vence el {{card.dueDate}}.' } } });
    expect(summarizeChanges(approved, reworded, RECORDS).attention.join(' ')).toMatch(/the English of “Payment instructions” changed but its approved Spanish \(United States\) translation did not/i);
  });

  it('puts a removed fallback in the attention list and counts the customers it blocks', () => {
    const noFallback = run(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
    const quiet = summarizeChanges(card, noFallback, RECORDS);
    expect(section(quiet, 'rules')).toEqual(['“Payment guidance” no longer has a fallback message']);
    expect(quiet.impact).toMatchObject({ changedCustomers: 0, newlyBlocked: 0 });
    expect(quiet.attention).toEqual(['“Payment guidance” no longer has a fallback (it was “Payment instructions”), so a customer no rule matches gets no message there and cannot get a document: no synthetic customer is in that position today.']);

    // with the rule for up-to-date customers switched off as well, those customers have nothing left
    const after = run(noFallback, { type: 'SET_RULE_ENABLED', ruleId: 'R01', enabled: false });
    const s = summarizeChanges(card, after, RECORDS);
    const newly = blocked(after) - blocked(card);
    expect(newly).toBeGreaterThan(0);
    expect(s.impact.newlyBlocked).toBe(newly);
    expect(s.impact.unblocked).toBe(0);
    expect(s.attention[0]).toMatch(new RegExp(`^${newly} synthetic customers can no longer get a document: no rule matches for “Payment guidance” and it has no fallback, for example `));
    expect(s.attention.some((a) => /no longer has a fallback .*: this now happens to \d+ synthetic customers\.$/.test(a))).toBe(true);
    expect(s.impact.examples[0].what).toBe('Can no longer get a document: no rule matches for “Payment guidance” and it has no fallback');
  });

  it('describes email and text message changes and notices a dropped "THIS IS NOT A BILL"', () => {
    const ch = channelConfig(eob);
    const after = run(eob, { type: 'SET_CHANNELS', channels: {
      sms: { text: 'DEMO {{issuer.name}}: Your Explanation of Benefits is ready. Details: {{link}}' },
      email: { ...ch.email, subject: 'Your {{issuer.name}} benefits summary is ready', sections: ch.email.sections.map((x) => (x.id === 'tables' ? { ...x, show: false } : x)) },
    } });
    const s = summarizeChanges(eob, after, RECORDS);
    expect(s.headline).toBe('3 email or text message changes');
    expect(s.sections.map((x) => x.area)).toEqual(['channels']);
    expect(section(s, 'channels')).toEqual([
      'The email subject line now reads “Your {{issuer.name}} benefits summary is ready”',
      'The text message now reads “DEMO {{issuer.name}}: Your Explanation of Benefits is ready. Details: {{link}}”',
      'The email section “Short tables” is now hidden',
    ]);
    expect(s.impact).toMatchObject({ changedCustomers: 0, totalCustomers: 30 });
    expect(s.attention[0]).toBe('Required content changed: the email subject line no longer says “THIS IS NOT A BILL” and the text message no longer says “THIS IS NOT A BILL”.');
    expect(s.attention[1]).toBe('Check the figures: the text message no longer shows Claim ID.');
  });

  it('orders the attention list: required disclosures before amounts, and collapses long lists', () => {
    let after = run(card, { type: 'UPSERT_CONTENT_PART', part: { ...card.contentParts.find((c) => c.id === 'sample-disclosure-set')!, approvedLocales: { 'en-US': 'New disclosure wording for the demo.' } }, advanced: true, reason: 'test' });
    after = run(after, { type: 'UPDATE_NODE', nodeId: 'billing-summary', patch: { binding: 'card.previousBalanceCents' } });
    after = run(after, { type: 'UPSERT_CONTENT_PART', part: { ...card.contentParts.find((c) => c.id === 'payment-standard')!, approvedLocales: { 'en-US': 'Please pay by the due date.' } } });
    after = run(after, { type: 'SET_LAYOUT', nodeId: 'greeting', profile: 'paged', layout: { spaceBeforePt: 20 } });
    const labelled = ['billing-summary', 'payment-due', 'payment-due-date', 'available-credit', 'previous-balance', 'purchases-total', 'payments-credits', 'fees-interest'];
    for (const id of labelled) after = run(after, { type: 'UPDATE_NODE', nodeId: id, patch: { label: `${card.nodes.find((n) => n.id === id)!.label} (new)` } });
    const s = summarizeChanges(card, after, RECORDS);
    expect(s.headline).toBe('10 wording changes, 2 layout changes');
    expect(s.sections.map((x) => x.area)).toEqual(['wording', 'layout']);
    const wording = section(s, 'wording');
    expect(wording[0]).toBe('The wording of “Payment instructions” now reads “Please pay by the due date.”');
    expect(wording).toContain('The wording of “Demonstration disclosures” now reads “New disclosure wording for the demo.”');
    expect(wording[wording.length - 1]).toBe('…and 3 more labels');
    expect(section(s, 'layout')).toEqual(['“New balance” now shows Previous balance instead of New balance', '“Greeting” was moved or resized']);
    expect(s.attention).toEqual([
      'Required content changed: the required wording “Demonstration disclosures” was changed.',
      'Check the figures: “Payment instructions” no longer shows Payment due date and “New balance” now shows Previous balance instead of New balance.',
    ]);
  });

  it('covers settings and tests, is deterministic, leaves its inputs alone and is fast', () => {
    let after = run(card, { type: 'ADD_LANGUAGE', locale: 'fr-FR' });
    after = run(after, { type: 'SET_GLOSSARY', locale: 'es-US', entries: [{ source: 'statement', target: 'estado de cuenta' }] });
    after = run(after, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'branch', label: 'Branch', type: 'string' }] });
    after = run(after, { type: 'UPSERT_TEST_CASE', testCase: { id: 'T-1', name: 'Up to date customer', recordId: 'CARD-0001', expect: { selectedVariants: { 'payment-guidance': 'payment-standard' } } } });
    const beforeDigest = digestOf(card), afterDigest = digestOf(after);
    const s = summarizeChanges(card, after, RECORDS);
    expect(s.headline).toBe('3 settings changes, 1 test change');
    expect(section(s, 'settings')).toEqual(['Language added: French (France)', 'Spanish (United States) glossary: 1 term added', 'Data field “Branch” added']);
    expect(section(s, 'tests')).toEqual(['Test “Up to date customer” added']);
    expect(summarizeChanges(card, after, RECORDS)).toEqual(s);
    expect(digestOf(card)).toBe(beforeDigest);
    expect(digestOf(after)).toBe(afterDigest);

    // a pinned test that the new version breaks is the first thing to look at after blocking problems
    const broken = run(after, { type: 'SET_RULE_ENABLED', ruleId: 'R01', enabled: false });
    const withFallbackOnly = summarizeChanges(after, run(broken, { type: 'UPSERT_TEST_CASE', testCase: { id: 'T-1', name: 'Up to date customer', recordId: 'CARD-0001', expect: { selectedVariants: { 'payment-guidance': 'payment-reminder' } } } }), RECORDS);
    expect(withFallbackOnly.attention[0]).toBe('1 pinned test fails with this version: “Up to date customer”.');

    const { project: drafts, ids } = withSpanishDrafts(card);
    const approved = run(drafts, { type: 'APPROVE_TRANSLATIONS', locale: 'es-US', ids });
    const t = performance.now();
    summarizeChanges(drafts, approved, RECORDS);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});
