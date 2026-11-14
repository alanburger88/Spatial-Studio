import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type Project, type SyntheticRecord } from '../../model/src';
import { gymMember, run } from '../../model/test/helpers/customProject';
import { depthProject } from '../../model/test/helpers/depthProject';
import { resolve } from '../../resolver/src';
import {
  captureExpectation, compareVersions, coverageGaps, customerBlockers, dateChecks, documentBlockers, documentDateBoundaries, documentTimeline, explainInPlainWords,
  planTestData, runTestCase, summarizeChanges,
} from '../src';

const ok = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };
const people: SyntheticRecord[] = [
  gymMember(),
  gymMember({ recordId: 'REC-60002', custom: { tier: 'basic', visits: 0, renewalDate: '2027-03-01', autoRenew: true } }),
  gymMember({ recordId: 'REC-60003', custom: { tier: 'pro', renewalDate: '2027-05-01' } }),
];

describe('gaps and overlaps in time', () => {
  it('a message whose fallback is only in effect for a period has a gap outside it, with the dates', () => {
    const p = ok(depthProject(), { type: 'SET_VARIANT_PERIOD', nodeId: 'renewal-note', variantId: 'renewal-note-default', period: { from: '2026-06-01', until: '2027-06-01' } });
    const gaps = dateChecks(p).filter((c) => c.kind === 'gap');
    expect(gaps.map((g) => [g.from, g.until, g.severity])).toEqual([[null, '2026-06-01', 'blocking'], ['2027-06-01', null, 'blocking']]);
    expect(gaps[0].message).toBe('“Message” has no fallback message in effect before 1 Jun 2026: its fallback “Standard message” applies only from 1 Jun 2026, until 1 Jun 2027 (not included). A customer no rule chooses a message for then gets none, unless a rule chooses another message.');
    // and a customer no rule matches is stopped on those days only
    const nobody = gymMember({ custom: { tier: 'plus', renewalDate: '2028-01-01' } });
    expect(resolve({ project: p, record: nobody, issueDate: '2026-11-25' }).findings.some((f) => f.code === 'NO_VARIANT_MATCH')).toBe(false);
    const stopped = resolve({ project: p, record: nobody, issueDate: '2027-06-01' }).findings.find((f) => f.code === 'NO_VARIANT_MATCH')!;
    expect(stopped.message).toBe('No exclusive rule matched renewal-note, and its fallback “Standard message” is not in effect: Not in effect on 1 Jun 2027: ended 1 Jun 2027 (its last day was the day before).');
  });
  it('two rules at the same priority whose periods meet can tie on those days', () => {
    const p = depthProject();
    const r04 = p.rules.find((r) => r.id === 'R04')!;
    const q = ok(p, { type: 'UPSERT_RULE', rule: { ...r04, id: 'R07', title: 'Spring offer', priority: 260, effective: { from: '2026-12-15', until: '2027-02-01' } } });
    expect(dateChecks(q).filter((c) => c.kind === 'overlap')).toEqual([{ kind: 'overlap', severity: 'warning', nodeId: 'renewal-note', ruleIds: ['R04', 'R07'], from: '2027-01-01', until: '2027-02-01', message: '“New year offer for Basic” and “Spring offer” have the same priority and are both in effect from 1 Jan 2027 until 1 Feb 2027 (not included): a customer both apply to then gets no message, because the studio never picks a winner silently.' }]);
    const basic = gymMember({ custom: { tier: 'basic', renewalDate: '2028-01-01' } });
    expect(resolve({ project: q, record: basic, issueDate: '2026-12-20' }).findings.some((f) => f.code === 'EXCLUSIVE_PRIORITY_TIE')).toBe(false);
    expect(resolve({ project: q, record: basic, issueDate: '2027-01-10' }).findings.some((f) => f.code === 'EXCLUSIVE_PRIORITY_TIE')).toBe(true);
    expect(resolve({ project: q, record: basic, issueDate: '2027-02-01' }).findings.some((f) => f.code === 'EXCLUSIVE_PRIORITY_TIE')).toBe(false);
  });
});

