import type { FastifyInstance } from 'fastify';
import { customFieldDefs, deepClone, projectFieldIndex, validateRecordShape, type Project, type SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import { audit } from '../auth';
import type { RouteDeps } from './deps';

const PREFIX: Record<string, string> = { 'credit-statement': 'CARD', eob: 'EOB' };
const MAX_BYTES = 400_000;
/** Bookkeeping the studio owns; never taken from what a person sends. */
const OWNED = ['recordId', 'documentType', 'projectId', 'generated', 'imported', 'sourceId', 'demonstrationOnly'] as const;

/**
 * Data Explorer: a project's own customers as whole nested records.
 * Sample and imported customers are shared by every project and are never changed here; "make an editable copy"
 * creates a record that belongs to this project alone. A generated customer that a person edits becomes theirs,
 * so generating again does not overwrite it.
 */
export function registerRecordRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, projectOr404, allRecords } = deps;

  /** Each problem with the field it is about (taken from the "(path)" the validator puts in its message), for showing beside the field. */
  const problemsOf = (record: unknown, project: Project) => {
    const fields = projectFieldIndex(project);
    return validateRecordShape(record, project.documentType, customFieldDefs(project.customFields)).map((message) => {
      // A list row is reported as "card.transactions[2].amountCents: …"; say it with the list's and the column's names.
      const row = /^([A-Za-z0-9_.]+)\[(\d+)\]\.([A-Za-z0-9_]+): (.*)$/.exec(message);
      if (row) {
        const list = fields.get(row[1]);
        const column = list?.itemFields?.find((c) => c.key === row[3]);
        return { path: `${row[1]}[${row[2]}].${row[3]}`, message: `${list?.label ?? row[1]}, row ${Number(row[2]) + 1}, ${column?.label ?? row[3]}: ${row[4]}` };
      }
      return { path: /\(([A-Za-z0-9_.[\]]+)\)/.exec(message)?.[1] ?? null, message };
    });
  };

  /** The data a person sent, without the bookkeeping fields. */
  const dataOf = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'INVALID_RECORD', 'Send the customer as one object.');
    if (JSON.stringify(raw).length > MAX_BYTES) throw new ApiError(413, 'RECORD_TOO_LARGE', 'This customer is too large to store (about 400 KB at most).');
    const data = deepClone(raw) as Record<string, unknown>;
    for (const k of OWNED) delete data[k];
    return data;
  };
  const checked = (project: Project, data: Record<string, unknown>) => {
    const problems = problemsOf(data, project);
    if (problems.length) throw new ApiError(422, 'INVALID_RECORD', `${problems.length} value${problems.length === 1 ? ' does' : 's do'} not fit the data fields.`, { problems });
    return data;
  };
  /** What the document does for this customer as issued: the messages chosen and any blocking issue. Never throws. */
  const outcomeOf = (project: Project, record: SyntheticRecord) => {
    try {
      const res = resolve({ project, record });
      return {
        messages: Object.entries(res.result.selectedVariants).map(([nodeId, variantId]) => ({ nodeId, node: project.nodes.find((n) => n.id === nodeId)?.name ?? nodeId, variantId, variant: variantId ? project.contentParts.find((c) => c.id === variantId)?.title ?? variantId : null })),
        blocking: res.findings.filter((f) => f.severity === 'blocking').map((f) => ({ code: f.code, message: f.message })),
      };
    } catch (e: any) {
      return { messages: [], blocking: [{ code: 'CANNOT_RESOLVE', message: String(e?.message ?? e).slice(0, 300) }] };
    }
  };
  const ownOr404 = (project: Project, recordId: string) => {
    const origin = store.projectRecordOrigin(project.projectId, recordId);
    const record = origin ? store.projectRecord(recordId) : undefined;
    if (!origin || !record) {
      const shared = allRecords().find((r) => r.recordId === recordId && r.documentType === project.documentType);
      if (shared) throw new ApiError(409, 'RECORD_SHARED', `${shared.customer.givenName} ${shared.customer.familyName} is a ${shared.imported ? 'customer imported for every project' : 'sample customer'} and cannot be changed here. Make an editable copy for this document instead.`);
      throw new ApiError(404, 'NOT_FOUND', 'This document has no such customer.');
    }
    return { origin, record };
  };

  /** Check a customer against the document's data fields and say what the document would do for them. Stores nothing. */
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/records/check', async (req) => {
    const project = projectOr404(req.params.projectId);
    const data = dataOf(req.body?.record);
    const problems = problemsOf(data, project);
    return { problems, outcome: problems.length ? null : outcomeOf(project, { ...(data as any), recordId: 'CHECK-0000', documentType: project.documentType }) };
  });

  /** Add a customer that belongs to this document: from the data sent, or as an editable copy of an existing customer (`copyOf`). */
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/records', async (req, reply) => {
    const project = projectOr404(req.params.projectId);
    const b = req.body ?? {};
    let data: Record<string, unknown>;
    let copiedFrom: SyntheticRecord | undefined;
    if (typeof b.copyOf === 'string') {
      copiedFrom = allRecords(project.projectId).find((r) => r.recordId === b.copyOf && r.documentType === project.documentType);
      if (!copiedFrom) throw new ApiError(404, 'NOT_FOUND', 'There is no such customer to copy for this document.');
      data = dataOf(copiedFrom);
    } else data = checked(project, dataOf(b.record));
    const [stored] = store.addProjectRecords(project.projectId, PREFIX[project.documentType] ?? 'REC', 'supplied', [{ ...(data as any), documentType: project.documentType }]);
    audit(store, req, 'records.add', { projectId: project.projectId, detail: { recordId: stored.recordId, name: `${stored.customer.givenName} ${stored.customer.familyName}`, copyOf: copiedFrom?.recordId ?? null } });
    reply.status(201);
    return { record: stored, origin: 'supplied', copiedFrom: copiedFrom?.recordId ?? null, outcome: outcomeOf(project, stored) };
  });

  /** Save changes to one of this document's own customers. An edited generated customer becomes the document's own. */
  app.put<{ Params: { projectId: string; recordId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/records/:recordId', async (req) => {
    const project = projectOr404(req.params.projectId);
    const { origin, record: before } = ownOr404(project, req.params.recordId);
    const data = checked(project, dataOf(req.body?.record));
    const next = { ...(data as any), recordId: before.recordId, documentType: project.documentType, projectId: project.projectId } as SyntheticRecord;
    store.updateProjectRecord(project.projectId, next);
    audit(store, req, 'records.edit', { projectId: project.projectId, detail: { recordId: next.recordId, name: `${next.customer.givenName} ${next.customer.familyName}`, wasGenerated: origin === 'generated' } });
    return { record: next, origin: 'supplied', wasGenerated: origin === 'generated', outcome: outcomeOf(project, next) };
  });

  /** Remove one of this document's own customers. Sample and imported customers cannot be removed here. */
  app.delete<{ Params: { projectId: string; recordId: string } }>('/api/v1/projects/:projectId/records/:recordId', async (req) => {
    const project = projectOr404(req.params.projectId);
    const { record } = ownOr404(project, req.params.recordId);
    store.deleteProjectRecord(project.projectId, record.recordId);
    audit(store, req, 'records.delete', { projectId: project.projectId, detail: { recordId: record.recordId, name: `${record.customer.givenName} ${record.customer.familyName}` } });
    return { removed: record.recordId };
  });
}
