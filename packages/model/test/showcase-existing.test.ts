/**
 * The showcase additions to the two original samples (D106): the approved results are unchanged (the oracle goldens
 * run against the enriched samples, and every fixture customer's core result is identical before and after), every
 * addition is real and working, and the examples' domain arithmetic over the fixture customers is as documented.
 */
import { describe, expect, it } from 'vitest';
import { resolve, indexTree } from '@iss/resolver';
import { checkWording, mappingChecks, planTestData, runTestCases } from '@iss/scenarios';
import { EXPECTED_SCENARIOS, RECORDS, recordById, sampleProjects, seedProjects } from '../src/fixtures';
import { buildContext, deepPatch, digestOf, evaluateCalculations, libraryContentFingerprint, type Project, type SyntheticRecord } from '../src';
import { CARD_LATE_FEES, EOB_REVIEW_TIMES, HOUSE, HOUSE_WORDING_RULES, houseContent, type HouseItemId } from '../src/samples/houseLibrary';
import { CARD_CALCULATIONS, EOB_CALCULATIONS, enrichCard, enrichEob, enrichSamples } from '../src/samples/showcaseExisting';
import { DELIBERATE_SCENARIO_FINDINGS, EXISTING_EXAMPLES, cardArithmetic, eobArithmetic, eobTotals } from '../src/samples/showcaseExistingAudit';

const KEYS = ['recordId', 'documentType', 'selectedVariants', 'matchedRuleIds', 'additiveRuleIds', 'requiredNodes', 'diagnostics', 'documentFacts'] as const;
const base = seedProjects();
const rich = sampleProjects();
const kindOf = (recordId: string) => (recordId.startsWith('EOB') ? 'eob' : 'credit-statement');
const pick = (ps: Project[], recordId: string) => ps.find((p) => p.documentType === kindOf(recordId))!;
const card = rich.find((p) => p.projectId === 'aster-card-demo')!;
const eob = rich.find((p) => p.projectId === 'harborcare-demo')!;
const customersOf = (p: Project) => RECORDS.filter((r) => r.documentType === p.documentType);

describe('the approved results do not change', () => {
  for (const [name, gc] of Object.entries(EXPECTED_SCENARIOS)) {
    it(`oracle golden ${name} holds on the enriched sample`, () => {
      let project = pick(rich, gc.recordId);
      if (gc.rulePatches) project = { ...project, rules: project.rules.map((r) => { const p = gc.rulePatches!.find((x) => x.id === r.id); return p ? { ...r, ...p } as typeof r : r; }) };
      const res = resolve({ project, record: recordById(gc.recordId)!, overrides: gc.overrides });
      for (const k of KEYS) expect(res.result[k], k).toEqual(gc.expected[k]);
      expect(res.result.resultDigest).toBe(gc.expected.resultDigest);
    });
  }

  it('every fixture customer gets exactly the same core result as before (selected variants, rules, required parts, diagnostics, facts)', () => {
    for (const r of RECORDS) {
      const a = resolve({ project: pick(base, r.recordId), record: r }).result;
      const b = resolve({ project: pick(rich, r.recordId), record: r }).result;
      expect(b, r.recordId).toEqual(a);
    }
  });

  it('keeps every component, rule, message and customer-facing setting the fixtures build, unchanged', () => {
    for (const p of base) {
      const e = pick(rich, p.projectId === 'harborcare-demo' ? 'EOB' : 'CARD');
      expect(e.rules).toEqual(p.rules);
      for (const n of p.nodes) {
        const after = e.nodes.find((x) => x.id === n.id)!;
        if (n.id === p.rootNodeId) expect(after.children!.filter((c) => n.children!.includes(c))).toEqual(n.children);
        else if (n.id === 'transaction-table') expect({ ...after, totalFrom: undefined }).toEqual({ ...n, totalFrom: undefined });
        else if (n.id === 'claim-facts') expect({ ...after, layout: { ...after.layout, paged: { ...after.layout!.paged, keepTogether: undefined } } }).toEqual({ ...n, layout: { ...n.layout, paged: { ...n.layout!.paged, keepTogether: undefined } } });
        else expect(after, n.id).toEqual(n);
      }
      for (const c of p.contentParts) expect(e.contentParts.find((x) => x.id === c.id)).toEqual(c);
      expect(e.modelVersion).toBe(p.modelVersion);
      expect(e.journey).toEqual(p.journey);
    }
  });

  it('is pure and deterministic', () => {
    const input = seedProjects();
    const before = digestOf(input);
    expect(digestOf(enrichSamples(input))).toBe(digestOf(enrichSamples(seedProjects())));
    expect(digestOf(input)).toBe(before);
    expect(() => enrichCard(input[1])).toThrow(/credit-card/);
    expect(() => enrichEob(input[0])).toThrow(/explanation-of-benefits/);
  });
});

