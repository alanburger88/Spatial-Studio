import { channelConfig, defaultNode, richFromMarkup, type CalculatedField, type LookupTable, type Project, type Rule } from '../../src';
import { gymProject, run } from './customProject';

/**
 * The gym membership notice (customProject.ts) with the rules-and-data-depth features, built through the command bus:
 * calculated fields, two lookup tables (one by exact text, one by a range of dates read with the document's date),
 * a dated rule, a dated alternative, a dated conditional section, wording and an SMS that show calculated values, and a
 * table footer that shows a calculated total. Test-only: the seed projects and fixtures are never changed.
 */

export const FEE_BY_TIER: LookupTable = {
  id: 'feeByTier', title: 'Late fee by tier',
  keys: [{ key: 'tier', label: 'Membership tier', match: 'text' }],
  columns: [{ key: 'lateFee', label: 'Late fee', type: 'money' }, { key: 'note', label: 'Note', type: 'text' }],
  rows: [
    { keys: { tier: 'basic' }, values: { lateFee: 1500, note: 'Basic' } },
    { keys: { tier: 'plus' }, values: { lateFee: 1000, note: 'Plus' } },
  ],
};

export const RATES: LookupTable = {
  id: 'rates', title: 'Bonus points rate',
  keys: [{ key: 'period', label: 'In effect', match: 'date-range' }],
  columns: [{ key: 'rate', label: 'Rate', type: 'number' }],
  rows: [
    { keys: { period: { from: '2026-01-01', until: '2027-01-01' } }, values: { rate: 1.5 } },
    { keys: { period: { from: '2027-01-01' } }, values: { rate: 2 } },
  ],
};

export const DEPTH_CALCS: CalculatedField[] = [
  { key: 'daysToRenewal', label: 'Days to renewal', type: 'number', expr: { op: 'days', from: { op: 'issueDate' }, to: { op: 'field', path: 'custom.renewalDate' } } },
  { key: 'spinTotal', label: 'Spin total', type: 'money', expr: { op: 'sum', list: 'custom.sessions', column: 'priceCents', where: { op: 'eq', path: 'className', value: 'Spin' } } },
  { key: 'feePerVisit', label: 'Fee per visit', type: 'money', expr: { op: 'round', places: 2, arg: { op: 'div', a: { op: 'field', path: 'custom.monthlyFeeCents' }, b: { op: 'field', path: 'custom.visits' } } } },
  { key: 'lateFee', label: 'Late fee', type: 'money', expr: { op: 'lookup', table: 'feeByTier', column: 'lateFee', keys: [{ op: 'field', path: 'custom.tier' }] } },
  { key: 'bonusRate', label: 'Bonus rate', type: 'number', expr: { op: 'lookup', table: 'rates', column: 'rate', keys: [{ op: 'issueDate' }] } },
  { key: 'renewSoon', label: 'Renews soon', type: 'bool', expr: { op: 'if', when: { op: 'lt', path: 'calc.daysToRenewal', value: 14 }, then: { op: 'bool', value: true }, else: { op: 'bool', value: false } } },
];

const rule = (id: string, title: string, priority: number, when: Rule['when'], variantId: string, extra: Partial<Rule> = {}): Rule =>
  ({ id, scope: 'custom', mode: 'exclusive', priority, when, then: { op: 'selectVariant', targetNodeId: 'renewal-note', variantId }, version: 1, enabled: true, title, exclusiveGroup: 'renewal-note', ...extra });

/** `dateFrom`: where the document's date comes from (default: given for the run). */
export function depthProject(opts: { dateFrom?: 'run' | 'field' } = {}): Project {
  let p = gymProject();
  if (opts.dateFrom === 'field') p = run(p, { type: 'SET_CUSTOM_FIELDS', fields: [...p.customFields!, { key: 'statementDate', label: 'Statement date', type: 'date' }] });
  p = run(p, { type: 'SET_DOCUMENT_DATE', source: opts.dateFrom === 'field' ? { source: 'field', path: 'custom.statementDate' } : { source: 'run' } });
  p = run(p, { type: 'UPSERT_LOOKUP_TABLE', table: FEE_BY_TIER });
  p = run(p, { type: 'UPSERT_LOOKUP_TABLE', table: RATES });
  for (const field of DEPTH_CALCS) p = run(p, { type: 'UPSERT_CALCULATED_FIELD', field });
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'renewal-note', variantId: 'note-soon', title: 'Renews soon', text: 'Your plan renews in {{calc.daysToRenewal}} days.' });
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'renewal-note', variantId: 'note-winter', title: 'Winter offer', text: 'Winter offer for Plus members.' });
  p = run(p, { type: 'ADD_VARIANT', nodeId: 'renewal-note', variantId: 'note-newyear', title: 'New year offer', text: 'New year offer for Basic members.' });
  p = run(p, { type: 'SET_VARIANT_PERIOD', nodeId: 'renewal-note', variantId: 'note-winter', period: { from: '2026-12-01', until: '2027-03-01' } });
  p = run(p, { type: 'UPSERT_RULE', rule: rule('R03', 'Renews within two weeks', 250, { op: 'eq', path: 'calc.renewSoon', value: true }, 'note-soon') });
  p = run(p, { type: 'UPSERT_RULE', rule: rule('R04', 'New year offer for Basic', 260, { op: 'eq', path: 'custom.tier', value: 'basic' }, 'note-newyear', { effective: { from: '2027-01-01' } }) });
  p = run(p, { type: 'UPSERT_RULE', rule: rule('R05', 'Winter offer for Plus', 150, { op: 'eq', path: 'custom.tier', value: 'plus' }, 'note-winter') });
  // Wording, a dated conditional section and a footer total that show calculated values.
  p = run(p, { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'fee-note', 'custom', p), name: 'Fee note', content: richFromMarkup('Late fee: {{calc.lateFee}}. Per visit: {{calc.feePerVisit}}. Bonus rate: {{calc.bonusRate}}.') }, parentId: 'doc-root' });
  p = run(p, { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'spin-note', 'custom', p), name: 'Spin note', content: richFromMarkup('You spent {{calc.spinTotal}} on Spin.'), visibleWhen: { op: 'gt', path: 'calc.spinTotal', value: 0 } }, parentId: 'doc-root' });
  p = run(p, { type: 'SET_SECTION_PERIOD', nodeId: 'spin-note', period: { until: '2027-06-01' } });
  p = run(p, { type: 'UPDATE_NODE', nodeId: 'sessions', patch: { totalFrom: 'calc.spinTotal' } });
  const ch = channelConfig(p);
  return run(p, { type: 'SET_CHANNELS', channels: { ...ch, sms: { text: 'Hi {{customer.givenName}}, your plan renews in {{calc.daysToRenewal}} days. {{link}}' } } });
}
