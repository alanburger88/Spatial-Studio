import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Project, SyntheticRecord } from '@iss/model';
import {
  CUSTOMER_PLACEHOLDER, ScenarioEngine, answerBaseQuestion, buildLandscape, checkBaseQuestion, coverageGaps, customerBlockers, documentBlockerStatus,
  documentBlockers, exampleQuestions, modelVocabulary, questionFromModel, queryVocabulary, readBaseQuestion, scrubCustomers,
  type BaseQuestion, type KnownDataProblem, type QueryTarget,
} from '@iss/scenarios';
import { EXAMPLES } from '../../../scripts/audit-examples';
import { buildApp } from '../src/app';
import { readQuestionWithAi, type AssistModel, type AssistTask } from '../src/assistAi';

/**
 * Ask about all customers (wave 4, item 7): the built-in reader, the engine's answers on the four example documents,
 * the counts compared with what the Blockers screen, coverage and the Scenario Landscape say, the check of a model's
 * reading, and what a model is sent (never a customer's data or name). No live model is ever called.
 */

const ex = (id: string) => { const e = EXAMPLES.find((x) => x.id === id); if (!e) throw new Error(id); return { project: e.project as Project, records: e.customers as SyntheticRecord[] }; };
const ASTER = ex('aster-card-demo'), HARBOR = ex('harborcare-demo'), NORTH = ex('northwind-energy-demo'), MERID = ex('meridian-wealth-demo');
const ALL = { 'aster-card-demo': ASTER, 'harborcare-demo': HARBOR, 'northwind-energy-demo': NORTH, 'meridian-wealth-demo': MERID } as const;
const read = (d: { project: Project; records: SyntheticRecord[] }, s: string) => readBaseQuestion(d.project, s, { records: d.records, blockers: documentBlockers(d.project, d.records).blockers });
const nameOf = (r: SyntheticRecord) => `${r.customer.givenName} ${r.customer.familyName}`;
/** A card customer whose full name no other card customer has (two samples share "Taylor Rivers"). */
const UNIQUE = ASTER.records.find((r) => ASTER.records.filter((x) => nameOf(x) === nameOf(r)).length === 1)!;

/** Every string a customer's data holds that the document itself does not (names, addresses, account numbers, merchants, …). */
function customerValues(project: Project, records: SyntheticRecord[]): string[] {
  const doc = JSON.stringify(project);
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (v.length >= 4 && !doc.includes(v)) out.add(v); }
    else if (typeof v === 'number') { if (Math.abs(v) >= 1000 && !doc.includes(String(v))) out.add(String(v)); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  records.forEach(walk);
  return [...out];
}

/* ------------------------------------------------------------------ the built-in reader: at least 40 phrasings */

type Want =
  | { status: 'understood'; ask?: BaseQuestion['ask']; target: QueryTarget; butNot?: QueryTarget; language?: string; customer?: string; where?: BaseQuestion['where']; issuedOn?: string }
  | { status: 'ask'; atLeast: number }
  | { status: 'refused' | 'unknown' };
const alt = (nodeId: string, variantId: string): QueryTarget => ({ kind: 'alternative', nodeId, variantId });
const sec = (nodeId: string): QueryTarget => ({ kind: 'section', nodeId });
const stopped = (blockerKind?: string): QueryTarget => ({ kind: 'blocker', ...(blockerKind ? { blockerKind } : {}) } as QueryTarget);

