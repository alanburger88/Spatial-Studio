import type { FastifyInstance } from 'fastify';
import { ISSUER_NAME_MAX, ISSUER_NAME_MIN, TEMPLATE_TITLE_MAX, checkSetupSpec, type SetupSpec } from '@iss/model';
import { fileSamples, notBroughtAcross, sendOutline, setupSpecFromFile, type FileReading } from '@iss/scenarios';
import { providerConfig, providerStatus } from '../assistant';
import { externalAssist } from '../assistAi';
import { audit } from '../auth';
import { FileRefusal, IMPORT_FILE_LIMITS, readImportFile } from '../importFile';
import { REBUILD_NEEDS_KEY, draftSetupFromFile } from '../setupAi';
import type { RouteDeps } from './deps';

/**
 * "Rebuild from a file" (wave 3, section 1). Two routes; neither stores anything about the file.
 *
 *  - `POST /projects/rebuild/read` reads one to three files (PDF or .docx, sent as base64, without their names) and
 *    returns what was found: each sample's blocks, tables, pictures (position and size) and what was ignored, the likely
 *    personal details, and how the samples compare. The page computes "what would be sent" from this with the same pure
 *    function (`sendOutline`) the server uses.
 *  - `POST /projects/rebuild/propose` reads the files again and proposes a document setup: with AI only when the
 *    request says the person confirmed "This file contains no real customer data" AND carries the exact outline the
 *    person saw (the server builds it again and refuses when it differs); without AI from the studio's own reading.
 *    The answer is a checked `SetupSpec` plus the report of what is not brought across. The page then shows it through
 *    the ordinary setup review (`/projects/setup/draft` with `spec`), and the document is created by `/projects/setup`.
 *
 * Files live in memory for the length of the request only. The Activity entry records the kind of each file, its page
 * count, whether AI was used and whether placeholders were used: never a name or any content.
 */
/** Enough room for three files of 10 MB as base64 and the rest of the request. */
const BODY_LIMIT = Math.ceil(IMPORT_FILE_LIMITS.files * IMPORT_FILE_LIMITS.bytes * 1.37) + 512 * 1024;

