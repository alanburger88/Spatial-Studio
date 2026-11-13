import { describe, expect, it } from 'vitest';
import { seedProjects } from '../../model/src/fixtures';
import { applyCommand, validateRule, type Predicate, type Project, type Rule, type RuleAction } from '@iss/model';
import { draftRuleFromSentence, nextRuleId, restateRule, ruleVocabulary, validateRuleDraft } from '../src/assist/ruleDraft';

const [card, eob] = seedProjects();
const seeded = (p: Project, id: string): Rule => p.rules.find((r) => r.id === id)!;
const cmd = (p: Project, c: Parameters<typeof applyCommand>[1]): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };

/** Every draft must be a complete rule the command bus accepts, with a fresh id, that ties with no sibling. */
function expectUsable(project: Project, rule: Rule): void {
  expect(validateRule(rule, project)).toEqual([]);
  expect(rule.id).toBe(nextRuleId(project));
  expect(rule.scope).toBe(project.documentType);
  expect(rule.version).toBe(1);
  expect(rule.enabled).toBe(true);
  expect(rule.title?.length).toBeGreaterThan(0);
  const applied = applyCommand(project, { type: 'UPSERT_RULE', rule });
  expect(applied.ok).toBe(true);
  if (applied.ok) expect(applied.project.rules.some((r) => r.id === rule.id)).toBe(true);
  if (rule.then.op === 'selectVariant') {
    expect(rule.mode).toBe('exclusive');
    expect(rule.exclusiveGroup).toBe(rule.then.targetNodeId);
    const siblings = project.rules.filter((r) => r.mode === 'exclusive' && r.exclusiveGroup === rule.exclusiveGroup);
    expect(siblings.map((r) => r.priority)).not.toContain(rule.priority);
  } else {
    expect(rule.mode).toBe('additive');
    expect(rule.exclusiveGroup).toBeUndefined();
  }
}

const select = (targetNodeId: string, variantId: string): RuleAction => ({ op: 'selectVariant', targetNodeId, variantId });
const section = (targetNodeId: string): RuleAction => ({ op: 'showSection', targetNodeId });

interface Case { project: Project; sentence: string; when: Predicate; then: RuleAction; /** Substrings expected in `uncertain`, one per entry; [] = confident. */ uncertain?: string[] }

