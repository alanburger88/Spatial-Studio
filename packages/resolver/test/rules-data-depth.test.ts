import { describe, expect, it } from 'vitest';
import { applyCommand, digestOf, sha256Hex, type Command, type Project } from '../../model/src';
import { recordById, seedProjects } from '../../model/src/fixtures';
import { renderEmail, renderInteractiveHtml, renderSms } from '../../renderers/src';
import { gymMember, gymProject, run, visibleText } from '../../model/test/helpers/customProject';
import { depthProject } from '../../model/test/helpers/depthProject';
import { buildProofRecord, explainNode, indexTree, proofDecisions, proofRecordProblems, resolve, verifyProof, type ProofOutput, type Resolution } from '../src';

const ON = '2026-11-25';
const res = (p: Project, opts: { custom?: Record<string, unknown>; date?: string | null } = {}): Resolution => resolve({ project: p, record: gymMember({ custom: opts.custom }), ...(opts.date === null ? {} : { issueDate: opts.date ?? ON }) });
const text = (r: Resolution, id: string): string => (indexTree(r.root).get(id)?.text ?? []).map((b) => (b.inlines ?? []).map((i) => i.text).join('')).join('|');
const blocking = (r: Resolution) => r.findings.filter((f) => f.severity === 'blocking').map((f) => f.code);

describe('documents without the new features resolve exactly as before', () => {
  it('a date given for the run is ignored by a document that does not use dates (same run id, same everything)', () => {
    const [card, eob] = seedProjects();
    for (const [p, id] of [[card, 'CARD-0001'], [eob, 'EOB-0001']] as const) {
      const a = resolve({ project: p, record: recordById(id)! });
      const b = resolve({ project: p, record: recordById(id)!, issueDate: '2027-01-01' });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect('documentDate' in a || 'calculated' in a).toBe(false);
    }
  });
});

describe('calculated fields in the resolver', () => {
  const p = depthProject();
  it('are worked out once per resolution and used in rules, wording, table footers, email and SMS', () => {
    const r = res(p);
    expect(Object.fromEntries(Object.entries(r.calculated!).map(([k, c]) => [k, c.value]))).toEqual({ daysToRenewal: 6, spinTotal: 1200, feePerVisit: 544, lateFee: 1000, bonusRate: 1.5, renewSoon: true });
    // a rule on a calculated field decides the message
    expect(r.result.selectedVariants['renewal-note']).toBe('note-soon');
    expect(r.trace.find((t) => t.ruleId === 'R03')).toMatchObject({ outcome: 'selected', predicateInputs: { 'calc.renewSoon': true } });
    // wording, formatted like data fields in the document language
    expect(text(r, 'fee-note')).toBe('Late fee: $10.00. Per visit: $5.44. Bonus rate: 1.5.');
    expect(text(r, 'renewal-note')).toBe('Your plan renews in 6 days.');
    // the table footer shows the calculated amount, and every output carries it
    expect(indexTree(r.root).get('sessions')!.table!.totalCents).toBe(1200);
    expect(r.semanticManifest.tableTotalsCents.sessions).toBe(1200);
    expect(renderInteractiveHtml(r, p)).toContain('data-table-total-cents="1200"');
    // email and SMS
    expect(r.channelTexts.sms).toBe('Hi Robin, your plan renews in 6 days. {{link}}');
    expect(renderSms(r, p).text).toMatch(/your plan renews in 6 days/);
    const email = visibleText(renderEmail(r, p).html);
    expect(email).toContain('Your plan renews in 6 days.');
    expect(email).toContain('Total $12.00');
    // inline condition on a calculated value
    expect(indexTree(r.root).get('spin-note')!.visible).toBe(true);
    expect(res(p, { custom: { sessions: [] } }).root.children.find((c) => c.id === 'spin-note')!.visible).toBe(false);
  });
  it('are formatted in the document language', () => {
    const es = run(run(p, { type: 'ADD_LANGUAGE', locale: 'es-US' }), { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'bonusRate', label: 'Bonus rate', type: 'number', expr: { op: 'number', value: 1234.5 } } });
    const r = resolve({ project: es, record: gymMember({ customer: { locale: 'es-US' } }), issueDate: ON });
    expect(r.locale).toBe('es-US');
    expect(text(r, 'fee-note')).toMatch(/Bonus rate: 1,234\.5\./);
  });
  it('a missing value behaves like a missing data field, with a finding that says why; blocking where the document needs it', () => {
    // shown only in wording: a warning, and the document is still produced
    const r = res(p, { custom: { visits: 0 } });
    expect(text(r, 'fee-note')).toBe('Late fee: $10.00. Per visit: —. Bonus rate: 1.5.');
    const f = r.findings.find((x) => x.code === 'CALCULATION_MISSING')!;
    expect(f).toMatchObject({ severity: 'warning', source: 'binding', details: { path: 'calc.feePerVisit', reason: 'division-by-zero', input: 'custom.visits', usedBy: ['Fee note'] } });
    expect(f.message).toBe('“Fee per visit” could not be worked out for this customer: “Visits this month” is zero, and nothing can be divided by zero. It is used by Fee note.');
    expect(blocking(r)).toEqual([]);
    // needed by a rule that must decide: blocking
    const r2 = res(p, { custom: { renewalDate: null } });
    expect(r2.trace.find((t) => t.ruleId === 'R03')).toMatchObject({ outcome: 'not-matched', undecided: { path: 'calc.renewSoon' } });
    expect(r2.findings.find((x) => x.code === 'CALCULATION_MISSING')).toMatchObject({ severity: 'blocking', details: { path: 'calc.renewSoon', reason: 'input-missing', input: 'custom.renewalDate', via: ['daysToRenewal'] } });
    // no lookup row and no default row: its own code
    const r3 = res(p, { custom: { tier: 'pro' } });
    expect(r3.findings.find((x) => x.code === 'LOOKUP_NO_MATCH')).toMatchObject({ severity: 'warning', details: { path: 'calc.lateFee', reason: 'no-lookup-row' } });
    // in a required part: blocking
    const req = run(p, { type: 'UPDATE_NODE', nodeId: 'fee-note', patch: { required: true } });
    expect(blocking(res(req, { custom: { tier: 'pro' } }))).toEqual(['LOOKUP_NO_MATCH']);
  });
  it('the explanation says how a calculated value was reached, by name', () => {
    const r = res(p);
    const e = explainNode(r, 'renewal-note');
    expect(e.summary).toContain('“Renews soon” is true, worked out from “Days to renewal”.');
    expect(explainNode(r, 'fee-note').summary).toContain('“Fee per visit” is 544, worked out from “Monthly fee”, “Visits this month”.');
    expect(explainNode(res(p, { custom: { visits: 0 } }), 'fee-note').summary).toContain('“Fee per visit” could not be worked out from “Monthly fee”, “Visits this month”: “Visits this month” is zero');
  });
});

