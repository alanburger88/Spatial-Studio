import { describe, expect, it } from 'vitest';
import { applyCommand, buildContext, fieldsFor, getPath, type Command, type Project } from '@iss/model';
import { resolve } from '@iss/resolver';
import { RECORDS, recordById, seedProjects } from '../../model/src/fixtures';
import { parseActivityQuery } from '../src/assist/activitySearch';
import { suggestAltText } from '../src/assist/altText';
import { explainNode } from '../src/assist/explain';
import { matchColumns } from '../src/assist/importMapping';
import { conditionWords, listWords, readingLevel } from '../src/assist/writing';

const [card, eob] = seedProjects();
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };
const jordan = recordById('CARD-0001')!;

/* ------------------------------------------------------------------ explain */

describe('explainNode', () => {
  const res = resolve({ project: card, record: jordan });

  it('explains a message chosen by a rule: which rule won, why, and which did not match', () => {
    const e = explainNode(card, res, 'payment-guidance');
    expect(e.headline).toBe('Jordan Mercer gets “Payment instructions” in “Payment guidance” because the rule “Customer is up to date” matched.');
    expect(e.steps).toEqual([
      'It matched because payment status is “current”.',
      'The rule “One missed payment — send a reminder” did not match: it applies only when missed payments is 1; for Jordan Mercer, missed payments is 0.',
      '3 other rules for this component did not match either: “Two or more missed payments — offer support”, “Customer asked for payment assistance” and “Payment arrangement approved”.',
      'The document is in English (United States).',
    ]);
    expect(e).toMatchObject({ variantId: 'payment-standard', nodeId: 'payment-guidance', ruleIds: ['R01', 'R02', 'R03', 'R04', 'R05'] });
    expect(e.variantId).toBe(res.result.selectedVariants['payment-guidance']);
    // no ids or field paths in the wording
    expect(`${e.headline} ${e.steps.join(' ')}`).not.toMatch(/R0\d|card\.|payment-guidance/);
  });

  it('explains priority: the higher-priority rule wins and the outranked one is named', () => {
    const r = resolve({ project: card, record: jordan, overrides: { card: { paymentStatus: 'overdue', missedPayments: 1, assistanceRequested: true } } });
    const e = explainNode(card, r, 'payment-guidance');
    expect(e.headline).toBe('Jordan Mercer gets “Assistance requested” in “Payment guidance” because the rule “Customer asked for payment assistance” matched.');
    expect(e.steps[0]).toBe('It matched because assistance requested is yes.');
    expect(e.steps[1]).toBe('The rule “One missed payment — send a reminder” also matched and would show “Payment reminder”, but the winning rule has the higher priority (400 against 200).');
    expect(e.ruleIds.slice(0, 2)).toEqual(['R04', 'R02']);
    expect(e.steps.length).toBeLessThanOrEqual(6);
  });

  it('explains a tie: both rules, the shared priority, and that it blocks the document', () => {
    const tied = run(card, { type: 'UPSERT_RULE', rule: { ...card.rules.find((x) => x.id === 'R03')!, priority: 400, when: { op: 'gte', path: 'card.missedPayments', value: 2 } } });
    const r = resolve({ project: tied, record: jordan, overrides: { card: { paymentStatus: 'overdue', missedPayments: 2, assistanceRequested: true } } });
    expect(r.findings.some((f) => f.code === 'EXCLUSIVE_PRIORITY_TIE')).toBe(true);
    const e = explainNode(tied, r, 'payment-guidance');
    expect(e.headline).toBe('Nothing can be chosen for “Payment guidance” for Jordan Mercer: two rules match with the same priority.');
    expect(e.steps).toEqual([
      'The rule “Two or more missed payments — offer support” would show “Payment support” and matches when missed payments is at least 2; for Jordan Mercer, missed payments is 2.',
      'The rule “Customer asked for payment assistance” would show “Assistance requested” and matches because assistance requested is yes.',
      'Both have priority 400, so neither wins and no message is chosen.',
      'This blocks the document until one rule’s priority is changed or a condition is narrowed.',
      'The document is in English (United States).',
    ]);
    expect(e.variantId).toBeNull();
    expect(e.ruleIds).toEqual(['R03', 'R04']);
  });

  it('explains the fallback when no rule matches', () => {
    const r = resolve({ project: card, record: jordan, overrides: { card: { paymentStatus: 'overdue', missedPayments: 0 } } });
    const e = explainNode(card, r, 'payment-guidance');
    expect(e.headline).toBe('Jordan Mercer gets “Payment instructions” in “Payment guidance” as the fallback, because no rule for it matched.');
    expect(e.steps[0]).toBe('The rule “Customer is up to date” did not match: it applies only when payment status is “current”; for Jordan Mercer, payment status is “overdue”.');
    expect(e.variantId).toBe('payment-standard');
  });

  it('explains a section shown by a rule and the same section hidden for another customer', () => {
    const hidden = explainNode(card, res, 'relationship-manager');
    expect(hidden.headline).toBe('“Relationship team” is not shown to Jordan Mercer because no rule that shows it matched.');
    expect(hidden.steps).toEqual([
      'The rule “Premium tier — show relationship team” would show it, but it applies only when account tier is “premium”; for Jordan Mercer, account tier is “standard”.',
      'The document is in English (United States).',
    ]);
    expect(hidden).toMatchObject({ variantId: null, ruleIds: ['R06'] });

    const premium = RECORDS.find((x) => x.card?.tier === 'premium')!;
    const shown = explainNode(card, resolve({ project: card, record: premium }), 'relationship-manager');
    expect(shown.headline).toBe(`“Relationship team” is shown to ${premium.customer.givenName} ${premium.customer.familyName} because the rule “Premium tier — show relationship team” matched.`);
    expect(shown.steps.slice(0, 2)).toEqual(['It matched because account tier is “premium”.', 'Without a matching rule this section stays hidden.']);
    expect(shown.variantId).toBe('relationship-manager');
  });

  it('explains a section with its own condition, met and not met', () => {
    const not = explainNode(card, res, 'high-volume-note');
    expect(not.headline).toBe('“High-volume note” is not shown to Jordan Mercer because none of its conditions is met and it has no fallback.');
    expect(not.steps[0]).toBe('“Transaction guide” is shown when transaction count is more than 25; for Jordan Mercer, transaction count is 12.');
    expect(not.ruleIds).toEqual([]);
    const busy = RECORDS.find((x) => (x.card?.transactions.length ?? 0) > 25)!;
    const met = explainNode(card, resolve({ project: card, record: busy }), 'high-volume-note');
    expect(met.headline).toMatch(/^“High-volume note” is shown to .+ because its condition is met\.$/);
    expect(met.steps[0]).toMatch(/^“Transaction guide” is shown when transaction count is more than 25; for .+, transaction count is \d+\.$/);
    // the same long list makes a rule repeat the table headings: said on the table, from the trace
    expect(explainNode(card, resolve({ project: card, record: busy }), 'transaction-table').steps).toContain('The rule “Long transaction list — repeat headings across pages” matched, so the column headings repeat on every page.');
  });

  it('says plainly when nothing decides a component, when it is required, and when it does not exist', () => {
    expect(explainNode(card, res, 'greeting')).toEqual({
      headline: '“Greeting” is always shown; no rule decides this.',
      steps: ['It has no condition and no rule shows, hides or chooses it, so every customer gets it.', 'The document is in English (United States).'],
      ruleIds: [], variantId: null, nodeId: 'greeting',
    });
    const required = explainNode(card, res, 'sample-disclosure-set');
    expect(required.headline).toBe('“Sample disclosures” is always shown to Jordan Mercer: the rule “Mandatory statement content” requires it.');
    expect(required.ruleIds).toEqual(['R12']);
    const unknown = explainNode(card, res, 'no-such-component');
    expect(unknown).toEqual({ headline: 'This is not a component of the document, so there is nothing to explain.', steps: [], ruleIds: [], variantId: null, nodeId: 'no-such-component' });
    expect(() => explainNode(card, res, '')).not.toThrow();
  });

  it('answers for a message asked about by its own name', () => {
    const e = explainNode(card, res, 'payment-reminder');
    expect(e.headline).toBe('Jordan Mercer does not get “Payment reminder” in “Payment guidance”.');
    expect(e.steps[0]).toBe('Jordan Mercer gets “Payment instructions” in “Payment guidance” because the rule “Customer is up to date” matched.');
    expect(e.steps).toContain('The rule “One missed payment — send a reminder”, which shows “Payment reminder”, did not match: it applies only when missed payments is 1; for Jordan Mercer, missed payments is 0.');
    expect(e.nodeId).toBe('payment-reminder');
  });

  it('names the document language, the rule that set it, missing translations and draft previews', () => {
    const spanish = RECORDS.find((x) => x.documentType === 'credit-statement' && x.customer.locale === 'es-US')!;
    const plain = explainNode(card, resolve({ project: card, record: spanish }), 'payment-guidance');
    expect(plain.steps).toContain('The document is in Spanish (United States) because the rule “Spanish-speaking customer — use approved Spanish wording” matched.');
    expect(plain.steps[plain.steps.length - 1]).toBe('Some of this wording has no approved Spanish translation, so the English text is shown.');
    expect(plain.ruleIds).toContain('R07');

    const drafted = run(card, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: 'Su pago vence el {{card.dueDate}}.' });
    const preview = resolve({ project: drafted, record: spanish, includeDrafts: true });
    expect(preview.translation.draftsShown).toContain('payment-standard');
    const e = explainNode(drafted, preview, 'payment-guidance');
    expect(e.steps[e.steps.length - 1]).toBe('The Spanish wording shown here is a draft that has not been approved yet; this is a preview.');
    expect(e.headline).toMatch(/gets “Payment instructions” in “Payment guidance”/); // English names, whatever the document language
    // without the preview flag the draft is not shown, and the explanation does not claim it is
    expect(explainNode(drafted, resolve({ project: drafted, record: spanish }), 'payment-guidance').steps.join(' ')).not.toMatch(/draft/);
  });

  it('explains the liability safeguard on an EOB amount from what the engine recorded', () => {
    const r = resolve({ project: eob, record: recordById('EOB-0002')! });
    const e = explainNode(eob, r, 'member-responsibility');
    expect(e.steps).toContain('The amount is not shown as owed, because the member’s responsibility has not been confirmed.');
    const msg = explainNode(eob, r, 'eob-claim-message');
    expect(msg.headline).toMatch(/gets “Claim under review” in “Claim message” because the rule “Claim denied — under review” matched\.$/);
    expect(msg.steps[0]).toBe('It matched because claim status is “denied pending review”.');
  });
});