describe('the additions work for every customer', () => {
  it('every calculation has a value for every fixture customer and every oracle scenario (so none can raise a finding)', () => {
    for (const p of [card, eob]) {
      for (const r of customersOf(p)) {
        const res = resolve({ project: p, record: r });
        for (const [k, v] of Object.entries(res.calculated ?? {})) expect(v.value, `${r.recordId} ${k}`).not.toBeNull();
      }
    }
    for (const [name, gc] of Object.entries(EXPECTED_SCENARIOS)) {
      const res = resolve({ project: pick(rich, gc.recordId), record: recordById(gc.recordId)!, overrides: gc.overrides });
      for (const [k, v] of Object.entries(res.calculated ?? {})) expect(v.value, `${name} ${k}`).not.toBeNull();
    }
  });

  it('card: the calculated values are the arithmetic of the data (days to due, listed total, largest, available %, late fee)', () => {
    const r = recordById('CARD-0001')!;
    const out = evaluateCalculations(card, buildContext(r) as Record<string, unknown>, '2026-11-01');
    expect(out.values).toEqual({ daysUntilDue: 24, listedTotal: 50800, largestTransaction: 4234, availableCreditPct: 84, lateFee: 2900 });
    const premium = evaluateCalculations(card, buildContext(recordById('CARD-0002')!) as Record<string, unknown>, '2026-11-01');
    expect(premium.values.lateFee).toBe(2500);
    const arranged = evaluateCalculations(card, buildContext(deepPatch(r as any, { card: { arrangementStatus: 'approved' } }) as SyntheticRecord) as Record<string, unknown>, '2026-11-01');
    expect(arranged.values.lateFee).toBe(0);
    const empty = evaluateCalculations(card, buildContext(deepPatch(r as any, { card: { transactions: [] } }) as SyntheticRecord) as Record<string, unknown>, '2026-11-01');
    expect(empty.values).toMatchObject({ listedTotal: 0, largestTransaction: 0 });
    expect(CARD_CALCULATIONS.map((c) => c.key)).toEqual(card.calculatedFields!.map((c) => c.key));
  });

  it('EOB: share of billed, total plan paid, number of claims and review time', () => {
    const covered = evaluateCalculations(eob, buildContext(recordById('EOB-0001')!) as Record<string, unknown>, null);
    expect(covered.values).toEqual({ memberSharePct: 12.5, totalPlanPaid: 20000, claimCount: 1, reviewDays: 30 });
    const big = evaluateCalculations(eob, buildContext(recordById('EOB-0004')!) as Record<string, unknown>, null);
    expect(big.values).toMatchObject({ memberSharePct: 0, totalPlanPaid: 0, reviewDays: 45 });
    expect(EOB_CALCULATIONS.map((c) => c.key)).toEqual(eob.calculatedFields!.map((c) => c.key));
  });

  it('card: the date comes from the statement issue date, which every customer has; the notices follow their periods (CARD-0007 gets a paper statement)', () => {
    expect(card.documentDate).toEqual({ source: 'field', path: 'card.issuedAt' });
    for (const r of customersOf(card)) expect(resolve({ project: card, record: r }).documentDate?.date, r.recordId).toBe((r as any).card.issuedAt);
    const shown = (issueDate?: string) => { const t = indexTree(resolve({ project: card, record: recordById('CARD-0007')!, ...(issueDate ? { issueDate } : {}) }).root); return ['notice-holiday-posting', 'notice-agreement-update'].map((id) => t.get(id)!.visible); };
    expect(shown()).toEqual([true, false]);
    expect(shown('2026-12-01')).toEqual([true, true]);
    expect(shown('2027-01-05')).toEqual([false, true]);
    expect(eob.documentDate).toBeUndefined();
  });

  it('the new sections show the right alternative and are hidden where they do not apply', () => {
    const at = (p: Project, id: string, overrides: Record<string, unknown> = {}) => indexTree(resolve({ project: p, record: recordById(id)!, overrides }).root);
    expect(at(card, 'CARD-0001').get('payment-timing')!.variants!.selected).toEqual(['timing-late-fee']);
    expect(at(card, 'CARD-0001', { card: { arrangementStatus: 'approved' } }).get('payment-timing')!.variants!.selected).toEqual(['timing-arrangement']);
    expect(at(card, 'CARD-0001', { card: { minimumDueCents: 0 } }).get('payment-timing')!.visible).toBe(false);
    expect(at(card, 'CARD-0001', { card: { transactions: [] } }).get('spending-summary')!.visible).toBe(false);
    expect(at(eob, 'EOB-0001').get('claim-summary')!.variants!.selected).toEqual(['summary-confirmed']);
    expect(at(eob, 'EOB-0002').get('claim-summary')!.variants!.selected).toEqual(['summary-in-review']);
    // The table footer total is the calculated total, the same sum as its amount column.
    const table = at(card, 'CARD-0008').get('transaction-table')!.table!;
    expect(table.totalCents).toBe(table.rows.reduce((s, r) => s + (r.cells.amountCents.raw as number), 0));
  });

  it('pinned tests pass (with tests "as issued on" a date for the card)', () => {
    for (const p of [card, eob]) {
      expect(p.testCases!.length).toBeGreaterThanOrEqual(5);
      expect(runTestCases(p, customersOf(p)).filter((t) => !t.pass)).toEqual([]);
    }
    expect(card.testCases!.filter((t) => t.issueDate).length).toBeGreaterThanOrEqual(1);
  });

  it('wording rules: one “must” already met, and exactly one deliberate “should” finding per example', () => {
    for (const ex of EXISTING_EXAMPLES) {
      const p = ex.projectId === 'aster-card-demo' ? card : eob;
      expect(p.wordingRules!.filter((r) => r.severity === 'must')).toHaveLength(1);
      const w = checkWording(p);
      expect(w.findings.map((f) => [f.ruleId, f.textId, f.severity])).toEqual([[ex.deliberateShould.ruleId, ex.deliberateShould.textId, 'should']]);
    }
  });

  it('each has a complete “Mapping for the print house”', () => {
    for (const p of [card, eob]) {
      expect(p.mappings!.map((m) => m.name)).toEqual(['Mapping for the print house']);
      const c = mappingChecks(p, p.mappings![0]);
      expect(c.complete).toBe(true);
      expect(c.findings.filter((f) => f.severity === 'problem')).toEqual([]);
    }
  });

  it('generated test customers can reach every outcome, including the new sections and the dates', () => {
    for (const p of [card, eob]) {
      const plan = planTestData(p, customersOf(p), { outcomes: true, edges: false });
      expect(plan.summary.outcomes.reached, p.projectId).toBe(plan.summary.outcomes.total);
    }
  });

  it('email wording uses a calculated value; the SMS is unchanged', () => {
    const r = resolve({ project: card, record: recordById('CARD-0001')! });
    expect(r.channelTexts.intro.map((b) => b.inlines!.map((i) => i.text).join('')).join(' ')).toBe('You have 24 days to pay. Every transaction is in your full statement.');
    expect(card.channels!.sms).toEqual(base[0].channels?.sms ?? card.channels!.sms);
    expect(resolve({ project: card, record: recordById('CARD-0001')! }).channelTexts.sms).toBe(resolve({ project: base[0], record: recordById('CARD-0001')! }).channelTexts.sms);
  });

  it('the explanation of benefits keeps the claim amounts together and has a first-page tint; accessible PDF is required', () => {
    expect(eob.nodes.find((n) => n.id === 'claim-facts')!.layout!.paged!.keepTogether).toBe(true);
    const paged = eob.presentationProfiles.filter((p) => p.kind === 'paged' || p.kind === 'afp-simulation');
    for (const p of paged) expect(p.pageTemplates?.first?.background).toEqual({ kind: 'tint', color: '#EEF5F1', opacityPct: 100 });
    expect(eob.accessiblePdfRequired).toBe(true);
    expect(card.accessiblePdfRequired).toBeUndefined();
    expect(card.presentationProfiles).toEqual(base[0].presentationProfiles);
  });
});

