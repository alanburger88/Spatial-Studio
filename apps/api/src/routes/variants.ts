import type { FastifyInstance } from 'fastify';
import {
  RECORD_ID_PREFIX, compareWithBase, diffProjects, differenceCounts, makeVariant, mergeVariantUpdate, projectContentDigest, VARIANT_LABEL_MAX, VARIANT_PURPOSES,
  type Project, type VariantPurpose,
} from '@iss/model';
import { audit } from '../auth';
import { ensureCustomer } from '../projectCustomers';
import { BASE_MISSING_WORDS, baseOf, copyCustomers, customerMap, familyOf, variantsOf } from '../variants';
import type { RouteDeps } from './deps';

/**
 * Variants by brand or region (wave 5, section 1; `docs/api/VARIANTS.md`).
 *
 *   POST /api/v1/projects/:projectId/variants   make a variant of this document (edit rights)
 *   GET  /api/v1/projects/:projectId/family     the base and its variants, with where each stands
 *   GET  /api/v1/projects/:projectId/variant    for a variant: what differs from the base, and what the base changed since
 *
 * The save-time lock, the delete rule and the release record live where saving, deleting and releasing already are
 * (`app.ts`, `releases.ts`); they call `variants.ts`. Activity entries carry ids and counts only.
 */
export function registerVariantRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, projectOr404 } = deps;
  const by = (req: { user?: { id: string; name: string } }) => (req.user ? { id: req.user.id, name: req.user.name } : null);
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'variant';

  app.post<{ Params: { projectId: string }; Body: Record<string, unknown> }>('/api/v1/projects/:projectId/variants', async (req, reply) => {
    const base = projectOr404(req.params.projectId);
    if (base.variantOf) throw new ApiError(400, 'VARIANT_ONE_LEVEL', `“${base.title}” is itself a variant of “${base.variantOf.baseTitle}”. A variant cannot be the base of another variant; make the new variant from “${base.variantOf.baseTitle}”.`);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof b.title === 'string' ? b.title.trim().replace(/\s+/g, ' ') : '';
    if (title.length < 2 || title.length > 80) throw new ApiError(400, 'INVALID_TITLE', 'Give the variant a name of 2 to 80 characters.');
    const purpose = b.purpose as VariantPurpose;
    if (!VARIANT_PURPOSES.includes(purpose)) throw new ApiError(400, 'INVALID_PURPOSE', 'Say what the variant is for: a brand, a region or other.');
    const label = typeof b.label === 'string' ? b.label.trim().replace(/\s+/g, ' ') : '';
    if (!label || label.length > VARIANT_LABEL_MAX) throw new ApiError(400, 'INVALID_LABEL', `Say which brand or region it is for (1 to ${VARIANT_LABEL_MAX} characters).`);
    // The variant follows the base's latest SAVED version (the history always holds it).
    const saved = store.getVersion(base.projectId, base.modelVersion);
    const at: Project = saved?.project ?? base;
    let id = slug(title); if (id.length < 3) id = `${id}-variant`;
    for (let i = 2; store.getProject(id) || store.hasReleases(id); i++) id = `${slug(title).slice(0, 36)}-${i}`;
    // A document with its own data: the variant starts with copies of the base's customers (its pinned tests use them).
    const customers = at.documentType === 'custom' ? copyCustomers(store, at, id, RECORD_ID_PREFIX.custom ?? 'REC') : {};
    const variant = makeVariant(at, { projectId: id, title, purpose, label, customers });
    const stored = store.putProject(variant, projectContentDigest(variant), { by: by(req), label: `Variant of “${at.title}” v${at.modelVersion}` });
    if (stored.documentType === 'custom') ensureCustomer(store, stored);
    audit(store, req, 'project.variant.create', { projectId: stored.projectId, modelVersion: stored.modelVersion, detail: { baseId: at.projectId, baseVersion: at.modelVersion, purpose, customers: Object.keys(customers).length } });
    reply.status(201);
    return { project: stored, variantOf: stored.variantOf, customers: Object.keys(customers).length };
  });

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/family', async (req) => {
    const p = projectOr404(req.params.projectId);
    return familyOf(store, p);
  });

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/variant', async (req) => {
    const p = projectOr404(req.params.projectId);
    if (!p.variantOf) {
      const variants = variantsOf(store, p.projectId).map((v) => v.projectId);
      return { projectId: p.projectId, variant: false, variants };
    }
    const found = baseOf(store, p)!;
    if ('missing' in found) return { projectId: p.projectId, variant: true, variantOf: p.variantOf, base: { found: false, reason: found.missing, message: BASE_MISSING_WORDS[found.missing] } };
    const customers = customerMap(store, p);
    const differences = compareWithBase(found.at, p, { customers });
    const behind = found.latest > p.variantOf.modelVersion;
    const update = behind ? (() => {
      const now = store.getVersion(found.base.projectId, found.latest)?.project ?? found.base;
      const u = mergeVariantUpdate({ ancestor: found.at, base: now, variant: p, customers });
      return { fromVersion: u.fromVersion, toVersion: u.toVersion, baseChanges: diffProjects(found.at, now).summary, comesIn: u.comesIn, kept: u.kept, needsLook: u.needsLook };
    })() : null;
    return {
      projectId: p.projectId, variant: true, variantOf: p.variantOf,
      base: { found: true, projectId: found.base.projectId, title: found.base.title, latestVersion: found.latest, follows: p.variantOf.modelVersion, behind },
      customers, differences, counts: differenceCounts(differences), update,
    };
  });
}
