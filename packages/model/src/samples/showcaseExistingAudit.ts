/**
 * The two original sample documents described for the examples' accuracy check (the audit of D106): what is
 * deliberately so (blocked customers, missing Spanish, the fixtures' deliberate inconsistencies, the one deliberate
 * "should" wording finding) and the domain arithmetic every customer of each must satisfy.
 *
 * Pure: the arithmetic checks read one customer record (as the fixtures hold it, or with a scenario's overrides
 * applied) and say what does not add up. They never change data. Amounts are whole cents.
 */
import type { SyntheticRecord } from '../types';
import type { SampleNotes } from './notes';

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
      'The holiday mail notice (paper-statement customers only) is in effect until 5 Jan 2027 and the cardholder agreement notice from 1 Dec 2026; every sample statement is issued 1 Nov 2026, so the agreement notice shows only “as issued on” a later day.',
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

/* ------------------------------------------------------------------ the notes the examples' accuracy check reads */

const existing = (id: ExistingExample['projectId']) => EXISTING_EXAMPLES.find((e) => e.projectId === id)!;

/** What is deliberate about the enriched Aster Card statement (read by `scripts/audit-examples.ts`). */
export const CARD_NOTES: SampleNotes = {
  title: 'Aster Card',
  kind: 'Credit-card statement (built-in kind)',
  description: existing('aster-card-demo').notes[0],
  intendedBlockers: existing('aster-card-demo').blockedCustomers.map((b) => ({ recordId: b.recordId, code: 'REQUIRED_TRANSLATION_MISSING', reason: b.why })),
  knownDataProblems: [],
  intendedShould: [{ ruleId: existing('aster-card-demo').deliberateShould.ruleId, reason: `The relationship team message says “relationship specialist”. ${existing('aster-card-demo').deliberateShould.why}` }],
  unusedFields: [
    { path: 'card.currency', reason: 'A field of the approved card data (every fixture customer has USD); the approved template formats every amount as US dollars and never prints the currency code. The print-house mapping carries it.' },
  ],
  missingCalcs: [],
  // No approved Spanish at all (the six Spanish-speaking customers are blocked on purpose for the four required texts);
  // the sample Spanish drafts for the added texts are offered by the studio on request and are not stored in the sample.
  translations: { 'es-US': { approved: 0, draft: 0, missing: 120 } },
  mappings: { 'print-house': 'complete' },
  pages: { 'CARD-0001': 2, 'CARD-0002': 3 },
  unreached: [
    { id: 'rule R03', reason: 'Approved rule: two or more missed payments without a request for help. No fixture customer is in that state as issued; the oracle reaches it with overrides.', via: { scenario: 'card-inconsistent-payment-state' } },
    { id: 'alternative payment-guidance/payment-support-offer', reason: 'Chosen only by R03 (see above).', via: { scenario: 'card-inconsistent-payment-state' } },
    { id: 'rule R05', reason: 'Approved rule: an approved payment arrangement. Every fixture customer has no arrangement; the oracle and the journey reach it.', via: { scenario: 'card-arrangement-approved' } },
    { id: 'alternative payment-guidance/payment-arrangement-active', reason: 'Chosen only by R05 (see above).', via: { scenario: 'card-arrangement-approved' } },
    { id: 'alternative payment-timing/timing-arrangement', reason: 'Added “When to pay” wording for an approved arrangement (no late fee). No fixture customer has an arrangement; the pinned test shows it.', via: { testId: 'aster-arrangement-no-fee' } },
    { id: 'shown notice-agreement-update', reason: 'In effect from 1 Dec 2026; every fixture statement is issued 1 Nov 2026, so it shows only “as issued on” a later day.', via: { testId: 'aster-issued-december' } },
    { id: 'alternative notice-agreement-update/agreement-update', reason: 'As above: the notice’s one alternative.', via: { testId: 'aster-issued-december' } },
    { id: 'hidden spending-summary', reason: 'The spending sentence is hidden only when no transaction is listed; every fixture customer lists at least one.', via: { recordId: 'CARD-0001', overrides: { card: { transactions: [] } } } },
    { id: 'hidden payment-timing', reason: '“When to pay” is hidden only when no minimum payment is due; every fixture customer owes one.', via: { recordId: 'CARD-0001', overrides: { card: { minimumDueCents: 0 } } } },
  ],
  accessiblePdf: {
    required: false,
    reason: 'Known limitation, kept on purpose: “Accessible PDF is required” is off for the card. Its transaction table, where it continues onto another page, does not repeat its header row, so that part fails the studio’s table-header check. The suggested fix (repeat the header row) changes the pagination that the 250-row case (AT-18, AT-19, scripts/verify_app.py) and the Page panel browser tests rely on.',
    knownFailures: [{ code: 'PDF_A11Y_TABLE_NO_HEADERS', reason: 'The continued part of the transaction table has no header row (the known limitation above).' }],
  },
  scenarioPages: [{ scenario: 'card-250-rows', pages: 8, reason: 'The oracle’s 250-row stress case: the transaction table runs over eight pages with continued headings (AT-18, AT-19).' }],
};

