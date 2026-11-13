import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
// Loaded via require so test bundlers that do not know the newer node:sqlite builtin leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { DEMOTE_ON_SAVE, WORKFLOW_LABEL, projectContentDigest, sha256Hex, type Project, type Role, type SyntheticRecord, type TemplateInfo, type TemplateVersionInfo, type WorkflowState } from '@iss/model';
import { seedProjects } from '@iss/model/fixtures';

export interface StoredUser { id: string; email: string; name: string; role: Role; disabled: boolean; createdAt: string; updatedAt: string }

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
      CREATE TABLE IF NOT EXISTS assets(asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE, width INTEGER, height INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(proposal_id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS project_versions(project_id TEXT NOT NULL, model_version INTEGER NOT NULL, json TEXT NOT NULL, content_digest TEXT NOT NULL, saved_at TEXT NOT NULL, saved_by TEXT, label TEXT, PRIMARY KEY(project_id, model_version));
      CREATE TABLE IF NOT EXISTS workflow(project_id TEXT PRIMARY KEY, state TEXT NOT NULL, model_version INTEGER NOT NULL, content_digest TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);
      CREATE TABLE IF NOT EXISTS workflow_events(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, action TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL, comment TEXT, user_id TEXT, user_name TEXT, at TEXT NOT NULL, model_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT NOT NULL, parent_id TEXT, body TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, model_version INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS comments_by_project ON comments(project_id, node_id);
      CREATE TABLE IF NOT EXISTS users(user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user TEXT, user_name TEXT, action TEXT NOT NULL, project_id TEXT, model_version INTEGER, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_by_project ON audit(project_id, id);
      CREATE TABLE IF NOT EXISTS project_records(record_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_type TEXT NOT NULL, origin TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS project_records_by_project ON project_records(project_id);
      CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_test_data(project_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS templates(template_id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, document_type TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS template_versions(template_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, meta TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(template_id, version));
    `);
    this.ensureSeeds();
    this.backfillVersions();
  }

  /** Every project's current state is always present in its version history (older databases predate it). */
  private backfillVersions() {
    const rows = this.db.prepare('SELECT p.project_id, p.json, p.model_version, p.content_digest, p.updated_at FROM projects p LEFT JOIN project_versions v ON v.project_id=p.project_id AND v.model_version=p.model_version WHERE v.project_id IS NULL').all() as any[];
    const st = this.db.prepare('INSERT OR IGNORE INTO project_versions(project_id,model_version,json,content_digest,saved_at,saved_by,label) VALUES (?,?,?,?,?,?,?)');
    for (const r of rows) st.run(r.project_id, r.model_version, r.json, r.content_digest, r.updated_at, null, 'Recorded at start-up');
  }

  private ensureSeeds() {
    for (const p of seedProjects()) {
      const row = this.db.prepare('SELECT project_id FROM projects WHERE project_id=?').get(p.projectId);
      if (!row) this.putProject(p, projectContentDigest(p), { label: 'Approved sample' });
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

  /* ---------------------------------------------------------- image asset library */

  private assetFile(sha: string) { return path.join(this.artifactDir, `asset-${sha}`); }
  listAssets() {
    return (this.db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all() as any[]).map((r) => ({ assetId: r.asset_id, name: r.name, mime: r.mime, size: r.size, sha256: r.sha256, width: r.width, height: r.height, createdAt: r.created_at }));
  }
  getAsset(assetId: string) { return this.listAssets().find((a) => a.assetId === assetId); }
  assetBytes(sha: string): Buffer | null { const f = this.assetFile(sha); return existsSync(f) ? readFileSync(f) : null; }
  /** Content-addressed: uploading identical bytes returns the existing asset. */
  addAsset(name: string, mime: string, bytes: Buffer, width: number | null, height: number | null) {
    const sha = sha256Hex(bytes);
    const existing = this.listAssets().find((a) => a.sha256 === sha);
    if (existing) return { ...existing, duplicate: true };
    writeFileSync(this.assetFile(sha), bytes);
    const id = `asset-${sha.slice(0, 12)}`;
    this.db.prepare('INSERT INTO assets(asset_id,name,mime,size,sha256,width,height,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, name, mime, bytes.length, sha, width, height, new Date().toISOString());
    return { ...this.getAsset(id)!, duplicate: false };
  }
  deleteAsset(assetId: string) { return Number(this.db.prepare('DELETE FROM assets WHERE asset_id=?').run(assetId).changes) > 0; }

  /* ---------------------------------------------------------- records that belong to one project */

  /** Generated test customers and data supplied for one project. Never visible to other projects. */
  projectRecords(projectId: string, origin?: 'generated' | 'supplied'): SyntheticRecord[] {
    const rows = (origin
      ? this.db.prepare('SELECT json FROM project_records WHERE project_id=? AND origin=? ORDER BY record_id').all(projectId, origin)
      : this.db.prepare('SELECT json FROM project_records WHERE project_id=? ORDER BY record_id').all(projectId)) as any[];
    return rows.map((r) => JSON.parse(r.json));
  }
  /** Lookup by id across every project (ids are unique studio-wide). */
  projectRecord(recordId: string): SyntheticRecord | undefined {
    const r = this.db.prepare('SELECT json FROM project_records WHERE record_id=?').get(recordId) as any;
    return r ? JSON.parse(r.json) : undefined;
  }
  /** Adds records for one project, giving each a studio-wide unique, never reused id `<PREFIX>-6xxxx`. Returns the stored records. */
  addProjectRecords(projectId: string, prefix: string, origin: 'generated' | 'supplied', records: Array<Omit<SyntheticRecord, 'recordId'>>): SyntheticRecord[] {
    const now = new Date().toISOString();
    // Ids are never reused, even after a set is replaced or removed: an old run or pinned test must not silently point at a different customer.
    const inUse = (this.db.prepare('SELECT record_id FROM project_records').all() as any[]).reduce((m, r) => Math.max(m, Number(String(r.record_id).split('-')[1]) || 0), 60000);
    const max = Math.max(inUse, Number((this.db.prepare("SELECT value FROM counters WHERE name='project_record'").get() as any)?.value ?? 0));
    this.db.prepare("INSERT INTO counters(name,value) VALUES ('project_record',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(max + records.length);
    const st = this.db.prepare('INSERT INTO project_records(record_id,project_id,document_type,origin,json,created_at) VALUES (?,?,?,?,?,?)');
    return records.map((r, i) => {
      const rec = { ...r, recordId: `${prefix}-${max + 1 + i}`, projectId } as SyntheticRecord;
      st.run(rec.recordId, projectId, rec.documentType, origin, JSON.stringify(rec), now);
      return rec;
    });
  }
  /** Where one of a project's own records came from, or undefined when it is not that project's record. */
  projectRecordOrigin(projectId: string, recordId: string): 'generated' | 'supplied' | undefined {
    return (this.db.prepare('SELECT origin FROM project_records WHERE project_id=? AND record_id=?').get(projectId, recordId) as any)?.origin;
  }
  /** Replaces one of the project's own records (same id). A record a person has edited is theirs from then on (origin `supplied`), so regenerating never overwrites it. */
  updateProjectRecord(projectId: string, record: SyntheticRecord): boolean {
    return Number(this.db.prepare("UPDATE project_records SET json=?, origin='supplied' WHERE project_id=? AND record_id=?").run(JSON.stringify(record), projectId, record.recordId).changes) > 0;
  }
  deleteProjectRecord(projectId: string, recordId: string): boolean {
    return Number(this.db.prepare('DELETE FROM project_records WHERE project_id=? AND record_id=?').run(projectId, recordId).changes) > 0;
  }
  clearProjectRecords(projectId: string, origin?: 'generated' | 'supplied'): number {
    return Number((origin ? this.db.prepare('DELETE FROM project_records WHERE project_id=? AND origin=?').run(projectId, origin) : this.db.prepare('DELETE FROM project_records WHERE project_id=?').run(projectId)).changes);
  }
  /** What the last generation covered (targets and summary), for showing coverage without regenerating. */
  getTestDataPlan(projectId: string): { plan: any; createdAt: string } | undefined {
    const r = this.db.prepare('SELECT json, created_at FROM project_test_data WHERE project_id=?').get(projectId) as any;
    return r ? { plan: JSON.parse(r.json), createdAt: r.created_at } : undefined;
  }
  setTestDataPlan(projectId: string, plan: unknown | null) {
    this.db.prepare('DELETE FROM project_test_data WHERE project_id=?').run(projectId);
    if (plan) this.db.prepare('INSERT INTO project_test_data(project_id,json,created_at) VALUES (?,?,?)').run(projectId, JSON.stringify(plan), new Date().toISOString());
  }

  /* ---------------------------------------------------------- saved templates (frozen, numbered versions) */

  /** Saved templates with their version lists (newest first). Template content is not loaded. */
  listSavedTemplates(): TemplateInfo[] {
    const versions = this.db.prepare('SELECT template_id, version, meta, saved_at FROM template_versions ORDER BY version DESC').all() as any[];
    return (this.db.prepare('SELECT * FROM templates ORDER BY created_at').all() as any[]).map((t) => {
      const vs: TemplateVersionInfo[] = versions.filter((v) => v.template_id === t.template_id).map((v) => ({ version: v.version, savedAt: v.saved_at, ...JSON.parse(v.meta) }));
      return { id: t.template_id, title: t.title, description: t.description, documentType: t.document_type, source: 'saved' as const, version: vs[0]?.version ?? 0, versions: vs, retired: !!t.retired };
    });
  }
  getSavedTemplate(templateId: string): TemplateInfo | undefined { return this.listSavedTemplates().find((t) => t.id === templateId); }
  /** The frozen content of one version (latest when no version is given). */
  savedTemplateContent(templateId: string, version?: number): { version: number; content: Project } | undefined {
    const r = (version === undefined
      ? this.db.prepare('SELECT version, json FROM template_versions WHERE template_id=? ORDER BY version DESC LIMIT 1').get(templateId)
      : this.db.prepare('SELECT version, json FROM template_versions WHERE template_id=? AND version=?').get(templateId, version)) as any;
    return r ? { version: r.version, content: JSON.parse(r.json) } : undefined;
  }
  /** Adds a version (creating the template on its first save). Earlier versions are never changed. */
  addTemplateVersion(t: { id: string; title: string; description: string; documentType: string }, content: Project, meta: Omit<TemplateVersionInfo, 'version' | 'savedAt'>): TemplateInfo {
    const now = new Date().toISOString();
    const exists = this.db.prepare('SELECT template_id FROM templates WHERE template_id=?').get(t.id);
    if (!exists) this.db.prepare('INSERT INTO templates(template_id,title,description,document_type,retired,created_at) VALUES (?,?,?,?,0,?)').run(t.id, t.title, t.description, t.documentType, now);
    else this.db.prepare('UPDATE templates SET title=?, description=?, retired=0 WHERE template_id=?').run(t.title, t.description, t.id);
    const next = Number((this.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM template_versions WHERE template_id=?').get(t.id) as any).v) + 1;
    this.db.prepare('INSERT INTO template_versions(template_id,version,json,meta,saved_at) VALUES (?,?,?,?,?)').run(t.id, next, JSON.stringify(content), JSON.stringify(meta), now);
    return this.getSavedTemplate(t.id)!;
  }
  setTemplateRetired(templateId: string, retired: boolean): TemplateInfo | undefined {
    this.db.prepare('UPDATE templates SET retired=? WHERE template_id=?').run(retired ? 1 : 0, templateId);
    return this.getSavedTemplate(templateId);
  }
  /** Test and demo reset only: removes every saved template. */
  clearSavedTemplates(): number {
    const n = Number(this.db.prepare('DELETE FROM templates').run().changes);
    this.db.prepare('DELETE FROM template_versions').run();
    return n;
  }

  /* ---------------------------------------------------------- projects (user copies) */

  deleteProject(projectId: string) {
    for (const t of ['projects', 'snapshots', 'project_versions', 'workflow', 'workflow_events', 'comments', 'project_records', 'project_test_data']) this.db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(projectId);
  }

  seedFor(projectId: string): Project | undefined {
    return seedProjects().find((p) => p.projectId === projectId);
  }

  listProjects() {
    return (this.db.prepare('SELECT project_id, json, model_version, content_digest, seed_digest, updated_at FROM projects ORDER BY project_id').all() as any[]).map((r) => {
      const p = JSON.parse(r.json) as Project;
      return { projectId: p.projectId, title: p.title, sample: this.sampleIds.has(p.projectId), derivedFrom: (p as any).derivedFrom ?? null, fromTemplate: p.fromTemplate ?? null, importedFrom: p.importedFrom ? { title: p.importedFrom.title, modelVersion: p.importedFrom.modelVersion } : null, documentType: p.documentType, modelVersion: r.model_version, schemaVersion: p.schemaVersion, issuer: p.issuer, contentDigest: r.content_digest, modified: r.content_digest !== r.seed_digest, updatedAt: r.updated_at, nodeCount: p.nodes.length, ruleCount: p.rules.length };
    });
  }

  getProject(projectId: string): Project | undefined {
    const r = this.db.prepare('SELECT json FROM projects WHERE project_id=?').get(projectId) as any;
    return r ? JSON.parse(r.json) : undefined;
  }

  /**
   * Stores the project and an immutable copy in its version history. `meta.by` / `meta.label` describe who
   * saved it and why ("Restored v3"). A changed model saved while approved/published/changes-requested moves
   * the review workflow back to draft (recorded as a workflow event).
   */
  putProject(p: Project, seedDigest?: string, meta: { by?: { id: string; name: string } | null; label?: string | null } = {}) {
    const now = new Date().toISOString();
    const stored = { ...p, lastSavedAt: now };
    const digest = projectContentDigest(p);
    const existingSeed = (this.db.prepare('SELECT seed_digest FROM projects WHERE project_id=?').get(p.projectId) as any)?.seed_digest;
    const json = JSON.stringify(stored);
    this.db.prepare('INSERT OR REPLACE INTO projects(project_id,json,model_version,content_digest,seed_digest,updated_at) VALUES (?,?,?,?,?,?)')
      .run(p.projectId, json, p.modelVersion, digest, seedDigest ?? existingSeed ?? digest, now);
    const prior = this.db.prepare('SELECT content_digest FROM project_versions WHERE project_id=? AND model_version=?').get(p.projectId, p.modelVersion) as any;
    if (!prior) this.db.prepare('INSERT INTO project_versions(project_id,model_version,json,content_digest,saved_at,saved_by,label) VALUES (?,?,?,?,?,?,?)').run(p.projectId, p.modelVersion, json, digest, now, meta.by?.name ?? null, meta.label ?? null);
    else if (prior.content_digest !== digest) this.db.prepare('UPDATE project_versions SET json=?, content_digest=?, saved_at=?, saved_by=?, label=? WHERE project_id=? AND model_version=?').run(json, digest, now, meta.by?.name ?? null, `${meta.label ?? 'Saved'} (replaced in place)`, p.projectId, p.modelVersion);
    this.demoteOnChange(p.projectId, p.modelVersion, digest, meta.by ?? null);
    return stored;
  }

  /* ---------------------------------------------------------- version history */

  listVersions(projectId: string) {
    return (this.db.prepare('SELECT project_id, model_version, content_digest, saved_at, saved_by, label, length(json) AS bytes FROM project_versions WHERE project_id=? ORDER BY model_version DESC').all(projectId) as any[])
      .map((r) => ({ modelVersion: r.model_version as number, contentDigest: r.content_digest as string, savedAt: r.saved_at as string, savedBy: (r.saved_by ?? null) as string | null, label: (r.label ?? null) as string | null, bytes: r.bytes as number }));
  }
  getVersion(projectId: string, modelVersion: number): { project: Project; contentDigest: string; savedAt: string; savedBy: string | null; label: string | null } | undefined {
    const r = this.db.prepare('SELECT * FROM project_versions WHERE project_id=? AND model_version=?').get(projectId, modelVersion) as any;
    return r ? { project: JSON.parse(r.json), contentDigest: r.content_digest, savedAt: r.saved_at, savedBy: r.saved_by ?? null, label: r.label ?? null } : undefined;
  }

  /* ---------------------------------------------------------- review workflow */

  getWorkflow(projectId: string): { state: WorkflowState; modelVersion: number | null; contentDigest: string | null; updatedAt: string | null; updatedBy: string | null } {
    const r = this.db.prepare('SELECT * FROM workflow WHERE project_id=?').get(projectId) as any;
    return r ? { state: r.state, modelVersion: r.model_version, contentDigest: r.content_digest, updatedAt: r.updated_at, updatedBy: r.updated_by ?? null } : { state: 'draft', modelVersion: null, contentDigest: null, updatedAt: null, updatedBy: null };
  }
  setWorkflow(projectId: string, action: string, to: WorkflowState, modelVersion: number, contentDigest: string, by: { id: string; name: string } | null, comment: string | null) {
    const from = this.getWorkflow(projectId).state;
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO workflow(project_id,state,model_version,content_digest,updated_at,updated_by) VALUES (?,?,?,?,?,?)').run(projectId, to, modelVersion, contentDigest, now, by?.name ?? null);
    this.db.prepare('INSERT INTO workflow_events(project_id,action,from_state,to_state,comment,user_id,user_name,at,model_version) VALUES (?,?,?,?,?,?,?,?,?)').run(projectId, action, from, to, comment, by?.id ?? null, by?.name ?? null, now, modelVersion);
    return { from, to };
  }
  workflowHistory(projectId: string, limit = 200) {
    return (this.db.prepare('SELECT * FROM workflow_events WHERE project_id=? ORDER BY id DESC LIMIT ?').all(projectId, limit) as any[])
      .map((r) => ({ id: r.id as number, action: r.action as string, from: r.from_state as WorkflowState, to: r.to_state as WorkflowState, comment: (r.comment ?? null) as string | null, user: (r.user_name ?? null) as string | null, userId: (r.user_id ?? null) as string | null, at: r.at as string, modelVersion: r.model_version as number }));
  }
  /** Saving a changed model while approved/published (or with changes requested) returns the document to draft. */
  private demoteOnChange(projectId: string, modelVersion: number, digest: string, by: { id: string; name: string } | null) {
    const wf = this.getWorkflow(projectId);
    if (!DEMOTE_ON_SAVE.includes(wf.state) || wf.contentDigest === digest) return;
    this.setWorkflow(projectId, 'auto_reopen', 'draft', modelVersion, digest, by, `Version ${modelVersion} was saved with changes while the document was ${WORKFLOW_LABEL[wf.state].toLowerCase()}, so it needs review again.`);
  }

  /* ---------------------------------------------------------- comments */

  private mapComment = (r: any) => ({ id: r.id as string, projectId: r.project_id as string, nodeId: r.node_id as string, parentId: (r.parent_id ?? null) as string | null, body: r.body as string, author: r.author as string, authorName: r.author_name as string, createdAt: r.created_at as string, resolvedAt: (r.resolved_at ?? null) as string | null, resolvedBy: (r.resolved_by ?? null) as string | null, modelVersion: r.model_version as number });
  listComments(projectId: string, nodeId?: string) {
    const rows = (nodeId ? this.db.prepare('SELECT * FROM comments WHERE project_id=? AND node_id=? ORDER BY created_at, id').all(projectId, nodeId) : this.db.prepare('SELECT * FROM comments WHERE project_id=? ORDER BY created_at, id').all(projectId)) as any[];
    return rows.map(this.mapComment);
  }
  getComment(id: string) { const r = this.db.prepare('SELECT * FROM comments WHERE id=?').get(id) as any; return r ? this.mapComment(r) : undefined; }
  addComment(c: { id: string; projectId: string; nodeId: string; parentId: string | null; body: string; author: string; authorName: string; modelVersion: number }) {
    this.db.prepare('INSERT INTO comments(id,project_id,node_id,parent_id,body,author,author_name,created_at,model_version) VALUES (?,?,?,?,?,?,?,?,?)').run(c.id, c.projectId, c.nodeId, c.parentId, c.body, c.author, c.authorName, new Date().toISOString(), c.modelVersion);
    return this.getComment(c.id)!;
  }
  setCommentResolved(id: string, resolved: boolean, by: string | null) {
    this.db.prepare('UPDATE comments SET resolved_at=?, resolved_by=? WHERE id=?').run(resolved ? new Date().toISOString() : null, resolved ? by : null, id);
    return this.getComment(id)!;
  }
  /** Deleting a thread root also deletes its replies. */
  deleteComment(id: string) { return Number(this.db.prepare('DELETE FROM comments WHERE id=? OR parent_id=?').run(id, id).changes); }

  /* ---------------------------------------------------------- users & sessions */

  private mapUser = (r: any): StoredUser => ({ id: r.user_id as string, email: r.email as string, name: r.name as string, role: r.role as Role, disabled: !!r.disabled, createdAt: r.created_at as string, updatedAt: r.updated_at as string });
  countUsers() { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n); }
  listUsers() { return (this.db.prepare('SELECT * FROM users ORDER BY created_at, email').all() as any[]).map(this.mapUser); }
  getUser(id: string) { const r = this.db.prepare('SELECT * FROM users WHERE user_id=?').get(id) as any; return r ? this.mapUser(r) : undefined; }
  userCredentials(email: string): { user: StoredUser; salt: string; hash: string } | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase()) as any;
    return r ? { user: this.mapUser(r), salt: r.salt, hash: r.hash } : undefined;
  }
  addUser(u: { id: string; email: string; name: string; role: Role; salt: string; hash: string }) {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO users(user_id,email,name,role,salt,hash,disabled,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)').run(u.id, u.email.toLowerCase(), u.name, u.role, u.salt, u.hash, now, now);
    return this.getUser(u.id)!;
  }
  updateUser(id: string, patch: { name?: string; role?: Role; disabled?: boolean; salt?: string; hash?: string }) {
    const cur = this.db.prepare('SELECT * FROM users WHERE user_id=?').get(id) as any;
    if (!cur) return undefined;
    this.db.prepare('UPDATE users SET name=?, role=?, disabled=?, salt=?, hash=?, updated_at=? WHERE user_id=?')
      .run(patch.name ?? cur.name, patch.role ?? cur.role, patch.disabled === undefined ? cur.disabled : patch.disabled ? 1 : 0, patch.salt ?? cur.salt, patch.hash ?? cur.hash, new Date().toISOString(), id);
    return this.getUser(id)!;
  }
  addSession(tokenHash: string, userId: string, expiresAt: string) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(tokenHash, userId, new Date().toISOString(), expiresAt);
  }
  getSession(tokenHash: string) {
    const r = this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(tokenHash) as any;
    return r ? { userId: r.user_id as string, expiresAt: r.expires_at as string } : undefined;
  }
  deleteSession(tokenHash: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); }
  deleteUserSessions(userId: string) { this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); }

  /* ---------------------------------------------------------- audit log (never stores content bodies) */

  audit(e: { user: string | null; userName: string | null; action: string; projectId?: string | null; modelVersion?: number | null; detail?: Record<string, unknown> }) {
    this.db.prepare('INSERT INTO audit(at,user,user_name,action,project_id,model_version,detail) VALUES (?,?,?,?,?,?,?)').run(new Date().toISOString(), e.user, e.userName, e.action, e.projectId ?? null, e.modelVersion ?? null, JSON.stringify(e.detail ?? {}));
  }
  listAudit(f: { projectId?: string; user?: string; action?: string; since?: string; before?: number; limit?: number } = {}) {
    const where: string[] = [], args: Array<string | number> = [];
    if (f.projectId) { where.push('project_id=?'); args.push(f.projectId); }
    if (f.user) { where.push('user=?'); args.push(f.user); }
    if (f.action) { where.push(f.action.endsWith('.') ? 'action LIKE ?' : 'action=?'); args.push(f.action.endsWith('.') ? `${f.action}%` : f.action); }
    if (f.since) { where.push('at>=?'); args.push(f.since); }
    if (f.before) { where.push('id<?'); args.push(f.before); }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const rows = this.db.prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as any[];
    return rows.map((r) => ({ id: r.id as number, at: r.at as string, user: (r.user ?? null) as string | null, userName: (r.user_name ?? null) as string | null, action: r.action as string, projectId: (r.project_id ?? null) as string | null, modelVersion: (r.model_version ?? null) as number | null, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  }
  auditActors() {
    return (this.db.prepare('SELECT user, MAX(user_name) AS name, COUNT(*) AS n FROM audit WHERE user IS NOT NULL GROUP BY user ORDER BY name').all() as any[]).map((r) => ({ id: r.user as string, name: (r.name ?? r.user) as string, count: Number(r.n) }));
  }

  saveRun(runId: string, projectId: string, recordId: string, request: unknown, summary: unknown) {
    this.db.prepare('INSERT OR IGNORE INTO runs(run_id,project_id,record_id,request_json,summary_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(runId, projectId, recordId, JSON.stringify(request), JSON.stringify(summary), new Date().toISOString());
  }

  getRun(runId: string): { request: any; summary: any; createdAt: string } | undefined {
    const r = this.db.prepare('SELECT request_json, summary_json, created_at FROM runs WHERE run_id=?').get(runId) as any;
    return r ? { request: JSON.parse(r.request_json), summary: JSON.parse(r.summary_json), createdAt: r.created_at } : undefined;
  }

  saveArtifact(runId: string, kind: 'pdf' | 'html' | 'afp-sim' | 'manifest' | 'email', filename: string, bytes: Buffer, meta: Record<string, unknown>, pageCount?: number) {
    const sha = sha256Hex(new Uint8Array(bytes));
    const artifactId = `art-${kind}-${sha.slice(0, 16)}`;
    const file = path.join(this.artifactDir, artifactId);
    if (!existsSync(file)) writeFileSync(file, bytes);
    // PDF bytes are not reproducible (embedded timestamps), so the content hash cannot dedupe a rebuild of the same
    // document. The run ID identifies the resolved document exactly, so a rebuild for the same run, draft state and
    // renderer supersedes the earlier export: the history lists only the latest, while the earlier file stays on disk
    // so a link that was already copied keeps downloading.
    if (kind === 'pdf') {
      const same = (this.db.prepare("SELECT artifact_id, meta_json FROM artifacts WHERE run_id=? AND kind='pdf' AND artifact_id<>?").all(runId, artifactId) as any[])
        .map((r) => ({ id: r.artifact_id as string, m: JSON.parse(r.meta_json) as Record<string, unknown> }))
        .filter((r) => !r.m.supersededBy && !!r.m.draft === !!meta.draft && r.m.renderer === meta.renderer);
      for (const r of same) this.db.prepare('UPDATE artifacts SET meta_json=? WHERE artifact_id=?').run(JSON.stringify({ ...r.m, supersededBy: artifactId }), r.id);
    }
    const now = new Date().toISOString();
    const done = this.db.prepare('INSERT OR IGNORE INTO artifacts(artifact_id,run_id,kind,filename,sha256,size,page_count,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(artifactId, runId, kind, filename, sha, bytes.length, pageCount ?? null, JSON.stringify(meta), now);
    // Byte-identical to an export that was superseded earlier: it is the latest again.
    if (kind === 'pdf' && !done.changes) this.db.prepare('UPDATE artifacts SET meta_json=?, created_at=? WHERE artifact_id=? AND run_id=?').run(JSON.stringify(meta), now, artifactId, runId);
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
    return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta_json) })).filter((r) => !r.meta.supersededBy).map((r) => ({ artifactId: r.artifact_id, runId: r.run_id, projectId: r.project_id, recordId: r.record_id, kind: r.kind, filename: r.filename, sha256: r.sha256, size: r.size, pageCount: r.page_count, createdAt: r.created_at, meta: r.meta }));
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
