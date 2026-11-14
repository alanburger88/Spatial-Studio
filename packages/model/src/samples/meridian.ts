import { blankProject } from '../templates';
import { channelConfig } from '../channels';
import { roundHalfUp } from '../expressions';
import type { CalculatedField, CustomField, LookupTable, Project, TestCase } from '../types';
import { SampleBuilder, addDays, container, eq, fixed, flow, isIn, metric, text, type SampleCustomer } from './kit';
import { HOUSE, houseContent, type HouseItemId } from './houseLibrary';
import { MERIDIAN_ES, MERIDIAN_ES_DRAFT_ONLY } from './meridianSpanish';
import type { SampleNotes } from './notes';

/**
 * Meridian Wealth (fictional): a quarterly portfolio statement for the United States. Account summary, holdings by asset
 * class with an allocation chart, transactions in the period, income and fees, performance against the previous
 * quarter, and risk and tax notices. Customers range from a single fund to forty holdings across two pages; messages
 * vary by risk profile, by a large fall in value, and by a fee change that takes effect on a date. Built from the blank
 * project through the command bus. All names, funds, codes, companies, people and numbers are invented.
 */

export const MERIDIAN_ID = 'meridian-wealth-demo';
export const MERIDIAN_ACCENT = '#1F2A44';
export const FEE_CHANGE_DAY = '2026-12-01';
export const Q3 = { start: '2026-07-01', end: '2026-09-30' } as const;
export const Q4 = { start: '2026-10-01', end: '2026-12-31' } as const;

/* ------------------------------------------------------------------ data fields */

export const MERIDIAN_FIELDS: CustomField[] = [
  { key: 'accountNumber', label: 'Account number', type: 'string', required: true, example: 'MW-208-44173' },
  { key: 'accountType', label: 'Account type', type: 'enum', enumValues: ['individual', 'joint', 'ira', 'trust'], required: true, dimension: true },
  { key: 'adviserName', label: 'Adviser name', type: 'string', example: 'Dana Whitlock' },
  { key: 'adviserPhone', label: 'Adviser phone', type: 'string', example: '1-800-555-0131' },
  { key: 'periodStart', label: 'Period start', type: 'date', required: true, example: '2026-07-01' },
  { key: 'periodEnd', label: 'Period end', type: 'date', required: true, example: '2026-09-30' },
  { key: 'riskProfile', label: 'Risk profile', type: 'enum', enumValues: ['conservative', 'balanced', 'growth', 'aggressive'], required: true, dimension: true },
  { key: 'openingValueCents', label: 'Opening value', type: 'cents', required: true },
  { key: 'closingValueCents', label: 'Closing value', type: 'cents' },
  { key: 'previousQuarterCloseCents', label: 'Previous quarter closing value', type: 'cents', required: true },
  { key: 'contributionsCents', label: 'Contributions', type: 'cents', required: true },
  { key: 'withdrawalsCents', label: 'Withdrawals', type: 'cents', required: true },
  { key: 'incomeCents', label: 'Dividends and interest', type: 'cents', required: true },
  { key: 'feesCents', label: 'Fees', type: 'cents', required: true },
  { key: 'marketChangeCents', label: 'Change in market value', type: 'cents', required: true },
  { key: 'realisedGainCents', label: 'Realized gain or loss this quarter', type: 'cents', required: true },
  { key: 'unrealisedGainCents', label: 'Unrealized gain or loss', type: 'cents', required: true },
  { key: 'previousQuarterReturnBps', label: 'Return last quarter (hundredths of a percent)', type: 'int', required: true },
  { key: 'feeWaived', label: 'Management fee waived this quarter', type: 'bool' },
  {
    key: 'holdings', label: 'Holdings', type: 'list',
    itemFields: [
      { key: 'assetClass', label: 'Asset class', type: 'string' },
      { key: 'fund', label: 'Fund', type: 'string' },
      { key: 'code', label: 'Fund code', type: 'string' },
      { key: 'units', label: 'Units', type: 'string' },
      { key: 'priceCents', label: 'Price', type: 'cents' },
      { key: 'valueCents', label: 'Market value', type: 'cents' },
      { key: 'costCents', label: 'Cost', type: 'cents' },
      { key: 'weight', label: 'Weight', type: 'string' },
    ],
  },
  {
    key: 'transactions', label: 'Transactions', type: 'list',
    itemFields: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'type', label: 'Type', type: 'string' },
      { key: 'fund', label: 'Fund', type: 'string' },
      { key: 'units', label: 'Units', type: 'string' },
      { key: 'amountCents', label: 'Amount', type: 'cents' },
    ],
  },
  {
    key: 'assetAllocation', label: 'Asset allocation', type: 'list',
    itemFields: [
      { key: 'assetClass', label: 'Asset class', type: 'string' },
      { key: 'valueCents', label: 'Market value', type: 'cents' },
      { key: 'weight', label: 'Weight', type: 'string' },
    ],
  },
];

/* ------------------------------------------------------------------ lookup tables */

const M = (dollars: number) => dollars * 100;
/** The annual management fee in basis points by opening value, with the schedule that applies from 1 December 2026. */
export const MANAGEMENT_FEES: LookupTable = {
  id: 'managementFees', title: 'Management fee by portfolio value',
  description: 'Annual fee in basis points (1 bp = 0.01%), by the opening value of the quarter and the statement date. The schedule changes on 1 December 2026.',
  keys: [
    { key: 'value', label: 'Opening value', match: 'number-range', unit: 'money' },
    { key: 'inEffect', label: 'Statement date', match: 'date-range' },
  ],
  columns: [{ key: 'rateBps', label: 'Annual fee (bp)', type: 'number' }],
  rows: [
    { keys: { value: { from: 0, until: M(250_000) }, inEffect: { from: '2026-01-01', until: FEE_CHANGE_DAY } }, values: { rateBps: 85 } },
    { keys: { value: { from: M(250_000), until: M(1_000_000) }, inEffect: { from: '2026-01-01', until: FEE_CHANGE_DAY } }, values: { rateBps: 65 } },
    { keys: { value: { from: M(1_000_000) }, inEffect: { from: '2026-01-01', until: FEE_CHANGE_DAY } }, values: { rateBps: 45 } },
    { keys: { value: { from: 0, until: M(250_000) }, inEffect: { from: FEE_CHANGE_DAY, until: '2028-01-01' } }, values: { rateBps: 80 } },
    { keys: { value: { from: M(250_000), until: M(1_000_000) }, inEffect: { from: FEE_CHANGE_DAY, until: '2028-01-01' } }, values: { rateBps: 65 } },
    { keys: { value: { from: M(1_000_000) }, inEffect: { from: FEE_CHANGE_DAY, until: '2028-01-01' } }, values: { rateBps: 40 } },
  ],
};
export const feeBps = (openingCents: number, day: string): number => {
  const old = day < FEE_CHANGE_DAY;
  if (openingCents < M(250_000)) return old ? 85 : 80;
  if (openingCents < M(1_000_000)) return 65;
  return old ? 45 : 40;
};
export const RISK_WORDING: LookupTable = {
  id: 'riskWording', title: 'Risk profile wording',
  keys: [{ key: 'profile', label: 'Risk profile', match: 'text' }],
  columns: [{ key: 'model', label: 'Model portfolio', type: 'text' }, { key: 'equityTarget', label: 'Target in shares (%)', type: 'number' }],
  rows: [
    { keys: { profile: 'conservative' }, values: { model: 'C-30', equityTarget: 30 } },
    { keys: { profile: 'balanced' }, values: { model: 'B-50', equityTarget: 50 } },
    { keys: { profile: 'growth' }, values: { model: 'G-70', equityTarget: 70 } },
    { keys: { profile: 'aggressive' }, values: { model: 'A-90', equityTarget: 90 } },
  ],
};

/* ------------------------------------------------------------------ calculations */

const f = (path: string) => ({ op: 'field' as const, path });
const n = (value: number) => ({ op: 'number' as const, value });
const pctOf = (a: ReturnType<typeof f> | { op: 'sub'; a: any; b: any }, b: ReturnType<typeof f>, places: number) =>
  ({ op: 'round' as const, places, arg: { op: 'mul' as const, a: { op: 'div' as const, a, b }, b: n(100) } });
