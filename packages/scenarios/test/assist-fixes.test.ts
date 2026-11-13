import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCommand, richFromMarkup, type Command, type Project, type SyntheticRecord } from '@iss/model';
import { resolve, type Finding } from '@iss/resolver';
import { EXPECTED_SCENARIOS, RECORDS, recordById, seedProjects } from '../../model/src/fixtures';
import { fixImpact, groupFindings, proposeFixes, safeFixPlan } from '../src/assist/fixes';
import type { FixProposal } from '../src/assist/types';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const apply = (p: Project, x: FixProposal): Project => run(p, { type: 'BATCH', label: x.title, commands: x.commands ?? [] });
const rec = (id: string): SyntheticRecord => recordById(id)!;
const find = (p: Project, recordId: string, code: string, extra: { overrides?: Record<string, unknown>; journeyCursor?: number | null } = {}): Finding => {
  const f = resolve({ project: p, record: rec(recordId), ...extra }).findings.find((x) => x.code === code);
  if (!f) throw new Error(`${recordId} has no ${code}`);
  return f;
};
const cardRecords = RECORDS.filter((r) => r.documentType === 'credit-statement');
const blockedIds = (p: Project): string[] => cardRecords.filter((r) => resolve({ project: p, record: r }).findings.some((f) => f.severity === 'blocking')).map((r) => r.recordId);

/** D01 exactly as the demo injects it: R03 loses its second condition and ties with R04 at priority 400. */
const r3 = card.rules.find((r) => r.id === 'R03')!;
const d01 = run(card, { type: 'UPSERT_RULE', rule: { ...r3, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, priority: 400 } });
const noFallback = run(card, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
const noContinuation = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: false } });
const nobodyMatches = { card: { paymentStatus: 'overdue', missedPayments: 0 } };
const overflow: Finding = {
  code: 'FLOW_OVERFLOW_NO_CONTINUATION', severity: 'blocking', nodeId: 'transaction-table', page: 1, source: 'composer', details: { rowsPlaced: 22, rowsClipped: 228 },
  message: 'Repeating table transaction-table overflows the flow region on page 1: 228 of 250 rows cannot be placed because continuation is disabled.',
};

function wellFormed(p: Project, proposals: FixProposal[]): void {
  expect(new Set(proposals.map((x) => x.id)).size).toBe(proposals.length);
  for (const x of proposals) {
    expect(x.id).toMatch(/^fix-[0-9a-f]{14}$/);
    expect(x.source).toBe('builtin');
    expect(x.title.length).toBeGreaterThan(5);
    expect(x.title[0]).toBe(x.title[0].toUpperCase());
    expect(x.explanation.length).toBeGreaterThan(20);
    if (x.kind === 'change') {
      expect(x.commands?.length).toBeGreaterThan(0);
      // every change is applicable as ONE undoable step
      expect(applyCommand(p, { type: 'BATCH', label: x.title, commands: x.commands! }).ok).toBe(true);
      if (x.risk === 'review') expect(x.riskReason).toBeTruthy();
      // translations are never drafted or approved for anyone
      expect(x.commands!.some((c) => /TRANSLATION/.test(c.type))).toBe(false);
    } else {
      expect(x.commands).toBeUndefined();
      expect(x.risk).toBe('review');
      if (x.kind === 'link') expect(x.link?.label).toBeTruthy(); else expect(x.link).toBeUndefined();
    }
  }
}

