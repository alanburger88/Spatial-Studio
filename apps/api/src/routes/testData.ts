import type { FastifyInstance } from 'fastify';
import { projectContentDigest, type Project, type SyntheticRecord } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { planTestData, type TestDataPlan } from '@iss/scenarios';
import { audit } from '../auth';
import type { RouteDeps } from './deps';

const PREFIX: Record<string, string> = { 'credit-statement': 'CARD', eob: 'EOB' };

/**
 * Generated test customers: synthetic records made FOR ONE PROJECT so that every rule, message version and optional
 * section is exercised, with edge values around each threshold. They belong to that project only, are marked as
 * generated everywhere, and regenerating replaces the previous set. Nothing here touches the shared sample or imported records.
 */
export function registerTestDataRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, projectOr404, checkDraftProject } = deps;

  /** The model to plan for: the unsaved one the studio sends, or the saved one. */
  const modelOf = (projectId: string, body: any): Project => (body?.project ? checkDraftProject(body.project, projectId) : projectOr404(projectId));
  const optionsOf = (body: any) => {
    const outcomes = body?.outcomes !== false;
    const edges = body?.edges !== false;
    if (!outcomes && !edges) throw new ApiError(400, 'NOTHING_TO_GENERATE', 'Choose at least one of: every outcome, edge values.');
    return { outcomes, edges };
  };
  /** Shared customers of this kind of document that the generator may start from (never earlier generated ones). */
  const baseRecords = (project: Project): SyntheticRecord[] => [...RECORDS, ...store.importedRecords(), ...store.projectRecords(project.projectId, 'supplied')].filter((r) => r.documentType === project.documentType);
  const publicPlan = (plan: TestDataPlan, ids: string[] = []) => ({
    summary: plan.summary,
    targets: plan.targets.map((t) => ({ ...t, recordId: t.customer === null ? null : ids[t.customer] ?? null })),
    customers: plan.customers.map((c, i) => ({ recordId: ids[i] ?? null, name: `${c.record.customer.givenName} ${c.record.customer.familyName}`, label: c.label, locale: c.record.customer.locale, targets: c.targets.length })),
  });

  /** What generating would create. Stores nothing. */
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/test-data/plan', async (req) => {
    projectOr404(req.params.projectId);
    const project = modelOf(req.params.projectId, req.body);
    const plan = planTestData(project, baseRecords(project), optionsOf(req.body));
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
    const plan = planTestData(project, baseRecords(project), options);
    const removed = store.clearProjectRecords(project.projectId, 'generated');
    const prefix = PREFIX[project.documentType] ?? 'REC';
    const stored = store.addProjectRecords(project.projectId, prefix, 'generated', plan.customers.map((c) => ({ ...c.record, documentType: project.documentType, generated: { label: c.label } })));
    const pub = publicPlan(plan, stored.map((r) => r.recordId));
    store.setTestDataPlan(project.projectId, { ...pub, options, forModelVersion: project.modelVersion, forDigest: projectContentDigest(project), unsavedModel: projectContentDigest(project) !== projectContentDigest(saved) });
    audit(store, req, 'testdata.generate', { projectId: project.projectId, modelVersion: project.modelVersion, detail: { customers: stored.length, replaced: removed, outcomes: options.outcomes, edges: options.edges, unreachable: plan.summary.unreachable, capped: plan.summary.capped } });
    reply.status(201);
    return { ...pub, generated: stored.length, replaced: removed };
  });

  /** Remove the project's generated customers. Sample and imported customers are never touched. */
  app.delete<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/test-data', async (req) => {
    const saved = projectOr404(req.params.projectId);
    const removed = store.clearProjectRecords(saved.projectId, 'generated');
    store.setTestDataPlan(saved.projectId, null);
    audit(store, req, 'testdata.clear', { projectId: saved.projectId, detail: { removed } });
    return { removed };
  });
}
