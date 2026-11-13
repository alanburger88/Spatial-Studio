import { createHash } from 'node:crypto';
import { customFieldDefs, validateRecordShape, type Project, type SyntheticRecord } from '@iss/model';
import { PROOF_CHANNELS, buildProofRecord, proofRecordProblems, resolve, verifyProof, type ProofChannel, type ProofDifference, type ProofOutput, type ProofRecord, type Resolution } from '@iss/resolver';
import { renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms } from '@iss/renderers';
import { explainInPlainWords, nodeWords, ruleWords } from '@iss/scenarios';
import type { Store, StoredRelease } from './db';
import type { PackageComposer } from './releasePackage';

/**
 * Proof for any customer: what a customer was given, from which release, and why — without the customer's data.
 *
 * The record itself is the contract in `packages/resolver/src/proof.ts` (fingerprints and decisions only). This file
 * keeps those records (add only, never edited or deleted), produces them from a FROZEN release, reads them from a
 * runnable package's `proof.jsonl`, and re-creates a document to check a record. Routes: `routes/proofs.ts`;
 * shapes: `docs/api/PROOFS.md`.
 *
 * Nothing here stores, logs or audits customer data. The produced files are not kept either: producing returns the
 * fingerprints and the records, and a check returns the re-created outputs in its answer only.
 */

/* ------------------------------------------------------------------ limits (stated on the screen and in PROOFS.md) */

export const PROOF_LIMITS = {
  /** Customers in one "produce" request when no PDF is asked for (the batch runner's limit). */
  customers: 500,
  /** Customers in one "produce" request when the PDF is asked for: each PDF is composed in a browser (about 0.3 s). */
  customersWithPdf: 20,
  /** The text of a proof.jsonl file. */
  fileBytes: 5 * 1024 * 1024,
  fileLines: 10_000,
  /** One line of a proof.jsonl file. */
  lineBytes: 256 * 1024,
  /** Data supplied for a check, as JSON. */
  suppliedBytes: 1024 * 1024,
  /** One page of search results. */
  pageMax: 100,
} as const;

/** The outputs produced when none are named. The PDF is optional because it is slow. */
export const DEFAULT_CHANNELS: readonly ProofChannel[] = ['email', 'sms', 'html'];
export const CHANNEL_LABEL: Record<ProofChannel, string> = { pdf: 'PDF', html: 'web page', email: 'email', sms: 'text message (SMS)' };
/** The one output profile every proof is resolved with (the runnable package uses the same). */
const PROFILE = 'paged-pdf' as const;

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
type Who = { id: string; name: string } | null;

/* ------------------------------------------------------------------ the record store: add only */

export interface StoredProofMeta {
  /** Where the studio got the record: it produced it, or it was added from a file. */
  source: 'studio' | 'file';
  addedAt: string;
  addedBy: Who;
}
export interface ProofSearch { documentId?: string; releaseId?: string; customerRef?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number }

/**
 * `proof_records` only ever grows. There is no update or delete method, and the table itself refuses both
 * (`proof_records_are_frozen`, `proof_records_are_kept`). The one exception is the test reset, which opens a gate
 * row for the length of one transaction (off unless the server runs with PROOFS_RESET=allow or RELEASES_RESET=allow).
 */
