import { blankProject } from '../templates';
import { channelConfig } from '../channels';
import { roundHalfUp } from '../expressions';
import type { CalculatedField, CustomField, LookupTable, Project, TestCase } from '../types';
import { SampleBuilder, addDays, and, centsAt, container, daysBetween, eq, fixed, flow, gte, isIn, metric, text, type SampleCustomer } from './kit';
import { HOUSE, RATE_BANDS, houseContent, type HouseItemId, type HouseLinkPlan } from './houseLibrary';
import { NORTHWIND_ES, NORTHWIND_ES_DRAFT_ONLY } from './northwindSpanish';
import type { SampleNotes } from './notes';

/**
 * Northwind Energy (fictional): a dual-fuel utility bill for the United States. Electricity and gas on one account;
 * customers have electricity only, gas only, or both, so sections appear and disappear. Built from the blank project
 * through the command bus, like a person would build it, with every feature a bill needs: calculations, three lookup
 * tables, the document's date, a dated rate change, a winter section, payment messages, a usage chart, a Last page
 * template with a tear-off payment slip, email and SMS wording, Spanish, journeys, pinned tests, wording rules,
 * mappings and links to the house library. All names, companies, people and numbers are invented.
 */

export const NORTHWIND_ID = 'northwind-energy-demo';
export const NORTHWIND_ACCENT = '#0B4F7C';
/** The day the electricity supply rate changes (the dated rate table row, the rate notice and the pinned tests use it). */
export const RATE_CHANGE_DAY = '2026-12-01';
export const WINTER = { from: '2026-11-01', until: '2027-04-01' } as const;

/* ------------------------------------------------------------------ data fields */

export const NORTHWIND_FIELDS: CustomField[] = [
  { key: 'accountNumber', label: 'Account number', type: 'string', required: true, example: '4417-2290-318' },
  { key: 'billDate', label: 'Bill date', type: 'date', required: true, example: '2026-11-14' },
  { key: 'periodStart', label: 'Billing period start', type: 'date', required: true, example: '2026-10-09' },
  { key: 'periodEnd', label: 'Billing period end', type: 'date', required: true, example: '2026-11-08' },
  { key: 'dueDate', label: 'Payment due date', type: 'date', example: '2026-12-05' },
  { key: 'serviceStreet', label: 'Service street', type: 'string', required: true, example: '118 Alder Row' },
  { key: 'serviceCity', label: 'Service city', type: 'string', required: true, example: 'Calder Bay' },
  { key: 'serviceState', label: 'Service state', type: 'string', required: true, example: 'MI' },
  { key: 'serviceZip', label: 'Service ZIP code', type: 'string', required: true, example: '49012' },
  { key: 'services', label: 'Services on the account', type: 'enum', enumValues: ['electric', 'gas', 'dual'], required: true, dimension: true },
  { key: 'plan', label: 'Rate plan', type: 'enum', enumValues: ['standard', 'time-of-use', 'budget'], required: true, dimension: true },
  { key: 'paymentStatus', label: 'Payment status', type: 'enum', enumValues: ['current', 'overdue'], required: true, dimension: true },
  { key: 'paymentPlan', label: 'On a payment plan', type: 'bool' },
  { key: 'autopay', label: 'Automatic payment', type: 'bool' },
  { key: 'planInstallmentCents', label: 'Payment plan installment', type: 'cents' },
  { key: 'previousBalanceCents', label: 'Previous balance', type: 'cents', required: true, example: '8742' },
  { key: 'paymentsCents', label: 'Payments received', type: 'cents', required: true, example: '8742' },
  { key: 'currentChargesCents', label: 'Current charges', type: 'cents', example: '11384' },
  { key: 'taxesCents', label: 'Taxes and fees', type: 'cents', required: true, example: '683' },
  { key: 'lastYearKwh', label: 'Electricity used, same month last year (kWh)', type: 'int', example: '612' },
  { key: 'lastYearTherms', label: 'Gas used, same month last year (therms)', type: 'int', example: '48' },
  {
    key: 'meters', label: 'Meter readings', type: 'list',
    itemFields: [
      { key: 'fuel', label: 'Fuel', type: 'string' },
      { key: 'meterNumber', label: 'Meter number', type: 'string' },
      { key: 'previousRead', label: 'Previous reading', type: 'int' },
      { key: 'currentRead', label: 'Current reading', type: 'int' },
      { key: 'readType', label: 'Read type', type: 'string' },
      { key: 'usage', label: 'Usage', type: 'int' },
      { key: 'unit', label: 'Unit', type: 'string' },
    ],
  },
  {
    key: 'charges', label: 'Charges', type: 'list',
    itemFields: [
      { key: 'fuel', label: 'Fuel', type: 'string' },
      { key: 'description', label: 'Description', type: 'string' },
      { key: 'quantity', label: 'Quantity', type: 'int' },
      { key: 'unit', label: 'Unit', type: 'string' },
      { key: 'rate', label: 'Rate', type: 'string' },
      { key: 'rateTenThousandths', label: 'Rate in ten-thousandths of a dollar', type: 'int' },
      { key: 'amountCents', label: 'Amount', type: 'cents' },
    ],
  },
  {
    key: 'usageHistory', label: 'Usage history', type: 'list',
    itemFields: [
      { key: 'month', label: 'Month', type: 'string' },
      { key: 'kwh', label: 'Electricity (kWh)', type: 'int' },
      { key: 'therms', label: 'Gas (therms)', type: 'int' },
    ],
  },
];

/* ------------------------------------------------------------------ lookup tables */

export { RATE_BANDS };
export const LATE_FEES: LookupTable = {
  id: 'lateFees', title: 'Late fee by rate plan',
  keys: [{ key: 'plan', label: 'Rate plan', match: 'text' }],
  columns: [{ key: 'fee', label: 'Late fee', type: 'money' }],
  rows: [
    { keys: { plan: 'standard' }, values: { fee: 1500 } },
    { keys: { plan: 'time-of-use' }, values: { fee: 1250 } },
    { keys: { plan: 'budget' }, values: { fee: 1000 } },
  ],
};
export const SUPPLY_RATES: LookupTable = {
  id: 'supplyRates', title: 'Electricity supply rate by bill date',
  description: 'The supply rate approved for each period. The rate changes on 1 December 2026.',
  keys: [{ key: 'period', label: 'Bill date', match: 'date-range' }],
  columns: [{ key: 'rate', label: 'Supply rate (¢ per kWh)', type: 'number' }],
  rows: [
    { keys: { period: { from: '2026-06-01', until: RATE_CHANGE_DAY } }, values: { rate: 7.85 } },
    { keys: { period: { from: RATE_CHANGE_DAY, until: '2027-06-01' } }, values: { rate: 8.42 } },
  ],
};

/** Rates in ten-thousandths of a dollar, as the charges list carries them (the customers are built from these). */
export const NW_RATES = {
  electricCustomer: 125000, gasCustomer: 97500, dualDiscount: -20000,
  delivery: (kwh: number) => (kwh < 500 ? 612 : kwh < 1000 ? 688 : 741),
  supply: (billDate: string) => (billDate < RATE_CHANGE_DAY ? 785 : 842),
  gasDelivery: 4120, gasSupply: 6385, publicPurpose: 41,
  /** Sales tax on current charges, in basis points. */
  taxBps: 600,
};

/* ------------------------------------------------------------------ calculations */