export const MERIDIAN_CALCS: CalculatedField[] = [
  { key: 'periodDays', label: 'Days in the period', type: 'number', expr: { op: 'days', from: f('custom.periodStart'), to: f('custom.periodEnd') } },
  { key: 'changeInValue', label: 'Change in value', type: 'money', description: 'Closing value less opening value.', expr: { op: 'sub', a: f('custom.closingValueCents'), b: f('custom.openingValueCents') } },
  { key: 'changePct', label: 'Change in value (%)', type: 'number', description: 'To two decimal places; zero for an account opened this quarter.', expr: { op: 'if', when: { op: 'gt', path: 'custom.openingValueCents', value: 0 }, then: pctOf({ op: 'sub', a: f('custom.closingValueCents'), b: f('custom.openingValueCents') }, f('custom.openingValueCents'), 2), else: n(0) } },
  { key: 'investmentReturnPct', label: 'Investment return (%)', type: 'number', description: 'Market change plus income less fees, as a share of the opening value, to two decimal places (money paid in or out does not count).', expr: { op: 'if', when: { op: 'gt', path: 'custom.openingValueCents', value: 0 }, then: pctOf({ op: 'sub', a: { op: 'add', a: f('custom.marketChangeCents'), b: f('custom.incomeCents') }, b: f('custom.feesCents') } as any, f('custom.openingValueCents'), 2), else: n(0) } },
  { key: 'previousReturnPct', label: 'Return last quarter (%)', type: 'number', expr: { op: 'round', places: 2, arg: { op: 'div', a: f('custom.previousQuarterReturnBps'), b: n(100) } } },
  { key: 'returnVsPrevious', label: 'Return compared with last quarter (percentage points)', type: 'number', expr: { op: 'round', places: 2, arg: { op: 'sub', a: f('calc.investmentReturnPct'), b: f('calc.previousReturnPct') } } },
  { key: 'lossPct', label: 'Loss this quarter (%)', type: 'number', description: 'The investment return without its sign, for wording that already says it is a loss.', expr: { op: 'abs', arg: f('calc.investmentReturnPct') } },
  { key: 'fellSharply', label: 'Fell by more than 5%', type: 'bool', expr: { op: 'if', when: { op: 'lte', path: 'calc.investmentReturnPct', value: -5 }, then: { op: 'bool', value: true }, else: { op: 'bool', value: false } } },
  { key: 'totalFees', label: 'Total fees', type: 'money', expr: { op: 'sum', list: 'custom.transactions', column: 'amountCents', where: { op: 'in', path: 'type', value: ['Management fee', 'Comisión de administración'] } } },
  { key: 'totalIncome', label: 'Total income', type: 'money', expr: { op: 'sum', list: 'custom.transactions', column: 'amountCents', where: { op: 'in', path: 'type', value: ['Dividend', 'Interest', 'Dividendo', 'Interés'] } } },
  { key: 'largestHolding', label: 'Largest holding', type: 'money', expr: { op: 'largest', list: 'custom.holdings', column: 'valueCents' } },
  { key: 'largestWeightPct', label: 'Largest holding’s share (%)', type: 'number', description: 'The largest holding as a share of the closing value, to one decimal place.', expr: pctOf(f('calc.largestHolding'), f('custom.closingValueCents'), 1) },
  { key: 'holdingCount', label: 'Number of holdings', type: 'number', expr: { op: 'count', list: 'custom.holdings', where: { op: 'gt', path: 'valueCents', value: 0 } } },
  { key: 'feeRateBps', label: 'Annual management fee (bp)', type: 'number', expr: { op: 'lookup', table: 'managementFees', column: 'rateBps', keys: [f('custom.openingValueCents'), { op: 'issueDate' }] } },
  { key: 'feeRatePct', label: 'Annual management fee (%)', type: 'number', expr: { op: 'round', places: 2, arg: { op: 'div', a: f('calc.feeRateBps'), b: n(100) } } },
  { key: 'quarterlyFee', label: 'Management fee for the quarter', type: 'money', description: 'Opening value times the annual fee, divided by four, to the cent; nothing when the fee is waived.', expr: { op: 'if', when: { op: 'eq', path: 'custom.feeWaived', value: true }, then: { op: 'money', cents: 0 }, else: { op: 'round', places: 2, arg: { op: 'div', a: { op: 'mul', a: f('custom.openingValueCents'), b: f('calc.feeRateBps') }, b: n(40000) } } } },
  { key: 'adviserLine', label: 'Adviser line', type: 'text', expr: { op: 'join', sep: ' · ', parts: [f('custom.adviserName'), f('custom.adviserPhone')] } },
  { key: 'modelPortfolio', label: 'Model portfolio', type: 'text', expr: { op: 'lookup', table: 'riskWording', column: 'model', keys: [f('custom.riskProfile')] } },
  { key: 'equityTarget', label: 'Target in shares (%)', type: 'number', expr: { op: 'lookup', table: 'riskWording', column: 'equityTarget', keys: [f('custom.riskProfile')] } },
];

/* ------------------------------------------------------------------ the document */

