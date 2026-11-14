/**
 * The two original sample documents, enriched in place (D106, 2026-11-14): "Aster Card" (credit-card statement,
 * `aster-card-demo`) and "HarborCare" (explanation of benefits, `harborcare-demo`).
 *
 * Every existing component, rule, message and customer is kept exactly as the fixtures build it; this layer only ADDS
 * (calculated fields, a lookup table, the document's date and dated notices, page design, wording rules, a mapping,
 * email wording and pinned tests), each through `applyCommand`, so every addition passes the same validation as an
 * edit in the studio. It is pure and deterministic: the same fixture project always gives the same enriched project.
 *
 * Constraint (see docs/design/EXAMPLES_EXISTING.md): the oracle goldens and `scripts/verify_app.py` compare the
 * resolver's core result (selected variants, matched and additive rule ids, required components, diagnostics,
 * document facts and its digest). Nothing added here is a rule, a message of a Variant Set, a required component or a
 * required text, and every calculation has a value for every fixture customer and every golden scenario, so the core
 * result of every customer is unchanged. New behaviour is expressed with inline conditions on NEW conditional sections,
 * calculated fields, wording, layout and periods.
 */
import { applyCommand, type Command } from '../commands';
import { mappablePaths, LIST_COLUMN_MARK } from '../mapping';
import type { CalculatedField, ChannelConfig, DocNode, MappingEntry, Predicate, Project, TestCase, WordingRule } from '../types';
import { channelConfig } from '../channels';
import { richFromMarkup } from '../rich';
import { CARD_LATE_FEES, EOB_REVIEW_TIMES, HOUSE, houseContent, type HouseItemId } from './houseLibrary';

/** The tables live in the house library (both examples link to them); re-exported where they were first defined. */
export { CARD_LATE_FEES, EOB_REVIEW_TIMES };

/* ------------------------------------------------------------------ helpers */

function run(project: Project, cmd: Command): Project {
  const res = applyCommand(project, cmd);
  if (!res.ok) throw new Error(`Showcase enrichment of ${project.projectId} refused ${cmd.type}: ${res.message}`);
  return res.project;
}

const flow = (spaceBeforePt = 10, html: NonNullable<DocNode['layout']>['html'] = { area: 'main', span: 12 }): NonNullable<DocNode['layout']> => ({
  paged: { mode: 'flow', widthPct: 100, align: 'left', spaceBeforePt },
  html,
});

const field = (path: string) => ({ op: 'field' as const, path });

/**
 * Links one house library item at the version the examples use, with exactly the library's content (as the Northwind
 * and Meridian builders do). Each link leaves every fixture customer's resolved document as it was: the glossary and
 * the house wording rules are not part of a resolution, and a linked table is the same table.
 */
function linkHouse(project: Project, itemId: HouseItemId): Project {
  const item = HOUSE.items[itemId];
  const version = HOUSE.linkPlan[itemId];
  return run(project, { type: 'LINK_LIBRARY_ITEM', item: { id: item.id, kind: item.kind, title: item.title }, version, content: houseContent(itemId, version) });
}

/** Inserts `node` into the root container right after `afterId` (or before `beforeId`). */
function insertAt(project: Project, node: DocNode, where: { after: string } | { before: string }): Command {
  const root = project.nodes.find((n) => n.id === project.rootNodeId)!;
  const children = root.children ?? [];
  const anchor = 'after' in where ? children.indexOf(where.after) : children.indexOf(where.before);
  if (anchor < 0) throw new Error(`Showcase enrichment: ${'after' in where ? where.after : where.before} is not in the root container.`);
  return { type: 'INSERT_NODE', node, parentId: project.rootNodeId, index: 'after' in where ? anchor + 1 : anchor };
}

/** A new conditional section with one alternative chosen by an inline condition (never a rule). */
function conditionalSection(project: Project, where: { after: string } | { before: string }, node: { id: string; name: string; spaceBeforePt: number }, alt: { variantId: string; title: string; when: Predicate; text: string }): Project {
  const section: DocNode = { id: node.id, type: 'conditional-region', name: node.name, policy: 'exclusive', variantIds: [], layout: flow(node.spaceBeforePt) };
  const p = run(project, insertAt(project, section, where));
  return run(p, { type: 'ADD_VARIANT', nodeId: node.id, variantId: alt.variantId, title: alt.title, when: alt.when, text: alt.text });
}

