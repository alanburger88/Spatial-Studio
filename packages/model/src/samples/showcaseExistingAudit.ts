/**
 * The two original sample documents described for the examples' accuracy check (the audit of D106): what is
 * deliberately so (blocked customers, missing Spanish, the fixtures' deliberate inconsistencies, the one deliberate
 * "should" wording finding) and the domain arithmetic every customer of each must satisfy.
 *
 * Pure: the arithmetic checks read one customer record (as the fixtures hold it, or with a scenario's overrides
 * applied) and say what does not add up. They never change data. Amounts are whole cents.
 */
import type { SyntheticRecord } from '../types';

/** One thing that does not add up for one customer. `intended`: the data is deliberately so (and `why`). */
export interface ArithmeticFinding {
  recordId: string;
  check: string;
  message: string;
  intended: boolean;
  why?: string;
}

type Card = {
  statementStart?: string; statementEnd?: string; issuedAt?: string; dueDate?: string;
  creditLimitCents?: number; previousBalanceCents?: number; purchasesCents?: number; paymentsCreditsCents?: number; interestFeesCents?: number;
  newBalanceCents?: number; minimumDueCents?: number; paymentStatus?: string; missedPayments?: number;
  transactions?: Array<{ id?: string; date?: string; amountCents?: number }>;
};
type Claim = {
  claimId?: string; status?: string; liabilityConfirmed?: boolean; billedCents?: number; allowedCents?: number; contractualAdjustmentCents?: number;
  planPaidCents?: number; patientResponsibilityCents?: number; deductibleAppliedCents?: number; amountUnderReviewCents?: number;
};

const money = (c: number) => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Statuses whose amounts are not decided yet: the whole billed amount is "under review", nothing is allowed. */
const IN_REVIEW = new Set(['denied-pending-review', 'appeal-filed', 'received']);

/**
 * Card statement: new balance = previous balance + purchases − payments and credits + fees and interest; the listed
 * transactions sum to purchases; the minimum payment is not more than the new balance; the dates are in order (period
 * start ≤ end ≤ issue date ≤ due date, every transaction inside the period); and the payment state is consistent.
 */
export function cardArithmetic(record: SyntheticRecord): ArithmeticFinding[] {
  const id = record.recordId;
  const c = ((record as unknown as { card?: Card }).card ?? {}) as Card;
  const out: ArithmeticFinding[] = [];
  const add = (check: string, message: string) => out.push({ recordId: id, check, message, intended: false });
  const expected = num(c.previousBalanceCents) + num(c.purchasesCents) - num(c.paymentsCreditsCents) + num(c.interestFeesCents);
  if (num(c.newBalanceCents) !== expected) add('new-balance', `New balance ${money(num(c.newBalanceCents))} ≠ previous ${money(num(c.previousBalanceCents))} + purchases ${money(num(c.purchasesCents))} − payments ${money(num(c.paymentsCreditsCents))} + fees ${money(num(c.interestFeesCents))} = ${money(expected)}.`);
  const tx = Array.isArray(c.transactions) ? c.transactions : [];
  const listed = tx.reduce((s, t) => s + num(t.amountCents), 0);
  if (listed !== num(c.purchasesCents)) add('transactions-sum', `The ${tx.length} listed transactions total ${money(listed)}, but purchases are ${money(num(c.purchasesCents))}.`);
  if (num(c.minimumDueCents) < 0) add('minimum-payment', `The minimum payment ${money(num(c.minimumDueCents))} is negative.`);
  else if (num(c.minimumDueCents) > Math.max(0, num(c.newBalanceCents))) add('minimum-payment', `The minimum payment ${money(num(c.minimumDueCents))} is more than the new balance ${money(num(c.newBalanceCents))}.`);
  const order: Array<[string, string | undefined]> = [['statement start', c.statementStart], ['statement end', c.statementEnd], ['issue date', c.issuedAt], ['due date', c.dueDate]];
  for (let i = 1; i < order.length; i++) {
    const [a, av] = order[i - 1], [b, bv] = order[i];
    if (!av || !bv) add('dates', `The ${!av ? a : b} is missing.`);
    else if (av > bv) add('dates', `The ${a} (${av}) is after the ${b} (${bv}).`);
  }
  const outside = tx.filter((t) => !t.date || (c.statementStart && t.date < c.statementStart) || (c.statementEnd && t.date > c.statementEnd));
  if (outside.length) add('transaction-dates', `${outside.length} listed transaction${outside.length === 1 ? ' is' : 's are'} dated outside the statement period (first: ${outside[0].id ?? '?'} on ${outside[0].date ?? 'no date'}).`);
  if (c.paymentStatus === 'current' && num(c.missedPayments) > 0) add('payment-state', `Payment status is “current” with ${num(c.missedPayments)} missed payment${num(c.missedPayments) === 1 ? '' : 's'}.`);
  return out;
}

