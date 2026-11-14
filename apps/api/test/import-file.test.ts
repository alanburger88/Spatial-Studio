import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSetupSpec, projectFileProblems } from '@iss/model';
import { fileSamples, sendOutline } from '@iss/scenarios';
import { buildApp } from '../src/app';
import type { AssistModel, AssistTask } from '../src/assistAi';
import { FileRefusal, readImportFile, sniffKind } from '../src/importFile';
import { zipFiles } from '../src/zip';
import { INVENTED, letterDocx, makeDocx, makePdf, scannedPdf, statementPdf, w } from './fixtures/import/makeFiles';

/**
 * "Rebuild from a file" (wave 3, section 1). Every file here is built by the test from invented values
 * (fixtures/import/makeFiles.ts). The model is a stand-in that records what it was asked: nothing here reaches a live model.
 */
type Ctx = Awaited<ReturnType<typeof buildApp>>;
const refusal = async (p: Promise<unknown>): Promise<FileRefusal> => { try { await p; } catch (e) { if (e instanceof FileRefusal) return e; throw e; } throw new Error('expected a refusal'); };
const b64 = (b: Buffer) => b.toString('base64');

describe('reading a PDF', () => {
  it('a one-page statement: blocks in reading order, headings by size and weight, a table with its header, a picture noted, small print, A4', async () => {
    const r = await readImportFile(statementPdf());
    expect(r).toMatchObject({ kind: 'pdf', pages: 1, paper: { size: 'A4', landscape: false }, bodySizePt: 10, ignored: [], notes: [] });
    expect(r.blocks.map((b) => [b.kind, b.level ?? null, b.lines[0] ?? b.rows?.[0].join('|')])).toEqual([
      ['heading', 1, 'Membership statement'],
      ['paragraph', null, 'Ms Jane Example'],
      ['paragraph', null, 'Dear Jane Example,'],
      ['paragraph', null, 'Member number: 4410 2201'],
      ['heading', 2, 'Charges this month'],
      ['table', null, 'Date|Description|Amount'],
      ['paragraph', null, 'Thank you for staying with us.'],
      ['paragraph', null, 'Fees are charged monthly in advance. You can cancel at any time from your account page or at the front desk.'],
    ]);
    expect(r.blocks[1].lines).toEqual(['Ms Jane Example', '12 Sample Street', 'Springfield, IL 62704']);
    expect(r.blocks[0]).toMatchObject({ bold: true, sizePt: 18, box: { x: 56 } });
    expect(r.blocks[5]).toMatchObject({ headerRow: true, rows: [['Date', 'Description', 'Amount'], ['2026-11-01', 'Membership', '$49.00'], ['2026-11-03', 'Towel hire', '$5.50'], ['Total', '', '$54.50']] });
    expect(r.blocks[7]).toMatchObject({ small: true, sizePt: 7 });
    expect(r.images).toEqual([{ page: 1, widthPt: 120, heightPt: 40, box: { x: 420, y: 40, w: 120, h: 40 } }]);
    expect(r.fonts).toEqual(['Helvetica']);
  });

  it('several pages: each block knows its page, and the page count is the file’s', async () => {
    const page = (n: number) => ({ texts: [{ x: 72, y: 72, size: 16, text: `Part ${n}`, bold: true }, { x: 72, y: 110, size: 10, text: `This is the text of part ${n}, written for the test.` }] });
    const r = await readImportFile(makePdf([page(1), page(2), page(3)]));
    expect(r.pages).toBe(3);
    expect(r.paper).toMatchObject({ size: 'US-Letter' });
    expect(r.blocks.map((b) => [b.page, b.kind, b.lines[0]])).toEqual([
      [1, 'heading', 'Part 1'], [1, 'paragraph', 'This is the text of part 1, written for the test.'],
      [2, 'heading', 'Part 2'], [2, 'paragraph', 'This is the text of part 2, written for the test.'],
      [3, 'heading', 'Part 3'], [3, 'paragraph', 'This is the text of part 3, written for the test.'],
    ]);
  });

  it('a list, and columns that do not line up are read as text with a note', async () => {
    const r = await readImportFile(makePdf([{ texts: [
      { x: 72, y: 72, size: 10, text: 'What to bring:' },
      { x: 72, y: 86, size: 10, text: '- Your card' }, { x: 72, y: 100, size: 10, text: '- A towel' },
      { x: 72, y: 160, size: 10, text: 'Left words here' }, { x: 300, y: 160, size: 10, text: 'right' },
      { x: 72, y: 174, size: 10, text: 'Other' }, { x: 160, y: 174, size: 10, text: 'middle words' }, { x: 420, y: 174, size: 10, text: 'far right' },
    ] }]));
    expect(r.blocks.find((b) => b.kind === 'list')).toMatchObject({ lines: ['Your card', 'A towel'] });
    expect(r.blocks.some((b) => b.kind === 'table')).toBe(false);
    expect(r.notes.join(' ')).toMatch(/rows and columns could not be told apart reliably, so they were read as text/);
  });

  it('scripts, attachments, links, comments and form fields are counted and reported, never run or opened', async () => {
    const r = await readImportFile(makePdf([{ texts: [{ x: 72, y: 72, size: 12, text: 'A notice written for the test, with nothing in it.' }], links: ['https://example.test/pay'], comment: true }], { javascript: true, attachment: true, formField: true }));
    expect(r.ignored.map((i) => i.kind).sort()).toEqual(['comment', 'embedded', 'form', 'link', 'script'].sort());
    expect(r.ignored.find((i) => i.kind === 'script')!.text).toMatch(/ignored and never run/);
    expect(r.ignored.find((i) => i.kind === 'link')!.text).toBe('1 link to outside the file was not followed and not brought across.');
  });
});

