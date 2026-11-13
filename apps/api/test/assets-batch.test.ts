import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { deflateSync } from 'node:zlib';
import { buildApp } from '../src/app';
import { Store } from '../src/db';

let ctx: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-ab-')), logger: false }); });
afterAll(async () => { await ctx.app.close(); });
const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });

/** Smallest valid 2×1 RGB PNG built in-test. */
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 78, 175, 96, 29, 89, 65]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Reads entry names and contents from a ZIP produced by zipFiles (local headers only). */
function unzip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8); const size = buf.readUInt32LE(i + 18); const nameLen = buf.readUInt16LE(i + 26); const extra = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const body = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    out[name] = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    i += 30 + nameLen + extra + size;
  }
  return out;
}

describe('image asset library', () => {
  it('accepts PNG by magic bytes, dedupes identical uploads, rejects SVG and oversize images, and the data URI renders in exports', async () => {
    const dataUri = `data:image/png;base64,${png().toString('base64')}`;
    const up = await inj('POST', '/api/v1/assets', { name: 'brand mark.png', dataUri });
    expect(up.statusCode).toBe(201);
    expect(up.json().asset).toMatchObject({ mime: 'image/png', width: 2, height: 1, name: 'brand mark.png' });
    expect((await inj('POST', '/api/v1/assets', { name: 'again.png', dataUri })).statusCode).toBe(200);
    expect((await inj('GET', '/api/v1/assets')).json().assets).toHaveLength(1);
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
    expect((await inj('POST', '/api/v1/assets', { name: 'x.svg', dataUri: svg })).json().error.code).toBe('UNSUPPORTED_IMAGE');
    const big = Buffer.concat([png(), Buffer.alloc(300 * 1024)]);
    expect((await inj('POST', '/api/v1/assets', { name: 'big.png', dataUri: `data:image/png;base64,${big.toString('base64')}` })).json().error.code).toBe('ASSET_TOO_LARGE');
    const id = up.json().asset.assetId;
    const raw = await inj('GET', `/api/v1/assets/${id}/raw`);
    expect(raw.headers['content-type']).toBe('image/png');
    // use it in a document and export HTML: the image is embedded
    const { project } = (await inj('GET', '/api/v1/projects/aster-card-demo')).json();
    const logo = project.nodes.find((n: any) => n.id === 'issuer-logo');
    logo.image = { ...logo.image, src: (await inj('GET', `/api/v1/assets/${id}`)).json().dataUri };
    const html = await inj('POST', '/api/v1/compose/html', { projectId: 'aster-card-demo', recordId: 'CARD-0001', project, allowDraft: true });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain(dataUri.slice(0, 60));
    expect((await inj('DELETE', `/api/v1/assets/${id}`)).json().deleted).toBe(true);
  });
});

describe('batch run', () => {
  it('composes the selected records into a ZIP with PDFs, manifest and CSV report; blocked records are skipped and reported', async () => {
    const { project } = (await inj('GET', '/api/v1/projects/aster-card-demo')).json();
    // Make R03 and R04 tie so CARD-0002 (2 missed payments + assistance) is blocked; CARD-0001 stays clean.
    const r03 = project.rules.find((r: any) => r.id === 'R03');
    r03.priority = 400;
    r03.when = { op: 'eq', path: 'card.assistanceRequested', value: true };
    const start = await inj('POST', '/api/v1/batches', { projectId: 'aster-card-demo', project, recordIds: ['CARD-0001', 'CARD-0002'], outputs: ['pdf', 'html'] });
    expect(start.statusCode).toBe(202);
    const id = start.json().batch.batchId;
    let job: any;
    for (let i = 0; i < 120; i++) { job = (await inj('GET', `/api/v1/batches/${id}`)).json().batch; if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 250)); }
    expect(job.status).toBe('done');
    expect(job.done).toBe(2);
    const byId = Object.fromEntries(job.items.map((x: any) => [x.recordId, x]));
    expect(byId['CARD-0001']).toMatchObject({ status: 'ok' });
    expect(byId['CARD-0001'].pages).toBeGreaterThanOrEqual(1);
    expect(byId['CARD-0002'].status).toBe('blocked');
    expect(byId['CARD-0002'].blocking).toContain('EXCLUSIVE_PRIORITY_TIE');
    const zip = await inj('GET', `/api/v1/batches/${id}/zip`);
    expect(zip.headers['content-type']).toBe('application/zip');
    const files = unzip(zip.rawPayload);
    expect(Object.keys(files).sort()).toEqual(['html/aster-card-demo-card-0001.html', 'manifest.json', 'pdf/aster-card-demo-card-0001.pdf', 'run-report.csv']);
    expect(files['pdf/aster-card-demo-card-0001.pdf'].subarray(0, 5).toString()).toBe('%PDF-');
    expect(files['run-report.csv'].toString()).toMatch(/CARD-0002,.*,blocked,/);
    expect(JSON.parse(files['manifest.json'].toString()).items).toHaveLength(2);
    expect((await inj('POST', '/api/v1/batches', { projectId: 'aster-card-demo', outputs: ['afp'] })).json().error.message).toMatch(/AFP is simulation-only/);
  }, 120_000);
});

