import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type Project, type SyntheticRecord } from '@iss/model';
import { RECORDS, recordById, seedProjects } from '../../model/src/fixtures';
import {
  blockerKindOfId, customerBlockers, documentBlockerStatus, documentBlockers, knownDataProblemRefusal, KNOWN_REASON_MAX, resolveOrder,
  splitKnownDataProblems, testsForFixedBlockers, withKnownDataProblems, type KnownDataProblem,
} from '../src/assist/blockers';
import { runTestCase } from '../src/testCases';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const cardRecords = RECORDS.filter((r) => r.documentType === 'credit-statement');
const DATA = 'inconsistent-payment-state~payment-guidance';
const SPANISH = 'required-translation-missing~billing-summary~es-US';
/** Two customers whose own data contradicts itself (up to date, yet missed payments). */
const bad: SyntheticRecord = { ...recordById('CARD-0001')!, recordId: 'CARD-9001', card: { ...recordById('CARD-0001')!.card!, paymentStatus: 'current', missedPayments: 3 } };
const bad2: SyntheticRecord = { ...recordById('CARD-0003')!, recordId: 'CARD-9002', card: { ...recordById('CARD-0003')!.card!, paymentStatus: 'current', missedPayments: 2 } };
const records = [...cardRecords, bad, bad2];
const known = (recordId: string, blockerId = DATA, reason = 'Corrected at source next cycle'): KnownDataProblem => ({ id: `${recordId}-${blockerId}`, blockerId, recordId, reason, markedBy: { id: 'u1', name: 'Ann Approver' }, markedAt: '2026-11-13T10:00:00.000Z' });

describe('one customer’s blockers', () => {
  it('names the same causes, with the same ids, as the whole-document check', () => {
    const all = documentBlockers(card, records);
    for (const r of [bad, cardRecords.find((x) => all.blockers[0].recordIds.includes(x.recordId))!]) {
      const mine = customerBlockers(card, r).map((b) => b.id).sort();
      const fromAll = all.blockers.filter((b) => b.recordIds.includes(r.recordId)).map((b) => b.id).sort();
      expect(mine).toEqual(fromAll);
    }
  });
  it('gives a customer-data blocker the customer’s values that disagree, as Data Explorer paths, and plain words', () => {
    const b = customerBlockers(card, bad).find((x) => x.id === DATA)!;
    expect(b).toMatchObject({ kind: 'customer-data', code: 'INCONSISTENT_PAYMENT_STATE', fields: ['card.paymentStatus', 'card.missedPayments'] });
    expect(b.title).toBe('The account is “up to date” but lists missed payments');
    expect(b.title + b.explanation).not.toMatch(/CARD-9001|paymentStatus|INCONSISTENT/);
  });
  it('points at the very claim that does not add up', () => {
    const eobRecords = RECORDS.filter((r) => r.documentType === 'eob');
    const base = eobRecords[0] as SyntheticRecord & { claims: Array<Record<string, any>> };
    // The document reads the first claim; the finding names it by its claim id, which is how the row is found.
    const claim: Record<string, any> = { ...base.claims[0], status: 'processed-covered' };
    const wrong = { ...base, recordId: 'EOB-9001', claims: [{ ...claim, billedCents: claim.billedCents + 100 }, ...base.claims.slice(1)] } as unknown as SyntheticRecord;
    const b = customerBlockers(eob, wrong).find((x) => x.code === 'CLAIM_RECONCILIATION_FAILED')!;
    expect(b.fields).toEqual(['claims[0].billedCents', 'claims[0].contractualAdjustmentCents', 'claims[0].allowedCents', 'claims[0].planPaidCents', 'claims[0].patientResponsibilityCents']);
  });
  it('a document blocker that stops the customer has no fields, and a customer of another kind has no blockers', () => {
    const spanish = cardRecords.find((r) => r.customer.locale === 'es-US')!;
    expect(customerBlockers(card, spanish).find((b) => b.id === SPANISH)).toMatchObject({ kind: 'wording', fields: [] });
    expect(customerBlockers(card, RECORDS.find((r) => r.documentType === 'eob')!)).toEqual([]);
  });
  it('an empty value a field must show is the customer’s data, with that field', () => {
    let p = run(card, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'branch', label: 'Branch', type: 'string' }] });
    p = run(p, { type: 'UPDATE_NODE', nodeId: 'available-credit', patch: { binding: 'custom.branch', nullPolicy: 'error' } as never });
    expect(customerBlockers(p, cardRecords[0]).find((b) => b.code === 'NULL_BINDING')).toMatchObject({ id: 'null-binding~available-credit', kind: 'customer-data', fields: ['custom.branch'] });
  });
});