describe('priority tie between exclusive rules', () => {
  const tie = find(d01, 'CARD-0002', 'EXCLUSIVE_PRIORITY_TIE');
  const proposals = proposeFixes(d01, tie, { records: RECORDS, recordId: 'CARD-0002' });

  it('proposes a concrete priority change that says which message tied customers will get', () => {
    wellFormed(d01, proposals);
    const [first, second] = proposals;
    expect(first.kind).toBe('change');
    expect(first.risk).toBe('review'); // it decides which message a customer gets
    expect(first.title).toBe('Raise the priority of “Customer asked for payment assistance”');
    expect(first.explanation).toContain('“Assistance requested”');
    expect(first.explanation).toContain('7 synthetic customers');
    expect(first.title + first.explanation).not.toMatch(/\bR0[34]\b|payment-guidance/); // names, not ids
    expect(first.commands).toEqual([{ type: 'UPSERT_RULE', rule: expect.objectContaining({ id: 'R04', priority: 450 }) }]);
    expect(second.kind).toBe('change');
    expect(second.commands).toEqual([{ type: 'UPSERT_RULE', rule: expect.objectContaining({ id: 'R03', priority: 450 }) }]);
    expect(proposals[proposals.length - 1].kind).toBe('link');
  });

  it('the effect is shown first: it resolves the tie, unblocks the tied customers and blocks nobody new', () => {
    const impact = fixImpact(d01, proposals[0], RECORDS, { finding: tie });
    expect(impact.resolves).toBe(true);
    expect(impact.newlyBlocked).toEqual([]);
    expect(impact.totalCustomers).toBe(70);
    // cross-check against a full, independent recomputation
    const after = apply(d01, proposals[0]);
    const before = blockedIds(d01), now = blockedIds(after);
    expect(impact.unblocked).toEqual(before.filter((id) => !now.includes(id)));
    expect(impact.unblocked).toContain('CARD-0002');
    expect(impact.unblocked).toHaveLength(7);
    expect(impact.changedCustomers).toBe(7);
    expect(impact.summary).toBe('Resolves the issue and unblocks 7 of 70 synthetic customers; nobody else is affected.');
    expect(resolve({ project: after, record: rec('CARD-0002') }).result.selectedVariants['payment-guidance']).toBe('payment-assistance-requested');
    expect(resolve({ project: apply(d01, proposals[1]), record: rec('CARD-0002') }).result.selectedVariants['payment-guidance']).toBe('payment-support-offer');
  });

  it('gives the same change for the static rule check’s finding', () => {
    const staticTie: Finding = { code: 'EQUAL_PRIORITY_EXCLUSIVE_RULES', severity: 'blocking', nodeId: 'payment-guidance', ruleIds: ['R03', 'R04'], source: 'rules-static', message: 'R03 and R04 share priority 400 in payment-guidance; 7 seeded record(s) match both.' };
    const viaStatic = proposeFixes(d01, staticTie, { records: RECORDS });
    wellFormed(d01, viaStatic);
    expect(viaStatic[0].commands).toEqual(proposals[0].commands);
    expect(fixImpact(d01, viaStatic[0], RECORDS, { finding: staticTie }).resolves).toBe(true);
  });

  it('stays strictly between the neighbouring priorities and falls back to a link when there is no room', () => {
    // R05 directly above the tie: the winner can only move down-side, so the other rule is lowered instead.
    const r5 = d01.rules.find((r) => r.id === 'R05')!;
    const tight = run(d01, { type: 'UPSERT_RULE', rule: { ...r5, priority: 401 } });
    const p = proposeFixes(tight, find(tight, 'CARD-0002', 'EXCLUSIVE_PRIORITY_TIE'), { records: RECORDS });
    wellFormed(tight, p);
    expect(p[0].title).toBe('Lower the priority of “Two or more missed payments — offer support”');
    expect(p[0].commands).toEqual([{ type: 'UPSERT_RULE', rule: expect.objectContaining({ id: 'R03', priority: 350 }) }]);
    expect(fixImpact(tight, p[0], RECORDS).newlyBlocked).toEqual([]);
    // a stale finding (the rules no longer tie) is answered with a link, not a change
    expect(proposeFixes(card, find(d01, 'CARD-0002', 'EXCLUSIVE_PRIORITY_TIE'), { records: RECORDS }).map((x) => x.kind)).toEqual(['link']);
  });
});

describe('message set without a fallback', () => {
  const f = find(noFallback, 'CARD-0001', 'NO_VARIANT_MATCH', { overrides: nobodyMatches });

  it('proposes the standard message as fallback; safe while no customer reaches it', () => {
    const proposals = proposeFixes(noFallback, f, { records: RECORDS, recordId: 'CARD-0001', overrides: nobodyMatches });
    wellFormed(noFallback, proposals);
    const [first] = proposals;
    expect(first.kind).toBe('change');
    expect(first.commands).toEqual([{ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: 'payment-standard' } }]);
    expect(first.title).toBe('Make “Payment instructions” the fallback message of “Payment guidance”');
    expect(first.risk).toBe('safe');
    const impact = fixImpact(noFallback, first, RECORDS, { finding: f });
    expect(impact).toMatchObject({ resolves: true, unblocked: [], newlyBlocked: [], changedCustomers: 0, totalCustomers: 70 });
    const res = resolve({ project: apply(noFallback, first), record: rec('CARD-0001'), overrides: nobodyMatches });
    expect(res.result.selectedVariants['payment-guidance']).toBe('payment-standard');
    expect(res.findings.some((x) => x.code === 'NO_VARIANT_MATCH')).toBe(false);
  });

  it('needs review as soon as a real customer would receive the fallback', () => {
    const stuck: SyntheticRecord = { ...rec('CARD-0001'), recordId: 'CARD-9001', card: { ...rec('CARD-0001').card!, paymentStatus: 'overdue', missedPayments: 0 } };
    const records = [...RECORDS, stuck];
    const first = proposeFixes(noFallback, f, { records })[0];
    expect(first.risk).toBe('review');
    expect(first.riskReason).toContain('1 synthetic customer');
    const impact = fixImpact(noFallback, first, records, { finding: f });
    expect(impact.resolves).toBe(true);
    expect(impact.unblocked).toEqual(['CARD-9001']);
    expect(impact.totalCustomers).toBe(71);
  });

  it('picks the one message no rule selects when there is one (HarborCare)', () => {
    const bare = run(eob, { type: 'UPDATE_NODE', nodeId: 'eob-claim-message', patch: { fallbackVariantId: undefined } });
    const first = proposeFixes(bare, { code: 'VARIANT_SET_WITHOUT_FALLBACK', severity: 'warning', nodeId: 'eob-claim-message', source: 'rules-static', message: 'eob-claim-message has no fallback; a scenario where no rule matches will be blocked.' }, { records: RECORDS })[0];
    expect(first.commands).toEqual([{ type: 'UPDATE_NODE', nodeId: 'eob-claim-message', patch: { fallbackVariantId: 'eob-processing' } }]);
    expect(first.risk).toBe('review'); // 9 sample members get the fallback today
  });
});

