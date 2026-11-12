import type { FastifyInstance } from 'fastify';
import { TEMPLATES, projectFromTemplate, registerTemplateSeeds, projectContentDigest, type DocumentType } from '@iss/model';
import { seedProjects as fixtureSeeds } from '@iss/model/fixtures';
import type { RouteDeps } from './deps';

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';

/** Templates: list them, preview one as a project, and create a new editable project from one. */
export function registerTemplateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, checkDraftProject } = deps;
  registerTemplateSeeds(fixtureSeeds());

  const docTypeOf = (v: unknown): DocumentType | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (v !== 'credit-statement' && v !== 'eob') throw new ApiError(400, 'INVALID_DOCUMENT_TYPE', 'documentType must be credit-statement or eob.');
    return v;
  };
  const templateOr404 = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) throw new ApiError(404, 'NOT_FOUND', `Unknown template ${id}.`);
    return t;
  };

  app.get('/api/v1/templates', async () => ({ templates: TEMPLATES }));

  /** Unsaved preview of a template (used for gallery thumbnails). Nothing is stored. */
  app.get<{ Params: { templateId: string }; Querystring: { documentType?: string } }>('/api/v1/templates/:templateId/project', async (req) => {
    const t = templateOr404(req.params.templateId);
    return { template: t, project: projectFromTemplate(t.id, { projectId: `template-${t.id}`, title: t.title, documentType: docTypeOf(req.query.documentType) }) };
  });

  app.post<{ Body: Record<string, any> }>('/api/v1/projects', async (req, reply) => {
    const body = req.body ?? {};
    const t = templateOr404(String(body.templateId ?? ''));
    const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
    if (title.length < 2 || title.length > 80) throw new ApiError(400, 'INVALID_TITLE', 'Title must be 2–80 characters.');
    let id = slug(title);
    if (id.length < 3) id = `${id}-project`;
    for (let i = 2; store.getProject(id); i++) id = `${slug(title).slice(0, 36)}-${i}`;
    const project = checkDraftProject(projectFromTemplate(t.id, { projectId: id, title, documentType: docTypeOf(body.documentType) }), id);
    const saved = store.putProject(project, projectContentDigest(project));
    reply.status(201);
    return { project: saved, createdFrom: t.id };
  });
}
