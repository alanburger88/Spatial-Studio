import { describe, expect, it } from 'vitest';
import { defaultNode, type Project } from '@iss/model';
import { indexTree, resolve } from '../src';
import { gymMember, gymProject, run } from '../../model/test/helpers/customProject';

/**
 * A chart over a list that is a series in time (monthly use) keeps the order of the list's rows (`order: 'data'`), and
 * with a limit shows the last rows; without the option the biggest come first, as before.
 */
describe('chart order', () => {
  const sessions = [
    { day: '2026-11-01', className: 'Yoga', priceCents: 900, spots: 1 },
    { day: '2026-11-02', className: 'Spin', priceCents: 1200, spots: 1 },
    { day: '2026-11-03', className: 'Pilates', priceCents: 1500, spots: 1 },
    { day: '2026-11-04', className: 'Row', priceCents: 300, spots: 1 },
  ];
  const withChart = (order?: 'value' | 'data', limit?: number): Project => {
    const p = gymProject();
    return run(p, { type: 'INSERT_NODE', parentId: 'doc-root', node: { ...defaultNode('chart', 'by-class', 'custom', p), binding: 'custom.sessions', chart: { kind: 'bar', title: 'By class', groupBy: 'className', valueKey: 'priceCents', limit: limit ?? 5, ...(order ? { order } : {}) } } });
  };
  const labels = (p: Project) => indexTree(resolve({ project: p, record: gymMember({ custom: { sessions } }) }).root).get('by-class')!.chart!.data.map((d) => d.label);

  it('puts the biggest first by default, as before', () => {
    expect(labels(withChart())).toEqual(['Pilates', 'Spin', 'Yoga', 'Row']);
    expect(labels(withChart('value', 2))).toEqual(['Pilates', 'Spin']);
  });
  it('keeps the rows’ order with order “data”, and shows the last rows when there are more than the limit', () => {
    expect(labels(withChart('data'))).toEqual(['Yoga', 'Spin', 'Pilates', 'Row']);
    expect(labels(withChart('data', 2))).toEqual(['Pilates', 'Row']);
  });
});

/** A table of a document with its own data has a total only when a column is marked for it (types.ts `TableColumn.total`). */
describe('table totals in a document with its own data', () => {
  const withTable = (total: boolean): Project => {
    const g = gymProject();
    const p = run(g, { type: 'SET_CUSTOM_FIELDS', fields: [...g.customFields!, { key: 'payments', label: 'Payments', type: 'list', itemFields: [{ key: 'kind', label: 'Kind', type: 'string' }, { key: 'amountCents', label: 'Amount', type: 'cents' }] }] });
    return run(p, { type: 'INSERT_NODE', parentId: 'doc-root', node: { ...defaultNode('repeating-table', 'pay-table', 'custom', p), binding: 'custom.payments', columns: [{ key: 'kind', label: 'Kind' }, { key: 'amountCents', label: 'Amount', format: 'usd-cents', align: 'right', ...(total ? { total: true } : {}) }] } });
  };
  const totalOf = (p: Project) => indexTree(resolve({ project: p, record: gymMember({ custom: { payments: [{ kind: 'Fee', amountCents: 500 }, { kind: 'Dividend', amountCents: 1200 }] } }) }).root).get('pay-table')!.table!.totalCents;
  it('does not sum a column called amountCents unless it is marked', () => expect(totalOf(withTable(false))).toBeUndefined());
  it('sums the marked column', () => expect(totalOf(withTable(true))).toBe(1700));
});
