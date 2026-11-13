import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LIBRARY_DESCRIPTION_MAX, LIBRARY_KIND_LABEL, LIBRARY_NOTE_MAX, LIBRARY_TITLE_MAX, checkLibraryContent, isLibraryKind, libraryContentFromProject, libraryListOf, linkFor, parseReleaseId, roleCan,
  type LibraryItemInfo, type LibraryKind, type LibrarySource, type Project,
} from '@iss/model';
import { audit } from '../auth';
import { LibraryStore, libraryUpdateImpact, libraryUsage } from '../library';
import type { RouteDeps } from './deps';

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/**
 * The shared library: `/api/v1/library`. Anyone signed in can read it; authors create items and drafts; approvers and
 * admins approve. Every write is audited with ids and titles only. Routes and shapes: docs/api/LIBRARY.md.
 */
export function registerLibraryRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, projectOr404, checkDraftProject } = deps;
  const library = new LibraryStore(store);
  const by = (req: FastifyRequest) => (req.user ? { id: req.user.id, name: req.user.name } : null);
  const role = (req: FastifyRequest) => req.user?.role;
  const can = (req: FastifyRequest) => ({ create: roleCan(role(req), 'edit'), approve: roleCan(role(req), 'approve') });
  const itemOr404 = (id: string): LibraryItemInfo => {
    const it = typeof id === 'string' && id.length <= 64 ? library.item(id) : undefined;
    if (!it) throw new ApiError(404, 'NOT_FOUND', `The library has no item ${String(id).slice(0, 64)}.`);
    return it;
  };
  const versionOf = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'INVALID_VERSION', 'version must be a whole number from 1.');
    return n;
  };
  const titleOf = (v: unknown) => {
    const t = oneLine(v, 200);
    if (t.length < 2 || t.length > LIBRARY_TITLE_MAX) throw new ApiError(400, 'INVALID_TITLE', `The name must be 2–${LIBRARY_TITLE_MAX} characters.`);
    return t;
  };
  /** Content from the request, checked for its kind: either sent as `content`, or taken from a saved document (`projectId` + `ref`). */
  const contentOf = (kind: LibraryKind, b: Record<string, any>) => {
    let raw = b.content;
    if (raw === undefined && typeof b.projectId === 'string') {
      const got = libraryContentFromProject(projectOr404(b.projectId), kind, typeof b.ref === 'string' ? b.ref : undefined);
      if ('error' in got) throw new ApiError(400, 'NOTHING_TO_ADD', got.error);
      raw = got.content;
    }
    if (raw === undefined) throw new ApiError(400, 'INVALID_CONTENT', 'Send the content of the item.');
    const c = checkLibraryContent(kind, raw);
    if (!c.ok) throw new ApiError(422, 'INVALID_CONTENT', c.problems[0], { problems: c.problems });
    return c.content;
  };
  const withUsage = (items: LibraryItemInfo[]) => {
    const usage = libraryUsage(store, items);
    return items.map((i) => { const u = usage.get(i.id) ?? []; return { ...i, usage: { documents: new Set(u.map((x) => x.projectId)).size, links: u.length, behind: u.filter((x) => x.behind).length } }; });
  };

  /** Items (filters: kind, q in the title or description, state = approved | draft). With their latest version, any draft, and how many documents use them. */
  app.get<{ Querystring: { kind?: string; q?: string; state?: string } }>('/api/v1/library', async (req) => {
    const { kind, q, state } = req.query;
    if (kind !== undefined && kind !== '' && !isLibraryKind(kind)) throw new ApiError(400, 'INVALID_KIND', `${kind} is not a kind of library item.`);
    const needle = (q ?? '').toLowerCase().trim();
    const items = library.list().filter((i) => (!kind || i.kind === kind) && (!needle || `${i.title} ${i.description}`.toLowerCase().includes(needle))
      && (!state || (state === 'draft' ? i.draft !== null : state === 'approved' ? i.latest !== null : true)));
    return { items: withUsage(items), can: can(req) };
  });

  /** One item with every version (newest first) and where it is used. */
  app.get<{ Params: { itemId: string } }>('/api/v1/library/:itemId', async (req) => {
    const item = itemOr404(req.params.itemId);
    return { item: withUsage([item])[0], usage: libraryUsage(store, [item]).get(item.id) ?? [], can: can(req) };
  });

  /** One version's content (`latest` = the latest approved one). */
  app.get<{ Params: { itemId: string; version: string } }>('/api/v1/library/:itemId/versions/:version', async (req) => {
    const item = itemOr404(req.params.itemId);
    const n = req.params.version === 'latest' ? undefined : versionOf(req.params.version);
    const got = library.content(item.id, n);
    if (!got) throw new ApiError(404, 'NOT_FOUND', n === undefined ? `“${item.title}” has no approved version yet.` : `“${item.title}” has no version ${n}.`);
    return { item: { id: item.id, kind: item.kind, title: item.title }, version: got.version, content: got.content };
  });

  /** Where an item is used: every document that links to it, at which version, and whether it is behind. */
  app.get<{ Params: { itemId: string } }>('/api/v1/library/:itemId/usage', async (req) => {
    const item = itemOr404(req.params.itemId);
    return { latest: item.latest, usage: libraryUsage(store, [item]).get(item.id) ?? [] };
  });

  /** A new item with its first version as a draft (authors and admins). */
  app.post<{ Body: Record<string, any> }>('/api/v1/library', async (req, reply) => {
    const b = req.body ?? {};
    if (!isLibraryKind(b.kind)) throw new ApiError(400, 'INVALID_KIND', 'Say what kind of item this is: brand, block, wording, glossary, wording-rules or lookup-table.');
    const kind = b.kind as LibraryKind;
    const title = titleOf(b.title);
    const description = oneLine(b.description, LIBRARY_DESCRIPTION_MAX);
    const note = oneLine(b.note, LIBRARY_NOTE_MAX) || 'First version';
    const all = library.list();
    if (all.some((i) => i.kind === kind && i.title.toLowerCase() === title.toLowerCase())) throw new ApiError(409, 'LIBRARY_NAME_TAKEN', `There is already a ${LIBRARY_KIND_LABEL[kind].toLowerCase()} called “${title}” in the library. Choose another name, or add a new version to it.`);
    const content = contentOf(kind, b);
    let source: LibrarySource | null = null;
    const srcId = typeof b.source?.projectId === 'string' ? b.source.projectId : typeof b.projectId === 'string' ? b.projectId : null;
    if (srcId) { const p = store.getProject(srcId); if (p) source = { projectId: p.projectId, projectTitle: p.title, ref: oneLine(b.source?.ref ?? b.ref ?? '', 100) }; }
    let id = slug(title);
    if (id.length < 2) id = `${id}-item`;
    for (let i = 2; all.some((x) => x.id === id); i++) id = `${slug(title).slice(0, 44)}-${i}`;
    const item = library.create({ id, kind, title, description, source, by: by(req) }, content, note);
    audit(store, req, 'library.create', { projectId: source?.projectId ?? null, detail: { itemId: item.id, title: item.title, kind, version: 1 } });
    reply.status(201);
    return { item: withUsage([item])[0] };
  });

  /** Saves the draft (a new version when there is none; the same draft edited otherwise). Approved versions are never changed. */
  app.put<{ Params: { itemId: string }; Body: Record<string, any> }>('/api/v1/library/:itemId/draft', async (req) => {
    const item = itemOr404(req.params.itemId);
    const b = req.body ?? {};
    const content = contentOf(item.kind, b);
    const meta: { title?: string; description?: string } = {};
    if (b.title !== undefined) {
      meta.title = titleOf(b.title);
      if (library.list().some((i) => i.id !== item.id && i.kind === item.kind && i.title.toLowerCase() === meta.title!.toLowerCase())) throw new ApiError(409, 'LIBRARY_NAME_TAKEN', `There is already a ${LIBRARY_KIND_LABEL[item.kind].toLowerCase()} called “${meta.title}”.`);
    }
    if (b.description !== undefined) meta.description = oneLine(b.description, LIBRARY_DESCRIPTION_MAX);
    const saved = library.saveDraft(item.id, content, oneLine(b.note, LIBRARY_NOTE_MAX), by(req), meta);
    audit(store, req, 'library.draft', { detail: { itemId: item.id, title: saved.item.title, kind: item.kind, version: saved.version, newVersion: saved.created } });
    return { item: withUsage([saved.item])[0], version: saved.version, created: saved.created };
  });

  /** Approves the draft (approvers and admins): it becomes the next approved version, frozen from now on. */
  app.post<{ Params: { itemId: string }; Body: Record<string, any> }>('/api/v1/library/:itemId/approve', async (req) => {
    const item = itemOr404(req.params.itemId);
    const note = req.body?.note === undefined ? undefined : oneLine(req.body.note, LIBRARY_NOTE_MAX) || undefined;
    const n = library.approve(item.id, by(req), note);
    if (n === null) throw new ApiError(409, 'NO_DRAFT', `“${item.title}” has no draft waiting for approval.`);
    const after = library.item(item.id)!;
    const usage = libraryUsage(store, [after]).get(item.id) ?? [];
    audit(store, req, 'library.approve', { detail: { itemId: item.id, title: item.title, kind: item.kind, version: n, documentsBehind: usage.filter((u) => u.behind).length } });
    return { item: withUsage([after])[0], version: n, usage };
  });

  /** Discards the draft (authors, approvers and admins). An item that never had an approved version is removed with it. */
  app.delete<{ Params: { itemId: string } }>('/api/v1/library/:itemId/draft', async (req) => {
    if (!roleCan(role(req), 'edit') && !roleCan(role(req), 'approve')) throw new ApiError(403, 'FORBIDDEN', 'Reviewers can see the library but not change it.', { role: role(req) ?? null });
    const item = itemOr404(req.params.itemId);
    const n = library.discardDraft(item.id);
    if (n === null) throw new ApiError(409, 'NO_DRAFT', `“${item.title}” has no draft to discard.`);
    const after = library.item(item.id) ?? null;
    audit(store, req, 'library.discard', { detail: { itemId: item.id, title: item.title, kind: item.kind, version: n, itemRemoved: !after } });
    return { item: after ? withUsage([after])[0] : null, discarded: n };
  });

  /**
   * Dry run: what updating document X's link to version N would change, and for which synthetic customers (the Before &
   * after engine). Nothing is stored. `project` may be sent to use the document as it is being edited.
   */
  app.post<{ Params: { itemId: string }; Body: Record<string, any> }>('/api/v1/library/:itemId/impact', async (req) => {
    const item = itemOr404(req.params.itemId);
    const b = req.body ?? {};
    const projectId = String(b.projectId ?? '');
    const project: Project = b.project ? checkDraftProject(b.project, projectId) : projectOr404(projectId);
    const n = versionOf(b.version) ?? item.latest;
    if (n === null || n === undefined) throw new ApiError(409, 'NO_APPROVED_VERSION', `“${item.title}” has no approved version yet.`);
    const got = library.content(item.id, n);
    if (!got || got.version.state !== 'approved') throw new ApiError(409, 'NOT_APPROVED', `Version ${n} of “${item.title}” is not approved, so no document can use it.`);
    const link = typeof b.linkId === 'string' ? linkFor(project, b.linkId) : (project.libraryLinks ?? []).find((l) => l.itemId === item.id);
    if (!link || link.itemId !== item.id) throw new ApiError(404, 'NOT_LINKED', `“${project.title}” does not use “${item.title}”.`);
    const records = deps.allRecords(project.projectId).filter((x) => x.documentType === project.documentType && (!x.projectId || x.projectId === project.projectId));
    try {
      const impact = libraryUpdateImpact(project, link.linkId, { version: n, content: got.content, title: item.title }, records);
      const { project: _p, ...rest } = impact;
      return { ...rest, content: got.content, version: got.version };
    } catch (e: any) { throw new ApiError(409, 'CANNOT_UPDATE', String(e?.message ?? e)); }
  });

  /** What a release took from the library (frozen with it): item ids, titles, kinds and versions. */
  app.get<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId/library', async (req) => {
    const r = parseReleaseId(req.params.releaseId) ? store.release(req.params.releaseId) : undefined;
    if (!r) throw new ApiError(404, 'NOT_FOUND', `This studio has no release ${String(req.params.releaseId).slice(0, 80)}.`);
    const frozen = store.releaseProject(r.id);
    if (!frozen) throw new ApiError(410, 'RELEASE_CONTENT_MISSING', `The stored content of release ${r.number} is missing.`);
    const known = new Set(library.list().map((i) => i.id));
    return { library: libraryListOf(frozen).map((x) => ({ ...x, inLibrary: known.has(x.itemId) })) };
  });

  /** Test and demo reset: removes every item and version. Refused unless the server was started with LIBRARY_RESET=allow. */
  app.post<{ Body: Record<string, any> }>('/api/v1/library/reset', async (req) => {
    if (process.env.LIBRARY_RESET !== 'allow') throw new ApiError(403, 'RESET_DISABLED', 'Approved library versions are never deleted. (A test or demo server can allow this reset with LIBRARY_RESET=allow.)');
    if (req.body?.confirm !== true) throw new ApiError(400, 'CONFIRM_REQUIRED', 'Send { "confirm": true } to remove every library item.');
    const removed = library.clear();
    audit(store, req, 'library.reset', { detail: { removed } });
    return { removed };
  });
}