const PHRASINGS: Array<[keyof typeof ALL, string, Want]> = [
  ['aster-card-demo', 'who gets the payment support offer', { status: 'understood', ask: 'who', target: alt('payment-guidance', 'payment-support-offer') }],
  ['aster-card-demo', 'Who gets "Payment support"?', { status: 'understood', target: alt('payment-guidance', 'payment-support-offer') }],
  ['aster-card-demo', 'how many customers get the payment reminder', { status: 'understood', ask: 'how-many', target: alt('payment-guidance', 'payment-reminder') }],
  ['aster-card-demo', 'How many get “Payment instructions”', { status: 'understood', ask: 'how-many', target: alt('payment-guidance', 'payment-standard') }],
  ['aster-card-demo', 'which customers get the relationship team', { status: 'understood', target: sec('relationship-manager') }],
  ['aster-card-demo', 'who sees the rewards summary?', { status: 'understood', target: sec('rewards-summary') }],
  ['aster-card-demo', 'WHO GETS THE REWARDS SUMARY', { status: 'understood', target: sec('rewards-summary') }],
  ['aster-card-demo', 'who gets the relationship team but not the rewards summary', { status: 'understood', target: sec('relationship-manager'), butNot: sec('rewards-summary') }],
  ['aster-card-demo', 'customers who get the relationship team and not the rewards summary', { status: 'understood', target: sec('relationship-manager'), butNot: sec('rewards-summary') }],
  ['aster-card-demo', 'who is stopped', { status: 'understood', ask: 'who', target: stopped() }],
  ['aster-card-demo', 'Who is stopped, and by what?', { status: 'understood', target: stopped() }],
  ['aster-card-demo', 'how many customers are blocked', { status: 'understood', ask: 'how-many', target: stopped() }],
  ['aster-card-demo', 'who is stopped by translations', { status: 'understood', target: stopped('wording') }],
  ['aster-card-demo', 'which customers cannot be issued', { status: 'understood', target: stopped() }],
  ['aster-card-demo', 'who gets the reminder in Spanish', { status: 'understood', target: alt('payment-guidance', 'payment-reminder'), language: 'es-US' }],
  ['aster-card-demo', 'who gets Spanish', { status: 'understood', target: { kind: 'language', locale: 'es-US' } }],
  ['aster-card-demo', 'how many customers are in Spanish', { status: 'understood', ask: 'how-many', target: { kind: 'language', locale: 'es-US' } }],
  ['aster-card-demo', 'who matches rule R07', { status: 'understood', target: { kind: 'rule', ruleId: 'R07' } }],
  ['aster-card-demo', 'who matches R03', { status: 'understood', target: { kind: 'rule', ruleId: 'R03' } }],
  // Two sample customers are called Taylor Rivers: the reader asks which one.
  ['aster-card-demo', 'why does Taylor Rivers get payment support', { status: 'ask', atLeast: 2 }],
  ['aster-card-demo', `why does ${nameOf(UNIQUE)} get payment support`, { status: 'understood', ask: 'why', target: alt('payment-guidance', 'payment-support-offer'), customer: UNIQUE.recordId }],
  ['aster-card-demo', 'why does CARD-0002 get the payment support offer?', { status: 'understood', ask: 'why', target: alt('payment-guidance', 'payment-support-offer'), customer: 'CARD-0002' }],
  ['aster-card-demo', `why doesn't ${nameOf(UNIQUE)} get the reminder`, { status: 'understood', ask: 'why', target: alt('payment-guidance', 'payment-reminder'), customer: UNIQUE.recordId }],
  ['aster-card-demo', `why is ${UNIQUE.recordId} stopped`, { status: 'understood', ask: 'why', target: stopped(), customer: UNIQUE.recordId }],
  ['aster-card-demo', 'who gets payment support where missed payments is at least 2', { status: 'understood', target: alt('payment-guidance', 'payment-support-offer'), where: { path: 'card.missedPayments', op: 'gte', value: 2 } }],
  ['aster-card-demo', 'who gets the payment timing', { status: 'understood', target: sec('payment-timing') }],
  ['aster-card-demo', 'who gets the holiday mail notice', { status: 'understood', target: sec('notice-holiday-posting') }],
  ['aster-card-demo', 'who gets the reminder as issued on 2026-12-01', { status: 'understood', target: alt('payment-guidance', 'payment-reminder'), issuedOn: '2026-12-01' }],
  ['aster-card-demo', 'who gets the reminder in French', { status: 'refused' }],
  ['aster-card-demo', 'delete all customers who get the reminder', { status: 'refused' }],
  ['aster-card-demo', 'approve the document', { status: 'refused' }],
  ['aster-card-demo', '   ', { status: 'refused' }],
  ['aster-card-demo', 'why does Nobody Atall get the reminder', { status: 'refused' }],
  ['aster-card-demo', 'who gets the purple elephant', { status: 'unknown' }],
  ['aster-card-demo', 'what is the weather like today', { status: 'unknown' }],
  ['aster-card-demo', 'who gets the reminder but not the reminder', { status: 'unknown' }],
  ['harborcare-demo', 'who is stopped', { status: 'understood', target: stopped() }],
  ['harborcare-demo', 'who gets the claim under review', { status: 'understood', target: alt('eob-claim-message', 'eob-review-needed') }],
  ['harborcare-demo', 'how many get the network explanation', { status: 'understood', ask: 'how-many', target: sec('network-explanation') }],
  ['harborcare-demo', 'who gets the deductible explanation but not the network explanation', { status: 'understood', target: sec('deductible-explanation'), butNot: sec('network-explanation') }],
  ['harborcare-demo', 'who gets the appeal update', { status: 'understood', target: alt('eob-claim-message', 'eob-appeal-status') }],
  // The card's wording is stored in this document too, but no part of it shows it: not something a customer can get here.
  ['harborcare-demo', 'who gets the payment reminder', { status: 'unknown' }],
  ['harborcare-demo', 'who gets the claim message as issued on 2026-12-01', { status: 'refused' }],
  ['northwind-energy-demo', 'who gets the winter heating help in Spanish', { status: 'understood', target: sec('winter-help'), language: 'es-US' }],
  ['northwind-energy-demo', 'who gets the electricity rate', { status: 'ask', atLeast: 2 }],
  ['northwind-energy-demo', 'who is stopped by customer data', { status: 'understood', target: stopped('customer-data') }],
  ['northwind-energy-demo', 'who gets the past due message', { status: 'understood', target: alt('payment-message', 'pay-overdue') }],
  ['northwind-energy-demo', 'how many get the higher use message', { status: 'understood', ask: 'how-many', target: sec('high-usage') }],
  ['northwind-energy-demo', 'who sees the rate notice', { status: 'understood', target: sec('rate-notice') }],
  ['meridian-wealth-demo', 'who gets the concentration notice but not the fall notice', { status: 'understood', target: sec('concentration-notice'), butNot: sec('fall-notice') }],
  ['meridian-wealth-demo', 'who is stopped by wording', { status: 'understood', target: stopped('wording') }],
  ['meridian-wealth-demo', 'who gets the conservative commentary', { status: 'understood', target: alt('commentary', 'commentary-conservative') }],
  ['meridian-wealth-demo', 'who gets the fee notice', { status: 'understood', target: sec('fee-notice') }],
  ['meridian-wealth-demo', 'who gets Spanish but not the fall notice', { status: 'understood', target: { kind: 'language', locale: 'es-US' }, butNot: sec('fall-notice') }],
  ['meridian-wealth-demo', 'who gets the tax documents in German', { status: 'refused' }],
];

