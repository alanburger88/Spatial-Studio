import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { applyCommand, type Project, type TestCase } from '@iss/model';
import { captureExpectation, nextTestId, runTestCases, summariseTests } from '@iss/scenarios';

const [card] = seedProjects();
const cmd = (p: Project, c: Parameters<typeof applyCommand>[1]) => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };
const rec = (id: string) => RECORDS.find((r) => r.recordId === id)!;
const pin = (id: string, name = id): TestCase => ({ id: nextTestId([]), name, recordId: id, overrides: {}, journeyCursor: null, expect: captureExpectation(card, rec(id)) });

describe('test cases', () => {
  it('captures selected variants, conditional visibility, locale and no-blocking', () => {
    const e = captureExpectation(card, rec('CARD-0002'));
    expect(e.selectedVariants?.['payment-guidance']).toBe('payment-assistance-requested');
    expect(e.visibleNodeIds?.length! + e.hiddenNodeIds?.length!).toBeGreaterThan(0);
    expect(e.approvedLocale).toBeNull();
    expect(e.noBlocking).toBe(true);
  });

  it('a pinned test passes on the model it was pinned from', () => {
    const r = runTestCases(card, RECORDS, [pin('CARD-0002'), pin('CARD-0001')]);
    expect(summariseTests(r)).toEqual({ total: 2, passed: 2, failed: 0 });
  });

  it('disabling R04 fails the CARD-0002 test with a plain-language reason', () => {
    const t = pin('CARD-0002');
    const after = cmd(card, { type: 'SET_RULE_ENABLED', ruleId: 'R04', enabled: false });
    const [r] = runTestCases(after, RECORDS, [t]);
    expect(r.pass).toBe(false);
    expect(r.diffs[0].kind).toBe('variant');
    expect(r.diffs[0].message).toMatch(/^Payment guidance: expected .+, got .+$/);
    expect(r.diffs[0].message).not.toContain('payment-');
    // undo (re-enable) passes again
    expect(runTestCases(cmd(after, { type: 'SET_RULE_ENABLED', ruleId: 'R04', enabled: true }), RECORDS, [t])[0].pass).toBe(true);
  });

  it('a priority tie fails the no-blocking expectation', () => {
    const r3 = card.rules.find((r) => r.id === 'R03')!;
    const tied = cmd(card, { type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } });
    const t = pin('CARD-0002');
    const [r] = runTestCases(tied, RECORDS, [t]);
    expect(r.pass).toBe(false);
    expect(r.diffs.some((d) => d.kind === 'blocking')).toBe(true);
  });

  it('honours pinned overrides', () => {
    const overrides = { card: { paymentStatus: 'overdue', missedPayments: 0 } };
    const t: TestCase = { id: 'T09', name: 'no match', recordId: 'CARD-0001', overrides, journeyCursor: null, expect: captureExpectation(card, rec('CARD-0001'), overrides) };
    expect(runTestCases(card, RECORDS, [t])[0].pass).toBe(true);
    expect(captureExpectation(card, rec('CARD-0001'), overrides).selectedVariants?.['payment-guidance']).toBe('payment-standard');
  });

  it('reports a missing record and numbers ids', () => {
    const t: TestCase = { ...pin('CARD-0002'), recordId: 'CARD-9999' };
    expect(runTestCases(card, RECORDS, [t])[0].diffs[0].kind).toBe('record');
    expect(nextTestId([{ ...t, id: 'T01' }, { ...t, id: 'T03' }])).toBe('T02');
  });
});
