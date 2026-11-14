import { createHash, randomBytes } from 'node:crypto';
import { SOURCE_LANGUAGE, languageName, projectLanguages, sanitizeCommentBody, translationStatus, type Project, type SyntheticRecord } from '@iss/model';
import { nodeWords } from '@iss/scenarios';
import type { Store } from './db';
import { releaseTemplate } from './releasePackage';
import { pinnedCustomerRefs } from './releases';

/**
 * Review links (wave 4, `docs/design/WAVE4_TEAMS.md` section 1; routes and shapes in `docs/api/REVIEW_LINKS.md`).
 *
 * A link points to ONE frozen version of ONE document (a release, or a saved version) for chosen synthetic customers.
 * Anyone holding it may look at the outputs and comment under a typed name. Nothing a link holder does changes the
 * document or its review state. This file holds the rules and the storage; `routes/reviewLinks.ts` holds the routes.
 *
 * What is stored: the SHA-256 of the token (never the token), the link's choices, who made it, open counts, and for
 * each comment the link, customer id, output and language. No IP address or browser detail is stored anywhere.
 */

export const REVIEW_LINK_LIMITS = {
  customersMin: 1,
  customersMax: 12,
  expiryDefaultDays: 7,
  expiryMinDays: 1,
  expiryMaxDays: 30,
  activePerDocument: 20,
  commentsPerHour: 30,
  commentsTotal: 200,
  outputsPerMinute: 120,
  nameMax: 80,
  commentMax: 2000,
  labelMax: 80,
} as const;

export const REVIEW_OUTPUTS = ['pdf', 'html', 'email', 'sms'] as const;
export type ReviewOutput = (typeof REVIEW_OUTPUTS)[number];
export const REVIEW_OUTPUT_LABEL: Record<ReviewOutput, string> = { pdf: 'PDF', html: 'Web page', email: 'Email', sms: 'Text message' };

/** The one answer for an unknown, expired or revoked token (rule 7): same status, same code, same words. */
export const DEAD_LINK = { status: 404, code: 'REVIEW_LINK_NOT_AVAILABLE', message: 'This review link is not available. Ask the person who sent it for a new one.' } as const;
/** The fixed banner of the review page (rule 13). */
export const REVIEW_BANNER = 'Review copy: synthetic data. Not for distribution.';

/** Customers whose origin lets them be shown through a link: the same rule a release package follows. */
const LINKABLE = new Set(['sample', 'generated']);

/* ------------------------------------------------------------------ the token (rule 4) */

/** 32 random bytes from the system's secure generator, URL-safe base64 (43 characters). */
export function newReviewToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: reviewTokenHash(token) };
}
export const reviewTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
/** Anything else is not a token: answered as a dead link without a database lookup. */
export const REVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/* ------------------------------------------------------------------ storage */

export interface StoredReviewLink {
  id: string; projectId: string; label: string;
  /** Set for a link to a release; null for a link to a saved version. */
  releaseId: string | null;
  modelVersion: number;
  /** The document's date given for each run, fixed when the link was made (documents that take their date from the run only). */
  issueDate: string | null;
  customers: string[]; languages: string[]; outputs: ReviewOutput[];
  createdBy: { id: string | null; name: string } | null; createdAt: string; expiresAt: string;
  revokedAt: string | null; revokedBy: string | null;
  opens: number; firstOpenedAt: string | null; lastOpenedAt: string | null;
}
export type ReviewLinkStatus = 'active' | 'expired' | 'revoked';
export const linkStatus = (l: Pick<StoredReviewLink, 'revokedAt' | 'expiresAt'>, now = new Date().toISOString()): ReviewLinkStatus => (l.revokedAt ? 'revoked' : l.expiresAt <= now ? 'expired' : 'active');

export interface ReviewCommentMeta { commentId: string; linkId: string; recordId: string; output: ReviewOutput; locale: string; createdAt: string }

