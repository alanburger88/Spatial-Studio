import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project, SyntheticRecord } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { proofRecordProblems, resolve, verifyProof, type ProofOutput, type ProofRecord } from '@iss/resolver';
import { renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms } from '@iss/renderers';
import { captureExpectation } from '@iss/scenarios';
import { inputSchemaFromDictionary, parseInput, withoutValues } from '@iss/runtime';
import { buildApp } from '../src/app';
import { countPdfPages } from '../src/composer';
import { releaseTemplate, type PackageComposer } from '../src/releasePackage';
import { buildRunnablePackage } from '../src/runnablePackage';
import { zipEntries, zipRead } from '../src/zip';

/**
 * The runnable package (phase 7): built by the studio, unpacked to a temporary folder OUTSIDE the repository, and run
 * there with plain `node` and a bare environment, so nothing from the workspace can help it. Its outputs are compared
 * byte for byte with the studio's own renderers on the frozen release.
 *
 * Composition is replaced by a stub except in the last suite, which composes real PDFs once.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const REPO = path.resolve(__dirname, '../../..');
const tmp = (what: string) => mkdtempSync(path.join(tmpdir(), `iss-runtime-${what}-`));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function stubComposer(): PackageComposer & { pdfs: number } {
  const stub = {
    pdfs: 0,
    async pdf(html: string) { stub.pdfs++; return { pdf: Buffer.from(`%PDF-1.4\n% stub composition ${sha(html)}\n%%EOF\n`), pageCount: 1, facts: null }; },
    async html() { return { facts: null }; },
  };
  return stub;
}

/** Writes a ZIP's entries into a folder; returns the folder the package unpacks into. */
function unpack(zip: Buffer, into: string): string {
  const names = zipEntries(zip).map((e) => e.name);
  for (const e of zipEntries(zip)) {
    const file = path.join(into, ...e.name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, zipRead(zip, e));
  }
  return path.join(into, names[0].split('/')[0]);
}

/** The environment an operator's machine gives the package: a PATH and a home, nothing from this workspace. */
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), LANG: 'C.UTF-8' };
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  return { ...env, ...extra };
}