/**
 * Explanation of benefits, per claim: billed = contractual adjustment + allowed (+ the amount under review while a
 * claim is not decided); allowed = plan paid + member responsibility; the deductible applied is part of the member's
 * responsibility. Totals: the claims' plan-paid, billed and member amounts add up to the document's totals.
 */
export function eobArithmetic(record: SyntheticRecord): ArithmeticFinding[] {
  const id = record.recordId;
  const claims = (((record as unknown as { claims?: Claim[] }).claims) ?? []) as Claim[];
  const out: ArithmeticFinding[] = [];
  for (const cl of claims) {
    const who = `Claim ${cl.claimId ?? '?'}`;
    const review = num(cl.amountUnderReviewCents);
    const decided = num(cl.contractualAdjustmentCents) + num(cl.allowedCents);
    if (num(cl.billedCents) !== decided) {
      const explained = num(cl.billedCents) === decided + review && IN_REVIEW.has(cl.status ?? '') && cl.liabilityConfirmed !== true;
      out.push({
        recordId: id, check: 'billed', intended: explained,
        message: `${who}: billed ${money(num(cl.billedCents))} ≠ adjustment ${money(num(cl.contractualAdjustmentCents))} + allowed ${money(num(cl.allowedCents))}${review ? ` (under review: ${money(review)})` : ''}.`,
        ...(explained ? { why: `The claim is ${cl.status}: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.` } : {}),
      });
    }
    const shared = num(cl.planPaidCents) + num(cl.patientResponsibilityCents);
    if (num(cl.allowedCents) !== shared) {
      const guarded = cl.liabilityConfirmed !== true && IN_REVIEW.has(cl.status ?? '');
      out.push({
        recordId: id, check: 'allowed', intended: false,
        message: `${who}: allowed ${money(num(cl.allowedCents))} ≠ plan paid ${money(num(cl.planPaidCents))} + member responsibility ${money(num(cl.patientResponsibilityCents))}.${guarded ? ' Liability is unconfirmed, so the studio never shows that amount as owed.' : ''}`,
      });
    }
    if (num(cl.deductibleAppliedCents) > num(cl.patientResponsibilityCents)) out.push({ recordId: id, check: 'deductible', intended: false, message: `${who}: the deductible applied ${money(num(cl.deductibleAppliedCents))} is more than the member responsibility ${money(num(cl.patientResponsibilityCents))}.` });
  }
  return out;
}

/** The totals across claims, as the document's calculations and table footer work them out. */
export function eobTotals(record: SyntheticRecord): { claims: number; billedCents: number; planPaidCents: number; memberCents: number } {
  const claims = (((record as unknown as { claims?: Claim[] }).claims) ?? []) as Claim[];
  const totals = { claims: 0, billedCents: 0, planPaidCents: 0, memberCents: 0 };
  for (const c of claims) { totals.claims += 1; totals.billedCents += num(c.billedCents); totals.planPaidCents += num(c.planPaidCents); totals.memberCents += num(c.patientResponsibilityCents); }
  return totals;
}

/** The fixture scenarios (fixtures/expected_scenarios.json) whose data is deliberately inconsistent, and why. */
export const DELIBERATE_SCENARIO_FINDINGS: Record<string, { checks: string[]; why: string }> = {
  'card-inconsistent-payment-state': { checks: ['payment-state'], why: 'Deliberate: the oracle expects INCONSISTENT_PAYMENT_STATE (status “current” with two missed payments); priority must not hide it.' },
  'eob-unconfirmed-liability': { checks: ['allowed'], why: 'Deliberate: the oracle expects UNCONFIRMED_MEMBER_LIABILITY (member responsibility supplied while liability is unconfirmed); the amount is never shown as owed.' },
};

