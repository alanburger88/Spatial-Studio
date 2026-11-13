import { dayWords, digestOf, isIsoDay, shortDigest, type SyntheticRecord } from '@iss/model';
import type { Resolution } from './types';

/**
 * Proof records: what a customer was given, from which release, and why — WITHOUT the customer's data.
 *
 * Decided by the product owner on 2026-11-13: a proof record keeps fingerprints and decisions only.
 * It holds no customer values. To re-create a document the data is supplied again; `verifyProof` then
 * confirms it is the same data, the same release and the same result.
 *
 * Written by whatever produces a document from a release: the studio, or the runnable package inside
 * another system. Pure: no clock, no network, no randomness (the producer passes the time in).
 */
export const PROOF_SCHEMA = 'proof-record/1' as const;

export type ProofChannel = 'pdf' | 'html' | 'email' | 'sms';
export const PROOF_CHANNELS: readonly ProofChannel[] = ['pdf', 'html', 'email', 'sms'];

/** One part of the document: which alternative was shown, and the rules that decided it (ids only, never the values tested). */
export interface ProofDecision {
  nodeId: string;
  variantId: string | null;
  /** Rules that selected, applied to or required this part, in the engine's order. */
  ruleIds: string[];
}

/**
 * A fingerprint of one output.
 * `bytes`: SHA-256 of the exact file (email, SMS and HTML are byte-identical for the same input).
 * `content`: SHA-256 of what the output says (PDF files differ byte for byte between runs, so the PDF is
 * fingerprinted by the content it was composed from plus its page count).
 */
export interface ProofOutput {
  channel: ProofChannel;
  kind: 'bytes' | 'content';
  sha256: string;
  size?: number;
  pages?: number;
}

export interface ProofRecord {
  schema: typeof PROOF_SCHEMA;
  /** Stable for the same release, customer reference, data and time. */
  proofId: string;
  releaseId: string;
  documentId: string;
  releaseNumber: number;
  /** The release's own content fingerprint (`ReleaseInfo.contentDigest`). */
  releaseDigest: string;
  engineVersion: string;
  producer: 'studio' | 'runtime';
  /** ISO time, supplied by the producer. */
  producedAt: string;
  /** The reference the producing system uses for the customer (an identifier to search by, not customer values). */
  customerRef: string;
  /** SHA-256 of the customer's data in canonical form. The data itself is not kept. */
  dataFingerprint: string;
  runId: string;
  /**
   * The document's date when it was GIVEN for the run (ISO day), for a document that uses dates. Absent when the date
   * came from the customer's data (it is then part of the data fingerprint) and on every record of a document without
   * dates. Re-creating the document uses the same date. An optional addition: records without it stay valid.
   */
  issueDate?: string;
  locale: string;
  profileId: string;
  /** False when a blocking issue stopped the document; then `outputs` is empty and `blockedBy` lists the issue codes. */
  produced: boolean;
  blockedBy: string[];
  decisions: ProofDecision[];
  /** Fingerprint of everything the document says for this customer (`Resolution.contentDigest`). */
  contentDigest: string;
  outputs: ProofOutput[];
}

/** The fingerprint of a customer's data: canonical JSON of the record, hashed. */
export const dataFingerprintOf = (record: SyntheticRecord): string => digestOf(record);

const DECIDING: ReadonlySet<string> = new Set(['selected', 'applied', 'required']);

/** Which alternative each part shows and the rules that decided it. No field values. */
export function proofDecisions(res: Resolution): ProofDecision[] {
  const rulesByNode = new Map<string, string[]>();
  for (const t of res.trace) {
    if (!t.targetNodeId || !DECIDING.has(t.outcome)) continue;
    const list = rulesByNode.get(t.targetNodeId) ?? [];
    if (!list.includes(t.ruleId)) list.push(t.ruleId);
    rulesByNode.set(t.targetNodeId, list);
  }
  const nodeIds = new Set<string>([...Object.keys(res.result.selectedVariants), ...rulesByNode.keys()]);
  return [...nodeIds].sort().map((nodeId) => ({ nodeId, variantId: res.result.selectedVariants[nodeId] ?? null, ruleIds: rulesByNode.get(nodeId) ?? [] }));
}

export interface ProofInput {
  release: { id: string; documentId: string; number: number; contentDigest: string };
  /** The resolution of the FROZEN release for this customer (never a draft). */
  resolution: Resolution;
  /** The data exactly as supplied (before overrides or journey steps). */
  record: SyntheticRecord;
  producer: 'studio' | 'runtime';
  producedAt: string;
  customerRef?: string;
  outputs: ProofOutput[];
}

