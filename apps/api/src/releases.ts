import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DOCUMENT_TYPE_LABEL, SOURCE_LANGUAGE, currentRelease, projectContentDigest, projectLanguages, promoteProblem, releaseCreationDecision, releaseId,
  releasePackageName, releaseStanding, supersededByPromotion, withdrawProblem,
  type Project, type ReleaseActor, type ReleaseInfo, type ReleasePackageCheck, type ReleasePackageStatus, type ReleaseStage, type ReleaseVersions,
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

const VERSION_NAMES: Record<keyof ReleaseVersions, string> = { schema: 'project format', engine: 'engine', pagedRenderer: 'PDF renderer', htmlRenderer: 'web page renderer', emailRenderer: 'email renderer', smsRenderer: 'SMS renderer', packageFormat: 'package format' };

/**
 * Why this studio can no longer build the release's package exactly as approved (null when it can): the engine, a
 * renderer or the package format has changed since the release was made. A package states the versions that produced
 * it, so building it with different ones would make that statement false.
 */
export function versionDrift(r: StoredRelease, frozen: Project): string | null {
  const now = releaseVersions(frozen);
  const changed = (Object.keys(VERSION_NAMES) as Array<keyof ReleaseVersions>).filter((k) => now[k] !== r.versions[k]);
  if (!changed.length) return null;
  return `This studio has been updated since release ${r.number} was made (${changed.map((k) => `${VERSION_NAMES[k]} ${r.versions[k]} then, ${now[k]} now`).join('; ')}), so it can no longer build this release's package exactly as it was approved.`;
}

/* ------------------------------------------------------------------ packages: build once, keep, serve */

export interface PackageBuildOutcome {
  status: ReleasePackageStatus;
  /** Set when this run built the package the studio now keeps. */
  built?: { sha256: string; bytes: number; files: number };
  /** Set when this run built the package again to check it against the kept one. */
  verified?: ReleasePackageCheck;
}

/**
 * Builds release packages one at a time, off the request that asked, and keeps each finished ZIP on disk with its
 * SHA-256. Once a package is built it is never replaced: building it again only checks that the result is the same.
 * "Building" lives in memory only, so a build cut short by a restart is simply not built.
 */