describe('date boundaries and the timeline', () => {
  const p = depthProject();
  it('lists every day on which something changes, in plain words', () => {
    expect(documentDateBoundaries(p).map((b) => [b.date, b.changes.map((c) => c.words)])).toEqual([
      ['2026-01-01', ['Row 1 of the table “Bonus points rate” starts']],
      ['2026-12-01', ['The message “Winter offer” in “Message” can be chosen from this day']],
      ['2027-01-01', ['Rule “New year offer for Basic” starts to apply', 'Row 1 of the table “Bonus points rate” stops', 'Row 2 of the table “Bonus points rate” starts']],
      ['2027-03-01', ['The message “Winter offer” in “Message” can no longer be chosen']],
      ['2027-06-01', ['The section “Spin note” is no longer shown']],
    ]);
  });
  it('says, for each day, what changes and which test customers it reaches', () => {
    const t = documentTimeline(p, people);
    expect(t.map((e) => [e.date, e.dayBefore, e.reached, e.evaluated])).toEqual([
      ['2026-01-01', '2025-12-31', ['REC-60001', 'REC-60002', 'REC-60003'], 3],
      // the winter rule starts to match for the Plus customer, but the higher-priority "renews soon" message still wins
      ['2026-12-01', '2026-11-30', ['REC-60001'], 3],
      ['2027-01-01', '2026-12-31', ['REC-60001', 'REC-60002', 'REC-60003'], 3],
      ['2027-03-01', '2027-02-28', ['REC-60001'], 3],
      ['2027-06-01', '2027-05-31', ['REC-60001', 'REC-60002', 'REC-60003'], 3],
    ]);
    const newYear = t[2].examples.find((x) => x.recordId === 'REC-60002')!;
    expect(newYear.changes.find((c) => c.nodeId === 'renewal-note')).toMatchObject({ kind: 'message', after: 'New year offer' });
  });
});

describe('checks "as issued on" a chosen date', () => {
  const p = depthProject();
  it('blockers: without a date every customer is stopped in plain words; on a date only real problems remain', () => {
    const none = documentBlockers(p, people);
    expect(none.blockers.map((b) => [b.kind, b.code, b.title, b.customerCount])).toEqual([['customer-data', 'DOCUMENT_DATE_MISSING', 'Some customers’ documents have no date', 3]]);
    expect(none.blockers[0].explanation).toMatch(/^This document’s wording depends on its date, and these customers have none\. Give the date for the run/);
    const dated = documentBlockers(p, people, { issueDate: '2026-11-25' });
    expect(dated.blockers).toEqual([]);
    // a calculation the rules need, missing for one customer
    const gap = [gymMember({ recordId: 'REC-60009', custom: { renewalDate: null } })];
    const b = documentBlockers(p, gap, { issueDate: '2026-11-25' });
    expect(b.blockers.map((x) => [x.kind, x.code, x.title])).toEqual([['customer-data', 'CALCULATION_MISSING', '“Renews soon” cannot be worked out for some customers']]);
    expect(b.blockers[0].explanation).toBe('The document needs “Renews soon”, and it cannot be worked out from these customers’ data (for example: “Renewal date” is missing). The document is fine if the data is completed; otherwise change the calculation so it copes. It stops 1 customer.');
    expect(b.blockers[0].fixes.map((x) => x.kind)).toEqual(['scenario', 'link']);
    expect(customerBlockers(p, gap[0], { issueDate: '2026-11-25' })).toEqual([expect.objectContaining({ code: 'CALCULATION_MISSING', kind: 'customer-data', fields: ['custom.renewalDate'] })]);
    // a lookup with no row is a data-field (table) problem
    const req = ok(p, { type: 'UPDATE_NODE', nodeId: 'fee-note', patch: { required: true } });
    expect(documentBlockers(req, [people[2]], { issueDate: '2026-11-25' }).blockers.map((x) => [x.kind, x.code, x.title])).toEqual([['data-fields', 'LOOKUP_NO_MATCH', '“Late fee” finds no row in its lookup table for some customers']]);
  });
  it('coverage: reached as issued on the date, and a dated rule says why it is not', () => {
    const gaps = coverageGaps(p, people, { issueDate: '2026-12-15' });
    const newYear = gaps.find((g) => g.kind === 'rule' && g.targetId === 'R04')!;
    expect(newYear).toMatchObject({ scenario: null, reason: 'Not in effect on 15 Dec 2026: starts 1 Jan 2027.' });
    const winter = gaps.find((g) => g.kind === 'variant' && g.targetId === 'note-winter');
    expect(winter?.reason).toBeUndefined(); // reachable (a Plus customer whose renewal is not soon) — pinned as a test on that date
    expect(winter?.testCase?.issueDate).toBe('2026-12-15');
    expect(runTestCase(p, people, winter!.testCase!).pass).toBe(true);
  });
  it('Before & after compares two versions as issued on the date', () => {
    const after = ok(p, { type: 'SET_RULE_PERIOD', ruleId: 'R04', period: { from: '2026-12-01' } });
    const onDay = compareVersions(p, after, people, { issueDate: '2026-12-15' });
    expect(onDay.groups.message).toEqual(['REC-60002']);
    expect(compareVersions(p, after, people, { issueDate: '2027-01-15' }).groups.same).toEqual(['REC-60001', 'REC-60002', 'REC-60003']);
  });
  it('a pinned test runs as issued on its own date', () => {
    const expect1 = captureExpectation(p, people[1], {}, null, '2027-01-02');
    expect(expect1.selectedVariants).toEqual({ 'renewal-note': 'note-newyear' });
    const tc = { id: 'T01', name: 'New year', recordId: 'REC-60002', issueDate: '2027-01-02', expect: expect1 };
    expect(runTestCase(p, people, tc).pass).toBe(true);
    expect(runTestCase(p, people, { ...tc, issueDate: '2026-12-02' }).pass).toBe(false);
  });
  it('explains a rule that is not in effect, and one that could not be decided', () => {
    const r = resolve({ project: p, record: people[1], issueDate: '2026-12-15' });
    expect(explainInPlainWords(p, r, 'renewal-note').steps).toContain('The rule “New year offer for Basic” is not in effect. Not in effect on 15 Dec 2026: starts 1 Jan 2027.');
    const r2 = resolve({ project: p, record: gymMember({ custom: { renewalDate: null } }), issueDate: '2026-12-15' });
    expect(explainInPlainWords(p, r2, 'renewal-note').steps).toContain('The rule “Renews within two weeks” could not be decided: “Renewal date” is missing.');
  });
  it('the change summary names calculations, tables, periods and the document’s date', () => {
    let after = ok(depthProject(), { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'spinTotal', label: 'Spin total', type: 'money', expr: { op: 'sum', list: 'custom.sessions', column: 'priceCents' } } });
    after = ok(after, { type: 'SET_RULE_PERIOD', ruleId: 'R04', period: { from: '2027-02-01' } });
    const s = summarizeChanges(depthProject(), after, people);
    const rules = s.sections.find((x) => x.area === 'rules')!.items.join('\n');
    expect(rules).toContain('Calculation “Spin total” is now worked out as =SUM(custom.sessions.priceCents) (before: =SUM(custom.sessions.priceCents WHERE className = "Spin"))');
    expect(rules).toContain('is now in effect from 1 Feb 2027 (before: from 1 Jan 2027)');
  });
});