const CASES: Case[] = [
  {
    project: card, sentence: 'If the customer has missed two or more payments and has not asked for help, show the payment support message',
    when: seeded(card, 'R03').when, then: select('payment-guidance', 'payment-support-offer'),
  },
  { project: card, sentence: 'When the payment status is overdue, show the payment reminder', when: { op: 'eq', path: 'card.paymentStatus', value: 'overdue' }, then: select('payment-guidance', 'payment-reminder') },
  { project: card, sentence: 'If the customer is past due, send the payment reminder', when: { op: 'eq', path: 'card.paymentStatus', value: 'overdue' }, then: select('payment-guidance', 'payment-reminder') },
  { project: card, sentence: 'When the new balance is over $500, show the payment reminder', when: { op: 'gt', path: 'card.newBalanceCents', value: 50000 }, then: select('payment-guidance', 'payment-reminder') },
  {
    project: card, sentence: 'If the payment status is overdue or the customer has asked for assistance, send the payment reminder',
    when: { op: 'or', args: [{ op: 'eq', path: 'card.paymentStatus', value: 'overdue' }, { op: 'eq', path: 'card.assistanceRequested', value: true }] }, then: select('payment-guidance', 'payment-reminder'),
  },
  { project: card, sentence: 'Show the rewards summary to customers with rewards', when: seeded(card, 'R11').when, then: seeded(card, 'R11').then },
  { project: card, sentence: 'Show the relationship team section to premium customers', when: seeded(card, 'R06').when, then: seeded(card, 'R06').then },
  {
    project: card, sentence: 'If missed payments is between 1 and 3 and the arrangement is approved, use Arrangement active in Payment guidance',
    when: { op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 1 }, { op: 'lte', path: 'card.missedPayments', value: 3 }, { op: 'eq', path: 'card.arrangementStatus', value: 'approved' }] },
    then: select('payment-guidance', 'payment-arrangement-active'),
  },
  {
    project: card, sentence: 'if missed payments is at least 2 and less than 5, show payment support',
    when: { op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 2 }, { op: 'lt', path: 'card.missedPayments', value: 5 }] }, then: select('payment-guidance', 'payment-support-offer'),
  },
  {
    project: card, sentence: 'If the customer is not premium and has more than 1,000 points, show the rewards summary',
    when: { op: 'and', args: [{ op: 'ne', path: 'card.tier', value: 'premium' }, { op: 'gt', path: 'card.rewardsBalance', value: 1000 }] }, then: section('rewards-summary'),
  },
  {
    project: card, sentence: 'if the customer has no missed payments and is up to date show payment instructions',
    when: { op: 'and', args: [{ op: 'eq', path: 'card.missedPayments', value: 0 }, { op: 'eq', path: 'card.paymentStatus', value: 'current' }] }, then: select('payment-guidance', 'payment-standard'),
  },
  {
    project: card, sentence: 'If fees and interest are more than 25 dollars or purchases are under $10, show “Payment support”',
    when: { op: 'or', args: [{ op: 'gt', path: 'card.interestFeesCents', value: 2500 }, { op: 'lt', path: 'card.purchasesCents', value: 1000 }] }, then: select('payment-guidance', 'payment-support-offer'),
  },
  { project: card, sentence: 'if card.missedPayments >= 3 then show payment-support-offer', when: { op: 'gte', path: 'card.missedPayments', value: 3 }, then: select('payment-guidance', 'payment-support-offer') },
  { project: card, sentence: 'if the payment due date is on or before 2026-12-01, show the payment reminder', when: { op: 'lte', path: 'card.dueDate', value: '2026-12-01' }, then: select('payment-guidance', 'payment-reminder') },
  { project: card, sentence: 'When the customer prefers Spanish, select the Payment reminder version', when: { op: 'eq', path: 'customer.locale', value: 'es-US' }, then: select('payment-guidance', 'payment-reminder') },
  { project: card, sentence: "Show the payment reminder to customers who haven't missed more than one payment", when: { op: 'lte', path: 'card.missedPayments', value: 1 }, then: select('payment-guidance', 'payment-reminder') },
  // guesses and unused words are reported, never silent
  {
    project: card, sentence: 'For customers with a past-due account, send them the reminder',
    when: { op: 'eq', path: 'card.paymentStatus', value: 'overdue' }, then: select('payment-guidance', 'payment-reminder'), uncertain: ['I matched “reminder” to “Payment reminder”'],
  },
  {
    project: card, sentence: 'if minimum payment due is 50 or more, show payment reminder',
    when: { op: 'gte', path: 'card.minimumDueCents', value: 5000 }, then: select('payment-guidance', 'payment-reminder'), uncertain: ['I read 50 as $50'],
  },
  {
    project: card, sentence: 'If missed payments is at least 2 and the customer is premium or has rewards, show payment support',
    when: { op: 'or', args: [{ op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 2 }, { op: 'eq', path: 'card.tier', value: 'premium' }] }, { op: 'gt', path: 'card.rewardsBalance', value: 0 }] },
    then: select('payment-guidance', 'payment-support-offer'), uncertain: ['mixes “and” and “or”'],
  },
  {
    project: card, sentence: "If the customer hasn't requested assistance and the tier is gold, show payment support",
    when: { op: 'eq', path: 'card.assistanceRequested', value: false }, then: select('payment-guidance', 'payment-support-offer'), uncertain: ['“gold” is not one of the Account tier values'],
  },
  {
    project: card, sentence: 'if the customer has missed more than two payments in the last year, show payment support',
    when: { op: 'gt', path: 'card.missedPayments', value: 2 }, then: select('payment-guidance', 'payment-support-offer'), uncertain: ['I did not use “last year”'],
  },
  // explanation of benefits
  { project: eob, sentence: 'If the claim is denied pending review, show the claim under review message', when: seeded(eob, 'R14').when, then: seeded(eob, 'R14').then },
  { project: eob, sentence: 'Show the network explanation when the provider is out of network', when: seeded(eob, 'R16').when, then: seeded(eob, 'R16').then },
  {
    project: eob, sentence: 'If liability is confirmed and member responsibility is more than $0, show the member responsibility summary',
    when: { op: 'and', args: [{ op: 'eq', path: 'claim.liabilityConfirmed', value: true }, { op: 'gt', path: 'claim.patientResponsibilityCents', value: 0 }] }, then: section('member-responsibility-summary'),
  },
  {
    project: eob, sentence: 'When the claim status is not denied or appealed, show covered services',
    when: { op: 'and', args: [{ op: 'ne', path: 'claim.status', value: 'denied-pending-review' }, { op: 'ne', path: 'claim.status', value: 'appeal-filed' }] }, then: select('eob-claim-message', 'eob-covered'),
  },
  { project: eob, sentence: 'when a deductible was applied show the deductible explanation', when: seeded(eob, 'R17').when, then: seeded(eob, 'R17').then },
  {
    project: eob, sentence: 'If the claim was appealed or the claim status is appeal resolved, show the appeal update',
    when: { op: 'or', args: [{ op: 'eq', path: 'claim.status', value: 'appeal-filed' }, { op: 'eq', path: 'claim.status', value: 'appeal-resolved' }] }, then: select('eob-claim-message', 'eob-appeal-status'),
  },
  { project: eob, sentence: 'If the plan paid is under 100 dollars and liability is not confirmed, use Processing your claim', when: { op: 'and', args: [{ op: 'lt', path: 'claim.planPaidCents', value: 10000 }, { op: 'eq', path: 'claim.liabilityConfirmed', value: false }] }, then: select('eob-claim-message', 'eob-processing') },
];

