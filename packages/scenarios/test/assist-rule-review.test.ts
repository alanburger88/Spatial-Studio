import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { applyCommand, type Command, type Project, type Rule } from '@iss/model';
import { resolve } from '@iss/resolver';
import { reviewRules } from '../src/assist/ruleReview';
import type { RuleObservation } from '../src/assist/types';

const [card, eob] = seedProjects();
const cmd = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };
const seeded = (id: string): Rule => card.rules.find((r) => r.id === id)!;
const of = (obs: RuleObservation[], kind: RuleObservation['kind']): RuleObservation[] => obs.filter((o) => o.kind === kind);
const cardRecords = RECORDS.filter((r) => r.documentType === 'credit-statement');
/** A proposal is applied the way the studio does it: all its commands as one undoable step. */
const applyProposal = (p: Project, o: RuleObservation): Project => cmd(p, { type: 'BATCH', label: o.proposal!.title, commands: o.proposal!.commands! });
const blockedBy = (p: Project, code: string): number => cardRecords.filter((record) => resolve({ project: p, record }).findings.some((f) => f.code === code)).length;

const withTie = cmd(card, { type: 'UPSERT_RULE', rule: { ...seeded('R03'), when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } });
const withoutFallback = cmd(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
const extra = (id: string, priority: number, when: Rule['when'], variantId: string, title: string): Rule => ({
  id, scope: 'credit-statement', mode: 'exclusive', priority, when, then: { op: 'selectVariant', targetNodeId: 'payment-guidance', variantId }, version: 1, exclusiveGroup: 'payment-guidance', enabled: true, title,
});

describe('reviewRules on the untouched samples', () => {
  const obs = reviewRules(card, RECORDS);

  it('reports R03 and R05 as rules no customer reaches, and no tie', () => {
    const unreachable = of(obs, 'unreachable');
    expect(unreachable.map((o) => o.ruleIds[0]).sort()).toEqual(['R03', 'R05']);
    expect(of(obs, 'tie')).toEqual([]);
    expect(obs.some((o) => o.severity === 'blocking')).toBe(false);
    expect(of(obs, 'shadowed')).toEqual([]);
    expect(of(obs, 'no-fallback')).toEqual([]);
    expect(of(obs, 'disabled')).toEqual([]);
    const r03 = unreachable.find((o) => o.ruleIds[0] === 'R03')!;
    expect(r03.title).toBe('No customer matches “Two or more missed payments — offer support” today');
    expect(r03.detail).toBe('None of the 70 synthetic customers matches this rule, today or at any journey step (when missed payments is at least 2 and assistance requested is no). That does not make the rule wrong: the sample data may simply not include such a customer. Coverage can build a scenario that reaches it.');
    const r05 = unreachable.find((o) => o.ruleIds[0] === 'R05')!;
    expect(r05.detail).toContain('70 synthetic customers would match it along the journey (first after the step “Arrangement approved”)');
    expect(r05.detail).toContain('Coverage can build a scenario');
  });

  it('uses names, never ids or field paths, and counts are labelled synthetic', () => {
    for (const o of [...obs, ...reviewRules(eob, RECORDS), ...reviewRules(withTie, RECORDS), ...reviewRules(withoutFallback, RECORDS)]) {
      for (const text of [o.title, o.detail, o.proposal?.title ?? '', o.proposal?.explanation ?? '', o.proposal?.riskReason ?? '']) {
        expect(text).not.toMatch(/\bR\d\d\b|card\.|claim\.|payment-guidance|payment-standard|eob-|undefined|NaN/);
        expect(text).not.toMatch(/\d (customers|records)\b/);
      }
      expect(o.id.startsWith(`rule-review/${o.kind}/`)).toBe(true);
    }
  });

  it('overlaps that only happen along the journey are informational and say who wins', () => {
    const overlaps = of(obs, 'overlap');
    expect(overlaps.map((o) => o.ruleIds.join('>'))).toEqual(['R04>R02', 'R05>R02', 'R05>R04']);
    expect(overlaps.every((o) => o.severity === 'info' && !o.proposal)).toBe(true);
    expect(overlaps[2].title).toBe('“Payment arrangement approved” would win over “Customer asked for payment assistance” later in the journey');
    expect(overlaps[2].detail).toContain('they would get “Arrangement active” rather than “Assistance requested”');
  });

  it('counts the customers who fall back in the EOB sample', () => {
    const e = reviewRules(eob, RECORDS);
    const gap = of(e, 'gap');
    expect(gap).toHaveLength(1);
    expect(gap[0].severity).toBe('info');
    expect(gap[0].title).toBe('9 synthetic customers get the fallback in Claim message');
    expect(gap[0].detail).toContain('9 of 30 synthetic customers match none of the rules for Claim message, so they receive the fallback version “Processing your claim”.');
    const expected = RECORDS.filter((r) => r.documentType === 'eob' && resolve({ project: eob, record: r }).findings.some((f) => f.code === 'FALLBACK_SELECTED' && f.nodeId === 'eob-claim-message')).length;
    expect(expected).toBe(9);
    expect(of(e, 'unreachable').map((o) => o.ruleIds[0])).toEqual(['R19']);
    expect(of(e, 'tie')).toEqual([]);
  });

  it('is deterministic, ordered and leaves its inputs alone', () => {
    const before = JSON.stringify(card);
    const records = JSON.stringify(RECORDS);
    const again = reviewRules(card, RECORDS);
    expect(again).toEqual(obs);
    expect(JSON.stringify(again)).toBe(JSON.stringify(obs));
    expect(JSON.stringify(card)).toBe(before);
    expect(JSON.stringify(RECORDS)).toBe(records);
    const mixed = reviewRules(cmd(withTie, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } }), RECORDS);
    const rank = { blocking: 0, warning: 1, info: 2 };
    const ranks = mixed.map((o) => rank[o.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(mixed.map((o) => o.id)).size).toBe(mixed.length);
    for (const severity of ['blocking', 'warning', 'info'] as const) {
      const ids = mixed.filter((o) => o.severity === severity).map((o) => o.ruleIds[0] ?? '');
      expect(ids).toEqual([...ids].sort());
    }
  });
});

