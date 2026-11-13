import { describe, expect, it } from 'vitest';
import {
  applyCommand, buildContext, customFieldDefs, getPath, prepareImport, validateRecordShape,
  type Command, type Predicate, type Project, type Rule, type SyntheticRecord,
} from '@iss/model';
import { RECORDS, seedProjects } from '@iss/model/fixtures';
import { resolve, type Resolution, type RNode } from '@iss/resolver';
import { coverageGaps } from '../src/assist/coverage';
import { planTestData } from '../src/assist/testData';
import type { GeneratedCustomer, TestDataPlan, TestDataTarget } from '../src/assist/types';

const [card, eob] = seedProjects();
const BOTH = { outcomes: true, edges: true };
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const hint = (id: string, title: string, when: Predicate, scope: Rule['scope'] = 'credit-statement'): Rule => ({ id, scope, mode: 'additive', priority: 30, when, then: { op: 'setPresentationHint', hint: `hint-${id.toLowerCase()}` }, version: 1, enabled: true, title });
const withRules = (p: Project, ...rules: Rule[]): Project => ({ ...p, rules: [...p.rules, ...rules] });

/** The customer exactly as it would be stored and issued: no what-if on top, no journey step. */
const asIssued = (c: GeneratedCustomer): SyntheticRecord => ({ ...c.record, recordId: 'GEN-0001' });
const issue = (p: Project, c: GeneratedCustomer): Resolution => resolve({ project: p, record: asIssued(c) });
const node = (res: Resolution, id: string): RNode | undefined => { let hit: RNode | undefined; const walk = (n: RNode): void => { if (n.id === id) hit = n; n.children.forEach(walk); }; walk(res.root); return hit; };
const valueAt = (c: GeneratedCustomer, path: string): unknown => getPath(buildContext(asIssued(c)), path);
const target = (plan: TestDataPlan, id: string): TestDataTarget => { const t = plan.targets.find((x) => x.id === id); if (!t) throw new Error(`no target ${id} in ${plan.targets.map((x) => x.id).join(', ')}`); return t; };
const customerOf = (plan: TestDataPlan, id: string): GeneratedCustomer => { const t = target(plan, id); if (t.customer === null) throw new Error(`${id} has no customer: ${t.reason}`); return plan.customers[t.customer]; };
const blockingCodes = (res: Resolution): string[] => [...new Set(res.findings.filter((f) => f.severity === 'blocking').map((f) => f.code))];
const day = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** What an edge target's id promises about the record: `edge:<path>:<below|on|above|is>:<value>`. */
function promised(t: TestDataTarget): { path: string; matches: (v: unknown) => boolean } {
  if (t.kind === 'empty') return { path: t.targetId, matches: (v) => v === null || (Array.isArray(v) && v.length === 0) };
  const [, path, position, ...rest] = t.id.split(':');
  const raw = rest.join(':');
  if (position === 'is') return { path, matches: (v) => String(v) === raw };
  const step = position === 'below' ? -1 : position === 'above' ? 1 : 0;
  return { path, matches: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? v === day(raw, step) : v === Number(raw) + step) };
}

/** Every structural promise of a plan, checked with the real resolver and the customer import's own validation. */
function verify(p: Project, plan: TestDataPlan): void {
  const extra = customFieldDefs(p.customFields);
  expect(new Set(plan.targets.map((t) => t.id)).size).toBe(plan.targets.length);
  const names = plan.customers.map((c) => `${c.record.customer.givenName} ${c.record.customer.familyName}`);
  expect(new Set(names).size).toBe(names.length);
  plan.customers.forEach((c, i) => {
    expect(c.targets.length, c.label).toBeGreaterThan(0);
    expect(c.label.length).toBeGreaterThan(5);
    expect(c.record).not.toHaveProperty('recordId');
    expect(c.record.documentType).toBe(p.documentType);
    expect(validateRecordShape(JSON.parse(JSON.stringify(c.record)), p.documentType, extra), c.label).toEqual([]);
    // each target a customer claims points back at it, and only those
    expect(plan.targets.filter((t) => t.customer === i).map((t) => t.id).sort(), c.label).toEqual([...c.targets].sort());
  });
  const resolutions = plan.customers.map((c) => issue(p, c));
  for (const t of plan.targets) {
    expect(t.title.length, t.id).toBeGreaterThan(5);
    if (t.customer === null) { expect(t.reason, t.id).toBeTruthy(); expect(t.observed).toBeUndefined(); continue; }
    expect(t.reason, t.id).toBeUndefined();
    const c = plan.customers[t.customer];
    const res = resolutions[t.customer];
    if (t.kind === 'rule') expect(res.result.matchedRuleIds, t.id).toContain(t.targetId);
    if (t.kind === 'variant') expect(node(res, t.id.slice('variant:'.length, t.id.lastIndexOf('/')))?.variants?.selected, t.id).toContain(t.targetId);
    if (t.kind === 'section-shown') expect(node(res, t.targetId)?.visible, t.id).toBe(true);
    if (t.kind === 'section-hidden') expect(!!node(res, t.targetId)?.visible, t.id).toBe(false);
    if (t.kind === 'language') { expect(res.locale, t.id).toBe(t.targetId); }
    if (t.kind === 'edge' || t.kind === 'empty') {
      const want = promised(t);
      expect(want.matches(valueAt(c, want.path)), `${t.id}: ${JSON.stringify(valueAt(c, want.path))}`).toBe(true);
      expect(t.observed, t.id).toBeTruthy();
    }
  }
  const outcomes = plan.targets.filter((t) => t.kind !== 'edge' && t.kind !== 'empty');
  const edges = plan.targets.filter((t) => t.kind === 'edge' || t.kind === 'empty');
  expect(plan.summary.outcomes).toEqual({ total: outcomes.length, reached: outcomes.filter((t) => t.customer !== null).length });
  expect(plan.summary.edges).toEqual({ total: edges.length, reached: edges.filter((t) => t.customer !== null).length });
}