describe('reading a Word file', () => {
  it('headings, bold runs, a list, a table, a picture, A4; macros, links, tracked changes, comments, headers and embedded files reported', async () => {
    const body = [
      w.p('Policy renewal', { style: 'Title' }),
      w.lines(['Ms Jane Example', '12 Sample Street', 'Springfield, IL 62704']),
      w.runs([['Your policy ', false], ['PX-12345', true], [' renews on 1 March 2027.', false]]),
      w.p('Please read this page carefully.', { bold: true }),
      w.p('What is covered', { style: 'Heading1' }),
      w.p('Home contents', { list: true }), w.p('Accidental damage', { list: true }),
      w.p('Your premium', { style: 'Heading2' }),
      w.table([['Month', 'Premium'], ['March 2027', '$31.20'], ['April 2027', '$31.20']]),
      w.picture(144, 48),
      w.tracked('Kept wording.', 'Removed wording'),
      w.commented('Commented wording.'),
      w.link('Visit your account'),
      w.pageBreak(),
      w.p('Second page text.'),
      w.p('Premiums are collected monthly by debit order.', { style: 'FinePrint' }),
      w.sectA4(),
    ].join('');
    const r = await readImportFile(makeDocx(body, { externalLink: true, macros: true, embedded: true, comments: true, header: true }));
    expect(r).toMatchObject({ kind: 'docx', pages: 2, paper: { size: 'A4' } });
    expect(r.blocks.map((b) => [b.kind, b.level ?? null, b.page])).toEqual([
      ['heading', 1, 1], ['paragraph', null, 1], ['paragraph', null, 1], ['paragraph', null, 1], ['heading', 1, 1], ['list', null, 1], ['heading', 2, 1], ['table', null, 1],
      ['paragraph', null, 1], ['paragraph', null, 1], ['paragraph', null, 1], ['paragraph', null, 2], ['paragraph', null, 2],
    ]);
    expect(r.blocks[2]).toMatchObject({ lines: ['Your policy PX-12345 renews on 1 March 2027.'] });
    expect(r.blocks[2].bold).toBeUndefined(); // one bold word does not make the paragraph bold
    expect(r.blocks[3]).toMatchObject({ bold: true });
    expect(r.blocks[5].lines).toEqual(['Home contents', 'Accidental damage']);
    expect(r.blocks[7]).toMatchObject({ headerRow: true, rows: [['Month', 'Premium'], ['March 2027', '$31.20'], ['April 2027', '$31.20']] });
    expect(r.blocks[8].lines).toEqual(['Kept wording.']); // deleted text is left out
    expect(r.blocks[12]).toMatchObject({ small: true });
    expect(r.images).toEqual([{ page: 1, widthPt: 144, heightPt: 48 }]);
    expect(r.ignored.map((i) => i.kind).sort()).toEqual(['comment', 'embedded', 'headerFooter', 'link', 'macro', 'trackedChange'].sort());
    expect(r.ignored.find((i) => i.kind === 'macro')!.text).toBe('The file contains macros. They were ignored and never run.');
  });

  it('the page count Word last saved is used when it says more', async () => {
    expect((await readImportFile(letterDocx({ pages: 4 }))).pages).toBe(4);
  });
});

