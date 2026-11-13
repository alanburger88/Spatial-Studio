import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-rec-'));

/** Data Explorer: a project's own customers as whole nested records. */
describe('data explorer: customers that belong to a document', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const P = 'aster-card-demo';
  const records = async (projectId?: string) => (await inj('GET', `/api/v1/records?documentType=credit-statement&full=1${projectId ? `&projectId=${projectId}` : ''}`)).json().records as any[];
  let copyId = '';

  it('checks a customer without storing it: problems name the field, a valid one says what the document does', async () => {
    const sample = (await records()).find((r) => r.recordId === 'CARD-0002');
    const ok = (await inj('POST', `/api/v1/projects/${P}/records/check`, { record: sample })).json();
    expect(ok.problems).toEqual([]);
    expect(ok.outcome.messages.find((m: any) => m.nodeId === 'payment-guidance')).toMatchObject({ node: 'Payment guidance', variant: 'Assistance requested' });
    const bad = (await inj('POST', `/api/v1/projects/${P}/records/check`, { record: { ...sample, card: { ...sample.card, dueDate: 'next week', minimumDueCents: 45.5, transactions: [{ ...sample.card.transactions[0], amountCents: 'ten' }] } } })).json();
    expect(bad.outcome).toBeNull();
    const paths = bad.problems.map((p: any) => p.path);
    expect(paths).toContain('card.dueDate');
    expect(paths).toContain('card.minimumDueCents');
    expect(paths.some((p: string) => p.startsWith('card.transactions[0]'))).toBe(true);
    expect((await records(P)).some((r) => r.projectId)).toBe(false);
    expect((await inj('POST', `/api/v1/projects/${P}/records/check`, { record: 'nope' })).statusCode).toBe(400);
  });

  it('a sample customer cannot be changed or removed; an editable copy belongs to this document only', async () => {
    const sample = (await records()).find((r) => r.recordId === 'CARD-0002');
    expect((await inj('PUT', `/api/v1/projects/${P}/records/CARD-0002`, { record: sample })).json().error.code).toBe('RECORD_SHARED');
    expect((await inj('DELETE', `/api/v1/projects/${P}/records/CARD-0002`)).json().error.code).toBe('RECORD_SHARED');
    const c = await inj('POST', `/api/v1/projects/${P}/records`, { copyOf: 'CARD-0002' });
    expect(c.statusCode).toBe(201);
    const { record, copiedFrom, outcome } = c.json();
    copyId = record.recordId;
    expect(copiedFrom).toBe('CARD-0002');
    expect(copyId).toMatch(/^CARD-6\d{4}$/);
    expect(record).toMatchObject({ projectId: P, documentType: 'credit-statement', customer: sample.customer });
    // the kind of customer (persona) carries over, so the copy is still described the same way
    expect(record.personaId).toBe(sample.personaId);
    expect(record.card.transactions).toEqual(sample.card.transactions);
    expect(outcome.messages.find((m: any) => m.nodeId === 'payment-guidance').variant).toBe('Assistance requested');
    expect((await records(P)).find((r) => r.recordId === copyId)).toBeTruthy();
    expect((await records()).find((r) => r.recordId === copyId)).toBeUndefined();
    expect((await records()).find((r) => r.recordId === 'CARD-0002')).toEqual(sample);
    expect((await inj('POST', `/api/v1/projects/${P}/records`, { copyOf: 'EOB-0001' })).statusCode).toBe(404);
  });

  it('saving nested changes (a value, a list row added and removed) is validated and changes what the document does', async () => {
    const mine = (await records(P)).find((r) => r.recordId === copyId);
    const edited = { ...mine, card: { ...mine.card, assistanceRequested: false, missedPayments: 0, paymentStatus: 'current', transactions: [...mine.card.transactions.slice(1), { id: 'T-NEW', date: '2026-10-30', merchant: 'Harbor Books', amountCents: 1299 }] } };
    // the statement must still add up: adjust purchases and balance with the rows
    const delta = 1299 - mine.card.transactions[0].amountCents;
    edited.card.purchasesCents = mine.card.purchasesCents + delta;
    edited.card.newBalanceCents = mine.card.newBalanceCents + delta;
    const s = await inj('PUT', `/api/v1/projects/${P}/records/${copyId}`, { record: { ...edited, recordId: 'CARD-0001', projectId: 'someone-else', generated: { label: 'x' } } });
    expect(s.statusCode).toBe(200);
    const out = s.json();
    expect(out.record).toMatchObject({ recordId: copyId, projectId: P });
    expect(out.record.generated).toBeUndefined();
    expect(out.record.card.transactions.at(-1)).toMatchObject({ merchant: 'Harbor Books', amountCents: 1299 });
    expect(out.record.card.transactions).toHaveLength(mine.card.transactions.length);
    expect(out.outcome.messages.find((m: any) => m.nodeId === 'payment-guidance').variant).toBe('Payment instructions');
    // a value that does not fit is refused with the field named, and nothing changes
    const bad = await inj('PUT', `/api/v1/projects/${P}/records/${copyId}`, { record: { ...edited, card: { ...edited.card, tier: 'platinum' } } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.problems[0]).toMatchObject({ path: 'card.tier' });
    expect((await records(P)).find((r) => r.recordId === copyId).card.tier).toBe(mine.card.tier);
    // the saved customer resolves in this project, and is refused in another
    expect((await inj('POST', '/api/v1/resolve', { projectId: P, recordId: copyId })).statusCode).toBe(200);
  });

  it('adds a new customer from data; an edited generated customer becomes the document\'s own and survives regenerating', async () => {
    const sample = (await records()).find((r) => r.recordId === 'CARD-0001');
    const added = await inj('POST', `/api/v1/projects/${P}/records`, { record: { ...sample, customer: { ...sample.customer, givenName: 'Noor', familyName: 'Haddad' } } });
    expect(added.statusCode).toBe(201);
    expect(added.json().record.customer.givenName).toBe('Noor');
    expect((await inj('POST', `/api/v1/projects/${P}/records`, { record: { customer: { givenName: 'No', familyName: 'Card', locale: 'en-US' } } })).statusCode).toBe(422);

    const gen = (await inj('POST', `/api/v1/projects/${P}/test-data`, { outcomes: true, edges: false })).json();
    const g = (await records(P)).find((r) => r.generated);
    const saved = (await inj('PUT', `/api/v1/projects/${P}/records/${g.recordId}`, { record: { ...g, customer: { ...g.customer, givenName: 'Edited' } } })).json();
    expect(saved.wasGenerated).toBe(true);
    const again = (await inj('POST', `/api/v1/projects/${P}/test-data`, { outcomes: true, edges: false })).json();
    expect(again.replaced).toBe(gen.generated - 1);
    const kept = (await records(P)).find((r) => r.recordId === g.recordId);
    expect(kept).toMatchObject({ projectId: P, customer: { givenName: 'Edited' } });
    expect(kept.generated).toBeUndefined();
  });

  it('removes one of the document\'s own customers; the action is recorded', async () => {
    expect((await inj('DELETE', `/api/v1/projects/${P}/records/${copyId}`)).json()).toEqual({ removed: copyId });
    expect((await records(P)).find((r) => r.recordId === copyId)).toBeUndefined();
    expect((await inj('DELETE', `/api/v1/projects/${P}/records/${copyId}`)).statusCode).toBe(404);
    expect((await inj('DELETE', `/api/v1/projects/harborcare-demo/records/CARD-0001`)).statusCode).toBe(404);
    const actions = ((await inj('GET', '/api/v1/audit?limit=60')).json().events ?? []).map((e: any) => e.action);
    for (const a of ['records.add', 'records.edit', 'records.delete']) expect(actions).toContain(a);
  });
});