/**
 * A complete mapping: every data field and list column the document has (calculated values and the document's date
 * are worked out by the studio and are left to the checks' notes). Target names are given per path; amounts say they
 * are whole cents.
 */
function completeMapping(project: Project, targets: Record<string, string>): MappingEntry[] {
  const entries: MappingEntry[] = [];
  for (const [path, info] of mappablePaths(project)) {
    if (path === 'documentType' || path === 'document.date' || path.startsWith('calc.')) continue;
    const target = targets[path];
    if (!target) throw new Error(`Showcase mapping of ${project.projectId} has no target for ${path}.`);
    const entry: MappingEntry = { path, target };
    if (info.type === 'cents') { entry.targetType = 'DECIMAL(11,2)'; entry.format = 'Divide by 100 (the document holds whole cents).'; }
    else if (info.type === 'date') { entry.targetType = 'DATE'; entry.format = 'YYYY-MM-DD'; }
    else if (info.type === 'int' || info.type === 'points') entry.targetType = 'INTEGER';
    else if (info.type === 'bool') entry.targetType = 'BOOLEAN';
    else if (info.type === 'array') entry.targetType = 'RECORD GROUP';
    else entry.targetType = 'VARCHAR(80)';
    if (path.includes(LIST_COLUMN_MARK) && info.type === 'cents') entry.format = 'Divide by 100 (whole cents in the document).';
    entries.push(entry);
  }
  return entries;
}

/* ------------------------------------------------------------------ Aster Card (credit-card statement) */


export const CARD_CALCULATIONS: CalculatedField[] = [
  { key: 'daysUntilDue', label: 'Days until the payment is due', type: 'number', description: 'From the statement’s issue date to the payment due date.', expr: { op: 'days', from: { op: 'issueDate' }, to: field('card.dueDate') } },
  { key: 'listedTotal', label: 'Total of the listed transactions', type: 'money', description: 'The sum of every transaction listed on this statement.', expr: { op: 'sum', list: 'card.transactions', column: 'amountCents' } },
  {
    key: 'largestTransaction', label: 'Largest transaction', type: 'money', description: 'The largest listed transaction ($0.00 when none is listed).',
    expr: { op: 'if', when: { op: 'gt', path: 'card.transactions.count', value: 0 }, then: { op: 'largest', list: 'card.transactions', column: 'amountCents' }, else: { op: 'money', cents: 0 } },
  },
  {
    key: 'availableCreditPct', label: 'Available credit as a percentage of the limit', type: 'number', description: 'Available credit ÷ credit limit × 100, to the whole percent (0 when there is no limit).',
    expr: {
      op: 'if', when: { op: 'gt', path: 'card.creditLimitCents', value: 0 },
      then: { op: 'round', places: 0, arg: { op: 'mul', a: { op: 'div', a: field('card.availableCreditCents'), b: field('card.creditLimitCents') }, b: { op: 'number', value: 100 } } },
      else: { op: 'number', value: 0 },
    },
  },
  {
    key: 'lateFee', label: 'Late fee if the payment is late', type: 'money', description: 'The late fee for the account’s tier; none while a payment arrangement is approved.',
    expr: { op: 'if', when: { op: 'eq', path: 'card.arrangementStatus', value: 'approved' }, then: { op: 'money', cents: 0 }, else: { op: 'lookup', table: 'lateFeeByTier', column: 'lateFee', keys: [field('card.tier')] } },
  },
];

/** Dated notices: one in effect until a date, one from a date (the statements of the samples are issued 1 Nov 2026). */
export const CARD_PERIODS = {
  holidayPosting: { until: '2027-01-05' },
  agreementUpdate: { from: '2026-12-01' },
} as const;