export function buildMeridian(): Project {
  const b = new SampleBuilder(blankProject({ projectId: MERIDIAN_ID, title: 'Meridian Wealth quarterly statement', issuerName: 'Meridian Wealth', accent: MERIDIAN_ACCENT }));
  b.project = { ...b.project, issuer: { ...b.project.issuer, product: 'Quarterly portfolio statement' } };
  b.run({ type: 'SET_CUSTOM_FIELDS', fields: MERIDIAN_FIELDS });
  b.run({ type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'custom.periodEnd' } });
  const plan = HOUSE.linkPlan;
  const link = (itemId: HouseItemId) => ({ item: { id: HOUSE.items[itemId].id, kind: HOUSE.items[itemId].kind, title: HOUSE.items[itemId].title }, version: plan[itemId], content: houseContent(itemId, plan[itemId]) });
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('brand-meridian') });
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('glossary-es') });
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('house-wording-rules') });
  b.run({ type: 'UPSERT_LOOKUP_TABLE', table: MANAGEMENT_FEES });
  b.run({ type: 'UPSERT_LOOKUP_TABLE', table: RISK_WORDING });
  for (const field of MERIDIAN_CALCS) b.run({ type: 'UPSERT_CALCULATED_FIELD', field });

  // Page design: US Letter; the first page has two columns (summary beside allocation) over a light tint; the holdings
  // table spans both columns and continues on following pages, which have one column.
  b.run({
    type: 'SET_PAGE_DESIGN',
    patch: {
      paper: 'US-Letter',
      pageTemplates: {
        first: { flowArea: { xPt: 40, yPt: 176, wPt: 532, hPt: 562 }, columns: 2, columnGapPt: 24, background: { kind: 'tint', color: '#F6F1E7', opacityPct: 55 } },
        following: { flowArea: { xPt: 40, yPt: 84, wPt: 532, hPt: 654 }, columns: 1 },
      },
    },
  });
  b.run({ type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true });

  /* ---- letterhead and page furniture */
  const hdr = (span: number) => ({ area: 'header' as const, span });
  b.insert({ id: 'issuer-logo', type: 'image', name: 'Meridian Wealth logo', image: { src: 'asset:meridian-mark', alt: 'Meridian Wealth (fictional wealth manager) logo', fit: 'contain' }, layout: fixed(40, 34, 186, 40, 'first', hdr(4)) });
  b.insert({ id: 'document-header', type: 'header-footer', name: 'Synthetic data notice', headerFooter: { role: 'document-header', text: 'SYNTHETIC DEMO DATA · Meridian Wealth is fictional · Not investment advice', repeat: false }, layout: fixed(300, 44, 272, 20, 'first', hdr(8)) });
  b.insert(text('statement-title', 'Statement title', '# Quarterly portfolio statement\n{{custom.periodStart}} to {{custom.periodEnd}} · {{calc.periodDays}} days\nAccount **{{custom.accountNumber}}** · {{customer.givenName}} {{customer.familyName}}', fixed(40, 86, 330, 70, 'first', hdr(7))));
  b.insert({ id: 'adviser', type: 'bound-field', name: 'Your adviser', label: 'Your adviser', binding: 'custom.adviserName', formatter: 'text', nullPolicy: 'error', layout: fixed(392, 90, 180, 18, 'first', hdr(5)) });
  b.insert(text('adviser-phone', 'Adviser phone', 'Call {{custom.adviserPhone}}, Monday to Friday, 8 a.m. to 6 p.m. Eastern', fixed(392, 110, 180, 40, 'first', hdr(5))));
  b.insert({ id: 'header-rule', type: 'shape', name: 'Header rule', decorative: true, shape: { kind: 'line', stroke: '#B08D3C', strokeWidthPt: 1.5 }, layout: fixed(40, 164, 532, 3, 'first', { area: 'header', span: 12, hidden: true }) });
  b.insert({ id: 'running-header', type: 'header-footer', name: 'Running header', headerFooter: { role: 'page-header', text: 'Meridian Wealth quarterly statement · {{custom.accountNumber}} · {{custom.periodEnd}}', repeat: true }, layout: fixed(40, 36, 532, 26, 'following', { area: 'header', span: 12, hidden: true }) });
  b.insert({ id: 'page-footer', type: 'header-footer', name: 'Page footer', headerFooter: { role: 'page-footer', text: 'Meridian Wealth (fictional) · Synthetic demonstration — not investment advice', repeat: true }, layout: fixed(40, 752, 532, 20, 'all', { area: 'footer', span: 12 }) });

  /* ---- column 1: the account summary */
  b.insert(text('greeting', 'Greeting', 'Dear {{customer.givenName}}, here is how your portfolio did this quarter.', flow({ spaceBeforePt: 0 })));
  b.insert(metric('closing-value', 'Closing value', 'custom.closingValueCents', 'usd-cents', 'primary', flow({ spaceBeforePt: 8 })));
  b.insert(container('summary-rows', 'Account summary', flow({ spaceBeforePt: 8, keepTogether: true })));
  const line = (id: string, label: string, binding: string, formatter: 'usd-cents' | 'text' = 'usd-cents') =>
    b.insert({ id, type: 'bound-field', name: label, label, binding, formatter, nullPolicy: 'fallback', fallbackText: '—', layout: flow({ spaceBeforePt: 2 }) }, 'summary-rows');
  b.insert(text('summary-heading', 'Account summary heading', '## Account summary', flow({ spaceBeforePt: 0 })), 'summary-rows');
  line('opening-value', 'Opening value', 'custom.openingValueCents');
  line('contributions', '+ Contributions', 'custom.contributionsCents');
  line('withdrawals', '− Withdrawals', 'custom.withdrawalsCents');
  line('income', '+ Dividends and interest', 'custom.incomeCents');
  line('fees', '− Fees', 'custom.feesCents');
  line('market-change', '+ Change in market value', 'custom.marketChangeCents');
  line('closing-line', '= Closing value', 'custom.closingValueCents');
  b.insert(text('performance', 'Performance', '## Performance\nYour investments returned **{{calc.investmentReturnPct}}%** this quarter, compared with {{calc.previousReturnPct}}% last quarter ({{calc.returnVsPrevious}} percentage points). Including money you added or took out, your portfolio changed by {{calc.changeInValue}} ({{calc.changePct}}%).\nRealized gain this quarter: {{custom.realisedGainCents}}. Unrealized gain on what you hold: {{custom.unrealisedGainCents}}.', flow({ spaceBeforePt: 10, keepTogether: true })));

  /* ---- column 2: allocation and risk */
  b.insert({ id: 'allocation-chart', type: 'chart', name: 'Asset allocation chart', binding: 'custom.assetAllocation', chart: { kind: 'donut', title: 'Asset allocation', groupBy: 'assetClass', valueKey: 'valueCents', limit: 6, palette: 'brand' }, layout: flow({ spaceBeforePt: 0, breakBefore: 'column', keepTogether: true }, { area: 'aside', span: 4 }) });
  b.insert(text('risk-profile', 'Risk profile', '## Your plan\nYour model portfolio {{calc.modelPortfolio}} aims to hold about {{calc.equityTarget}}% in shares. You hold {{calc.holdingCount}} investments; the largest is worth {{calc.largestHolding}}.', flow({ spaceBeforePt: 10, keepTogether: true }, { area: 'aside', span: 4 })));
  b.message({ id: 'commentary', name: 'Quarterly commentary', layout: flow({ spaceBeforePt: 10, keepTogether: true }, { area: 'aside', span: 4 }) }, [
    { id: 'commentary-balanced', title: 'This quarter for balanced investors', text: 'Shares rose modestly and bond prices held steady. A balanced mix aims to grow over time while limiting how far it can fall; we kept your mix close to its targets.', fallback: true },
    { id: 'commentary-conservative', title: 'This quarter for conservative investors', text: 'Your portfolio is weighted toward bonds and cash, which held their value this quarter. Interest income made up most of your return.' },
    { id: 'commentary-growth', title: 'This quarter for growth investors', text: 'Shares drove most of the movement in your portfolio this quarter. Growth portfolios can rise and fall more from quarter to quarter; what matters is the long term.' },
    { id: 'commentary-aggressive', title: 'This quarter for aggressive-growth investors', text: 'Almost all of your portfolio is in shares, so it moved with the markets this quarter. Expect larger swings in value, in both directions, than other profiles.' },
  ]);
  b.rule({ id: 'R01', title: 'Conservative profile: conservative commentary', mode: 'exclusive', priority: 300, exclusiveGroup: 'commentary', when: eq('custom.riskProfile', 'conservative'), then: { op: 'selectVariant', targetNodeId: 'commentary', variantId: 'commentary-conservative' } });
  b.rule({ id: 'R02', title: 'Growth profile: growth commentary', mode: 'exclusive', priority: 200, exclusiveGroup: 'commentary', when: eq('custom.riskProfile', 'growth'), then: { op: 'selectVariant', targetNodeId: 'commentary', variantId: 'commentary-growth' } });
  b.rule({ id: 'R03', title: 'Aggressive profile: aggressive-growth commentary', mode: 'exclusive', priority: 100, exclusiveGroup: 'commentary', when: eq('custom.riskProfile', 'aggressive'), then: { op: 'selectVariant', targetNodeId: 'commentary', variantId: 'commentary-aggressive' } });

  b.rule({ id: 'R07', title: 'Spanish-speaking client: approved Spanish wording only', mode: 'obligation', priority: 900, when: eq('customer.locale', 'es-US'), then: { op: 'setApprovedLocale', locale: 'es-US', errorIfMissingMandatoryTranslation: true } });

  /* ---- notices across both columns */
  b.insert({ id: 'fall-notice', type: 'conditional-region', name: 'Fall in value notice', ruleDriven: true, policy: 'exclusive', variantIds: [], layout: flow({ spaceBeforePt: 12, keepTogether: true, spanColumns: true }) });
  b.run({ type: 'ADD_VARIANT', nodeId: 'fall-notice', variantId: 'fall-notice-text', title: 'Your portfolio fell this quarter', text: 'Your investments lost {{calc.lossPct}}% this quarter. No investment is risk-free, and falls like this are part of investing; selling after a fall can lock in a loss. If your plans or your attitude to risk have changed, call your adviser to talk it through.' });
  b.run({ type: 'UPDATE_NODE', nodeId: 'fall-notice', patch: { fallbackVariantId: 'fall-notice-text' } });
  b.rule({ id: 'R04', title: 'Fell by more than 5%: show the fall notice', mode: 'additive', priority: 100, when: eq('calc.fellSharply', true), then: { op: 'showSection', targetNodeId: 'fall-notice' } });
  b.insert({ id: 'concentration-notice', type: 'conditional-region', name: 'Concentration notice', policy: 'exclusive', variantIds: [], variantConditions: {}, layout: flow({ spaceBeforePt: 10, keepTogether: true, spanColumns: true }) });
  b.run({ type: 'ADD_VARIANT', nodeId: 'concentration-notice', variantId: 'concentration', title: 'One investment is a large part of your portfolio', text: 'It makes up {{calc.largestWeightPct}}% of the total. Spreading your money over more investments can reduce the effect of any one of them on your portfolio.', when: { op: 'gt', path: 'calc.largestWeightPct', value: 25 } });

  /* ---- holdings, spanning both columns, continued on the following pages */
  b.insert({
    id: 'holdings-table', type: 'repeating-table', name: 'Holdings', binding: 'custom.holdings', caption: 'Your holdings at the end of the quarter', flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true,
    columns: [
      { key: 'assetClass', label: 'Asset class', format: 'text' }, { key: 'fund', label: 'Fund', format: 'text' }, { key: 'code', label: 'Code', format: 'text' },
      { key: 'units', label: 'Units', format: 'text', align: 'right' }, { key: 'priceCents', label: 'Price', format: 'usd-cents', align: 'right' },
      { key: 'valueCents', label: 'Market value', format: 'usd-cents', align: 'right', total: true }, { key: 'weight', label: 'Weight', format: 'text', align: 'right' },
    ],
    layout: flow({ spaceBeforePt: 14, spanColumns: true }),
  });
  b.insert({
    id: 'transactions-table', type: 'repeating-table', name: 'Transactions', binding: 'custom.transactions', caption: 'Transactions this quarter', flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true,
    columns: [
      { key: 'date', label: 'Date', format: 'date' }, { key: 'type', label: 'Type', format: 'text' }, { key: 'fund', label: 'Fund', format: 'text' },
      { key: 'units', label: 'Units', format: 'text', align: 'right' }, { key: 'amountCents', label: 'Amount', format: 'usd-cents', align: 'right' },
    ],
    layout: flow({ spaceBeforePt: 14, spanColumns: true }),
  });
  b.insert(text('fees-income', 'Income and fees', '## Income and fees\nThis quarter you received {{calc.totalIncome}} in dividends and interest and paid {{calc.totalFees}} in management fees. Your annual management fee is {{calc.feeRatePct}}% of your portfolio’s value, which comes to {{calc.quarterlyFee}} for this quarter.', flow({ spaceBeforePt: 14, keepTogether: true, spanColumns: true })));

  b.insert({ id: 'gains-explained', type: 'expandable-explanation', name: 'Gains explained', explanation: { title: 'What do realized and unrealized gains mean?', summary: 'A realized gain comes from selling; an unrealized gain is on what you still hold.', details: 'When you sell an investment for more than you paid, the difference is a realized gain, and it may be taxed in the year you sell. An unrealized gain is the rise in value of what you still hold: it is not taxed until you sell, and it can go down again.' }, layout: flow({ spaceBeforePt: 10, keepTogether: true, spanColumns: true }) });

  /* ---- the fee change: the announcement until the day it changes, the confirmation from that day */
  const affected = { op: 'or' as const, args: [{ op: 'lt' as const, path: 'custom.openingValueCents', value: M(250_000) }, { op: 'gte' as const, path: 'custom.openingValueCents', value: M(1_000_000) }] };
  b.insert(text('fee-waived-note', 'Fee waived note', '**Your management fee was waived this quarter**, because there was no activity in your account.', flow({ spaceBeforePt: 6, spanColumns: true }), { visibleWhen: eq('custom.feeWaived', true) }));
  b.message({ id: 'fee-notice', name: 'Fee notice', layout: flow({ spaceBeforePt: 10, keepTogether: true, spanColumns: true }) }, [
    { id: 'fee-unchanged', title: 'Your management fee', text: 'Your annual management fee stays at {{calc.feeRatePct}}% of your portfolio’s value. We will tell you at least 30 days before any change.', fallback: true },
    { id: 'fee-upcoming', title: 'Your management fee is going down', text: 'From December 1, 2026, the annual management fee for portfolios under $250,000 falls from 0.85% to 0.80%, and for portfolios of $1,000,000 or more from 0.45% to 0.40%. You do not need to do anything.' },
    { id: 'fee-changed', title: 'Your lower management fee', text: 'Since December 1, 2026, your annual management fee is {{calc.feeRatePct}}%. The fees on this statement already use the new rate.' },
  ]);
  b.run({ type: 'SET_VARIANT_PERIOD', nodeId: 'fee-notice', variantId: 'fee-upcoming', period: { until: FEE_CHANGE_DAY } });
  b.run({ type: 'SET_VARIANT_PERIOD', nodeId: 'fee-notice', variantId: 'fee-changed', period: { from: FEE_CHANGE_DAY } });
  b.rule({ id: 'R05', title: 'Fee falls on 1 December: announce it before then', mode: 'exclusive', priority: 120, exclusiveGroup: 'fee-notice', when: affected, then: { op: 'selectVariant', targetNodeId: 'fee-notice', variantId: 'fee-upcoming' }, effective: { until: FEE_CHANGE_DAY } });
  b.rule({ id: 'R06', title: 'Fee fell on 1 December: confirm the new fee', mode: 'exclusive', priority: 110, exclusiveGroup: 'fee-notice', when: affected, then: { op: 'selectVariant', targetNodeId: 'fee-notice', variantId: 'fee-changed' }, effective: { from: FEE_CHANGE_DAY } });

  /* ---- tax documents (fourth quarter, taxable accounts) */
  b.insert({ id: 'tax-notice', type: 'conditional-region', name: 'Tax documents notice', policy: 'exclusive', variantIds: [], variantConditions: {}, layout: flow({ spaceBeforePt: 10, keepTogether: true, spanColumns: true }) });
  b.run({ type: 'ADD_VARIANT', nodeId: 'tax-notice', variantId: 'tax-documents', title: 'Your 2026 tax documents', text: 'Form 1099 for this account will be ready by February 16, 2027. You will find it under Documents when you sign in, and we will mail a copy if you asked for paper.', when: isIn('custom.accountType', ['individual', 'joint', 'trust']) });
  b.run({ type: 'SET_SECTION_PERIOD', nodeId: 'tax-notice', period: { from: Q4.start, until: '2027-01-01' } });

  /* ---- the client portal, the required notice and the shared panel */
  b.insert(container('portal-actions', 'Online account', flow({ direction: 'row', spaceBeforePt: 14, keepTogether: true, spanColumns: true }, { area: 'main', span: 12, direction: 'row' })));
  b.insert({ id: 'portal-link', type: 'action-link', name: 'View your account online', action: { label: 'View your account online', url: 'https://example.com/meridian/account', fallbackText: 'See your holdings, documents and performance at example.com/meridian/account, or call your adviser.' }, layout: flow({ widthPct: 72, spaceBeforePt: 0 }, { area: 'main', span: 9 }) }, 'portal-actions');
  b.insert({ id: 'portal-qr', type: 'qr-code', name: 'Account QR code', qr: { url: 'https://example.com/meridian/account', caption: 'Scan to view your account' }, layout: flow({ widthPct: 28, spaceBeforePt: 0, align: 'right' }, { area: 'main', span: 3 }) }, 'portal-actions');
  b.notice({ id: 'important-information', name: 'Important information', required: true, layout: flow({ spaceBeforePt: 14, keepTogether: true, spanColumns: true }, { area: 'footer', span: 12 }) }, 'Important information',
    'Investments are not bank deposits and are not insured by any government agency. Their value can go down as well as up, and you may get back less than you invested. Past returns do not predict future returns. Meridian Wealth (fictional) is a demonstration company; this statement is synthetic and is not investment, tax or legal advice.');
  b.run({ type: 'LINK_LIBRARY_ITEM', ...link('accessible-formats-panel'), placement: { parentId: b.project.rootNodeId } });

  /* ---- email and SMS */
  const ch = channelConfig(b.project);
  b.run({
    type: 'SET_CHANNELS',
    channels: {
      email: { ...ch.email, subject: 'Your Meridian Wealth statement for the quarter ending {{custom.periodEnd}}', preheader: 'Closing value {{custom.closingValueCents}}. {{keyFacts}}', title: 'Your quarterly statement is ready', intro: 'Dear {{customer.givenName}}, your statement for account {{custom.accountNumber}} is ready. Your investments returned {{calc.investmentReturnPct}}% this quarter.', closing: 'Questions? Your adviser is {{calc.adviserLine}}.', keyFactsHeading: 'Your quarter at a glance' },
      sms: { text: 'DEMO Meridian Wealth: Your statement for the quarter ending {{custom.periodEnd}} is ready. Closing value {{custom.closingValueCents}}. View: {{link}}' },
    },
  });

  /* ---- Spanish */
  b.run({ type: 'ADD_LANGUAGE', locale: 'es-US' });
  b.translate('es-US', MERIDIAN_ES(), MERIDIAN_ES_DRAFT_ONLY);

  /* ---- journeys, pinned tests, own wording rules, mappings */
  b.run({
    type: 'SET_JOURNEY',
    events: [
      { eventId: 'mw-issued', eventType: 'statement.issued', day: 1, label: 'Statement issued', payload: {}, effects: [], emits: 'immutable-issued-snapshot' },
      { eventId: 'mw-risk-review', eventType: 'risk.reviewed', day: 21, label: 'Risk profile reviewed with the adviser', payload: {}, effects: [{ op: 'set', path: 'custom.riskProfile', value: 'conservative' }], emits: 'new-communication-preview' },
      { eventId: 'mw-adviser-change', eventType: 'adviser.changed', day: 40, label: 'New adviser assigned', payload: {}, effects: [{ op: 'set', path: 'custom.adviserName', value: 'Rowan Ashby' }, { op: 'set', path: 'custom.adviserPhone', value: '1-800-555-0139' }], emits: 'new-communication-preview' },
    ],
  });
  for (const t of meridianTests()) b.run({ type: 'UPSERT_TEST_CASE', testCase: t });
  b.run({ type: 'ADD_WORDING_RULE', rule: { id: 'mw-no-risk-free', kind: 'banned', severity: 'should', phrase: 'risk-free', appliesTo: 'anywhere', language: 'en-US', note: 'Avoid the phrase even in a denial; say what the risk is instead.' } });
  b.run({ type: 'ADD_WORDING_RULE', rule: { id: 'mw-no-beat-market', kind: 'banned', severity: 'must', phrase: 'beat the market', appliesTo: 'anywhere', note: 'We never promise performance against the market.' } });
  mappings(b);
  return { ...b.project, modelVersion: 1 };
}

