import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectContentDigest, projectFileProblems, tokensIn, type Project } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { predicatePaths, resolve } from '@iss/resolver';
import { captureExpectation } from '@iss/scenarios';
import { buildApp } from '../src/app';
import { countPdfPages } from '../src/composer';
import { customerDigest, normalisePdf, packageContentType, wordingXliff, type PackageComposer, type WordingRow } from '../src/releasePackage';
import { ZIP_FIXED_DATE, zipEntries, zipFiles, zipRead } from '../src/zip';
import { gymProject } from '../../../packages/model/test/helpers/customProject';

/**
 * Releases and the release package, against the real API.
 * The browser composition is replaced by a stub everywhere except the last suite, which builds real PDFs once.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-releases-'));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Stands in for the browser: a small, repeatable "PDF" per page of HTML, and no facts read back. */
function stubComposer(): PackageComposer & { pdfs: number; fail: string | null } {
  const stub = {
    pdfs: 0,
    fail: null as string | null,
    async pdf(html: string) {
      if (stub.fail) throw new Error(stub.fail);
      stub.pdfs++;
      return { pdf: Buffer.from(`%PDF-1.4\n% stub composition ${sha(html)}\n%%EOF\n`), pageCount: 1, facts: null };
    },
    async html() { return { facts: null }; },
  };
  return stub;
}

/** Every file of a package ZIP by path. */
function unzip(zip: Buffer): Map<string, Buffer> {
  return new Map(zipEntries(zip).map((e) => [e.name, zipRead(zip, e)]));
}

/** Problems that make a document not well-formed XML (empty = well-formed). A small strict reader: elements, quoted attributes, the five entities. */
function xmlProblems(xml: string): string[] {
  const problems: string[] = [];
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) problems.push('no XML declaration');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) problems.push('a character XML cannot carry');
  const body = xml.replace(/^<\?xml[^?]*\?>/, '');
  const ENTITY = '&(?:amp|lt|gt|quot|apos);';
  const re = new RegExp(`<(/?)([A-Za-z_][\\w:.-]*)((?:\\s+[\\w:.-]+="(?:[^"<&]|${ENTITY})*")*)\\s*(/?)>|((?:[^<&]|${ENTITY})+)`, 'y');
  const stack: string[] = [];
  let roots = 0;
  let pos = 0;
  while (pos < body.length) {
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) { problems.push(`cannot be read at “${body.slice(pos, pos + 40)}”`); break; }
    pos = re.lastIndex;
    if (m[5] !== undefined) { if (!stack.length && m[5].trim()) problems.push('text outside the root element'); continue; }
    if (m[1]) { const open = stack.pop(); if (open !== m[2]) problems.push(`</${m[2]}> closes <${open}>`); continue; }
    if (!stack.length) roots++;
    const names = [...m[3].matchAll(/\s([\w:.-]+)=/g)].map((a) => a[1]);
    if (new Set(names).size !== names.length) problems.push(`<${m[2]}> repeats an attribute`);
    if (!m[4]) stack.push(m[2]);
  }
  if (stack.length) problems.push(`<${stack.join('>, <')}> never closed`);
  if (roots !== 1) problems.push(`${roots} root elements`);
  return problems;
}
const unXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** The units of one of our XLIFF files: studio text id, source, target (null when there is none) and state. */
function xliffUnits(xml: string) {
  return [...xml.matchAll(/<unit id="([^"]+)" name="([^"]*)">([\s\S]*?)<\/unit>/g)].map((m) => ({
    unitId: m[1], id: unXml(m[2]),
    state: /<segment state="([^"]+)">/.exec(m[3])?.[1] ?? null,
    source: unXml(/<source>([\s\S]*?)<\/source>/.exec(m[3])?.[1] ?? ''),
    target: /<target>/.test(m[3]) ? unXml(/<target>([\s\S]*?)<\/target>/.exec(m[3])![1]) : null,
  }));
}
/** A tiny CSV reader for the wording files (quoted cells, doubled quotes, CRLF rows). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  return rows;
}

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any) => getCtx().app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string, headers?: any): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`, undefined, headers)).project;
  /** Saves a changed copy of the project (the change is whatever `edit` does to it). */
  const save = async (id: string, edit: (p: any) => void, headers?: any) => {
    const p: any = await project(id, headers);
    edit(p);
    const r = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: p.modelVersion + 1 } }, { ...(headers ?? {}), 'if-match': `"${p.modelVersion}"` });
    expect(r.statusCode).toBe(200);
    return r.json().project as Project;
  };
  const workflow = (id: string, action: string, headers?: any, comment?: string) => inj('POST', `/api/v1/projects/${id}/workflow`, { action, ...(comment ? { comment } : {}) }, headers);
  /** Submits and approves; returns the approval response. A document that is not a draft is taken back to draft first. */
  const approve = async (id: string) => {
    const state = (await json('GET', `/api/v1/projects/${id}/workflow?checks=0`)).state;
    if (state !== 'draft') expect((await workflow(id, 'reopen')).statusCode).toBe(200);
    expect((await workflow(id, 'submit')).statusCode).toBe(200);
    const r = await workflow(id, 'approve');
    expect(r.statusCode, JSON.stringify(r.json().error?.message ?? '')).toBe(200);
    return r.json();
  };
  /**
   * The card sample cannot be approved as shipped: some customers prefer Spanish and four texts have no approved
   * Spanish. This approves a Spanish text for exactly those (what a person does in Content & Translations).
   */
  const makeCardApprovable = async () => {
    const readiness = (await json('GET', '/api/v1/projects/aster-card-demo/workflow')).readiness;
    const ids = [...new Set((readiness.blocking as any[]).filter((b) => b.code === 'REQUIRED_TRANSLATION_MISSING').map((b) => b.nodeId as string))];
    await save('aster-card-demo', (p) => {
      for (const part of p.contentParts) if (ids.includes(part.id)) part.approvedLocales['es-US'] = `ES aprobado: ${part.approvedLocales['en-US']}`;
    });
    return ids;
  };
  const packageOf = async (releaseId: string) => {
    const r = await inj('GET', `/api/v1/releases/${releaseId}/package?wait=1`);
    expect(r.statusCode, r.statusCode === 200 ? '' : r.body.slice(0, 300)).toBe(200);
    return { res: r, zip: r.rawPayload, files: unzip(r.rawPayload) };
  };
  return { inj, json, project, save, workflow, approve, makeCardApprovable, packageOf };
}

/* ====================================================================== building blocks */

describe('release package building blocks', () => {
  it('a ZIP written with the fixed date is the same bytes whenever it is written, and reads back entry by entry', async () => {
    const entries = [
      { name: 'manifest.json', data: Buffer.from('{"a":1}\n') },
      { name: 'wording/es-US.xlf', data: Buffer.from('<xliff>ñ – “quoted”</xliff>'.repeat(40), 'utf8') },
      { name: 'reference/s01/document.pdf', data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 254, 1, 2, 3]) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];
    const a = zipFiles(entries.map((e) => ({ ...e, date: ZIP_FIXED_DATE })));
    await new Promise((r) => setTimeout(r, 5));
    const b = zipFiles(entries.map((e) => ({ ...e, date: ZIP_FIXED_DATE })));
    expect(a.equals(b)).toBe(true);
    const read = zipEntries(a);
    expect(read.map((e) => [e.name, e.size])).toEqual(entries.map((e) => [e.name, e.data.length]));
    for (const [i, e] of read.entries()) expect(zipRead(a, e).equals(entries[i].data), e.name).toBe(true);
    // deflated where that is smaller, stored where it is not
    expect(read.map((e) => e.method)).toEqual([0, 8, 0, 0]);
    // the stored timestamp is 1 January 1980, 00:00, in every entry, wherever the machine is
    for (const e of read) { expect(a.readUInt16LE(e.offset + 10), e.name).toBe(0); expect(a.readUInt16LE(e.offset + 12), e.name).toBe((1 << 5) | 1); }
    // a damaged entry is refused, not returned
    const damaged = Buffer.from(a);
    damaged[read[2].offset + 30 + read[2].name.length + 4] ^= 0xff;
    expect(() => zipRead(damaged, read[2])).toThrow(/does not match its checksum/);
    expect(() => zipEntries(Buffer.from('not a zip at all, just some text'))).toThrow(/Not a ZIP/);
  });

  it('a composed PDF is made repeatable: dated at the approval, structure ids renumbered in order, every offset kept', () => {
    const pdf = (date: string, ids: number[]) => Buffer.from([
      '%PDF-1.4', `1 0 obj\n<</Creator (Chromium)\n/Producer (Skia/PDF m153)\n/CreationDate (D:${date}+02'00')\n/ModDate (D:${date}+02'00')>>\nendobj`,
      ...ids.map((n, i) => `${i + 2} 0 obj\n<</Type /StructElem\n/S /P\n/ID (node${String(n).padStart(8, '0')})>>\nendobj`),
      `9 0 obj\n<</Names [${[...ids].sort((x, y) => x - y).map((n, i) => `(node${String(n).padStart(8, '0')}) ${i + 2} 0 R`).join(' ')}]>>\nendobj`,
      'binary \u00ff\u00fe\u0000 bytes stay as they are', '%%EOF', '',
    ].join('\n'), 'latin1');
    const approvedAt = '2026-11-13T09:08:07.654Z';
    const one = normalisePdf(pdf('20270102030405', [142, 131, 150]), approvedAt);
    const two = normalisePdf(pdf('20280910111213', [138, 127, 149]), approvedAt);
    expect(one.equals(two)).toBe(true);
    const text = one.toString('latin1');
    expect(text).toContain("/CreationDate (D:20261113090807+00'00')");
    expect(text).toContain("/ModDate (D:20261113090807+00'00')");
    // renumbered by rank, so a sorted name tree stays sorted and each element keeps its own id
    expect(text.match(/\/ID \(node\d{8}\)/g)).toEqual(['/ID (node00000002)', '/ID (node00000001)', '/ID (node00000003)']);
    expect(text).toContain('[(node00000001) 2 0 R (node00000002) 3 0 R (node00000003) 4 0 R]');
    expect(one.length).toBe(pdf('20270102030405', [142, 131, 150]).length);
    expect(text).toContain('binary \u00ff\u00fe\u0000 bytes stay as they are');
    expect(normalisePdf(one, approvedAt).equals(one)).toBe(true);
    // something that is not a composed PDF passes through untouched
    const other = Buffer.from('%PDF-1.4\n% stub\n%%EOF\n');
    expect(normalisePdf(other, approvedAt).equals(other)).toBe(true);
  });

  it('XLIFF survives any wording: markup characters, quotes, line breaks and characters XML cannot carry', () => {
    const rows: WordingRow[] = [
      { id: '@a<b>/label', kind: 'label', title: 'Fees & "interest" <new>', mandatory: true, source: 'Pay < $5 & keep > $1\nsecond line {{card.dueDate}}', target: 'Pague < $5 & conserve > $1\nsegunda línea {{card.dueDate}}', status: 'approved', sourceChanged: true },
      { id: 'part-2', kind: 'message', title: 'Bell\u0007 and form feed\u000c', mandatory: false, source: 'Tab\tkept, bell\u0007 dropped — “curly” ñ 日本', target: null, status: 'missing', sourceChanged: false },
    ];
    const xml = wordingXliff(rows, 'es-US', 'Statement & "notice", release 3');
    expect(xmlProblems(xml)).toEqual([]);
    const units = xliffUnits(xml);
    expect(units).toEqual([
      { unitId: 'u1', id: '@a<b>/label', state: 'final', source: rows[0].source, target: rows[0].target },
      { unitId: 'u2', id: 'part-2', state: 'initial', source: 'Tab\tkept, bell dropped — “curly” ñ 日本', target: null },
    ]);
    expect(xml).toContain('<note category="release">Statement &amp; &quot;notice&quot;, release 3</note>');
    expect(xml).toContain('<note category="warning">The English text changed after this translation was approved.</note>');
    expect(xml).toContain('<note category="mandatory">');
    expect(xml).toContain('xml:space="preserve"');
  });

  it('a customer is recognised by its data, whatever id the studio stored it under', () => {
    const data = { documentType: 'custom' as const, customer: { givenName: 'Avery', familyName: 'Abbott', locale: 'en-US' }, custom: { tier: 'pro', visits: 3 } };
    const stored = { ...data, recordId: 'REC-60012', projectId: 'gym', generated: { label: 'Reaches “Pro members”' } };
    expect(customerDigest(stored)).toBe(customerDigest(data));
    expect(customerDigest({ ...stored, recordId: 'REC-60099' })).toBe(customerDigest(data));
    expect(customerDigest({ ...data, customer: { ...data.customer, givenName: 'Edited' } })).not.toBe(customerDigest(data));
    expect(customerDigest({ ...data, custom: { ...data.custom, visits: 4 } })).not.toBe(customerDigest(data));
  });

  it('knows how to serve each kind of file in a package', () => {
    expect(['manifest.json', 'README.html', 'reference/s01/document.pdf', 'reference/s01/sms.txt', 'wording/es-US.csv', 'wording/es-US.xlf', 'assets/x.svg', 'assets/x.PNG', 'unknown.bin'].map(packageContentType)).toEqual([
      'application/json; charset=utf-8', 'text/html; charset=utf-8', 'application/pdf', 'text/plain; charset=utf-8', 'text/csv; charset=utf-8', 'application/xliff+xml; charset=utf-8', 'image/svg+xml', 'image/png', 'application/octet-stream',
    ]);
  });
});