describe('draftRuleFromSentence', () => {
  it('has at least 20 understood sentences across both sample projects', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    expect(CASES.some((c) => c.project === card)).toBe(true);
    expect(CASES.some((c) => c.project === eob)).toBe(true);
  });

  for (const c of CASES) {
    it(`understands: ${c.sentence}`, () => {
      const d = draftRuleFromSentence(c.project, c.sentence);
      expect(d.source).toBe('builtin');
      expect(d.rule, d.uncertain.join(' | ')).not.toBeNull();
      const rule = d.rule!;
      expect(rule.when).toEqual(c.when);
      expect(rule.then).toEqual(c.then);
      expectUsable(c.project, rule);
      expect(d.restatement.startsWith('When ')).toBe(true);
      expect(d.uncertain.length).toBe((c.uncertain ?? []).length);
      for (const [i, part] of (c.uncertain ?? []).entries()) expect(d.uncertain[i]).toContain(part);
    });
  }

  it('the required sentence reproduces seeded rule R03 and places it by specificity', () => {
    const d = draftRuleFromSentence(card, 'If the customer has missed two or more payments and has not asked for help, show the payment support message');
    const rule = d.rule!;
    expect(rule.when).toEqual(seeded(card, 'R03').when);
    expect(rule.then).toEqual({ op: 'selectVariant', targetNodeId: 'payment-guidance', variantId: 'payment-support-offer' });
    // Two conditions: above every single-condition rule for the component, and tied with none.
    for (const id of ['R01', 'R02', 'R04', 'R05']) expect(rule.priority).toBeGreaterThan(seeded(card, id).priority);
    expect(rule.priority).not.toBe(seeded(card, 'R03').priority);
    expect(d.uncertain).toEqual([]);
    expect(d.restatement).toBe('When missed payments is at least 2 and assistance requested is no, show “Payment support” in Payment guidance. It will win over “Payment arrangement approved”, “Customer asked for payment assistance”, “Two or more missed payments — offer support” and 2 more. Note: the existing rule “Two or more missed payments — offer support” already has the same condition and outcome.');
    expect(rule.description).toContain('Drafted from:');
  });

  it('a one-condition rule goes above the other one-condition rules it can beat and below the more specific rule', () => {
    const d = draftRuleFromSentence(card, 'When the payment status is overdue, show the payment reminder');
    expect(d.rule!.priority).toBeGreaterThan(seeded(card, 'R02').priority);
    expect(d.rule!.priority).toBeLessThan(seeded(card, 'R03').priority);
    expect(d.restatement).toBe('When payment status is “overdue”, show “Payment reminder” in Payment guidance. It will win over “One missed payment — send a reminder” and “Customer is up to date”, and lose to “Two or more missed payments — offer support”, “Customer asked for payment assistance” and “Payment arrangement approved”.');
  });

  it('section rules are additive and mirror the seeded section rules', () => {
    const d = draftRuleFromSentence(card, 'Show the rewards summary to customers with rewards');
    const r11 = seeded(card, 'R11');
    expect(d.rule!.mode).toBe(r11.mode);
    expect(d.rule!.priority).toBe(r11.priority);
    expect(Object.keys(d.rule!).filter((k) => k !== 'description').sort()).toEqual(Object.keys(r11).sort());
    expect(d.restatement).toContain('include the “Rewards summary” section');
  });

  it('exclusive drafts carry exactly the properties of the seeded exclusive rules', () => {
    const d = draftRuleFromSentence(card, 'When the new balance is over $500, show the payment reminder');
    expect(Object.keys(d.rule!).filter((k) => k !== 'description')).toEqual(Object.keys(seeded(card, 'R03')));
  });

  it('reads the restatement of every seeded version/section rule back into the same rule', () => {
    let checked = 0;
    for (const project of [card, eob]) for (const r of project.rules) {
      if (r.then.op !== 'selectVariant' && r.then.op !== 'showSection') continue;
      if (JSON.stringify(r.when).includes('.count')) continue; // derived fields are outside the parser's scope
      const sentence = restateRule(project, r).split('. It ')[0].replace(/\.$/, '');
      const d = draftRuleFromSentence(project, sentence);
      expect(d.rule, `${r.id}: ${sentence} → ${d.uncertain.join(' | ')}`).not.toBeNull();
      expect(d.rule!.when).toEqual(r.when);
      expect(d.rule!.then).toEqual(r.then);
      expect(d.uncertain).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(13);
  });

  it('an ambiguous field is not guessed: the candidates are listed', () => {
    const d = draftRuleFromSentence(card, 'If the balance is over $500, show the payment reminder');
    expect(d.rule).toBeNull();
    expect(d.uncertain).toHaveLength(1);
    expect(d.uncertain[0]).toContain('“balance” could mean');
    expect(d.uncertain[0]).toContain('New balance');
    expect(d.uncertain[0]).toContain('Previous balance');
    expect(d.uncertain[0]).not.toContain('Rewards balance'); // "$500" cannot be points
    expect(d.restatement).toContain('I did understand what to show (show “Payment reminder” in Payment guidance)');
    expect(d.restatement).toContain('A sentence that works: “');
  });

  it('a value settles which field is meant', () => {
    const d = draftRuleFromSentence(card, 'If the status is approved, show arrangement active');
    expect(d.rule!.when).toEqual({ op: 'eq', path: 'card.arrangementStatus', value: 'approved' });
    expect(d.uncertain).toEqual([]);
  });

  it('an unknown target gives no rule and says what can be shown', () => {
    const d = draftRuleFromSentence(card, 'If the customer is premium, show the gold banner');
    expect(d.rule).toBeNull();
    expect(d.uncertain[0]).toContain('“gold banner” is not a version or section');
    expect(d.restatement).toContain('I did understand the condition (account tier is “premium”)');
    expect(d.restatement).toContain('Payment reminder');
    expect(d.restatement).toContain('Rewards summary');
  });

  it('an ambiguous target lists the candidates', () => {
    const d = draftRuleFromSentence(card, 'show the payment message when the customer is overdue');
    expect(d.rule).toBeNull();
    expect(d.uncertain[0]).toContain('could be “Payment instructions” in Payment guidance, “Payment reminder” in Payment guidance');
  });

  it.each([
    'Hide the rewards summary for customers with no rewards',
    "don't show the rewards summary to standard customers",
    'If the customer has no rewards, remove the rewards summary',
  ])('“hide” is refused with an explanation: %s', (sentence) => {
    const d = draftRuleFromSentence(card, sentence);
    expect(d.rule).toBeNull();
    expect(d.uncertain).toEqual(['“Hide” is not supported: a rule can only show a version or a section.']);
    expect(d.restatement).toContain('there is no “hide” rule');
  });

  it.each([
    ['purple monkey dishwasher', 'I could not find what to show'],
    ['', 'There is no sentence to read'],
    ['Show the payment reminder', 'does not say which customers'],
    ['Otherwise show payment instructions', 'fallback version'],
    ['Show payment support unless the customer asked for help', '“Unless” is not supported'],
    ['show the rewards summary if the customer did not use rewards', 'I could not use any of the conditions'],
    ['If missed payments is over $50, show the payment reminder', 'I could not use any of the conditions'],
    ['If the account tier is more than premium, show the payment reminder', 'I could not use any of the conditions'],
  ])('gives no rule for %j', (sentence, why) => {
    const d = draftRuleFromSentence(card, sentence);
    expect(d.rule).toBeNull();
    expect(d.restatement).toContain('No rule was drafted.');
    expect(d.restatement).toContain(why);
    expect(d.uncertain.length).toBeGreaterThan(0);
  });

  it('looser everyday wording is accepted but reported, never silent', () => {
    const late = draftRuleFromSentence(card, 'if the customer is late, show the payment reminder');
    expect(late.rule!.when).toEqual({ op: 'eq', path: 'card.paymentStatus', value: 'overdue' });
    expect(late.uncertain).toEqual(['In “the customer is late”: I read “late” as payment status “overdue”.']);
    const interest = draftRuleFromSentence(card, 'if interest is more than $20, show payment support');
    expect(interest.rule!.when).toEqual({ op: 'gt', path: 'card.interestFeesCents', value: 2000 });
    expect(interest.uncertain).toEqual(['In “interest is more than $20”: I read “interest” as fees and interest.']);
    const plan = draftRuleFromSentence(card, 'if the customer is on a payment plan, show arrangement active');
    expect(plan.rule!.when).toEqual({ op: 'ne', path: 'card.arrangementStatus', value: 'none' });
    expect(plan.uncertain[0]).toContain('I read this as arrangement status is not “none”');
    for (const d of [late, interest, plan]) expectUsable(card, d.rule!);
  });

  it('takes the verb that is followed by something that can be shown, and refuses over-long text', () => {
    const d = draftRuleFromSentence(card, 'if customers use paper show the transaction guide');
    expect(d.rule!.when).toEqual({ op: 'eq', path: 'card.channelPreference', value: 'print' });
    expect(d.rule!.then).toEqual({ op: 'selectVariant', targetNodeId: 'high-volume-note', variantId: 'high-volume-help' });
    const long = draftRuleFromSentence(card, `if ${'missed payments is 1 and '.repeat(40)}tier is premium, show payment reminder`);
    expect(long.rule).toBeNull();
    expect(long.uncertain[0]).toContain('too long');
  });

  it('matches enum values with separators normalised, including on custom fields', () => {
    const custom = cmd(card, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'collectionStage', label: 'Collection stage', type: 'enum', enumValues: ['none', 'past-due', 'written_off'] }] });
    const a = draftRuleFromSentence(custom, 'If collection stage is past due, show the payment reminder');
    expect(a.rule!.when).toEqual({ op: 'eq', path: 'custom.collectionStage', value: 'past-due' });
    expectUsable(custom, a.rule!);
    const b = draftRuleFromSentence(custom, 'If the customer is written off, show payment support');
    expect(b.rule!.when).toEqual({ op: 'eq', path: 'custom.collectionStage', value: 'written_off' });
    expect(a.restatement).toContain('When collection stage is “past due”');
  });

  it('never ties, even when the priorities leave no room where the rule belongs', () => {
    let dense = card;
    ['R01', 'R02', 'R03', 'R04', 'R05'].forEach((id, i) => { dense = cmd(dense, { type: 'UPSERT_RULE', rule: { ...seeded(card, id), priority: i } }); });
    const d = draftRuleFromSentence(dense, 'When the payment status is overdue, show the payment reminder');
    expectUsable(dense, d.rule!);
    expect(d.uncertain.join(' ')).toContain('existing priorities do not follow');
  });

  it('is deterministic and does not change the project', () => {
    const before = JSON.stringify(card);
    const a = draftRuleFromSentence(card, CASES[0].sentence);
    const b = draftRuleFromSentence(card, CASES[0].sentence);
    expect(a).toEqual(b);
    expect(JSON.stringify(card)).toBe(before);
  });
});

