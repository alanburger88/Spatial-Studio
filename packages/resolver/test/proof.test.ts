import { describe, expect, it } from 'vitest';
import { applyCommand, digestOf, sha256Hex, type Project } from '../../model/src';
import { RECORDS, recordById, seedProjects } from '../../model/src/fixtures';
import { buildProofRecord, dataFingerprintOf, proofDecisions, proofRecordProblems, resolve, verifyProof, type ProofOutput } from '../src';

const [card] = seedProjects();
const rec = recordById('CARD-0001')!;
const release = { id: `${card.projectId}-r1`, documentId: card.projectId, number: 1, contentDigest: digestOf(card) };
const outputs: ProofOutput[] = [{ channel: 'sms', kind: 'bytes', sha256: sha256Hex('sms text'), size: 8 }, { channel: 'pdf', kind: 'content', sha256: sha256Hex('pdf content'), pages: 2 }];
const at = '2026-11-13T10:00:00.000Z';
const proofFor = (project: Project, record = rec) => buildProofRecord({ release, resolution: resolve({ project, record }), record, producer: 'studio', producedAt: at, outputs });

describe('proof records', () => {
  it('keeps decisions and fingerprints, and none of the customer’s values', () => {
    const res = resolve({ project: card, record: rec });
    const proof = proofFor(card);
    expect(proof.schema).toBe('proof-record/1');
    expect(proof.customerRef).toBe('CARD-0001');
    expect(proof.dataFingerprint).toBe(dataFingerprintOf(rec));
    expect(proof.runId).toBe(res.runId);
    expect(proof.contentDigest).toBe(res.contentDigest);
    expect(proof.outputs.map((o) => o.channel)).toEqual(['pdf', 'sms']);
    expect(proof.decisions.length).toBeGreaterThan(0);
    for (const [nodeId, variantId] of Object.entries(res.result.selectedVariants)) expect(proof.decisions.find((d) => d.nodeId === nodeId)?.variantId ?? null).toBe(variantId);
    expect(proof.decisions.some((d) => d.ruleIds.length > 0)).toBe(true);
    expect(proofRecordProblems(proof)).toEqual([]);
    // No value of the customer's data appears anywhere in the record (names, amounts, dates).
    const text = JSON.stringify(proof);
    const leaves: string[] = [];
    const walk = (v: unknown, key = ''): void => {
      if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k); return; }
      if (key === 'recordId' || key === 'locale') return; // the reference and the language are kept on purpose
      // Free text, dates and numbers. A bare choice word such as “standard” can also be part of a message's own name, which is not customer data.
      if (typeof v === 'string' && v.length >= 6 && /[\s\d]/.test(v)) leaves.push(v);
    };
    walk(rec);
    expect(leaves.length).toBeGreaterThan(3);
    for (const leaf of leaves) expect(text.includes(leaf), `customer value “${leaf}” must not be in a proof record`).toBe(false);
  });

  it('is the same record for the same input, and a different proof id for a different time', () => {
    expect(proofFor(card)).toEqual(proofFor(card));
    const later = buildProofRecord({ release, resolution: resolve({ project: card, record: rec }), record: rec, producer: 'studio', producedAt: '2026-11-14T10:00:00.000Z', outputs });
    expect(later.proofId).not.toBe(proofFor(card).proofId);
  });

  it('verifies against the same release and data, and names what differs otherwise', () => {
    const proof = proofFor(card);
    const same = { release, resolution: resolve({ project: card, record: rec }), record: rec, outputs };
    expect(verifyProof(proof, same)).toEqual([]);

    const changedData = { ...rec, customer: { ...rec.customer, givenName: 'Someone' } };
    expect(verifyProof(proof, { ...same, record: changedData, resolution: resolve({ project: card, record: changedData }) }).map((d) => d.kind)).toContain('data');

    expect(verifyProof(proof, { ...same, release: { id: release.id, contentDigest: sha256Hex('another release') } }).map((d) => d.kind)).toEqual(['release']);
    expect(verifyProof(proof, { ...same, outputs: [{ channel: 'sms', kind: 'bytes', sha256: sha256Hex('other sms') }] })).toEqual([{ kind: 'output', channel: 'sms', message: 'The SMS output differs from what was produced.' }]);

    // Another customer gets different messages: the decisions and the content differ.
    const other = RECORDS.filter((r) => r.documentType === card.documentType).find((r) => JSON.stringify(proofDecisions(resolve({ project: card, record: r }))) !== JSON.stringify(proof.decisions))!;
    const kinds = verifyProof(proof, { ...same, record: other, resolution: resolve({ project: card, record: other }) }).map((d) => d.kind);
    expect(kinds).toContain('data');
    expect(kinds).toContain('decision');
    expect(kinds).toContain('content');
  });

  it('records a stopped document as not produced, with no outputs', () => {
    // Uses a sample customer the engine stops, when the samples include one.
    const blocked = RECORDS.filter((r) => r.documentType === card.documentType).find((r) => resolve({ project: card, record: r }).findings.some((f) => f.severity === 'blocking'));
    if (!blocked) return;
    const proof = proofFor(card, blocked);
    expect(proof.produced).toBe(false);
    expect(proof.outputs).toEqual([]);
    expect(proof.blockedBy.length).toBeGreaterThan(0);
  });

  it('refuses records that are malformed or carry extra fields', () => {
    const proof = proofFor(card);
    expect(proofRecordProblems(null)).toEqual(['Not a proof record.']);
    expect(proofRecordProblems({ ...proof, schema: 'proof-record/9' })[0]).toMatch(/Unknown kind/);
    expect(proofRecordProblems({ ...proof, customer: { displayName: 'A' } }).join(' ')).toMatch(/Unexpected fields: customer/);
    expect(proofRecordProblems({ ...proof, dataFingerprint: 'abc' }).join(' ')).toMatch(/dataFingerprint/);
    expect(proofRecordProblems({ ...proof, outputs: [{ channel: 'fax', kind: 'bytes', sha256: proof.contentDigest }] }).join(' ')).toMatch(/outputs/);
    void applyCommand;
  });
});
