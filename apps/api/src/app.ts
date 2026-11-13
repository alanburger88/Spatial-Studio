import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { canonicalJson, customFieldDefs, fieldsFor, projectFields, projectContentDigest, validateRule, validateCustomFields, isDocumentType, csvToRecords, prepareImport, IMPORT_ID_BASE, IMPORT_LIMIT, RECORD_ID_PREFIX, SCHEMA_VERSION, RECORD_ID_PATTERN, DOCUMENT_TYPE_LABEL, type DocumentType, type Project, type ProfileId, type SyntheticRecord } from '@iss/model';
import { diffProjects, sanitizeCommentBody, transitionProblem, roleCan, COMMENT_MAX, WORKFLOW_ACTIONS, WORKFLOW_LABEL, WORKFLOW_TRANSITIONS, ACTION_LABEL, type WorkflowAction } from '@iss/model';
import { RECORDS, PERSONAS, FIXTURE_SEED } from '@iss/model/fixtures';
import { resolve, ENGINE_VERSION, type Resolution } from '@iss/resolver';
import { renderPagedDocument, renderInteractiveHtml, compareManifests, afpSimulation, AFP_SIMULATION_LABEL, PAGED_RENDERER_VERSION, HTML_RENDERER_VERSION } from '@iss/renderers';
import { ScenarioEngine, buildCube, buildLandscape, generateEdgeCase, replayJourney, runTestCases, EDGE_CASE_PRESETS, DIMENSIONS, type DimensionId } from '@iss/scenarios';
import { staticRuleAnalysis, bindingAnalysis, modelAccessibility, axeToFindings, toIssue, type ValidationIssue, type Suite } from '@iss/validation';
import { Composer } from './composer';
import { Store } from './db';
import { BatchRunner, BATCH_LIMIT, type BatchOutput } from './batch';
import { registerTemplateRoutes } from './routes/templates';
import { registerChannelRoutes } from './routes/channels';
import { registerTranslationRoutes } from './routes/translations';
import { registerAssistRoutes } from './routes/assist';
import { registerTestDataRoutes } from './routes/testData';
import { registerRecordRoutes } from './routes/records';
import { registerSetupRoutes } from './routes/setup';
import type { RouteDeps } from './routes/deps';
import { handleMessage, providerConfig, providerStatus, type Proposal } from './assistant';
import { registerAuth, audit } from './auth';
import { firstCustomers } from './projectCustomers';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

const ResolveBody = z.object({
  projectId: z.string().regex(/^[a-z0-9-]{3,64}$/),
  recordId: z.string().regex(RECORD_ID_PATTERN),
  overrides: z.record(z.string(), z.any()).optional().default({}),
  outputContext: z.object({ profileId: z.enum(['paged-pdf', 'paged-afp-sim', 'html-responsive']).optional() }).optional().default({}),
  journeyCursor: z.number().int().min(0).max(50).nullable().optional().default(null),
  claimIndex: z.number().int().min(0).max(50).optional().default(0),
  project: z.any().optional(),
  allowDraft: z.boolean().optional(),
  /** Previews only, and only honoured together with allowDraft: also show unapproved translation drafts. */
  includeDrafts: z.boolean().optional(),
  includeTree: z.boolean().optional(),
});
type ResolveBodyT = z.infer<typeof ResolveBody>;

function checkDraftProject(p: any, projectId: string): Project {
  if (!p || typeof p !== 'object' || p.projectId !== projectId || !Array.isArray(p.nodes) || !Array.isArray(p.rules) || !Array.isArray(p.contentParts) || !Array.isArray(p.presentationProfiles)) throw new ApiError(400, 'INVALID_PROJECT', 'Draft project does not match the canonical project shape.');
  if (p.schemaVersion !== SCHEMA_VERSION) throw new ApiError(400, 'SCHEMA_VERSION', `Unsupported schemaVersion ${p.schemaVersion}.`);
  if (!isDocumentType(p.documentType)) throw new ApiError(400, 'INVALID_PROJECT', `Unknown kind of document ${String(p.documentType)}.`);
  // The project's own data fields define what its rules, bindings and customer records may use, so a malformed list never gets stored.
  if (p.customFields !== undefined) {
    if (!Array.isArray(p.customFields) || p.customFields.some((f: unknown) => !f || typeof f !== 'object' || Array.isArray(f))) throw new ApiError(400, 'INVALID_PROJECT', 'The project’s data fields cannot be read.');
    const errs = validateCustomFields(p.documentType, p.customFields);
    if (errs.length) throw new ApiError(422, 'INVALID_FIELDS', errs.join(' '));
  }
  const ids = new Set<string>();
  for (const n of p.nodes) { if (typeof n.id !== 'string' || ids.has(n.id)) throw new ApiError(400, 'INVALID_PROJECT', `Duplicate or invalid node id ${n.id}.`); ids.add(n.id); }
  for (const r of p.rules) { const errs = validateRule(r, p); if (errs.length) throw new ApiError(422, 'INVALID_RULE', `${r.id}: ${errs.join(' ')}`, { ruleId: r.id }); }
  return p as Project;
}

export interface AppOptions { dataDir?: string; logger?: boolean; /** Overrides env AUTH=on (tests). */ auth?: boolean; /** Replaces the AI translation call (tests). */ translator?: import('./translate').Translator; /** Replaces the assistant's model call (tests). */ assistModel?: import('./assistAi').AssistModel }

