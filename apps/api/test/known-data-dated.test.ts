import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project } from '@iss/model';
import { buildApp } from '../src/app';
import { depthProject } from '../../../packages/model/test/helpers/depthProject';
import { gymMember } from '../../../packages/model/test/helpers/customProject';

/**
 * Known data problems on a document whose date is given for each run: a blocker that stops a customer only on a day is
 * judged on the day the screen shows ("as issued on"), and an entry set aside on one day does not lapse when the list
 * is asked for without a day or on another day.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const BLOCKER = 'calculation-missing~calc.renewSoon';

describe('known data problems as issued on a day', () => {
  let ctx: Ctx;
  let id = '';
  let recordId = '';
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any) => (await inj(method, url, payload)).json();
  const base = () => `/api/v1/projects/${id}/known-data-problems`;

  beforeAll(async () => {
    ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-known-dated-')), logger: false, auth: false });
    const made = (await json('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Membership notice', issuerName: 'Northside Gym', accent: '#1f4e79' })).project as Project;
    id = made.projectId;
    const d = depthProject();
    // The renewal date may be left empty in this test document (it is required in the helper's).
    const customFields = d.customFields!.map((f) => (f.key === 'renewalDate' ? { ...f, required: false } : f));
    const put = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...d, customFields, projectId: id, title: made.title, issuer: made.issuer, modelVersion: made.modelVersion + 1 } }, { 'if-match': `"${made.modelVersion}"` });
    expect(put.statusCode, put.body.slice(0, 300)).toBe(200);
    // A customer without a renewal date: "Renews soon" cannot be worked out, which stops them only once the document has a date.
    const { recordId: _r, ...record } = gymMember({ custom: { renewalDate: null } });
    const added = await inj('POST', `/api/v1/projects/${id}/records`, { record });
    expect(added.statusCode, added.body.slice(0, 300)).toBe(201);
    recordId = added.json().record.recordId;
  }, 60_000);
  afterAll(async () => { await ctx.app.close(); });

  it('refuses a day that is not a day', async () => {
    const r = await inj('POST', base(), { blockerId: BLOCKER, recordId, reason: 'Renewal date arrives next week', issueDate: '2027-13-01' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_ISSUE_DATE');
    expect((await inj('GET', `${base()}?issueDate=tomorrow`)).json().error.code).toBe('INVALID_ISSUE_DATE');
  });

  it('judges the blocker on the day given: without the day it does not stop the customer, on the day it does', async () => {
    const undated = await inj('POST', base(), { blockerId: BLOCKER, recordId, reason: 'Renewal date arrives next week' });
    expect(undated.statusCode, undated.body).toBe(409);
    expect(undated.json().error.code).toBe('NOT_STOPPING_THIS_CUSTOMER');
    const dated = await inj('POST', base(), { blockerId: BLOCKER, recordId, reason: 'Renewal date arrives next week', issueDate: '2027-01-02' });
    expect(dated.statusCode, dated.body).toBe(201);
    expect(dated.json().knownDataProblem).toMatchObject({ blockerId: BLOCKER, recordId, blocker: { kind: 'customer-data' } });
  });

  it('the entry stays in force when listed on the day, on another day and without a day', async () => {
    for (const q of ['?issueDate=2027-01-02', '?issueDate=2026-12-15', '']) {
      const r = await json('GET', `${base()}${q}`);
      expect(r.knownDataProblems.map((k: any) => k.blockerId), q).toEqual([BLOCKER]);
      expect(r.lapsed).toEqual([]);
    }
  });
});
