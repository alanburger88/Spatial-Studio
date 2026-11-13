import { describe, expect, it } from 'vitest';
import { blankProject, customFieldDefs, usageEntryFromResolution, validateRecordShape, type Project, type SyntheticRecord } from '@iss/model';
import { RECORDS } from '@iss/model/fixtures';
import { resolve } from '@iss/resolver';
import {
  analyseDecisionTable, baselineCustomer, buildCube, buildLandscape, captureExpectation, coverageGaps, decisionGroups, DIMENSIONS, draftRuleFromSentence, EDGE_CASE_PRESETS,
  explainInPlainWords, generateEdgeCase, groupFindings, impactOf, matchColumns, planTestData, replayJourney, reviewRules, ruleVocabulary, runTestCases, ScenarioEngine, summarizeChanges,
} from '../src';
import { GYM_FIELDS, gymMember, gymProject, run, SAMPLE_WORDING } from '../../model/test/helpers/customProject';

const p = gymProject({ withSpanish: true });
const plan = planTestData(p, [], { outcomes: true, edges: true });
/** The plan's customers as the API stores them. */
const stored = (project: Project, customers = plan.customers): SyntheticRecord[] => customers.map((c, i) => ({ ...c.record, recordId: `REC-${60001 + i}`, projectId: project.projectId, generated: { label: c.label } }));
const records = stored(p);
const noSampleWords = (value: unknown, what: string) => expect(JSON.stringify(value).match(SAMPLE_WORDING)?.[0], what).toBeUndefined();

describe('test customers for a document with its own data, planned from nothing', () => {
  it('covers every rule, message, section, language and edge value with no starting customers at all', () => {
    expect(plan.summary).toEqual({ outcomes: { total: 9, reached: 9 }, edges: { total: 12, reached: 12 }, unreachable: 0, capped: false });
    const kinds = (kind: string) => plan.targets.filter((t) => t.kind === kind).map((t) => t.targetId).sort();
    expect(kinds('rule')).toEqual(['R01', 'R02']);
    expect(kinds('variant')).toEqual(['note-lapsing', 'note-pro', 'renewal-note-default']);
    expect(kinds('section-shown')).toEqual(['busy-note']);
    expect(kinds('section-hidden')).toEqual(['busy-note']);
    expect(kinds('language')).toEqual(['en-US', 'es-US']);
    expect(plan.targets.filter((t) => t.kind === 'edge' || t.kind === 'empty').map((t) => t.id)).toEqual([
      'edge:custom.tier:is:pro', 'edge:custom.autoRenew:is:true', 'edge:custom.autoRenew:is:false',
      'edge:custom.visits:below:2', 'edge:custom.visits:on:2', 'edge:custom.visits:above:2',
      'edge:custom.sessions.count:below:3', 'edge:custom.sessions.count:on:3', 'edge:custom.sessions.count:above:3',
      'empty:custom.autoRenew', 'empty:custom.visits', 'empty:custom.sessions',
    ]);
    expect(plan.targets.every((t) => t.customer !== null)).toBe(true);
  });

  it('every customer is a valid record of this project, resolves cleanly and reads without sample wording', () => {
    const extra = customFieldDefs(GYM_FIELDS);
    expect(plan.customers.length).toBeGreaterThanOrEqual(8);
    for (const r of records) {
      expect(r.documentType).toBe('custom');
      expect(validateRecordShape(JSON.parse(JSON.stringify(r)), 'custom', extra), r.generated!.label).toEqual([]);
      expect(resolve({ project: p, record: r }).findings.filter((f) => f.severity === 'blocking'), r.generated!.label).toEqual([]);
      expect((r as { card?: unknown; claims?: unknown; member?: unknown; personaId?: unknown }).card ?? (r as { claims?: unknown }).claims ?? (r as { member?: unknown }).member ?? r.personaId).toBeUndefined();
    }
    noSampleWords(plan, 'plan');
    // a list is filled with rows of its columns, and the row count is reached by adding or removing rows
    const rowsOf = (id: string) => (records[plan.targets.find((t) => t.id === id)!.customer!].custom!.sessions as unknown[]);
    expect(rowsOf('edge:custom.sessions.count:above:3')).toHaveLength(4);
    expect(rowsOf('edge:custom.sessions.count:below:3')).toHaveLength(2);
    expect(rowsOf('empty:custom.sessions')).toEqual([]);
    expect(Object.keys(rowsOf('edge:custom.sessions.count:on:3')[0] as object).sort()).toEqual(['className', 'day', 'priceCents', 'spots']);
    expect(new Set(records.map((r) => `${r.customer.givenName} ${r.customer.familyName}`)).size).toBe(records.length);
    // deterministic
    expect(planTestData(gymProject({ withSpanish: true }), [], { outcomes: true, edges: true })).toEqual(plan);
  });

  it('ignores customers of other kinds, and an empty blank project still gets one customer to preview with', () => {
    expect(planTestData(p, RECORDS, { outcomes: true, edges: true })).toEqual(plan);
    const blank = blankProject({ projectId: 'empty-doc', title: 'Empty' });
    const first = planTestData(blank, [], { outcomes: true, edges: true });
    expect(first.customers).toHaveLength(1);
    expect(first.customers[0]).toMatchObject({ label: 'Document in English (United States)', record: { documentType: 'custom', customer: { locale: 'en-US' } } });
    expect(first.targets.map((t) => t.id)).toEqual(['language:en-US']);
    const base = baselineCustomer(p);
    expect(base).toMatchObject({ label: 'Starting customer: every field filled in', record: { documentType: 'custom', customer: { givenName: 'Avery', familyName: 'Abbott', locale: 'en-US' }, custom: { planName: 'Flex', monthlyFeeCents: 4900, renewalDate: '2026-12-01', tier: 'basic' } } });
    expect(base.record.custom!.sessions).toHaveLength(3);
    expect(validateRecordShape(JSON.parse(JSON.stringify(base.record)), 'custom', customFieldDefs(GYM_FIELDS))).toEqual([]);
    expect(baselineCustomer(blank).record).toEqual({ documentType: 'custom', customer: { givenName: 'Avery', familyName: 'Abbott', locale: 'en-US', accessibility: { largeText: false, highContrast: false }, middleName: 'Sample middle name' } });
  });
});