describe('the kind of a blocker from its id', () => {
  it('reads it from the first part, and does not guess for an id the engine never makes', () => {
    expect(blockerKindOfId(DATA)).toBe('customer-data');
    expect(blockerKindOfId('null-binding~available-credit')).toBe('customer-data');
    expect(blockerKindOfId(SPANISH)).toBe('wording');
    expect(blockerKindOfId('priority-tie~R03+R04')).toBe('rules');
    expect(blockerKindOfId('no-fallback~payment-guidance')).toBe('rules');
    expect(blockerKindOfId('flow-overflow-no-continuation~transaction-table')).toBe('layout');
    expect(blockerKindOfId('invalid-binding~x')).toBe('data-fields');
    expect(blockerKindOfId('made-up~x')).toBeNull();
  });
});

describe('who may set a problem aside, and for what', () => {
  const blockers = customerBlockers(card, bad);
  const ok = { blockerId: DATA, reason: 'Corrected at source', customer: bad, blockers };
  it('accepts one customer-data blocker that stops this customer, with a reason', () => {
    expect(knownDataProblemRefusal(ok)).toBeNull();
  });
  it('needs a reason, trimmed, of at most 500 characters', () => {
    expect(knownDataProblemRefusal({ ...ok, reason: '   ' })).toMatchObject({ code: 'REASON_REQUIRED', status: 400 });
    expect(knownDataProblemRefusal({ ...ok, reason: undefined })).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(knownDataProblemRefusal({ ...ok, reason: 'x'.repeat(KNOWN_REASON_MAX + 1) })).toMatchObject({ code: 'REASON_TOO_LONG', status: 400 });
    expect(knownDataProblemRefusal({ ...ok, reason: ` ${'x'.repeat(KNOWN_REASON_MAX)} ` })).toBeNull();
  });
  it('never sets aside a blocker in the document itself, even one that stops this customer', () => {
    const spanish = cardRecords.find((r) => r.customer.locale === 'es-US')!;
    const r = knownDataProblemRefusal({ blockerId: SPANISH, reason: 'We accept it', customer: spanish, blockers: customerBlockers(card, spanish) });
    expect(r).toMatchObject({ code: 'NOT_A_DATA_PROBLEM', status: 422 });
    expect(r!.message).toContain('must always be fixed');
    for (const id of ['priority-tie~R03+R04', 'flow-overflow-no-continuation~transaction-table', 'invalid-binding~billing-summary~card.nothing', 'made-up~x']) {
      expect(knownDataProblemRefusal({ ...ok, blockerId: id })?.code, id).toBe('NOT_A_DATA_PROBLEM');
    }
  });
  it('refuses an unknown customer, and a problem that does not stop this customer', () => {
    expect(knownDataProblemRefusal({ ...ok, customer: null, blockers: [] })).toMatchObject({ code: 'UNKNOWN_CUSTOMER', status: 404 });
    expect(knownDataProblemRefusal({ ...ok, customer: cardRecords[0], blockers: customerBlockers(card, cardRecords[0]) })).toMatchObject({ code: 'NOT_STOPPING_THIS_CUSTOMER', status: 409 });
  });
});