describe('the test-data generator', () => {
  const p = depthProject();
  it('reaches every outcome of rules that use a calculated field or a date, by varying inputs and the "as issued on" date', () => {
    const plan = planTestData(p, people, { outcomes: true, edges: false });
    expect(plan.summary.outcomes).toEqual({ total: 16, reached: 16 });
    const by = (title: string) => plan.customers[plan.targets.find((t) => t.title === title)!.customer!];
    // through a calculated value (renews within two weeks of the document's date)
    const soon = by('Rule “Renews within two weeks” applies');
    expect(resolve({ project: p, record: { ...soon.record, recordId: 'REC-69999' } as SyntheticRecord, issueDate: soon.issueDate }).result.selectedVariants['renewal-note']).toBe('note-soon');
    // through a date: the dated rule and the dated alternative are reached on days in their periods
    const newYear = by('Rule “New year offer for Basic” applies');
    expect(newYear.issueDate! >= '2027-01-01').toBe(true);
    const winter = by('Message “Winter offer” is chosen in “Message”');
    expect(winter.issueDate! >= '2026-12-01' && winter.issueDate! < '2027-03-01').toBe(true);
    // every generated customer states the date it is produced on (this document's date is given for each run)
    expect(plan.customers.every((c) => typeof c.issueDate === 'string')).toBe(true);
  });
  it('says plainly when an outcome cannot be reached through a calculation', () => {
    const never = ok(p, { type: 'UPSERT_RULE', rule: { ...p.rules.find((r) => r.id === 'R03')!, id: 'R08', title: 'Negative spin total', priority: 270, when: { op: 'lt', path: 'calc.spinTotal', value: -1 } } });
    const plan = planTestData(never, people, { outcomes: true, edges: false });
    const t = plan.targets.find((x) => x.targetId === 'R08')!;
    expect(t.customer).toBeNull();
    expect(t.reason).toBe('It depends on the calculation “Spin total”. No change to the fields it is worked out from, or to the document’s date, reached it within the search limit.');
  });
  it('documents without dates are planned exactly as before (no dates on customers)', () => {
    const plan = planTestData(depthProject({ dateFrom: 'field' }), people.map((r) => ({ ...r, custom: { ...r.custom, statementDate: '2026-11-25' } })), { outcomes: true, edges: false });
    expect(plan.customers.some((c) => c.issueDate)).toBe(false);
    expect(plan.summary.outcomes.reached).toBe(plan.summary.outcomes.total);
  });
});

it('run() helper keeps the projects through the command bus', () => {
  expect(run(depthProject(), { type: 'MOVE_CALCULATED_FIELD', key: 'renewSoon', index: 0 }).calculatedFields![0].key).toBe('renewSoon');
});
