import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  HANDOVER_KINDS, HANDOVER_LABEL, RELEASE_NOTE_MAX, RELEASE_STAGES, RELEASE_STAGE_LABEL, WORKFLOW_LABEL, cleanReleaseNote, isHandoverKind, isReleaseStage, parseReleaseId,
  projectContentDigest, promoteProblem, releaseCreationDecision, releaseRoleProblem, withdrawProblem,
  type Project, type ReleaseInfo, type ReleaseStage, type ReleaseStageStatus,
} from '@iss/model';
import { audit } from '../auth';
import type { StoredRelease } from '../db';
import { createRelease, liveReleases, promoteRelease, releaseInfo, withdrawRelease, type PackageBuildOutcome } from '../releases';
import { packageContentType, releaseTemplate } from '../releasePackage';
import type { RouteDeps } from './deps';

/**
 * Releases: the frozen, numbered copies of approved documents, their stages (Test, then Production), the handover
 * log and the release package. Request and response shapes are documented in docs/api/RELEASES.md.
 *
 * Reading is open to anyone signed in. Creating a release and adding to the handover log need an approver or admin;
 * moving a release to Production or withdrawing it needs an admin (see the route table in auth.ts).
 * Every state change writes an audit entry with names and numbers, never content.
 */
export function registerReleaseRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, projectOr404 } = deps;
  const packages = deps.releasePackages;
  const by = (req: FastifyRequest) => (req.user ? { id: req.user.id, name: req.user.name } : null);

  const info = (r: StoredRelease, counts = store.handoverCounts()): ReleaseInfo => releaseInfo(r, packages.status(r), counts.get(r.id));
  const releaseOr404 = (id: string): StoredRelease => {
    const r = parseReleaseId(id) ? store.release(id) : undefined;
    if (!r) throw new ApiError(404, 'NOT_FOUND', `Unknown release ${id}.`);
    return r;
  };
  const noteOf = (v: unknown, what: string): string | null => {
    const s = cleanReleaseNote(v);
    if (s.length > RELEASE_NOTE_MAX) throw new ApiError(400, 'NOTE_TOO_LONG', `${what} is limited to ${RELEASE_NOTE_MAX} characters.`);
    return s || null;
  };
  /** What an audit entry says about a release: names and numbers. */
  const named = (r: StoredRelease) => ({ releaseId: r.id, number: r.number, title: r.title });

  /* ------------------------------------------------------------ lists */

  /** Every release, newest first. `documentId` narrows to one document; `stage` to the releases that are current at that stage (`status` picks another standing, or `any`). */
  app.get<{ Querystring: { documentId?: string; stage?: string; status?: string } }>('/api/v1/releases', async (req) => {
    const { documentId, stage, status } = req.query;
    if (stage !== undefined && stage !== '' && !isReleaseStage(stage)) throw new ApiError(400, 'INVALID_STAGE', `stage must be one of ${RELEASE_STAGES.join(', ')}.`);
    const want = status || 'current';
    if (!['current', 'superseded', 'withdrawn', 'any'].includes(want)) throw new ApiError(400, 'INVALID_STATUS', 'status must be current, superseded, withdrawn or any.');
    if (status && !stage) throw new ApiError(400, 'STAGE_REQUIRED', 'status needs a stage: say which stage the release should be current, superseded or withdrawn at.');
    let rows = store.releases(documentId || undefined);
    if (stage) rows = rows.filter((r) => { const s = r.stages[stage as ReleaseStage]; return !!s && (want === 'any' || s.status === (want as ReleaseStageStatus)); });
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.number - a.number));
    const counts = store.handoverCounts();
    return { releases: rows.map((r) => info(r, counts)), total: rows.length, stages: RELEASE_STAGES.map((id) => ({ id, label: RELEASE_STAGE_LABEL[id] })) };
  });

  /** Whether a release can be created from the document's approved version right now, and why not. */
  const creatable = (project: Project | undefined, req: FastifyRequest): { allowed: boolean; reason: string | null } => {
    if (!project) return { allowed: false, reason: 'The document was deleted.' };
    const wf = store.getWorkflow(project.projectId);
    if (wf.state !== 'approved' && wf.state !== 'published') return { allowed: false, reason: `Only an approved document can be released. This one is ${WORKFLOW_LABEL[wf.state].toLowerCase()}.` };
    const decision = releaseCreationDecision(store.releases(project.projectId), wf.contentDigest ?? projectContentDigest(project));
    if (!decision.create) return { allowed: false, reason: `Release ${decision.number} already holds the approved version.` };
    const role = releaseRoleProblem(req.user?.role, 'create');
    return { allowed: !role, reason: role };
  };

  /** What is live: per document, the current Production release (or none) and the current Test release. */
  app.get<{ Querystring: { includeUnreleased?: string } }>('/api/v1/releases/live', async (req) => {
    const counts = store.handoverCounts();
    const byDocument = new Map<string, StoredRelease[]>();
    for (const r of store.releases()) byDocument.set(r.documentId, [...(byDocument.get(r.documentId) ?? []), r]);
    const projects = new Map(store.listProjects().map((p) => [p.projectId, p]));
    const ids = new Set(byDocument.keys());
    if (req.query.includeUnreleased === '1' || req.query.includeUnreleased === 'true') for (const id of projects.keys()) ids.add(id);
    const documents = [...ids].sort().map((documentId) => {
      const releases = byDocument.get(documentId) ?? [];
      const project = projects.get(documentId);
      const live = releases.length ? liveReleases(releases) : null;
      const wf = project ? store.getWorkflow(documentId) : null;
      return {
        documentId,
        /** The document's title now, or, when it was deleted, the title of its latest release. */
        title: project?.title ?? live?.latest.title ?? documentId,
        documentType: project?.documentType ?? live?.latest.documentType ?? null,
        documentRemoved: !project,
        workflow: wf ? { state: wf.state, label: WORKFLOW_LABEL[wf.state] } : null,
        production: live?.production ? info(live.production, counts) : null,
        test: live?.test ? info(live.test, counts) : null,
        latest: live ? info(live.latest, counts) : null,
        releases: releases.length,
        /** The document is approved but its approved version has no release yet (approved before releases existed, or its release was withdrawn). */
        approvedUnreleased: !!project && !!wf && (wf.state === 'approved' || wf.state === 'published') && releaseCreationDecision(releases, wf.contentDigest ?? '').create,
      };
    });
    return { documents, stages: RELEASE_STAGES.map((id) => ({ id, label: RELEASE_STAGE_LABEL[id] })) };
  });

  /** One document's releases, newest first. Works for a deleted document too, as long as it has releases. */
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/releases', async (req) => {
    const documentId = req.params.projectId;
    const project = store.getProject(documentId);
    const rows = store.releases(documentId);
    if (!project && !rows.length) throw new ApiError(404, 'NOT_FOUND', `Unknown project ${documentId}.`);
    const counts = store.handoverCounts();
    const live = rows.length ? liveReleases(rows) : null;
    return {
      documentId, documentExists: !!project, title: project?.title ?? live?.latest.title ?? documentId,
      releases: [...rows].reverse().map((r) => info(r, counts)),
      production: live?.production?.id ?? null, test: live?.test?.id ?? null,
      create: creatable(project, req),
    };
  });

  /* ------------------------------------------------------------ creating */

  /**
   * Create a release from the document's approved version (approvers and admins). For documents approved before
   * releases existed; approving a document creates its release by itself.
   */
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/releases', async (req, reply) => {
    const p = projectOr404(req.params.projectId);
    const wf = store.getWorkflow(p.projectId);
    if (wf.state !== 'approved' && wf.state !== 'published') throw new ApiError(409, 'NOT_APPROVED', `Only an approved document can be released. “${p.title}” is ${WORKFLOW_LABEL[wf.state].toLowerCase()}.`, { state: wf.state });
    // The approved version is the one the review recorded; saving a change afterwards would have sent the document back to draft.
    const version = wf.modelVersion ? store.getVersion(p.projectId, wf.modelVersion) : undefined;
    const approved = version && version.contentDigest === wf.contentDigest ? version.project : projectContentDigest(p) === wf.contentDigest ? p : null;
    if (!approved) throw new ApiError(409, 'APPROVED_VERSION_MISSING', 'The approved version is no longer in the version history. Approve the document again to release it.');
    const approval = store.workflowHistory(p.projectId).find((e) => e.action === 'approve');
    const approvedBy = approval?.user ? { id: approval.userId ?? 'unknown', name: approval.user } : null;
    const made = store.transaction(() => createRelease(store, approved, { approvedBy, approvedAt: approval?.at ?? wf.updatedAt ?? new Date().toISOString(), createdBy: by(req), origin: 'manual' }));
    if (!made.created) {
      req.audited = true;
      return { created: false, reason: 'unchanged', message: `Release ${made.release.number} already holds the approved version, so no new release was made.`, release: info(made.release) };
    }
    audit(store, req, 'release.create', { projectId: p.projectId, modelVersion: approved.modelVersion, detail: { ...named(made.release), stage: RELEASE_STAGE_LABEL.test, origin: 'manual', approvedBy: approvedBy?.name ?? null, supersededAtTest: made.supersededAtTest } });
    reply.status(201);
    return { created: true, reason: null, message: `Release ${made.release.number} was created at Test.`, release: info(made.release) };
  });

  /* ------------------------------------------------------------ one release */

  app.get<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId', async (req) => {
    const r = releaseOr404(req.params.releaseId);
    const project = store.getProject(r.documentId);
    const role = req.user?.role;
    const action = (a: 'promote' | 'withdraw', stage: ReleaseStage, label: string, problem: string | null) => {
      const reason = problem ?? releaseRoleProblem(role, a);
      return { action: a, stage, label, allowed: !reason, reason };
    };
    return {
      release: info(r),
      /** Stage history, oldest first. */
      history: store.releaseEvents(r.id),
      /** Handover log, oldest first. */
      handover: store.releaseHandover(r.id),
      actions: [
        action('promote', 'production', 'Move to Production', promoteProblem(r)),
        action('withdraw', 'test', 'Withdraw from Test', withdrawProblem(r, 'test')),
        action('withdraw', 'production', 'Withdraw from Production', withdrawProblem(r, 'production')),
        ...HANDOVER_KINDS.map((kind) => ({ action: 'handover' as const, kind, label: `Mark as ${HANDOVER_LABEL[kind].toLowerCase()}`, allowed: !releaseRoleProblem(role, 'handover'), reason: releaseRoleProblem(role, 'handover') })),
      ],
      document: { id: r.documentId, exists: !!project, title: project?.title ?? null, modelVersion: project?.modelVersion ?? null, workflowState: project ? store.getWorkflow(r.documentId).state : null },
    };
  });

  /** The frozen template of a release: the same content as `template.json` in its package (a studio project file). */
  app.get<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId/template', async (req, reply) => {
    const r = releaseOr404(req.params.releaseId);
    const frozen = store.releaseProject(r.id);
    if (!frozen) throw new ApiError(410, 'RELEASE_CONTENT_MISSING', 'The stored content of this release is missing.');
    reply.header('Content-Disposition', `attachment; filename="${r.id}-template.json"`);
    return releaseTemplate(frozen);
  });

  /* ------------------------------------------------------------ stages */

  /** Move a release to Production (admins). The earlier Production release of the same document becomes superseded. */
  app.post<{ Params: { releaseId: string }; Body: Record<string, any> }>('/api/v1/releases/:releaseId/promote', async (req) => {
    const r = releaseOr404(req.params.releaseId);
    const note = noteOf(req.body?.note, 'A note');
    const problem = promoteProblem(r);
    if (problem) throw new ApiError(409, 'INVALID_STAGE_MOVE', problem, { stages: r.stages });
    const done = store.transaction(() => promoteRelease(store, r, by(req), note));
    audit(store, req, 'release.promote', { projectId: r.documentId, modelVersion: r.modelVersion, detail: { ...named(r), stage: RELEASE_STAGE_LABEL.production, superseded: done.superseded.map((x) => x.number), withNote: !!note } });
    const counts = store.handoverCounts();
    return { release: info(done.release, counts), superseded: done.superseded.map((x) => info(x, counts)) };
  });

  /** Withdraw a release from a stage (admins). A reason is required. The release is kept and marked withdrawn. */
  app.post<{ Params: { releaseId: string }; Body: Record<string, any> }>('/api/v1/releases/:releaseId/withdraw', async (req) => {
    const r = releaseOr404(req.params.releaseId);
    const stage = req.body?.stage;
    if (!isReleaseStage(stage)) throw new ApiError(400, 'INVALID_STAGE', `stage must be one of ${RELEASE_STAGES.join(', ')}.`);
    const reason = noteOf(req.body?.reason, 'The reason');
    if (!reason) throw new ApiError(400, 'REASON_REQUIRED', `Say why release ${r.number} is being withdrawn from ${RELEASE_STAGE_LABEL[stage]}.`);
    const problem = withdrawProblem(r, stage);
    if (problem) throw new ApiError(409, 'INVALID_STAGE_MOVE', problem, { stages: r.stages });
    const out = store.transaction(() => withdrawRelease(store, r, stage, reason, by(req)));
    audit(store, req, 'release.withdraw', { projectId: r.documentId, modelVersion: r.modelVersion, detail: { ...named(r), stage: RELEASE_STAGE_LABEL[stage], withReason: true } });
    return { release: info(out) };
  });

  /** Add to the handover log: the receiving team marks a release as received or live (approvers and admins). */
  app.post<{ Params: { releaseId: string }; Body: Record<string, any> }>('/api/v1/releases/:releaseId/handover', async (req, reply) => {
    const r = releaseOr404(req.params.releaseId);
    const kind = req.body?.kind;
    if (!isHandoverKind(kind)) throw new ApiError(400, 'INVALID_KIND', `kind must be one of ${HANDOVER_KINDS.join(', ')}.`);
    const stage = req.body?.stage;
    if (stage !== undefined && stage !== null && stage !== '' && !isReleaseStage(stage)) throw new ApiError(400, 'INVALID_STAGE', `stage must be one of ${RELEASE_STAGES.join(', ')}, or left out.`);
    const note = noteOf(req.body?.note, 'A note');
    // What was handed over: the package as the studio held it at this moment (null when nobody had prepared it yet).
    const entry = store.addHandover(r.id, { kind, stage: isReleaseStage(stage) ? stage : null, note, packageSha256: packages.status(r).sha256, by: by(req) });
    audit(store, req, 'release.handover', { projectId: r.documentId, modelVersion: r.modelVersion, detail: { ...named(r), kind: HANDOVER_LABEL[kind], stage: isReleaseStage(stage) ? RELEASE_STAGE_LABEL[stage] : null, withNote: !!note } });
    reply.status(201);
    return { entry, handover: store.releaseHandover(r.id), release: info(r) };
  });

  /* ------------------------------------------------------------ the package */

  /** Starts a build (or, with `verify`, a check of the kept package) when one is needed, and records who asked and how it ended. */
  const prepare = (r: StoredRelease, req: FastifyRequest, verify: boolean) => {
    const p = packages.prepare(r, { verify });
    if (p.started) {
      const who = { user: req.user?.id ?? null, userName: req.user?.name ?? null };
      const checking = p.status.status === 'ready';
      audit(store, req, 'release.package', { projectId: r.documentId, modelVersion: r.modelVersion, detail: { ...named(r), event: checking ? 'check-started' : 'started' } });
      void p.done!.then((o: PackageBuildOutcome) => store.audit({
        ...who, action: 'release.package', projectId: r.documentId, modelVersion: r.modelVersion,
        detail: o.verified
          ? { ...named(r), event: 'checked', same: o.verified.same, sha256: o.verified.sha256, keptSha256: o.status.sha256, ...(o.verified.error ? { reason: o.verified.error } : {}) }
          : { ...named(r), event: o.status.status, ...(o.built ? { sha256: o.built.sha256, bytes: o.built.bytes, files: o.built.files } : {}), ...(o.status.error ? { reason: o.status.error } : {}) },
      }));
    } else req.audited = true;
    return p;
  };
  const sendZip = (r: StoredRelease, reply: FastifyReply) => {
    const zip = packages.zip(r)!;
    const st = packages.status(r);
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${st.fileName}"`).header('X-Sha256', st.sha256 ?? '').header('X-Content-Type-Options', 'nosniff');
    return reply.send(zip);
  };

  app.get<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId/package/status', async (req) => ({ package: packages.status(releaseOr404(req.params.releaseId)) }));

  /**
   * Prepare the package. Answers at once: 200 when it is ready (or failed), 202 while work is still going on.
   * `wait: true` holds the answer until the work ends. `verify: true` builds a ready package again and compares the
   * result with the kept one; the kept package is never replaced, and the outcome is reported as `package.verified`.
   */
  app.post<{ Params: { releaseId: string }; Body: Record<string, any> }>('/api/v1/releases/:releaseId/package', async (req, reply) => {
    const r = releaseOr404(req.params.releaseId);
    const p = prepare(r, req, req.body?.verify === true);
    if (p.done && req.body?.wait === true) await p.done;
    const status = packages.status(r);
    reply.status(status.status === 'building' || status.progress ? 202 : 200);
    return { package: status, started: p.started };
  });

  /**
   * Download the package. When it has not been built yet, the build starts and the answer is 202 with the status
   * (ask again, or send `?wait=1` to get the ZIP in one request). A failed build is not retried here: prepare it again.
   */
  app.get<{ Params: { releaseId: string }; Querystring: { wait?: string } }>('/api/v1/releases/:releaseId/package', async (req, reply) => {
    const r = releaseOr404(req.params.releaseId);
    let status = packages.status(r);
    if (status.status === 'ready') return sendZip(r, reply);
    if (status.status === 'failed') throw new ApiError(409, 'PACKAGE_FAILED', `Preparing the package failed: ${status.error ?? 'unknown reason'} Prepare it again.`, { package: status });
    const p = prepare(r, req, false);
    if (p.done && (req.query.wait === '1' || req.query.wait === 'true')) {
      await p.done;
      status = packages.status(r);
      if (status.status === 'ready') return sendZip(r, reply);
      throw new ApiError(409, 'PACKAGE_FAILED', `Preparing the package failed: ${status.error ?? 'unknown reason'} Prepare it again.`, { package: status });
    }
    reply.status(202).header('Retry-After', '2');
    return { package: packages.status(r), started: p.started };
  });

  const readyOr409 = (r: StoredRelease) => {
    const status = packages.status(r);
    if (status.status !== 'ready') throw new ApiError(409, 'PACKAGE_NOT_READY', status.status === 'building' ? 'The package is still being prepared.' : status.status === 'failed' ? 'Preparing the package failed. Prepare it again.' : 'The package has not been prepared yet.', { package: status });
    return status;
  };

  /** The files of a ready package, as its manifest lists them. */
  app.get<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId/package/files', async (req) => {
    const r = releaseOr404(req.params.releaseId);
    const status = readyOr409(r);
    return { package: status, files: (packages.files(r) ?? []).map((f) => ({ ...f, contentType: packageContentType(f.path) })) };
  });

  /** One file of a ready package, without downloading the ZIP (the manifest, the README, a reference output). */
  app.get<{ Params: { releaseId: string; '*': string }; Querystring: { download?: string } }>('/api/v1/releases/:releaseId/package/files/*', async (req, reply) => {
    const r = releaseOr404(req.params.releaseId);
    readyOr409(r);
    const filePath = req.params['*'];
    const data = packages.read(r, filePath);
    if (!data) throw new ApiError(404, 'NOT_FOUND', `The package of release ${r.number} has no file ${filePath}.`);
    const type = packageContentType(filePath);
    reply.header('Content-Type', type).header('X-Sha256', createHash('sha256').update(data).digest('hex')).header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${filePath.split('/').pop()}"`);
    // Pages and pictures from a package are shown in a sandbox: they can run their own scripts but cannot reach the studio.
    if (type.startsWith('text/html') || type === 'image/svg+xml') reply.header('Content-Security-Policy', 'sandbox allow-scripts');
    return reply.send(data);
  });

  /**
   * Test and demo reset: removes every release. Refused unless the server was started with RELEASES_RESET=allow,
   * because in normal use a release is never deleted.
   */
  app.post<{ Body: Record<string, any> }>('/api/v1/releases/reset', async (req) => {
    if (process.env.RELEASES_RESET !== 'allow') throw new ApiError(403, 'RESET_DISABLED', 'Releases are never deleted. (A test or demo server can allow this reset with RELEASES_RESET=allow.)');
    if (req.body?.confirm !== true) throw new ApiError(400, 'CONFIRM_REQUIRED', 'Send { "confirm": true } to remove every release.');
    await packages.idle();
    const removed = store.clearReleases();
    audit(store, req, 'release.reset', { detail: { removed } });
    return { removed };
  });

  app.addHook('onClose', async () => { await packages.idle(); });
}
