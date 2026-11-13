import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toTranslationCsv, usageEntryFromResolution, type Project, type SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import { buildApp } from '../src/app';
import { depthProject } from '../../../packages/model/test/helpers/depthProject';

/**
 * "As issued on" through every route that resolves: with `issueDate` a route gives the result of that day (the same as
 * the pure engine on that day); without it, exactly what it gave before; a date that is not a day is refused in plain
 * words. A document that does not use dates gives the same answer with or without a date.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const BEFORE = '2026-12-31';
const ON = '2027-01-01';
const BAD = '2027-02-30';
const REFUSAL = 'The document’s date “2027-02-30” is not a calendar day. Write it as YYYY-MM-DD, for example 2027-01-01.';

describe('the document’s date ("as issued on") through every route that resolves', () => {
  let ctx: Ctx;
  let id = '';
  let project: Project;
  let customers: SyntheticRecord[] = [];
  /** A customer whose message changes on ON (the dated rule "New year offer for Basic" starts that day). */
  let basic: SyntheticRecord;
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any) => (await inj(method, url, payload)).json();
  const pure = (record: SyntheticRecord, issueDate?: string) => resolve({ project, record, profileId: 'paged-pdf', ...(issueDate ? { issueDate } : {}) });
  const refused = async (method: any, url: string, payload?: any) => {
    const r = await inj(method, url, payload);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'INVALID_ISSUE_DATE', message: REFUSAL });
  };

  beforeAll(async () => {
    ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-issue-date-')), logger: false, auth: false });
    const made = (await json('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Membership notice', issuerName: 'Northside Gym', accent: '#1f4e79' })).project as Project;
    id = made.projectId;
    const put = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...depthProject(), projectId: id, title: made.title, issuer: made.issuer, modelVersion: made.modelVersion + 1 } }, { 'if-match': `"${made.modelVersion}"` });
    expect(put.statusCode, put.body.slice(0, 400)).toBe(200);
    project = put.json().project;
    expect((await inj('POST', `/api/v1/projects/${id}/test-data`, { outcomes: true, edges: false })).statusCode).toBe(201);
    customers = (await json('GET', `/api/v1/records?documentType=custom&full=1&projectId=${id}`)).records;
    basic = customers.find((r) => pure(r, BEFORE).result.selectedVariants['renewal-note'] !== pure(r, ON).result.selectedVariants['renewal-note'])!;
    expect(basic, 'a test customer whose message changes on 1 Jan 2027').toBeTruthy();
  }, 120_000);
  afterAll(async () => { await ctx.app.close(); });

  it('resolve: the dated result with a date, the old result without, a bad date refused', async () => {
    const on = await json('POST', '/api/v1/resolve', { projectId: id, recordId: basic.recordId, issueDate: ON });
    const before = await json('POST', '/api/v1/resolve', { projectId: id, recordId: basic.recordId, issueDate: BEFORE });
    const none = await json('POST', '/api/v1/resolve', { projectId: id, recordId: basic.recordId });
    expect(on.result.selectedVariants).toEqual(pure(basic, ON).result.selectedVariants);
    expect(before.result.selectedVariants).toEqual(pure(basic, BEFORE).result.selectedVariants);
    expect(on.result.selectedVariants['renewal-note']).not.toBe(before.result.selectedVariants['renewal-note']);
    expect(on.documentDate).toEqual({ date: ON, source: 'run', given: true });
    expect(on.calculated?.bonusRate?.value).toBe(2);
    expect(none.runId).toBe(pure(basic).runId);
    expect(none.findings.map((f: any) => f.code)).toContain('DOCUMENT_DATE_MISSING');
    await refused('POST', '/api/v1/resolve', { projectId: id, recordId: basic.recordId, issueDate: BAD });
  });

  it('compose (email and HTML) and validate follow the date', async () => {
    const email = await json('POST', '/api/v1/compose/email', { projectId: id, recordId: basic.recordId, issueDate: ON, allowDraft: true });
    expect(email.runId).toBe(pure(basic, ON).runId);
    const html = await inj('POST', '/api/v1/compose/html', { projectId: id, recordId: basic.recordId, issueDate: ON, allowDraft: true });
    expect(html.headers['x-run-id']).toBe(pure(basic, ON).runId);
    const v = await json('POST', '/api/v1/validate', { projectId: id, recordId: basic.recordId, issueDate: BEFORE, suites: ['rules'] });
    expect(v.runId).toBe(pure(basic, BEFORE).runId);
    const vNone = await json('POST', '/api/v1/validate', { projectId: id, recordId: basic.recordId, suites: ['rules'] });
    expect(vNone.runId).toBe(pure(basic).runId);
    await refused('POST', '/api/v1/compose/html', { projectId: id, recordId: basic.recordId, issueDate: BAD });
    await refused('POST', '/api/v1/validate', { projectId: id, recordId: basic.recordId, issueDate: BAD, suites: ['rules'] });
  });

  it('journey replay and the cube and landscape follow the date', async () => {
    const replay = await json('POST', '/api/v1/journeys/replay', { projectId: id, recordId: basic.recordId, issueDate: ON });
    expect(replay.snapshots.length).toBeGreaterThan(0);
    await refused('POST', '/api/v1/journeys/replay', { projectId: id, recordId: basic.recordId, issueDate: BAD });
    const mine = customers.filter((r) => r.documentType === 'custom');
    const count = (issueDate?: string) => mine.filter((r) => pure(r, issueDate).result.selectedVariants['renewal-note'] === 'note-newyear').length;
    const landscape = async (issueDate?: string) => json('POST', '/api/v1/analysis/landscape', { projectId: id, ...(issueDate ? { issueDate } : {}) });
    const [lOn, lBefore, lNone] = [await landscape(ON), await landscape(BEFORE), await landscape()];
    const reach = (l: any) => JSON.stringify(l).split('note-newyear').length;
    expect(count(ON)).toBeGreaterThan(count(BEFORE));
    expect(reach(lOn)).toBeGreaterThan(reach(lBefore));
    expect(lNone).toEqual(await landscape());
    const cube = async (issueDate?: string) => json('POST', '/api/v1/analysis/cube', { projectId: id, axes: ['persona', 'output', 'journey'], ...(issueDate ? { issueDate } : {}) });
    const cOn = await cube(ON);
    const cBefore = await cube(BEFORE);
    expect(JSON.stringify(cOn)).not.toBe(JSON.stringify(cBefore));
    await refused('POST', '/api/v1/analysis/cube', { projectId: id, issueDate: BAD });
    await refused('POST', '/api/v1/analysis/landscape', { projectId: id, issueDate: BAD });
  });

  it('a batch uses the date for every customer and records it', async () => {
    const start = await inj('POST', '/api/v1/batches', { projectId: id, recordIds: [basic.recordId], outputs: ['html'], includeBlocked: true, issueDate: ON });
    expect(start.statusCode, start.body.slice(0, 300)).toBe(202);
    let job = start.json().batch;
    expect(job.issueDate).toBe(ON);
    for (let i = 0; i < 100 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 50)); job = (await json('GET', `/api/v1/batches/${job.batchId}`)).batch; }
    expect(job.status).toBe('done');
    expect(job.items[0].runId).toBe(pure(basic, ON).runId);
    expect(job.items[0].selectedVariants).toEqual(pure(basic, ON).result.selectedVariants);
    const plain = (await inj('POST', '/api/v1/batches', { projectId: id, recordIds: [basic.recordId], outputs: ['html'], includeBlocked: true })).json().batch;
    expect(plain.issueDate).toBeUndefined();
    for (let i = 0; i < 100 && plain.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 50)); Object.assign(plain, (await json('GET', `/api/v1/batches/${plain.batchId}`)).batch); }
    expect(plain.items[0].runId).toBe(pure(basic).runId);
    await refused('POST', '/api/v1/batches', { projectId: id, recordIds: [basic.recordId], outputs: ['html'], issueDate: BAD });
  });

  it('the assistant explains and answers as issued on the date', async () => {
    const ask = (issueDate?: string) => json('POST', '/api/v1/assistant/message', { message: 'Why does this message appear?', forceOffline: true, context: { projectId: id, recordId: basic.recordId, selectedNodeId: 'renewal-note', ...(issueDate ? { issueDate } : {}) } });
    const [on, before, none] = [await ask(ON), await ask(BEFORE), await ask()];
    expect(JSON.stringify(on.explanation)).not.toBe(JSON.stringify(before.explanation));
    expect(JSON.stringify(none.explanation)).toBe(JSON.stringify((await ask()).explanation));
    await refused('POST', '/api/v1/assistant/message', { message: 'Why?', forceOffline: true, context: { projectId: id, recordId: basic.recordId, issueDate: BAD } });
  });

  it('Data Explorer’s customer routes (check, add, save) say what the customer gets on the date', async () => {
    const { recordId: _r, documentType: _d, projectId: _p, generated: _g, ...data } = basic as any;
    const check = (issueDate?: string) => json('POST', `/api/v1/projects/${id}/records/check`, { record: data, ...(issueDate ? { issueDate } : {}) });
    const variantOf = (o: any) => o.outcome.messages.find((m: any) => m.nodeId === 'renewal-note')?.variantId;
    const [on, before, none] = [await check(ON), await check(BEFORE), await check()];
    expect(variantOf(on)).toBe(pure(basic, ON).result.selectedVariants['renewal-note']);
    expect(variantOf(before)).toBe(pure(basic, BEFORE).result.selectedVariants['renewal-note']);
    expect(none.outcome.blocking.map((b: any) => b.code)).toContain('DOCUMENT_DATE_MISSING');
    await refused('POST', `/api/v1/projects/${id}/records/check`, { record: data, issueDate: BAD });
    const added = await inj('POST', `/api/v1/projects/${id}/records`, { record: data, issueDate: ON });
    expect(added.statusCode, added.body.slice(0, 300)).toBe(201);
    expect(variantOf(added.json())).toBe(pure(basic, ON).result.selectedVariants['renewal-note']);
    const own = added.json().record.recordId;
    const saved = await json('PUT', `/api/v1/projects/${id}/records/${own}`, { record: data, issueDate: BEFORE });
    expect(variantOf(saved)).toBe(pure(basic, BEFORE).result.selectedVariants['renewal-note']);
    const savedNone = await json('PUT', `/api/v1/projects/${id}/records/${own}`, { record: data });
    expect(savedNone.outcome.blocking.map((b: any) => b.code)).toContain('DOCUMENT_DATE_MISSING');
    await refused('POST', `/api/v1/projects/${id}/records`, { record: data, issueDate: BAD });
    await refused('PUT', `/api/v1/projects/${id}/records/${own}`, { record: data, issueDate: BAD });
  });

  it('translations: which texts customers are shown follows the date', async () => {
    const csv = async (issueDate?: string) => (await inj('GET', `/api/v1/projects/${id}/translations.csv?locale=es-US${issueDate ? `&issueDate=${issueDate}` : ''}`)).body;
    const [on, before, none] = [await csv(ON), await csv(BEFORE), await csv()];
    // The CSV states each text's status, worked out from who is shown it on that day (the same as the engine on that day).
    const expected = (issueDate?: string) => toTranslationCsv(project, 'es-US', customers.map((record) => usageEntryFromResolution(project, record, resolve({ project, record, ...(issueDate ? { issueDate } : {}) }) as any)));
    const usage = (issueDate?: string) => JSON.stringify(customers.map((record) => usageEntryFromResolution(project, record, resolve({ project, record, ...(issueDate ? { issueDate } : {}) }) as any).partIds));
    expect(usage(ON)).not.toBe(usage(BEFORE));
    expect(on).toBe(expected(ON));
    expect(before).toBe(expected(BEFORE));
    expect(none).toBe(expected());
    await refused('GET', `/api/v1/projects/${id}/translations.csv?locale=es-US&issueDate=${BAD}`);
  });

  it('generate test customers plans as issued on the date', async () => {
    const plan = async (issueDate?: string) => json('POST', `/api/v1/projects/${id}/test-data/plan`, { outcomes: true, edges: false, ...(issueDate ? { issueDate } : {}) });
    const [on, none] = [await plan(ON), await plan()];
    expect(on.summary).toBeTruthy();
    expect(none).toEqual(await plan());
    await refused('POST', `/api/v1/projects/${id}/test-data/plan`, { outcomes: true, edges: false, issueDate: BAD });
  });

  it('setup and project import take the date and refuse a bad one (their documents start without dates)', async () => {
    const draft = (issueDate?: string) => inj('POST', '/api/v1/projects/setup/draft', { sampleData: { format: 'csv', data: 'name,amount\nAda,10\nBo,20\n' }, ...(issueDate ? { issueDate } : {}) });
    const [d1, d0] = [await draft(ON), await draft()];
    expect(d1.statusCode, d1.body.slice(0, 300)).toBe(200);
    expect(d1.json().preview).toEqual(d0.json().preview);
    await refused('POST', '/api/v1/projects/setup/draft', { sampleData: { format: 'csv', data: 'name,amount\nAda,10\n' }, issueDate: BAD });
    await refused('POST', '/api/v1/projects/setup', { spec: {}, title: 'x', customers: 'generate', source: 'builtin', issueDate: BAD });
    const file = (await inj('GET', `/api/v1/projects/${id}/export`)).json();
    const imported = await inj('POST', '/api/v1/projects/import', { file, dryRun: true, issueDate: ON });
    expect(imported.statusCode, imported.body.slice(0, 300)).toBe(200);
    await refused('POST', '/api/v1/projects/import', { file, dryRun: true, issueDate: BAD });
  });

  it('a document that does not use dates gives the same answers with or without a date', async () => {
    const body = { projectId: 'aster-card-demo', recordId: 'CARD-0001' };
    const a = await json('POST', '/api/v1/resolve', body);
    const b = await json('POST', '/api/v1/resolve', { ...body, issueDate: ON });
    expect(b.runId).toBe(a.runId);
    expect(b.result).toEqual(a.result);
    expect(b.documentDate).toBeUndefined();
    const l1 = await json('POST', '/api/v1/analysis/landscape', { projectId: 'aster-card-demo' });
    const l2 = await json('POST', '/api/v1/analysis/landscape', { projectId: 'aster-card-demo', issueDate: ON });
    expect(l2).toEqual(l1);
    const c1 = await json('POST', '/api/v1/projects/aster-card-demo/records/check', { record: (await json('GET', '/api/v1/records/CARD-0001')).record });
    const c2 = await json('POST', '/api/v1/projects/aster-card-demo/records/check', { record: (await json('GET', '/api/v1/records/CARD-0001')).record, issueDate: ON });
    expect(c2).toEqual(c1);
  });
});