export class ProofStore {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS proof_records(proof_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, release_id TEXT NOT NULL, release_number INTEGER NOT NULL, release_digest TEXT NOT NULL, customer_ref TEXT NOT NULL, run_id TEXT NOT NULL, produced_at TEXT NOT NULL, producer TEXT NOT NULL, produced INTEGER NOT NULL, json TEXT NOT NULL, source TEXT NOT NULL, added_at TEXT NOT NULL, added_by_id TEXT, added_by_name TEXT);
      CREATE INDEX IF NOT EXISTS proof_records_by_document ON proof_records(document_id, produced_at);
      CREATE INDEX IF NOT EXISTS proof_records_by_release ON proof_records(release_id, produced_at);
      CREATE INDEX IF NOT EXISTS proof_records_by_customer ON proof_records(customer_ref, produced_at);
      CREATE INDEX IF NOT EXISTS proof_records_by_date ON proof_records(produced_at);
      CREATE INDEX IF NOT EXISTS proof_records_by_run ON proof_records(run_id);
      CREATE TABLE IF NOT EXISTS proof_reset_gate(open INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS proof_records_are_frozen BEFORE UPDATE ON proof_records BEGIN SELECT RAISE(ABORT, 'A proof record is never changed: it is only ever added.'); END;
      CREATE TRIGGER IF NOT EXISTS proof_records_are_kept BEFORE DELETE ON proof_records WHEN (SELECT COUNT(*) FROM proof_reset_gate) = 0 BEGIN SELECT RAISE(ABORT, 'A proof record is never deleted.'); END;
    `);
  }

  /**
   * Adds a record checked with `proofRecordProblems` (and the stricter `proofProblems`). A record whose proof id is
   * already stored adds nothing: the answer says whether the stored one is the same.
   */
  add(record: ProofRecord, meta: { source: 'studio' | 'file'; by: Who }): 'added' | 'known' | 'conflict' {
    const problems = proofProblems(record);
    if (problems.length) throw new Error(`Not a usable proof record: ${problems.join(' ')}`);
    const existing = this.get(record.proofId);
    if (existing) return sameRecord(existing.proof, record) ? 'known' : 'conflict';
    this.store.db.prepare('INSERT OR IGNORE INTO proof_records(proof_id,document_id,release_id,release_number,release_digest,customer_ref,run_id,produced_at,producer,produced,json,source,added_at,added_by_id,added_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(record.proofId, record.documentId, record.releaseId, record.releaseNumber, record.releaseDigest, record.customerRef, record.runId, isoOf(record.producedAt), record.producer, record.produced ? 1 : 0, JSON.stringify(record), meta.source, new Date().toISOString(), meta.by?.id ?? null, meta.by?.name ?? null);
    return 'added';
  }

  has(proofId: string): boolean { return !!this.store.db.prepare('SELECT 1 FROM proof_records WHERE proof_id=?').get(proofId); }

  get(proofId: string): { proof: ProofRecord; meta: StoredProofMeta } | undefined {
    const r = this.store.db.prepare('SELECT * FROM proof_records WHERE proof_id=?').get(proofId) as any;
    return r ? this.map(r) : undefined;
  }

  /** Newest first (by when it was produced). `q` matches part of a proof id or a run id. */
  search(f: ProofSearch): { items: Array<{ proof: ProofRecord; meta: StoredProofMeta }>; total: number } {
    const where: string[] = [], args: Array<string | number> = [];
    if (f.documentId) { where.push('document_id=?'); args.push(f.documentId); }
    if (f.releaseId) { where.push('release_id=?'); args.push(f.releaseId); }
    if (f.customerRef) { where.push('customer_ref=?'); args.push(f.customerRef); }
    if (f.from) { where.push('produced_at>=?'); args.push(f.from); }
    if (f.to) { where.push('produced_at<=?'); args.push(f.to); }
    if (f.q) { const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; where.push("(proof_id LIKE ? ESCAPE '\\' OR run_id LIKE ? ESCAPE '\\')"); args.push(like, like); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((this.store.db.prepare(`SELECT COUNT(*) AS n FROM proof_records ${clause}`).get(...args) as any).n);
    const limit = Math.min(Math.max(f.limit ?? 25, 1), PROOF_LIMITS.pageMax);
    const offset = Math.max(f.offset ?? 0, 0);
    const rows = this.store.db.prepare(`SELECT * FROM proof_records ${clause} ORDER BY produced_at DESC, added_at DESC, proof_id LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
    return { items: rows.map((r) => this.map(r)), total };
  }

  /** Test and demo reset only (its route is off unless PROOFS_RESET=allow or RELEASES_RESET=allow). */
  clear(): number {
    return this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO proof_reset_gate(open) VALUES (1)').run();
      const n = Number(this.store.db.prepare('DELETE FROM proof_records').run().changes);
      this.store.db.prepare('DELETE FROM proof_reset_gate').run();
      return n;
    });
  }

  private map(r: any): { proof: ProofRecord; meta: StoredProofMeta } {
    return { proof: JSON.parse(r.json) as ProofRecord, meta: { source: r.source, addedAt: r.added_at, addedBy: r.added_by_name ? { id: r.added_by_id ?? '', name: r.added_by_name } : null } };
  }
}

