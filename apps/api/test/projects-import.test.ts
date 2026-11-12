import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { RECORDS } from '@iss/model/fixtures';

let ctx: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-pi-')), logger: false }); });
afterAll(async () => { await ctx.app.close(); });
const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });

describe('project management', () => {
  it('duplicates a sample into an editable copy, renames and deletes it; samples cannot be deleted', async () => {
    const dup = await inj('POST', '/api/v1/projects/aster-card-demo/duplicate', { title: 'Aster Card — Spanish pilot' });
    expect(dup.statusCode).toBe(201);
    const copy = dup.json().project;
    expect(copy.projectId).toBe('aster-card-spanish-pilot');
    expect(copy.modelVersion).toBe(1);
    expect(copy.nodes.length).toBeGreaterThan(10);
    const list = (await inj('GET', '/api/v1/projects')).json().projects;
    expect(list.find((p: any) => p.projectId === copy.projectId)).toMatchObject({ sample: false, modified: false, derivedFrom: { projectId: 'aster-card-demo' } });
    expect(list.find((p: any) => p.projectId === 'aster-card-demo').sample).toBe(true);
    // second copy with same title gets a unique id
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/duplicate', { title: 'Aster Card — Spanish pilot' })).json().project.projectId).toBe('aster-card-spanish-pilot-2');
    const ren = await inj('PATCH', `/api/v1/projects/${copy.projectId}`, { title: 'Spanish pilot v2' });
    expect(ren.json().project).toMatchObject({ title: 'Spanish pilot v2', modelVersion: 2 });
    expect((await inj('PATCH', `/api/v1/projects/${copy.projectId}`, { title: 'x' })).statusCode).toBe(400);
    // a copy resolves like the original
    const res = await inj('POST', '/api/v1/resolve', { projectId: copy.projectId, recordId: 'CARD-0002' });
    expect(res.statusCode).toBe(200);
    expect((await inj('POST', `/api/v1/projects/${copy.projectId}/reset`, { confirm: true })).json().error.code).toBe('NOT_A_SAMPLE');
    expect((await inj('DELETE', '/api/v1/projects/aster-card-demo')).json().error.code).toBe('SAMPLE_PROJECT');
    expect((await inj('DELETE', `/api/v1/projects/${copy.projectId}`)).json()).toMatchObject({ deleted: true });
    expect((await inj('GET', `/api/v1/projects/${copy.projectId}`)).statusCode).toBe(404);
  });
});

describe('record import', () => {
  it('imports valid JSON records with fresh IDs, rejects invalid rows with reasons, and uses them in resolution', async () => {
    const good = { ...structuredClone(RECORDS.find((r) => r.recordId === 'CARD-0002')!), recordId: 'MY-1' };
    good.customer.givenName = 'Pat';
    const bad = { ...structuredClone(good), recordId: 'MY-2' } as any;
    bad.card.paymentStatus = 'late';
    delete bad.card.dueDate;
    const r = (await inj('POST', '/api/v1/records/import', { documentType: 'credit-statement', format: 'json', data: [good, bad] })).json();
    expect(r.imported).toEqual([{ recordId: 'CARD-5001', sourceId: 'MY-1', name: `Pat ${good.customer.familyName}` }]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].errors.join(' ')).toMatch(/late.*not one of current, overdue/);
    expect(r.rejected[0].errors.join(' ')).toMatch(/Payment due date/);
    const recs = (await inj('GET', '/api/v1/records?documentType=credit-statement')).json().records;
    expect(recs.find((x: any) => x.recordId === 'CARD-5001')).toMatchObject({ imported: true, synthetic: false });
    const res = (await inj('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: 'CARD-5001' })).json();
    expect(res.result.selectedVariants['payment-guidance']).toBe('payment-assistance-requested');
    const dry = (await inj('POST', '/api/v1/records/import', { documentType: 'credit-statement', data: [good], dryRun: true })).json();
    expect(dry.imported[0].recordId).toBe('CARD-5002');
    expect((await inj('GET', '/api/v1/records?documentType=credit-statement')).json().records.some((x: any) => x.recordId === 'CARD-5002')).toBe(false);
  });

  it('imports EOB rows from CSV with data-contract headers; unknown and derived columns are refused', async () => {
    const csv = 'recordId,customer.givenName,customer.familyName,customer.locale,member.planName,member.memberId,claim.claimId,claim.status,claim.network,claim.billedCents,claim.liabilityConfirmed\r\n'
      + 'A1,Sam,"Rivera, Jr.",en-US,HarborCare Select,HC-1,HC-77,denied-pending-review,in-network,30000,no\r\n'
      + 'A2,Lee,Chan,en-US,HarborCare Select,HC-2,HC-78,lost,in-network,abc,no\r\n';
    const r = (await inj('POST', '/api/v1/records/import', { documentType: 'eob', format: 'csv', data: csv })).json();
    expect(r.imported).toEqual([{ recordId: 'EOB-5001', sourceId: 'A1', name: 'Sam Rivera, Jr.' }]);
    expect(r.rejected[0].errors.join(' ')).toMatch(/lost/);
    expect(r.rejected[0].errors.join(' ')).toMatch(/whole number/);
    const res = (await inj('POST', '/api/v1/resolve', { projectId: 'harborcare-demo', recordId: 'EOB-5001' })).json();
    expect(res.result.selectedVariants['eob-claim-message']).toBe('eob-review-needed');
    const bad = await inj('POST', '/api/v1/records/import', { documentType: 'eob', format: 'csv', data: 'customer.givenName,claims.count,ssn\nA,1,2\n' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/Unknown column “ssn”/);
    expect(bad.json().error.message).toMatch(/calculated by the engine/);
    expect((await inj('DELETE', '/api/v1/records/imported?documentType=eob')).json().removed).toBe(1);
  });
});
