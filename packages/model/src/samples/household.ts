import { blankProject } from '../templates';
import type { CalculatedField, CustomField, Predicate } from '../types';
import { addDays, container, fixed, flow, lt, metric, SampleBuilder, text, type SampleCustomer } from './kit';

/**
 * "Household accounts statement": the example of the richer data shapes (wave 5, section 2). A customer has a mailing
 * address (a group of fields) and one to four accounts (a list); each account has a holder (a group inside the item)
 * and its transactions (a list inside the list). The document repeats one section per account with the account's own
 * table, subtotal (a calculation per account) and an "overdrawn" line shown for that account only; a rule over the
 * accounts ("any account is overdrawn") chooses the notice at the top.
 *
 * Built by code through the ordinary commands, like the other examples, with 20 synthetic customers. It is used by
 * tests (unit, API and browser) and is NOT one of the gallery's seeded samples: adding it there would change the sample
 * counts every other test relies on.
 */

export const HOUSEHOLD_ID = 'household-accounts';
const ACCENT = '#2F5D8A';

export const HOUSEHOLD_FIELDS: CustomField[] = [
  { key: 'statementDate', label: 'Statement date', type: 'date', required: true, example: '2026-10-31' },
  { key: 'householdName', label: 'Household name', type: 'string', example: 'The Abbott household' },
  {
    key: 'mailing', label: 'Mailing address', type: 'group',
    fields: [
      { key: 'street', label: 'Street', type: 'string', required: true, example: '12 Harbour Lane' },
      { key: 'city', label: 'City', type: 'string', required: true, example: 'Calder Bay' },
      { key: 'state', label: 'State', type: 'string', example: 'MI' },
      { key: 'postcode', label: 'Postcode', type: 'string', example: '49012' },
    ],
  },
  {
    key: 'accounts', label: 'Accounts', type: 'list', required: true,
    itemFields: [
      { key: 'number', label: 'Account number', type: 'string' },
      { key: 'kind', label: 'Account type', type: 'string' },
      { key: 'openingCents', label: 'Opening balance', type: 'cents' },
      { key: 'balanceCents', label: 'Closing balance', type: 'cents' },
      { key: 'holder', label: 'Holder', type: 'group', fields: [{ key: 'name', label: 'Name', type: 'string' }, { key: 'relation', label: 'Relation', type: 'string' }] },
      { key: 'transactions', label: 'Transactions', type: 'list', itemFields: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'description', label: 'Description', type: 'string' }, { key: 'amountCents', label: 'Amount', type: 'cents' }] },
    ],
  },
];

export const HOUSEHOLD_CALCS: CalculatedField[] = [
  { key: 'accountSubtotal', label: 'Account subtotal', type: 'money', list: 'custom.accounts', description: 'The total of this account’s transactions.', expr: { op: 'sum', list: 'custom.accounts[].transactions', column: 'amountCents' } },
  { key: 'accountTransactionCount', label: 'Account transaction count', type: 'number', list: 'custom.accounts', expr: { op: 'count', list: 'custom.accounts[].transactions' } },
  { key: 'grandTotal', label: 'Total of all transactions', type: 'money', description: 'Every transaction on every account.', expr: { op: 'sum', list: 'custom.accounts[].transactions', column: 'amountCents' } },
  { key: 'allTransactionCount', label: 'Number of transactions', type: 'number', description: 'Transactions on every account.', expr: { op: 'count', list: 'custom.accounts[].transactions' } },
  { key: 'largestTransaction', label: 'Largest transaction', type: 'money', expr: { op: 'if', when: { op: 'gte', path: 'calc.allTransactionCount', value: 1 }, then: { op: 'largest', list: 'custom.accounts[].transactions', column: 'amountCents' }, else: { op: 'money', cents: 0 } } },
  { key: 'totalBalance', label: 'Total of closing balances', type: 'money', expr: { op: 'sum', list: 'custom.accounts', column: 'balanceCents' } },
];

/** "Any account is overdrawn". */
export const ANY_OVERDRAWN: Predicate = { op: 'items', path: 'custom.accounts', match: 'any', where: lt('custom.accounts[].balanceCents', 0) };
/** "Every account had at least one transaction". */
export const EVERY_ACTIVE: Predicate = { op: 'items', path: 'custom.accounts', match: 'every', where: { op: 'gte', path: 'custom.accounts[].transactions.count', value: 1 } };

