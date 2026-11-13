import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project } from '@iss/model';
import { buildApp } from '../src/app';
import { gymMember, gymProject, SAMPLE_WORDING, visibleText } from '../../../packages/model/test/helpers/customProject';

/**
 * The third kind of document, “Your own data”: a project that starts blank, defines its own data fields, and has only
 * customers of its own (generated for it or supplied by the user). Runs against the real API with the real composer.
 */
describe('a blank project with its own data fields', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-own-')), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string): Promise<Project> => (await json('GET', `/api/v1/projects/${id}`)).project;
  /** The customers a project sees, as the studio asks for them. */
  const customers = async (projectId: string, kind = 'custom') => (await json('GET', `/api/v1/records?documentType=${kind}&full=1&projectId=${projectId}`)).records as any[];
  const blocking = (r: any) => r.findings.filter((f: any) => f.severity === 'blocking');
  let id = '';

  it('is created from the Blank project template with an issuer name and colour, and gets its first customer at once', async () => {
    const templates = (await json('GET', '/api/v1/templates')).templates;
    expect(templates.find((t: any) => t.id === 'blank-project')).toMatchObject({ title: 'Blank project', documentType: 'custom', source: 'builtin' });

    const r = await inj('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Membership notice', issuerName: '  Northside   Gym ', accent: '#1F4E79' });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    id = body.project.projectId;
    expect(id).toBe('membership-notice');
    expect(body.project).toMatchObject({ documentType: 'custom', modelVersion: 1, title: 'Membership notice', issuer: { name: 'Northside Gym', accent: '#1f4e79', product: 'Membership notice' }, rules: [], contentParts: [], customFields: [], languages: [] });
    expect(body.project.nodes).toEqual([{ id: 'doc-root', type: 'container', name: 'Document', children: [] }]);
    expect(body.customers).toBe(1);
    expect((await json('GET', '/api/v1/projects')).projects.find((x: any) => x.projectId === id)).toMatchObject({ documentType: 'custom', sample: false, nodeCount: 1, ruleCount: 0 });

    const mine = await customers(id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ documentType: 'custom', projectId: id, generated: { label: 'Document in English (United States)' }, customer: { locale: 'en-US' } });
    expect(mine[0].recordId).toMatch(/^REC-6\d{4}$/);
    expect(mine[0].card ?? mine[0].claims ?? mine[0].member).toBeUndefined();
    expect(await json('GET', `/api/v1/projects/${id}/test-data`)).toMatchObject({ count: 1, stale: false, summary: { outcomes: { total: 1, reached: 1 }, unreachable: 0 } });

    const res = await inj('POST', '/api/v1/resolve', { projectId: id, recordId: mine[0].recordId, includeTree: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ findings: [], result: { documentType: 'custom', documentFacts: {}, selectedVariants: {} }, tree: { id: 'doc-root', children: [] } });
  });

  it('checks the issuer name and colour, and keeps Blank letter for the two sample kinds', async () => {
    const make = (extra: object) => inj('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Another notice', ...extra });
    expect((await make({ issuerName: 'X' })).json().error).toMatchObject({ code: 'INVALID_ISSUER_NAME' });
    expect((await make({ issuerName: 'N'.repeat(61) })).json().error).toMatchObject({ code: 'INVALID_ISSUER_NAME' });
    expect((await make({ accent: 'red' })).json().error).toMatchObject({ code: 'INVALID_ACCENT' });
    expect((await make({ accent: '#12345' })).json().error).toMatchObject({ code: 'INVALID_ACCENT' });
    expect((await json('GET', '/api/v1/projects')).projects.some((x: any) => x.title === 'Another notice')).toBe(false);
    // without them: the title is the issuer, and the colour is a neutral one
    const plain = (await make({})).json();
    expect(plain.project.issuer).toEqual({ name: 'Another notice', accent: '#475569', product: 'Another notice' });
    expect(plain.customers).toBe(1);
    const letter = await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Own letter', documentType: 'custom' });
    expect(letter.statusCode).toBe(400);
    expect(letter.json().error.message).toMatch(/starts from the “Blank project” template/);
    // the template preview comes with a customer to draw it with (nothing is stored)
    const preview = await json('GET', '/api/v1/templates/blank-project/project');
    expect(preview.project.documentType).toBe('custom');
    expect(preview.previewRecord).toMatchObject({ recordId: 'REC-0000', documentType: 'custom', customer: { givenName: 'Avery', familyName: 'Abbott' } });
    expect((await json('GET', '/api/v1/templates/blank-letter/project')).previewRecord).toBeUndefined();
  });

  it('an empty page composes as pages, PDF, web page, email and SMS, and PDF and web page agree', async () => {
    const [first] = await customers(id);
    const run = { projectId: id, recordId: first.recordId };
    const pages = await json('POST', '/api/v1/compose/pages', run);
    expect(pages).toMatchObject({ pageCount: 1, diagnostics: [], findings: [], transactionCount: null });
    expect(pages.pages[0].nodeIds).toEqual([]);
    const pdf = await inj('POST', '/api/v1/compose/pdf', run);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['x-page-count']).toBe('1');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const html = await inj('POST', '/api/v1/compose/html', run);
    expect(html.statusCode).toBe(200);
    expect(visibleText(html.payload).match(SAMPLE_WORDING)?.[0]).toBeUndefined();
    const email = await json('POST', '/api/v1/compose/email', run);
    expect(email).toMatchObject({ subject: 'Your Northside Gym document is ready', parity: { ok: true } });
    expect(await json('POST', '/api/v1/compose/sms', run)).toMatchObject({ text: 'DEMO Northside Gym: Your document is ready.', segments: 1, parity: { ok: true } });
    const parity = await json('POST', '/api/v1/parity', run);
    expect(parity.report.ok).toBe(true);
    expect(parity.report.checks.filter((c: any) => c.status === 'mismatch')).toEqual([]);
    expect(parity.report.checks.find((c: any) => c.id === 'identity')).toMatchObject({ status: 'match', expected: {}, pdf: {}, html: {} });
    const sim = await json('POST', '/api/v1/compose/afp-sim', run);
    expect(sim).toMatchObject({ simulationOnly: true, afpBytesGenerated: 0, pageCount: 1 });
  });

  it('takes data fields (a list among them), components and rules through a normal save, and refuses a malformed list', async () => {
    const current = await project(id);
    const built = gymProject({ withSpanish: true });
    const next: Project = { ...built, projectId: id, title: current.title, issuer: current.issuer, modelVersion: current.modelVersion + 1 };
    const bad = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...next, customFields: [{ key: 'sessions', label: 'Booked sessions', type: 'list', itemFields: [] }] } }, { 'if-match': `"${current.modelVersion}"` });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'INVALID_FIELDS', message: expect.stringMatching(/needs at least one column/) });
    const otherKind = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...next, documentType: 'credit-statement', rules: [] } }, { 'if-match': `"${current.modelVersion}"` });
    expect(otherKind.json().error).toMatchObject({ code: 'DOCUMENT_TYPE_FIXED' });

    const ok = await inj('PUT', `/api/v1/projects/${id}`, { project: next }, { 'if-match': `"${current.modelVersion}"` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project).toMatchObject({ modelVersion: current.modelVersion + 1, documentType: 'custom' });
    const schemas = await json('GET', `/api/v1/projects/${id}/schemas`);
    expect(schemas.dimensions.map((d: any) => d.id)).toEqual(['persona', 'journey', 'output', 'language']);
    expect(schemas.edgeCasePresets).toEqual([]);
    expect(schemas.fields.map((f: any) => f.path)).toEqual(expect.arrayContaining(['customer.givenName', 'custom.tier', 'custom.sessions', 'custom.sessions.count']));
    expect(schemas.fields.some((f: any) => /^(card|claim|claims|member)\b/.test(f.path))).toBe(false);
    // the customer generated for the empty page predates the fields: the studio says the set is stale
    expect(await json('GET', `/api/v1/projects/${id}/test-data`)).toMatchObject({ count: 1, stale: true });
  });

  it('regenerating test customers covers every rule, message, section, language and edge value', async () => {
    const before = await customers(id);
    const g = await inj('POST', `/api/v1/projects/${id}/test-data`, { outcomes: true, edges: true });
    expect(g.statusCode).toBe(201);
    const out = g.json();
    expect(out).toMatchObject({ replaced: 1, summary: { outcomes: { total: 9, reached: 9 }, edges: { total: 12, reached: 12 }, unreachable: 0 } });
    expect(out.generated).toBe(out.customers.length);
    expect(out.kept).toBeUndefined();
    const mine = await customers(id);
    expect(mine.map((r) => r.recordId)).toEqual(out.customers.map((c: any) => c.recordId));
    expect(mine.every((r) => /^REC-6\d{4}$/.test(r.recordId) && r.projectId === id && r.generated?.label)).toBe(true);
    // ids are never reused
    expect(mine.some((r) => r.recordId === before[0].recordId)).toBe(false);
    for (const r of mine) {
      const res = await json('POST', '/api/v1/resolve', { projectId: id, recordId: r.recordId });
      expect(blocking(res), r.generated.label).toEqual([]);
    }
    expect(mine.filter((r) => r.customer.locale === 'es-US')).toHaveLength(1);
    expect((await json('GET', `/api/v1/projects/${id}/workflow`)).readiness).toMatchObject({ ready: true, recordsChecked: mine.length, blocking: [] });
  });

  it('a customer’s document composes in every output with its own values and no sample wording, and PDF and web page agree', async () => {
    const mine = await customers(id);
    const pro = mine.find((r) => r.custom.tier === 'pro')!;
    const run = { projectId: id, recordId: pro.recordId };
    const pages = await json('POST', '/api/v1/compose/pages', run);
    expect(pages.pageCount).toBe(1);
    expect(pages.diagnostics.filter((d: any) => d.severity === 'blocking' || d.severity === 'error')).toEqual([]);
    expect(pages.pages[0].tables.sessions).toMatchObject({ rows: pro.custom.sessions.length, continued: false });
    const html = (await inj('POST', '/api/v1/compose/html', run)).payload;
    const text = visibleText(html);
    for (const s of [pro.customer.givenName, 'Flex', '$49.00', 'Pro members', 'Booked sessions', 'Sample class 1']) expect(text).toContain(s);
    expect(text.match(SAMPLE_WORDING)?.[0]).toBeUndefined();
    const parity = await json('POST', '/api/v1/parity', run);
    expect(parity.report.checks.filter((c: any) => c.status === 'mismatch')).toEqual([]);
    expect(parity.report.ok).toBe(true);
    expect(parity.report.checks.find((c: any) => c.id === 'identity').expected).toEqual({ name: `${pro.customer.givenName} ${pro.customer.familyName}` });
    expect(parity.expected.tableRows).toEqual({ sessions: pro.custom.sessions.length });
    const email = await json('POST', '/api/v1/compose/email', run);
    expect(email.parity.ok).toBe(true);
    expect(`${email.subject}\n${email.text}`.match(SAMPLE_WORDING)?.[0]).toBeUndefined();
    // every check, the browser accessibility run included: the document's first heading is the page's main heading
    const check = await json('POST', '/api/v1/validate', run);
    expect(Object.fromEntries(Object.entries(check.suites).map(([k, v]: [string, any]) => [k, v.status]))).toEqual({ rules: 'clean', bindings: 'clean', pagination: 'clean', parity: 'clean', accessibility: 'clean' });
    expect(check.counts).toMatchObject({ blocking: 0, error: 0, warning: 0 });
    expect(html).toMatch(/<div class="iss-rich"><h1>Your membership<\/h1>/);
    expect(JSON.stringify(check.issues.map((i: any) => i.message)).match(SAMPLE_WORDING)?.[0]).toBeUndefined();
  });

  it('cube, landscape, journey replay and the offline assistant work on its customers', async () => {
    const mine = await customers(id);
    const cube = await inj('POST', '/api/v1/analysis/cube', { projectId: id, axes: ['persona', 'output', 'language'] });
    expect(cube.statusCode).toBe(200);
    expect(cube.json().axes[0].totalCategories).toBe(mine.length);
    expect(cube.json().axes[0].categories.map((c: any) => c.label)).toEqual(mine.slice(0, 5).map((r) => r.generated.label));
    expect((await inj('POST', '/api/v1/analysis/cube', { projectId: id, axes: ['persona', 'claimStatus', 'output'] })).json().error.message).toBe('Claim status is not available for a document with its own data.');
    const land = await json('POST', '/api/v1/analysis/landscape', { projectId: id });
    expect(land).toMatchObject({ reconciles: true, universeSize: mine.length });
    expect((await json('POST', '/api/v1/journeys/replay', { projectId: id, recordId: mine[0].recordId })).snapshots.map((s: any) => s.kind)).toEqual(['baseline']);
    expect((await inj('POST', '/api/v1/scenarios/generate', { recordId: mine[0].recordId, preset: 'zero-transactions' })).statusCode).toBe(400);

    const ask = async (message: string, context: object = {}) => json('POST', '/api/v1/assistant/message', { message, forceOffline: true, context: { projectId: id, ...context } });
    const rules = await ask('What rules apply?', { recordId: mine[0].recordId });
    expect(rules).toMatchObject({ mode: 'offline', understood: true });
    expect(rules.response).toMatch(new RegExp(`For ${mine[0].customer.givenName} ${mine[0].customer.familyName} the engine matched “`));
    expect(rules.explanation.nodeId).toBe('renewal-note');
    const named = await ask(`Show me ${mine[1].customer.givenName} ${mine[1].customer.familyName}`);
    expect(named.actions).toEqual([{ action: 'select_scenario', recordId: mine[1].recordId }]);
    const byId = await ask(`Choose ${mine[2].recordId.toLowerCase()}`);
    expect(byId.actions).toEqual([{ action: 'select_scenario', recordId: mine[2].recordId }]);
    const edge = await ask('Show an edge case');
    expect(edge).toMatchObject({ understood: true, actions: [] });
    expect(edge.response).toMatch(/no ready-made edge cases for a document with its own data/);
    const lost = await ask('Show me a cardholder who missed two payments and a denied claim');
    expect(lost).toMatchObject({ understood: false, actions: [] });
    expect(lost.suggestions).toEqual(expect.arrayContaining(['What rules apply?', 'Run validation']));
    for (const reply of [rules, named, byId, edge, lost, await ask('help')]) {
      expect(`${reply.response} ${(reply.suggestions ?? []).join(' ')}`.match(/\b(card|cardholder|claims?|eob|statement|bill|balance|aster|harborcare)\b/i)?.[0], reply.response).toBeUndefined();
    }
  });

  it('supplied customers are checked against this project’s fields and stay with this project', async () => {
    const good = (over: object = {}) => { const { recordId: _id, documentType: _dt, ...rest } = gymMember(over); return rest; };
    const rows = [good({ custom: { tier: 'pro' } }), good({ custom: { sessions: [{ day: 'soon', className: 'Spin', priceCents: 1200, spots: 2 }] } }), { customer: { givenName: 'No', familyName: 'Fields', locale: 'en-US' } }];
    // a document with its own data has no shared customers: the project must be named
    expect((await inj('POST', '/api/v1/records/import', { documentType: 'custom', format: 'json', data: rows })).json().error).toMatchObject({ code: 'PROJECT_REQUIRED' });
    expect((await inj('POST', '/api/v1/records/import', { documentType: 'credit-statement', projectId: id, format: 'json', data: rows })).json().error).toMatchObject({ code: 'RECORD_TYPE_MISMATCH' });

    const before = (await customers(id)).length;
    const dry = await json('POST', '/api/v1/records/import', { projectId: id, format: 'json', data: rows, dryRun: true });
    expect(dry).toMatchObject({ documentType: 'custom', dryRun: true, scope: 'project', projectId: id, total: 3, imported: [{ recordId: null, name: 'Robin Okoye' }] });
    expect(await customers(id)).toHaveLength(before);

    const r = await json('POST', '/api/v1/records/import', { documentType: 'custom', projectId: id, format: 'json', data: rows });
    expect(r).toMatchObject({ documentType: 'custom', dryRun: false, scope: 'project', projectId: id, total: 3 });
    expect(r.imported).toHaveLength(1);
    expect(r.imported[0].recordId).toMatch(/^REC-6\d{4}$/);
    expect(r.rejected).toEqual([
      { row: 2, sourceId: null, errors: ['custom.sessions[0].day: expected a date YYYY-MM-DD, got "soon".'] },
      { row: 3, sourceId: null, errors: expect.arrayContaining(['Missing required field Plan name (custom.planName).']) },
    ]);
    const suppliedId = r.imported[0].recordId;
    const mine = await customers(id);
    expect(mine).toHaveLength(before + 1);
    expect(mine.find((x) => x.recordId === suppliedId)).toMatchObject({ projectId: id, imported: true, documentType: 'custom', custom: { tier: 'pro' } });
    expect(mine.find((x) => x.recordId === suppliedId).generated).toBeUndefined();
    expect(blocking(await json('POST', '/api/v1/resolve', { projectId: id, recordId: suppliedId }))).toEqual([]);

    // a list cannot come from a CSV, and the message says what to do instead
    const csv = await inj('POST', '/api/v1/records/import', { projectId: id, format: 'csv', data: 'customer.givenName,customer.familyName,customer.locale,custom.sessions\nAna,Diaz,en-US,[]\n' });
    expect(csv.statusCode).toBe(422);
    expect(csv.json().error.message).toMatch(/is a list \(Booked sessions\), and a CSV row cannot hold a list/);
    const plainCsv = await json('POST', '/api/v1/records/import', { projectId: id, format: 'csv', data: 'customer.givenName,customer.familyName,customer.locale,custom.planName,custom.monthlyFeeCents,custom.renewalDate,custom.tier\nAna,Diaz,en-US,Flex,4900,2026-12-01,plus\n' });
    expect(plainCsv.imported).toHaveLength(1);

    // not visible to any other project, nor in the shared list; another project cannot use it
    const other = (await json('POST', '/api/v1/projects', { templateId: 'blank-project', title: 'Second own-data document' })).project.projectId;
    expect((await customers(other)).map((x) => x.recordId)).not.toContain(suppliedId);
    expect((await customers(other)).every((x) => x.projectId === other)).toBe(true);
    expect((await json('GET', '/api/v1/records?full=1')).records.some((x: any) => x.documentType === 'custom')).toBe(false);
    expect((await inj('POST', '/api/v1/resolve', { projectId: other, recordId: suppliedId })).json().error).toMatchObject({ code: 'RECORD_OTHER_PROJECT' });
    // without a kind in the question, a document with its own data still only sees its own customers
    const unfiltered = (await json('GET', `/api/v1/records?full=1&projectId=${id}`)).records;
    expect(unfiltered.every((x: any) => x.documentType === 'custom' && x.projectId === id)).toBe(true);
    expect(unfiltered).toHaveLength(before + 2);

    // removable, without touching the generated customers
    const del = await json('DELETE', `/api/v1/projects/${id}/records/supplied`);
    expect(del).toEqual({ removed: 2, remaining: before, kept: null });
    expect((await customers(id)).some((x) => x.imported)).toBe(false);
    expect((await inj('GET', `/api/v1/records/${suppliedId}`)).statusCode).toBe(404);
  });

  it('removing the generated customers leaves one starting customer, and says so', async () => {
    const before = await customers(id);
    const del = await json('DELETE', `/api/v1/projects/${id}/test-data`);
    expect(del.removed).toBe(before.length);
    expect(del.remaining).toBe(1);
    expect(del.kept).toMatchObject({ name: 'Avery Abbott', label: 'Starting customer: every field filled in' });
    expect(del.note).toMatch(/one starting customer \(Avery Abbott\) was created/);
    const left = await customers(id);
    expect(left.map((x) => x.recordId)).toEqual([del.kept.recordId]);
    expect(before.map((x) => x.recordId)).not.toContain(del.kept.recordId);
    expect(left[0].custom).toMatchObject({ planName: 'Flex', monthlyFeeCents: 4900, tier: 'basic' });
    expect(left[0].custom.sessions).toHaveLength(3);
    expect(blocking(await json('POST', '/api/v1/resolve', { projectId: id, recordId: left[0].recordId }))).toEqual([]);
    expect(await json('GET', `/api/v1/projects/${id}/test-data`)).toMatchObject({ count: 1, generatedAt: null, summary: null });
    // removing again cannot take the last one away
    const again = await json('DELETE', `/api/v1/projects/${id}/test-data`);
    expect(again).toMatchObject({ removed: 1, remaining: 1 });
    expect((await customers(id))).toHaveLength(1);
    // supplied customers count: with one of those, nothing needs to be created
    const { recordId: _id, documentType: _dt, ...own } = gymMember();
    await json('POST', '/api/v1/records/import', { projectId: id, format: 'json', data: [own] });
    expect(await json('DELETE', `/api/v1/projects/${id}/test-data`)).toEqual({ removed: 1, remaining: 1, kept: null });
    // and removing the supplied one, the last customer there is, brings the starting customer back
    const last = await json('DELETE', `/api/v1/projects/${id}/records/supplied`);
    expect(last).toMatchObject({ removed: 1, remaining: 1, kept: { name: 'Avery Abbott' } });
    // regenerate for the tests below
    expect((await inj('POST', `/api/v1/projects/${id}/test-data`, {})).statusCode).toBe(201);
  });

  it('works as a saved template: a project created from it has its own customers', async () => {
    const saved = await inj('POST', '/api/v1/templates', { projectId: id, title: 'Gym notice starter', description: 'Membership notice layout' });
    expect(saved.statusCode).toBe(201);
    const template = saved.json().template;
    expect(template).toMatchObject({ documentType: 'custom', source: 'saved', version: 1 });
    const preview = await json('GET', `/api/v1/templates/${template.id}/project`);
    expect(preview.previewRecord).toMatchObject({ recordId: 'REC-0000', custom: { planName: 'Flex' } });
    // it cannot become a new version of a template of another kind
    const cardTemplate = (await json('POST', '/api/v1/templates', { projectId: 'aster-card-demo', title: 'Card starter' })).template;
    expect((await inj('POST', '/api/v1/templates', { projectId: id, templateId: cardTemplate.id })).json().error).toMatchObject({ code: 'DOCUMENT_TYPE_MISMATCH' });

    const made = await inj('POST', '/api/v1/projects', { templateId: template.id, title: 'Riverside gym notice' });
    expect(made.statusCode).toBe(201);
    const p = made.json().project;
    expect(p).toMatchObject({ documentType: 'custom', fromTemplate: { templateId: template.id, version: 1 }, issuer: { name: 'Northside Gym' } });
    expect(p.customFields.map((f: any) => f.key)).toContain('sessions');
    expect(made.json().customers).toBeGreaterThanOrEqual(8);
    const theirs = await customers(p.projectId);
    expect(theirs).toHaveLength(made.json().customers);
    expect(theirs.every((x) => x.projectId === p.projectId)).toBe(true);
    const ours = new Set((await customers(id)).map((x) => x.recordId));
    expect(theirs.some((x) => ours.has(x.recordId))).toBe(false);
    expect(blocking(await json('POST', '/api/v1/resolve', { projectId: p.projectId, recordId: theirs[0].recordId }))).toEqual([]);
    expect(await json('GET', `/api/v1/projects/${p.projectId}/test-data`)).toMatchObject({ count: theirs.length, stale: false, summary: { unreachable: 0 } });
  });

  it('exports as a project file and imports as a new draft with customers of its own', async () => {
    const file = await json('GET', `/api/v1/projects/${id}/export`);
    expect(file.documentType).toBe('custom');
    expect(JSON.stringify(file)).not.toMatch(/REC-6\d{4}/);
    const dry = await json('POST', '/api/v1/projects/import', { file, title: 'Imported gym notice', dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, wouldCreate: { title: 'Imported gym notice' }, report: { notImported: expect.arrayContaining(['Customers']) } });
    expect(dry.report.warnings.join(' ')).toMatch(/A project file never carries customers. New test customers are generated/);
    expect(dry.report.warnings.join(' ')).not.toMatch(/Synthetic customers here have no values/);
    expect((await json('GET', '/api/v1/projects')).projects.some((x: any) => x.title === 'Imported gym notice')).toBe(false);

    const r = await inj('POST', '/api/v1/projects/import', { file, title: 'Imported gym notice' });
    expect(r.statusCode).toBe(201);
    const p = r.json().project;
    expect(p).toMatchObject({ documentType: 'custom', modelVersion: 1, importedFrom: { projectId: id } });
    expect(r.json().customers).toBeGreaterThanOrEqual(8);
    const theirs = await customers(p.projectId);
    expect(theirs).toHaveLength(r.json().customers);
    expect(blocking(await json('POST', '/api/v1/resolve', { projectId: p.projectId, recordId: theirs[0].recordId }))).toEqual([]);
    // a file whose data fields are malformed, or of an unknown kind, is refused before anything is stored
    expect((await inj('POST', '/api/v1/projects/import', { file: { ...file, customFields: [{ key: 'sessions', label: 'Booked sessions', type: 'list', itemFields: 'oops' }] } })).json().error).toMatchObject({ code: 'INVALID_PROJECT_FILE' });
    expect((await inj('POST', '/api/v1/projects/import', { file: { ...file, documentType: 'invoice' } })).json().error).toMatchObject({ code: 'INVALID_PROJECT_FILE' });

    // a copy gets customers of its own too, and deleting a project takes its customers with it
    const copy = await inj('POST', `/api/v1/projects/${id}/duplicate`, { title: 'Gym notice copy' });
    expect(copy.statusCode).toBe(201);
    expect(copy.json().customers).toBeGreaterThanOrEqual(8);
    const copyId = copy.json().project.projectId;
    const copied = await customers(copyId);
    expect(copied.every((x) => x.projectId === copyId)).toBe(true);
    expect((await inj('DELETE', `/api/v1/projects/${copyId}`)).statusCode).toBe(200);
    expect((await inj('GET', `/api/v1/records/${copied[0].recordId}`)).statusCode).toBe(404);
  });

  it('batch runs, the Spanish document and the translator’s file work on its customers', async () => {
    const mine = await customers(id);
    const spanish = mine.find((r) => r.customer.locale === 'es-US')!;
    const pdf = await inj('POST', '/api/v1/compose/pdf', { projectId: id, recordId: spanish.recordId });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['x-draft']).toBe('0');
    expect((await json('POST', '/api/v1/compose/email', { projectId: id, recordId: spanish.recordId })).locale).toBe('es-US');

    const csv = await inj('GET', `/api/v1/projects/${id}/translations.csv?locale=es-US`);
    expect(csv.statusCode).toBe(200);
    expect(csv.payload).toContain('note-pro');
    expect(csv.payload).toContain('@sys/sectionDetails');
    expect(csv.payload).not.toContain('@sys/sectionTransactions');

    const pick = mine.slice(0, 2).map((r) => r.recordId);
    const start = await inj('POST', '/api/v1/batches', { projectId: id, recordIds: pick, outputs: ['pdf', 'html'] });
    expect(start.statusCode).toBe(202);
    let job: any;
    for (let i = 0; i < 120; i++) { job = (await json('GET', `/api/v1/batches/${start.json().batch.batchId}`)).batch; if (job.status !== 'running') break; await new Promise((r) => setTimeout(r, 250)); }
    expect(job).toMatchObject({ status: 'done', done: 2 });
    expect(job.items.map((x: any) => x.status)).toEqual(['ok', 'ok']);
    expect((await inj('POST', '/api/v1/batches', { projectId: id, recordIds: ['CARD-0001'] })).json().error.message).toBe('Not customers of this document: CARD-0001.');
  }, 120_000);

  it('the two sample projects are unaffected: no own-data customers there, and none of theirs here', async () => {
    const card = await customers('aster-card-demo', 'credit-statement');
    const eob = await customers('harborcare-demo', 'eob');
    expect(card).toHaveLength(70);
    expect(eob).toHaveLength(30);
    for (const list of [card, eob, (await json('GET', '/api/v1/records?full=1&projectId=aster-card-demo')).records, (await json('GET', '/api/v1/records?full=1')).records]) {
      expect(list.some((x: any) => x.documentType === 'custom' || /^REC-/.test(x.recordId))).toBe(false);
    }
    expect((await customers(id)).some((x) => x.documentType !== 'custom' || /^(CARD|EOB)-/.test(x.recordId))).toBe(false);
    expect(await customers('aster-card-demo', 'custom')).toEqual([]);
    // a sample customer cannot be used with a document that has its own data, and the other way round
    expect((await inj('POST', '/api/v1/resolve', { projectId: id, recordId: 'CARD-0001' })).json().error).toMatchObject({ code: 'RECORD_TYPE_MISMATCH' });
    const mine = await customers(id);
    expect((await inj('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: mine[0].recordId })).json().error).toMatchObject({ code: 'RECORD_OTHER_PROJECT' });
    // the samples resolve as ever, and their record import is still shared unless asked otherwise
    expect((await json('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: 'CARD-0001' })).result.documentFacts).toMatchObject({ newBalanceCents: 124800 });
    expect((await json('GET', '/api/v1/projects/aster-card-demo/schemas')).dimensions.map((d: any) => d.id)).toEqual(['persona', 'journey', 'output', 'language', 'paymentStatus', 'accountTier', 'channel']);
    const sample = (await json('GET', '/api/v1/records/CARD-0001')).record;
    const { recordId: _id, ...row } = sample;
    const shared = await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', projectId: 'aster-card-demo', format: 'json', data: [row] });
    expect(shared.scope).toBeUndefined();
    expect(shared.imported.map((x: any) => x.recordId)).toEqual(['CARD-5001']);
    expect((await customers('harborcare-demo', 'credit-statement')).some((x) => x.recordId === 'CARD-5001')).toBe(true);
    const own = await json('POST', '/api/v1/records/import', { documentType: 'credit-statement', projectId: 'aster-card-demo', scope: 'project', format: 'json', data: [row] });
    expect(own).toMatchObject({ scope: 'project', projectId: 'aster-card-demo' });
    expect(own.imported[0].recordId).toMatch(/^CARD-6\d{4}$/);
    expect((await customers('aster-card-demo', 'credit-statement')).some((x) => x.recordId === own.imported[0].recordId)).toBe(true);
    expect((await json('GET', '/api/v1/records?documentType=credit-statement&full=1')).records.some((x: any) => x.recordId === own.imported[0].recordId)).toBe(false);
    expect(await json('DELETE', '/api/v1/projects/aster-card-demo/records/supplied')).toEqual({ removed: 1 });
    expect(await json('DELETE', '/api/v1/projects/aster-card-demo/test-data')).toEqual({ removed: 0 });
  });
});