const CARD_MAPPING_TARGETS: Record<string, string> = {
  recordId: 'DOC_KEY',
  'customer.givenName': 'CH_FIRST_NAME',
  'customer.familyName': 'CH_LAST_NAME',
  'customer.middleName': 'CH_MIDDLE_NAME',
  'customer.locale': 'CH_LANGUAGE',
  'customer.accessibility.largeText': 'CH_LARGE_PRINT',
  'customer.accessibility.highContrast': 'CH_HIGH_CONTRAST',
  'card.maskedAccount': 'ACCT_MASKED',
  'card.statementStart': 'STMT_FROM',
  'card.statementEnd': 'STMT_TO',
  'card.issuedAt': 'STMT_ISSUE_DATE',
  'card.dueDate': 'PAY_DUE_DATE',
  'card.currency': 'CURRENCY',
  'card.creditLimitCents': 'CREDIT_LIMIT',
  'card.previousBalanceCents': 'BAL_PREVIOUS',
  'card.purchasesCents': 'AMT_PURCHASES',
  'card.paymentsCreditsCents': 'AMT_PAYMENTS',
  'card.interestFeesCents': 'AMT_FEES_INTEREST',
  'card.newBalanceCents': 'BAL_NEW',
  'card.minimumDueCents': 'AMT_MIN_DUE',
  'card.tier': 'ACCT_TIER',
  'card.paymentStatus': 'PAY_STATUS',
  'card.missedPayments': 'PAY_MISSED_COUNT',
  'card.assistanceRequested': 'ASSIST_REQUESTED',
  'card.arrangementStatus': 'ARRANGEMENT_STATUS',
  'card.channelPreference': 'DELIVERY_CHANNEL',
  'card.rewardsBalance': 'REWARDS_POINTS',
  'card.transactions': 'TXN_GROUP',
  'card.transactions[].id': 'TXN_REF',
  'card.transactions[].date': 'TXN_DATE',
  'card.transactions[].merchant': 'TXN_DESC',
  'card.transactions[].amountCents': 'TXN_AMOUNT',
  'card.transactions.count': 'TXN_COUNT',
  'card.availableCreditCents': 'CREDIT_AVAILABLE',
  'card.transactionsTotalCents': 'TXN_TOTAL',
};

/** The document's own wording rules: one "must" the wording already satisfies, three "should" (one deliberately not met). */
export const CARD_WORDING_RULES: WordingRule[] = [
  { id: 'aster-not-legal', kind: 'required', severity: 'must', phrase: 'not a legal statement', appliesTo: 'anywhere', note: 'Every synthetic statement says it is not a legal statement.' },
  { id: 'aster-no-kindly', kind: 'banned', severity: 'should', phrase: 'kindly', replacement: 'please', appliesTo: 'anywhere', note: 'House style: a plain “please”.' },
  { id: 'aster-short-sentences', kind: 'sentence-length', severity: 'should', limit: 25, appliesTo: 'messages', note: 'Short sentences read better on a statement.' },
  // Deliberately not met by one existing message (the relationship team message says "relationship specialist"): the
  // example's one "should" finding. A banned phrase's replacement is "review first", so "Fix all safe issues" leaves it.
  { id: 'aster-relationship-team', kind: 'banned', severity: 'should', phrase: 'relationship specialist', replacement: 'relationship team', appliesTo: 'messages', note: 'Premium customers have a team, as the section title says, not one specialist.' },
];

export const CARD_TEST_IDS = ['aster-standard-on-time', 'aster-premium-team', 'aster-arrangement-no-fee', 'aster-spanish-blocked', 'aster-paper-holiday', 'aster-issued-december', 'aster-issued-january'] as const;

