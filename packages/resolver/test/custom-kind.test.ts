import { describe, expect, it } from 'vitest';
import { blankProject, defaultNode, type Project } from '@iss/model';
import { explainNode, indexTree, resolve } from '../src';
import { gymMember, gymProject, run } from '../../model/test/helpers/customProject';

const blocking = (p: Project, record = gymMember()) => resolve({ project: p, record }).findings.filter((f) => f.severity === 'blocking');

describe('resolving a document with its own data', () => {
  const p = gymProject();

  it('resolves from the project’s own fields: text, amount, date, choice, yes/no and a list', () => {
    const res = resolve({ project: p, record: gymMember() });
    expect(res.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    const tree = indexTree(res.root);
    expect(tree.get('heading')!.text!.map((b) => b.inlines!.map((i) => i.text).join(''))).toEqual(['Your membership', 'Hello Robin Okoye, here is your Flex plan.']);
    expect(tree.get('fee')!.field).toMatchObject({ label: 'Monthly fee', path: 'custom.monthlyFeeCents', display: '$49.00', cents: 4900 });
    expect(tree.get('renewal')!.field).toMatchObject({ label: 'Renews on', display: 'Dec 1, 2026' });
    expect(tree.get('auto')!.field).toMatchObject({ display: 'Yes', raw: true });
    const table = tree.get('sessions')!.table!;
    expect(table).toMatchObject({ path: 'custom.sessions', caption: 'Booked sessions', totalCents: 2100 });
    expect(table.rows.map((r) => [r.cells.day.display, r.cells.className.display, r.cells.priceCents.display, r.cells.spots.display])).toEqual([['Nov 3, 2026', 'Spin', '$12.00', '2'], ['Nov 10, 2026', 'Yoga', '$9.00', '1']]);
    expect(res.semanticManifest).toMatchObject({ documentType: 'custom', money: { fee: 4900 }, tableRows: { sessions: 2 }, tableTotalsCents: { sessions: 2100 }, guardedLiabilityNodeIds: [] });
  });

  it('knows no card or claim facts and runs no card or claim checks', () => {
    const res = resolve({ project: p, record: gymMember() });
    expect(res.result.documentFacts).toEqual({});
    expect(res.semanticManifest.facts).toEqual({});
    // data and wording that would trip the card and claim checks do nothing here
    const odd = { ...gymMember(), card: { paymentStatus: 'current', missedPayments: 3, newBalanceCents: 1, transactions: [] }, claims: [{ status: 'denied-pending-review', liabilityConfirmed: false, patientResponsibilityCents: 500 }] } as never;
    const withDebtWords = run(p, { type: 'UPDATE_NODE', nodeId: 'fee', patch: { label: 'Amount due' } });
    const codes = resolve({ project: withDebtWords, record: odd }).findings.map((f) => f.code);
    for (const code of ['INCONSISTENT_PAYMENT_STATE', 'BALANCE_RECONCILIATION_FAILED', 'UNCONFIRMED_MEMBER_LIABILITY', 'CLAIM_RECONCILIATION_FAILED', 'UNCONFIRMED_DEBT_LANGUAGE']) expect(codes).not.toContain(code);
    expect(resolve({ project: withDebtWords, record: odd }).semanticManifest.identity).toEqual({ name: 'Robin Okoye' });
  });

  it('rules on the project’s own fields choose the message, by priority, and the row count shows a section', () => {
    const chosen = (custom: Record<string, unknown>) => resolve({ project: p, record: gymMember({ custom }) });
    expect(chosen({}).result).toMatchObject({ selectedVariants: { 'renewal-note': 'renewal-note-default' }, matchedRuleIds: [] });
    expect(chosen({ tier: 'pro' }).result).toMatchObject({ selectedVariants: { 'renewal-note': 'note-pro' }, matchedRuleIds: ['R01'] });
    const both = chosen({ tier: 'pro', autoRenew: false, visits: 1 });
    expect(both.result).toMatchObject({ selectedVariants: { 'renewal-note': 'note-lapsing' }, matchedRuleIds: ['R01', 'R02'] });
    expect(explainNode(both, 'renewal-note').summary).toMatch(/“We miss you”.*R02 matched/);
    expect(indexTree(both.root).get('renewal-note')!.text!.map((b) => b.inlines!.map((i) => i.text).join(''))).toEqual(['You visited 1 times this month. Your plan ends on Dec 1, 2026 unless you renew.']);

    expect(indexTree(chosen({}).root).get('busy-note')!.visible).toBe(false);
    const four = Array.from({ length: 4 }, (_, i) => ({ day: `2026-11-0${i + 1}`, className: 'Spin', priceCents: 1000, spots: 1 }));
    const busy = indexTree(chosen({ sessions: four }).root).get('busy-note')!;
    expect(busy.visible).toBe(true);
    expect(busy.text![0].inlines!.map((i) => i.text).join('')).toBe('You have 4 sessions booked. Arrive ten minutes early.');
  });

  it('a customer without the list gets an empty table, not a broken document; a list that is not a list is reported', () => {
    const { sessions: _none, ...rest } = gymMember().custom as Record<string, unknown>;
    const res = resolve({ project: p, record: { ...gymMember(), custom: rest } });
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(indexTree(res.root).get('sessions')!.table).toMatchObject({ rows: [], totalCents: undefined });
    expect(blocking(p, gymMember({ custom: { sessions: 'two' } })).map((f) => f.code)).toEqual(['INVALID_BINDING']);
  });

  it('the same goes for a card project that adds a list: sample customers without it get an empty table', async () => {
    const { seedProjects, RECORDS } = await import('@iss/model/fixtures');
    const card = seedProjects().find((x) => x.documentType === 'credit-statement')!;
    const before = resolve({ project: card, record: RECORDS[0] });
    let withList = run(card, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'offers', label: 'Offers', type: 'list', itemFields: [{ key: 'name', label: 'Offer', type: 'string' }, { key: 'valueCents', label: 'Value', type: 'cents' }] }] });
    withList = run(withList, { type: 'INSERT_NODE', node: { ...defaultNode('repeating-table', 'offers', 'credit-statement'), binding: 'custom.offers', columns: [{ key: 'name', label: 'Offer' }, { key: 'valueCents', label: 'Value', format: 'usd-cents', align: 'right', total: true }], caption: 'Offers' }, parentId: 'doc-root' });
    const plain = resolve({ project: withList, record: RECORDS[0] });
    expect(plain.findings.filter((f) => f.severity === 'blocking')).toEqual(before.findings.filter((f) => f.severity === 'blocking'));
    const rich = resolve({ project: withList, record: { ...RECORDS[0], custom: { offers: [{ name: 'Travel', valueCents: 2500 }, { name: 'Dining', valueCents: 1500 }] } } });
    expect(indexTree(rich.root).get('offers')!.table).toMatchObject({ totalCents: 4000 });
    expect(indexTree(rich.root).get('offers')!.table!.rows.map((r) => r.cells.name.display)).toEqual(['Travel', 'Dining']);
    // the card's own table still totals its amount column without being told to
    expect(indexTree(rich.root).get('transaction-table')!.table!.totalCents).toBe(indexTree(before.root).get('transaction-table')!.table!.totalCents);
  });

  it('a chart of a list shows amounts as money and whole numbers as plain numbers', () => {
    const chart = defaultNode('chart', 'by-class', 'custom', p);
    const money = run(p, { type: 'INSERT_NODE', node: chart, parentId: 'doc-root' });
    expect(indexTree(resolve({ project: money, record: gymMember() }).root).get('by-class')!.chart).toMatchObject({ title: 'Price by class', data: [{ label: 'Spin', value: 1200, display: '$12.00' }, { label: 'Yoga', value: 900, display: '$9.00' }] });
    const counts = run(p, { type: 'INSERT_NODE', node: { ...chart, chart: { ...chart.chart!, valueKey: 'spots', title: 'Spots by class' } }, parentId: 'doc-root' });
    expect(indexTree(resolve({ project: counts, record: gymMember() }).root).get('by-class')!.chart!.data).toEqual([{ label: 'Spin', value: 2, display: '2' }, { label: 'Yoga', value: 1, display: '1' }]);
  });

  it('a customer who prefers one of the project’s languages gets it, with approved wording and that language’s formats', () => {
    const es = gymProject({ withSpanish: true });
    const res = resolve({ project: es, record: gymMember({ customer: { locale: 'es-US' }, custom: { tier: 'pro' } }) });
    expect(res.locale).toBe('es-US');
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    const tree = indexTree(res.root);
    expect(tree.get('fee')!.field!.label).toBe('Cuota mensual');
    expect(tree.get('renewal-note')!.text![0].inlines!.map((i) => i.text).join('')).toBe('Como miembro Pro conserva la reserva prioritaria, Robin.');
    // English only (the blank project's own setting): the same customer simply gets English
    const en = resolve({ project: p, record: gymMember({ customer: { locale: 'es-US' }, custom: { tier: 'pro' } }) });
    expect(en.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(indexTree(en.root).get('fee')!.field!.label).toBe('Monthly fee');
  });
});