describe('table that cannot continue', () => {
  it('turns continuation on: a safe change', () => {
    const proposals = proposeFixes(noContinuation, overflow, { records: RECORDS, recordId: 'CARD-0008' });
    wellFormed(noContinuation, proposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'change', risk: 'safe', title: 'Let “Transactions” continue on the next page', commands: [{ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: true } }] });
    expect(proposals[0].explanation).toContain('228 of 250 rows');
    expect(proposals[0].riskReason).toBeUndefined();
    const impact = fixImpact(noContinuation, proposals[0], RECORDS, { finding: overflow });
    expect(impact).toMatchObject({ resolves: true, unblocked: [], newlyBlocked: [], changedCustomers: 0 });
    expect(apply(noContinuation, proposals[0]).nodes.find((n) => n.id === 'transaction-table')!.flowContinuation).toBe(true);
  });

  it('a clipped total gets the same change, and a link once continuation is already on', () => {
    const clipped: Finding = { code: 'TABLE_TOTAL_CLIPPED', severity: 'error', nodeId: 'transaction-table', page: 1, source: 'composer', message: 'The total row of transaction-table does not fit on page 1.' };
    expect(proposeFixes(noContinuation, clipped, { records: RECORDS })[0]).toMatchObject({ kind: 'change', risk: 'safe' });
    expect(proposeFixes(card, clipped, { records: RECORDS }).map((x) => x.kind)).toEqual(['link']);
    expect(proposeFixes(card, overflow, { records: RECORDS })[0].link).toMatchObject({ view: 'design', nodeId: 'transaction-table' });
  });
});

describe('unknown data field', () => {
  const withToken = (markup: string): Project => run(card, { type: 'UPDATE_NODE', nodeId: 'greeting', patch: { content: richFromMarkup(markup) } });

  it('replaces {{card.minimumDue}} with the clearly closest field', () => {
    const p = withToken('Hello {{customer.givenName}}, please pay {{card.minimumDue}} by **{{card.dueDate}}**.');
    const f = find(p, 'CARD-0001', 'INVALID_BINDING');
    const proposals = proposeFixes(p, f, { records: RECORDS, recordId: 'CARD-0001' });
    wellFormed(p, proposals);
    expect(proposals[0]).toMatchObject({ kind: 'change', risk: 'review', title: 'Use “Minimum payment due” in “Greeting”' });
    const after = apply(p, proposals[0]);
    expect(JSON.stringify(after.nodes.find((n) => n.id === 'greeting')!.content)).toContain('"card.minimumDueCents"');
    expect(JSON.stringify(after.nodes.find((n) => n.id === 'greeting')!.content)).toContain('"card.dueDate"');
    expect(resolve({ project: after, record: rec('CARD-0001') }).findings.some((x) => x.code === 'INVALID_BINDING')).toBe(false);
    const impact = fixImpact(p, proposals[0], RECORDS, { finding: f });
    expect(impact.resolves).toBe(true);
    expect(impact.newlyBlocked).toEqual([]);
    expect(impact.unblocked).toHaveLength(64); // the six Spanish-language customers stay blocked by missing translations
    expect(impact.changedCustomers).toBe(70);
    expect(proposals[1].kind).toBe('link');
  });

  it('offers only a link when no field is clearly the closest', () => {
    for (const token of ['card.statement', 'card.balance', 'customer.firstName', 'x']) {
      const p = withToken(`Value {{${token}}}`);
      const proposals = proposeFixes(p, find(p, 'CARD-0001', 'INVALID_BINDING'), { records: RECORDS });
      wellFormed(p, proposals);
      expect(proposals.map((x) => x.kind), token).toEqual(['link']);
      expect(proposals[0].link).toMatchObject({ view: 'design', nodeId: 'greeting' });
    }
  });

  it('fixes a binding, a header token and a message token; the static check’s findings work as input', () => {
    const binding = run(card, { type: 'UPDATE_NODE', nodeId: 'payment-due', patch: { binding: 'card.minimumDue' } });
    const b = proposeFixes(binding, find(binding, 'CARD-0001', 'INVALID_BINDING'), { records: RECORDS });
    wellFormed(binding, b);
    expect(b[0].commands).toEqual([{ type: 'UPDATE_NODE', nodeId: 'payment-due', patch: { binding: 'card.minimumDueCents' } }]);

    const header = run(card, { type: 'UPDATE_NODE', nodeId: 'running-header', patch: { headerFooter: { role: 'page-header', repeat: true, text: 'Statement · {{card.maskedAcount}}' } } });
    const staticFinding: Finding = { code: 'INVALID_BINDING', severity: 'blocking', nodeId: 'running-header', source: 'binding', message: 'Header token references unknown field “card.maskedAcount”.', details: { path: 'card.maskedAcount' } };
    const h = proposeFixes(header, staticFinding, { records: RECORDS });
    wellFormed(header, h);
    expect(apply(header, h[0]).nodes.find((n) => n.id === 'running-header')!.headerFooter!.text).toBe('Statement · {{card.maskedAccount}}');
    expect(fixImpact(header, h[0], RECORDS, { finding: staticFinding }).resolves).toBe(true);

    const part = card.contentParts.find((c) => c.id === 'payment-standard')!;
    const message = run(card, { type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: { 'en-US': 'Your payment is due on {{card.dueDay}}.' } } });
    // the static check reports content parts without `details`; the path is read from the message
    const m = proposeFixes(message, { code: 'INVALID_BINDING', severity: 'warning', nodeId: 'payment-standard', source: 'binding', message: 'Content part payment-standard references unknown field “card.dueDay”.' }, { records: RECORDS });
    wellFormed(message, m);
    expect(apply(message, m[0]).contentParts.find((c) => c.id === 'payment-standard')!.approvedLocales['en-US']).toBe('Your payment is due on {{card.dueDate}}.');

    // protected, approved disclosure wording is never rewritten: link only
    const disclosure = { ...card, contentParts: card.contentParts.map((c) => (c.id === 'sample-disclosure-set' ? { ...c, approvedLocales: { 'en-US': 'Demo {{card.dueDay}}' } } : c)) };
    expect(proposeFixes(disclosure, { code: 'INVALID_BINDING', severity: 'blocking', nodeId: 'sample-disclosure-set', source: 'binding', message: 'Unknown field path “card.dueDay” in sample-disclosure-set.', details: { path: 'card.dueDay' } }, { records: RECORDS }).map((x) => x.kind)).toEqual(['link']);
  });

  it('a table bound to a single value is pointed at the only list there is', () => {
    const p = run(card, { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { binding: 'card.dueDate' } });
    const f = resolve({ project: p, record: rec('CARD-0001') }).findings.find((x) => x.code === 'INVALID_BINDING' && x.nodeId === 'transaction-table')!;
    expect(f.message).toBe('card.dueDate is not a collection.');
    const proposals = proposeFixes(p, f, { records: RECORDS });
    wellFormed(p, proposals);
    expect(proposals[0].commands).toEqual([{ type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { binding: 'card.transactions' } }]);
  });
});