const cardPlan = planTestData(card, RECORDS, BOTH);
const eobPlan = planTestData(eob, RECORDS, BOTH);

describe('test customers for the two sample documents', () => {
  it('every customer resolves as issued and reaches each target it claims (card)', () => { verify(card, cardPlan); });
  it('every customer resolves as issued and reaches each target it claims (EOB)', () => { verify(eob, eobPlan); });

  it('every outcome of the card sample has a customer, with far fewer than 60 customers', () => {
    const plan = planTestData(card, RECORDS, { outcomes: true, edges: false });
    verify(card, plan);
    expect(plan.summary).toEqual({ outcomes: { total: 25, reached: 25 }, edges: { total: 0, reached: 0 }, unreachable: 0, capped: false });
    expect(plan.customers.length).toBeLessThanOrEqual(12);
    expect(plan.targets.map((t) => t.kind).filter((k, i, a) => a.indexOf(k) === i)).toEqual(['rule', 'variant', 'section-shown', 'section-hidden', 'language']);
    // one message version each, the fallback included
    expect(plan.targets.filter((t) => t.kind === 'variant').map((t) => t.targetId).sort()).toEqual(['payment-arrangement-active', 'payment-assistance-requested', 'payment-reminder', 'payment-standard', 'payment-support-offer']);
  });

  it('every outcome of the EOB sample has a customer, with far fewer than 60 customers', () => {
    const plan = planTestData(eob, RECORDS, { outcomes: true, edges: false });
    verify(eob, plan);
    expect(plan.summary).toEqual({ outcomes: { total: 22, reached: 22 }, edges: { total: 0, reached: 0 }, unreachable: 0, capped: false });
    expect(plan.customers.length).toBeLessThanOrEqual(10);
  });

  it('whatever the coverage check says is reachable as issued has a customer', () => {
    for (const p of [card, eob]) {
      const plan = p === card ? cardPlan : eobPlan;
      const all = coverageGaps(p, []).map((g) => g.id); // with no customers, every rule, message and section is a gap
      const notAsIssued = new Set(coverageGaps(p, RECORDS).filter((g) => !g.scenario || g.scenario.journeyCursor !== null).map((g) => g.id));
      expect(all.length).toBeGreaterThan(10);
      for (const id of all.filter((x) => !notAsIssued.has(x))) {
        const t = target(plan, id.startsWith('section:') ? `section-shown:${id.slice('section:'.length)}` : id);
        expect(t.customer, id).not.toBeNull();
      }
      // and the ones coverage only reaches through a journey step are reached here by a real record
      for (const id of notAsIssued) expect(target(plan, id).customer, id).not.toBeNull();
    }
  });

  it('each optional section is shown for one customer and hidden for another', () => {
    for (const [p, plan, ids] of [[card, cardPlan, ['relationship-manager', 'rewards-summary', 'high-volume-note']], [eob, eobPlan, ['network-explanation', 'deductible-explanation', 'member-responsibility-summary', 'multi-claim-index']]] as const) {
      for (const id of ids) {
        const shown = customerOf(plan, `section-shown:${id}`);
        const hidden = customerOf(plan, `section-hidden:${id}`);
        expect(shown).not.toBe(hidden);
        expect(node(issue(p, shown), id)?.visible).toBe(true);
        expect(!!node(issue(p, hidden), id)?.visible).toBe(false);
      }
    }
  });

  it('every record passes the customer import, which gives it an id', () => {
    for (const [p, plan] of [[card, cardPlan], [eob, eobPlan]] as const) {
      const rows = prepareImport(plan.customers.map((c) => JSON.parse(JSON.stringify(c.record))), p.documentType, 0, customFieldDefs(p.customFields));
      expect(rows.flatMap((r) => r.errors)).toEqual([]);
      expect(rows.every((r) => !!r.record?.recordId)).toBe(true);
      expect(rows.length).toBe(plan.customers.length);
    }
  });

  it('customers have ordinary, distinct names and only a language the project has', () => {
    for (const plan of [cardPlan, eobPlan]) {
      for (const c of plan.customers) {
        expect(c.record.customer.givenName).toMatch(/^[A-Z][a-z]+$/);
        expect(c.record.customer.familyName).toMatch(/^[A-Z][a-z]+$/);
        expect(['en-US', 'es-US']).toContain(c.record.customer.locale);
        expect(c.record).not.toHaveProperty('personaId');
      }
    }
    expect(cardPlan.customers.slice(0, 2).map((c) => `${c.record.customer.givenName} ${c.record.customer.familyName}`)).toEqual(['Avery Abbott', 'Bianca Bennett']);
  });

  it('titles, labels, reasons and observations use names, never ids or field paths', () => {
    for (const [p, plan] of [[card, cardPlan], [eob, eobPlan]] as const) {
      const ids = [...p.rules.map((r) => r.id), ...p.nodes.map((n) => n.id), ...p.contentParts.map((c) => c.id)];
      const texts = [...plan.customers.map((c) => c.label), ...plan.targets.flatMap((t) => [t.title, t.reason ?? '', t.observed ?? ''])];
      for (const text of texts) {
        for (const id of ids) expect(new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(text), `${id} in “${text}”`).toBe(false);
        expect(text).not.toMatch(/\b(card|claim|claims|customer|custom|member)\.[a-z]/);
      }
    }
    expect(target(cardPlan, 'rule:R03').title).toBe('Rule “Two or more missed payments — offer support” applies');
    expect(target(cardPlan, 'variant:payment-guidance/payment-support-offer').title).toBe('Message “Payment support” is chosen in “Payment guidance”');
    expect(customerOf(cardPlan, 'variant:payment-guidance/payment-support-offer').label).toBe('Reaches “Payment support”');
    expect(target(cardPlan, 'section-hidden:rewards-summary').title).toBe('Section “Rewards summary” is hidden');
    expect(target(cardPlan, 'language:es-US').title).toBe('Document in Spanish (United States)');
  });

  it('is deterministic and leaves its inputs alone', () => {
    expect(planTestData(card, RECORDS, BOTH)).toEqual(cardPlan);
    expect(planTestData(eob, RECORDS, BOTH)).toEqual(eobPlan);
    const freeze = <T,>(v: T): T => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v as object).forEach(freeze); } return v; };
    const p = freeze(JSON.parse(JSON.stringify(card)) as Project);
    const records = freeze(JSON.parse(JSON.stringify(RECORDS)) as SyntheticRecord[]);
    expect(planTestData(p, records, BOTH)).toEqual(cardPlan);
    expect(JSON.stringify(planTestData(card, RECORDS, BOTH))).toBe(JSON.stringify(cardPlan));
  });

  it('takes well under 3 seconds for each sample document', () => {
    for (const p of [card, eob]) {
      const started = performance.now();
      const plan = planTestData(p, RECORDS, BOTH);
      const ms = performance.now() - started;
      console.info(`planTestData ${p.projectId}: ${ms.toFixed(0)} ms, ${plan.customers.length} customers for ${plan.targets.length} targets`);
      expect(ms).toBeLessThan(3000);
    }
  });

  it('only the Spanish customer has a blocking issue, because the samples have no approved Spanish wording', () => {
    for (const [p, plan] of [[card, cardPlan], [eob, eobPlan]] as const) {
      const blocked = plan.customers.filter((c) => blockingCodes(issue(p, c)).length);
      expect(blocked.map((c) => [c.record.customer.locale, blockingCodes(issue(p, c))])).toEqual([['es-US', ['REQUIRED_TRANSLATION_MISSING']]]);
    }
  });
});

