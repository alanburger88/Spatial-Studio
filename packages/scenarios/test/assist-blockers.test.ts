import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type Project, type SyntheticRecord } from '@iss/model';
import { resolve, type Finding } from '@iss/resolver';
import { RECORDS, recordById, seedProjects } from '../../model/src/fixtures';
import { BLOCKER_KIND_ORDER, blockerIdOf, blockerKindOf, documentBlockers } from '../src/assist/blockers';
import { fixImpact } from '../src/assist/fixes';
import type { Blocker } from '../src/assist/types';
import { gymProject } from '../../model/test/helpers/customProject';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const cardRecords = RECORDS.filter((r) => r.documentType === 'credit-statement');
const eobRecords = RECORDS.filter((r) => r.documentType === 'eob');
const blockedBy = (p: Project, records: SyntheticRecord[], code: string): string[] =>
  records.filter((r) => resolve({ project: p, record: r }).findings.some((f) => f.severity === 'blocking' && f.code === code)).map((r) => r.recordId).sort();

/** D01 exactly as the demo injects it: R03 loses its second condition and ties with R04 at priority 400. */
const r3 = card.rules.find((r) => r.id === 'R03')!;
const withTie = run(card, { type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } });
const noFallback = run(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
const noContinuation = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: false } });
/** A customer no rule matches (what “Remove the fallback” followed by “Load customer” shows in the demo), stored as a real customer. */
const nobody: SyntheticRecord = { ...recordById('CARD-0001')!, recordId: 'CARD-9100', card: { ...recordById('CARD-0001')!.card!, paymentStatus: 'overdue', missedPayments: 0 } };
const overflow = (recordId: string): { finding: Finding; recordId: string } => ({
  recordId,
  finding: { code: 'FLOW_OVERFLOW_NO_CONTINUATION', severity: 'blocking', nodeId: 'transaction-table', page: 1, source: 'composer', details: { rowsPlaced: 22, rowsClipped: 228 }, message: 'Repeating table transaction-table overflows the flow region on page 1.' },
});
const ids = (bs: Blocker[]): string[] => bs.map((b) => b.id).sort();

describe('the two sample projects as they are', () => {
  it('HarborCare has no blocker for any of its customers', () => {
    const r = documentBlockers(eob, RECORDS);
    expect(r).toEqual({ checked: 30, issuable: 30, stopped: 0, blockers: [] });
    expect(r.checked).toBe(eobRecords.length);
  });

  it('Aster Card has one Wording blocker per message without a Spanish text, each stopping the same Spanish-speaking customers', () => {
    const r = documentBlockers(card, RECORDS);
    expect(r.checked).toBe(70);
    expect(r.blockers.length).toBe(4);
    expect(r.blockers.every((b) => b.kind === 'wording' && b.code === 'REQUIRED_TRANSLATION_MISSING' && b.speed === 'fast' && b.about.language?.code === 'es-US')).toBe(true);
    const spanish = blockedBy(card, cardRecords, 'REQUIRED_TRANSLATION_MISSING');
    expect(spanish.length).toBeGreaterThan(1);
    for (const b of r.blockers) { expect(b.recordIds).toEqual(spanish); expect(b.customerCount).toBe(spanish.length); }
    expect(r.stopped).toBe(spanish.length);
    expect(r.issuable).toBe(70 - spanish.length);
    for (const b of r.blockers) {
      expect(b.title).toMatch(/^No approved Spanish text for “[^”]+”$/);
      expect(b.title + b.explanation).not.toMatch(/es-US|REQUIRED_TRANSLATION|billing-summary|payment-due|payment-standard/);
      expect(b.about.message?.id).toBe(b.finding.nodeId);
      expect(b.fixes.length).toBeGreaterThan(0);
      expect(b.fixes[0].kind).toBe('link');
      expect(b.link).toMatchObject({ view: 'content', locale: 'es-US', textId: b.about.message!.id });
    }
  });
});