describe('domain arithmetic of the examples', () => {
  const rec = (x: unknown) => x as SyntheticRecord;
  it('card checks: balance, transactions, minimum, dates, payment state', () => {
    const ok = recordById('CARD-0001')!;
    expect(cardArithmetic(ok)).toEqual([]);
    const bad = rec(deepPatch(ok as any, { card: { newBalanceCents: 1, minimumDueCents: 5, dueDate: '2026-10-01', paymentStatus: 'current', missedPayments: 1, transactions: [{ id: 'X', date: '2025-01-01', amountCents: 10 }] } }));
    expect(cardArithmetic(bad).map((f) => f.check)).toEqual(['new-balance', 'transactions-sum', 'minimum-payment', 'dates', 'transaction-dates', 'payment-state']);
    expect(cardArithmetic(bad).every((f) => !f.intended)).toBe(true);
  });

  it('EOB checks: billed, allowed, deductible; an undecided claim is an intended exception', () => {
    expect(eobArithmetic(recordById('EOB-0001')!)).toEqual([]);
    const review = eobArithmetic(recordById('EOB-0002')!);
    expect(review).toMatchObject([{ check: 'billed', intended: true }]);
    const broken = rec({ recordId: 'EOB-X', documentType: 'eob', claims: [{ claimId: 'C1', status: 'processed-covered', liabilityConfirmed: true, billedCents: 100, allowedCents: 50, contractualAdjustmentCents: 40, planPaidCents: 30, patientResponsibilityCents: 10, deductibleAppliedCents: 20 }] });
    expect(eobArithmetic(broken).map((f) => [f.check, f.intended])).toEqual([['billed', false], ['allowed', false], ['deductible', false]]);
    expect(eobTotals(recordById('EOB-0001')!)).toEqual({ claims: 1, billedCents: 40000, planPaidCents: 20000, memberCents: 5000 });
  });

  it('over the fixture customers: every finding is an intended exception (none on the cards; the undecided claims on the EOB)', () => {
    const cards = customersOf(card).flatMap(cardArithmetic);
    expect(cards).toEqual([]);
    const eobs = customersOf(eob).flatMap(eobArithmetic);
    expect(eobs.filter((f) => !f.intended)).toEqual([]);
    expect(eobs.map((f) => f.recordId)).toEqual(['EOB-0002', 'EOB-0004', 'EOB-0005', 'EOB-0010', 'EOB-0011', 'EOB-0016', 'EOB-0017', 'EOB-0022', 'EOB-0023', 'EOB-0028', 'EOB-0029']);
  });

  it('over the oracle scenarios: the deliberately inconsistent ones are exactly those named, with those checks', () => {
    const found: Record<string, string[]> = {};
    for (const [name, gc] of Object.entries(EXPECTED_SCENARIOS)) {
      const r = deepPatch(recordById(gc.recordId)! as any, gc.overrides) as SyntheticRecord;
      const fs = (kindOf(gc.recordId) === 'eob' ? eobArithmetic : cardArithmetic)(r).filter((f) => !f.intended).map((f) => f.check);
      if (fs.length) found[name] = fs;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(DELIBERATE_SCENARIO_FINDINGS).map(([k, v]) => [k, v.checks])));
  });

  it('describes the deliberately blocked customers, and they are the only blocked fixture customers', () => {
    for (const ex of EXISTING_EXAMPLES) {
      const p = ex.projectId === 'aster-card-demo' ? card : eob;
      const blocked = customersOf(p).filter((r) => resolve({ project: p, record: r }).result.diagnostics.some((d) => d.severity === 'blocking')).map((r) => r.recordId);
      expect(blocked).toEqual(ex.blockedCustomers.map((b) => b.recordId));
      expect(ex.notes.length).toBeGreaterThan(3);
    }
  });
});

