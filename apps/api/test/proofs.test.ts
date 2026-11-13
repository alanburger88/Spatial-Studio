import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project, SyntheticRecord } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { buildProofRecord, resolve, type ProofRecord } from '@iss/resolver';
import { renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms } from '@iss/renderers';
import { buildApp } from '../src/app';
import { proofProblems } from '../src/proofs';
import { releaseTemplate, type PackageComposer } from '../src/releasePackage';

/**
 * Proof for any customer, against the real API. PDF composition is replaced by a stand-in (a fixed page count per
 * page source); everything else (resolving the frozen release, rendering the web page, email and SMS) is the real thing.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-proofs-'));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const EOB = 'harborcare-demo';
const CARD = 'aster-card-demo';

function stubComposer(): PackageComposer & { pdfs: number } {
  const stub = {
    pdfs: 0,
    async pdf(html: string) { stub.pdfs++; return { pdf: Buffer.from(`%PDF-1.4\n% ${sha(html)}\n%%EOF\n`), pageCount: 2, facts: null }; },
    async html() { return { facts: null }; },
  };
  return stub;
}

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any) => getCtx().app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`)).project;
  const save = async (id: string, edit: (p: any) => void) => {
    const p: any = await project(id);
    edit(p);
    const r = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: p.modelVersion + 1 } }, { 'if-match': `"${p.modelVersion}"` });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    return r.json().project as Project;
  };
  const workflow = (id: string, action: string, headers?: any) => inj('POST', `/api/v1/projects/${id}/workflow`, { action }, headers);
  const approve = async (id: string) => {
    const state = (await json('GET', `/api/v1/projects/${id}/workflow?checks=0`)).state;
    if (state !== 'draft') expect((await workflow(id, 'reopen')).statusCode).toBe(200);
    expect((await workflow(id, 'submit')).statusCode).toBe(200);
    const r = await workflow(id, 'approve');
    expect(r.statusCode, JSON.stringify(r.json().error?.message ?? '')).toBe(200);
    return r.json().release.release as { id: string; number: number; contentDigest: string };
  };
  /** The card sample needs approved Spanish for four texts before it can be approved (see releases.test.ts). */
  const makeCardApprovable = async () => {
    const readiness = (await json('GET', `/api/v1/projects/${CARD}/workflow`)).readiness;
    const ids = [...new Set((readiness.blocking as any[]).filter((b) => b.code === 'REQUIRED_TRANSLATION_MISSING').map((b) => b.nodeId as string))];
    await save(CARD, (p) => { for (const part of p.contentParts) if (ids.includes(part.id)) part.approvedLocales['es-US'] = `ES aprobado: ${part.approvedLocales['en-US']}`; });
  };
  const produce = (releaseId: string, body: Record<string, unknown>, headers?: any) => inj('POST', `/api/v1/releases/${releaseId}/produce`, body, headers);
  const search = async (q: Record<string, string> = {}) => (await json('GET', `/api/v1/proofs?${new URLSearchParams(q)}`));
  const verify = (proofId: string, body: Record<string, unknown>, headers?: any) => inj('POST', `/api/v1/proofs/${proofId}/verify`, body, headers);
  const importFile = (text: string, dryRun: boolean, headers?: any) => inj('POST', '/api/v1/proofs/import', { text, dryRun }, headers);
  return { inj, json, project, save, workflow, approve, makeCardApprovable, produce, search, verify, importFile };
}

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Free text, dates and identifiers with digits from a customer's data (the reference and language are kept on purpose), plus the full name and every amount. */
function customerValues(rec: SyntheticRecord): { texts: string[]; amounts: number[] } {
  const texts = new Set<string>([`${rec.customer.givenName} ${rec.customer.familyName}`]);
  const amounts = new Set<number>();
  const walk = (v: unknown, key = ''): void => {
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k); return; }
    if (key === 'recordId' || key === 'locale' || key === 'documentType' || key === 'projectId') return;
    if (typeof v === 'string' && v.length >= 6 && /[\s\d]/.test(v)) texts.add(v);
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 1000) amounts.add(v);
  };
  walk(rec);
  return { texts: [...texts], amounts: [...amounts] };
}

/* ====================================================================== storage */