describe('one blocker per root cause', () => {
  const r = documentBlockers(withTie, RECORDS);
  const tie = r.blockers.find((b) => b.kind === 'rules');

  it('a priority tie that stops several customers is ONE Rules blocker naming them all', () => {
    const tied = blockedBy(withTie, cardRecords, 'EXCLUSIVE_PRIORITY_TIE');
    expect(tied.length).toBeGreaterThan(1);
    expect(r.blockers.filter((b) => b.kind === 'rules')).toHaveLength(1);
    expect(tie).toBeDefined();
    expect(tie!.id).toBe('priority-tie~R03+R04');
    expect(tie!.recordIds).toEqual(tied);
    expect(tie!.customerCount).toBe(tied.length);
    expect(tie!.about.rules?.map((x) => x.id)).toEqual(['R03', 'R04']);
    expect(tie!.title).toContain('“Customer asked for payment assistance”');
    expect(tie!.title + tie!.explanation).not.toMatch(/\bR0[34]\b|EXCLUSIVE_PRIORITY_TIE|payment-guidance/);
  });

  it('keeps every fix alternative, best first, each applicable and with its effect on all customers', () => {
    expect(tie!.fixes.length).toBeGreaterThanOrEqual(2);
    expect(tie!.fixes[0].kind).toBe('change');
    expect(tie!.fixes[0].title).toMatch(/^Raise the priority of/);
    const impact = fixImpact(withTie, tie!.fixes[0], RECORDS, { finding: tie!.finding });
    expect(impact.resolves).toBe(true);
    expect(impact.unblocked).toEqual(tie!.recordIds);
    expect(impact.newlyBlocked).toEqual([]);
    expect(tie!.link).toMatchObject({ view: 'rules-data', ruleId: 'R03' });
  });

  it('the Spanish blockers and the tie are listed together; most customers first, then kind order', () => {
    expect(r.blockers.length).toBe(5);
    const counts = r.blockers.map((b) => b.customerCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const sameCount = r.blockers.filter((b) => b.customerCount === r.blockers[0].customerCount);
    const kinds = sameCount.map((b) => BLOCKER_KIND_ORDER.indexOf(b.kind));
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
    // customers stopped by two blockers are counted once
    const union = new Set(r.blockers.flatMap((b) => b.recordIds));
    expect(r.stopped).toBe(union.size);
    expect(r.issuable + r.stopped).toBe(r.checked);
  });

  it('a static equal-priority check of the same two rules is the same blocker and does not add one', () => {
    const staticFinding: Finding = { code: 'EQUAL_PRIORITY_EXCLUSIVE_RULES', severity: 'blocking', nodeId: 'payment-guidance', ruleIds: ['R04', 'R03'], source: 'rules-static', message: 'R03 and R04 share priority 400.' };
    const merged = documentBlockers(withTie, RECORDS, { extraFindings: [{ finding: staticFinding, recordId: null, speed: 'fast' }] });
    expect(merged.blockers.length).toBe(r.blockers.length);
    expect(merged.blockers.find((b) => b.kind === 'rules')!.recordIds).toEqual(tie!.recordIds);
    // without any customer, the same check lists a cause nobody reaches yet
    const alone = documentBlockers(card, RECORDS, { extraFindings: [{ finding: staticFinding, recordId: null, speed: 'fast' }] });
    const lonely = alone.blockers.find((b) => b.kind === 'rules')!;
    expect(lonely).toMatchObject({ id: 'priority-tie~R03+R04', customerCount: 0, recordIds: [], speed: 'fast' });
    expect(alone.blockers.at(-1)).toBe(lonely);
    expect(lonely.explanation).toContain('No sample customer');
  });

  it('a missing fallback is one Rules blocker whose best fix sets the fallback', () => {
    const b = documentBlockers(noFallback, [...RECORDS, nobody]).blockers.find((x) => x.code === 'NO_VARIANT_MATCH');
    expect(b).toBeDefined();
    expect(b!.kind).toBe('rules');
    expect(b!.id).toBe('no-fallback~payment-guidance');
    expect(b!.recordIds).toEqual(['CARD-9100']);
    expect(b!.fixes[0].kind).toBe('change');
    expect(b!.fixes[0].commands).toEqual([{ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: expect.any(String) } }]);
    // the static check of the same set is the same cause
    expect(blockerIdOf({ code: 'VARIANT_SET_WITHOUT_FALLBACK', nodeId: 'payment-guidance', message: '' })).toBe(b!.id);
  });
});

