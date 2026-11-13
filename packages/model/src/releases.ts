import type { DocumentType } from './types';
import type { Permission, Role } from './collab';
import { roleCan } from './collab';

/**
 * Releases: the frozen, numbered copies of an approved document that a CCM receives.
 *
 * Pure rules shared by the API (enforcement) and the studio (what to offer): numbering, the two stages a release moves
 * through, who may move it, and the shapes the API returns. Nothing here reads a clock or a store.
 *
 * A release is created at stage Test. An admin moves it to Production. At each stage at most one release of a
 * document is the current one; a newer one makes the earlier one "superseded". A release can be withdrawn from a stage
 * with a reason. Nothing is ever deleted and nothing edits a release.
 */

export type ReleaseStage = 'test' | 'production';
/** In the order a release moves through them. */
export const RELEASE_STAGES: readonly ReleaseStage[] = ['test', 'production'];
export const RELEASE_STAGE_LABEL: Record<ReleaseStage, string> = { test: 'Test', production: 'Production' };
export const isReleaseStage = (v: unknown): v is ReleaseStage => v === 'test' || v === 'production';

/** Where a release stands at one stage. */
export type ReleaseStageStatus = 'current' | 'superseded' | 'withdrawn';
export const RELEASE_STAGE_STATUS_LABEL: Record<ReleaseStageStatus, string> = { current: 'Current', superseded: 'Superseded', withdrawn: 'Withdrawn' };

export interface ReleaseActor { id: string | null; name: string }

export interface ReleaseStageState {
  status: ReleaseStageStatus;
  /** When it got this status at this stage. */
  since: string;
  by: ReleaseActor | null;
  /** Withdrawn only: why. */
  reason?: string | null;
  /** Superseded only: the release number that took its place. */
  supersededBy?: number | null;
}

/** The versions of everything that turns a release into outputs, recorded when the release is created. */
export interface ReleaseVersions {
  /** The project format (`schemaVersion`) of the frozen template. */
  schema: string;
  engine: string;
  pagedRenderer: string;
  htmlRenderer: string;
  emailRenderer: string;
  smsRenderer: string;
  /** The release package format the studio writes (`formatVersion` in the package manifest). */
  packageFormat: number;
}

export type ReleasePackageState = 'not-built' | 'building' | 'ready' | 'failed';
export const RELEASE_PACKAGE_STATE_LABEL: Record<ReleasePackageState, string> = { 'not-built': 'Not built', building: 'Building', ready: 'Ready', failed: 'Failed' };

export interface ReleasePackageStatus {
  status: ReleasePackageState;
  /** `<document-id>-r<release>.zip` */
  fileName: string;
  /** Ready only. */
  sha256: string | null;
  bytes: number | null;
  files: number | null;
  /** When the studio built the ZIP it is holding (studio bookkeeping; no file in the package states a build time). */
  builtAt: string | null;
  /** Building only: how far it is. */
  progress: { step: string; done: number; total: number } | null;
  /** Failed only: why, in plain words. */
  error: string | null;
  /** Ready only: what the package holds, for a list or a preview header. */
  summary: ReleasePackageSummary | null;
  /**
   * The last time the package was built again to check it (it is never replaced once built): whether the new build
   * was byte-identical to the kept one, or why it could not be built. Null when it was never checked.
   */
  verified: ReleasePackageCheck | null;
}

export interface ReleasePackageCheck { at: string; same: boolean; sha256: string | null; error: string | null }

export interface ReleasePackageSummary {
  scenarios: number;
  references: number;
  /** Pinned tests left out because their customer is not provably synthetic. */
  pinnedExcluded: number;
  languages: Array<{ locale: string; name: string; texts: number; approved: number; missing: number }>;
}

