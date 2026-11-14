import { createHash } from 'node:crypto';
import { projectContentDigest, type Project, type SyntheticRecord } from '@iss/model';
import { blockerKindOfId, blockerIdOf, blockerTitleOf, customerBlockers, wordingFindings, type BlockerKind } from '@iss/scenarios';
import { bindingAnalysis, staticRuleAnalysis } from '@iss/validation';
import type { Store } from './db';
import { approvalDays } from './issueDate';
import { notify } from './notifications';

/**
 * Blockers phase 4: a root cause's owner, status and notes (docs/design/BLOCKERS.md decision 6; routes in
 * docs/api/BLOCKER_WORK.md). Keyed by document and the cause's stable id (`blockerIdOf`), so they survive saves.
 *
 * Statuses: a person sets only "open" and "being-fixed". "Fixed" is set here alone, when the SAVED document no longer
 * has the cause for any customer; "Known data problem" comes from phase 2 (every customer it stops is set aside). A fixed
 * cause stays listed until the document's next approval, then drops off with its notes.
 *
 * Where "fixed" is decided: on the server, against the saved document and every customer the studio holds, on every
 * day approval checks (the same ground approval stands on). It is checked after every successful change to a document
 * (a hook in `routes/work.ts`) and again whenever the work is read, so it does not depend on anyone having the Blockers
 * screen open, and the owner is told once. Causes only the full check can see (page layout, PDF/web differences, PDF
 * accessibility) are judged by the full check: the studio reports what a full check of the saved version found.
 */

export type WorkStatus = 'open' | 'being-fixed';
export const SETTABLE_STATUSES: readonly WorkStatus[] = ['open', 'being-fixed'];
export const NOTE_MAX = 1000;

export interface Person { id: string; name: string }
export interface WorkNote { id: string; blockerId: string; body: string; author: Person | null; at: string }
export interface BlockerWorkRow {
  projectId: string; blockerId: string; kind: BlockerKind; title: string;
  /** `fast`: judged against the saved document by the server; `full-check`: judged by a full check of the saved version. */
  speed: 'fast' | 'full-check';
  owner: Person | null; status: WorkStatus; statusBy: Person | null; statusAt: string | null;
  fixedAt: string | null; fixedInVersion: number | null; customerCount: number | null;
  createdAt: string; updatedAt: string;
}

