import { describe, expect, it } from 'vitest';
import {
  applyCommand, allFieldIndex, blankProject, buildContext, checkFormula, conditionInWords, customFieldUsage, evaluateCalculations, exprScopeOf, formulaInWords, itemCalculations,
  itemFieldDefs, parseFormula, printCondition, printFormula, projectFieldIndex, projectFields, validateCustomFields, validatePredicate, wordsScopeOf,
  type CustomField, type ItemsCondition, type Predicate, type Project,
} from '@iss/model';
import { ANY_OVERDRAWN, EVERY_ACTIVE, buildHousehold, householdCustomers } from '@iss/model/samples/index';
import { evaluatePredicate, indexTree, resolve } from '@iss/resolver';
import { baselineCustomer, coverageGaps, planTestData } from '@iss/scenarios';

/** Richer data shapes (wave 5, section 2): the engine, the document side and test customers. */
const project = buildHousehold();
const customers = householdCustomers();
const ok = (p: Project, cmd: Parameters<typeof applyCommand>[1]) => { const r = applyCommand(p, cmd); if (!r.ok) throw new Error(r.message); return r.project; };
const refused = (p: Project, cmd: Parameters<typeof applyCommand>[1]) => { const r = applyCommand(p, cmd); expect(r.ok).toBe(false); return r.ok ? '' : r.message; };
const list = (itemFields: unknown[]): CustomField => ({ key: 'accounts', label: 'Accounts', type: 'list', itemFields } as CustomField);

describe('the shapes of the data fields', () => {
  it('accepts a group at the top level and in a list item, and a list inside a list item', () => {
    expect(validateCustomFields('custom', project.customFields!)).toEqual([]);
  });

  it('refuses a third level, a group in a group, a list in a group and a group in an inner list, in plain words', () => {
    const third = validateCustomFields('custom', [list([{ key: 'tx', label: 'Transactions', type: 'list', itemFields: [{ key: 'splits', label: 'Splits', type: 'list', itemFields: [{ key: 'a', label: 'A', type: 'cents' }] }] }])]);
    expect(third.join(' ')).toContain('cannot hold another list. Lists go at most two levels deep');
    const groupInGroup = validateCustomFields('custom', [{ key: 'address', label: 'Address', type: 'group', fields: [{ key: 'geo', label: 'Geo', type: 'group' as never }] }]);
    expect(groupInGroup.join(' ')).toContain('cannot hold another group');
    const listInGroup = validateCustomFields('custom', [{ key: 'address', label: 'Address', type: 'group', fields: [{ key: 'lines', label: 'Lines', type: 'list' as never }] }]);
    expect(listInGroup.join(' ')).toContain('cannot hold a list');
    const groupInInner = validateCustomFields('custom', [list([{ key: 'tx', label: 'Transactions', type: 'list', itemFields: [{ key: 'who', label: 'Who', type: 'group', fields: [] }] }])]);
    expect(groupInInner.join(' ')).toContain('cannot hold a group');
    expect(validateCustomFields('custom', [{ key: 'address', label: 'Address', type: 'group', fields: [] }]).join(' ')).toContain('needs at least one field');
  });

  it('gives paths custom.address.city, custom.accounts[].number and custom.accounts[].transactions[].amountCents, with names a person reads', () => {
    const top = projectFieldIndex(project);
    expect(top.get('custom.mailing.city')).toMatchObject({ type: 'string', label: 'Mailing address: City', group: 'Mailing address' });
    expect(top.get('custom.accounts')!.itemFields!.map((c) => c.key)).toEqual(['number', 'kind', 'openingCents', 'balanceCents', 'holder.name', 'holder.relation']);
    expect(top.has('custom.accounts[].number')).toBe(false);
    const items = new Map(itemFieldDefs(project.customFields, project.calculatedFields).map((f) => [f.path, f]));
    expect(items.get('custom.accounts[].number')).toMatchObject({ label: 'Account number', item: 'custom.accounts' });
    expect(items.get('custom.accounts[].holder.name')).toMatchObject({ label: 'Holder: Name' });
    expect(items.get('custom.accounts[].transactions')).toMatchObject({ type: 'array', item: 'custom.accounts' });
    expect(items.get('custom.accounts[].transactions[].amountCents')).toMatchObject({ type: 'cents', item: 'custom.accounts[].transactions' });
    expect(items.get('calc.accountSubtotal')).toMatchObject({ calculated: true, item: 'custom.accounts' });
    expect(projectFields(project).some((f) => f.path === 'calc.accountSubtotal')).toBe(false);
    expect(allFieldIndex(project).has('custom.accounts[].transactions[].date')).toBe(true);
  });

  it('a field of a group, a list or a column still in use cannot be removed (renames are a removal and an addition, as before)', () => {
    const without = project.customFields!.map((f) => (f.key === 'accounts' ? { ...f, itemFields: f.itemFields!.filter((c) => c.key !== 'balanceCents') } : f));
    expect(refused(project, { type: 'SET_CUSTOM_FIELDS', fields: without })).toMatch(/balanceCents is still used by|A rule no longer validates/);
    expect(customFieldUsage(project).map((u) => u.path)).toEqual(expect.arrayContaining(['custom.accounts', 'custom.accounts[].balanceCents', 'custom.mailing.city', 'custom.accounts[].holder.name']));
  });
});

