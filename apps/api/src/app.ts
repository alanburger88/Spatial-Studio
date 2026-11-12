import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { canonicalJson, fieldsFor, projectContentDigest, validateRule, csvToRecords, prepareImport, IMPORT_LIMIT, SCHEMA_VERSION, type Project, type ProfileId, type SyntheticRecord } from '@iss/model';
import { RECORDS, PERSONAS, FIXTURE_SEED } from '@iss/model/fixtures';
import { resolve, ENGINE_VERSION, type Resolution } from '@iss/resolver';
import { renderPagedDocument, renderInteractiveHtml, compareManifests, afpSimulation, AFP_SIMULATION_LABEL, PAGED_RENDERER_VERSION, HTML_RENDERER_VERSION } from '@iss/renderers';
import { ScenarioEngine, buildCube, buildLandscape, generateEdgeCase, replayJourney, EDGE_CASE_PRESETS, DIMENSIONS, type DimensionId } from '@iss/scenarios';
import { staticRuleAnalysis, bindingAnalysis, modelAccessibility, axeToFindings, toIssue, type ValidationIssue, type Suite } from '@iss/validation';
import { Composer } from './composer';
import { Store } from './db';
import { handleMessage, providerConfig, providerStatus, type Proposal } from './assistant';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const ResolveBody = z.object({
  projectId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  recordId: z.string().regex(/^(CARD|EOB)-\d{4}$/),
  overrides: z.record(z.string(), z.any()).optional().default({}),
  outputContext: z.object({ profileId: z.enum(['paged-pdf', 'paged-afp-sim', 'html-responsive']).optional() }).optional().default({}),
  journeyCursor: z.number().int().min(0).max(50).nullable().optional().default(null),
  claimIndex: z.number().int().min(0).max(50).optional().default(0),
  project: z.any().optional(),
  allowDraft: z.boolean().optional(),
  includeTree: z.boolean().optional(),
});
type ResolveBodyT = z.infer<typeof ResolveBody>;

function checkDraftProject(p: any, projectId: string): Project {
  if (!p || typeof p !== 'object' || p.projectId !== projectId || !Array.isArray(p.nodes) || !Array.isArray(p.rules) || !Array.isArray(p.contentParts) || !Array.isArray(p.presentationProfiles)) throw new ApiError(400, 'INVALID_PROJECT', 'Draft project does not match the canonical project shape.');
  if (p.schemaVersion !== SCHEMA_VERSION) throw new ApiError(400, 'SCHEMA_VERSION', `Unsupported schemaVersion ${p.schemaVersion}.`);
  const ids = new Set<string>();
  for (const n of p.nodes) { if (typeof n.id !== 'string' || ids.has(n.id)) throw new ApiError(400, 'INVALID_PROJECT', `Duplicate or invalid node id ${n.id}.`); ids.add(n.id); }
  for (const r of p.rules) { const errs = validateRule(r, p); if (errs.length) throw new ApiError(422, 'INVALID_RULE', `${r.id}: ${errs.join(' ')}`, { ruleId: r.id }); }
  return p as Project;
}

export interface AppOptions { dataDir?: string; logger?: boolean }