describe('data explorer: roles (auth on)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const k of ['AUTH', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) saved[k] = process.env[k];
    process.env.AUTH = 'on'; process.env.ADMIN_EMAIL = 'admin@example.test'; process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false });
  });
  afterAll(async () => { await ctx.app.close(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const login = async (email: string, password: string) => String([(await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })).headers['set-cookie']].flat()[0]).split(';')[0];

  it('a reviewer can check a customer but not add, change or remove one; an author can', async () => {
    const admin = await login('admin@example.test', 'correct horse battery');
    for (const role of ['author', 'reviewer']) expect((await inj('POST', '/api/v1/users', { email: `${role}@example.test`, name: `${role} person`, role, password: 'password-123' }, { cookie: admin })).statusCode).toBe(201);
    const author = await login('author@example.test', 'password-123');
    const reviewer = await login('reviewer@example.test', 'password-123');
    const sample = (await inj('GET', '/api/v1/records/CARD-0001', undefined, { cookie: reviewer })).json().record;
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/records/check', { record: sample }, { cookie: reviewer })).statusCode).toBe(200);
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/records', { copyOf: 'CARD-0001' }, { cookie: reviewer })).statusCode).toBe(403);
    const mine = await inj('POST', '/api/v1/projects/aster-card-demo/records', { copyOf: 'CARD-0001' }, { cookie: author });
    expect(mine.statusCode).toBe(201);
    const id = mine.json().record.recordId;
    expect((await inj('PUT', `/api/v1/projects/aster-card-demo/records/${id}`, { record: mine.json().record }, { cookie: reviewer })).statusCode).toBe(403);
    expect((await inj('DELETE', `/api/v1/projects/aster-card-demo/records/${id}`, undefined, { cookie: reviewer })).statusCode).toBe(403);
    expect((await inj('DELETE', `/api/v1/projects/aster-card-demo/records/${id}`, undefined, { cookie: author })).statusCode).toBe(200);
  });
});