export class ReleasePackages {
  private building = new Map<string, { promise: Promise<PackageBuildOutcome>; progress: { step: string; done: number; total: number } }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private composer: PackageComposer, private caps: { scenarioCap?: number; referenceCap?: number } = {}) {}

  private file(name: string) { return path.join(this.store.artifactDir, name); }
  /** The stored record of a package whose ZIP is really there. */
  private kept(releaseId: string) {
    const row = this.store.releasePackage(releaseId);
    return row && row.status === 'ready' && row.file && existsSync(this.file(row.file)) ? row : null;
  }

  status(r: Pick<StoredRelease, 'id' | 'documentId' | 'number'>): ReleasePackageStatus {
    const fileName = releasePackageName(r.documentId, r.number);
    const empty: ReleasePackageStatus = { status: 'not-built', fileName, sha256: null, bytes: null, files: null, builtAt: null, progress: null, error: null, summary: null, verified: null };
    const kept = this.kept(r.id);
    const job = this.building.get(r.id);
    // While a kept package is being checked it stays ready (and downloadable); only a first build shows as building.
    if (kept) return { status: 'ready', fileName, sha256: kept.sha256, bytes: kept.bytes, files: kept.files, builtAt: kept.builtAt, progress: job ? { ...job.progress } : null, error: null, summary: kept.summary, verified: kept.verified };
    if (job) return { ...empty, status: 'building', progress: { ...job.progress } };
    const row = this.store.releasePackage(r.id);
    return row?.status === 'failed' ? { ...empty, status: 'failed', error: row.error, builtAt: row.builtAt } : empty;
  }

  /**
   * Starts a build when the package is not built (or its last build failed). With `verify`, a package that is ready is
   * built again and compared with the kept one, which stays in place whatever the result.
   * Returns at once with the status and, when a build was started or is running, the promise of its outcome.
   */
  prepare(r: StoredRelease, opts: { verify?: boolean } = {}): { status: ReleasePackageStatus; started: boolean; done: Promise<PackageBuildOutcome> | null } {
    const running = this.building.get(r.id);
    if (running) return { status: this.status(r), started: false, done: running.promise };
    if (this.kept(r.id) && !opts.verify) return { status: this.status(r), started: false, done: null };
    const job = { progress: { step: 'Waiting for its turn', done: 0, total: 1 }, promise: null as unknown as Promise<PackageBuildOutcome> };
    job.promise = (this.queue = this.queue.then(() => this.build(r, job))) as Promise<PackageBuildOutcome>;
    this.building.set(r.id, job);
    return { status: this.status(r), started: true, done: job.promise };
  }

  private async build(r: StoredRelease, job: { progress: { step: string; done: number; total: number } }): Promise<PackageBuildOutcome> {
    const now = () => new Date().toISOString();
    // Names and reasons only: never a content body.
    const reason = (e: any) => String(e?.message ?? e).slice(0, 400);
    let built: PackageBuildOutcome['built'];
    let verified: PackageBuildOutcome['verified'];
    try {
      const frozen = this.store.releaseProject(r.id);
      if (!frozen) throw new Error('The release has no stored content.');
      const drift = versionDrift(r, frozen);
      if (drift) throw new Error(drift);
      const pkg = await buildReleasePackage(r, frozen, { composer: this.composer, ...this.caps, onProgress: (p) => { job.progress = p; } });
      const kept = this.kept(r.id);
      if (kept) {
        verified = { at: now(), same: kept.sha256 === pkg.sha256, sha256: pkg.sha256, error: null };
        this.store.setReleasePackage(r.id, { ...kept, verified });
      } else {
        const file = `release-${r.id}-${pkg.sha256.slice(0, 16)}.zip`;
        writeFileSync(this.file(file), pkg.zip);
        this.store.setReleasePackage(r.id, { status: 'ready', file, sha256: pkg.sha256, bytes: pkg.zip.length, files: pkg.files.length + 1, summary: pkg.summary, error: null, builtAt: now(), verified: null });
        built = { sha256: pkg.sha256, bytes: pkg.zip.length, files: pkg.files.length + 1 };
      }
    } catch (e: any) {
      const kept = this.kept(r.id);
      if (kept) {
        verified = { at: now(), same: false, sha256: null, error: reason(e) };
        this.store.setReleasePackage(r.id, { ...kept, verified });
      } else this.store.setReleasePackage(r.id, { status: 'failed', file: null, sha256: null, bytes: null, files: null, summary: null, error: reason(e), builtAt: now(), verified: null });
    } finally {
      this.building.delete(r.id);
    }
    return { status: this.status(r), built, verified };
  }

  /** The kept ZIP of a ready package. */
  zip(r: StoredRelease): Buffer | null {
    const kept = this.kept(r.id);
    return kept ? readFileSync(this.file(kept.file!)) : null;
  }

  /** The files of a ready package as its manifest lists them (plus the manifest itself), without unpacking anything. */
  files(r: StoredRelease): PackageFile[] | null {
    const zip = this.zip(r);
    if (!zip) return null;
    const manifestEntry = zipEntries(zip).find((e) => e.name === 'manifest.json');
    if (!manifestEntry) return null;
    const manifest = zipRead(zip, manifestEntry);
    const listed = (JSON.parse(manifest.toString('utf8')).contents ?? []) as PackageFile[];
    return [{ path: 'manifest.json', sha256: createHash('sha256').update(manifest).digest('hex'), bytes: manifest.length, role: 'manifest' }, ...listed];
  }

  /** One file of a ready package, read straight from the kept ZIP. */
  read(r: StoredRelease, filePath: string): Buffer | null {
    const zip = this.zip(r);
    if (!zip) return null;
    const entry = zipEntries(zip).find((e) => e.name === filePath);
    return entry ? zipRead(zip, entry) : null;
  }

  /** Resolves when no build is running (shutdown, tests). */
  async idle(): Promise<void> { await this.queue.catch(() => undefined); }
}