describe('calculations per item and across the items', () => {
  it('a subtotal for each account, a total, a count and the largest across every account’s transactions', () => {
    const r = customers[4];
    const ctx = buildContext(r) as Record<string, unknown>;
    const out = evaluateCalculations(project, ctx, null);
    const accounts = r.custom.accounts as Array<{ transactions: Array<{ amountCents: number }> }>;
    const sums = accounts.map((a) => a.transactions.reduce((s, t) => s + t.amountCents, 0));
    expect(itemCalculations(ctx, 'custom.accounts')!.map((v) => v.accountSubtotal)).toEqual(sums);
    expect(out.values.grandTotal).toBe(sums.reduce((a, b) => a + b, 0));
    expect(out.values.allTransactionCount).toBe(accounts.reduce((s, a) => s + a.transactions.length, 0));
    expect(out.values.largestTransaction).toBe(Math.max(...accounts.flatMap((a) => a.transactions.map((t) => t.amountCents))));
    expect(out.values).not.toHaveProperty('accountSubtotal');
  });

  it('formula text, type check and plain words cover item paths and the whole document', () => {
    const scope = exprScopeOf(project, 'custom.accounts');
    const sub = checkFormula('=SUM(custom.accounts[].transactions.amountCents)', scope);
    expect(sub.ok && sub.type).toBe('money');
    const words = wordsScopeOf(project, scope.fields);
    expect(formulaInWords(project.calculatedFields!.find((c) => c.key === 'accountSubtotal')!.expr, words)).toBe('The total of “Amount” in “Transactions”.');
    expect(formulaInWords(project.calculatedFields!.find((c) => c.key === 'grandTotal')!.expr, wordsScopeOf(project, projectFieldIndex(project)))).toBe('The total of “Amount” in “Transactions” of every item of “Accounts”.');
    // An item's own field outside the item, and a calculation of the items used for the whole document, are refused.
    const top = exprScopeOf(project);
    const a = checkFormula('=custom.accounts[].balanceCents', top);
    expect(!a.ok && a.errors[0].message).toContain('belongs to each item of “Accounts”');
    const b = checkFormula('=calc.accountSubtotal + $1.00', top);
    expect(!b.ok && b.errors[0].message).toContain('is worked out for each item of “Accounts”');
    expect(printFormula(project.calculatedFields!.find((c) => c.key === 'accountSubtotal')!.expr)).toBe('=SUM(custom.accounts[].transactions.amountCents)');
  });

  it('a calculation that belongs to a list is refused for a list the document does not have', () => {
    const msg = refused(project, { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'x', label: 'X', type: 'money', list: 'custom.nothing', expr: { op: 'money', cents: 1 } } });
    expect(msg).toContain('is not one of this document’s lists');
  });
});

