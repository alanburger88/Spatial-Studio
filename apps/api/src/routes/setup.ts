import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ACCENT_PATTERN, IMPORT_ID_BASE, IMPORT_LIMIT, ISSUER_NAME_MAX, ISSUER_NAME_MIN, RECORD_ID_PREFIX, TEMPLATE_TITLE_MAX,
  checkSetupSpec, customFieldDefs, isEmptySetupSpec, prepareImport, projectContentDigest, projectFileProblems, projectFromSetupSpec,
  type Project, type SetupSpec, type SyntheticRecord,
} from '@iss/model';
import { resolve } from '@iss/resolver';
import { baselineCustomer, dataShapeOf, planTestData, readSampleData, recordProblems, recordsFromRows, setupOutline, setupSpecFromData, type RowMatch, type SampleRow } from '@iss/scenarios';
import { providerConfig, providerStatus } from '../assistant';
import { externalAssist } from '../assistAi';
import { audit } from '../auth';
import { ensureCustomer, firstCustomers } from '../projectCustomers';
import { SETUP_DESCRIPTION_MAX, SETUP_NEEDS_KEY, draftSetupSpec } from '../setupAi';
import type { RouteDeps } from './deps';

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
/** How many rejected rows are listed with their reasons (the count is always complete). */
const REJECTED_LISTED = 50;

/** Who produced a setup: a model (`ai`) or the studio itself from supplied data (`builtin`). */
type SetupSource = 'ai' | 'builtin';

export interface SuppliedSummary {
  /** Rows in the file. */
  total: number;
  /** Rows that fit the data fields and are (or would be) stored as this document's own customers. */
  accepted: number;
  rejectedCount: number;
  /** The first rejected rows, each with why, in plain words. */
  rejected: Array<{ row: number; reasons: string[] }>;
  /** What each column of the file is used for. */
  matching: RowMatch[];
  notes: string[];
}

/**
 * Set up a new document from a description, from sample data, or both.
 *
 *  - `POST /projects/setup/draft` stores nothing. It returns a PROPOSAL: the setup (drafted by a model from the
 *    description, or by the studio from the data), the project it would become, what will be created in plain words,
 *    what happens to the customers, and what the document does for the first of them.
 *  - `POST /projects/setup` creates the document from the setup a person approved (and may have edited). The project
 *    is built again here, on the server, from the setup alone: a project sent by a client is never used.
 *
 * The assistant proposes and a person approves: nothing here approves, exports or publishes.
 */
