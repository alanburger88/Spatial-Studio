import { describe, expect, it } from 'vitest';
import { customFieldDefs, projectFileProblems, projectFromSetupSpec, validateRecordShape, type Project, type SetupSection, type SetupSpec, type SyntheticRecord } from '@iss/model';
import { resolve, type RNode } from '@iss/resolver';
import { baselineCustomer, columnLabel, dataShapeOf, planTestData, readSampleData, recordProblems, recordsFromRows, setupOutline, setupSpecFromData, type SampleRow } from '../src';
import { gymSetup } from '../../model/test/helpers/setupSpec';

const build = (spec: SetupSpec, title = spec.title) => projectFromSetupSpec(spec, { projectId: 'setup-test', title });
const blocking = (project: Project, record: SyntheticRecord) => resolve({ project, record }).findings.filter((f) => f.severity === 'blocking');
const find = (root: RNode, id: string): RNode | undefined => (root.id === id ? root : root.children.map((c) => find(c, id)).find(Boolean));
const textOf = (n: RNode | undefined): string => (n?.text ?? []).map((b) => (b.inlines ?? []).map((i) => i.text).join('')).join('\n');
const rowsOf = (format: 'csv' | 'json', data: unknown): SampleRow[] => { const r = readSampleData(format, data); if ('error' in r) throw new Error(r.error); return r.rows; };
const section = <T extends SetupSection['type']>(spec: SetupSpec, type: T) => spec.sections.filter((s) => s.type === type) as Array<Extract<SetupSection, { type: T }>>;

/** A member of the gym notice built from the setup; `custom` overrides the values that matter to a test. */
function member(project: Project, custom: Record<string, unknown> = {}, customer: Record<string, unknown> = {}): SyntheticRecord {
  const base = baselineCustomer(project).record;
  return {
    ...base, recordId: 'REC-60001',
    customer: { ...base.customer, givenName: 'Robin', familyName: 'Okoye', ...customer },
    custom: {
      planName: 'Flex', monthlyFeeCents: 4900, renewalDate: '2026-12-01', paymentStatus: 'paid', renewsAutomatically: true, visitsThisMonth: 9,
      fees: [{ description: 'Membership', chargedOn: '2026-11-01', amountCents: 4900, quantity: 1 }, { description: 'Towel service', chargedOn: '2026-11-03', amountCents: 550, quantity: 2 }],
      ...custom,
    },
  } as SyntheticRecord;
}

