import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Project, ReleaseKnownDataProblem, SyntheticRecord } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { customerBlockers, knownDataProblemRefusal, splitKnownDataProblems, type CustomerBlocker } from '@iss/scenarios';
import { audit } from '../auth';
import type { Store, StoredKnownDataProblem } from '../db';
import type { RouteDeps } from './deps';

/**
 * Known data problems: an approver sets aside ONE customer-data blocker for ONE customer, with a reason. The rules
 * (which blockers qualify, when an entry lapses, what a customer set aside counts as) are pure and live in
 * `@iss/scenarios` (`blockers.ts`); this file stores entries, checks requests against the SAVED document and the
 * customers the studio holds, and removes entries that have lapsed, saying so in the answer. Routes: docs/api/KNOWN_DATA_PROBLEMS.md.
 */

/** Every customer the studio holds for a document (samples, imported, the document's own), as `allRecords(projectId)` gives them. */
export function recordsOf(store: Store, projectId: string): SyntheticRecord[] {
  return [...RECORDS, ...store.importedRecords(), ...store.projectRecords(projectId)];
}

const nameOf = (r: SyntheticRecord): string => `${r.customer?.givenName ?? ''} ${r.customer?.familyName ?? ''}`.trim() || r.recordId;

export interface KnownInForce extends StoredKnownDataProblem { blocker: Pick<CustomerBlocker, 'title' | 'kind' | 'fields'>; customer: SyntheticRecord }

/**
 * Which stored entries are in force for the document as saved, and which have lapsed (the blocker no longer stops that
 * customer because the customer's data or the document changed, or the customer is gone). One resolution per customer
 * that has an entry; nothing is changed.
 */
export function knownDataStatus(store: Store, project: Project, records: SyntheticRecord[]): { active: KnownInForce[]; lapsed: StoredKnownDataProblem[] } {
  const stored = store.knownDataProblems(project.projectId);
  if (!stored.length) return { active: [], lapsed: [] };
  const byRecord = new Map<string, { record: SyntheticRecord; blockers: CustomerBlocker[] } | null>();
  const of = (recordId: string) => {
    if (!byRecord.has(recordId)) {
      const record = records.find((r) => r.recordId === recordId && r.documentType === project.documentType);
      byRecord.set(recordId, record ? { record, blockers: customerBlockers(project, record) } : null);
    }
    return byRecord.get(recordId)!;
  };
  const { active, lapsed } = splitKnownDataProblems(stored, (recordId, blockerId) => !!of(recordId)?.blockers.some((b) => b.id === blockerId));
  return {
    active: (active as StoredKnownDataProblem[]).map((k) => {
      const c = of(k.recordId)!;
      const b = c.blockers.find((x) => x.id === k.blockerId)!;
      return { ...k, blocker: { title: b.title, kind: b.kind, fields: b.fields }, customer: c.record };
    }),
    lapsed: lapsed as StoredKnownDataProblem[],
  };
}

/** Removes lapsed entries, each audited, and says so in plain words (null when nothing lapsed). */
export function removeLapsed(store: Store, req: FastifyRequest | null, project: Project, lapsed: StoredKnownDataProblem[], records: SyntheticRecord[]): string | null {
  if (!lapsed.length) return null;
  for (const k of lapsed) {
    store.removeKnownDataProblem(project.projectId, k.id);
    const r = records.find((x) => x.recordId === k.recordId);
    const detail = { id: k.id, blockerId: k.blockerId, recordId: k.recordId, name: r ? nameOf(r) : null, why: r ? 'no-longer-stops' : 'customer-gone' };
    if (req) audit(store, req, 'known-data.lapse', { projectId: project.projectId, modelVersion: project.modelVersion, detail });
    else store.audit({ user: null, userName: null, action: 'known-data.lapse', projectId: project.projectId, modelVersion: project.modelVersion, detail });
  }
  return lapsed.length === 1
    ? '1 known data problem no longer applies, because the problem no longer stops that customer, so it was removed.'
    : `${lapsed.length} known data problems no longer apply, because the problems no longer stop those customers, so they were removed.`;
}

/** An entry as the API returns it: what was set aside, for whom, why, by whom and when. */
function view(k: KnownInForce, project: Project, store: Store) {
  const origin = RECORDS.some((r) => r.recordId === k.recordId) ? 'sample' : store.projectRecordOrigin(project.projectId, k.recordId) ?? 'imported';
  return { id: k.id, blockerId: k.blockerId, recordId: k.recordId, reason: k.reason, markedBy: k.markedBy, markedAt: k.markedAt, blocker: { title: k.blocker.title, kind: k.blocker.kind, fields: k.blocker.fields }, customer: { name: nameOf(k.customer), origin } };
}
export type KnownDataProblemView = ReturnType<typeof view>;