/* ------------------------------------------------------------------ pinned tests */

export function meridianTests(): TestCase[] {
  const T = (id: string, name: string, recordId: string, expect: TestCase['expect'], issueDate?: string): TestCase => ({ id, name, recordId, expect, ...(issueDate ? { issueDate } : {}) });
  return [
    T('T1', 'Balanced investor, single fund: standard commentary, one fund is 100%', 'MWS-60001', { selectedVariants: { commentary: 'commentary-balanced', 'fee-notice': 'fee-upcoming' }, visibleNodeIds: ['concentration-notice'], hiddenNodeIds: ['fall-notice', 'tax-notice'], noBlocking: true }),
    T('T2', 'A fall of more than 5% shows the fall notice', 'MWS-60004', { visibleNodeIds: ['fall-notice'], selectedVariants: { commentary: 'commentary-aggressive' }, noBlocking: true }),
    T('T3', 'Spanish-speaking client gets the approved Spanish statement', 'MWS-60003', { approvedLocale: 'es-US', noBlocking: true }),
    T('T4', 'Fourth quarter, taxable account: tax documents notice', 'MWS-60020', { visibleNodeIds: ['tax-notice'], noBlocking: true }),
    T('T5', 'As issued the day before the fee change: the announcement', 'MWS-60001', { selectedVariants: { 'fee-notice': 'fee-upcoming' }, noBlocking: true }, '2026-11-30'),
    T('T6', 'As issued on the day of the fee change: the new fee', 'MWS-60001', { selectedVariants: { 'fee-notice': 'fee-changed' }, noBlocking: true }, FEE_CHANGE_DAY),
    T('T7', 'Concentrated portfolio: concentration notice', 'MWS-60002', { visibleNodeIds: ['concentration-notice'], selectedVariants: { commentary: 'commentary-conservative' }, noBlocking: true }),
  ];
}