const f = (path: string) => ({ op: 'field' as const, path });
export const NORTHWIND_CALCS: CalculatedField[] = [
  { key: 'electricUsage', label: 'Electricity used (kWh)', type: 'number', description: 'The usage of every electricity meter added up.', expr: { op: 'sum', list: 'custom.meters', column: 'usage', where: { op: 'eq', path: 'fuel', value: 'Electricity' } } },
  { key: 'gasUsage', label: 'Gas used (therms)', type: 'number', description: 'The usage of every gas meter added up.', expr: { op: 'sum', list: 'custom.meters', column: 'usage', where: { op: 'eq', path: 'fuel', value: 'Gas' } } },
  { key: 'estimatedReads', label: 'Estimated readings', type: 'number', expr: { op: 'count', list: 'custom.meters', where: { op: 'eq', path: 'readType', value: 'estimated' } } },
  { key: 'deliveryRate', label: 'Delivery rate (¢ per kWh)', type: 'number', expr: { op: 'lookup', table: 'rateBands', column: 'rate', keys: [f('calc.electricUsage')] } },
  { key: 'deliveryBand', label: 'Delivery rate band', type: 'text', expr: { op: 'lookup', table: 'rateBands', column: 'band', keys: [f('calc.electricUsage')] } },
  { key: 'deliveryCharge', label: 'Electricity delivery charge', type: 'money', description: 'Electricity used times the delivery rate of its band, to the cent.', expr: { op: 'round', places: 2, arg: { op: 'mul', a: { op: 'mul', a: f('calc.electricUsage'), b: { op: 'money', cents: 1 } }, b: f('calc.deliveryRate') } } },
  { key: 'supplyRate', label: 'Supply rate (¢ per kWh)', type: 'number', description: 'The supply rate in force on the bill date.', expr: { op: 'lookup', table: 'supplyRates', column: 'rate', keys: [{ op: 'issueDate' }] } },
  { key: 'billingDays', label: 'Days in the billing period', type: 'number', expr: { op: 'days', from: f('custom.periodStart'), to: f('custom.periodEnd') } },
  { key: 'daysUntilDue', label: 'Days until the due date', type: 'number', expr: { op: 'days', from: { op: 'issueDate' }, to: f('custom.dueDate') } },
  { key: 'avgDailyKwh', label: 'Average electricity a day (kWh)', type: 'number', expr: { op: 'round', places: 1, arg: { op: 'div', a: f('calc.electricUsage'), b: f('calc.billingDays') } } },
  { key: 'lateFee', label: 'Late fee if unpaid', type: 'money', description: 'Only for an overdue account: the late fee of its rate plan.', expr: { op: 'if', when: { op: 'eq', path: 'custom.paymentStatus', value: 'overdue' }, then: { op: 'lookup', table: 'lateFees', column: 'fee', keys: [f('custom.plan')] }, else: { op: 'money', cents: 0 } } },
  { key: 'totalDue', label: 'Total amount due', type: 'money', description: 'Previous balance, less payments received, plus current charges and taxes.', expr: { op: 'add', a: { op: 'add', a: { op: 'sub', a: f('custom.previousBalanceCents'), b: f('custom.paymentsCents') }, b: f('custom.currentChargesCents') }, b: f('custom.taxesCents') } },
  { key: 'creditAmount', label: 'Credit on the account', type: 'money', expr: { op: 'abs', arg: f('calc.totalDue') } },
  { key: 'serviceAddress', label: 'Service address', type: 'text', expr: { op: 'join', sep: ', ', parts: [f('custom.serviceStreet'), f('custom.serviceCity'), { op: 'join', sep: ' ', parts: [f('custom.serviceState'), f('custom.serviceZip')] }] } },
  { key: 'kwhChangePct', label: 'Change in electricity use from last year (%)', type: 'number', description: 'Zero when there is no reading for the same month last year.', expr: { op: 'if', when: { op: 'gt', path: 'custom.lastYearKwh', value: 0 }, then: { op: 'round', places: 0, arg: { op: 'mul', a: { op: 'div', a: { op: 'sub', a: f('calc.electricUsage'), b: f('custom.lastYearKwh') }, b: f('custom.lastYearKwh') }, b: { op: 'number', value: 100 } } }, else: { op: 'number', value: 0 } } },
  { key: 'nextReadDate', label: 'Next meter reading (about)', type: 'date', expr: { op: 'addDays', date: f('custom.periodEnd'), days: { op: 'number', value: 30 } } },
  { key: 'peakMonthKwh', label: 'Highest monthly electricity use in the past year (kWh)', type: 'number', expr: { op: 'largest', list: 'custom.usageHistory', column: 'kwh' } },
];

/* ------------------------------------------------------------------ the document */

/** Which version of the document: the one released to Production (release 1), or the working version that differs from it. */
export type NorthwindStage = 'release1' | 'working';

const MESSAGE = {
  standardRelease1: 'Please pay **{{calc.totalDue}}** by **{{custom.dueDate}}**, {{calc.daysUntilDue}} days from the date of this bill. You can pay online, by phone or by mail.',
  standard: 'Please pay **{{calc.totalDue}}** by **{{custom.dueDate}}**, {{calc.daysUntilDue}} days from the date of this bill. You can pay online, by phone, or by mail with the payment slip on the last page.',
};