export async function buildApp(opts: AppOptions = {}) {
  const store = new Store(opts.dataDir ?? process.env.DATA_DIR ?? path.resolve(here, '../../../.data'));
  const composer = new Composer();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(cors, { origin: (origin, cb) => cb(null, !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)), exposedHeaders: ['X-Run-Id', 'X-Artifact-Id', 'X-Page-Count', 'X-Pdf-Page-Count', 'X-Content-Digest', 'X-Sha256', 'X-Draft', 'Content-Disposition', 'X-Correlation-Id'] });
  app.addHook('onClose', async () => { await composer.close(); });

  app.setErrorHandler((err: any, req, reply) => {
    const correlationId = randomUUID();
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, correlationId, ...err.extra } });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), correlationId } });
    if (err.validation || err.statusCode === 400) return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: err.message, correlationId } });
    req.log.error({ correlationId, code: err.code, message: String(err.message).slice(0, 300) });
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected server error (details logged without content bodies).', correlationId } });
  });

  const projectOr404 = (id: string) => { const p = store.getProject(id); if (!p) throw new ApiError(404, 'NOT_FOUND', `Unknown project ${id}.`); return p; };
  /** Seeded synthetic fixtures plus any records the user imported locally. */
  const allRecords = (): SyntheticRecord[] => [...RECORDS, ...store.importedRecords()];
  const recordOr404 = (id: string) => { const r = allRecords().find((x) => x.recordId === id); if (!r) throw new ApiError(404, 'NOT_FOUND', `Unknown synthetic record ${id}.`); return r; };

  /** Resolve a request, persist it as an immutable run, and return the resolution + the exact request. */
  function runFor(body: ResolveBodyT): { res: Resolution; project: Project; request: ResolveBodyT } {
    const project = body.project ? checkDraftProject(body.project, body.projectId) : projectOr404(body.projectId);
    const record = recordOr404(body.recordId);
    if (record.documentType !== project.documentType) throw new ApiError(400, 'RECORD_TYPE_MISMATCH', `${record.recordId} is a ${record.documentType} record; ${project.projectId} expects ${project.documentType}.`);
    const res = resolve({ project, record, overrides: body.overrides, journeyCursor: body.journeyCursor, claimIndex: body.claimIndex, profileId: (body.outputContext?.profileId ?? 'paged-pdf') as ProfileId });
    store.saveRun(res.runId, project.projectId, record.recordId, { ...body, project }, { result: res.result, contentDigest: res.contentDigest, modelVersion: project.modelVersion, projectDigest: res.projectDigest, rulesDigest: res.rulesDigest, engine: ENGINE_VERSION });
    return { res, project, request: body };
  }

  function runFromBody(raw: unknown) {
    const b = raw as any;
    if (b && typeof b.runId === 'string') {
      const run = store.getRun(b.runId);
      if (!run) throw new ApiError(404, 'NOT_FOUND', `Unknown run ${b.runId}.`);
      const r = runFor(ResolveBody.parse({ ...run.request, allowDraft: b.allowDraft ?? run.request.allowDraft, outputContext: b.outputContext ?? run.request.outputContext }));
      if (r.res.runId !== b.runId && !b.outputContext) throw new ApiError(409, 'RUN_NOT_REPRODUCIBLE', 'Stored run no longer reproduces deterministically.');
      return r;
    }
    return runFor(ResolveBody.parse(raw));
  }

  const blocking = (res: Resolution) => res.findings.filter((f) => f.severity === 'blocking');

  function fileBase(project: Project, res: Resolution) {
    return `${project.projectId}-${res.recordId}-${res.runId.slice(4, 12)}`.toLowerCase();
  }

  async function composePdf(res: Resolution, project: Project, draft: boolean) {
    const html = renderPagedDocument(res, project, { profileId: 'paged-pdf', watermark: draft ? 'DRAFT — BLOCKING ISSUES' : '' });
    const comp = await composer.composePaged(html, { pdf: true });
    const art = store.saveArtifact(res.runId, 'pdf', `${fileBase(project, res)}.pdf`, comp.pdf!, { contentDigest: res.contentDigest, metrics: comp.metrics, extracted: { ...comp.extracted, text: undefined }, draft, renderer: PAGED_RENDERER_VERSION }, comp.metrics.pageCount);
    return { comp, art };
  }

  async function composeHtml(res: Resolution, project: Project) {
    const html = renderInteractiveHtml(res, project);
    const inspected = await composer.inspectHtml(html);
    const art = store.saveArtifact(res.runId, 'html', `${fileBase(project, res)}.html`, Buffer.from(html, 'utf8'), { contentDigest: res.contentDigest, extracted: { ...inspected.extracted, text: undefined }, interactive: inspected.interactive, renderer: HTML_RENDERER_VERSION });
    return { html, inspected, art };
  }

  /* ----------------------------------------------------------- routes */

  app.get('/api/v1/health', async () => ({ status: 'ok', schemaVersion: SCHEMA_VERSION, engine: ENGINE_VERSION, renderers: [PAGED_RENDERER_VERSION, HTML_RENDERER_VERSION], ai: providerStatus(providerConfig()), syntheticOnly: true }));

  app.get('/api/v1/projects', async () => ({ projects: store.listProjects() }));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', async (req) => ({ project: projectOr404(req.params.projectId) }));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/export', async (req, reply) => {
    const p = projectOr404(req.params.projectId);
    reply.header('Content-Disposition', `attachment; filename="${p.projectId}-v${p.modelVersion}.json"`);
    return p;
  });
  app.put<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId', async (req, reply) => {
    const current = projectOr404(req.params.projectId);
    const ifMatch = req.headers['if-match'];
    const expected = Number(String(ifMatch ?? '').replace(/"/g, ''));
    if (!ifMatch || !Number.isInteger(expected)) throw new ApiError(428, 'PRECONDITION_REQUIRED', 'Save requires If-Match with the project model version you loaded.');
    if (expected !== current.modelVersion) throw new ApiError(409, 'VERSION_CONFLICT', `Project is at version ${current.modelVersion}; you edited version ${expected}.`, { currentVersion: current.modelVersion });
    const incoming = checkDraftProject((req.body as any)?.project ?? req.body, req.params.projectId);
    if (incoming.modelVersion <= current.modelVersion && projectContentDigest(incoming) !== projectContentDigest(current)) incoming.modelVersion = current.modelVersion + 1;
    const saved = store.putProject(incoming);
    reply.header('ETag', `"${saved.modelVersion}"`);
    return { project: saved, saved: true, contentDigest: projectContentDigest(saved) };
  });
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/reset', async (req) => {
    const current = projectOr404(req.params.projectId);
    if ((req.body as any)?.confirm !== true) throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Reset requires {"confirm": true}.');
    const seed = store.seedFor(req.params.projectId);
    if (!seed) throw new ApiError(400, 'NOT_A_SAMPLE', 'Only approved sample projects can be restored.');
    const reset = store.putProject({ ...seed, modelVersion: current.modelVersion + 1 }, projectContentDigest(seed));
    if ((req.body as any)?.clearSnapshots !== false) store.clearSnapshots(req.params.projectId);
    return { project: reset, reset: true, seedDigest: projectContentDigest(seed) };
  });
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  const cleanTitle = (t: unknown) => { const s = typeof t === 'string' ? t.trim().replace(/\s+/g, ' ') : ''; if (s.length < 2 || s.length > 80) throw new ApiError(400, 'INVALID_TITLE', 'Title must be 2–80 characters.'); return s; };
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/duplicate', async (req, reply) => {
    const src = projectOr404(req.params.projectId);
    const title = cleanTitle((req.body as any)?.title ?? `${src.title} (copy)`);
    let id = slug(title); if (id.length < 3) id = `${id}-copy`;
    for (let i = 2; store.getProject(id); i++) id = `${slug(title).slice(0, 36)}-${i}`;
    const { lastSavedAt: _l, ...rest } = src as Project & { lastSavedAt?: string };
    const copy = { ...rest, projectId: id, title, modelVersion: 1, derivedFrom: { projectId: src.projectId, modelVersion: src.modelVersion } } as Project;
    const saved = store.putProject(copy, projectContentDigest(copy));
    reply.status(201);
    return { project: saved, duplicatedFrom: src.projectId };
  });
  app.patch<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId', async (req) => {
    const current = projectOr404(req.params.projectId);
    const title = cleanTitle((req.body as any)?.title);
    const saved = store.putProject({ ...current, title, modelVersion: current.modelVersion + 1 });
    return { project: saved, renamed: true };
  });
  app.delete<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', async (req) => {
    projectOr404(req.params.projectId);
    if (store.isSample(req.params.projectId)) throw new ApiError(400, 'SAMPLE_PROJECT', 'Approved sample projects cannot be deleted; use Restore approved sample instead.');
    store.deleteProject(req.params.projectId);
    return { deleted: true, projectId: req.params.projectId };
  });

  /* Imported scenario records: validated against the typed data contract; stored locally only. */
  app.post<{ Body: Record<string, any> }>('/api/v1/records/import', async (req) => {
    const b = (req.body ?? {}) as { documentType?: string; format?: string; data?: unknown; dryRun?: boolean };
    if (b.documentType !== 'credit-statement' && b.documentType !== 'eob') throw new ApiError(400, 'INVALID_REQUEST', 'documentType must be credit-statement or eob.');
    const documentType = b.documentType;
    let items: unknown[];
    if (b.format === 'csv') {
      if (typeof b.data !== 'string') throw new ApiError(400, 'INVALID_REQUEST', 'CSV import expects data as text.');
      const parsed = csvToRecords(b.data, documentType);
      if (parsed.headerErrors.length) throw new ApiError(422, 'INVALID_CSV_HEADER', parsed.headerErrors.join(' '), { errors: parsed.headerErrors });
      items = parsed.records;
    } else {
      let data = b.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { throw new ApiError(400, 'INVALID_JSON', 'The file is not valid JSON.'); } }
      items = Array.isArray(data) ? data : Array.isArray((data as any)?.records) ? (data as any).records : [data];
    }
    if (!items.length) throw new ApiError(400, 'EMPTY_IMPORT', 'No records found in the file.');
    if (items.length > IMPORT_LIMIT) throw new ApiError(413, 'IMPORT_TOO_LARGE', `At most ${IMPORT_LIMIT} records per import.`);
    const rows = prepareImport(items, documentType, store.nextImportNumber(documentType));
    const ok = rows.filter((r) => r.record).map((r) => r.record!);
    if (!b.dryRun && ok.length) store.addImportedRecords(ok);
    return { documentType, dryRun: !!b.dryRun, imported: ok.map((r) => ({ recordId: r.recordId, sourceId: r.sourceId ?? null, name: `${r.customer.givenName} ${r.customer.familyName}` })), rejected: rows.filter((r) => !r.record).map(({ row, sourceId, errors }) => ({ row, sourceId, errors })), total: items.length };
  });
  app.delete<{ Querystring: { documentType?: string } }>('/api/v1/records/imported', async (req) => ({ removed: store.clearImportedRecords(req.query.documentType) }));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/schemas', async (req) => {
    const p = projectOr404(req.params.projectId);
    return { documentType: p.documentType, fields: fieldsFor(p.documentType), dimensions: DIMENSIONS.filter((d) => d.documentTypes.includes(p.documentType)), edgeCasePresets: EDGE_CASE_PRESETS.filter((e) => e.documentType === p.documentType) };
  });

  app.get<{ Querystring: { documentType?: string; full?: string } }>('/api/v1/records', async (req) => {
    const recs = allRecords().filter((r) => !req.query.documentType || r.documentType === req.query.documentType);
    if (req.query.full === '1') return { seed: FIXTURE_SEED, syntheticOnly: true, records: recs };
    return { seed: FIXTURE_SEED, syntheticOnly: true, records: recs.map((r) => ({ recordId: r.recordId, documentType: r.documentType, personaId: r.personaId ?? null, name: `${r.customer.givenName} ${r.customer.familyName}`, locale: r.customer.locale, status: (r.card as any)?.paymentStatus ?? (r.claims?.[0] as any)?.status, synthetic: !r.imported, imported: !!r.imported })) };
  });
  app.get<{ Params: { recordId: string } }>('/api/v1/records/:recordId', async (req) => ({ record: recordOr404(req.params.recordId), synthetic: true }));
  app.get('/api/v1/personas', async () => ({ personas: PERSONAS }));

  app.post('/api/v1/resolve', async (req) => {
    const { res, project } = runFor(ResolveBody.parse(req.body));
    const body = req.body as any;
    return { runId: res.runId, result: res.result, trace: res.trace, findings: res.findings, semanticManifest: res.semanticManifest, contentDigest: res.contentDigest, projectDigest: res.projectDigest, rulesDigest: res.rulesDigest, modelVersion: project.modelVersion, engineVersion: res.engineVersion, hints: res.hints, locale: res.locale, journeySteps: res.journeySteps, ...(body?.includeTree ? { tree: res.root } : {}) };
  });

  app.post('/api/v1/compose/pdf', async (req, reply: FastifyReply) => {
    const { res, project, request } = runFromBody(req.body);
    const draft = blocking(res).length > 0;
    if (draft && !request.allowDraft) throw new ApiError(422, 'BLOCKING_DIAGNOSTICS', `Export blocked: ${blocking(res).length} blocking issue(s). Fix them or request a watermarked draft.`, { runId: res.runId, issues: blocking(res) });
    const { comp, art } = await composePdf(res, project, draft);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${art.filename}"`)
      .header('X-Run-Id', res.runId).header('X-Artifact-Id', art.artifactId).header('X-Page-Count', String(comp.metrics.pageCount)).header('X-Pdf-Page-Count', String(comp.metrics.pdfPageCount)).header('X-Content-Digest', res.contentDigest).header('X-Sha256', art.sha256).header('X-Draft', draft ? '1' : '0');
    return reply.send(comp.pdf);
  });

  app.post('/api/v1/compose/html', async (req, reply) => {
    const { res, project, request } = runFromBody(req.body);
    if (blocking(res).length && !request.allowDraft) throw new ApiError(422, 'BLOCKING_DIAGNOSTICS', `Export blocked: ${blocking(res).length} blocking issue(s).`, { runId: res.runId, issues: blocking(res) });
    const { html, art } = await composeHtml(res, project);
    reply.header('Content-Type', 'text/html; charset=utf-8').header('Content-Disposition', `attachment; filename="${art.filename}"`).header('X-Run-Id', res.runId).header('X-Artifact-Id', art.artifactId).header('X-Content-Digest', res.contentDigest).header('X-Sha256', art.sha256);
    return reply.send(html);
  });

  app.post('/api/v1/compose/pages', async (req) => {
    const { res, project } = runFromBody(req.body);
    const body = req.body as any;
    const html = renderPagedDocument(res, project, { profileId: body?.outputContext?.profileId === 'paged-afp-sim' ? 'paged-afp-sim' : 'paged-pdf', watermark: body?.outputContext?.profileId === 'paged-afp-sim' ? 'AFP SIMULATION — NOT AN AFP STREAM' : '' });
    const comp = await composer.composePaged(html, { snapshot: true, pdf: body?.verifyPdf === true });
    return { runId: res.runId, recordId: res.recordId, modelVersion: project.modelVersion, contentDigest: res.contentDigest, engine: comp.metrics.engine, pageCount: comp.metrics.pageCount, pdfPageCount: comp.metrics.pdfPageCount ?? null, durationMs: comp.metrics.durationMs, pages: comp.metrics.pages, diagnostics: comp.metrics.diagnostics, snapshot: comp.snapshot, extracted: { ...comp.extracted, text: undefined }, findings: res.findings, transactionCount: res.result.documentFacts.transactionCount ?? null };
  });

  app.post('/api/v1/compose/afp-sim', async (req, reply) => {
    const { res, project } = runFromBody(req.body);
    const comp = await composer.composePaged(renderPagedDocument(res, project, { profileId: 'paged-afp-sim' }));
    const sim = afpSimulation(res, project, comp.metrics);
    store.saveArtifact(res.runId, 'afp-sim', `${fileBase(project, res)}-afp-simulation.json`, Buffer.from(JSON.stringify(sim, null, 2)), { simulationOnly: true, label: AFP_SIMULATION_LABEL }, comp.metrics.pageCount);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return sim;
  });

  app.post('/api/v1/parity', async (req) => {
    const { res, project } = runFromBody({ ...(req.body as any), allowDraft: true });
    const draft = blocking(res).length > 0;
    const [pdf, html] = [await composePdf(res, project, draft), await composeHtml(res, project)];
    const report = compareManifests(res.semanticManifest, pdf.comp.extracted, html.inspected.extracted);
    const textChecks = { pdfContainsNewBalance: res.semanticManifest.money['billing-summary'] === undefined || /\$[\d,]+\.\d{2}/.test(pdf.comp.extracted.text ?? '') };
    return { runId: res.runId, contentDigest: res.contentDigest, draft, report, pdf: { artifactId: pdf.art.artifactId, pageCount: pdf.comp.metrics.pageCount, pdfPageCount: pdf.comp.metrics.pdfPageCount, sha256: pdf.art.sha256 }, html: { artifactId: html.art.artifactId, sha256: html.art.sha256, interactive: html.inspected.interactive }, textChecks, expected: res.semanticManifest };
  });

  app.post('/api/v1/validate', async (req) => {
    const body = req.body as any;
    const suites: Suite[] = Array.isArray(body?.suites) && body.suites.length ? body.suites : ['rules', 'bindings', 'pagination', 'parity', 'accessibility'];
    const { res, project, request } = runFromBody({ ...body, allowDraft: true });
    const repro = { recordId: res.recordId, overrides: request.overrides, journeyCursor: request.journeyCursor };
    const issues: ValidationIssue[] = [];
    const suiteStatus: Record<string, { status: 'clean' | 'warnings' | 'errors' | 'not-run'; count: number; durationMs: number }> = {};
    const t = () => Date.now();
    for (const s of ['rules', 'bindings', 'pagination', 'parity', 'accessibility'] as Suite[]) suiteStatus[s] = { status: 'not-run', count: 0, durationMs: 0 };
    const add = (suite: Suite, list: ValidationIssue[], t0: number) => {
      issues.push(...list);
      const sev = list.filter((i) => i.severity !== 'info');
      suiteStatus[suite] = { status: sev.some((i) => i.severity === 'blocking' || i.severity === 'error') ? 'errors' : sev.length ? 'warnings' : 'clean', count: list.length, durationMs: Date.now() - t0 };
    };
    if (suites.includes('rules')) { const t0 = t(); add('rules', [...res.findings.filter((f) => f.source === 'resolver' || f.source === 'domain'), ...staticRuleAnalysis(project, allRecords())].map((f) => toIssue(f, 'rules', { runId: res.runId, reproduction: repro })), t0); }
    if (suites.includes('bindings')) {
      const t0 = t();
      const seen = new Set<string>();
      const list = [...res.findings.filter((f) => f.source === 'binding'), ...bindingAnalysis(project)].filter((f) => { const k = `${f.code}|${f.nodeId}|${f.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
      add('bindings', list.map((f) => toIssue(f, 'bindings', { runId: res.runId, reproduction: repro })), t0);
    }
    let pageCount: number | null = null;
    if (suites.includes('pagination')) {
      const t0 = t();
      const comp = await composer.composePaged(renderPagedDocument(res, project));
      pageCount = comp.metrics.pageCount;
      add('pagination', comp.metrics.diagnostics.map((d: any) => toIssue({ code: d.code, severity: d.severity, nodeId: d.nodeId, page: d.page, message: d.message, source: 'composer', details: { rowsPlaced: d.rowsPlaced, rowsClipped: d.rowsClipped } }, 'pagination', { runId: res.runId, reproduction: repro })), t0);
    }
    let parity: ReturnType<typeof compareManifests> | null = null;
    let a11yHtml: string | null = null;
    if (suites.includes('parity') || suites.includes('accessibility')) a11yHtml = renderInteractiveHtml(res, project);
    if (suites.includes('parity')) {
      const t0 = t();
      const comp = await composer.composePaged(renderPagedDocument(res, project));
      const h = await composer.inspectHtml(a11yHtml!);
      parity = compareManifests(res.semanticManifest, comp.extracted, h.extracted);
      add('parity', parity.checks.filter((c) => c.status === 'mismatch').map((c) => toIssue({ code: 'PARITY_MISMATCH', severity: c.blocking ? 'blocking' : 'warning', source: 'parity', message: `${c.label}: PDF and/or HTML differ from the resolved semantic facts.`, details: { check: c.id, expected: c.expected, pdf: c.pdf, html: c.html } }, 'parity', { runId: res.runId, reproduction: repro })), t0);
    }
    if (suites.includes('accessibility')) {
      const t0 = t();
      const axe = await runAxe(composer, a11yHtml!);
      add('accessibility', [...modelAccessibility(project, res), ...axeToFindings(axe)].map((f) => toIssue(f, 'accessibility', { runId: res.runId })), t0);
    }
    const counts = { blocking: 0, error: 0, warning: 0, info: 0 } as Record<string, number>;
    issues.forEach((i) => (counts[i.severity] = (counts[i.severity] ?? 0) + 1));
    return { runId: res.runId, modelVersion: project.modelVersion, contentDigest: res.contentDigest, suites: suiteStatus, counts, issues, parity, pageCount, note: 'Automated checks are necessary but not sufficient; this is not WCAG or regulatory certification.' };
  });

  app.post('/api/v1/journeys/replay', async (req) => {
    const b = req.body as any;
    const project = b?.project ? checkDraftProject(b.project, b.projectId) : projectOr404(String(b?.projectId));
    const record = recordOr404(String(b?.recordId));
    const overrides = b?.overrides ?? {};
    const snaps = replayJourney(project, record, overrides);
    const issued = [];
    for (const s of snaps.filter((x) => x.kind === 'issued')) {
      const res = resolve({ project, record, overrides, journeyCursor: s.cursor });
      const canonical = canonicalJson({ manifest: res.semanticManifest, html: renderInteractiveHtml(res, project) });
      const stored = store.issueSnapshot(project.projectId, record.recordId, s.eventId!, res.runId, res.contentDigest, canonical);
      issued.push({ ...stored, currentPreviewDigest: res.contentDigest, unchangedByLaterEvents: true, currentModelWouldDiffer: stored.contentDigest !== res.contentDigest });
    }
    const cursor = typeof b?.journeyCursor === 'number' ? b.journeyCursor : snaps.length - 2;
    const preview = snaps.find((s) => s.cursor === cursor) ?? snaps[snaps.length - 1];
    return { snapshots: snaps, issued, preview, policy: project.journey.snapshotPolicy };
  });
  app.get<{ Querystring: { projectId: string; recordId?: string } }>('/api/v1/snapshots', async (req) => ({ snapshots: store.listSnapshots(req.query.projectId, req.query.recordId) }));
  app.post('/api/v1/snapshots/reset', async (req) => { const b = req.body as any; if (b?.confirm !== true) throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Requires {"confirm": true}.'); store.clearSnapshots(String(b.projectId)); return { cleared: true }; });

  app.post('/api/v1/scenarios/generate', async (req) => {
    const b = req.body as any;
    const record = recordOr404(String(b?.recordId));
    try { return { syntheticOnly: true, ...generateEdgeCase(record, String(b?.preset), b?.seed ? String(b.seed) : undefined) }; }
    catch (e: any) { throw new ApiError(400, 'INVALID_PRESET', e.message); }
  });

  app.post('/api/v1/analysis/cube', async (req) => {
    const b = req.body as any;
    const project = b?.project ? checkDraftProject(b.project, b.projectId) : projectOr404(String(b?.projectId));
    const cube = buildCube(new ScenarioEngine(project, allRecords()), (b?.axes ?? ['persona', 'output', 'journey']) as [DimensionId, DimensionId, DimensionId], { offsets: b?.offsets, filters: b?.filters });
    if (cube.errors.length) throw new ApiError(400, 'INVALID_AXES', cube.errors.join(' '));
    return cube;
  });
  app.post('/api/v1/analysis/landscape', async (req) => {
    const b = req.body as any;
    const project = b?.project ? checkDraftProject(b.project, b.projectId) : projectOr404(String(b?.projectId));
    return buildLandscape(new ScenarioEngine(project, allRecords()), { includeJourney: !!b?.includeJourney, filters: b?.filters });
  });

  app.get<{ Params: { artifactId: string } }>('/api/v1/artifacts/:artifactId', async (req, reply) => {
    const a = store.getArtifact(req.params.artifactId);
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'Unknown artifact.');
    const type = a.kind === 'pdf' ? 'application/pdf' : a.kind === 'html' ? 'text/html; charset=utf-8' : 'application/json';
    reply.header('Content-Type', type).header('Content-Disposition', `${(req.query as any)?.inline ? 'inline' : 'attachment'}; filename="${a.filename}"`).header('X-Sha256', a.sha256).header('X-Run-Id', a.run_id);
    return reply.send(a.bytes);
  });
  app.get<{ Querystring: { runId?: string; projectId?: string } }>('/api/v1/artifacts', async (req) => ({ artifacts: store.listArtifacts({ runId: req.query.runId, projectId: req.query.projectId }) }));

  app.get('/api/v1/assistant/status', async () => providerStatus(providerConfig()));
  app.post('/api/v1/assistant/message', async (req) => {
    const b = req.body as any;
    if (typeof b?.message !== 'string' || !b.message.trim() || b.message.length > 2000) throw new ApiError(400, 'INVALID_MESSAGE', 'Message must be 1–2000 characters.');
    const ctx = b.context ?? {};
    const project = b.project ? checkDraftProject(b.project, String(ctx.projectId)) : projectOr404(String(ctx.projectId));
    const recordId = String(ctx.recordId ?? (project.documentType === 'eob' ? 'EOB-0001' : 'CARD-0001'));
    recordOr404(recordId);
    const cfg = providerConfig();
    if (b.forceOffline === true) cfg.provider = 'offline';
    const reply = await handleMessage(b.message, { project, records: allRecords(), recordId, overrides: ctx.overrides ?? {}, journeyCursor: ctx.journeyCursor ?? null, selectedNodeId: ctx.selectedNodeId ?? null }, cfg);
    if (reply.proposal) store.saveProposal(reply.proposal.proposalId, reply.proposal);
    return reply;
  });
  app.post<{ Params: { id: string } }>('/api/v1/assistant/proposals/:id/decision', async (req) => {
    const b = req.body as any;
    const found = store.getProposal(req.params.id);
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'Unknown proposal.');
    if (found.status !== 'pending') throw new ApiError(409, 'ALREADY_DECIDED', `Proposal already ${found.status}.`);
    const approved = b?.approved === true;
    store.decideProposal(req.params.id, approved ? 'approved' : 'declined');
    const proposal = found.proposal as Proposal;
    return { proposalId: req.params.id, approved, mutationApplied: false, modelVersion: Number(b?.modelVersion ?? proposal.baseModelVersion), command: approved ? proposal.command : null, provenance: approved ? 'Assistant suggestion; evaluated by deterministic engine; approved by user.' : 'Declined by user; no change made.' };
  });

  return { app, store, composer };
}

async function runAxe(composer: Composer, html: string) {
  const axePath = require.resolve('axe-core/axe.min.js');
  const browser = await composer.getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.addScriptTag({ path: axePath });
    const result = await page.evaluate(async () => {
      const r = await (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
      return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n: any) => { const el = document.querySelector(n.target[0]); return { target: n.target, nodeId: el?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null }; }) }));
    });
    return result;
  } finally { await ctx.close(); }
}