describe('a document built from a setup, end to end (the gym renewal notice)', () => {
  const { project, notes } = build(gymSetup());

  it('resolves without a blocking issue for a customer made from its own data fields, and for every generated test customer', () => {
    expect(notes).toEqual([]);
    expect(projectFileProblems(project)).toEqual([]);
    expect(blocking(project, { ...baselineCustomer(project).record, recordId: 'REC-0000' } as SyntheticRecord)).toEqual([]);
    const plan = planTestData(project, [], { outcomes: true, edges: true });
    expect(plan.summary.unreachable).toBe(0);
    expect(plan.summary.outcomes.reached).toBe(plan.summary.outcomes.total);
    // every version of the message is reached by some generated customer
    expect(plan.targets.filter((t) => t.kind === 'variant').map((t) => t.title)).toHaveLength(4);
    plan.customers.forEach((c, i) => {
      const record = { ...c.record, recordId: `REC-6${String(i).padStart(4, '0')}` } as SyntheticRecord;
      expect(validateRecordShape(record, 'custom', customFieldDefs(project.customFields)), c.label).toEqual([]);
      expect(blocking(project, record), c.label).toEqual([]);
    });
  });

  it('the rules choose the right version: the first condition that holds wins, and the fallback is shown when none does', () => {
    const chosen = (custom: Record<string, unknown>) => {
      const res = resolve({ project, record: member(project, custom) });
      expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
      return project.contentParts.find((c) => c.id === res.result.selectedVariants['message-5'])!.title;
    };
    expect(chosen({})).toBe('Nothing to do');
    expect(chosen({ paymentStatus: 'failed' })).toBe('Payment failed');
    expect(chosen({ paymentStatus: 'pending' })).toBe('Nothing to do');
    // an amount condition is written in dollars in the setup and compared in cents: "at least 100" is $100.00
    expect(chosen({ monthlyFeeCents: 9999 })).toBe('Nothing to do');
    expect(chosen({ monthlyFeeCents: 10000 })).toBe('Premium member');
    expect(chosen({ visitsThisMonth: 12 })).toBe('Nothing to do');
    expect(chosen({ visitsThisMonth: 13 })).toBe('Frequent visitor');
    // several hold: the version listed first wins
    expect(chosen({ visitsThisMonth: 30, monthlyFeeCents: 15000 })).toBe('Premium member');
    expect(chosen({ visitsThisMonth: 30, monthlyFeeCents: 15000, paymentStatus: 'failed' })).toBe('Payment failed');
  });

  it('mentions are filled with the customer’s own values, in the document, the email and the text message', () => {
    const res = resolve({ project, record: member(project, { paymentStatus: 'failed' }) });
    expect(textOf(find(res.root, 'heading-1'))).toBe('Your Flex membership renews soon');
    expect(find(res.root, 'heading-1')!.text![0].kind).toBe('h2');
    expect(textOf(find(res.root, 'greeting'))).toBe('Hello Robin Okoye,\nyour Flex plan renews on Dec 1, 2026 for $49.00 a month.');
    expect(textOf(find(res.root, 'message-5'))).toBe('Your last payment of $49.00 did not go through, Robin. Please update your card before Dec 1, 2026.');
    expect(textOf(find(res.root, 'notice-7'))).toBe('Fees are charged monthly in advance. You can cancel at any time before Dec 1, 2026.');
    expect(['figure-3-1', 'figure-3-2', 'figure-3-3', 'figure-3-4'].map((id) => { const f = find(res.root, id)!.field!; return `${f.label}: ${f.display}`; }))
      .toEqual(['Monthly fee: $49.00', 'Renewal date: Dec 1, 2026', 'Visits this month: 9', 'Renews automatically: Yes']);
    const table = find(res.root, 'table-4')!.table!;
    expect(table.columns.map((c) => c.label)).toEqual(['Description', 'Charged on', 'Amount']);
    expect(table.rows.map((r) => Object.values(r.cells).map((c) => c.display))).toEqual([['Membership', 'Nov 1, 2026', '$49.00'], ['Towel service', 'Nov 3, 2026', '$5.50']]);
    expect(table.totalCents).toBe(5450);
    expect(find(res.root, 'action-8')!.action).toMatchObject({ label: 'Manage your membership', url: 'https://example.com/membership' });
    expect(res.channelTexts.subject).toBe('Your Flex membership renews on Dec 1, 2026');
    expect(res.channelTexts.intro.map((b) => (b.inlines ?? []).map((i) => i.text).join('')).join(' ')).toBe('Hello Robin, here is what your renewal looks like.');
    // {Link} stays for the channel renderer, which knows the button's address
    expect(res.channelTexts.sms).toBe('DEMO Northside Gym: Your Flex membership renews on Dec 1, 2026. Details: {{link}}');
  });

  it('the outline says what will be created in plain words, with each version’s condition restated from the rule that was built', () => {
    const outline = setupOutline(gymSetup(), project);
    expect(outline.fields).toEqual([
      { label: 'Plan name', kind: 'Text', detail: 'For example Flex', required: true },
      { label: 'Monthly fee', kind: 'Amount', detail: 'For example $49.00', required: true },
      { label: 'Renewal date', kind: 'Date', detail: 'For example 2026-12-01', required: true },
      { label: 'Payment status', kind: 'Choice', detail: 'One of “paid”, “failed” and “pending”', required: false },
      { label: 'Renews automatically', kind: 'Yes or no', detail: 'For example yes', required: false },
      { label: 'Visits this month', kind: 'Whole number', detail: 'For example 9', required: false },
      { label: 'Fees', kind: 'List', detail: 'Columns: Description (text), Charged on (date), Amount (amount) and Quantity (whole number)', required: false },
    ]);
    expect(outline.sections.map((s) => s.kind)).toEqual(['Heading', 'Paragraph', 'Key figures', 'Table', 'Message', 'Divider', 'Notice', 'Button']);
    expect(outline.sections[2].text).toBe('Monthly fee, Renewal date, Visits this month and Renews automatically');
    expect(outline.sections[3].text).toBe('Fees: Description, Charged on and Amount, with the total of Amount');
    expect(outline.sections[4]).toEqual({
      kind: 'Message', text: 'Payment note: 4 versions. The versions are tried in the order listed; the first that applies is shown.',
      versions: [
        { title: 'Payment failed', fallback: false, shownWhen: 'Shown when payment status is “failed”.' },
        { title: 'Premium member', fallback: false, shownWhen: 'Shown when monthly fee is at least $100.' },
        { title: 'Frequent visitor', fallback: false, shownWhen: 'Shown when visits this month is more than 12.' },
        { title: 'Nothing to do', fallback: true, shownWhen: 'Shown when no other version applies.' },
      ],
    });
    expect(outline.sections[7].text).toBe('“Manage your membership” opens https://example.com/membership');
    expect(outline.email).toEqual({ subject: 'Your {Plan name} membership renews on {Renewal date}', intro: 'Hello {First name}, here is what your renewal looks like.' });
    expect(outline.sms).toBe('Your {Plan name} membership renews on {Renewal date}. Details: {Link}');
    // names, never ids or paths, in anything a person reads
    expect(outline.lines.join('\n')).not.toMatch(/custom\.|message-\d|R0\d|\{\{/);
    expect(outline.lines).toContain('“Premium member”: Shown when monthly fee is at least $100.');
    expect(setupOutline({ ...gymSetup(), email: undefined, sms: undefined }, project).lines.at(-1)).toBe('The email and the text message keep the standard wording.');
  });
});

const CSV = [
  'first_name,last_name,language,member_id,plan,monthly_fee,balanceCents,joined,tier,auto_renew,visits,rating,Total Visits',
  'Ana,Silva,es,000123,Flex,49.00,1250,2024-03-01,plus,yes,9,4.5,120',
  'Ben,Okoro,en-US,000124,Flex,29,0,2025-01-15,basic,no,2,3.8,14',
  'Cy,Lee,English,000125,Max,"1,099.50",99,2023-07-30,plus,yes,14,5,300',
].join('\n');

const JSON_ROWS = [
  { recordId: 'M-1', customer: { firstName: 'Dana', lastName: 'Novak', preferredLanguage: 'fr-CA' }, plan: { name: 'Flex', feeCents: 4900 }, active: true, tags: ['a', 'b'], sessions: [{ day: '2026-11-03', className: 'Spin', price: 12.5, spots: 2 }, { day: '2026-11-10', className: 'Yoga', price: 9, spots: 1 }] },
  { recordId: 'M-2', customer: { firstName: 'Eli', lastName: 'Marsh', preferredLanguage: 'en-US' }, plan: { name: 'Max', feeCents: 9900 }, active: false, tags: [], sessions: [] },
];

describe('setting a document up from sample data alone', () => {
  it('reads CSV: names and language go to the customer, each other column becomes a field of the type its name and values suggest', () => {
    const rows = rowsOf('csv', CSV);
    const { spec, notes } = setupSpecFromData(rows, { title: 'Member statement', issuerName: 'Northside Gym' });
    expect(spec).toMatchObject({ title: 'Member statement', issuerName: 'Northside Gym', summary: 'Set up from 3 sample customers: 10 data fields.' });
    expect(spec.fields).toEqual([
      { label: 'Member ID', type: 'text', example: '000123' },
      { label: 'Plan', type: 'choice', choices: ['Flex', 'Max'], example: 'Flex' },
      { label: 'Monthly fee', type: 'amount', example: '49.00' },
      { label: 'Balance', type: 'amount', example: '12.50' },
      { label: 'Joined', type: 'date', example: '2024-03-01' },
      { label: 'Tier', type: 'choice', choices: ['plus', 'basic'], example: 'plus' },
      { label: 'Auto renew', type: 'yesNo', example: 'yes' },
      { label: 'Visits', type: 'number', example: '9' },
      { label: 'Rating', type: 'text', example: '4.5' },
      { label: 'Total visits', type: 'number', example: '120' },
    ]);
    const all = notes.join('\n');
    for (const expected of [
      /“first_name”, “last_name” are used as the customer’s name, not as data fields/, /“language” is used as the customer’s language, not as a data field/,
      /“Member ID” looks like an identifier, so it is kept as text/, /“Plan” has 2 different values in the data \(Flex, Max\), so it is set up as a choice/,
      /“Monthly fee” is read as an amount in dollars, not cents, because its name says money \(49\.00 is \$49\.00\)\. If the values are whole cents, end the column name with “cents”/,
      /“Balance” is read as an amount in whole cents, because the column name says cents \(1250 is \$12\.50\)/,
      /“Rating” holds numbers with decimals that do not look like money\. A number field holds whole numbers only, so it is set up as text/,
      /4 data fields are not on the page yet \(Member ID, Tier, Auto renew, Rating\)/, /No messages or rules were set up/,
    ]) expect(all).toMatch(expected);
    // a simple page: heading, greeting, six key figures (amounts and dates first), nothing else
    expect(spec.sections).toEqual([
      { type: 'heading', text: 'Member statement' },
      { type: 'paragraph', text: 'Hello {First name} {Last name},' },
      { type: 'keyFigures', fields: ['Plan', 'Monthly fee', 'Balance', 'Joined', 'Visits', 'Total visits'] },
    ]);
    expect(spec.email).toBeUndefined();
    const { project, notes: buildNotes } = build(spec);
    expect(buildNotes).toEqual([]);
    expect(project.rules).toEqual([]);
    expect(projectFileProblems(project)).toEqual([]);

    // the same rows become this document's customers: every value converted to what its field holds
    const { records, matching, notes: rowNotes } = recordsFromRows(rows, project);
    expect(matching.map((m) => `${m.column} -> ${m.field} (${m.confidence})`)).toEqual([
      'first_name -> First name (exact)', 'last_name -> Last name (exact)', 'language -> Language (exact)', 'member_id -> Member ID (exact)', 'plan -> Plan (exact)', 'monthly_fee -> Monthly fee (exact)',
      'balanceCents -> Balance (exact)', 'joined -> Joined (exact)', 'tier -> Tier (exact)', 'auto_renew -> Auto renew (exact)', 'visits -> Visits (exact)', 'rating -> Rating (exact)', 'Total Visits -> Total visits (exact)',
    ]);
    expect(records).toEqual([
      { customer: { givenName: 'Ana', familyName: 'Silva', locale: 'es-US' }, custom: { memberID: '000123', plan: 'Flex', monthlyFeeCents: 4900, balanceCents: 1250, joined: '2024-03-01', tier: 'plus', autoRenew: true, visits: 9, rating: '4.5', totalVisits: 120 } },
      { customer: { givenName: 'Ben', familyName: 'Okoro', locale: 'en-US' }, custom: { memberID: '000124', plan: 'Flex', monthlyFeeCents: 2900, balanceCents: 0, joined: '2025-01-15', tier: 'basic', autoRenew: false, visits: 2, rating: '3.8', totalVisits: 14 } },
      { customer: { givenName: 'Cy', familyName: 'Lee', locale: 'en-US' }, custom: { memberID: '000125', plan: 'Max', monthlyFeeCents: 109950, balanceCents: 99, joined: '2023-07-30', tier: 'plus', autoRenew: true, visits: 14, rating: '5', totalVisits: 300 } },
    ]);
    expect(rowNotes).toEqual(['“monthly_fee” is read as dollars for “Monthly fee” (49 or 49.00 is $49.00).', '“balanceCents” is read as whole cents for “Balance”, because the column name says cents.']);
    for (const r of records) {
      expect(recordProblems(r, project)).toEqual([]);
      expect(blocking(project, { ...r, recordId: 'REC-60009', documentType: 'custom' } as unknown as SyntheticRecord)).toEqual([]);
    }
    const res = resolve({ project, record: { ...records[2], recordId: 'REC-60009', documentType: 'custom' } as unknown as SyntheticRecord });
    expect(textOf(find(res.root, 'greeting'))).toBe('Hello Cy Lee,');
    expect(find(res.root, 'figure-3-2')!.field!.display).toBe('$1,099.50');
  });

  it('reads JSON with nested objects and a nested list: the list becomes a list field with a table, amounts in cents and in decimals are told apart', () => {
    const rows = rowsOf('json', JSON.stringify({ records: JSON_ROWS }));
    expect(Object.keys(rows[0])).toEqual(['recordId', 'customer.firstName', 'customer.lastName', 'customer.preferredLanguage', 'plan.name', 'plan.feeCents', 'active', 'tags', 'sessions']);
    const { spec, notes } = setupSpecFromData(rows, { title: 'Class bookings' });
    expect(spec.issuerName).toBe('Class bookings');
    expect(spec.fields).toEqual([
      { label: 'Plan name', type: 'text', example: 'Flex' },
      { label: 'Plan fee', type: 'amount', example: '49.00' },
      { label: 'Active', type: 'yesNo', example: 'yes' },
      { label: 'Sessions', type: 'list', columns: [{ label: 'Day', type: 'date' }, { label: 'Class name', type: 'text' }, { label: 'Price', type: 'amount' }, { label: 'Spots', type: 'number' }] },
    ]);
    expect(spec.sections).toEqual([
      { type: 'heading', text: 'Class bookings' },
      { type: 'paragraph', text: 'Hello {First name} {Last name},' },
      { type: 'keyFigures', fields: ['Plan name', 'Plan fee', 'Active'] },
      { type: 'table', list: 'Sessions', columns: ['Day', 'Class name', 'Price', 'Spots'], totalColumn: 'Price' },
    ]);
    const all = notes.join('\n');
    for (const expected of [
      /“customer\.firstName”, “customer\.lastName” are used as the customer’s name/, /“customer\.preferredLanguage” is used as the customer’s language/, /“recordId” is kept as your own record ID/,
      /“Tags” holds plain lists of values, which a document cannot show, so it is left out/, /“Plan fee” is read as an amount in whole cents, because the column name says cents \(4900 is \$49\.00\)/,
      /“Price” in “Sessions” is read as an amount in dollars, not cents/, /The table “Sessions” adds up “Price”/,
    ]) expect(all).toMatch(expected);

    const { project } = build(spec);
    const { records, matching } = recordsFromRows(rows, project);
    expect(matching.filter((m) => !m.field).map((m) => `${m.column}: ${m.reason}`)).toEqual(['tags: No list field has this name, so the column is not used.']);
    expect(records[0]).toEqual({
      recordId: 'M-1', customer: { givenName: 'Dana', familyName: 'Novak', locale: 'fr-CA' },
      custom: { planName: 'Flex', planFeeCents: 4900, active: true, sessions: [{ day: '2026-11-03', className: 'Spin', priceCents: 1250, spots: 2 }, { day: '2026-11-10', className: 'Yoga', priceCents: 900, spots: 1 }] },
    });
    expect(records[1].custom).toEqual({ planName: 'Max', planFeeCents: 9900, active: false, sessions: [] });
    for (const r of records) expect(recordProblems(r, project)).toEqual([]);
    const res = resolve({ project, record: { ...records[0], recordId: 'REC-60010', documentType: 'custom' } as unknown as SyntheticRecord });
    expect(res.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(find(res.root, 'table-4')!.table).toMatchObject({ totalCents: 2150, caption: 'Sessions' });
    expect(res.locale).toBe('fr-CA');
  });

  it('a row that does not fit is reported in plain words with the field’s name; a column nobody asked for is not used', () => {
    const { project } = build(gymSetup());
    const rows = rowsOf('csv', [
      'Name,Plan Name,monthly fee,Renewal date,payment_status,renews automatically,Visits this month,shoe size,Fee',
      'Ana Maria Silva,Flex,49.00,2026-12-01,PAID,yes,9,38,1',
      'Cher,Max,abc,12/01/2026,overdue,maybe,2.5,40,1',
      ',,,,,,,,',
    ].join('\n'));
    expect(rows).toHaveLength(2);
    const { records, matching, notes } = recordsFromRows(rows, project);
    expect(Object.fromEntries(matching.map((m) => [m.column, m.field]))).toEqual({
      Name: 'First and last name', 'Plan Name': 'Plan name', 'monthly fee': 'Monthly fee', 'Renewal date': 'Renewal date', payment_status: 'Payment status',
      'renews automatically': 'Renews automatically', 'Visits this month': 'Visits this month', 'shoe size': null, Fee: null,
    });
    expect(matching.find((m) => m.column === 'shoe size')!.reason).toBe('No data field has this name, so the column is not used.');
    // "Fee" is close to both "Fees" (a list) and "Monthly fee": a guess is never used on its own
    expect(matching.find((m) => m.column === 'Fee')!.confidence).not.toBe('exact');
    expect(records[0]).toEqual({ customer: { givenName: 'Ana Maria', familyName: 'Silva', locale: 'en-US' }, custom: { planName: 'Flex', monthlyFeeCents: 4900, renewalDate: '2026-12-01', paymentStatus: 'paid', renewsAutomatically: true, visitsThisMonth: 9 } });
    expect(records[1].customer).toEqual({ givenName: 'Cher', familyName: '-', locale: 'en-US' });
    expect(recordProblems(records[0], project)).toEqual([]);
    expect(recordProblems(records[1], project)).toEqual([
      'Monthly fee: expected a whole number of cents, got "abc".',
      'Renewal date: expected a date YYYY-MM-DD, got "12/01/2026".',
      'Payment status: “overdue” is not one of paid, failed, pending.',
      'Renews automatically: expected true/false, got "maybe".',
      'Visits this month: expected a whole number, got "2.5".',
    ]);
    expect(notes).toEqual(['“monthly fee” is read as dollars for “Monthly fee” (49 or 49.00 is $49.00).']);
    // a list row is named by the list, the row and the column
    const withList = { ...records[0], custom: { ...(records[0].custom as object), fees: [{ description: 'Membership', amountCents: 4900 }, { description: 'Towel', amountCents: 'five' }] } };
    expect(recordProblems(withList, project)).toEqual(['Fees, row 2, Amount: expected a whole number of cents, got "five".']);
  });

  it('data without names still gives customers, and what a model is told about the data holds no row and no example value', () => {
    const rows = rowsOf('json', [{ invoice: 'INV-1', amount: '$120.00', status: 'open', secretNote: 'Call Maria on 555-0101' }, { invoice: 'INV-2', amount: '$80.00', status: 'open', secretNote: 'Gate code 4471' }, { invoice: 'INV-3', amount: '$15.25', status: 'paid', secretNote: 'none' }]);
    const { spec, notes } = setupSpecFromData(rows);
    expect(spec.title).toBe('New document');
    expect(notes[0]).toBe('The data has no column for the customer’s name, so the customers are called Customer 1, Customer 2 and so on.');
    expect(spec.fields.map((f) => `${f.label}:${f.type}`)).toEqual(['Invoice:text', 'Amount:amount', 'Status:choice', 'Secret note:text']);
    const { project } = build(spec);
    const { records } = recordsFromRows(rows, project);
    expect(records.map((r) => r.customer)).toEqual([{ givenName: 'Customer', familyName: '1', locale: 'en-US' }, { givenName: 'Customer', familyName: '2', locale: 'en-US' }, { givenName: 'Customer', familyName: '3', locale: 'en-US' }]);
    expect(records.map((r) => (r.custom as any).amountCents)).toEqual([12000, 8000, 1525]);
    for (const r of records) expect(recordProblems(r, project)).toEqual([]);

    const shape = dataShapeOf(rows);
    expect(shape).toEqual({
      fields: [{ label: 'Invoice', type: 'text' }, { label: 'Amount', type: 'amount' }, { label: 'Status', type: 'choice', choices: ['open', 'paid'] }, { label: 'Secret note', type: 'text' }],
      customerName: false, customerLanguage: false, rows: 3,
    });
    expect(JSON.stringify(shape)).not.toMatch(/INV-|120|Maria|555|4471/);
    expect(JSON.stringify(dataShapeOf(rowsOf('csv', CSV)))).not.toMatch(/Ana|Silva|000123|1,099|2024-03-01/);
  });

  it('says plainly when a file cannot be read, and never throws', () => {
    expect(readSampleData('csv', 'only,a,heading')).toEqual({ error: 'The CSV file needs a heading row and at least one row of data.' });
    expect(readSampleData('csv', 42)).toEqual({ error: 'A CSV file is expected as text.' });
    expect(readSampleData('json', '{not json')).toEqual({ error: 'The file is not valid JSON.' });
    expect(readSampleData('json', '"text"')).toEqual({ error: 'The JSON file must hold a list of customers (an array of objects).' });
    expect(readSampleData('json', [1, 2, 'x'])).toEqual({ error: 'No customers were found in the file.' });
    expect(readSampleData('xml', '<a/>')).toEqual({ error: 'The sample data must be CSV or JSON.' });
    expect(readSampleData('json', { name: 'Solo Person', fee: 5 })).toEqual({ rows: [{ name: 'Solo Person', fee: 5 }] });
    expect(setupSpecFromData([] as SampleRow[]).spec.fields).toEqual([]);
    expect(setupSpecFromData(null as unknown as SampleRow[]).spec.sections).toHaveLength(2);
    expect(['monthlyFeeCents', 'customer.first_name', 'PLAN NAME', 'memberId', 'x'].map(columnLabel)).toEqual(['Monthly fee', 'Customer first name', 'Plan name', 'Member ID', 'X']);
    expect(section(setupSpecFromData(rowsOf('csv', 'name,fee\nA B,5\n')).spec, 'keyFigures')[0].fields).toEqual(['Fee']);
  });
});