describe('conditions about the items of a list', () => {
  const ctxOf = (accounts: unknown[]) => buildContext({ ...customers[0], custom: { ...customers[0].custom, accounts } } as never);
  const acct = (balanceCents: number, n = 1) => ({ balanceCents, transactions: Array.from({ length: n }, () => ({ amountCents: 1 })) });
  const q = (match: 'any' | 'every' | 'none' | 'atLeast', count?: number): ItemsCondition => ({ op: 'items', path: 'custom.accounts', match, ...(count ? { count } : {}), where: { op: 'lt', path: 'custom.accounts[].balanceCents', value: 0 } });

  it('any, every, none and at least N, with an empty list', () => {
    const cases: Array<[unknown[], Record<string, boolean>]> = [
      [[], { any: false, every: true, none: true, at2: false }],
      [[acct(5)], { any: false, every: false, none: true, at2: false }],
      [[acct(-5), acct(5)], { any: true, every: false, none: false, at2: false }],
      [[acct(-5), acct(-1)], { any: true, every: true, none: false, at2: true }],
    ];
    for (const [accounts, want] of cases) {
      const ctx = ctxOf(accounts);
      expect({ any: evaluatePredicate(q('any'), ctx), every: evaluatePredicate(q('every'), ctx), none: evaluatePredicate(q('none'), ctx), at2: evaluatePredicate(q('atLeast', 2), ctx) }, JSON.stringify(accounts)).toEqual(want);
    }
    expect(evaluatePredicate(EVERY_ACTIVE, ctxOf([acct(1, 0), acct(1, 3)]))).toBe(false);
  });

  it('validates, prints, reads back and says them in words', () => {
    const fields = projectFieldIndex(project);
    expect(validatePredicate(ANY_OVERDRAWN, fields)).toEqual([]);
    expect(validatePredicate({ ...q('atLeast'), count: 0 }, fields).join(' ')).toContain('“At least” needs a whole number');
    expect(validatePredicate({ ...q('any'), where: { op: 'lt', path: 'custom.accounts[].nothing', value: 0 } }, fields).join(' ')).toContain('Unknown field path');
    expect(validatePredicate({ op: 'lt', path: 'custom.accounts[].balanceCents', value: 0 }, fields).join(' ')).toContain('Unknown field path');
    const text = printCondition(q('atLeast', 2), fields);
    expect(text).toBe('AT_LEAST(2, custom.accounts WHERE custom.accounts[].balanceCents < $0.00)');
    const back = parseFormula(`=IF(${text}, 1, 0)`);
    expect(back.ok && back.expr).toEqual({ op: 'if', when: q('atLeast', 2), then: { op: 'number', value: 1 }, else: { op: 'number', value: 0 } });
    expect(printCondition(ANY_OVERDRAWN, fields)).toBe('ANY(custom.accounts WHERE custom.accounts[].balanceCents < $0.00)');
    expect(conditionInWords(ANY_OVERDRAWN, wordsScopeOf(project, fields))).toBe('for any item of “Accounts”, “Closing balance” is less than $0.00');
  });
});