describe('cube and landscape for a document with its own data', () => {
  const engine = new ScenarioEngine(p, [...RECORDS, ...records]);

  it('offers customer, journey, output and language; card and claim dimensions are not offered', () => {
    expect(DIMENSIONS.filter((d) => d.documentTypes.includes('custom')).map((d) => d.id)).toEqual(['persona', 'journey', 'output', 'language']);
    expect(DIMENSIONS.filter((d) => d.documentTypes.includes('credit-statement')).map((d) => d.id)).toEqual(['persona', 'journey', 'output', 'language', 'paymentStatus', 'accountTier', 'channel']);
    expect(EDGE_CASE_PRESETS.some((e) => (e.documentType as string) === 'custom')).toBe(false);
    expect(() => generateEdgeCase(records[0], 'zero-transactions')).toThrow(/applies to credit-statement records/);
    expect(buildCube(engine, ['persona', 'paymentStatus', 'output']).errors).toEqual(['Payment status is not available for a document with its own data.']);
  });

  it('the cube names customers without a persona by why they were generated, and uses the project’s own languages', () => {
    const cube = buildCube(engine, ['persona', 'output', 'language']);
    expect(cube.errors).toEqual([]);
    expect(cube.universeSize).toBe(records.length * 3);
    const [who, , language] = cube.axes;
    expect(who.totalCategories).toBe(records.length);
    expect(who.categories.map((c) => c.label)).toEqual(records.slice(0, 5).map((r) => r.generated!.label));
    expect(language.categories.map((c) => c.key)).toEqual(['en-US', 'es-US']);
    expect(cube.cells.reduce((s, c) => s + c.count, 0)).toBe(5 * 3);
    noSampleWords(cube.axes, 'cube axes');
    // a customer with neither persona nor label is named by name; one with nothing at all still has a label
    const plain = new ScenarioEngine(p, [gymMember(), { ...gymMember({ recordId: 'REC-60002' }), customer: { givenName: '', familyName: '', locale: 'en-US' } }]);
    expect(buildCube(plain, ['persona', 'output', 'journey']).axes[0].categories.map((c) => c.label)).toEqual(['Robin Okoye', 'Customer']);
    // English only: one language
    const blank = blankProject({ projectId: 'empty-doc', title: 'Empty' });
    const one = buildCube(new ScenarioEngine(blank, stored(blank, planTestData(blank, [], { outcomes: true, edges: true }).customers)), ['persona', 'output', 'language']);
    expect(one.axes[2].categories.map((c) => c.key)).toEqual(['en-US']);
    expect(one.primaryVariantSet).toBeNull();
    expect(one.cells.filter((c) => c.count).map((c) => c.dominantOutcome)).toEqual(['n/a', 'n/a', 'n/a']);
  });

  it('the landscape groups the project’s own customers by outcome and reconciles', () => {
    const land = buildLandscape(engine);
    expect(land.reconciles).toBe(true);
    expect(land.universeSize).toBe(records.length);
    expect(land.countBasis).toBe('This project’s synthetic customers (actual count, unweighted)');
    expect(land.clusters.map((c) => c.label.split(' + ')[0]).sort()).toEqual([...new Set(land.clusters.map((c) => c.label.split(' + ')[0]))].sort());
    expect(new Set(land.clusters.map((c) => c.signature.variants['renewal-note']))).toEqual(new Set(['renewal-note-default', 'note-pro', 'note-lapsing']));
    expect(land.clusters.every((c) => c.blockingScenarios === 0)).toBe(true);
    const blank = blankProject({ projectId: 'empty-doc', title: 'Empty' });
    const empty = buildLandscape(new ScenarioEngine(blank, stored(blank, planTestData(blank, [], { outcomes: true, edges: true }).customers)));
    expect(empty.clusters.map((c) => [c.label, c.count, c.severity])).toEqual([['Same document for everyone', 1, 'ok']]);
  });

  it('the samples’ cube is unchanged: a customer without a persona who was not generated is still “none”', () => {
    const [card] = [RECORDS.find((r) => r.documentType === 'credit-statement')!];
    const { personaId: _p, ...noPersona } = card;
    const seeds = new ScenarioEngine({ ...p, documentType: 'credit-statement', rules: [], nodes: [{ id: 'doc-root', type: 'container', children: [] }], contentParts: [], customFields: [] }, [{ ...noPersona, recordId: 'CARD-5001' } as SyntheticRecord]);
    expect(buildCube(seeds, ['persona', 'output', 'journey']).axes[0].categories.map((c) => [c.key, c.label])).toEqual([['none', 'none']]);
  });
});

