import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type Project } from '@iss/model';
import { RECORDS, seedProjects } from '../../model/src/fixtures';
import { bindingAnalysis, staticRuleAnalysis } from '../../validation/src/index';
import { documentBlockers } from '../src/assist/blockers';
import { fastCauses, newCauseCustomers, newCausesOnSave, saveCheckDays } from '../src/saveCheck';

/**
 * Blockers phase 6: "warn before saving" compares the fast root causes of the version about to be saved with those of the
 * last saved version, by the id the Blockers screen uses. Cases: nothing new; one new cause; one removed and one added;
 * a cause that only gains customers (decided: no warning, it is not a new cause).
 */

const [card, eob] = seedProjects();
const cardRecords = RECORDS.filter((r) => r.documentType === 'credit-statement');
const run = (p: Project, ...cs: Command[]): Project => cs.reduce((x, c) => { const r = applyCommand(x, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const causes = (p: Project) => fastCauses(p, RECORDS, [...staticRuleAnalysis(p, RECORDS), ...bindingAnalysis(p)]);
const r3 = card.rules.find((r) => r.id === 'R03')!;
const tieAt = (missed: number): Command => ({ type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: missed }, priority: 400 } });

describe('the fast causes of a version', () => {
  it('are the Blockers screen’s fast blockers, by the same ids and customers (Aster Card: the four Spanish texts)', () => {
    const c = causes(card);
    expect(c.checked).toBe(70);
    expect(c.days).toEqual([null]);
    const screen = documentBlockers(card, RECORDS).blockers.filter((b) => b.speed === 'fast');
    expect([...c.causes.keys()].sort()).toEqual(screen.map((b) => b.id).sort());
    for (const b of screen) expect(c.causes.get(b.id)!.recordIds).toEqual(b.recordIds);
    expect(causes(eob).causes.size).toBe(0);
  });

  it('a document dated by the run is checked on every day approval checks', () => {
    const dated = { ...card, documentDate: { source: 'run' as const } } as Project;
    expect(saveCheckDays(dated).length).toBeGreaterThanOrEqual(1);
    expect(saveCheckDays(dated).every((d) => typeof d === 'string')).toBe(true);
    expect(saveCheckDays(card)).toEqual([null]);
  });
});

describe('newCausesOnSave', () => {
  it('nothing new: an unchanged version, or a change that adds no cause, warns about nothing', () => {
    expect(newCausesOnSave(causes(card), causes(card))).toEqual([]);
    const retitled = run(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { name: 'Payment help' } } as Command);
    expect(newCausesOnSave(causes(card), causes(retitled))).toEqual([]);
  });

  it('one new cause: two rules that tie name the tie, with the customers it stops', () => {
    const withTie = run(card, tieAt(2));
    const added = newCausesOnSave(causes(card), causes(withTie));
    expect(added.map((c) => c.id)).toEqual([expect.stringMatching(/^priority-tie~/)]);
    expect(added[0].kind).toBe('rules');
    expect(added[0].recordIds.length).toBeGreaterThan(0);
    expect(added[0].title).not.toMatch(/EXCLUSIVE_PRIORITY_TIE|R03|R04/);
    // the same customers the Blockers screen lists for it
    expect(added[0].recordIds).toEqual(documentBlockers(withTie, RECORDS).blockers.find((b) => b.id === added[0].id)!.recordIds);
    expect(newCauseCustomers(withTie, RECORDS, added[0])).toEqual(added[0].recordIds);
  });

  it('a cause removed and one added: only the added one is named', () => {
    const before = causes(card);
    const spanish = [...before.causes.values()].find((c) => c.id.startsWith('required-translation-missing~'))!;
    const partId = spanish.id.split('~')[1];
    // The English text itself, so the data tokens match (a test of the comparison, not of the wording).
    const english = card.contentParts.find((c) => c.id === partId)!.approvedLocales['en-US']!;
    const after = run(card, { type: 'SET_TRANSLATION_DRAFT', partId, locale: 'es-US', text: english }, { type: 'APPROVE_TRANSLATION', partId, locale: 'es-US' }, tieAt(2));
    const a = causes(after);
    expect(a.causes.has(spanish.id)).toBe(false);
    expect(newCausesOnSave(before, a).map((c) => c.id)).toEqual([expect.stringMatching(/^priority-tie~/)]);
    // and the other way round: undoing the fix brings the Spanish cause back as new
    expect(newCausesOnSave(a, before).map((c) => c.id)).toEqual([spanish.id]);
  });

  it('a cause that only gains customers is not new, so it does not warn', () => {
    // R03 at R04's priority on a balance threshold: the higher threshold ties for the customer with the largest balance
    // who asked for help; the lower one for every customer who asked for help.
    const asked = cardRecords.filter((r) => (r as any).card?.assistanceRequested === true).map((r) => Number((r as any).card.newBalanceCents));
    const onBalance = (min: number): Command => ({ type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.newBalanceCents', value: min }, priority: 400 } });
    const narrow = causes(run(card, onBalance(Math.max(...asked))));
    const wide = causes(run(card, onBalance(Math.min(...asked))));
    const id = [...wide.causes.keys()].find((k) => k.startsWith('priority-tie~'))!;
    expect(narrow.causes.has(id)).toBe(true);
    expect(wide.causes.get(id)!.recordIds.length).toBeGreaterThan(narrow.causes.get(id)!.recordIds.length);
    expect(newCausesOnSave(narrow, wide)).toEqual([]);
  });

  it('most customers first', () => {
    const before = causes(card);
    const after = causes(run(card, tieAt(2), { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } } as Command));
    const added = newCausesOnSave(before, after);
    for (let i = 1; i < added.length; i++) expect(added[i - 1].recordIds.length).toBeGreaterThanOrEqual(added[i].recordIds.length);
  });
});

describe('only customers of the document’s kind count', () => {
  it('Aster Card checks its 70 card customers, not the claims', () => {
    expect(fastCauses(card, cardRecords).checked).toBe(fastCauses(card, RECORDS).checked);
  });
});