function cardTests(): TestCase[] {
  const always = ['payment-timing'];
  return [
    { id: 'aster-standard-on-time', name: 'Up-to-date customer by email: standard guidance and payment timing, no paper-only notice', recordId: 'CARD-0001', expect: { selectedVariants: { 'payment-guidance': 'payment-standard' }, visibleNodeIds: always, hiddenNodeIds: ['notice-holiday-posting', 'notice-agreement-update', 'relationship-manager'], approvedLocale: null, noBlocking: true } },
    { id: 'aster-premium-team', name: 'Premium customer asking for help: assistance message and the relationship team', recordId: 'CARD-0002', expect: { selectedVariants: { 'payment-guidance': 'payment-assistance-requested' }, visibleNodeIds: [...always, 'relationship-manager', 'high-volume-note'], noBlocking: true } },
    { id: 'aster-arrangement-no-fee', name: 'Approved arrangement: arrangement message, no late fee', recordId: 'CARD-0001', overrides: { card: { missedPayments: 2, paymentStatus: 'overdue', assistanceRequested: true, arrangementStatus: 'approved' } }, expect: { selectedVariants: { 'payment-guidance': 'payment-arrangement-active' }, visibleNodeIds: always, noBlocking: true } },
    { id: 'aster-spanish-blocked', name: 'Spanish-speaking customer stays blocked until the required Spanish is approved', recordId: 'CARD-0005', expect: { selectedVariants: { 'payment-guidance': 'payment-standard' }, approvedLocale: 'es-US' } },
    { id: 'aster-paper-holiday', name: 'Paper statement: the holiday mail notice shows; the agreement notice has not started', recordId: 'CARD-0007', expect: { visibleNodeIds: [...always, 'notice-holiday-posting'], hiddenNodeIds: ['notice-agreement-update'], noBlocking: true } },
    { id: 'aster-issued-december', name: 'As issued on 15 Dec 2026: the agreement notice starts, the holiday notice still shows', recordId: 'CARD-0007', issueDate: '2026-12-15', expect: { visibleNodeIds: ['notice-agreement-update', 'notice-holiday-posting'], noBlocking: true } },
    { id: 'aster-issued-january', name: 'As issued on 10 Jan 2027: the holiday notice has ended', recordId: 'CARD-0007', issueDate: '2027-01-10', expect: { visibleNodeIds: ['notice-agreement-update'], hiddenNodeIds: ['notice-holiday-posting'], noBlocking: true } },
  ];
}