describe('refusals', () => {
  it('a scanned PDF (pictures of pages, no text) is refused with a plain explanation', async () => {
    const e = await refusal(readImportFile(scannedPdf()));
    expect(e.code).toBe('FILE_SCANNED');
    expect(e.message).toMatch(/no text layer.*does not read text from pictures/);
  });
  it('more than 20 pages', async () => {
    const pages = Array.from({ length: 21 }, (_, i) => ({ texts: [{ x: 72, y: 72, size: 12, text: `Page ${i + 1} of an invented document.` }] }));
    expect((await refusal(readImportFile(makePdf(pages)))).code).toBe('FILE_TOO_MANY_PAGES');
    expect((await refusal(readImportFile(letterDocx({ pages: 21 })))).message).toMatch(/has 21 pages\. The studio reads at most 20/);
  });
  it('larger than 10 MB', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10 * 1024 * 1024)]);
    expect(await refusal(readImportFile(big))).toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
  });
  it('not a PDF or a Word file (whatever its name)', async () => {
    expect(sniffKind(Buffer.from('Name,Amount\nAna,12'))).toBeNull();
    expect(await refusal(readImportFile(Buffer.from('Name,Amount\nAna,12')))).toMatchObject({ code: 'FILE_KIND', status: 415 });
    // A ZIP that is not a Word document.
    expect((await refusal(readImportFile(zipFiles([{ name: 'readme.txt', data: Buffer.from('invented') }])))).code).toBe('FILE_KIND');
  });
  it('a damaged file', async () => {
    expect((await refusal(readImportFile(Buffer.from('%PDF-1.7\nthis is not really a PDF at all\n%%EOF')))).code).toMatch(/FILE_DAMAGED|FILE_NO_TEXT/);
    const docx = letterDocx();
    expect((await refusal(readImportFile(docx.subarray(0, Math.floor(docx.length / 2))))).code).toMatch(/FILE_KIND|FILE_DAMAGED/);
    expect((await refusal(readImportFile(makeDocx('', { documentXml: '<w:document><w:body><w:p></w:body></w:document>' })))).code).toBe('FILE_DAMAGED');
  });
  it('a ZIP bomb-style Word file is refused before and while it is unpacked', async () => {
    // A document part that unpacks to 40 MB (from a few kilobytes) is refused by its declared size.
    const huge = Buffer.alloc(40 * 1024 * 1024, 0x20);
    const bomb = makeDocxWith('word/document.xml', huge);
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(await refusal(readImportFile(bomb))).toMatchObject({ code: 'FILE_TOO_LARGE' });
    // The same part with a header that lies about its size is stopped while unpacking.
    expect((await refusal(readImportFile(lyingSize(makeDocxWith('word/document.xml', Buffer.alloc(4 * 1024 * 1024, 0x20)), 'word/document.xml', 1000)))).code).toBe('FILE_TOO_LARGE');
  });
  it('an XML document type (entity expansion) is refused', async () => {
    const e = await refusal(readImportFile(makeDocx('', { documentXml: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><w:document><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>' })));
    expect(e.code).toBe('FILE_UNSAFE');
  });
});

/** A Word file whose part `name` holds `data` (the rest as in `makeDocx`). */
function makeDocxWith(name: string, data: Buffer): Buffer {
  return makeDocx('', { documentXml: name === 'word/document.xml' ? data.toString('latin1') : undefined });
}
/** The ZIP with the sizes of one entry rewritten (local header and directory), as a hostile file would. */
function lyingSize(zip: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(zip);
  let at = 0;
  while ((at = out.indexOf(Buffer.from(name), at + 1)) > 0) {
    if (out.readUInt32LE(at - 30) === 0x04034b50) out.writeUInt32LE(size, at - 30 + 22);
    if (out.readUInt32LE(at - 46) === 0x02014b50) out.writeUInt32LE(size, at - 46 + 24);
  }
  return out;
}

/* ------------------------------------------------------------------ the routes */

let answer: unknown = null;
const seen: AssistTask[] = [];
const model: AssistModel = async (_cfg, task) => { seen.push(task); return answer; };
const saved: Record<string, string | undefined> = {};
const setEnv = (env: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(env)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const restoreEnv = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

/** A setup in the form a model returns it (every property present). */
const MODEL_SETUP = {
  title: 'Membership statement', issuerName: 'Northside Gym', accent: '', summary: 'A monthly membership statement.', paper: '',
  fields: [
    { label: 'Member number', type: 'text', choices: [], columns: [], example: '', required: true },
    { label: 'Amount due', type: 'amount', choices: [], columns: [], example: '', required: false },
    { label: 'Due date', type: 'date', choices: [], columns: [], example: '', required: false },
    { label: 'Charges', type: 'list', choices: [], columns: [{ label: 'Date', type: 'date' }, { label: 'Description', type: 'text' }, { label: 'Amount', type: 'amount' }], example: '', required: false },
  ],
  sections: [
    { type: 'heading', text: 'Membership statement', fields: [], list: '', columns: [], totalColumn: '', name: '', versions: [], label: '', url: '' },
    { type: 'paragraph', text: 'Dear {First name} {Last name},', fields: [], list: '', columns: [], totalColumn: '', name: '', versions: [], label: '', url: '' },
    { type: 'keyFigures', text: '', fields: ['Member number', 'Amount due', 'Due date'], list: '', columns: [], totalColumn: '', name: '', versions: [], label: '', url: '' },
    { type: 'table', text: '', fields: [], list: 'Charges', columns: [], totalColumn: 'Amount', name: '', versions: [], label: '', url: '' },
    { type: 'notice', text: 'Fees are charged monthly in advance.', fields: [], list: '', columns: [], totalColumn: '', name: '', versions: [], label: '', url: '' },
  ],
  email: { subject: '', intro: '' }, sms: '',
};

describe('rebuild routes', () => {
  let ctx: Ctx;
  let dataDir: string;
  beforeAll(async () => {
    // "A live model is configured" (with a key that is not one): the routes take the model path, which the stand-in answers.
    setEnv({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'not-a-real-key', AUTH: undefined });
    dataDir = mkdtempSync(path.join(tmpdir(), 'iss-rebuild-'));
    ctx = await buildApp({ dataDir, logger: false, auth: false, assistModel: model });
  });
  afterAll(async () => { await ctx.app.close(); restoreEnv(); });
  const post = (url: string, payload: unknown) => ctx.app.inject({ method: 'POST', url, payload: payload as any });
  const files = (...bufs: Buffer[]) => bufs.map((b) => ({ data: b64(b) }));
  const audits = async (action: string) => (await ctx.app.inject({ method: 'GET', url: `/api/v1/audit?action=${action}` })).json().events as any[];

  it('reading returns what was found, the marks and (for two samples) the comparison; nothing is stored or audited', async () => {
    const before = (await ctx.app.inject({ method: 'GET', url: '/api/v1/audit' })).json().events.length;
    const r = await post('/api/v1/projects/rebuild/read', { files: files(statementPdf(INVENTED[0]), statementPdf(INVENTED[1])) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.samples).toHaveLength(2);
    expect(body.samples[0].reading.blocks).toHaveLength(8);
    expect(body.samples[0].marks.map((m: any) => m.kind)).toEqual(expect.arrayContaining(['name', 'address', 'reference', 'amount', 'date']));
    expect(body.alignment.counts).toMatchObject({ different: 1 });
    expect(body.ai).toMatchObject({ live: true });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/audit' })).json().events.length).toBe(before);
  });

  it('refusals come back with the sample they concern', async () => {
    const r = await post('/api/v1/projects/rebuild/read', { files: files(statementPdf(), scannedPdf()) });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'FILE_SCANNED', sample: 2 });
    expect(r.json().error.message).toMatch(/^Sample 2: This PDF has no text layer/);
    expect((await post('/api/v1/projects/rebuild/read', { files: [] })).statusCode).toBe(400);
    expect((await post('/api/v1/projects/rebuild/read', { files: files(statementPdf(), statementPdf(), statementPdf(), statementPdf()) })).json().error.code).toBe('TOO_MANY_FILES');
    expect((await post('/api/v1/projects/rebuild/read', { files: [{ data: 'A'.repeat(14 * 1024 * 1024) }] })).statusCode).toBe(413);
  });

  it('the model is never called without the confirmation, nor when the outline differs from what was shown', async () => {
    seen.length = 0;
    const f = files(statementPdf());
    const fs = fileSamples([await readImportFile(statementPdf())]);
    const outline = sendOutline(fs, { placeholders: true });
    const noFlag = await post('/api/v1/projects/rebuild/propose', { files: f, useAi: true, placeholders: true, outline });
    expect(noFlag.statusCode).toBe(400);
    expect(noFlag.json().error.code).toBe('CONSENT_REQUIRED');
    const falsy = await post('/api/v1/projects/rebuild/propose', { files: f, useAi: true, confirmNoCustomerData: 'yes', placeholders: true, outline });
    expect(falsy.json().error.code).toBe('CONSENT_REQUIRED');
    const changed = await post('/api/v1/projects/rebuild/propose', { files: f, useAi: true, confirmNoCustomerData: true, placeholders: true, outline: outline.replace('{{Amount due}}', '$54.50') });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('OUTLINE_CHANGED');
    const otherChoice = await post('/api/v1/projects/rebuild/propose', { files: f, useAi: true, confirmNoCustomerData: true, placeholders: false, outline });
    expect(otherChoice.statusCode).toBe(409);
    expect(seen).toHaveLength(0);
    expect(await audits('file.read')).toHaveLength(0);
  });

  it('with the confirmation and placeholders, the model receives exactly the outline, without the marked values; its answer is checked', async () => {
    seen.length = 0;
    answer = MODEL_SETUP;
    const fs = fileSamples([await readImportFile(statementPdf())]);
    const outline = sendOutline(fs, { placeholders: true });
    const r = await post('/api/v1/projects/rebuild/propose', { files: files(statementPdf()), useAi: true, confirmNoCustomerData: true, placeholders: true, outline, title: 'Gym statement' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ mode: 'proposal', source: 'ai' });
    expect(seen).toHaveLength(1);
    expect(seen[0].user).toContain(outline);
    for (const value of ['Jane', 'Example', '12 Sample Street', '62704', '4410 2201', '$54.50', '$49.00', 'Towel hire', '2026-12-01']) expect(seen[0].user).not.toContain(value);
    expect(seen[0].image).toBeUndefined();
    expect(body.spec.paper).toBe('A4'); // the model left it empty: the file's paper is kept
    expect(checkSetupSpec(body.spec)).toEqual({ spec: body.spec, notes: [] });
    expect(body.report.map((i: any) => i.topic)).toEqual(expect.arrayContaining(['images', 'fonts', 'layout', 'rules']));
    const [entry] = await audits('file.read');
    expect(entry.detail).toEqual({ files: 1, kinds: ['pdf'], pages: [1], ai: true, placeholders: true, marks: expect.any(Number), fields: 4, sections: 5 });
  });

  it('without placeholders the confirmed text is sent as it is', async () => {
    seen.length = 0;
    answer = MODEL_SETUP;
    const fs = fileSamples([await readImportFile(statementPdf())]);
    const outline = sendOutline(fs, { placeholders: false });
    const r = await post('/api/v1/projects/rebuild/propose', { files: files(statementPdf()), useAi: true, confirmNoCustomerData: true, placeholders: false, outline });
    expect(r.json().mode).toBe('proposal');
    expect(seen[0].user).toContain('Ms Jane Example');
    expect((await audits('file.read'))[0].detail).toMatchObject({ ai: true, placeholders: false });
  });

  it('a model answer that fails the checks, and no AI key, are plain states; the built-in reading still works', async () => {
    answer = { title: 'x', fields: 'not a list', sections: [] };
    const fs = fileSamples([await readImportFile(statementPdf())]);
    const outline = sendOutline(fs, { placeholders: true });
    const bad = (await post('/api/v1/projects/rebuild/propose', { files: files(statementPdf()), useAi: true, confirmNoCustomerData: true, placeholders: true, outline })).json();
    expect(bad).toMatchObject({ mode: 'unavailable', reason: 'failed' });
    expect(bad.message).toMatch(/did not pass the studio’s checks/);
    const offline = (await post('/api/v1/projects/rebuild/propose', { files: files(statementPdf()), useAi: true, confirmNoCustomerData: true, placeholders: true, outline, forceOffline: true })).json();
    expect(offline).toMatchObject({ mode: 'unavailable', reason: 'no-key' });
    expect(offline.message).toMatch(/Continue without AI/);
  });

  it('without AI: the built-in proposal is checked, becomes a document that resolves and composes, and nothing personal from the file is stored', async () => {
    seen.length = 0;
    const r = await post('/api/v1/projects/rebuild/propose', { files: files(statementPdf()), useAi: false, title: 'Rebuilt statement' });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p).toMatchObject({ mode: 'proposal', source: 'builtin' });
    expect(seen).toHaveLength(0);
    expect(checkSetupSpec(p.spec).notes).toEqual([]);
    expect(p.spec.fields.map((f: any) => f.label)).toEqual(['Address line 1', 'Address line 2', 'Member number', 'Amount due', 'Due date', 'Charges this month']);
    expect(p.spec.sections.map((s: any) => s.type)).toEqual(['heading', 'paragraph', 'paragraph', 'keyFigures', 'heading', 'table', 'paragraph', 'notice']);

    // The ordinary setup review and creation (the same routes "Describe your document" uses).
    const draft = (await post('/api/v1/projects/setup/draft', { spec: p.spec, source: 'builtin', title: 'Rebuilt statement' })).json();
    expect(draft).toMatchObject({ mode: 'proposal', notes: [], preview: { blocking: [] } });
    expect(projectFileProblems(draft.project)).toEqual([]);
    const created = await post('/api/v1/projects/setup', { spec: draft.spec, source: 'builtin', origin: 'file', title: 'Rebuilt statement', customers: 'generate' });
    expect(created.statusCode).toBe(201);
    const project = created.json().project;
    expect(project.presentationProfiles.find((x: any) => x.id === 'paged-pdf').paper).toBe('A4');
    const [made] = await audits('project.create');
    expect(made.detail).toMatchObject({ setup: 'builtin', from: 'file' });
    const recs = (await ctx.app.inject({ method: 'GET', url: `/api/v1/records?documentType=custom&full=1&projectId=${project.projectId}` })).json().records;
    const pdf = await post('/api/v1/compose/pdf', { projectId: project.projectId, recordId: recs[0].recordId });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // The studio's own PDF reads back: its heading and its table.
    const back = await readImportFile(pdf.rawPayload);
    expect(back.blocks.some((b) => b.kind === 'heading' && b.lines[0] === 'Membership statement')).toBe(true);

    // Nothing personal from the file is anywhere in the studio's data, and the audit holds kinds and counts only.
    const personal = ['Jane', 'Example', '12 Sample Street', 'Springfield', '62704', '4410 2201', '54.50', 'Towel hire'];
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p2 = path.join(d, f); return statSync(p2).isDirectory() ? walk(p2) : [p2]; });
    for (const f of walk(dataDir)) { const text = readFileSync(f).toString('latin1'); for (const v of personal) expect(text.includes(v), `${v} in ${path.basename(f)}`).toBe(false); }
    const all = (await ctx.app.inject({ method: 'GET', url: '/api/v1/audit?action=file.read' })).json().events as any[];
    for (const e of all) {
      expect(Object.keys(e.detail).sort()).toEqual(['ai', 'fields', 'files', 'kinds', 'marks', 'pages', 'placeholders', 'sections']);
      expect(JSON.stringify(e.detail)).not.toMatch(/statement|Jane|\.pdf|\.docx/i);
    }
  });

  it('a Word file and three samples propose without AI too', async () => {
    const word = (await post('/api/v1/projects/rebuild/propose', { files: files(letterDocx({ macros: true })), useAi: false })).json();
    expect(word).toMatchObject({ mode: 'proposal', source: 'builtin', spec: { title: 'Policy renewal', paper: 'A4' } });
    expect(word.report.find((i: any) => i.topic === 'safety').text).toMatch(/macros/);
    const three = (await post('/api/v1/projects/rebuild/propose', { files: files(...INVENTED.map((v) => statementPdf(v))), useAi: false, title: 'Three samples' })).json();
    expect(three.spec.sections.some((s: any) => s.type === 'messages')).toBe(true);
    expect(three.report.map((i: any) => i.text).join(' ')).toMatch(/not in every sample/);
    const draft = (await post('/api/v1/projects/setup/draft', { spec: three.spec, source: 'builtin', title: 'Three samples' })).json();
    expect(draft).toMatchObject({ mode: 'proposal', notes: [], preview: { blocking: [] } });
  });
});