export function buildHousehold() {
  const b = new SampleBuilder(blankProject({ projectId: HOUSEHOLD_ID, title: 'Household accounts statement', issuerName: 'Calder Bay Credit Union', accent: ACCENT }));
  b.project = { ...b.project, issuer: { ...b.project.issuer, product: 'Household accounts statement' } };
  b.run({ type: 'SET_CUSTOM_FIELDS', fields: HOUSEHOLD_FIELDS });
  for (const field of HOUSEHOLD_CALCS) b.run({ type: 'UPSERT_CALCULATED_FIELD', field });

  b.insert({ id: 'document-header', type: 'header-footer', name: 'Synthetic data notice', headerFooter: { role: 'document-header', text: 'SYNTHETIC DEMO DATA · Calder Bay Credit Union is fictional · Not a real statement', repeat: false }, layout: fixed(40, 40, 532, 20, 'first', { area: 'header', span: 12 }) });
  b.insert({ id: 'page-footer', type: 'header-footer', name: 'Page footer', headerFooter: { role: 'page-footer', text: 'Calder Bay Credit Union (fictional) · Synthetic demonstration', repeat: true }, layout: fixed(40, 752, 532, 20, 'all', { area: 'footer', span: 12 }) });
  b.insert(text('statement-title', 'Statement title', '# Your household accounts\n**{{customer.givenName}} {{customer.familyName}}** · {{custom.householdName}}\n{{custom.mailing.street}}, {{custom.mailing.city}} {{custom.mailing.state}} {{custom.mailing.postcode}}\nStatement date {{custom.statementDate}}', flow({ spaceBeforePt: 0 })));
  b.insert(container('totals', 'Totals', flow({ direction: 'row', spaceBeforePt: 8 }, { area: 'main', span: 12, direction: 'row' })));
  b.insert(metric('grand-total', 'Total of all transactions', 'calc.grandTotal', 'usd-cents', 'primary', flow({ widthPct: 33 })), 'totals');
  b.insert(metric('total-balance', 'Total of closing balances', 'calc.totalBalance', 'usd-cents', 'secondary', flow({ widthPct: 33 })), 'totals');
  b.insert(metric('largest-transaction', 'Largest transaction', 'calc.largestTransaction', 'usd-cents', 'secondary', flow({ widthPct: 33 })), 'totals');

  b.message({ id: 'account-notice', name: 'Account notice', layout: flow({ spaceBeforePt: 10 }) }, [
    { id: 'notice-overdrawn', title: 'An account is overdrawn', text: '**One of your accounts is overdrawn.** Please bring it back above zero to avoid fees. The account is marked below.' },
    { id: 'notice-active', title: 'Every account was used', text: 'Every account in your household was used this month. Thank you for banking with us.' },
    { id: 'notice-quiet', title: 'Standard notice', text: 'Here is a summary of your household’s accounts.', fallback: true },
  ]);
  b.rule({ id: 'R01', title: 'Any account is overdrawn', mode: 'exclusive', priority: 200, exclusiveGroup: 'account-notice', when: ANY_OVERDRAWN, then: { op: 'selectVariant', targetNodeId: 'account-notice', variantId: 'notice-overdrawn' } });
  b.rule({ id: 'R02', title: 'Every account was used', mode: 'exclusive', priority: 100, exclusiveGroup: 'account-notice', when: { op: 'and', args: [EVERY_ACTIVE, { op: 'gte', path: 'custom.accounts.count', value: 1 }] }, then: { op: 'selectVariant', targetNodeId: 'account-notice', variantId: 'notice-active' } });

  // The repeating section: laid out once, repeated for each account.
  b.insert(container('accounts-section', 'Accounts', flow({ spaceBeforePt: 12 }), { repeat: { list: 'custom.accounts', keepHeading: true } }));
  b.insert(text('account-heading', 'Account heading', '## {{custom.accounts[].kind}} account {{custom.accounts[].number}}\nHeld by {{custom.accounts[].holder.name}} ({{custom.accounts[].holder.relation}}) · Opening balance {{custom.accounts[].openingCents}}', flow({ spaceBeforePt: 14 })), 'accounts-section');
  b.insert(text('account-overdrawn', 'Overdrawn line', '**This account is overdrawn.** Its closing balance is {{custom.accounts[].balanceCents}}.', flow({ spaceBeforePt: 4 }), { visibleWhen: lt('custom.accounts[].balanceCents', 0) }), 'accounts-section');
  b.insert({
    id: 'account-transactions', type: 'repeating-table', name: 'Account transactions', binding: 'custom.accounts[].transactions', caption: 'Transactions', flowContinuation: true, repeatHeader: 'always', sortable: true, filterable: true,
    totalFrom: 'calc.accountSubtotal',
    columns: [
      { key: 'date', label: 'Date', format: 'date' },
      { key: 'description', label: 'Description', format: 'text' },
      { key: 'amountCents', label: 'Amount', format: 'usd-cents', align: 'right', total: true },
    ],
    layout: flow({ spaceBeforePt: 6 }),
  }, 'accounts-section');
  b.insert({ id: 'account-balance', type: 'bound-field', name: 'Closing balance', label: 'Closing balance', binding: 'custom.accounts[].balanceCents', formatter: 'usd-cents', nullPolicy: 'fallback', fallbackText: '—', layout: flow({ spaceBeforePt: 4 }) }, 'accounts-section');
  b.insert(text('closing', 'Closing', 'Questions? Call us on 555-0100 (fictional).', flow({ spaceBeforePt: 14 })));
  return b.project;
}

