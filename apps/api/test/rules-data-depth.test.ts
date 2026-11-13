import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project, SyntheticRecord } from '@iss/model';
import { resolve, type ProofRecord } from '@iss/resolver';
import { buildApp } from '../src/app';
import { releaseTemplate, type PackageComposer } from '../src/releasePackage';
import { zipEntries, zipRead } from '../src/zip';
import { depthProject } from '../../../packages/model/test/helpers/depthProject';

/**
 * Calculated fields, lookup tables and the document's date through the studio's routes, the release package and the
 * runnable package (run outside the repository with plain node, including a dated proof case). Composition is a stub.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = (what: string) => mkdtempSync(path.join(tmpdir(), `iss-depth-${what}-`));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const ON = '2026-11-25';

function stubComposer(): PackageComposer {
  return { async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% ${sha(html)}\n%%EOF\n`), pageCount: 1, facts: null }; }, async html() { return { facts: null }; } };
}
function unpack(zip: Buffer, into: string): string {
  for (const e of zipEntries(zip)) { const file = path.join(into, ...e.name.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, zipRead(zip, e)); }
  return path.join(into, zipEntries(zip)[0].name.split('/')[0]);
}
const node = (cwd: string, args: string[]) => {
  const r = spawnSync(process.execPath, args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 240_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const readJsonl = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('rules and data depth through the studio, the release package and the runnable package', () => {
  let ctx: Ctx;
  let id = '';
  let customers: SyntheticRecord[] = [];
  let releaseId = '';
  let template: Project;
  const work = tmp('work');
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any) => (await inj(method, url, payload)).json();

  beforeAll(async () => {
    ctx = await buildApp({ dataDir: tmp('data'), logger: false, auth: false, releasePackage: { composer: stubComposer(), scenarioCap: 24, referenceCap: 8 } });
    const made = (await json('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Membership notice', issuerName: 'Northside Gym', accent: '#1f4e79' })).project as Project;
    id = made.projectId;
    const d = depthProject();
    const put = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...d, projectId: id, title: made.title, issuer: made.issuer, modelVersion: made.modelVersion + 1 } }, { 'if-match': `"${made.modelVersion}"` });
    expect(put.statusCode, put.body.slice(0, 400)).toBe(200);
    expect((await inj('POST', `/api/v1/projects/${id}/test-data`, { outcomes: true, edges: false })).statusCode).toBe(201);
    customers = (await json('GET', `/api/v1/records?documentType=custom&full=1&projectId=${id}`)).records;
  }, 120_000);
  afterAll(async () => { await ctx.app.close(); rmSync(work, { recursive: true, force: true }); });

  it('a draft project with a broken calculation or table is refused in plain words', async () => {
    const p: any = (await json('GET', `/api/v1/projects/${id}`)).project;
    const bad = JSON.parse(JSON.stringify(p));
    bad.calculatedFields[0].expr = { op: 'field', path: 'custom.nope' };
    const r = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...bad, modelVersion: p.modelVersion + 1 } }, { 'if-match': `"${p.modelVersion}"` });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe('A calculated field in the file is not valid: “Days to renewal”: “custom.nope” is not a data field of this document.');
  });

  it('the resolve route takes the "as issued on" date; it is part of the run id and the run reproduces', async () => {
    const recordId = customers[0].recordId;
    const a = await json('POST', '/api/v1/resolve', { projectId: id, recordId, issueDate: ON });
    const b = await json('POST', '/api/v1/resolve', { projectId: id, recordId, issueDate: '2027-01-02' });
    const none = await json('POST', '/api/v1/resolve', { projectId: id, recordId });
    expect(a.runId).not.toBe(b.runId);
    expect(none.findings.map((f: any) => f.code)).toContain('DOCUMENT_DATE_MISSING');
    expect(a.findings.some((f: any) => f.code === 'DOCUMENT_DATE_MISSING')).toBe(false);
    const again = await inj('POST', '/api/v1/compose/html', { runId: a.runId });
    expect(again.statusCode, again.body.slice(0, 200)).toBe(200);
    expect(again.headers['x-run-id']).toBe(a.runId);
    expect((await inj('POST', '/api/v1/resolve', { projectId: id, recordId, issueDate: '2026-02-30' })).statusCode).toBe(400);
  });

  it('is approved on its whole dated behaviour and released', async () => {
    const readiness = (await json('GET', `/api/v1/projects/${id}/workflow`)).readiness;
    expect(readiness.blocking, JSON.stringify(readiness.blocking).slice(0, 400)).toEqual([]);
    for (const action of ['submit', 'approve']) { const r = await inj('POST', `/api/v1/projects/${id}/workflow`, { action }); expect(r.statusCode, r.body.slice(0, 300)).toBe(200); }
    releaseId = `${id}-r1`;
    template = releaseTemplate(ctx.store.releaseProject(releaseId)!);
    expect(template.calculatedFields).toHaveLength(6);
    expect(template.documentDate).toEqual({ source: 'run' });
  });

  it('the release package lists calculations, lookup tables and date boundaries, with reference outputs on each side of every boundary', async () => {
    const zip = (await inj('GET', `/api/v1/releases/${releaseId}/package?wait=1`)).rawPayload;
    const files = new Map(zipEntries(zip).map((e) => [e.name, zipRead(zip, e)]));
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.documentDate).toEqual({ source: 'run' });
    expect(manifest.dateBoundaries.map((b: any) => b.date)).toEqual(['2026-01-01', '2026-12-01', '2027-01-01', '2027-03-01', '2027-06-01']);
    expect(manifest.dateBoundaries[2].changes.map((c: any) => c.words)).toContain('Rule “New year offer for Basic” starts to apply');
    const scenarios = JSON.parse(files.get('tests/scenarios.json')!.toString('utf8')).scenarios as any[];
    for (const b of manifest.dateBoundaries) {
      const before = scenarios.find((s) => s.id === b.scenarios.dayBefore);
      const on = scenarios.find((s) => s.id === b.scenarios.onTheDay);
      expect(before).toMatchObject({ issueDate: expect.any(String), dateBoundary: { date: b.date, side: 'before' } });
      expect(on).toMatchObject({ issueDate: b.date, dateBoundary: { date: b.date, side: 'on' } });
    }
    // within the caps: 8 sets of reference outputs, all of them on a boundary (there are 10 boundary scenarios)
    expect(manifest.reference.scenarios).toHaveLength(8);
    for (const sid of manifest.reference.scenarios) expect(scenarios.find((s) => s.id === sid).dateBoundary).toBeDefined();
    expect(scenarios.length).toBeLessThanOrEqual(24);
    // what the engine works out for a dated scenario states the date and the calculated values
    const one = scenarios.find((s) => s.issueDate === '2027-01-01');
    expect(one.expected).toMatchObject({ issueDate: '2027-01-01', issueDateGiven: true, calculated: expect.objectContaining({ 'calc.bonusRate': 2 }) });
    // the data dictionary: calculated fields with their formula and plain words, the document's date, the tables
    const dict = JSON.parse(files.get('data/dictionary.json')!.toString('utf8'));
    const days = dict.fields.find((f: any) => f.path === 'calc.daysToRenewal');
    expect(days).toMatchObject({ calculated: true, type: 'number', calculatedFrom: ['custom.renewalDate', 'document.date'], calculation: { gives: 'number', formula: '=DAYS(ISSUE_DATE(), custom.renewalDate)', inWords: 'The number of days from the document’s date to “Renewal date”.' } });
    expect(dict.fields.find((f: any) => f.path === 'calc.lateFee')).toMatchObject({ calculated: true, type: 'cents', calculatedFrom: ['custom.tier'] });
    expect(dict.fields.find((f: any) => f.path === 'document.date')).toMatchObject({ calculated: true, type: 'date' });
    expect(dict.fields.find((f: any) => f.path === 'custom.renewalDate').usedIn.calculatedFields).toEqual(expect.arrayContaining(['calc.daysToRenewal']));
    expect(dict.documentDate).toMatchObject({ source: 'run' });
    expect(dict.lookupTables.map((t: any) => [t.id, t.rows.length, t.usedBy])).toEqual([['feeByTier', 2, ['calc.lateFee']], ['rates', 2, ['calc.bonusRate']]]);
    // and the README says what changes on which day
    const readme = files.get('README.html')!.toString('utf8');
    expect(readme).toContain('<h2>Dates</h2>');
    expect(readme).toContain('1 Jan 2027');
  });

  it('the runnable package takes --issue-date and a per-customer date, states it in results and proof records, and verifies a dated proof case outside the repository', async () => {
    const r = await inj('POST', `/api/v1/releases/${releaseId}/runtime`, { wait: true });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    const zip = (await inj('GET', `/api/v1/releases/${releaseId}/runtime`)).rawPayload;
    const dir = unpack(zip, work);
    const expected = JSON.parse(readFileSync(path.join(dir, 'proof', 'expected.json'), 'utf8'));
    expect(expected.cases.filter((c: any) => c.issueDate).length).toBeGreaterThan(3);
    // verify, with plain node and a bare environment, outside the repository
    const v = node(dir, ['verify', '--without-pdf', '--json']);
    const report = JSON.parse(v.out);
    expect(report, v.err).toMatchObject({ ok: true, differences: [] });
    expect(report.datedCases).toBeGreaterThan(3);
    // run: a date for the run, and a customer with its own date
    const c0 = customers[0];
    const { recordId: _r, projectId: _p, generated: _g, ...data } = c0 as any;
    const lines = [
      JSON.stringify({ customerRef: 'whole-run', data: { ...data, recordId: 'MEMBER-1' } }),
      JSON.stringify({ customerRef: 'own-date', issueDate: '2027-01-02', data: { ...data, recordId: 'MEMBER-2' } }),
      JSON.stringify({ customerRef: 'bad-date', issueDate: '2027-02-30', data: { ...data, recordId: 'MEMBER-3' } }),
    ];
    writeFileSync(path.join(work, 'in.jsonl'), lines.join('\n') + '\n');
    const run = node(dir, ['run', '--data', path.join(work, 'in.jsonl'), '--issue-date', ON, '--out', path.join(work, 'out')]);
    expect(run.code, run.err).toBe(0);
    const results = readJsonl(path.join(work, 'out', 'results.jsonl'));
    expect(results.map((x) => [x.customerRef, x.status, x.issueDate])).toEqual([['whole-run', 'produced', ON], ['own-date', 'produced', '2027-01-02'], ['bad-date', 'invalid', undefined]]);
    expect(results[2].problems).toEqual(['issueDate must be a date written as YYYY-MM-DD.']);
    const studio = resolve({ project: template, record: { ...data, recordId: 'MEMBER-1', documentType: 'custom' } as SyntheticRecord, issueDate: ON, profileId: 'paged-pdf' });
    expect(results[0].runId).toBe(studio.runId);
    const proofs = readJsonl(path.join(work, 'out', 'proof.jsonl')) as ProofRecord[];
    expect(proofs.map((p) => p.issueDate)).toEqual([ON, '2027-01-02']);
    // a bad --issue-date is refused before anything runs
    expect(node(dir, ['run', '--data', path.join(work, 'in.jsonl'), '--issue-date', 'tomorrow', '--out', path.join(work, 'out2')]).code).toBe(2);
    // no customer values in results or proof records (the date given for the run is not a customer value)
    const text = readFileSync(path.join(work, 'out', 'results.jsonl'), 'utf8') + readFileSync(path.join(work, 'out', 'proof.jsonl'), 'utf8');
    for (const v2 of [c0.customer.givenName, c0.customer.familyName, String((c0 as any).custom.renewalDate)]) expect(text.includes(v2), v2).toBe(false);
    // a proof record from the package verifies in the studio with the same date
    const imported = await inj('POST', '/api/v1/proofs/import', { text: JSON.stringify(proofs[1]) + '\n', dryRun: false });
    expect(imported.statusCode, imported.body.slice(0, 300)).toBe(200);
    const check = await inj('POST', `/api/v1/proofs/${proofs[1].proofId}/verify`, { record: { ...data, recordId: 'MEMBER-2', documentType: 'custom' } });
    expect(check.json(), check.body.slice(0, 400)).toMatchObject({ same: true });
  }, 240_000);

  it('the studio produces with a date and verifies with the same date; another date is named as the difference', async () => {
    await inj('POST', `/api/v1/releases/${releaseId}/promote`);
    const recordId = customers[0].recordId;
    const made = await inj('POST', `/api/v1/releases/${releaseId}/produce`, { recordId, issueDate: '2027-01-02' });
    expect(made.statusCode, made.body.slice(0, 300)).toBe(201);
    const proofId = made.json().results[0].proofId;
    const stored = (await json('GET', `/api/v1/proofs/${proofId}`)).proof as ProofRecord;
    expect(stored.issueDate).toBe('2027-01-02');
    const same = await json('POST', `/api/v1/proofs/${proofId}/verify`, { recordId });
    expect(same).toMatchObject({ same: true });
    const other = await json('POST', `/api/v1/proofs/${proofId}/verify`, { recordId, issueDate: '2027-01-03' });
    expect(other.same).toBe(false);
    expect(other.differences[0]).toMatchObject({ kind: 'date', plain: 'The document was produced as issued on 2 Jan 2027; it is checked as issued on 3 Jan 2027.' });
    expect((await inj('POST', `/api/v1/releases/${releaseId}/produce`, { recordId, issueDate: 'soon' })).json().error).toMatchObject({ code: 'INVALID_ISSUE_DATE' });
  });
});