describe('the built-in reader', () => {
  it(`reads ${PHRASINGS.length} phrasings on the four examples: understood, asked back, refused or left for a model`, () => {
    expect(PHRASINGS.length).toBeGreaterThanOrEqual(40);
    for (const [id, sentence, want] of PHRASINGS) {
      const r = read(ALL[id], sentence);
      expect(r.status, `${id}: ${sentence} → ${JSON.stringify(r)}`).toBe(want.status);
      if (want.status === 'ask' && r.status === 'ask') { expect(r.choices.length).toBeGreaterThanOrEqual(want.atLeast); continue; }
      if (want.status !== 'understood' || r.status !== 'understood') continue;
      const q = r.question;
      expect(q.target, sentence).toEqual(want.target);
      if (want.ask) expect(q.ask, sentence).toBe(want.ask);
      expect(q.butNot, sentence).toEqual(want.butNot);
      expect(q.language, sentence).toBe(want.language);
      expect(q.customer, sentence).toBe(want.customer);
      expect(q.where, sentence).toEqual(want.where);
      expect(q.issuedOn, sentence).toBe(want.issuedOn);
    }
  });

  it('asks back with the candidates as choices instead of guessing, and each choice is a complete question', () => {
    const r = read(NORTH, 'who gets the electricity rate');
    if (r.status !== 'ask') throw new Error(r.status);
    expect(r.choices.map((c) => c.question.target)).toEqual(expect.arrayContaining([alt('rate-notice', 'rate-upcoming'), alt('rate-notice', 'rate-new')]));
    for (const c of r.choices) expect(checkBaseQuestion(NORTH.project, c.question, { records: NORTH.records }).problems).toEqual([]);
    // Two customers with the same first name: the reader asks which one.
    const given = NORTH.records[0].customer.givenName;
    const twin = { ...NORTH.records[1], recordId: 'REC-69999', customer: { ...NORTH.records[1].customer, givenName: given, familyName: 'Twin' } } as SyntheticRecord;
    const r2 = readBaseQuestion(NORTH.project, `why does ${given} get the winter heating help`, { records: [...NORTH.records, twin] });
    expect(r2.status).toBe('ask');
    if (r2.status === 'ask') expect(r2.choices.map((c) => c.question.customer)).toEqual(expect.arrayContaining([NORTH.records[0].recordId, 'REC-69999']));
  });

  it('the example questions are made from each document’s own names and are all read without a model', () => {
    for (const [id, d] of Object.entries(ALL)) {
      const qs = exampleQuestions(d.project, d.records);
      expect(qs.length, id).toBeGreaterThanOrEqual(3);
      expect(qs, id).toContain('Who is stopped, and by what?');
      for (const q of qs) expect(read(d, q).status, `${id}: ${q}`).toBe('understood');
    }
  });
});