describe('edge values', () => {
  it('“two or more missed payments” flips exactly at 2', () => {
    const picked = (id: string): string | null => issue(card, customerOf(cardPlan, id)).result.selectedVariants['payment-guidance'];
    const below = customerOf(cardPlan, 'edge:card.missedPayments:below:2');
    const on = customerOf(cardPlan, 'edge:card.missedPayments:on:2');
    const above = customerOf(cardPlan, 'edge:card.missedPayments:above:2');
    expect([below, on, above].map((c) => c.record.card!.missedPayments)).toEqual([1, 2, 3]);
    expect(issue(card, below).result.matchedRuleIds).not.toContain('R03');
    expect(issue(card, on).result.matchedRuleIds).toContain('R03');
    expect(issue(card, above).result.matchedRuleIds).toContain('R03');
    expect(['below', 'on', 'above'].map((x) => picked(`edge:card.missedPayments:${x}:2`))).toEqual(['payment-reminder', 'payment-support-offer', 'payment-support-offer']);
    // the other condition of the rule holds in all three, so the count alone decides
    expect([below, on, above].map((c) => c.record.card!.assistanceRequested)).toEqual([false, false, false]);
    expect(['below', 'on', 'above'].map((x) => target(cardPlan, `edge:card.missedPayments:${x}:2`).observed)).toEqual(['Gets “Payment reminder”', 'Gets “Payment support”', 'Gets “Payment support”']);
    expect(['below', 'on', 'above'].map((x) => target(cardPlan, `edge:card.missedPayments:${x}:2`).title)).toEqual(['Missed payments just below 2', 'Missed payments exactly 2', 'Missed payments just above 2']);
  });

  it('“more than 25 transactions” flips between 25 and 26 rows, for the rule and the section that share the threshold', () => {
    const rows = ['below', 'on', 'above'].map((x) => customerOf(cardPlan, `edge:card.transactions.count:${x}:25`));
    expect(rows.map((c) => c.record.card!.transactions.length)).toEqual([24, 25, 26]);
    expect(rows.map((c) => issue(card, c).result.matchedRuleIds.includes('R10'))).toEqual([false, false, true]);
    expect(rows.map((c) => !!node(issue(card, c), 'high-volume-note')?.visible)).toEqual([false, false, true]);
    expect(target(cardPlan, 'edge:card.transactions.count:above:25').observed).toBe('Rule “Long transaction list — repeat headings across pages” applies; Gets “Transaction guide”');
    expect(cardPlan.targets.filter((t) => t.id.startsWith('edge:card.transactions.count:')).length).toBe(3); // one target per value, not per reader
  });

  it('an amount threshold on the EOB: one cent below, on and above', () => {
    const three = ['below', 'on', 'above'].map((x) => customerOf(eobPlan, `edge:claim.deductibleAppliedCents:${x}:0`));
    expect(three.map((c) => c.record.claims![0].deductibleAppliedCents)).toEqual([-1, 0, 1]);
    expect(three.map((c) => !!node(issue(eob, c), 'deductible-explanation')?.visible)).toEqual([false, false, true]);
    expect(target(eobPlan, 'edge:claim.deductibleAppliedCents:above:0')).toMatchObject({ kind: 'edge', targetId: 'claim.deductibleAppliedCents', title: 'Deductible applied just above $0.00', observed: 'Shows “Deductible explanation”' });
  });

  it('a balance threshold keeps the statement reconciled, so the edge customers have no blocking issue', () => {
    const p = withRules(card, hint('R21', 'Large balance', { op: 'gte', path: 'card.newBalanceCents', value: 50000 }));
    const plan = planTestData(p, RECORDS, BOTH);
    verify(p, plan);
    const three = ['below', 'on', 'above'].map((x) => customerOf(plan, `edge:card.newBalanceCents:${x}:50000`));
    expect(three.map((c) => c.record.card!.newBalanceCents)).toEqual([49999, 50000, 50001]);
    expect(three.map((c) => issue(p, c).result.matchedRuleIds.includes('R21'))).toEqual([false, true, true]);
    expect(three.map((c) => blockingCodes(issue(p, c)))).toEqual([[], [], []]);
    expect(target(plan, 'edge:card.newBalanceCents:on:50000').title).toBe('New balance exactly $500.00');
    expect(three[2].label).toBe('New balance just above $500.00');
    expect(target(plan, 'edge:card.newBalanceCents:below:50000').observed).toBe('Rule “Large balance” does not apply');
  });

  it('one customer for each enum value and for yes and no', () => {
    expect(customerOf(cardPlan, 'edge:card.arrangementStatus:is:approved').record.card!.arrangementStatus).toBe('approved');
    expect(customerOf(cardPlan, 'edge:card.channelPreference:is:digital').record.card!.channelPreference).toBe('digital');
    expect(customerOf(cardPlan, 'edge:card.channelPreference:is:print').record.card!.channelPreference).toBe('print');
    const yes = customerOf(cardPlan, 'edge:card.assistanceRequested:is:true');
    const no = customerOf(cardPlan, 'edge:card.assistanceRequested:is:false');
    expect([yes.record.card!.assistanceRequested, no.record.card!.assistanceRequested]).toEqual([true, false]);
    expect([target(cardPlan, 'edge:card.assistanceRequested:is:true').observed, target(cardPlan, 'edge:card.assistanceRequested:is:false').observed]).toEqual(['Gets “Assistance requested”', 'Gets “Payment support”']);
    expect(target(cardPlan, 'edge:card.assistanceRequested:is:false').title).toBe('Assistance requested is No');
    expect(eobPlan.targets.filter((t) => t.id.startsWith('edge:claim.status:is:')).map((t) => t.id.split(':')[3])).toEqual(['processed-covered', 'denied-pending-review', 'appeal-filed']);
    expect(target(cardPlan, 'edge:customer.locale:is:es-US').title).toBe('Preferred locale is Spanish (United States)');
  });

  it('one customer with each optional field a condition reads left empty', () => {
    const empties = cardPlan.targets.filter((t) => t.kind === 'empty');
    expect(empties.map((t) => t.targetId)).toEqual(['card.paymentStatus', 'card.missedPayments', 'card.assistanceRequested', 'card.arrangementStatus', 'card.tier', 'card.channelPreference', 'card.transactions', 'card.rewardsBalance']);
    expect(empties.map((t) => t.targetId)).not.toContain('customer.locale'); // required: never empty
    const rewards = customerOf(cardPlan, 'empty:card.rewardsBalance');
    expect(rewards.record.card!.rewardsBalance).toBeNull();
    expect(issue(card, rewards).result.matchedRuleIds).not.toContain('R11');
    expect(target(cardPlan, 'empty:card.rewardsBalance')).toMatchObject({ title: 'Rewards balance is empty', observed: 'Hides “Rewards summary”' });
    expect(customerOf(cardPlan, 'empty:card.transactions').record.card!.transactions).toEqual([]);
    expect(target(cardPlan, 'empty:card.transactions').title).toBe('Transactions is an empty list');
    expect(target(eobPlan, 'empty:claim.status').observed).toBe('Gets “Processing your claim”');
  });

  it('values no valid record can have are reported with a reason instead of a customer', () => {
    expect(target(cardPlan, 'edge:card.rewardsBalance:below:0')).toMatchObject({ customer: null, reason: 'Rewards balance cannot be less than 0, so there is no value just below 0.' });
    expect(target(eobPlan, 'edge:claims.count:below:1')).toMatchObject({ customer: null, reason: expect.stringContaining('at least one claim') });
    expect(target(eobPlan, 'empty:claims')).toMatchObject({ customer: null, reason: expect.stringContaining('The customer data contract does not accept it') });
    expect(cardPlan.summary.unreachable).toBe(1);
    expect(eobPlan.summary.unreachable).toBe(2);
  });

  it('an edge customer that an outcome customer already is, is not created twice', () => {
    const outcomeOnly = planTestData(card, RECORDS, { outcomes: true, edges: false });
    expect(cardPlan.customers.slice(0, outcomeOnly.customers.length).map((c) => c.record)).toEqual(outcomeOnly.customers.map((c) => c.record));
    const shared = cardPlan.targets.filter((t) => (t.kind === 'edge' || t.kind === 'empty') && t.customer !== null && t.customer < outcomeOnly.customers.length);
    expect(shared.length).toBeGreaterThanOrEqual(10);
    expect(target(cardPlan, 'edge:card.missedPayments:on:2').customer).toBe(target(cardPlan, 'rule:R03').customer);
    const edgesOnly = planTestData(card, RECORDS, { outcomes: false, edges: true });
    expect(cardPlan.customers.length).toBeLessThan(outcomeOnly.customers.length + edgesOnly.customers.length);
  });
});

