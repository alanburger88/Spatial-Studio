import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, type Project, type SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import { renderPagedDocument, renderInteractiveHtml } from '@iss/renderers';
import type { Composer } from './composer';
import { zipFiles } from './zip';

/**
 * Batch production run: resolves and composes every selected record with the same engine as single exports,
 * then packages PDFs/HTML plus a manifest and a CSV run report into one ZIP. Records with blocking findings
 * are skipped (reported as "blocked") unless the caller asks for watermarked drafts.
 */

export type BatchOutput = 'pdf' | 'html';
export interface BatchItem {
  recordId: string; name: string; status: 'pending' | 'ok' | 'draft' | 'blocked' | 'failed';
  pages: number | null; pdfBytes: number | null; htmlBytes: number | null; ms: number | null;
  blocking: string[]; warnings: number; selectedVariants: Record<string, string | null>; error?: string; runId?: string;
}
export interface BatchJob {
  batchId: string; projectId: string; projectTitle: string; modelVersion: number; outputs: BatchOutput[]; includeBlocked: boolean;
  status: 'running' | 'done' | 'failed' | 'cancelled'; total: number; done: number; items: BatchItem[];
  startedAt: string; finishedAt: string | null; durationMs: number | null; zipBytes: number | null; zipSha256: string | null; error?: string;
}

export const BATCH_LIMIT = 500;

export class BatchRunner {
  private jobs = new Map<string, BatchJob>();
  private cancelled = new Set<string>();
  constructor(private composer: Composer, private dir: string) { mkdirSync(dir, { recursive: true }); }

  list(): BatchJob[] { return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20); }
  get(id: string) { return this.jobs.get(id); }
  zipPath(id: string) { const p = path.join(this.dir, `${id}.zip`); return existsSync(p) ? p : null; }
  readZip(id: string) { const p = this.zipPath(id); return p ? readFileSync(p) : null; }
  cancel(id: string) { const j = this.jobs.get(id); if (j && j.status === 'running') this.cancelled.add(id); return j; }

  start(project: Project, records: SyntheticRecord[], outputs: BatchOutput[], includeBlocked: boolean): BatchJob {
    const batchId = `batch-${randomUUID().slice(0, 8)}`;
    const job: BatchJob = {
      batchId, projectId: project.projectId, projectTitle: project.title, modelVersion: project.modelVersion, outputs, includeBlocked,
      status: 'running', total: records.length, done: 0, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, zipBytes: null, zipSha256: null,
      items: records.map((r) => ({ recordId: r.recordId, name: `${r.customer.givenName} ${r.customer.familyName}`, status: 'pending', pages: null, pdfBytes: null, htmlBytes: null, ms: null, blocking: [], warnings: 0, selectedVariants: {} })),
    };
    this.jobs.set(batchId, job);
    void this.run(job, project, records);
    return job;
  }

  private async run(job: BatchJob, project: Project, records: SyntheticRecord[]) {
    const t0 = Date.now();
    const files: Array<{ name: string; data: Buffer }> = [];
    const base = (r: SyntheticRecord) => `${project.projectId}-${r.recordId}`.toLowerCase();
    try {
      for (let i = 0; i < records.length; i++) {
        if (this.cancelled.has(job.batchId)) { job.status = 'cancelled'; break; }
        const r = records[i];
        const item = job.items[i];
        const s = Date.now();
        try {
          const res = resolve({ project, record: r, profileId: 'paged-pdf' });
          item.runId = res.runId;
          item.selectedVariants = res.result.selectedVariants;
          item.blocking = [...new Set(res.findings.filter((f) => f.severity === 'blocking').map((f) => f.code))];
          item.warnings = res.findings.filter((f) => f.severity === 'warning').length;
          const blocked = item.blocking.length > 0;
          if (blocked && !job.includeBlocked) { item.status = 'blocked'; }
          else {
            if (job.outputs.includes('pdf')) {
              const comp = await this.composer.composePaged(renderPagedDocument(res, project, { profileId: 'paged-pdf', watermark: blocked ? 'DRAFT — BLOCKING ISSUES' : '' }), { pdf: true });
              item.pages = comp.metrics.pageCount; item.pdfBytes = comp.pdf!.length;
              files.push({ name: `pdf/${base(r)}${blocked ? '-DRAFT' : ''}.pdf`, data: comp.pdf! });
            }
            if (job.outputs.includes('html')) {
              const html = Buffer.from(renderInteractiveHtml(res, project), 'utf8');
              item.htmlBytes = html.length;
              files.push({ name: `html/${base(r)}${blocked ? '-DRAFT' : ''}.html`, data: html });
            }
            item.status = blocked ? 'draft' : 'ok';
          }
        } catch (e: any) {
          item.status = 'failed'; item.error = String(e?.message ?? e).slice(0, 300);
        }
        item.ms = Date.now() - s;
        job.done = i + 1;
      }
      job.durationMs = Date.now() - t0;
      const manifest = { batchId: job.batchId, projectId: job.projectId, projectTitle: job.projectTitle, modelVersion: job.modelVersion, outputs: job.outputs, includeBlocked: job.includeBlocked, startedAt: job.startedAt, durationMs: job.durationMs, status: job.status === 'running' ? 'done' : job.status, items: job.items };
      const csvq = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const csv = ['recordId,name,status,pages,pdfBytes,htmlBytes,ms,blocking,warnings,runId,error', ...job.items.map((it) => [it.recordId, it.name, it.status, it.pages, it.pdfBytes, it.htmlBytes, it.ms, it.blocking.join(' '), it.warnings, it.runId, it.error].map(csvq).join(','))].join('\r\n') + '\r\n';
      files.push({ name: 'manifest.json', data: Buffer.from(canonicalJson(manifest) + '\n', 'utf8') }, { name: 'run-report.csv', data: Buffer.from(csv, 'utf8') });
      const zip = zipFiles(files);
      writeFileSync(path.join(this.dir, `${job.batchId}.zip`), zip);
      job.zipBytes = zip.length; job.zipSha256 = createHash('sha256').update(zip).digest('hex');
      if (job.status === 'running') job.status = 'done';
    } catch (e: any) {
      job.status = 'failed'; job.error = String(e?.message ?? e).slice(0, 300);
    } finally {
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - t0;
      this.cancelled.delete(job.batchId);
    }
  }
}
