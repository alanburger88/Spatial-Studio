import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type Predicate, type Project, type Rule, type SyntheticRecord } from '@iss/model';
import { resolve, type Resolution, type RNode } from '@iss/resolver';
import { RECORDS, recordById, seedProjects } from '../../model/src/fixtures';
import { coverageGaps } from '../src/assist/coverage';
import { runTestCase } from '../src/testCases';
import type { CoverageGap } from '../src/assist/types';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const byId = (gaps: CoverageGap[], id: string): CoverageGap => { const g = gaps.find((x) => x.id === id); if (!g) throw new Error(`no gap ${id} in ${gaps.map((x) => x.id).join(', ')}`); return g; };
const replay = (p: Project, g: CoverageGap): Resolution => resolve({ project: p, record: recordById(g.scenario!.recordId)!, overrides: g.scenario!.overrides, journeyCursor: g.scenario!.journeyCursor });
const node = (res: Resolution, id: string): RNode | undefined => { let hit: RNode | undefined; const walk = (n: RNode): void => { if (n.id === id) hit = n; n.children.forEach(walk); }; walk(res.root); return hit; };
const hint = (id: string, when: Predicate): Rule => ({ id, scope: 'credit-statement', mode: 'additive', priority: 30, when, then: { op: 'setPresentationHint', hint: `hint-${id.toLowerCase()}` }, version: 1, enabled: true, title: `Test rule ${id}` });

/** Every gap with a scenario must be confirmed by the real resolver and come with a test that passes and can be pinned. */
function confirmed(p: Project, gaps: CoverageGap[]): void {
  expect(new Set(gaps.map((g) => g.id)).size).toBe(gaps.length);
  const ids = gaps.flatMap((g) => (g.testCase ? [g.testCase.id] : []));
  expect(new Set(ids).size).toBe(ids.length);
  for (const g of gaps) {
    expect(g.title.length).toBeGreaterThan(2);
    if (!g.scenario) { expect(g.reason, g.id).toBeTruthy(); expect(g.testCase).toBeUndefined(); continue; }
    expect(g.scenario.explanation.length).toBeGreaterThan(10);
    const res = replay(p, g);
    if (g.kind === 'rule') expect(res.result.matchedRuleIds, g.id).toContain(g.targetId);
    if (g.kind === 'section') expect(node(res, g.targetId)?.visible, g.id).toBe(true);
    if (g.kind === 'variant') {
      const nodeId = g.id.slice('variant:'.length, g.id.lastIndexOf('/'));
      expect(node(res, nodeId)?.variants?.selected, g.id).toContain(g.targetId);
    }
    if (!g.testCase) { expect(g.reason, g.id).toBeTruthy(); continue; }
    expect(g.testCase).toMatchObject({ recordId: g.scenario.recordId, overrides: g.scenario.overrides, journeyCursor: g.scenario.journeyCursor });
    expect(runTestCase(p, RECORDS, g.testCase), g.id).toMatchObject({ pass: true, diffs: [] });
    expect(applyCommand(p, { type: 'UPSERT_TEST_CASE', testCase: g.testCase }).ok, g.id).toBe(true);
  }
}

