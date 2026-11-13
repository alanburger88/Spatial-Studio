import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DOCUMENT_TYPE_LABEL, RELEASE_STAGE_LABEL, SOURCE_LANGUAGE, currentRelease, projectContentDigest, projectLanguages, promoteProblem, releaseCreationDecision, releaseId,
  releasePackageName, releaseStanding, supersededByPromotion, withdrawProblem,
  type Project, type ReleaseActor, type ReleaseInfo, type ReleasePackageStatus, type ReleaseStage, type ReleaseVersions,
} from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { ENGINE_VERSION } from '@iss/resolver';
import { EMAIL_RENDERER_VERSION, HTML_RENDERER_VERSION, PAGED_RENDERER_VERSION, SMS_RENDERER_VERSION } from '@iss/renderers';
import type { PinnedCustomerRef, Store, StoredRelease } from './db';
import { PACKAGE_FORMAT_VERSION, buildReleasePackage, customerDigest, type PackageComposer, type PackageFile } from './releasePackage';
import { zipEntries, zipRead } from './zip';

/**
 * Releases on the server: creating one from an approved version, moving it between stages, and building and keeping
 * its package. The rules themselves (numbering, who may do what, what supersedes what) are pure and live in
 * `@iss/model` (`releases.ts`); this file applies them to the store.
 *
 * None of these functions opens a transaction: the caller wraps each state change in `store.transaction`, so an
 * approval and the release it creates are stored together or not at all.
 */

type Who = { id: string; name: string } | null;
const actor = (w: Who): ReleaseActor | null => (w ? { id: w.id, name: w.name } : null);

export function releaseVersions(project: Project): ReleaseVersions {
  return { schema: project.schemaVersion, engine: ENGINE_VERSION, pagedRenderer: PAGED_RENDERER_VERSION, htmlRenderer: HTML_RENDERER_VERSION, emailRenderer: EMAIL_RENDERER_VERSION, smsRenderer: SMS_RENDERER_VERSION, packageFormat: PACKAGE_FORMAT_VERSION };
}

/**
 * Which customer each pinned test uses, decided now and stored with the release (ids, an origin and a digest: no data).
 * Only a built-in sample customer, or a generated customer the package builder can later reproduce from synthetic data
 * alone, will ever reach a package.
 */
export function pinnedCustomerRefs(store: Store, project: Project): PinnedCustomerRef[] {
  const samples = new Set(RECORDS.filter((r) => r.documentType === project.documentType).map((r) => r.recordId));
  const imported = new Set(store.importedRecords(project.documentType).map((r) => r.recordId));
  return (project.testCases ?? []).map((t): PinnedCustomerRef => {
    const base = { testId: t.id, recordId: t.recordId };
    if (samples.has(t.recordId)) return { ...base, kind: 'sample' };
    const origin = store.projectRecordOrigin(project.projectId, t.recordId);
    if (origin === 'generated') return { ...base, kind: 'generated', digest: customerDigest(store.projectRecord(t.recordId)!) };
    if (origin === 'supplied') return { ...base, kind: 'supplied' };
    return { ...base, kind: imported.has(t.recordId) ? 'imported' : 'missing' };
  });
}

export interface ReleaseCreation { created: boolean; reason: 'unchanged' | null; release: StoredRelease; supersededAtTest: number[] }

/**
 * THE place a release comes into being. `project` is the approved version exactly as stored.
 * Today it is called when a document is approved and by the "create a release from the approved version" action; a
 * separate manual step would call the same function.
 *
 * When the content is the same as the latest release's (and that release was not withdrawn), no release is created:
 * the existing one is returned, and with `noteReapproval` the approval is added to its history.
 */
export function createRelease(store: Store, project: Project, o: { approvedBy: Who; approvedAt: string; createdBy: Who; origin: 'approval' | 'manual'; noteReapproval?: boolean }): ReleaseCreation {
  const digest = projectContentDigest(project);
  const existing = store.releases(project.projectId);
  const decision = releaseCreationDecision(existing, digest);
  const now = new Date().toISOString();
  if (!decision.create) {
    const release = existing.find((r) => r.number === decision.number)!;
    if (o.noteReapproval) store.addReleaseEvent(release.id, { kind: 'reapproved', stage: null, note: `Version ${project.modelVersion} was approved again with no change to the content, so no new release was made.`, by: actor(o.approvedBy), at: now });
    return { created: false, reason: 'unchanged', release, supersededAtTest: [] };
  }
  const release: StoredRelease = {
    id: releaseId(project.projectId, decision.number), documentId: project.projectId, number: decision.number, title: project.title, documentType: project.documentType,
    modelVersion: project.modelVersion, contentDigest: digest, languages: [SOURCE_LANGUAGE, ...projectLanguages(project)], versions: releaseVersions(project), pinned: pinnedCustomerRefs(store, project),
    origin: o.origin, approvedBy: actor(o.approvedBy), approvedAt: o.approvedAt, createdBy: actor(o.createdBy), createdAt: now,
    stages: { test: { status: 'current', since: now, by: actor(o.createdBy) }, production: null }, documentRemovedAt: null,
  };
  store.insertRelease(release, project);
  store.addReleaseEvent(release.id, { kind: 'created', stage: 'test', note: o.origin === 'approval' ? `Created when version ${project.modelVersion} was approved.` : `Created from the approved version ${project.modelVersion}.`, by: actor(o.createdBy), at: now });
  for (const older of existing.filter((r) => decision.supersedesAtTest.includes(r.number))) {
    store.setReleaseStages(older.id, { ...older.stages, test: { status: 'superseded', since: now, by: actor(o.createdBy), supersededBy: release.number } });
    store.addReleaseEvent(older.id, { kind: 'superseded', stage: 'test', note: `Release ${release.number} took its place in Test.`, by: actor(o.createdBy), at: now });
  }
  return { created: true, reason: null, release, supersededAtTest: decision.supersedesAtTest };
}