export function registerImportFileRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, ApiError } = deps;
  const model = deps.assistModel ?? externalAssist;

  async function readAll(files: unknown): Promise<FileReading[]> {
    if (!Array.isArray(files) || !files.length) throw new ApiError(400, 'NO_FILE', 'Choose a PDF or Word (.docx) file to rebuild the document from.');
    if (files.length > IMPORT_FILE_LIMITS.files) throw new ApiError(400, 'TOO_MANY_FILES', `Choose at most ${IMPORT_FILE_LIMITS.files} samples of the same document.`);
    const out: FileReading[] = [];
    for (const [i, f] of files.entries()) {
      const which = files.length > 1 ? `Sample ${i + 1}: ` : '';
      const data = f && typeof f === 'object' && typeof (f as { data?: unknown }).data === 'string' ? (f as { data: string }).data : null;
      if (data === null) throw new ApiError(400, 'INVALID_FILE', `${which}send each file as { "data": "<base64>" }.`, { sample: i + 1 });
      if (data.length > Math.ceil((IMPORT_FILE_LIMITS.bytes * 4) / 3) + 8) throw new ApiError(413, 'FILE_TOO_LARGE', `${which}the file is larger than 10 MB. Use a smaller file, or fewer pages of it.`, { sample: i + 1 });
      const buf = Buffer.from(data, 'base64');
      try { out.push(await readImportFile(buf)); }
      catch (e) {
        if (e instanceof FileRefusal) throw new ApiError(e.status, e.code, `${which}${e.message}`, { sample: i + 1 });
        throw new ApiError(422, 'FILE_DAMAGED', `${which}the file could not be read.`, { sample: i + 1 });
      } finally { buf.fill(0); }
    }
    return out;
  }

  const textOf = (v: unknown, min: number, max: number, code: string, what: string): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (s.length < min || s.length > max) throw new ApiError(400, code, `${what} must be ${min}–${max} characters.`);
    return s;
  };

  app.post<{ Body: Record<string, unknown> }>('/api/v1/projects/rebuild/read', { bodyLimit: BODY_LIMIT }, async (req) => {
    const readings = await readAll(req.body?.files);
    const fs = fileSamples(readings);
    const status = providerStatus(providerConfig());
    return { samples: fs.samples, alignment: fs.alignment, ai: { live: status.mode === 'external', providerStatus: status.label } };
  });

  app.post<{ Body: Record<string, unknown> }>('/api/v1/projects/rebuild/propose', { bodyLimit: BODY_LIMIT }, async (req) => {
    const b = req.body ?? {};
    const useAi = b.useAi === true;
    // The consent is checked before anything else: without it no file is read again and no model is called.
    if (useAi && b.confirmNoCustomerData !== true) throw new ApiError(400, 'CONSENT_REQUIRED', 'Nothing was sent. To use the AI model, confirm that the file contains no real customer data, or continue without AI.');
    const title = textOf(b.title, 2, TEMPLATE_TITLE_MAX, 'INVALID_TITLE', 'The name of the document');
    const issuerName = textOf(b.issuerName, ISSUER_NAME_MIN, ISSUER_NAME_MAX, 'INVALID_ISSUER_NAME', 'The issuer name');
    const placeholders = b.placeholders !== false;
    const readings = await readAll(b.files);
    const fs = fileSamples(readings);
    const known = new Set(fs.samples.flatMap((s) => s.marks.map((m) => m.id)));
    const unmarked = Array.isArray(b.unmarked) ? b.unmarked.filter((x): x is string => typeof x === 'string' && known.has(x)) : [];

    let spec: SetupSpec;
    let notes: string[];
    let message: string;
    let source: 'ai' | 'builtin';
    const cfg = providerConfig();
    if (b.forceOffline === true) cfg.provider = 'offline';
    const status = providerStatus(cfg);
    if (useAi) {
      const outline = sendOutline(fs, { placeholders, unmarked });
      // What is sent is exactly what the person saw: the page sends back the outline it showed, and it must match.
      if (b.outline !== outline) throw new ApiError(409, 'OUTLINE_CHANGED', 'Nothing was sent: what would be sent is not what was shown. Look at “What will be sent” again and confirm.');
      if (status.mode !== 'external') return { mode: 'unavailable' as const, reason: 'no-key' as const, providerStatus: status.label, message: REBUILD_NEEDS_KEY, notes: [] };
      const draft = await draftSetupFromFile(cfg, model, { outline, title, issuerName, paper: readings[0].paper.size ?? undefined });
      if (draft.mode !== 'ai' || !draft.spec) return { mode: 'unavailable' as const, reason: 'failed' as const, providerStatus: draft.providerStatus, message: draft.message, notes: draft.notes };
      spec = draft.spec; notes = draft.notes; message = draft.message; source = 'ai';
    } else {
      const built = setupSpecFromFile(fs, { title, issuerName, unmarked });
      const checked = checkSetupSpec(built.spec);
      spec = checked.spec; notes = [...built.notes, ...checked.notes]; source = 'builtin';
      message = 'Proposed by the studio’s own reading of the file, without an AI model: its headings, text and tables, with the marked values as data fields and no rules. Change what is not right, then create the document.';
    }
    const report = notBroughtAcross(fs, { unmarked });
    audit(store, req, 'file.read', {
      detail: {
        files: readings.length, kinds: readings.map((r) => r.kind), pages: readings.map((r) => r.pages), ai: useAi, placeholders: useAi && placeholders,
        marks: known.size - unmarked.length, fields: spec.fields.length, sections: spec.sections.length,
      },
    });
    return { mode: 'proposal' as const, source, providerStatus: status.label, message, spec, notes: [...new Set(notes)], report };
  });
}