/* ------------------------------------------------------------------ mappings */

const STAMP = { by: 'Sample author', at: '2026-11-03T10:00:00.000Z' };
function mappings(b: SampleBuilder): void {
  b.run({ type: 'ADD_MAPPING', mapping: { id: 'print-house', name: 'Mapping for the print house', system: 'Calder Print & Mail (fictional)', description: 'The quarterly statement file the print house receives.' }, stamp: STAMP });
  const out: Array<[string, string, string, string?]> = [
    ['recordId', 'CUST_REF', 'CHAR(10)'], ['customer.givenName', 'FIRST_NAME', 'VARCHAR(40)'], ['customer.familyName', 'LAST_NAME', 'VARCHAR(40)'], ['customer.locale', 'LANG', 'CHAR(5)'], ['custom.feeWaived', 'FEE_WAIVED', 'BOOLEAN'],
    ['custom.accountNumber', 'ACCT_ID', 'CHAR(12)'], ['custom.accountType', 'ACCT_TYPE', 'VARCHAR(10)'], ['custom.adviserName', 'ADV_NAME', 'VARCHAR(60)'], ['custom.adviserPhone', 'ADV_PHONE', 'CHAR(14)'],
    ['custom.periodStart', 'PER_START', 'DATE', 'MM/DD/YYYY'], ['custom.periodEnd', 'PER_END', 'DATE', 'MM/DD/YYYY'], ['custom.riskProfile', 'RISK_PROF', 'VARCHAR(12)'],
    ['custom.openingValueCents', 'OPEN_VAL', 'DECIMAL(13,2)', 'divide by 100'], ['custom.closingValueCents', 'CLOSE_VAL', 'DECIMAL(13,2)', 'divide by 100'], ['custom.previousQuarterCloseCents', 'PRIOR_CLOSE', 'DECIMAL(13,2)', 'divide by 100'],
    ['custom.contributionsCents', 'CONTRIB', 'DECIMAL(13,2)', 'divide by 100'], ['custom.withdrawalsCents', 'WITHDR', 'DECIMAL(13,2)', 'divide by 100'], ['custom.incomeCents', 'INCOME', 'DECIMAL(13,2)', 'divide by 100'],
    ['custom.feesCents', 'FEES', 'DECIMAL(11,2)', 'divide by 100'], ['custom.marketChangeCents', 'MKT_CHG', 'DECIMAL(13,2)', 'divide by 100'], ['custom.realisedGainCents', 'REAL_GL', 'DECIMAL(13,2)', 'divide by 100'],
    ['custom.unrealisedGainCents', 'UNREAL_GL', 'DECIMAL(13,2)', 'divide by 100'], ['custom.previousQuarterReturnBps', 'PRIOR_RET_BP', 'INTEGER'],
    ['custom.holdings', 'HOLD_REC', 'REPEATING GROUP'], ['custom.holdings[].assetClass', 'HOLD_CLASS', 'VARCHAR(30)'], ['custom.holdings[].fund', 'HOLD_NAME', 'VARCHAR(60)'], ['custom.holdings[].code', 'HOLD_CODE', 'CHAR(10)'],
    ['custom.holdings[].units', 'HOLD_UNITS_TXT', 'VARCHAR(18)', 'three decimals, with thousands separators'], ['custom.holdings[].priceCents', 'HOLD_PRICE', 'DECIMAL(11,2)', 'divide by 100'], ['custom.holdings[].valueCents', 'HOLD_VAL', 'DECIMAL(13,2)', 'divide by 100'],
    ['custom.holdings[].costCents', 'HOLD_COST', 'DECIMAL(13,2)', 'divide by 100'], ['custom.holdings[].weight', 'HOLD_WT', 'CHAR(6)'],
    ['custom.transactions', 'TXN_REC', 'REPEATING GROUP'], ['custom.transactions[].date', 'TXN_DT', 'DATE', 'MM/DD/YYYY'], ['custom.transactions[].type', 'TXN_TYPE', 'VARCHAR(20)'], ['custom.transactions[].fund', 'TXN_FUND', 'VARCHAR(60)'],
    ['custom.transactions[].units', 'TXN_UNITS_TXT', 'VARCHAR(18)', 'three decimals, with thousands separators; empty for income and fees'], ['custom.transactions[].amountCents', 'TXN_AMT', 'DECIMAL(13,2)', 'divide by 100'],
    ['custom.assetAllocation', 'ALLOC_REC', 'REPEATING GROUP'], ['custom.assetAllocation[].assetClass', 'ALLOC_CLASS', 'VARCHAR(30)'], ['custom.assetAllocation[].valueCents', 'ALLOC_VAL', 'DECIMAL(13,2)', 'divide by 100'], ['custom.assetAllocation[].weight', 'ALLOC_WT', 'CHAR(6)'],
  ];
  b.run({ type: 'SET_MAPPING_ENTRIES', mappingId: 'print-house', stamp: STAMP, entries: out.map(([path, target, targetType, format]) => ({ path, target, targetType, ...(format ? { format } : {}) })) });
  b.run({ type: 'ADD_MAPPING', mapping: { id: 'client-portal', name: 'Mapping for the client portal', system: 'Meridian client portal (fictional)', description: 'In progress: the portal team has mapped the summary values so far.' }, stamp: STAMP });
  b.run({ type: 'SET_MAPPING_ENTRIES', mappingId: 'client-portal', stamp: STAMP, entries: [
    { path: 'custom.accountNumber', target: 'account.number', targetType: 'string' },
    { path: 'custom.closingValueCents', target: 'summary.closingValue', targetType: 'number', format: 'divide by 100' },
    { path: 'custom.openingValueCents', target: 'summary.openingValue', targetType: 'number', format: 'divide by 100' },
    { path: 'custom.periodEnd', target: 'statement.asOf', targetType: 'date' },
  ] });
}