export function buildNorthwind(stage: NorthwindStage = 'working', plan: HouseLinkPlan = HOUSE.linkPlan): Project {
  const b = new SampleBuilder(blankProject({ projectId: NORTHWIND_ID, title: 'Northwind Energy bill', issuerName: 'Northwind Energy', accent: NORTHWIND_ACCENT }));
  b.project = { ...b.project, issuer: { ...b.project.issuer, product: 'Home energy bill' } };
  b.run({ type: 'SET_CUSTOM_FIELDS', fields: NORTHWIND_FIELDS });
  b.run({ type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'custom.billDate' } });

  // Brand, glossary and house wording rules from the library (the same content the library holds at the linked version).
  const link = (itemId: HouseItemId) => {
    const item = HOUSE.items[itemId];
    const version = plan[itemId];
    return { item: { id: item.id, kind: item.kind, title: item.title }, version, content: houseContent(itemId, version) };
  };
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('brand-northwind') });
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('glossary-es') });
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('house-wording-rules') });

  // Lookup tables (the delivery rate bands come from the library) and the calculations that read them.
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('energy-rate-bands'), placement: undefined });
  b.run({ type: 'UPSERT_LOOKUP_TABLE', table: LATE_FEES });
  b.run({ type: 'UPSERT_LOOKUP_TABLE', table: SUPPLY_RATES });
  for (const field of NORTHWIND_CALCS) b.run({ type: 'UPSERT_CALCULATED_FIELD', field });

  // Page design: US Letter, a letterhead zone above the first page's flow, and a Last page template that keeps the
  // lower part of the last page clear for the tear-off payment slip.
  b.run({
    type: 'SET_PAGE_DESIGN',
    patch: {
      paper: 'US-Letter',
      pageTemplates: {
        first: { flowArea: { xPt: 40, yPt: 188, wPt: 532, hPt: 550 } },
        following: { flowArea: { xPt: 40, yPt: 84, wPt: 532, hPt: 654 } },
        last: { flowArea: { xPt: 40, yPt: 84, wPt: 532, hPt: 538 } },
      },
    },
  });
  b.run({ type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true });

  /* ---- letterhead (first page) and page furniture */
  const hdr = (span: number) => ({ area: 'header' as const, span });
  b.insert({ id: 'issuer-logo', type: 'image', name: 'Northwind Energy logo', image: { src: 'asset:northwind-mark', alt: 'Northwind Energy (fictional utility) logo', fit: 'contain' }, layout: fixed(40, 34, 176, 40, 'first', hdr(4)) });
  b.insert({ id: 'document-header', type: 'header-footer', name: 'Synthetic data notice', headerFooter: { role: 'document-header', text: 'SYNTHETIC DEMO DATA · Northwind Energy is fictional · Not a real bill', repeat: false }, layout: fixed(300, 44, 272, 20, 'first', hdr(8)) });
  b.insert(text('bill-title', 'Bill title', '# Your energy bill\nBill date {{custom.billDate}} · Account **{{custom.accountNumber}}**\nService address: {{calc.serviceAddress}}\nBilling period {{custom.periodStart}} to {{custom.periodEnd}} ({{calc.billingDays}} days)', fixed(40, 86, 318, 86, 'first', hdr(7))));
  b.insert(metric('amount-due', 'Total amount due', 'calc.totalDue', 'usd-cents', 'primary', fixed(380, 86, 192, 58, 'first', hdr(5))));
  b.insert({ id: 'due-date', type: 'bound-field', name: 'Payment due date', label: 'Please pay by', binding: 'custom.dueDate', formatter: 'date', nullPolicy: 'error', layout: fixed(380, 150, 192, 20, 'first', hdr(5)) });
  b.insert({ id: 'header-rule', type: 'shape', name: 'Header rule', decorative: true, shape: { kind: 'line', stroke: NORTHWIND_ACCENT, strokeWidthPt: 2 }, layout: fixed(40, 178, 532, 3, 'first', { area: 'header', span: 12, hidden: true }) });
  b.insert({ id: 'running-header', type: 'header-footer', name: 'Running header', headerFooter: { role: 'page-header', text: 'Northwind Energy bill · Account {{custom.accountNumber}} · {{customer.givenName}} {{customer.familyName}}', repeat: true }, layout: fixed(40, 36, 532, 26, 'following', { area: 'header', span: 12, hidden: true }) });
  b.insert({ id: 'page-footer', type: 'header-footer', name: 'Page footer', headerFooter: { role: 'page-footer', text: 'Northwind Energy (fictional) · Synthetic demonstration — not a real bill', repeat: true }, layout: fixed(40, 752, 532, 20, 'all', { area: 'footer', span: 12 }) });

  /* ---- the flow: greeting and the account summary */
  b.insert(text('greeting', 'Greeting', 'Hello {{customer.givenName}}, here is your Northwind Energy bill for {{calc.billingDays}} days of service.', flow({ spaceBeforePt: 0 })));
  b.insert(container('account-summary', 'Account summary', flow({ direction: 'row', keepTogether: true, spaceBeforePt: 8 }, { area: 'main', span: 12, direction: 'row' })));
  const cell = (span: number) => flow({ widthPct: 20, spaceBeforePt: 0 }, { area: 'main', span });
  b.insert(metric('previous-balance', 'Previous balance', 'custom.previousBalanceCents', 'usd-cents', 'secondary', cell(2)), 'account-summary');
  b.insert(metric('payments-received', '− Payments received', 'custom.paymentsCents', 'usd-cents', 'secondary', cell(2)), 'account-summary');
  b.insert(metric('current-charges', '+ Current charges', 'custom.currentChargesCents', 'usd-cents', 'secondary', cell(3)), 'account-summary');
  b.insert(metric('taxes-fees', '+ Taxes and fees', 'custom.taxesCents', 'usd-cents', 'secondary', cell(2)), 'account-summary');
  b.insert(metric('total-due', '= Total amount due', 'calc.totalDue', 'usd-cents', 'primary', cell(3)), 'account-summary');

  /* ---- payment message: one of five, chosen by rules */
  const versions = [
    { id: 'pay-standard', title: 'Paying your bill', text: stage === 'release1' ? MESSAGE.standardRelease1 : MESSAGE.standard, fallback: true },
    { id: 'pay-overdue', title: 'Your account is past due', text: 'We have not received payment of your previous balance. Please pay **{{calc.totalDue}}** by **{{custom.dueDate}}**. If we do not receive it by then, a late fee of **{{calc.lateFee}}** will be added to your next bill. If you are having trouble paying, call us at 1-800-555-0148 and we will work out a payment plan with you.' },
    { id: 'pay-plan', title: 'Your payment plan', text: 'You are on a payment plan. This month’s installment is **{{custom.planInstallmentCents}}**, due by **{{custom.dueDate}}**. The rest of your balance is spread over your remaining installments. Paying each installment on time keeps your plan in place.' },
    { id: 'pay-autopay', title: 'Automatic payment is on', text: 'You do not need to do anything. We will take **{{calc.totalDue}}** from your bank account on **{{custom.dueDate}}**. To pay a different amount, change it online at least three days before then.' },
    ...(stage === 'working' ? [{ id: 'pay-credit', title: 'Your account is in credit', text: 'You have a credit of **{{calc.creditAmount}}** on your account, so there is nothing to pay this month. We will use the credit for your next bill.' }] : []),
  ];
  b.message({ id: 'payment-message', name: 'Payment message', layout: flow({ spaceBeforePt: 12, keepTogether: true }) }, versions);
  b.rule({ id: 'R01', title: 'Overdue account: past-due message', mode: 'exclusive', priority: 400, exclusiveGroup: 'payment-message', when: eq('custom.paymentStatus', 'overdue'), then: { op: 'selectVariant', targetNodeId: 'payment-message', variantId: 'pay-overdue' } });
  if (stage === 'working') b.rule({ id: 'R02', title: 'Credit balance: nothing to pay', mode: 'exclusive', priority: 350, exclusiveGroup: 'payment-message', when: { op: 'lt', path: 'calc.totalDue', value: 0 }, then: { op: 'selectVariant', targetNodeId: 'payment-message', variantId: 'pay-credit' } });
  b.rule({ id: 'R03', title: 'Payment plan: installment message', mode: 'exclusive', priority: 300, exclusiveGroup: 'payment-message', when: eq('custom.paymentPlan', true), then: { op: 'selectVariant', targetNodeId: 'payment-message', variantId: 'pay-plan' } });
  b.rule({ id: 'R04', title: 'Automatic payment: no action needed', mode: 'exclusive', priority: 200, exclusiveGroup: 'payment-message', when: eq('custom.autopay', true), then: { op: 'selectVariant', targetNodeId: 'payment-message', variantId: 'pay-autopay' } });

  /* ---- the rate change: the old wording until the day it changes, the new wording from that day */
  b.insert({ id: 'rate-notice', type: 'conditional-region', name: 'Electricity rate notice', policy: 'exclusive', variantIds: [], variantConditions: {}, layout: flow({ spaceBeforePt: 10, keepTogether: true }) });
  const electric = isIn('custom.services', ['electric', 'dual']);
  b.run({ type: 'ADD_VARIANT', nodeId: 'rate-notice', variantId: 'rate-upcoming', title: 'Your electricity supply rate is changing', text: 'From December 1, 2026, the electricity supply rate changes from 7.85¢ to 8.42¢ per kWh, as approved by the Calder Bay Public Utility Commission (fictional). This bill uses the current rate of {{calc.supplyRate}}¢ per kWh; your next bill will use the new rate.', when: electric });
  b.run({ type: 'ADD_VARIANT', nodeId: 'rate-notice', variantId: 'rate-new', title: 'Your new electricity supply rate', text: 'Since December 1, 2026, the electricity supply rate is {{calc.supplyRate}}¢ per kWh (it was 7.85¢). The Calder Bay Public Utility Commission (fictional) approved the change. This bill uses the new rate.', when: electric });
  b.run({ type: 'SET_VARIANT_PERIOD', nodeId: 'rate-notice', variantId: 'rate-upcoming', period: { until: RATE_CHANGE_DAY } });
  b.run({ type: 'SET_VARIANT_PERIOD', nodeId: 'rate-notice', variantId: 'rate-new', period: { from: RATE_CHANGE_DAY } });

  /* ---- electricity and gas sections: shown by the services on the account */
  b.insert(container('electricity-section', 'Electricity', flow({ spaceBeforePt: 14 }), { visibleWhen: electric }));
  b.insert(text('electricity-heading', 'Electricity heading', '## Electricity', flow({ spaceBeforePt: 0, keepWithNext: true })), 'electricity-section');
  b.insert(container('electricity-row', 'Electricity use and chart', flow({ direction: 'row', spaceBeforePt: 4, keepTogether: true }, { area: 'main', span: 12, direction: 'row' })), 'electricity-section');
  b.insert(text('electricity-use', 'Electricity use', 'You used **{{calc.electricUsage}} kWh** in {{calc.billingDays}} days, an average of {{calc.avgDailyKwh}} kWh a day.\nYour delivery rate is {{calc.deliveryRate}}¢ per kWh, the rate for {{calc.deliveryBand}}, so electricity delivery costs {{calc.deliveryCharge}} this month. The supply rate is {{calc.supplyRate}}¢ per kWh.\nYour highest month in the past year was {{calc.peakMonthKwh}} kWh. Your next meter reading will be around {{calc.nextReadDate}}.', flow({ widthPct: 52, spaceBeforePt: 0 }, { area: 'main', span: 7 })), 'electricity-row');
  b.insert({ id: 'electricity-chart', type: 'chart', name: 'Electricity use chart', binding: 'custom.usageHistory', chart: { kind: 'bar', title: 'Electricity use, last 6 months (kWh)', groupBy: 'month', valueKey: 'kwh', limit: 6, palette: 'mono', order: 'data' }, layout: flow({ widthPct: 48, spaceBeforePt: 0 }, { area: 'main', span: 5 }) }, 'electricity-row');
  b.insert(text('electricity-compare', 'Compared with last year', 'In the same month last year you used {{custom.lastYearKwh}} kWh. Your use changed by {{calc.kwhChangePct}}%.', flow({ spaceBeforePt: 4 }), { visibleWhen: gt0('custom.lastYearKwh') }), 'electricity-section');

  b.insert(container('gas-section', 'Natural gas', flow({ spaceBeforePt: 14 }), { visibleWhen: isIn('custom.services', ['gas', 'dual']) }));
  b.insert(text('gas-heading', 'Gas heading', '## Natural gas', flow({ spaceBeforePt: 0, keepWithNext: true })), 'gas-section');
  b.insert(container('gas-row', 'Gas use and chart', flow({ direction: 'row', spaceBeforePt: 4, keepTogether: true }, { area: 'main', span: 12, direction: 'row' })), 'gas-section');
  b.insert(text('gas-use', 'Gas use', 'You used **{{calc.gasUsage}} therms** of natural gas in {{calc.billingDays}} days.\nIn the same month last year you used {{custom.lastYearTherms}} therms.\nGas delivery is 41.20¢ and gas supply 63.85¢ per therm.', flow({ widthPct: 52, spaceBeforePt: 0 }, { area: 'main', span: 7 })), 'gas-row');
  b.insert({ id: 'gas-chart', type: 'chart', name: 'Gas use chart', binding: 'custom.usageHistory', chart: { kind: 'bar', title: 'Gas use, last 6 months (therms)', groupBy: 'month', valueKey: 'therms', limit: 6, palette: 'mono', order: 'data' }, layout: flow({ widthPct: 48, spaceBeforePt: 0 }, { area: 'main', span: 5 }) }, 'gas-row');

  b.insert(text('dual-fuel-note', 'Dual-fuel saving', '**Dual-fuel saving.** Because you buy both electricity and gas from us, your gas customer charge is $2.00 lower every month.', flow({ spaceBeforePt: 10 }), { visibleWhen: eq('custom.services', 'dual') }));

  /* ---- usage messages */
  b.insert(text('estimated-read-note', 'Estimated reading explanation', '**About estimated readings.** We could not read {{calc.estimatedReads}} of your meters this time, so we estimated the reading from your past use and the weather. Estimated kilowatt-hours are corrected automatically at your next actual reading.', flow({ spaceBeforePt: 10, keepTogether: true }), { visibleWhen: gt0('calc.estimatedReads') }));
  b.insert({ id: 'high-usage', type: 'conditional-region', name: 'Higher use message', ruleDriven: true, policy: 'exclusive', variantIds: [], layout: flow({ spaceBeforePt: 10, keepTogether: true }) });
  b.run({ type: 'ADD_VARIANT', nodeId: 'high-usage', variantId: 'high-usage-tips', title: 'You used more electricity than last year', text: 'Your electricity use is {{calc.kwhChangePct}}% higher than in the same month last year. Heating and shorter days often raise use in winter. A free home energy check can help you find savings: call 1-800-555-0148 to book one.' });
  b.run({ type: 'UPDATE_NODE', nodeId: 'high-usage', patch: { fallbackVariantId: 'high-usage-tips' } });
  b.rule({ id: 'R05', title: 'Use up by a quarter or more on last year: show the higher-use message', mode: 'additive', priority: 100, when: gte('calc.kwhChangePct', 25), then: { op: 'showSection', targetNodeId: 'high-usage' } });

  /* ---- readings and charges */
  b.insert({
    id: 'meter-table', type: 'repeating-table', name: 'Meter readings', binding: 'custom.meters', caption: 'Meter readings', flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true,
    columns: [
      { key: 'fuel', label: 'Fuel', format: 'text' }, { key: 'meterNumber', label: 'Meter', format: 'text' },
      { key: 'previousRead', label: 'Previous', format: 'int', align: 'right' }, { key: 'currentRead', label: 'Current', format: 'int', align: 'right' },
      { key: 'readType', label: 'Read type', format: 'text' }, { key: 'usage', label: 'Usage', format: 'int', align: 'right' }, { key: 'unit', label: 'Unit', format: 'text' },
    ],
    layout: flow({ spaceBeforePt: 14 }),
  });
  b.insert({
    id: 'charges-table', type: 'repeating-table', name: 'Charges', binding: 'custom.charges', caption: 'Your charges this period', flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true,
    columns: [
      { key: 'fuel', label: 'Fuel', format: 'text' }, { key: 'description', label: 'Description', format: 'text' },
      { key: 'quantity', label: 'Quantity', format: 'int', align: 'right' }, { key: 'unit', label: 'Unit', format: 'text' },
      { key: 'rate', label: 'Rate', format: 'text', align: 'right' }, { key: 'amountCents', label: 'Amount', format: 'usd-cents', align: 'right', total: true },
    ],
    layout: flow({ spaceBeforePt: 14 }),
  });

  /* ---- winter help (in effect for the heating season only) and paying */
  b.insert(text('winter-help', 'Winter heating help', '## Help with winter heating bills\nFrom November through March, households that qualify can get help with heating costs from the Calder Bay Home Energy Assistance Program (fictional). Call 1-800-555-0142 or visit example.com/northwind/help to apply. Applying does not affect your service.', flow({ spaceBeforePt: 14, keepTogether: true }), { visibleWhen: isIn('custom.services', ['gas', 'dual']) }));
  b.run({ type: 'SET_SECTION_PERIOD', nodeId: 'winter-help', period: { ...WINTER } });
  b.insert(container('pay-actions', 'Ways to pay', flow({ direction: 'row', spaceBeforePt: 14, keepTogether: true }, { area: 'main', span: 12, direction: 'row' })));
  b.insert({ id: 'pay-online', type: 'action-link', name: 'Pay online', action: { label: 'Pay your bill online', url: 'https://example.com/northwind/pay', fallbackText: 'Pay online at example.com/northwind/pay, by phone at 1-800-555-0148, or by mail with the payment slip.' }, layout: flow({ widthPct: 72, spaceBeforePt: 0 }, { area: 'main', span: 9 }) }, 'pay-actions');
  b.insert({ id: 'pay-qr', type: 'qr-code', name: 'Pay online QR code', qr: { url: 'https://example.com/northwind/pay', caption: 'Scan to pay online' }, layout: flow({ widthPct: 28, spaceBeforePt: 0, align: 'right' }, { area: 'main', span: 3 }) }, 'pay-actions');

  /* ---- notices: the required customer-rights notice (house library wording) and the shared accessible-formats panel */
  b.notice({ id: 'rights-notice', name: 'Your rights as a customer', required: true, layout: flow({ spaceBeforePt: 14, keepTogether: true }, { area: 'footer', span: 12 }) }, 'Your rights as a customer', 'Placeholder until linked.');
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('customer-rights-notice'), placement: { partId: 'rights-notice' } });
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('accessible-formats-panel'), placement: { parentId: b.project.rootNodeId } });

  /* ---- the tear-off payment slip: fixed items on the Last page template */
  const slip = (id: string, name: string, x: number, y: number, w: number, h: number, markup: string) => b.insert(text(id, name, markup, fixed(x, y, w, h, 'last', { area: 'footer', span: 12, hidden: true })));
  slip('slip-cut', 'Payment slip: detach line', 40, 628, 532, 14, '*Please detach and return this portion with your payment.*');
  b.insert({ id: 'slip-rule', type: 'shape', name: 'Payment slip: tear-off line', decorative: true, shape: { kind: 'line', stroke: '#64748B', strokeWidthPt: 1 }, layout: fixed(40, 644, 532, 2, 'last', { area: 'footer', span: 12, hidden: true }) });
  b.insert({ id: 'slip-logo', type: 'image', name: 'Payment slip: logo', image: { src: 'asset:northwind-mark', alt: 'Northwind Energy (fictional utility) logo', fit: 'contain' }, layout: fixed(40, 654, 140, 30, 'last', { area: 'footer', span: 12, hidden: true }) });
  slip('slip-remit', 'Payment slip: where to send it', 40, 690, 284, 56, '**Make checks payable to Northwind Energy**\nPayment Center (fictional), PO Box 2041, Calder Bay, MI 49012');
  slip('slip-account', 'Payment slip: account and amount', 330, 652, 242, 96, '**Payment slip** · Account **{{custom.accountNumber}}**\n{{customer.givenName}} {{customer.familyName}}\nAmount due **{{calc.totalDue}}** by {{custom.dueDate}}\nAmount enclosed: $ ______________');

  /* ---- email and SMS wording, with calculated values */
  const ch = channelConfig(b.project);
  b.run({
    type: 'SET_CHANNELS',
    channels: {
      email: { ...ch.email, subject: 'Your Northwind Energy bill of {{custom.billDate}} is ready', preheader: 'Your bill for {{calc.billingDays}} days of service is ready. {{keyFacts}}', title: 'Your energy bill is ready', intro: 'Hello {{customer.givenName}}, your bill for account {{custom.accountNumber}} is ready to view.', closing: 'Thank you for being a Northwind Energy customer.', keyFactsHeading: 'Your bill at a glance' },
      sms: { text: 'DEMO Northwind Energy: Your bill is ready. Account balance {{calc.totalDue}}, due {{custom.dueDate}}. View and pay: {{link}}' },
    },
  });

  /* ---- Spanish: every text approved except a deliberate handful left as drafts */
  b.run({ type: 'ADD_LANGUAGE', locale: 'es-US' });
  const es = NORTHWIND_ES(stage);
  b.translate('es-US', es, NORTHWIND_ES_DRAFT_ONLY);

  /* ---- journeys, pinned tests, the document's own wording rules and the mappings */
  b.run({
    type: 'SET_JOURNEY',
    events: [
      { eventId: 'nw-due-missed', eventType: 'payment.missed', day: 22, label: 'Due date passed without payment', payload: {}, preconditions: [{ path: 'custom.paymentStatus', op: 'eq', value: 'current' }], effects: [{ op: 'set', path: 'custom.paymentStatus', value: 'overdue' }], emits: 'new-communication-preview' },
      { eventId: 'nw-plan-agreed', eventType: 'payment.plan', day: 30, label: 'Payment plan agreed', payload: {}, preconditions: [{ path: 'custom.paymentStatus', op: 'eq', value: 'overdue' }], effects: [{ op: 'set', path: 'custom.paymentPlan', value: true }, { op: 'set', path: 'custom.paymentStatus', value: 'current' }], emits: 'new-communication-preview' },
      { eventId: 'nw-autopay-on', eventType: 'autopay.enrolled', day: 45, label: 'Automatic payment set up', payload: {}, effects: [{ op: 'set', path: 'custom.autopay', value: true }], emits: 'immutable-issued-snapshot' },
    ],
  });
  for (const t of northwindTests(stage)) b.run({ type: 'UPSERT_TEST_CASE', testCase: t });
  b.run({ type: 'ADD_WORDING_RULE', rule: { id: 'nw-say-kwh', kind: 'preferred', severity: 'should', phrase: 'kilowatt-hours', replacement: 'kWh', appliesTo: 'anywhere', language: 'en-US', note: 'Our bills say kWh, as the meter does.' } });
  b.run({ type: 'ADD_WORDING_RULE', rule: { id: 'nw-no-disconnect-threat', kind: 'banned', severity: 'must', phrase: 'will be disconnected', appliesTo: 'messages', note: 'A bill never threatens disconnection; that is a separate, regulated notice.' } });
  mappings(b);

  return { ...b.project, modelVersion: 1 };
}

