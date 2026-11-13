import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseReleaseId } from '@iss/model';
import { audit } from '../auth';
import type { StoredRelease } from '../db';
import type { PackageComposer } from '../releasePackage';
import { RuntimePackages, type RuntimeBuildOutcome } from '../runnablePackage';
import type { RouteDeps } from './deps';

/**
 * The runnable package of a release (phase 7): prepare, status, download. Modelled on the release package routes in
 * routes/releases.ts, with the same permissions: anyone signed in may read and download it, and anyone who may
 * download it may ask for it to be prepared (auth.ts). Every build is audited as `release.runtime`, with names,
 * numbers and fingerprints, never content. Shapes: docs/api/RELEASES.md.
 */
export function registerRuntimeRoutes(app: FastifyInstance, deps: RouteDeps, composer: PackageComposer): RuntimePackages {
  const { store, ApiError } = deps;
  const runtimes = new RuntimePackages(store, deps.releasePackages, composer);
  const releaseOr404 = (id: string): StoredRelease => {
    const r = parseReleaseId(id) ? store.release(id) : undefined;
    if (!r) throw new ApiError(404, 'NOT_FOUND', `Unknown release ${id}.`);
    return r;
  };
  const named = (r: StoredRelease) => ({ releaseId: r.id, number: r.number, title: r.title });

  const prepare = (r: StoredRelease, req: FastifyRequest, verify: boolean) => {
    const p = runtimes.prepare(r, { verify });
    if (p.started) {
      const who = { user: req.user?.id ?? null, userName: req.user?.name ?? null };
      audit(store, req, 'release.runtime', { projectId: r.documentId, modelVersion: r.modelVersion, detail: { ...named(r), event: p.status.status === 'ready' ? 'check-started' : 'started' } });
      void p.done!.then((o: RuntimeBuildOutcome) => store.audit({
        ...who, action: 'release.runtime', projectId: r.documentId, modelVersion: r.modelVersion,
        detail: o.verified
          ? { ...named(r), event: 'checked', same: o.verified.same, sha256: o.verified.sha256, keptSha256: o.status.sha256, ...(o.verified.error ? { reason: o.verified.error } : {}) }
          : { ...named(r), event: o.status.status, ...(o.built ? { sha256: o.built.sha256, bytes: o.built.bytes, files: o.built.files, engine: o.status.engine, releasePackageBuilt: o.built.releasePackageBuilt } : {}), ...(o.status.error ? { reason: o.status.error } : {}) },
      }));
    } else req.audited = true;
    return p;
  };
  const sendZip = (r: StoredRelease, reply: FastifyReply) => {
    const zip = runtimes.zip(r)!;
    const st = runtimes.status(r);
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${st.fileName}"`).header('X-Sha256', st.sha256 ?? '').header('X-Content-Type-Options', 'nosniff');
    return reply.send(zip);
  };
  const failed = (status: ReturnType<RuntimePackages['status']>) => new ApiError(409, 'RUNTIME_FAILED', `Preparing the runnable package failed: ${status.error ?? 'unknown reason'} Prepare it again.`, { runtime: status });

  app.get<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId/runtime/status', async (req) => ({ runtime: runtimes.status(releaseOr404(req.params.releaseId)) }));

  /** Prepare it: 200 when ready (or failed), 202 while work goes on. `wait: true` holds the answer until it ends; `verify: true` builds a ready one again and compares. */
  app.post<{ Params: { releaseId: string }; Body: Record<string, any> }>('/api/v1/releases/:releaseId/runtime', async (req, reply) => {
    const r = releaseOr404(req.params.releaseId);
    const p = prepare(r, req, req.body?.verify === true);
    if (p.done && req.body?.wait === true) await p.done;
    const status = runtimes.status(r);
    reply.status(status.status === 'building' || status.progress ? 202 : 200);
    return { runtime: status, started: p.started };
  });

  /** Download it. Not built yet: the build starts and the answer is 202 (or the ZIP, with `?wait=1`). A failed build is not retried here. */
  app.get<{ Params: { releaseId: string }; Querystring: { wait?: string } }>('/api/v1/releases/:releaseId/runtime', async (req, reply) => {
    const r = releaseOr404(req.params.releaseId);
    let status = runtimes.status(r);
    if (status.status === 'ready') return sendZip(r, reply);
    if (status.status === 'failed') throw failed(status);
    const p = prepare(r, req, false);
    if (p.done && (req.query.wait === '1' || req.query.wait === 'true')) {
      await p.done;
      status = runtimes.status(r);
      if (status.status === 'ready') return sendZip(r, reply);
      throw failed(status);
    }
    reply.status(202).header('Retry-After', '2');
    return { runtime: runtimes.status(r), started: p.started };
  });

  app.addHook('onClose', async () => { await runtimes.idle(); });
  return runtimes;
}