/** Moves a release to Production. The earlier Production release of the same document becomes superseded (kept). Throws a plain Error with the reason when the rules forbid it. */
export function promoteRelease(store: Store, release: StoredRelease, by: Who, note: string | null): { release: StoredRelease; superseded: StoredRelease[] } {
  const problem = promoteProblem(release);
  if (problem) throw new Error(problem);
  const now = new Date().toISOString();
  const all = store.releases(release.documentId);
  const superseded = all.filter((r) => supersededByPromotion(all, release.number).includes(r.number));
  for (const older of superseded) {
    store.setReleaseStages(older.id, { ...older.stages, production: { status: 'superseded', since: now, by: actor(by), supersededBy: release.number } });
    store.addReleaseEvent(older.id, { kind: 'superseded', stage: 'production', note: `Release ${release.number} took its place in Production.`, by: actor(by), at: now });
  }
  const back = release.stages.production?.status === 'superseded';
  store.setReleaseStages(release.id, { ...release.stages, production: { status: 'current', since: now, by: actor(by) } });
  store.addReleaseEvent(release.id, { kind: 'promoted', stage: 'production', note: note || (back ? 'Made the Production release again.' : null), by: actor(by), at: now });
  return { release: store.release(release.id)!, superseded: superseded.map((r) => store.release(r.id)!) };
}

/** Withdraws a release from a stage, with the reason. It is kept and marked withdrawn; nothing takes its place automatically. */
export function withdrawRelease(store: Store, release: StoredRelease, stage: ReleaseStage, reason: string, by: Who): StoredRelease {
  const problem = withdrawProblem(release, stage);
  if (problem) throw new Error(problem);
  const now = new Date().toISOString();
  store.setReleaseStages(release.id, { ...release.stages, [stage]: { status: 'withdrawn', since: now, by: actor(by), reason } });
  store.addReleaseEvent(release.id, { kind: 'withdrawn', stage, note: reason, by: actor(by), at: now });
  return store.release(release.id)!;
}

/** A release as the API returns it. */
export function releaseInfo(r: StoredRelease, pkg: ReleasePackageStatus, handover: { received: number; live: number } | undefined): ReleaseInfo {
  return {
    id: r.id, documentId: r.documentId, number: r.number, title: r.title, documentType: r.documentType, kind: DOCUMENT_TYPE_LABEL[r.documentType], modelVersion: r.modelVersion, contentDigest: r.contentDigest,
    languages: r.languages, approvedBy: r.approvedBy, approvedAt: r.approvedAt, origin: r.origin, createdBy: r.createdBy, createdAt: r.createdAt, versions: r.versions,
    stages: r.stages, standing: releaseStanding(r), documentRemoved: !!r.documentRemovedAt, documentRemovedAt: r.documentRemovedAt,
    package: pkg, handover: { received: (handover?.received ?? 0) > 0, live: (handover?.live ?? 0) > 0, entries: (handover?.received ?? 0) + (handover?.live ?? 0) },
  };
}

/** Per document: the release that is current at each stage. */
export function liveReleases(releases: StoredRelease[]): { production: StoredRelease | null; test: StoredRelease | null; latest: StoredRelease } {
  return { production: currentRelease(releases, 'production'), test: currentRelease(releases, 'test'), latest: releases[releases.length - 1] };
}

export const stageLabel = (s: ReleaseStage): string => RELEASE_STAGE_LABEL[s];

/* ------------------------------------------------------------------ packages: build once, keep, serve */

export interface PackageBuildOutcome { status: ReleasePackageStatus; /** Set when this call finished a build. */ built?: { sha256: string; bytes: number; files: number; sameAsBefore: boolean | null } }

/**
 * Builds release packages one at a time, off the request that asked, and keeps each finished ZIP on disk with its
 * SHA-256. "Building" lives in memory only, so a build cut short by a restart is simply not built.
 */
