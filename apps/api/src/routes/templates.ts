import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  TEMPLATES, TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NOTE_MAX, TEMPLATE_TITLE_MAX, SCHEMA_VERSION,
  projectFromTemplate, projectFromSavedTemplate, registerTemplateSeeds, projectContentDigest, projectFileProblems, projectInFile,
  templateContentOf, templateCounts, roleCan,
  ACCENT_PATTERN, BLANK_PROJECT_TEMPLATE_ID, DOCUMENT_TYPE_LABEL, ISSUER_NAME_MAX, ISSUER_NAME_MIN,
  type DocumentType, type Project, type SyntheticRecord, type TemplateInfo,
} from '@iss/model';
import { seedProjects as fixtureSeeds } from '@iss/model/fixtures';
import { resolve } from '@iss/resolver';
import { baselineCustomer } from '@iss/scenarios';
import { audit } from '../auth';
import { firstCustomers } from '../projectCustomers';
import type { RouteDeps } from './deps';

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/**
 * Templates and project files.
 *  - Built-in starters ship with the studio. Saved templates are published from a document by an approver or admin;
 *    each save is a new frozen, numbered version and earlier versions are never changed.
 *  - A studio project file (what "Export project" downloads) can be imported as a new draft document.
 */
export function registerTemplateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, checkDraftProject, projectOr404, allRecords } = deps;
  registerTemplateSeeds(fixtureSeeds());

  const by = (req: FastifyRequest) => (req.user ? { id: req.user.id, name: req.user.name } : null);
  /** `documentType` chooses the sample data a Blank letter is written against. The Blank project is always a document with its own data. */
  const docTypeOf = (v: unknown, templateId?: string): DocumentType | undefined => {
    if (templateId === BLANK_PROJECT_TEMPLATE_ID) return undefined;
    if (v === undefined || v === null || v === '') return undefined;
    if (v === 'custom') throw new ApiError(400, 'INVALID_DOCUMENT_TYPE', `A document with its own data (“${DOCUMENT_TYPE_LABEL.custom}”) starts from the “Blank project” template. documentType here must be credit-statement or eob.`);
    if (v !== 'credit-statement' && v !== 'eob') throw new ApiError(400, 'INVALID_DOCUMENT_TYPE', 'documentType must be credit-statement or eob.');
    return v;
  };
  /** Blank project only: who the document is from and the issuer's colour. Both optional. */
  const issuerOf = (body: Record<string, any>): { issuerName?: string; accent?: string } => {
    const out: { issuerName?: string; accent?: string } = {};
    if (body.issuerName !== undefined && body.issuerName !== null && body.issuerName !== '') {
      const name = oneLine(body.issuerName, 200);
      if (name.length < ISSUER_NAME_MIN || name.length > ISSUER_NAME_MAX) throw new ApiError(400, 'INVALID_ISSUER_NAME', `The issuer name must be ${ISSUER_NAME_MIN}–${ISSUER_NAME_MAX} characters.`);
      out.issuerName = name;
    }
    if (body.accent !== undefined && body.accent !== null && body.accent !== '') {
      if (typeof body.accent !== 'string' || !ACCENT_PATTERN.test(body.accent)) throw new ApiError(400, 'INVALID_ACCENT', 'The colour must be a 6-digit hex value such as #1F4E79.');
      out.accent = body.accent.toLowerCase();
    }
    return out;
  };
  /**
   * A customer to preview a document with its own data before it has any (a template thumbnail, the check of an imported
   * file): built from the project's field definitions, never stored.
   */
  const previewRecordOf = (project: Project): SyntheticRecord => ({ ...baselineCustomer(project).record, recordId: 'REC-0000' });
  const builtIn = (): TemplateInfo[] => TEMPLATES.map((t) => ({ ...t, source: 'builtin' as const }));
  const templateOr404 = (id: string): TemplateInfo => {
    const t = builtIn().find((x) => x.id === id) ?? store.getSavedTemplate(id);
    if (!t) throw new ApiError(404, 'NOT_FOUND', `Unknown template ${id}.`);
    return t;
  };
  const savedOr404 = (id: string): TemplateInfo => {
    const t = store.getSavedTemplate(id);
    if (!t) throw new ApiError(404, 'NOT_FOUND', builtIn().some((x) => x.id === id) ? 'Built-in templates cannot be changed.' : `Unknown template ${id}.`);
    return t;
  };
  const versionOf = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'INVALID_VERSION', 'version must be a whole number from 1.');
    return n;
  };
  const savedContent = (t: TemplateInfo, version?: number) => {
    const c = store.savedTemplateContent(t.id, version);
    if (!c) throw new ApiError(404, 'NOT_FOUND', `Template “${t.title}” has no version ${version}.`);
    return c;
  };
  const titleOf = (v: unknown, what = 'Title') => {
    const title = oneLine(v, 200);
    if (title.length < 2 || title.length > TEMPLATE_TITLE_MAX) throw new ApiError(400, 'INVALID_TITLE', `${what} must be 2–${TEMPLATE_TITLE_MAX} characters.`);
    return title;
  };
  const freeProjectId = (title: string, fallback: string) => {
    let id = slug(title);
    if (id.length < 3) id = `${id}-${fallback}`;
    // A deleted document's releases keep its id, so that id is never given to another document.
    for (let i = 2; store.getProject(id) || store.hasReleases(id); i++) id = `${slug(title).slice(0, 36)}-${i}`;
    return id;
  };

  /** Built-in starters first, then saved templates. Retired ones are left out unless asked for. */
  app.get<{ Querystring: { includeRetired?: string } }>('/api/v1/templates', async (req) => {
    const saved = store.listSavedTemplates().filter((t) => req.query.includeRetired === 'true' || !t.retired);
    return { templates: [...builtIn(), ...saved], canSave: roleCan(req.user?.role, 'approve') };
  });

  /** Unsaved preview of a template (used for gallery thumbnails). Nothing is stored. */
  app.get<{ Params: { templateId: string }; Querystring: { documentType?: string; version?: string } }>('/api/v1/templates/:templateId/project', async (req) => {
    const t = templateOr404(req.params.templateId);
    // A template of a document with its own data has no stored customer to draw it with: one is sent along (`previewRecord`).
    const withPreview = <T extends { project: Project }>(out: T) => (out.project.documentType === 'custom' ? { ...out, previewRecord: previewRecordOf(out.project) } : out);
    if (t.source === 'saved') {
      const c = savedContent(t, versionOf(req.query.version));
      return withPreview({ template: t, version: c.version, project: projectFromSavedTemplate(c.content, { projectId: `template-${t.id}`, title: t.title, templateId: t.id, version: c.version, templateTitle: t.title }) });
    }
    return withPreview({ template: t, project: projectFromTemplate(t.id, { projectId: `template-${t.id}`, title: t.title, documentType: docTypeOf(req.query.documentType, t.id) }) });
  });

  /**
   * Save a document as a template (approvers and admins). Always taken from the document's last saved version.
   * With `templateId` it adds the next version to that saved template; without, it creates a new template.
   */
  app.post<{ Body: Record<string, any> }>('/api/v1/templates', async (req, reply) => {
    const b = req.body ?? {};
    const src = projectOr404(String(b.projectId ?? ''));
    const existing = b.templateId ? savedOr404(String(b.templateId)) : null;
    if (existing && existing.documentType !== src.documentType) throw new ApiError(400, 'DOCUMENT_TYPE_MISMATCH', `“${existing.title}” is a template for a different kind of document. Save this one as a new template.`);
    const title = titleOf(b.title ?? existing?.title ?? src.title, 'Template name');
    const description = oneLine(b.description ?? existing?.description ?? '', TEMPLATE_DESCRIPTION_MAX);
    const note = oneLine(b.note, TEMPLATE_NOTE_MAX);
    const all = [...builtIn(), ...store.listSavedTemplates()];
    if (all.some((t) => t.id !== existing?.id && t.title.toLowerCase() === title.toLowerCase())) throw new ApiError(409, 'TEMPLATE_NAME_TAKEN', `There is already a template called “${title}”. Choose another name, or save this as a new version of it.`);
    let id = existing?.id ?? `saved-${slug(title)}`;
    if (!existing) for (let i = 2; all.some((t) => t.id === id); i++) id = `saved-${slug(title).slice(0, 36)}-${i}`;
    const content = templateContentOf(src);
    const saved = store.addTemplateVersion({ id, title, description, documentType: src.documentType }, content, {
      savedBy: by(req), note, from: { projectId: src.projectId, title: src.title, modelVersion: src.modelVersion }, counts: templateCounts(content),
    });
    audit(store, req, 'template.save', { projectId: src.projectId, modelVersion: src.modelVersion, detail: { templateId: saved.id, title: saved.title, version: saved.version, newTemplate: !existing } });
    reply.status(201);
    return { template: saved, version: saved.version, created: !existing };
  });

  /** Retire a saved template (hidden from "New project", kept for the record) or bring it back. */
  app.patch<{ Params: { templateId: string }; Body: Record<string, any> }>('/api/v1/templates/:templateId', async (req) => {
    const t = savedOr404(req.params.templateId);
    if (typeof req.body?.retired !== 'boolean') throw new ApiError(400, 'INVALID', 'Send { "retired": true } or { "retired": false }.');
    const next = store.setTemplateRetired(t.id, req.body.retired)!;
    audit(store, req, req.body.retired ? 'template.retire' : 'template.unretire', { detail: { templateId: t.id, title: t.title } });
    return { template: next };
  });

  /** Demo and test reset: removes every saved template. Built-in starters are untouched. */
  app.post<{ Body: Record<string, any> }>('/api/v1/templates/reset', async (req) => {
    if (req.body?.confirm !== true) throw new ApiError(400, 'CONFIRM_REQUIRED', 'Send { "confirm": true } to remove every saved template.');
    const removed = store.clearSavedTemplates();
    audit(store, req, 'template.reset', { detail: { removed } });
    return { removed };
  });

  app.post<{ Body: Record<string, any> }>('/api/v1/projects', async (req, reply) => {
    const body = req.body ?? {};
    const t = templateOr404(String(body.templateId ?? ''));
    const title = titleOf(body.title);
    const id = freeProjectId(title, 'project');
    let project: Project;
    let label = `Created from template ${t.title}`;
    if (t.source === 'saved') {
      const c = savedContent(t, versionOf(body.templateVersion));
      project = checkDraftProject(projectFromSavedTemplate(c.content, { projectId: id, title, templateId: t.id, version: c.version, templateTitle: t.title }), id);
      label = `Created from template “${t.title}” v${c.version}`;
    } else {
      project = checkDraftProject(projectFromTemplate(t.id, { projectId: id, title, documentType: docTypeOf(body.documentType, t.id), ...(t.id === BLANK_PROJECT_TEMPLATE_ID ? issuerOf(body) : {}) }), id);
    }
    const saved = store.putProject(project, projectContentDigest(project), { by: by(req), label });
    // A document with its own data has no shared sample customers: it gets its first customers now (templates never carry any).
    const customers = firstCustomers(store, saved);
    audit(store, req, 'project.create', { projectId: saved.projectId, modelVersion: saved.modelVersion, detail: { title, templateId: t.id, templateTitle: t.title, templateVersion: saved.fromTemplate?.version ?? null, ...(saved.documentType === 'custom' ? { customers } : {}) } });
    reply.status(201);
    return { project: saved, createdFrom: t.id, templateVersion: saved.fromTemplate?.version ?? null, ...(saved.documentType === 'custom' ? { customers } : {}) };
  });

  /**
   * Import a studio project file as a NEW draft document. The file is checked before anything is stored:
   * its shape, every rule, and that the studio can actually work out a document from it for a synthetic customer.
   * It never replaces an existing document, and never brings customers, history, review state or comments.
   * `dryRun: true` returns the same report without storing anything.
   */
  app.post<{ Body: Record<string, any> }>('/api/v1/projects/import', async (req, reply) => {
    const body = req.body ?? {};
    const raw = projectInFile(body.file ?? body.project);
    const problems = projectFileProblems(raw);
    if (problems.length) throw new ApiError(422, 'INVALID_PROJECT_FILE', problems[0].message, { problems });
    const file = raw as Project & Record<string, unknown>;
    if (file.schemaVersion !== SCHEMA_VERSION) throw new ApiError(422, 'SCHEMA_VERSION', `The file uses project format ${file.schemaVersion}; this studio reads ${SCHEMA_VERSION}.`, { problems: [{ code: 'SCHEMA_VERSION', message: `The file uses project format ${file.schemaVersion}; this studio reads ${SCHEMA_VERSION}.` }] });
    const title = titleOf(body.title ?? file.title);
    const id = freeProjectId(title, 'import');
    const { lastSavedAt: _l, derivedFrom: _d, fromTemplate: _f, importedFrom: _i, ...rest } = file;
    const importedFrom = { projectId: String(file.projectId ?? ''), title: String(file.title), modelVersion: Number(file.modelVersion) || 1, importedAt: new Date().toISOString() };
    let project: Project;
    try { project = checkDraftProject({ ...rest, projectId: id, title, modelVersion: 1, importedFrom }, id); }
    catch (e: any) { throw new ApiError(422, 'INVALID_PROJECT_FILE', `The file could not be read as a project: ${e?.message ?? e}`, { problems: [{ code: e?.code ?? 'INVALID', message: e?.message ?? String(e) }] }); }

    // Prove the studio can work out a document from it before storing anything. A document with its own data has no
    // shared customers to try it on, so it is tried on a customer built from its own field definitions.
    const ownData = project.documentType === 'custom';
    const records = allRecords(project.projectId).filter((r) => r.documentType === project.documentType);
    const known = new Set(records.map((r) => r.recordId));
    try {
      const probe: SyntheticRecord | undefined = ownData ? previewRecordOf(project) : records[0];
      if (probe) resolve({ project, record: probe, profileId: 'paged-pdf' });
    }
    catch (e: any) { throw new ApiError(422, 'INVALID_PROJECT_FILE', 'The file has the right shape, but the studio could not work out a document from it, so it was not imported.', { problems: [{ code: 'CANNOT_RESOLVE', message: String(e?.message ?? e).slice(0, 300) }] }); }

    const warnings: string[] = [];
    const lostTests = (project.testCases ?? []).filter((t: any) => t.recordId && !known.has(t.recordId));
    if (lostTests.length) warnings.push(`${lostTests.length} pinned test${lostTests.length === 1 ? ' uses a customer' : 's use customers'} that this studio does not have. ${lostTests.length === 1 ? 'It is' : 'They are'} kept and will fail until ${ownData ? 'they are pointed at one of the new customers' : 'those customers are imported'}.`);
    if (store.getProject(String(file.projectId ?? ''))) warnings.push(`The document this file was exported from (“${store.getProject(String(file.projectId))!.title}”) is still here. The import is a separate new document; nothing is replaced.`);
    if (ownData) warnings.push('A project file never carries customers. New test customers are generated for this document from its data fields and rules.');
    else if ((project.customFields ?? []).length) warnings.push(`${project.customFields!.length} extra data field${project.customFields!.length === 1 ? '' : 's'} came with the file. Synthetic customers here have no values for ${project.customFields!.length === 1 ? 'it' : 'them'} until you add them.`);
    const report = {
      from: { projectId: importedFrom.projectId, title: importedFrom.title, modelVersion: importedFrom.modelVersion },
      counts: templateCounts(project),
      warnings,
      notImported: ['Customers', 'Version history', 'Review state', 'Comments'],
    };
    if (body.dryRun === true) return { dryRun: true, wouldCreate: { projectId: id, title }, report };
    const saved = store.putProject(project, projectContentDigest(project), { by: by(req), label: `Imported from file “${importedFrom.title}” v${importedFrom.modelVersion}` });
    const customers = firstCustomers(store, saved);
    audit(store, req, 'project.import', { projectId: saved.projectId, modelVersion: saved.modelVersion, detail: { title, fromProjectId: importedFrom.projectId, fromTitle: importedFrom.title, fromVersion: importedFrom.modelVersion, warnings: warnings.length, ...(ownData ? { customers } : {}) } });
    reply.status(201);
    return { project: saved, report, ...(ownData ? { customers } : {}) };
  });
}