/** One release, as every list and detail route returns it. */
export interface ReleaseInfo {
  /** `<document-id>-r<number>` */
  id: string;
  documentId: string;
  number: number;
  /** The document's title when it was approved. */
  title: string;
  documentType: DocumentType;
  /** What a person calls that kind of document. */
  kind: string;
  /** The saved version of the document that was approved. */
  modelVersion: number;
  /** The studio's digest of the approved content (the same value its version history shows). */
  contentDigest: string;
  /** Source language first, then the document's other languages. */
  languages: string[];
  approvedBy: ReleaseActor | null;
  approvedAt: string;
  /** `approval` = created when the document was approved; `manual` = created later from the approved version. */
  origin: 'approval' | 'manual';
  createdBy: ReleaseActor | null;
  createdAt: string;
  versions: ReleaseVersions;
  stages: { test: ReleaseStageState; production: ReleaseStageState | null };
  /** One word for a list: where the release stands overall. */
  standing: ReleaseStanding;
  /** The document was deleted after this release was made. The release is kept. */
  documentRemoved: boolean;
  documentRemovedAt: string | null;
  package: ReleasePackageStatus;
  handover: { received: boolean; live: boolean; entries: number };
}

export type ReleaseEventKind = 'created' | 'reapproved' | 'promoted' | 'superseded' | 'withdrawn' | 'document-removed';
export interface ReleaseEvent {
  id: number;
  kind: ReleaseEventKind;
  /** The stage the event is about (absent for events about the release as a whole). */
  stage: ReleaseStage | null;
  /** A reason or note a person gave, or what the studio recorded. */
  note: string | null;
  by: ReleaseActor | null;
  at: string;
}

export type HandoverKind = 'received' | 'live';
export const HANDOVER_KINDS: readonly HandoverKind[] = ['received', 'live'];
export const HANDOVER_LABEL: Record<HandoverKind, string> = { received: 'Received', live: 'Live' };
export const isHandoverKind = (v: unknown): v is HandoverKind => v === 'received' || v === 'live';
export interface HandoverEntry {
  id: number;
  kind: HandoverKind;
  /** The environment it was received or went live in, when the person said. */
  stage: ReleaseStage | null;
  note: string | null;
  /** The SHA-256 of the release package the studio held when this was logged (null when it had not been built yet). */
  packageSha256: string | null;
  by: ReleaseActor | null;
  at: string;
}

export const RELEASE_NOTE_MAX = 500;

export type ReleaseAction = 'create' | 'promote' | 'withdraw' | 'handover';
/** Approvers and admins create releases and keep the handover log; only admins move a release between stages. */
export const RELEASE_ACTION_PERMISSION: Record<ReleaseAction, Permission> = { create: 'approve', promote: 'promote_release', withdraw: 'promote_release', handover: 'approve' };
export function roleCanRelease(role: Role | null | undefined, action: ReleaseAction): boolean { return roleCan(role, RELEASE_ACTION_PERMISSION[action]); }
/** What to tell someone whose role may not do it. */
export function releaseRoleProblem(role: Role | null | undefined, action: ReleaseAction): string | null {
  if (roleCanRelease(role, action)) return null;
  if (action === 'promote') return 'Only admins can move a release to Production.';
  if (action === 'withdraw') return 'Only admins can withdraw a release.';
  if (action === 'handover') return 'Only approvers and admins can add to the handover log.';
  return 'Only approvers and admins can create a release.';
}

/* ------------------------------------------------------------------ numbering and names */

/** Release numbers start at 1 and are never reused for a document, whatever happened to earlier releases. */
export function nextReleaseNumber(existing: readonly number[]): number {
  let max = 0;
  for (const n of existing) if (Number.isInteger(n) && n > max) max = n;
  return max + 1;
}
export const releaseId = (documentId: string, number: number): string => `${documentId}-r${number}`;
export const RELEASE_ID_PATTERN = /^([a-z0-9-]{3,64})-r([1-9]\d{0,8})$/;
export function parseReleaseId(id: string): { documentId: string; number: number } | null {
  const m = RELEASE_ID_PATTERN.exec(id);
  return m ? { documentId: m[1], number: Number(m[2]) } : null;
}
export const releasePackageName = (documentId: string, number: number): string => `${releaseId(documentId, number)}.zip`;

/* ------------------------------------------------------------------ creating */

/** What the rules need to know about a release. */
export type ReleaseStagesOnly = Pick<ReleaseInfo, 'number' | 'stages'>;

export type ReleaseCreationDecision =
  | { create: true; number: number; supersedesAtTest: number[] }
  | { create: false; reason: 'unchanged'; number: number };

