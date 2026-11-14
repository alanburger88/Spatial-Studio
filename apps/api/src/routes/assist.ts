import type { FastifyInstance } from 'fastify';
import { isSupportedLanguage, projectLanguages } from '@iss/model';
import { providerConfig } from '../assistant';
import { compliantRewrite, describeImage, draftNewVersion, draftRule, externalAssist, meaningCheck, readQuestionWithAi, rewriteText, subjectLines, type RewriteKind, type RewriteStyle } from '../assistAi';
import type { WordingTextScope } from '@iss/scenarios';
import type { RouteDeps } from './deps';

const STYLES: RewriteStyle[] = ['shorter', 'plainer', 'warmer', 'formal', 'one-sms'];
const KINDS: RewriteKind[] = ['message', 'label', 'email', 'sms'];
const SCOPES: WordingTextScope[] = ['messages', 'disclosures', 'labels', 'email', 'sms'];

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
    // "Suggest compliant wording" (wave 2): the rules in force are the constraints, and the answer is checked by the same checker.
    if (b.style === 'compliant') {
      const scope = SCOPES.includes(b.scope as WordingTextScope) ? (b.scope as WordingTextScope) : null;
      if (!scope) throw new ApiError(400, 'INVALID', `"scope" must be one of ${SCOPES.join(', ')}.`);
      const loc = typeof b.locale === 'string' ? b.locale : 'en-US';
      if (!isSupportedLanguage(loc) || (loc !== 'en-US' && !projectLanguages(project).includes(loc))) throw new ApiError(400, 'INVALID_LOCALE', `Unsupported language ${loc}.`);
      return compliantRewrite(cfgOf(b), model, project, { text: text(b.text, 'The text', 4000), scope, locale: loc, ...(b.tone === true ? { tone: true } : {}) });
    }
    const style = STYLES.includes(b.style as RewriteStyle) ? (b.style as RewriteStyle) : null;
    const kind = KINDS.includes(b.kind as RewriteKind) ? (b.kind as RewriteKind) : null;
    if (!style || !kind) throw new ApiError(400, 'INVALID', `"style" must be one of ${STYLES.join(', ')} and "kind" one of ${KINDS.join(', ')}.`);
    const locale = typeof b.locale === 'string' ? b.locale : 'en-US';
    if (!isSupportedLanguage(locale) || (locale !== 'en-US' && !projectLanguages(project).includes(locale))) throw new ApiError(400, 'INVALID_LOCALE', `Unsupported language ${locale}.`);
    return rewriteText(cfgOf(b), model, { text: text(b.text, 'The text', 4000), style, kind, locale, documentType: project.documentType });
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

  /* Ask about all customers (wave 4, item 7): a model reads a free sentence into the structured question. The studio
     answers it in the browser from every customer; this route never sees or returns a customer's data. The server's own
     customers of the document are used only to take their names out of the sentence before the model sees it. */
  app.post('/api/v1/projects/:projectId/assist/base-question', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const projectId = (req.params as any).projectId as string;
    const project = projectOf(projectId, b);
    const records = deps.allRecords(projectId).filter((r) => r.documentType === project.documentType);
    return readQuestionWithAi(cfgOf(b), model, project, { sentence: text(b.sentence, 'The question', 300), records });
  });
}
