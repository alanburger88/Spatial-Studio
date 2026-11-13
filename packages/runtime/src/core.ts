import { createHash } from 'node:crypto';
import type { Project, SyntheticRecord } from '@iss/model';
import { ENGINE_VERSION, buildProofRecord, resolve, type ProofOutput, type ProofRecord, type Resolution } from '@iss/resolver';
import { EMAIL_RENDERER_VERSION, HTML_RENDERER_VERSION, PAGED_RENDERER_VERSION, SMS_RENDERER_VERSION, renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms } from '@iss/renderers';

/**
 * The engine of a runnable package: one customer in, the documents out, exactly as the studio makes them.
 * The same functions the studio calls (`resolve`, `renderInteractiveHtml`, `renderEmail`, `renderSms`,
 * `renderPagedDocument`), with the same arguments, on the frozen release. No clock, no network: the caller supplies
 * the time for the proof record, and composes the PDF (it needs a browser).
 */

export const RUNTIME_FORMAT = 'iss-runnable-package';
/** Raised when a reader of the previous version could misread the package. */
export const RUNTIME_FORMAT_VERSION = 1;
/** The profile every document is resolved with: the studio's default, which its exports and the release package use too. */
export const RUNTIME_PROFILE = 'paged-pdf' as const;

export type Channel = 'pdf' | 'html' | 'email' | 'sms';
export const CHANNELS: readonly Channel[] = ['pdf', 'html', 'email', 'sms'];
export const isChannel = (s: string): s is Channel => (CHANNELS as readonly string[]).includes(s);

export const ENGINE_VERSIONS = { engine: ENGINE_VERSION, pagedRenderer: PAGED_RENDERER_VERSION, htmlRenderer: HTML_RENDERER_VERSION, emailRenderer: EMAIL_RENDERER_VERSION, smsRenderer: SMS_RENDERER_VERSION } as const;

export interface RuntimeRelease { id: string; documentId: string; number: number; title: string; contentDigest: string }
export interface LoadedRelease { release: RuntimeRelease; project: Project }

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** What one customer gets, before any PDF is composed. Files are the exact bytes a document is written as. */
export interface Rendered {
  res: Resolution;
  blockedBy: string[];
  produced: boolean;
  /** Present when produced, for the channels asked for. */
  files: {
    html?: Buffer;
    emailHtml?: Buffer;
    emailText?: Buffer;
    sms?: Buffer;
    /** What the browser composes into the PDF. Its SHA-256 is the PDF's content fingerprint. */
    pagedHtml?: string;
  };
  email?: { subject: string; preheader: string };
  smsInfo?: { encoding: string; characters: number; segments: number };
}

/** Blocking issue codes of a resolution, sorted and without repeats (the same list a proof record keeps). */
export const blockingCodes = (res: Resolution): string[] => [...new Set(res.findings.filter((f) => f.severity === 'blocking').map((f) => f.code))].sort();

/**
 * Never sets `includeDrafts`: a runnable package produces approved wording only. `issueDate` is the document's date given
 * for the run (`--issue-date` or a customer's own `issueDate`); a document that does not use dates ignores it.
 */
export function resolveCustomer(project: Project, record: SyntheticRecord, issueDate?: string | null): Resolution {
  return resolve({ project, record, profileId: RUNTIME_PROFILE, ...(issueDate ? { issueDate } : {}) });
}

/** Whether the template uses the document's date (only then is a given date part of the run). */
export const usesDocumentDate = (project: Project): boolean => !!project.documentDate;

export function render(loaded: LoadedRelease, record: SyntheticRecord, channels: ReadonlySet<Channel>, issueDate?: string | null): Rendered {
  const { project } = loaded;
  const res = resolveCustomer(project, record, issueDate);
  const blockedBy = blockingCodes(res);
  const out: Rendered = { res, blockedBy, produced: blockedBy.length === 0, files: {} };
  if (!out.produced) return out;
  if (channels.has('html')) out.files.html = Buffer.from(renderInteractiveHtml(res, project), 'utf8');
  if (channels.has('email')) {
    const e = renderEmail(res, project);
    out.files.emailHtml = Buffer.from(e.html, 'utf8');
    out.files.emailText = Buffer.from(e.text, 'utf8');
    out.email = { subject: e.subject, preheader: e.preheader };
  }
  if (channels.has('sms')) {
    const s = renderSms(res, project);
    out.files.sms = Buffer.from(s.text, 'utf8');
    out.smsInfo = { encoding: s.encoding, characters: s.length, segments: s.segments };
  }
  if (channels.has('pdf')) out.files.pagedHtml = renderPagedDocument(res, project, { profileId: RUNTIME_PROFILE, watermark: '' });
  return out;
}

/**
 * The fingerprints a proof record keeps (see `ProofOutput` in packages/resolver/src/proof.ts):
 * HTML, email and SMS by the SHA-256 of their exact file (email: `email.html`, which the text version is made from too);
 * the PDF by the SHA-256 of the page source it was composed from, with its page count.
 */
export function outputFingerprints(r: Rendered, pdfPages: number | null): ProofOutput[] {
  const out: ProofOutput[] = [];
  if (!r.produced) return out;
  if (r.files.pagedHtml !== undefined && pdfPages !== null) out.push({ channel: 'pdf', kind: 'content', sha256: sha256(r.files.pagedHtml), pages: pdfPages });
  if (r.files.html) out.push({ channel: 'html', kind: 'bytes', sha256: sha256(r.files.html), size: r.files.html.length });
  if (r.files.emailHtml) out.push({ channel: 'email', kind: 'bytes', sha256: sha256(r.files.emailHtml), size: r.files.emailHtml.length });
  if (r.files.sms) out.push({ channel: 'sms', kind: 'bytes', sha256: sha256(r.files.sms), size: r.files.sms.length });
  return out;
}

export function proofOf(loaded: LoadedRelease, r: Rendered, record: SyntheticRecord, customerRef: string, producedAt: string, outputs: ProofOutput[]): ProofRecord {
  const { release } = loaded;
  return buildProofRecord({ release: { id: release.id, documentId: release.documentId, number: release.number, contentDigest: release.contentDigest }, resolution: r.res, record, producer: 'runtime', producedAt, customerRef, outputs });
}

/** Problems that make a template unfit to run: anything that could put unapproved wording in a document. */
export function draftProblems(project: Project): string[] {
  const p: string[] = [];
  if (project.contentParts.some((c) => c.draftLocales && Object.keys(c.draftLocales).length)) p.push('The template carries draft wording for a message or notice.');
  if (Object.values(project.strings ?? {}).some((s) => s.draft && Object.keys(s.draft).length)) p.push('The template carries draft translations of labels or channel texts.');
  if ((project as unknown as Record<string, unknown>).translationOrigins) p.push('The template carries a record of translation drafts.');
  return p;
}