describe('options', () => {
  it('outcomes only, edges only, and neither', () => {
    const outcomes = planTestData(card, RECORDS, { outcomes: true, edges: false });
    expect(outcomes.targets.some((t) => t.kind === 'edge' || t.kind === 'empty')).toBe(false);
    const edges = planTestData(card, RECORDS, { outcomes: false, edges: true });
    verify(card, edges);
    expect(edges.targets.every((t) => t.kind === 'edge' || t.kind === 'empty')).toBe(true);
    expect(edges.summary).toMatchObject({ outcomes: { total: 0, reached: 0 }, edges: { total: 28, reached: 27 }, capped: false });
    expect(edges.targets.map((t) => t.id)).toEqual(cardPlan.targets.filter((t) => t.kind === 'edge' || t.kind === 'empty').map((t) => t.id));
    expect(planTestData(card, RECORDS, { outcomes: false, edges: false })).toEqual({ customers: [], targets: [], summary: { outcomes: { total: 0, reached: 0 }, edges: { total: 0, reached: 0 }, unreachable: 0, capped: false } });
  });

  it('the cap keeps the outcome customers first and says what was left out', () => {
    const plan = planTestData(card, RECORDS, { ...BOTH, max: 5 });
    verify(card, plan);
    expect(plan.customers.length).toBe(5);
    expect(plan.summary.capped).toBe(true);
    expect(plan.customers.map((c) => c.record)).toEqual(cardPlan.customers.slice(0, 5).map((c) => c.record));
    expect(plan.targets.map((t) => t.id)).toEqual(cardPlan.targets.map((t) => t.id));
    const leftOut = plan.targets.filter((t) => t.customer === null && t.reason?.startsWith('Left out'));
    expect(leftOut.length).toBeGreaterThan(5);
    expect(leftOut[0].reason).toBe('Left out: the limit of 5 customers was reached.');
    expect(plan.summary.unreachable).toBe(cardPlan.summary.unreachable); // left out is not the same as unreachable
    expect(plan.summary.outcomes.reached).toBeLessThan(25);
    expect(plan.summary.outcomes.reached).toBeGreaterThan(plan.summary.edges.reached);
  });

  it('the default cap is 200 and a cap of zero gives no customers', () => {
    expect(cardPlan.summary.capped).toBe(false);
    expect(planTestData(card, RECORDS, { ...BOTH, max: 200 })).toEqual(cardPlan);
    const none = planTestData(card, RECORDS, { ...BOTH, max: 0 });
    expect(none.customers).toEqual([]);
    expect(none.summary).toMatchObject({ outcomes: { total: 25, reached: 0 }, capped: true });
    expect(planTestData(card, RECORDS, { ...BOTH, max: 1 }).targets.find((t) => t.customer === null)?.reason).toContain('limit of 1 customer was reached');
  });
});

