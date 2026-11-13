import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseReleaseId } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { resolve } from '@iss/resolver';
import { audit } from '../auth';
import { checkDocumentPdf, proofLevelOf, type PdfAccessibilityResult } from '../pdfAccessibility';
import { veraPdfStatus } from '../verapdf';
import type { RouteDeps } from './deps';

/**
 * Accessible PDF (wave 2): whether veraPDF is installed, and the PDF accessibility record of a release.
 *
 * The record is made ON DEMAND, not when the release is created: composing and checking a PDF takes a second or more
 * (veraPDF far longer), and the release creation belongs to `releases.ts`. A record is added, never changed; the
 * release detail shows the latest. It names the level reached ("Checked by the studio" or "Validated by veraPDF") and
 * when, the studio's passed and failed counts, and veraPDF's verdict or "not run". No customer data is stored: the
 * customer the PDF was composed for is named by its id only.
 */

export interface ReleasePdfRecord {
  id: number;
  releaseId: string;
  at: string;
  by: string | null;
  recordId: string;
  level: 'studio' | 'verapdf';
  levelLabel: string;
  studio: { checker: string; pageCount: number; summary: PdfAccessibilityResult['studio']['summary']; checks: Array<{ id: string; label: string; status: string }>; findings: number };
  verapdf: { status: string; version?: string | null; compliant?: boolean; failedRules?: Array<{ id: string; description: string; count: number; knownLimit?: string }>; message?: string };
}

export function registerPdfAccessibilityRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError, composer } = deps;
  store.db.exec(`CREATE TABLE IF NOT EXISTS release_pdf_checks(id INTEGER PRIMARY KEY AUTOINCREMENT, release_id TEXT NOT NULL, release_created_at TEXT NOT NULL, record_id TEXT NOT NULL, at TEXT NOT NULL, by_name TEXT, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS release_pdf_checks_by_release ON release_pdf_checks(release_id, id);`);

  const releaseOr404 = (id: string) => {
    const r = parseReleaseId(id) ? store.release(id) : undefined;
    if (!r) throw new ApiError(404, 'NOT_FOUND', `Unknown release ${id}.`);
    return r;
  };
  /** The latest record of THIS release (a release reset and made again under the same id does not inherit records). */
  const latest = (releaseId: string, createdAt: string): ReleasePdfRecord | null => {
    const row = store.db.prepare('SELECT * FROM release_pdf_checks WHERE release_id=? AND release_created_at=? ORDER BY id DESC LIMIT 1').get(releaseId, createdAt) as { id: number; json: string } | undefined;
    return row ? { ...(JSON.parse(row.json) as Omit<ReleasePdfRecord, 'id'>), id: row.id } : null;
  };

  /** Whether veraPDF is installed on this machine, and its version. Never downloads or installs it. */
  app.get('/api/v1/pdf-accessibility/verapdf', async () => veraPdfStatus());

  app.get<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId/pdf-accessibility', async (req) => {
    const r = releaseOr404(req.params.releaseId);
    return { record: latest(r.id, r.createdAt), verapdf: await veraPdfStatus() };
  });

  /** Composes the release's frozen document for one built-in sample customer and records the level of proof reached. */
  app.post<{ Params: { releaseId: string } }>('/api/v1/releases/:releaseId/pdf-accessibility', async (req: FastifyRequest<{ Params: { releaseId: string } }>) => {
    const r = releaseOr404(req.params.releaseId);
    const project = store.releaseProject(r.id);
    if (!project) throw new ApiError(410, 'RELEASE_CONTENT_MISSING', 'The stored content of this release is missing.');
    // A built-in sample customer when the kind of document has them; otherwise the document's own first customer.
    const record = RECORDS.find((x) => x.documentType === project.documentType) ?? deps.allRecords(r.documentId).find((x) => x.documentType === project.documentType);
    if (!record) throw new ApiError(409, 'NO_CUSTOMER', 'This document has no customer to compose a PDF for.');
    const res = resolve({ project, record, profileId: 'paged-pdf' });
    const result = await checkDocumentPdf(composer, res, project, { verapdf: true });
    const lvl = proofLevelOf(result);
    const v = result.verapdf;
    const rec: Omit<ReleasePdfRecord, 'id'> = {
      releaseId: r.id, at: result.checkedAt, by: req.user?.name ?? null, recordId: record.recordId, level: lvl.level, levelLabel: lvl.label,
      studio: { checker: result.studio.checker, pageCount: result.studio.pageCount, summary: result.studio.summary, checks: result.studio.checks.map((c) => ({ id: c.id, label: c.label, status: c.status })), findings: result.studio.findings.length },
      verapdf: v.status === 'ran' ? { status: 'ran', version: v.version, compliant: v.compliant, failedRules: v.failedRules.map((x) => ({ id: x.id, description: x.description, count: x.count, ...(x.knownLimit ? { knownLimit: x.knownLimit } : {}) })) }
        : { status: v.status, message: v.message, ...('version' in v ? { version: v.version } : {}) },
    };
    const info = store.db.prepare('INSERT INTO release_pdf_checks(release_id, release_created_at, record_id, at, by_name, json) VALUES (?,?,?,?,?,?)').run(r.id, r.createdAt, record.recordId, rec.at, rec.by, JSON.stringify(rec));
    audit(store, req, 'release.pdf-accessibility', { projectId: r.documentId, detail: { releaseId: r.id, number: r.number, recordId: record.recordId, level: lvl.level, passed: rec.studio.summary.passed, failed: rec.studio.summary.failed, verapdf: v.status } });
    return { record: { ...rec, id: Number(info.lastInsertRowid) } };
  });
}