/** The tables are created in `db.ts` ("review links" block); every read and write is here. */
export class ReviewLinkStore {
  constructor(private store: Store) {}
  private get db() { return this.store.db; }
  private map = (r: any): StoredReviewLink => ({
    id: r.link_id, projectId: r.project_id, label: r.label, releaseId: r.release_id ?? null, modelVersion: r.model_version, issueDate: r.issue_date ?? null,
    customers: JSON.parse(r.customers), languages: JSON.parse(r.languages), outputs: JSON.parse(r.outputs),
    createdBy: r.created_by_name ? { id: r.created_by_id ?? null, name: r.created_by_name } : null, createdAt: r.created_at, expiresAt: r.expires_at,
    revokedAt: r.revoked_at ?? null, revokedBy: r.revoked_by_name ?? null, opens: Number(r.opens ?? 0), firstOpenedAt: r.first_opened_at ?? null, lastOpenedAt: r.last_opened_at ?? null,
  });
  insert(l: StoredReviewLink, tokenHash: string) {
    this.db.prepare('INSERT INTO review_links(link_id,project_id,token_hash,label,release_id,model_version,issue_date,customers,languages,outputs,created_by_id,created_by_name,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(l.id, l.projectId, tokenHash, l.label, l.releaseId, l.modelVersion, l.issueDate, JSON.stringify(l.customers), JSON.stringify(l.languages), JSON.stringify(l.outputs), l.createdBy?.id ?? null, l.createdBy?.name ?? null, l.createdAt, l.expiresAt);
  }
  byTokenHash(hash: string): StoredReviewLink | undefined { const r = this.db.prepare('SELECT * FROM review_links WHERE token_hash=?').get(hash) as any; return r ? this.map(r) : undefined; }
  get(id: string): StoredReviewLink | undefined { const r = this.db.prepare('SELECT * FROM review_links WHERE link_id=?').get(id) as any; return r ? this.map(r) : undefined; }
  /** A document's links, newest first. */
  list(projectId: string): StoredReviewLink[] { return (this.db.prepare('SELECT * FROM review_links WHERE project_id=? ORDER BY created_at DESC, link_id').all(projectId) as any[]).map(this.map); }
  activeCount(projectId: string, now = new Date().toISOString()): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM review_links WHERE project_id=? AND revoked_at IS NULL AND expires_at>?').get(projectId, now) as any).n);
  }
  revoke(id: string, byName: string | null): StoredReviewLink | undefined {
    this.db.prepare('UPDATE review_links SET revoked_at=?, revoked_by_name=? WHERE link_id=? AND revoked_at IS NULL').run(new Date().toISOString(), byName, id);
    return this.get(id);
  }
  /** Counts an opening of the review page. True the first time. */
  recordOpen(id: string): boolean {
    const now = new Date().toISOString();
    const first = Number(this.db.prepare('UPDATE review_links SET first_opened_at=? WHERE link_id=? AND first_opened_at IS NULL').run(now, id).changes) > 0;
    this.db.prepare('UPDATE review_links SET opens=opens+1, last_opened_at=? WHERE link_id=?').run(now, id);
    return first;
  }
  addCommentMeta(m: ReviewCommentMeta) {
    this.db.prepare('INSERT INTO review_link_comments(comment_id,link_id,record_id,output,locale,created_at) VALUES (?,?,?,?,?,?)').run(m.commentId, m.linkId, m.recordId, m.output, m.locale, m.createdAt);
  }
  /** Comments made through one link (whose thread still exists), optionally only those made since a time. */
  commentCount(linkId: string, since?: string): number {
    const row = since
      ? this.db.prepare('SELECT COUNT(*) AS n FROM review_link_comments WHERE link_id=? AND created_at>=?').get(linkId, since)
      : this.db.prepare('SELECT COUNT(*) AS n FROM review_link_comments WHERE link_id=?').get(linkId);
    return Number((row as any).n);
  }
  commentMetas(linkId: string): ReviewCommentMeta[] {
    return (this.db.prepare('SELECT * FROM review_link_comments WHERE link_id=? ORDER BY created_at, comment_id').all(linkId) as any[]).map(this.mapMeta);
  }
  private mapMeta = (r: any): ReviewCommentMeta => ({ commentId: r.comment_id, linkId: r.link_id, recordId: r.record_id, output: r.output, locale: r.locale, createdAt: r.created_at });
  /** For the studio's comment list: which of these comments came through a link, and which. */
  metasFor(projectId: string): Map<string, ReviewCommentMeta & { label: string; linkStatus: ReviewLinkStatus }> {
    const rows = this.db.prepare('SELECT m.*, l.label, l.revoked_at, l.expires_at FROM review_link_comments m JOIN review_links l ON l.link_id=m.link_id WHERE l.project_id=?').all(projectId) as any[];
    return new Map(rows.map((r) => [r.comment_id, { ...this.mapMeta(r), label: r.label, linkStatus: linkStatus({ revokedAt: r.revoked_at, expiresAt: r.expires_at }) }]));
  }
}

/**
 * Integration point for notifications (built separately): called once a comment received through a link has been
 * stored. It does nothing yet. It is given ids and the stored comment only; the typed name is in `comment.authorName`.
 */
export function onReviewLinkComment(_link: StoredReviewLink, _comment: { id: string; projectId: string; nodeId: string; modelVersion: number; authorName: string }): void {
  /* intentionally empty: the notifications work connects here */
}

/**
 * Comments that came through links a person made and that still wait for an answer: not resolved, and nobody in the
 * studio has replied. For "My work". Ids and the link's label only; the typed name and the text are not returned.
 */