/** Two synthetic claims for EOB-0001, to show the claim index the approved rule R19 adds for several claims. */
const TWO_CLAIMS = [
  { claimId: 'HC-90001', serviceDate: '2026-10-18', service: 'Office visit', billedCents: 40000, allowedCents: 25000, contractualAdjustmentCents: 15000, planPaidCents: 20000, patientResponsibilityCents: 5000, liabilityConfirmed: true, status: 'processed-covered', network: 'in-network', deductibleAppliedCents: 0, amountUnderReviewCents: 0 },
  { claimId: 'HC-90002', serviceDate: '2026-10-20', service: 'Diagnostic laboratory', billedCents: 12000, allowedCents: 8000, contractualAdjustmentCents: 4000, planPaidCents: 6000, patientResponsibilityCents: 2000, liabilityConfirmed: true, status: 'processed-covered', network: 'in-network', deductibleAppliedCents: 0, amountUnderReviewCents: 0 },
];

/** What is deliberate about the enriched HarborCare explanation of benefits (read by `scripts/audit-examples.ts`). */
export const EOB_NOTES: SampleNotes = {
  title: 'HarborCare Health',
  kind: 'Explanation of benefits (built-in kind)',
  description: existing('harborcare-demo').notes[0],
  intendedBlockers: [],
  knownDataProblems: [],
  intendedShould: [{ ruleId: existing('harborcare-demo').deliberateShould.ruleId, reason: `The approved “Claim totals” disclosure says “patient responsibility”. ${existing('harborcare-demo').deliberateShould.why}` }],
  unusedFields: [
    { path: 'claim.service', reason: 'A field of the approved claims data: the first claim’s service. The claim table shows every claim’s service (claims[].service), so for these one-claim customers it is shown there.' },
    { path: 'claim.serviceDate', reason: 'As above: the claim table shows every claim’s service date (claims[].serviceDate). The document has no date of its own (see the notes), so no calculation reads it.' },
  ],
  missingCalcs: [],
  translations: { 'es-US': { approved: 0, draft: 0, missing: 121 } },
  mappings: { 'print-house': 'complete' },
  pages: {},
  unreached: [
    { id: 'rule R19', reason: 'Approved rule: several claims show a claim index. Every fixture customer has exactly one claim.', via: { recordId: 'EOB-0001', overrides: { claims: TWO_CLAIMS } } },
    { id: 'shown multi-claim-index', reason: 'Shown only by R19 (see above).', via: { recordId: 'EOB-0001', overrides: { claims: TWO_CLAIMS } } },
    { id: 'alternative multi-claim-index/multi-claim-index', reason: 'The index’s one alternative, shown only by R19.', via: { recordId: 'EOB-0001', overrides: { claims: TWO_CLAIMS } } },
    { id: 'hidden claim-summary', reason: 'The claim summary is hidden only for a claim that says neither that the member’s liability is confirmed nor that it is not; every fixture claim says one or the other.', via: { recordId: 'EOB-0001', overrides: { claims: [{ ...TWO_CLAIMS[0], liabilityConfirmed: null }] } } },
    { id: 'language es-US', reason: existing('harborcare-demo').notes[3], via: { recordId: 'EOB-0001', overrides: { customer: { locale: 'es-US' } } } },
  ],
};