/* ====================================================================== releases and stages */

describe('releases (sign-in off: the local admin)', () => {
  let ctx: Ctx;
  const stub = stubComposer();
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { composer: stub } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, project, save, workflow, approve, makeCardApprovable } = helpers(() => ctx);
  const CARD = 'aster-card-demo', EOB = 'harborcare-demo';

  it('nothing is released to begin with', async () => {
    expect(await json('GET', '/api/v1/releases')).toMatchObject({ releases: [], total: 0, stages: [{ id: 'test', label: 'Test' }, { id: 'production', label: 'Production' }] });
    expect((await json('GET', '/api/v1/releases/live')).documents).toEqual([]);
    const mine = await json('GET', `/api/v1/projects/${CARD}/releases`);
    expect(mine).toMatchObject({ documentId: CARD, documentExists: true, releases: [], production: null, test: null, create: { allowed: false } });
    expect(mine.create.reason).toMatch(/Only an approved document can be released/);
    expect((await inj('GET', '/api/v1/projects/no-such-document/releases')).statusCode).toBe(404);
    expect((await inj('GET', `/api/v1/releases/${CARD}-r1`)).statusCode).toBe(404);
    expect((await inj('GET', '/api/v1/releases/not-a-release-id')).statusCode).toBe(404);
    expect((await inj('GET', '/api/v1/releases?stage=staging')).json().error.code).toBe('INVALID_STAGE');
    expect((await inj('GET', '/api/v1/releases?status=current')).json().error.code).toBe('STAGE_REQUIRED');
  });

  it('approving a document creates release 1 at Test, frozen at exactly the approved version', async () => {
    await makeCardApprovable();
    const approvedProject = await project(CARD);
    const out = await approve(CARD);
    expect(out.state).toBe('approved');
    expect(out.release).toMatchObject({ created: true, reason: null, message: 'Release 1 was created at Test.' });
    const r = out.release.release;
    expect(r).toMatchObject({
      id: `${CARD}-r1`, documentId: CARD, number: 1, title: approvedProject.title, documentType: 'credit-statement', kind: 'Credit-card statement',
      modelVersion: approvedProject.modelVersion, contentDigest: projectContentDigest(approvedProject), languages: ['en-US', 'es-US'], origin: 'approval',
      approvedBy: { id: 'local-admin', name: 'Local admin' }, createdBy: { name: 'Local admin' }, standing: 'test', documentRemoved: false,
      stages: { test: { status: 'current', by: { name: 'Local admin' } }, production: null },
      versions: { schema: '1.0.0', engine: 'iss-resolver/1.0.0', pagedRenderer: 'iss-paged-renderer/1.0.0', htmlRenderer: 'iss-html-renderer/1.0.0', emailRenderer: 'email-renderer/1', smsRenderer: 'sms-renderer/1', packageFormat: 1 },
      package: { status: 'not-built', fileName: `${CARD}-r1.zip`, sha256: null }, handover: { received: false, live: false, entries: 0 },
    });
    expect(Date.parse(r.approvedAt)).not.toBeNaN();
    // the approval moment is the one the review workflow recorded
    expect(r.approvedAt).toBe((await json('GET', `/api/v1/projects/${CARD}/workflow?checks=0`)).updatedAt);

    const detail = await json('GET', `/api/v1/releases/${CARD}-r1`);
    expect(detail.release.id).toBe(`${CARD}-r1`);
    expect(detail.history.map((h: any) => [h.kind, h.stage, h.by?.name])).toEqual([['created', 'test', 'Local admin']]);
    expect(detail.history[0].note).toBe(`Created when version ${approvedProject.modelVersion} was approved.`);
    expect(detail.handover).toEqual([]);
    expect(detail.document).toMatchObject({ id: CARD, exists: true, workflowState: 'approved' });
    expect(detail.actions.find((a: any) => a.action === 'promote')).toMatchObject({ stage: 'production', label: 'Move to Production', allowed: true, reason: null });
    expect(detail.actions.find((a: any) => a.action === 'withdraw' && a.stage === 'production')).toMatchObject({ allowed: false, reason: 'Release 1 has never been in Production.' });

    // the frozen template is the approved project as a project file: same content, no save time
    const tpl = await inj('GET', `/api/v1/releases/${CARD}-r1/template`);
    expect(tpl.headers['content-disposition']).toBe(`attachment; filename="${CARD}-r1-template.json"`);
    const { lastSavedAt: _saved, ...approvedContent } = approvedProject as Project & { lastSavedAt?: string };
    expect(tpl.json()).toEqual(approvedContent);
  });

  it('later edits to the document do not change the release, and nothing can edit one', async () => {
    const before = (await inj('GET', `/api/v1/releases/${CARD}-r1/template`)).json();
    const edited = await save(CARD, (p) => { p.title = 'Aster statement, second edition'; p.rules[0].priority += 1; });
    expect((await json('GET', `/api/v1/projects/${CARD}/workflow?checks=0`)).state).toBe('draft');
    const after = (await inj('GET', `/api/v1/releases/${CARD}-r1/template`)).json();
    expect(after).toEqual(before);
    expect(after.title).not.toBe(edited.title);
    const info = (await json('GET', `/api/v1/releases/${CARD}-r1`)).release;
    expect(info).toMatchObject({ title: before.title, modelVersion: before.modelVersion, contentDigest: projectContentDigest(before) });
    // the store has no way to change a release, and the table refuses a direct write to any frozen column
    for (const column of ['json', 'content_digest', 'number', 'title', 'approved_by_name', 'approved_at', 'versions', 'pinned']) {
      expect(() => ctx.store.db.prepare(`UPDATE releases SET ${column}=? WHERE release_id=?`).run('tampered', `${CARD}-r1`), column).toThrow(/A release is frozen/);
    }
    expect((await inj('GET', `/api/v1/releases/${CARD}-r1/template`)).json()).toEqual(before);
    // there is no route that changes or removes a release
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect((await inj(method, `/api/v1/releases/${CARD}-r1`, {})).statusCode).toBe(404);
    expect((await inj('POST', '/api/v1/releases/reset', { confirm: true })).json().error.code).toBe('RESET_DISABLED');
  });

  it('a second approval after a change creates release 2; the first is superseded in Test and kept', async () => {
    const current = await project(CARD);
    const out = await approve(CARD);
    expect(out.release).toMatchObject({ created: true, release: { id: `${CARD}-r2`, number: 2, title: 'Aster statement, second edition', modelVersion: current.modelVersion, contentDigest: projectContentDigest(current), stages: { test: { status: 'current' } } } });
    const list = await json('GET', `/api/v1/projects/${CARD}/releases`);
    expect(list.releases.map((r: any) => [r.number, r.stages.test.status, r.standing])).toEqual([[2, 'current', 'test'], [1, 'superseded', 'superseded']]);
    expect(list).toMatchObject({ test: `${CARD}-r2`, production: null });
    expect(list.releases[1].stages.test).toMatchObject({ supersededBy: 2 });
    const first = await json('GET', `/api/v1/releases/${CARD}-r1`);
    expect(first.history.map((h: any) => h.kind)).toEqual(['created', 'superseded']);
    expect(first.history[1]).toMatchObject({ stage: 'test', note: 'Release 2 took its place in Test.' });
    // each release still holds its own content
    expect((await inj('GET', `/api/v1/releases/${CARD}-r1/template`)).json().title).not.toBe('Aster statement, second edition');
    expect((await inj('GET', `/api/v1/releases/${CARD}-r2/template`)).json().title).toBe('Aster statement, second edition');
  });

  it('approving unchanged content again does not make a duplicate: the release stands and the approval is noted on it', async () => {
    const out = await approve(CARD);
    expect(out.state).toBe('approved');
    expect(out.release).toMatchObject({ created: false, reason: 'unchanged', message: 'Release 2 already holds this content, so no new release was made.', release: { id: `${CARD}-r2`, number: 2 } });
    expect((await json('GET', `/api/v1/projects/${CARD}/releases`)).releases.map((r: any) => r.number)).toEqual([2, 1]);
    const detail = await json('GET', `/api/v1/releases/${CARD}-r2`);
    expect(detail.history.map((h: any) => h.kind)).toEqual(['created', 'reapproved']);
    expect(detail.history[1].note).toMatch(/approved again with no change to the content, so no new release was made/);
    // the explicit action says the same and creates nothing
    const again = await inj('POST', `/api/v1/projects/${CARD}/releases`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, reason: 'unchanged', release: { number: 2 } });
    expect((await json('GET', `/api/v1/releases?documentId=${CARD}`)).total).toBe(2);
    expect((await json('GET', `/api/v1/projects/${CARD}/releases`)).create).toEqual({ allowed: false, reason: 'Release 2 already holds the approved version.' });
  });

  it('a document approved before releases existed gets its release from the explicit action', async () => {
    const eob = await project(EOB);
    // a draft cannot be released
    const early = await inj('POST', `/api/v1/projects/${EOB}/releases`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: 'NOT_APPROVED', state: 'draft' });
    // what an approval looked like before this feature: the review state alone, no release
    ctx.store.setWorkflow(EOB, 'submit', 'in_review', eob.modelVersion, projectContentDigest(eob), { id: 'u-old', name: 'Olive Author' }, null);
    ctx.store.setWorkflow(EOB, 'approve', 'approved', eob.modelVersion, projectContentDigest(eob), { id: 'u-app', name: 'Ada Approver' }, null);
    const approvedAt = (await json('GET', `/api/v1/projects/${EOB}/workflow?checks=0`)).updatedAt;
    const live = (await json('GET', '/api/v1/releases/live?includeUnreleased=1')).documents.find((d: any) => d.documentId === EOB);
    expect(live).toMatchObject({ releases: 0, production: null, test: null, latest: null, approvedUnreleased: true, workflow: { state: 'approved', label: 'Approved' } });
    expect((await json('GET', `/api/v1/projects/${EOB}/releases`)).create).toEqual({ allowed: true, reason: null });

    const made = await inj('POST', `/api/v1/projects/${EOB}/releases`);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      created: true, message: 'Release 1 was created at Test.',
      release: { id: `${EOB}-r1`, number: 1, origin: 'manual', approvedBy: { id: 'u-app', name: 'Ada Approver' }, approvedAt, createdBy: { name: 'Local admin' }, contentDigest: projectContentDigest(eob), stages: { test: { status: 'current' } } },
    });
    expect((await json('GET', `/api/v1/releases/${EOB}-r1`)).history[0].note).toBe(`Created from the approved version ${eob.modelVersion}.`);
    expect((await json('GET', '/api/v1/releases/live')).documents.find((d: any) => d.documentId === EOB)).toMatchObject({ releases: 1, approvedUnreleased: false, test: { number: 1 } });
    // asking again creates nothing
    expect((await inj('POST', `/api/v1/projects/${EOB}/releases`)).json()).toMatchObject({ created: false, reason: 'unchanged' });
    // publishing (the existing workflow step) does not touch releases, and a published document's approved version is still the one released
    expect((await workflow(EOB, 'publish')).statusCode).toBe(200);
    expect((await inj('POST', `/api/v1/projects/${EOB}/releases`)).json()).toMatchObject({ created: false, release: { number: 1 } });
    expect((await json('GET', `/api/v1/releases?documentId=${EOB}`)).total).toBe(1);
    expect((await inj('POST', '/api/v1/projects/no-such-document/releases')).statusCode).toBe(404);
  });

  it('moving to Production: one current Production release per document; the earlier one is superseded and kept', async () => {
    const p2 = await inj('POST', `/api/v1/releases/${CARD}-r2/promote`, { note: 'Agreed at the release meeting' });
    expect(p2.statusCode).toBe(200);
    expect(p2.json()).toMatchObject({ release: { number: 2, standing: 'production', stages: { test: { status: 'current' }, production: { status: 'current', by: { name: 'Local admin' } } } }, superseded: [] });
    const again = await inj('POST', `/api/v1/releases/${CARD}-r2/promote`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'INVALID_STAGE_MOVE', message: 'Release 2 is already the Production release.' });

    // release 3, promoted: release 2 leaves Production but is kept
    await save(CARD, (p) => { p.title = 'Aster statement, third edition'; });
    expect((await approve(CARD)).release).toMatchObject({ created: true, release: { number: 3 } });
    const p3 = (await inj('POST', `/api/v1/releases/${CARD}-r3/promote`)).json();
    expect(p3.release).toMatchObject({ number: 3, standing: 'production' });
    expect(p3.superseded.map((r: any) => [r.number, r.stages.production.status, r.stages.production.supersededBy, r.standing])).toEqual([[2, 'superseded', 3, 'superseded']]);
    const all = (await json('GET', `/api/v1/projects/${CARD}/releases`)).releases;
    expect(all.filter((r: any) => r.stages.production?.status === 'current').map((r: any) => r.number)).toEqual([3]);
    expect((await json('GET', `/api/v1/releases/${CARD}-r2`)).history.map((h: any) => [h.kind, h.stage, h.note])).toEqual([
      ['created', 'test', expect.any(String)], ['reapproved', null, expect.any(String)], ['promoted', 'production', 'Agreed at the release meeting'],
      ['superseded', 'test', 'Release 3 took its place in Test.'], ['superseded', 'production', 'Release 3 took its place in Production.'],
    ]);

    // an earlier release can be put back
    const back = (await inj('POST', `/api/v1/releases/${CARD}-r2/promote`)).json();
    expect(back.release).toMatchObject({ number: 2, standing: 'production' });
    expect(back.superseded.map((r: any) => r.number)).toEqual([3]);
    expect((await json('GET', `/api/v1/releases/${CARD}-r2`)).history.at(-1)).toMatchObject({ kind: 'promoted', note: 'Made the Production release again.' });

    // filters
    const inProd = await json('GET', '/api/v1/releases?stage=production');
    expect(inProd.releases.map((r: any) => r.id)).toEqual([`${CARD}-r2`]);
    expect((await json('GET', `/api/v1/releases?stage=production&status=superseded&documentId=${CARD}`)).releases.map((r: any) => r.number)).toEqual([3]);
    expect((await json('GET', `/api/v1/releases?stage=production&status=any&documentId=${CARD}`)).releases.map((r: any) => r.number).sort()).toEqual([2, 3]);
    expect((await json('GET', '/api/v1/releases?stage=test')).releases.map((r: any) => r.id).sort()).toEqual([`${CARD}-r3`, `${EOB}-r1`]);
    expect((await json('GET', `/api/v1/releases?documentId=${EOB}`)).releases.map((r: any) => r.id)).toEqual([`${EOB}-r1`]);
    expect((await json('GET', '/api/v1/releases')).total).toBe(4);
  });

  it('withdrawing needs a reason, marks the release withdrawn and keeps it; a withdrawn release cannot be promoted', async () => {
    const url = `/api/v1/releases/${CARD}-r2/withdraw`;
    expect((await inj('POST', url, { stage: 'production' })).json().error).toMatchObject({ code: 'REASON_REQUIRED' });
    expect((await inj('POST', url, { stage: 'production', reason: '   ' })).json().error.code).toBe('REASON_REQUIRED');
    expect((await inj('POST', url, { reason: 'No stage named' })).json().error.code).toBe('INVALID_STAGE');
    expect((await inj('POST', url, { stage: 'production', reason: 'x'.repeat(501) })).json().error.code).toBe('NOTE_TOO_LONG');
    // not from Test while it is the Production release
    const fromTest = await inj('POST', url, { stage: 'test', reason: 'Wrong footer' });
    expect(fromTest.statusCode).toBe(409);
    expect(fromTest.json().error.message).toBe('Release 2 is the Production release. Withdraw it from Production first.');

    const out = await inj('POST', url, { stage: 'production', reason: '  Wrong   footer text ' });
    expect(out.statusCode).toBe(200);
    expect(out.json().release).toMatchObject({ number: 2, standing: 'withdrawn', stages: { test: { status: 'superseded' }, production: { status: 'withdrawn', reason: 'Wrong footer text', by: { name: 'Local admin' } } } });
    expect((await json('GET', `/api/v1/releases/${CARD}-r2`)).history.at(-1)).toMatchObject({ kind: 'withdrawn', stage: 'production', note: 'Wrong footer text' });
    expect((await inj('POST', url, { stage: 'production', reason: 'Again' })).json().error.message).toBe('Release 2 is already withdrawn from Production.');
    const promote = await inj('POST', `/api/v1/releases/${CARD}-r2/promote`);
    expect(promote.statusCode).toBe(409);
    expect(promote.json().error.message).toMatch(/withdrawn from Production/);
    // nothing takes its place by itself: Production is empty until an admin promotes a release
    const live = (await json('GET', '/api/v1/releases/live')).documents.find((d: any) => d.documentId === CARD);
    expect(live).toMatchObject({ production: null, test: { number: 3 }, latest: { number: 3 }, releases: 3, documentRemoved: false });
    // every release is still there
    expect((await json('GET', `/api/v1/projects/${CARD}/releases`)).releases.map((r: any) => [r.number, r.standing])).toEqual([[3, 'test'], [2, 'withdrawn'], [1, 'superseded']]);
    expect((await json('GET', `/api/v1/releases?stage=production&status=withdrawn`)).releases.map((r: any) => r.id)).toEqual([`${CARD}-r2`]);
  });

  it('after the latest release is withdrawn from Test, approving the same content again makes a new release', async () => {
    const w = await inj('POST', `/api/v1/releases/${CARD}-r3/withdraw`, { stage: 'test', reason: 'Approved by mistake' });
    expect(w.json().release).toMatchObject({ number: 3, standing: 'withdrawn', stages: { test: { status: 'withdrawn' }, production: { status: 'superseded' } } });
    expect((await inj('POST', `/api/v1/releases/${CARD}-r3/promote`)).json().error.message).toMatch(/withdrawn from Test, so it cannot go to Production/);
    expect((await json('GET', '/api/v1/releases/live')).documents.find((d: any) => d.documentId === CARD)).toMatchObject({ production: null, test: null, approvedUnreleased: true });
    const out = await approve(CARD);
    expect(out.release).toMatchObject({ created: true, release: { number: 4, stages: { test: { status: 'current' } } } });
    expect((await json('GET', `/api/v1/releases/${CARD}-r3`)).release.stages.test.status).toBe('withdrawn');
    expect((await json('GET', `/api/v1/releases/${CARD}-r4`)).release.contentDigest).toBe((await json('GET', `/api/v1/releases/${CARD}-r3`)).release.contentDigest);
  });

  it('handover log: received and live, each with an optional note, who and when', async () => {
    const url = `/api/v1/releases/${CARD}-r4/handover`;
    expect((await inj('POST', url, { kind: 'installed' })).json().error.code).toBe('INVALID_KIND');
    expect((await inj('POST', url, { kind: 'received', stage: 'staging' })).json().error.code).toBe('INVALID_STAGE');
    const a = await inj('POST', url, { kind: 'received', note: ' Loaded into the  test environment ', stage: 'test' });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ entry: { kind: 'received', stage: 'test', note: 'Loaded into the test environment', packageSha256: null, by: { id: 'local-admin', name: 'Local admin' } }, release: { handover: { received: true, live: false, entries: 1 } } });
    expect(Date.parse(a.json().entry.at)).not.toBeNaN();
    const b = await inj('POST', url, { kind: 'live' });
    expect(b.json()).toMatchObject({ entry: { kind: 'live', stage: null, note: null }, release: { handover: { received: true, live: true, entries: 2 } } });
    expect(b.json().handover.map((e: any) => e.kind)).toEqual(['received', 'live']);
    const detail = await json('GET', `/api/v1/releases/${CARD}-r4`);
    expect(detail.handover.map((e: any) => [e.kind, e.note, e.by.name])).toEqual([['received', 'Loaded into the test environment', 'Local admin'], ['live', null, 'Local admin']]);
    // the log does not move the release, and a superseded or withdrawn release can still be logged against
    expect(detail.release.stages).toMatchObject({ test: { status: 'current' }, production: null });
    expect((await inj('POST', `/api/v1/releases/${CARD}-r2/handover`, { kind: 'received' })).statusCode).toBe(201);
    expect((await json('GET', `/api/v1/releases?documentId=${CARD}`)).releases.map((r: any) => [r.number, r.handover.entries])).toEqual([[4, 2], [3, 0], [2, 1], [1, 0]]);
  });

  it('what is live: per document, the Production release (or none) and the Test release', async () => {
    await inj('POST', `/api/v1/releases/${EOB}-r1/promote`);
    const live = await json('GET', '/api/v1/releases/live');
    expect(live.documents.map((d: any) => [d.documentId, d.production?.number ?? null, d.test?.number ?? null, d.latest.number, d.releases])).toEqual([[CARD, null, 4, 4, 4], [EOB, 1, 1, 1, 1]]);
    expect(live.documents[1]).toMatchObject({ title: 'HarborCare – explanation of benefits', documentType: 'eob', documentRemoved: false, production: { id: `${EOB}-r1`, standing: 'production' } });
    // with every document: one that has never been released is listed with nothing live
    const all = await json('GET', '/api/v1/releases/live?includeUnreleased=1');
    expect(all.documents.map((d: any) => d.documentId)).toEqual([CARD, EOB]);
  });

  it('deleting a document keeps its releases, marked “document removed”, and its id is never reused', async () => {
    const created = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Rate change letter' })).json().project as Project;
    const id = created.projectId;
    expect(id).toBe('rate-change-letter');
    expect((await approve(id)).release).toMatchObject({ created: true, release: { id: `${id}-r1` } });
    await inj('POST', `/api/v1/releases/${id}-r1/promote`);
    const template = (await inj('GET', `/api/v1/releases/${id}-r1/template`)).json();

    const del = await inj('DELETE', `/api/v1/projects/${id}`);
    expect(del.json()).toEqual({ deleted: true, projectId: id, releasesKept: 1 });
    expect((await inj('GET', `/api/v1/projects/${id}`)).statusCode).toBe(404);
    const kept = await json('GET', `/api/v1/releases/${id}-r1`);
    expect(kept.release).toMatchObject({ id: `${id}-r1`, title: 'Rate change letter', documentRemoved: true, standing: 'production', stages: { production: { status: 'current' } } });
    expect(Date.parse(kept.release.documentRemovedAt)).not.toBeNaN();
    expect(kept.history.at(-1)).toMatchObject({ kind: 'document-removed', note: 'The document was deleted. This release is kept.', by: { name: 'Local admin' } });
    expect(kept.document).toEqual({ id, exists: false, title: null, modelVersion: null, workflowState: null });
    expect((await inj('GET', `/api/v1/releases/${id}-r1/template`)).json()).toEqual(template);
    // still listed, still "live", still downloadable
    expect(await json('GET', `/api/v1/projects/${id}/releases`)).toMatchObject({ documentExists: false, title: 'Rate change letter', releases: [{ number: 1 }], create: { allowed: false, reason: 'The document was deleted.' } });
    expect((await json('GET', '/api/v1/releases/live')).documents.find((d: any) => d.documentId === id)).toMatchObject({ documentRemoved: true, title: 'Rate change letter', production: { number: 1 }, workflow: null, approvedUnreleased: false });
    expect((await inj('GET', `/api/v1/releases/${id}-r1/package?wait=1`)).statusCode).toBe(200);
    expect((await inj('POST', `/api/v1/projects/${id}/releases`)).statusCode).toBe(404);
    // a new document with the same title gets another id, so the kept release is never mistaken for it
    const second = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Rate change letter' })).json().project as Project;
    expect(second.projectId).toBe('rate-change-letter-2');
    const copy = (await inj('POST', `/api/v1/projects/${second.projectId}/duplicate`, { title: 'Rate change letter' })).json().project as Project;
    expect(copy.projectId).toBe('rate-change-letter-3');
  });

  it('restoring a sample keeps its releases too', async () => {
    const before = (await json('GET', `/api/v1/projects/${CARD}/releases`)).releases;
    const reset = await inj('POST', `/api/v1/projects/${CARD}/reset`, { confirm: true });
    expect(reset.json()).toMatchObject({ reset: true });
    expect((await json('GET', `/api/v1/projects/${CARD}/workflow?checks=0`)).state).toBe('draft');
    const after = (await json('GET', `/api/v1/projects/${CARD}/releases`)).releases;
    expect(after.map((r: any) => [r.id, r.contentDigest, r.documentRemoved, r.standing])).toEqual(before.map((r: any) => [r.id, r.contentDigest, false, r.standing]));
    expect((await inj('GET', `/api/v1/releases/${CARD}-r4/template`)).json().title).toBe('Aster statement, third edition');
  });

  it('an approval and its release are stored together or not at all', async () => {
    const id = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Interrupted letter' })).json().project.projectId as string;
    expect((await workflow(id, 'submit')).statusCode).toBe(200);
    const insert = ctx.store.insertRelease;
    ctx.store.insertRelease = () => { throw new Error('The disk is full.'); };
    const failed = await workflow(id, 'approve');
    ctx.store.insertRelease = insert;
    expect(failed.statusCode).toBe(500);
    // nothing of the approval was kept: still in review, no approval in the history, no release
    const wf = await json('GET', `/api/v1/projects/${id}/workflow?checks=0`);
    expect(wf.state).toBe('in_review');
    expect(wf.history.map((h: any) => h.action)).toEqual(['submit']);
    expect((await json('GET', `/api/v1/projects/${id}/releases`)).releases).toEqual([]);
    expect((await json('GET', `/api/v1/audit?projectId=${id}&limit=50`)).events.map((e: any) => e.action)).not.toContain('workflow.approve');
    // and the next attempt works normally
    const ok = await workflow(id, 'approve');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().release).toMatchObject({ created: true, release: { id: `${id}-r1`, number: 1 } });
    expect((await json('GET', `/api/v1/projects/${id}/workflow?checks=0`)).history.map((h: any) => h.action)).toEqual(['approve', 'submit']);
  });

  it('every state change is in the audit log with names and numbers, never content', async () => {
    const events = (await json('GET', '/api/v1/audit?action=release.&limit=200')).events as any[];
    const of = (action: string) => events.filter((e) => e.action === action);
    expect(of('release.create').length).toBe(7);
    expect(of('release.create').at(-1)).toMatchObject({ userName: 'Local admin', projectId: CARD, detail: { releaseId: `${CARD}-r1`, number: 1, title: expect.any(String), stage: 'Test', origin: 'approval', approvedBy: 'Local admin', supersededAtTest: [] } });
    expect(of('release.create').find((e) => e.detail.origin === 'manual')).toMatchObject({ projectId: EOB, detail: { number: 1, approvedBy: 'Ada Approver' } });
    expect(of('release.promote').find((e) => e.detail.number === 3)).toMatchObject({ detail: { releaseId: `${CARD}-r3`, title: 'Aster statement, third edition', stage: 'Production', superseded: [2], withNote: false } });
    expect(of('release.withdraw').map((e) => [e.detail.number, e.detail.stage, e.detail.withReason]).sort()).toEqual([[2, 'Production', true], [3, 'Test', true]]);
    expect(of('release.handover').map((e) => [e.detail.number, e.detail.kind, e.detail.stage, e.detail.withNote])).toEqual([[2, 'Received', null, false], [4, 'Live', null, false], [4, 'Received', 'Test', true]]);
    expect(of('release.package').map((e) => e.detail.event).sort()).toEqual(['ready', 'started']);
    // reasons and notes are kept on the release, not in the audit log
    const text = JSON.stringify(events);
    for (const typed of ['Wrong footer text', 'Approved by mistake', 'Loaded into the test environment', 'Agreed at the release meeting']) expect(text).not.toContain(typed);
    // the approval itself says which release it made, and a repeated approval that it made none
    const approvals = (await json('GET', `/api/v1/audit?action=workflow.approve&projectId=${CARD}&limit=50`)).events as any[];
    expect(approvals.map((e) => e.detail.release).reverse()).toEqual([{ number: 1, created: true }, { number: 2, created: true }, { number: 2, created: false }, { number: 3, created: true }, { number: 4, created: true }]);
    // refused requests and reads left no trace
    expect(events.some((e) => e.detail?.status >= 400)).toBe(false);
  });
});