export function registerSetupRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, checkDraftProject } = deps;
  const model = deps.assistModel ?? externalAssist;
  const by = (req: FastifyRequest) => (req.user ? { id: req.user.id, name: req.user.name } : null);

  const titleOf = (v: unknown): string => {
    const title = oneLine(v, 200);
    if (title.length < 2 || title.length > TEMPLATE_TITLE_MAX) throw new ApiError(400, 'INVALID_TITLE', `Title must be 2–${TEMPLATE_TITLE_MAX} characters.`);
    return title;
  };
  /** Who the document is from and the issuer's colour, as typed by the person. Both optional; they win over what the setup says. */
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
  const freeProjectId = (title: string): string => {
    let id = slug(title);
    if (id.length < 3) id = `${id}-project`;
    for (let i = 2; store.getProject(id); i++) id = `${slug(title).slice(0, 36)}-${i}`;
    return id;
  };
  /** The rows of the supplied file, or undefined when none was sent. */
  const rowsOf = (sample: unknown): SampleRow[] | undefined => {
    if (sample === undefined || sample === null) return undefined;
    if (typeof sample !== 'object' || Array.isArray(sample)) throw new ApiError(400, 'INVALID_SAMPLE_DATA', 'Send the sample data as { "format": "csv" | "json", "data": … }.');
    const s = sample as { format?: unknown; data?: unknown };
    const read = readSampleData(s.format, s.data);
    if ('error' in read) throw new ApiError(400, 'INVALID_SAMPLE_DATA', read.error);
    if (read.rows.length > IMPORT_LIMIT) throw new ApiError(413, 'IMPORT_TOO_LARGE', `At most ${IMPORT_LIMIT} customers can be supplied at once.`);
    return read.rows;
  };

  /** The supplied rows as customers of `project`: which fit, which do not and why, and how the columns were matched. Stores nothing. */
  function suppliedFor(project: Project, rows: SampleRow[]): { records: Array<Omit<SyntheticRecord, 'recordId'>>; summary: SuppliedSummary } {
    const { records, matching, notes } = recordsFromRows(rows, project);
    const prepared = prepareImport(records, 'custom', IMPORT_ID_BASE, customFieldDefs(project.customFields));
    const accepted = prepared.filter((r) => r.record).map((r) => { const { recordId: _provisional, ...rest } = r.record!; return rest; });
    const bad = prepared.filter((r) => !r.record);
    return {
      records: accepted,
      summary: {
        total: rows.length, accepted: accepted.length, rejectedCount: bad.length,
        // Reasons name the fields as a person reads them, never their paths.
        rejected: bad.slice(0, REJECTED_LISTED).map((r) => { const plain = recordProblems(records[r.row - 1], project); return { row: r.row, reasons: (plain.length ? plain : r.errors).slice(0, 6) }; }),
        matching, notes,
      },
    };
  }

  /** What the document does for one customer as issued: the message versions chosen and any blocking issue. Never throws. */
  function previewOf(project: Project, record: SyntheticRecord, origin: 'supplied' | 'generated') {
    const customer = { name: `${record.customer.givenName} ${record.customer.familyName}`.trim(), origin };
    try {
      const res = resolve({ project, record });
      return {
        customer,
        messages: Object.entries(res.result.selectedVariants).map(([nodeId, variantId]) => ({ section: project.nodes.find((n) => n.id === nodeId)?.name ?? 'Message', version: variantId ? project.contentParts.find((c) => c.id === variantId)?.title ?? null : null })),
        blocking: res.findings.filter((f) => f.severity === 'blocking').map((f) => ({ code: f.code, message: f.message })),
      };
    } catch (e: any) {
      return { customer, messages: [], blocking: [{ code: 'CANNOT_RESOLVE', message: String(e?.message ?? e).slice(0, 300) }] };
    }
  }

  /** The setup with the title, issuer and colour the person typed, checked, and the project it builds. */
  function build(rawSpec: unknown, overrides: { title?: string; issuerName?: string; accent?: string }, projectId: string) {
    const first = checkSetupSpec(rawSpec);
    const spec: SetupSpec = { ...first.spec, ...(overrides.title ? { title: overrides.title } : {}), ...(overrides.issuerName ? { issuerName: overrides.issuerName } : {}), ...(overrides.accent ? { accent: overrides.accent } : {}) };
    const built = projectFromSetupSpec(spec, { projectId, title: spec.title });
    return { spec: checkSetupSpec(spec).spec, project: built.project, notes: [...new Set([...first.notes, ...built.notes])] };
  }

  /** How many test customers generating would create for this document (every outcome once, plus the edge values). */
  function generatedCount(project: Project): number {
    try { return Math.max(1, planTestData(project, [], { outcomes: true, edges: true }).customers.length); }
    catch { return 1; }
  }

  app.post<{ Body: Record<string, any> }>('/api/v1/projects/setup/draft', async (req) => {
    const b = req.body ?? {};
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    if (b.description !== undefined && b.description !== null && typeof b.description !== 'string') throw new ApiError(400, 'INVALID', 'The description must be text.');
    if (description.length > SETUP_DESCRIPTION_MAX) throw new ApiError(400, 'TOO_LONG', 'The description is limited to 2,000 characters.');
    const rows = rowsOf(b.sampleData);
    if (!description && !rows) throw new ApiError(400, 'NOTHING_TO_SET_UP', 'Describe the document, supply sample data, or both.');
    const title = b.title === undefined || b.title === null || b.title === '' ? undefined : titleOf(b.title);
    const issuer = issuerOf(b);
    const cfg = providerConfig();
    if (b.forceOffline === true) cfg.provider = 'offline';
    const status = providerStatus(cfg);
    const live = status.mode === 'external';

    let source: SetupSource = 'builtin';
    let rawSpec: unknown;
    let message: string;
    const notes: string[] = [];
    const ai = description && live ? await draftSetupSpec(cfg, model, { description, dataShape: rows ? dataShapeOf(rows) : undefined, title, issuerName: issuer.issuerName }) : null;
    if (ai?.mode === 'ai' && ai.spec) {
      source = 'ai';
      rawSpec = ai.spec;
      message = ai.message;
      notes.push(...ai.notes);
    } else if (rows) {
      // Without a model, or when it gave nothing usable, the data alone still describes a document.
      const fromData = setupSpecFromData(rows, { title, issuerName: issuer.issuerName });
      rawSpec = fromData.spec;
      message = 'Set up by the studio from your sample data, without an AI model. Every guess is listed in the notes; change what is not right, then create the document.';
      if (ai) notes.push('The AI model did not return a usable setup, so your description was not used: this setup comes from the data alone.');
      else if (description) notes.push('No AI key is configured, so your description was not used: this setup comes from the data alone.');
      notes.push(...fromData.notes);
    } else {
      // A description on its own needs a model.
      return ai ? { mode: 'unavailable' as const, providerStatus: ai.providerStatus, message: ai.message, notes: ai.notes } : { mode: 'unavailable' as const, providerStatus: status.label, message: SETUP_NEEDS_KEY, notes: [] };
    }

    const wanted = title ?? checkSetupSpec(rawSpec).spec.title;
    const projectId = freeProjectId(wanted);
    const built = build(rawSpec, { title, ...issuer }, projectId);
    notes.push(...built.notes);
    const supplied = rows ? suppliedFor(built.project, rows) : null;
    const first = supplied?.records[0];
    const preview = first
      ? previewOf(built.project, { ...first, recordId: 'REC-0000' } as SyntheticRecord, 'supplied')
      : previewOf(built.project, { ...baselineCustomer(built.project).record, recordId: 'REC-0000' } as SyntheticRecord, 'generated');
    return {
      mode: 'proposal' as const,
      source,
      providerStatus: status.label,
      message,
      wouldCreate: { projectId, title: built.spec.title },
      spec: built.spec,
      project: built.project,
      notes: [...new Set(notes)],
      outline: setupOutline(built.spec, built.project),
      customers: { generated: { count: generatedCount(built.project) }, supplied: supplied?.summary ?? null },
      preview,
    };
  });

  app.post<{ Body: Record<string, any> }>('/api/v1/projects/setup', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.spec || typeof b.spec !== 'object' || Array.isArray(b.spec)) throw new ApiError(400, 'INVALID_SETUP', 'Send the document setup as "spec".');
    const title = titleOf(b.title);
    const issuer = issuerOf(b);
    const choice = b.customers;
    if (choice !== 'generate' && choice !== 'supplied' && choice !== 'both') throw new ApiError(400, 'INVALID', '"customers" must be "generate", "supplied" or "both".');
    const rows = choice === 'generate' ? undefined : rowsOf(b.sampleData);
    if (choice !== 'generate' && !rows) throw new ApiError(400, 'SAMPLE_DATA_REQUIRED', 'Supply the sample data to use it for this document’s customers, or choose generated customers.');
    // Who drafted the setup is what the studio told the person when it proposed it; the studio keeps no draft to look it up in.
    const source: SetupSource = b.source === 'ai' ? 'ai' : 'builtin';

    const id = freeProjectId(title);
    // The project is built here from the setup alone. Whatever else a client sends (a project, components, rules) is not read.
    const built = build(b.spec, { title, ...issuer }, id);
    if (isEmptySetupSpec(built.spec)) throw new ApiError(422, 'EMPTY_SETUP', 'There is nothing to set up: the setup has no data field and no section left after it was checked.', { notes: built.notes });
    const problems = projectFileProblems(built.project);
    if (problems.length) throw new ApiError(422, 'INVALID_SETUP', problems[0].message, { problems });
    const project = checkDraftProject(built.project, id);
    // Prove the studio can work out a document from it before storing anything.
    try { resolve({ project, record: { ...baselineCustomer(project).record, recordId: 'REC-0000' } as SyntheticRecord, profileId: 'paged-pdf' }); }
    catch (e: any) { throw new ApiError(422, 'INVALID_SETUP', 'The studio could not work out a document from this setup, so nothing was created.', { problems: [{ code: 'CANNOT_RESOLVE', message: String(e?.message ?? e).slice(0, 300) }] }); }
    const supplied = rows ? suppliedFor(project, rows) : null;

    const saved = store.putProject(project, projectContentDigest(project), { by: by(req), label: source === 'ai' ? 'Set up from a description (AI suggestion, approved by a person)' : 'Set up from sample data' });
    // Supplied rows first: generated customers then start from them. A document with its own data is never left without a customer.
    if (supplied?.records.length) store.addProjectRecords(saved.projectId, RECORD_ID_PREFIX.custom, 'supplied', supplied.records);
    if (choice === 'supplied') ensureCustomer(store, saved); else firstCustomers(store, saved);
    const generated = store.projectRecords(saved.projectId, 'generated');
    const mine = store.projectRecords(saved.projectId, 'supplied');
    const total = generated.length + mine.length;
    const startingCustomerOnly = choice === 'supplied' && !mine.length;
    const notes = [...built.notes];
    if (startingCustomerOnly) notes.push('None of the supplied rows could be used, so one starting customer was created to preview the document with.');

    audit(store, req, 'project.create', { projectId: saved.projectId, modelVersion: saved.modelVersion, detail: { title, setup: source, customers: total, generated: generated.length, supplied: mine.length, rejected: supplied?.summary.rejectedCount ?? 0, notes: notes.length } });
    reply.status(201);
    return {
      project: saved,
      source,
      notes,
      customers: { total, generated: generated.length, supplied: supplied?.summary ?? null, startingCustomerOnly },
      preview: previewOf(saved, mine[0] ?? generated[0], mine[0] ? 'supplied' : 'generated'),
    };
  });
}