describe('a document with no sample customers', () => {
  const plan = planTestData(card, [], BOTH);

  it('the card project works from its field definitions alone', () => {
    verify(card, plan);
    expect(plan.summary).toEqual({ outcomes: { total: 25, reached: 25 }, edges: { total: 28, reached: 27 }, unreachable: 1, capped: false });
    expect(plan.targets.map((t) => t.id)).toEqual(cardPlan.targets.map((t) => t.id));
    expect(planTestData(card, [], BOTH)).toEqual(plan);
  });

  it('the starting record uses field examples, sensible values by type and three rows per list', () => {
    const base = customerOf(plan, 'rule:R01').record;
    expect(base.card).toMatchObject({ maskedAccount: '•••• 1842', currency: 'USD', tier: 'standard', paymentStatus: 'current', missedPayments: 0, assistanceRequested: false, statementStart: '2026-01-01', statementEnd: '2026-01-11' });
    expect(base.card!.transactions.length).toBe(3);
    expect(base.card!.transactions[0]).toEqual({ id: 'Sample transaction id 1', date: '2026-01-01', merchant: 'Sample description 1', amountCents: 0 });
    expect(base.customer.locale).toBe('en-US');
    expect(base.customer.givenName).not.toBe('Jordan'); // the example name gives way to the name pool
  });

  it('customers built from it are consistent: only the Spanish one has a blocking issue', () => {
    expect(plan.customers.filter((c) => blockingCodes(issue(card, c)).length).map((c) => c.record.customer.locale)).toEqual(['es-US']);
    const reminder = customerOf(plan, 'variant:payment-guidance/payment-reminder').record.card!;
    expect([reminder.missedPayments, reminder.paymentStatus]).toEqual([1, 'overdue']); // not "1 missed payment on a current account"
  });

  it('records of another kind of document do not count as samples', () => {
    expect(planTestData(card, RECORDS.filter((r) => r.documentType === 'eob'), BOTH)).toEqual(plan);
  });

  it('the EOB project works too, with three claims built from the claim columns', () => {
    const p = planTestData(eob, [], BOTH);
    verify(eob, p);
    expect(p.summary.outcomes).toEqual({ total: 22, reached: 22 });
    const claims = customerOf(p, 'rule:R19').record.claims!;
    expect(claims.length).toBe(3);
    expect(claims[1]).toMatchObject({ claimId: 'Sample claim 2', status: 'received', billedCents: 0 });
    expect(customerOf(p, 'section-hidden:multi-claim-index').record.claims!.length).toBe(1);
  });
});