describe('export history', () => {
  it('rebuilding the PDF of the same document replaces the earlier export instead of adding another', async () => {
    const body = { projectId: 'harborcare-demo', recordId: 'EOB-0001' };
    const first = await inj('POST', '/api/v1/compose/pdf', body);
    expect(first.statusCode).toBe(200);
    const runId = String(first.headers['x-run-id']);
    const second = await inj('POST', '/api/v1/compose/pdf', body);
    expect(second.headers['x-run-id']).toBe(runId);
    const pdfs = (await inj('GET', `/api/v1/artifacts?runId=${runId}`)).json().artifacts.filter((a: any) => a.kind === 'pdf');
    expect(pdfs).toHaveLength(1);
    // the entry kept is the latest build and still downloads
    expect(pdfs[0].artifactId).toBe(second.headers['x-artifact-id']);
    expect((await inj('GET', `/api/v1/artifacts/${pdfs[0].artifactId}`)).rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // the earlier build is out of the history, but a link to it that was already copied still downloads
    // (two builds inside the same second can be byte-identical, in which case they are one and the same export)
    const earlier = String(first.headers['x-artifact-id']);
    expect((await inj('GET', `/api/v1/artifacts/${earlier}`)).rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // a different customer is a different document: its export is kept alongside
    const other = await inj('POST', '/api/v1/compose/pdf', { projectId: 'harborcare-demo', recordId: 'EOB-0003' });
    expect(other.statusCode).toBe(200);
    expect(other.headers['x-run-id']).not.toBe(runId);
    const all = (await inj('GET', '/api/v1/artifacts?projectId=harborcare-demo')).json().artifacts.filter((a: any) => a.kind === 'pdf');
    expect(all).toHaveLength(2);
  }, 120_000);

  it('a superseded PDF leaves the history but stays downloadable; identical bytes become the latest again', () => {
    const store = new Store(mkdtempSync(path.join(tmpdir(), 'iss-sup-')));
    store.saveRun('run-x', 'p1', 'r1', {}, {});
    const meta = { draft: false, renderer: 'paged-1' };
    const a = store.saveArtifact('run-x', 'pdf', 'doc.pdf', Buffer.from('%PDF-first'), meta, 1);
    const b = store.saveArtifact('run-x', 'pdf', 'doc.pdf', Buffer.from('%PDF-second'), meta, 1);
    expect(b.artifactId).not.toBe(a.artifactId);
    expect(store.listArtifacts({ runId: 'run-x' }).map((x) => x.artifactId)).toEqual([b.artifactId]);
    expect(store.getArtifact(a.artifactId)?.bytes.toString()).toBe('%PDF-first');
    expect(store.getArtifact(a.artifactId)?.meta.supersededBy).toBe(b.artifactId);
    // a draft of the same document is a different export and is kept alongside
    const d = store.saveArtifact('run-x', 'pdf', 'doc.pdf', Buffer.from('%PDF-draft'), { ...meta, draft: true }, 1);
    expect(store.listArtifacts({ runId: 'run-x' }).map((x) => x.artifactId).sort()).toEqual([b.artifactId, d.artifactId].sort());
    // the first bytes again: that export is the latest once more and the second is superseded
    store.saveArtifact('run-x', 'pdf', 'doc.pdf', Buffer.from('%PDF-first'), meta, 1);
    expect(store.listArtifacts({ runId: 'run-x' }).map((x) => x.artifactId).sort()).toEqual([a.artifactId, d.artifactId].sort());
    expect(store.getArtifact(b.artifactId)?.bytes.toString()).toBe('%PDF-second');
  });
});