/* ------------------------------------------------------------------ customers */

/** The invented funds, by asset class: [name, code, price in cents at the end of Q3, at the end of Q4]. */
const FUNDS: Record<string, Array<[string, string, number, number]>> = {
  'US equity': [
    ['Meridian Core US Equity Fund', 'MW-USEQ', 4812, 4955], ['Meridian US Dividend Fund', 'MW-USDV', 3127, 3168], ['Meridian US Small Companies Fund', 'MW-USSM', 2264, 2190],
    ['Meridian Technology Leaders Fund', 'MW-TECH', 7731, 8102], ['Meridian Health Care Fund', 'MW-HLTH', 3990, 3871], ['Meridian Financials Fund', 'MW-FINL', 2655, 2740],
    ['Meridian Industrials Fund', 'MW-INDU', 3318, 3402], ['Meridian Consumer Staples Fund', 'MW-STPL', 2876, 2911], ['Meridian Consumer Brands Fund', 'MW-CONS', 4105, 4020],
    ['Meridian Energy Transition Fund', 'MW-ENRG', 1944, 1877], ['Meridian Utilities Income Fund', 'MW-UTIL', 2231, 2268], ['Meridian Materials Fund', 'MW-MATL', 1789, 1812],
  ],
  'International equity': [
    ['Meridian Global ex-US Equity Fund', 'MW-INTL', 2588, 2633], ['Meridian Emerging Markets Fund', 'MW-EMKT', 1712, 1650], ['Meridian Europe Select Fund', 'MW-EURO', 2943, 3010],
    ['Meridian Asia Pacific Fund', 'MW-ASIA', 2201, 2154], ['Meridian International Small Companies Fund', 'MW-INSM', 1588, 1601],
  ],
  'Fixed income': [
    ['Meridian Short-Term Bond Fund', 'MW-STBD', 1003, 1006], ['Meridian Intermediate Bond Fund', 'MW-INBD', 962, 971], ['Meridian Municipal Income Fund', 'MW-MUNI', 1041, 1047],
    ['Meridian Inflation-Protected Bond Fund', 'MW-TIPS', 1118, 1122], ['Meridian Corporate Bond Fund', 'MW-CORP', 987, 993], ['Meridian High Yield Bond Fund', 'MW-HYLD', 891, 884],
    ['Meridian Treasury Ladder 2027', 'MW-TL27', 1000, 1001], ['Meridian Treasury Ladder 2028', 'MW-TL28', 996, 999], ['Meridian Treasury Ladder 2029', 'MW-TL29', 989, 994],
    ['Meridian Treasury Ladder 2030', 'MW-TL30', 981, 987], ['Meridian Treasury Ladder 2031', 'MW-TL31', 973, 980], ['Meridian Treasury Ladder 2032', 'MW-TL32', 966, 974],
    ['Meridian Global Bond Fund', 'MW-GLBD', 942, 950],
  ],
  'Real estate': [
    ['Meridian Real Estate Income Fund', 'MW-REIT', 2077, 2036], ['Meridian Global Property Fund', 'MW-GPRP', 1655, 1640], ['Meridian Infrastructure Fund', 'MW-INFR', 2412, 2450],
  ],
  Cash: [['Meridian Cash Reserve', 'MW-CASH', 100, 100]],
};
const CLASS_ORDER = ['US equity', 'International equity', 'Fixed income', 'Real estate', 'Cash'];
/** What the custodian writes into a client's data, in the client's language (the calculations accept both spellings). */
export const MW_DATA_WORDS = {
  en: { classes: { 'US equity': 'US equity', 'International equity': 'International equity', 'Fixed income': 'Fixed income', 'Real estate': 'Real estate', Cash: 'Cash' } as Record<string, string>, contribution: 'Contribution', withdrawal: 'Withdrawal', dividend: 'Dividend', interest: 'Interest', fee: 'Management fee', buy: 'Buy', sell: 'Sell', closed: '(position closed)' },
  es: { classes: { 'US equity': 'Acciones de EE. UU.', 'International equity': 'Acciones internacionales', 'Fixed income': 'Renta fija', 'Real estate': 'Bienes raíces', Cash: 'Efectivo' } as Record<string, string>, contribution: 'Aporte', withdrawal: 'Retiro', dividend: 'Dividendo', interest: 'Interés', fee: 'Comisión de administración', buy: 'Compra', sell: 'Venta', closed: '(posición cerrada)' },
} as const;
/** Share of each asset class by risk profile (percent). */
const MIX: Record<string, number[]> = {
  conservative: [18, 8, 62, 4, 8], balanced: [34, 14, 42, 5, 5], growth: [48, 20, 22, 6, 4], aggressive: [62, 26, 4, 6, 2],
};

interface MwSpec {
  given: string; family: string; es?: boolean; type: 'individual' | 'joint' | 'ira' | 'trust'; risk: 'conservative' | 'balanced' | 'growth' | 'aggressive';
  q: 'Q3' | 'Q4'; value: number; holdings: number; ret: number; contrib?: number; withdraw?: number; prevRet: number;
  noTransactions?: boolean; closed?: boolean; concentrated?: boolean; newAccount?: boolean; adviser?: [string, string] | null;
  /** Deliberate data problem (listed in the notes). */
  noClosingValue?: boolean;
}

const ADVISERS: Array<[string, string]> = [['Dana Whitlock', '1-800-555-0131'], ['Marisol Peña', '1-800-555-0133'], ['Theo Lindgren', '1-800-555-0135'], ['Keiko Arima', '1-800-555-0137']];