describe('targets nothing can reach', () => {
  it('a contradictory rule is reported with the reason and does not disturb the rest', () => {
    const p = run(card, { type: 'UPSERT_RULE', rule: hint('R21', 'Current and overdue at once', { op: 'and', args: [{ op: 'eq', path: 'card.paymentStatus', value: 'current' }, { op: 'eq', path: 'card.paymentStatus', value: 'overdue' }] }) });
    const plan = planTestData(p, RECORDS, BOTH);
    verify(p, plan);
    expect(target(plan, 'rule:R21')).toMatchObject({ customer: null, title: 'Rule “Current and overdue at once” applies' });
    expect(target(plan, 'rule:R21').reason).toBe('The conditions contradict each other: Payment status is “current” and Payment status is “overdue” cannot all be true at once. No customer can ever match.');
    expect(plan.summary.outcomes).toEqual({ total: 26, reached: 25 });
    expect(plan.summary.unreachable).toBe(cardPlan.summary.unreachable + 1);
    for (const t of cardPlan.targets.filter((x) => x.customer !== null)) expect(target(plan, t.id).customer, t.id).not.toBeNull();
    // the values the impossible rule mentions still get customers
    expect(customerOf(plan, 'edge:card.paymentStatus:is:overdue').record.card!.paymentStatus).toBe('overdue');
  });

  it('a rule that only a journey step can reach says so, and gets no customer', () => {
    const p: Project = {
      ...withRules(card, hint('R21', 'Hardship flag set', { op: 'eq', path: 'card.hardshipFlag', value: true })),
      journey: { ...card.journey, events: [...card.journey.events, { eventId: 'card-day75', eventType: 'hardship.flagged', label: 'Hardship flagged', day: 75, effects: [{ op: 'set', path: 'card.hardshipFlag', value: true }] }] },
    };
    const plan = planTestData(p, RECORDS, BOTH);
    verify(p, plan);
    expect(target(plan, 'rule:R21')).toMatchObject({ customer: null, reason: 'It is only reached at the journey step “Day 75 · Hardship flagged”, not on a document as issued, so no customer record is created for it.' });
    // the sample's own journey-only gap (arrangement approved) IS reachable by a real record
    expect(customerOf(plan, 'rule:R05').record.card!.arrangementStatus).toBe('approved');
  });

  it('a calculated field is solved through its inputs when that is known, and reported otherwise', () => {
    const p = withRules(card,
      hint('R21', 'Huge spend', { op: 'gt', path: 'card.transactionsTotalCents', value: 99999999 }),
      hint('R22', 'Nearly at the limit', { op: 'lt', path: 'card.availableCreditCents', value: 10000 }));
    const plan = planTestData(p, RECORDS, BOTH);
    verify(p, plan);
    expect(target(plan, 'rule:R21')).toMatchObject({ customer: null, reason: expect.stringContaining('“Sum of listed transactions”, which is calculated from other fields') });
    expect(target(plan, 'edge:card.transactionsTotalCents:on:99999999')).toMatchObject({ customer: null, reason: 'Sum of listed transactions is calculated from other fields and cannot be set on a customer.' });
    const near = customerOf(plan, 'rule:R22').record.card!;
    expect((near.creditLimitCents as number) - (near.newBalanceCents as number)).toBeLessThan(10000);
    expect(['below', 'on', 'above'].map((x) => valueAt(customerOf(plan, `edge:card.availableCreditCents:${x}:10000`), 'card.availableCreditCents'))).toEqual([9999, 10000, 10001]);
    for (const c of plan.customers) expect(c.record.card).not.toHaveProperty('availableCreditCents'); // never stored
    expect(target(plan, 'empty:card.availableCreditCents').reason).toContain('cannot be left empty');
  });

  it('a message no rule selects, and a disabled rule', () => {
    const p = run(card, { type: 'SET_RULE_ENABLED', ruleId: 'R03', enabled: false });
    const plan = planTestData(p, RECORDS, BOTH);
    verify(p, plan);
    expect(plan.targets.map((t) => t.id)).not.toContain('rule:R03');
    expect(target(plan, 'variant:payment-guidance/payment-support-offer')).toMatchObject({ customer: null, reason: expect.stringContaining('No rule or condition selects this message') });
    expect(plan.targets.map((t) => t.id)).not.toContain('edge:card.missedPayments:on:2'); // its threshold is no longer read
  });

  it('a rule that matches but never wins still gets a customer for whom it matches; its losing message does not', () => {
    const loser: Rule = { id: 'R21', scope: 'credit-statement', mode: 'exclusive', priority: 50, exclusiveGroup: 'payment-guidance', when: { op: 'eq', path: 'card.paymentStatus', value: 'current' }, then: { op: 'selectVariant', targetNodeId: 'payment-guidance', variantId: 'payment-reminder' }, version: 1, enabled: true, title: 'Always outranked' };
    const p = withRules(run(card, { type: 'SET_RULE_ENABLED', ruleId: 'R02', enabled: false }), loser);
    const plan = planTestData(p, RECORDS, { outcomes: true, edges: false });
    verify(p, plan);
    const res = issue(p, customerOf(plan, 'rule:R21'));
    expect(res.result.matchedRuleIds).toContain('R21');
    expect(res.result.selectedVariants['payment-guidance']).toBe('payment-standard');
    expect(target(plan, 'variant:payment-guidance/payment-reminder')).toMatchObject({ customer: null, reason: expect.stringContaining('always takes precedence') });
  });
});