describe('the kind of every blocking code', () => {
  // Every code that can reach the screen with blocking severity: the resolver, the static rule and binding checks, and the page composer.
  const EXPECTED: Record<string, string> = {
    REQUIRED_TRANSLATION_MISSING: 'wording', MISSING_CONTENT_PART: 'wording', UNCONFIRMED_DEBT_LANGUAGE: 'wording', UNSAFE_URL: 'wording',
    EXCLUSIVE_PRIORITY_TIE: 'rules', EQUAL_PRIORITY_EXCLUSIVE_RULES: 'rules', NO_VARIANT_MATCH: 'rules', UNKNOWN_VARIANT: 'rules', REQUIRED_NODE_MISSING: 'rules',
    FLOW_OVERFLOW_NO_CONTINUATION: 'layout', PARITY_MISMATCH: 'layout',
    INVALID_BINDING: 'data-fields',
    RECORD_TYPE_MISMATCH: 'customer-data', INCONSISTENT_PAYMENT_STATE: 'customer-data', BALANCE_RECONCILIATION_FAILED: 'customer-data',
    UNCONFIRMED_MEMBER_LIABILITY: 'customer-data', CLAIM_RECONCILIATION_FAILED: 'customer-data', NULL_BINDING: 'customer-data',
  };
  it('lists every code the code base emits with blocking severity, and gives each the right kind', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(18); // 17 codes written as 'blocking' plus PARITY_MISMATCH, which the server marks blocking per check
    for (const [code, kind] of Object.entries(EXPECTED)) expect(blockerKindOf({ code, source: 'resolver' }), code).toBe(kind);
  });
  it('places a code it does not know by where it came from', () => {
    expect(blockerKindOf({ code: 'SOMETHING_NEW', source: 'composer' })).toBe('layout');
    expect(blockerKindOf({ code: 'SOMETHING_NEW', source: 'binding' })).toBe('data-fields');
    expect(blockerKindOf({ code: 'SOMETHING_NEW', source: 'translation' })).toBe('wording');
    expect(blockerKindOf({ code: 'SOMETHING_NEW', source: 'domain' })).toBe('customer-data');
    expect(blockerKindOf({ code: 'SOMETHING_NEW', source: 'resolver' })).toBe('rules');
  });
});

describe('ids', () => {
  const base = documentBlockers(withTie, RECORDS);
  it('are stable across a no-op change and a fresh copy of the same model', () => {
    const copy = JSON.parse(JSON.stringify(withTie)) as Project;
    expect(documentBlockers(copy, RECORDS).blockers.map((b) => b.id)).toEqual(base.blockers.map((b) => b.id));
    // a change that touches nothing the blockers are about (the title of the document) keeps every id
    const renamed = run(withTie, { type: 'UPDATE_NODE', nodeId: 'billing-summary', patch: { name: 'New balance box' } });
    expect(ids(documentBlockers(renamed, RECORDS).blockers)).toEqual(ids(base.blockers));
  });
  it('do not change for the other blockers when one is fixed, and do not depend on who is stopped', () => {
    const tie = base.blockers.find((b) => b.kind === 'rules')!;
    const fixed = run(withTie, { type: 'BATCH', label: 'fix', commands: tie.fixes[0].commands! });
    const after = documentBlockers(fixed, RECORDS);
    expect(after.blockers.some((b) => b.id === tie.id)).toBe(false);
    expect(ids(after.blockers)).toEqual(ids(base.blockers.filter((b) => b.id !== tie.id)));
    // fewer customers (a smaller list) keeps the id of a cause that still exists
    const fewer = documentBlockers(withTie, cardRecords.slice(0, 20));
    const again = fewer.blockers.find((b) => b.kind === 'rules');
    expect(again?.id).toBe(tie.id);
  });
  it('are URL-safe and name the kind of problem first', () => {
    for (const b of base.blockers) expect(b.id).toMatch(/^[a-z]+(-[a-z]+)*(~[A-Za-z0-9_.+-]+)+$/);
  });
});