/* ------------------------------------------------------------------ the engine's answers on the four examples */

describe('the engine answers on every example', () => {
  it('Aster Card: who gets the payment support offer — none of the 70; the reason names the rule and its condition when someone does', () => {
    const r = read(ASTER, 'who gets the payment support offer');
    if (r.status !== 'understood') throw new Error(r.status);
    const a = answerBaseQuestion(ASTER.project, ASTER.records, r.question);
    expect([a.count, a.total]).toEqual([0, 70]);
    expect(a.headline).toBe('0 of 70 synthetic customers get “Payment support” in Payment guidance.');
    const rem = answerBaseQuestion(ASTER.project, ASTER.records, { ask: 'who', target: alt('payment-guidance', 'payment-reminder') });
    expect(rem.count).toBeGreaterThan(0);
    expect(rem.reasons[0].text).toMatch(/^Chosen by the rule “One missed payment — send a reminder” \(R02\), which applies when missed payments is 1\.$/);
    expect(rem.reasons.reduce((n, x) => n + x.count, 0)).toBe(rem.count);
    for (const id of rem.recordIds) expect(rem.perCustomer[id]).toBe('One missed payment — send a reminder');
  });

  it('Northwind: who gets the winter heating help in Spanish — 7 of 34, and the reason is the section’s own condition', () => {
    const r = read(NORTH, 'who gets the winter heating help in Spanish');
    if (r.status !== 'understood') throw new Error(r.status);
    const a = answerBaseQuestion(NORTH.project, NORTH.records, r.question);
    expect([a.count, a.total]).toEqual([7, 34]);
    expect(a.understood).toBe('Which customers get the section “Winter heating help”, among customers whose language is Spanish?');
    expect(a.reasons[0].text).toMatch(/^Shown when services on the account is one of “gas”, “dual”/);
    expect(a.notes[0]).toMatch(/whose language is Spanish are counted: 10 of 34/);
    // every customer listed really is Spanish-speaking and sees the section
    const eng = new ScenarioEngine(NORTH.project, NORTH.records);
    for (const id of a.recordIds) {
      const res = eng.resolveScenario({ recordId: id, overrides: {}, journeyCursor: null, profileId: 'paged-pdf' });
      expect(res.effectiveRecord.customer.locale).toBe('es-US');
      expect(res.semanticManifest.visibleNodeIds).toContain('winter-help');
    }
  });

  it('Meridian: who gets the concentration notice but not the fall notice — the overlap is left out and said', () => {
    const r = read(MERID, 'who gets the concentration notice but not the fall notice');
    if (r.status !== 'understood') throw new Error(r.status);
    const a = answerBaseQuestion(MERID.project, MERID.records, r.question);
    const conc = answerBaseQuestion(MERID.project, MERID.records, { ask: 'who', target: sec('concentration-notice') });
    const fall = answerBaseQuestion(MERID.project, MERID.records, { ask: 'who', target: sec('fall-notice') });
    expect(a.recordIds).toEqual(conc.recordIds.filter((x) => !fall.recordIds.includes(x)));
    expect([a.count, a.total]).toEqual([16, 34]);
    expect(a.notes[0]).toBe('1 customer who gets it also gets the section “Fall in value notice”, so is left out.');
  });

  it('HarborCare: who is stopped — nobody of 30; why does a named customer get a message — from the engine’s trace', () => {
    const r = read(HARBOR, 'who is stopped');
    if (r.status !== 'understood') throw new Error(r.status);
    const a = answerBaseQuestion(HARBOR.project, HARBOR.records, r.question);
    expect([a.count, a.total, a.byBlocker]).toEqual([0, 30, []]);
    const cust = HARBOR.records.find((x) => x.claims?.[0]?.status === 'denied-pending-review')!;
    const w = read(HARBOR, `why does ${nameOf(cust)} get the claim under review`);
    if (w.status !== 'understood') throw new Error(w.status);
    const why = answerBaseQuestion(HARBOR.project, HARBOR.records, w.question);
    expect(why.why?.gets).toBe(true);
    expect(why.why?.headline).toMatch(/^Yes\. /);
    expect(why.why?.ruleIds).toContain('R14');
  });

  it('a "why" for a customer who does not get it says no, and why, with the rules that decided instead', () => {
    const a = answerBaseQuestion(ASTER.project, ASTER.records, { ask: 'why', target: alt('payment-guidance', 'payment-support-offer'), customer: 'CARD-0002' });
    expect(a.why?.gets).toBe(false);
    expect(a.why?.headline).toMatch(/^No\. Taylor Rivers does not get “Payment support”/);
    expect(a.why?.steps.join(' ')).toMatch(/Customer asked for payment assistance/);
  });

  it('a field condition and "as issued on" narrow the customers and are stated', () => {
    const a = answerBaseQuestion(ASTER.project, ASTER.records, { ask: 'who', target: { kind: 'rule', ruleId: 'R02' }, where: { path: 'card.missedPayments', op: 'eq', value: 1 } });
    const all = answerBaseQuestion(ASTER.project, ASTER.records, { ask: 'who', target: { kind: 'rule', ruleId: 'R02' } });
    expect(a.recordIds).toEqual(all.recordIds);
    expect(a.notes[0]).toMatch(/^Only customers whose missed payments is 1 are counted/);
    const dated = answerBaseQuestion(NORTH.project, NORTH.records, { ask: 'who', target: alt('rate-notice', 'rate-new'), issuedOn: '2027-06-01' });
    expect(dated.basis.issueDate).toBe('2027-06-01');
    expect(dated.notes).toContain('Worked out as issued on 2027-06-01.');
  });
});