const gt0 = (path: string) => ({ op: 'gt' as const, path, value: 0 });

/* ------------------------------------------------------------------ pinned tests */

export function northwindTests(stage: NorthwindStage): TestCase[] {
  const T = (id: string, name: string, recordId: string, expect: TestCase['expect'], issueDate?: string): TestCase => ({ id, name, recordId, expect, ...(issueDate ? { issueDate } : {}) });
  return [
    T('T1', 'Standard bill, electricity only', 'NWE-60001', { selectedVariants: { 'payment-message': 'pay-standard' }, visibleNodeIds: ['electricity-section'], hiddenNodeIds: ['gas-section', 'dual-fuel-note'], noBlocking: true }),
    T('T2', 'Overdue account gets the past-due message', 'NWE-60005', { selectedVariants: { 'payment-message': 'pay-overdue' }, noBlocking: true }),
    T('T3', 'Spanish-speaking customer gets the approved Spanish bill', 'NWE-60003', { approvedLocale: 'es-US', noBlocking: true }),
    T('T4', 'Gas only: no electricity section, winter help shown', 'NWE-60002', { visibleNodeIds: ['gas-section', 'winter-help'], hiddenNodeIds: ['electricity-section', 'rate-notice'], noBlocking: true }),
    T('T5', 'As issued the day before the rate change: the upcoming-rate notice', 'NWE-60011', { selectedVariants: { 'rate-notice': 'rate-upcoming' }, noBlocking: true }, '2026-11-30'),
    T('T6', 'As issued on the day of the rate change: the new-rate notice', 'NWE-60012', { selectedVariants: { 'rate-notice': 'rate-new' }, noBlocking: true }, RATE_CHANGE_DAY),
    T('T7', 'Estimated reading explained, higher use flagged', 'NWE-60008', { visibleNodeIds: ['estimated-read-note', 'high-usage'], noBlocking: true }),
    ...(stage === 'working' ? [T('T8', 'Credit balance: nothing to pay', 'NWE-60016', { selectedVariants: { 'payment-message': 'pay-credit' }, noBlocking: true })] : []),
  ];
}