export function enrichCard(project: Project): Project {
  if (project.documentType !== 'credit-statement') throw new Error('enrichCard expects the credit-card statement sample.');
  let p = project;
  // The document's date: the statement's issue date, which every sample customer has.
  p = run(p, { type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'card.issuedAt' } });
  // The late-fee table comes from the house library (the same table, linked: read-only here, "where used" lists the card).
  p = linkHouse(p, 'card-late-fees');
  for (const f of CARD_CALCULATIONS) p = run(p, { type: 'UPSERT_CALCULATED_FIELD', field: f });

  // Everything new goes after the transaction table, so the first page and the table's pages stay exactly as they were
  // (the oracle's 250-row case still starts its table on page 1 and keeps its continuation headings).
  // A one-sentence spending summary right under the transactions (plain text, like a note to the table), shown when at
  // least one transaction is listed.
  p = run(p, insertAt(p, {
    id: 'spending-summary', type: 'rich-text', name: 'Spending summary', layout: flow(6),
    visibleWhen: { op: 'gte', path: 'card.transactions.count', value: 1 },
    content: richFromMarkup('The {{card.transactions.count}} transactions on this statement total {{calc.listedTotal}}; the largest was {{calc.largestTransaction}}. {{calc.availableCreditPct}}% of your credit limit is available.'),
  }, { after: 'transaction-table' }));
  // Payment timing: an inline choice between two alternatives (not a rule, not a Variant Set), shown only when a minimum
  // payment is due.
  const owing: Predicate = { op: 'gt', path: 'card.minimumDueCents', value: 0 };
  const timing: DocNode = { id: 'payment-timing', type: 'conditional-region', name: 'Payment timing', policy: 'exclusive', variantIds: [], layout: flow(8) };
  p = run(p, insertAt(p, timing, { after: 'spending-summary' }));
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'payment-timing', variantId: 'timing-late-fee', title: 'When to pay', when: { op: 'and', args: [owing, { op: 'ne', path: 'card.arrangementStatus', value: 'approved' }] }, text: 'You have **{{calc.daysUntilDue}} days** to pay. If the minimum payment is late, a late fee of up to {{calc.lateFee}} may apply.' });
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'payment-timing', variantId: 'timing-arrangement', title: 'When to pay — arrangement in place', when: { op: 'and', args: [owing, { op: 'eq', path: 'card.arrangementStatus', value: 'approved' }] }, text: 'You have **{{calc.daysUntilDue}} days** to pay. While your arrangement is in place, no late fee is charged.' });
  // Two dated notices before the disclosures: one in effect until a date, one from a date.
  p = conditionalSection(p, { before: 'sample-disclosure-set' }, { id: 'notice-holiday-posting', name: 'Holiday mail notice', spaceBeforePt: 12 }, {
    variantId: 'holiday-posting', title: 'Paying by mail over the holidays', when: { op: 'eq', path: 'card.channelPreference', value: 'print' },
    text: 'Payments mailed between 24 December and 1 January may take an extra business day to arrive. Mail yours early so it arrives by {{card.dueDate}}.',
  });
  p = conditionalSection(p, { before: 'sample-disclosure-set' }, { id: 'notice-agreement-update', name: 'Cardholder agreement update', spaceBeforePt: 8 }, {
    variantId: 'agreement-update', title: 'Your cardholder agreement is changing', when: { op: 'gt', path: 'card.creditLimitCents', value: 0 },
    text: 'From 1 December 2026 it includes a section on paying with a digital wallet. You can read it at example.com/aster/agreement.',
  });
  p = run(p, { type: 'SET_SECTION_PERIOD', nodeId: 'notice-holiday-posting', period: CARD_PERIODS.holidayPosting });
  p = run(p, { type: 'SET_SECTION_PERIOD', nodeId: 'notice-agreement-update', period: CARD_PERIODS.agreementUpdate });
  // The transaction table's footer shows the calculated total (the same sum as its amount column, named).
  p = run(p, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { totalFrom: 'calc.listedTotal' } });

  // Email: an opening line with a calculated value (the SMS is unchanged: it is sized to one message).
  const ch: ChannelConfig = channelConfig(p);
  p = run(p, { type: 'SET_CHANNELS', channels: { ...ch, email: { ...ch.email, intro: 'You have {{calc.daysUntilDue}} days to pay. Every transaction is in your full statement.' } } });

  for (const rule of CARD_WORDING_RULES) p = run(p, { type: 'ADD_WORDING_RULE', rule });
  // The house wording rules and the Spanish glossary from the library: the approved fixture wording meets every house
  // "must" rule (it names Aster Card as fictional, never says "click here" or "guaranteed"), so no customer gains a finding.
  p = linkHouse(p, 'glossary-es');
  p = linkHouse(p, 'house-wording-rules');
  p = run(p, { type: 'ADD_MAPPING', mapping: { id: 'print-house', name: 'Mapping for the print house', system: 'the print house', description: 'Field names of the print house’s statement data file (fictional).' } });
  p = run(p, { type: 'SET_MAPPING_ENTRIES', mappingId: 'print-house', entries: completeMapping(p, CARD_MAPPING_TARGETS) });
  for (const t of cardTests()) p = run(p, { type: 'UPSERT_TEST_CASE', testCase: t });
  return { ...p, modelVersion: project.modelVersion };
}

/* ------------------------------------------------------------------ HarborCare (explanation of benefits) */


export const EOB_CALCULATIONS: CalculatedField[] = [
  {
    key: 'memberSharePct', label: 'Member’s share of the billed amount (%)', type: 'number', description: 'Member responsibility ÷ billed amount × 100, to one decimal (0 when nothing was billed).',
    expr: {
      op: 'if', when: { op: 'gt', path: 'claim.billedCents', value: 0 },
      then: { op: 'round', places: 1, arg: { op: 'mul', a: { op: 'div', a: field('claim.patientResponsibilityCents'), b: field('claim.billedCents') }, b: { op: 'number', value: 100 } } },
      else: { op: 'number', value: 0 },
    },
  },
  { key: 'totalPlanPaid', label: 'Total plan paid across claims', type: 'money', description: 'The sum of what the plan paid on every claim in this explanation.', expr: { op: 'sum', list: 'claims', column: 'planPaidCents' } },
  { key: 'claimCount', label: 'Number of claims', type: 'number', description: 'How many claims this explanation covers.', expr: { op: 'count', list: 'claims' } },
  { key: 'reviewDays', label: 'Days a review usually takes', type: 'number', description: 'From the review-time table, by the billed amount.', expr: { op: 'lookup', table: 'reviewTimeByAmount', column: 'days', keys: [field('claim.billedCents')] } },
];

