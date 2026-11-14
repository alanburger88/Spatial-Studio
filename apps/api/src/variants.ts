import {
  compareWithBase, differenceCounts, projectContentDigest, variantLockProblem, variantReleaseRecord, variantRulesDiffer, variantStanding,
  type Project, type SyntheticRecord, type VariantReleaseRecord,
} from '@iss/model';
import type { Store } from './db';

/**
 * Variants by brand or region (wave 5, section 1) on the server: finding a variant's base at the version it follows,
 * the variant's copies of the base's customers, the save-time lock, the family of a document and what a release records.
 * Everything that decides anything is pure and lives in `@iss/model` (`variants.ts`, `variantLock.ts`); this file only
 * reads the store. Nothing here is used when a document is resolved, rendered, released or packaged: a variant is a
 * complete document.
 */

/** The base at the version a variant follows, or why it cannot be found (an imported variant, a deleted base). */
export function baseOf(store: Store, variant: Project): { base: Project; at: Project; latest: number } | { missing: 'document' | 'version' | 'changed' } | null {
  const v = variant.variantOf;
  if (!v) return null;
  const base = store.getProject(v.projectId);
  if (!base) return { missing: 'document' };
  const at = store.getVersion(v.projectId, v.modelVersion);
  if (!at) return { missing: 'version' };
  if (at.contentDigest !== v.contentDigest && projectContentDigest(at.project) !== v.contentDigest) return { missing: 'changed' };
  return { base, at: at.project, latest: base.modelVersion };
}

export const BASE_MISSING_WORDS = {
  document: 'The base document is not in this studio (it may have been imported from another one, or removed). This variant behaves as an ordinary document until it is detached or the base is imported.',
  version: 'The version of the base this variant follows is not in the base’s history. It behaves as an ordinary document until it is detached.',
  changed: 'The version of the base this variant follows is not the one it was made from. It behaves as an ordinary document until it is detached.',
} as const;

/** The variant's copies of the base's own customers: base record id → the variant's record id (from `sourceId`). */
export function customerMap(store: Store, variant: Project): Record<string, string> {
  const v = variant.variantOf;
  if (!v) return {};
  const baseIds = new Set(store.projectRecords(v.projectId).map((r) => r.recordId));
  const out: Record<string, string> = {};
  for (const r of store.projectRecords(variant.projectId)) if (typeof r.sourceId === 'string' && baseIds.has(r.sourceId)) out[r.sourceId] = r.recordId;
  return out;
}

/** The documents that follow `baseId`. */
export function variantsOf(store: Store, baseId: string): Project[] {
  return store.listProjects().filter((p) => p.variantOf?.projectId === baseId).map((p) => store.getProject(p.projectId)!).filter(Boolean);
}

/**
 * Why a save of `incoming` must be refused (null when it may be stored). The browser is not the only client, so the
 * server checks what `applyCommand` checks: a variant's locked parts equal its base's at the version it follows.
 */
export function variantSaveProblem(store: Store, current: Project | null, incoming: Project): { code: string; message: string; nodeId?: string } | null {
  const v = incoming.variantOf;
  if (!v) return null;
  if (!current?.variantOf) return { code: 'VARIANT_FROM_SAVE', message: 'A document becomes a variant only with “New variant” on its base.' };
  if (current.variantOf.projectId !== v.projectId) return { code: 'VARIANT_BASE_FIXED', message: `This variant follows “${current.variantOf.baseTitle}”. A variant cannot change which document it follows; detach it instead.` };
  const found = baseOf(store, incoming);
  if (!found || 'missing' in found) return null; // no base here: it behaves as an ordinary document
  if (found.base.variantOf) return { code: 'VARIANT_ONE_LEVEL', message: 'A variant cannot follow another variant.' };
  const baseIds = new Set(found.at.nodes.map((n) => n.id));
  const stray = v.baseNodeIds.find((id) => !baseIds.has(id));
  if (stray || v.baseNodeIds.length !== new Set(v.baseNodeIds).size) return { code: 'VARIANT_LOCKED', message: `The variant’s list of the base’s components does not match version ${v.modelVersion} of “${found.at.title}”.` };
  const hit = variantLockProblem(found.at, incoming, v);
  return hit ? { code: 'VARIANT_LOCKED', message: hit.message, nodeId: hit.nodeId } : null;
}