describe('a customer whose own data is wrong', () => {
  const bad: SyntheticRecord = { ...recordById('CARD-0001')!, recordId: 'CARD-9001', card: { ...recordById('CARD-0001')!.card!, paymentStatus: 'current', missedPayments: 3 } };
  const bad2: SyntheticRecord = { ...recordById('CARD-0003')!, recordId: 'CARD-9002', card: { ...recordById('CARD-0003')!.card!, paymentStatus: 'current', missedPayments: 2 } };
  const r = documentBlockers(card, [...cardRecords, bad, bad2]);

  it('is a customer-data blocker that lists them, proposes no change to the document and links to Data Explorer', () => {
    const b = r.blockers.find((x) => x.code === 'INCONSISTENT_PAYMENT_STATE')!;
    expect(b.kind).toBe('customer-data');
    expect(b.recordIds).toEqual(['CARD-9001', 'CARD-9002']);
    expect(b.id).toBe('inconsistent-payment-state~payment-guidance');
    expect(b.fixes.every((f) => f.kind === 'scenario' || f.kind === 'link')).toBe(true);
    expect(b.fixes[0].kind).toBe('scenario');
    expect(b.link).toEqual({ view: 'data', label: 'Open in Data Explorer', recordId: 'CARD-9001' });
    expect(b.explanation).toContain('The document is fine');
  });
  it('is counted among the customers stopped, and customers of another kind are not checked', () => {
    expect(r.checked).toBe(72);
    expect(r.stopped).toBeGreaterThanOrEqual(2);
    expect(documentBlockers(card, [...RECORDS, bad]).checked).toBe(71);
  });
  it('covers the claim checks of the other sample', () => {
    const claim = eobRecords[0].claims![0] as { billedCents: number; status: string };
    const wrong: SyntheticRecord = { ...eobRecords[0], recordId: 'EOB-9001', claims: [{ ...claim, status: 'processed-covered', billedCents: claim.billedCents + 100 }, ...eobRecords[0].claims!.slice(1)] } as SyntheticRecord;
    const b = documentBlockers(eob, [...eobRecords, wrong]).blockers.find((x) => x.code === 'CLAIM_RECONCILIATION_FAILED');
    expect(b?.kind).toBe('customer-data');
    expect(b?.recordIds).toEqual(['EOB-9001']);
  });
});

