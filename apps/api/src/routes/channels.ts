import type { FastifyInstance } from 'fastify';
import { renderEmail, renderSms, checkChannelParity, EMAIL_RENDERER_VERSION } from '@iss/renderers';
import type { RouteDeps } from './deps';

/** Channels routes: email and SMS renderings of the same resolved semantic tree. */
export function registerChannelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError } = deps;

  function run(body: unknown) {
    const r = deps.runFor(body);
    const blocking = r.res.findings.filter((f) => f.severity === 'blocking');
    if (blocking.length && !r.request.allowDraft) throw new ApiError(422, 'BLOCKING_DIAGNOSTICS', `Export blocked: ${blocking.length} blocking issue(s).`, { runId: r.res.runId, issues: blocking });
    return r;
  }

  app.post('/api/v1/compose/email', async (req) => {
    const { res, project } = run(req.body);
    const email = renderEmail(res, project);
    const sms = renderSms(res, project);
    const parity = checkChannelParity(res, email, sms);
    const filename = `${project.projectId}-${res.recordId}-${res.runId.slice(4, 12)}-email.html`.toLowerCase();
    // The db accepts any lowercase kind; the artifact route serves it by id (see report: it labels non-pdf/html kinds as JSON).
    const art = store.saveArtifact(res.runId, 'email' as any, filename, Buffer.from(email.html, 'utf8'), { contentDigest: res.contentDigest, subject: email.subject, renderer: EMAIL_RENDERER_VERSION, contentType: 'text/html; charset=utf-8', parityOk: parity.ok });
    return { runId: res.runId, recordId: res.recordId, contentDigest: res.contentDigest, locale: res.locale, subject: email.subject, preheader: email.preheader, html: email.html, text: email.text, warnings: email.warnings, parity, artifactId: art.artifactId, sha256: art.sha256, filename: art.filename };
  });

  app.post('/api/v1/compose/sms', async (req) => {
    const { res, project } = run(req.body);
    const email = renderEmail(res, project);
    const sms = renderSms(res, project);
    const parity = checkChannelParity(res, email, sms);
    return { runId: res.runId, recordId: res.recordId, contentDigest: res.contentDigest, locale: res.locale, text: sms.text, encoding: sms.encoding, length: sms.length, segments: sms.segments, perSegment: sms.perSegment, nonGsm: sms.nonGsm, warnings: sms.warnings, parity };
  });
}