/** Times are compared as text, so every stored time is the same ISO form. */
const isoOf = (s: string): string => new Date(Date.parse(s)).toISOString();
const sameRecord = (a: ProofRecord, b: ProofRecord) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ checking records read from anywhere */

const DECISION_KEYS = new Set(['nodeId', 'variantId', 'ruleIds']);
const OUTPUT_KEYS = new Set(['channel', 'kind', 'sha256', 'size', 'pages']);

/**
 * `proofRecordProblems`, plus what it leaves open: no extra field inside a decision or an output fingerprint, no
 * overlong text, sizes and page counts that are whole numbers. A record that passes holds nothing beyond the contract.
 */
export function proofProblems(raw: unknown): string[] {
  const p = proofRecordProblems(raw);
  if (p.length) return p;
  const r = raw as ProofRecord;
  for (const d of r.decisions) {
    const extra = Object.keys(d).filter((k) => !DECISION_KEYS.has(k));
    if (extra.length) { p.push(`A decision carries unexpected fields: ${extra.slice(0, 5).join(', ')}.`); break; }
    if (d.nodeId.length > 200 || (d.variantId?.length ?? 0) > 200 || d.ruleIds.length > 200 || d.ruleIds.some((x) => x.length > 200)) { p.push('A decision is too long.'); break; }
  }
  for (const o of r.outputs) {
    const extra = Object.keys(o).filter((k) => !OUTPUT_KEYS.has(k));
    if (extra.length) { p.push(`An output fingerprint carries unexpected fields: ${extra.slice(0, 5).join(', ')}.`); break; }
    if ((o.size !== undefined && (!Number.isInteger(o.size) || o.size < 0)) || (o.pages !== undefined && (!Number.isInteger(o.pages) || o.pages < 0))) { p.push('An output fingerprint has a size or page count that is not a whole number.'); break; }
  }
  if (new Set(r.outputs.map((o) => o.channel)).size !== r.outputs.length) p.push('“outputs” lists the same output twice.');
  if (r.blockedBy.length > 200 || r.blockedBy.some((c) => c.length > 200)) p.push('“blockedBy” is too long.');
  if (!r.produced && r.outputs.length) p.push('A record of a document that was not produced cannot list outputs.');
  if (r.produced && r.blockedBy.length) p.push('A produced document cannot be stopped by blocking issues.');
  return p;
}

export interface FileLineVerdict { line: number; proofId: string | null; outcome: 'new' | 'known' | 'conflict' | 'refused'; problems: string[]; releaseKnown?: boolean }
export interface FileReading { lines: FileLineVerdict[]; records: Map<number, ProofRecord>; tooBig: string | null }

/**
 * Reads the text of a `proof.jsonl` file. Untrusted: every line is parsed as JSON and checked; nothing is run or
 * trusted beyond the record's own fields. Blank lines are skipped. Nothing is stored here.
 */
