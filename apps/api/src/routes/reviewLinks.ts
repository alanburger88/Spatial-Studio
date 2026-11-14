import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DOCUMENT_TYPE_LABEL, roleCan, sanitizeCommentBody, type Project, type SyntheticRecord } from '@iss/model';
import { renderPagedDocument } from '@iss/renderers';
import { audit } from '../auth';
import type { StoredRelease } from '../db';
import { issueWords, produceOne } from '../proofs';
import { releaseTemplate, type PackageComposer } from '../releasePackage';
import {
  DEAD_LINK, KIND_REASON, OutputLimiter, REVIEW_BANNER, REVIEW_LINK_LIMITS, REVIEW_OUTPUTS, REVIEW_OUTPUT_LABEL, REVIEW_TOKEN_PATTERN, ReviewLinkStore,
  approvedLanguages, cleanLinkLabel, cleanReviewerName, commentParts, customerChoices, customerName, languageChoice, linkStatus, linkTemplate,
  newReviewToken, onReviewLinkComment, reviewTokenHash, type ReviewOutput, type StoredReviewLink,
} from '../reviewLinks';
import { notify } from '../notifications';
import type { RouteDeps } from './deps';

/**
 * Review links (docs/api/REVIEW_LINKS.md). Two kinds of route:
 *
 * - For signed-in users, under `/api/v1/projects/:projectId/review-links`: what may be put in a link, make one, list
 *   them, revoke one. Making one needs `comment` (auth.ts); revoking is checked here (its creator, an approver or an admin).
 * - Five public routes under `/api/v1/review/:token/`. The token in the address is their only key. They read
 *   nothing else from the request (no session, no cookie), set no cookie, and every dead or wrong token gets the same
 *   answer. Every reply carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`.
 *
 * Audit entries carry ids and counts only: never the token, the label, a typed name or a customer's name.
 */