describe('things a person must do', () => {
  it('a missing Spanish translation gets a link to the text, never a change', () => {
    const spanish = cardRecords.find((r) => r.customer.locale === 'es-US')!;
    const findings = resolve({ project: card, record: spanish }).findings;
    expect(findings.map((f) => f.code)).toContain('REQUIRED_TRANSLATION_MISSING');
    for (const f of findings) {
      const proposals = proposeFixes(card, f, { records: RECORDS, recordId: spanish.recordId });
      wellFormed(card, proposals);
      expect(proposals.map((x) => x.kind)).toEqual(['link']);
      expect(proposals[0].link).toMatchObject({ view: 'content', locale: 'es-US' });
      expect(proposals[0].link!.textId).toBe(f.nodeId ?? '@issuer-logo/image.alt');
      expect(proposals[0].explanation).toContain('never approves');
      expect(fixImpact(card, proposals[0], RECORDS, { finding: f })).toMatchObject({ resolves: false, unblocked: [], newlyBlocked: [], changedCustomers: 0, totalCustomers: 70 });
    }
    // even when a draft is waiting, it is only pointed out
    const drafted = run(card, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: 'Su pago vence el {{card.dueDate}}.' });
    const p = proposeFixes(drafted, findings.find((f) => f.nodeId === 'payment-standard')!, { records: RECORDS });
    expect(p.map((x) => x.kind)).toEqual(['link']);
    expect(p[0].explanation).toContain('draft exists');
  });

  it('unconfirmed-debt wording gets a link to the text', () => {
    const worded = run(eob, { type: 'UPDATE_NODE', nodeId: 'member-responsibility', patch: { label: 'Amount you owe' } });
    const sc = EXPECTED_SCENARIOS['eob-unconfirmed-liability'];
    const f = find(worded, sc.recordId, 'UNCONFIRMED_DEBT_LANGUAGE', { overrides: sc.overrides });
    const proposals = proposeFixes(worded, f, { records: RECORDS, recordId: sc.recordId, overrides: sc.overrides });
    wellFormed(worded, proposals);
    expect(proposals.map((x) => x.kind)).toEqual(['link']);
    expect(proposals[0].link).toMatchObject({ view: 'design', nodeId: 'member-responsibility', textId: '@member-responsibility/label' });
  });
});

describe('the previewed data is the problem', () => {
  it('EOB unconfirmed liability: a scenario proposal and no document change', () => {
    const sc = EXPECTED_SCENARIOS['eob-unconfirmed-liability'];
    const f = find(eob, sc.recordId, 'UNCONFIRMED_MEMBER_LIABILITY', { overrides: sc.overrides });
    const proposals = proposeFixes(eob, f, { records: RECORDS, recordId: sc.recordId, overrides: sc.overrides });
    wellFormed(eob, proposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'scenario', risk: 'review', title: 'Adjust the what-if values' });
    expect(proposals[0].explanation).toContain('no document change is proposed');
    expect(fixImpact(eob, proposals[0], RECORDS, { finding: f })).toMatchObject({ resolves: false, unblocked: [], newlyBlocked: [], changedCustomers: 0, totalCustomers: 30 });
  });

  it('says where the bad state comes from: the record, a journey step or the what-if', () => {
    const atStep = find(eob, 'EOB-0001', 'UNCONFIRMED_MEMBER_LIABILITY', { journeyCursor: 2 });
    expect(proposeFixes(eob, atStep, { records: RECORDS, recordId: 'EOB-0001', journeyCursor: 2 })[0]).toMatchObject({ kind: 'scenario', title: 'Review the journey step “Review requested”' });
    const whatIf = { card: { paymentStatus: 'current', missedPayments: 2 } };
    const p = proposeFixes(card, find(card, 'CARD-0001', 'INCONSISTENT_PAYMENT_STATE', { overrides: whatIf }), { records: RECORDS, recordId: 'CARD-0001', overrides: whatIf });
    expect(p.map((x) => x.kind)).toEqual(['scenario']);
    const broken: SyntheticRecord = { ...rec('CARD-0001'), recordId: 'CARD-9002', card: { ...rec('CARD-0001').card!, newBalanceCents: 1 } };
    const fromRecord = proposeFixes(card, resolve({ project: card, record: broken }).findings.find((x) => x.code === 'BALANCE_RECONCILIATION_FAILED')!, { records: [...RECORDS, broken], recordId: 'CARD-9002' });
    expect(fromRecord[0]).toMatchObject({ kind: 'scenario', title: 'Correct the customer data' });
    expect(fromRecord[0].explanation).toContain('sample record itself');
  });
});

