import type { FastifyInstance } from 'fastify';
import { fromTranslationCsv, toTranslationCsv, usageEntryFromResolution, type Locale } from '@iss/model';
import { resolve } from '@iss/resolver';
import type { RouteDeps } from './deps';

const LOCALES: Locale[] = ['en-US', 'es-US'];

/** Translations routes (C1): CSV export for translators and CSV import that returns drafts (the client applies them as undoable commands). */
export function registerTranslationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ApiError, projectOr404, allRecords, checkDraftProject } = deps;
  const localeOf = (v: unknown): Locale => {
    const l = String(v ?? 'es-US') as Locale;
    if (!LOCALES.includes(l)) throw new ApiError(400, 'INVALID_LOCALE', `Unsupported locale ${l}.`);
    return l;
  };
  const usage = (project: ReturnType<typeof projectOr404>) =>
    allRecords().filter((r) => r.documentType === project.documentType).map((record) => usageEntryFromResolution(project, record as any, resolve({ project, record }) as any));

  app.get('/api/v1/projects/:projectId/translations.csv', async (req, reply) => {
    const project = projectOr404((req.params as any).projectId);
    const locale = localeOf((req.query as any)?.locale);
    const csv = toTranslationCsv(project, locale, usage(project));
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${project.projectId}-translations-${locale}.csv"`).header('X-Content-Type-Options', 'nosniff');
    return csv;
  });

  app.post('/api/v1/projects/:projectId/translations/import', async (req) => {
    const id = (req.params as any).projectId as string;
    const b = (req.body ?? {}) as { locale?: string; csv?: unknown; project?: unknown };
    if (typeof b.csv !== 'string' || !b.csv.trim()) throw new ApiError(400, 'EMPTY_CSV', 'Provide the CSV text in "csv".');
    if (b.csv.length > 2_000_000) throw new ApiError(413, 'TOO_LARGE', 'The CSV is larger than 2 MB.');
    const project = b.project ? checkDraftProject(b.project, id) : projectOr404(id);
    const locale = localeOf(b.locale);
    const r = fromTranslationCsv(project, b.csv, locale);
    return { locale, drafts: r.drafts, errors: r.errors, skipped: r.skipped, rows: r.rows };
  });
}