describe('links to the house library (glossary, house wording rules, each example’s own table)', () => {
  /** The same enriched sample as if nothing came from the library: the table kept as the document's own, no glossary, no house rules. */
  const unlinked = (p: Project): Project => {
    const q = JSON.parse(JSON.stringify(p)) as Project;
    delete q.libraryLinks; delete q.glossary; delete q.houseWordingRules;
    return q;
  };
  const without = (res: ReturnType<typeof resolve>) => ({ ...res, runId: undefined, projectDigest: undefined });

  it('each example links exactly the house items the plan names, with the library’s content', () => {
    expect(card.libraryLinks!.map((l) => [l.itemId, l.version])).toEqual([['card-late-fees', 1], ['house-wording-rules', 1]]);
    expect(eob.libraryLinks!.map((l) => [l.itemId, l.version])).toEqual([['claim-review-times', 1], ['glossary-es', 1], ['house-wording-rules', 1]]);
    for (const p of [card, eob]) for (const l of p.libraryLinks!) {
      expect(l.version).toBe(HOUSE.linkPlan[l.itemId as HouseItemId]);
      expect(l.fingerprint).toBe(libraryContentFingerprint(houseContent(l.itemId as HouseItemId, l.version)));
    }
    expect(card.lookupTables).toEqual([CARD_LATE_FEES]);
    expect(eob.lookupTables).toEqual([EOB_REVIEW_TIMES]);
    expect(card.houseWordingRules).toEqual(HOUSE_WORDING_RULES);
    expect(card.glossary).toBeUndefined();
    expect(eob.glossary).toEqual((houseContent('glossary-es', 1) as { entries: unknown }).entries);
    expect(card.wordingRules!.map((r) => r.id)).toEqual(['aster-not-legal', 'aster-no-kindly', 'aster-short-sentences', 'aster-relationship-team']);
  });

  it('every fixture customer and every oracle scenario resolves exactly as without the links (only the run id, a hash of the document, differs)', () => {
    for (const r of RECORDS) {
      const p = pick(rich, r.recordId);
      expect(without(resolve({ project: p, record: r })), r.recordId).toEqual(without(resolve({ project: unlinked(p), record: r })));
    }
    for (const [name, gc] of Object.entries(EXPECTED_SCENARIOS)) {
      const p = pick(rich, gc.recordId);
      const record = recordById(gc.recordId)!;
      expect(without(resolve({ project: p, record, overrides: gc.overrides })), name).toEqual(without(resolve({ project: unlinked(p), record, overrides: gc.overrides })));
    }
  });

  it('no house “must” rule is broken by any text, and the only wording finding of each example is its deliberate “should”', () => {
    for (const ex of EXISTING_EXAMPLES) {
      const p = ex.projectId === 'aster-card-demo' ? card : eob;
      const w = checkWording(p);
      expect(w.rules.length).toBe(HOUSE_WORDING_RULES.length + 4);
      expect(w.findings.map((f) => `${f.severity} ${f.ruleId}`)).toEqual([`should ${ex.deliberateShould.ruleId}`]);
    }
  });
});