function node(cwd: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  const r = spawnSync(process.execPath, args, { cwd, env: bareEnv(extra), encoding: 'utf8', timeout: 240_000, input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const readJsonl = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * Loaded before the package's own code (`node --import`): records every attempt to open an outbound connection
 * (TCP, TLS, DNS, fetch, http/https requests) to a file, and refuses it. Listening for connections is allowed.
 */
const NETWORK_GUARD = `
import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https'; import { appendFileSync } from 'node:fs';
const log = process.env.NET_GUARD_LOG;
const note = (what) => { appendFileSync(log, what + '\\n'); };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { note('net.Socket.connect ' + JSON.stringify(args[0] && typeof args[0] === 'object' ? { host: args[0].host, port: args[0].port, path: args[0].path } : args.slice(0, 2))); return origConnect.apply(this, args); };
const wrap = (obj, name, label) => { const f = obj[name]; obj[name] = function (...a) { note(label); return f.apply(this, a); }; };
wrap(tls, 'connect', 'tls.connect'); wrap(dns, 'resolve', 'dns.resolve');
// listen() looks its own address up; a lookup of an IP address never leaves the machine, any other is recorded.
const lookup = dns.lookup; dns.lookup = function (host, ...a) { if (!/^(127\\.\\d+\\.\\d+\\.\\d+|::1|0\\.0\\.0\\.0|::)$/.test(String(host))) note('dns.lookup ' + host); return lookup.call(this, host, ...a); };
wrap(http, 'request', 'http.request'); wrap(http, 'get', 'http.get'); wrap(https, 'request', 'https.request'); wrap(https, 'get', 'https.get');
if (globalThis.fetch) { const f = globalThis.fetch; globalThis.fetch = (...a) => { note('fetch'); return f(...a); }; }
`;

/* ====================================================================== the package, with the studio's own checks */

describe('the runnable package (composition replaced by a stub)', () => {
  let ctx: Ctx;
  const stub = stubComposer();
  const CARD = 'aster-card-demo';
  const REL = `${CARD}-r1`;
  const IMPORTED = { givenName: 'Zebulon', familyName: 'Quackenbush' };
  const SUPPLIED = { givenName: 'Wilhelmina', familyName: 'Featherstonehaugh' };
  const EDITED = { givenName: 'Ignatius', familyName: 'Throckmorton' };
  const SECRETS = [IMPORTED.givenName, IMPORTED.familyName, SUPPLIED.givenName, SUPPLIED.familyName, EDITED.givenName, EDITED.familyName, 'Quackenbush-Merchant', 'BORRADOR'];
  let zip = Buffer.alloc(0);
  let files = new Map<string, Buffer>();
  let pkgDir = '';
  let frozen: Project;
  let template: Project;
  const work = tmp('work');

  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
  const json = async (method: any, url: string, payload?: any) => (await inj(method, url, payload)).json();

  beforeAll(async () => {
    ctx = await buildApp({ dataDir: tmp('data'), logger: false, auth: false, releasePackage: { composer: stub, scenarioCap: 10, referenceCap: 2 } });
    // The card sample is made approvable (Spanish texts approved), and given what a package must never carry:
    // customers imported, supplied for this document and edited by a person, pinned tests on them, and drafts.
    const readiness = (await json('GET', `/api/v1/projects/${CARD}/workflow`)).readiness;
    const ids = [...new Set((readiness.blocking as any[]).filter((b) => b.code === 'REQUIRED_TRANSLATION_MISSING').map((b) => b.nodeId as string))];
    const sample = (await json('GET', '/api/v1/records/CARD-0001')).record;
    const { recordId: _id, ...row } = sample;
    const withName = (name: typeof IMPORTED) => ({ ...row, customer: { ...row.customer, ...name }, card: { ...row.card, transactions: row.card.transactions.map((t: any, i: number) => (i === 0 ? { ...t, merchant: 'Quackenbush-Merchant' } : t)) } });
    const imported = (await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', format: 'json', data: [withName(IMPORTED)] })).imported[0].recordId;
    const supplied = (await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', projectId: CARD, scope: 'project', format: 'json', data: [withName(SUPPLIED)] })).imported[0].recordId;
    expect((await inj('POST', `/api/v1/projects/${CARD}/test-data`, { outcomes: true, edges: false })).statusCode).toBe(201);
    const generated = ((await json('GET', `/api/v1/records?documentType=credit-statement&full=1&projectId=${CARD}`)).records as any[]).filter((r) => r.generated);
    expect((await inj('PUT', `/api/v1/projects/${CARD}/records/${generated[0].recordId}`, { record: { ...generated[0], customer: { ...generated[0].customer, ...EDITED } } })).statusCode).toBe(200);
    const all = (await json('GET', `/api/v1/records?documentType=credit-statement&full=1&projectId=${CARD}`)).records as any[];
    const rec = (id: string) => all.find((r) => r.recordId === id);
    const p: any = (await json('GET', `/api/v1/projects/${CARD}`)).project;
    for (const part of p.contentParts) if (ids.includes(part.id)) part.approvedLocales['es-US'] = `ES aprobado: ${part.approvedLocales['en-US']}`;
    p.testCases = [
      { id: 'T01', name: 'Everyday customer', recordId: 'CARD-0001', expect: captureExpectation(p, rec('CARD-0001')) },
      { id: 'T02', name: 'Imported customer', recordId: imported, expect: captureExpectation(p, rec(imported)) },
      { id: 'T03', name: 'Supplied customer', recordId: supplied, expect: captureExpectation(p, rec(supplied)) },
      { id: 'T04', name: 'Edited customer', recordId: generated[0].recordId, expect: captureExpectation(p, rec(generated[0].recordId)) },
    ];
    p.strings = { ...(p.strings ?? {}), '@payment-due/label': { draft: { 'es-US': 'BORRADOR pago mínimo' } } };
    const part = p.contentParts.find((c: any) => c.approvedLocales['es-US']);
    part.draftLocales = { ...(part.draftLocales ?? {}), 'es-US': 'BORRADOR sin aprobar' };
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/v1/projects/${CARD}`, payload: { project: { ...p, modelVersion: p.modelVersion + 1 } }, headers: { 'if-match': `"${p.modelVersion}"` } });
    expect(put.statusCode, put.body.slice(0, 300)).toBe(200);
    for (const action of ['submit', 'approve']) expect((await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action })).statusCode).toBe(200);
    frozen = ctx.store.releaseProject(REL)!;
    template = releaseTemplate(frozen);
    expect(JSON.stringify(frozen)).toContain('BORRADOR');
  }, 120_000);
  afterAll(async () => { await ctx.app.close(); rmSync(work, { recursive: true, force: true }); });

  it('is prepared on request, kept once built, and building it again gives the same bytes', async () => {
    const url = `/api/v1/releases/${REL}/runtime`;
    expect((await json('GET', `${url}/status`)).runtime).toEqual({ status: 'not-built', fileName: `${REL}-runtime.zip`, sha256: null, bytes: null, files: null, builtAt: null, progress: null, error: null, verified: null, engine: null, proofCases: null });
    const first = await inj('GET', url);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ started: true, runtime: { status: 'building' } });
    const done = await inj('POST', url, { wait: true });
    expect(done.statusCode).toBe(200);
    const status = done.json().runtime;
    expect(status).toMatchObject({ status: 'ready', fileName: `${REL}-runtime.zip`, error: null, verified: null, engine: { version: 'iss-resolver/1.0.0' } });
    expect(status.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(status.engine.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(status.proofCases).toBeGreaterThan(3);
    // It needed the release package, which was prepared for it.
    expect((await json('GET', `/api/v1/releases/${REL}/package/status`)).package.status).toBe('ready');

    const dl = await inj('GET', url);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="${REL}-runtime.zip"`);
    expect(dl.headers['x-sha256']).toBe(status.sha256);
    zip = dl.rawPayload;
    expect(sha(zip)).toBe(status.sha256);
    expect(zip.length).toBe(status.bytes);
    files = new Map(zipEntries(zip).map((e) => [e.name.slice(`${REL}-runtime/`.length), zipRead(zip, e)]));
    expect(files.size).toBe(status.files);

    // Built again after the clock moved on: the same bytes, and the kept one stays.
    await new Promise((r) => setTimeout(r, 1100));
    const again = await inj('POST', url, { verify: true, wait: true });
    expect(again.json().runtime).toMatchObject({ status: 'ready', sha256: status.sha256, builtAt: status.builtAt, verified: { same: true, sha256: status.sha256, error: null } });
    // and building it directly from the same inputs is the same bytes too
    const direct = await buildRunnablePackage(ctx.store.release(REL)!, frozen, { releaseZip: (await inj('GET', `/api/v1/releases/${REL}/package`)).rawPayload, composer: stubComposer() });
    expect(direct.sha256).toBe(status.sha256);

    const events = (await json('GET', '/api/v1/audit?action=release.runtime&limit=20')).events as any[];
    expect(events.map((e) => e.detail.event).reverse()).toEqual(['started', 'ready', 'check-started', 'checked']);
    expect(events.find((e) => e.detail.event === 'ready').detail).toMatchObject({ releaseId: REL, number: 1, sha256: status.sha256, releasePackageBuilt: true, engine: status.engine });
    expect(JSON.stringify(events)).not.toMatch(/Quackenbush|Featherstonehaugh|Throckmorton|BORRADOR/);
    expect((await inj('GET', '/api/v1/releases/nope-r1/runtime/status')).statusCode).toBe(404);
  });

  it('holds the agreed layout; runtime.json lists every other file with its SHA-256; release/ is the release package as it is', async () => {
    const runtime = JSON.parse(files.get('runtime.json')!.toString('utf8'));
    expect(zipEntries(zip)[0].name).toBe(`${REL}-runtime/runtime.json`);
    expect(zipEntries(zip).every((e) => e.name.startsWith(`${REL}-runtime/`))).toBe(true);
    expect(runtime).toMatchObject({ format: 'iss-runnable-package', formatVersion: 1, release: { id: REL, number: 1, contentDigest: ctx.store.release(REL)!.contentDigest }, syntheticOnly: true });
    expect(runtime.contents.map((c: any) => c.path).sort()).toEqual([...files.keys()].filter((p) => p !== 'runtime.json').sort());
    for (const c of runtime.contents) expect(sha(files.get(c.path)!), c.path).toBe(c.sha256);
    for (const p of ['README.html', 'run', 'serve', 'verify', 'package.json', 'image/Dockerfile', 'engine/iss-engine.mjs', 'engine/engine.json', 'contract/input.schema.json', 'contract/sample-input.json', 'contract/entry-point.json', 'proof/inputs.jsonl', 'proof/expected.json', 'engine/node_modules/playwright-core/package.json', 'engine/node_modules/playwright-core/LICENSE', 'engine/node_modules/playwright-core/NOTICE']) expect(files.has(p), p).toBe(true);
    // release/: exactly the release package's files
    const relZip = (await inj('GET', `/api/v1/releases/${REL}/package`)).rawPayload;
    const rel = zipEntries(relZip);
    expect([...files.keys()].filter((p) => p.startsWith('release/')).sort()).toEqual(rel.map((e) => `release/${e.name}`).sort());
    for (const e of rel) expect(files.get(`release/${e.name}`)!.equals(zipRead(relZip, e)), e.name).toBe(true);
    // the engine states its version and its own SHA-256
    const engine = JSON.parse(files.get('engine/engine.json')!.toString('utf8'));
    expect(engine).toMatchObject({ file: 'iss-engine.mjs', engine: 'iss-resolver/1.0.0', sha256: sha(files.get('engine/iss-engine.mjs')!), composer: { package: 'playwright-core', version: '1.63.0', licence: 'Apache-2.0' } });
    expect(runtime.engine.sha256).toBe(engine.sha256);
    expect(files.get('engine/iss-engine.mjs')!.toString('utf8').slice(0, 300)).toContain('Engine iss-resolver/1.0.0');
    // the contract: the schema is generated from the data dictionary, and the sample line passes the engine's own check
    const dictionary = JSON.parse(files.get('release/data/dictionary.json')!.toString('utf8'));
    const schema = JSON.parse(files.get('contract/input.schema.json')!.toString('utf8'));
    expect(schema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' });
    expect(schema.required).toEqual(expect.arrayContaining(['recordId', 'customer', 'card']));
    expect(schema.properties.card.properties.newBalanceCents).toMatchObject({ type: 'integer' });
    expect(schema.properties.card.properties.availableCreditCents).toBeUndefined(); // calculated, never supplied
    expect(schema.properties.card.properties.paymentStatus.enum).toEqual(['current', 'overdue']);
    expect(schema).toEqual(JSON.parse(JSON.stringify(inputSchemaFromDictionary(dictionary, { releaseId: REL, title: frozen.title, languages: ['en-US', 'es-US'] }))));
    expect(parseInput(JSON.parse(files.get('contract/sample-input.json')!.toString('utf8')), template).ok).toBe(true);
    // the proof pack: a line per case, every produced case with its expected files
    const expected = JSON.parse(files.get('proof/expected.json')!.toString('utf8'));
    expect(expected.cases.length).toBe(runtime.proof.cases);
    expect(expected.cases.filter((c: any) => c.status === 'invalid').map((c: any) => c.customerRef)).toEqual(['invalid-missing-given-name']);
    for (const c of expected.cases.filter((x: any) => x.status === 'produced')) for (const f of Object.values(c.files) as any[]) expect(sha(files.get(f.path)!)).toBe(f.sha256);
    expect(files.get('image/Dockerfile')!.toString('utf8')).toContain('FROM mcr.microsoft.com/playwright:v1.63.0-noble');
    const readme = files.get('README.html')!.toString('utf8');
    for (const s of ['node verify', 'node run --data customers.jsonl --outputs pdf,html,email,sms --out out', 'node serve --port 8787', 'Upgrading', 'CHROMIUM_PATH', 'Liberation Sans']) expect(readme).toContain(s);
  });

  it('runs from a folder outside the repository with plain node, and gives byte for byte what the studio gives', () => {
    pkgDir = unpack(zip, work);
    expect(path.relative(REPO, pkgDir).startsWith('..')).toBe(true);
    expect(existsSync(path.join(pkgDir, 'node_modules'))).toBe(false);
    const samples = RECORDS.filter((r) => r.documentType === 'credit-statement');
    const spanish = samples.find((r) => r.customer.locale === 'es-US')!;
    const english = samples.slice(0, 6);
    const blocked: SyntheticRecord = { ...samples[0], recordId: 'CARD-0901', card: { ...samples[0].card!, paymentStatus: 'current', missedPayments: 2 } };
    const lines = [
      ...english.map((r) => JSON.stringify(r)),
      JSON.stringify({ customerRef: 'acct-spanish', data: spanish }),
      JSON.stringify({ customerRef: 'acct-blocked', data: blocked }),
      '{ not json at all',
      JSON.stringify({ customerRef: 'acct-bad', data: { ...samples[1], recordId: 'CARD-0902', card: { ...samples[1].card, newBalanceCents: '12.50' } } }),
      '',
    ];
    writeFileSync(path.join(work, 'customers.jsonl'), lines.join('\n') + '\n');
    const r = node(pkgDir, ['run', '--data', path.join(work, 'customers.jsonl'), '--outputs', 'html,email,sms', '--out', path.join(work, 'out')]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('10 lines read: 7 produced, 1 stopped by a blocking issue, 2 invalid, 0 failed');
    const results = readJsonl(path.join(work, 'out', 'results.jsonl'));
    expect(results.map((x) => [x.line, x.status])).toEqual([[1, 'produced'], [2, 'produced'], [3, 'produced'], [4, 'produced'], [5, 'produced'], [6, 'produced'], [7, 'produced'], [8, 'stopped'], [9, 'invalid'], [10, 'invalid']]);
    expect(results[6].customerRef).toBe('acct-spanish');
    expect(results[0].customerRef).toBe(english[0].recordId);
    // a blocked customer is not produced: the codes, no files
    expect(results[7]).toMatchObject({ customerRef: 'acct-blocked', status: 'stopped', blockedBy: ['INCONSISTENT_PAYMENT_STATE'] });
    expect(results[7].files).toBeUndefined();
    expect(existsSync(path.join(work, 'out', 'documents', 'acct-blocked'))).toBe(false);
    // a bad line is reported in plain words, without the value it carried
    expect(results[8]).toEqual({ line: 9, customerRef: null, status: 'invalid', problems: ['The line is not valid JSON.'] });
    expect(results[9]).toMatchObject({ customerRef: 'acct-bad', status: 'invalid' });
    expect(results[9].problems.join(' ')).toContain('card.newBalanceCents');
    expect(JSON.stringify(results[9])).not.toContain('12.50');

    // the same bytes and run IDs as the studio's renderers on the frozen release
    const inputs: Array<{ ref: string; record: SyntheticRecord }> = [...english.map((x) => ({ ref: x.recordId, record: x })), { ref: 'acct-spanish', record: spanish }];
    const proofs = readJsonl(path.join(work, 'out', 'proof.jsonl')) as ProofRecord[];
    expect(proofs.length).toBe(8); // 7 produced + 1 stopped
    for (const [i, { ref, record }] of inputs.entries()) {
      const rec = { ...record, documentType: 'credit-statement' } as SyntheticRecord;
      const res = resolve({ project: template, record: rec, profileId: 'paged-pdf' });
      expect(results[i].runId).toBe(res.runId);
      const dir = path.join(work, 'out', 'documents', ref);
      const email = renderEmail(res, template);
      expect(readFileSync(path.join(dir, 'document.html')).equals(Buffer.from(renderInteractiveHtml(res, template), 'utf8')), `${ref} html`).toBe(true);
      expect(readFileSync(path.join(dir, 'email.html')).equals(Buffer.from(email.html, 'utf8')), `${ref} email`).toBe(true);
      expect(readFileSync(path.join(dir, 'email.txt')).equals(Buffer.from(email.text, 'utf8')), `${ref} email text`).toBe(true);
      expect(readFileSync(path.join(dir, 'sms.txt')).equals(Buffer.from(renderSms(res, template).text, 'utf8')), `${ref} sms`).toBe(true);
      expect(existsSync(path.join(dir, 'document.pdf'))).toBe(false);
      // its proof record is valid and the studio confirms it: same release, data, decisions, content and outputs
      const proof = proofs.find((x) => x.customerRef === ref)!;
      expect(proofRecordProblems(proof)).toEqual([]);
      expect(proof).toMatchObject({ producer: 'runtime', releaseId: REL, releaseNumber: 1, releaseDigest: ctx.store.release(REL)!.contentDigest, runId: res.runId, produced: true });
      expect(Date.parse(proof.producedAt)).toBeGreaterThan(Date.now() - 600_000);
      const outputs: ProofOutput[] = [
        { channel: 'html', kind: 'bytes', sha256: sha(renderInteractiveHtml(res, template)) },
        { channel: 'email', kind: 'bytes', sha256: sha(email.html) },
        { channel: 'sms', kind: 'bytes', sha256: sha(renderSms(res, template).text) },
      ];
      expect(verifyProof(proof, { release: ctx.store.release(REL)!, resolution: res, record: rec, outputs })).toEqual([]);
    }
    // the run IDs are the ones the studio published for this release: its release package's reference outputs, run again here
    const scenarios = JSON.parse(files.get('release/tests/scenarios.json')!.toString('utf8'));
    const refs = scenarios.scenarios.filter((s: any) => s.reference);
    expect(refs.length).toBeGreaterThan(0);
    const refLines = refs.map((s: any) => JSON.stringify({ customerRef: s.id, data: s.data }));
    writeFileSync(path.join(work, 'refs.jsonl'), refLines.join('\n') + '\n');
    const rr = node(pkgDir, ['run', '--data', path.join(work, 'refs.jsonl'), '--out', path.join(work, 'out-refs')]);
    expect(rr.code, rr.err).toBe(0);
    for (const [i, s] of refs.entries()) {
      const facts = JSON.parse(files.get(`release/reference/${s.id}/facts.json`)!.toString('utf8'));
      const got = readJsonl(path.join(work, 'out-refs', 'results.jsonl'))[i];
      expect(got.runId).toBe(facts.runId);
      expect(facts.runId).toBe(s.expected.runId);
      expect(readFileSync(path.join(work, 'out-refs', 'documents', s.id, 'email.html')).equals(files.get(`release/reference/${s.id}/email.html`)!)).toBe(true);
      expect(readFileSync(path.join(work, 'out-refs', 'documents', s.id, 'sms.txt')).equals(files.get(`release/reference/${s.id}/sms.txt`)!)).toBe(true);
      expect(readFileSync(path.join(work, 'out-refs', 'documents', s.id, 'document.html')).equals(files.get(`release/reference/${s.id}/document.html`)!)).toBe(true);
    }

    // approved wording only: the Spanish customer gets the approved Spanish, never the draft
    const es = readFileSync(path.join(work, 'out', 'documents', 'acct-spanish', 'document.html'), 'utf8');
    expect(es).toContain('ES aprobado');
    expect(es).not.toContain('BORRADOR');
    const stopped = proofs.find((x) => x.customerRef === 'acct-blocked')!;
    expect(stopped).toMatchObject({ produced: false, blockedBy: ['INCONSISTENT_PAYMENT_STATE'], outputs: [] });
    expect(proofRecordProblems(stopped)).toEqual([]);

    // no customer values in the results, the proof records or the console
    const said = `${readFileSync(path.join(work, 'out', 'results.jsonl'), 'utf8')}\n${readFileSync(path.join(work, 'out', 'proof.jsonl'), 'utf8')}\n${r.out}\n${r.err}`;
    for (const x of [...english, spanish]) {
      for (const v of [x.customer.givenName, x.customer.familyName, String(x.card!.newBalanceCents), x.card!.maskedAccount as string, x.card!.dueDate as string]) expect(said.includes(v), `customer value ${v}`).toBe(false);
    }
  });

  it('verify passes on the untouched package and names what differs after tampering with the template, an expected output or the engine', () => {
    const ok = node(pkgDir, ['verify', '--without-pdf']);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(ok.out).toContain('Verified: this machine produces exactly what the studio approved.');
    expect(ok.out).toContain('PDF was not checked');
    const jsonOk = JSON.parse(node(pkgDir, ['verify', '--without-pdf', '--json']).out);
    expect(jsonOk).toMatchObject({ ok: true, differences: [], pdfChecked: false });
    expect(jsonOk.checked).toBe(jsonOk.proofCases);

    const copy = (name: string) => { const d = path.join(work, name); cpSync(pkgDir, d, { recursive: true }); return d; };
    // the template: a rule's threshold changed
    const t1 = copy('tampered-template');
    const tf = path.join(t1, 'release', 'template.json');
    const t = JSON.parse(readFileSync(tf, 'utf8'));
    t.contentParts[0].approvedLocales['en-US'] = 'Something nobody approved.';
    writeFileSync(tf, JSON.stringify(t, null, 2) + '\n');
    const v1 = node(t1, ['verify', '--without-pdf']);
    expect(v1.code).toBe(1);
    expect(v1.out).toContain('NOT verified');
    expect(v1.out).toContain('release/template.json has been changed since the package was built.');
    expect(v1.out).toContain('release/template.json is not the approved template of this release');
    const run1 = node(t1, ['run', '--data', path.join(work, 'customers.jsonl'), '--out', path.join(work, 'out-t1')]);
    expect(run1.code).toBe(3);
    expect(run1.err).toContain('The package cannot be used');
    expect(existsSync(path.join(work, 'out-t1', 'results.jsonl'))).toBe(false);

    // an expected output
    const t2 = copy('tampered-expected');
    const expected = JSON.parse(readFileSync(path.join(t2, 'proof', 'expected.json'), 'utf8'));
    const target = expected.cases.find((c: any) => c.status === 'produced');
    writeFileSync(path.join(t2, ...target.files['sms.txt'].path.split('/')), 'A different SMS.');
    const v2 = node(t2, ['verify', '--without-pdf']);
    expect(v2.code).toBe(1);
    expect(v2.out).toContain(`${target.files['sms.txt'].path} has been changed since the package was built.`);
    expect(v2.out).toContain(`Proof case ${target.customerRef}: the expected sms.txt`);

    // the engine
    const t3 = copy('tampered-engine');
    const ef = path.join(t3, 'engine', 'iss-engine.mjs');
    writeFileSync(ef, readFileSync(ef, 'utf8') + '\n// changed\n');
    const v3 = node(t3, ['verify', '--without-pdf']);
    expect(v3.code).toBe(1);
    expect(v3.out).toContain('The engine file (engine/iss-engine.mjs) has been changed since the package was built');
    expect(node(t3, ['run', '--data', path.join(work, 'customers.jsonl'), '--out', path.join(work, 'out-t3')]).code).toBe(3);
  });

  it('drafts cannot be produced: a template that carries draft wording is refused', () => {
    const d = path.join(work, 'with-drafts');
    cpSync(pkgDir, d, { recursive: true });
    const tf = path.join(d, 'release', 'template.json');
    // Put the release's own drafts back in (what the studio keeps, and the package left out).
    writeFileSync(tf, JSON.stringify(frozen, null, 2) + '\n');
    const v = node(d, ['verify', '--without-pdf']);
    expect(v.code).toBe(1);
    expect(v.out).toContain('Drafts cannot be produced: only approved wording runs.');
    const run = node(d, ['run', '--data', path.join(work, 'customers.jsonl'), '--out', path.join(work, 'out-drafts')]);
    expect(run.code).toBe(3);
    expect(run.err).toContain('Drafts cannot be produced');
    // and the package itself carries no draft: the template has none, no file has the draft words
    expect(JSON.stringify(template)).not.toContain('BORRADOR');
  });

  it('makes no outbound connection: run, verify and serve under a guard that records every attempt', async () => {
    const guard = path.join(work, 'net-guard.mjs');
    writeFileSync(guard, NETWORK_GUARD);
    const log = path.join(work, 'net.log');
    writeFileSync(log, '');
    const env = { NET_GUARD_LOG: log };
    const runOut = path.join(work, 'out-guarded');
    expect(node(pkgDir, ['--import', guard, 'run', '--data', path.join(work, 'customers.jsonl'), '--out', runOut], env).code).toBe(0);
    expect(node(pkgDir, ['--import', guard, 'verify', '--without-pdf'], env).code).toBe(0);
    // serve: only inbound connections (from this test)
    const child = spawn(process.execPath, ['--import', guard, 'serve', '--port', '0'], { cwd: pkgDir, env: bareEnv(env) });
    const addr: string = await new Promise((ok, fail) => {
      let buf = '';
      child.stdout.on('data', (c) => { buf += c; const m = /at (http:\/\/[^ ]+) /.exec(buf); if (m) ok(m[1]); });
      child.on('exit', (code) => fail(new Error(`serve exited ${code}`)));
    });
    expect(addr).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const call = (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => new Promise((ok, fail) => {
      const req = request(`${addr}${p}`, { method, headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode!, body: b ? JSON.parse(b) : null })); });
      req.on('error', fail);
      if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
    const sample = RECORDS.find((r) => r.recordId === 'CARD-0002')!;
    const health = await call('GET', '/health');
    expect(health).toMatchObject({ status: 200, body: { status: 'ok', release: { id: REL } } });
    const made = await call('POST', '/render', { customerRef: 'acct-77', data: sample, outputs: ['html', 'sms'] });
    expect(made.status).toBe(200);
    const res = resolve({ project: template, record: { ...sample, documentType: 'credit-statement' } as SyntheticRecord });
    expect(made.body).toMatchObject({ status: 'produced', customerRef: 'acct-77', runId: res.runId });
    expect(made.body.outputs.html).toBe(renderInteractiveHtml(res, template));
    expect(made.body.outputs.sms.text).toBe(renderSms(res, template).text);
    expect(made.body.outputs.email).toBeUndefined();
    expect(proofRecordProblems(made.body.proof)).toEqual([]);
    const blocked = await call('POST', '/render', { ...sample, card: { ...sample.card, paymentStatus: 'current', missedPayments: 3 } });
    expect(blocked).toMatchObject({ status: 409, body: { status: 'stopped', blockedBy: ['INCONSISTENT_PAYMENT_STATE'] } });
    const invalid = await call('POST', '/render', { ...sample, card: { ...sample.card, dueDate: 'next Tuesday' } });
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(invalid.body)).not.toContain('next Tuesday');
    expect((await call('POST', '/render', '{oops')).status).toBe(400);
    expect((await call('GET', '/render')).status).toBe(405);
    expect((await call('GET', '/elsewhere')).status).toBe(404);
    const stderr: string[] = [];
    child.stderr.on('data', (c) => stderr.push(String(c)));
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    expect(readFileSync(log, 'utf8')).toBe('');
    // its log: method, route, status, time; never a reference or a value
    expect(stderr.join('')).not.toMatch(/acct-77|CARD-0002|Jordan|next Tuesday/);

    // and the engine file contains no code that opens one: only the server and the file system
    const code = files.get('engine/iss-engine.mjs')!.toString('utf8');
    expect(code).not.toMatch(/\bfetch\(|https?\.(request|get)\(|net\.connect|tls\.connect|createConnection\(|WebSocket|XMLHttpRequest|from "node:(net|tls|dns|https)"/);
    expect([...new Set([...code.matchAll(/from "node:([a-z_]+)"/g)].map((m) => m[1]))].sort()).toEqual(['crypto', 'fs', 'http', 'module', 'os', 'path', 'readline', 'url']);
  });

  it('PDF without a browser fails clearly, and everything else still works', async () => {
    const missing = { CHROMIUM_PATH: path.join(work, 'no-browser-here') };
    const r = node(pkgDir, ['run', '--data', path.join(work, 'customers.jsonl'), '--outputs', 'pdf,html', '--out', path.join(work, 'out-nobrowser')], missing);
    expect(r.code).toBe(4);
    expect(r.err).toContain('CHROMIUM_PATH is set, but there is no browser at that path. PDF needs a headless Chromium.');
    const v = node(pkgDir, ['verify'], missing);
    expect(v.code).toBe(1);
    expect(v.out).toContain('PDF needs a headless Chromium');
    const fine = node(pkgDir, ['run', '--data', path.join(work, 'customers.jsonl'), '--outputs', 'email,sms', '--out', path.join(work, 'out-nopdf')], missing);
    expect(fine.code).toBe(0);
    // no Playwright anywhere: email, SMS and HTML do not need it
    const bare = path.join(work, 'no-composer');
    cpSync(pkgDir, bare, { recursive: true });
    rmSync(path.join(bare, 'engine', 'node_modules'), { recursive: true });
    // the composer is listed in runtime.json, so verify names it; run (email/SMS/HTML) does not need it at all
    const runBare = node(bare, ['run', '--data', path.join(work, 'customers.jsonl'), '--outputs', 'html,email,sms', '--out', path.join(work, 'out-bare')]);
    expect(runBare.code).toBe(0);
    const pdfBare = node(bare, ['run', '--data', path.join(work, 'customers.jsonl'), '--outputs', 'pdf', '--out', path.join(work, 'out-bare-pdf')]);
    expect(pdfBare.code).toBe(4);
    expect(pdfBare.err).toContain('The page composer (playwright-core) was not found');
    // unknown outputs and earlier results are refused
    expect(node(pkgDir, ['run', '--data', path.join(work, 'customers.jsonl'), '--outputs', 'afp', '--out', path.join(work, 'x')]).err).toContain('AFP is a simulation');
    expect(node(pkgDir, ['run', '--data', path.join(work, 'customers.jsonl'), '--out', path.join(work, 'out')]).code).toBe(2);
  });

  it('generates synthetic customers with the engine, which then run', () => {
    const g = node(pkgDir, ['engine/iss-engine.mjs', 'generate', '--count', '40', '--out', path.join(work, 'gen.jsonl')]);
    expect(g.code, g.err).toBe(0);
    const lines = readJsonl(path.join(work, 'gen.jsonl'));
    expect(lines.length).toBe(40);
    expect(new Set(lines.map((l) => l.data.recordId)).size).toBe(40);
    const r = node(pkgDir, ['run', '--data', path.join(work, 'gen.jsonl'), '--out', path.join(work, 'out-gen')]);
    expect(r.code).toBe(0);
    const results = readJsonl(path.join(work, 'out-gen', 'results.jsonl'));
    expect(results.length).toBe(40);
    expect(results.filter((x) => x.status === 'invalid')).toEqual([]);
    const v = JSON.parse(node(pkgDir, ['engine/iss-engine.mjs', 'version']).out);
    expect(v).toMatchObject({ engine: 'iss-resolver/1.0.0', sha256: sha(files.get('engine/iss-engine.mjs')!) });
  });

  it('carries no customer data: no imported, supplied or edited customer and no draft in any file', async () => {
    const mine = (await json('GET', `/api/v1/records?documentType=credit-statement&projectId=${CARD}`)).records as any[];
    for (const who of [IMPORTED, SUPPLIED, EDITED]) expect(mine.some((r) => r.name === `${who.givenName} ${who.familyName}`)).toBe(true);
    expect(files.size).toBeGreaterThan(100);
    for (const [p, data] of files) {
      const body = `${data.toString('utf8')}\n${data.toString('latin1')}\n${data.toString('utf16le')}`;
      for (const secret of SECRETS) expect(body.includes(secret), `${secret} in ${p}`).toBe(false);
    }
    for (const secret of SECRETS) expect(zip.includes(Buffer.from(secret, 'utf8')), secret).toBe(false);
    // every proof input is a built-in sample customer or one the engine generated (the release package's scenarios)
    const scenarios = JSON.parse(files.get('release/tests/scenarios.json')!.toString('utf8'));
    const known = new Set(scenarios.scenarios.map((s: any) => JSON.stringify(s.data)));
    const inputs = files.get('proof/inputs.jsonl')!.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const i of inputs.filter((x) => x.customerRef !== 'invalid-missing-given-name')) expect(known.has(JSON.stringify(i.data))).toBe(true);
    expect(scenarios.customers.every((c: any) => c.kind === 'sample' || c.kind === 'generated')).toBe(true);
    // and none of the files states when it was built: the only moments in it are the release's own
    const r = ctx.store.release(REL)!;
    for (const p of ['runtime.json', 'engine/engine.json', 'proof/expected.json', 'contract/entry-point.json', 'contract/input.schema.json', 'README.html']) {
      for (const m of files.get(p)!.toString('utf8').matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g)) expect([r.approvedAt, r.createdAt], `${m[0]} in ${p}`).toContain(m[0]);
    }
  });

  it('a value check in plain words never quotes the value', () => {
    expect(withoutValues('New balance (card.newBalanceCents): expected a whole number of cents, got "12.50".')).toBe('New balance (card.newBalanceCents): expected a whole number of cents.');
    expect(withoutValues('Payment status (card.paymentStatus): “late” is not one of current, overdue.')).toBe('Payment status (card.paymentStatus): not one of the allowed values.');
  });
});

/* ====================================================================== who may do it */

describe('the runnable package with sign-in on', () => {
  let ctx: Ctx;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp('auth'), logger: false, auth: true, releasePackage: { composer: stubComposer(), scenarioCap: 3, referenceCap: 1 } });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    cookies.admin = await login('admin@example.test', 'correct horse battery');
    for (const [role, name] of [['author', 'Olive Author'], ['reviewer', 'Rhea Reviewer']] as const) {
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name, role, password: 'a long enough password' }, headers: cookies.admin })).statusCode).toBe(201);
      cookies[role] = await login(`${role}@example.test`, 'a long enough password');
    }
    for (const action of ['submit', 'approve']) expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/projects/harborcare-demo/workflow', payload: { action }, headers: cookies.admin })).statusCode).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('needs a session; anyone signed in may prepare and download it, as for the release package; the audit names who asked', async () => {
    const url = '/api/v1/releases/harborcare-demo-r1/runtime';
    expect((await ctx.app.inject({ method: 'GET', url: `${url}/status` })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    const z = await ctx.app.inject({ method: 'GET', url: `${url}?wait=1`, headers: cookies.reviewer });
    expect(z.statusCode).toBe(200);
    expect(z.headers['content-type']).toBe('application/zip');
    expect((await ctx.app.inject({ method: 'POST', url, payload: { verify: true, wait: true }, headers: cookies.author })).json().runtime.verified).toMatchObject({ same: true });
    const events = (await ctx.app.inject({ method: 'GET', url: '/api/v1/audit?action=release.runtime&limit=20', headers: cookies.admin })).json().events as any[];
    expect(events.map((e) => [e.userName, e.detail.event]).reverse()).toEqual([['Rhea Reviewer', 'started'], ['Rhea Reviewer', 'ready'], ['Olive Author', 'check-started'], ['Olive Author', 'checked']]);
  });
});