export function buildProofRecord(input: ProofInput): ProofRecord {
  const { release, resolution: res, record } = input;
  const blockedBy = [...new Set(res.findings.filter((f) => f.severity === 'blocking').map((f) => f.code))].sort();
  const produced = blockedBy.length === 0;
  const customerRef = input.customerRef ?? record.recordId;
  const dataFingerprint = dataFingerprintOf(record);
  return {
    schema: PROOF_SCHEMA,
    proofId: 'proof-' + shortDigest({ release: release.id, customerRef, dataFingerprint, runId: res.runId, producedAt: input.producedAt }, 20),
    releaseId: release.id, documentId: release.documentId, releaseNumber: release.number, releaseDigest: release.contentDigest,
    engineVersion: res.engineVersion, producer: input.producer, producedAt: input.producedAt,
    customerRef, dataFingerprint, runId: res.runId, ...(givenDate(res) ? { issueDate: givenDate(res)! } : {}), locale: res.locale, profileId: res.profileId,
    produced, blockedBy,
    decisions: proofDecisions(res),
    contentDigest: res.contentDigest,
    outputs: produced ? [...input.outputs].sort((a, b) => PROOF_CHANNELS.indexOf(a.channel) - PROOF_CHANNELS.indexOf(b.channel)) : [],
  };
}

/** The document's date when it was given for the run (what a proof record keeps as `issueDate`). */
export const givenDate = (res: Pick<Resolution, 'documentDate'>): string | null => (res.documentDate?.given && res.documentDate.date ? res.documentDate.date : null);

export type ProofDifferenceKind = 'release' | 'engine' | 'data' | 'date' | 'decision' | 'content' | 'output' | 'blocked';
export interface ProofDifference { kind: ProofDifferenceKind; message: string; nodeId?: string; channel?: ProofChannel }

/**
 * Re-create and compare. `resolution` and `record` come from running the same release on data supplied again;
 * `outputs` are the fingerprints of freshly produced outputs (omit a channel to skip it).
 * An empty answer means: same data, same release, same decisions, same content, same outputs.
 */
export function verifyProof(proof: ProofRecord, again: { release: { id: string; contentDigest: string }; resolution: Resolution; record: SyntheticRecord; outputs?: ProofOutput[] }): ProofDifference[] {
  const out: ProofDifference[] = [];
  if (again.release.id !== proof.releaseId || again.release.contentDigest !== proof.releaseDigest) out.push({ kind: 'release', message: `This is not the release the document was produced from (${proof.releaseId}).` });
  if (again.resolution.engineVersion !== proof.engineVersion) out.push({ kind: 'engine', message: `The engine version differs: produced with ${proof.engineVersion}, checked with ${again.resolution.engineVersion}.` });
  if (dataFingerprintOf(again.record) !== proof.dataFingerprint) out.push({ kind: 'data', message: 'The data supplied is not the data the document was produced from.' });
  const dateNow = givenDate(again.resolution);
  if ((proof.issueDate ?? null) !== dateNow) out.push({ kind: 'date', message: proof.issueDate ? (dateNow ? `The document was produced as issued on ${dayWords(proof.issueDate)}; it is checked as issued on ${dayWords(dateNow)}.` : `The document was produced as issued on ${dayWords(proof.issueDate)}; it is checked without that date. Give the same date to check it.`) : `The document was produced without a date given for the run; it is checked as issued on ${dayWords(dateNow!)}.` });
  const blockedBy = [...new Set(again.resolution.findings.filter((f) => f.severity === 'blocking').map((f) => f.code))].sort();
  if ((blockedBy.length === 0) !== proof.produced) out.push({ kind: 'blocked', message: proof.produced ? 'The document was produced then, but is stopped by a blocking issue now.' : 'The document was stopped then, but would be produced now.' });
  const now = new Map(proofDecisions(again.resolution).map((d) => [d.nodeId, d]));
  const seen = new Set<string>();
  for (const d of proof.decisions) {
    seen.add(d.nodeId);
    const n = now.get(d.nodeId);
    if (!n) { out.push({ kind: 'decision', nodeId: d.nodeId, message: `“${d.nodeId}” was decided then and is not part of the result now.` }); continue; }
    if (n.variantId !== d.variantId) out.push({ kind: 'decision', nodeId: d.nodeId, message: `“${d.nodeId}” showed “${d.variantId ?? 'nothing'}” then and shows “${n.variantId ?? 'nothing'}” now.` });
    else if (n.ruleIds.join(',') !== d.ruleIds.join(',')) out.push({ kind: 'decision', nodeId: d.nodeId, message: `“${d.nodeId}” shows the same alternative, decided by different rules (${d.ruleIds.join(', ') || 'none'} then, ${n.ruleIds.join(', ') || 'none'} now).` });
  }
  for (const n of now.values()) if (!seen.has(n.nodeId)) out.push({ kind: 'decision', nodeId: n.nodeId, message: `“${n.nodeId}” is decided now and was not part of the result then.` });
  if (again.resolution.contentDigest !== proof.contentDigest) out.push({ kind: 'content', message: 'What the document says differs from what was produced.' });
  for (const o of again.outputs ?? []) {
    const was = proof.outputs.find((p) => p.channel === o.channel);
    if (!was) continue;
    if (was.kind !== o.kind || was.sha256 !== o.sha256 || (was.pages != null && o.pages != null && was.pages !== o.pages)) out.push({ kind: 'output', channel: o.channel, message: `The ${o.channel.toUpperCase()} output differs from what was produced.` });
  }
  return out;
}