describe('status once known data problems are applied', () => {
  const base = documentBlockers(card, records);
  const spanishIds = base.blockers.find((b) => b.id === SPANISH)!.recordIds;

  it('with none, nothing changes: every blocker is open and nobody is set aside', () => {
    const s = withKnownDataProblems(base, []);
    expect(s).toMatchObject({ checked: base.checked, issuable: base.issuable, stopped: base.stopped, setAside: 0, setAsideRecordIds: [], known: [], lapsed: [] });
    expect(s.blockers.every((b) => b.status === 'open' && b.openRecordIds.join() === b.recordIds.join())).toBe(true);
    expect(s.blockers.map((b) => b.id)).toEqual(base.blockers.map((b) => b.id));
  });

  it('a customer whose only blocker is set aside is not stopped, not issuable, but set aside; the blocker stays listed with the same id', () => {
    const s = documentBlockerStatus(card, records, { known: [known('CARD-9001')] });
    const b = s.blockers.find((x) => x.id === DATA)!;
    expect(b).toMatchObject({ status: 'open', recordIds: ['CARD-9001', 'CARD-9002'], customerCount: 2, openRecordIds: ['CARD-9002'] });
    expect(b.known.map((k) => k.recordId)).toEqual(['CARD-9001']);
    expect(s).toMatchObject({ setAside: 1, setAsideRecordIds: ['CARD-9001'], stopped: base.stopped - 1, issuable: base.issuable });
    expect(s.issuable + s.stopped + s.setAside).toBe(s.checked);
  });

  it('when every customer it stops is set aside, the blocker’s status is “known data problem”', () => {
    const s = withKnownDataProblems(base, [known('CARD-9001'), known('CARD-9002')]);
    expect(s.blockers.find((x) => x.id === DATA)).toMatchObject({ status: 'known-data-problem', openRecordIds: [] });
    expect(s.setAsideRecordIds).toEqual(['CARD-9001', 'CARD-9002']);
    expect(s.stopped).toBe(spanishIds.length);
    expect(resolveOrder(s).some((x) => x.id === DATA)).toBe(false);
  });

  it('a customer who is also stopped by a document blocker stays stopped', () => {
    const spanishBad: SyntheticRecord = { ...bad, recordId: 'CARD-9003', customer: { ...bad.customer, locale: 'es-US' } };
    const s = documentBlockerStatus(card, [...records, spanishBad], { known: [known('CARD-9003')] });
    expect(s.blockers.find((x) => x.id === SPANISH)!.openRecordIds).toContain('CARD-9003');
    expect(s.setAsideRecordIds).not.toContain('CARD-9003');
    expect(s.blockers.find((x) => x.id === DATA)!.known.map((k) => k.recordId)).toEqual(['CARD-9003']);
  });

  it('an entry lapses when the problem no longer stops that customer: corrected data, a changed document, a customer gone, or a document blocker', () => {
    const fixedData = { ...bad, card: { ...bad.card!, missedPayments: 0 } };
    const corrected = documentBlockerStatus(card, [...cardRecords, fixedData, bad2], { known: [known('CARD-9001'), known('CARD-9002')] });
    expect(corrected.lapsed.map((k) => k.recordId)).toEqual(['CARD-9001']);
    expect(corrected.known.map((k) => k.recordId)).toEqual(['CARD-9002']);
    expect(corrected.setAside).toBe(1);
    const gone = documentBlockerStatus(card, cardRecords, { known: [known('CARD-9001')] });
    expect(gone).toMatchObject({ known: [], setAside: 0 });
    expect(gone.lapsed).toHaveLength(1);
    // a change to the document that leaves the problem in place keeps the entry
    const moved = run(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { name: 'Help with payments' } });
    expect(documentBlockerStatus(moved, records, { known: [known('CARD-9001')] }).known).toHaveLength(1);
    const notData = documentBlockerStatus(card, records, { known: [known(spanishIds[0], SPANISH)] });
    expect(notData).toMatchObject({ known: [], setAside: 0, stopped: base.stopped });
    expect(notData.lapsed).toHaveLength(1);
  });

  it('a duplicate entry counts once and the second is lapsed', () => {
    const s = splitKnownDataProblems([known('CARD-9001'), { ...known('CARD-9001'), id: 'dup' }], () => true);
    expect(s.active).toHaveLength(1);
    expect(s.lapsed.map((k) => k.id)).toEqual(['dup']);
  });

  it('is pure: the result it was given is not changed', () => {
    const before = JSON.stringify(base);
    withKnownDataProblems(base, [known('CARD-9001')]);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('resolving one by one', () => {
  const r3 = card.rules.find((r) => r.id === 'R03')!;
  const withTie = run(card, { type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } });

  it('takes the open blockers with the most customers still stopped first, and leaves set-aside ones out', () => {
    const s = documentBlockerStatus(withTie, records, { known: [known('CARD-9001')] });
    const order = resolveOrder(s);
    const counts = order.map((b) => b.openRecordIds.length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(order.length).toBe(s.blockers.filter((b) => b.status === 'open').length);
    expect(order.find((b) => b.id === DATA)!.openRecordIds).toEqual(['CARD-9002']);
  });

  it('offers a test per fixed blocker on one affected customer that passes now and fails if the problem comes back', () => {
    const tie = documentBlockers(withTie, RECORDS).blockers.find((b) => b.kind === 'rules')!;
    const fixed = run(withTie, { type: 'BATCH', label: 'fix', commands: tie.fixes[0].commands! });
    expect(documentBlockers(fixed, RECORDS).blockers.some((b) => b.id === tie.id)).toBe(false);
    const [test] = testsForFixedBlockers(fixed, RECORDS, [{ blockerId: tie.id, title: tie.title, recordId: tie.recordIds[0] }]);
    expect(test).toMatchObject({ id: 'T01', recordId: tie.recordIds[0], overrides: {}, journeyCursor: null });
    expect(test.name).toBe(`Stays fixed: ${tie.title}`);
    expect(applyCommand(fixed, { type: 'UPSERT_TEST_CASE', testCase: test }).ok).toBe(true);
    expect(runTestCase(fixed, RECORDS, test).pass).toBe(true);
    // the tie coming back makes the test fail
    expect(runTestCase(withTie, RECORDS, test).pass).toBe(false);
  });

  it('gives each test its own id, skips a customer that is not there, and never puts a customer’s name in the test', () => {
    const tests = testsForFixedBlockers(card, RECORDS, [{ blockerId: 'a', title: 'One', recordId: 'CARD-0001' }, { blockerId: 'b', title: 'Two', recordId: 'NO-SUCH' }, { blockerId: 'c', title: 'Three', recordId: 'CARD-0002' }]);
    expect(tests.map((t) => [t.id, t.recordId])).toEqual([['T01', 'CARD-0001'], ['T02', 'CARD-0002']]);
    const names = RECORDS.filter((r) => ['CARD-0001', 'CARD-0002'].includes(r.recordId)).flatMap((r) => [r.customer.givenName, r.customer.familyName]);
    for (const t of tests) for (const n of names) expect(t.name).not.toContain(n);
  });
});