export function unansweredLinkComments(store: Store, userId: string): Array<{ projectId: string; commentId: string; nodeId: string; linkId: string; label: string; createdAt: string }> {
  const rows = store.db.prepare(
    `SELECT c.id AS comment_id, c.project_id, c.node_id, c.created_at, l.link_id, l.label
       FROM review_link_comments m
       JOIN review_links l ON l.link_id = m.link_id
       JOIN comments c ON c.id = m.comment_id
      WHERE l.created_by_id = ? AND c.resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.id NOT IN (SELECT comment_id FROM review_link_comments))
      ORDER BY c.created_at DESC, c.id`).all(userId) as any[];
  return rows.map((r) => ({ projectId: r.project_id, commentId: r.comment_id, nodeId: r.node_id, linkId: r.link_id, label: r.label, createdAt: r.created_at }));
}

/* ------------------------------------------------------------------ the frozen target (rule 1) */

/** The project the link shows, exactly as frozen, with every unapproved draft removed (rule 3). Undefined when it is gone. */
export function linkTemplate(store: Store, l: Pick<StoredReviewLink, 'projectId' | 'releaseId' | 'modelVersion'>): Project | undefined {
  const frozen = l.releaseId ? store.releaseProject(l.releaseId) : store.getVersion(l.projectId, l.modelVersion)?.project;
  return frozen ? releaseTemplate(frozen) : undefined;
}

/* ------------------------------------------------------------------ customers (rule 2) */

export interface CustomerChoice { record: SyntheticRecord; kind: 'sample' | 'generated' | 'imported' | 'supplied' | 'missing'; allowed: boolean }

/**
 * Every test customer of the document, each with where it came from, decided exactly as a release package decides it
 * (`pinnedCustomerRefs`): only built-in sample customers and generated customers may be shown through a link.
 */
export function customerChoices(store: Store, project: Project, records: SyntheticRecord[]): CustomerChoice[] {
  const candidates = records.filter((r) => r.documentType === project.documentType && (!r.projectId || r.projectId === project.projectId));
  const asTests = { ...project, testCases: candidates.map((r) => ({ id: r.recordId, recordId: r.recordId })) } as unknown as Project;
  const kinds = new Map(pinnedCustomerRefs(store, asTests).map((p) => [p.recordId, p.kind]));
  return candidates.map((record) => { const kind = kinds.get(record.recordId) ?? 'missing'; return { record, kind, allowed: LINKABLE.has(kind) }; });
}

export const customerName = (r: SyntheticRecord): string => `${r.customer?.givenName ?? ''} ${r.customer?.familyName ?? ''}`.trim() || 'Unnamed customer';

export const KIND_REASON: Record<CustomerChoice['kind'], string | null> = {
  sample: null,
  generated: null,
  imported: 'Imported customers can never be shown through a review link.',
  supplied: 'Customers whose data was supplied or edited by a person can never be shown through a review link.',
  missing: 'This customer cannot be shown through a review link.',
};

/* ------------------------------------------------------------------ languages (rule 3) */

/** English plus every language of the frozen document with at least one approved translation. Drafts never count. */
export function approvedLanguages(template: Project): string[] {
  const others = projectLanguages(template).filter((l) => translationStatus(template, l).rows.some((r) => r.status.status === 'approved'));
  return [SOURCE_LANGUAGE, ...others];
}
export const languageChoice = (code: string) => ({ code, name: languageName(code) });

/* ------------------------------------------------------------------ parts a comment may be about (rule 9) */

/**
 * The named parts a reviewer may comment on: the document's top-level parts (and their children when the top level
 * is only a page or two). Each gets a short opaque key so the page shows no component ids.
 */
export function commentParts(template: Project): Array<{ key: string; nodeId: string; name: string }> {
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const top = (byId.get(template.rootNodeId)?.children ?? []).map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => !!n && !n.decorative);
  const list = top.length >= 3 ? top : top.flatMap((n) => [n, ...(n.children ?? []).map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c && !c.decorative)]);
  return list.slice(0, 60).map((n, i) => ({ key: `p${i + 1}`, nodeId: n.id, name: nodeWords(template, n.id) }));
}

/* ------------------------------------------------------------------ text from a link holder */

/** A typed name: plain text on one line, cleaned like a comment. Empty when nothing usable is left. */
export function cleanReviewerName(v: unknown): string {
  return sanitizeCommentBody(v).replace(/\s+/g, ' ').trim();
}
/** A link's label, typed by its creator. */
export function cleanLinkLabel(v: unknown): string {
  return sanitizeCommentBody(v).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ output request limits (rule 10) */

/** Requests for outputs per link per minute, counted in memory only (no address or browser detail). */
export class OutputLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMinute: number = REVIEW_LINK_LIMITS.outputsPerMinute) {}
  /** True when this request is within the limit (and counts it). */
  take(linkId: string, now = Date.now()): boolean {
    const recent = (this.hits.get(linkId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.perMinute) { this.hits.set(linkId, recent); return false; }
    recent.push(now);
    this.hits.set(linkId, recent);
    return true;
  }
}