/** Shape check for a proof record read from a file. Returns problems in plain words; empty when it can be used. */
export function proofRecordProblems(raw: unknown): string[] {
  const p: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['Not a proof record.'];
  const r = raw as Record<string, unknown>;
  if (r.schema !== PROOF_SCHEMA) return [`Unknown kind of record (expected ${PROOF_SCHEMA}).`];
  const str = (k: string, max = 200) => { if (typeof r[k] !== 'string' || !(r[k] as string).length || (r[k] as string).length > max) p.push(`“${k}” is missing or too long.`); };
  for (const k of ['proofId', 'releaseId', 'documentId', 'releaseDigest', 'engineVersion', 'producedAt', 'customerRef', 'dataFingerprint', 'runId', 'locale', 'profileId', 'contentDigest']) str(k);
  if (r.producer !== 'studio' && r.producer !== 'runtime') p.push('“producer” must be studio or runtime.');
  if (!Number.isInteger(r.releaseNumber) || (r.releaseNumber as number) < 1) p.push('“releaseNumber” must be a whole number from 1.');
  if (typeof r.produced !== 'boolean') p.push('“produced” must be true or false.');
  if (typeof r.producedAt === 'string' && Number.isNaN(Date.parse(r.producedAt))) p.push('“producedAt” is not a date and time.');
  for (const k of ['dataFingerprint', 'releaseDigest', 'contentDigest']) if (typeof r[k] === 'string' && !/^[0-9a-f]{64}$/.test(r[k] as string)) p.push(`“${k}” is not a SHA-256 fingerprint.`);
  if (!Array.isArray(r.blockedBy) || r.blockedBy.some((c) => typeof c !== 'string')) p.push('“blockedBy” must be a list of issue codes.');
  if (r.issueDate !== undefined && !isIsoDay(r.issueDate)) p.push('“issueDate” must be a date written as YYYY-MM-DD.');
  if (!Array.isArray(r.decisions) || r.decisions.length > 2000 || r.decisions.some((d) => !d || typeof d !== 'object' || typeof (d as ProofDecision).nodeId !== 'string' || !((d as ProofDecision).variantId === null || typeof (d as ProofDecision).variantId === 'string') || !Array.isArray((d as ProofDecision).ruleIds) || (d as ProofDecision).ruleIds.some((x) => typeof x !== 'string'))) p.push('“decisions” is not a list of decisions.');
  if (!Array.isArray(r.outputs) || r.outputs.length > 8 || r.outputs.some((o) => !o || typeof o !== 'object' || !PROOF_CHANNELS.includes((o as ProofOutput).channel) || !['bytes', 'content'].includes((o as ProofOutput).kind) || !/^[0-9a-f]{64}$/.test(String((o as ProofOutput).sha256)))) p.push('“outputs” is not a list of output fingerprints.');
  const extraKeys = (list: unknown, keys: string[]): string[] => (Array.isArray(list) ? [...new Set(list.flatMap((x) => (x && typeof x === 'object' ? Object.keys(x).filter((k) => !keys.includes(k)) : [])))] : []);
  const inDecisions = extraKeys(r.decisions, ['nodeId', 'variantId', 'ruleIds']);
  if (inDecisions.length) p.push(`A decision carries unexpected fields: ${inDecisions.slice(0, 5).join(', ')}.`);
  const inOutputs = extraKeys(r.outputs, ['channel', 'kind', 'sha256', 'size', 'pages']);
  if (inOutputs.length) p.push(`An output fingerprint carries unexpected fields: ${inOutputs.slice(0, 5).join(', ')}.`);
  const allowed = new Set(['schema', 'proofId', 'releaseId', 'documentId', 'releaseNumber', 'releaseDigest', 'engineVersion', 'producer', 'producedAt', 'customerRef', 'dataFingerprint', 'runId', 'issueDate', 'locale', 'profileId', 'produced', 'blockedBy', 'decisions', 'contentDigest', 'outputs']);
  const extra = Object.keys(r).filter((k) => !allowed.has(k));
  if (extra.length) p.push(`Unexpected fields: ${extra.slice(0, 5).join(', ')}. A proof record must not carry anything else (it holds no customer data).`);
  return p;
}
