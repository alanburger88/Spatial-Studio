import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseReleaseId, roleCan, type Project, type SyntheticRecord } from '@iss/model';
import { verifyProof, type ProofChannel, type ProofRecord } from '@iss/resolver';
import { audit } from '../auth';
import type { StoredRelease } from '../db';
import {
  CHANNEL_LABEL, PROOF_LIMITS, ProofStore, channelsOf, explanationWithValues, issueWords, namedDecisions, plainDifferences, produceOne, produceProblem,
  proofFor, readProofFile, releaseStatusOf, suppliedProblems, type Produced,
} from '../proofs';
import { releaseTemplate, type PackageComposer } from '../releasePackage';
import type { RouteDeps } from './deps';

/**
 * Proof for any customer (docs/api/PROOFS.md). Producing from a release and adding records from a file need an
 * approver or admin; looking records up and checking one ("re-create and verify") are open to anyone signed in, who
 * can see every document. Nobody can change or delete a record.
 *
 * Data supplied for a check is used for that one answer: it is never stored, never logged, and its audit entry says
 * only that a check happened and what it found.
 */
export function registerProofRoutes(app: FastifyInstance, deps: RouteDeps, opts: { composer: PackageComposer }): void {
  const { store, ApiError } = deps;
  const proofs = new ProofStore(store);
  const by = (req: FastifyRequest) => (req.user ? { id: req.user.id, name: req.user.name } : null);
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  const mayAdd = (req: FastifyRequest, what: string) => {
    if (!req.user || !roleCan(req.user.role, 'approve')) throw new ApiError(403, 'FORBIDDEN', `Only approvers and admins can ${what}.`, { role: req.user?.role ?? null, needs: 'approve' });
  };
  const releaseOr404 = (id: string): StoredRelease => {
    const r = parseReleaseId(id) ? store.release(id) : undefined;
    if (!r) throw new ApiError(404, 'NOT_FOUND', `This studio has no release ${id}.`);
    return r;
  };
  const templateOf = (r: StoredRelease): Project => {
    const frozen = store.releaseProject(r.id);
    if (!frozen) throw new ApiError(410, 'RELEASE_CONTENT_MISSING', `The stored content of release ${r.number} is missing.`);
    return releaseTemplate(frozen);
  };
  /** The document's test customers: the shared samples and imported customers of its kind, and its own. */
  const testCustomers = (documentId: string, documentType: string): SyntheticRecord[] =>
    deps.allRecords(documentId).filter((x) => x.documentType === documentType && (!x.projectId || x.projectId === documentId));
  const proofOr404 = (id: string) => {
    const found = typeof id === 'string' && id.length <= 200 ? proofs.get(id) : undefined;
    if (!found) throw new ApiError(404, 'NOT_FOUND', `There is no proof record ${String(id).slice(0, 80)}.`);
    return found;
  };
  const releaseSummary = (r: StoredRelease | null) => (r ? { id: r.id, number: r.number, title: r.title, documentId: r.documentId, standing: r.stages.production?.status === 'current' ? 'production' : r.stages.test.status === 'current' ? 'test' : (r.stages.production?.status === 'withdrawn' || r.stages.test.status === 'withdrawn') ? 'withdrawn' : 'superseded', documentRemoved: !!r.documentRemovedAt } : null);
  const listItem = (x: { proof: ProofRecord; meta: unknown }) => { const st = releaseStatusOf(store, x.proof); return { proof: x.proof, meta: x.meta, release: { status: st.status, message: st.message, info: releaseSummary(st.release) } }; };

  /* ------------------------------------------------------------ produce from a release (the studio as producer) */

  let producing = false;
  app.post<{ Params: { releaseId: string }; Body: Record<string, any> }>('/api/v1/releases/:releaseId/produce', async (req, reply) => {
    mayAdd(req, 'produce documents from a release');
    const r = releaseOr404(req.params.releaseId);
    const problem = produceProblem(r);
    if (problem) throw new ApiError(409, 'RELEASE_NOT_CURRENT', problem, { standing: releaseSummary(r)?.standing });
    let channels: ProofChannel[];
    try { channels = channelsOf(req.body?.outputs); } catch (e: any) { throw new ApiError(400, 'INVALID_OUTPUTS', e.message); }
    const all = req.body?.all === true;
    const recordId = typeof req.body?.recordId === 'string' ? req.body.recordId : null;
    if (all === !!recordId) throw new ApiError(400, 'CUSTOMERS_REQUIRED', 'Say which test customer to produce for (recordId), or ask for all of them (all: true).');
    const customers = testCustomers(r.documentId, r.documentType);
    const chosen = all ? customers : customers.filter((c) => c.recordId === recordId);
    if (!chosen.length) throw new ApiError(404, all ? 'NO_CUSTOMERS' : 'NOT_FOUND', all ? 'This document has no test customers to produce for.' : `This document has no test customer ${String(recordId).slice(0, 80)}.`);
    const cap = channels.includes('pdf') ? PROOF_LIMITS.customersWithPdf : PROOF_LIMITS.customers;
    if (chosen.length > cap) throw new ApiError(413, 'TOO_MANY_CUSTOMERS', channels.includes('pdf') ? `With the PDF, at most ${cap} customers can be produced at a time (each PDF is composed in a browser). This document has ${chosen.length}: leave the PDF out or produce for one customer at a time.` : `At most ${cap} customers can be produced at a time; this document has ${chosen.length}.`, { limit: cap });
    if (producing) throw new ApiError(409, 'PRODUCE_RUNNING', 'Documents are already being produced from a release. Wait for that to finish and try again.');
    producing = true;
    try {
      const template = templateOf(r);
      const producedAt = new Date().toISOString();
      const made: ProofRecord[] = [];
      for (const record of chosen) {
        let produced: Produced;
        try { produced = await produceOne(template, record, channels, opts.composer); }
        catch { throw new ApiError(502, 'PRODUCE_FAILED', `Producing for test customer ${record.recordId} failed, so nothing was recorded. Try again; if it keeps failing, leave the PDF out.`); }
        made.push(proofFor(r, produced, record, producedAt));
        await tick();
      }
      const outcomes = store.transaction(() => made.map((p) => proofs.add(p, { source: 'studio', by: by(req) })));
      const stopped = made.filter((p) => !p.produced).length;
      audit(store, req, 'proof.produce', { projectId: r.documentId, modelVersion: r.modelVersion, detail: { releaseId: r.id, number: r.number, title: r.title, customers: made.length, produced: made.length - stopped, stopped, outputs: channels, ...(all ? { all: true } : { customerRef: made[0].customerRef }) } });
      reply.status(201);
      return {
        release: releaseSummary(r), producedAt, outputs: channels,
        counts: { customers: made.length, produced: made.length - stopped, stopped, added: outcomes.filter((o) => o === 'added').length },
        results: made.map((p) => ({ proofId: p.proofId, customerRef: p.customerRef, produced: p.produced, blockedBy: p.blockedBy, blockedWords: p.blockedBy.map(issueWords), outputs: p.outputs })),
        filesKept: false,
        message: `${made.length - stopped} of ${made.length} produced from release ${r.number}${stopped ? `; ${stopped} stopped by a blocking issue (recorded as not produced)` : ''}. The produced files are not kept: each proof record keeps their fingerprints.`,
      };
    } finally { producing = false; }
  });

  /* ------------------------------------------------------------ add proof records from a file */

  app.post<{ Body: Record<string, any> }>('/api/v1/proofs/import', async (req) => {
    mayAdd(req, 'add proof records');
    const text = req.body?.text;
    if (typeof text !== 'string') throw new ApiError(400, 'TEXT_REQUIRED', 'Send the text of a proof.jsonl file as “text”.');
    const dryRun = req.body?.dryRun !== false;
    const reading = readProofFile(text, (id) => proofs.get(id)?.proof);
    if (reading.tooBig) throw new ApiError(413, 'FILE_TOO_LARGE', reading.tooBig, { limits: { bytes: PROOF_LIMITS.fileBytes, lines: PROOF_LIMITS.fileLines } });
    const lines = reading.lines.map((l) => (l.outcome === 'new' ? { ...l, releaseKnown: releaseStatusOf(store, reading.records.get(l.line)!).status === 'known' } : l));
    const count = (o: string) => lines.filter((l) => l.outcome === o).length;
    const fresh = [...reading.records.values()];
    const summary = {
      dryRun, lines: lines.length,
      new: count('new'), known: count('known'), conflict: count('conflict'), refused: count('refused'),
      unknownRelease: lines.filter((l) => l.outcome === 'new' && !l.releaseKnown).length,
      producers: { studio: fresh.filter((p) => p.producer === 'studio').length, runtime: fresh.filter((p) => p.producer === 'runtime').length },
    };
    // Why each line was refused, or what happens to it. Proof ids and problems only: nothing else from the file is repeated back.
    const shown = lines.slice(0, 500);
    if (dryRun) { req.audited = true; return { ...summary, added: 0, details: shown, detailsCut: lines.length > shown.length }; }
    const added = store.transaction(() => fresh.map((p) => proofs.add(p, { source: 'file', by: by(req) })).filter((o) => o === 'added').length);
    audit(store, req, 'proof.import', { detail: { added, known: summary.known, conflict: summary.conflict, refused: summary.refused, unknownRelease: summary.unknownRelease, runtime: summary.producers.runtime, studio: summary.producers.studio, documents: [...new Set(fresh.map((p) => p.documentId))].slice(0, 10) } });
    return { ...summary, added, details: shown, detailsCut: lines.length > shown.length };
  });

  /* ------------------------------------------------------------ look up */

  const dateOf = (v: unknown, end: boolean): string | undefined => {
    if (v === undefined || v === '') return undefined;
    const s = String(v);
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : s;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new ApiError(400, 'INVALID_DATE', `“${s.slice(0, 40)}” is not a date (use YYYY-MM-DD).`);
    return new Date(t).toISOString();
  };
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/v1/proofs', async (req) => {
    const q = req.query;
    const str = (v: string | undefined, max = 200) => (v && v.trim() ? v.trim().slice(0, max) : undefined);
    const limit = q.limit ? Number(q.limit) : 25;
    const offset = q.offset ? Number(q.offset) : 0;
    if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || offset < 0) throw new ApiError(400, 'INVALID_PAGE', 'limit and offset must be whole numbers.');
    const found = proofs.search({ documentId: str(q.documentId), releaseId: str(q.releaseId), customerRef: str(q.customerRef), from: dateOf(q.from, false), to: dateOf(q.to, true), q: str(q.q, 100), limit, offset });
    return { records: found.items.map(listItem), total: found.total, limit: Math.min(limit, PROOF_LIMITS.pageMax), offset, limits: PROOF_LIMITS };
  });

  app.get<{ Params: { proofId: string } }>('/api/v1/proofs/:proofId', async (req) => {
    const found = proofOr404(req.params.proofId);
    const item = listItem(found);
    const st = releaseStatusOf(store, found.proof);
    const template = st.status === 'known' ? (() => { try { return templateOf(st.release!); } catch { return null; } })() : null;
    return {
      ...item,
      explanation: {
        /** Named from the frozen release when this studio has it; otherwise ids only. */
        namedFrom: template ? 'release' : 'ids',
        decisions: namedDecisions(found.proof, template),
        blocked: found.proof.blockedBy.map((code) => ({ code, words: issueWords(code) })),
        valuesHeld: false,
      },
      outputs: found.proof.outputs.map((o) => ({ ...o, label: CHANNEL_LABEL[o.channel] })),
    };
  });

  /* ------------------------------------------------------------ re-create and verify */

  app.post<{ Params: { proofId: string }; Body: Record<string, any> }>('/api/v1/proofs/:proofId/verify', async (req) => {
    const { proof } = proofOr404(req.params.proofId);
    const b = req.body ?? {};
    const askedRelease = typeof b.releaseId === 'string' && b.releaseId ? b.releaseId : null;
    const r = askedRelease ? releaseOr404(askedRelease) : releaseStatusOf(store, proof).release;
    if (!r) throw new ApiError(409, 'RELEASE_NOT_KNOWN', 'The release this record names is not known here, so the document cannot be re-created in this studio.');
    const template = templateOf(r);
    const hasId = typeof b.recordId === 'string' && b.recordId !== '';
    const hasData = b.record !== undefined && b.record !== null;
    if (hasId === hasData) throw new ApiError(400, 'DATA_REQUIRED', 'Supply the data again: either a test customer of this document (recordId) or the customer’s data as JSON (record).');
    let record: SyntheticRecord;
    if (hasId) {
      const found = testCustomers(proof.documentId, r.documentType).find((c) => c.recordId === b.recordId);
      if (!found) throw new ApiError(404, 'NOT_FOUND', `This studio has no test customer ${String(b.recordId).slice(0, 80)} for this document. Supply the data as JSON instead.`);
      record = found;
    } else {
      if (Buffer.byteLength(JSON.stringify(b.record), 'utf8') > PROOF_LIMITS.suppliedBytes) throw new ApiError(413, 'DATA_TOO_LARGE', `The data supplied is larger than ${PROOF_LIMITS.suppliedBytes / 1024 / 1024} MB.`);
      const problems = suppliedProblems(template, b.record);
      if (problems.length) throw new ApiError(422, 'INVALID_DATA', 'The data supplied cannot be read as a customer of this document. Nothing was stored.', { problems });
      record = b.record as SyntheticRecord;
    }
    const channels = proof.outputs.map((o) => o.channel);
    let again: Produced;
    // Fixed words only: an error raised while reading the data could quote it, and this answer is the only place the data goes.
    try { again = await produceOne(template, record, channels, opts.composer); }
    catch { throw new ApiError(422, 'CANNOT_RECREATE', 'The document could not be re-created from the data supplied. Nothing was stored.'); }
    const diffs = verifyProof(proof, { release: { id: r.id, contentDigest: r.contentDigest }, resolution: again.res, record, outputs: again.outputs });
    const same = diffs.length === 0;
    audit(store, req, 'proof.verify', { projectId: proof.documentId, detail: { proofId: proof.proofId, releaseId: r.id, number: r.number, dataFrom: hasId ? 'test-customer' : 'supplied', same, differences: [...new Set(diffs.map((d) => d.kind))] } });
    return {
      proofId: proof.proofId, same,
      verdict: same ? 'Same data, same release, same result.' : 'Not the same.',
      differences: plainDifferences(diffs, proof, template, again.res),
      checked: { release: releaseSummary(r), dataFrom: hasId ? 'test-customer' : 'supplied', outputs: channels, stored: false },
      // The data is at hand for this check only: the explanation with values and the re-created outputs are in this answer and nowhere else.
      ...(same ? {
        explanation: explanationWithValues(template, again.res, proof),
        recreated: { ...again.files, pdf: channels.includes('pdf') ? { pages: again.outputs.find((o) => o.channel === 'pdf')?.pages ?? null, note: 'The PDF is compared by the content it is composed from and its page count; it is not returned here.' } : undefined },
      } : {}),
    };
  });

  /* ------------------------------------------------------------ reset (tests and demos only) */

  app.post<{ Body: Record<string, any> }>('/api/v1/proofs/reset', async (req) => {
    if (process.env.PROOFS_RESET !== 'allow' && process.env.RELEASES_RESET !== 'allow') throw new ApiError(403, 'RESET_DISABLED', 'Proof records are never deleted. (A test or demo server can allow this reset with PROOFS_RESET=allow.)');
    if (req.body?.confirm !== true) throw new ApiError(400, 'CONFIRM_REQUIRED', 'Send { "confirm": true } to remove every proof record.');
    const removed = proofs.clear();
    audit(store, req, 'proof.reset', { detail: { removed } });
    return { removed };
  });
}