describe('custom fields', () => {
  const custom: Project = {
    ...withRules(card,
      hint('R21', 'Loyal customer', { op: 'gte', path: 'custom.loyaltyYears', value: 5 }),
      hint('R22', 'Long-standing gold member', { op: 'and', args: [{ op: 'eq', path: 'custom.segment', value: 'gold' }, { op: 'lt', path: 'custom.memberSince', value: '2020-01-01' }] })),
    customFields: [
      { key: 'loyaltyYears', label: 'Loyalty years', type: 'int' },
      { key: 'segment', label: 'Customer segment', type: 'enum', enumValues: ['standard', 'gold'], required: true },
      { key: 'memberSince', label: 'Member since', type: 'date' },
    ],
  };
  const plan = planTestData(custom, RECORDS, BOTH);
  const customOf = (id: string): Record<string, unknown> => (customerOf(plan, id).record as unknown as { custom: Record<string, unknown> }).custom;

  it('a rule on a custom field gets an outcome customer with the value set on the record', () => {
    verify(custom, plan);
    expect(customOf('rule:R21').loyaltyYears).toBeGreaterThanOrEqual(5);
    expect(issue(custom, customerOf(plan, 'rule:R21')).result.matchedRuleIds).toContain('R21');
    expect(customOf('rule:R22')).toMatchObject({ segment: 'gold', memberSince: '2019-12-31' });
  });

  it('and edge customers below, on and above its threshold, plus one with it empty', () => {
    expect(['below', 'on', 'above'].map((x) => customOf(`edge:custom.loyaltyYears:${x}:5`).loyaltyYears)).toEqual([4, 5, 6]);
    expect(['below', 'on', 'above'].map((x) => issue(custom, customerOf(plan, `edge:custom.loyaltyYears:${x}:5`)).result.matchedRuleIds.includes('R21'))).toEqual([false, true, true]);
    expect(target(plan, 'edge:custom.loyaltyYears:on:5')).toMatchObject({ targetId: 'custom.loyaltyYears', title: 'Loyalty years exactly 5', observed: 'Rule “Loyal customer” applies' });
    expect(customOf('empty:custom.loyaltyYears').loyaltyYears ?? null).toBeNull();
    expect(target(plan, 'empty:custom.loyaltyYears').observed).toBe('Rule “Loyal customer” does not apply');
  });

  it('a date threshold moves by one day, with the rule’s other condition holding', () => {
    expect(['below', 'on', 'above'].map((x) => customOf(`edge:custom.memberSince:${x}:2020-01-01`))).toEqual([{ segment: 'gold', memberSince: '2019-12-31' }, { segment: 'gold', memberSince: '2020-01-01' }, { segment: 'gold', memberSince: '2020-01-02' }]);
    expect(['below', 'on', 'above'].map((x) => target(plan, `edge:custom.memberSince:${x}:2020-01-01`).observed)).toEqual(['Rule “Long-standing gold member” applies', 'Rule “Long-standing gold member” does not apply', 'Rule “Long-standing gold member” does not apply']);
    expect(target(plan, 'edge:custom.memberSince:below:2020-01-01').title).toBe('Member since just before Jan 1, 2020');
  });

  it('a required custom field the samples do not have is filled on every customer', () => {
    for (const c of plan.customers) expect(['standard', 'gold']).toContain((c.record as unknown as { custom: Record<string, unknown> }).custom.segment);
    expect(plan.targets.map((t) => t.id)).not.toContain('empty:custom.segment');
    const fromNothing = planTestData(custom, [], BOTH);
    verify(custom, fromNothing);
    expect((customerOf(fromNothing, 'rule:R01').record as unknown as { custom: Record<string, unknown> }).custom).toEqual({ loyaltyYears: 0, segment: 'standard', memberSince: '2026-02-10' });
  });

  it('works on the EOB too: an amount in a custom field', () => {
    const p: Project = { ...withRules(eob, hint('R21', 'Copay over $25', { op: 'gt', path: 'custom.copayCents', value: 2500 }, 'eob')), customFields: [{ key: 'copayCents', label: 'Copay', type: 'cents' }] };
    const eobCustom = planTestData(p, RECORDS, BOTH);
    verify(p, eobCustom);
    expect(['below', 'on', 'above'].map((x) => valueAt(customerOf(eobCustom, `edge:custom.copayCents:${x}:2500`), 'custom.copayCents'))).toEqual([2499, 2500, 2501]);
    expect(target(eobCustom, 'edge:custom.copayCents:above:2500')).toMatchObject({ title: 'Copay just above $25.00', observed: 'Rule “Copay over $25” applies' });
  });
});