const SPECS: MwSpec[] = [
  { given: 'Eleanor', family: 'Whitcombe', type: 'individual', risk: 'balanced', q: 'Q3', value: 84_000, holdings: 1, ret: 1.8, prevRet: 2.6 },
  { given: 'Marcus', family: 'Adeyemi', type: 'ira', risk: 'conservative', q: 'Q3', value: 212_000, holdings: 3, ret: 0.9, prevRet: 1.1, concentrated: true },
  { given: 'Valentina', family: 'Ríos', es: true, type: 'joint', risk: 'balanced', q: 'Q3', value: 356_000, holdings: 8, ret: 2.1, prevRet: 3.0, contrib: 5_000 },
  { given: 'Gregory', family: 'Halvorsen', type: 'individual', risk: 'aggressive', q: 'Q3', value: 498_000, holdings: 12, ret: -7.4, prevRet: 4.8 },
  { given: 'Priscilla', family: 'Nwosu', type: 'trust', risk: 'growth', q: 'Q3', value: 1_420_000, holdings: 18, ret: 3.6, prevRet: 2.2 },
  { given: 'Hector', family: 'Villanueva', es: true, type: 'ira', risk: 'growth', q: 'Q3', value: 167_500, holdings: 6, ret: -5.6, prevRet: 3.4 },
  { given: 'Imogen', family: 'Thackeray', type: 'individual', risk: 'conservative', q: 'Q3', value: 59_800, holdings: 4, ret: 0.7, prevRet: 0.9, noTransactions: true },
  { given: 'Bashir', family: 'Rahimi', type: 'joint', risk: 'growth', q: 'Q3', value: 731_000, holdings: 14, ret: 4.2, prevRet: -1.3, withdraw: 25_000 },
  { given: 'Consuelo', family: 'Bermúdez', es: true, type: 'individual', risk: 'conservative', q: 'Q3', value: 128_300, holdings: 5, ret: 1.0, prevRet: 1.2 },
  { given: 'Desmond', family: 'Okafor', type: 'ira', risk: 'aggressive', q: 'Q3', value: 96_400, holdings: 7, ret: 6.9, prevRet: 5.1, closed: true },
  { given: 'Henrietta', family: 'Lowell', type: 'trust', risk: 'balanced', q: 'Q3', value: 2_350_000, holdings: 40, ret: 2.4, prevRet: 1.9 },
  { given: 'Ignacio', family: 'Paredes', es: true, type: 'joint', risk: 'aggressive', q: 'Q3', value: 288_000, holdings: 10, ret: 5.5, prevRet: 6.1 },
  { given: 'Juniper', family: 'Castellanos', type: 'individual', risk: 'balanced', q: 'Q3', value: 15_200, holdings: 2, ret: 1.5, prevRet: 0, newAccount: true, contrib: 15_000 },
  { given: 'Kwame', family: 'Asante', type: 'individual', risk: 'growth', q: 'Q3', value: 402_000, holdings: 11, ret: 3.1, prevRet: 2.7, adviser: null },
  { given: 'Lorraine', family: 'Featherstone', type: 'ira', risk: 'balanced', q: 'Q3', value: 640_000, holdings: 13, ret: 1.9, prevRet: 2.0, withdraw: 12_000 },
  { given: 'Mateo', family: 'Guerrero', es: true, type: 'ira', risk: 'conservative', q: 'Q3', value: 77_700, holdings: 3, ret: 0.8, prevRet: 0.6 },
  { given: 'Nora', family: 'Brandvold', type: 'joint', risk: 'balanced', q: 'Q3', value: 189_000, holdings: 7, ret: 2.0, prevRet: 2.4 },
  { given: 'Oscar', family: 'Delahaye', type: 'individual', risk: 'balanced', q: 'Q3', value: 245_000, holdings: 9, ret: 1.6, prevRet: 1.7, noClosingValue: true },
  { given: 'Penelope', family: 'Szabo', type: 'trust', risk: 'conservative', q: 'Q4', value: 1_050_000, holdings: 16, ret: 1.1, prevRet: 0.9 },
  { given: 'Quentin', family: 'Abara', type: 'individual', risk: 'growth', q: 'Q4', value: 318_000, holdings: 10, ret: 4.4, prevRet: 3.6 },
  { given: 'Rafaela', family: 'Montoya', es: true, type: 'joint', risk: 'balanced', q: 'Q4', value: 142_000, holdings: 6, ret: 2.3, prevRet: 2.1 },
  { given: 'Silas', family: 'Wakefield', type: 'ira', risk: 'aggressive', q: 'Q4', value: 511_000, holdings: 15, ret: -8.2, prevRet: 6.6 },
  { given: 'Tamsin', family: 'Pryce', type: 'individual', risk: 'conservative', q: 'Q4', value: 66_000, holdings: 1, ret: 0.6, prevRet: 0.7, concentrated: true },
  { given: 'Ulises', family: 'Carmona', es: true, type: 'individual', risk: 'growth', q: 'Q4', value: 233_000, holdings: 8, ret: 3.9, prevRet: 4.1 },
  { given: 'Vivienne', family: 'Achebe', type: 'trust', risk: 'growth', q: 'Q4', value: 3_100_000, holdings: 24, ret: 3.2, prevRet: 3.5, contrib: 100_000 },
  { given: 'Wendell', family: 'Strickland', type: 'joint', risk: 'balanced', q: 'Q4', value: 404_000, holdings: 12, ret: 2.2, prevRet: 1.8 },
  { given: 'Ximena', family: 'Fuentes', es: true, type: 'ira', risk: 'aggressive', q: 'Q4', value: 188_000, holdings: 9, ret: 7.1, prevRet: -2.4 },
  { given: 'Yannick', family: 'Moreau', type: 'individual', risk: 'balanced', q: 'Q4', value: 97_500, holdings: 4, ret: 1.7, prevRet: 2.3, noTransactions: true },
  { given: 'Zelda', family: 'Kristiansen', type: 'joint', risk: 'conservative', q: 'Q4', value: 276_000, holdings: 6, ret: 0.9, prevRet: 1.0, withdraw: 8_000 },
  { given: 'Abel', family: 'Mensah', type: 'individual', risk: 'growth', q: 'Q4', value: 1_880_000, holdings: 30, ret: -5.2, prevRet: 2.9 },
  { given: 'Beatriz', family: 'Saavedra', es: true, type: 'trust', risk: 'conservative', q: 'Q4', value: 760_000, holdings: 11, ret: 1.2, prevRet: 1.3 },
  { given: 'Cyrus', family: 'Farahani', type: 'ira', risk: 'balanced', q: 'Q4', value: 52_000, holdings: 3, ret: 1.4, prevRet: 1.6, closed: true },
  { given: 'Delphine', family: 'Arceneaux', type: 'individual', risk: 'aggressive', q: 'Q4', value: 129_000, holdings: 8, ret: 8.8, prevRet: 7.2 },
  { given: 'Emilio', family: 'Rocha', es: true, type: 'joint', risk: 'growth', q: 'Q4', value: 612_000, holdings: 14, ret: 3.4, prevRet: 2.8 },
];

const groupThousands = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Units with three decimals as a statement shows them ("1,234.567"), from thousandths. */
export const unitsText = (thousandths: number): string => `${thousandths < 0 ? '-' : ''}${groupThousands(String(Math.floor(Math.abs(thousandths) / 1000)))}.${String(Math.abs(thousandths) % 1000).padStart(3, '0')}`;
/** Thousandths of a unit from the statement's text. */
export const unitsOf = (t: string): number => { const [i, d = '0'] = t.replace(/,/g, '').split('.'); const sign = i.startsWith('-') ? -1 : 1; return sign * (Math.abs(Number(i)) * 1000 + Number(d.padEnd(3, '0').slice(0, 3))); };
/** A share of a total as "12.4%". */
const pct1 = (part: number, total: number) => `${total ? roundHalfUp((part * 100) / total, 1).toFixed(1) : '0.0'}%`;

