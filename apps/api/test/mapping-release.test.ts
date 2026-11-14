import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SOURCE_LANGUAGE, applyCommand, projectContentDigest, projectLanguages, type Command, type Project, type TargetMapping } from '@iss/model';
import { seedProjects } from '@iss/model/fixtures';
import { mappingChecks, planWordingImport, readWordingFile } from '@iss/scenarios';
import { buildApp } from '../src/app';
import { buildReleasePackage, wordingRows, wordingXliff, type PackageComposer } from '../src/releasePackage';
import { releaseVersions } from '../src/releases';
import type { StoredRelease } from '../src/db';
import { zipEntries, zipRead } from '../src/zip';
import { gymProject } from '../../../packages/model/test/helpers/customProject';

/**
 * Mappings in a release (wave 3, section 3): complete ones frozen with the release and written to the package, incomplete
 * ones left out and said so; nothing changes for a document without mappings. Also: the wording importer reads the
 * package's own wording files back without a change.
 */

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const stub: PackageComposer = {
  async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% stub composition ${sha(html)}\n%%EOF\n`), pageCount: 1, facts: null }; },
  async html() { return { facts: null }; },
};
function releaseOf(p: Project): StoredRelease {
  return {
    id: `${p.projectId}-r1`, documentId: p.projectId, number: 1, title: p.title, documentType: p.documentType, modelVersion: p.modelVersion, contentDigest: projectContentDigest(p),
    languages: [SOURCE_LANGUAGE, ...projectLanguages(p)], versions: releaseVersions(p), pinned: [], origin: 'approval',
    approvedBy: { id: 'u-approver', name: 'Ada Approver' }, approvedAt: '2026-11-14T10:00:00.000Z', createdBy: { id: 'u-approver', name: 'Ada Approver' }, createdAt: '2026-11-14T10:00:00.001Z',
    stages: { test: { status: 'current', since: '2026-11-14T10:00:00.001Z', by: null }, production: null }, documentRemovedAt: null,
  } as StoredRelease;
}
const build = (p: Project) => buildReleasePackage(releaseOf(p), p, { composer: stub, scenarioCap: 4, referenceCap: 1 });
const unzip = (zip: Buffer) => new Map(zipEntries(zip).map((e) => [e.name, zipRead(zip, e)]));
const run = (p: Project, ...cs: Command[]): Project => cs.reduce((q, c) => { const r = applyCommand(q, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const [card, eob] = seedProjects();
const TYPES: Record<string, string> = { string: 'VARCHAR(80)', enum: 'VARCHAR(20)', cents: 'BIGINT', int: 'INTEGER', points: 'INTEGER', date: 'DATE', bool: 'BOOLEAN', array: 'ARRAY', number: 'DECIMAL(12,4)' };
/** The document with two mappings: one complete, one with nothing mapped. */
function withMappings(p: Project): Project {
  const empty: TargetMapping = { id: 'map-core', name: 'Mapping for Core', system: 'Core', entries: [] };
  const rows = mappingChecks(p, empty).rows.filter((r) => r.required);
  return run(p,
    { type: 'ADD_MAPPING', mapping: { id: 'map-core', name: 'Mapping for Core', system: 'Core Banking' }, stamp: { by: 'Ada Approver', at: '2026-11-14T09:00:00Z' } },
    { type: 'SET_MAPPING_ENTRIES', mappingId: 'map-core', entries: rows.map((r) => ({ path: r.path, target: `T_${r.path.replace(/\W+/g, '_').toUpperCase()}`, targetType: TYPES[r.type] })) },
    { type: 'ADD_MAPPING', mapping: { id: 'map-print', name: 'Mapping for Print House', system: 'Print House' } },
  );
}

describe('a document without mappings', () => {
  // Fingerprints of the packages these documents made before mappings existed (the manifest lists the SHA-256 of every
  // other file, so its own SHA-256 covers the whole package). Taken at the commit this work started from.
  const BEFORE: Record<string, string> = {
    'aster-card-demo': 'f7070896c4da184e2d975b3b4808b9aa1ca3fe4489aec0e0eecb20a72f8f4ef1',
    'harborcare-demo': '5ae190704a348b17557b9e0721e4ab044e2369bdfd542d4e0a26013d18768518',
    'gym-notice': 'd07402d49ce17b55e0d8742d1bd1bb858be07ead82359eecc16b42a09da1ad50',
  };
  it('produces exactly the package bytes it produced before mappings existed', async () => {
    for (const p of [card, eob, gymProject({ withSpanish: true })]) {
      const files = unzip((await build(p)).zip);
      expect(sha(files.get('manifest.json')!), p.projectId).toBe(BEFORE[p.projectId]);
    }
  });
});

describe('mappings in the release package', () => {
  it('writes each complete mapping as JSON and CSV, lists it in the manifest, and leaves an incomplete one out (the README says so)', async () => {
    const p = withMappings(card);
    const pkg = await build(p);
    const files = unzip(pkg.zip);
    expect([...files.keys()].filter((f) => f.startsWith('data/'))).toEqual(['data/dictionary.json', 'data/mapping-mapping-for-core.csv', 'data/mapping-mapping-for-core.json']);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.mappings).toEqual([
      { id: 'map-core', name: 'Mapping for Core', system: 'Core Banking', included: true, file: 'data/mapping-mapping-for-core.json', csv: 'data/mapping-mapping-for-core.csv', fields: expect.any(Number), mapped: expect.any(Number), notNeeded: 0 },
      { id: 'map-print', name: 'Mapping for Print House', system: 'Print House', included: false, reason: 'not complete when the release was made', unmapped: expect.any(Number), typeClashes: 0, mappedTwice: 0 },
    ]);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.notIncluded).toContain('mappings that were not complete');
    expect(manifest.contents.filter((c: any) => c.path.startsWith('data/mapping')).map((c: any) => c.role)).toEqual(['mapping-csv', 'mapping']);
    const file = JSON.parse(files.get('data/mapping-mapping-for-core.json')!.toString('utf8'));
    expect(file).toMatchObject({ formatVersion: 1, complete: true, mapping: { id: 'map-core', name: 'Mapping for Core', system: 'Core Banking', created: { by: 'Ada Approver', at: '2026-11-14T09:00:00Z' } }, document: { id: 'aster-card-demo', kind: 'credit-statement' } });
    expect(file.fields.find((f: any) => f.path === 'card.newBalanceCents')).toMatchObject({ target: { name: 'T_CARD_NEWBALANCECENTS', type: 'BIGINT', typeReadAs: 'integer' }, status: 'mapped', example: expect.any(Number) });
    expect(files.get('data/mapping-mapping-for-core.csv')!.toString('utf8').split('\r\n')[0]).toBe('path,label,type,calculated,required,status,target,targetType,format,notNeededReason,note,example');
    const readme = files.get('README.html')!.toString('utf8');
    expect(readme).toContain('<h2>Mappings to production systems</h2>');
    expect(readme).toMatch(/One mapping was not complete when the release was made, so it is not in this package\./);
    expect(readme).toMatch(/Mapping for Print House<\/td><td>Print House<\/td><td>Left out: not complete \(\d+ fields not mapped\)/);
    expect(readme).not.toContain('A mapping of the data fields to a particular system’s field names.');
    // template.json never carries mappings: complete ones are in data/, incomplete ones are not handed over
    expect(JSON.parse(files.get('template.json')!.toString('utf8')).mappings).toBeUndefined();
    // nothing else changes: the dictionary is the same file as without mappings
    const plain = unzip((await build(card)).zip);
    expect(files.get('data/dictionary.json')!.equals(plain.get('data/dictionary.json')!)).toBe(true);
  });

  it('is deterministic: the same release gives the same bytes', async () => {
    const p = withMappings(eob);
    const a = await build(p), b = await build(p);
    expect(a.zip.equals(b.zip)).toBe(true);
  });

  it('with only complete mappings, nothing is said to be left out', async () => {
    const p = run(withMappings(gymProject()), { type: 'REMOVE_MAPPING', mappingId: 'map-print' });
    const files = unzip((await build(p)).zip);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.notIncluded).not.toContain('mappings that were not complete');
    expect(manifest.notIncluded).not.toContain('data/mapping-<ccm>.json');
    expect(files.has('data/mapping-mapping-for-core.json')).toBe(true);
  });
});

describe('the wording importer reads the package’s own wording files back without a change', () => {
  it('XLIFF and both CSVs: export → import gives no changes; an edit comes back as exactly that draft', () => {
    let p = gymProject({ withSpanish: true });
    const rows = wordingRows(p, 'es-US');
    const xlf = wordingXliff(rows, 'es-US', 'Membership notice, release 1');
    const x = readWordingFile(xlf, p);
    expect(x.kind).toBe('xliff');
    const plan = planWordingImport(p, x);
    expect(plan.command).toBeNull();
    expect(plan.counts.unmatched).toBe(0);
    // the package's CSV for the language
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = (rs: string[][]) => rs.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
    const table = [['id', 'kind', 'title', 'mandatory', 'status', 'sourceChanged', 'en-US', 'es-US'], ...rows.map((r) => [r.id, r.kind, r.title, r.mandatory ? 'yes' : 'no', r.status, r.sourceChanged ? 'yes' : 'no', r.source, r.target ?? ''])];
    const c = readWordingFile(csv(table), p);
    expect(c.kind).toBe('package-csv');
    expect(planWordingImport(p, c).command).toBeNull();
    const source = readWordingFile(csv([['id', 'kind', 'title', 'mandatory', 'en-US'], ...rows.map((r) => [r.id, r.kind, r.title, r.mandatory ? 'yes' : 'no', r.source])]), p);
    expect(source.kind).toBe('source-csv');
    expect(planWordingImport(p, source).command).toBeNull();
    // edit one missing translation in the XLIFF: exactly that comes back, as a draft marked imported
    const missing = rows.find((r) => r.target === null && !r.id.startsWith('@sys'))!;
    const edited = wordingXliff(rows.map((r) => (r.id === missing.id ? { ...r, target: 'Traducción nueva', status: 'approved' as const } : r)), 'es-US', 'x');
    const e = planWordingImport(p, readWordingFile(edited, p));
    expect(e.rows.flatMap((r) => r.changes)).toEqual([{ kind: 'draft', id: missing.id, title: expect.any(String), locale: 'es-US', from: null, to: 'Traducción nueva' }]);
    p = run(p, e.command!);
    expect(p.translationOrigins?.[`es-US|${missing.id}`]).toBe('imported');
  });
});

describe('releases through the API', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-mapping-')), releasePackage: { composer: stub, scenarioCap: 4, referenceCap: 1 } }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });

  it('a draft with a broken mapping is refused; the release detail says which mappings it carries; no customer data reaches a mapping file', async () => {
    const CARD = 'aster-card-demo';
    // a customer imported for every document must never appear in a package
    const sample = (await inj('GET', '/api/v1/records/CARD-0001')).json().record;
    const { recordId: _id, ...row } = sample;
    expect((await inj('POST', '/api/v1/records/import', { documentType: 'credit-statement', format: 'json', data: [{ ...row, customer: { ...row.customer, givenName: 'Zebulon', familyName: 'Quackenbush' } }] })).statusCode).toBeLessThan(300);
    const current = (await inj('GET', `/api/v1/projects/${CARD}`)).json().project as Project;
    // the card sample needs approved Spanish for some texts before it can be approved
    const readiness = (await inj('GET', `/api/v1/projects/${CARD}/workflow`)).json().readiness;
    const needEs = new Set((readiness.blocking as any[]).filter((b) => b.code === 'REQUIRED_TRANSLATION_MISSING').map((b) => b.nodeId as string));
    const next = structuredClone(withMappings(current));
    for (const part of next.contentParts) if (needEs.has(part.id)) part.approvedLocales['es-US'] = `ES: ${part.approvedLocales['en-US']}`;
    const bad = structuredClone(next); bad.mappings![0].entries.push({ path: 'card.tier', target: '<b>' });
    const refusedSave = await ctx.app.inject({ method: 'PUT', url: `/api/v1/projects/${CARD}`, payload: { project: { ...bad, modelVersion: current.modelVersion + 1 } }, headers: { 'if-match': `"${current.modelVersion}"` } });
    expect(refusedSave.statusCode).toBe(422);
    expect(refusedSave.json().error.message).toMatch(/cannot contain < or >/);
    const saved = await ctx.app.inject({ method: 'PUT', url: `/api/v1/projects/${CARD}`, payload: { project: { ...next, modelVersion: current.modelVersion + 1 } }, headers: { 'if-match': `"${current.modelVersion}"` } });
    expect(saved.statusCode, saved.body.slice(0, 300)).toBe(200);
    expect((await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'submit' })).statusCode).toBe(200);
    const approved = await inj('POST', `/api/v1/projects/${CARD}/workflow`, { action: 'approve' });
    expect(approved.statusCode, approved.body.slice(0, 300)).toBe(200);
    const detail = (await inj('GET', `/api/v1/releases/${CARD}-r1`)).json();
    expect(detail.mappings.map((m: any) => [m.name, m.complete, m.file])).toEqual([['Mapping for Core', true, 'data/mapping-mapping-for-core.json'], ['Mapping for Print House', false, null]]);
    const zip = (await inj('GET', `/api/v1/releases/${CARD}-r1/package?wait=1`)).rawPayload;
    const files = unzip(zip);
    expect(files.has('data/mapping-mapping-for-core.json')).toBe(true);
    for (const [p, data] of files) for (const secret of ['Zebulon', 'Quackenbush']) expect(data.toString('utf8').includes(secret), `${secret} in ${p}`).toBe(false);
  });
});