export function readProofFile(text: string, known: (proofId: string) => ProofRecord | undefined): FileReading {
  const out: FileReading = { lines: [], records: new Map(), tooBig: null };
  if (Buffer.byteLength(text, 'utf8') > PROOF_LIMITS.fileBytes) { out.tooBig = `The file is larger than ${PROOF_LIMITS.fileBytes / 1024 / 1024} MB. Split it and add the parts one by one.`; return out; }
  const lines = text.split(/\r?\n/);
  if (lines.filter((l) => l.trim()).length > PROOF_LIMITS.fileLines) { out.tooBig = `The file has more than ${PROOF_LIMITS.fileLines.toLocaleString('en-US')} records. Split it and add the parts one by one.`; return out; }
  const seen = new Map<string, ProofRecord>();
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    if (Buffer.byteLength(raw, 'utf8') > PROOF_LIMITS.lineBytes) { out.lines.push({ line, proofId: null, outcome: 'refused', problems: [`The line is longer than ${PROOF_LIMITS.lineBytes / 1024} KB.`] }); return; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { out.lines.push({ line, proofId: null, outcome: 'refused', problems: ['The line is not JSON.'] }); return; }
    const problems = proofProblems(value);
    const proofId = value && typeof value === 'object' && typeof (value as any).proofId === 'string' ? String((value as any).proofId).slice(0, 80) : null;
    if (problems.length) { out.lines.push({ line, proofId, outcome: 'refused', problems }); return; }
    const record = value as ProofRecord;
    const already = known(record.proofId) ?? seen.get(record.proofId);
    if (already) { out.lines.push({ line, proofId, outcome: sameRecord(already, record) ? 'known' : 'conflict', problems: sameRecord(already, record) ? [] : ['A record with this proof id is already known and says something else. The record already kept is not changed.'] }); return; }
    seen.set(record.proofId, record);
    out.records.set(line, record);
    out.lines.push({ line, proofId, outcome: 'new', problems: [] });
  });
  return out;
}

/* ------------------------------------------------------------------ the release a record names */

export type ReleaseStatus = 'known' | 'unknown' | 'different';
/** Whether this studio has the release a record names, with the same content. */
export function releaseStatusOf(store: Store, p: Pick<ProofRecord, 'releaseId' | 'releaseDigest'>): { status: ReleaseStatus; release: StoredRelease | null; message: string | null } {
  const r = store.release(p.releaseId);
  if (!r) return { status: 'unknown', release: null, message: 'Release not known here: this studio has no release with that id. The record is kept as it was received.' };
  if (r.contentDigest !== p.releaseDigest) return { status: 'different', release: r, message: `Release not known here: this studio's release ${r.number} has different content from the one the record names. The record is kept as it was received.` };
  return { status: 'known', release: r, message: null };
}

/** Only a release that is current at Test or Production may be produced from. Null when it may. */
export function produceProblem(r: StoredRelease): string | null {
  if (r.documentRemovedAt) return `The document of release ${r.number} was deleted, so nothing is produced from it.`;
  if (r.stages.production?.status === 'current' || r.stages.test.status === 'current') return null;
  const withdrawn = r.stages.production?.status === 'withdrawn' || r.stages.test.status === 'withdrawn';
  return withdrawn
    ? `Release ${r.number} was withdrawn, so documents are no longer produced from it. Produce from the release that is current in Test or Production.`
    : `Release ${r.number} has been replaced by a later release, so documents are no longer produced from it. Produce from the release that is current in Test or Production.`;
}

/* ------------------------------------------------------------------ producing (the same as the runnable package) */

export interface Produced {
  res: Resolution;
  outputs: ProofOutput[];
  /** The produced files, in memory only. Never stored by this feature. */
  files: { html?: string; email?: { subject: string; preheader: string; html: string; text: string }; sms?: string };
}

/**
 * Produces the asked-for outputs of one customer from the release's template, exactly as the runnable package does:
 * HTML, email and SMS fingerprinted by the SHA-256 of their exact file (email: `email.html`); the PDF by the SHA-256
 * of the page source it is composed from, with the page count the composition gives. A stopped customer gets nothing.
 */