const EOB_MAPPING_TARGETS: Record<string, string> = {
  recordId: 'DOC_KEY',
  'customer.givenName': 'MBR_FIRST_NAME',
  'customer.familyName': 'MBR_LAST_NAME',
  'customer.middleName': 'MBR_MIDDLE_NAME',
  'customer.locale': 'MBR_LANGUAGE',
  'customer.accessibility.largeText': 'MBR_LARGE_PRINT',
  'customer.accessibility.highContrast': 'MBR_HIGH_CONTRAST',
  'member.planName': 'PLAN_NAME',
  'member.memberId': 'MBR_ID',
  claims: 'CLM_GROUP',
  'claims[].claimId': 'CLM_ID',
  'claims[].service': 'CLM_SERVICE',
  'claims[].serviceDate': 'CLM_SERVICE_DATE',
  'claims[].billedCents': 'CLM_BILLED',
  'claims[].allowedCents': 'CLM_ALLOWED',
  'claims[].planPaidCents': 'CLM_PLAN_PAID',
  'claims[].patientResponsibilityCents': 'CLM_MBR_RESP',
  'claims[].status': 'CLM_STATUS',
  'claims.count': 'CLM_COUNT',
  'claim.claimId': 'PRIMARY_CLM_ID',
  'claim.serviceDate': 'PRIMARY_SERVICE_DATE',
  'claim.service': 'PRIMARY_SERVICE',
  'claim.billedCents': 'PRIMARY_BILLED',
  'claim.allowedCents': 'PRIMARY_ALLOWED',
  'claim.contractualAdjustmentCents': 'PRIMARY_ADJUSTMENT',
  'claim.planPaidCents': 'PRIMARY_PLAN_PAID',
  'claim.patientResponsibilityCents': 'PRIMARY_MBR_RESP',
  'claim.liabilityConfirmed': 'PRIMARY_LIAB_CONFIRMED',
  'claim.status': 'PRIMARY_STATUS',
  'claim.network': 'PRIMARY_NETWORK',
  'claim.deductibleAppliedCents': 'PRIMARY_DEDUCTIBLE',
  'claim.amountUnderReviewCents': 'PRIMARY_UNDER_REVIEW',
};

/** One "must" the wording already satisfies, three "should" (one deliberately not met). */
export const EOB_WORDING_RULES: WordingRule[] = [
  { id: 'harbor-not-a-bill', kind: 'required', severity: 'must', phrase: 'this is not a bill', appliesTo: 'anywhere', note: 'Every explanation of benefits says plainly that it is not a bill.' },
  // Deliberately not met by one existing text (the approved "Claim totals" disclosure says "patient responsibility"; a
  // disclosure's wording is changed by a person, never by a fix): the example's one "should" finding.
  { id: 'harbor-no-patient', kind: 'preferred', severity: 'should', phrase: 'patient responsibility', replacement: 'member responsibility', appliesTo: 'anywhere', note: 'We speak to members, not patients.' },
  { id: 'harbor-no-insurance-company', kind: 'banned', severity: 'should', phrase: 'insurance company', replacement: 'your plan', appliesTo: 'anywhere', note: 'Name the plan, not “the insurance company”.' },
  { id: 'harbor-short-sentences', kind: 'sentence-length', severity: 'should', limit: 25, appliesTo: 'messages', note: 'Explanations of benefits are read by everyone: keep sentences short.' },
];

export const EOB_TEST_IDS = ['harbor-covered', 'harbor-under-review', 'harbor-out-of-network', 'harbor-deductible', 'harbor-appeal'] as const;

