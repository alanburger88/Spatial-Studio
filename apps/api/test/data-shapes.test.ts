/**
 * Richer data shapes (wave 5, section 2) through the API: a document with a group, a list inside a list and a
 * repeating section is imported as a project file; its nested customers are imported as JSON (a flat CSV is refused
 * with plain words and JSON offered), checked with errors that name the path, edited in place (Data Explorer), and
 * carried by the release's data dictionary and the runnable package's input contract.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHousehold, householdCustomers } from '@iss/model/samples/index';
import { dataFingerprintOf, resolve } from '@iss/resolver';
import { dataDictionary } from '@iss/scenarios';
import { inputSchemaFromDictionary, parseInput, recordProblems } from '@iss/runtime';
import { buildApp } from '../src/app';

type Ctx = Awaited<ReturnType<typeof buildApp>>;
let ctx: Ctx;
let projectId = '';
const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
const data = (r: ReturnType<typeof householdCustomers>[number]) => ({ customer: r.customer, custom: r.custom });

beforeAll(async () => {
  ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-shapes-')), logger: false, auth: false });
});
afterAll(async () => { await ctx.app.close(); });

describe('a document with groups and a list inside a list', () => {
  it('imports as a project file and keeps its shapes, its calculations per item and its repeating section', async () => {
    const res = await inj('POST', '/api/v1/projects/import', { file: buildHousehold() });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
    projectId = res.json().project.projectId;
    const stored = (await inj('GET', `/api/v1/projects/${projectId}`)).json().project;
    expect(stored.customFields.find((f: any) => f.key === 'accounts').itemFields.map((c: any) => c.type)).toEqual(['string', 'string', 'cents', 'cents', 'group', 'list']);
    expect(stored.calculatedFields.find((c: any) => c.key === 'accountSubtotal').list).toBe('custom.accounts');
    expect(stored.nodes.find((n: any) => n.id === 'accounts-section').repeat).toEqual({ list: 'custom.accounts', keepHeading: true });
  });

  it('accepts nested customers as JSON, and names the path of what is wrong', async () => {
    const ok = await inj('POST', '/api/v1/records/import', { projectId, scope: 'project', format: 'json', data: householdCustomers().map(data) });
    expect(ok.statusCode, ok.body.slice(0, 400)).toBe(200);
    expect(ok.json().imported.length).toBe(20);
    const bad = householdCustomers()[4];
    const broken = JSON.parse(JSON.stringify(data(bad)));
    broken.custom.accounts[1].transactions[2].amountCents = '12.50';
    broken.custom.accounts[0].holder = 'Elliot';
    broken.custom.accounts[2].transactions[0].splits = [{ amountCents: 1 }];
    const dry = (await inj('POST', '/api/v1/records/import', { projectId, scope: 'project', format: 'json', data: [broken], dryRun: true })).json();
    const errors: string[] = JSON.stringify(dry).match(/custom\.accounts\[[^"]*/g) ?? [];
    expect(errors.some((e) => e.startsWith('custom.accounts[1].transactions[2].amountCents'))).toBe(true);
    expect(errors.some((e) => e.startsWith('custom.accounts[0].holder'))).toBe(true);
    expect(JSON.stringify(dry)).toContain('a list inside a list cannot hold another list');
  });

  it('refuses a flat CSV for a list inside a list, saying why and offering JSON', async () => {
    for (const header of ['custom.accounts', 'custom.accounts[].transactions']) {
      const res = (await inj('POST', '/api/v1/records/import', { projectId, scope: 'project', format: 'csv', data: `customer.givenName,customer.familyName,customer.locale,${header}\nA,B,en-US,[]\n`, dryRun: true })).json();
      const text = JSON.stringify(res);
      expect(text, header).toMatch(/cannot hold a list/);
      expect(text, header).toContain('JSON file');
    }
    // A group's fields are ordinary columns.
    const groupOnly = (await inj('POST', '/api/v1/records/import', { projectId, scope: 'project', format: 'csv', data: 'customer.givenName,customer.familyName,customer.locale,custom.statementDate,custom.mailing.city\nA,B,en-US,2026-10-31,Calder Bay\n', dryRun: true })).json();
    expect(JSON.stringify(groupOnly)).not.toMatch(/Unknown column/);
  });

  it('edits a nested value of a customer (Data Explorer) and the document follows it', async () => {
    const list = (await inj('GET', `/api/v1/records?projectId=${projectId}&full=1`)).json().records as any[];
    const target = list.find((r) => (r.custom?.accounts ?? []).length === 2)!;
    const custom = JSON.parse(JSON.stringify(target.custom));
    custom.accounts[1].balanceCents = -500;
    custom.accounts[1].transactions.push({ date: '2026-10-30', description: 'Added by a person', amountCents: -100 });
    const put = await inj('PUT', `/api/v1/projects/${projectId}/records/${target.recordId}`, { record: { ...target, custom } });
    expect(put.statusCode, put.body.slice(0, 400)).toBe(200);
    const res = (await inj('POST', '/api/v1/resolve', { projectId, recordId: target.recordId, includeTree: true })).json();
    expect(res.result.selectedVariants['account-notice']).toBe('notice-overdrawn');
    expect(JSON.stringify(res.tree)).toContain('account-overdrawn~2');
  });

  it('the data dictionary and the runnable package’s input contract describe the nested input, and a nested line is read', () => {
    const project = buildHousehold();
    const dict = dataDictionary(project);
    const accounts = dict.fields.find((f) => f.path === 'custom.accounts')!;
    expect(accounts.columns!.map((c) => c.key)).toContain('holder.name');
    expect((accounts as any).innerLists).toEqual([expect.objectContaining({ key: 'transactions', columns: expect.arrayContaining([expect.objectContaining({ key: 'amountCents', type: 'cents' })]) })]);
    expect(dict.fields.find((f) => f.path === 'custom.mailing.city')).toMatchObject({ label: 'Mailing address: City' });
    expect((dict as any).itemFields.map((f: any) => f.path)).toEqual(expect.arrayContaining(['custom.accounts[].number', 'custom.accounts[].holder.name', 'custom.accounts[].transactions', 'custom.accounts[].transactions[].amountCents', 'calc.accountSubtotal']));
    expect((dict as any).itemFields.find((f: any) => f.path === 'calc.accountSubtotal').calculation.formula).toBe('=SUM(custom.accounts[].transactions.amountCents)');
    const schema = inputSchemaFromDictionary(dict as never, { releaseId: 'household-r1', title: project.title, languages: ['en-US'] }) as any;
    const items = schema.properties.custom.properties.accounts.items;
    expect(items.properties.holder.properties.name.type).toBe('string');
    expect(items.properties.transactions).toMatchObject({ type: 'array', items: { properties: { amountCents: { type: 'integer' } } } });
    expect(schema.properties.custom.properties.mailing.properties.city.type).toBe('string');
    // The runnable package reads a nested line with the studio's own checks.
    const customer = householdCustomers()[4];
    const line = parseInput({ customerRef: 'c-1', data: { ...data(customer), recordId: 'H-1' } }, project);
    expect(line.ok, JSON.stringify(line)).toBe(true);
    const wrong = JSON.parse(JSON.stringify({ ...data(customer), recordId: 'H-2' }));
    wrong.custom.accounts[3].transactions[0].date = 'yesterday';
    expect(recordProblems(wrong, project).join(' ')).toContain('custom.accounts[3].transactions[0].date');
  });

  it('a proof’s data fingerprint covers the values inside the lists of the lists', () => {
    const r = householdCustomers()[3];
    const changed = JSON.parse(JSON.stringify(r));
    changed.custom.accounts[1].transactions[0].amountCents += 1;
    expect(dataFingerprintOf(changed)).not.toBe(dataFingerprintOf(r));
    expect(resolve({ project: buildHousehold(), record: changed }).contentDigest).not.toBe(resolve({ project: buildHousehold(), record: r }).contentDigest);
  });
});