export async function produceOne(template: Project, record: SyntheticRecord, channels: readonly ProofChannel[], composer: PackageComposer, issueDate?: string | null): Promise<Produced> {
  // The document's date given for the run (documents that use dates); it is part of the run ID and kept in the proof record.
  const res = resolve({ project: template, record, profileId: PROFILE, ...(issueDate ? { issueDate } : {}) });
  const out: Produced = { res, outputs: [], files: {} };
  if (res.findings.some((f) => f.severity === 'blocking')) return out;
  if (channels.includes('html')) {
    const html = renderInteractiveHtml(res, template);
    out.files.html = html;
    out.outputs.push({ channel: 'html', kind: 'bytes', sha256: sha256(html), size: Buffer.byteLength(html, 'utf8') });
  }
  if (channels.includes('email')) {
    const e = renderEmail(res, template);
    out.files.email = { subject: e.subject, preheader: e.preheader, html: e.html, text: e.text };
    out.outputs.push({ channel: 'email', kind: 'bytes', sha256: sha256(e.html), size: Buffer.byteLength(e.html, 'utf8') });
  }
  if (channels.includes('sms')) {
    const s = renderSms(res, template);
    out.files.sms = s.text;
    out.outputs.push({ channel: 'sms', kind: 'bytes', sha256: sha256(s.text), size: Buffer.byteLength(s.text, 'utf8') });
  }
  if (channels.includes('pdf')) {
    const paged = renderPagedDocument(res, template, { profileId: PROFILE, watermark: '' });
    const composed = await composer.pdf(paged);
    out.outputs.push({ channel: 'pdf', kind: 'content', sha256: sha256(paged), pages: composed.pageCount });
  }
  out.outputs.sort((a, b) => PROOF_CHANNELS.indexOf(a.channel) - PROOF_CHANNELS.indexOf(b.channel));
  return out;
}

export function proofFor(release: StoredRelease, produced: Produced, record: SyntheticRecord, producedAt: string): ProofRecord {
  return buildProofRecord({ release: { id: release.id, documentId: release.documentId, number: release.number, contentDigest: release.contentDigest }, resolution: produced.res, record, producer: 'studio', producedAt, customerRef: record.recordId, outputs: produced.outputs });
}

/** Checks data supplied for a check against the release's data fields. Problems in plain words (they may quote the supplied values back to the person who supplied them; they are never stored). */
export function suppliedProblems(template: Project, raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['The data must be one customer, as a JSON object.'];
  const r = raw as Record<string, unknown>;
  if (typeof r.recordId !== 'string' || !r.recordId.trim() || r.recordId.length > 200) return ['The data has no “recordId”: the producing system’s reference for the customer, exactly as it was when the document was produced.'];
  if (r.documentType !== template.documentType) return [`The data is not for this kind of document (expected “documentType”: “${template.documentType}”).`];
  return validateRecordShape(raw, template.documentType, customFieldDefs(template.customFields)).slice(0, 10);
}

/* ------------------------------------------------------------------ in plain words, named from the frozen release */

const ISSUE_WORDS: Record<string, string> = {
  EXCLUSIVE_PRIORITY_TIE: 'two rules tied for the same part',
  NO_VARIANT_MATCH: 'no rule chose a message for a part that has no fallback',
  REQUIRED_TRANSLATION_MISSING: 'a required translation was missing',
  MISSING_CONTENT_PART: 'a part pointed to wording that does not exist',
  UNKNOWN_VARIANT: 'a rule chose a message the part does not have',
  REQUIRED_NODE_MISSING: 'required content was missing from the document',
  INVALID_BINDING: 'a part used a data field that does not exist',
  NULL_BINDING: 'a part had no value but must have one',
  CALCULATION_MISSING: 'a calculated value the document needs could not be worked out',
  LOOKUP_NO_MATCH: 'a lookup table had no row for the customer',
  DOCUMENT_DATE_MISSING: 'the document had no date',
  ISSUE_DATE_INVALID: 'the date given for the run was not a date',
  UNSAFE_URL: 'a link was not a safe web address',
  UNCONFIRMED_DEBT_LANGUAGE: 'an unconfirmed amount was worded as owed',
};
/** A blocking issue code in plain words. */
export const issueWords = (code: string): string => ISSUE_WORDS[code] ?? (/RECONCILIATION|MISMATCH|INCONSISTENT|LIABILITY/.test(code) ? 'the customer’s data did not add up' : code.toLowerCase().replace(/_/g, ' '));

export interface NamedRule { id: string; title: string }
export interface NamedDecision { nodeId: string; part: string; variantId: string | null; message: string | null; rules: NamedRule[]; known: boolean }

/** A variant's title from the template (it is a content part), or null when the release has no such message. */
const variantTitle = (t: Project, id: string): string | null => t.contentParts.find((c) => c.id === id)?.title?.trim() || null;
const ruleTitleOf = (t: Project, id: string): string | null => { const r = t.rules.find((x) => x.id === id); return r ? ruleWords(t, r) : null; };

