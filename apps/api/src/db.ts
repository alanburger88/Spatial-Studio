import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
// Loaded via require so test bundlers that do not know the newer node:sqlite builtin leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { projectContentDigest, sha256Hex, type Project, type SyntheticRecord } from '@iss/model';
import { seedProjects } from '@iss/model/fixtures';

/**
 * Local-first POC persistence: SQLite (node:sqlite) behind a small repository API so a
 * PostgreSQL implementation can replace it later. Artifacts are stored on disk by content hash.
 */
export class Store {
  db: DatabaseSyncT;
  artifactDir: string;
  private sampleIds = new Set(seedProjects().map((p) => p.projectId));
  isSample(projectId: string) { return this.sampleIds.has(projectId); }
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.artifactDir = path.join(dataDir, 'artifacts');
    mkdirSync(this.artifactDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'spatial-studio.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects(project_id TEXT PRIMARY KEY, json TEXT NOT NULL, model_version INTEGER NOT NULL, content_digest TEXT NOT NULL, seed_digest TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record_id TEXT NOT NULL, request_json TEXT NOT NULL, summary_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, page_count INTEGER, meta_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record_id TEXT NOT NULL, event_id TEXT NOT NULL, run_id TEXT NOT NULL, content_digest TEXT NOT NULL, canonical TEXT NOT NULL, sha256 TEXT NOT NULL, issued_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imported_records(record_id TEXT PRIMARY KEY, document_type TEXT NOT NULL, source_id TEXT, json TEXT NOT NULL, imported_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(proposal_id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
    `);
    this.ensureSeeds();
  }

  private ensureSeeds() {
    for (const p of seedProjects()) {
      const row = this.db.prepare('SELECT project_id FROM projects WHERE project_id=?').get(p.projectId);
      if (!row) this.putProject(p, projectContentDigest(p));
    }
  }

  /* ---------------------------------------------------------- imported records */

  importedRecords(documentType?: string): SyntheticRecord[] {
    const rows = (documentType ? this.db.prepare('SELECT json FROM imported_records WHERE document_type=? ORDER BY record_id').all(documentType) : this.db.prepare('SELECT json FROM imported_records ORDER BY record_id').all()) as any[];
    return rows.map((r) => JSON.parse(r.json));
  }

  nextImportNumber(documentType: string): number {
    const ids = (this.db.prepare('SELECT record_id FROM imported_records WHERE document_type=?').all(documentType) as any[]).map((r) => Number(String(r.record_id).split('-')[1]));
    return ids.length ? Math.max(...ids) + 1 : 0;
  }

  addImportedRecords(records: SyntheticRecord[]) {
    const now = new Date().toISOString();
    const st = this.db.prepare('INSERT INTO imported_records(record_id,document_type,source_id,json,imported_at) VALUES (?,?,?,?,?)');
    for (const r of records) st.run(r.recordId, r.documentType, (r as any).sourceId ?? null, JSON.stringify(r), now);
  }

  clearImportedRecords(documentType?: string): number {
    const res = documentType ? this.db.prepare('DELETE FROM imported_records WHERE document_type=?').run(documentType) : this.db.prepare('DELETE FROM imported_records').run();
    return Number(res.changes);
  }

  /* ---------------------------------------------------------- projects (user copies) */

  deleteProject(projectId: string) {
    this.db.prepare('DELETE FROM projects WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM snapshots WHERE project_id=?').run(projectId);
  }

  seedFor(projectId: string): Project | undefined {
    return seedProjects().find((p) => p.projectId === projectId);
  }

  listProjects() {
    return (this.db.prepare('SELECT project_id, json, model_version, content_digest, seed_digest, updated_at FROM projects ORDER BY project_id').all() as any[]).map((r) => {
      const p = JSON.parse(r.json) as Project;
      return { projectId: p.projectId, title: p.title, sample: this.sampleIds.has(p.projectId), derivedFrom: (p as any).derivedFrom ?? null, documentType: p.documentType, modelVersion: r.model_version, schemaVersion: p.schemaVersion, issuer: p.issuer, contentDigest: r.content_digest, modified: r.content_digest !== r.seed_digest, updatedAt: r.updated_at, nodeCount: p.nodes.length, ruleCount: p.rules.length };
    });
  }

  getProject(projectId: string): Project | undefined {
    const r = this.db.prepare('SELECT json FROM projects WHERE project_id=?').get(projectId) as any;
    return r ? JSON.parse(r.json) : undefined;
  }

  putProject(p: Project, seedDigest?: string) {
    const now = new Date().toISOString();
    const stored = { ...p, lastSavedAt: now };
    const digest = projectContentDigest(p);
    const existingSeed = (this.db.prepare('SELECT seed_digest FROM projects WHERE project_id=?').get(p.projectId) as any)?.seed_digest;
    this.db.prepare('INSERT OR REPLACE INTO projects(project_id,json,model_version,content_digest,seed_digest,updated_at) VALUES (?,?,?,?,?,?)')
      .run(p.projectId, JSON.stringify(stored), p.modelVersion, digest, seedDigest ?? existingSeed ?? digest, now);
    return stored;
  }

  saveRun(runId: string, projectId: string, recordId: string, request: unknown, summary: unknown) {
    this.db.prepare('INSERT OR IGNORE INTO runs(run_id,project_id,record_id,request_json,summary_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(runId, projectId, recordId, JSON.stringify(request), JSON.stringify(summary), new Date().toISOString());
  }

  getRun(runId: string): { request: any; summary: any; createdAt: string } | undefined {
    const r = this.db.prepare('SELECT request_json, summary_json, created_at FROM runs WHERE run_id=?').get(runId) as any;
    return r ? { request: JSON.parse(r.request_json), summary: JSON.parse(r.summary_json), createdAt: r.created_at } : undefined;
  }

  saveArtifact(runId: string, kind: 'pdf' | 'html' | 'afp-sim' | 'manifest', filename: string, bytes: Buffer, meta: Record<string, unknown>, pageCount?: number) {
    const sha = sha256Hex(new Uint8Array(bytes));
    const artifactId = `art-${kind}-${sha.slice(0, 16)}`;
    const file = path.join(this.artifactDir, artifactId);
    if (!existsSync(file)) writeFileSync(file, bytes);
    this.db.prepare('INSERT OR IGNORE INTO artifacts(artifact_id,run_id,kind,filename,sha256,size,page_count,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(artifactId, runId, kind, filename, sha, bytes.length, pageCount ?? null, JSON.stringify(meta), new Date().toISOString());
    return { artifactId, sha256: sha, size: bytes.length, filename };
  }

  getArtifact(artifactId: string) {
    if (!/^art-[a-z-]+-[0-9a-f]{16}$/.test(artifactId)) return undefined;
    const r = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(artifactId) as any;
    if (!r) return undefined;
    return { ...r, meta: JSON.parse(r.meta_json), bytes: readFileSync(path.join(this.artifactDir, artifactId)) };
  }

  listArtifacts(filter: { runId?: string; projectId?: string; limit?: number } = {}) {
    const rows = (filter.runId
      ? this.db.prepare('SELECT a.*, r.project_id, r.record_id FROM artifacts a JOIN runs r ON r.run_id=a.run_id WHERE a.run_id=? ORDER BY a.created_at DESC').all(filter.runId)
      : filter.projectId
        ? this.db.prepare('SELECT a.*, r.project_id, r.record_id FROM artifacts a JOIN runs r ON r.run_id=a.run_id WHERE r.project_id=? ORDER BY a.created_at DESC LIMIT ?').all(filter.projectId, filter.limit ?? 30)
        : this.db.prepare('SELECT a.*, r.project_id, r.record_id FROM artifacts a JOIN runs r ON r.run_id=a.run_id ORDER BY a.created_at DESC LIMIT ?').all(filter.limit ?? 30)) as any[];
    return rows.map((r) => ({ artifactId: r.artifact_id, runId: r.run_id, projectId: r.project_id, recordId: r.record_id, kind: r.kind, filename: r.filename, sha256: r.sha256, size: r.size, pageCount: r.page_count, createdAt: r.created_at, meta: JSON.parse(r.meta_json) }));
  }

  /** Issued snapshots are write-once: a second issue for the same key returns the original, never overwrites. */
  issueSnapshot(projectId: string, recordId: string, eventId: string, runId: string, contentDigest: string, canonical: string) {
    const snapshotId = `snap-${sha256Hex(`${projectId}|${recordId}|${eventId}`).slice(0, 16)}`;
    const existing = this.db.prepare('SELECT * FROM snapshots WHERE snapshot_id=?').get(snapshotId) as any;
    if (existing) return { ...this.mapSnap(existing), alreadyIssued: true };
    const sha = sha256Hex(canonical);
    const issuedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO snapshots(snapshot_id,project_id,record_id,event_id,run_id,content_digest,canonical,sha256,issued_at) VALUES (?,?,?,?,?,?,?,?,?)').run(snapshotId, projectId, recordId, eventId, runId, contentDigest, canonical, sha, issuedAt);
    return { ...this.mapSnap(this.db.prepare('SELECT * FROM snapshots WHERE snapshot_id=?').get(snapshotId)), alreadyIssued: false };
  }

  listSnapshots(projectId: string, recordId?: string) {
    const rows = (recordId ? this.db.prepare('SELECT * FROM snapshots WHERE project_id=? AND record_id=? ORDER BY issued_at').all(projectId, recordId) : this.db.prepare('SELECT * FROM snapshots WHERE project_id=? ORDER BY issued_at').all(projectId)) as any[];
    return rows.map((r) => this.mapSnap(r));
  }

  private mapSnap(r: any) {
    return { snapshotId: r.snapshot_id, projectId: r.project_id, recordId: r.record_id, eventId: r.event_id, runId: r.run_id, contentDigest: r.content_digest, sha256: r.sha256, verified: sha256Hex(r.canonical) === r.sha256, issuedAt: r.issued_at, canonicalBytes: r.canonical.length };
  }

  clearSnapshots(projectId: string) {
    this.db.prepare('DELETE FROM snapshots WHERE project_id=?').run(projectId);
  }

  saveProposal(id: string, proposal: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO proposals(proposal_id,json,status,created_at) VALUES (?,?,?,?)').run(id, JSON.stringify(proposal), 'pending', new Date().toISOString());
  }
  getProposal(id: string) {
    const r = this.db.prepare('SELECT * FROM proposals WHERE proposal_id=?').get(id) as any;
    return r ? { proposal: JSON.parse(r.json), status: r.status as string, decidedAt: r.decided_at } : undefined;
  }
  decideProposal(id: string, status: 'approved' | 'declined') {
    this.db.prepare('UPDATE proposals SET status=?, decided_at=? WHERE proposal_id=? AND status=?').run(status, new Date().toISOString(), id, 'pending');
  }
}