describe('reviewRules: ties', () => {
  it('reports the injected tie as blocking, with a proposal that removes it', () => {
    const obs = reviewRules(withTie, RECORDS);
    const tie = obs[0];
    expect(tie.kind).toBe('tie');
    expect(tie.severity).toBe('blocking');
    expect(tie.ruleIds).toEqual(['R03', 'R04']);
    expect(tie.title).toBe('“Two or more missed payments — offer support” and “Customer asked for payment assistance” tie for 7 synthetic customers');
    expect(tie.detail).toContain('7 of 70 synthetic customers match both today, and their document is blocked');
    expect(blockedBy(withTie, 'EXCLUSIVE_PRIORITY_TIE')).toBe(7);
    expect(of(obs, 'tie')).toHaveLength(1);

    const p = tie.proposal!;
    expect(p).toMatchObject({ kind: 'change', risk: 'review', source: 'builtin', findingCode: 'EXCLUSIVE_PRIORITY_TIE' });
    expect(p.title).toMatch(/^Raise the priority of “/);
    expect(p.commands).toHaveLength(1);
    expect(p.commands![0]).toMatchObject({ type: 'UPSERT_RULE', rule: { priority: 410 } });
    expect(p.riskReason).toBe('Changes which version 7 synthetic customers receive.');

    const fixed = applyProposal(withTie, tie);
    const after = reviewRules(fixed, RECORDS);
    expect(of(after, 'tie')).toEqual([]);
    expect(after.some((o) => o.severity === 'blocking')).toBe(false);
    expect(blockedBy(fixed, 'EXCLUSIVE_PRIORITY_TIE')).toBe(0);
    // No new tie with any other rule of the component.
    const priorities = fixed.rules.filter((r) => r.exclusiveGroup === 'payment-guidance').map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('prefers the more specific rule as the winner', () => {
    // R03 (two conditions) against a one-condition rule at the same priority.
    const p = cmd(card, { type: 'UPSERT_RULE', rule: extra('R13', 300, { op: 'gte', path: 'card.missedPayments', value: 2 }, 'payment-reminder', 'Two missed payments — remind') });
    const tie = of(reviewRules(p, RECORDS), 'tie')[0];
    expect(tie.ruleIds).toEqual(['R03', 'R13']);
    expect(tie.severity).toBe('warning'); // nobody matches R03 today, so nobody matches both
    expect(tie.title).toBe('“Two or more missed payments — offer support” and “Two missed payments — remind” have the same priority');
    expect(tie.proposal!.commands![0]).toMatchObject({ type: 'UPSERT_RULE', rule: { id: 'R03' } });
    expect(tie.proposal!.explanation).toContain('has more conditions, so it is the more specific rule');
    expect(of(reviewRules(applyProposal(p, tie), RECORDS), 'tie')).toEqual([]);
  });

  it('warns about equal priorities that could meet, and stays quiet when the conditions exclude each other', () => {
    // R01 (status current) and R02 (one missed payment) are about different fields: they could both hold.
    const could = cmd(card, { type: 'UPSERT_RULE', rule: { ...seeded('R01'), priority: 200 } });
    const tie = of(reviewRules(could, RECORDS), 'tie');
    expect(tie).toHaveLength(1);
    expect(tie[0].severity).toBe('warning');
    expect(tie[0].detail).toContain('No synthetic customer matches both today, but nothing in the two conditions rules it out');
    // Lowering R02 to sit with R01 has no room below 100 for... the proposal still must not create a tie.
    const fixed = applyProposal(could, tie[0]);
    expect(of(reviewRules(fixed, RECORDS), 'tie')).toEqual([]);

    // "exactly one missed payment" and "two or more missed payments and …" can never both hold.
    const never = cmd(card, { type: 'UPSERT_RULE', rule: { ...seeded('R02'), priority: 300 } });
    expect(of(reviewRules(never, RECORDS), 'tie')).toEqual([]);
  });

  it('lowers the other rule when there is no room above the winner', () => {
    let p = cmd(withTie, { type: 'UPSERT_RULE', rule: { ...seeded('R05'), priority: 401 } });
    const tie = of(reviewRules(p, RECORDS), 'tie')[0];
    expect(tie.proposal!.title).toMatch(/^Lower the priority of “/);
    p = applyProposal(p, tie);
    expect(of(reviewRules(p, RECORDS), 'tie')).toEqual([]);
    const priorities = p.rules.filter((r) => r.exclusiveGroup === 'payment-guidance').map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

describe('reviewRules: shadowed rules and overlaps', () => {
  // "Overdue → reminder" above R02: it takes every customer R02 matches, and loses the rest to R04.
  const p = cmd(card, { type: 'UPSERT_RULE', rule: extra('R13', 250, { op: 'eq', path: 'card.paymentStatus', value: 'overdue' }, 'payment-reminder', 'Overdue — remind') });
  const obs = reviewRules(p, RECORDS);

  it('says which rule shadows it and for how many customers', () => {
    const shadowed = of(obs, 'shadowed');
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]).toMatchObject({ severity: 'warning', ruleIds: ['R02', 'R13'] });
    expect(shadowed[0].title).toBe('“One missed payment — send a reminder” never applies: “Overdue — remind” always wins');
    expect(shadowed[0].detail).toContain('6 of 70 synthetic customers match “One missed payment — send a reminder”');
    expect(shadowed[0].detail).toContain('“Overdue — remind” (6 synthetic customers)');
    expect(shadowed[0].proposal).toBeUndefined(); // not more specific than the rule that outranks it
  });

  it('reports the remaining overlap with who wins, and does not repeat the shadowed pair', () => {
    const overlaps = of(obs, 'overlap');
    expect(overlaps.some((o) => o.ruleIds.includes('R02') && o.ruleIds.includes('R13'))).toBe(false);
    const o = overlaps.find((x) => x.ruleIds.join('>') === 'R04>R13')!;
    expect(o.severity).toBe('info');
    expect(o.title).toBe('“Customer asked for payment assistance” wins over “Overdue — remind” for 7 synthetic customers');
    expect(o.detail).toContain('7 of 70 synthetic customers match both rules for Payment guidance.');
    expect(o.detail).toContain('they get “Assistance requested” rather than “Payment reminder”');
  });

  it('proposes raising a shadowed rule that is the more specific one', () => {
    const when: Rule['when'] = { op: 'and', args: [{ op: 'eq', path: 'card.assistanceRequested', value: true }, { op: 'gte', path: 'card.missedPayments', value: 2 }] };
    const q = cmd(card, { type: 'UPSERT_RULE', rule: extra('R13', 350, when, 'payment-support-offer', 'Asked for help, two behind') });
    const shadowed = of(reviewRules(q, RECORDS), 'shadowed')[0];
    expect(shadowed.ruleIds).toEqual(['R13', 'R04']);
    expect(shadowed.proposal).toMatchObject({ kind: 'change', risk: 'review', findingCode: 'RULE_SHADOWED' });
    expect(shadowed.proposal!.commands![0]).toMatchObject({ type: 'UPSERT_RULE', rule: { id: 'R13', priority: 410 } });
    const after = reviewRules(applyProposal(q, shadowed), RECORDS);
    expect(of(after, 'shadowed').some((o) => o.ruleIds[0] === 'R13')).toBe(false);
    expect(of(after, 'tie')).toEqual([]);
  });
});

describe('reviewRules: fallbacks, unreachable and disabled rules', () => {
  it('reports a variant set without a fallback and proposes one', () => {
    const obs = reviewRules(withoutFallback, RECORDS);
    const nf = of(obs, 'no-fallback');
    expect(nf).toHaveLength(1);
    expect(nf[0].severity).toBe('warning'); // every customer still matches a rule
    expect(nf[0].title).toBe('Payment guidance has no fallback version');
    expect(nf[0].ruleIds).toEqual(['R01', 'R02', 'R03', 'R04', 'R05']);
    expect(nf[0].proposal).toMatchObject({ kind: 'change', risk: 'safe', title: 'Make “Payment instructions” the fallback version of Payment guidance' });
    expect(nf[0].proposal!.commands).toEqual([{ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: 'payment-standard' } }]);
    const fixed = applyProposal(withoutFallback, nf[0]);
    expect(fixed.nodes.find((n) => n.id === 'payment-guidance')!.fallbackVariantId).toBe('payment-standard');
    expect(of(reviewRules(fixed, RECORDS), 'no-fallback')).toEqual([]);
    // Optional sections (rule-driven or with their own conditions) are not asked for a fallback.
    expect(obs.some((o) => o.id.includes('high-volume-note'))).toBe(false);
  });

  it('is blocking when customers match no rule, and lists the switched-off rule', () => {
    const p = cmd(withoutFallback, { type: 'SET_RULE_ENABLED', ruleId: 'R01', enabled: false });
    const obs = reviewRules(p, RECORDS);
    expect(obs[0]).toMatchObject({ kind: 'no-fallback', severity: 'blocking' });
    expect(obs[0].detail).toContain('57 of 70 synthetic customers match none of the rules for Payment guidance, and no fallback version is set, so their document is blocked.');
    expect(blockedBy(p, 'NO_VARIANT_MATCH')).toBe(57);
    expect(obs[0].proposal).toMatchObject({ risk: 'review' });
    expect(obs[0].proposal!.riskReason).toContain('57 synthetic customers');
    const disabled = of(obs, 'disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({ severity: 'info', ruleIds: ['R01'], title: '“Customer is up to date” is switched off' });
    expect(of(obs, 'unreachable').some((o) => o.ruleIds[0] === 'R01')).toBe(false);
    const fixed = applyProposal(p, obs[0]);
    expect(blockedBy(fixed, 'NO_VARIANT_MATCH')).toBe(0);
    expect(of(reviewRules(fixed, RECORDS), 'gap')[0].title).toBe('57 synthetic customers get the fallback in Payment guidance');
  });

  it('warns about a rule whose conditions contradict each other', () => {
    const when: Rule['when'] = { op: 'and', args: [{ op: 'eq', path: 'card.missedPayments', value: 1 }, { op: 'gte', path: 'card.missedPayments', value: 2 }] };
    const p = cmd(card, { type: 'UPSERT_RULE', rule: extra('R13', 50, when, 'payment-reminder', 'Impossible') });
    const o = of(reviewRules(p, RECORDS), 'unreachable').find((x) => x.ruleIds[0] === 'R13')!;
    expect(o.severity).toBe('warning');
    expect(o.title).toBe('“Impossible” can never apply');
    expect(o.detail).not.toContain('Coverage');
  });

  it('counts only records of the project’s document type and handles an empty record set', () => {
    const none = reviewRules(card, []);
    expect(of(none, 'tie')).toEqual([]);
    expect(of(none, 'unreachable').length).toBe(card.rules.length);
    expect(reviewRules(card, RECORDS.filter((r) => r.documentType === 'eob'))).toEqual(none);
  });
});
