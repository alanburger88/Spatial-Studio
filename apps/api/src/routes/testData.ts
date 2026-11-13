import type { FastifyInstance } from 'fastify';
import { projectContentDigest, type Project } from '@iss/model';
import { planTestData } from '@iss/scenarios';
import { audit } from '../auth';
import { baseRecordsFor, ensureCustomer, generateTestCustomers, publicPlan } from '../projectCustomers';
import type { RouteDeps } from './deps';
import { issueDateFrom } from '../issueDate';

/**
 * Generated test customers: synthetic records made FOR ONE PROJECT so that every rule, message version and optional
 * section is exercised, with edge values around each threshold. They belong to that project only, are marked as
 * generated everywhere, and regenerating replaces the previous set. Nothing here touches the shared sample or imported records.
 *
 * A document with its own data ("custom") has no shared customers at all, so its generated and supplied customers are
 * the only ones it has: removing them leaves one starting customer behind (see `ensureCustomer`).
 */
export function registerTestDataRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, projectOr404, checkDraftProject } = deps;

  /** The model to plan for: the unsaved one the studio sends, or the saved one. */
  const modelOf = (projectId: string, body: any): Project => (body?.project ? checkDraftProject(body.project, projectId) : projectOr404(projectId));
  const optionsOf = (body: any) => {
    const outcomes = body?.outcomes !== false;
    const edges = body?.edges !== false;
    if (!outcomes && !edges) throw new ApiError(400, 'NOTHING_TO_GENERATE', 'Choose at least one of: every outcome, edge values.');
    // "As issued on": the outcomes are reached on this day (documents that use dates). Only sent when set.
    const issueDate = issueDateFrom(body?.issueDate, ApiError);
    return { outcomes, edges, ...(issueDate ? { issueDate } : {}) };
  };
  /** The customer a project was given so that it is not left without one, as the responses report it. */
  const keptOf = (b: ReturnType<typeof ensureCustomer>) => (b ? { recordId: b.record.recordId, name: b.name, label: b.label } : null);
  /** What a removal answers. A document with its own data also says how many customers it has left and which one was created to keep it previewable. */
  const afterRemoval = (saved: Project, removed: number, baseline: ReturnType<typeof ensureCustomer>) => (saved.documentType !== 'custom' ? { removed } : {
    removed,
    remaining: store.projectRecords(saved.projectId).length,
    kept: keptOf(baseline),
    ...(baseline ? { note: `This document has only its own customers, so one starting customer (${baseline.name}) was created to keep it previewable.` } : {}),
  });

  /** What generating would create. Stores nothing. */
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/test-data/plan', async (req) => {
    projectOr404(req.params.projectId);
    const project = modelOf(req.params.projectId, req.body);
    const plan = planTestData(project, baseRecordsFor(store, project), optionsOf(req.body));
    return { ...publicPlan(plan), existing: store.projectRecords(project.projectId, 'generated').length };
  });

  /** The project's current generated customers and what the last generation covered. */
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/test-data', async (req) => {
    const saved = projectOr404(req.params.projectId);
    const stored = store.getTestDataPlan(saved.projectId);
    const records = store.projectRecords(saved.projectId, 'generated');
    return {
      count: records.length,
      generatedAt: stored?.createdAt ?? null,
      options: stored?.plan?.options ?? null,
      forModelVersion: stored?.plan?.forModelVersion ?? null,
      /** The saved document has changed since these customers were generated, so they may no longer cover every outcome. */
      stale: !!stored && stored.plan.forDigest !== projectContentDigest(saved),
      summary: stored?.plan?.summary ?? null,
      targets: stored?.plan?.targets ?? [],
      customers: stored?.plan?.customers ?? [],
    };
  });

  /** Generate and store, replacing the project's previous generated customers. */
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/test-data', async (req, reply) => {
    const saved = projectOr404(req.params.projectId);
    const project = modelOf(req.params.projectId, req.body);
    const options = optionsOf(req.body);
    const { plan, pub, stored, removed, baseline } = generateTestCustomers(store, project, options, saved);
    audit(store, req, 'testdata.generate', { projectId: project.projectId, modelVersion: project.modelVersion, detail: { customers: stored.length, replaced: removed, outcomes: options.outcomes, edges: options.edges, unreachable: plan.summary.unreachable, capped: plan.summary.capped } });
    reply.status(201);
    return { ...pub, generated: stored.length, replaced: removed, ...(baseline ? { kept: keptOf(baseline) } : {}) };
  });

  /**
   * Remove the project's generated customers. Sample and imported customers are never touched.
   * A document with its own data is never left without a customer: when nothing else remains, one starting customer is
   * created and reported as `kept`.
   */
  app.delete<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/test-data', async (req) => {
    const saved = projectOr404(req.params.projectId);
    const removed = store.clearProjectRecords(saved.projectId, 'generated');
    store.setTestDataPlan(saved.projectId, null);
    const baseline = ensureCustomer(store, saved);
    audit(store, req, 'testdata.clear', { projectId: saved.projectId, detail: { removed, ...(baseline ? { keptOne: baseline.record.recordId } : {}) } });
    return afterRemoval(saved, removed, baseline);
  });

  /**
   * Remove the customers that were supplied for this project (imported with its `projectId`). Generated customers stay.
   * As above, a document with its own data keeps one starting customer when nothing else remains.
   */
  app.delete<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/records/supplied', async (req) => {
    const saved = projectOr404(req.params.projectId);
    const removed = store.clearProjectRecords(saved.projectId, 'supplied');
    const baseline = ensureCustomer(store, saved);
    audit(store, req, 'records.clear', { projectId: saved.projectId, detail: { documentType: saved.documentType, scope: 'project', removed, ...(baseline ? { keptOne: baseline.record.recordId } : {}) } });
    return afterRemoval(saved, removed, baseline);
  });
}