/**
 * Whether approving content with this digest makes a new release.
 * Approving again exactly what the latest release already holds does not: that release stands, and the approval is noted
 * on it. The one exception is a latest release that was withdrawn from a stage — approving its content again is a
 * deliberate decision to release it again, so it gets a new number and the withdrawn release stays withdrawn.
 */
export function releaseCreationDecision(existing: ReadonlyArray<ReleaseStagesOnly & { contentDigest: string }>, contentDigest: string): ReleaseCreationDecision {
  const latest = latestRelease(existing);
  const withdrawn = !!latest && (latest.stages.test.status === 'withdrawn' || latest.stages.production?.status === 'withdrawn');
  if (latest && latest.contentDigest === contentDigest && !withdrawn) return { create: false, reason: 'unchanged', number: latest.number };
  return { create: true, number: nextReleaseNumber(existing.map((r) => r.number)), supersedesAtTest: existing.filter((r) => r.stages.test.status === 'current').map((r) => r.number) };
}

export function latestRelease<T extends { number: number }>(releases: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of releases) if (!best || r.number > best.number) best = r;
  return best;
}

/** The release of a document that is current at a stage, or null. */
export function currentRelease<T extends ReleaseStagesOnly>(releases: readonly T[], stage: ReleaseStage): T | null {
  return releases.find((r) => r.stages[stage]?.status === 'current') ?? null;
}

/* ------------------------------------------------------------------ moving between stages */

/**
 * Why this release cannot be moved to Production (null when it can). The role is checked separately.
 * A release that is superseded at either stage can still be promoted (that is how an earlier release is put back);
 * one that was withdrawn cannot — it needs a new release.
 */
export function promoteProblem(r: ReleaseStagesOnly): string | null {
  if (r.stages.test.status === 'withdrawn') return `Release ${r.number} was withdrawn from Test, so it cannot go to Production. Approve the document again to make a new release.`;
  if (r.stages.production?.status === 'current') return `Release ${r.number} is already the Production release.`;
  if (r.stages.production?.status === 'withdrawn') return `Release ${r.number} was withdrawn from Production. Approve the document again to make a new release.`;
  return null;
}

/** The releases of the same document that stop being the Production release when `number` is promoted. */
export function supersededByPromotion(releases: readonly ReleaseStagesOnly[], number: number): number[] {
  return releases.filter((r) => r.number !== number && r.stages.production?.status === 'current').map((r) => r.number);
}

/** Why this release cannot be withdrawn from a stage (null when it can). A reason is required and checked separately. */
export function withdrawProblem(r: ReleaseStagesOnly, stage: ReleaseStage): string | null {
  const s = r.stages[stage];
  const where = RELEASE_STAGE_LABEL[stage];
  if (!s) return `Release ${r.number} has never been in ${where}.`;
  if (s.status === 'withdrawn') return `Release ${r.number} is already withdrawn from ${where}.`;
  if (stage === 'test' && r.stages.production?.status === 'current') return `Release ${r.number} is the Production release. Withdraw it from Production first.`;
  return null;
}

/** A reason or note a person typed: one paragraph of plain text, trimmed and bounded. */
export function cleanReleaseNote(input: unknown): string {
  const s = typeof input === 'string' ? input : '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ reading a release at a glance */

export type ReleaseStanding = 'production' | 'test' | 'superseded' | 'withdrawn';
export const RELEASE_STANDING_LABEL: Record<ReleaseStanding, string> = { production: 'In Production', test: 'In Test', superseded: 'Superseded', withdrawn: 'Withdrawn' };

/**
 * Where a release stands overall: the Production release; else the current Test release; else withdrawn when its
 * furthest stage was withdrawn; else superseded.
 */
export function releaseStanding(r: Pick<ReleaseInfo, 'stages'>): ReleaseStanding {
  if (r.stages.production?.status === 'current') return 'production';
  if (r.stages.test.status === 'current') return 'test';
  const furthest = r.stages.production ?? r.stages.test;
  if (furthest.status === 'withdrawn' || r.stages.test.status === 'withdrawn') return 'withdrawn';
  return 'superseded';
}