describe('validateRuleDraft', () => {
  const ok = {
    mode: 'exclusive',
    when: { op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 3 }, { op: 'eq', path: 'card.tier', value: 'premium' }] },
    then: { op: 'selectVariant', targetNodeId: 'payment-guidance', variantId: 'payment-support-offer' },
    title: 'Premium customers three payments behind',
  };
  const refused = (raw: unknown, why: string, project = card): void => {
    const d = validateRuleDraft(project, raw, 'ai');
    expect(d.rule).toBeNull();
    expect(d.source).toBe('ai');
    expect(d.uncertain.join(' | ')).toContain(why);
    expect(d.restatement).toContain('No rule was drafted');
  };

  it('accepts a valid object, assigns the id and scope and restates it', () => {
    const d = validateRuleDraft(card, ok, 'ai');
    expect(d.source).toBe('ai');
    expect(d.uncertain).toEqual([]);
    expectUsable(card, d.rule!);
    expect(d.rule).toMatchObject({ id: 'R13', scope: 'credit-statement', mode: 'exclusive', exclusiveGroup: 'payment-guidance', when: ok.when, then: ok.then, title: ok.title });
    expect(d.restatement).toBe('When missed payments is at least 3 and account tier is “premium”, show “Payment support” in Payment guidance. It will win over “Payment arrangement approved”, “Customer asked for payment assistance”, “Two or more missed payments — offer support” and 2 more.');
  });

  it('ignores a suggested id and keeps a free priority', () => {
    const d = validateRuleDraft(card, { ...ok, id: 'R03', priority: 450 }, 'ai');
    expect(d.rule!.id).toBe('R13');
    expect(d.rule!.priority).toBe(450);
    expectUsable(card, d.rule!);
  });

  it('never drafts a tie: a taken priority is re-placed and reported', () => {
    const d = validateRuleDraft(card, { ...ok, priority: 400 }, 'ai');
    expectUsable(card, d.rule!);
    expect(d.uncertain).toHaveLength(1);
    expect(d.uncertain[0]).toContain('priority 400 is already used by “Customer asked for payment assistance”');
    // The vocabulary's own example (an existing rule) therefore round-trips as a new, untied draft.
    const again = validateRuleDraft(card, ruleVocabulary(card).exampleRule, 'ai');
    expectUsable(card, again.rule!);
  });

  it('accepts a section rule and derives its mode', () => {
    const d = validateRuleDraft(card, { when: { op: 'gt', path: 'card.rewardsBalance', value: 1000 }, then: { op: 'showSection', targetNodeId: 'rewards-summary' } }, 'ai');
    expectUsable(card, d.rule!);
    expect(d.rule!.priority).toBe(30);
  });

  it('accepts in / not / isNull conditions on EOB fields', () => {
    const d = validateRuleDraft(eob, {
      when: { op: 'and', args: [{ op: 'in', path: 'claim.status', value: ['appeal-filed', 'appeal-resolved'] }, { op: 'not', arg: { op: 'isNull', path: 'claim.serviceDate' } }] },
      then: { op: 'selectVariant', targetNodeId: 'eob-claim-message', variantId: 'eob-appeal-status' },
    }, 'ai');
    expectUsable(eob, d.rule!);
    expect(d.restatement).toContain('When claim status is one of “appeal filed”, “appeal resolved” and not (service date is empty), show “Appeal update” in Claim message.');
  });

  it('rejects an unknown field path', () => refused({ ...ok, when: { op: 'eq', path: 'card.creditScore', value: 700 } }, 'Unknown field “card.creditScore”'));
  it('rejects a bad operator', () => refused({ ...ok, when: { op: 'matches', path: 'card.tier', value: 'prem.*' } }, 'Unsupported operator “matches”'));
  it('rejects a wrong value type without coercing it', () => refused({ ...ok, when: { op: 'gte', path: 'card.missedPayments', value: '3' } }, 'Missed payments must be compared with a whole number, not “3”'));
  it('rejects a wrong boolean, enum and money value', () => {
    refused({ ...ok, when: { op: 'eq', path: 'card.assistanceRequested', value: 'yes' } }, 'must be compared with true or false');
    refused({ ...ok, when: { op: 'eq', path: 'card.tier', value: 'gold' } }, '“gold” is not a Account tier value');
    refused({ ...ok, when: { op: 'gt', path: 'card.newBalanceCents', value: 500.5 } }, 'whole number of cents');
    refused({ ...ok, when: { op: 'gt', path: 'card.tier', value: 'premium' } }, 'can only be compared with “eq” or “ne”');
  });
  it('rejects an unknown version and an unknown component', () => {
    refused({ ...ok, then: { op: 'selectVariant', targetNodeId: 'payment-guidance', variantId: 'payment-gold' } }, 'Unknown version “payment-gold”');
    refused({ ...ok, then: { op: 'selectVariant', targetNodeId: 'billing-summary', variantId: 'payment-reminder' } }, 'Unknown component “billing-summary”');
    refused({ when: ok.when, then: { op: 'showSection', targetNodeId: 'billing-summary' } }, 'Unknown section “billing-summary”');
  });
  it('rejects extra, code-like fields anywhere in the object', () => {
    refused({ ...ok, script: 'alert(1)', onMatch: '() => fetch("https://example.com")' }, 'properties that a rule cannot have: “script”, “onMatch”');
    refused({ ...ok, when: { op: 'eq', path: 'card.tier', value: 'premium', js: 'return true' } }, 'cannot have: “js”');
    refused({ ...ok, then: { ...ok.then, run: 'x' } }, 'cannot have: “run”');
    refused(JSON.parse('{"__proto__":{"polluted":true},"when":{"op":"eq","path":"card.tier","value":"premium"},"then":{"op":"showSection","targetNodeId":"rewards-summary"}}'), '“__proto__”');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('rejects code-like strings in titles and text values', () => {
    refused({ ...ok, title: '<img src=x onerror=alert(1)>' }, 'title contains markup or code-like text');
    refused({ ...ok, description: 'x`${process.env.KEY}`' }, 'description contains markup or code-like text');
    refused({ ...ok, when: { op: 'eq', path: 'customer.givenName', value: 'fetch(1)' } }, 'Given name must be compared with plain text');
  });
  it('rejects anything that is not a plain rule object', () => {
    refused(JSON.stringify(ok), 'not a rule object');
    refused([ok], 'not a rule object');
    refused(null, 'not a rule object');
    refused(new (class Sneaky { when = ok.when; then = ok.then; })(), 'not a rule object');
    refused({ title: 'No logic' }, 'needs a “then”');
    refused({ then: ok.then }, 'needs a “when”');
  });
  it('rejects the wrong mode, group, scope and action kind', () => {
    refused({ ...ok, mode: 'additive' }, 'must have mode “exclusive”');
    refused({ ...ok, exclusiveGroup: 'rewards-summary' }, 'exclusiveGroup must be “payment-guidance”');
    refused({ ...ok, scope: 'eob' }, 'this document is a credit-statement');
    refused({ ...ok, priority: 12.5 }, 'Priority must be a whole number');
    refused({ mode: 'obligation', when: { op: 'eq', path: 'documentType', value: 'credit-statement' }, then: { op: 'requireNodes', nodeIds: ['billing-summary'] } }, 'Only rules that show a version');
    refused(ok, 'Unknown field “card.missedPayments”', eob);
  });
  it('does not change its input or the project', () => {
    const raw = JSON.parse(JSON.stringify({ ...ok, priority: 400 }));
    const before = JSON.stringify(card);
    validateRuleDraft(card, raw, 'ai');
    expect(raw).toEqual({ ...ok, priority: 400 });
    expect(JSON.stringify(card)).toBe(before);
  });
});

