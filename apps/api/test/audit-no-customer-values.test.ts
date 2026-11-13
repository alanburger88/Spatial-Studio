import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';

/**
 * The audit log stores the customer's id (the reference), never a value from the customer's data: no name, amount, date
 * or free text. This performs every action that touches a customer on one with distinctive values, then scans every audit
 * row for those values.
 */
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-audit-'));
const CARD = 'aster-card-demo';
const DATA = 'inconsistent-payment-state~payment-guidance';
const NAME = { givenName: 'Wilhelmina', familyName: 'Featherstonehaugh' };
const IMPORTED_NAME = { givenName: 'Zebulon', familyName: 'Quackenbush' };
const AMOUNT = 987654; // minimum due, in cents
const DATE = '2031-07-19';
const REASON_NOTE = 'Corrected upstream by the billing team';

describe('audit details carry ids, never customer values', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
  const json = async (method: any, url: string, payload?: any) => (await inj(method, url, payload)).json();
  const auditRows = () => ((ctx.store as any).db.prepare('SELECT * FROM audit ORDER BY id').all() as Array<Record<string, unknown>>);

  it('records.add, records.edit, known-data.add/remove/lapse, records.delete and records.import store only ids', async () => {
    // records.add: an editable copy of a sample customer
    const made = await inj('POST', `/api/v1/projects/${CARD}/records`, { copyOf: 'CARD-0001' });
    expect(made.statusCode).toBe(201);
    const rec = made.json().record;
    const id: string = rec.recordId;
    expect(id).toMatch(/^CARD-6\d{4}$/);

    // records.edit: a distinctive name, amount and date, and data that contradicts itself so a data blocker applies
    const edited = { ...rec, customer: { ...rec.customer, ...NAME }, card: { ...rec.card, dueDate: DATE, minimumDueCents: AMOUNT, paymentStatus: 'current', missedPayments: 3 } };
    const put = await inj('PUT', `/api/v1/projects/${CARD}/records/${id}`, { record: edited });
    expect(put.statusCode).toBe(200);
    expect(put.json().record.customer).toMatchObject(NAME);

    // known-data.add (the reason is the person's own note and is not copied), then known-data.remove
    const add = await inj('POST', `/api/v1/projects/${CARD}/known-data-problems`, { blockerId: DATA, recordId: id, reason: REASON_NOTE });
    expect(add.statusCode).toBe(201);
    const kid = add.json().knownDataProblem.id;
    expect((await inj('DELETE', `/api/v1/projects/${CARD}/known-data-problems/${kid}`)).statusCode).toBe(200);

    // known-data.lapse: set aside again, then correct the customer's data so the problem no longer stops them
    expect((await inj('POST', `/api/v1/projects/${CARD}/known-data-problems`, { blockerId: DATA, recordId: id, reason: REASON_NOTE })).statusCode).toBe(201);
    expect((await inj('PUT', `/api/v1/projects/${CARD}/records/${id}`, { record: { ...edited, card: { ...edited.card, missedPayments: 0 } } })).statusCode).toBe(200);
    const after = await json('GET', `/api/v1/projects/${CARD}/known-data-problems`);
    expect(after.lapsed.map((k: any) => k.recordId)).toEqual([id]);

    // lapse because the customer is gone: set aside, then delete the customer (records.delete)
    expect((await inj('PUT', `/api/v1/projects/${CARD}/records/${id}`, { record: edited })).statusCode).toBe(200);
    expect((await inj('POST', `/api/v1/projects/${CARD}/known-data-problems`, { blockerId: DATA, recordId: id, reason: REASON_NOTE })).statusCode).toBe(201);
    expect((await inj('DELETE', `/api/v1/projects/${CARD}/records/${id}`)).statusCode).toBe(200);
    await json('GET', `/api/v1/projects/${CARD}/known-data-problems`);

    // records.import: a shared customer with a distinctive name
    const { recordId: _drop, ...row } = (await json('GET', '/api/v1/records/CARD-0002')).record;
    const imp = await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', format: 'json', data: [{ ...row, customer: { ...row.customer, ...IMPORTED_NAME }, card: { ...row.card, dueDate: DATE, minimumDueCents: AMOUNT } }] });
    expect(imp.imported).toHaveLength(1);

    const rows = auditRows();
    const actions = rows.map((r) => r.action);
    for (const a of ['records.add', 'records.edit', 'records.delete', 'records.import', 'known-data.add', 'known-data.remove', 'known-data.lapse']) expect(actions, a).toContain(a);
    expect(rows.filter((r) => r.action === 'known-data.lapse').map((r) => JSON.parse(String(r.detail)).why).sort()).toEqual(['customer-gone', 'no-longer-stops']);

    // what each one stores: the customer's id, never a value from the customer's data
    const detailOf = (action: string) => JSON.parse(String(rows.find((r) => r.action === action)!.detail));
    expect(detailOf('records.add')).toMatchObject({ recordId: id, copyOf: 'CARD-0001' });
    expect(detailOf('records.edit')).toMatchObject({ recordId: id });
    expect(detailOf('records.delete')).toEqual({ recordId: id });
    expect(detailOf('known-data.add')).toMatchObject({ recordId: id, blockerId: DATA });
    expect(detailOf('known-data.remove')).toMatchObject({ recordId: id });
    for (const a of ['records.add', 'records.edit', 'records.delete', 'known-data.add', 'known-data.remove', 'known-data.lapse']) expect(Object.keys(detailOf(a)), a).not.toContain('name');

    // every audit row, whole: no name, amount, date or the person's reason text
    const everything = JSON.stringify(rows);
    for (const needle of [NAME.givenName, NAME.familyName, IMPORTED_NAME.givenName, IMPORTED_NAME.familyName, String(AMOUNT), DATE, REASON_NOTE, `${NAME.givenName} ${NAME.familyName}`]) {
      expect(everything, `audit rows must not contain "${needle}"`).not.toContain(needle);
    }
    // and through the API the Activity screen reads
    const viaApi = JSON.stringify((await json('GET', '/api/v1/audit?limit=500')).events);
    for (const needle of [NAME.familyName, IMPORTED_NAME.familyName, String(AMOUNT), DATE]) expect(viaApi).not.toContain(needle);
  });
});