describe('the other engines on a document with its own data', () => {
  it('journey replay with no events is the baseline alone; with events it shows what they change', () => {
    expect(replayJourney(p, records[0]).map((s) => [s.kind, s.label, s.state])).toEqual([['baseline', 'Baseline', {}]]);
    const withEvent = run(p, { type: 'SET_JOURNEY', events: [{ eventId: 'upgrade', eventType: 'plan.upgraded', label: 'Upgraded to Pro', day: 10, effects: [{ op: 'set', path: 'custom.tier', value: 'pro' }] }] });
    const snaps = replayJourney(withEvent, gymMember());
    expect(snaps.map((s) => [s.kind, s.selectedVariants['renewal-note'], s.state])).toEqual([['baseline', 'renewal-note-default', { 'custom.tier': 'plus' }], ['preview', 'note-pro', { 'custom.tier': 'pro' }]]);
  });

  it('decision table, rule review, coverage and suggested fixes read the project’s own fields and customers', () => {
    expect(decisionGroups(p)).toEqual([{ id: 'renewal-note', kind: 'exclusive', ruleIds: ['R01', 'R02'] }]);
    const table = analyseDecisionTable(p, 'renewal-note', [...RECORDS, ...records]);
    expect(table).toMatchObject({ fields: ['custom.autoRenew', 'custom.visits', 'custom.tier'], evaluated: records.length, unresolved: 0, blocking: 0 });
    expect(table.wins.R01 + table.wins.R02 + table.fallbackWins).toBe(records.length);
    const review = reviewRules(p, records);
    expect(review.every((o) => o.severity !== 'blocking')).toBe(true);
    noSampleWords(review, 'rule review');
    // one customer only: the engine finds what-ifs for everything it does not reach, in the project's own fields
    const gaps = coverageGaps(p, [gymMember()]);
    expect(gaps.map((g) => g.id)).toEqual(['rule:R01', 'rule:R02', 'variant:renewal-note/note-lapsing', 'variant:renewal-note/note-pro', 'section:busy-note']);
    expect(gaps.every((g) => g.scenario !== null && g.testCase)).toBe(true);
    expect(gaps[0].scenario).toMatchObject({ recordId: 'REC-60001', overrides: { custom: { tier: 'pro' } }, explanation: 'Start from Robin Okoye and set Membership tier to “pro”.' });
    expect(gaps[4].scenario!.overrides).toMatchObject({ custom: { sessions: expect.any(Array) } });
    expect((gaps[4].scenario!.overrides as { custom: { sessions: unknown[] } }).custom.sessions).toHaveLength(4);
    noSampleWords(gaps, 'coverage');
    expect(coverageGaps(p, records)).toEqual([]);
    const groups = groupFindings(p, records);
    expect(groups.every((g) => g.finding.severity !== 'blocking')).toBe(true);
    noSampleWords(groups.map((g) => g.finding.message), 'findings');
    // a broken binding on this kind is explained without naming a built-in schema
    const broken = { ...p, nodes: p.nodes.map((n) => (n.id === 'renewal' ? { ...n, binding: 'custom.renewsOn' } : n)) };
    const finding = resolve({ project: broken, record: gymMember() }).findings.find((f) => f.code === 'INVALID_BINDING')!;
    expect(finding.message).toBe('Unknown field path “custom.renewsOn” in renewal. Only the customer fields and this project’s own data fields can be used.');
  });

  it('pinned tests, impact preview and the change summary work on its customers', () => {
    const rec = gymMember({ custom: { tier: 'pro' } });
    const pinned = run(p, { type: 'UPSERT_TEST_CASE', testCase: { id: 'T01', name: 'Pro note', recordId: rec.recordId, expect: captureExpectation(p, rec) } });
    expect(runTestCases(pinned, [rec]).map((t) => t.pass)).toEqual([true]);
    const lower = run(pinned, { type: 'UPSERT_RULE', rule: { ...pinned.rules.find((r) => r.id === 'R01')!, when: { op: 'eq', path: 'custom.tier', value: 'plus' } } });
    expect(runTestCases(lower, [rec]).map((t) => t.pass)).toEqual([false]);
    const impact = impactOf(pinned, lower, [...RECORDS, ...records]);
    expect(impact.evaluated).toBe(records.length);
    expect(impact.changed.length).toBeGreaterThan(0);
    const summary = summarizeChanges(pinned, lower, records);
    expect(summary.headline).toMatch(/1 rule change/);
    expect(summary.impact.totalCustomers).toBe(records.length);
    noSampleWords(summary, 'change summary');
  });

  it('rule drafting knows only the customer fields and the project’s own, including a list’s row count', () => {
    const vocab = ruleVocabulary(p);
    expect(vocab.fields.map((f) => f.path)).toEqual([
      'documentType', 'recordId', 'customer.givenName', 'customer.familyName', 'customer.locale', 'customer.accessibility.largeText', 'customer.accessibility.highContrast', 'customer.middleName',
      'custom.planName', 'custom.monthlyFeeCents', 'custom.renewalDate', 'custom.tier', 'custom.autoRenew', 'custom.visits', 'custom.sessions.count',
    ]);
    const draft = draftRuleFromSentence(p, 'When membership tier is pro, show Pro members in Message');
    expect(draft.rule).toMatchObject({ scope: 'custom', when: { op: 'eq', path: 'custom.tier', value: 'pro' }, then: { op: 'selectVariant', targetNodeId: 'renewal-note', variantId: 'note-pro' } });
    const byCount = draftRuleFromSentence(p, 'When booked sessions count is more than 5, show We miss you in Message');
    expect(byCount.rule).toMatchObject({ when: { op: 'gt', path: 'custom.sessions.count', value: 5 } });
    expect(byCount.uncertain).toEqual([]);
    // naming just the list is read as its number of rows, and the draft says so
    const loose = draftRuleFromSentence(p, 'If the customer has more than 5 booked sessions show We miss you');
    expect(loose.rule).toMatchObject({ when: { op: 'gt', path: 'custom.sessions.count', value: 5 } });
    expect(loose.uncertain.join(' ')).toMatch(/I read “booked sessions” as booked sessions count/);
    // a sentence about a field this document does not have is not turned into a card rule
    const foreign = draftRuleFromSentence(p, 'When missed payments is at least 2, show Pro members in Message');
    expect(JSON.stringify(foreign.rule ?? {})).not.toMatch(/card\./);
    noSampleWords([draft.restatement, byCount.restatement, foreign.restatement, ...foreign.uncertain], 'rule draft');
    // on a blank project there is nothing to target yet, and it says so without inventing anything
    const none = draftRuleFromSentence(blankProject({ projectId: 'empty-doc', title: 'Empty' }), 'When membership tier is pro, show Pro members');
    expect(none.rule).toBeNull();
    noSampleWords(none, 'rule draft on a blank project');
  });

  it('plain-words explanations, translation usage and column matching use its names', () => {
    const res = resolve({ project: p, record: gymMember({ custom: { tier: 'pro' } }) });
    const why = explainInPlainWords(p, res, 'renewal-note');
    expect(why.headline).toBe('Robin Okoye gets “Pro members” in “Message” because the rule “Pro members get the Pro note” matched.');
    noSampleWords(why, 'explanation');
    // translation usage: which wording each customer needs, and in which language
    const usage = records.map((record) => usageEntryFromResolution(p, record, resolve({ project: p, record })));
    expect(usage.filter((u) => u.locale === 'es-US').map((u) => u.recordId)).toEqual(records.filter((r) => r.customer.locale === 'es-US').map((r) => r.recordId));
    expect(usage.filter((u) => u.locale === 'es-US')).toHaveLength(1);
    expect(usage.every((u) => u.requiredPartIds.length === 1 && ['renewal-note-default', 'note-pro', 'note-lapsing'].includes(u.requiredPartIds[0]))).toBe(true);
    const cols = matchColumns(['First name', 'Tier', 'Booked sessions', 'Card number'], [['Ana', 'pro', '2', '1234']], p);
    expect(cols.map((c) => c.path)).toEqual(['customer.givenName', 'custom.tier', null, null]);
  });
});