describe('document languages', () => {
  it('English and each project language are used by someone', () => {
    for (const [p, plan] of [[card, cardPlan], [eob, eobPlan]] as const) {
      expect(plan.targets.filter((t) => t.kind === 'language').map((t) => t.targetId)).toEqual(['en-US', 'es-US']);
      expect(issue(p, customerOf(plan, 'language:en-US')).locale).toBe('en-US');
      const spanish = customerOf(plan, 'language:es-US');
      expect(spanish.record.customer.locale).toBe('es-US');
      expect(issue(p, spanish).locale).toBe('es-US');
    }
  });

  it('an English-only project gets one language, and no customer in a language it does not have', () => {
    const p: Project = { ...card, languages: [] };
    const plan = planTestData(p, RECORDS, BOTH);
    verify(p, plan);
    expect(plan.targets.filter((t) => t.kind === 'language').map((t) => t.targetId)).toEqual(['en-US']);
    expect(plan.customers.every((c) => c.record.customer.locale === 'en-US')).toBe(true);
    expect(target(plan, 'rule:R07')).toMatchObject({ customer: null, reason: expect.stringContaining('Spanish (United States) is not a language of this project') });
  });

  it('a language the customer data contract cannot name is reported, unless a rule switches to it', () => {
    const french: Project = { ...card, languages: ['es-US', 'fr-FR'] };
    const plan = planTestData(french, RECORDS, BOTH);
    verify(french, plan);
    expect(target(plan, 'language:fr-FR')).toMatchObject({ customer: null, title: 'Document in French (France)', reason: 'A customer record can only name English (United States) and Spanish (United States) as the preferred language, and no rule switches a document to French (France).' });
    expect(target(plan, 'language:es-US').customer).not.toBeNull();
    const byRule = withRules(french, { ...hint('R21', 'Premium customers read French', { op: 'eq', path: 'card.tier', value: 'premium' }), then: { op: 'setApprovedLocale', locale: 'fr-FR' } });
    const plan2 = planTestData(byRule, RECORDS, BOTH);
    verify(byRule, plan2);
    const reader = customerOf(plan2, 'language:fr-FR');
    expect(reader.record.card!.tier).toBe('premium');
    expect(issue(byRule, reader).locale).toBe('fr-FR');
    expect(['en-US', 'es-US']).toContain(reader.record.customer.locale);
  });
});

describe('names that a condition reads', () => {
  it('are kept, so the customer still reaches the rule', () => {
    const p = withRules(card, hint('R21', 'Named Jordan', { op: 'eq', path: 'customer.givenName', value: 'Jordan' }));
    const plan = planTestData(p, RECORDS, BOTH);
    verify(p, plan);
    const jordan = customerOf(plan, 'rule:R21');
    expect(jordan.record.customer.givenName).toBe('Jordan');
    expect(issue(p, jordan).result.matchedRuleIds).toContain('R21');
  });
});