describe('restateRule', () => {
  it('turns the seeded rules into sentences', () => {
    expect(restateRule(card, seeded(card, 'R03'))).toBe('When missed payments is at least 2 and assistance requested is no, show “Payment support” in Payment guidance. It wins over “One missed payment — send a reminder” and “Customer is up to date”, and loses to “Customer asked for payment assistance” and “Payment arrangement approved”.');
    expect(restateRule(card, seeded(card, 'R05'))).toBe('When arrangement status is “approved”, show “Arrangement active” in Payment guidance. It wins over “Customer asked for payment assistance”, “Two or more missed payments — offer support”, “One missed payment — send a reminder” and “Customer is up to date”.');
    expect(restateRule(card, seeded(card, 'R01'))).toBe('When payment status is “current”, show “Payment instructions” in Payment guidance. It loses to “One missed payment — send a reminder”, “Two or more missed payments — offer support”, “Customer asked for payment assistance” and “Payment arrangement approved”.');
    expect(restateRule(card, seeded(card, 'R07'))).toBe('When preferred locale is “Spanish (United States)”, use the approved Spanish (United States) wording.');
    expect(restateRule(card, seeded(card, 'R11'))).toBe('When rewards balance (points) is more than 0, include the “Rewards summary” section.');
    expect(restateRule(card, seeded(card, 'R12'))).toBe('When document type is “credit statement”, require “New balance”, “Minimum payment”, “Sample disclosures”.');
    expect(restateRule(eob, seeded(eob, 'R14'))).toBe('When claim status is “denied pending review”, show “Claim under review” in Claim message. It wins over “Claim processed and covered”, and loses to “Appeal filed”.');
    expect(restateRule(eob, seeded(eob, 'R18'))).toBe('When member responsibility is more than $0 and member liability confirmed is yes, include the “Member responsibility summary” section.');
  });

  it('gives every seeded rule a sentence without codes or raw paths', () => {
    for (const project of [card, eob]) for (const r of project.rules) {
      const s = restateRule(project, r);
      expect(s.startsWith('When ')).toBe(true);
      expect(s).not.toMatch(/card\.|claim\.|customer\.|undefined|\bR\d\d\b/);
    }
  });

  it('says when a rule ties or is switched off, and shows amounts as money', () => {
    const tie: Rule = { ...seeded(card, 'R03'), priority: 400 };
    expect(restateRule(card, tie)).toContain('It has the same priority as “Customer asked for payment assistance”, so neither wins when both apply.');
    expect(restateRule(card, { ...seeded(card, 'R02'), enabled: false })).toContain('This rule is switched off.');
    const money: Rule = { ...seeded(card, 'R02'), when: { op: 'or', args: [{ op: 'gte', path: 'card.newBalanceCents', value: 125050 }, { op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 1 }, { op: 'lte', path: 'card.missedPayments', value: 3 }] }] } };
    expect(restateRule(card, money)).toContain('When new balance is at least $1,250.50 or (missed payments is between 1 and 3), show “Payment reminder”');
  });
});