/* ------------------------------------------------------------------ the same numbers as Blockers, coverage and the Landscape */

describe('counts agree with the Blockers screen, coverage and the Scenario Landscape', () => {
  for (const [id, d] of Object.entries(ALL)) {
    it(`${id}: blockers`, () => {
      const blockers = documentBlockers(d.project, d.records);
      const stoppedQ = answerBaseQuestion(d.project, d.records, { ask: 'who', target: stopped() });
      expect(stoppedQ.count).toBe(blockers.stopped);
      expect(stoppedQ.total).toBe(blockers.checked);
      for (const kind of ['wording', 'rules', 'layout', 'data-fields', 'customer-data'] as const) {
        const want = new Set(blockers.blockers.filter((b) => b.kind === kind).flatMap((b) => b.recordIds));
        expect(answerBaseQuestion(d.project, d.records, { ask: 'who', target: stopped(kind) }).count, kind).toBe(want.size);
      }
      for (const b of blockers.blockers) expect(answerBaseQuestion(d.project, d.records, { ask: 'who', target: { kind: 'blocker', blockerId: b.id } }).recordIds).toEqual(b.recordIds);
      // The screen's own result (with known data problems set aside) is counted exactly as the screen counts it.
      const data = blockers.blockers.find((b) => b.kind === 'customer-data');
      if (data) {
        const known: KnownDataProblem[] = [{ blockerId: data.id, recordId: data.recordIds[0], reason: 'test', markedBy: null, markedAt: '2026-11-14T00:00:00.000Z' }];
        const screen = documentBlockerStatus(d.project, d.records, { known });
        const held = { checked: screen.checked, blockers: screen.blockers };
        expect(answerBaseQuestion(d.project, d.records, { ask: 'who', target: stopped() }, { blockers: held }).count).toBe(screen.stopped);
      }
      // One customer at a time: the same causes.
      for (const r of d.records.slice(0, 12)) {
        const mine = customerBlockers(d.project, r).map((b) => b.title).sort();
        const why = answerBaseQuestion(d.project, d.records, { ask: 'why', target: stopped(), customer: r.recordId });
        expect(why.why!.steps.map((s) => s.replace(/^Stopped by: /, '').replace(/\.$/, '')).sort()).toEqual(mine);
      }
    });

    it(`${id}: the Scenario Landscape and its language filter`, () => {
      const engine = new ScenarioEngine(d.project, d.records);
      const land = buildLandscape(engine, {});
      const vocab = queryVocabulary(d.project);
      for (const m of vocab.messages.filter((x) => d.project.nodes.find((n) => n.id === x.nodeId)?.type === 'variant-set')) {
        for (const a of m.alternatives) {
          const want = land.clusters.filter((c) => c.signature.variants[m.nodeId] === a.id).reduce((n, c) => n + c.count, 0);
          expect(answerBaseQuestion(d.project, d.records, { ask: 'how-many', target: alt(m.nodeId, a.id) }, { engine }).count, `${m.nodeId}/${a.id}`).toBe(want);
        }
      }
      for (const s of vocab.sections) {
        const node = d.project.nodes.find((n) => n.id === s.nodeId)!;
        if (node.type !== 'conditional-region') continue;
        const parts = node.variantIds ?? [];
        const want = land.clusters.filter((c) => c.signature.sections.some((x) => parts.includes(x))).reduce((n, c) => n + c.count, 0);
        expect(answerBaseQuestion(d.project, d.records, { ask: 'how-many', target: sec(s.nodeId) }, { engine }).count, s.nodeId).toBe(want);
      }
      for (const l of vocab.languages) {
        const want = buildLandscape(engine, { filters: { language: l.code } }).evaluated;
        expect(answerBaseQuestion(d.project, d.records, { ask: 'how-many', target: { kind: 'language', locale: l.code } }, { engine }).count, l.code).toBe(want);
      }
    });

    it(`${id}: coverage — an outcome nobody gets is exactly a coverage gap`, () => {
      const gaps = coverageGaps(d.project, d.records, { maxCandidates: 1 });
      const gapIds = new Set(gaps.map((g) => g.id));
      const vocab = queryVocabulary(d.project);
      const checks: Array<[string, QueryTarget]> = [
        ...vocab.rules.map((r) => [`rule:${r.id}`, { kind: 'rule', ruleId: r.id }] as [string, QueryTarget]),
        ...vocab.messages.flatMap((m) => m.alternatives.map((a) => [`variant:${m.nodeId}/${a.id}`, alt(m.nodeId, a.id)] as [string, QueryTarget])),
        ...vocab.sections.map((s) => [`section:${s.nodeId}`, sec(s.nodeId)] as [string, QueryTarget]),
      ];
      const known = new Set(gaps.map((g) => g.id.split(':')[0]));
      expect(known.size === 0 || [...known].every((k) => ['rule', 'variant', 'section'].includes(k))).toBe(true);
      let compared = 0;
      for (const [key, target] of checks) {
        const n = answerBaseQuestion(d.project, d.records, { ask: 'how-many', target }).count;
        if (gapIds.has(key)) { expect(n, key).toBe(0); compared++; }
        else if (n === 0) {
          // Not a gap but nobody gets it: only allowed for a target coverage does not list at all (always shown, or not a target).
          expect(gaps.some((g) => g.targetId === (target.kind === 'rule' ? target.ruleId : target.kind === 'alternative' ? target.variantId : (target as { nodeId: string }).nodeId)), key).toBe(false);
        }
      }
      expect(compared).toBe(gaps.filter((g) => checks.some(([k]) => k === g.id)).length);
    });
  }
});