/* ------------------------------------------------------------------ mappings */

const STAMP = { by: 'Sample author', at: '2026-11-02T09:00:00.000Z' };
function mappings(b: SampleBuilder): void {
  b.run({ type: 'ADD_MAPPING', mapping: { id: 'print-house', name: 'Mapping for the print house', system: 'Calder Print & Mail (fictional)', description: 'The fields the print house receives in its nightly bill file.' }, stamp: STAMP });
  const target: Record<string, [string, string, string?]> = {
    'custom.accountNumber': ['ACCT_NO', 'CHAR(13)'], 'custom.billDate': ['BILL_DT', 'DATE', 'MM/DD/YYYY'], 'custom.periodStart': ['PER_START', 'DATE', 'MM/DD/YYYY'], 'custom.periodEnd': ['PER_END', 'DATE', 'MM/DD/YYYY'],
    'custom.dueDate': ['DUE_DT', 'DATE', 'MM/DD/YYYY'], 'custom.serviceStreet': ['SVC_ADDR1', 'VARCHAR(60)'], 'custom.serviceCity': ['SVC_CITY', 'VARCHAR(40)'], 'custom.serviceState': ['SVC_ST', 'CHAR(2)'], 'custom.serviceZip': ['SVC_ZIP', 'CHAR(10)'],
    'custom.services': ['SVC_TYPE', 'CHAR(1)', 'E, G or D'], 'custom.plan': ['RATE_PLAN', 'VARCHAR(12)'], 'custom.paymentStatus': ['PAY_STAT', 'CHAR(1)', 'C or O'], 'custom.paymentPlan': ['PLAN_FLAG', 'CHAR(1)', 'Y or N'], 'custom.autopay': ['AUTOPAY_FLAG', 'CHAR(1)', 'Y or N'],
    'custom.planInstallmentCents': ['PLAN_AMT', 'DECIMAL(9,2)', 'divide by 100'], 'custom.previousBalanceCents': ['PREV_BAL', 'DECIMAL(11,2)', 'divide by 100'], 'custom.paymentsCents': ['PMTS', 'DECIMAL(11,2)', 'divide by 100'],
    'custom.currentChargesCents': ['CUR_CHG', 'DECIMAL(11,2)', 'divide by 100'], 'custom.taxesCents': ['TAX_FEES', 'DECIMAL(9,2)', 'divide by 100'], 'custom.lastYearKwh': ['LY_KWH', 'INTEGER'], 'custom.lastYearTherms': ['LY_THERM', 'INTEGER'],
    'custom.meters': ['METER_REC', 'REPEATING GROUP'], 'custom.meters[].fuel': ['MTR_FUEL', 'CHAR(1)', 'E or G'], 'custom.meters[].meterNumber': ['MTR_NO', 'CHAR(10)'], 'custom.meters[].previousRead': ['MTR_PREV', 'INTEGER'], 'custom.meters[].currentRead': ['MTR_CURR', 'INTEGER'],
    'custom.meters[].readType': ['MTR_RD_TYPE', 'CHAR(1)', 'A or E'], 'custom.meters[].usage': ['MTR_USE', 'INTEGER'], 'custom.meters[].unit': ['MTR_UOM', 'CHAR(6)'],
    'custom.charges': ['CHG_REC', 'REPEATING GROUP'], 'custom.charges[].fuel': ['CHG_FUEL', 'CHAR(1)', 'E or G'], 'custom.charges[].description': ['CHG_DESC', 'VARCHAR(50)'], 'custom.charges[].quantity': ['CHG_QTY', 'INTEGER'], 'custom.charges[].unit': ['CHG_UOM', 'CHAR(6)'],
    'custom.charges[].rate': ['CHG_RATE_TXT', 'VARCHAR(16)'], 'custom.charges[].rateTenThousandths': ['CHG_RATE', 'DECIMAL(9,4)', 'divide by 10,000'], 'custom.charges[].amountCents': ['CHG_AMT', 'DECIMAL(11,2)', 'divide by 100'],
    'custom.usageHistory': ['HIST_REC', 'REPEATING GROUP'], 'custom.usageHistory[].month': ['HIST_MO', 'CHAR(5)', 'MM/YY'], 'custom.usageHistory[].kwh': ['HIST_KWH', 'INTEGER'], 'custom.usageHistory[].therms': ['HIST_THERM', 'INTEGER'],
  };
  b.run({ type: 'SET_MAPPING_ENTRIES', mappingId: 'print-house', stamp: STAMP, entries: Object.entries(target).map(([path, [t, type, format]]) => ({ path, target: t, targetType: type, ...(format ? { format } : {}) })) });
  // The customer portal mapping is deliberately half done: it shows what an incomplete mapping looks like.
  b.run({ type: 'ADD_MAPPING', mapping: { id: 'customer-portal', name: 'Mapping for the customer portal', system: 'Northwind customer portal (fictional)', description: 'Started: the portal team has mapped the account fields so far.' }, stamp: STAMP });
  b.run({ type: 'SET_MAPPING_ENTRIES', mappingId: 'customer-portal', stamp: STAMP, entries: [
    { path: 'custom.accountNumber', target: 'account.id', targetType: 'string' },
    { path: 'custom.billDate', target: 'bill.issuedOn', targetType: 'date' },
    { path: 'custom.dueDate', target: 'bill.dueOn', targetType: 'date' },
    { path: 'custom.previousBalanceCents', target: 'bill.previousBalance', targetType: 'number', format: 'divide by 100' },
    { path: 'custom.paymentsCents', target: 'bill.payments', targetType: 'number', format: 'divide by 100' },
    { path: 'custom.lastYearTherms', notNeeded: { reason: 'The portal shows its own usage history.' } },
  ] });
}

