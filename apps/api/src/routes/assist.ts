import type { FastifyInstance } from 'fastify';
import { isSupportedLanguage, projectLanguages } from '@iss/model';
import { providerConfig } from '../assistant';
import { describeImage, draftNewVersion, draftRule, externalAssist, meaningCheck, rewriteText, subjectLines, type RewriteKind, type RewriteStyle } from '../assistAi';
import type { RouteDeps } from './deps';

const STYLES: RewriteStyle[] = ['shorter', 'plainer', 'warmer', 'formal', 'one-sms'];
const KINDS: RewriteKind[] = ['message', 'label', 'email', 'sms'];

/**
 * Model-backed assistant routes. Each returns suggestions only (see assistAi.ts); none changes a project.
 * Without an AI key they answer 200 with `mode: "unavailable"` and an explanation, never an error.
 */
export function registerAssistRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ApiError, projectOr404, checkDraftProject } = deps;
  const model = deps.assistModel ?? externalAssist;
  const cfgOf = (b: { forceOffline?: unknown }) => { const cfg = providerConfig(); if (b.forceOffline === true) cfg.provider = 'offline'; return cfg; };
  const projectOf = (id: string, b: { project?: unknown }) => (b.project ? checkDraftProject(b.project, id) : projectOr404(id));
  const text = (v: unknown, name: string, max: number): string => {
    if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, 'INVALID', `${name} is required.`);
    if (v.length > max) throw new ApiError(400, 'TOO_LONG', `${name} is limited to ${max} characters.`);
    return v;
  };

  app.post('/api/v1/projects/:projectId/assist/rewrite', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const project = projectOf((req.params as any).projectId, b);
    const style = STYLES.includes(b.style as RewriteStyle) ? (b.style as RewriteStyle) : null;
    const kind = KINDS.includes(b.kind as RewriteKind) ? (b.kind as RewriteKind) : null;
    if (!style || !kind) throw new ApiError(400, 'INVALID', `"style" must be one of ${STYLES.join(', ')} and "kind" one of ${KINDS.join(', ')}.`);
    const locale = typeof b.locale === 'string' ? b.locale : 'en-US';
    if (!isSupportedLanguage(locale) || (locale !== 'en-US' && !projectLanguages(project).includes(locale))) throw new ApiError(400, 'INVALID_LOCALE', `Unsupported language ${locale}.`);
    return rewriteText(cfgOf(b), model, { text: text(b.text, 'The text', 4000), style, kind, locale });
  });

  app.post('/api/v1/projects/:projectId/assist/new-version', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const project = projectOf((req.params as any).projectId, b);
    return draftNewVersion(cfgOf(b), model, project, { nodeId: text(b.nodeId, 'The component', 64), brief: text(b.brief, 'The brief', 600) });
  });

  app.post('/api/v1/projects/:projectId/assist/subject-lines', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const project = projectOf((req.params as any).projectId, b);
    return subjectLines(cfgOf(b), model, project, { current: text(b.current, 'The current subject', 400), brief: typeof b.brief === 'string' ? b.brief : undefined });
  });

  app.post('/api/v1/projects/:projectId/assist/translation-meaning', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const project = projectOf((req.params as any).projectId, b);
    const locale = String(b.locale ?? '');
    if (locale === 'en-US' || !projectLanguages(project).includes(locale)) throw new ApiError(400, 'INVALID_LOCALE', 'Choose one of the project’s languages.');
    const ids = Array.isArray(b.ids) && b.ids.every((x) => typeof x === 'string') && b.ids.length <= 400 ? (b.ids as string[]) : undefined;
    return meaningCheck(cfgOf(b), model, project, { locale, ids });
  });

  app.post('/api/v1/projects/:projectId/assist/rule-draft', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const project = projectOf((req.params as any).projectId, b);
    return draftRule(cfgOf(b), model, project, text(b.sentence, 'The description', 600));
  });

  app.post('/api/v1/projects/:projectId/assist/image-description', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const project = projectOf((req.params as any).projectId, b);
    return describeImage(cfgOf(b), model, project, { nodeId: text(b.nodeId, 'The component', 64) });
  });
}
