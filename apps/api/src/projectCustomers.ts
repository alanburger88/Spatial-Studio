import { projectContentDigest, RECORD_ID_PREFIX, type Project, type SyntheticRecord } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { baselineCustomer, planTestData, type TestDataPlan } from '@iss/scenarios';
import type { Store } from './db';

/**
 * Customers that belong to ONE project: the generated test customers every kind of document can have, and, for a
 * document with its own data ("custom"), the only customers there are. Such a project has no shared sample customers,
 * so it is given its first customers when it is created and is never left without one.
 */

/** What to generate. `issueDate`: "as issued on" (documents that use dates); the outcomes are reached on that day. */
export interface TestDataChoice { outcomes: boolean; edges: boolean; issueDate?: string | null }

/** Shared customers of this kind of document that the generator may start from (never earlier generated ones). */
export const baseRecordsFor = (store: Store, project: Project): SyntheticRecord[] =>
  [...RECORDS, ...store.importedRecords(), ...store.projectRecords(project.projectId, 'supplied')].filter((r) => r.documentType === project.documentType);

export const publicPlan = (plan: TestDataPlan, ids: string[] = []) => ({
  summary: plan.summary,
  targets: plan.targets.map((t) => ({ ...t, recordId: t.customer === null ? null : ids[t.customer] ?? null })),
  customers: plan.customers.map((c, i) => ({ recordId: ids[i] ?? null, name: `${c.record.customer.givenName} ${c.record.customer.familyName}`, label: c.label, locale: c.record.customer.locale, targets: c.targets.length, ...(c.issueDate ? { issueDate: c.issueDate } : {}) })),
});

const prefixOf = (project: Project): string => RECORD_ID_PREFIX[project.documentType] ?? 'REC';
const nameOf = (r: Pick<SyntheticRecord, 'customer'>): string => `${r.customer.givenName} ${r.customer.familyName}`.trim();

/**
 * Plans test customers for `project` (the saved model, or the unsaved one the studio sent), stores them in place of the
 * project's previous generated customers and remembers what the generation covered.
 */
export function generateTestCustomers(store: Store, project: Project, options: TestDataChoice, saved: Project = project) {
  const plan = planTestData(project, baseRecordsFor(store, project), options);
  const removed = store.clearProjectRecords(project.projectId, 'generated');
  const stored = store.addProjectRecords(project.projectId, prefixOf(project), 'generated', plan.customers.map((c) => ({ ...c.record, documentType: project.documentType, generated: { label: c.label } })));
  const pub = publicPlan(plan, stored.map((r) => r.recordId));
  store.setTestDataPlan(project.projectId, { ...pub, options, forModelVersion: project.modelVersion, forDigest: projectContentDigest(project), unsavedModel: projectContentDigest(project) !== projectContentDigest(saved) });
  // A document with its own data must keep a customer to preview with, even when nothing could be planned.
  const baseline = ensureCustomer(store, project);
  return { plan, pub, stored: baseline ? [...stored, baseline.record] : stored, removed, baseline };
}

/**
 * A document with its own data that has no customer left (its generated or supplied customers were removed) gets one
 * starting customer built from its field definitions. Returns it, or null when nothing had to be created
 * (the project still has customers, or it is one of the built-in kinds, which always have the shared samples).
 */
export function ensureCustomer(store: Store, project: Project): { record: SyntheticRecord; name: string; label: string } | null {
  if (project.documentType !== 'custom' || store.projectRecords(project.projectId).length) return null;
  const b = baselineCustomer(project);
  const [record] = store.addProjectRecords(project.projectId, prefixOf(project), 'generated', [{ ...b.record, documentType: project.documentType, generated: { label: b.label } }]);
  return { record, name: nameOf(record), label: b.label };
}

/**
 * The first customers of a newly created document with its own data (from the blank starter, a saved template, a
 * project file or a copy): every outcome once and the edge values, planned from the field definitions alone.
 * Nothing happens for the built-in kinds. Returns how many customers the project now has.
 */
export function firstCustomers(store: Store, project: Project): number {
  if (project.documentType !== 'custom') return 0;
  // The project is already stored at this point: whatever happens while planning, it must not be left without a customer.
  try { generateTestCustomers(store, project, { outcomes: true, edges: true }); }
  catch { ensureCustomer(store, project); }
  return store.projectRecords(project.projectId).length;
}