/* ------------------------------------------------------------------ a model's reading: a fixed shape, the document's names only */

describe('a model’s reading is checked against a fixed shape and the document', () => {
  const base = { understood: true, ask: 'who', target_kind: 'section', target_id: 'concentration-notice', but_not_kind: '', but_not_id: '', where_field: '', where_op: '', where_value: '', language: '', names_customer: false, issued_on: '' };
  it('accepts what the document has and refuses anything it does not', () => {
    const p = MERID.project;
    expect(questionFromModel(p, base).question).toEqual({ ask: 'who', target: sec('concentration-notice') });
    expect(questionFromModel(p, { ...base, but_not_kind: 'section', but_not_id: 'fall-notice', language: 'es-US' }).question).toEqual({ ask: 'who', target: sec('concentration-notice'), butNot: sec('fall-notice'), language: 'es-US' });
    expect(questionFromModel(p, { ...base, target_kind: 'alternative', target_id: 'commentary-growth' }).question?.target).toEqual(alt('commentary', 'commentary-growth'));
    expect(questionFromModel(p, { ...base, ask: 'why', names_customer: true }).question?.customer).toBe(CUSTOMER_PLACEHOLDER);
    for (const bad of [
      { ...base, target_kind: 'rule', target_id: 'R99' },
      { ...base, target_kind: 'alternative', target_id: 'made-up' },
      { ...base, target_kind: 'section', target_id: 'payment-guidance' },
      { ...base, target_kind: 'script', target_id: 'x' },
      { ...base, language: 'fr-FR' },
      { ...base, where_field: 'customer.ssn', where_op: 'eq', where_value: '1' },
      { ...base, where_field: 'custom.riskProfile', where_op: 'eq', where_value: 'reckless' },
      { ...base, where_field: 'custom.riskProfile', where_op: 'like', where_value: 'growth' },
      { ...base, issued_on: 'next tuesday' },
      { ...base, blockers: 'x', ask: 'delete' },
      { ...base, understood: false },
      { ...base, ask: 'who', names_customer: true },
      { ...base, ask: 'why', names_customer: false },
      { ...base, target_kind: 'blocker', target_id: 'everything' },
      null, 'who gets it', [],
    ]) expect(questionFromModel(p, bad).question, JSON.stringify(bad)).toBeNull();
    expect(questionFromModel(HARBOR.project, { ...base, target_id: 'network-explanation', issued_on: '2026-12-01' }).question).toBeNull(); // no date in this document
  });

  it('checkBaseQuestion: a customer must be one of the document’s, and only a model may name the placeholder', () => {
    const q = { ask: 'why', target: sec('winter-help'), customer: NORTH.records[0].recordId };
    expect(checkBaseQuestion(NORTH.project, q, { records: NORTH.records }).question).not.toBeNull();
    expect(checkBaseQuestion(NORTH.project, { ...q, customer: 'CARD-0001' }, { records: NORTH.records }).question).toBeNull();
    expect(checkBaseQuestion(NORTH.project, { ...q, customer: CUSTOMER_PLACEHOLDER }, { records: NORTH.records }).question).toBeNull();
    expect(checkBaseQuestion(NORTH.project, { ...q, customer: CUSTOMER_PLACEHOLDER }, { records: NORTH.records, allowPlaceholder: true }).question).not.toBeNull();
  });

  it('customer names and ids are taken out of a sentence, and remembered for the studio', () => {
    const r = NORTH.records[3];
    const s = scrubCustomers(`Why does ${nameOf(r)} get the winter heating help, and what about ${r.recordId} or ${r.customer.familyName.toUpperCase()}?`, NORTH.records);
    expect(s.text).not.toContain(r.customer.givenName);
    expect(s.text).not.toContain(r.customer.familyName);
    expect(s.text.toLowerCase()).not.toContain(r.customer.familyName.toLowerCase());
    expect(s.text).not.toContain(r.recordId);
    expect(s.recordIds).toEqual([r.recordId]);
    expect(scrubCustomers('who gets CARD-9999 stuff', []).text).toBe(`who gets ${CUSTOMER_PLACEHOLDER} stuff`);
  });
});