/* ====================================================================== real PDFs */

describe('the runnable package with the real page composer', () => {
  let ctx: Ctx;
  const work = tmp('pdf');
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp('pdf-data'), logger: false, auth: false, releasePackage: { scenarioCap: 3, referenceCap: 1 } }); });
  afterAll(async () => { await ctx.app.close(); rmSync(work, { recursive: true, force: true }); });

  it('verify composes the proof pack PDFs on this machine; run writes real PDFs with content fingerprints; a missing font fails verify', async () => {
    const EOB = 'harborcare-demo';
    for (const action of ['submit', 'approve']) expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${EOB}/workflow`, payload: { action } })).statusCode).toBe(200);
    const dl = await ctx.app.inject({ method: 'GET', url: `/api/v1/releases/${EOB}-r1/runtime?wait=1` });
    expect(dl.statusCode, dl.body.slice(0, 300)).toBe(200);
    const pkgDir = unpack(dl.rawPayload, work);
    const fonts = JSON.parse(readFileSync(path.join(pkgDir, 'release', 'assets', 'fonts.json'), 'utf8'));
    expect(fonts.referencePdfFonts.length).toBeGreaterThan(0);

    const v = node(pkgDir, ['verify', '--json']);
    const report = JSON.parse(v.out);
    expect(report, v.err).toMatchObject({ ok: true, pdfChecked: true, differences: [] });
    expect(v.code).toBe(0);

    const frozen = ctx.store.releaseProject(`${EOB}-r1`)!;
    const template = releaseTemplate(frozen);
    const customers = RECORDS.filter((r) => r.documentType === 'eob').slice(0, 3);
    writeFileSync(path.join(work, 'c.jsonl'), customers.map((c) => JSON.stringify(c)).join('\n') + '\n');
    const r = node(pkgDir, ['run', '--data', path.join(work, 'c.jsonl'), '--outputs', 'pdf,html,email,sms', '--out', path.join(work, 'out'), '--parallel', '2']);
    expect(r.code, r.err).toBe(0);
    const proofs = readJsonl(path.join(work, 'out', 'proof.jsonl')) as ProofRecord[];
    for (const c of customers) {
      const pdf = readFileSync(path.join(work, 'out', 'documents', c.recordId, 'document.pdf'));
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(20_000);
      const res = resolve({ project: template, record: c });
      const proof = proofs.find((p) => p.customerRef === c.recordId)!;
      // This release carries no draft, so the studio's stored copy resolves to the very same run ID as the package's template.
      expect(resolve({ project: frozen, record: c }).runId).toBe(res.runId);
      expect(proof.runId).toBe(res.runId);
      const pdfOut = proof.outputs.find((o) => o.channel === 'pdf')!;
      expect(pdfOut).toMatchObject({ kind: 'content', sha256: sha(renderPagedDocument(res, template, { profileId: 'paged-pdf', watermark: '' })), pages: countPdfPages(pdf) });
      expect(verifyProof(proof, { release: ctx.store.release(`${EOB}-r1`)!, resolution: res, record: c, outputs: [{ channel: 'pdf', kind: 'content', sha256: pdfOut.sha256, pages: countPdfPages(pdf) }] })).toEqual([]);
    }

    // With no fonts at all (an empty font configuration), verify fails and says which font to install.
    const conf = path.join(work, 'fonts.conf');
    writeFileSync(conf, '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><cachedir>' + path.join(work, 'fc-cache') + '</cachedir></fontconfig>\n');
    const nf = node(pkgDir, ['verify'], { FONTCONFIG_FILE: conf });
    expect(nf.code).toBe(1);
    expect(nf.out).toMatch(/The font “[^”]+” is not installed/);
    expect(readdirSync(path.join(work, 'out', 'documents')).length).toBe(3);
  }, 240_000);
});
