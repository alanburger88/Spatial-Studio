import { projectContentDigest, type Project, type SyntheticRecord } from '@iss/model';
import { EXTRA_SAMPLES, type ExtraSample } from '@iss/model/samples/index';
import { resolve } from '@iss/resolver';
import { blockerIdOf } from '@iss/scenarios';
import type { Store } from './db';
import { ProofStore, produceOne, proofFor } from './proofs';
import { releaseTemplate, type PackageComposer } from './releasePackage';
import { createRelease, promoteRelease } from './releases';

/**
 * The built-in example documents beyond the two fixture samples (`@iss/model/samples`): seeded on the first start with
 * their own customers (stable ids, origin `sample`), their known data problem, and — for Northwind — release 1 approved
 * and in Production with a working version that differs from it, and a few proof records produced from that release.
 *
 * Seeding is idempotent: a sample whose document already exists is left exactly as it is (a person may have edited it),
 * so restarting on an existing data folder changes nothing. "Restore sample" (`restoreExtraSample`) puts one back.
 */

/** Who the seeded approvals, releases and known data problems are recorded as. */
export const SAMPLE_ACTOR = { id: 'studio-samples', name: 'Studio samples' } as const;

/** The customer-data blockers a sample sets aside on purpose (its notes), as the studio stores them. */
function seedKnownDataProblems(store: Store, sample: ExtraSample, project: Project): void {
  for (const k of sample.notes.knownDataProblems) {
    const record = sample.customers.find((c) => c.recordId === k.recordId);
    if (!record) throw new Error(`${project.projectId}: no customer ${k.recordId} for the known data problem.`);
    const finding = resolve({ project, record }).findings.find((f) => f.severity === 'blocking' && f.code === k.code && (!k.nodeId || f.nodeId === k.nodeId));
    if (!finding) throw new Error(`${project.projectId}: ${k.recordId} is not stopped by ${k.code}, so it cannot be set aside.`);
    store.addKnownDataProblem({ projectId: project.projectId, blockerId: blockerIdOf(finding), recordId: k.recordId, reason: k.reason, by: { ...SAMPLE_ACTOR } });
  }
}

/** One sample's release history: release 1 (the released content) approved and in Production, then the working version saved over it. */
function seedRelease(store: Store, sample: ExtraSample): void {
  const working = sample.project;
  const released = { ...sample.release!.project, modelVersion: 1 };
  store.putProject(released, projectContentDigest(working), { label: `${sample.release!.label}` });
  seedKnownDataProblems(store, sample, released);
  const now = new Date().toISOString();
  store.setWorkflow(released.projectId, 'approve', 'approved', 1, projectContentDigest(released), { ...SAMPLE_ACTOR }, 'Approved as release 1 of the example document.');
  const made = createRelease(store, released, { approvedBy: { ...SAMPLE_ACTOR }, approvedAt: now, createdBy: { ...SAMPLE_ACTOR }, origin: 'approval' });
  promoteRelease(store, made.release, { ...SAMPLE_ACTOR }, 'Release 1 of the example document, in Production from the start.');
  // The working version differs from release 1 (one wording change, one rule change). Saving it returns the document to Draft.
  store.putProject({ ...working, modelVersion: 2 }, projectContentDigest(working), { by: { ...SAMPLE_ACTOR }, label: 'Working version of the example (differs from release 1)' });
}

/**
 * Seeds every extra sample whose document does not exist yet. Returns the ids seeded now. Synchronous and pure apart
 * from the store; the proof records (which need the release) are added by `seedSampleProofs`.
 */
export function seedExtraSamples(store: Store, only?: string): string[] {
  const seeded: string[] = [];
  for (const sample of EXTRA_SAMPLES()) {
    const id = sample.project.projectId;
    if (only && id !== only) continue;
    if (store.getProject(id)) continue;
    store.putSampleRecords(id, sample.customers as SyntheticRecord[], 'replace');
    // A document id that already has releases (the sample was seeded once and its releases kept) gets no second release 1.
    if (sample.release && !store.hasReleases(id)) seedRelease(store, sample);
    else {
      store.putProject({ ...sample.project, modelVersion: 1 }, projectContentDigest(sample.project), { label: 'Approved sample' });
      seedKnownDataProblems(store, sample, sample.project);
    }
    seeded.push(id);
  }
  return seeded;
}

/** The customers whose outputs the seeded proof records are for: one of each payment message, in English and Spanish. */
export const SAMPLE_PROOF_CUSTOMERS: Record<string, string[]> = { 'northwind-energy-demo': ['NWE-60001', 'NWE-60003', 'NWE-60005', 'NWE-60007'] };

/**
 * A few proof records produced by the studio from each seeded release (web page, email and SMS: no PDF, so no browser
 * is needed). Only for the samples seeded now, so a restart adds nothing.
 */
export async function seedSampleProofs(store: Store, seeded: string[]): Promise<number> {
  const proofs = new ProofStore(store);
  const noBrowser: PackageComposer = { pdf: async () => { throw new Error('Seeded proofs are produced without a PDF.'); } } as unknown as PackageComposer;
  let added = 0;
  for (const id of seeded) {
    const sample = EXTRA_SAMPLES().find((s) => s.project.projectId === id);
    const release = store.releases(id).find((r) => r.stages.production?.status === 'current');
    if (!sample || !release) continue;
    const frozen = store.releaseProject(release.id);
    if (!frozen) continue;
    const template = releaseTemplate(frozen);
    const producedAt = new Date().toISOString();
    for (const recordId of SAMPLE_PROOF_CUSTOMERS[id] ?? []) {
      const record = sample.customers.find((c) => c.recordId === recordId) as SyntheticRecord | undefined;
      if (!record) continue;
      const produced = await produceOne(template, record, ['email', 'sms', 'html'], noBrowser);
      if (proofs.add(proofFor(release, produced, record, producedAt), { source: 'studio', by: { ...SAMPLE_ACTOR } }) === 'added') added += 1;
    }
  }
  return added;
}

/**
 * "Restore sample" for an extra sample: its own customers back to the originals (customers a person added or edited
 * are removed) and its known data problems back to the intended ones. The document itself is restored by the caller;
 * releases and proof records are never touched (they are frozen).
 */
export function restoreExtraSample(store: Store, projectId: string): boolean {
  const sample = EXTRA_SAMPLES().find((s) => s.project.projectId === projectId);
  if (!sample) return false;
  store.putSampleRecords(projectId, sample.customers as SyntheticRecord[], 'replace');
  store.clearKnownDataProblems(projectId);
  seedKnownDataProblems(store, sample, sample.project);
  return true;
}