function eobTests(): TestCase[] {
  return [
    { id: 'harbor-covered', name: 'Covered claim: covered message, member share and claim summary', recordId: 'EOB-0001', expect: { selectedVariants: { 'eob-claim-message': 'eob-covered' }, visibleNodeIds: ['claim-summary', 'member-responsibility-summary'], approvedLocale: null, noBlocking: true } },
    { id: 'harbor-under-review', name: 'Claim under review: no amount shown for the member, review time instead', recordId: 'EOB-0002', expect: { selectedVariants: { 'eob-claim-message': 'eob-review-needed' }, visibleNodeIds: ['claim-summary'], hiddenNodeIds: ['member-responsibility-summary'], noBlocking: true } },
    { id: 'harbor-out-of-network', name: 'Out-of-network claim: the network explanation shows', recordId: 'EOB-0003', expect: { visibleNodeIds: ['network-explanation', 'claim-summary'], noBlocking: true } },
    { id: 'harbor-deductible', name: 'Deductible applied: the deductible explanation shows', recordId: 'EOB-0008', expect: { visibleNodeIds: ['deductible-explanation', 'claim-summary'], noBlocking: true } },
    { id: 'harbor-appeal', name: 'Appeal filed: the appeal status message', recordId: 'EOB-0005', expect: { selectedVariants: { 'eob-claim-message': 'eob-appeal-status' }, visibleNodeIds: ['claim-summary'], noBlocking: true } },
  ];
}

/** Light stationery tint behind the first page of the explanation of benefits (decoration only). */
export const EOB_FIRST_PAGE_TINT = { kind: 'tint' as const, color: '#EEF5F1', opacityPct: 100 };

export function enrichEob(project: Project): Project {
  if (project.documentType !== 'eob') throw new Error('enrichEob expects the explanation-of-benefits sample.');
  let p = project;
  p = linkHouse(p, 'claim-review-times');
  for (const f of EOB_CALCULATIONS) p = run(p, { type: 'UPSERT_CALCULATED_FIELD', field: f });

  const confirmed: Predicate = { op: 'eq', path: 'claim.liabilityConfirmed', value: true };
  const notConfirmed: Predicate = { op: 'eq', path: 'claim.liabilityConfirmed', value: false };
  const summary: DocNode = { id: 'claim-summary', type: 'conditional-region', name: 'Claim summary', policy: 'exclusive', variantIds: [], layout: flow(8) };
  // After the claim details table, so the first page's top half (banner, amounts, message, chart) does not move.
  p = run(p, insertAt(p, summary, { after: 'claim-table' }));
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'claim-summary', variantId: 'summary-confirmed', title: 'Claim summary', when: confirmed, text: 'Your plan paid {{calc.totalPlanPaid}} for the claims in this explanation. Your share is {{calc.memberSharePct}}% of the amount the provider billed.' });
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'claim-summary', variantId: 'summary-in-review', title: 'How long the review takes', when: notConfirmed, text: 'Reviews of claims of this size usually take up to {{calc.reviewDays}} days. No amount is shown for you until it is done.' });
  // Keep the four claim amounts together on one page.
  p = run(p, { type: 'SET_LAYOUT', nodeId: 'claim-facts', profile: 'paged', layout: { keepTogether: true } });
  p = run(p, { type: 'SET_PAGE_DESIGN', patch: { pageTemplates: { first: { background: EOB_FIRST_PAGE_TINT } } } });
  p = run(p, { type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true });

  const ch: ChannelConfig = channelConfig(p);
  p = run(p, { type: 'SET_CHANNELS', channels: { ...ch, email: { ...ch.email, intro: 'Claims in this explanation: {{calc.claimCount}}. Open it to see what your plan paid and why.' } } });

  for (const rule of EOB_WORDING_RULES) p = run(p, { type: 'ADD_WORDING_RULE', rule });
  p = linkHouse(p, 'glossary-es');
  p = linkHouse(p, 'house-wording-rules');
  p = run(p, { type: 'ADD_MAPPING', mapping: { id: 'print-house', name: 'Mapping for the print house', system: 'the print house', description: 'Field names of the print house’s claims data file (fictional).' } });
  p = run(p, { type: 'SET_MAPPING_ENTRIES', mappingId: 'print-house', entries: completeMapping(p, EOB_MAPPING_TARGETS) });
  for (const t of eobTests()) p = run(p, { type: 'UPSERT_TEST_CASE', testCase: t });
  return { ...p, modelVersion: project.modelVersion };
}

/** Both samples enriched; any other project is returned as it is. */
export function enrichSamples(projects: Project[]): Project[] {
  return projects.map((p) => (p.projectId === 'aster-card-demo' ? enrichCard(p) : p.projectId === 'harborcare-demo' ? enrichEob(p) : p));
}