describe('proof records are only ever added', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const h = helpers(() => ctx);

  it('the table refuses a change or a removal; the same proof id twice stores nothing new', async () => {
    const rel = await h.approve(EOB);
    const made = (await h.produce(rel.id, { recordId: 'EOB-0001' })).json();
    expect(made.counts).toMatchObject({ customers: 1, produced: 1, added: 1 });
    const id = made.results[0].proofId as string;
    const db = ctx.store.db;
    expect(() => db.prepare("UPDATE proof_records SET customer_ref='someone-else' WHERE proof_id=?").run(id)).toThrow(/never changed/);
    expect(() => db.prepare('DELETE FROM proof_records WHERE proof_id=?').run(id)).toThrow(/never deleted/);
    expect(() => db.prepare('DELETE FROM proof_records').run()).toThrow(/never deleted/);
    // The same record again (as it would arrive in a file): known, nothing stored.
    const stored = (await h.json('GET', `/api/v1/proofs/${id}`)).proof as ProofRecord;
    const again = (await h.importFile(jsonl([stored]), false)).json();
    expect(again).toMatchObject({ new: 0, known: 1, added: 0, refused: 0 });
    // The same proof id saying something else: not an error, nothing changed.
    const other = (await h.importFile(jsonl([{ ...stored, customerRef: 'OTHER-REF' }]), false)).json();
    expect(other).toMatchObject({ new: 0, conflict: 1, added: 0 });
    expect((await h.json('GET', `/api/v1/proofs/${id}`)).proof).toEqual(stored);
    expect((await h.search({ documentId: EOB })).total).toBe(1);
  });

  it('checks every record with the contract before it is stored', () => {
    const rec = { schema: 'proof-record/1', proofId: 'p', releaseId: 'x-r1', documentId: 'x', releaseNumber: 1, releaseDigest: 'a'.repeat(64), engineVersion: 'e', producer: 'studio', producedAt: '2026-11-13T10:00:00.000Z', customerRef: 'c', dataFingerprint: 'b'.repeat(64), runId: 'r', locale: 'en-US', profileId: 'paged-pdf', produced: true, blockedBy: [], decisions: [], contentDigest: 'c'.repeat(64), outputs: [] };
    expect(proofProblems(rec)).toEqual([]);
    expect(proofProblems({ ...rec, customer: { name: 'A' } }).join(' ')).toMatch(/Unexpected fields: customer/);
    expect(proofProblems({ ...rec, decisions: [{ nodeId: 'n', variantId: null, ruleIds: [], value: 1250 }] }).join(' ')).toMatch(/decision carries unexpected fields: value/);
    expect(proofProblems({ ...rec, outputs: [{ channel: 'sms', kind: 'bytes', sha256: 'd'.repeat(64), text: 'Hello Morgan' }] }).join(' ')).toMatch(/output fingerprint carries unexpected fields: text/);
    expect(proofProblems({ ...rec, produced: false, outputs: [{ channel: 'sms', kind: 'bytes', sha256: 'd'.repeat(64) }] }).join(' ')).toMatch(/not produced cannot list outputs/);
    expect(proofProblems({ ...rec, outputs: [{ channel: 'sms', kind: 'bytes', sha256: 'd'.repeat(64) }, { channel: 'sms', kind: 'bytes', sha256: 'e'.repeat(64) }] }).join(' ')).toMatch(/same output twice/);
  });
});

/* ====================================================================== produce, look up, verify */