describe('rules that point at something missing, wording and accessibility', () => {
  it('a rule selecting a removed message can be turned off or re-pointed only when unambiguous', () => {
    const removed = run(card, { type: 'REMOVE_VARIANT', nodeId: 'payment-guidance', variantId: 'payment-reminder' });
    const f = find(removed, 'CARD-0003', 'UNKNOWN_VARIANT');
    const proposals = proposeFixes(removed, f, { records: RECORDS, recordId: 'CARD-0003' });
    wellFormed(removed, proposals);
    expect(proposals.map((x) => x.kind)).toEqual(['change', 'link']); // no version is clearly the one meant
    expect(proposals[0]).toMatchObject({ title: 'Turn off “One missed payment — send a reminder”', risk: 'review', commands: [{ type: 'SET_RULE_ENABLED', ruleId: 'R02', enabled: false }] });
    const impact = fixImpact(removed, proposals[0], RECORDS, { finding: f });
    expect(impact.resolves).toBe(true);
    expect(impact.newlyBlocked).toEqual([]);
    expect(impact.unblocked.length).toBeGreaterThan(0);
    // a near-identical id is unambiguous
    const typo = { ...card, rules: card.rules.map((r) => (r.id === 'R02' ? { ...r, then: { op: 'selectVariant' as const, targetNodeId: 'payment-guidance', variantId: 'payment-remindr' } } : r)) };
    const t = proposeFixes(typo, find(typo, 'CARD-0003', 'UNKNOWN_VARIANT'), { records: RECORDS });
    wellFormed(typo, t);
    expect(t[0]).toMatchObject({ title: 'Point “One missed payment — send a reminder” at “Payment reminder”', risk: 'review' });
  });

  it('a rule showing a section that does not exist', () => {
    const typo = { ...card, rules: card.rules.map((r) => (r.id === 'R06' ? { ...r, then: { op: 'showSection' as const, targetNodeId: 'relationship-managers' } } : r)) };
    const premium = cardRecords.find((r) => r.card!.tier === 'premium')!;
    const f = find(typo, premium.recordId, 'UNKNOWN_SECTION');
    const proposals = proposeFixes(typo, f, { records: RECORDS });
    wellFormed(typo, proposals);
    expect(proposals.map((x) => [x.kind, x.risk])).toEqual([['change', 'review'], ['change', 'review'], ['link', 'review']]);
    expect(proposals[0].title).toBe('Point “Premium tier — show relationship team” at “Relationship team”');
    const impact = fixImpact(typo, proposals[0], RECORDS, { finding: f });
    expect(impact.resolves).toBe(true);
    expect(impact.newlyBlocked).toEqual([]);
    expect(fixImpact(typo, proposals[1], RECORDS, { finding: f }).resolves).toBe(true);
  });

  it('a message without wording: remove it only when nobody could receive it', () => {
    const selected = { ...card, contentParts: card.contentParts.filter((c) => c.id !== 'payment-reminder') };
    const a = proposeFixes(selected, find(selected, 'CARD-0001', 'MISSING_CONTENT_PART'), { records: RECORDS });
    wellFormed(selected, a);
    expect(a.map((x) => x.kind)).toEqual(['link']); // a rule selects it: wording must be written
    const orphan = { ...card, nodes: card.nodes.map((n) => (n.id === 'payment-guidance' ? { ...n, variantIds: [...n.variantIds!, 'payment-extra'] } : n)) };
    const f = find(orphan, 'CARD-0001', 'MISSING_CONTENT_PART');
    const b = proposeFixes(orphan, f, { records: RECORDS });
    wellFormed(orphan, b);
    expect(b.map((x) => [x.kind, x.risk])).toEqual([['change', 'review'], ['link', 'review']]);
    const impact = fixImpact(orphan, b[0], RECORDS, { finding: f });
    expect(impact).toMatchObject({ resolves: true, newlyBlocked: [] });
    expect(impact.unblocked).toHaveLength(64);
  });

  it('a missing image description is suggested from the name and needs review', () => {
    const p = run(card, { type: 'UPDATE_NODE', nodeId: 'issuer-logo', patch: { image: { src: 'asset:aster-mark', alt: '' } } });
    const f = find(p, 'CARD-0001', 'IMAGE_ALT_MISSING');
    const proposals = proposeFixes(p, f, { records: RECORDS });
    wellFormed(p, proposals);
    expect(proposals.map((x) => [x.kind, x.risk])).toEqual([['change', 'review'], ['change', 'review']]);
    expect(proposals[0].title).toBe('Describe the image as “Issuer logo”');
    expect(apply(p, proposals[0]).nodes.find((n) => n.id === 'issuer-logo')!.image).toEqual({ src: 'asset:aster-mark', alt: 'Issuer logo' });
    expect(fixImpact(p, proposals[0], RECORDS, { finding: f })).toMatchObject({ resolves: true, newlyBlocked: [] });
    // the model accessibility check reports the same thing under its own code
    const a11y = proposeFixes(p, { code: 'A11Y_IMAGE_ALT', severity: 'warning', nodeId: 'issuer-logo', source: 'accessibility', message: 'Image issuer-logo needs alternative text.' }, { records: RECORDS });
    expect(a11y[0].commands).toEqual(proposals[0].commands);
    expect(fixImpact(p, a11y[0], RECORDS, { finding: { code: 'A11Y_IMAGE_ALT', severity: 'warning', nodeId: 'issuer-logo', source: 'accessibility', message: '' } }).resolves).toBe(true);
  });
});