describe('resolving an empty blank project', () => {
  const blank = blankProject({ projectId: 'empty-doc', title: 'Empty', issuerName: 'Northside Gym' });
  const anyone = { recordId: 'REC-60001', documentType: 'custom' as const, customer: { givenName: 'Robin', familyName: 'Okoye', locale: 'en-US' } };

  it('resolves to an empty page with no findings, no outcomes and no identity to compare', () => {
    const res = resolve({ project: blank, record: anyone });
    expect(res.findings).toEqual([]);
    expect(res.root).toMatchObject({ id: 'doc-root', visible: true, children: [] });
    expect(res.result).toMatchObject({ documentType: 'custom', selectedVariants: {}, matchedRuleIds: [], requiredNodes: [], diagnostics: [], documentFacts: {} });
    expect(res.semanticManifest).toMatchObject({ visibleNodeIds: [], money: {}, disclosures: [], identity: {}, tableRows: {}, actions: [] });
    expect(res.channelTexts).toMatchObject({ subject: 'Your Northside Gym document is ready', title: 'Your document is ready' });
  });

  it('names the customer only as far as the document shows the name', () => {
    const first = run(blank, { type: 'INSERT_NODE', node: defaultNode('rich-text', 'hello', 'custom', blank), parentId: 'doc-root' });
    expect(resolve({ project: first, record: anyone }).semanticManifest.identity).toEqual({ name: 'Robin' });
  });

  it('refuses a customer of another kind, as before', () => {
    expect(blocking(blank, { ...anyone, documentType: 'credit-statement', card: { transactions: [] } } as never).map((f) => f.code)).toEqual(['RECORD_TYPE_MISMATCH']);
  });
});