/** The known data problems in force for a document, as the API and the approval check list them; lapsed entries are removed first. */
export function knownDataProblemsInForce(store: Store, req: FastifyRequest | null, project: Project, records: SyntheticRecord[]): { list: KnownDataProblemView[]; active: KnownInForce[]; lapsedNote: string | null; lapsed: StoredKnownDataProblem[] } {
  const { active, lapsed } = knownDataStatus(store, project, records);
  const lapsedNote = removeLapsed(store, req, project, lapsed, records);
  return { list: active.map((k) => view(k, project, store)), active, lapsedNote, lapsed };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a release records about the known data problems in force for `project`: never customer data. A built-in sample
 * or engine-generated customer is named by id; any other customer has no id and no name, and their name is taken out of
 * the reason. Reads only; lapsed entries are simply not recorded.
 */
export function releaseKnownDataProblems(store: Store, project: Project): ReleaseKnownDataProblem[] {
  const { active } = knownDataStatus(store, project, recordsOf(store, project.projectId));
  return active.map((k): ReleaseKnownDataProblem => {
    const sample = RECORDS.some((r) => r.recordId === k.recordId);
    const origin = sample ? 'sample' : store.projectRecordOrigin(project.projectId, k.recordId);
    const synthetic = sample || origin === 'generated';
    let reason = k.reason;
    if (!synthetic) {
      const names = [nameOf(k.customer), k.customer.customer?.givenName, k.customer.customer?.familyName, k.recordId].filter((n): n is string => typeof n === 'string' && n.trim().length >= 2);
      for (const n of names) reason = reason.replace(new RegExp(escapeRe(n.trim()), 'gi'), 'the customer');
    }
    return {
      blockerId: k.blockerId, blocker: k.blocker.title,
      customer: synthetic ? { kind: sample ? 'sample' : 'generated', id: k.recordId } : { kind: origin === 'supplied' ? 'supplied' : 'imported' },
      reason, markedBy: k.markedBy?.name ?? null, markedAt: k.markedAt,
    };
  });
}

export function registerKnownDataRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, projectOr404, allRecords } = deps;
  const base = '/api/v1/projects/:projectId/known-data-problems';

  /** The known data problems in force for the saved document. Entries that lapsed are removed now, and the answer says so. */
  app.get<{ Params: { projectId: string } }>(base, async (req) => {
    const project = projectOr404(req.params.projectId);
    const { list, lapsedNote, lapsed } = knownDataProblemsInForce(store, req, project, allRecords(project.projectId));
    return { projectId: project.projectId, modelVersion: project.modelVersion, knownDataProblems: list, lapsed: lapsed.map((k) => ({ id: k.id, blockerId: k.blockerId, recordId: k.recordId })), note: lapsedNote };
  });

  /** Sets one customer-data blocker aside for one customer. Approvers only (see auth.ts); refused for any blocker in the document itself. */
  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>(base, async (req, reply) => {
    const project = projectOr404(req.params.projectId);
    const b = req.body ?? {};
    const blockerId = typeof b.blockerId === 'string' ? b.blockerId.trim() : '';
    const recordId = typeof b.recordId === 'string' ? b.recordId.trim() : '';
    if (!blockerId || !recordId) throw new ApiError(400, 'INVALID_REQUEST', 'Say which blocker (blockerId) and which customer (recordId).');
    const records = allRecords(project.projectId);
    const customer = records.find((r) => r.recordId === recordId && r.documentType === project.documentType) ?? null;
    const refusal = knownDataProblemRefusal({ blockerId, reason: b.reason, customer, blockers: customer ? customerBlockers(project, customer) : [] });
    if (refusal) throw new ApiError(refusal.status, refusal.code, refusal.message);
    const { lapsedNote, lapsed } = knownDataProblemsInForce(store, req, project, records);
    const reason = String(b.reason).trim();
    const stored = store.addKnownDataProblem({ projectId: project.projectId, blockerId, recordId, reason, by: req.user ? { id: req.user.id, name: req.user.name } : null });
    if (!stored) throw new ApiError(409, 'ALREADY_KNOWN', 'This problem is already set aside for this customer.');
    const entry = knownDataStatus(store, project, records).active.find((k) => k.id === stored.id)!;
    audit(store, req, 'known-data.add', { projectId: project.projectId, modelVersion: project.modelVersion, detail: { id: stored.id, blockerId, recordId, name: nameOf(customer!), blocker: entry.blocker.title, reasonLength: reason.length } });
    reply.status(201);
    return { knownDataProblem: view(entry, project, store), lapsed: lapsed.map((k) => ({ id: k.id, blockerId: k.blockerId, recordId: k.recordId })), note: lapsedNote };
  });

  /** Removes a known data problem: the blocker stops that customer again. Approvers only. */
  app.delete<{ Params: { projectId: string; id: string } }>(`${base}/:id`, async (req) => {
    const project = projectOr404(req.params.projectId);
    const found = store.knownDataProblem(project.projectId, req.params.id);
    if (!found) throw new ApiError(404, 'NOT_FOUND', 'There is no such known data problem for this document; it may already have been removed or have lapsed.');
    store.removeKnownDataProblem(project.projectId, found.id);
    const records = allRecords(project.projectId);
    const r = records.find((x) => x.recordId === found.recordId);
    audit(store, req, 'known-data.remove', { projectId: project.projectId, modelVersion: project.modelVersion, detail: { id: found.id, blockerId: found.blockerId, recordId: found.recordId, name: r ? nameOf(r) : null } });
    const { lapsedNote, lapsed } = knownDataProblemsInForce(store, req, project, records);
    return { removed: found.id, lapsed: lapsed.map((k) => ({ id: k.id, blockerId: k.blockerId, recordId: k.recordId })), note: lapsedNote };
  });
}