describe('coverage of the untouched Aster sample', () => {
  const gaps = coverageGaps(card, RECORDS);

  it('reports R03 and R05 (no customer reaches them as issued), then the two messages they select', () => {
    expect(gaps.map((g) => [g.kind, g.targetId])).toEqual([
      ['rule', 'R03'], ['rule', 'R05'],
      ['variant', 'payment-arrangement-active'], ['variant', 'payment-support-offer'],
    ]);
    expect(gaps.map((g) => g.title)).toEqual(['Two or more missed payments — offer support', 'Payment arrangement approved', 'Arrangement active (Payment guidance)', 'Payment support (Payment guidance)']);
    confirmed(card, gaps);
  });

  it('R03: the smallest what-if on the closest customer, confirmed and ready to pin', () => {
    const g = byId(gaps, 'rule:R03');
    expect(g.scenario).toMatchObject({ recordId: 'CARD-0002', overrides: { card: { assistanceRequested: false } }, journeyCursor: null });
    expect(g.scenario!.explanation).toBe('Start from Taylor Rivers and set Assistance requested to No.');
    expect(g.reason).toBeUndefined();
    const res = replay(card, g);
    expect(res.result.selectedVariants['payment-guidance']).toBe('payment-support-offer'); // the rule wins, not merely matches
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(g.testCase).toMatchObject({ id: 'T01', name: 'Reaches “Two or more missed payments — offer support”' });
    expect(g.testCase!.expect).toMatchObject({ selectedVariants: { 'payment-guidance': 'payment-support-offer' }, noBlocking: true });
  });

  it('R05: reached by a journey step without touching the data', () => {
    const g = byId(gaps, 'rule:R05');
    expect(g.scenario).toMatchObject({ overrides: {}, journeyCursor: 3 });
    expect(g.scenario!.explanation).toContain('“Day 60 · Arrangement approved”');
    expect(replay(card, g).result.selectedVariants['payment-guidance']).toBe('payment-arrangement-active');
    expect(g.testCase).toMatchObject({ id: 'T02', journeyCursor: 3 });
  });

  it('with journey steps counted as coverage, only R03 and its message remain', () => {
    const strict = coverageGaps(card, RECORDS, { journeySteps: true });
    expect(strict.map((g) => g.id)).toEqual(['rule:R03', 'variant:payment-guidance/payment-support-offer']);
    confirmed(card, strict);
  });

  it('is deterministic and leaves its inputs alone', () => {
    expect(coverageGaps(card, RECORDS)).toEqual(gaps);
    const freeze = <T,>(v: T): T => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v as object).forEach(freeze); } return v; };
    const p = freeze(JSON.parse(JSON.stringify(card)) as Project);
    const records = freeze(JSON.parse(JSON.stringify(RECORDS)) as SyntheticRecord[]);
    expect(coverageGaps(p, records)).toEqual(gaps);
  });

  it('test ids continue after the tests the project already has', () => {
    const withTest = run(card, { type: 'UPSERT_TEST_CASE', testCase: { ...gaps[0].testCase!, id: 'T01' } });
    expect(coverageGaps(withTest, RECORDS).map((g) => g.testCase?.id)).toEqual(['T02', 'T03', 'T04', 'T05']);
  });

  it('disabled rules are not coverage targets, and a tighter search bound still answers', () => {
    const off = run(card, { type: 'SET_RULE_ENABLED', ruleId: 'R03', enabled: false });
    const g = coverageGaps(off, RECORDS);
    expect(g.map((x) => x.id)).not.toContain('rule:R03');
    // its message has lost its only rule: a real finding, not a search failure
    expect(byId(g, 'variant:payment-guidance/payment-support-offer')).toMatchObject({ scenario: null, reason: expect.stringContaining('No rule or condition selects this message') });
    const narrow = coverageGaps(card, RECORDS, { maxCandidates: 1 });
    expect(narrow.map((x) => x.id)).toEqual(gaps.map((x) => x.id));
    confirmed(card, narrow);
  });
});

describe('coverage of the HarborCare sample', () => {
  it('builds a second claim to reach the multi-claim rule and section', () => {
    const gaps = coverageGaps(eob, RECORDS);
    expect(gaps.map((g) => g.id)).toEqual(['rule:R19', 'section:multi-claim-index']);
    confirmed(eob, gaps);
    const g = byId(gaps, 'rule:R19');
    expect((g.scenario!.overrides.claims as unknown[]).length).toBe(2);
    expect(g.scenario!.journeyCursor).toBeNull();
    expect(g.testCase!.expect.visibleNodeIds).toContain('multi-claim-index');
    expect(g.testCase!.expect.noBlocking).toBe(true);
  });
});

