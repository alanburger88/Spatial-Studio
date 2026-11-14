import { canonicalJson } from './digest';
import type { DocNode, Project, VariantOf, VariantPurpose } from './types';

/**
 * Variants by brand or region (wave 5, section 1): what stays the base's in a variant ("the lock", design rule 3).
 *
 * A variant is an ordinary, complete document. Its data fields, calculations, the document's date, the page design and
 * the position, size and order of the base's components stay exactly the base's; everything else is the variant's to
 * change. A component the variant added itself is free. This file is small on purpose: `applyCommand` uses it, so it is
 * part of the first download. The comparison, the update and "use the base's again" are in `variants.ts`.
 *
 * The lock is checked by result, like the library's read-only rule: `applyCommand` applies a command and then compares
 * the locked parts before and after, so a command added later cannot slip past it. The server checks the same parts of
 * a saved variant against the base at the version it follows (`variantLockProblem(baseVersion, variant)`).
 */

export const VARIANT_PURPOSES: readonly VariantPurpose[] = ['brand', 'region', 'other'];
export const VARIANT_LABEL_MAX = 60;

/** The project-level parts that stay the base's, with the words used in a refusal. */
const LOCKED_FIELDS: ReadonlyArray<{ key: keyof Project; what: string; them: boolean }> = [
  { key: 'customFields', what: 'The data fields', them: true },
  { key: 'calculatedFields', what: 'The calculations', them: true },
  { key: 'documentDate', what: 'Where the document’s date comes from', them: false },
  { key: 'presentationProfiles', what: 'The page design', them: false },
  { key: 'rootNodeId', what: 'The top of the document', them: false },
  { key: 'documentType', what: 'The kind of document', them: false },
];

/** The project-level keys the lock covers (for the comparison and the update, which always take the base's value). */
export const VARIANT_LOCKED_KEYS: ReadonlySet<string> = new Set(LOCKED_FIELDS.map((f) => f.key as string));

export interface VariantLockHit { message: string; nodeId?: string; part: string }

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const named = (n: DocNode) => n.name ?? n.label ?? n.id;

/** The plain message for a locked part: what it is, where it comes from, and the two ways forward. */
export function variantLockedMessage(variantOf: Pick<VariantOf, 'baseTitle'>, what: string, them = false): string {
  return `${what} ${them ? 'come' : 'comes'} from the base document “${variantOf.baseTitle}”. Change ${them ? 'them' : 'it'} there, or detach this variant.`;
}

function parents(project: Project): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of project.nodes) for (const c of n.children ?? []) m.set(c, n.id);
  return m;
}

/**
 * The first locked part that differs between `reference` and `candidate` (null when the lock holds). `reference` is the
 * variant before a command, or the base at the followed version (the server's check on save). Only the base's
 * components (`baseNodeIds`) present in both are compared: a hidden base component and the variant's own are free.
 * A base component that `candidate` has but `reference` does not is refused: it can only come back with
 * "Use the base's again" or an update, which carry the base's own copy.
 */
export function variantLockProblem(reference: Project, candidate: Project, variantOf: VariantOf | undefined = candidate.variantOf ?? reference.variantOf): VariantLockHit | null {
  if (!variantOf) return null;
  for (const f of LOCKED_FIELDS) if (!same(reference[f.key], candidate[f.key])) return { part: String(f.key), message: variantLockedMessage(variantOf, f.what, f.them) };
  const base = new Set(variantOf.baseNodeIds);
  const R = new Map(reference.nodes.map((n) => [n.id, n])), C = new Map(candidate.nodes.map((n) => [n.id, n]));
  const pr = parents(reference), pc = parents(candidate);
  for (const n of candidate.nodes) {
    if (!base.has(n.id)) continue;
    const r = R.get(n.id);
    if (!r) return { part: 'component', nodeId: n.id, message: `“${named(n)}” is a component of the base document “${variantOf.baseTitle}” that this variant hides. Bring it back with “Use the base’s again” on Overview, or detach this variant.` };
    if (r.type !== n.type) return { part: 'component', nodeId: n.id, message: variantLockedMessage(variantOf, `The kind of component “${named(n)}”`) };
    if (!same(r.layout, n.layout)) return { part: 'layout', nodeId: n.id, message: variantLockedMessage(variantOf, `The position and size of “${named(n)}”`, true) };
    // A repeating section (richer data shapes): which list a base section repeats over, and how, is part of the page's structure.
    if (!same(r.repeat, n.repeat)) return { part: 'repeat', nodeId: n.id, message: variantLockedMessage(variantOf, `What “${named(n)}” repeats for`) };
    if ((pr.get(n.id) ?? null) !== (pc.get(n.id) ?? null)) return { part: 'place', nodeId: n.id, message: variantLockedMessage(variantOf, `The place of “${named(n)}” in the document`) };
  }
  // The order of the base's components inside each container (the variant's own components and hidden ones aside).
  for (const n of candidate.nodes) {
    const r = R.get(n.id);
    if (!r || !base.has(n.id)) continue;
    const keep = (id: string) => base.has(id) && R.has(id) && C.has(id);
    const a = (r.children ?? []).filter(keep), b = (n.children ?? []).filter(keep);
    if (!same(a, b)) {
      const moved = b.find((id, i) => a[i] !== id) ?? n.id;
      return { part: 'order', nodeId: moved, message: variantLockedMessage(variantOf, `The order of the components in “${named(n)}”`) };
    }
  }
  return null;
}

/** Whether a component is the base's in this variant (its place and size are locked), as opposed to the variant's own. */
export function isBaseComponent(project: Project, nodeId: string): boolean {
  return !!project.variantOf?.baseNodeIds.includes(nodeId);
}

/** Problems with a project's `variantOf` as read from a file or a request (empty when absent or well formed). */
export function variantOfProblems(p: { projectId?: unknown; variantOf?: unknown; nodes?: unknown }): string[] {
  const v = p.variantOf as Record<string, unknown> | undefined;
  if (v === undefined) return [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['What the document is a variant of cannot be read.'];
  const out: string[] = [];
  if (typeof v.projectId !== 'string' || !/^[a-z0-9-]{3,64}$/.test(v.projectId)) out.push('The variant does not name its base document.');
  else if (v.projectId === p.projectId) out.push('A document cannot be a variant of itself.');
  if (!Number.isInteger(v.modelVersion) || (v.modelVersion as number) < 1) out.push('The variant does not say which version of its base it follows.');
  if (typeof v.contentDigest !== 'string' || !/^[0-9a-f]{16,64}$/.test(v.contentDigest)) out.push('The variant does not carry the digest of the base version it follows.');
  if (!VARIANT_PURPOSES.includes(v.purpose as VariantPurpose)) out.push('A variant is for a brand, a region or other.');
  if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > VARIANT_LABEL_MAX) out.push(`Say what the variant is for (1 to ${VARIANT_LABEL_MAX} characters).`);
  if (typeof v.baseTitle !== 'string' || !v.baseTitle.trim()) out.push('The variant does not name its base document.');
  if (!Array.isArray(v.baseNodeIds) || v.baseNodeIds.some((x) => typeof x !== 'string')) out.push('The variant’s list of the base’s components cannot be read.');
  return out;
}