/* ------------------------------------------------------------------ customers */

interface NwSpec {
  given: string; family: string; es?: boolean; services: 'electric' | 'gas' | 'dual'; plan: 'standard' | 'time-of-use' | 'budget';
  billDate: string; overdue?: boolean; paymentPlan?: boolean; autopay?: boolean;
  kwh?: number; therms?: number; lastYearKwh?: number; lastYearTherms?: number;
  estimated?: 'electric' | 'gas'; previous?: number; paid?: number; credit?: number;
  extraMeters?: { electric: number; gas: number };
  street: string; city?: string; zip?: string;
  /** Deliberate data problems (each listed in the sample's notes). */
  noCurrentCharges?: boolean; noDueDate?: boolean;
}

const MONTHS = (end: string) => {
  const [y, m] = end.split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => { const k = m - 11 + i; const yy = y + Math.floor((k - 1) / 12); const mm = ((k - 1) % 12 + 12) % 12 + 1; return `${String(mm).padStart(2, '0')}/${String(yy).slice(2)}`; });
};
const SEASON_KWH = [0.92, 0.84, 0.86, 0.78, 0.83, 1.02, 1.21, 1.18, 0.97, 0.88, 0.95, 1.0];
const SEASON_THERMS = [1.0, 1.12, 0.82, 0.55, 0.31, 0.18, 0.12, 0.12, 0.2, 0.44, 0.78, 1.0];