describe('rules that cannot be reached, or cannot win', () => {
  it('contradictory conditions: no scenario, and the reason says what contradicts', () => {
    const p = run(card, { type: 'UPSERT_RULE', rule: hint('R21', { op: 'and', args: [{ op: 'eq', path: 'card.paymentStatus', value: 'current' }, { op: 'eq', path: 'card.paymentStatus', value: 'overdue' }] }) });
    const g = byId(coverageGaps(p, RECORDS), 'rule:R21');
    expect(g.scenario).toBeNull();
    expect(g.testCase).toBeUndefined();
    expect(g.reason).toBe('The conditions contradict each other: Payment status is “current” and Payment status is “overdue” cannot all be true at once. No customer can ever match.');
    // numeric ranges that exclude each other, and a "not" that leaves nothing
    const q = run(run(card, { type: 'UPSERT_RULE', rule: hint('R22', { op: 'and', args: [{ op: 'gt', path: 'card.missedPayments', value: 5 }, { op: 'lt', path: 'card.missedPayments', value: 6 }] }) }),
      { type: 'UPSERT_RULE', rule: hint('R23', { op: 'and', args: [{ op: 'in', path: 'card.tier', value: ['premium'] }, { op: 'not', arg: { op: 'in', path: 'card.tier', value: ['premium', 'standard'] } }, { op: 'notNull', path: 'card.tier' }] }) });
    const gaps = coverageGaps(q, RECORDS);
    expect(byId(gaps, 'rule:R22')).toMatchObject({ scenario: null, reason: expect.stringContaining('contradict') });
    expect(byId(gaps, 'rule:R23')).toMatchObject({ scenario: null, reason: expect.stringContaining('contradict') });
    confirmed(q, gaps);
  });

  it('a rule that always loses to a higher-priority rule is reported as such, with no test to pin', () => {
    const shadowed: Rule = { id: 'R24', scope: 'credit-statement', mode: 'exclusive', priority: 150, exclusiveGroup: 'payment-guidance', when: { op: 'eq', path: 'card.arrangementStatus', value: 'approved' }, then: { op: 'selectVariant', targetNodeId: 'payment-guidance', variantId: 'payment-standard' }, version: 1, enabled: true, title: 'Arrangement approved — standard wording' };
    const p = run(card, { type: 'UPSERT_RULE', rule: shadowed });
    const gaps = coverageGaps(p, RECORDS);
    const g = byId(gaps, 'rule:R24');
    expect(g.scenario).not.toBeNull();
    expect(g.testCase).toBeUndefined();
    expect(g.reason).toContain('“Payment arrangement approved” has a higher priority and wins');
    expect(g.reason).toContain('Whenever it matches');
    const res = replay(p, g);
    expect(res.result.matchedRuleIds).toContain('R24');
    expect(res.result.selectedVariants['payment-guidance']).toBe('payment-arrangement-active');
    confirmed(p, gaps);
  });

  it('a message no rule selects and that is not the fallback can never appear', () => {
    const p = run(card, { type: 'ADD_VARIANT', nodeId: 'payment-guidance', variantId: 'payment-extra', title: 'Extra note', text: 'An extra note.' });
    expect(byId(coverageGaps(p, RECORDS), 'variant:payment-guidance/payment-extra')).toMatchObject({ kind: 'variant', title: 'Extra note (Payment guidance)', scenario: null, reason: 'No rule or condition selects this message and it is not the fallback, so no customer can receive it.' });
  });

  it('a fallback nobody reaches gets a scenario in which no rule matches', () => {
    const gaps = coverageGaps(card, RECORDS.filter((r) => r.documentType !== 'credit-statement' || (r.card!.paymentStatus as string) !== 'current'));
    const g = byId(gaps, 'variant:payment-guidance/payment-standard');
    expect(g.scenario).not.toBeNull();
    const res = replay(card, g);
    expect(res.result.selectedVariants['payment-guidance']).toBe('payment-standard');
  });
});

describe('preferring clean scenarios', () => {
  it('finds the customer whose what-if stays clean even when similar-looking customers come first', () => {
    // Customers with two missed payments last: a naive closest-first search would spend its bound on "set missed payments
    // to 2" for up-to-date customers, which contradicts their payment status.
    const late = (r: SyntheticRecord): number => (r.documentType === 'credit-statement' && Number(r.card!.missedPayments) >= 2 ? 1 : 0);
    const reordered = [...RECORDS].sort((a, b) => late(a) - late(b));
    const g = byId(coverageGaps(card, reordered), 'rule:R03');
    expect(g.scenario!.overrides).toEqual({ card: { assistanceRequested: false } });
    expect(g.scenario!.explanation).not.toContain('Note:');
    expect(g.testCase!.expect.noBlocking).toBe(true);
  });

  it('says so when every scenario that reaches the rule also raises a blocking issue', () => {
    const p = run(card, { type: 'UPSERT_RULE', rule: hint('R25', { op: 'and', args: [{ op: 'eq', path: 'card.paymentStatus', value: 'current' }, { op: 'gte', path: 'card.missedPayments', value: 3 }] }) });
    const g = byId(coverageGaps(p, RECORDS), 'rule:R25');
    expect(g.scenario).not.toBeNull();
    expect(g.scenario!.explanation).toContain('Note: this what-if also raises a blocking issue that the customer does not have today');
    expect(replay(p, g).findings.map((f) => f.code)).toContain('INCONSISTENT_PAYMENT_STATE');
    expect(g.testCase!.expect.noBlocking).toBeUndefined();
    expect(runTestCase(p, RECORDS, g.testCase!).pass).toBe(true);
  });
});