describe('every finding code the resolver, the static checks and the composer can emit', () => {
  const noChartTitle = run(card, { type: 'UPDATE_NODE', nodeId: 'spend-chart', patch: { chart: { kind: 'bar', groupBy: 'merchant', valueKey: 'amountCents', title: '' } } });
  const F = (code: string, severity: Finding['severity'], source: Finding['source'], extra: Partial<Finding> = {}): Finding => ({ code, severity, source, message: `${code} sample`, ...extra });
  /** One finding per code, shaped as its emitter shapes it, with the project it is raised on. */
  const samples: Array<[Project, Finding, Array<FixProposal['kind']>]> = [
    // resolver
    [card, F('RECORD_TYPE_MISMATCH', 'blocking', 'resolver'), ['scenario']],
    [card, F('REQUIRED_NODE_MISSING', 'blocking', 'resolver', { nodeId: 'payment-due-missing', ruleId: 'R12' }), ['link']],
    [d01, F('EXCLUSIVE_PRIORITY_TIE', 'blocking', 'resolver', { nodeId: 'payment-guidance', ruleIds: ['R03', 'R04'] }), ['change', 'change', 'link']],
    [card, F('UNKNOWN_VARIANT', 'blocking', 'resolver', { nodeId: 'payment-guidance', ruleId: 'R99' }), ['link']],
    [card, F('FALLBACK_SELECTED', 'info', 'resolver', { nodeId: 'payment-guidance' }), []],
    [noFallback, F('NO_VARIANT_MATCH', 'blocking', 'resolver', { nodeId: 'payment-guidance' }), ['change', 'link']],
    [card, F('INCONSISTENT_PAYMENT_STATE', 'blocking', 'domain', { nodeId: 'payment-guidance' }), ['scenario']],
    [card, F('BALANCE_RECONCILIATION_FAILED', 'blocking', 'domain', { nodeId: 'billing-summary' }), ['scenario']],
    [eob, F('UNCONFIRMED_MEMBER_LIABILITY', 'blocking', 'domain', { nodeId: 'totals-and-terms' }), ['scenario']],
    [eob, F('CLAIM_RECONCILIATION_FAILED', 'blocking', 'domain', { nodeId: 'totals-and-terms' }), ['scenario']],
    [card, F('REQUIRED_TRANSLATION_MISSING', 'blocking', 'resolver', { nodeId: 'payment-standard', locale: 'es-US' }), ['link']],
    [card, F('TRANSLATION_MISSING_OPTIONAL', 'warning', 'resolver', { nodeId: 'relationship-manager', locale: 'es-US' }), ['link']],
    [card, F('UNAPPROVED_TRANSLATION_SHOWN', 'warning', 'translation', { locale: 'es-US', details: { ids: ['payment-standard', '@greeting/content'] } }), ['link']],
    [card, F('TRANSLATION_MISSING_TEXT', 'warning', 'translation', { locale: 'es-US', details: { ids: ['@greeting/content'] } }), ['link']],
    [card, F('INVALID_BINDING', 'blocking', 'binding', { nodeId: 'greeting', details: { path: 'card.nope' } }), ['link']],
    [card, F('NULL_BINDING', 'blocking', 'binding', { nodeId: 'payment-due-date' }), ['scenario', 'link']],
    [eob, F('UNCONFIRMED_DEBT_LANGUAGE', 'blocking', 'domain', { nodeId: 'member-responsibility' }), ['link']],
    [card, F('MISSING_CONTENT_PART', 'blocking', 'resolver', { nodeId: 'gone' }), ['link']],
    [card, F('UNSAFE_URL', 'blocking', 'binding', { nodeId: 'payment-action' }), ['link']],
    [card, F('IMAGE_ALT_MISSING', 'warning', 'accessibility', { nodeId: 'issuer-logo' }), []], // stale: the image has a description
    [card, F('UNKNOWN_SECTION', 'warning', 'resolver', { nodeId: 'nowhere', ruleIds: ['R06'] }), ['link']],
    // calculated fields, lookup tables and the document's date (rules and data depth)
    [card, F('CALCULATION_MISSING', 'blocking', 'binding', { details: { path: 'calc.daysToDue', reason: 'input-missing', usedBy: ['rule R03'] } }), ['scenario', 'link']],
    [card, F('LOOKUP_NO_MATCH', 'blocking', 'binding', { details: { path: 'calc.fee', reason: 'no-lookup-row', usedBy: ['rule R03'] } }), ['link']],
    [card, F('DOCUMENT_DATE_MISSING', 'blocking', 'binding', { details: { path: 'document.date', usedBy: [] } }), ['scenario', 'link']],
    [card, F('ISSUE_DATE_INVALID', 'blocking', 'resolver'), ['scenario']],
    // static rule checks, binding analysis, model accessibility, axe
    [d01, F('EQUAL_PRIORITY_EXCLUSIVE_RULES', 'blocking', 'rules-static', { nodeId: 'payment-guidance', ruleIds: ['R03', 'R04'] }), ['change', 'change', 'link']],
    [card, F('RULE_NOT_REACHED_IN_FIXTURES', 'info', 'rules-static', { ruleId: 'R03' }), ['link']],
    [card, { ...F('VARIANT_WITHOUT_RULE', 'warning', 'rules-static', { nodeId: 'payment-guidance' }), message: 'Variant payment-reminder of payment-guidance is not selected by any enabled rule and is not the fallback — it can never appear.' }, ['link']],
    [noFallback, F('VARIANT_SET_WITHOUT_FALLBACK', 'warning', 'rules-static', { nodeId: 'payment-guidance' }), ['change', 'link']],
    [card, F('A11Y_IMAGE_ALT', 'warning', 'accessibility', { nodeId: 'missing-image' }), ['link']],
    [card, F('A11Y_LINK_TEXT', 'warning', 'accessibility', { nodeId: 'payment-action' }), ['link']],
    [noChartTitle, F('A11Y_CHART_TITLE', 'warning', 'accessibility', { nodeId: 'spend-chart' }), ['change']],
    [card, F('A11Y_TABLE_HEADERS', 'warning', 'accessibility', { nodeId: 'transaction-table' }), ['link']],
    [card, F('A11Y_TOKEN_ONLY_TEXT', 'info', 'accessibility', { nodeId: 'greeting' }), ['link']],
    [card, F('A11Y_NO_H1', 'warning', 'accessibility'), ['link']],
    [card, F('AXE_COLOR_CONTRAST', 'error', 'accessibility', { details: { rule: 'color-contrast', impact: 'serious' } }), ['link']],
    // page composer
    [card, F('FIXED_FLOW_ADJUSTED', 'warning', 'composer', { nodeId: 'issuer-logo', page: 1 }), ['link']],
    [card, F('ROW_TALLER_THAN_REGION', 'error', 'composer', { nodeId: 'transaction-table', page: 1 }), ['link']],
    [noContinuation, F('TABLE_TOTAL_CLIPPED', 'error', 'composer', { nodeId: 'transaction-table', page: 2 }), ['change']],
    [noContinuation, { ...overflow }, ['change']],
    [card, F('BLOCK_OVERFLOW', 'error', 'composer', { nodeId: 'greeting', page: 1 }), ['link']],
    [card, F('ORPHANED_HEADING', 'warning', 'composer', { nodeId: 'greeting', page: 1 }), ['change']],
    // output comparison (API) and anything not known yet
    [card, F('PARITY_MISMATCH', 'blocking', 'parity', { details: { check: 'money' } }), ['link']],
    [card, F('SOMETHING_NEW', 'warning', 'resolver', { nodeId: 'greeting' }), ['link']],
    [card, F('SOMETHING_NEW_INFO', 'info', 'resolver'), []],
  ];

  it('covers every code found in the emitting source files', () => {
    const root = path.resolve(__dirname, '../../..');
    const sources = ['packages/resolver/src/resolve.ts', 'packages/validation/src/index.ts', 'packages/renderers/src/paginator-source.ts'].map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
    const emitted = [...new Set([...sources.matchAll(/code: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]))].sort();
    expect(emitted.length).toBeGreaterThanOrEqual(36);
    const covered = new Set(samples.map(([, f]) => f.code));
    expect(emitted.filter((c) => !covered.has(c))).toEqual([]);
    expect(sources).toContain('`AXE_${'); // the one dynamic code family, covered by AXE_COLOR_CONTRAST
  });

  it.each(samples.map(([p, f, kinds]) => [f.code, p, f, kinds] as const))('%s', (_code, p, f, kinds) => {
    const ctx = { records: RECORDS };
    const proposals = proposeFixes(p, f, ctx);
    wellFormed(p, proposals);
    expect(proposals.map((x) => x.kind)).toEqual(kinds);
    if (f.severity === 'info') expect(proposals.every((x) => x.kind === 'link')).toBe(true); // never an invented change
    // stable ids for the same project state and finding
    expect(proposeFixes(p, f, ctx).map((x) => x.id)).toEqual(proposals.map((x) => x.id));
    for (const x of proposals) {
      const impact = fixImpact(p, x, RECORDS, { finding: f });
      expect(impact.totalCustomers).toBe(p.documentType === 'eob' ? 30 : 70);
      expect(impact.summary.length).toBeGreaterThan(10);
      if (x.kind !== 'change') expect(impact).toMatchObject({ resolves: false, unblocked: [], newlyBlocked: [], changedCustomers: 0 });
      else expect(impact.newlyBlocked).toEqual([]);
    }
  });

  it('only the two reversible, nobody-is-affected changes are ever marked safe', () => {
    const safe = samples.flatMap(([p, f]) => proposeFixes(p, f, { records: RECORDS }).filter((x) => x.risk === 'safe').map((x) => `${f.code}:${x.commands![0].type}`));
    expect([...new Set(safe)].sort()).toEqual(['FLOW_OVERFLOW_NO_CONTINUATION:UPDATE_NODE', 'NO_VARIANT_MATCH:UPDATE_NODE', 'TABLE_TOTAL_CLIPPED:UPDATE_NODE', 'VARIANT_SET_WITHOUT_FALLBACK:UPDATE_NODE']);
  });
});