describe('findings from a composed-page check', () => {
  it('are merged, marked full-check, and kept off the fast count unless the engine also finds them', () => {
    const r = documentBlockers(noContinuation, RECORDS, { extraFindings: [overflow('CARD-0002'), overflow('CARD-0004'), overflow('CARD-0002')] });
    const b = r.blockers.find((x) => x.kind === 'layout')!;
    expect(b).toMatchObject({ id: 'flow-overflow-no-continuation~transaction-table', speed: 'full-check', recordIds: ['CARD-0002', 'CARD-0004'], customerCount: 2, code: 'FLOW_OVERFLOW_NO_CONTINUATION' });
    expect(b.title).toBe('“Transactions” runs off the page');
    expect(b.fixes[0]).toMatchObject({ kind: 'change', risk: 'safe' });
    expect(b.link).toMatchObject({ view: 'design', nodeId: 'transaction-table' });
    // customers stopped by it count as stopped
    expect(r.stopped).toBe(new Set([...documentBlockers(noContinuation, RECORDS).blockers.flatMap((x) => x.recordIds), 'CARD-0002', 'CARD-0004']).size);
    // the fast blockers stay fast
    expect(r.blockers.filter((x) => x.kind === 'wording').every((x) => x.speed === 'fast')).toBe(true);
  });
  it('ignore findings that are not blocking and customers that are not in the list', () => {
    const warn = { ...overflow('CARD-0002'), finding: { ...overflow('CARD-0002').finding, severity: 'warning' as const } };
    expect(documentBlockers(card, RECORDS, { extraFindings: [warn] }).blockers.some((b) => b.kind === 'layout')).toBe(false);
    const stray = documentBlockers(card, RECORDS, { extraFindings: [overflow('NO-SUCH-CUSTOMER')] });
    expect(stray.blockers.find((b) => b.kind === 'layout')).toMatchObject({ recordIds: [], customerCount: 0 });
  });
  it('a difference between the PDF and the web version is a Layout blocker per check', () => {
    const f: Finding = { code: 'PARITY_MISMATCH', severity: 'blocking', source: 'parity', message: 'Total: PDF and/or HTML differ from the resolved semantic facts.', details: { check: 'total' } };
    const b = documentBlockers(card, RECORDS, { extraFindings: [{ finding: f, recordId: 'CARD-0003' }] }).blockers.find((x) => x.code === 'PARITY_MISMATCH')!;
    expect(b).toMatchObject({ kind: 'layout', id: 'parity-mismatch~total', speed: 'full-check', link: { view: 'validate' } });
  });
});

describe('deterministic and pure', () => {
  it('gives the same answer twice, whatever the order of the customers', () => {
    const a = documentBlockers(withTie, RECORDS);
    expect(JSON.parse(JSON.stringify(documentBlockers(withTie, RECORDS)))).toEqual(JSON.parse(JSON.stringify(a)));
    const reversed = documentBlockers(withTie, [...RECORDS].reverse());
    expect(reversed.blockers.map((b) => [b.id, b.recordIds])).toEqual(a.blockers.map((b) => [b.id, b.recordIds]));
  });
  it('never changes the model', () => {
    const before = JSON.stringify(withTie);
    documentBlockers(withTie, RECORDS);
    expect(JSON.stringify(withTie)).toBe(before);
  });
});

describe('a document with its own data', () => {
  const p = gymProject({ withSpanish: true });
  const base: SyntheticRecord = { recordId: 'REC-60001', projectId: p.projectId, documentType: 'custom', customer: { givenName: 'Ada', familyName: 'Lovelace', locale: 'en-US' }, custom: { tier: 'pro', autoRenew: false, visits: 0, sessions: [], planName: 'Pro', renewalDate: '2026-12-01', monthlyFeeCents: 4000 } } as unknown as SyntheticRecord;
  const second: SyntheticRecord = { ...base, recordId: 'REC-60002', customer: { ...base.customer, givenName: 'Grace' } };
  const plain: SyntheticRecord = { ...base, recordId: 'REC-60003', custom: { ...base.custom, tier: 'basic', autoRenew: true } } as SyntheticRecord;
  const r2 = p.rules.find((x) => x.id === 'R02')!;
  const tied = run(p, { type: 'UPSERT_RULE', rule: { ...r2, priority: 200 } });

  it('is clean when nothing is wrong', () => {
    const r = documentBlockers(p, [base, second, plain]);
    expect(r).toMatchObject({ checked: 3, issuable: 3, stopped: 0, blockers: [] });
  });
  it('groups a tie across its own customers and ignores the sample customers', () => {
    const r = documentBlockers(tied, [...RECORDS, base, second, plain]);
    expect(r.checked).toBe(3);
    const b = r.blockers.find((x) => x.kind === 'rules')!;
    expect(b.id).toBe('priority-tie~R01+R02');
    expect(b.recordIds).toEqual(['REC-60001', 'REC-60002']);
    expect(r.stopped).toBe(2);
    expect(r.issuable).toBe(1);
    expect(b.fixes[0].kind).toBe('change');
  });
});
