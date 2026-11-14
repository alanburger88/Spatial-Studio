import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectContentDigest, type Project } from '@iss/model';
import { EXTRA_SAMPLES, HOUSE, MERIDIAN_ID, NORTHWIND_ID } from '@iss/model/samples/index';
import { buildApp } from '../src/app';
import { pinnedCustomerRefs } from '../src/releases';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-samples-'));

/**
 * The example documents beyond the two fixture samples: seeded on the first start (project, own customers with stable
 * ids, the known data problem, Northwind's release 1 in Production with a differing working version and its proof
 * records, the house library), listed and protected as samples, restored by "Restore sample", and never re-seeded over
 * an existing data folder.
 */
describe('example documents: seeding, listing and restoring', () => {
  const dir = tmp();
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: dir, logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const customers = async (id: string) => (await json('GET', `/api/v1/records?projectId=${id}&full=1`)).records as any[];
  const northwind = EXTRA_SAMPLES().find((s) => s.project.projectId === NORTHWIND_ID)!;
  const meridian = EXTRA_SAMPLES().find((s) => s.project.projectId === MERIDIAN_ID)!;

  it('lists the four examples as samples; the new two cannot be deleted', async () => {
    const list = (await json('GET', '/api/v1/projects')).projects as any[];
    const samples = list.filter((p) => p.sample).map((p) => p.projectId).sort();
    expect(samples).toEqual(['aster-card-demo', 'harborcare-demo', MERIDIAN_ID, NORTHWIND_ID].sort());
    for (const id of [NORTHWIND_ID, MERIDIAN_ID]) {
      const row = list.find((p) => p.projectId === id);
      expect(row).toMatchObject({ documentType: 'custom', modified: false });
      expect((await inj('DELETE', `/api/v1/projects/${id}`)).json().error.code).toBe('SAMPLE_PROJECT');
    }
  });

  it('seeds each example’s own customers with their stable ids, as built-in sample customers', async () => {
    for (const s of [northwind, meridian]) {
      const got = await customers(s.project.projectId);
      expect(got.map((r) => r.recordId)).toEqual(s.customers.map((c) => c.recordId));
      expect(got.every((r) => r.projectId === s.project.projectId && !r.generated)).toBe(true);
      expect(got.length).toBeGreaterThanOrEqual(30);
    }
    // A new document's generated customers keep the studio's own numbering (the samples' ids use prefixes of their own).
    const created = await json('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Seed numbering check' });
    const mine = await customers(created.project.projectId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => /^REC-6\d{4}$/.test(r.recordId))).toBe(true);
    expect(mine.some((r) => r.recordId === 'REC-60001')).toBe(true);
  });

  it('seeds Northwind with release 1 approved and in Production, a working version that differs, and studio proof records', async () => {
    const project = (await json('GET', `/api/v1/projects/${NORTHWIND_ID}`)).project as Project;
    expect(project.modelVersion).toBe(2);
    expect(projectContentDigest(project)).toBe(projectContentDigest(northwind.project));
    const releases = (await json('GET', `/api/v1/projects/${NORTHWIND_ID}/releases`)).releases as any[];
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ number: 1, modelVersion: 1, standing: 'production', approvedBy: { name: 'Studio samples' } });
    expect(releases[0].contentDigest).toBe(projectContentDigest(northwind.release!.project));
    expect(releases[0].contentDigest).not.toBe(projectContentDigest(northwind.project));
    expect(releases[0].knownDataProblems).toHaveLength(1);
    expect(releases[0].knownDataProblems[0].customer).toEqual({ kind: 'sample', id: 'NWE-60034' });
    const wf = await json('GET', `/api/v1/projects/${NORTHWIND_ID}/workflow`);
    expect(wf.state ?? wf.workflow?.state).toBe('draft');
    const proofs = (await json('GET', `/api/v1/proofs?documentId=${NORTHWIND_ID}`)).records as any[];
    expect(proofs).toHaveLength(4);
    expect(proofs.every((p) => p.proof.producer === 'studio' && p.proof.produced && p.proof.releaseNumber === 1)).toBe(true);
    // Meridian starts as a Draft with no release, like the fixture samples.
    expect((await json('GET', `/api/v1/projects/${MERIDIAN_ID}/releases`)).releases).toEqual([]);
  });

  it('records each example’s known data problem, with its reason', async () => {
    for (const [id, recordId] of [[NORTHWIND_ID, 'NWE-60034'], [MERIDIAN_ID, 'MWS-60014']]) {
      const known = (await json('GET', `/api/v1/projects/${id}/known-data-problems`)).problems ?? (await json('GET', `/api/v1/projects/${id}/known-data-problems`)).knownDataProblems;
      expect(known).toHaveLength(1);
      expect(known[0]).toMatchObject({ recordId, customer: { origin: 'sample' } });
      expect(known[0].reason.length).toBeGreaterThan(40);
    }
  });

  it('seeds the house library, approved, with a second version of the rights notice; the examples link to it', async () => {
    const items = (await json('GET', '/api/v1/library')).items as any[];
    for (const h of HOUSE.list) {
      const it = items.find((i) => i.id === h.id);
      expect(it, h.id).toBeTruthy();
      expect(it.latest).toBe(h.versions.length);
      expect(it.draft).toBeNull();
      expect(it.usage.documents, h.id).toBeGreaterThanOrEqual(1);
    }
    const rights = items.find((i) => i.id === 'customer-rights-notice');
    expect(rights.latest).toBe(2);
    expect(rights.usage.behind).toBe(1);
    const shared = items.filter((i) => i.usage.documents === 2).map((i) => i.id).sort();
    expect(shared).toEqual(['accessible-formats-panel', 'glossary-es', 'house-wording-rules']);
  });

  it('pinned tests on the examples’ own customers count as built-in sample customers; an edited one does not', async () => {
    const refs = pinnedCustomerRefs(ctx.store as any, northwind.project);
    expect(refs.length).toBeGreaterThanOrEqual(5);
    expect(refs.every((r) => r.kind === 'sample')).toBe(true);
  });

  it('restores an edited example: the document, its customers and its known data problem; other documents are untouched', async () => {
    const asterBefore = (await json('GET', '/api/v1/projects/aster-card-demo')).project;
    const current = (await json('GET', `/api/v1/projects/${MERIDIAN_ID}`)).project as Project;
    const edited = { ...current, title: 'Meridian Wealth statement (edited)' };
    expect((await inj('PUT', `/api/v1/projects/${MERIDIAN_ID}`, { project: edited }, { 'if-match': `"${current.modelVersion}"` })).statusCode).toBe(200);
    const first = (await customers(MERIDIAN_ID))[0];
    const changed = await inj('PUT', `/api/v1/projects/${MERIDIAN_ID}/records/${first.recordId}`, { record: { ...first, customer: { ...first.customer, givenName: 'Edited' } } });
    expect(changed.statusCode).toBe(200);
    expect(pinnedCustomerRefs(ctx.store as any, meridian.project).find((r) => r.recordId === first.recordId)?.kind).toBe('supplied');
    expect((await inj('POST', `/api/v1/projects/${MERIDIAN_ID}/records`, { copyOf: first.recordId })).statusCode).toBe(201);
    expect((await json('GET', '/api/v1/projects')).projects.find((p: any) => p.projectId === MERIDIAN_ID).modified).toBe(true);

    const reset = await json('POST', `/api/v1/projects/${MERIDIAN_ID}/reset`, { confirm: true });
    expect(reset.reset).toBe(true);
    const after = (await json('GET', `/api/v1/projects/${MERIDIAN_ID}`)).project as Project;
    expect(projectContentDigest(after)).toBe(projectContentDigest(meridian.project));
    const restored = await customers(MERIDIAN_ID);
    expect(restored.map((r) => r.recordId)).toEqual(meridian.customers.map((c) => c.recordId));
    expect(restored[0].customer.givenName).toBe(meridian.customers[0].customer.givenName);
    expect(pinnedCustomerRefs(ctx.store as any, meridian.project).every((r) => r.kind === 'sample')).toBe(true);
    const known = await json('GET', `/api/v1/projects/${MERIDIAN_ID}/known-data-problems`);
    expect((known.problems ?? known.knownDataProblems)).toHaveLength(1);
    expect((await json('GET', '/api/v1/projects')).projects.find((p: any) => p.projectId === MERIDIAN_ID).modified).toBe(false);
    // Restoring again changes nothing; Aster Card was never touched.
    expect((await json('POST', `/api/v1/projects/${MERIDIAN_ID}/reset`, { confirm: true })).unchanged).toBe(true);
    expect(projectContentDigest((await json('GET', '/api/v1/projects/aster-card-demo')).project)).toBe(projectContentDigest(asterBefore));
  });

  it('is idempotent: starting again on the same data folder re-seeds nothing and keeps an edited example as it is', async () => {
    const current = (await json('GET', `/api/v1/projects/${NORTHWIND_ID}`)).project as Project;
    const edited = { ...current, title: 'Northwind bill (kept across restarts)' };
    expect((await inj('PUT', `/api/v1/projects/${NORTHWIND_ID}`, { project: edited }, { 'if-match': `"${current.modelVersion}"` })).statusCode).toBe(200);
    const before = {
      versions: (await json('GET', `/api/v1/projects/${NORTHWIND_ID}/versions`)).versions.length,
      releases: (await json('GET', `/api/v1/releases`)).releases.length,
      proofs: (await json('GET', '/api/v1/proofs?limit=100')).total,
      library: (await json('GET', '/api/v1/library')).items.map((i: any) => `${i.id}:${i.versions.length}`).join(),
      customers: (await customers(NORTHWIND_ID)).length,
    };
    await ctx.app.close();
    ctx = await buildApp({ dataDir: dir, logger: false, auth: false });
    expect((await json('GET', `/api/v1/projects/${NORTHWIND_ID}`)).project.title).toBe('Northwind bill (kept across restarts)');
    expect((await json('GET', `/api/v1/projects/${NORTHWIND_ID}/versions`)).versions.length).toBe(before.versions);
    expect((await json('GET', `/api/v1/releases`)).releases.length).toBe(before.releases);
    expect((await json('GET', '/api/v1/proofs?limit=100')).total).toBe(before.proofs);
    expect((await json('GET', '/api/v1/library')).items.map((i: any) => `${i.id}:${i.versions.length}`).join()).toBe(before.library);
    expect((await customers(NORTHWIND_ID)).length).toBe(before.customers);
  });
});