export class ReleasePackages {
  private building = new Map<string, { promise: Promise<PackageBuildOutcome>; progress: { step: string; done: number; total: number } }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private composer: PackageComposer, private caps: { scenarioCap?: number; referenceCap?: number } = {}) {}

  private file(name: string) { return path.join(this.store.artifactDir, name); }

  status(r: Pick<StoredRelease, 'id' | 'documentId' | 'number'>): ReleasePackageStatus {
    const fileName = releasePackageName(r.documentId, r.number);
    const empty: ReleasePackageStatus = { status: 'not-built', fileName, sha256: null, bytes: null, files: null, builtAt: null, progress: null, error: null, summary: null };
    const job = this.building.get(r.id);
    if (job) return { ...empty, status: 'building', progress: { ...job.progress } };
    const row = this.store.releasePackage(r.id);
    if (!row) return empty;
    if (row.status === 'failed') return { ...empty, status: 'failed', error: row.error, builtAt: row.builtAt };
    if (!row.file || !existsSync(this.file(row.file))) return empty;
    return { status: 'ready', fileName, sha256: row.sha256, bytes: row.bytes, files: row.files, builtAt: row.builtAt, progress: null, error: null, summary: row.summary };
  }

  /**
   * Starts a build unless one is running or the package is ready (`force` rebuilds a ready one).
   * Returns at once with the status and, when a build was started or is running, the promise of its outcome.
   */
  prepare(r: StoredRelease, opts: { force?: boolean } = {}): { status: ReleasePackageStatus; started: boolean; done: Promise<PackageBuildOutcome> | null } {
    const running = this.building.get(r.id);
    if (running) return { status: this.status(r), started: false, done: running.promise };
    const now = this.status(r);
    if (now.status === 'ready' && !opts.force) return { status: now, started: false, done: null };
    const job = { progress: { step: 'Waiting for its turn', done: 0, total: 1 }, promise: null as unknown as Promise<PackageBuildOutcome> };
    const previous = now.status === 'ready' ? now.sha256 : null;
    job.promise = (this.queue = this.queue.then(() => this.build(r, job, previous))) as Promise<PackageBuildOutcome>;
    this.building.set(r.id, job);
    return { status: this.status(r), started: true, done: job.promise };
  }

  private async build(r: StoredRelease, job: { progress: { step: string; done: number; total: number } }, previousSha: string | null): Promise<PackageBuildOutcome> {
    let built: PackageBuildOutcome['built'];
    try {
      const frozen = this.store.releaseProject(r.id);
      if (!frozen) throw new Error('The release has no stored content.');
      const pkg = await buildReleasePackage(r, frozen, { composer: this.composer, ...this.caps, onProgress: (p) => { job.progress = p; } });
      const file = `release-${r.id}-${pkg.sha256.slice(0, 16)}.zip`;
      writeFileSync(this.file(file), pkg.zip);
      this.store.setReleasePackage(r.id, { status: 'ready', file, sha256: pkg.sha256, bytes: pkg.zip.length, files: pkg.files.length + 1, summary: pkg.summary, error: null, builtAt: new Date().toISOString() });
      built = { sha256: pkg.sha256, bytes: pkg.zip.length, files: pkg.files.length + 1, sameAsBefore: previousSha === null ? null : previousSha === pkg.sha256 };
    } catch (e: any) {
      // Names and reasons only: never a content body.
      this.store.setReleasePackage(r.id, { status: 'failed', file: null, sha256: null, bytes: null, files: null, summary: null, error: String(e?.message ?? e).slice(0, 300), builtAt: new Date().toISOString() });
    } finally {
      this.building.delete(r.id);
    }
    return { status: this.status(r), built };
  }

  /** The cached ZIP of a ready package. */
  zip(r: StoredRelease): Buffer | null {
    const row = this.store.releasePackage(r.id);
    if (!row || row.status !== 'ready' || !row.file || !existsSync(this.file(row.file))) return null;
    return readFileSync(this.file(row.file));
  }

  /** The files of a ready package as its manifest lists them (plus the manifest itself), without unpacking anything. */
  files(r: StoredRelease): PackageFile[] | null {
    const zip = this.zip(r);
    if (!zip) return null;
    const entries = zipEntries(zip);
    const manifestEntry = entries.find((e) => e.name === 'manifest.json');
    if (!manifestEntry) return null;
    const manifest = zipRead(zip, manifestEntry);
    const listed = (JSON.parse(manifest.toString('utf8')).contents ?? []) as PackageFile[];
    return [{ path: 'manifest.json', sha256: createHash('sha256').update(manifest).digest('hex'), bytes: manifest.length, role: 'manifest' }, ...listed];
  }

  /** One file of a ready package, read straight from the cached ZIP. */
  read(r: StoredRelease, filePath: string): Buffer | null {
    const zip = this.zip(r);
    if (!zip) return null;
    const entry = zipEntries(zip).find((e) => e.name === filePath);
    return entry ? zipRead(zip, entry) : null;
  }

  /** Resolves when no build is running (shutdown, tests). */
  async idle(): Promise<void> { await this.queue.catch(() => undefined); }
}