describe('the document’s date and effective periods', () => {
  const p = depthProject();
  it('rules, alternatives and sections outside their period are absent, with the dates; boundary days included/excluded', () => {
    // a dated rule starts on its "from" day (included)
    const basic = { tier: 'basic', renewalDate: '2027-06-01' };
    expect(res(p, { custom: basic, date: '2026-12-31' }).result.selectedVariants['renewal-note']).toBe('renewal-note-default');
    const before = res(p, { custom: basic, date: '2026-12-31' }).trace.find((t) => t.ruleId === 'R04')!;
    expect(before).toMatchObject({ outcome: 'out-of-scope', matched: false, note: 'Not in effect on 31 Dec 2026: starts 1 Jan 2027.', period: { period: { from: '2027-01-01' }, issueDate: '2026-12-31' } });
    expect(res(p, { custom: basic, date: '2027-01-01' }).result.selectedVariants['renewal-note']).toBe('note-newyear');
    // an alternative can only be chosen in its period: from 1 Dec 2026 until 1 Mar 2027 (not included)
    const plus = { tier: 'plus', renewalDate: '2027-06-01' };
    expect(res(p, { custom: plus, date: '2026-11-30' }).result.selectedVariants['renewal-note']).toBe('renewal-note-default');
    expect(res(p, { custom: plus, date: '2026-12-01' }).result.selectedVariants['renewal-note']).toBe('note-winter');
    expect(res(p, { custom: plus, date: '2027-02-28' }).result.selectedVariants['renewal-note']).toBe('note-winter');
    const after = res(p, { custom: plus, date: '2027-03-01' });
    expect(after.result.selectedVariants['renewal-note']).toBe('renewal-note-default');
    expect(after.result.matchedRuleIds).not.toContain('R05');
    expect(after.trace.find((t) => t.ruleId === 'R05')!.note).toBe('The alternative “Winter offer” it chooses is not in effect. Not in effect on 1 Mar 2027: ended 1 Mar 2027 (its last day was the day before).');
    // a conditional section is not shown outside its period ("until" is the first day it no longer applies)
    expect(indexTree(res(p, { date: '2027-05-31' }).root).get('spin-note')!.visible).toBe(true);
    const gone = indexTree(res(p, { date: '2027-06-01' }).root).get('spin-note')!;
    expect(gone).toMatchObject({ visible: false, hiddenReason: 'Not in effect on 1 Jun 2027: ended 1 Jun 2027 (its last day was the day before).' });
    expect(explainNode(res(p, { date: '2027-06-01' }), 'spin-note').summary).toContain('Not in effect on 1 Jun 2027');
  });
  it('the document’s date is a value: ISSUE_DATE() in calculations, document.date in conditions and wording', () => {
    const q = run(run(p, { type: 'INSERT_NODE', node: { id: 'date-line', type: 'rich-text', name: 'Date line', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Issued ' }, { type: 'token', attrs: { path: 'document.date' } }] }] }, visibleWhen: { op: 'gte', path: 'document.date', value: '2027-01-01' } }, parentId: 'doc-root' }), { type: 'UPSERT_RULE', rule: { ...p.rules.find((r) => r.id === 'R05')!, id: 'R06', priority: 140, when: { op: 'lt', path: 'document.date', value: '2026-01-01' } } });
    expect(indexTree(res(q, { date: '2026-12-31' }).root).get('date-line')!.visible).toBe(false);
    expect(text(res(q, { date: '2027-01-15' }), 'date-line')).toBe('Issued Jan 15, 2027');
  });
  it('the date comes from a data field, or is given for the run (which then takes precedence)', () => {
    const f = depthProject({ dateFrom: 'field' });
    const member = gymMember({ custom: { statementDate: '2026-11-25' } });
    const fromData = resolve({ project: f, record: member });
    expect(fromData.documentDate).toEqual({ date: '2026-11-25', source: 'field', given: false });
    expect(fromData.calculated!.daysToRenewal.value).toBe(6);
    const given = resolve({ project: f, record: member, issueDate: '2026-11-20' });
    expect(given.documentDate).toEqual({ date: '2026-11-20', source: 'field', given: true });
    expect(given.calculated!.daysToRenewal.value).toBe(11);
  });
  it('no date available is a blocker in plain words; an invalid date given for the run too', () => {
    const r = res(p, { date: null });
    expect(r.documentDate).toEqual({ date: null, source: 'run', given: false });
    expect(r.findings.find((f) => f.code === 'DOCUMENT_DATE_MISSING')).toMatchObject({ severity: 'blocking', message: 'This document’s content depends on its date, and this customer has none.', suggestion: 'Give the date for the run (“as issued on”).' });
    expect(r.findings.some((f) => f.code === 'CALCULATION_MISSING')).toBe(false); // the date is the one root cause
    const f = depthProject({ dateFrom: 'field' });
    expect(resolve({ project: f, record: gymMember() }).findings.find((x) => x.code === 'DOCUMENT_DATE_MISSING')).toMatchObject({ severity: 'blocking', suggestion: 'Fill in “Statement date” for this customer, or give a date for the run.', details: { input: 'custom.statementDate' } });
    expect(blocking(res(p, { date: '2026-02-30' }))).toEqual(['ISSUE_DATE_INVALID']);
    // a document that only shows the date in wording: a warning, not a blocker
    const g = run(run(gymProject(), { type: 'SET_DOCUMENT_DATE', source: { source: 'run' } }), { type: 'UPDATE_NODE', nodeId: 'heading', patch: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'token', attrs: { path: 'document.date' } }] }] } } });
    expect(resolve({ project: g, record: gymMember() }).findings.find((x) => x.code === 'DOCUMENT_DATE_MISSING')?.severity).toBe('warning');
  });
  it('the run id includes the document’s date when it was given for the run, and only then', () => {
    const a = res(p, { date: '2026-11-25' });
    const b = res(p, { date: '2026-11-26' });
    expect(a.runId).not.toBe(b.runId);
    expect(res(p, { date: '2026-11-25' }).runId).toBe(a.runId);
    const f = depthProject({ dateFrom: 'field' });
    const m1 = gymMember({ custom: { statementDate: '2026-11-25' } });
    const fromData = resolve({ project: f, record: m1 });
    const sameDayGiven = resolve({ project: f, record: m1, issueDate: '2026-11-25' });
    expect(sameDayGiven.contentDigest).toBe(fromData.contentDigest);
    expect(sameDayGiven.runId).not.toBe(fromData.runId);
  });
});