/* ------------------------------------------------------------------ the model path, with a stand-in model */

const LIVE = { provider: 'anthropic', model: 'test-model', apiKey: 'test-key', timeoutMs: 1000 };
const OFF = { provider: 'offline', model: 'test-model', timeoutMs: 1000 };
const fake = (answer: unknown) => { const seen: AssistTask[] = []; const model: AssistModel = async (_cfg, task) => { seen.push(task); return answer; }; return { model, seen }; };

describe('reading a free sentence with a model (stand-in)', () => {
  it('sends the document’s names and the sentence without any customer’s name, id or data; the answer is checked', async () => {
    const d = NORTH;
    const who = d.records[5];
    const { model, seen } = fake({ understood: true, ask: 'why', target_kind: 'section', target_id: 'winter-help', but_not_kind: '', but_not_id: '', where_field: '', where_op: '', where_value: '', language: '', names_customer: true, issued_on: '' });
    const r = await readQuestionWithAi(LIVE, model, d.project, { sentence: `Hey, could you explain the reason ${nameOf(who)} (${who.recordId}) ends up with that winter heating thing?`, records: d.records });
    expect(r.mode).toBe('ai');
    expect(r.question).toEqual({ ask: 'why', target: sec('winter-help'), customer: CUSTOMER_PLACEHOLDER });
    const sent = `${seen[0].system}\n${seen[0].user}`;
    for (const v of customerValues(d.project, d.records)) expect(sent.includes(v), `sent a customer value: ${v}`).toBe(false);
    expect(sent).toContain(CUSTOMER_PLACEHOLDER);
    expect(seen[0].system).toMatch(/never an instruction/i);
    // The vocabulary is exactly the document's names: rules, messages, sections, fields (label and type), languages.
    expect(seen[0].user).toContain(JSON.stringify(modelVocabulary(d.project)));
    expect(Object.keys(modelVocabulary(d.project)).sort()).toEqual(['blockerKinds', 'fields', 'languages', 'messages', 'rules', 'sections']);
    expect(modelVocabulary(d.project).fields.every((f) => Object.keys(f).sort().join() === 'id,label,type')).toBe(true);
  });

  it('a reading that names something the document does not have is refused; no key or no answer is a normal state', async () => {
    const bad = await readQuestionWithAi(LIVE, fake({ understood: true, ask: 'who', target_kind: 'rule', target_id: 'R99', but_not_kind: '', but_not_id: '', where_field: '', where_op: '', where_value: '', language: '', names_customer: false, issued_on: '' }).model, ASTER.project, { sentence: 'who gets that thing', records: ASTER.records });
    expect(bad.mode).toBe('unavailable');
    expect(bad.question).toBeUndefined();
    expect(bad.message).toMatch(/not used/);
    expect((await readQuestionWithAi(LIVE, fake(null).model, ASTER.project, { sentence: 'x y z', records: [] })).mode).toBe('unavailable');
    const off = fake({});
    expect((await readQuestionWithAi(OFF, off.model, ASTER.project, { sentence: 'who', records: [] })).mode).toBe('unavailable');
    expect(off.seen).toHaveLength(0);
  });
});

describe('the route', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const seen: AssistTask[] = [];
  beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-ask-')), logger: false, assistModel: async (_c, t) => { seen.push(t); return null; } }); });
  afterAll(async () => { await ctx.app.close(); });
  it('answers 200 "unavailable" without a key, refuses a missing or long sentence, and never calls the model offline', async () => {
    const url = '/api/v1/projects/northwind-energy-demo/assist/base-question';
    const r = await ctx.app.inject({ method: 'POST', url, payload: { sentence: 'who would be most upset', forceOffline: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json().mode).toBe('unavailable');
    expect(r.json().message).toMatch(/AI/);
    expect((await ctx.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url, payload: { sentence: 'x'.repeat(301) } })).statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
