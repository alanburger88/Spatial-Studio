/**
 * Richer data shapes (wave 5, section 2) through a release and its runnable package, end to end: the household
 * statement (a group, a list inside a list, a repeating section, a calculation per item) is approved and released,
 * its runnable package is built, unpacked OUTSIDE the repository and run with plain `node` on nested customers. What it
 * writes is byte for byte what the studio's own renderers give for the frozen release, a nested line that is wrong is
 * reported by its path without its value, and the package's own `verify` passes. Composition is a stub (no PDFs here;
 * real pages of this document are checked in `data-shapes-pdf.test.ts`).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project, SyntheticRecord } from '@iss/model';
import { buildHousehold, householdCustomers } from '@iss/model/samples/index';
import { resolve } from '@iss/resolver';
import { renderEmail, renderInteractiveHtml, renderSms } from '@iss/renderers';
import { buildApp } from '../src/app';
import { releaseTemplate, type PackageComposer } from '../src/releasePackage';
import { zipEntries, zipRead } from '../src/zip';

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const REPO = path.resolve(__dirname, '../../..');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const stub: PackageComposer = {
  async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% stub composition ${sha(html)}\n%%EOF\n`), pageCount: 1, facts: null }; },
  async html() { return { facts: null }; },
} as unknown as PackageComposer;
const work = mkdtempSync(path.join(tmpdir(), 'iss-shapes-runtime-'));
const node = (cwd: string, args: string[]) => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), LANG: 'C.UTF-8' };
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 240_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const readJsonl = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('a released document with a list inside a list, run from its package', () => {
  let ctx: Ctx;
  let projectId = '';
  let template: Project;
  let pkgDir = '';
  const customers = householdCustomers();
  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });

  beforeAll(async () => {
    ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-shapes-runtime-data-')), logger: false, auth: false, extraSamples: false, releasePackage: { composer: stub, scenarioCap: 10, referenceCap: 2 } });
    const made = await inj('POST', '/api/v1/projects/import', { file: buildHousehold() });
    expect(made.statusCode, made.body.slice(0, 300)).toBe(201);
    projectId = made.json().project.projectId;
    const imp = await inj('POST', '/api/v1/records/import', { projectId, scope: 'project', format: 'json', data: customers.map((c) => ({ customer: c.customer, custom: c.custom })) });
    expect([200, 201], imp.body.slice(0, 300)).toContain(imp.statusCode);
    for (const action of ['submit', 'approve']) { const r = await inj('POST', `/api/v1/projects/${projectId}/workflow`, { action }); expect(r.statusCode, `${action}: ${r.body.slice(0, 400)}`).toBe(200); }
    template = releaseTemplate(ctx.store.releaseProject(`${projectId}-r1`)!);
  }, 180_000);
  afterAll(async () => { await ctx.app.close(); rmSync(work, { recursive: true, force: true }); });

  it('the package is built, and its contract describes the nested input', async () => {
    const url = `/api/v1/releases/${projectId}-r1/runtime`;
    const done = await inj('POST', url, { wait: true });
    expect(done.statusCode, done.body.slice(0, 300)).toBe(200);
    expect(done.json().runtime).toMatchObject({ status: 'ready', error: null });
    const zip = (await inj('GET', url)).rawPayload;
    for (const e of zipEntries(zip)) { const file = path.join(work, ...e.name.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, zipRead(zip, e)); }
    pkgDir = path.join(work, zipEntries(zip)[0].name.split('/')[0]);
    expect(path.relative(REPO, pkgDir).startsWith('..')).toBe(true);
    const schema = JSON.parse(readFileSync(path.join(pkgDir, 'contract', 'input.schema.json'), 'utf8'));
    const accounts = schema.properties.custom.properties.accounts;
    expect(accounts.type).toBe('array');
    expect(accounts.items.properties.holder.type).toBe('object');
    expect(accounts.items.properties.transactions.type).toBe('array');
    expect(accounts.items.properties.transactions.items.properties.amountCents.type).toBe('integer');
    expect(schema.properties.custom.properties.mailing.type).toBe('object');
  }, 300_000);

  it('runs on nested customers with plain node and gives byte for byte what the studio gives; a wrong nested value is named by its path', () => {
    const pick = [1, 2, 4].map((n) => customers.find((c) => (c.custom.accounts as unknown[]).length === n)!);
    const bad = JSON.parse(JSON.stringify(pick[1]));
    bad.recordId = 'HHA-69999';
    bad.custom.accounts[1].transactions[2].amountCents = 'twelve dollars';
    writeFileSync(path.join(work, 'in.jsonl'), [...pick.map((c) => JSON.stringify(c)), JSON.stringify({ customerRef: 'bad-nested', data: bad })].join('\n') + '\n');
    const r = node(pkgDir, ['run', '--data', path.join(work, 'in.jsonl'), '--outputs', 'html,email,sms', '--out', path.join(work, 'out')]);
    expect(r.code, r.err).toBe(0);
    const results = readJsonl(path.join(work, 'out', 'results.jsonl'));
    expect(results.map((x) => x.status)).toEqual(['produced', 'produced', 'produced', 'invalid']);
    expect(results[3].problems.join(' ')).toContain('custom.accounts[1].transactions[2].amountCents');
    expect(JSON.stringify(results[3])).not.toContain('twelve dollars');
    for (const [i, c] of pick.entries()) {
      const res = resolve({ project: template, record: { ...c, documentType: 'custom' } as SyntheticRecord, profileId: 'paged-pdf' });
      expect(results[i].runId, c.recordId).toBe(res.runId);
      const dir = path.join(work, 'out', 'documents', c.recordId);
      const html = renderInteractiveHtml(res, template);
      expect(readFileSync(path.join(dir, 'document.html')).equals(Buffer.from(html, 'utf8')), `${c.recordId} html`).toBe(true);
      expect(readFileSync(path.join(dir, 'email.html')).equals(Buffer.from(renderEmail(res, template).html, 'utf8')), `${c.recordId} email`).toBe(true);
      expect(readFileSync(path.join(dir, 'sms.txt')).equals(Buffer.from(renderSms(res, template).text, 'utf8')), `${c.recordId} sms`).toBe(true);
      // Each account is on the page: its number appears, once per account of this customer.
      for (const a of c.custom.accounts as Array<{ number: string }>) expect(html, `${c.recordId} ${a.number}`).toContain(a.number);
    }
  }, 300_000);

  it('the package’s own check passes', () => {
    const v = node(pkgDir, ['verify', '--without-pdf']);
    expect(v.code, `${v.out}\n${v.err}`).toBe(0);
  }, 300_000);
});