/** How one existing example is registered for the examples' accuracy check. */
export interface ExistingExample {
  projectId: 'aster-card-demo' | 'harborcare-demo';
  title: string;
  documentType: 'credit-statement' | 'eob';
  /** Customers deliberately blocked, and why. */
  blockedCustomers: Array<{ recordId: string; why: string }>;
  /** Intended exceptions an audit must not report as defects. */
  notes: string[];
  /** The wording-rule id of the one deliberate "should" finding, and the text it is about. */
  deliberateShould: { ruleId: string; textId: string; why: string };
  /** The domain arithmetic for one customer. */
  arithmetic: (record: SyntheticRecord) => ArithmeticFinding[];
}

const SPANISH_BLOCKED = ['CARD-0005', 'CARD-0017', 'CARD-0029', 'CARD-0041', 'CARD-0053', 'CARD-0065'];
const SPANISH_WHY = 'Prefers Spanish (es-US); R07 asks for approved Spanish and four required texts (New balance, Minimum payment, Payment instructions, Sample disclosures) have none, so REQUIRED_TRANSLATION_MISSING blocks this customer. Deliberate: Blockers, Translations and the guided demo show it.';

export const EXISTING_EXAMPLES: ExistingExample[] = [
  {
    projectId: 'aster-card-demo', title: 'Aster Card – credit-card statement', documentType: 'credit-statement',
    blockedCustomers: SPANISH_BLOCKED.map((recordId) => ({ recordId, why: SPANISH_WHY })),
    notes: [
      'Six Spanish-speaking customers are blocked on purpose (missing approved Spanish for required texts); the other 64 have no blocking issue.',
      'Required Spanish is deliberately missing for billing-summary, payment-due, payment-standard and sample-disclosure-set. The added texts have labelled Spanish sample drafts only (never approved by code).',
      'The fixture scenarios card-inconsistent-payment-state (contradictory payment state), and card-tie-defect (a rule patch that ties R03 and R04 at priority 400) are deliberate defects the oracle expects. card-250-rows replaces the list with 250 stress rows that still sum exactly to purchases.',
      'Rules R03 and R05 are reached by no customer as issued (only through scenario overrides or the journey): coverage reports them on purpose.',
      'One deliberate “should” wording finding: the relationship team message says “relationship specialist” (rule aster-relationship-team prefers “relationship team”).',
      'The holiday posting notice is in effect until 5 Jan 2027 and the cardholder agreement notice from 1 Dec 2026; every sample statement is issued 1 Nov 2026, so the agreement notice shows only “as issued on” a later day.',
      'The minimum payment, fees and late fees are illustrative synthetic values, not compliant calculations.',
    ],
    deliberateShould: { ruleId: 'aster-relationship-team', textId: 'relationship-manager', why: 'An existing approved message; the finding shows a “should” rule warning without blocking.' },
    arithmetic: cardArithmetic,
  },
  {
    projectId: 'harborcare-demo', title: 'HarborCare – explanation of benefits', documentType: 'eob',
    blockedCustomers: [],
    notes: [
      'No customer is blocked as issued; eob-unconfirmed-liability (scenario) is blocked on purpose by UNCONFIRMED_MEMBER_LIABILITY.',
      'Claims that are denied pending review or under appeal (EOB-0002, -0004, -0005, -0010, -0011, -0016, -0017, -0022, -0023, -0028, -0029) have nothing allowed and the whole billed amount under review: billed = adjustment + allowed does not hold for them by design.',
      'The document has no date: the fixture data has no issue or processing date, so “days since the service date” and dated notices are not part of this example.',
      'There is no Spanish-speaking EOB customer; Spanish exists as labelled sample drafts only.',
      'One deliberate “should” wording finding: the approved “Claim totals” disclosure says “patient responsibility” (rule harbor-no-patient prefers “member responsibility”); a disclosure is changed by a person, never by a fix.',
      'Accessible PDF is required for this example: every sample customer’s PDF passes the studio’s eleven checks.',
    ],
    deliberateShould: { ruleId: 'harbor-no-patient', textId: 'totals-and-terms', why: 'An approved disclosure; the finding shows a “should” rule warning on protected wording.' },
    arithmetic: eobArithmetic,
  },
];