describe('deriving the smallest what-if from the condition', () => {
  const cases: Array<[string, Predicate]> = [
    ['R31', { op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 5 }, { op: 'lt', path: 'card.missedPayments', value: 7 }, { op: 'ne', path: 'card.missedPayments', value: 5 }, { op: 'eq', path: 'card.paymentStatus', value: 'overdue' }] }],
    ['R32', { op: 'not', arg: { op: 'or', args: [{ op: 'eq', path: 'card.tier', value: 'standard' }, { op: 'lte', path: 'card.creditLimitCents', value: 99999999 }] } }],
    ['R33', { op: 'and', args: [{ op: 'in', path: 'card.channelPreference', value: ['digital', 'print'] }, { op: 'lte', path: 'card.transactions.count', value: 0 }] }],
    ['R34', { op: 'notNull', path: 'customer.middleName' }],
    ['R35', { op: 'or', args: [{ op: 'isNull', path: 'card.rewardsBalance' }, { op: 'gt', path: 'card.rewardsBalance', value: 100000000 }] }],
    ['R36', { op: 'and', args: [{ op: 'gt', path: 'card.availableCreditCents', value: 900000000 }, { op: 'eq', path: 'customer.accessibility.largeText', value: true }] }],
    ['R37', { op: 'and', args: [{ op: 'gt', path: 'card.dueDate', value: '2027-06-30' }, { op: 'lte', path: 'card.dueDate', value: '2027-07-01' }] }],
  ];
  let p = card;
  for (const [id, when] of cases) p = run(p, { type: 'UPSERT_RULE', rule: hint(id, when) });
  const gaps = coverageGaps(p, RECORDS);

  it.each(cases.map(([id]) => id))('%s is reached by a confirmed what-if', (id) => {
    const g = byId(gaps, `rule:${id}`);
    expect(g.scenario, g.reason).not.toBeNull();
    expect(replay(p, g).result.matchedRuleIds).toContain(id);
    expect(runTestCase(p, RECORDS, g.testCase!).pass).toBe(true);
  });

  it('changes as few fields as needed and describes them by name', () => {
    confirmed(p, gaps);
    expect(byId(gaps, 'rule:R31').scenario).toMatchObject({ recordId: 'CARD-0002', overrides: { card: { missedPayments: 6 } }, journeyCursor: null });
    expect(byId(gaps, 'rule:R34').scenario!.explanation).toMatch(/^Start from .+ and set Middle name \(optional\) to “Sample”\.$/);
    expect(byId(gaps, 'rule:R37').scenario!.overrides).toEqual({ card: { dueDate: '2027-07-01' } });
    expect((byId(gaps, 'rule:R33').scenario!.overrides as { card: { transactions: unknown[] } }).card.transactions).toEqual([]);
    // a derived value is reached through the field it is computed from, and the explanation names that field
    const derived = byId(gaps, 'rule:R36').scenario!;
    expect(Object.keys(derived.overrides.card as object)).toEqual(['creditLimitCents']);
    expect(derived.explanation).toMatch(/^Start from .+ and set Credit limit to \$[\d,]+\.\d\d\.$/);
  });

  it('a condition on something a what-if cannot change is reported as never true, not as a failed search', () => {
    const q = run(card, { type: 'UPSERT_RULE', rule: hint('R38', { op: 'eq', path: 'documentType', value: 'eob' }) });
    expect(byId(coverageGaps(q, RECORDS), 'rule:R38')).toMatchObject({ scenario: null, reason: 'The condition can never be true for this document: Document type is “eob”. No customer can ever match.' });
  });
});