/**
 * Why, for each part: the message shown and the rules that chose it, named from the frozen release. Ids and names
 * only: a proof record holds no customer values, so none can be shown. Without the release, the ids are all there is.
 */
export function namedDecisions(record: ProofRecord, template: Project | null): NamedDecision[] {
  return record.decisions.map((d) => {
    const part = template ? nodeWords(template, d.nodeId) : d.nodeId;
    const message = d.variantId ? (template ? variantTitle(template, d.variantId) ?? d.variantId : d.variantId) : null;
    const rules = d.ruleIds.map((id) => ({ id, title: (template && ruleTitleOf(template, id)) || id }));
    const known = !!template && (template.nodes.some((n) => n.id === d.nodeId) || template.contentParts.some((c) => c.id === d.nodeId));
    return { nodeId: d.nodeId, part, variantId: d.variantId, message, rules, known };
  });
}

/** verifyProof's differences, with parts, messages and rules named from the release (codes stay on each difference). */
export function plainDifferences(diffs: ProofDifference[], proof: ProofRecord, template: Project, again: Resolution): Array<ProofDifference & { plain: string }> {
  const now = new Map(Object.entries(again.result.selectedVariants));
  const then = new Map(proof.decisions.map((d) => [d.nodeId, d]));
  const msg = (id: string | null | undefined) => (id ? `“${variantTitle(template, id) ?? id}”` : 'nothing');
  return diffs.map((d) => {
    let plain = d.message;
    if (d.kind === 'decision' && d.nodeId) {
      const part = `“${nodeWords(template, d.nodeId)}”`;
      const was = then.get(d.nodeId);
      const is = now.has(d.nodeId) ? now.get(d.nodeId) ?? null : undefined;
      if (!was) plain = `${part} is decided now (it shows ${msg(is ?? null)}) and was not part of the document then.`;
      else if (is === undefined && !again.trace.some((t) => t.targetNodeId === d.nodeId)) plain = `${part} showed ${msg(was.variantId)} then and is not part of the document now.`;
      else if ((is ?? null) !== was.variantId) plain = `${part} showed ${msg(was.variantId)} then and shows ${msg(is ?? null)} now.`;
      else plain = `${part} shows the same message, chosen by different rules.`;
    } else if (d.kind === 'output' && d.channel) plain = `The ${CHANNEL_LABEL[d.channel]} differs from what was produced.`;
    else if (d.kind === 'release') plain = `This is not the release the document was produced from (release ${proof.releaseNumber}).`;
    else if (d.kind === 'engine') plain = `The engine differs: produced with ${proof.engineVersion}, checked with ${again.engineVersion}.`;
    else if (d.kind === 'date') plain = d.message;
    return { ...d, plain };
  });
}

/** The explanation WITH values, for a check where the data is at hand. Returned to the caller only; never stored. */
export function explanationWithValues(template: Project, res: Resolution, record: ProofRecord): Array<{ nodeId: string; part: string; headline: string; steps: string[] }> {
  return record.decisions.map((d) => {
    try {
      const e = explainInPlainWords(template, res, d.nodeId);
      return { nodeId: d.nodeId, part: nodeWords(template, d.nodeId), headline: e.headline, steps: e.steps };
    } catch {
      return { nodeId: d.nodeId, part: nodeWords(template, d.nodeId), headline: 'This part could not be explained.', steps: [] };
    }
  });
}

/** Which outputs a request asks for, in the contract's order. Throws a plain message for anything else. */
export function channelsOf(v: unknown): ProofChannel[] {
  if (v === undefined || v === null) return [...DEFAULT_CHANNELS].sort((a, b) => PROOF_CHANNELS.indexOf(a) - PROOF_CHANNELS.indexOf(b));
  if (!Array.isArray(v) || !v.length || v.some((c) => !PROOF_CHANNELS.includes(c as ProofChannel))) throw new Error(`Outputs must be a list of ${PROOF_CHANNELS.join(', ')}.`);
  return [...new Set(v as ProofChannel[])].sort((a, b) => PROOF_CHANNELS.indexOf(a) - PROOF_CHANNELS.indexOf(b));
}