export async function buildApp(opts: AppOptions = {}) {
  const store = new Store(opts.dataDir ?? process.env.DATA_DIR ?? path.resolve(here, '../../../.data'));
  const composer = new Composer();
  const batches = new BatchRunner(composer, path.join(opts.dataDir ?? process.env.DATA_DIR ?? path.resolve(here, '../../../.data'), 'batches'));
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

  /* Accounts, sessions, role checks and the audit trail (auth is off unless AUTH=on; see auth.ts). */
  const authEnabled = opts.auth ?? process.env.AUTH === 'on';
  registerAuth(app, { store, ApiError, enabled: authEnabled });
  const by = (req: FastifyRequest) => (req.user ? { id: req.user.id, name: req.user.name } : null);

  const projectOr404 = (id: string) => { const p = store.getProject(id); if (!p) throw new ApiError(404, 'NOT_FOUND', `Unknown project ${id}.`); return p; };
  /** Seeded synthetic fixtures plus any records the user imported locally. */
  /** Seeded fixtures and imported records (shared by every project), plus, when a project is named, the records that belong to it alone. */
  const allRecords = (projectId?: string): SyntheticRecord[] => [...RECORDS, ...store.importedRecords(), ...(projectId ? store.projectRecords(projectId) : [])];
  const recordOr404 = (id: string) => { const r = allRecords().find((x) => x.recordId === id) ?? store.projectRecord(id); if (!r) throw new ApiError(404, 'NOT_FOUND', `Unknown synthetic record ${id}.`); return r; };

  /** Resolve a request, persist it as an immutable run, and return the resolution + the exact request. */
  function runFor(body: ResolveBodyT): { res: Resolution; project: Project; request: ResolveBodyT } {
    const project = body.project ? checkDraftProject(body.project, body.projectId) : projectOr404(body.projectId);
    const record = recordOr404(body.recordId);
    if (record.projectId && record.projectId !== project.projectId) throw new ApiError(400, 'RECORD_OTHER_PROJECT', `${record.recordId} is a test customer of another project.`);
    if (record.documentType !== project.documentType) throw new ApiError(400, 'RECORD_TYPE_MISMATCH', `${record.recordId} is a ${record.documentType} record; ${project.projectId} expects ${project.documentType}.`);
    const res = resolve({ project, record, overrides: body.overrides, journeyCursor: body.journeyCursor, claimIndex: body.claimIndex, profileId: (body.outputContext?.profileId ?? 'paged-pdf') as ProfileId, includeDrafts: body.includeDrafts === true && body.allowDraft === true });
    store.saveRun(res.runId, project.projectId, record.recordId, { ...body, project }, { result: res.result, contentDigest: res.contentDigest, modelVersion: project.modelVersion, projectDigest: res.projectDigest, rulesDigest: res.rulesDigest, engine: ENGINE_VERSION });
    return { res, project, request: body };
  }

  function runFromBody(raw: unknown) {
    const b = raw as any;
    if (b && typeof b.runId === 'string') {
      const run = store.getRun(b.runId);
      if (!run) throw new ApiError(404, 'NOT_FOUND', `Unknown run ${b.runId}.`);
      const r = runFor(ResolveBody.parse({ ...run.request, allowDraft: b.allowDraft ?? run.request.allowDraft, includeDrafts: b.includeDrafts ?? run.request.includeDrafts, outputContext: b.outputContext ?? run.request.outputContext }));
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
    const html = renderPagedDocument(res, project, { profileId: 'paged-pdf', watermark: res.translation.draftsShown.length ? 'DRAFT — UNAPPROVED TRANSLATIONS' : draft ? 'DRAFT — BLOCKING ISSUES' : '' });
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
    // The kind decides which customers a document has (a document with its own data has only its own), so it is fixed at creation.
    if ((incoming.documentType === 'custom') !== (current.documentType === 'custom')) throw new ApiError(400, 'DOCUMENT_TYPE_FIXED', 'The kind of document cannot be changed after it is created. Start a new project instead.');
    if (incoming.modelVersion <= current.modelVersion && projectContentDigest(incoming) !== projectContentDigest(current)) incoming.modelVersion = current.modelVersion + 1;
    const wasState = store.getWorkflow(current.projectId).state;
    const saved = store.putProject(incoming, undefined, { by: by(req) });
    const changes = diffProjects(current, saved).summary.counts;
    const workflow = store.getWorkflow(saved.projectId);
    audit(store, req, 'project.save', { projectId: saved.projectId, modelVersion: saved.modelVersion, detail: { fromVersion: current.modelVersion, toVersion: saved.modelVersion, contentDigest: projectContentDigest(saved), changes, ...(workflow.state !== wasState ? { workflow: { from: wasState, to: workflow.state } } : {}) } });
    reply.header('ETag', `"${saved.modelVersion}"`);
    return { project: saved, saved: true, contentDigest: projectContentDigest(saved), workflow: { state: workflow.state, previous: wasState } };
  });
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/reset', async (req) => {
    const current = projectOr404(req.params.projectId);
    if ((req.body as any)?.confirm !== true) throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Reset requires {"confirm": true}.');
    const seed = store.seedFor(req.params.projectId);
    if (!seed) throw new ApiError(400, 'NOT_A_SAMPLE', 'Only approved sample projects can be restored.');
    // Restoring a sample that is already identical to the approved seed is a no-op: no new version, no audit noise.
    if (projectContentDigest(current) === projectContentDigest(seed)) {
      if ((req.body as any)?.clearSnapshots !== false) store.clearSnapshots(req.params.projectId);
      req.audited = true;
      return { project: current, reset: true, unchanged: true, seedDigest: projectContentDigest(seed) };
    }
    const reset = store.putProject({ ...seed, modelVersion: current.modelVersion + 1 }, projectContentDigest(seed), { by: by(req), label: 'Restored approved sample' });
    if ((req.body as any)?.clearSnapshots !== false) store.clearSnapshots(req.params.projectId);
    audit(store, req, 'project.reset', { projectId: reset.projectId, modelVersion: reset.modelVersion, detail: { fromVersion: current.modelVersion, seedDigest: projectContentDigest(seed) } });
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
    const saved = store.putProject(copy, projectContentDigest(copy), { by: by(req), label: `Duplicated from “${src.title}” v${src.modelVersion}` });
    // A copy of a document with its own data starts with customers of its own (the original's customers stay with the original).
    const customers = firstCustomers(store, saved);
    audit(store, req, 'project.duplicate', { projectId: saved.projectId, modelVersion: saved.modelVersion, detail: { from: src.projectId, fromVersion: src.modelVersion, title, ...(saved.documentType === 'custom' ? { customers } : {}) } });
    reply.status(201);
    return { project: saved, duplicatedFrom: src.projectId, ...(saved.documentType === 'custom' ? { customers } : {}) };
  });
  app.patch<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId', async (req) => {
    const current = projectOr404(req.params.projectId);
    const title = cleanTitle((req.body as any)?.title);
    const saved = store.putProject({ ...current, title, modelVersion: current.modelVersion + 1 }, undefined, { by: by(req), label: `Renamed to “${title}”` });
    audit(store, req, 'project.rename', { projectId: saved.projectId, modelVersion: saved.modelVersion, detail: { from: current.title, to: title } });
    return { project: saved, renamed: true };
  });
  app.delete<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', async (req) => {
    projectOr404(req.params.projectId);
    if (store.isSample(req.params.projectId)) throw new ApiError(400, 'SAMPLE_PROJECT', 'Approved sample projects cannot be deleted; use Restore approved sample instead.');
    const gone = projectOr404(req.params.projectId);
    store.deleteProject(req.params.projectId);
    audit(store, req, 'project.delete', { projectId: gone.projectId, modelVersion: gone.modelVersion, detail: { title: gone.title } });
    return { deleted: true, projectId: req.params.projectId };
  });

  /* Feature route modules (each owns its own file; see routes/deps.ts for the shared helpers they receive). */
  const deps: RouteDeps = { store, composer, ApiError, projectOr404, recordOr404, allRecords, checkDraftProject, runFor: (b) => runFor(ResolveBody.parse(b)), translator: opts.translator, assistModel: opts.assistModel };
  registerTemplateRoutes(app, deps);
  registerChannelRoutes(app, deps);
  registerTranslationRoutes(app, deps);
  registerAssistRoutes(app, deps);
  registerTestDataRoutes(app, deps);
  registerRecordRoutes(app, deps);
  registerSetupRoutes(app, deps);

  /* ------------------------------------------------ version history, review workflow, comments, audit */

  const versionNum = (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'INVALID_VERSION', `Not a version number: ${v}.`); return n; };
  const versionOr404 = (projectId: string, v: string) => { const n = versionNum(v); const found = store.getVersion(projectId, n); if (!found) throw new ApiError(404, 'NOT_FOUND', `Version ${n} of ${projectId} is not in the history.`); return { n, ...found }; };

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/versions', async (req) => {
    const p = projectOr404(req.params.projectId);
    const events = store.workflowHistory(p.projectId);
    const versions = store.listVersions(p.projectId).map((v) => ({ ...v, current: v.modelVersion === p.modelVersion, workflow: events.filter((e) => e.modelVersion === v.modelVersion).map((e) => ({ action: e.action, from: e.from, to: e.to, user: e.user, at: e.at })) }));
    return { projectId: p.projectId, currentVersion: p.modelVersion, versions };
  });
  app.get<{ Params: { projectId: string; version: string } }>('/api/v1/projects/:projectId/versions/:version', async (req) => {
    projectOr404(req.params.projectId);
    const v = versionOr404(req.params.projectId, req.params.version);
    return { modelVersion: v.n, contentDigest: v.contentDigest, savedAt: v.savedAt, savedBy: v.savedBy, label: v.label, project: v.project };
  });
  app.get<{ Params: { projectId: string; a: string; b: string } }>('/api/v1/projects/:projectId/versions/:a/diff/:b', async (req) => {
    projectOr404(req.params.projectId);
    const a = versionOr404(req.params.projectId, req.params.a);
    const b = versionOr404(req.params.projectId, req.params.b);
    const meta = (v: typeof a) => ({ modelVersion: v.n, contentDigest: v.contentDigest, savedAt: v.savedAt, savedBy: v.savedBy, label: v.label, title: v.project.title });
    return { from: meta(a), to: meta(b), diff: diffProjects(a.project, b.project) };
  });
  app.post<{ Params: { projectId: string; version: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/versions/:version/restore', async (req) => {
    const current = projectOr404(req.params.projectId);
    if ((req.body as any)?.confirm !== true) throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Restore requires {"confirm": true}.');
    const ifMatch = req.headers['if-match'];
    const expected = Number(String(ifMatch ?? '').replace(/"/g, ''));
    if (!ifMatch || !Number.isInteger(expected)) throw new ApiError(428, 'PRECONDITION_REQUIRED', 'Restore requires If-Match with the project model version you loaded.');
    if (expected !== current.modelVersion) throw new ApiError(409, 'VERSION_CONFLICT', `Project is at version ${current.modelVersion}; you loaded version ${expected}.`, { currentVersion: current.modelVersion });
    const v = versionOr404(current.projectId, req.params.version);
    if (v.n === current.modelVersion) throw new ApiError(400, 'ALREADY_CURRENT', `Version ${v.n} is already the current version.`);
    const { lastSavedAt: _l, ...content } = v.project as Project & { lastSavedAt?: string };
    const restored = checkDraftProject({ ...content, projectId: current.projectId, modelVersion: current.modelVersion + 1 }, current.projectId);
    const saved = store.putProject(restored, undefined, { by: by(req), label: `Restored v${v.n}` });
    audit(store, req, 'project.restore', { projectId: saved.projectId, modelVersion: saved.modelVersion, detail: { restoredVersion: v.n, fromVersion: current.modelVersion, contentDigest: projectContentDigest(saved) } });
    return { project: saved, restored: true, restoredVersion: v.n, contentDigest: projectContentDigest(saved), workflow: { state: store.getWorkflow(saved.projectId).state } };
  });

  /** Everything that must be true before the saved model can be approved: no blocking issue for any seeded or imported record, every pinned test passing. */
  function approvalReadiness(project: Project) {
    const records = allRecords(project.projectId).filter((r) => r.documentType === project.documentType);
    const groups = new Map<string, { code: string; severity: string; nodeId: string | null; locale: string | null; message: string; source: string; recordIds: string[] }>();
    const add = (f: { code: string; severity: string; nodeId?: string; locale?: string; message: string; source: string }, recordId: string | null) => {
      const key = `${f.code}|${f.nodeId ?? ''}|${f.locale ?? ''}|${recordId === null ? f.message : ''}`;
      const g = groups.get(key) ?? { code: f.code, severity: f.severity, nodeId: f.nodeId ?? null, locale: f.locale ?? null, message: f.message, source: f.source, recordIds: [] };
      if (recordId && !g.recordIds.includes(recordId)) g.recordIds.push(recordId);
      groups.set(key, g);
    };
    for (const record of records) for (const f of resolve({ project, record }).findings) if (f.severity === 'blocking') add(f, record.recordId);
    for (const f of [...staticRuleAnalysis(project, allRecords(project.projectId)), ...bindingAnalysis(project)]) if (f.severity === 'blocking') add(f, null);
    // Same runner as Rules & Data → Tests, so "passes" means the same thing everywhere.
    const tests = runTestCases(project, allRecords(project.projectId));
    const issues = [...groups.values()];
    const failedTests = tests.filter((t) => !t.pass);
    return { ready: issues.length === 0 && failedTests.length === 0, modelVersion: project.modelVersion, recordsChecked: records.length, blocking: issues, tests, testsRun: tests.length, testsFailed: failedTests.length };
  }

  function workflowView(project: Project, req: FastifyRequest, withChecks: boolean) {
    const wf = store.getWorkflow(project.projectId);
    const readiness = withChecks ? approvalReadiness(project) : null;
    const role = req.user?.role ?? null;
    const actions = WORKFLOW_ACTIONS.map((action) => {
      const t = WORKFLOW_TRANSITIONS[action];
      const stateProblem = transitionProblem(wf.state, action);
      const roleProblem = roleCan(role, t.permission) ? null : `Your role (${role ?? 'none'}) cannot ${ACTION_LABEL[action].toLowerCase()}.`;
      const checkProblem = action === 'approve' && readiness && !readiness.ready ? 'Approval is blocked until every blocking issue is fixed and every test passes.' : null;
      return { action, label: ACTION_LABEL[action], to: t.to, available: !stateProblem, allowed: !stateProblem && !roleProblem && !checkProblem, reason: stateProblem ?? roleProblem ?? checkProblem };
    }).filter((a) => a.available);
    return { projectId: project.projectId, modelVersion: project.modelVersion, state: wf.state, label: WORKFLOW_LABEL[wf.state], stateVersion: wf.modelVersion, updatedAt: wf.updatedAt, updatedBy: wf.updatedBy, actions, history: store.workflowHistory(project.projectId, 100), readiness };
  }

  app.get<{ Params: { projectId: string }; Querystring: { checks?: string } }>('/api/v1/projects/:projectId/workflow', async (req) => {
    const p = projectOr404(req.params.projectId);
    return workflowView(p, req, req.query.checks !== '0');
  });
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/workflow', async (req) => {
    const p = projectOr404(req.params.projectId);
    const action = String((req.body as any)?.action ?? '') as WorkflowAction;
    const t = WORKFLOW_TRANSITIONS[action];
    if (!t) throw new ApiError(400, 'INVALID_ACTION', `action must be one of ${WORKFLOW_ACTIONS.join(', ')}.`);
    const rawComment = (req.body as any)?.comment;
    const comment = rawComment === undefined || rawComment === null ? '' : sanitizeCommentBody(rawComment);
    if (comment.length > COMMENT_MAX) throw new ApiError(400, 'COMMENT_TOO_LONG', `Comments are limited to ${COMMENT_MAX} characters.`);
    if (!roleCan(req.user?.role, t.permission)) throw new ApiError(403, 'FORBIDDEN', req.user?.role === 'reviewer' && action !== 'request_changes' ? 'Reviewers can comment and request changes, but not approve, publish or submit.' : `Your role cannot ${ACTION_LABEL[action].toLowerCase()}.`, { role: req.user?.role, needs: t.permission });
    const wf = store.getWorkflow(p.projectId);
    const problem = transitionProblem(wf.state, action);
    if (problem) throw new ApiError(409, 'INVALID_TRANSITION', problem, { state: wf.state });
    if (action === 'approve') {
      const readiness = approvalReadiness(p);
      if (!readiness.ready) throw new ApiError(422, 'APPROVAL_BLOCKED', `Cannot approve: ${readiness.blocking.length} blocking issue${readiness.blocking.length === 1 ? '' : 's'} and ${readiness.testsFailed} failing test${readiness.testsFailed === 1 ? '' : 's'} in the saved model (v${p.modelVersion}).`, { readiness });
    }
    if (action === 'request_changes' && !comment) throw new ApiError(400, 'COMMENT_REQUIRED', 'Say what needs to change.');
    const { from, to } = store.setWorkflow(p.projectId, action, t.to, p.modelVersion, projectContentDigest(p), by(req), comment || null);
    audit(store, req, `workflow.${action}`, { projectId: p.projectId, modelVersion: p.modelVersion, detail: { from, to, withComment: !!comment } });
    return workflowView(p, req, false);
  });

  /* Comments pinned to components (plain text only). */
  /** Component display name for audit entries (a label, never a content body). */
  const nodeNameOf = (p: Project, nodeId: string) => { const n = p.nodes.find((x) => x.id === nodeId); return n?.name ?? n?.label ?? null; };
  const commentOr404 = (projectId: string, id: string) => { const c = store.getComment(id); if (!c || c.projectId !== projectId) throw new ApiError(404, 'NOT_FOUND', 'Unknown comment.'); return c; };
  app.get<{ Params: { projectId: string }; Querystring: { nodeId?: string; status?: string } }>('/api/v1/projects/:projectId/comments', async (req) => {
    const p = projectOr404(req.params.projectId);
    const all = store.listComments(p.projectId, req.query.nodeId || undefined);
    const roots = all.filter((c) => !c.parentId);
    const status = req.query.status ?? 'all';
    const keep = new Set(roots.filter((r) => status === 'all' || (status === 'open' ? !r.resolvedAt : !!r.resolvedAt)).map((r) => r.id));
    const comments = all.filter((c) => keep.has(c.parentId ?? c.id)).map((c) => ({ ...c, mine: c.author === req.user?.id }));
    return { comments, counts: { open: roots.filter((r) => !r.resolvedAt).length, resolved: roots.filter((r) => !!r.resolvedAt).length } };
  });
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/comments', async (req, reply) => {
    const p = projectOr404(req.params.projectId);
    const b = (req.body ?? {}) as { nodeId?: unknown; body?: unknown; parentId?: unknown };
    const body = sanitizeCommentBody(b.body);
    if (!body) throw new ApiError(400, 'EMPTY_COMMENT', 'Write a comment first.');
    if (body.length > COMMENT_MAX) throw new ApiError(400, 'COMMENT_TOO_LONG', `Comments are limited to ${COMMENT_MAX} characters.`);
    let nodeId = typeof b.nodeId === 'string' ? b.nodeId : '';
    let parentId: string | null = null;
    if (b.parentId !== undefined && b.parentId !== null) {
      const parent = commentOr404(p.projectId, String(b.parentId));
      parentId = parent.parentId ?? parent.id;
      nodeId = parent.nodeId;
    } else if (!p.nodes.some((n) => n.id === nodeId)) throw new ApiError(400, 'UNKNOWN_NODE', `No component ${nodeId || '(none)'} in ${p.projectId}.`);
    const c = store.addComment({ id: `cmt-${randomUUID().slice(0, 12)}`, projectId: p.projectId, nodeId, parentId, body, author: req.user?.id ?? 'unknown', authorName: req.user?.name ?? 'Unknown', modelVersion: p.modelVersion });
    audit(store, req, parentId ? 'comment.reply' : 'comment.create', { projectId: p.projectId, modelVersion: p.modelVersion, detail: { commentId: c.id, nodeId, nodeName: nodeNameOf(p, nodeId), parentId, length: body.length } });
    reply.status(201);
    return { comment: { ...c, mine: true } };
  });
  app.post<{ Params: { projectId: string; commentId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/comments/:commentId/resolve', async (req) => {
    const p = projectOr404(req.params.projectId);
    const c = commentOr404(p.projectId, req.params.commentId);
    const root = c.parentId ? commentOr404(p.projectId, c.parentId) : c;
    const resolved = (req.body as any)?.resolved !== false;
    const out = store.setCommentResolved(root.id, resolved, req.user?.name ?? null);
    audit(store, req, resolved ? 'comment.resolve' : 'comment.reopen', { projectId: p.projectId, modelVersion: p.modelVersion, detail: { commentId: root.id, nodeId: root.nodeId, nodeName: nodeNameOf(p, root.nodeId) } });
    return { comment: { ...out, mine: out.author === req.user?.id } };
  });
  app.delete<{ Params: { projectId: string; commentId: string } }>('/api/v1/projects/:projectId/comments/:commentId', async (req) => {
    const p = projectOr404(req.params.projectId);
    const c = commentOr404(p.projectId, req.params.commentId);
    if (c.author !== req.user?.id && req.user?.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'You can only delete your own comments.');
    const removed = store.deleteComment(c.id);
    audit(store, req, 'comment.delete', { projectId: p.projectId, modelVersion: p.modelVersion, detail: { commentId: c.id, nodeId: c.nodeId, nodeName: nodeNameOf(p, c.nodeId), removed } });
    return { deleted: true, removed };
  });

  /* Audit log: who did what, when (no content bodies). */
  app.get<{ Querystring: { projectId?: string; user?: string; action?: string; since?: string; before?: string; limit?: string } }>('/api/v1/audit', async (req) => {
    const q = req.query;
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);
    if (q.since && Number.isNaN(Date.parse(q.since))) throw new ApiError(400, 'INVALID_REQUEST', 'since must be an ISO date.');
    const events = store.listAudit({ projectId: q.projectId || undefined, user: q.user || undefined, action: q.action || undefined, since: q.since ? new Date(q.since).toISOString() : undefined, before: q.before ? Number(q.before) : undefined, limit: limit + 1 });
    const more = events.length > limit;
    const page = events.slice(0, limit);
    return { events: page, nextBefore: more ? page[page.length - 1].id : null, actors: store.auditActors(), authEnabled };
  });

  /* Image asset library: PNG/JPEG/WebP only (checked by magic bytes), ≤ 280 KB so the data URI stays within the renderer's embed limit. */
  const ASSET_MAX = 280 * 1024;
  const sniff = (b: Buffer): string | null => {
    if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  };
  const dims = (b: Buffer, mime: string): [number | null, number | null] => {
    try {
      if (mime === 'image/png') return [b.readUInt32BE(16), b.readUInt32BE(20)];
      if (mime === 'image/jpeg') {
        for (let i = 2; i < b.length - 9;) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1]; const len = b.readUInt16BE(i + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
          i += 2 + len;
        }
      }
    } catch { /* unknown */ }
    return [null, null];
  };
  app.get('/api/v1/assets', async () => ({ assets: store.listAssets(), maxBytes: ASSET_MAX, types: ['image/png', 'image/jpeg', 'image/webp'] }));
  app.post<{ Body: Record<string, any> }>('/api/v1/assets', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; dataUri?: string };
    const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUri ?? '');
    if (!m) throw new ApiError(400, 'INVALID_ASSET', 'Send the image as a base64 data URI.');
    const bytes = Buffer.from(m[2], 'base64');
    const mime = sniff(bytes);
    if (!mime) throw new ApiError(415, 'UNSUPPORTED_IMAGE', 'Only PNG, JPEG or WebP images are accepted (SVG is not, for safety).');
    if (bytes.length > ASSET_MAX) throw new ApiError(413, 'ASSET_TOO_LARGE', `Images must be at most ${Math.round(ASSET_MAX / 1024)} KB (this one is ${Math.round(bytes.length / 1024)} KB). Export a smaller PNG/JPEG.`);
    const name = String(b.name ?? 'image').replace(/[^\w .()-]/g, '').slice(0, 80) || 'image';
    const [w, h] = dims(bytes, mime);
    const asset = store.addAsset(name, mime, bytes, w, h);
    audit(store, req, 'asset.upload', { detail: { assetId: asset.assetId, name, mime, size: bytes.length, duplicate: asset.duplicate } });
    reply.status(asset.duplicate ? 200 : 201);
    return { asset, dataUri: `data:${mime};base64,${bytes.toString('base64')}` };
  });
  const assetOr404 = (id: string) => { const a = store.getAsset(id); if (!a) throw new ApiError(404, 'NOT_FOUND', `Unknown asset ${id}.`); return a; };
  app.get<{ Params: { assetId: string } }>('/api/v1/assets/:assetId', async (req) => {
    const a = assetOr404(req.params.assetId);
    const bytes = store.assetBytes(a.sha256);
    if (!bytes) throw new ApiError(410, 'ASSET_MISSING', 'Asset file is missing from the local store.');
    return { asset: a, dataUri: `data:${a.mime};base64,${bytes.toString('base64')}` };
  });
  app.get<{ Params: { assetId: string } }>('/api/v1/assets/:assetId/raw', async (req, reply) => {
    const a = assetOr404(req.params.assetId);
    const bytes = store.assetBytes(a.sha256);
    if (!bytes) throw new ApiError(410, 'ASSET_MISSING', 'Asset file is missing from the local store.');
    reply.header('Content-Type', a.mime).header('Cache-Control', 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff');
    return reply.send(bytes);
  });
  app.delete<{ Params: { assetId: string } }>('/api/v1/assets/:assetId', async (req) => {
    const gone = assetOr404(req.params.assetId);
    store.deleteAsset(req.params.assetId);
    audit(store, req, 'asset.delete', { detail: { assetId: gone.assetId, name: gone.name } });
    return { deleted: true, note: 'Documents that already use this image keep their embedded copy.' };
  });

  /* Batch production runs */
  app.post<{ Body: Record<string, any> }>('/api/v1/batches', async (req, reply) => {
    const b = (req.body ?? {}) as { projectId?: string; project?: unknown; recordIds?: unknown; outputs?: unknown; includeBlocked?: boolean };
    if (typeof b.projectId !== 'string') throw new ApiError(400, 'INVALID_REQUEST', 'projectId is required.');
    const project = b.project ? checkDraftProject(b.project, b.projectId) : projectOr404(b.projectId);
    const pool = allRecords(project.projectId).filter((r) => r.documentType === project.documentType);
    let records = pool;
    if (Array.isArray(b.recordIds)) {
      const want = new Set(b.recordIds.map(String));
      records = pool.filter((r) => want.has(r.recordId));
      const missing = [...want].filter((id) => !pool.some((r) => r.recordId === id));
      if (missing.length) throw new ApiError(400, 'UNKNOWN_RECORDS', project.documentType === 'custom' ? `Not customers of this document: ${missing.slice(0, 5).join(', ')}.` : `Not ${project.documentType} records: ${missing.slice(0, 5).join(', ')}.`);
    }
    if (!records.length) throw new ApiError(400, 'EMPTY_BATCH', 'Choose at least one record.');
    if (records.length > BATCH_LIMIT) throw new ApiError(413, 'BATCH_TOO_LARGE', `At most ${BATCH_LIMIT} records per batch.`);
    const outputs = (Array.isArray(b.outputs) && b.outputs.length ? b.outputs : ['pdf']).filter((o): o is BatchOutput => o === 'pdf' || o === 'html');
    if (!outputs.length) throw new ApiError(400, 'INVALID_REQUEST', 'outputs must include pdf and/or html (AFP is simulation-only).');
    if (batches.list().some((j) => j.status === 'running')) throw new ApiError(409, 'BATCH_RUNNING', 'Another batch is still running; wait for it or cancel it.');
    const job = batches.start(project, records, outputs, !!b.includeBlocked);
    audit(store, req, 'batch.start', { projectId: project.projectId, modelVersion: project.modelVersion, detail: { batchId: job.batchId, records: records.length, outputs, includeBlocked: !!b.includeBlocked, unsavedModel: !!b.project } });
    reply.status(202);
    return { batch: job };
  });
  app.get('/api/v1/batches', async () => ({ batches: batches.list().map(({ items, ...j }) => j) }));
  const batchOr404 = (id: string) => { const j = batches.get(id); if (!j) throw new ApiError(404, 'NOT_FOUND', `Unknown batch ${id}.`); return j; };
  app.get<{ Params: { batchId: string } }>('/api/v1/batches/:batchId', async (req) => ({ batch: batchOr404(req.params.batchId) }));
  app.post<{ Params: { batchId: string } }>('/api/v1/batches/:batchId/cancel', async (req) => { const j = batchOr404(req.params.batchId); audit(store, req, 'batch.cancel', { projectId: j.projectId, modelVersion: j.modelVersion, detail: { batchId: j.batchId } }); return { batch: batches.cancel(req.params.batchId) }; });
  app.get<{ Params: { batchId: string } }>('/api/v1/batches/:batchId/zip', async (req, reply) => {
    const j = batchOr404(req.params.batchId);
    const zip = batches.readZip(j.batchId);
    if (!zip) throw new ApiError(409, 'BATCH_NOT_READY', 'The batch has not finished yet.');
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${j.projectId}-${j.batchId}.zip"`).header('X-Sha256', j.zipSha256 ?? '');
    return reply.send(zip);
  });

  /* Imported scenario records: validated against the typed data contract; stored locally only. */
  app.post<{ Body: Record<string, any> }>('/api/v1/records/import', async (req) => {
    const b = (req.body ?? {}) as { documentType?: string; format?: string; data?: unknown; dryRun?: boolean; projectId?: string; scope?: string };
    // Custom data fields of the chosen project are accepted in addition to the standard contract.
    const target = b.projectId ? projectOr404(b.projectId) : undefined;
    // A document with its own data has no shared customers: its records are always supplied FOR one project, which must be named.
    if (b.documentType === 'custom' && !target) throw new ApiError(400, 'PROJECT_REQUIRED', `Customers for a document with its own data (“${DOCUMENT_TYPE_LABEL.custom}”) belong to one project. Send that project’s projectId with the import.`);
    // With a project named, the kind may be left out: it is the project's.
    const wanted = b.documentType === undefined || b.documentType === null || b.documentType === '' ? target?.documentType : b.documentType;
    if (!isDocumentType(wanted)) throw new ApiError(400, 'INVALID_REQUEST', 'documentType must be credit-statement or eob (or leave it out and send the projectId of the document the customers are for).');
    const documentType: DocumentType = wanted;
    if (target && target.documentType !== documentType) throw new ApiError(400, 'RECORD_TYPE_MISMATCH', target.documentType === 'custom' || documentType === 'custom' ? `“${target.title}” is a different kind of document (${DOCUMENT_TYPE_LABEL[target.documentType]}).` : `${target.projectId} is a ${target.documentType} project.`);
    if (b.scope !== undefined && b.scope !== 'project' && b.scope !== 'shared') throw new ApiError(400, 'INVALID_REQUEST', 'scope must be "project" or "shared".');
    if (b.scope === 'project' && !target) throw new ApiError(400, 'PROJECT_REQUIRED', 'Send the projectId of the document these customers are for.');
    if (b.scope === 'shared' && documentType === 'custom') throw new ApiError(400, 'INVALID_REQUEST', 'Customers of a document with its own data cannot be shared with other documents.');
    /**
     * Where the accepted rows go. For one project ("supplied": validated against that project's fields, visible only
     * there, removable with DELETE /projects/:id/records/supplied): always for a document with its own data, and for the
     * built-in kinds when asked with scope "project". Otherwise as before: shared by every document of that kind.
     */
    const forProject = !!target && (documentType === 'custom' || b.scope === 'project');
    const extra = customFieldDefs(target?.customFields);
    let items: unknown[];
    if (b.format === 'csv') {
      if (typeof b.data !== 'string') throw new ApiError(400, 'INVALID_REQUEST', 'CSV import expects data as text.');
      const parsed = csvToRecords(b.data, documentType, extra);
      if (parsed.headerErrors.length) throw new ApiError(422, 'INVALID_CSV_HEADER', parsed.headerErrors.join(' '), { errors: parsed.headerErrors });
      items = parsed.records;
    } else {
      let data = b.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { throw new ApiError(400, 'INVALID_JSON', 'The file is not valid JSON.'); } }
      items = Array.isArray(data) ? data : Array.isArray((data as any)?.records) ? (data as any).records : [data];
    }
    if (!items.length) throw new ApiError(400, 'EMPTY_IMPORT', 'No records found in the file.');
    if (items.length > IMPORT_LIMIT) throw new ApiError(413, 'IMPORT_TOO_LARGE', `At most ${IMPORT_LIMIT} records per import.`);
    const rows = prepareImport(items, documentType, forProject ? IMPORT_ID_BASE : store.nextImportNumber(documentType), extra);
    let ok = rows.filter((r) => r.record).map((r) => r.record!);
    if (forProject) {
      // The project's own records get studio-wide unique ids of their own (never reused); a dry run shows none yet.
      const mine = ok.map(({ recordId: _provisional, ...rest }) => rest);
      ok = b.dryRun ? mine.map((r) => ({ ...r, recordId: '', projectId: target!.projectId }) as SyntheticRecord) : store.addProjectRecords(target!.projectId, RECORD_ID_PREFIX[documentType], 'supplied', mine);
    } else if (!b.dryRun && ok.length) store.addImportedRecords(ok);
    if (b.dryRun) req.audited = true;
    else audit(store, req, 'records.import', { projectId: target?.projectId ?? null, detail: { documentType, format: b.format === 'csv' ? 'csv' : 'json', imported: ok.length, rejected: rows.length - ok.length, recordIds: ok.slice(0, 20).map((r) => r.recordId), ...(forProject ? { scope: 'project' } : {}) } });
    return { documentType, dryRun: !!b.dryRun, ...(forProject ? { projectId: target!.projectId, scope: 'project' as const } : {}), imported: ok.map((r) => ({ recordId: r.recordId || null, sourceId: r.sourceId ?? null, name: `${r.customer.givenName} ${r.customer.familyName}` })), rejected: rows.filter((r) => !r.record).map(({ row, sourceId, errors }) => ({ row, sourceId, errors })), total: items.length };
  });
  app.delete<{ Querystring: { documentType?: string } }>('/api/v1/records/imported', async (req) => {
    const removed = store.clearImportedRecords(req.query.documentType);
    audit(store, req, 'records.clear', { detail: { documentType: req.query.documentType ?? 'all', removed } });
    return { removed };
  });

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/schemas', async (req) => {
    const p = projectOr404(req.params.projectId);
    return { documentType: p.documentType, fields: projectFields(p), customFields: p.customFields ?? [], dimensions: DIMENSIONS.filter((d) => d.documentTypes.includes(p.documentType)), edgeCasePresets: EDGE_CASE_PRESETS.filter((e) => e.documentType === p.documentType) };
  });

  /** `projectId` adds the records that belong to that project alone (generated test customers, supplied data). */
  app.get<{ Querystring: { documentType?: string; full?: string; projectId?: string } }>('/api/v1/records', async (req) => {
    // A document with its own data only ever sees its own customers, whatever kind is asked for.
    const ownOnly = req.query.projectId && !req.query.documentType && store.getProject(req.query.projectId)?.documentType === 'custom' ? 'custom' : undefined;
    const kind = req.query.documentType || ownOnly;
    const recs = allRecords(req.query.projectId).filter((r) => !kind || r.documentType === kind);
    if (req.query.full === '1') return { seed: FIXTURE_SEED, syntheticOnly: true, records: recs };
    return { seed: FIXTURE_SEED, syntheticOnly: true, records: recs.map((r) => ({ recordId: r.recordId, documentType: r.documentType, personaId: r.personaId ?? null, name: `${r.customer.givenName} ${r.customer.familyName}`, locale: r.customer.locale, status: (r.card as any)?.paymentStatus ?? (r.claims?.[0] as any)?.status, synthetic: !r.imported, imported: !!r.imported, generated: r.generated ? r.generated.label : null, projectOnly: !!r.projectId })) };
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
    if (suites.includes('rules')) { const t0 = t(); add('rules', [...res.findings.filter((f) => f.source === 'resolver' || f.source === 'domain'), ...staticRuleAnalysis(project, allRecords(project.projectId))].map((f) => toIssue(f, 'rules', { runId: res.runId, reproduction: repro })), t0); }
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
  app.post('/api/v1/snapshots/reset', async (req) => { const b = req.body as any; if (b?.confirm !== true) throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Requires {"confirm": true}.'); store.clearSnapshots(String(b.projectId)); audit(store, req, 'snapshots.reset', { projectId: String(b.projectId) }); return { cleared: true }; });

  app.post('/api/v1/scenarios/generate', async (req) => {
    const b = req.body as any;
    const record = recordOr404(String(b?.recordId));
    try { return { syntheticOnly: true, ...generateEdgeCase(record, String(b?.preset), b?.seed ? String(b.seed) : undefined) }; }
    catch (e: any) { throw new ApiError(400, 'INVALID_PRESET', e.message); }
  });

  app.post('/api/v1/analysis/cube', async (req) => {
    const b = req.body as any;
    const project = b?.project ? checkDraftProject(b.project, b.projectId) : projectOr404(String(b?.projectId));
    const cube = buildCube(new ScenarioEngine(project, allRecords(project.projectId)), (b?.axes ?? ['persona', 'output', 'journey']) as [DimensionId, DimensionId, DimensionId], { offsets: b?.offsets, filters: b?.filters });
    if (cube.errors.length) throw new ApiError(400, 'INVALID_AXES', cube.errors.join(' '));
    return cube;
  });
  app.post('/api/v1/analysis/landscape', async (req) => {
    const b = req.body as any;
    const project = b?.project ? checkDraftProject(b.project, b.projectId) : projectOr404(String(b?.projectId));
    return buildLandscape(new ScenarioEngine(project, allRecords(project.projectId)), { includeJourney: !!b?.includeJourney, filters: b?.filters });
  });

  app.get<{ Params: { artifactId: string } }>('/api/v1/artifacts/:artifactId', async (req, reply) => {
    const a = store.getArtifact(req.params.artifactId);
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'Unknown artifact.');
    const type = a.kind === 'pdf' ? 'application/pdf' : a.kind === 'html' || a.kind === 'email' ? 'text/html; charset=utf-8' : 'application/json';
    reply.header('Content-Type', type).header('Content-Disposition', `${(req.query as any)?.inline ? 'inline' : 'attachment'}; filename="${a.filename}"`).header('X-Sha256', a.sha256).header('X-Run-Id', a.run_id);
    return reply.send(a.bytes);
  });
  app.get<{ Querystring: { runId?: string; projectId?: string } }>('/api/v1/artifacts', async (req) => ({ artifacts: store.listArtifacts({ runId: req.query.runId, projectId: req.query.projectId }) }));

  app.get('/api/v1/assistant/status', async () => providerStatus(providerConfig()));
  /** The studio reports each assistant proposal a person applied, so Activity shows it as AI-assisted. Stores a label and counts only. */
  app.post('/api/v1/assist/applied', async (req) => {
    const b = (req.body ?? {}) as { projectId?: unknown; feature?: unknown; label?: unknown; source?: unknown; changes?: unknown; modelVersion?: unknown };
    if (typeof b.projectId !== 'string' || typeof b.feature !== 'string' || typeof b.label !== 'string') throw new ApiError(400, 'INVALID', 'projectId, feature and label are required.');
    projectOr404(b.projectId);
    audit(store, req, 'assist.applied', { projectId: b.projectId, modelVersion: typeof b.modelVersion === 'number' ? b.modelVersion : null, detail: { feature: b.feature.slice(0, 40), label: b.label.slice(0, 200), source: b.source === 'ai' ? 'ai' : 'builtin', changes: typeof b.changes === 'number' ? b.changes : 1 } });
    return { recorded: true };
  });
  app.post('/api/v1/assistant/message', async (req) => {
    const b = req.body as any;
    if (typeof b?.message !== 'string' || !b.message.trim() || b.message.length > 2000) throw new ApiError(400, 'INVALID_MESSAGE', 'Message must be 1–2000 characters.');
    const ctx = b.context ?? {};
    const project = b.project ? checkDraftProject(b.project, String(ctx.projectId)) : projectOr404(String(ctx.projectId));
    // Without a chosen customer: the first sample customer of the kind, or, for a document with its own data, its first own customer.
    const recordId = String(ctx.recordId ?? (project.documentType === 'custom' ? store.projectRecords(project.projectId)[0]?.recordId ?? '' : project.documentType === 'eob' ? 'EOB-0001' : 'CARD-0001'));
    if (!recordId) throw new ApiError(400, 'NO_CUSTOMER', 'This document has no customers yet. Generate test customers first.');
    const chosen = recordOr404(recordId);
    if (chosen.projectId && chosen.projectId !== project.projectId) throw new ApiError(400, 'RECORD_OTHER_PROJECT', 'That customer belongs to another document.');
    const cfg = providerConfig();
    if (b.forceOffline === true) cfg.provider = 'offline';
    const reply = await handleMessage(b.message, { project, records: allRecords(project.projectId), recordId, overrides: ctx.overrides ?? {}, journeyCursor: ctx.journeyCursor ?? null, selectedNodeId: ctx.selectedNodeId ?? null }, cfg);
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