/** One document of a family, as the family view shows it (ids, numbers and states: no content). */
export interface FamilyMember {
  projectId: string;
  title: string;
  modelVersion: number;
  workflow: string;
  latestRelease: { number: number; stage: 'production' | 'test' | null } | null;
  variant?: { purpose: string; label: string; follows: number; behind: boolean; baseMissing: boolean; rulesDiffer: boolean | null; differences: number | null };
}

function member(store: Store, p: Project, base: { latest: number; at?: Project } | null): FamilyMember {
  const releases = store.releases(p.projectId);
  const last = releases[releases.length - 1];
  const stage = last ? (last.stages.production?.status === 'current' ? 'production' : last.stages.test?.status === 'current' ? 'test' : null) : null;
  const out: FamilyMember = { projectId: p.projectId, title: p.title, modelVersion: p.modelVersion, workflow: store.getWorkflow(p.projectId).state, latestRelease: last ? { number: last.number, stage } : null };
  if (p.variantOf) {
    const s = variantStanding(p, base ? base.latest : null)!;
    const customers = customerMap(store, p);
    out.variant = {
      purpose: p.variantOf.purpose, label: p.variantOf.label, follows: s.follows, behind: s.behind, baseMissing: s.baseMissing || !base?.at,
      rulesDiffer: base?.at ? variantRulesDiffer(base.at, p) : null,
      differences: base?.at ? compareWithBase(base.at, p, { customers }).length : null,
    };
  }
  return out;
}

/** The family of a document: its base (itself, or the base it follows) and every variant of that base. */
export function familyOf(store: Store, project: Project): { base: FamilyMember | null; baseId: string; variants: FamilyMember[] } {
  const baseId = project.variantOf?.projectId ?? project.projectId;
  const base = store.getProject(baseId) ?? null;
  const variants = variantsOf(store, baseId).map((v) => {
    const found = baseOf(store, v);
    return member(store, v, found && !('missing' in found) ? { latest: found.latest, at: found.at } : base ? { latest: base.modelVersion } : null);
  });
  return { baseId, base: base ? member(store, base, null) : null, variants: variants.sort((a, b) => a.title.localeCompare(b.title)) };
}

/** What a release of a variant records about it (design rule 9). Null for a document that is not a variant. */
export function releaseVariantRecord(store: Store, project: Project): (VariantReleaseRecord & { baseFound: boolean }) | null {
  const v = project.variantOf;
  if (!v) return null;
  const found = baseOf(store, project);
  if (!found || 'missing' in found) return { baseId: v.projectId, baseTitle: v.baseTitle, baseVersion: v.modelVersion, baseDigest: v.contentDigest, purpose: v.purpose, label: v.label, differences: [], baseFound: false };
  return { ...variantReleaseRecord(found.at, project, { customers: customerMap(store, project) })!, baseFound: true };
}

/**
 * The base's own customers copied for a new variant of a document with its own data (design: "starts with a copy of
 * the base's customers"). Each copy remembers the customer it was copied from (`sourceId`), so the variant's pinned tests
 * and updates use the copies. Returns base record id → the copy's id.
 */
export function copyCustomers(store: Store, base: Project, variantId: string, prefix: string): Record<string, string> {
  const own = store.projectRecords(base.projectId);
  if (!own.length) return {};
  const copies = store.addProjectRecords(variantId, prefix, 'supplied', own.map((r) => {
    const { recordId: _id, projectId: _p, generated: _g, ...rest } = r as SyntheticRecord & Record<string, unknown>;
    return { ...rest, sourceId: r.recordId } as Omit<SyntheticRecord, 'recordId'>;
  }));
  return Object.fromEntries(own.map((r, i) => [r.recordId, copies[i].recordId]));
}

export { differenceCounts };
