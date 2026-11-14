import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LIBRARY_DESCRIPTION_MAX, LIBRARY_KIND_LABEL, LIBRARY_NOTE_MAX, LIBRARY_TITLE_MAX, SOURCE_LANGUAGE, WORKFLOW_LABEL, checkLibraryContent, isLibraryKind, isSupportedLanguage,
  libraryContentFromProject, libraryListOf, linkFor, parseReleaseId, roleCan,
  wordingSeverityProblem, type LibraryWordingContent, type LibraryWordingRulesContent,
  type LibraryItemInfo, type LibraryKind, type LibrarySource, type Project,
} from '@iss/model';
import {
  DEFAULT_DUPLICATE_KINDS, DEFAULT_DUPLICATE_MIN_WORDS, DEFAULT_DUPLICATE_THRESHOLD, DUPLICATE_KINDS, MIN_DUPLICATE_THRESHOLD,
  approvedTranslationsOf, findDuplicateWording, normalizeWording, sharedTranslations, wordingReleaseRecord, wordingTexts,
  type DuplicateKind, type DuplicateOptions,
} from '@iss/scenarios';
import { audit } from '../auth';
import { DuplicateScanCache, LibraryStore, duplicateSources, libraryLinkImpact, libraryUpdateImpact, libraryUsage, wordingDifference } from '../library';
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
  // `setSeverity`: only an admin decides whether a house wording rule is a "must" or a "should" (section 4 of the wave 2 design).
  const can = (req: FastifyRequest) => ({ create: roleCan(role(req), 'edit'), approve: roleCan(role(req), 'approve'), setSeverity: role(req) === 'admin' });
  /** Refuses a wording-rules draft in which someone who is not an admin set or changed whether a rule is a "must" or a "should". */
  const checkSeverity = (req: FastifyRequest, base: LibraryWordingRulesContent | null, next: LibraryWordingRulesContent) => {
    const why = wordingSeverityProblem(base?.rules ?? null, next.rules, role(req) === 'admin');
    if (why) throw new ApiError(403, 'SEVERITY_ADMIN_ONLY', why, { role: role(req) ?? null });
  };
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
    if (kind === 'wording-rules') checkSeverity(req, null, content as LibraryWordingRulesContent);
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
    if (item.kind === 'wording-rules') checkSeverity(req, (library.content(item.id, item.draft ?? undefined)?.content ?? null) as LibraryWordingRulesContent | null, content as LibraryWordingRulesContent);
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
    // The wording rules in force when it was approved and what the checker found in the frozen content (null: none).
    return { library: libraryListOf(frozen).map((x) => ({ ...x, inLibrary: known.has(x.itemId) })), wordingRules: wordingReleaseRecord(frozen) };
  });

  /* ---------------------------------------------------------------- duplicate wording (wave 3, section 2) */

  const scans = new DuplicateScanCache();
  const optionsOf = (q: Record<string, string | undefined>): Required<Pick<DuplicateOptions, 'threshold' | 'kinds' | 'minWords'>> & { language: string | null } => {
    const threshold = q.threshold === undefined || q.threshold === '' ? DEFAULT_DUPLICATE_THRESHOLD : Number(q.threshold);
    if (!Number.isFinite(threshold) || threshold < MIN_DUPLICATE_THRESHOLD || threshold > 1) throw new ApiError(400, 'INVALID_THRESHOLD', `The threshold for “nearly the same” must be a number from ${MIN_DUPLICATE_THRESHOLD} to 1.`);
    const kinds = q.kinds ? q.kinds.split(',').map((k) => k.trim()).filter(Boolean) : [...DEFAULT_DUPLICATE_KINDS];
    const bad = kinds.find((k) => !(DUPLICATE_KINDS as readonly string[]).includes(k));
    if (bad || !kinds.length) throw new ApiError(400, 'INVALID_KINDS', `Say which kinds of text to compare: ${DUPLICATE_KINDS.join(', ')}.`);
    const language = q.language ? q.language : null;
    if (language && !isSupportedLanguage(language)) throw new ApiError(400, 'INVALID_LANGUAGE', `${language.slice(0, 20)} is not a language the studio supports.`);
    const minWords = q.minWords === undefined || q.minWords === '' ? DEFAULT_DUPLICATE_MIN_WORDS : Number(q.minWords);
    if (!Number.isInteger(minWords) || minWords < 1 || minWords > 50) throw new ApiError(400, 'INVALID_MIN_WORDS', 'The shortest text compared must be from 1 to 50 words.');
    return { threshold: Math.round(threshold * 1000) / 1000, kinds: kinds as DuplicateKind[], language, minWords };
  };

  /**
   * Duplicate wording: every saved document and the library's wording items, grouped by texts that are the same or nearly
   * the same. It reads and changes nothing. Wording is document content (ids, titles and texts), never customer data.
   * Cached by what it read (each document's version and content, each wording item's versions) and how it was asked.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/library/duplicates', async (req) => {
    const opts = optionsOf(req.query ?? {});
    const t0 = performance.now();
    const src = duplicateSources(store, library);
    const key = `${src.key}|${opts.threshold}|${[...opts.kinds].sort().join(',')}|${opts.language ?? ''}|${opts.minWords}`;
    let hit = scans.get(key);
    const cached = !!hit;
    if (!hit) {
      const s0 = performance.now();
      const scan = findDuplicateWording(src.documents(), src.items(), opts);
      hit = { scan, tookMs: Math.round(performance.now() - s0) };
      scans.set(key, hit);
    }
    const documents = src.summaries.map((s) => ({ projectId: s.projectId, title: s.title, documentType: s.documentType, modelVersion: s.modelVersion, workflowState: store.getWorkflow(s.projectId).state }));
    return { ...hit.scan, documents, tookMs: hit.tookMs, cached, servedInMs: Math.round(performance.now() - t0), can: { ...can(req), link: roleCan(role(req), 'edit') } };
  });

  /**
   * "Keep this wording in the library": a new wording item, as a draft, from the chosen (or edited) English text, with the
   * translations every member of the group shares exactly (a language any member lacks or words differently is left out).
   * Approved in the usual way. Members are `{ projectId, textId }` (a saved document's text) or `{ itemId }` (a library item).
   */
  app.post<{ Body: Record<string, any> }>('/api/v1/library/duplicates/keep', async (req, reply) => {
    const b = req.body ?? {};
    const title = titleOf(b.title);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) throw new ApiError(400, 'INVALID_CONTENT', 'Send the wording to keep.');
    const members = Array.isArray(b.members) ? b.members.slice(0, 500) : [];
    if (members.length < 1) throw new ApiError(400, 'NO_MEMBERS', 'Say which texts this wording is kept for.');
    if (library.list().some((i) => i.kind === 'wording' && i.title.toLowerCase() === title.toLowerCase())) throw new ApiError(409, 'LIBRARY_NAME_TAKEN', `There is already a wording called “${title}” in the library. Choose another name.`);
    const english: string[] = [];
    const translations: Array<Record<string, string>> = [];
    // The heading customers read above a message (the message's title) and its translations, for members that are messages.
    const headings: Array<{ title: string; translations: Record<string, string> }> = [];
    const projects = new Set<string>();
    for (const m of members) {
      if (typeof m?.itemId === 'string') {
        const it = library.item(m.itemId);
        const got = it?.kind === 'wording' ? library.content(it.id, it.latest ?? it.draft ?? undefined) : undefined;
        if (!got) throw new ApiError(404, 'NOT_FOUND', `The library has no wording ${String(m.itemId).slice(0, 64)}.`);
        const w = got.content as LibraryWordingContent;
        const { [SOURCE_LANGUAGE]: en, ...rest } = w.part.approvedLocales;
        english.push(en ?? ''); translations.push(rest);
        headings.push({ title: w.part.title, translations: { ...(w.titleTranslations ?? {}) } });
      } else {
        const p = projectOr404(String(m?.projectId ?? ''));
        const textId = String(m?.textId ?? '');
        const t = wordingTexts(p, [SOURCE_LANGUAGE]).find((x) => x.id === textId);
        if (!t) throw new ApiError(404, 'NOT_FOUND', `“${p.title}” has no text ${textId.slice(0, 80)} a customer reads.`);
        english.push(t.text); translations.push(approvedTranslationsOf(p, textId)); projects.add(p.projectId);
        const part = p.contentParts.find((c) => c.id === textId);
        if (part) headings.push({ title: part.title, translations: approvedTranslationsOf(p, `@title/${part.id}`) });
      }
    }
    // Translations belong to the English they translate: when the kept text is not the wording of every member, none are carried.
    const same = english.every((e) => normalizeWording(e) === normalizeWording(text));
    const shared = same ? sharedTranslations(translations) : {};
    const offered = [...new Set(translations.flatMap((t) => Object.keys(t)))].sort();
    const type = b.type === 'disclosure' ? 'disclosure' : 'text';
    // The heading: the one the person gave, else the members' own heading (so linking does not change it), else the name.
    const heading = oneLine(b.heading, LIBRARY_TITLE_MAX) || headings[0]?.title || title;
    const sameHeading = headings.length > 0 && headings.every((h) => h.title === heading);
    const titleTranslations = sameHeading ? sharedTranslations(headings.map((h) => h.translations)) : {};
    const content = contentOf('wording', { content: { part: { id: slug(title), title: heading, type, approvedLocales: { [SOURCE_LANGUAGE]: text, ...shared } }, ...(Object.keys(titleTranslations).length ? { titleTranslations } : {}) } });
    let id = slug(title);
    const all = library.list();
    for (let i = 2; all.some((x) => x.id === id); i++) id = `${slug(title).slice(0, 44)}-${i}`;
    let source: LibrarySource | null = null;
    if (typeof b.source?.projectId === 'string') { const p = store.getProject(b.source.projectId); if (p) source = { projectId: p.projectId, projectTitle: p.title, ref: oneLine(b.source.ref ?? '', 100) }; }
    const item = library.create({ id, kind: 'wording', title, description: oneLine(b.description, LIBRARY_DESCRIPTION_MAX), source, by: by(req) }, content, oneLine(b.note, LIBRARY_NOTE_MAX) || 'Kept from duplicate wording');
    audit(store, req, 'library.create', { projectId: source?.projectId ?? null, detail: { itemId: item.id, title: item.title, kind: 'wording', version: 1, fromDuplicates: true, members: members.length, documents: projects.size, languages: Object.keys(shared) } });
    reply.status(201);
    return { item: withUsage([item])[0], translations: Object.keys(shared), notCarried: offered.filter((l) => !(l in shared)), edited: !same };
  });

  const wordingOr409 = (item: LibraryItemInfo) => {
    if (item.kind !== 'wording') throw new ApiError(400, 'NOT_WORDING', `“${item.title}” is not a wording item.`);
    if (item.latest === null) throw new ApiError(409, 'NO_APPROVED_VERSION', `“${item.title}” has no approved version yet. An approver approves it first.`);
    return library.content(item.id, item.latest)!;
  };
  const recordsFor = (project: Project) => deps.allRecords(project.projectId).filter((x) => x.documentType === project.documentType && (!x.projectId || x.projectId === project.projectId));

  /**
   * Dry run of "Link here": what linking one of a document's messages to the latest approved version of a wording item would
   * change, in words, and which synthetic customers would read something different. Nothing is stored.
   */
  app.post<{ Params: { itemId: string }; Body: Record<string, any> }>('/api/v1/library/:itemId/link-preview', async (req) => {
    const item = itemOr404(req.params.itemId);
    const got = wordingOr409(item);
    const b = req.body ?? {};
    const projectId = String(b.projectId ?? '');
    const project: Project = b.project ? checkDraftProject(b.project, projectId) : projectOr404(projectId);
    const partId = String(b.partId ?? '');
    try {
      const impact = libraryLinkImpact(project, item, got.version.version, got.content as LibraryWordingContent, partId, recordsFor(project));
      const { project: _p, ...rest } = impact;
      return { ...rest, itemId: item.id, title: item.title, version: got.version, content: got.content };
    } catch (e: any) { throw new ApiError(409, 'CANNOT_LINK', String(e?.message ?? e)); }
  });

  /**
   * "Link in all draft documents": for each chosen document whose message is EXACTLY the library's wording (text,
   * translations, heading and kind, and no synthetic customer would read anything different) and whose workflow state is
   * draft, links it and saves a new version, as the document's save does (checked, stored with its history, audited).
   * It never approves anything; a document in review or approved is refused and listed, to be linked there.
   */
  app.post<{ Params: { itemId: string }; Body: Record<string, any> }>('/api/v1/library/:itemId/link-drafts', async (req) => {
    const item = itemOr404(req.params.itemId);
    const got = wordingOr409(item);
    const content = got.content as LibraryWordingContent;
    const targets = Array.isArray(req.body?.targets) ? req.body.targets.slice(0, 100) : [];
    if (!targets.length) throw new ApiError(400, 'NO_TARGETS', 'Say which documents to link.');
    const linked: Array<{ projectId: string; title: string; partId: string; linkId: string; fromVersion: number; toVersion: number }> = [];
    const refused: Array<{ projectId: string; title: string | null; partId: string; code: string; reason: string; state?: string }> = [];
    for (const t of targets) {
      const projectId = String(t?.projectId ?? '').slice(0, 100), partId = String(t?.partId ?? '').slice(0, 100);
      const current = store.getProject(projectId);
      const no = (code: string, reason: string, state?: string) => refused.push({ projectId, title: current?.title ?? null, partId, code, reason, ...(state ? { state } : {}) });
      if (!current) { no('NOT_FOUND', 'This studio has no such document.'); continue; }
      const state = store.getWorkflow(projectId).state;
      if (state !== 'draft') { no('NOT_DRAFT', `The document is ${WORKFLOW_LABEL[state].toLowerCase()}: open it and link it there, so the change goes through its review.`, state); continue; }
      if (t.modelVersion !== undefined && Number(t.modelVersion) !== current.modelVersion) { no('VERSION_CONFLICT', `The document has been saved since the scan (it is now version ${current.modelVersion}). Scan again.`); continue; }
      const why = wordingDifference(current, partId, content);
      if (why) { no('NOT_EXACT', `${why} Open the document and use “Link here” to review the difference first.`); continue; }
      try {
        const impact = libraryLinkImpact(current, item, got.version.version, content, partId, recordsFor(current));
        if (!impact.identical) { no('NOT_EXACT', `${impact.difference ?? 'Some customers would read something different.'} Open the document and use “Link here” to review it first.`); continue; }
        const next = checkDraftProject(impact.project, projectId);
        const saved = store.putProject(next, undefined, { by: by(req), label: `Linked “${item.title}” from the library (version ${got.version.version})` });
        const link = (saved.libraryLinks ?? []).find((l) => l.itemId === item.id && l.target.kind === 'wording' && l.target.partId === partId)!;
        audit(store, req, 'library.link', { projectId, modelVersion: saved.modelVersion, detail: { itemId: item.id, title: item.title, kind: item.kind, version: got.version.version, partId, linkId: link.linkId, fromVersion: current.modelVersion, toVersion: saved.modelVersion, bulk: true } });
        linked.push({ projectId, title: saved.title, partId, linkId: link.linkId, fromVersion: current.modelVersion, toVersion: saved.modelVersion });
      } catch (e: any) { no('CANNOT_LINK', String(e?.message ?? e)); }
    }
    return { item: { id: item.id, title: item.title, version: got.version.version }, linked, refused };
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