describe('producing from a release, looking up and verifying', () => {
  let ctx: Ctx;
  let composer: ReturnType<typeof stubComposer>;
  let r1: { id: string; number: number; contentDigest: string };
  let all: any;
  beforeAll(async () => {
    composer = stubComposer();
    ctx = await buildApp({ dataDir: tmp(), logger: false, releasePackage: { composer } });
    r1 = await helpers(() => ctx).approve(EOB);
  });
  afterAll(async () => { await ctx.app.close(); });
  const h = helpers(() => ctx);
  const eobCustomers = RECORDS.filter((r) => r.documentType === 'eob');

  it('produces email, SMS and web page by default for every test customer from the frozen release, one record each', async () => {
    const res = await h.produce(r1.id, { all: true });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
    all = res.json();
    expect(all.outputs).toEqual(['html', 'email', 'sms']);
    expect(all.counts).toMatchObject({ customers: eobCustomers.length, produced: eobCustomers.length, stopped: 0, added: eobCustomers.length });
    expect(all.filesKept).toBe(false);
    expect(composer.pdfs).toBe(0); // no PDF unless asked for
    const one = (await h.json('GET', `/api/v1/proofs/${all.results[0].proofId}`));
    expect(one.proof).toMatchObject({ schema: 'proof-record/1', producer: 'studio', releaseId: r1.id, releaseNumber: 1, releaseDigest: r1.contentDigest, documentId: EOB });
    expect(one.proof.outputs.map((o: any) => [o.channel, o.kind])).toEqual([['html', 'bytes'], ['email', 'bytes'], ['sms', 'bytes']]);
    expect(Math.abs(Date.parse(one.proof.producedAt) - Date.now())).toBeLessThan(60_000);
    expect(one.release).toMatchObject({ status: 'known', message: null, info: { number: 1, standing: 'test' } });
    // The same fingerprint the runnable package computes: SHA-256 of the exact SMS text from the frozen template.
    const template = releaseTemplate(ctx.store.releaseProject(r1.id)!);
    const rec = eobCustomers.find((r) => r.recordId === one.proof.customerRef)!;
    const res2 = resolve({ project: template, record: rec, profileId: 'paged-pdf' });
    expect(one.proof.runId).toBe(res2.runId);
    expect(one.proof.contentDigest).toBe(res2.contentDigest);
  });

  it('the PDF, when asked for, is fingerprinted by the content it is composed from and its page count', async () => {
    const res = await h.produce(r1.id, { recordId: 'EOB-0002', outputs: ['pdf', 'sms'] });
    expect(res.statusCode).toBe(201);
    const p = (await h.json('GET', `/api/v1/proofs/${res.json().results[0].proofId}`)).proof as ProofRecord;
    const pdf = p.outputs.find((o) => o.channel === 'pdf')!;
    const template = releaseTemplate(ctx.store.releaseProject(r1.id)!);
    const rr = resolve({ project: template, record: RECORDS.find((r) => r.recordId === 'EOB-0002')!, profileId: 'paged-pdf' });
    expect(pdf).toEqual({ channel: 'pdf', kind: 'content', sha256: sha(renderPagedDocument(rr, template, { profileId: 'paged-pdf', watermark: '' })), pages: 2 });
    expect(p.outputs.map((o) => o.channel)).toEqual(['pdf', 'sms']);
    // The PDF limit (each one is composed in a browser).
    const many = await h.produce(r1.id, { all: true, outputs: ['pdf'] });
    expect(many.statusCode).toBe(413);
    expect(many.json().error.message).toMatch(/at most 20 customers/);
  });

  it('refuses what it cannot do, in plain words', async () => {
    expect((await h.produce(r1.id, {})).json().error.code).toBe('CUSTOMERS_REQUIRED');
    expect((await h.produce(r1.id, { recordId: 'CARD-0001' })).statusCode).toBe(404); // not a test customer of this document
    expect((await h.produce(r1.id, { all: true, outputs: ['fax'] })).json().error.code).toBe('INVALID_OUTPUTS');
    expect((await h.produce(`${EOB}-r99`, { all: true })).statusCode).toBe(404);
  });

  it('looks records up by document, release, customer reference, proof or run id and date, newest first, paged', async () => {
    const everything = await h.search({ documentId: EOB, limit: '100' });
    expect(everything.total).toBe(eobCustomers.length + 1);
    expect(everything.records[0].proof.customerRef).toBe('EOB-0002'); // produced last
    const times = everything.records.map((x: any) => x.proof.producedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect((await h.search({ releaseId: r1.id })).total).toBe(eobCustomers.length + 1);
    expect((await h.search({ customerRef: 'EOB-0002' })).total).toBe(2);
    const some = all.results[3];
    const stored = (await h.json('GET', `/api/v1/proofs/${some.proofId}`)).proof;
    expect((await h.search({ q: some.proofId.slice(6, 16) })).records.map((x: any) => x.proof.proofId)).toEqual([some.proofId]);
    expect((await h.search({ q: stored.runId })).records.map((x: any) => x.proof.proofId)).toContain(some.proofId);
    const today = new Date().toISOString().slice(0, 10);
    expect((await h.search({ from: today, to: today })).total).toBe(eobCustomers.length + 1);
    expect((await h.search({ to: '2020-01-01' })).total).toBe(0);
    expect((await h.inj('GET', '/api/v1/proofs?from=yesterday')).statusCode).toBe(400);
    const page2 = await h.search({ documentId: EOB, limit: '5', offset: '5' });
    expect(page2.records.map((x: any) => x.proof.proofId)).toEqual(everything.records.slice(5, 10).map((x: any) => x.proof.proofId));
    expect((await h.inj('GET', '/api/v1/proofs/proof-nope')).statusCode).toBe(404);
  });

  it('explains each part with names from the frozen release, and holds no values', async () => {
    const d = await h.json('GET', `/api/v1/proofs/${all.results[0].proofId}`);
    expect(d.explanation.namedFrom).toBe('release');
    expect(d.explanation.valuesHeld).toBe(false);
    const template = releaseTemplate(ctx.store.releaseProject(r1.id)!);
    const withMessage = d.explanation.decisions.filter((x: any) => x.variantId);
    expect(withMessage.length).toBeGreaterThan(0);
    for (const x of withMessage) {
      expect(x.message).toBe(template.contentParts.find((c) => c.id === x.variantId)!.title);
      expect(x.part).not.toBe(x.nodeId);
    }
    const ruled = d.explanation.decisions.flatMap((x: any) => x.rules);
    expect(ruled.length).toBeGreaterThan(0);
    for (const rule of ruled) expect(rule.title).not.toBe(rule.id);
  });

  it('verifies: same data and release give the same result; changed data names the difference; nothing supplied is kept', async () => {
    const pick = all.results[1];
    const rec = eobCustomers.find((r) => r.recordId === pick.customerRef)!;
    const same = (await h.verify(pick.proofId, { recordId: rec.recordId })).json();
    expect(same).toMatchObject({ same: true, verdict: 'Same data, same release, same result.', differences: [], checked: { dataFrom: 'test-customer', stored: false } });
    expect(same.explanation.length).toBeGreaterThan(0);
    expect(same.recreated.sms.length).toBeGreaterThan(0);
    expect(same.recreated.email.subject.length).toBeGreaterThan(0);

    // The same data supplied as JSON: the same answer.
    const supplied = (await h.verify(pick.proofId, { record: JSON.parse(JSON.stringify(rec)) })).json();
    expect(supplied).toMatchObject({ same: true, checked: { dataFrom: 'supplied' } });

    // Changed data: named.
    const changed = { ...rec, claims: rec.claims!.map((c, i) => (i === 0 ? { ...c, service: 'Something else entirely' } : c)) };
    const diff = (await h.verify(pick.proofId, { record: changed })).json();
    expect(diff.same).toBe(false);
    expect(diff.verdict).toBe('Not the same.');
    expect(diff.differences.map((x: any) => x.kind)).toContain('data');
    expect(diff.differences.find((x: any) => x.kind === 'data').plain).toMatch(/not the data the document was produced from/);
    expect(diff.explanation).toBeUndefined();
    expect(diff.recreated).toBeUndefined();

    // Data that cannot be a customer of this document.
    const bad = await h.verify(pick.proofId, { record: { recordId: 'X', documentType: 'credit-statement' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/Nothing was stored/);
    expect((await h.verify(pick.proofId, {})).json().error.code).toBe('DATA_REQUIRED');

    // Nothing of the supplied data is stored anywhere: not in the records, not in the audit.
    const dump = JSON.stringify((ctx.store.db.prepare('SELECT * FROM proof_records').all())) + JSON.stringify(ctx.store.listAudit({ limit: 500 }));
    expect(dump).not.toContain('Something else entirely');
    const audits = ctx.store.listAudit({ action: 'proof.verify' });
    expect(audits.length).toBe(3);
    expect(audits[0].detail).toMatchObject({ proofId: pick.proofId, same: false, dataFrom: 'supplied', differences: expect.arrayContaining(['data']) });
  });

  it('a release side is always the frozen release: editing the working project does not change the verdict; another release is named', async () => {
    const pick = all.results[2];
    // Change the wording of every message in the working project and save it (not approved).
    await h.save(EOB, (p) => { for (const c of p.contentParts) c.approvedLocales['en-US'] = `${c.approvedLocales['en-US']} (edited after the proof)`; });
    const still = (await h.verify(pick.proofId, { recordId: pick.customerRef })).json();
    expect(still.same).toBe(true);
    // Approving the edit makes release 2; release 1 is superseded and nothing more is produced from it.
    const r2 = await h.approve(EOB);
    expect(r2.number).toBe(2);
    const refused = await h.produce(r1.id, { all: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'RELEASE_NOT_CURRENT' });
    expect(refused.json().error.message).toMatch(/replaced by a later release/);
    // Checked against release 2: not the release it was produced from, and the content differs.
    const other = (await h.verify(pick.proofId, { recordId: pick.customerRef, releaseId: r2.id })).json();
    expect(other.same).toBe(false);
    const kinds = other.differences.map((x: any) => x.kind);
    expect(kinds).toContain('release');
    expect(kinds).toContain('content');
    expect(other.differences.find((x: any) => x.kind === 'release').plain).toMatch(/release 1/);
    // The record's own release still answers "same".
    expect((await h.verify(pick.proofId, { recordId: pick.customerRef })).json().same).toBe(true);
  });

  it('a tampered record is caught: the differences are named', async () => {
    const stored = (await h.json('GET', `/api/v1/proofs/${all.results[4].proofId}`)).proof as ProofRecord;
    const i = stored.decisions.findIndex((d) => d.variantId);
    const tampered: ProofRecord = { ...stored, proofId: 'proof-tampered-0001', decisions: stored.decisions.map((d, j) => (j === i ? { ...d, variantId: 'some-other-message' } : d)), outputs: stored.outputs.map((o) => (o.channel === 'sms' ? { ...o, sha256: sha('another text') } : o)) };
    expect((await h.importFile(jsonl([tampered]), false)).json()).toMatchObject({ added: 1 });
    const v = (await h.verify(tampered.proofId, { recordId: stored.customerRef })).json();
    expect(v.same).toBe(false);
    const kinds = v.differences.map((x: any) => x.kind);
    expect(kinds).toContain('decision');
    expect(kinds).toContain('output');
    expect(v.differences.find((x: any) => x.kind === 'output').plain).toBe('The text message (SMS) differs from what was produced.');
    expect(v.differences.find((x: any) => x.kind === 'decision').plain).toMatch(/showed “some-other-message” then and shows “.+” now/);
  });

  it('adds records from a proof.jsonl: a dry run first, then the import; runtime records are kept and searched like studio ones', async () => {
    const template = releaseTemplate(ctx.store.releaseProject(r1.id)!);
    const rec = eobCustomers[5];
    const runtime = buildProofRecord({ release: { id: r1.id, documentId: EOB, number: 1, contentDigest: r1.contentDigest }, resolution: resolve({ project: template, record: rec, profileId: 'paged-pdf' }), record: rec, producer: 'runtime', producedAt: '2026-11-10T08:00:00.000Z', customerRef: 'BILLING-77', outputs: [] });
    const foreign = { ...runtime, proofId: 'proof-foreign-0001', customerRef: 'FOREIGN-1', releaseId: 'elsewhere-doc-r4', documentId: 'elsewhere-doc', releaseNumber: 4 };
    const text = [JSON.stringify(runtime), '', 'not json at all', JSON.stringify({ ...runtime, proofId: 'proof-extra-1', customer: { givenName: 'Morgan' } }), JSON.stringify(foreign), JSON.stringify(runtime)].join('\n');
    const dry = (await h.importFile(text, true)).json();
    expect(dry).toMatchObject({ dryRun: true, lines: 5, new: 2, known: 1, refused: 2, unknownRelease: 1, added: 0, producers: { runtime: 2, studio: 0 } });
    expect(dry.details.find((d: any) => d.line === 3)).toMatchObject({ outcome: 'refused', problems: ['The line is not JSON.'] });
    expect(dry.details.find((d: any) => d.line === 4).problems.join(' ')).toMatch(/Unexpected fields: customer/);
    expect(JSON.stringify(dry)).not.toContain('Morgan');
    expect((await h.search({ customerRef: 'BILLING-77' })).total).toBe(0); // a dry run stores nothing
    expect(ctx.store.listAudit({ action: 'proof.import' })).toHaveLength(1); // only the earlier real import of the tampered record

    const done = (await h.importFile(text, false)).json();
    expect(done).toMatchObject({ dryRun: false, added: 2, refused: 2 });
    const found = await h.search({ customerRef: 'BILLING-77' });
    expect(found.total).toBe(1);
    expect(found.records[0]).toMatchObject({ proof: { producer: 'runtime', releaseId: r1.id }, meta: { source: 'file' }, release: { status: 'known' } });
    expect((await h.search({ releaseId: r1.id, q: runtime.runId })).records.some((x: any) => x.proof.producer === 'runtime')).toBe(true);
    const unknown = await h.json('GET', `/api/v1/proofs/${foreign.proofId}`);
    expect(unknown.release).toMatchObject({ status: 'unknown' });
    expect(unknown.release.message).toMatch(/Release not known here/);
    expect(unknown.explanation.namedFrom).toBe('ids');
    expect((await h.verify(foreign.proofId, { recordId: rec.recordId })).json().error.code).toBe('RELEASE_NOT_KNOWN');
    // A runtime record verifies like a studio one.
    expect((await h.verify(runtime.proofId, { record: rec })).json().same).toBe(true);

    // Size limits.
    const big = await h.importFile('x'.repeat(5 * 1024 * 1024 + 10), true);
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('FILE_TOO_LARGE');
    expect((await h.inj('POST', '/api/v1/proofs/import', { dryRun: true })).json().error.code).toBe('TEXT_REQUIRED');
  });

  it('writes audit entries with names and numbers, never data', async () => {
    const produce = ctx.store.listAudit({ action: 'proof.produce' });
    expect(produce.length).toBe(2);
    expect(produce.at(-1)!.detail).toMatchObject({ releaseId: r1.id, number: 1, customers: eobCustomers.length, produced: eobCustomers.length, stopped: 0, all: true, outputs: ['html', 'email', 'sms'] });
    expect(ctx.store.listAudit({ action: 'proof.import' }).at(0)!.detail).toMatchObject({ added: 2, refused: 2, runtime: 2 });
  });

  it('the reset is for tests only', async () => {
    const saved = { p: process.env.PROOFS_RESET, r: process.env.RELEASES_RESET };
    delete process.env.PROOFS_RESET; delete process.env.RELEASES_RESET;
    try {
      expect((await h.inj('POST', '/api/v1/proofs/reset', { confirm: true })).statusCode).toBe(403);
      process.env.PROOFS_RESET = 'allow';
      expect((await h.inj('POST', '/api/v1/proofs/reset', {})).statusCode).toBe(400);
      const r = (await h.json('POST', '/api/v1/proofs/reset', { confirm: true }));
      expect(r.removed).toBeGreaterThan(30);
      expect((await h.search()).total).toBe(0);
      // Still closed to anything but the reset.
      expect(() => ctx.store.db.prepare('DELETE FROM proof_records').run()).not.toThrow(); // empty table: nothing to refuse
    } finally {
      if (saved.p === undefined) delete process.env.PROOFS_RESET; else process.env.PROOFS_RESET = saved.p;
      if (saved.r === undefined) delete process.env.RELEASES_RESET; else process.env.RELEASES_RESET = saved.r;
    }
  });
});

/* ====================================================================== releases approved with translation drafts */

describe('a release approved while it had translation drafts is produced from its template (approved wording only)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const h = helpers(() => ctx);
  const DRAFT = 'BORRADOR SIN APROBAR';

  it('gives the run id, content fingerprint and output bytes of the release package template, never draft wording; a runtime record verifies as same', async () => {
    await h.save(EOB, (p) => { for (const c of p.contentParts) c.draftLocales = { ...(c.draftLocales ?? {}), 'es-US': `${DRAFT} ${c.id}` }; });
    const rel = await h.approve(EOB);
    const frozen = ctx.store.releaseProject(rel.id)!;
    expect(frozen.contentParts.some((c) => c.draftLocales?.['es-US']?.startsWith(DRAFT))).toBe(true); // the stored approved version carries the drafts
    const template = releaseTemplate(frozen);
    expect(JSON.stringify(template)).not.toContain(DRAFT);
    // The template is what GET /releases/:id/template serves (the package's template.json).
    expect(JSON.stringify(await h.json('GET', `/api/v1/releases/${rel.id}/template`))).toBe(JSON.stringify(template));

    const rec = RECORDS.find((r) => r.documentType === 'eob' && r.customer.locale === 'es-US') ?? RECORDS.find((r) => r.documentType === 'eob')!;
    const made = (await h.produce(rel.id, { recordId: rec.recordId })).json();
    const proof = (await h.json('GET', `/api/v1/proofs/${made.results[0].proofId}`)).proof as ProofRecord;
    const fromTemplate = resolve({ project: template, record: rec, profileId: 'paged-pdf' });
    const fromFrozen = resolve({ project: frozen, record: rec, profileId: 'paged-pdf' });
    expect(fromFrozen.runId).not.toBe(fromTemplate.runId); // why the stored project must not be used
    expect(proof.runId).toBe(fromTemplate.runId);
    expect(proof.contentDigest).toBe(fromTemplate.contentDigest);
    const email = renderEmail(fromTemplate, template), sms = renderSms(fromTemplate, template), html = renderInteractiveHtml(fromTemplate, template);
    expect(proof.outputs).toEqual([
      { channel: 'html', kind: 'bytes', sha256: sha(html), size: Buffer.byteLength(html) },
      { channel: 'email', kind: 'bytes', sha256: sha(email.html), size: Buffer.byteLength(email.html) },
      { channel: 'sms', kind: 'bytes', sha256: sha(sms.text), size: Buffer.byteLength(sms.text) },
    ]);
    const v = (await h.verify(proof.proofId, { recordId: rec.recordId })).json();
    expect(v.same).toBe(true);
    expect(JSON.stringify(v.recreated)).not.toContain(DRAFT);

    // A record the runnable package would write (from template.json, same fingerprints) verifies as the same.
    const runtime = buildProofRecord({ release: { id: rel.id, documentId: EOB, number: rel.number, contentDigest: rel.contentDigest }, resolution: fromTemplate, record: rec, producer: 'runtime', producedAt: '2026-11-12T09:00:00.000Z', customerRef: 'RUNTIME-REF-1', outputs: proof.outputs });
    expect((await h.importFile(jsonl([runtime]), false)).json()).toMatchObject({ added: 1, unknownRelease: 0 });
    expect((await h.verify(runtime.proofId, { record: rec })).json()).toMatchObject({ same: true, differences: [] });
  });
});

/* ====================================================================== no customer data */

describe('no customer data is stored by this feature', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const h = helpers(() => ctx);

  it('produces for every sample customer of both samples and finds none of their values in the stored rows or the audit', async () => {
    await h.makeCardApprovable();
    const card = await h.approve(CARD);
    const eob = await h.approve(EOB);
    // A customer of the document's own whose claim does not add up: the engine stops the document for them.
    const base = RECORDS.find((r) => r.recordId === 'EOB-0001')!;
    const { recordId: _id, ...data } = base;
    const own = await h.inj('POST', `/api/v1/projects/${EOB}/records`, { record: { ...data, customer: { ...base.customer, givenName: 'Quinlan', familyName: 'Ashgrove-Patel' }, claims: base.claims!.map((c) => ({ ...c, planPaidCents: 12_345, serviceDate: '2026-09-07' })) } });
    expect(own.statusCode, own.body.slice(0, 300)).toBe(201);
    const ownRecord = own.json().record as SyntheticRecord;
    const cardRun = (await h.produce(card.id, { all: true })).json();
    const eobRun = (await h.produce(eob.id, { all: true })).json();
    const samples = [...RECORDS.filter((r) => r.documentType === 'credit-statement' || r.documentType === 'eob'), ownRecord];
    expect(cardRun.counts.customers + eobRun.counts.customers).toBe(samples.length);
    // Customers the engine stops are recorded as not produced, with no outputs.
    expect(eobRun.counts.stopped).toBeGreaterThan(0);
    const stopped = eobRun.results.find((x: any) => !x.produced);
    expect(stopped.customerRef).toBe(ownRecord.recordId);
    expect(stopped).toMatchObject({ produced: false, outputs: [] });
    expect(stopped.blockedBy.length).toBeGreaterThan(0);
    // One sample customer checked with the data supplied again, so the data has passed through the server.
    const pick = eobRun.results[0];
    expect((await h.verify(pick.proofId, { record: RECORDS.find((r) => r.recordId === pick.customerRef) })).json().same).toBe(true);

    const rows = JSON.stringify(ctx.store.db.prepare('SELECT * FROM proof_records').all()).replace(/\\"size\\":\d+/g, '');
    const auditText = JSON.stringify(ctx.store.listAudit({ action: 'proof.', limit: 500 }));
    expect(rows.length).toBeGreaterThan(10_000);
    let checked = 0;
    for (const rec of samples) {
      const { texts, amounts } = customerValues(rec);
      for (const t of texts) {
        expect(rows.includes(t), `customer value “${t}” of ${rec.recordId} must not be stored`).toBe(false);
        expect(auditText.includes(t), `customer value “${t}” of ${rec.recordId} must not be in the audit`).toBe(false);
        checked++;
      }
      for (const n of amounts) {
        const re = new RegExp(`(?<![0-9a-f])${n}(?![0-9a-f])`);
        expect(re.test(rows), `amount ${n} of ${rec.recordId} must not be stored`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

/* ====================================================================== roles */

describe('proof records with sign-in on: who may do what', () => {
  let ctx: Ctx;
  const saved = { AUTH: process.env.AUTH, ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
  let releaseId = '';
  let proofId = '';
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: true, releasePackage: { composer: stubComposer() } });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      expect(r.statusCode).toBe(200);
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    cookies.admin = await login('admin@example.test', 'correct horse battery');
    for (const role of ['author', 'reviewer', 'approver'] as const) {
      expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name: `A ${role}`, role, password: 'a long enough password' }, headers: cookies.admin })).statusCode).toBe(201);
      cookies[role] = await login(`${role}@example.test`, 'a long enough password');
    }
    const wf = (action: string, who: string) => ctx.app.inject({ method: 'POST', url: `/api/v1/projects/${EOB}/workflow`, payload: { action }, headers: cookies[who] });
    expect((await wf('submit', 'author')).statusCode).toBe(200);
    const ok = await wf('approve', 'approver');
    releaseId = ok.json().release.release.id;
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const h = helpers(() => ctx);

  it('needs a session for everything', async () => {
    expect((await h.inj('GET', '/api/v1/proofs')).statusCode).toBe(401);
    expect((await h.produce(releaseId, { all: true })).statusCode).toBe(401);
    expect((await h.importFile('', true)).statusCode).toBe(401);
  });

  it('only approvers and admins produce and add records; refusals are in plain words', async () => {
    for (const role of ['author', 'reviewer']) {
      const p = await h.produce(releaseId, { recordId: 'EOB-0001' }, cookies[role]);
      expect(p.statusCode, role).toBe(403);
      expect(p.json().error.message).toBe('Only approvers and admins can produce documents from a release.');
      const i = await h.importFile('', true, cookies[role]);
      expect(i.statusCode, role).toBe(403);
      expect(i.json().error.message).toBe('Only approvers and admins can add proof records.');
    }
    const made = await h.produce(releaseId, { recordId: 'EOB-0001' }, cookies.approver);
    expect(made.statusCode).toBe(201);
    proofId = made.json().results[0].proofId;
    expect((await h.importFile('', true, cookies.admin)).statusCode).toBe(200);
    expect((await h.inj('POST', '/api/v1/proofs/reset', { confirm: true }, cookies.approver)).statusCode).toBe(403);
  });

  it('everyone signed in can look records up and check one', async () => {
    for (const role of ['author', 'reviewer', 'approver', 'admin']) {
      expect((await h.json('GET', `/api/v1/proofs?releaseId=${releaseId}`, undefined, cookies[role])).total, role).toBe(1);
      expect((await h.inj('GET', `/api/v1/proofs/${proofId}`, undefined, cookies[role])).statusCode, role).toBe(200);
      const v = await h.verify(proofId, { recordId: 'EOB-0001' }, cookies[role]);
      expect(v.statusCode, role).toBe(200);
      expect(v.json().same).toBe(true);
    }
    const audits = ctx.store.listAudit({ action: 'proof.verify' });
    expect(audits.map((a) => a.userName).sort()).toEqual(['A approver', 'A author', 'A reviewer', 'Administrator']);
    expect(ctx.store.listAudit({ action: 'proof.produce' })[0].userName).toBe('A approver');
  });
});