describe('grouping and “Fix all safe issues”', () => {
  it('groups blocking and warning findings across the customers', () => {
    const groups = groupFindings(card, RECORDS);
    expect(groups.map((g) => [g.finding.code, g.finding.nodeId, g.recordIds.length])).toEqual([
      ['REQUIRED_TRANSLATION_MISSING', 'billing-summary', 6], ['REQUIRED_TRANSLATION_MISSING', 'payment-due', 6], ['REQUIRED_TRANSLATION_MISSING', 'payment-standard', 6],
      ['REQUIRED_TRANSLATION_MISSING', 'sample-disclosure-set', 6], ['TRANSLATION_MISSING_TEXT', undefined, 6],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
    expect(groupFindings(eob, RECORDS)).toEqual([]);
    // the given journey step, not the baseline
    const atReview = groupFindings(eob, RECORDS, { journeyCursor: 2 });
    expect(atReview.map((g) => [g.finding.code, g.recordIds.length])).toEqual([['UNCONFIRMED_MEMBER_LIABILITY', 19]]);
    const tied = groupFindings(d01, RECORDS);
    expect(tied[0]).toMatchObject({ finding: { code: 'EXCLUSIVE_PRIORITY_TIE', severity: 'blocking' }, recordIds: ['CARD-0002', 'CARD-0004', 'CARD-0016', 'CARD-0028', 'CARD-0040', 'CARD-0052', 'CARD-0064'] });
  });

  it('proposes nothing unsafe on the untouched samples', () => {
    for (const p of [card, eob, d01]) {
      const plan = safeFixPlan(p, RECORDS);
      expect(plan.items).toEqual([]);
      expect(plan.batch).toBeNull();
      expect(plan.skipped).toHaveLength(groupFindings(p, RECORDS).length);
      for (const s of plan.skipped) expect(s.reason.length).toBeGreaterThan(10);
    }
    expect(safeFixPlan(d01, RECORDS).skipped[0].reason).toMatch(/^Needs your review: /); // a priority change is never applied in bulk
    expect(safeFixPlan(card, RECORDS).skipped[0].reason).toMatch(/^Needs a person: Write and approve the Spanish text/);
  });

  it('combines the safe fixes for findings from other checks into one undoable step', () => {
    const both = run(noContinuation, { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: undefined } });
    const extra: Finding[] = [
      overflow,
      { code: 'TABLE_TOTAL_CLIPPED', severity: 'error', nodeId: 'transaction-table', page: 9, source: 'composer', message: 'The total row of transaction-table does not fit on page 9.' },
      { code: 'VARIANT_SET_WITHOUT_FALLBACK', severity: 'warning', nodeId: 'payment-guidance', source: 'rules-static', message: 'payment-guidance has no fallback; a scenario where no rule matches will be blocked.' },
      { code: 'A11Y_NO_H1', severity: 'warning', source: 'accessibility', message: 'Document has no top-level heading.' },
    ];
    const plan = safeFixPlan(both, RECORDS, { findings: extra });
    expect(plan.items.map((i) => i.group.finding.code).sort()).toEqual(['FLOW_OVERFLOW_NO_CONTINUATION', 'TABLE_TOTAL_CLIPPED', 'VARIANT_SET_WITHOUT_FALLBACK']);
    for (const item of plan.items) {
      expect(item.proposal.risk).toBe('safe');
      expect(item.impact).toMatchObject({ resolves: true, newlyBlocked: [] });
    }
    // the two table findings share one command
    expect(plan.batch).toEqual({ type: 'BATCH', label: 'Fix 3 safe issues', commands: [
      { type: 'UPDATE_NODE', nodeId: 'transaction-table', patch: { flowContinuation: true } },
      { type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { fallbackVariantId: 'payment-standard' } },
    ] });
    const fixed = run(both, plan.batch!);
    expect(fixed.modelVersion).toBe(both.modelVersion + 1);
    expect(blockedIds(fixed)).toEqual(blockedIds(both));
    expect(plan.skipped.map((s) => s.group.finding.code)).toContain('A11Y_NO_H1');
    expect(plan.skipped.map((s) => s.group.finding.code)).toContain('REQUIRED_TRANSLATION_MISSING');
  });
});

describe('purity', () => {
  const freeze = <T,>(v: T): T => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v as object).forEach(freeze); } return v; };

  it('does not mutate the project, the records or the finding, and is deterministic', () => {
    const p = freeze(JSON.parse(JSON.stringify(d01)) as Project);
    const records = freeze(JSON.parse(JSON.stringify(RECORDS)) as SyntheticRecord[]);
    const f = freeze({ ...find(d01, 'CARD-0002', 'EXCLUSIVE_PRIORITY_TIE') });
    const a = proposeFixes(p, f, { records, recordId: 'CARD-0002' });
    const impact = fixImpact(p, a[0], records, { finding: f });
    expect(groupFindings(p, records).length).toBeGreaterThan(0);
    expect(safeFixPlan(p, records).batch).toBeNull();
    // a second, structurally equal project gives identical proposals and impact
    const again = JSON.parse(JSON.stringify(d01)) as Project;
    expect(proposeFixes(again, f, { records: RECORDS, recordId: 'CARD-0002' })).toEqual(a);
    expect(fixImpact(again, a[0], RECORDS, { finding: f })).toEqual(impact);
  });
});