describe('proof records with a date', () => {
  const p = depthProject();
  const release = { id: 'gym-notice-r1', documentId: 'gym-notice', number: 1, contentDigest: digestOf(p) };
  const outputs: ProofOutput[] = [{ channel: 'sms', kind: 'bytes', sha256: sha256Hex('sms'), size: 3 }];
  const record = gymMember();
  const proofOn = (date?: string, project = p) => buildProofRecord({ release, resolution: resolve({ project, record, ...(date ? { issueDate: date } : {}) }), record, producer: 'runtime', producedAt: '2026-11-25T10:00:00.000Z', outputs });
  it('keeps the date given for the run, and is valid; records without it stay valid', () => {
    const proof = proofOn(ON);
    expect(proof.issueDate).toBe(ON);
    expect(proofRecordProblems(proof)).toEqual([]);
    expect(proofRecordProblems({ ...proof, issueDate: '25/11/2026' })).toEqual(['“issueDate” must be a date written as YYYY-MM-DD.']);
    const [card] = seedProjects();
    const undated = buildProofRecord({ release, resolution: resolve({ project: card, record: recordById('CARD-0001')! }), record: recordById('CARD-0001')!, producer: 'studio', producedAt: '2026-11-25T10:00:00.000Z', outputs });
    expect('issueDate' in undated).toBe(false);
    expect(proofRecordProblems(undated)).toEqual([]);
    // a date taken from the customer's data is not kept (it is part of the data fingerprint)
    const f = depthProject({ dateFrom: 'field' });
    const m = gymMember({ custom: { statementDate: ON } });
    expect('issueDate' in buildProofRecord({ release, resolution: resolve({ project: f, record: m }), record: m, producer: 'runtime', producedAt: '2026-11-25T10:00:00.000Z', outputs })).toBe(false);
  });
  it('verifies with the same date, and says so when the date differs', () => {
    const proof = proofOn(ON);
    const again = (date?: string) => ({ release, resolution: resolve({ project: p, record, ...(date ? { issueDate: date } : {}) }), record, outputs });
    expect(verifyProof(proof, again(ON))).toEqual([]);
    const other = verifyProof(proof, again('2027-01-02'));
    expect(other[0]).toEqual({ kind: 'date', message: 'The document was produced as issued on 25 Nov 2026; it is checked as issued on 2 Jan 2027.' });
    const undated = verifyProof(proof, again()).map((d) => d.kind);
    expect(undated[0]).toBe('date');
    expect(undated).toContain('blocked');
  });
  it('holds no customer values, also with calculated fields in play (decisions are ids only)', () => {
    const rich = gymMember({ custom: { planName: 'Platinum Saver Plan', monthlyFeeCents: 7777, visits: 3, renewalDate: '2026-12-09' }, customer: { givenName: 'Philippa', familyName: 'Vandermeer' } });
    const r = resolve({ project: p, record: rich, issueDate: ON });
    const proof = buildProofRecord({ release, resolution: r, record: rich, producer: 'studio', producedAt: '2026-11-25T10:00:00.000Z', outputs });
    const textOf = JSON.stringify(proof);
    expect(r.calculated!.feePerVisit.value).toBe(2592);
    for (const v of ['Platinum Saver Plan', 'Philippa', 'Vandermeer', '2026-12-09', '$25.92', 'Platinum']) expect(textOf.includes(v), v).toBe(false);
    for (const d of proofDecisions(r)) expect(Object.keys(d).sort()).toEqual(['nodeId', 'ruleIds', 'variantId']);
  });
});

describe('commands keep projects valid for the resolver', () => {
  it('a project with a calculation the resolver cannot evaluate never crashes it', () => {
    // A cycle can only come from a file that skipped the checks; the values are missing, never a crash.
    const p = depthProject();
    const broken: Project = { ...p, calculatedFields: [...p.calculatedFields!, { key: 'loopA', label: 'Loop A', type: 'number', expr: { op: 'field', path: 'calc.loopB' } }, { key: 'loopB', label: 'Loop B', type: 'number', expr: { op: 'field', path: 'calc.loopA' } }] };
    const r = res(broken);
    expect(r.calculated!.loopA).toMatchObject({ value: null, missing: { code: 'invalid' } });
    const cmd: Command = { type: 'UPSERT_CALCULATED_FIELD', field: broken.calculatedFields![6] };
    expect(applyCommand(p, cmd).ok).toBe(false);
  });
});