describe('nextRuleId and ruleVocabulary', () => {
  it('gives the next free R## id', () => {
    expect(nextRuleId(card)).toBe('R13');
    expect(nextRuleId(eob)).toBe('R21');
    expect(nextRuleId({ ...card, rules: [] })).toBe('R01');
    const withDraft = cmd(card, { type: 'UPSERT_RULE', rule: draftRuleFromSentence(card, CASES[1].sentence).rule! });
    expect(nextRuleId(withDraft)).toBe('R14');
  });

  it('lists fields, components and sections a model may use, as plain JSON', () => {
    const v = ruleVocabulary(card);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(v.fields.find((f) => f.path === 'card.missedPayments')).toEqual({ path: 'card.missedPayments', label: 'Missed payments', type: 'int' });
    expect(v.fields.find((f) => f.path === 'card.tier')).toEqual({ path: 'card.tier', label: 'Account tier', type: 'enum', values: ['standard', 'premium'] });
    expect(v.fields.some((f) => f.type === 'array')).toBe(false);
    const guidance = v.variantSets.find((s) => s.nodeId === 'payment-guidance')!;
    expect(guidance.name).toBe('Payment guidance');
    expect(guidance.versions).toContainEqual({ id: 'payment-support-offer', title: 'Payment support' });
    expect(guidance.versions).toHaveLength(5);
    expect(v.sections).toEqual([{ nodeId: 'relationship-manager', name: 'Relationship team' }, { nodeId: 'rewards-summary', name: 'Rewards summary' }]);
    expect(v.variantSets.some((s) => s.nodeId === 'rewards-summary')).toBe(false);
    expect(validateRule(v.exampleRule, card)).toEqual([]);
    const e = ruleVocabulary(eob);
    expect(e.fields.some((f) => f.path === 'card.tier')).toBe(false);
    expect(e.variantSets.map((s) => s.nodeId)).toEqual(['eob-claim-message']);
    expect(e.sections.map((s) => s.nodeId)).toEqual(['network-explanation', 'deductible-explanation', 'member-responsibility-summary', 'multi-claim-index']);
    expect(validateRule(e.exampleRule, eob)).toEqual([]);
  });

  it('every field path and target in the vocabulary is accepted by validateRuleDraft', () => {
    for (const project of [card, eob]) {
      const v = ruleVocabulary(project);
      for (const s of v.variantSets) for (const ver of s.versions) {
        const d = validateRuleDraft(project, { when: { op: 'notNull', path: v.fields[0].path }, then: { op: 'selectVariant', targetNodeId: s.nodeId, variantId: ver.id } }, 'ai');
        expect(d.rule, d.uncertain.join(' | ')).not.toBeNull();
      }
      for (const s of v.sections) for (const f of v.fields) {
        const d = validateRuleDraft(project, { when: { op: 'isNull', path: f.path }, then: { op: 'showSection', targetNodeId: s.nodeId } }, 'ai');
        expect(d.rule, d.uncertain.join(' | ')).not.toBeNull();
      }
    }
  });
});