/* ====================================================================== roles */

describe('releases with sign-in on: who may do what', () => {
  let ctx: Ctx;
  const saved = { AUTH: process.env.AUTH, ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
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
    for (const [role, name] of [['author', 'Olive Author'], ['reviewer', 'Rhea Reviewer'], ['approver', 'Ada Approver']] as const) {
      const made = await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name, role, password: 'a long enough password' }, headers: cookies.admin });
      expect(made.statusCode).toBe(201);
      cookies[role] = await login(`${role}@example.test`, 'a long enough password');
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const { inj, json, workflow } = helpers(() => ctx);
  const EOB = 'harborcare-demo';
  const as = (role: string) => cookies[role];

  it('needs a session', async () => {
    for (const url of ['/api/v1/releases', '/api/v1/releases/live', `/api/v1/projects/${EOB}/releases`, `/api/v1/releases/${EOB}-r1`, `/api/v1/releases/${EOB}-r1/package`]) expect((await inj('GET', url)).statusCode, url).toBe(401);
    expect((await inj('POST', `/api/v1/projects/${EOB}/releases`)).statusCode).toBe(401);
  });

  it('the approver who approves is recorded as the approver of the release', async () => {
    expect((await workflow(EOB, 'submit', as('author'))).statusCode).toBe(200);
    expect((await workflow(EOB, 'approve', as('author'))).statusCode).toBe(403);
    expect((await workflow(EOB, 'approve', as('reviewer'))).statusCode).toBe(403);
    expect((await json('GET', '/api/v1/releases', undefined, as('admin'))).total).toBe(0);
    const ok = await workflow(EOB, 'approve', as('approver'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().release).toMatchObject({ created: true, release: { number: 1, approvedBy: { name: 'Ada Approver' }, createdBy: { name: 'Ada Approver' }, stages: { test: { status: 'current', by: { name: 'Ada Approver' } } } } });
    expect(ok.json().release.release.approvedBy.id).toMatch(/^u-/);
  });

  it('everyone signed in can read releases; the actions offered depend on the role', async () => {
    for (const role of ['author', 'reviewer', 'approver', 'admin']) {
      expect((await inj('GET', '/api/v1/releases', undefined, as(role))).statusCode, role).toBe(200);
      expect((await inj('GET', '/api/v1/releases/live', undefined, as(role))).statusCode, role).toBe(200);
      expect((await inj('GET', `/api/v1/releases/${EOB}-r1/template`, undefined, as(role))).statusCode, role).toBe(200);
      const detail = await json('GET', `/api/v1/releases/${EOB}-r1`, undefined, as(role));
      const allowed = (action: string) => detail.actions.filter((a: any) => a.action === action).map((a: any) => a.allowed);
      expect(allowed('promote'), role).toEqual([role === 'admin']);
      expect(allowed('handover'), role).toEqual(role === 'admin' || role === 'approver' ? [true, true] : [false, false]);
    }
    const forApprover = await json('GET', `/api/v1/releases/${EOB}-r1`, undefined, as('approver'));
    expect(forApprover.actions.find((a: any) => a.action === 'promote').reason).toBe('Only admins can move a release to Production.');
    expect(forApprover.actions.find((a: any) => a.action === 'withdraw' && a.stage === 'test').reason).toBe('Only admins can withdraw a release.');
  });

  it('only an admin moves a release to Production or withdraws it', async () => {
    for (const role of ['author', 'reviewer', 'approver']) {
      const p = await inj('POST', `/api/v1/releases/${EOB}-r1/promote`, {}, as(role));
      expect(p.statusCode, role).toBe(403);
      expect(p.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Only admins can move a release to Production or withdraw it.', needs: 'promote_release' });
      expect((await inj('POST', `/api/v1/releases/${EOB}-r1/withdraw`, { stage: 'test', reason: 'No' }, as(role))).statusCode, role).toBe(403);
    }
    expect((await json('GET', `/api/v1/releases/${EOB}-r1`, undefined, as('admin'))).release.stages.production).toBeNull();
    const ok = await inj('POST', `/api/v1/releases/${EOB}-r1/promote`, {}, as('admin'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().release.stages.production).toMatchObject({ status: 'current', by: { name: 'Administrator' } });
    const w = await inj('POST', `/api/v1/releases/${EOB}-r1/withdraw`, { stage: 'production', reason: 'Trial run only' }, as('admin'));
    expect(w.json().release.stages.production).toMatchObject({ status: 'withdrawn', reason: 'Trial run only', by: { name: 'Administrator' } });
  });

  it('approvers and admins create releases from the approved version and keep the handover log; authors and reviewers do not', async () => {
    for (const role of ['author', 'reviewer']) {
      expect((await inj('POST', `/api/v1/projects/${EOB}/releases`, {}, as(role))).statusCode, role).toBe(403);
      expect((await inj('POST', `/api/v1/releases/${EOB}-r1/handover`, { kind: 'received' }, as(role))).statusCode, role).toBe(403);
      expect((await json('GET', `/api/v1/projects/${EOB}/releases`, undefined, as(role))).create.allowed, role).toBe(false);
    }
    // the release was withdrawn from Production, so its approved content may be released again, by an approver
    expect((await json('GET', `/api/v1/projects/${EOB}/releases`, undefined, as('author'))).create).toEqual({ allowed: false, reason: 'Only approvers and admins can create a release.' });
    expect((await json('GET', `/api/v1/projects/${EOB}/releases`, undefined, as('approver'))).create).toEqual({ allowed: true, reason: null });
    const made = await inj('POST', `/api/v1/projects/${EOB}/releases`, {}, as('approver'));
    expect(made.statusCode).toBe(201);
    expect(made.json().release).toMatchObject({ number: 2, origin: 'manual', approvedBy: { name: 'Ada Approver' }, createdBy: { name: 'Ada Approver' } });
    const h = await inj('POST', `/api/v1/releases/${EOB}-r2/handover`, { kind: 'received', note: 'Got it' }, as('approver'));
    expect(h.statusCode).toBe(201);
    expect(h.json().entry).toMatchObject({ kind: 'received', by: { name: 'Ada Approver' } });
    expect((await inj('POST', `/api/v1/releases/${EOB}-r2/handover`, { kind: 'live' }, as('admin'))).statusCode).toBe(201);
  });

  it('anyone signed in can prepare and download the package; the audit log names who asked', async () => {
    const z = await inj('GET', `/api/v1/releases/${EOB}-r2/package?wait=1`, undefined, as('author'));
    expect(z.statusCode).toBe(200);
    expect(z.headers['content-type']).toBe('application/zip');
    expect((await inj('GET', `/api/v1/releases/${EOB}-r2/package/files/manifest.json`, undefined, as('reviewer'))).statusCode).toBe(200);
    const events = (await json('GET', '/api/v1/audit?action=release.&limit=100', undefined, as('admin'))).events as any[];
    expect(events.filter((e) => e.action === 'release.package').map((e) => [e.userName, e.detail.event, e.detail.number]).reverse()).toEqual([['Olive Author', 'started', 2], ['Olive Author', 'ready', 2]]);
    expect(events.filter((e) => e.action === 'release.promote').map((e) => e.userName)).toEqual(['Administrator']);
    expect(events.filter((e) => e.action === 'release.create').map((e) => [e.userName, e.detail.origin]).reverse()).toEqual([['Ada Approver', 'approval'], ['Ada Approver', 'manual']]);
    // the reset stays off even for an admin
    expect((await inj('POST', '/api/v1/releases/reset', { confirm: true }, as('admin'))).statusCode).toBe(403);
    expect((await inj('POST', '/api/v1/releases/reset', { confirm: true }, as('approver'))).statusCode).toBe(403);
  });
});

/* ====================================================================== the package */

describe('the release package (composition replaced by a stub)', () => {
  let ctx: Ctx;
  const stub = stubComposer();
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { composer: stub } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, project, save, approve, makeCardApprovable, packageOf } = helpers(() => ctx);
  const CARD = 'aster-card-demo';
  const REL = `${CARD}-r1`;
  // People who must never appear in a package, and a draft that was never approved.
  const IMPORTED = { givenName: 'Zebulon', familyName: 'Quackenbush' };
  const SUPPLIED = { givenName: 'Wilhelmina', familyName: 'Featherstonehaugh' };
  const EDITED = { givenName: 'Ignatius', familyName: 'Throckmorton' };
  const SECRETS = [IMPORTED.givenName, IMPORTED.familyName, SUPPLIED.givenName, SUPPLIED.familyName, EDITED.givenName, EDITED.familyName, 'Quackenbush-Merchant', 'BORRADOR'];
  let files = new Map<string, Buffer>();
  let zip = Buffer.alloc(0);
  let approvedParts: string[] = [];
  let ids = { imported: '', supplied: '', edited: '' };
  const text = (p: string) => files.get(p)!.toString('utf8');
  const parsed = (p: string) => JSON.parse(text(p));

  it('is built off the request: not built, then building, then ready with its SHA-256', async () => {
    approvedParts = await makeCardApprovable();
    // Customers a package must never show: one imported for every document, one supplied for this document, one generated and then edited by a person.
    const sample = (await json('GET', '/api/v1/records/CARD-0001')).record;
    const { recordId: _id, ...row } = sample;
    const withName = (name: typeof IMPORTED) => ({ ...row, customer: { ...row.customer, ...name }, card: { ...row.card, transactions: row.card.transactions.map((t: any, i: number) => (i === 0 ? { ...t, merchant: 'Quackenbush-Merchant' } : t)) } });
    ids.imported = (await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', format: 'json', data: [withName(IMPORTED)] })).imported[0].recordId;
    ids.supplied = (await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', projectId: CARD, scope: 'project', format: 'json', data: [withName(SUPPLIED)] })).imported[0].recordId;
    expect((await inj('POST', `/api/v1/projects/${CARD}/test-data`, { outcomes: true, edges: false })).statusCode).toBe(201);
    const records = (await json('GET', `/api/v1/records?documentType=credit-statement&full=1&projectId=${CARD}`)).records as any[];
    const generated = records.filter((r) => r.generated);
    ids.edited = generated[0].recordId;
    expect((await inj('PUT', `/api/v1/projects/${CARD}/records/${ids.edited}`, { record: { ...generated[0], customer: { ...generated[0].customer, ...EDITED } } })).statusCode).toBe(200);

    // Pinned tests: on a sample customer (plain, with a what-if, and at a journey step) and on each of the three customers above. One translation approved, one only drafted.
    const before = await project(CARD);
    const all = (await json('GET', `/api/v1/records?documentType=credit-statement&full=1&projectId=${CARD}`)).records as any[];
    const rec = (id: string) => all.find((r) => r.recordId === id);
    const whatIf = { card: { paymentStatus: 'overdue', missedPayments: 2 } };
    await save(CARD, (p) => {
      p.testCases = [
        { id: 'T01', name: 'Everyday customer gets payment instructions', recordId: 'CARD-0001', expect: captureExpectation(before, rec('CARD-0001')) },
        { id: 'T02', name: 'Two missed payments', recordId: 'CARD-0001', overrides: whatIf, expect: captureExpectation(before, rec('CARD-0001'), whatIf) },
        { id: 'T03', name: 'A customer from the imported file', recordId: ids.imported, expect: captureExpectation(before, rec(ids.imported)) },
        { id: 'T04', name: 'A customer supplied for this document', recordId: ids.supplied, expect: captureExpectation(before, rec(ids.supplied)) },
        { id: 'T05', name: 'A generated customer that was edited', recordId: ids.edited, expect: captureExpectation(before, rec(ids.edited)) },
        { id: 'T06', name: 'After a missed payment', recordId: 'CARD-0001', journeyCursor: 1, expect: captureExpectation(before, rec('CARD-0001'), {}, 1) },
      ];
      p.strings = { ...(p.strings ?? {}), '@billing-summary/label': { approved: { 'es-US': 'Saldo nuevo' }, basedOn: { 'es-US': p.nodes.find((n: any) => n.id === 'billing-summary').label } }, '@payment-due/label': { draft: { 'es-US': 'BORRADOR pago mínimo' } } };
      const part = p.contentParts.find((c: any) => !c.approvedLocales['es-US']);
      part.draftLocales = { ...(part.draftLocales ?? {}), 'es-US': 'BORRADOR sin aprobar' };
      p.translationOrigins = { ...(p.translationOrigins ?? {}), '@payment-due/label': 'ai' };
    });
    expect((await approve(CARD)).release).toMatchObject({ created: true, release: { id: REL, package: { status: 'not-built' } } });

    const url = `/api/v1/releases/${REL}/package`;
    expect((await json('GET', `${url}/status`)).package).toEqual({ status: 'not-built', fileName: `${REL}.zip`, sha256: null, bytes: null, files: null, builtAt: null, progress: null, error: null, summary: null, verified: null });
    // nothing to read before it is built
    const tooEarly = await inj('GET', `${url}/files/manifest.json`);
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toMatchObject({ code: 'PACKAGE_NOT_READY', message: 'The package has not been prepared yet.', package: { status: 'not-built' } });
    expect((await inj('GET', `${url}/files`)).statusCode).toBe(409);

    // asking for the ZIP starts the build and answers at once
    const first = await inj('GET', url);
    expect(first.statusCode).toBe(202);
    expect(first.headers['retry-after']).toBe('2');
    expect(first.json()).toMatchObject({ started: true, package: { status: 'building', sha256: null, progress: { step: expect.any(String) } } });
    // while it runs: still building, a second request starts nothing, and other requests are answered
    const meanwhile = await inj('POST', url, {});
    expect(meanwhile.statusCode).toBe(202);
    expect(meanwhile.json()).toMatchObject({ started: false, package: { status: 'building' } });
    expect((await json('GET', `/api/v1/releases/${REL}`)).release.package.status).toBe('building');
    expect((await inj('GET', '/api/v1/health')).statusCode).toBe(200);
    expect((await inj('GET', `${url}/files/README.html`)).json().error).toMatchObject({ code: 'PACKAGE_NOT_READY', message: 'The package is still being prepared.' });

    const done = await inj('POST', url, { wait: true });
    expect(done.statusCode).toBe(200);
    const status = done.json().package;
    expect(status).toMatchObject({ status: 'ready', fileName: `${REL}.zip`, progress: null, error: null, verified: null });
    expect(status.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(status.builtAt)).not.toBeNaN();
    expect((await json('GET', `/api/v1/releases/${REL}`)).release.package).toEqual(status);
    expect((await json('GET', `/api/v1/projects/${CARD}/releases`)).releases[0].package).toEqual(status);

    const got = await packageOf(REL);
    zip = got.zip; files = got.files;
    expect(sha(zip)).toBe(status.sha256);
    expect(zip.length).toBe(status.bytes);
    expect(files.size).toBe(status.files);
  });

  it('downloads as a ZIP named after the document and release, with its SHA-256', async () => {
    const r = await inj('GET', `/api/v1/releases/${REL}/package`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${REL}.zip"`);
    expect(r.headers['x-sha256']).toBe(sha(r.rawPayload));
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.rawPayload.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    expect(r.rawPayload.equals(zip)).toBe(true);
  });

  it('holds the agreed layout, and the manifest lists every other file with its SHA-256 and size', async () => {
    const manifest = parsed('manifest.json');
    const paths = [...files.keys()];
    expect(paths[0]).toBe('manifest.json');
    expect(paths.slice(1)).toEqual([...paths.slice(1)].sort());
    expect(manifest.contents.map((c: any) => c.path)).toEqual(paths.slice(1));
    for (const c of manifest.contents) {
      const data = files.get(c.path)!;
      expect(sha(data), c.path).toBe(c.sha256);
      expect(data.length, c.path).toBe(c.bytes);
      expect(typeof c.role, c.path).toBe('string');
    }
    for (const fixed of ['template.json', 'wording/en-US.csv', 'wording/es-US.xlf', 'wording/es-US.csv', 'data/dictionary.json', 'assets/index.json', 'assets/fonts.json', 'tests/scenarios.json', 'README.html']) expect(paths, fixed).toContain(fixed);
    expect(new Set(paths.map((p) => p.split('/')[0]))).toEqual(new Set(['manifest.json', 'README.html', 'template.json', 'wording', 'data', 'assets', 'tests', 'reference']));
    // nothing from later phases
    expect(paths.some((p) => p.startsWith('library/') || p.startsWith('data/mapping'))).toBe(false);

    const release = (await json('GET', `/api/v1/releases/${REL}`)).release;
    expect(manifest).toMatchObject({
      format: 'iss-release-package', formatVersion: 1, syntheticOnly: true,
      release: { id: REL, number: 1, origin: 'approval', createdAt: release.createdAt },
      document: { id: CARD, title: release.title, kind: 'credit-statement', kindLabel: 'Credit-card statement', modelVersion: release.modelVersion, issuer: 'Aster Card' },
      approvedBy: { name: 'Local admin' }, approvedAt: release.approvedAt, contentDigest: release.contentDigest,
      versions: { schema: '1.0.0', engine: 'iss-resolver/1.0.0', pagedRenderer: 'iss-paged-renderer/1.0.0', htmlRenderer: 'iss-html-renderer/1.0.0', emailRenderer: 'email-renderer/1', smsRenderer: 'sms-renderer/1' },
      languages: { source: 'en-US', targets: [{ locale: 'es-US', name: 'Spanish (United States)' }] },
    });
    // the stage is the studio's record, not part of the frozen package: promoting must not change a byte
    expect(JSON.stringify(manifest)).not.toMatch(/"stage"|"stages"|"standing"/);
    expect(manifest.templateDigest).toBe(projectContentDigest(parsed('template.json')));
  });

  it('building it again gives the same bytes, the kept package is never replaced, and no file says when it was built', async () => {
    const before = stub.pdfs;
    const kept = (await json('GET', `/api/v1/releases/${REL}/package/status`)).package;
    const again = await inj('POST', `/api/v1/releases/${REL}/package`, { verify: true, wait: true });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ started: true, package: { status: 'ready', sha256: sha(zip), bytes: zip.length, builtAt: kept.builtAt, verified: { same: true, sha256: sha(zip), error: null } } });
    expect(Date.parse(again.json().package.verified.at)).toBeGreaterThanOrEqual(Date.parse(kept.builtAt));
    expect(stub.pdfs).toBeGreaterThan(before);
    const second = (await inj('GET', `/api/v1/releases/${REL}/package`)).rawPayload;
    expect(second.equals(zip)).toBe(true);
    // every entry carries the fixed date, not the moment it was packed
    for (const e of zipEntries(zip)) { expect(zip.readUInt16LE(e.offset + 10), e.name).toBe(0); expect(zip.readUInt16LE(e.offset + 12), e.name).toBe(33); }
    // moving the release, logging a handover and time passing change nothing either
    await inj('POST', `/api/v1/releases/${REL}/promote`);
    // a handover entry records which package it was about
    const logged = await inj('POST', `/api/v1/releases/${REL}/handover`, { kind: 'received' });
    expect(logged.json().entry).toMatchObject({ kind: 'received', packageSha256: sha(zip) });
    const third = await inj('POST', `/api/v1/releases/${REL}/package`, { verify: true, wait: true });
    expect(third.json().package).toMatchObject({ sha256: sha(zip), verified: { same: true, sha256: sha(zip) } });
    const events = (await json('GET', '/api/v1/audit?action=release.package&limit=20')).events as any[];
    expect(events.map((e) => e.detail.event).reverse()).toEqual(['started', 'ready', 'check-started', 'checked', 'check-started', 'checked']);
    expect(events.filter((e) => e.detail.event === 'checked').map((e) => [e.detail.same, e.detail.sha256, e.detail.keptSha256])).toEqual([[true, sha(zip), sha(zip)], [true, sha(zip), sha(zip)]]);
    expect(events.find((e) => e.detail.event === 'ready').detail).toMatchObject({ releaseId: REL, number: 1, sha256: sha(zip), bytes: zip.length, files: files.size });
    // without `verify` a ready package is left alone
    const calm = await inj('POST', `/api/v1/releases/${REL}/package`, {});
    expect(calm.statusCode).toBe(200);
    expect(calm.json()).toMatchObject({ started: false, package: { status: 'ready' } });
    // the only moments in the package are the release's own: when it was approved and when it was created
    const release = (await json('GET', `/api/v1/releases/${REL}`)).release;
    const builtAt = release.package.builtAt as string;
    for (const [p, data] of files) {
      if (p.endsWith('.pdf')) continue;
      const stamps = data.toString('utf8').match(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g) ?? [];
      for (const s of stamps) expect([release.approvedAt, release.createdAt], `${p}: ${s}`).toContain(s);
      expect(data.toString('utf8'), p).not.toContain(builtAt);
    }
  });

  it('template.json is the approved version as a project file: valid, without drafts, and importable', async () => {
    const template = parsed('template.json');
    expect(projectFileProblems(template)).toEqual([]);
    expect(template).toMatchObject({ schemaVersion: '1.0.0', projectId: CARD, documentType: 'credit-statement' });
    for (const key of ['lastSavedAt', 'derivedFrom', 'fromTemplate', 'importedFrom', 'translationOrigins']) expect(template[key], key).toBeUndefined();
    expect(template).toEqual((await inj('GET', `/api/v1/releases/${REL}/template`)).json());
    // approved translations stay; drafts do not
    expect(template.strings).toEqual({ '@billing-summary/label': { approved: { 'es-US': 'Saldo nuevo' }, basedOn: { 'es-US': expect.any(String) } } });
    expect(template.contentParts.some((c: any) => c.draftLocales)).toBe(false);
    expect(template.contentParts.filter((c: any) => approvedParts.includes(c.id)).every((c: any) => c.approvedLocales['es-US'].startsWith('ES aprobado: '))).toBe(true);
    expect(template.testCases.map((t: any) => t.id)).toEqual(['T01', 'T02', 'T03', 'T04', 'T05', 'T06']);
    // apart from the drafts it is exactly what was approved
    const frozen = ctx.store.releaseProject(REL)!;
    const stripped = JSON.parse(JSON.stringify(frozen));
    delete stripped.lastSavedAt; delete stripped.translationOrigins; delete stripped.strings['@payment-due/label'];
    for (const c of stripped.contentParts) delete c.draftLocales;
    expect(template).toEqual(stripped);

    const dry = await inj('POST', '/api/v1/projects/import', { file: template, dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, report: { from: { projectId: CARD, title: template.title, modelVersion: template.modelVersion } } });
    const imported = await inj('POST', '/api/v1/projects/import', { file: template, title: 'Aster from a release' });
    expect(imported.statusCode).toBe(201);
    const copy = imported.json().project as Project;
    expect(copy).toMatchObject({ projectId: 'aster-from-a-release', modelVersion: 1, importedFrom: { projectId: CARD, modelVersion: template.modelVersion } });
    expect(copy.nodes).toEqual(template.nodes);
    expect(copy.rules).toEqual(template.rules);
    expect(copy.contentParts).toEqual(template.contentParts);
    // and the copy resolves like the release does
    const first = parsed('tests/scenarios.json').scenarios.find((s: any) => s.customerId === 'CARD-0001' && !Object.keys(s.overrides).length);
    const viaApi = await json('POST', '/api/v1/resolve', { projectId: copy.projectId, recordId: 'CARD-0001' });
    expect(viaApi.result.selectedVariants).toEqual(Object.fromEntries(first.expected.messages.map((m: any) => [m.sectionId, m.chosenId])));
    expect(viaApi.semanticManifest.money).toEqual(Object.fromEntries(first.expected.amounts.map((a: any) => [a.id, a.cents])));
    expect(viaApi.result.matchedRuleIds).toEqual(first.expected.rulesApplied.map((r: any) => r.id));
  });

  it('wording: XLIFF is well-formed, carries approved translations only, and the manifest lists what is missing', async () => {
    // the reader used here does refuse malformed XML
    expect(xmlProblems('<?xml version="1.0" encoding="UTF-8"?>\n<a><b>x</b></a>\n')).toEqual([]);
    for (const bad of ['<a><b></a>', '<?xml version="1.0" encoding="UTF-8"?><a>&</a>', '<?xml version="1.0" encoding="UTF-8"?><a b=c/>', '<?xml version="1.0" encoding="UTF-8"?><a/><b/>', '<?xml version="1.0" encoding="UTF-8"?><a><b>', '<?xml version="1.0" encoding="UTF-8"?><a x="1" x="2"/>']) expect(xmlProblems(bad).length, bad).toBeGreaterThan(0);

    const xlf = text('wording/es-US.xlf');
    expect(xmlProblems(xlf)).toEqual([]);
    expect(xlf).toContain('<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en-US" trgLang="es-US">');
    const units = xliffUnits(xlf);
    expect(units.length).toBeGreaterThan(50);
    expect(new Set(units.map((u) => u.unitId)).size).toBe(units.length);
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
    const template = parsed('template.json');
    // a target exists exactly where an approved translation does, and says exactly that
    const approved = new Map<string, string>();
    for (const c of template.contentParts) if (c.approvedLocales['es-US']) approved.set(c.id, c.approvedLocales['es-US']);
    for (const [id, s] of Object.entries<any>(template.strings ?? {})) if (s.approved?.['es-US']) approved.set(id, s.approved['es-US']);
    const translated = units.filter((u) => u.target !== null);
    expect(translated.length).toBeGreaterThan(approvedParts.length);
    for (const u of translated) { expect(approved.get(u.id), u.id).toBe(u.target); expect(u.state).toBe('final'); }
    for (const u of units.filter((x) => x.target === null)) { expect(approved.has(u.id), u.id).toBe(false); expect(u.state).toBe('initial'); }
    expect(units.find((u) => u.id === '@billing-summary/label')).toMatchObject({ target: 'Saldo nuevo', source: 'New balance', state: 'final' });
    expect(units.find((u) => u.id === '@payment-due/label')).toMatchObject({ target: null, state: 'initial' });
    for (const id of approvedParts) expect(units.find((u) => u.id === id)?.target).toMatch(/^ES aprobado: /);
    // sources are the English texts, tokens untouched
    const english = new Map<string, string>(template.contentParts.map((c: any) => [c.id, c.approvedLocales['en-US']]));
    for (const u of units) if (english.has(u.id)) expect(u.source, u.id).toBe(english.get(u.id));
    expect(units.some((u) => /\{\{[\w.]+\}\}/.test(u.source))).toBe(true);

    // the manifest's "missing" for the language is exactly the texts without a target
    const lang = parsed('manifest.json').languages.targets[0];
    expect([...lang.missing].sort()).toEqual(units.filter((u) => u.target === null).map((u) => u.id).sort());
    expect(lang).toMatchObject({ texts: units.length, approved: translated.length });
    expect(lang.missing).toContain('@payment-due/label');
    expect(lang.missing).not.toContain('@billing-summary/label');

    // the spreadsheets carry the same rows
    const es = csvRows(text('wording/es-US.csv'));
    expect(es[0]).toEqual(['id', 'kind', 'title', 'mandatory', 'status', 'sourceChanged', 'en-US', 'es-US']);
    expect(es.slice(1).map((r) => [r[0], r[4], r[6], r[7]])).toEqual(units.map((u) => [u.id, u.target === null ? 'missing' : 'approved', u.source, u.target ?? '']));
    const en = csvRows(text('wording/en-US.csv'));
    expect(en[0]).toEqual(['id', 'kind', 'title', 'mandatory', 'en-US']);
    expect(en.slice(1).map((r) => [r[0], r[4]])).toEqual(units.map((u) => [u.id, u.source]));
    expect(new Set(en.slice(1).map((r) => r[1]))).toEqual(new Set(['message', 'label', 'email-sms', 'fixed']));
    // the status page shows the same counts
    expect((await json('GET', `/api/v1/releases/${REL}`)).release.package.summary.languages).toEqual([{ locale: 'es-US', name: 'Spanish (United States)', texts: units.length, approved: translated.length, missing: lang.missing.length }]);
  });

  it('the data dictionary covers every field a rule, a binding or a text token uses', () => {
    const template = parsed('template.json') as Project;
    const dictionary = parsed('data/dictionary.json');
    const byPath = new Map<string, any>(dictionary.fields.map((f: any) => [f.path, f]));
    const ruleUse = new Map<string, Set<string>>();
    for (const r of template.rules) for (const p of predicatePaths(r.when)) ruleUse.set(p, (ruleUse.get(p) ?? new Set()).add(r.id));
    expect(ruleUse.size).toBeGreaterThan(5);
    for (const [p, rules] of ruleUse) {
      expect(byPath.has(p), p).toBe(true);
      expect(byPath.get(p).needed, p).toBe(true);
      expect(new Set(byPath.get(p).usedIn.rules.map((x: any) => x.id)), p).toEqual(rules);
      for (const x of byPath.get(p).usedIn.rules) expect(x.title).toBe(template.rules.find((r) => r.id === x.id)!.title);
    }
    const bound = template.nodes.filter((n) => n.binding);
    expect(bound.length).toBeGreaterThan(5);
    for (const n of bound) { expect(byPath.get(n.binding!)?.needed, n.binding).toBe(true); expect(byPath.get(n.binding!).usedIn.bindings, n.binding).toContain(n.name ?? n.id); }
    const tokens = new Set<string>();
    for (const n of template.nodes) tokensIn(n.content).forEach((t) => tokens.add(t));
    // the messages and notices the document uses (the sample also carries wording of the other sample kind, which it never shows)
    const usedPartIds = new Set<string>();
    for (const n of template.nodes) { (n.variantIds ?? []).forEach((v) => usedPartIds.add(v)); if (n.contentPartId) usedPartIds.add(n.contentPartId); }
    for (const r of template.rules) { if (r.then.op === 'showSection') usedPartIds.add(r.then.targetNodeId); if (r.then.op === 'requireNodes') r.then.nodeIds.forEach((x) => usedPartIds.add(x)); }
    const usedParts = template.contentParts.filter((c) => usedPartIds.has(c.id));
    expect(usedParts.length).toBeGreaterThan(8);
    expect(usedParts.length).toBeLessThan(template.contentParts.length);
    for (const c of usedParts) for (const t of Object.values(c.approvedLocales)) for (const m of (t ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) tokens.add(m[1]);
    expect(tokens.size).toBeGreaterThan(3);
    for (const t of tokens) { expect(byPath.get(t)?.needed, t).toBe(true); expect(byPath.get(t).usedIn.tokens.length, t).toBeGreaterThan(0); }
    for (const n of template.nodes) for (const p of predicatePaths(n.visibleWhen)) expect(byPath.get(p)?.usedIn.conditions, p).toContain(n.name ?? n.id);
    expect(dictionary.unknownReferences).toEqual([]);

    // every entry is complete, and a calculated field names what it is worked out from
    for (const f of dictionary.fields) {
      for (const key of ['path', 'label', 'type', 'format', 'required', 'calculated', 'needed', 'usedIn']) expect(f[key], `${f.path}.${key}`).toBeDefined();
      expect('example' in f, f.path).toBe(true);
      if (f.required) expect(f.needed, f.path).toBe(true);
    }
    expect(byPath.get('card.newBalanceCents')).toMatchObject({ label: 'New balance', type: 'cents', format: 'Whole number of cents (integer, never a decimal amount)', required: true, calculated: false });
    expect(byPath.get('card.dueDate')).toMatchObject({ type: 'date', format: 'ISO 8601 date, YYYY-MM-DD', required: true });
    expect(byPath.get('card.paymentStatus')).toMatchObject({ type: 'enum', allowedValues: ['current', 'overdue'] });
    expect(byPath.get('card.transactions.count')).toMatchObject({ calculated: true, calculatedFrom: ['card.transactions'], needed: true });
    expect(byPath.get('card.transactions')).toMatchObject({ type: 'array', needed: true, usedIn: { calculatedFields: ['card.transactions.count'] } });
    expect(byPath.get('card.transactions').columns.map((c: any) => c.key)).toEqual(['id', 'date', 'merchant', 'amountCents']);
    expect(dictionary.fields.some((f: any) => !f.needed)).toBe(true);
  });

  it('images are provided as files named by their hash, and fonts are listed, not shipped', () => {
    const index = parsed('assets/index.json');
    expect(index.assets.length).toBeGreaterThan(0);
    for (const a of index.assets) {
      const data = files.get(a.path)!;
      expect(a.path).toBe(`assets/${sha(data)}.${a.mime === 'image/svg+xml' ? 'svg' : a.mime === 'image/png' ? 'png' : a.mime === 'image/jpeg' ? 'jpg' : 'webp'}`);
      expect(a).toMatchObject({ sha256: sha(data), bytes: data.length });
      expect(a.usedBy.length).toBeGreaterThan(0);
    }
    expect(index.assets.find((a: any) => a.builtIn === 'aster-mark')).toMatchObject({ referencedAs: 'asset:aster-mark', mime: 'image/svg+xml', usedBy: [{ what: 'component', name: expect.any(String) }] });
    expect(parsed('template.json').nodes.some((n: any) => n.image?.src === 'asset:aster-mark')).toBe(true);
    const fonts = parsed('assets/fonts.json');
    expect(fonts.fonts.map((f: any) => [f.use, f.family])).toEqual([['Printed document (PDF)', 'Arial'], ['Web page (HTML)', 'Inter'], ['Email', 'Arial']]);
    expect([...files.keys()].some((p) => /\.(ttf|otf|woff2?)$/i.test(p))).toBe(false);
  });

  it('scenarios: pinned tests on synthetic customers plus one generated customer per outcome, each with what the engine works out', () => {
    const template = parsed('template.json') as Project;
    const s = parsed('tests/scenarios.json');
    expect(s).toMatchObject({ formatVersion: 1, syntheticOnly: true, cap: 24, release: { id: REL, number: 1 } });
    expect(s.counts).toMatchObject({ pinnedTests: 3, pinnedTestsExcluded: 3, omittedByCap: 0, scenarios: s.scenarios.length });
    expect(s.counts.generated).toBeGreaterThanOrEqual(6);
    expect(s.scenarios.slice(0, 2).map((x: any) => [x.source, x.name, x.pinnedTest.id, x.customerId])).toEqual([
      ['pinned-test', 'Everyday customer gets payment instructions', 'T01', 'CARD-0001'], ['pinned-test', 'Two missed payments', 'T02', 'CARD-0001'],
    ]);
    expect(s.scenarios[1].overrides).toEqual({ card: { paymentStatus: 'overdue', missedPayments: 2 } });
    expect(s.scenarios[1].data.card).toMatchObject({ paymentStatus: 'overdue', missedPayments: 2 });
    // a test pinned at a journey step: the data is the customer after that step
    expect(s.scenarios[2]).toMatchObject({ source: 'pinned-test', name: 'After a missed payment', pinnedTest: { id: 'T06' }, customerId: 'CARD-0001', journeyCursor: 1, journeyStep: template.journey.events[1].label, overrides: {} });
    expect(s.scenarios[2].data.card.missedPayments).toBeGreaterThan(s.scenarios[0].data.card.missedPayments);
    expect(s.scenarios[2].expected.contentDigest).not.toBe(s.scenarios[0].expected.contentDigest);
    for (const x of s.scenarios.slice(0, 3)) expect(x.pinnedExpectation).toMatchObject({ holds: true, selectedVariants: expect.any(Object) });
    expect(s.scenarios.slice(3).every((x: any) => x.source === 'generated' && x.journeyCursor === null && x.journeyStep === null)).toBe(true);
    // the three tests on customers that are not synthetic are left out, each with the reason and without the customer
    expect(s.pinnedTestsExcluded).toEqual([
      { test: 'A customer from the imported file', reason: 'It uses an imported customer. Imported customers never leave the studio.' },
      { test: 'A customer supplied for this document', reason: 'It uses a customer that was supplied for this document or edited by a person. Those never leave the studio.' },
      { test: 'A generated customer that was edited', reason: 'It uses a customer that was supplied for this document or edited by a person. Those never leave the studio.' },
    ]);
    expect(parsed('manifest.json').tests).toMatchObject({ cap: 24, scenarios: s.scenarios.length, pinnedTests: 3, pinnedTestsExcluded: s.pinnedTestsExcluded, omittedByCap: [] });

    // only built-in sample customers and customers the engine generated
    const sampleIds = new Set(RECORDS.map((r) => r.recordId));
    for (const c of s.customers) {
      expect(['sample', 'generated']).toContain(c.kind);
      if (c.kind === 'sample') expect(c.record).toEqual(RECORDS.find((r) => r.recordId === c.id));
      else { expect(sampleIds.has(c.id)).toBe(false); expect(c.id).toMatch(/^CARD-9\d{4}$/); expect(typeof c.generatedTo).toBe('string'); }
      expect(c.record.projectId).toBeUndefined();
      expect(c.record.imported).toBeUndefined();
    }
    expect(s.customers.map((c: any) => c.id)).not.toContain(ids.imported);
    // every outcome the engine can reach is covered by a generated scenario
    expect(s.outcomes).toMatchObject({ reached: s.outcomes.total, notReached: [] });
    expect(s.outcomes.total).toBeGreaterThan(15);
    const covered = new Set(s.scenarios.flatMap((x: any) => x.covers ?? []));
    expect(covered.size).toBe(s.outcomes.total);
    for (const r of template.rules.filter((x) => x.enabled !== false)) expect([...covered].some((c: any) => c.includes(r.title!)), r.title).toBe(true);

    // what is written as expected is what a fresh run of the engine on template.json gives
    const customers = new Map<string, any>(s.customers.map((c: any) => [c.id, c.record]));
    expect(new Set(s.scenarios.map((x: any) => x.id)).size).toBe(s.scenarios.length);
    for (const x of s.scenarios) {
      const res = resolve({ project: template, record: customers.get(x.customerId), overrides: x.overrides, journeyCursor: x.journeyCursor, profileId: 'paged-pdf' });
      expect(x.expected.runId, x.id).toBe(res.runId);
      expect(x.expected.contentDigest, x.id).toBe(res.contentDigest);
      expect(Object.fromEntries(x.expected.messages.map((m: any) => [m.sectionId, m.chosenId])), x.id).toEqual(res.result.selectedVariants);
      expect(x.expected.rulesApplied.map((r: any) => r.id), x.id).toEqual(res.result.matchedRuleIds);
      expect(x.expected.language, x.id).toBe(res.locale);
      expect(Object.fromEntries(x.expected.amounts.map((a: any) => [a.id, a.cents])), x.id).toEqual(res.semanticManifest.money);
      expect(x.expected.facts, x.id).toEqual(res.semanticManifest.facts);
      const blocking = res.findings.filter((f) => f.severity === 'blocking');
      expect(x.expected.produced, x.id).toBe(blocking.length === 0);
      expect(x.expected.blocking.map((b: any) => b.code), x.id).toEqual(blocking.map((f) => f.code));
      expect(x.data, x.id).toEqual(JSON.parse(JSON.stringify(res.effectiveRecord)));
      // names beside ids
      for (const m of x.expected.messages) { expect(m.section).toBe(template.nodes.find((n) => n.id === m.sectionId)!.name); if (m.chosenId) expect(m.chosen).toBe(template.contentParts.find((c) => c.id === m.chosenId)!.title); }
      expect(x.expected.sections.length).toBeGreaterThan(0);
      // the data alone is enough: the same document comes out of it with no what-if on top
      expect(resolve({ project: template, record: x.data, profileId: 'paged-pdf' }).contentDigest, x.id).toBe(res.contentDigest);
      expect(x.customerName).toBe(`${customers.get(x.customerId).customer.givenName} ${customers.get(x.customerId).customer.familyName}`);
    }
    // Spanish is fully approved for what a Spanish-preferring customer needs, so that customer's document is produced, in Spanish
    const spanish = s.scenarios.find((x: any) => x.expected.language === 'es-US');
    expect(spanish).toMatchObject({ source: 'generated', expected: { produced: true, blocking: [] } });
  });

  it('reference outputs exist for the chosen subset, chosen to show the most outcomes, with their facts', () => {
    const s = parsed('tests/scenarios.json');
    const manifest = parsed('manifest.json');
    const chosen = s.scenarios.filter((x: any) => x.reference);
    expect(chosen.length).toBeGreaterThan(1);
    expect(chosen.length).toBeLessThanOrEqual(8);
    expect(manifest.reference).toMatchObject({ cap: 8, scenarios: chosen.map((x: any) => x.id), files: ['document.pdf', 'document.html', 'email.html', 'email.txt', 'sms.txt', 'facts.json'] });
    expect(manifest.reference.outcomesShown).toBeGreaterThan(manifest.reference.outcomesSeen * 0.8);
    expect(s.counts.withReference).toBe(chosen.length);
    const referenceFiles = [...files.keys()].filter((p) => p.startsWith('reference/'));
    expect(referenceFiles.length).toBe(chosen.length * 6);
    const template = parsed('template.json') as Project;
    const customers = new Map<string, any>(s.customers.map((c: any) => [c.id, c.record]));
    for (const x of chosen) {
      expect(x.reference).toBe(`reference/${x.id}/`);
      expect(x.id).toMatch(/^s\d\d(-[a-z0-9-]+)?$/);
      for (const f of manifest.reference.files) expect(files.has(`${x.reference}${f}`), `${x.reference}${f}`).toBe(true);
      expect(text(`${x.reference}document.pdf`).startsWith('%PDF-')).toBe(true);
      const html = text(`${x.reference}document.html`);
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toContain(x.customerName.split(' ')[0]);
      expect(text(`${x.reference}email.html`)).toMatch(/<html/i);
      expect(text(`${x.reference}email.txt`).length).toBeGreaterThan(100);
      expect(text(`${x.reference}sms.txt`)).toMatch(/^DEMO /);
      const facts = parsed(`${x.reference}facts.json`);
      const res = resolve({ project: template, record: customers.get(x.customerId), overrides: x.overrides, journeyCursor: x.journeyCursor, profileId: 'paged-pdf' });
      expect(facts).toMatchObject({ scenario: { id: x.id, name: x.name }, customer: { id: x.customerId, name: x.customerName }, runId: res.runId, contentDigest: res.contentDigest, projectDigest: manifest.templateDigest, engine: 'iss-resolver/1.0.0', language: res.locale });
      expect(facts.expected).toEqual(JSON.parse(JSON.stringify(res.semanticManifest)));
      for (const f of manifest.reference.files.filter((n: string) => n !== 'facts.json')) expect(facts.outputs[f], f).toMatchObject({ sha256: sha(files.get(`${x.reference}${f}`)!), bytes: files.get(`${x.reference}${f}`)!.length });
      expect(facts.outputs['email.html'].subject.length).toBeGreaterThan(5);
      expect(facts.outputs['sms.txt']).toMatchObject({ segments: expect.any(Number), encoding: expect.any(String) });
      expect(facts.parity.channels).toMatchObject({ ok: true });
    }
    // the README names the scenarios and where their outputs are
    const readme = text('README.html');
    for (const x of s.scenarios) expect(readme).toContain(x.customerName);
    for (const x of chosen) expect(readme).toContain(`reference/${x.id}/`);
    expect(readme).toContain('release 1');
    expect(readme).toContain('Approved by Local admin');
    expect(readme).toMatch(/3 pinned tests were left out because their customers are not synthetic/);
    for (const heading of ['What this is', 'What is inside', 'How to verify a build against this package', 'What “matching” means', 'What is not included']) expect(readme).toContain(`<h2>${heading}</h2>`);
  });

  it('no imported, supplied or edited customer, and no unapproved draft, appears anywhere in the ZIP', async () => {
    // they do exist in the studio, and the document was tested against them
    const mine = (await json('GET', `/api/v1/records?documentType=credit-statement&projectId=${CARD}`)).records as any[];
    for (const who of [IMPORTED, SUPPLIED, EDITED]) expect(mine.some((r) => r.name === `${who.givenName} ${who.familyName}`)).toBe(true);
    expect(JSON.stringify(ctx.store.releaseProject(REL))).toContain('BORRADOR');
    expect(ctx.store.release(REL)!.pinned.map((p) => [p.testId, p.kind])).toEqual([['T01', 'sample'], ['T02', 'sample'], ['T03', 'imported'], ['T04', 'supplied'], ['T05', 'supplied'], ['T06', 'sample']]);
    // what the release remembers about those customers is an id and where it came from: no data
    expect(JSON.stringify(ctx.store.release(REL)!.pinned)).not.toMatch(/Quackenbush|Featherstonehaugh|Throckmorton/);
    expect(files.size).toBeGreaterThan(20);
    for (const [p, data] of files) {
      const body = `${data.toString('utf8')}\n${data.toString('latin1')}\n${data.toString('utf16le')}`;
      for (const secret of SECRETS) expect(body.includes(secret), `${secret} in ${p}`).toBe(false);
    }
    for (const secret of SECRETS) expect(zip.includes(Buffer.from(secret, 'utf8')), secret).toBe(false);
    // the same holds for what the routes serve file by file
    const listing = await json('GET', `/api/v1/releases/${REL}/package/files`);
    for (const f of listing.files) {
      const one = await inj('GET', `/api/v1/releases/${REL}/package/files/${f.path}`);
      for (const secret of SECRETS) expect(one.body.includes(secret), `${secret} in ${f.path}`).toBe(false);
    }
  });

  it('one file of the package can be read without downloading the ZIP', async () => {
    const listing = await json('GET', `/api/v1/releases/${REL}/package/files`);
    expect(listing.package.status).toBe('ready');
    expect(listing.files.map((f: any) => f.path)).toEqual([...files.keys()]);
    for (const f of listing.files) { expect(f.sha256, f.path).toBe(sha(files.get(f.path)!)); expect(f.bytes, f.path).toBe(files.get(f.path)!.length); }
    expect(listing.files[0]).toMatchObject({ path: 'manifest.json', role: 'manifest', contentType: 'application/json; charset=utf-8' });
    const url = `/api/v1/releases/${REL}/package/files`;
    const manifest = await inj('GET', `${url}/manifest.json`);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(manifest.headers['x-sha256']).toBe(sha(files.get('manifest.json')!));
    expect(manifest.headers['content-disposition']).toBe('inline; filename="manifest.json"');
    expect(manifest.rawPayload.equals(files.get('manifest.json')!)).toBe(true);
    const readme = await inj('GET', `${url}/README.html`);
    expect(readme.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(readme.headers['content-security-policy']).toBe('sandbox allow-scripts');
    expect(readme.headers['x-content-type-options']).toBe('nosniff');
    const reference = parsed('manifest.json').reference.scenarios[0];
    const pdf = await inj('GET', `${url}/reference/${reference}/document.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.equals(files.get(`reference/${reference}/document.pdf`)!)).toBe(true);
    expect((await inj('GET', `${url}/reference/${reference}/sms.txt`)).headers['content-type']).toBe('text/plain; charset=utf-8');
    expect((await inj('GET', `${url}/wording/es-US.xlf`)).headers['content-type']).toBe('application/xliff+xml; charset=utf-8');
    expect((await inj('GET', `${url}/template.json?download=1`)).headers['content-disposition']).toBe('attachment; filename="template.json"');
    for (const missing of ['nope.txt', 'reference/', '../manifest.json', '..%2Fmanifest.json', 'reference%2F..%2F..%2Fmanifest.json', 'manifest.json/extra']) expect((await inj('GET', `${url}/${missing}`)).statusCode, missing).toBe(404);
    expect((await inj('GET', '/api/v1/releases/aster-card-demo-r99/package/files/manifest.json')).statusCode).toBe(404);
  });

  it('a build that fails says why, is not retried by a download, and can be prepared again', async () => {
    const eob = 'harborcare-demo';
    expect((await approve(eob)).release.created).toBe(true);
    const url = `/api/v1/releases/${eob}-r1/package`;
    stub.fail = 'The page composer is not available.';
    const failed = await inj('POST', url, { wait: true });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().package).toMatchObject({ status: 'failed', error: 'The page composer is not available.', sha256: null, summary: null });
    expect((await json('GET', `/api/v1/releases/${eob}-r1`)).release.package.status).toBe('failed');
    const download = await inj('GET', `${url}?wait=1`);
    expect(download.statusCode).toBe(409);
    expect(download.json().error).toMatchObject({ code: 'PACKAGE_FAILED', package: { status: 'failed' } });
    expect(download.json().error.message).toBe('Preparing the package failed: The page composer is not available. Prepare it again.');
    expect((await inj('GET', `${url}/files/manifest.json`)).json().error).toMatchObject({ code: 'PACKAGE_NOT_READY', message: 'Preparing the package failed. Prepare it again.' });
    stub.fail = null;
    const retry = await inj('POST', url, { wait: true });
    expect(retry.json()).toMatchObject({ started: true, package: { status: 'ready', error: null } });
    const good = await inj('GET', url);
    expect(good.statusCode).toBe(200);
    // a check that cannot be completed says so and leaves the kept package exactly as it was
    stub.fail = 'The page composer stopped.';
    const check = await inj('POST', url, { verify: true, wait: true });
    stub.fail = null;
    expect(check.json().package).toMatchObject({ status: 'ready', sha256: good.headers['x-sha256'], verified: { same: false, sha256: null, error: 'The page composer stopped.' } });
    expect((await inj('GET', url)).rawPayload.equals(good.rawPayload)).toBe(true);
    const events = (await json('GET', `/api/v1/audit?action=release.package&projectId=${eob}&limit=20`)).events as any[];
    expect(events.map((e) => e.detail.event).reverse()).toEqual(['started', 'failed', 'started', 'ready', 'check-started', 'checked']);
    expect(events.find((e) => e.detail.event === 'failed').detail).toMatchObject({ number: 1, reason: 'The page composer is not available.' });
    expect(events.find((e) => e.detail.event === 'checked').detail).toMatchObject({ same: false, reason: 'The page composer stopped.', keptSha256: good.headers['x-sha256'] });

    // a release made by an earlier engine is not built by this one: its package would claim versions that did not produce it
    const r1 = ctx.store.release(`${eob}-r1`)!;
    ctx.store.insertRelease({ ...r1, id: `${eob}-r2`, number: 2, versions: { ...r1.versions, engine: 'iss-resolver/0.9.0', packageFormat: 0 } }, ctx.store.releaseProject(r1.id)!);
    const old = await inj('POST', `/api/v1/releases/${eob}-r2/package`, { wait: true });
    expect(old.json().package).toMatchObject({ status: 'failed', sha256: null, error: "This studio has been updated since release 2 was made (engine iss-resolver/0.9.0 then, iss-resolver/1.0.0 now; package format 0 then, 1 now), so it can no longer build this release's package exactly as it was approved." });
    expect((await inj('GET', `/api/v1/releases/${eob}-r2/package`)).statusCode).toBe(409);
    // an English-only package of the other sample kind, for good measure: Spanish is a language of the document but nothing is approved
    const built = unzip((await inj('GET', url)).rawPayload);
    const m = JSON.parse(built.get('manifest.json')!.toString('utf8'));
    expect(m.document).toMatchObject({ id: eob, kind: 'eob', kindLabel: 'Explanation of benefits' });
    expect(m.languages.targets[0]).toMatchObject({ locale: 'es-US', approved: 0 });
    expect(xliffUnits(built.get('wording/es-US.xlf')!.toString('utf8')).every((u) => u.target === null)).toBe(true);
    // so the customer who prefers Spanish gets no document: the scenario says it is not produced, why, and has no reference outputs
    const scenarios = JSON.parse(built.get('tests/scenarios.json')!.toString('utf8')).scenarios as any[];
    const blocked = scenarios.filter((x) => !x.expected.produced);
    expect(blocked.map((x) => [x.name, x.reference, x.expected.blocking[0].code])).toEqual([['Document in Spanish (United States)', null, 'REQUIRED_TRANSLATION_MISSING']]);
    expect(blocked[0].expected.blocking[0]).toMatchObject({ where: expect.any(String), message: expect.stringMatching(/No approved es-US version/) });
    expect(scenarios.filter((x) => x.expected.produced).every((x) => x.expected.blocking.length === 0)).toBe(true);
    expect(m.reference.scenarios).not.toContain(blocked[0].id);
    expect(built.get('README.html')!.toString('utf8')).toContain('Not produced (blocking issue)');
    expect(JSON.parse(built.get('data/dictionary.json')!.toString('utf8')).note).toMatch(/Fields that start with "claim\." describe the claim the document is about/);
  });
});

/* ====================================================================== a document with its own data */

describe('the release package of a document with its own data', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { composer: stubComposer(), scenarioCap: 3, referenceCap: 2 } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, project, save, approve, packageOf } = helpers(() => ctx);
  let id = '';
  const owners = async () => (await json('GET', `/api/v1/records?documentType=custom&full=1&projectId=${id}`)).records as any[];

  it('a pinned test on a generated customer is kept, because the engine reproduces that customer from the document alone', async () => {
    id = (await inj('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Membership notice', issuerName: 'Northside Gym', accent: '#1F4E79' })).json().project.projectId;
    const built = gymProject({ withSpanish: true });
    await save(id, (p) => { Object.assign(p, { ...built, projectId: id, title: p.title, issuer: p.issuer, modelVersion: p.modelVersion }); });
    expect((await inj('POST', `/api/v1/projects/${id}/test-data`, { outcomes: true, edges: true })).statusCode).toBe(201);
    const generated = (await owners()).filter((r) => r.generated);
    expect(generated.length).toBeGreaterThan(3);
    const pro = generated.find((r) => r.custom.tier === 'pro')!;
    const current = await project(id);
    await save(id, (p) => { p.testCases = [{ id: 'T01', name: 'Pro members get the Pro note', recordId: pro.recordId, expect: captureExpectation(current, pro) }]; });
    const out = await approve(id);
    expect(out.release).toMatchObject({ created: true, release: { id: `${id}-r1`, documentType: 'custom', kind: 'Your own data', languages: ['en-US', 'es-US'] } });
    expect(ctx.store.release(`${id}-r1`)!.pinned).toEqual([{ testId: 'T01', recordId: pro.recordId, kind: 'generated', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);

    const { files } = await packageOf(`${id}-r1`);
    const s = JSON.parse(files.get('tests/scenarios.json')!.toString('utf8'));
    expect(s.pinnedTestsExcluded).toEqual([]);
    expect(s.scenarios[0]).toMatchObject({ source: 'pinned-test', name: 'Pro members get the Pro note', customerId: pro.recordId, pinnedExpectation: { holds: true } });
    expect(s.scenarios[0].expected.messages).toEqual([{ sectionId: 'renewal-note', section: expect.any(String), chosenId: 'note-pro', chosen: 'Pro members' }]);
    // the customer in the package is the engine's own, without the studio's bookkeeping
    const packed = s.customers.find((c: any) => c.id === pro.recordId);
    const { projectId: _p, generated: _g, ...data } = pro;
    expect(packed).toMatchObject({ kind: 'generated', name: `${pro.customer.givenName} ${pro.customer.familyName}` });
    expect(packed.record).toEqual(data);
    // the lowered caps are what the package reports, with what was left out by name
    expect(s).toMatchObject({ cap: 3, counts: { scenarios: 3, withReference: 2 } });
    expect(s.counts.omittedByCap).toBeGreaterThan(0);
    expect(s.omittedByCap.length).toBe(s.counts.omittedByCap);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.tests).toMatchObject({ cap: 3, scenarios: 3, omittedByCap: s.omittedByCap });
    expect(manifest.reference).toMatchObject({ cap: 2 });
    expect(manifest.reference.scenarios.length).toBe(2);
    expect([...files.keys()].filter((p) => p.endsWith('/document.pdf')).length).toBe(2);
    expect(files.get('README.html')!.toString('utf8')).toMatch(/The limit is 3 scenarios and 2 sets of reference outputs; \d+ more could have been included/);
    // its own data fields are the dictionary; nothing from the card or claim samples
    const dictionary = JSON.parse(files.get('data/dictionary.json')!.toString('utf8'));
    expect(dictionary.fields.map((f: any) => f.path).filter((p: string) => p.startsWith('custom.'))).toEqual(['custom.planName', 'custom.monthlyFeeCents', 'custom.renewalDate', 'custom.tier', 'custom.autoRenew', 'custom.visits', 'custom.sessions', 'custom.sessions.count']);
    expect(dictionary.fields.some((f: any) => /^(card|claim|member)\./.test(f.path))).toBe(false);
    expect(dictionary.fields.find((f: any) => f.path === 'custom.sessions.count')).toMatchObject({ calculated: true, calculatedFrom: ['custom.sessions'], usedIn: { conditions: ['Busy month note'] } });
    expect(dictionary.fields.find((f: any) => f.path === 'custom.tier')).toMatchObject({ allowedValues: ['basic', 'plus', 'pro'], usedIn: { rules: [{ id: 'R01', title: 'Pro members get the Pro note' }] } });
    // Spanish: the approved texts are targets, the rest is missing
    const units = xliffUnits(files.get('wording/es-US.xlf')!.toString('utf8'));
    expect(units.find((u) => u.id === 'note-pro')?.target).toBe('Como miembro Pro conserva la reserva prioritaria, {{customer.givenName}}.');
    expect(units.find((u) => u.id === '@fee/label')?.target).toBe('Cuota mensual');
    expect(manifest.languages.targets[0].approved).toBe(4);
  });

  it('once a person edits that customer, the next release leaves the test out', async () => {
    const recordId = ctx.store.release(`${id}-r1`)!.pinned[0].recordId;
    const mine = (await owners()).find((r) => r.recordId === recordId);
    expect((await inj('PUT', `/api/v1/projects/${id}/records/${recordId}`, { record: { ...mine, customer: { ...mine.customer, givenName: 'Perpetua', familyName: 'Windlesham' } } })).statusCode).toBe(200);
    await save(id, (p) => { p.title = 'Membership notice, second edition'; });
    expect((await approve(id)).release).toMatchObject({ created: true, release: { number: 2 } });
    expect(ctx.store.release(`${id}-r2`)!.pinned).toEqual([{ testId: 'T01', recordId, kind: 'supplied' }]);
    const { files, zip } = await packageOf(`${id}-r2`);
    const s = JSON.parse(files.get('tests/scenarios.json')!.toString('utf8'));
    expect(s.pinnedTestsExcluded).toEqual([{ test: 'Pro members get the Pro note', reason: 'It uses a customer that was supplied for this document or edited by a person. Those never leave the studio.' }]);
    expect(s.scenarios.every((x: any) => x.source === 'generated')).toBe(true);
    for (const name of ['Perpetua', 'Windlesham']) expect(zip.includes(Buffer.from(name)), name).toBe(false);
    for (const data of files.values()) expect(data.toString('utf8')).not.toMatch(/Perpetua|Windlesham/);
    // release 1 is unchanged by any of this
    expect((await inj('POST', `/api/v1/releases/${id}-r1/package`, { verify: true, wait: true })).json().package.verified).toMatchObject({ same: true, error: null });
  });
});

/* ====================================================================== real PDFs, once */

describe('the release package with the real page composer', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { scenarioCap: 3, referenceCap: 2 } }); });
  afterAll(async () => { await ctx.app.close(); });
  const { inj, json, approve, packageOf } = helpers(() => ctx);

  it('reference PDFs are real PDFs that agree with the web page, and two builds give byte-identical ZIPs', async () => {
    const EOB = 'harborcare-demo';
    expect((await approve(EOB)).release.created).toBe(true);
    const release = (await json('GET', `/api/v1/releases/${EOB}-r1`)).release;
    const { zip, files } = await packageOf(`${EOB}-r1`);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.reference.scenarios.length).toBe(2);
    expect(manifest.versions.pdfProducer).toMatch(/Skia\/PDF/);
    const stamp = release.approvedAt.replace(/\D/g, '').slice(0, 14);
    for (const id of manifest.reference.scenarios) {
      const pdf = files.get(`reference/${id}/document.pdf`)!;
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.subarray(-6).toString('latin1')).toContain('%%EOF');
      expect(pdf.length).toBeGreaterThan(20_000);
      const facts = JSON.parse(files.get(`reference/${id}/facts.json`)!.toString('utf8'));
      expect(countPdfPages(pdf)).toBe(facts.outputs['document.pdf'].pages);
      expect(facts.outputs['document.pdf'].pages).toBeGreaterThanOrEqual(1);
      // dated at the approval, not at the build; normalising again changes nothing
      expect(pdf.toString('latin1').match(/\/(?:CreationDate|ModDate) \(D:(\d{14})/g)).toEqual([`/CreationDate (D:${stamp}`, `/ModDate (D:${stamp}`]);
      expect(normalisePdf(pdf, release.approvedAt).equals(pdf)).toBe(true);
      // the studio's own parity checks on the real outputs: PDF and web page carry the expected facts
      expect(facts.outputs['document.pdf'].facts.money).toEqual(facts.expected.money);
      expect(facts.outputs['document.html'].facts.money).toEqual(facts.expected.money);
      expect(facts.parity.documents).toMatchObject({ ok: true });
      expect(facts.parity.documents.checks.filter((c: any) => c.status === 'mismatch')).toEqual([]);
      expect(facts.parity.channels.ok).toBe(true);
      expect(JSON.stringify(facts)).not.toContain('durationMs');
    }
    const fonts = JSON.parse(files.get('assets/fonts.json')!.toString('utf8'));
    expect(fonts.referencePdfFonts.length).toBeGreaterThan(0);
    for (const c of manifest.contents) expect(sha(files.get(c.path)!), c.path).toBe(c.sha256);

    // a second build, after the clock has moved on, is the same file byte for byte
    await new Promise((r) => setTimeout(r, 1100));
    const again = await inj('POST', `/api/v1/releases/${EOB}-r1/package`, { verify: true, wait: true });
    expect(again.json().package).toMatchObject({ status: 'ready', sha256: sha(zip), bytes: zip.length, verified: { same: true, sha256: sha(zip), error: null } });
    expect((await inj('GET', `/api/v1/releases/${EOB}-r1/package`)).rawPayload.equals(zip)).toBe(true);
  });
});