const SPECS: NwSpec[] = [
  { given: 'Avery', family: 'Lindqvist', services: 'electric', plan: 'standard', billDate: '2026-11-14', kwh: 612, lastYearKwh: 588, previous: 9418, paid: 9418, street: '118 Alder Row' },
  { given: 'Malik', family: 'Osei', services: 'gas', plan: 'budget', billDate: '2026-11-14', therms: 74, lastYearTherms: 69, previous: 6830, paid: 6830, street: '27 Birchwood Court' },
  { given: 'Lucía', family: 'Herrera', es: true, services: 'dual', plan: 'standard', billDate: '2026-11-14', kwh: 540, therms: 61, lastYearKwh: 566, lastYearTherms: 58, previous: 14250, paid: 14250, street: '903 Juniper Lane' },
  { given: 'Hannah', family: 'Brightwater', services: 'dual', plan: 'time-of-use', billDate: '2026-11-15', kwh: 830, therms: 88, lastYearKwh: 790, lastYearTherms: 84, previous: 17322, paid: 17322, autopay: true, street: '44 Quarry Hill Road' },
  { given: 'Devon', family: 'Achterberg', services: 'electric', plan: 'standard', billDate: '2026-11-16', kwh: 455, lastYearKwh: 470, previous: 7140, paid: 0, overdue: true, street: '5 Fenwick Street' },
  { given: 'Rosa', family: 'Quintero', es: true, services: 'gas', plan: 'standard', billDate: '2026-11-16', therms: 66, lastYearTherms: 70, previous: 6122, paid: 0, overdue: true, street: '61 Larkspur Avenue', city: 'Port Elling', zip: '49031' },
  { given: 'Theo', family: 'Marchetti', services: 'dual', plan: 'budget', billDate: '2026-11-17', kwh: 702, therms: 95, lastYearKwh: 650, lastYearTherms: 90, previous: 31840, paid: 12000, paymentPlan: true, street: '310 Orchard Bend' },
  { given: 'Imani', family: 'Rutherford', services: 'electric', plan: 'time-of-use', billDate: '2026-11-17', kwh: 1180, lastYearKwh: 860, estimated: 'electric', previous: 11980, paid: 11980, street: '72 Canal Street', city: 'Port Elling', zip: '49031' },
  { given: 'Joaquín', family: 'Salazar', es: true, services: 'dual', plan: 'standard', billDate: '2026-11-18', kwh: 920, therms: 104, lastYearKwh: 700, lastYearTherms: 97, estimated: 'gas', previous: 18890, paid: 18890, street: '15 Mill Pond Drive' },
  { given: 'Priya', family: 'Venkataraman', services: 'dual', plan: 'standard', billDate: '2026-11-18', kwh: 488, therms: 52, lastYearKwh: 512, lastYearTherms: 55, previous: 12011, paid: 12011, autopay: true, street: '208 Heron Way' },
  { given: 'Oliver', family: 'Nakamura-Reyes', services: 'electric', plan: 'standard', billDate: '2026-11-30', kwh: 640, lastYearKwh: 621, previous: 9876, paid: 9876, street: '19 Lantern Close' },
  { given: 'Camila', family: 'Ferreira', es: true, services: 'dual', plan: 'time-of-use', billDate: RATE_CHANGE_DAY, kwh: 705, therms: 83, lastYearKwh: 690, lastYearTherms: 80, previous: 15530, paid: 15530, street: '77 Saltmarsh Road' },
  { given: 'Grace', family: 'Okonkwo', services: 'electric', plan: 'budget', billDate: '2026-10-20', kwh: 380, lastYearKwh: 395, previous: 6455, paid: 6455, autopay: true, street: '3 Weatherby Place' },
  { given: 'Samuel', family: 'Kowalczyk', services: 'gas', plan: 'standard', billDate: '2026-10-22', therms: 38, lastYearTherms: 41, previous: 3310, paid: 3310, street: '940 Tamarack Trail' },
  { given: 'Elena', family: 'Vasquez-Moore', es: true, services: 'electric', plan: 'standard', billDate: '2026-11-19', kwh: 0, lastYearKwh: 210, previous: 2210, paid: 2210, street: '12 Dune Grass Lane', city: 'Port Elling', zip: '49031' },
  { given: 'Felix', family: 'Abernathy', services: 'dual', plan: 'standard', billDate: '2026-11-19', kwh: 260, therms: 22, lastYearKwh: 410, lastYearTherms: 40, previous: 4500, paid: 15000, credit: 1, street: '66 Gull Point' },
  { given: 'Mariana', family: 'Delgado', es: true, services: 'electric', plan: 'budget', billDate: '2026-11-20', kwh: 300, lastYearKwh: 330, previous: 5200, paid: 12000, credit: 1, street: '450 Cedar Hollow' },
  { given: 'Ravi', family: 'Chaudhry', services: 'electric', plan: 'standard', billDate: '2026-11-20', kwh: 715, lastYearKwh: 0, previous: 0, paid: 0, street: '88 Foundry Lane' },
  { given: 'Beatrix', family: 'Hollowell', services: 'dual', plan: 'standard', billDate: '2026-11-21', kwh: 1920, therms: 310, lastYearKwh: 1850, lastYearTherms: 298, previous: 88320, paid: 88320, extraMeters: { electric: 12, gas: 5 }, street: '1200 Harbor Lane Apartments' },
  { given: 'Nikolai', family: 'Petrovsky', services: 'gas', plan: 'budget', billDate: '2026-11-21', therms: 58, lastYearTherms: 61, previous: 9120, paid: 3000, paymentPlan: true, street: '29 Steeple Street' },
  { given: 'Ana', family: 'Morales', es: true, services: 'dual', plan: 'budget', billDate: '2026-11-22', kwh: 610, therms: 72, lastYearKwh: 590, lastYearTherms: 70, previous: 26510, paid: 10000, paymentPlan: true, street: '17 Willow Spring Road' },
  { given: 'Gideon', family: 'Fairweather', services: 'dual', plan: 'time-of-use', billDate: '2026-11-22', kwh: 1010, therms: 120, lastYearKwh: 790, lastYearTherms: 101, previous: 21004, paid: 0, overdue: true, street: '351 Bellwether Drive' },
  { given: 'Yusuf', family: 'Haddad', services: 'electric', plan: 'time-of-use', billDate: '2026-11-23', kwh: 980, lastYearKwh: 920, previous: 14420, paid: 14420, autopay: true, street: '7 Signal Hill' },
  { given: 'Carmen', family: 'Ibarra', es: true, services: 'gas', plan: 'standard', billDate: '2026-11-23', therms: 81, lastYearTherms: 77, previous: 7020, paid: 7020, autopay: true, street: '602 Pinecrest Avenue' },
  { given: 'Winston', family: 'Mbeki-Clarke', services: 'dual', plan: 'standard', billDate: '2026-11-24', kwh: 575, therms: 68, lastYearKwh: 600, lastYearTherms: 66, previous: 13360, paid: 13360, street: '14 Ferry Landing' },
  { given: 'Siobhan', family: 'Gallagher', services: 'electric', plan: 'standard', billDate: '2026-11-24', kwh: 499, lastYearKwh: 505, previous: 8120, paid: 8120, street: '230 Rookery Road' },
  { given: 'Tomás', family: 'Ortega', es: true, services: 'electric', plan: 'time-of-use', billDate: '2026-11-25', kwh: 1000, lastYearKwh: 760, previous: 13300, paid: 13300, street: '9 Ironbridge Walk', city: 'Port Elling', zip: '49031' },
  { given: 'Hiroko', family: 'Tanabe', services: 'dual', plan: 'budget', billDate: '2026-11-25', kwh: 433, therms: 49, lastYearKwh: 450, lastYearTherms: 51, previous: 11270, paid: 11270, autopay: true, estimated: 'electric', street: '41 Copper Beech Lane' },
  { given: 'Marcus', family: 'Delacroix', services: 'gas', plan: 'time-of-use', billDate: '2026-11-26', therms: 112, lastYearTherms: 108, previous: 10850, paid: 10850, street: '18 Keel Street' },
  { given: 'Abigail', family: 'Strand', services: 'dual', plan: 'standard', billDate: '2026-12-02', kwh: 760, therms: 99, lastYearKwh: 744, lastYearTherms: 96, previous: 17110, paid: 17110, street: '505 Lighthouse Road' },
  { given: 'Esteban', family: 'Navarro', es: true, services: 'dual', plan: 'standard', billDate: '2026-12-03', kwh: 820, therms: 101, lastYearKwh: 805, lastYearTherms: 99, previous: 0, paid: 0, overdue: false, street: '36 Marigold Terrace' },
  { given: 'Fiona', family: 'Blackwood', services: 'electric', plan: 'standard', billDate: '2026-12-04', kwh: 690, lastYearKwh: 520, previous: 10340, paid: 0, overdue: true, street: '700 Northgate Boulevard' },
  { given: 'Arjun', family: 'Mehta', services: 'dual', plan: 'time-of-use', billDate: '2026-11-27', kwh: 655, therms: 78, lastYearKwh: 640, lastYearTherms: 75, previous: 15020, paid: 15020, noCurrentCharges: true, street: '82 Glasshouse Row' },
  { given: 'Nadia', family: 'Sorensen', services: 'electric', plan: 'budget', billDate: '2026-11-27', kwh: 520, lastYearKwh: 530, previous: 8210, paid: 8210, autopay: true, noDueDate: true, street: '21 Ashgrove Mews' },
];