/* ------------------------------------------------------------------ column matching */

describe('matchColumns', () => {
  const byColumn = (ms: ReturnType<typeof matchColumns>) => Object.fromEntries(ms.map((m) => [m.column, m]));

  it('matches every column of the studio’s own CSV template exactly, with no complaints about its example row', () => {
    for (const p of [card, eob]) {
      // same construction as the "CSV template" download in the import dialog
      const cols = fieldsFor(p.documentType).filter((f) => !f.derived && f.type !== 'array' && f.path !== 'documentType' && f.path !== 'recordId').map((f) => f.path);
      const example = RECORDS.find((r) => r.documentType === p.documentType)!;
      const ctx = buildContext(example);
      const header = ['recordId', ...cols];
      const row = ['EXAMPLE-1', ...cols.map((c) => { const v = getPath(ctx, c); return v === null || v === undefined ? '' : String(v); })];
      const ms = matchColumns(header, [row], p);
      expect(ms.map((m) => m.column)).toEqual(header);
      expect(ms.every((m) => m.confidence === 'exact' && m.path === m.column && !m.sampleProblem)).toBe(true);
    }
  });

  it('recognises headings written differently and common other names', () => {
    const m = byColumn(matchColumns(['Customer ID', 'First Name', 'surname', 'Language', 'Acct No', 'Min Payment', 'due_date', 'New balance', 'paymentStatus', 'Missed', 'statement-start', 'Fees & Interest', 'CARD.DUEDATE '], [], card));
    expect(m['Customer ID']).toMatchObject({ path: 'recordId', confidence: 'likely' });
    expect(m['First Name']).toMatchObject({ path: 'customer.givenName', confidence: 'likely', reason: '“First Name” is another name for “Given name”.' });
    expect(m.surname).toMatchObject({ path: 'customer.familyName', confidence: 'likely' });
    expect(m.Language).toMatchObject({ path: 'customer.locale', confidence: 'likely' });
    expect(m['Acct No']).toMatchObject({ path: 'card.maskedAccount', confidence: 'likely' });
    expect(m['Min Payment']).toMatchObject({ path: 'card.minimumDueCents', confidence: 'likely' });
    expect(m['New balance']).toMatchObject({ path: 'card.newBalanceCents', confidence: 'likely', reason: 'It is the name of the field “New balance”.' });
    expect(m.paymentStatus).toMatchObject({ path: 'card.paymentStatus', confidence: 'likely', reason: 'Same name as the field “Payment status”, written differently.' });
    expect(m.Missed).toMatchObject({ path: 'card.missedPayments', confidence: 'likely' });
    expect(m['statement-start']).toMatchObject({ path: 'card.statementStart', confidence: 'likely' });
    expect(m['Fees & Interest']).toMatchObject({ path: 'card.interestFeesCents', confidence: 'likely' });
    // "due_date" and "CARD.DUEDATE" are the same field: one column keeps it
    expect([m.due_date.path, m['CARD.DUEDATE '].path].filter(Boolean)).toEqual(['card.dueDate']);

    const e = byColumn(matchColumns(['member id', 'Claim Number', 'Billed', 'allowed', 'Plan Paid', 'Patient Responsibility', 'status', 'Date of service', 'plan'], [], eob));
    expect(Object.values(e).map((x) => x.path)).toEqual(['member.memberId', 'claim.claimId', 'claim.billedCents', 'claim.allowedCents', 'claim.planPaidCents', 'claim.patientResponsibilityCents', 'claim.status', 'claim.serviceDate', 'member.planName']);
    expect(Object.values(e).every((x) => x.confidence === 'likely')).toBe(true);
    // "status" means the payment status on a statement
    expect(matchColumns(['Status', 'Balance', 'Account'], [], card).map((x) => x.path)).toEqual(['card.paymentStatus', 'card.newBalanceCents', 'card.maskedAccount']);
  });

  it('guesses with a reason, refuses what it cannot place, and never gives two columns the same field', () => {
    const m = byColumn(matchColumns(['Ballance prev', 'Balance', 'New balance', 'Favourite colour', 'Available credit', 'Name', 'documentType', ''], [], card));
    expect(m['Ballance prev']).toEqual({ column: 'Ballance prev', path: 'card.previousBalanceCents', confidence: 'guess', reason: 'A guess: “Ballance prev” shares the words “balance”, “previous” with “Previous balance”. Check it.' });
    expect(m['New balance'].path).toBe('card.newBalanceCents');
    expect(m.Balance).toEqual({ column: 'Balance', path: null, confidence: 'none', reason: 'Column “New balance” is the better match for “New balance”, and a field takes one column only.' });
    expect(m['Favourite colour']).toEqual({ column: 'Favourite colour', path: null, confidence: 'none', reason: 'No field has a similar name.' });
    expect(m['Available credit']).toMatchObject({ path: null, confidence: 'none', reason: '“Available credit” is calculated by the studio and cannot be imported.' });
    expect(m.Name).toMatchObject({ path: null, confidence: 'none' }); // given or family name? not guessed
    expect(m.documentType.path).toBeNull();
    expect(m[''].reason).toBe('The column has no heading.');
    const all = matchColumns(['Balance', 'New balance', 'card.newBalanceCents', 'Ballance'], [], card);
    expect(all.filter((x) => x.path === 'card.newBalanceCents').map((x) => x.column)).toEqual(['card.newBalanceCents']);
    expect(new Set(all.map((x) => x.path).filter(Boolean)).size).toBe(all.filter((x) => x.path).length);
  });

  it('matches custom fields by key and label and checks their values', () => {
    const p = { documentType: card.documentType, customFields: [{ key: 'loyaltyTier', label: 'Loyalty tier', type: 'enum' as const, enumValues: ['gold', 'silver'] }, { key: 'joinedOn', label: 'Member since', type: 'date' as const }] };
    const m = matchColumns(['custom.loyaltyTier', 'Member Since', 'loyalty_tier'], [['bronze', '2020-02-30', 'gold']], p);
    expect(m[0]).toMatchObject({ path: 'custom.loyaltyTier', confidence: 'exact', sampleProblem: '“bronze” is not one of the allowed values (gold, silver).' });
    expect(m[1]).toMatchObject({ path: 'custom.joinedOn', confidence: 'likely', sampleProblem: '“2020-02-30” is not a date written as YYYY-MM-DD.' });
    expect(m[2]).toMatchObject({ path: null, confidence: 'none' });
  });

  it('points out sample values that would be rejected', () => {
    const headers = ['Min Payment', 'due_date', 'Language', 'Missed', 'New balance', 'Tier', 'assistance requested', 'First Name'];
    const rows = [
      ['45.00', '25/11/2026', 'Spanish', 'two', '124800', 'gold', 'maybe', 'Ana'],
      ['$1,248.50', '2026-11-25', 'en-US', '1', '99', 'premium', 'yes', 'Bo'],
      ['', '2026-11-25', 'es-US', '0', '100', 'standard', 'no', ''],
    ];
    const m = byColumn(matchColumns(headers, rows, card));
    expect(m['Min Payment'].sampleProblem).toBe('“45.00” looks like dollars, expected cents (4500 for this value). 2 of 2 sample values do not fit.');
    expect(m.due_date.sampleProblem).toBe('“25/11/2026” is not a date written as YYYY-MM-DD. 1 of 3 sample values does not fit.');
    expect(m.Language.sampleProblem).toBe('“Spanish” is not one of the allowed values (en-US, es-US). 1 of 3 sample values does not fit.');
    expect(m.Missed.sampleProblem).toBe('“two” is not a whole number. 1 of 3 sample values does not fit.');
    expect(m.Tier.sampleProblem).toMatch(/^“gold” is not one of the allowed values \(standard, premium\)/);
    expect(m['assistance requested'].sampleProblem).toMatch(/^“maybe” is not yes or no/);
    expect(m['New balance'].sampleProblem).toBeUndefined();
    expect(m['First Name'].sampleProblem).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ activity search */

describe('parseActivityQuery', () => {
  // Friday 13 November 2026, 10:30 UTC
  const ctx = {
    now: '2026-11-13T10:30:00.000Z',
    users: [{ id: 'u-thandi', name: 'Thandi Nkosi' }, { id: 'u-alan', name: 'Alan Reid' }, { id: 'u-april', name: 'April Jones' }],
    projects: [{ projectId: 'aster-card-demo', title: 'Aster Card – credit-card statement' }, { projectId: 'harborcare-demo', title: 'HarborCare – explanation of benefits' }],
  };
  const parse = (q: string) => parseActivityQuery(q, ctx);

  it('understands people', () => {
    expect(parse('saves by Thandi today')).toEqual({ user: 'u-thandi', action: 'project.save', since: '2026-11-13T00:00:00.000Z', understood: ['By Thandi Nkosi', 'Saves', 'Today (13 Nov 2026)'], ignored: [] });
    expect(parse('what did Alan Reid approve yesterday?')).toMatchObject({ user: 'u-alan', action: 'workflow.approve', since: '2026-11-12T00:00:00.000Z', until: '2026-11-13T00:00:00.000Z' });
    expect(parse('by April in harborcare')).toEqual({ user: 'u-april', projectId: 'harborcare-demo', understood: ['By April Jones', 'Project “HarborCare – explanation of benefits”'], ignored: [] }); // a person, not the month
    expect(parse('who changed the rules last week?')).toEqual({ since: '2026-11-02T00:00:00.000Z', until: '2026-11-09T00:00:00.000Z', text: 'rule', understood: ['Anyone (each entry shows who did it)', 'Rules', 'Last week (2 Nov 2026 to 8 Nov 2026)'], ignored: [] });
    // somebody we do not know, and "my": said back as not understood, never guessed
    expect(parse('edits by Sipho last month')).toMatchObject({ since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z', ignored: ['sipho'] });
    expect(parse('edits by Sipho last month').user).toBeUndefined();
    expect(parse('my saves this month')).toMatchObject({ action: 'project.save', since: '2026-11-01T00:00:00.000Z', ignored: ['me'] });
  });

  it('understands areas', () => {
    expect(parse('saved').action).toBe('project.save');
    expect(parse('saves').action).toBe('project.save');
    expect(parse('approved').action).toBe('workflow.approve');
    expect(parse('approval').action).toBe('workflow.approve');
    expect(parse('review').action).toBe('workflow.');
    expect(parse('review and approval')).toMatchObject({ action: 'workflow.', understood: ['Review and approval'] });
    expect(parse('submitted for review').action).toBe('workflow.submit');
    expect(parse('comments').action).toBe('comment.');
    expect(parse('who resolved comments').action).toBe('comment.resolve');
    expect(parse('exports').action).toBe('batch.');
    expect(parse('batches').action).toBe('batch.');
    expect(parse('who signed in').action).toBe('auth.login');
    expect(parse('failed sign-ins').action).toBe('auth.login_failed');
    expect(parse('AI changes')).toMatchObject({ action: 'assist.', understood: ['Changes made with the assistant'] });
    expect(parse('what did the assistant do').action).toBe('assist.');
    expect(parse('restored versions').action).toBe('project.restore');
    expect(parse('imported records').action).toBe('records.import');
    for (const q of ['wording', 'content changes', 'text edits']) expect(parse(q)).toMatchObject({ text: 'wording', understood: ['Wording'] });
    expect(parse('rules')).toEqual({ text: 'rule', understood: ['Rules'], ignored: [] });
    expect(parse('translations approved on 12 Nov')).toEqual({ action: 'workflow.approve', text: 'translation', since: '2026-11-12T00:00:00.000Z', until: '2026-11-13T00:00:00.000Z', understood: ['Approvals', 'Translations', '12 Nov 2026'], ignored: [] });
    // two different kinds of entry cannot both be filtered: the first is used, the other is said back
    expect(parse('saved or approved')).toMatchObject({ action: 'project.save', ignored: ['approved'] });
  });

  it('understands time, computed from the given now in UTC', () => {
    expect(parse('today')).toMatchObject({ since: '2026-11-13T00:00:00.000Z', understood: ['Today (13 Nov 2026)'] });
    expect(parse('today').until).toBeUndefined();
    expect(parse('yesterday')).toMatchObject({ since: '2026-11-12T00:00:00.000Z', until: '2026-11-13T00:00:00.000Z' });
    expect(parse('last week')).toMatchObject({ since: '2026-11-02T00:00:00.000Z', until: '2026-11-09T00:00:00.000Z' });
    expect(parse('this week')).toMatchObject({ since: '2026-11-09T00:00:00.000Z', understood: ['This week (since Monday 9 Nov 2026)'] });
    expect(parse('this week').until).toBeUndefined();
    expect(parse('exports in the last 7 days')).toEqual({ action: 'batch.', since: '2026-11-06T10:30:00.000Z', understood: ['Batch runs and exports', 'Last 7 days (since 6 Nov 2026)'], ignored: [] });
    expect(parse('last 24 hours').since).toBe('2026-11-12T10:30:00.000Z');
    expect(parse('who signed in since Monday')).toMatchObject({ action: 'auth.login', since: '2026-11-09T00:00:00.000Z', understood: ['Anyone (each entry shows who did it)', 'Sign-ins', 'Since Monday 9 Nov 2026'] });
    expect(parse('since Monday').until).toBeUndefined();
    expect(parse('on Tuesday')).toMatchObject({ since: '2026-11-10T00:00:00.000Z', until: '2026-11-11T00:00:00.000Z' });
    expect(parse('last Friday')).toMatchObject({ since: '2026-11-06T00:00:00.000Z', until: '2026-11-07T00:00:00.000Z' }); // today is Friday: the one before
    expect(parse('AI changes in November')).toMatchObject({ action: 'assist.', since: '2026-11-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z', understood: ['Changes made with the assistant', 'November 2026'] });
    expect(parse('in December')).toMatchObject({ since: '2025-12-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z' }); // not in the future
    expect(parse('on 12 Nov')).toMatchObject({ since: '2026-11-12T00:00:00.000Z', until: '2026-11-13T00:00:00.000Z', understood: ['12 Nov 2026'] });
    expect(parse('November 3rd, 2025')).toMatchObject({ since: '2025-11-03T00:00:00.000Z', until: '2025-11-04T00:00:00.000Z' });
    expect(parse('2026-11-05')).toMatchObject({ since: '2026-11-05T00:00:00.000Z', until: '2026-11-06T00:00:00.000Z' });
    expect(parse('since 2026-11-01')).toMatchObject({ since: '2026-11-01T00:00:00.000Z', understood: ['Since 1 Nov 2026'] });
    expect(parse('saved from 2026-11-01 to 2026-11-05')).toEqual({ action: 'project.save', since: '2026-11-01T00:00:00.000Z', until: '2026-11-06T00:00:00.000Z', understood: ['Saves', 'From 1 Nov 2026 to 5 Nov 2026'], ignored: [] });
    expect(parse('before 12 Nov 2026')).toEqual({ until: '2026-11-12T00:00:00.000Z', understood: ['Before 12 Nov 2026'], ignored: [] });
    // the result depends on now only
    expect(parseActivityQuery('yesterday', { now: '2027-01-01T00:00:00.000Z' })).toMatchObject({ since: '2026-12-31T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z' });
    expect(parseActivityQuery('last week', { now: 'not a date' })).toEqual({ understood: [], ignored: [] });
  });

  it('understands project names and sends what it does not know to the free-text filter', () => {
    expect(parse('wording changes in Aster Card since 2026-11-01')).toEqual({ projectId: 'aster-card-demo', text: 'wording', since: '2026-11-01T00:00:00.000Z', understood: ['Wording', 'Since 1 Nov 2026', 'Project “Aster Card – credit-card statement”'], ignored: [] });
    expect(parse('comments on the harborcare project').projectId).toBe('harborcare-demo');
    expect(parse('aster-card-demo saves').projectId).toBe('aster-card-demo');
    expect(parse('payment reminder edits last month')).toEqual({ text: 'payment reminder', since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z', understood: ['Last month (October 2026)'], ignored: ['payment', 'reminder'] });
    expect(parse('show me everything')).toEqual({ understood: [], ignored: [] });
    expect(parse('')).toEqual({ understood: [], ignored: [] });
    expect(parseActivityQuery('saves by Thandi', { now: ctx.now })).toMatchObject({ action: 'project.save', ignored: ['thandi'] }); // no list of people given
  });
});

/* ------------------------------------------------------------------ alt text */

describe('suggestAltText', () => {
  it('describes the issuer logo of both samples from its name and place, and says the picture was not seen', () => {
    expect(suggestAltText(card, 'issuer-logo')).toEqual({ text: 'Aster Card logo', basis: 'From the component name and its place in the header; the picture itself was not examined' });
    expect(suggestAltText(eob, 'issuer-logo')).toEqual({ text: 'HarborCare Health logo', basis: 'From the component name and its place in the header; the picture itself was not examined' });
  });

  it('returns null for anything that is not a picture, and when nothing sensible can be said', () => {
    expect(suggestAltText(card, 'greeting')).toBeNull();
    expect(suggestAltText(card, 'no-such-node')).toBeNull();
    const body = (name: string, extra: Record<string, unknown> = {}) => run(card, { type: 'INSERT_NODE', parentId: 'doc-root', node: { id: 'pic-1', type: 'image', name, image: { src: 'data:image/png;base64,AAAA', alt: '' }, layout: { paged: { mode: 'flow' }, html: { area: 'main', span: 12 } }, ...extra } });
    expect(suggestAltText(body('Image'), 'pic-1')).toBeNull();
    expect(suggestAltText(body('Divider flourish', { decorative: true }), 'pic-1')).toBeNull();
  });

  it('uses the component name for other pictures, never "image of", at most 120 characters', () => {
    const body = (name: string, src = 'data:image/png;base64,AAAA') => run(card, { type: 'INSERT_NODE', parentId: 'doc-root', node: { id: 'pic-1', type: 'image', name, image: { src, alt: '' }, layout: { paged: { mode: 'flow' }, html: { area: 'main', span: 12 } } } });
    expect(suggestAltText(body('Image of rewards banner'), 'pic-1')).toEqual({ text: 'Rewards banner', basis: 'From the component name and its place in the body of the document; the picture itself was not examined' });
    expect(suggestAltText(body('Picture 2', 'asset:spring-offer-banner'), 'pic-1')).toEqual({ text: 'Spring offer banner', basis: 'From the name of the picture file; the picture itself was not examined' });
    const long = suggestAltText(body(`Customer service team ${'helping a cardholder at the branch counter '.repeat(5)}`), 'pic-1')!;
    expect(long.text.length).toBeLessThanOrEqual(120);
    expect(long.text).toMatch(/^Customer service team helping .+…$/);
    // a nameless picture in the header is most likely the logo: offered as a guess
    const header = run(card, { type: 'UPDATE_NODE', nodeId: 'issuer-logo', patch: { name: 'Image', image: { src: 'data:image/png;base64,AAAA', alt: '' } } });
    expect(suggestAltText(header, 'issuer-logo')).toEqual({ text: 'Aster Card logo', basis: 'A guess from its place in the header, where the issuer’s logo usually sits; the picture itself was not examined' });
  });
});

/* ------------------------------------------------------------------ writing */

describe('readingLevel and plain wording', () => {
  it('grades English text with Flesch–Kincaid, ignoring tokens, markup and addresses', () => {
    const easy = readingLevel('The cat sat on the mat. It was a big cat.')!;
    expect(easy).toMatchObject({ words: 11, sentences: 2, longSentences: 0 });
    expect(easy.grade).toBeLessThan(2);
    expect(easy.label).toMatch(/^Easy \(about grade \d\)$/);

    const due = readingLevel('Your payment is due on {{card.dueDate}}.')!;
    expect(due).toMatchObject({ words: 5, sentences: 1 });
    expect(readingLevel('**Your** payment is due on {{card.dueDate}}. See https://example.com/aster/payments')!.words).toBe(6);

    const hard = readingLevel('This synthetic statement does not calculate annual percentage rate, interest or payoff timelines. Figures are fictional demonstration data and not regulatory-compliant financial calculations.')!;
    expect(hard.sentences).toBe(2);
    expect(hard.grade).toBeGreaterThan(12);
    expect(hard.label).toMatch(/^Hard /);
    expect(hard.grade).toBeGreaterThan(readingLevel('If making a payment is difficult, review assistance options.')!.grade);

    const long = readingLevel(`We are writing to let you know that ${'your account and your card and your statement '.repeat(4)}are all fine. Thank you.`)!;
    expect(long.longSentences).toBe(1);
  });

  it('returns null for fewer than three words and for text that is clearly not English', () => {
    expect(readingLevel('Hi there')).toBeNull();
    expect(readingLevel('{{card.dueDate}} {{card.newBalanceCents}}')).toBeNull();
    expect(readingLevel('')).toBeNull();
    expect(readingLevel('Su estado de cuenta ya se puede consultar en línea hoy.')).toBeNull();
    expect(readingLevel('Votre relevé est prêt pour vous dans votre espace.')).toBeNull();
    expect(readingLevel('Payment due date')).not.toBeNull();
  });

  it('words conditions and lists the way the engines share them', () => {
    expect(conditionWords(card, { op: 'and', args: [{ op: 'gte', path: 'card.missedPayments', value: 2 }, { op: 'eq', path: 'card.assistanceRequested', value: false }] })).toBe('missed payments is at least 2 and assistance requested is no');
    expect(conditionWords(card, { op: 'gt', path: 'card.minimumDueCents', value: 4500 })).toBe('minimum payment due is more than $45.00');
    expect(listWords(['a', 'b', 'c', 'd', 'e'], 3, 'labels')).toBe('a, b, c and 2 more labels');
    expect(listWords(['a', 'b'])).toBe('a and b');
  });
});