/* ------------------------------------------------------------------ customers */

const GIVEN = ['Avery', 'Bianca', 'Callum', 'Daniela', 'Elliot', 'Farah', 'Gideon', 'Hannah', 'Imani', 'Julian', 'Keiko', 'Lucas', 'Maya', 'Nolan', 'Olivia', 'Priya', 'Quentin', 'Rosa', 'Samuel', 'Thandi'];
const FAMILY = ['Abbott', 'Bennett', 'Castillo', 'Dlamini', 'Eriksen', 'Fraser', 'Gupta', 'Hughes', 'Ibarra', 'Jensen', 'Kowalski', 'Lindgren', 'Moreno', 'Nakamura', 'Okafor', 'Petrov', 'Quinn', 'Romero', 'Sato', 'Tanaka'];
const KINDS = ['Checking', 'Savings', 'Joint checking', 'Holiday savings'];
const SHOPS = ['Harbour Grocers', 'Calder Bay Transit', 'Lakeside Pharmacy', 'Bayview Utilities', 'Pier 9 Café', 'Northside Books', 'Salary', 'Transfer in', 'Transfer out', 'Card refund'];
/** Accounts per customer (1 to 4) and transactions per account (0 to 40), including the edges: none, one and many. */
const SHAPES: number[][] = [
  [3], [0], [1], [12, 4], [40, 38, 36, 40], [5, 0, 7], [2, 2], [25], [8, 1, 0, 3], [15, 15],
  [6], [0, 0], [30, 2, 9], [4, 4, 4, 4], [11], [1, 1], [19, 7], [3, 0, 22, 5], [9], [14, 6, 2],
];
/** Customers whose first account ends overdrawn. */
const OVERDRAWN = new Set([2, 4, 8, 13, 17]);

/** The synthetic customers of the household statement. Ids are stable (`HHA-60001` …); every closing balance is its opening balance plus its transactions. */
export function householdCustomers(): SampleCustomer[] {
  return SHAPES.map((counts, i) => {
    const statementDate = addDays('2026-10-31', -(i % 3) * 30);
    const accounts = counts.map((n, a) => {
      const transactions = Array.from({ length: n }, (_, t) => {
        const seed = (i * 131 + a * 37 + t * 17) % 997;
        const shop = SHOPS[seed % SHOPS.length];
        const credit = shop === 'Salary' || shop === 'Transfer in' || shop === 'Card refund';
        const amount = (credit ? 1 : -1) * (500 + ((seed * 53) % 24000));
        return { date: addDays(statementDate, -30 + Math.floor((t * 30) / Math.max(1, n))), description: shop, amountCents: amount };
      });
      const moved = transactions.reduce((s, t) => s + t.amountCents, 0);
      const overdraw = OVERDRAWN.has(i) && a === 0;
      const openingCents = overdraw ? -moved - 1250 - i * 10 : 20000 + ((i * 7919 + a * 104729) % 500000) - Math.min(0, moved);
      return {
        number: `${7100 + i * 13 + a}-${String(3000 + i * 37 + a * 101).padStart(4, '0')}`,
        kind: KINDS[(i + a) % KINDS.length],
        openingCents,
        balanceCents: openingCents + moved,
        holder: { name: a === 1 ? `${GIVEN[(i + 7) % GIVEN.length]} ${FAMILY[i]}` : `${GIVEN[i]} ${FAMILY[i]}`, relation: a === 1 ? 'Partner' : a === 2 ? 'Child' : 'Self' },
        transactions,
      };
    });
    return {
      recordId: `HHA-${60001 + i}`, documentType: 'custom', projectId: HOUSEHOLD_ID,
      customer: { givenName: GIVEN[i], familyName: FAMILY[i], locale: 'en-US' },
      custom: {
        statementDate, householdName: `The ${FAMILY[i]} household`,
        mailing: { street: `${10 + i * 3} Harbour Lane`, city: 'Calder Bay', state: 'MI', postcode: String(49010 + i) },
        accounts,
      },
      demonstrationOnly: true,
    } as SampleCustomer;
  });
}