export function meridianCustomers(): SampleCustomer[] {
  return SPECS.map((s, i) => {
    const recordId = `MWS-${60001 + i}`;
    const q = s.q === 'Q3' ? Q3 : Q4;
    const priceIdx = s.q === 'Q3' ? 2 : 3;
    // Choose the funds: spread over the asset classes of the risk profile, most in the largest classes.
    const mix = MIX[s.risk];
    const picks: Array<{ cls: string; fund: [string, string, number, number] }> = [];
    if (s.holdings === 1) picks.push({ cls: s.risk === 'conservative' ? 'Fixed income' : 'US equity', fund: FUNDS[s.risk === 'conservative' ? 'Fixed income' : 'US equity'][0] });
    else {
      const order = CLASS_ORDER.map((c, k) => ({ c, w: mix[k] })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w).map((x) => x.c);
      const used = new Map<string, number>();
      for (let k = 0; picks.length < s.holdings; k++) {
        const cls = order[k % order.length];
        const idx = used.get(cls) ?? 0;
        if (idx >= FUNDS[cls].length) { if (k > 400) break; continue; }
        used.set(cls, idx + 1);
        picks.push({ cls, fund: FUNDS[cls][(idx + i) % FUNDS[cls].length] });
      }
    }
    // Dollar targets: by asset-class mix, the concentrated portfolios with one large position.
    const totalCents = Math.round(s.value * 100 * (1 + ((i * 13) % 17) / 997));
    const weights = picks.map((p, k) => {
      if (s.concentrated && k === 0) return 60;
      const classShare = mix[CLASS_ORDER.indexOf(p.cls)];
      const inClass = picks.filter((x) => x.cls === p.cls).length;
      return (classShare / inClass) * (1 + ((k * 3 + i * 5) % 7) / 8);
    });
    const wsum = weights.reduce((a, b) => a + b, 0);
    let holdings = picks.map((p, k) => {
      const price = p.fund[priceIdx];
      const target = (totalCents * weights[k]) / wsum;
      const units = Math.max(1, Math.round((target / price) * 1000));
      const value = roundHalfUp((units * price) / 1000, 0);
      return { assetClass: p.cls, fund: p.fund[0], code: p.fund[1], unitsK: units, priceCents: price, valueCents: value, costCents: roundHalfUp(value / (1 + (0.04 + ((k + i) % 6) * 0.03)), 0) };
    });
    // A position closed this quarter: still listed with nothing left in it.
    const w = MW_DATA_WORDS[s.es ? 'es' : 'en'];
    if (s.closed) holdings.push({ assetClass: 'US equity', fund: `Meridian Energy Transition Fund ${w.closed}`, code: 'MW-ENRG', unitsK: 0, priceCents: FUNDS['US equity'][9][priceIdx], valueCents: 0, costCents: 0 });
    // Merge duplicates (the same fund picked twice) so every fund appears once.
    const seen = new Map<string, typeof holdings[number]>();
    for (const h of holdings) { const e = seen.get(h.code + h.fund); if (e) { e.unitsK += h.unitsK; e.valueCents = roundHalfUp((e.unitsK * e.priceCents) / 1000, 0); e.costCents += h.costCents; } else seen.set(h.code + h.fund, { ...h }); }
    holdings = [...seen.values()].sort((a, b) => CLASS_ORDER.indexOf(a.assetClass) - CLASS_ORDER.indexOf(b.assetClass) || b.valueCents - a.valueCents);
    const closing = holdings.reduce((t, h) => t + h.valueCents, 0);
    // The quarter's flows: the opening value from the investment return, then fees from the fee table.
    const contributions = (s.contrib ?? 0) * 100;
    const withdrawals = (s.withdraw ?? 0) * 100;
    const opening = s.newAccount ? 0 : roundHalfUp((closing - contributions + withdrawals) / (1 + s.ret / 100), 0);
    // A quiet account (no transactions this quarter) has its fee waived; a new account pays none in its first quarter.
    const fees = s.newAccount || s.noTransactions ? 0 : roundHalfUp((opening * feeBps(opening, q.end)) / 40000, 0);
    const income = s.noTransactions ? 0 : roundHalfUp(opening * (s.risk === 'conservative' ? 0.0085 : s.risk === 'balanced' ? 0.0062 : 0.0041), 0);
    const marketChange = closing - opening - contributions + withdrawals - income + fees;
    // Transactions in the period (dated inside it).
    const tx: Array<Record<string, unknown>> = [];
    const d = (k: number) => addDays(q.start, k);
    if (!s.noTransactions) {
      if (contributions) tx.push({ date: d(9), type: w.contribution, fund: 'Meridian Cash Reserve', units: unitsText(contributions * 10), amountCents: contributions });
      // About three fifths of the income is the dividend and the rest is interest, so the two lines do not read as a copy.
      const income1 = Math.floor((income * 62) / 100);
      tx.push({ date: d(30), type: w.dividend, fund: holdings.filter((h) => h.valueCents > 0)[0].fund, units: '', amountCents: income1 });
      tx.push({ date: d(61), type: w.interest, fund: 'Meridian Cash Reserve', units: '', amountCents: income - income1 });
      if (fees) tx.push({ date: d(88), type: w.fee, fund: 'Meridian Cash Reserve', units: '', amountCents: fees });
      if (withdrawals) tx.push({ date: d(45), type: w.withdrawal, fund: 'Meridian Cash Reserve', units: unitsText(withdrawals * 10), amountCents: withdrawals });
      if (s.closed) tx.push({ date: d(52), type: w.sell, fund: 'Meridian Energy Transition Fund', units: unitsText(-((i + 3) * 41_250)), amountCents: roundHalfUp(((i + 3) * 41_250 * FUNDS['US equity'][9][priceIdx]) / 1000, 0) });
      const open = holdings.filter((h) => h.valueCents > 0);
      if (open.length > 3) tx.push({ date: d(70), type: w.buy, fund: open[1].fund, units: unitsText(5_000 + i * 250), amountCents: roundHalfUp(((5_000 + i * 250) * open[1].priceCents) / 1000, 0) });
      tx.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
    // Asset allocation: the holdings grouped by class.
    const alloc = CLASS_ORDER.map((cls) => ({ assetClass: cls, valueCents: holdings.filter((h) => h.assetClass === cls).reduce((t, h) => t + h.valueCents, 0) })).filter((a) => a.valueCents > 0);
    const realised = s.closed ? roundHalfUp(((i + 3) * 41_250 * FUNDS['US equity'][9][priceIdx]) / 1000 * 0.12, 0) : s.noTransactions ? 0 : roundHalfUp(closing * 0.002, 0);
    const unrealised = holdings.reduce((t, h) => t + h.valueCents - h.costCents, 0);
    const adviser = s.adviser === null ? null : s.adviser ?? ADVISERS[i % ADVISERS.length];
    const custom: Record<string, unknown> = {
      accountNumber: `MW-${200 + i * 7}-${String(44173 + i * 389).slice(-5)}`, accountType: s.type,
      ...(adviser ? { adviserName: adviser[0], adviserPhone: adviser[1] } : {}),
      periodStart: q.start, periodEnd: q.end, riskProfile: s.risk,
      openingValueCents: opening, closingValueCents: closing, previousQuarterCloseCents: opening,
      contributionsCents: contributions, withdrawalsCents: withdrawals, incomeCents: income, feesCents: fees, marketChangeCents: marketChange,
      realisedGainCents: realised, unrealisedGainCents: unrealised, previousQuarterReturnBps: Math.round(s.prevRet * 100),
      ...(s.noTransactions ? { feeWaived: true } : {}),
      holdings: holdings.map((h) => ({ assetClass: w.classes[h.assetClass], fund: h.fund, code: h.code, units: unitsText(h.unitsK), priceCents: h.priceCents, valueCents: h.valueCents, costCents: h.costCents, weight: pct1(h.valueCents, closing) })),
      transactions: tx,
      assetAllocation: alloc.map((a) => ({ ...a, assetClass: w.classes[a.assetClass], weight: pct1(a.valueCents, closing) })),
    };
    if (s.noClosingValue) delete custom.closingValueCents;
    return { recordId, documentType: 'custom', projectId: MERIDIAN_ID, customer: { givenName: s.given, familyName: s.family, locale: s.es ? 'es-US' : 'en-US' }, custom } as SampleCustomer;
  });
}

export const MERIDIAN_NOTES: SampleNotes = {
  title: 'Meridian Wealth',
  kind: 'Quarterly portfolio statement',
  description: 'A quarterly investment statement: two-column summary and allocation, holdings over two pages, transactions, income and fees, and messages by risk profile, by a fall in value and by a dated fee change.',
  intendedBlockers: [
    { recordId: 'MWS-60018', code: 'CALCULATION_MISSING', path: 'calc.largestWeightPct', reason: 'Demonstration: this customer’s data does not reconcile — the custodian sent no closing value although the holdings are listed, so the change in value and the share of the largest holding (which decides the concentration notice) cannot be worked out.' },
    { recordId: 'MWS-60012', code: 'REQUIRED_TRANSLATION_MISSING', path: 'commentary-aggressive', reason: 'Demonstration: the aggressive-growth commentary has only a draft Spanish text, and this Spanish-speaking client has an aggressive profile.' },
    { recordId: 'MWS-60027', code: 'REQUIRED_TRANSLATION_MISSING', path: 'commentary-aggressive', reason: 'Demonstration: the same draft Spanish commentary, for the second Spanish-speaking aggressive client.' },
  ],
  knownDataProblems: [
    { recordId: 'MWS-60014', code: 'NULL_BINDING', nodeId: 'adviser', reason: 'A self-directed account with no adviser assigned; client services confirmed the statement goes out without an adviser line and the client calls the general service number.' },
  ],
  intendedShould: [{ ruleId: 'mw-no-risk-free', reason: 'Demonstration of a “should” wording rule: the fall notice says “No investment is risk-free”, which the house style would rather avoid even in a denial.' }],
  unusedFields: [
    { path: 'custom.holdings[].costCents', reason: 'Carried for the unrealized gain; the accuracy check adds it up.' },
    { path: 'custom.assetAllocation[].weight', reason: 'Carried for the client portal; the chart shows amounts.' },
  ],
  missingCalcs: [
    { recordId: 'MWS-60018', key: 'changeInValue', reason: 'The deliberate non-reconciling customer (no closing value).' },
    { recordId: 'MWS-60018', key: 'changePct', reason: 'Worked out from the missing closing value.' },
    { recordId: 'MWS-60018', key: 'largestWeightPct', reason: 'Worked out from the missing closing value.' },
    { recordId: 'MWS-60014', key: 'adviserLine', reason: 'The known data problem: no adviser.' },
  ],
  // Every text approved in Spanish except four drafts: the aggressive-growth commentary and its heading (the
  // demonstration blockers) and two fixed phrases the sample customers never see.
  translations: { 'es-US': { approved: 118, draft: 4, missing: 0 } },
  mappings: { 'print-house': 'complete', 'client-portal': 'incomplete' },
  pages: { 'MWS-60011': 3 },
};