export function ensureWorkTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS blocker_work(project_id TEXT NOT NULL, blocker_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, speed TEXT NOT NULL, owner_id TEXT, owner_name TEXT, status TEXT NOT NULL, status_by_id TEXT, status_by_name TEXT, status_at TEXT, fixed_at TEXT, fixed_version INTEGER, customer_count INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id, blocker_id));
    CREATE INDEX IF NOT EXISTS blocker_work_by_owner ON blocker_work(owner_id);
    CREATE TABLE IF NOT EXISTS blocker_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, blocker_id TEXT NOT NULL, body TEXT NOT NULL, author_id TEXT, author_name TEXT, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS blocker_notes_by_cause ON blocker_notes(project_id, blocker_id, id);
  `);
}

const person = (id: unknown, name: unknown): Person | null => (typeof name === 'string' && name ? { id: typeof id === 'string' ? id : '', name } : null);
const mapRow = (r: any): BlockerWorkRow => ({
  projectId: r.project_id, blockerId: r.blocker_id, kind: r.kind, title: r.title, speed: r.speed,
  owner: person(r.owner_id, r.owner_name), status: r.status, statusBy: person(r.status_by_id, r.status_by_name), statusAt: r.status_at ?? null,
  fixedAt: r.fixed_at ?? null, fixedInVersion: r.fixed_version ?? null, customerCount: r.customer_count ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});
const mapNote = (r: any): WorkNote => ({ id: String(r.id), blockerId: r.blocker_id, body: r.body, author: person(r.author_id, r.author_name), at: r.at });

export function workRows(store: Store, projectId: string): BlockerWorkRow[] {
  ensureWorkTables(store);
  return (store.db.prepare('SELECT * FROM blocker_work WHERE project_id=? ORDER BY created_at, blocker_id').all(projectId) as any[]).map(mapRow);
}
export function workRow(store: Store, projectId: string, blockerId: string): BlockerWorkRow | undefined {
  ensureWorkTables(store);
  const r = store.db.prepare('SELECT * FROM blocker_work WHERE project_id=? AND blocker_id=?').get(projectId, blockerId);
  return r ? mapRow(r) : undefined;
}
export function workNotes(store: Store, projectId: string, blockerId?: string): WorkNote[] {
  ensureWorkTables(store);
  const rows = blockerId ? store.db.prepare('SELECT * FROM blocker_notes WHERE project_id=? AND blocker_id=? ORDER BY id').all(projectId, blockerId) : store.db.prepare('SELECT * FROM blocker_notes WHERE project_id=? ORDER BY id').all(projectId);
  return (rows as any[]).map(mapNote);
}
/** Projects in which this person owns a cause. */
export function projectsOwnedBy(store: Store, userId: string): string[] {
  ensureWorkTables(store);
  return (store.db.prepare('SELECT DISTINCT project_id FROM blocker_work WHERE owner_id=?').all(userId) as any[]).map((r) => r.project_id as string);
}

/** Creates the row for a cause the first time someone works on it. */
export function ensureRow(store: Store, projectId: string, cause: { blockerId: string; kind: BlockerKind; title: string; speed: 'fast' | 'full-check'; customerCount: number | null }): BlockerWorkRow {
  ensureWorkTables(store);
  const now = new Date().toISOString();
  store.db.prepare('INSERT OR IGNORE INTO blocker_work(project_id,blocker_id,kind,title,speed,status,customer_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(projectId, cause.blockerId, cause.kind, cause.title, cause.speed, 'open', cause.customerCount, now, now);
  return workRow(store, projectId, cause.blockerId)!;
}
export function setOwner(store: Store, projectId: string, blockerId: string, owner: Person | null): void {
  store.db.prepare('UPDATE blocker_work SET owner_id=?, owner_name=?, updated_at=? WHERE project_id=? AND blocker_id=?').run(owner?.id ?? null, owner?.name ?? null, new Date().toISOString(), projectId, blockerId);
}
export function setStatus(store: Store, projectId: string, blockerId: string, status: WorkStatus, by: Person | null): void {
  const now = new Date().toISOString();
  store.db.prepare('UPDATE blocker_work SET status=?, status_by_id=?, status_by_name=?, status_at=?, updated_at=? WHERE project_id=? AND blocker_id=?').run(status, by?.id ?? null, by?.name ?? null, now, now, projectId, blockerId);
}
export function addNote(store: Store, projectId: string, blockerId: string, body: string, author: Person | null): WorkNote {
  const done = store.db.prepare('INSERT INTO blocker_notes(project_id,blocker_id,body,author_id,author_name,at) VALUES (?,?,?,?,?,?)').run(projectId, blockerId, body, author?.id ?? null, author?.name ?? null, new Date().toISOString());
  store.db.prepare('UPDATE blocker_work SET updated_at=? WHERE project_id=? AND blocker_id=?').run(new Date().toISOString(), projectId, blockerId);
  return mapNote(store.db.prepare('SELECT * FROM blocker_notes WHERE id=?').get(Number(done.lastInsertRowid)));
}
function dropRow(store: Store, projectId: string, blockerId: string): void {
  store.db.prepare('DELETE FROM blocker_notes WHERE project_id=? AND blocker_id=?').run(projectId, blockerId);
  store.db.prepare('DELETE FROM blocker_work WHERE project_id=? AND blocker_id=?').run(projectId, blockerId);
}
/** A deleted document takes its owners, statuses and notes with it. */
export function clearProjectWork(store: Store, projectId: string): void {
  ensureWorkTables(store);
  store.db.prepare('DELETE FROM blocker_notes WHERE project_id=?').run(projectId);
  store.db.prepare('DELETE FROM blocker_work WHERE project_id=?').run(projectId);
}

/* ------------------------------------------------------------------ which causes the saved document has */

export interface SavedCause { blockerId: string; kind: BlockerKind; title: string; recordIds: Set<string> }

const memo = new Map<string, { key: string; causes: Map<string, SavedCause> }>();

/**
 * Every cause the server can work out for the saved document, across every customer of its kind and every day approval
 * checks: what the resolver finds for each customer, broken "must" wording rules, and the static rule and data-link
 * checks. Page layout, PDF/web and PDF accessibility need composed pages and are not here (see the full-check report).
 * Kept for as long as the document and its customers stay the same.
 */
export function savedCauses(project: Project, records: SyntheticRecord[]): Map<string, SavedCause> {
  const ofType = records.filter((r) => r.documentType === project.documentType);
  const key = `${project.modelVersion}|${projectContentDigest(project)}|${createHash('sha256').update(JSON.stringify(ofType)).digest('hex')}`;
  const hit = memo.get(project.projectId);
  if (hit && hit.key === key) return hit.causes;
  const causes = new Map<string, SavedCause>();
  const add = (id: string, kind: BlockerKind, title: string, recordId: string | null) => {
    let c = causes.get(id);
    if (!c) { c = { blockerId: id, kind, title, recordIds: new Set() }; causes.set(id, c); }
    if (recordId) c.recordIds.add(recordId);
  };
  const days: Array<string | null> = project.documentDate?.source === 'run' ? approvalDays(project) : [null];
  for (const record of ofType) for (const day of days) for (const b of customerBlockers(project, record, day ? { issueDate: day } : undefined)) add(b.id, b.kind, b.title, record.recordId);
  for (const f of [...wordingFindings(project), ...staticRuleAnalysis(project, records), ...bindingAnalysis(project)]) {
    if (f.severity !== 'blocking') continue;
    const id = blockerIdOf(f);
    add(id, blockerKindOfId(id) ?? 'rules', blockerTitleOf(project, f), null);
  }
  memo.set(project.projectId, { key, causes });
  return causes;
}

/** The approval that ends the "Fixed" listing: the latest approval of the document, if any. */
export function lastApprovalAt(store: Store, projectId: string): string | null {
  return store.workflowHistory(projectId).find((e) => e.action === 'approve')?.at ?? null;
}

/** Customers of the saved document a cause stops, without those an approver set aside for it (phase 2). */
function knownForCause(store: Store, projectId: string, cause: SavedCause | undefined): boolean {
  if (!cause || cause.kind !== 'customer-data' || !cause.recordIds.size) return false;
  const aside = new Set(store.knownDataProblems(projectId).filter((k) => k.blockerId === cause.blockerId).map((k) => k.recordId));
  return [...cause.recordIds].every((r) => aside.has(r));
}

export type EffectiveStatus = 'open' | 'being-fixed' | 'fixed' | 'known-data-problem';
export function effectiveStatus(store: Store, row: BlockerWorkRow, cause: SavedCause | undefined): EffectiveStatus {
  if (row.fixedAt) return 'fixed';
  if (knownForCause(store, row.projectId, cause)) return 'known-data-problem';
  return row.status;
}

function markFixed(store: Store, project: Project, row: BlockerWorkRow, actor: Person | null, how: 'saved-document' | 'full-check'): void {
  const now = new Date().toISOString();
  store.db.prepare('UPDATE blocker_work SET fixed_at=?, fixed_version=?, customer_count=0, updated_at=? WHERE project_id=? AND blocker_id=?').run(now, project.modelVersion, now, project.projectId, row.blockerId);
  store.audit({ user: actor?.id ?? null, userName: actor?.name ?? null, action: 'blocker.fixed', projectId: project.projectId, modelVersion: project.modelVersion, detail: { blockerId: row.blockerId, blocker: row.title, kind: row.kind, how, ownerId: row.owner?.id ?? null } });
  if (row.owner) notify(store, { userId: row.owner.id, kind: 'blocker.fixed', projectId: project.projectId, data: { blockerId: row.blockerId, modelVersion: project.modelVersion }, actor });
}
function reopen(store: Store, project: Project, row: BlockerWorkRow, actor: Person | null, count: number | null): void {
  const now = new Date().toISOString();
  store.db.prepare("UPDATE blocker_work SET fixed_at=NULL, fixed_version=NULL, status='open', customer_count=?, updated_at=? WHERE project_id=? AND blocker_id=?").run(count, now, project.projectId, row.blockerId);
  store.audit({ user: actor?.id ?? null, userName: actor?.name ?? null, action: 'blocker.reopen', projectId: project.projectId, modelVersion: project.modelVersion, detail: { blockerId: row.blockerId, blocker: row.title, kind: row.kind } });
}

/**
 * Brings every worked-on cause of a document up to date with the saved document: a cause gone for every customer is
 * marked fixed (once; its owner is told, unless the owner made the change), a fixed cause that is back is open again, and
 * a fixed cause from before the latest approval drops off with its notes. Does nothing for a document nobody works on.
 * `actor`: who made the change that is being judged (null when it is noticed on a read).
 */
export function refreshBlockerWork(store: Store, project: Project, records: SyntheticRecord[], actor: Person | null): void {
  const rows = workRows(store, project.projectId);
  if (!rows.length) return;
  const approvedAt = lastApprovalAt(store, project.projectId);
  const causes = rows.some((r) => r.speed === 'fast' && !(r.fixedAt && approvedAt && approvedAt > r.fixedAt)) ? savedCauses(project, records) : new Map<string, SavedCause>();
  store.transaction(() => {
    for (const row of rows) {
      if (row.fixedAt && approvedAt && approvedAt > row.fixedAt) { dropRow(store, project.projectId, row.blockerId); continue; }
      if (row.speed !== 'fast') continue;
      const cause = causes.get(row.blockerId);
      if (!row.fixedAt && !cause) markFixed(store, project, row, actor, 'saved-document');
      else if (row.fixedAt && cause) reopen(store, project, row, actor, cause.recordIds.size);
      else if (cause && (cause.recordIds.size !== row.customerCount || cause.title !== row.title)) {
        store.db.prepare('UPDATE blocker_work SET customer_count=?, title=? WHERE project_id=? AND blocker_id=?').run(cause.recordIds.size, cause.title, project.projectId, row.blockerId);
      }
    }
  });
}

/**
 * What a full check of the saved version found (the causes only composed pages show): causes judged by the full check
 * that it no longer finds are fixed, and fixed ones it finds again are open again.
 */
export function applyFullCheck(store: Store, project: Project, found: Set<string>, actor: Person | null): { fixed: string[]; reopened: string[] } {
  const out = { fixed: [] as string[], reopened: [] as string[] };
  const approvedAt = lastApprovalAt(store, project.projectId);
  store.transaction(() => {
    for (const row of workRows(store, project.projectId)) {
      if (row.speed !== 'full-check' || (row.fixedAt && approvedAt && approvedAt > row.fixedAt)) continue;
      if (!row.fixedAt && !found.has(row.blockerId)) { markFixed(store, project, row, actor, 'full-check'); out.fixed.push(row.blockerId); }
      else if (row.fixedAt && found.has(row.blockerId)) { reopen(store, project, row, actor, null); out.reopened.push(row.blockerId); }
    }
  });
  return out;
}