export function registerReviewLinkRoutes(app: FastifyInstance, deps: RouteDeps, opts: { composer: PackageComposer }): void {
  const { store, ApiError } = deps;
  const links = new ReviewLinkStore(store);
  const limiter = new OutputLimiter();
  const by = (req: FastifyRequest) => (req.user ? { id: req.user.id, name: req.user.name } : null);
  const dead = () => new ApiError(DEAD_LINK.status, DEAD_LINK.code, DEAD_LINK.message);

  // Rule 12: every reply of the public routes, the dead-link answer included.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/v1/review/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Robots-Tag', 'noindex');
      reply.removeHeader('set-cookie');
    }
    return payload;
  });

  /* ------------------------------------------------------------ shared */

  const outputsOf = (v: unknown): ReviewOutput[] => {
    if (v === undefined || v === null) return [...REVIEW_OUTPUTS];
    if (!Array.isArray(v) || !v.length || v.some((o) => !(REVIEW_OUTPUTS as readonly string[]).includes(o))) throw new ApiError(400, 'INVALID_OUTPUTS', `Choose at least one output: ${REVIEW_OUTPUTS.join(', ')}.`);
    return REVIEW_OUTPUTS.filter((o) => v.includes(o));
  };
  const releaseOf = (l: Pick<StoredReviewLink, 'releaseId'>): StoredRelease | null => (l.releaseId ? store.release(l.releaseId) ?? null : null);
  const withdrawn = (r: StoredRelease | null) => !!r && (r.stages.test.status === 'withdrawn' || r.stages.production?.status === 'withdrawn');

  /** The frozen thing a new link would point to: a release of this document, or one of its saved versions. */
  function targetOf(project: Project, q: { releaseId?: unknown; version?: unknown }): { releaseId: string | null; release: StoredRelease | null; modelVersion: number; template: Project } {
    if (typeof q.releaseId === 'string' && q.releaseId) {
      const r = store.release(q.releaseId);
      if (!r || r.documentId !== project.projectId) throw new ApiError(404, 'NOT_FOUND', 'This document has no such release.');
      if (r.documentRemovedAt) throw new ApiError(409, 'DOCUMENT_REMOVED', 'The document of this release was deleted.');
      const frozen = store.releaseProject(r.id);
      if (!frozen) throw new ApiError(410, 'RELEASE_CONTENT_MISSING', `The stored content of release ${r.number} is missing.`);
      return { releaseId: r.id, release: r, modelVersion: r.modelVersion, template: releaseTemplate(frozen) };
    }
    if (q.version !== undefined && q.version !== null && q.version !== '') {
      const n = Number(q.version);
      if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'INVALID_VERSION', 'The version must be a whole number.');
      const v = store.getVersion(project.projectId, n);
      if (!v) throw new ApiError(404, 'NOT_FOUND', `Version ${n} of this document is not in its history.`);
      return { releaseId: null, release: null, modelVersion: n, template: releaseTemplate(v.project) };
    }
    throw new ApiError(400, 'TARGET_REQUIRED', 'Say which release (releaseId) or saved version (version) the link is for.');
  }

  const targetInfo = (l: Pick<StoredReviewLink, 'releaseId' | 'modelVersion'>) => {
    const r = releaseOf(l);
    return l.releaseId ? { kind: 'release' as const, releaseId: l.releaseId, releaseNumber: r?.number ?? null, version: l.modelVersion } : { kind: 'version' as const, releaseId: null, releaseNumber: null, version: l.modelVersion };
  };
  const mayRevoke = (req: FastifyRequest, l: StoredReviewLink) => !!req.user && (roleCan(req.user.role, 'approve') || (!!l.createdBy?.id && l.createdBy.id === req.user.id));
  /** A link as the studio sees it. Never the token: it is not stored. */
  const linkInfo = (req: FastifyRequest, l: StoredReviewLink) => ({
    id: l.id, label: l.label, target: targetInfo(l), customers: l.customers, languages: l.languages, outputs: l.outputs,
    createdBy: l.createdBy, createdAt: l.createdAt, expiresAt: l.expiresAt, status: linkStatus(l), revokedAt: l.revokedAt, revokedBy: l.revokedBy,
    opens: l.opens, firstOpenedAt: l.firstOpenedAt, lastOpenedAt: l.lastOpenedAt, comments: links.commentCount(l.id), mayRevoke: mayRevoke(req, l),
  });

  /* ------------------------------------------------------------ for signed-in users */

  app.get<{ Params: { projectId: string }; Querystring: { releaseId?: string; version?: string } }>('/api/v1/projects/:projectId/review-links/options', async (req) => {
    const project = deps.projectOr404(req.params.projectId);
    const t = targetOf(project, req.query);
    const customers = customerChoices(store, project, deps.allRecords(project.projectId)).map((c) => ({ recordId: c.record.recordId, name: customerName(c.record), kind: c.kind, allowed: c.allowed, reason: KIND_REASON[c.kind] }));
    return {
      target: { kind: t.releaseId ? 'release' : 'version', releaseId: t.releaseId, releaseNumber: t.release?.number ?? null, version: t.modelVersion, title: t.template.title },
      customers, languages: approvedLanguages(t.template).map(languageChoice), outputs: REVIEW_OUTPUTS.map((o) => ({ id: o, label: REVIEW_OUTPUT_LABEL[o] })),
      limits: REVIEW_LINK_LIMITS, active: links.activeCount(project.projectId),
    };
  });

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/review-links', async (req) => {
    const project = deps.projectOr404(req.params.projectId);
    const all = links.list(project.projectId).map((l) => linkInfo(req, l));
    return { links: all, active: all.filter((l) => l.status === 'active').length, limits: REVIEW_LINK_LIMITS };
  });

  app.post<{ Params: { projectId: string }; Body: Record<string, any> }>('/api/v1/projects/:projectId/review-links', async (req, reply) => {
    const project = deps.projectOr404(req.params.projectId);
    const b = req.body ?? {};
    const t = targetOf(project, b);
    const label = cleanLinkLabel(b.label) || (t.release ? `Review of release ${t.release.number}` : `Review of version ${t.modelVersion}`);
    if (label.length > REVIEW_LINK_LIMITS.labelMax) throw new ApiError(400, 'LABEL_TOO_LONG', `The label can be at most ${REVIEW_LINK_LIMITS.labelMax} characters.`);

    // Rule 2: 1 to 12 customers, built-in sample or generated customers only.
    const asked = Array.isArray(b.customers) ? [...new Set(b.customers.filter((x: unknown): x is string => typeof x === 'string'))] : [];
    if (asked.length < REVIEW_LINK_LIMITS.customersMin || asked.length > REVIEW_LINK_LIMITS.customersMax || asked.length !== (b.customers?.length ?? 0)) {
      throw new ApiError(400, 'INVALID_CUSTOMERS', `Choose ${REVIEW_LINK_LIMITS.customersMin} to ${REVIEW_LINK_LIMITS.customersMax} different customers.`);
    }
    const choices = new Map(customerChoices(store, project, deps.allRecords(project.projectId)).map((c) => [c.record.recordId, c]));
    for (const id of asked) {
      const c = choices.get(id);
      if (!c) throw new ApiError(400, 'UNKNOWN_CUSTOMER', `This document has no test customer ${id.slice(0, 80)}.`);
      if (!c.allowed) throw new ApiError(400, 'CUSTOMER_NOT_ALLOWED', `${id} cannot be put in a review link. ${KIND_REASON[c.kind]} Only built-in sample customers and generated customers can.`, { recordId: id, kind: c.kind });
    }

    // Rule 3: languages from the approved ones (default all); outputs (default all four).
    const approved = approvedLanguages(t.template);
    let languages = approved;
    if (b.languages !== undefined && b.languages !== null) {
      if (!Array.isArray(b.languages) || !b.languages.length || b.languages.some((l: unknown) => typeof l !== 'string' || !approved.includes(l))) throw new ApiError(400, 'INVALID_LANGUAGES', `Choose at least one of the approved languages: ${approved.join(', ')}.`);
      languages = approved.filter((l) => b.languages.includes(l));
    }
    const outputs = outputsOf(b.outputs);

    // Rule 5: every link expires, after 1 to 30 days (default 7). There is no "never".
    const days = b.expiresInDays === undefined || b.expiresInDays === null ? REVIEW_LINK_LIMITS.expiryDefaultDays : Number(b.expiresInDays);
    if (!Number.isInteger(days) || days < REVIEW_LINK_LIMITS.expiryMinDays || days > REVIEW_LINK_LIMITS.expiryMaxDays) throw new ApiError(400, 'INVALID_EXPIRY', `A review link expires after ${REVIEW_LINK_LIMITS.expiryMinDays} to ${REVIEW_LINK_LIMITS.expiryMaxDays} days. There is no “never”.`);

    // Rule 10: at most 20 active links per document.
    if (links.activeCount(project.projectId) >= REVIEW_LINK_LIMITS.activePerDocument) throw new ApiError(409, 'TOO_MANY_LINKS', `This document already has ${REVIEW_LINK_LIMITS.activePerDocument} active review links. Revoke one first.`);

    const now = new Date();
    const { token, hash } = newReviewToken();
    const link: StoredReviewLink = {
      id: `rl-${randomUUID().slice(0, 12)}`, projectId: project.projectId, label, releaseId: t.releaseId, modelVersion: t.modelVersion,
      // A document that takes its date from the run is shown as issued on the day the link was made, the same for every request.
      issueDate: t.template.documentDate?.source === 'run' ? now.toISOString().slice(0, 10) : null,
      customers: asked, languages, outputs, createdBy: by(req), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86400_000).toISOString(),
      revokedAt: null, revokedBy: null, opens: 0, firstOpenedAt: null, lastOpenedAt: null,
    };
    links.insert(link, hash);
    audit(store, req, 'review-link.create', { projectId: project.projectId, modelVersion: t.modelVersion, detail: { linkId: link.id, target: t.releaseId ? 'release' : 'version', releaseNumber: t.release?.number ?? null, version: t.modelVersion, customers: asked.length, languages: languages.length, outputs: outputs.length, expiresInDays: days, expiresAt: link.expiresAt } });
    reply.status(201);
    // The token is in this answer and nowhere else, ever.
    return { link: linkInfo(req, link), token, path: `/review/${token}` };
  });

  app.post<{ Params: { projectId: string; linkId: string } }>('/api/v1/projects/:projectId/review-links/:linkId/revoke', async (req) => {
    const project = deps.projectOr404(req.params.projectId);
    const l = links.get(req.params.linkId);
    if (!l || l.projectId !== project.projectId) throw new ApiError(404, 'NOT_FOUND', 'This document has no such review link.');
    if (!mayRevoke(req, l)) throw new ApiError(403, 'FORBIDDEN', 'Only the person who made this link, an approver or an admin can revoke it.', { role: req.user?.role ?? null });
    if (l.revokedAt) return { link: linkInfo(req, l), alreadyRevoked: true };
    const out = links.revoke(l.id, req.user?.name ?? null)!;
    audit(store, req, 'review-link.revoke', { projectId: project.projectId, modelVersion: l.modelVersion, detail: { linkId: l.id, target: l.releaseId ? 'release' : 'version', version: l.modelVersion } });
    return { link: linkInfo(req, out), alreadyRevoked: false };
  });

  /* ------------------------------------------------------------ the five public routes */

  /** The link behind a token, or the one dead-link answer (rule 7). */
  function live(token: unknown): { link: StoredReviewLink; template: Project; project: Project } {
    if (typeof token !== 'string' || !REVIEW_TOKEN_PATTERN.test(token)) throw dead();
    const link = links.byTokenHash(reviewTokenHash(token));
    if (!link || linkStatus(link) !== 'active') throw dead();
    const project = store.getProject(link.projectId);
    const template = project ? linkTemplate(store, link) : undefined;
    if (!project || !template) throw dead();
    return { link, template, project };
  }
  /** The link's customers that may still be shown, checked again now (rule 2): one that became supplied drops out. */
  function customersNow(link: StoredReviewLink, project: Project): SyntheticRecord[] {
    const choices = new Map(customerChoices(store, project, deps.allRecords(project.projectId)).map((c) => [c.record.recordId, c]));
    return link.customers.map((id) => choices.get(id)).filter((c): c is NonNullable<typeof c> => !!c && c.allowed).map((c) => c.record);
  }
  const customerOf = (link: StoredReviewLink, project: Project, id: unknown): SyntheticRecord => {
    const r = typeof id === 'string' ? customersNow(link, project).find((x) => x.recordId === id) : undefined;
    if (!r) throw new ApiError(404, 'CUSTOMER_NOT_AVAILABLE', 'This customer is not available through this link.');
    return r;
  };
  const outputOf = (link: StoredReviewLink, v: unknown): ReviewOutput => {
    if (typeof v !== 'string' || !link.outputs.includes(v as ReviewOutput)) throw new ApiError(400, 'OUTPUT_NOT_AVAILABLE', 'This output is not part of this link.');
    return v as ReviewOutput;
  };
  /** The language asked for, or the customer's own when the link has it, else the link's first. */
  const languageOf = (link: StoredReviewLink, template: Project, record: SyntheticRecord, v: unknown): string => {
    const allowed = link.languages.filter((l) => approvedLanguages(template).includes(l));
    if (v === undefined || v === null || v === '') return allowed.includes(record.customer?.locale) ? record.customer.locale : allowed[0];
    if (typeof v !== 'string' || !allowed.includes(v)) throw new ApiError(400, 'LANGUAGE_NOT_AVAILABLE', 'This language is not part of this link.');
    return v;
  };
  const inLanguage = (r: SyntheticRecord, locale: string): SyntheticRecord => ({ ...r, customer: { ...r.customer, locale } }) as SyntheticRecord;
  const throttle = (link: StoredReviewLink) => {
    if (!limiter.take(link.id)) throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Too many requests through this link. Wait a minute and try again.');
  };
  const stoppedBy = (res: { findings: Array<{ severity: string; code: string }> }) => [...new Set(res.findings.filter((f) => f.severity === 'blocking').map((f) => issueWords(f.code)))];
  /** Comments and audit entries from a link holder are never attributed to a studio user. */
  const linkAudit = (req: FastifyRequest, action: string, link: StoredReviewLink, detail: Record<string, unknown>) => {
    req.audited = true;
    store.audit({ user: null, userName: 'Review link', action, projectId: link.projectId, modelVersion: link.modelVersion, detail: { linkId: link.id, ...detail } });
  };

  // 1. The summary: which document and version, the choices, and whether a newer version exists (without showing it).
  app.get<{ Params: { token: string } }>('/api/v1/review/:token', async (req) => {
    const { link, template, project } = live(req.params.token);
    if (links.recordOpen(link.id)) linkAudit(req, 'review-link.open', link, {});
    const release = releaseOf(link);
    const newerExists = release ? store.releases(project.projectId).some((r) => r.number > release.number) : project.modelVersion > link.modelVersion;
    return {
      banner: REVIEW_BANNER, label: link.label,
      document: { title: template.title, kind: DOCUMENT_TYPE_LABEL[template.documentType] },
      version: { kind: release ? 'release' : 'version', releaseNumber: release?.number ?? null, version: link.modelVersion },
      newerExists, withdrawn: withdrawn(release), expiresAt: link.expiresAt,
      customers: customersNow(link, project).map((r) => ({ key: r.recordId, name: customerName(r), language: r.customer?.locale ?? null })),
      languages: link.languages.filter((l) => approvedLanguages(template).includes(l)).map(languageChoice),
      outputs: link.outputs.map((o) => ({ id: o, label: REVIEW_OUTPUT_LABEL[o] })),
      parts: commentParts(template).map(({ key, name }) => ({ key, name })),
      limits: { nameMax: REVIEW_LINK_LIMITS.nameMax, commentMax: REVIEW_LINK_LIMITS.commentMax },
    };
  });

  // 2. One output for one customer.
  app.get<{ Params: { token: string }; Querystring: { customer?: string; output?: string; language?: string } }>('/api/v1/review/:token/output', async (req) => {
    const { link, template, project } = live(req.params.token);
    const record = customerOf(link, project, req.query.customer);
    const output = outputOf(link, req.query.output);
    const language = languageOf(link, template, record, req.query.language);
    throttle(link);
    const produced = await produceOne(template, inLanguage(record, language), output === 'pdf' ? [] : [output], opts.composer, link.issueDate);
    const base = { customer: { key: record.recordId, name: customerName(record) }, output, language: languageChoice(produced.res.locale ?? language) };
    const stopped = stoppedBy(produced.res);
    if (stopped.length) return { ...base, stopped: { reasons: stopped } };
    if (output === 'html') return { ...base, html: produced.files.html };
    if (output === 'email') return { ...base, email: produced.files.email };
    if (output === 'sms') return { ...base, sms: { text: produced.files.sms } };
    return { ...base, pdf: { query: `customer=${encodeURIComponent(record.recordId)}&language=${encodeURIComponent(language)}` } };
  });

  // 3. The comments made through this link, with the studio's replies. Nothing else.
  app.get<{ Params: { token: string } }>('/api/v1/review/:token/comments', async (req) => {
    const { link, template, project } = live(req.params.token);
    const metas = new Map(links.commentMetas(link.id).map((m) => [m.commentId, m]));
    const all = store.listComments(project.projectId);
    const shown = new Map(customersNow(link, project).map((r) => [r.recordId, customerName(r)]));
    const parts = new Map(commentParts(template).map((p) => [p.nodeId, p.name]));
    const comments = all.filter((c) => metas.has(c.id)).map((c) => {
      const m = metas.get(c.id)!;
      return {
        id: c.id, author: c.authorName, body: c.body, createdAt: c.createdAt, resolved: !!c.resolvedAt,
        customer: { key: m.recordId, name: shown.get(m.recordId) ?? null }, output: { id: m.output, label: REVIEW_OUTPUT_LABEL[m.output] }, language: languageChoice(m.locale),
        part: c.nodeId ? parts.get(c.nodeId) ?? 'A part of the document' : null,
        replies: all.filter((r) => r.parentId === c.id).map((r) => ({ id: r.id, author: r.authorName, body: r.body, createdAt: r.createdAt, fromStudio: !metas.has(r.id) })),
      };
    });
    return { comments, limits: { nameMax: REVIEW_LINK_LIMITS.nameMax, commentMax: REVIEW_LINK_LIMITS.commentMax } };
  });

  // 4. Add a comment: stored as a review comment on this version, marked as coming from this link.
  app.post<{ Params: { token: string }; Body: Record<string, any> }>('/api/v1/review/:token/comments', async (req, reply) => {
    const { link, template, project } = live(req.params.token);
    const b = req.body ?? {};
    const name = cleanReviewerName(b.name);
    if (!name) throw new ApiError(400, 'NAME_REQUIRED', 'Type your name.');
    if (name.length > REVIEW_LINK_LIMITS.nameMax) throw new ApiError(400, 'NAME_TOO_LONG', `Your name can be at most ${REVIEW_LINK_LIMITS.nameMax} characters.`);
    const body = sanitizeCommentBody(b.body);
    if (!body) throw new ApiError(400, 'EMPTY_COMMENT', 'Write a comment first.');
    if (body.length > REVIEW_LINK_LIMITS.commentMax) throw new ApiError(400, 'COMMENT_TOO_LONG', `A comment can be at most ${REVIEW_LINK_LIMITS.commentMax.toLocaleString('en-US')} characters.`);
    const record = customerOf(link, project, b.customer);
    const output = outputOf(link, b.output);
    const locale = languageOf(link, template, record, b.language);
    let nodeId = '';
    if (b.part !== undefined && b.part !== null && b.part !== '') {
      const part = commentParts(template).find((p) => p.key === b.part);
      if (!part) throw new ApiError(400, 'UNKNOWN_PART', 'Choose a part from the list, or the whole document.');
      nodeId = part.nodeId;
    }
    // Rule 10: 200 in all and 30 an hour per link.
    if (links.commentCount(link.id) >= REVIEW_LINK_LIMITS.commentsTotal) throw new ApiError(429, 'COMMENT_LIMIT', `This link has reached its limit of ${REVIEW_LINK_LIMITS.commentsTotal} comments. Ask for a new link.`);
    if (links.commentCount(link.id, new Date(Date.now() - 3600_000).toISOString()) >= REVIEW_LINK_LIMITS.commentsPerHour) throw new ApiError(429, 'COMMENT_RATE', `At most ${REVIEW_LINK_LIMITS.commentsPerHour} comments an hour can be left through one link. Try again later.`);

    const comment = store.transaction(() => {
      const c = store.addComment({ id: `cmt-${randomUUID().slice(0, 12)}`, projectId: project.projectId, nodeId, parentId: null, body, author: `review-link:${link.id}`, authorName: `${name} (review link: ${link.label})`, modelVersion: link.modelVersion });
      links.addCommentMeta({ commentId: c.id, linkId: link.id, recordId: record.recordId, output, locale, createdAt: c.createdAt });
      return c;
    });
    // Ids and counts only: never the typed name or the text.
    linkAudit(req, 'review-link.comment', link, { commentId: comment.id, recordId: record.recordId, output, locale, nodeId: nodeId || null, nodeName: nodeId ? commentParts(template).find((p) => p.nodeId === nodeId)?.name ?? null : null, length: body.length });
    onReviewLinkComment(link, comment);
    // Tell the person who made the link (ids only; the commenter is outside the studio, so there is no actor).
    notify(store, { userId: link.createdBy?.id, kind: 'review_link.comment', projectId: link.projectId, data: { commentId: comment.id, linkId: link.id, ...(comment.nodeId ? { nodeId: comment.nodeId } : {}), modelVersion: link.modelVersion }, actor: null });
    reply.status(201);
    return { comment: { id: comment.id, author: comment.authorName, body: comment.body, createdAt: comment.createdAt, resolved: false, customer: { key: record.recordId, name: customerName(record) }, output: { id: output, label: REVIEW_OUTPUT_LABEL[output] }, language: languageChoice(locale), part: nodeId ? commentParts(template).find((p) => p.nodeId === nodeId)?.name ?? null : null, replies: [] } };
  });

  // 5. The PDF file of one customer.
  app.get<{ Params: { token: string }; Querystring: { customer?: string; language?: string } }>('/api/v1/review/:token/pdf', async (req, reply) => {
    const { link, template, project } = live(req.params.token);
    const record = customerOf(link, project, req.query.customer);
    outputOf(link, 'pdf');
    const language = languageOf(link, template, record, req.query.language);
    throttle(link);
    const produced = await produceOne(template, inLanguage(record, language), [], opts.composer, link.issueDate);
    const stopped = stoppedBy(produced.res);
    if (stopped.length) throw new ApiError(409, 'DOCUMENT_STOPPED', `This document is not produced for this customer: ${stopped.join('; ')}.`);
    const composed = await opts.composer.pdf(renderPagedDocument(produced.res, template, { profileId: 'paged-pdf', watermark: '' }));
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="review-${link.modelVersion}-${record.recordId.toLowerCase().replace(/[^a-z0-9-]/g, '')}.pdf"`);
    return reply.send(composed.pdf);
  });
}

/** For the studio's comment list: marks the comments that came through a review link (link label, customer, output, language). */
export function reviewLinkCommentInfo(deps: Pick<RouteDeps, 'store'>, projectId: string) {
  const metas = new ReviewLinkStore(deps.store).metasFor(projectId);
  return (commentId: string) => {
    const m = metas.get(commentId);
    return m ? { reviewLink: { linkId: m.linkId, label: m.label, status: m.linkStatus, recordId: m.recordId, output: m.output, outputLabel: REVIEW_OUTPUT_LABEL[m.output], locale: m.locale } } : {};
  };
}