describe('the repeating section', () => {
  it('lays its content out once per account, the first with the components’ own ids, later ones as <id>~<n>', () => {
    const r = customers[5];
    const res = resolve({ project, record: r });
    expect(res.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    const tree = indexTree(res.root);
    const section = tree.get('accounts-section')!;
    expect(section.repeat).toEqual({ list: 'custom.accounts', label: 'Accounts', count: 3, newPage: false, keepHeading: true });
    expect(section.children.map((c) => c.id)).toEqual(['account-heading', 'account-overdrawn', 'account-transactions', 'account-balance', 'account-heading~2', 'account-overdrawn~2', 'account-transactions~2', 'account-balance~2', 'account-heading~3', 'account-overdrawn~3', 'account-transactions~3', 'account-balance~3']);
    expect(tree.get('account-heading~2')).toMatchObject({ instanceOf: 'account-heading', repeatItem: { section: 'accounts-section', index: 2, count: 3, first: true } });
    const accounts = r.custom.accounts as Array<{ number: string; transactions: unknown[] }>;
    expect(tree.get('account-heading~3')!.text![0].inlines!.map((i) => i.text).join('')).toContain(accounts[2].number);
    expect(tree.get('account-transactions~2')!.table!.rows.length).toBe(accounts[1].transactions.length);
    expect(res.semanticManifest.tableTotalsCents['account-transactions~3']).toBe(itemSums(r)[2]);
  });

  it('shows the “overdrawn” line for the overdrawn account only, and the rule over the accounts chooses the notice', () => {
    const r = customers.find((c) => (c.custom.accounts as Array<{ balanceCents: number }>).some((a) => a.balanceCents < 0) && (c.custom.accounts as unknown[]).length > 1)!;
    const res = resolve({ project, record: r });
    const tree = indexTree(res.root);
    const accounts = r.custom.accounts as Array<{ balanceCents: number }>;
    accounts.forEach((a, i) => expect(tree.get(i ? `account-overdrawn~${i + 1}` : 'account-overdrawn')!.visible, `account ${i + 1}`).toBe(a.balanceCents < 0));
    expect(res.result).toMatchObject({ selectedVariants: { 'account-notice': 'notice-overdrawn' }, matchedRuleIds: expect.arrayContaining(['R01']) });
    expect(res.trace.find((t) => t.ruleId === 'R01')!.predicateInputs['custom.accounts']).toBe(accounts.filter((a) => a.balanceCents < 0).length);
  });

  it('with no items the section is hidden and says why, and nothing is reported about the empty layout', () => {
    const r = { ...customers[0], custom: { ...customers[0].custom, accounts: [] } };
    const res = resolve({ project, record: r as never });
    const s = indexTree(res.root).get('accounts-section')!;
    expect([s.visible, s.hiddenReason]).toEqual([false, 'No items in “Accounts” for this customer.']);
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
  });

  it('is refused inside another section, as a fixed item, for a list the document does not have; an item field cannot leave its section', () => {
    const base = ok(blankProject({ projectId: 'shapes-x', title: 'X' }), { type: 'SET_CUSTOM_FIELDS', fields: project.customFields! });
    const withBox = ok(base, { type: 'INSERT_NODE', parentId: base.rootNodeId, node: { id: 'box', type: 'container', name: 'Box', children: [] } });
    expect(refused(withBox, { type: 'INSERT_NODE', parentId: 'box', node: { id: 'rep', type: 'container', name: 'Rep', children: [], repeat: { list: 'custom.accounts' } } })).toContain('sits directly on the page');
    expect(refused(withBox, { type: 'INSERT_NODE', parentId: base.rootNodeId, node: { id: 'rep', type: 'container', name: 'Rep', children: [], repeat: { list: 'custom.nothing' } } })).toContain('is not one of this document’s own lists');
    expect(refused(withBox, { type: 'INSERT_NODE', parentId: base.rootNodeId, node: { id: 'rep', type: 'rich-text', name: 'Rep', repeat: { list: 'custom.accounts' } } })).toContain('Only a section');
    expect(refused(project, { type: 'MOVE_NODE', nodeId: 'account-overdrawn', parentId: project.rootNodeId, index: 0 })).toContain('belongs to each item of “Accounts”');
    expect(refused(project, { type: 'UPDATE_NODE', nodeId: 'closing', patch: { visibleWhen: { op: 'lt', path: 'custom.accounts[].balanceCents', value: 0 } } })).toContain('Unknown field path');
  });
});

describe('test customers for the new shapes', () => {
  it('reach every outcome, including the rule over the accounts and the line shown for one account', () => {
    const plan = planTestData(project, customers.slice(0, 3), { outcomes: true, edges: true });
    expect(plan.summary.outcomes.total).toBeGreaterThanOrEqual(7);
    expect(plan.summary.outcomes.reached).toBe(plan.summary.outcomes.total);
    for (const c of plan.customers) expect(resolve({ project, record: { ...c.record, recordId: 'REC-60001' } as never }).findings.filter((f) => f.severity === 'blocking'), c.label).toEqual([]);
    const counts = plan.customers.map((c) => ((c.record.custom as { accounts?: unknown[] }).accounts ?? []).length);
    expect(counts).toContain(0);
  });

  it('a starting customer built from the fields alone has a mailing address and accounts with none, one and many transactions', () => {
    const base = baselineCustomer(project).record.custom as { mailing: Record<string, unknown>; accounts: Array<{ holder: Record<string, unknown>; transactions: unknown[] }> };
    expect(Object.keys(base.mailing)).toEqual(['street', 'city', 'state', 'postcode']);
    expect(base.accounts.map((a) => a.transactions.length)).toEqual([1, 0, 4]);
    expect(Object.keys(base.accounts[0].holder)).toEqual(['name', 'relation']);
  });

  it('the coverage check finds a what-if for the rule over the accounts and for the line inside the section', () => {
    const calm = customers.filter((c) => (c.custom.accounts as Array<{ balanceCents: number }>).every((a) => a.balanceCents >= 0)).slice(0, 2);
    const gaps = coverageGaps(project, calm);
    for (const id of ['rule:R01', 'section:account-overdrawn']) expect(gaps.find((g) => g.id === id)?.scenario, id).toBeTruthy();
  });
});

function itemSums(r: (typeof customers)[number]): number[] {
  return (r.custom.accounts as Array<{ transactions: Array<{ amountCents: number }> }>).map((a) => a.transactions.reduce((s, t) => s + t.amountCents, 0));
}