/** Every charge line, worked out from the usage and the rates, so the lines, the totals and the calculations agree to the cent. */
function chargesFor(s: NwSpec, kwh: number, therms: number, meters: Array<{ fuel: string; meterNumber: string }>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  // Energy rates to a hundredth of a cent; fixed monthly charges to the cent.
  const rate = (u: number, per: string) => per ? `$${(u / 10000).toFixed(4)} per ${per}` : `${u < 0 ? '−' : ''}$${(Math.abs(u) / 10000).toFixed(2)} a month`;
  const line = (fuel: string, description: string, quantity: number, unit: string, r: number, per: string) => rows.push({ fuel, description, quantity, unit, rate: rate(r, per), rateTenThousandths: r, amountCents: centsAt(quantity, r) });
  const elec = meters.filter((m) => m.fuel === 'Electricity');
  const gas = meters.filter((m) => m.fuel === 'Gas');
  for (const m of elec) line('Electricity', elec.length > 1 ? `Customer charge, meter ${m.meterNumber}` : 'Customer charge', 1, 'month', NW_RATES.electricCustomer, '');
  if (elec.length) {
    line('Electricity', `Delivery (${kwh < 500 ? 'up to 500 kWh' : kwh < 1000 ? '500 to 999 kWh' : '1,000 kWh and over'})`, kwh, 'kWh', NW_RATES.delivery(kwh), 'kWh');
    line('Electricity', 'Supply', kwh, 'kWh', NW_RATES.supply(s.billDate), 'kWh');
    line('Electricity', 'Public purpose programs', kwh, 'kWh', NW_RATES.publicPurpose, 'kWh');
  }
  for (const m of gas) line('Gas', gas.length > 1 ? `Customer charge, meter ${m.meterNumber}` : 'Customer charge', 1, 'month', NW_RATES.gasCustomer, '');
  if (gas.length) {
    line('Gas', 'Delivery', therms, 'therms', NW_RATES.gasDelivery, 'therm');
    line('Gas', 'Supply', therms, 'therms', NW_RATES.gasSupply, 'therm');
  }
  if (s.services === 'dual') line('Gas', 'Dual-fuel saving', 1, 'month', NW_RATES.dualDiscount, '');
  return rows;
}

/** The synthetic customers of the Northwind bill. Ids are stable (`NWE-60001` …) and the data is consistent to the cent. */
export function northwindCustomers(): SampleCustomer[] {
  return SPECS.map((s, i) => {
    const recordId = `NWE-${60001 + i}`;
    const periodEnd = addDays(s.billDate, -5);
    const periodStart = addDays(periodEnd, -(28 + (i % 5)));
    const kwh = s.services === 'gas' ? 0 : s.kwh ?? 0;
    const therms = s.services === 'electric' ? 0 : s.therms ?? 0;
    const meters: Array<Record<string, unknown>> = [];
    const meterNo = (fuel: 'E' | 'G', k: number) => `${fuel}-${String(41000 + (i * 37 + k * 11) % 9000).padStart(5, '0')}`;
    const addMeters = (fuel: 'Electricity' | 'Gas', total: number, count: number, unit: string, base: number) => {
      // Split the usage over the meters; the last meter takes the remainder so the sum is exact.
      let left = total;
      for (let k = 0; k < count; k++) {
        const share = Math.floor(total / count);
        const use = k === count - 1 ? left : Math.max(0, share + ((k * 37) % 23) - 11);
        left -= use;
        const prev = base + k * 1371 + i * 97;
        const estimated = s.estimated === (fuel === 'Electricity' ? 'electric' : 'gas') && k === 0;
        meters.push({ fuel, meterNumber: meterNo(fuel === 'Electricity' ? 'E' : 'G', k), previousRead: prev, currentRead: prev + use, readType: estimated ? 'estimated' : 'actual', usage: use, unit });
      }
    };
    if (s.services !== 'gas') addMeters('Electricity', kwh, 1 + (s.extraMeters?.electric ?? 0), 'kWh', 24000);
    if (s.services !== 'electric') addMeters('Gas', therms, 1 + (s.extraMeters?.gas ?? 0), 'therms', 3100);
    const charges = chargesFor(s, kwh, therms, meters as Array<{ fuel: string; meterNumber: string }>);
    const current = charges.reduce((t, c) => t + (c.amountCents as number), 0);
    const taxes = roundHalfUp((current * NW_RATES.taxBps) / 10000, 0);
    const previous = s.previous ?? 0;
    const paid = s.paid ?? 0;
    const lyK = s.services === 'gas' ? 0 : s.lastYearKwh ?? 0;
    const lyT = s.services === 'electric' ? 0 : s.lastYearTherms ?? 0;
    const months = MONTHS(periodEnd.slice(0, 7) + '-01');
    const usageHistory = months.map((month, k) => ({
      month,
      kwh: k === 11 ? kwh : s.services === 'gas' ? 0 : Math.round(Math.max(lyK, kwh, 300) * SEASON_KWH[k]),
      therms: k === 11 ? therms : s.services === 'electric' ? 0 : Math.round(Math.max(lyT, therms, 30) * SEASON_THERMS[k]),
    }));
    const totalDue = previous - paid + current + taxes;
    const custom: Record<string, unknown> = {
      accountNumber: `${4400 + i * 3}-${String(2290 + i * 41).padStart(4, '0')}-${String(300 + i * 7).padStart(3, '0')}`,
      billDate: s.billDate, periodStart, periodEnd, dueDate: addDays(s.billDate, 21),
      serviceStreet: s.street, serviceCity: s.city ?? 'Calder Bay', serviceState: 'MI', serviceZip: s.zip ?? '49012',
      services: s.services, plan: s.plan, paymentStatus: s.overdue ? 'overdue' : 'current', paymentPlan: !!s.paymentPlan, autopay: !!s.autopay,
      ...(s.paymentPlan ? { planInstallmentCents: roundHalfUp(totalDue / 6, 0) } : {}),
      previousBalanceCents: previous, paymentsCents: paid, currentChargesCents: current, taxesCents: taxes,
      lastYearKwh: lyK, lastYearTherms: lyT,
      meters, charges, usageHistory,
    };
    if (s.noCurrentCharges) delete custom.currentChargesCents;
    if (s.noDueDate) delete custom.dueDate;
    return {
      recordId, documentType: 'custom', projectId: NORTHWIND_ID,
      customer: { givenName: s.given, familyName: s.family, locale: s.es ? 'es-US' : 'en-US' },
      custom,
    } as SampleCustomer;
  });
}

/** What is deliberate about this example, for the accuracy check and the people who open it. */
export const NORTHWIND_NOTES_BASE: Omit<SampleNotes, 'translations'> = {
  title: 'Northwind Energy',
  kind: 'Utility bill (dual fuel)',
  description: 'A dual-fuel electricity and gas bill: sections by service, meter readings, tiered rates, a usage chart, a dated rate change and a tear-off payment slip.',
  intendedBlockers: [
    { recordId: 'NWE-60033', code: 'CALCULATION_MISSING', path: 'calc.totalDue', reason: 'Demonstration: this customer’s data does not reconcile — the current charges total is missing although charge lines exist, so the total due cannot be worked out and the credit-balance rule cannot decide.' },
    { recordId: 'NWE-60017', code: 'REQUIRED_TRANSLATION_MISSING', path: 'pay-credit', reason: 'Demonstration: the credit-balance message added in the working version has only a draft Spanish text, and this Spanish-speaking customer is in credit.' },
  ],
  knownDataProblems: [
    { recordId: 'NWE-60034', code: 'NULL_BINDING', nodeId: 'due-date', reason: 'Accounts moving to budget billing get their due date from the billing system after the cycle closes; billing operations confirmed this customer pays by automatic payment, so the bill can go out without a printed due date.' },
  ],
  intendedShould: [{ ruleId: 'nw-say-kwh', reason: 'Demonstration of a “should” wording rule: the estimated-reading explanation says “kilowatt-hours” once.' }],
  unusedFields: [{ path: 'custom.charges[].rateTenThousandths', reason: 'Carried for the print house and the accuracy check; the bill shows the rate as text.' }],
  missingCalcs: [
    { recordId: 'NWE-60033', key: 'totalDue', reason: 'The deliberate non-reconciling customer (no current charges total).' },
    { recordId: 'NWE-60033', key: 'creditAmount', reason: 'Worked out from the missing total due.' },
    { recordId: 'NWE-60034', key: 'daysUntilDue', reason: 'The known data problem: no due date.' },
  ],
  mappings: { 'print-house': 'complete', 'customer-portal': 'incomplete' },
  pages: { 'NWE-60019': 3 },
};
