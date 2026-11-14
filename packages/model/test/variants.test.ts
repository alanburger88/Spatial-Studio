import { describe, expect, it } from 'vitest';
import { seedProjects } from '../src/fixtures';
import {
  applyCommand, compareWithBase, defaultNode, differenceCounts, makeVariant, mergeVariantUpdate, projectContentDigest, projectFileContentOf, projectFileProblems,
  richFromMarkup, templateContentOf, tokensOfText, translatableStrings, useBaseAgain, variantLockProblem, variantOfProblems, variantReleaseRecord, variantRulesDiffer,
  type Command, type Project, type Rule,
} from '../src';
import { FEE_BY_TIER } from './helpers/depthProject';

/* ------------------------------------------------------------------ helpers */

const [card] = seedProjects();
const run = (p: Project, ...cmds: Command[]): Project => cmds.reduce((acc, c) => { const r = applyCommand(acc, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const refused = (p: Project, c: Command) => { const r = applyCommand(p, c); return r.ok ? null : r; };
const ruleOf = (p: Project, id: string) => p.rules.find((r) => r.id === id)!;
const partText = (p: Project, id: string, loc = 'en-US') => p.contentParts.find((c) => c.id === id)?.approvedLocales[loc];
const childrenOf = (p: Project, id: string) => p.nodes.find((n) => n.id === id)!.children!;

/** The base: the card statement with a lookup table, a calculation, a data field of its own and the document's date. */
const BASE: Project = { ...run(card,
  { type: 'UPSERT_LOOKUP_TABLE', table: FEE_BY_TIER },
  { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'segment', label: 'Segment', type: 'string' }] },
  { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'twiceDue', label: 'Twice the minimum', type: 'money', expr: { op: 'add', a: { op: 'field', path: 'card.minimumDueCents' }, b: { op: 'field', path: 'card.minimumDueCents' } } } },
  { type: 'SET_DOCUMENT_DATE', source: { source: 'run' } },
), projectId: 'base-doc', title: 'Aster Card statement', modelVersion: 3 };
const fresh = () => makeVariant(BASE, { projectId: 'lakeshore', title: 'Aster Card — Lakeshore', purpose: 'region', label: 'Lakeshore region' });

/** Approved Spanish for a message (draft, then approve). */
/** Spanish words plus the same data tokens as the English (an approval needs them). */
const withTokens = (p: Project, id: string, words: string) => `${words} ${tokensOfText(p.contentParts.find((c) => c.id === id)?.approvedLocales['en-US'] ?? '').map((t) => `{{${t}}}`).join(' ')}`.trim();
const spanish = (id: string, text: string, p: Project = BASE): Command[] => [
  { type: 'SET_TRANSLATION_DRAFT', partId: id, locale: 'es-US', text: withTokens(p, id, text) },
  { type: 'APPROVE_TRANSLATION', partId: id, locale: 'es-US' },
];
const greetingText = (text: string): Command => ({ type: 'UPDATE_NODE', nodeId: 'greeting', patch: { content: richFromMarkup(text) } });

/* ------------------------------------------------------------------ making a variant */

describe('making a variant', () => {
  it('is an exact copy of the base version that follows it', () => {
    const v = fresh();
    expect(v.variantOf).toMatchObject({ projectId: 'base-doc', modelVersion: 3, contentDigest: projectContentDigest(BASE), purpose: 'region', label: 'Lakeshore region', baseTitle: 'Aster Card statement' });
    expect(v.variantOf!.baseNodeIds).toEqual(BASE.nodes.map((n) => n.id));
    expect(v.modelVersion).toBe(1);
    expect(compareWithBase(BASE, v)).toEqual([]); // its title is its own name, like its id
    expect(variantOfProblems(v)).toEqual([]);
    expect(projectFileProblems(JSON.parse(JSON.stringify(v))).length).toBe(0);
  });
  it('a variant cannot be the base of another (one level only)', () => {
    expect(() => makeVariant(fresh(), { projectId: 'x-doc', title: 'X', purpose: 'brand', label: 'X' })).toThrow(/cannot be the base/);
  });
  it('maps pinned tests to the variant’s own copies of the base’s customers', () => {
    const base = run(BASE, { type: 'UPSERT_TEST_CASE', testCase: { id: 'T1', name: 'One', recordId: 'CARD-0001', expect: { noBlocking: true } } });
    const v = makeVariant(base, { projectId: 'v-doc', title: 'V', purpose: 'brand', label: 'B', customers: { 'CARD-0001': 'REC-60001' } });
    expect(v.testCases![0].recordId).toBe('REC-60001');
    expect(compareWithBase(base, v, { customers: { 'CARD-0001': 'REC-60001' } })).toEqual([]);
    expect(compareWithBase(base, v).map((d) => d.id)).toEqual(['testCases[T1].recordId']);
  });
  it('templates and the package’s template.json do not carry it; a project file does', () => {
    const v = fresh();
    expect('variantOf' in templateContentOf(v)).toBe(false);
    expect('variantOf' in projectFileContentOf(v)).toBe(false);
    expect(variantOfProblems({ projectId: 'v', variantOf: { projectId: 'v', modelVersion: 0, contentDigest: 'x', purpose: 'nope', label: '', baseTitle: '', baseNodeIds: 'x' } }).length).toBeGreaterThanOrEqual(6);
  });
});

/* ------------------------------------------------------------------ what differs */

/** A variant with one difference of every group (and the made-up fields). */
function differing(): Project {
  let v = fresh();
  v = run(v,
    { type: 'SET_BRAND', brand: { primary: '#123456', accent: '#2E7D5B' } },
    greetingText('Hello from Lakeshore, {{customer.givenName}}.'),
    { type: 'UPSERT_CONTENT_PART', part: { ...v.contentParts.find((c) => c.id === 'payment-standard')!, approvedLocales: { ...v.contentParts.find((c) => c.id === 'payment-standard')!.approvedLocales, 'en-US': 'Pay your Lakeshore balance by the due date.' } } },
    { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: 'Pague su saldo de Lakeshore antes de la fecha.' },
    { type: 'APPROVE_TRANSLATION', partId: 'payment-standard', locale: 'es-US' },
    { type: 'UPSERT_RULE', rule: { ...ruleOf(v, 'R06'), priority: ruleOf(v, 'R06').priority + 5 } },
    { type: 'DELETE_NODE', nodeId: 'high-volume-note' },
    { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'lakeshore-note', 'credit-statement'), name: 'Lakeshore note', content: richFromMarkup('Lakeshore customers can pay at any branch.') }, parentId: 'doc-root', index: 9 },
    { type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, rows: [{ keys: { tier: 'basic' }, values: { lateFee: 900, note: 'Basic' } }, FEE_BY_TIER.rows[1]] } },
  );
  // A made-up top-level field and a made-up component property: compared and merged like any other.
  return { ...v, futureSetting: { mode: 'calm', level: 2 }, nodes: v.nodes.map((n) => (n.id === 'greeting' ? { ...n, futureProp: 'shiny' } : n)) } as Project;
}

describe('what differs (the variant against the base at the version it follows)', () => {
  const v = differing();
  const diffs = compareWithBase(BASE, v);
  const byId = (id: string) => diffs.find((d) => d.id === id);
  it('lists each difference once, grouped, with the base’s value beside the variant’s', () => {
    expect(byId('brand')).toMatchObject({ group: 'brand', base: null, variant: 'main colour #123456, accent colour #2E7D5B', kind: 'added', label: 'Brand' });
    expect(byId('nodes[greeting].content')).toMatchObject({ group: 'wording', nodeId: 'greeting', variant: 'Hello from Lakeshore, [Given name].' });
    expect(byId('contentParts[payment-standard].approvedLocales.en-US')).toMatchObject({ group: 'wording', variant: 'Pay your Lakeshore balance by the due date.' });
    expect(byId('contentParts[payment-standard].approvedLocales.es-US')).toMatchObject({ group: 'wording', base: null, label: expect.stringMatching(/Spanish/) });
    expect(byId('rules[R06]')).toMatchObject({ group: 'rules', kind: 'changed' });
    expect(byId('nodes[high-volume-note]')).toMatchObject({ group: 'sections', kind: 'removed' });
    expect(byId('nodes[lakeshore-note]')).toMatchObject({ group: 'sections', kind: 'added' });
    expect(byId('lookupTables[feeByTier].rows')).toMatchObject({ group: 'tables', label: 'Lookup table “Late fee by tier”: values', base: expect.stringContaining('15.00'), variant: expect.stringContaining('9.00') });
    // version counters are not differences
    expect(diffs.some((d) => /\.version$/.test(d.id))).toBe(false);
    expect(differenceCounts(diffs).total).toBe(diffs.length);
    expect(variantRulesDiffer(BASE, v)).toBe(true);
    expect(variantRulesDiffer(BASE, fresh())).toBe(false);
  });
  it('compares a made-up top-level field and a made-up component property by structure', () => {
    expect(byId('futureSetting')).toMatchObject({ kind: 'added', group: 'other' });
    expect(byId('nodes[greeting].futureProp')).toMatchObject({ kind: 'added', variant: 'shiny' });
    const both = { ...BASE, futureSetting: { mode: 'busy', level: 2 } } as Project;
    expect(compareWithBase(both, v).find((d) => d.id === 'futureSetting.mode')).toMatchObject({ base: 'busy', variant: 'calm' });
  });
  it('is deterministic', () => {
    expect(JSON.stringify(compareWithBase(BASE, differing()))).toBe(JSON.stringify(diffs));
  });
  it('a release records the base, the version followed and the list of differences', () => {
    const rec = variantReleaseRecord(BASE, v)!;
    expect(rec).toMatchObject({ baseId: 'base-doc', baseVersion: 3, baseTitle: 'Aster Card statement', purpose: 'region' });
    expect(rec.differences.map((d) => d.id)).toEqual(diffs.map((d) => d.id));
    expect(variantReleaseRecord(BASE, BASE)).toBeNull();
  });
});

/* ------------------------------------------------------------------ the lock (exhaustive) */

type Probe = { what: string; cmd: (v: Project) => Command; allowed?: boolean; setup?: (v: Project) => Project };
const LOCKED = /the base document “Aster Card statement”.*(Change (it|them) there, or detach this variant\.|or detach this variant\.)/;
const own = (v: Project) => run(v, { type: 'INSERT_NODE', node: { ...defaultNode('container', 'own-box', 'credit-statement'), name: 'Own box' }, parentId: 'doc-root' }, { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'own-text', 'credit-statement'), name: 'Own text' }, parentId: 'own-box' });
const fixedLayout = (v: Project) => v.nodes.find((n) => n.id === 'statement-title')!.layout!.paged!;

/**
 * Every command type, and what each may do in a variant. TypeScript fails this file when a command type is added, so a
 * new command cannot slip past the lock unclassified. Allowed probes must succeed; the rest are refused with a message
 * naming the base document.
 */
const PROBES: Record<Command['type'], Probe[]> = {
  INSERT_NODE: [
    { what: 'a component of its own into a base container', cmd: () => ({ type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'mine-1', 'credit-statement'), name: 'Mine' }, parentId: 'account-summary', index: 1 }), allowed: true },
    { what: 'a hidden base component back by hand (only “Use the base’s again” brings it back)', setup: (v) => run(v, { type: 'DELETE_NODE', nodeId: 'greeting' }), cmd: () => ({ type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'greeting', 'credit-statement') }, parentId: 'doc-root' }) },
  ],
  DELETE_NODE: [
    { what: 'a base section (hiding it)', cmd: () => ({ type: 'DELETE_NODE', nodeId: 'high-volume-note' }), allowed: true },
    { what: 'its own component', setup: own, cmd: () => ({ type: 'DELETE_NODE', nodeId: 'own-box' }), allowed: true },
  ],
  MOVE_NODE: [
    { what: 'a base component within its container', cmd: () => ({ type: 'MOVE_NODE', nodeId: 'greeting', parentId: 'doc-root', index: 0 }) },
    { what: 'a base component into another container', cmd: () => ({ type: 'MOVE_NODE', nodeId: 'payment-due', parentId: 'balance-breakdown', index: 0 }) },
    { what: 'its own component anywhere', setup: own, cmd: () => ({ type: 'MOVE_NODE', nodeId: 'own-text', parentId: 'doc-root', index: 3 }), allowed: true },
  ],
  UPDATE_NODE: [
    { what: 'the text of a base component', cmd: () => greetingText('Hello there.'), allowed: true },
    { what: 'the size of a base component through its layout', cmd: (v) => ({ type: 'UPDATE_NODE', nodeId: 'statement-title', patch: { layout: { ...v.nodes.find((n) => n.id === 'statement-title')!.layout, paged: { ...fixedLayout(v), wPt: 100 } } } }) },
  ],
  SET_LAYOUT: [
    { what: 'the position of a base component', cmd: (v) => ({ type: 'SET_LAYOUT', nodeId: 'statement-title', profile: 'paged', layout: { xPt: (fixedLayout(v).xPt ?? 0) + 10 } }) },
    { what: 'the web layout of a base component', cmd: () => ({ type: 'SET_LAYOUT', nodeId: 'greeting', profile: 'html', layout: { span: 6 } }) },
    { what: 'the layout of its own component', setup: own, cmd: () => ({ type: 'SET_LAYOUT', nodeId: 'own-text', profile: 'paged', layout: { spaceBeforePt: 20 } }), allowed: true },
  ],
  DUPLICATE_NODE: [{ what: 'a copy of a base component (the copy is its own)', cmd: () => ({ type: 'DUPLICATE_NODE', nodeId: 'greeting', newId: 'greeting-copy' }), allowed: true }],
  UPSERT_RULE: [{ what: 'a changed rule', cmd: (v) => ({ type: 'UPSERT_RULE', rule: { ...ruleOf(v, 'R06'), priority: 1 } }), allowed: true }],
  DELETE_RULE: [{ what: 'a rule', cmd: () => ({ type: 'DELETE_RULE', ruleId: 'R06' }), allowed: true }],
  SET_RULE_ENABLED: [{ what: 'switching a rule off', cmd: () => ({ type: 'SET_RULE_ENABLED', ruleId: 'R06', enabled: false }), allowed: true }],
  UPSERT_CONTENT_PART: [{ what: 'a message’s wording', cmd: (v) => ({ type: 'UPSERT_CONTENT_PART', part: { ...v.contentParts.find((c) => c.id === 'payment-standard')!, approvedLocales: { 'en-US': 'Pay now.' } } }), allowed: true }],
  ADD_VARIANT: [{ what: 'an alternative of its own to a base message', cmd: () => ({ type: 'ADD_VARIANT', nodeId: 'payment-guidance', variantId: 'lakeshore-alt', title: 'Lakeshore', text: 'Lakeshore wording.' }), allowed: true }],
  REMOVE_VARIANT: [{ what: 'an alternative', cmd: () => ({ type: 'REMOVE_VARIANT', nodeId: 'payment-guidance', variantId: 'payment-arrangement-active' }), setup: (v) => run(v, { type: 'DELETE_RULE', ruleId: 'R05' }), allowed: true }],
  SET_VARIANT_CONDITION: [{ what: 'a condition', cmd: () => ({ type: 'SET_VARIANT_CONDITION', nodeId: 'high-volume-note', variantId: 'high-volume-help', when: { op: 'gte', path: 'card.missedPayments', value: 1 } }), allowed: true }],
  SET_JOURNEY: [{ what: 'the journey', cmd: () => ({ type: 'SET_JOURNEY', events: [] }), allowed: true }],
  UPDATE_PROFILE: [{ what: 'a presentation profile (page design)', cmd: () => ({ type: 'UPDATE_PROFILE', profileId: 'paged-pdf', patch: { duplex: true } }) }],
  SET_CUSTOM_FIELDS: [{ what: 'the data fields', cmd: () => ({ type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'segment', label: 'Segment', type: 'string' }, { key: 'region', label: 'Region', type: 'string' }] }) }],
  SET_STYLES: [{ what: 'the text styles', cmd: () => ({ type: 'SET_STYLES', styles: [{ id: 'lake', name: 'Lake', kind: 'paragraph', color: '#123456' }] }), allowed: true }],
  SET_BRAND: [{ what: 'the brand', cmd: () => ({ type: 'SET_BRAND', brand: { primary: '#123456', accent: '#2E7D5B' } }), allowed: true }],
  UPSERT_TEST_CASE: [{ what: 'a pinned test', cmd: () => ({ type: 'UPSERT_TEST_CASE', testCase: { id: 'L1', name: 'Lakeshore', recordId: 'CARD-0001', expect: { noBlocking: true } } }), allowed: true }],
  DELETE_TEST_CASE: [{ what: 'a pinned test', setup: (v) => run(v, { type: 'UPSERT_TEST_CASE', testCase: { id: 'L1', name: 'Lakeshore', recordId: 'CARD-0001', expect: {} } }), cmd: () => ({ type: 'DELETE_TEST_CASE', testCaseId: 'L1' }), allowed: true }],
  SET_TRANSLATION_DRAFT: [{ what: 'a translation', cmd: () => ({ type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: 'Pague.' }), allowed: true }],
  APPROVE_TRANSLATION: [{ what: 'approving a translation', setup: (v) => run(v, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: withTokens(v, 'payment-standard', 'Pague.') }), cmd: () => ({ type: 'APPROVE_TRANSLATION', partId: 'payment-standard', locale: 'es-US' }), allowed: true }],
  SET_TRANSLATION_DRAFTS: [{ what: 'many translations', cmd: () => ({ type: 'SET_TRANSLATION_DRAFTS', locale: 'es-US', items: [{ id: 'payment-standard', text: 'Pague.' }] }), allowed: true }],
  APPROVE_TRANSLATIONS: [{ what: 'approving many', setup: (v) => run(v, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: withTokens(v, 'payment-standard', 'Pague.') }), cmd: () => ({ type: 'APPROVE_TRANSLATIONS', locale: 'es-US', ids: ['payment-standard'] }), allowed: true }],
  ADD_LANGUAGE: [{ what: 'a language', cmd: () => ({ type: 'ADD_LANGUAGE', locale: 'fr-CA' }), allowed: true }],
  REMOVE_LANGUAGE: [{ what: 'a language', setup: (v) => run(v, { type: 'ADD_LANGUAGE', locale: 'fr-CA' }), cmd: () => ({ type: 'REMOVE_LANGUAGE', locale: 'fr-CA' }), allowed: true }],
  SET_CHANNELS: [{ what: 'the email and SMS wording', cmd: (v) => ({ type: 'SET_CHANNELS', channels: { email: { subject: 'Your Lakeshore statement', preheader: '', title: 'Statement', intro: '', closing: '', keyFactsHeading: 'Key facts', sections: ['keyFacts', 'messages', 'tables', 'summaries', 'actions'].map((id) => ({ id: id as never, show: true })) }, sms: { text: 'Your statement is ready.' } } }), allowed: true }],
  SET_GLOSSARY: [{ what: 'the glossary', cmd: () => ({ type: 'SET_GLOSSARY', locale: 'es-US', entries: [{ source: 'lake', target: 'lago' }] }), allowed: true }],
  SET_DOCUMENT_DATE: [{ what: 'where the document’s date comes from', cmd: () => ({ type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'card.dueDate' } }) }],
  UPSERT_CALCULATED_FIELD: [{ what: 'a calculation’s formula', cmd: () => ({ type: 'UPSERT_CALCULATED_FIELD', field: { key: 'twiceDue', label: 'Twice the minimum', type: 'money', expr: { op: 'field', path: 'card.minimumDueCents' } } }) }],
  DELETE_CALCULATED_FIELD: [{ what: 'a calculation', cmd: () => ({ type: 'DELETE_CALCULATED_FIELD', key: 'twiceDue' }) }],
  MOVE_CALCULATED_FIELD: [{ what: 'a calculation in the list', setup: (v) => ({ ...v, calculatedFields: [...v.calculatedFields!, { key: 'onceDue', label: 'Once', type: 'money', expr: { op: 'field', path: 'card.minimumDueCents' } }] }), cmd: () => ({ type: 'MOVE_CALCULATED_FIELD', key: 'onceDue', index: 0 }) }],
  UPSERT_LOOKUP_TABLE: [{ what: 'a lookup table’s values', cmd: () => ({ type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, rows: [FEE_BY_TIER.rows[0]] } }), allowed: true }],
  DELETE_LOOKUP_TABLE: [{ what: 'a lookup table nothing reads', cmd: () => ({ type: 'DELETE_LOOKUP_TABLE', tableId: 'feeByTier' }), allowed: true }],
  MOVE_LOOKUP_TABLE: [{ what: 'a lookup table in the list', setup: (v) => run(v, { type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, id: 'second', title: 'Second' } }), cmd: () => ({ type: 'MOVE_LOOKUP_TABLE', tableId: 'second', index: 0 }), allowed: true }],
  SET_RULE_PERIOD: [{ what: 'a rule’s period', cmd: () => ({ type: 'SET_RULE_PERIOD', ruleId: 'R06', period: { from: '2027-01-01' } }), allowed: true }],
  SET_VARIANT_PERIOD: [{ what: 'an alternative’s period', cmd: () => ({ type: 'SET_VARIANT_PERIOD', nodeId: 'payment-guidance', variantId: 'payment-reminder', period: { from: '2027-01-01' } }), allowed: true }],
  SET_SECTION_PERIOD: [{ what: 'a section’s period', cmd: () => ({ type: 'SET_SECTION_PERIOD', nodeId: 'high-volume-note', period: { from: '2027-01-01' } }), allowed: true }],
  BATCH: [
    { what: 'a batch with one locked change', cmd: () => ({ type: 'BATCH', label: 'Fixes', commands: [greetingText('Hi.'), { type: 'MOVE_NODE', nodeId: 'greeting', parentId: 'doc-root', index: 0 }] }) },
    { what: 'a batch of free changes', cmd: () => ({ type: 'BATCH', label: 'Fixes', commands: [greetingText('Hi.'), { type: 'SET_BRAND', brand: { primary: '#123456', accent: '#2E7D5B' } }] }), allowed: true },
  ],
  SET_PAGE_DESIGN: [{ what: 'the page design', cmd: () => ({ type: 'SET_PAGE_DESIGN', patch: { paper: 'A4' } }) }],
  SET_ACCESSIBLE_PDF_REQUIRED: [{ what: '“accessible PDF is required”', cmd: () => ({ type: 'SET_ACCESSIBLE_PDF_REQUIRED', required: true }), allowed: true }],
  RESTORE_SNAPSHOT: [{ what: 'undo to an earlier state of the variant', cmd: (v) => ({ type: 'RESTORE_SNAPSHOT', project: fresh(), label: 'Undo' }), allowed: true }],
  LINK_LIBRARY_ITEM: [
    { what: 'a brand from the library', cmd: () => ({ type: 'LINK_LIBRARY_ITEM', item: { id: 'lake-brand', kind: 'brand', title: 'Lake brand' }, version: 1, content: { primary: '#111111', accent: '#222222' } }), allowed: true },
    { what: 'a building block in place of a base component (hides it and adds its own)', allowed: true, cmd: (v) => ({ type: 'LINK_LIBRARY_ITEM', item: { id: 'greet-block', kind: 'block', title: 'Greeting block' }, version: 1, content: { rootNodeId: 'g2', nodes: [{ id: 'g2', type: 'rich-text', name: 'G2', content: richFromMarkup('Hi.'), layout: { paged: { mode: 'flow', spaceBeforePt: 30 } } }], contentParts: [] }, placement: { replaceNodeId: 'greeting' } }) },
  ],
  UPDATE_LIBRARY_LINK: [{ what: 'a brand link to another version', setup: (v) => run(v, { type: 'LINK_LIBRARY_ITEM', item: { id: 'lake-brand', kind: 'brand', title: 'Lake brand' }, version: 1, content: { primary: '#111111', accent: '#222222' } }), cmd: (v) => ({ type: 'UPDATE_LIBRARY_LINK', linkId: v.libraryLinks![0].linkId, version: 2, content: { primary: '#333333', accent: '#222222' } }), allowed: true }],
  UNLINK_LIBRARY_ITEM: [{ what: 'a brand link', setup: (v) => run(v, { type: 'LINK_LIBRARY_ITEM', item: { id: 'lake-brand', kind: 'brand', title: 'Lake brand' }, version: 1, content: { primary: '#111111', accent: '#222222' } }), cmd: (v) => ({ type: 'UNLINK_LIBRARY_ITEM', linkId: v.libraryLinks![0].linkId }), allowed: true }],
  ADD_WORDING_RULE: [{ what: 'a wording rule', cmd: () => ({ type: 'ADD_WORDING_RULE', rule: { id: 'lake-1', kind: 'banned', severity: 'should', phrase: 'kindly' } }), allowed: true }],
  UPDATE_WORDING_RULE: [{ what: 'a wording rule', setup: (v) => run(v, { type: 'ADD_WORDING_RULE', rule: { id: 'lake-1', kind: 'banned', severity: 'should', phrase: 'kindly' } }), cmd: () => ({ type: 'UPDATE_WORDING_RULE', ruleId: 'lake-1', rule: { id: 'lake-1', kind: 'banned', severity: 'must', phrase: 'kindly' } }), allowed: true }],
  REMOVE_WORDING_RULE: [{ what: 'a wording rule', setup: (v) => run(v, { type: 'ADD_WORDING_RULE', rule: { id: 'lake-1', kind: 'banned', severity: 'should', phrase: 'kindly' } }), cmd: () => ({ type: 'REMOVE_WORDING_RULE', ruleId: 'lake-1' }), allowed: true }],
  MOVE_WORDING_RULE: [{ what: 'a wording rule', setup: (v) => run(v, { type: 'ADD_WORDING_RULE', rule: { id: 'lake-1', kind: 'banned', severity: 'should', phrase: 'kindly' } }, { type: 'ADD_WORDING_RULE', rule: { id: 'lake-2', kind: 'banned', severity: 'should', phrase: 'please note' } }), cmd: () => ({ type: 'MOVE_WORDING_RULE', ruleId: 'lake-2', index: 0 }), allowed: true }],
  ADD_MAPPING: [{ what: 'a mapping', cmd: () => ({ type: 'ADD_MAPPING', mapping: { id: 'lake-print', name: 'Mapping for Lake Print', system: 'Lake Print' } }), allowed: true }],
  RENAME_MAPPING: [{ what: 'a mapping', setup: (v) => run(v, { type: 'ADD_MAPPING', mapping: { id: 'lake-print', name: 'Mapping for Lake Print', system: 'Lake Print' } }), cmd: () => ({ type: 'RENAME_MAPPING', mappingId: 'lake-print', name: 'Mapping for Lake Mail' }), allowed: true }],
  REMOVE_MAPPING: [{ what: 'a mapping', setup: (v) => run(v, { type: 'ADD_MAPPING', mapping: { id: 'lake-print', name: 'Mapping for Lake Print', system: 'Lake Print' } }), cmd: () => ({ type: 'REMOVE_MAPPING', mappingId: 'lake-print' }), allowed: true }],
  IMPORT_TARGET_FIELDS: [{ what: 'a mapping’s target fields', setup: (v) => run(v, { type: 'ADD_MAPPING', mapping: { id: 'lake-print', name: 'Mapping for Lake Print', system: 'Lake Print' } }), cmd: () => ({ type: 'IMPORT_TARGET_FIELDS', mappingId: 'lake-print', fields: [{ name: 'ACCT' }] }), allowed: true }],
  SET_MAPPING_ENTRY: [{ what: 'a mapping entry', setup: (v) => run(v, { type: 'ADD_MAPPING', mapping: { id: 'lake-print', name: 'Mapping for Lake Print', system: 'Lake Print' } }), cmd: () => ({ type: 'SET_MAPPING_ENTRY', mappingId: 'lake-print', entry: { path: 'card.newBalanceCents', target: 'BAL' } }), allowed: true }],
  CLEAR_MAPPING_ENTRY: [{ what: 'a mapping entry', setup: (v) => run(v, { type: 'ADD_MAPPING', mapping: { id: 'lake-print', name: 'Mapping for Lake Print', system: 'Lake Print' } }, { type: 'SET_MAPPING_ENTRY', mappingId: 'lake-print', entry: { path: 'card.newBalanceCents', target: 'BAL' } }), cmd: () => ({ type: 'CLEAR_MAPPING_ENTRY', mappingId: 'lake-print', path: 'card.newBalanceCents' }), allowed: true }],
  SET_MAPPING_ENTRIES: [{ what: 'mapping entries', setup: (v) => run(v, { type: 'ADD_MAPPING', mapping: { id: 'lake-print', name: 'Mapping for Lake Print', system: 'Lake Print' } }), cmd: () => ({ type: 'SET_MAPPING_ENTRIES', mappingId: 'lake-print', entries: [{ path: 'card.newBalanceCents', target: 'BAL' }] }), allowed: true }],
  DETACH_VARIANT: [{ what: 'detaching', cmd: () => ({ type: 'DETACH_VARIANT' }), allowed: true }],
  UPDATE_FROM_BASE: [{ what: 'an update (carries the base’s own content)', cmd: (v) => ({ type: 'UPDATE_FROM_BASE', project: { ...v, variantOf: { ...v.variantOf!, modelVersion: 4 } } }), allowed: true }],
  USE_BASE_AGAIN: [{ what: 'one value back', setup: (v) => run(v, greetingText('Hi.')), cmd: (v) => ({ type: 'USE_BASE_AGAIN', project: (useBaseAgain(v, BASE, 'nodes[greeting].content') as { project: Project }).project, label: 'Use the base’s greeting again' }), allowed: true }],
};

describe('the lock: what stays the base’s in a variant', () => {
  const v = fresh();
  for (const [type, probes] of Object.entries(PROBES)) for (const probe of probes) {
    it(`${type}: ${probe.what} is ${probe.allowed ? 'allowed' : 'refused, naming the base document'}`, () => {
      const start = probe.setup ? probe.setup(v) : v;
      const r = applyCommand(start, probe.cmd(start));
      if (probe.allowed) { expect(r.ok, r.ok ? '' : r.message).toBe(true); return; }
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code, r.message).toBe('VARIANT_LOCKED');
      expect(r.message).toMatch(LOCKED);
    });
  }
  it('the same commands work on an ordinary document', () => {
    expect(applyCommand(BASE, { type: 'SET_PAGE_DESIGN', patch: { paper: 'A4' } }).ok).toBe(true);
    expect(applyCommand(BASE, { type: 'MOVE_NODE', nodeId: 'greeting', parentId: 'doc-root', index: 0 }).ok).toBe(true);
  });
  it('names the component and points at it', () => {
    const r = refused(v, { type: 'MOVE_NODE', nodeId: 'greeting', parentId: 'doc-root', index: 0 })!;
    expect(r.nodeId).toBeDefined();
    expect(r.message).toMatch(/The order of the components in “.*” comes from the base document “Aster Card statement”\. Change it there, or detach this variant\./);
    expect(refused(v, { type: 'SET_LAYOUT', nodeId: 'statement-title', profile: 'paged', layout: { xPt: 50 } })).toMatchObject({ nodeId: 'statement-title', message: expect.stringMatching(/^The position and size of “/) });
  });
  it('the server’s check: a saved variant whose locked parts differ from the base at the followed version', () => {
    expect(variantLockProblem(BASE, v)).toBeNull();
    expect(variantLockProblem(BASE, differing())).toBeNull();
    const moved = { ...v, presentationProfiles: v.presentationProfiles.map((p) => (p.id === 'paged-pdf' ? { ...p, duplex: true } : p)) };
    expect(variantLockProblem(BASE, moved)?.message).toMatch(/^The page design comes from the base document/);
    const reordered = { ...v, nodes: v.nodes.map((n) => (n.id === 'doc-root' ? { ...n, children: [...n.children!].reverse() } : n)) };
    expect(variantLockProblem(BASE, reordered)?.part).toBe('order');
  });
  it('detaching makes it an ordinary document with the same content', () => {
    const d = run(differing(), { type: 'DETACH_VARIANT' });
    expect(d.variantOf).toBeUndefined();
    expect(run(d, { type: 'SET_PAGE_DESIGN', patch: { paper: 'A4' } }).presentationProfiles).toBeDefined();
    expect(refused(BASE, { type: 'DETACH_VARIANT' })?.code).toBe('NOT_A_VARIANT');
  });
  it('the variant commands check what they carry', () => {
    expect(refused(v, { type: 'UPDATE_FROM_BASE', project: v })?.code).toBe('UNCHANGED');
    expect(refused(v, { type: 'UPDATE_FROM_BASE', project: { ...v, projectId: 'other' } })?.code).toBe('INVALID');
    expect(refused(v, { type: 'UPDATE_FROM_BASE', project: { ...v, variantOf: { ...v.variantOf!, projectId: 'other-base', modelVersion: 9 } } })?.message).toMatch(/follows “Aster Card statement”/);
    expect(refused(v, { type: 'USE_BASE_AGAIN', project: { ...v, variantOf: { ...v.variantOf!, modelVersion: 9 } }, label: 'x' })?.code).toBe('INVALID');
    expect(refused(v, { type: 'UPDATE_FROM_BASE', project: { ...v, variantOf: undefined } })?.code).toBe('INVALID');
  });
});

/* ------------------------------------------------------------------ the update */

/** The base at a newer version: `cmds` applied to BASE. */
const newer = (...cmds: Command[]): Project => ({ ...run(BASE, ...cmds), modelVersion: 5 });
const update = (variant: Project, base: Project, customers?: Record<string, string>) => mergeVariantUpdate({ ancestor: BASE, base, variant, customers });
const ids = (l: Array<{ id: string }>) => l.map((e) => e.id);

describe('the update: a three-way merge of the base at the followed version, the base now and the variant', () => {
  it('comes in: what the base changed and the variant had not touched', () => {
    const base = newer(
      { type: 'UPDATE_NODE', nodeId: 'payment-action', patch: { action: { label: 'Pay online now', url: 'https://example.com/pay', fallbackText: 'Pay online.' } } },
      { type: 'UPSERT_RULE', rule: { ...ruleOf(BASE, 'R11'), priority: ruleOf(BASE, 'R11').priority + 1 } },
      { type: 'ADD_VARIANT', nodeId: 'payment-guidance', variantId: 'payment-new', title: 'New', text: 'A new message.' },
    );
    const u = update(differing(), base);
    expect(ids(u.comesIn)).toEqual(expect.arrayContaining(['nodes[payment-action].action.label', 'rules[R11]', 'contentParts[payment-new]', 'nodes[payment-guidance].variantIds']));
    expect(u.kept).toEqual([]);
    expect(u.needsLook).toEqual([]);
    expect(u.project.nodes.find((n) => n.id === 'payment-action')!.action!.label).toBe('Pay online now');
    expect(u.project.nodes.find((n) => n.id === 'payment-guidance')!.variantIds).toContain('payment-new');
    expect(u.project.variantOf).toMatchObject({ modelVersion: 5, contentDigest: projectContentDigest(base) });
    // the variant's own differences are all still there
    const before = compareWithBase(BASE, differing()).map((d) => d.id);
    const after = compareWithBase(base, u.project).map((d) => d.id);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(variantLockProblem(base, u.project)).toBeNull();
    expect(u.baseChanges.summary.total).toBeGreaterThan(0);
  });
  it('kept as yours: both changed the same thing; the base’s new value is shown beside it', () => {
    const base = newer(greetingText('Hello from the base.'), { type: 'SET_BRAND', brand: { primary: '#000000', accent: '#FF0000' } });
    const u = update(differing(), base);
    const greet = u.kept.find((e) => e.id === 'nodes[greeting].content')!;
    expect(greet).toMatchObject({ yours: 'Hello from Lakeshore, [Given name].', baseNow: 'Hello from the base.', note: expect.stringMatching(/your value stays/) });
    expect(ids(u.kept)).toContain('brand');
    expect(ids(u.comesIn)).not.toContain('brand');
    expect(u.project.brand!.accent).toBe('#2E7D5B');
  });
  it('needs a look: the base removed something the variant changed or added to', () => {
    const v = run(differing(),
      { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'own-in-balance', 'credit-statement'), name: 'Own line' }, parentId: 'balance-breakdown' },
      { type: 'UPDATE_NODE', nodeId: 'spend-chart', patch: { name: 'Lakeshore spending' } },
    );
    const base = newer({ type: 'DELETE_NODE', nodeId: 'balance-breakdown' }, { type: 'DELETE_NODE', nodeId: 'spend-chart' }, { type: 'DELETE_NODE', nodeId: 'interest-explainer' });
    const u = update(v, base);
    expect(ids(u.needsLook)).toEqual(expect.arrayContaining(['nodes[balance-breakdown]', 'nodes[spend-chart]']));
    // removal on one side: untouched by the variant, the base's removal comes in
    expect(ids(u.comesIn)).toContain('nodes[interest-explainer]');
    expect(u.project.nodes.some((n) => n.id === 'interest-explainer')).toBe(false);
    // what the variant put in the removed container is kept, in it
    expect(childrenOf(u.project, 'balance-breakdown')).toContain('own-in-balance');
    expect(u.project.nodes.some((n) => n.id === 'spend-chart')).toBe(true);
    // kept components are the variant's own now: free to move
    expect(u.project.variantOf!.baseNodeIds).not.toContain('balance-breakdown');
    expect(variantLockProblem(base, u.project)).toBeNull();
  });
  it('a section of the variant’s own survives, where it was', () => {
    const base = newer({ type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'base-new', 'credit-statement'), name: 'Base news' }, parentId: 'doc-root', index: 2 });
    const u = update(differing(), base);
    const kids = childrenOf(u.project, 'doc-root');
    expect(kids).toContain('lakeshore-note');
    expect(kids.indexOf('lakeshore-note')).toBe(kids.indexOf('account-summary') + 1);
    expect(kids).toContain('base-new');
    expect(ids(u.comesIn)).toContain('nodes[base-new]');
    expect(variantLockProblem(base, u.project)).toBeNull();
  });
  it('a base component the variant hid stays hidden, even when the base changed it', () => {
    const base = newer({ type: 'UPDATE_NODE', nodeId: 'high-volume-note', patch: { name: 'High volume (new)' } });
    const u = update(differing(), base);
    expect(u.project.nodes.some((n) => n.id === 'high-volume-note')).toBe(false);
    expect(u.kept.find((e) => e.id === 'nodes[high-volume-note]')?.note).toMatch(/stays hidden/);
    expect(u.project.variantOf!.baseNodeIds).toContain('high-volume-note');
  });
  it('a rule changed on both sides is kept as yours; changed on the base only, it comes in', () => {
    const base = newer({ type: 'UPSERT_RULE', rule: { ...ruleOf(BASE, 'R06'), when: { op: 'gte', path: 'card.missedPayments', value: 3 } } });
    const u = update(differing(), base);
    expect(u.kept.find((e) => e.id === 'rules[R06]')).toMatchObject({ group: 'rules', baseNow: expect.stringMatching(/Missed payments is at least 3/) });
    expect(ruleOf(u.project, 'R06').priority).toBe(ruleOf(differing(), 'R06').priority);
    expect(ruleOf(u.project, 'R06').version).toBeGreaterThanOrEqual(ruleOf(base, 'R06').version);
  });
  it('a lookup table changed on both sides: the variant’s values stay, the base’s other changes come in', () => {
    const base = newer({ type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, title: 'Late fee by membership tier', rows: [{ keys: { tier: 'basic' }, values: { lateFee: 1700, note: 'Basic' } }, FEE_BY_TIER.rows[1]] } });
    const u = update(differing(), base);
    expect(u.kept.find((e) => e.id === 'lookupTables[feeByTier].rows')).toMatchObject({ group: 'tables', yours: expect.stringContaining('9.00'), baseNow: expect.stringContaining('17.00') });
    expect(ids(u.comesIn)).toContain('lookupTables[feeByTier].title');
    const t = u.project.lookupTables!.find((x) => x.id === 'feeByTier')!;
    expect(t.title).toBe('Late fee by membership tier');
    expect(t.rows[0].values.lateFee).toBe(900);
  });
  it('a base wording change under the variant’s own translation needs a look', () => {
    const v = run(fresh(), ...spanish('payment-standard', 'Pague a tiempo, Lakeshore.'));
    const base = newer({ type: 'UPSERT_CONTENT_PART', part: { ...BASE.contentParts.find((c) => c.id === 'payment-standard')!, approvedLocales: { ...BASE.contentParts.find((c) => c.id === 'payment-standard')!.approvedLocales, 'en-US': 'Please pay on time.' } } });
    const u = update(v, base);
    expect(partText(u.project, 'payment-standard')).toBe('Please pay on time.');
    expect(partText(u.project, 'payment-standard', 'es-US')).toBe(withTokens(BASE, 'payment-standard', 'Pague a tiempo, Lakeshore.'));
    expect(u.needsLook.find((e) => e.id === 'contentParts[payment-standard].approvedLocales.es-US')?.note).toMatch(/written for the old English/);
    // …and a text kept with a component (its translation is a string of the document)
    const sid = translatableStrings(fresh()).find((s) => s.nodeId === 'greeting')!.id;
    const greetSource = translatableStrings(fresh()).find((s) => s.id === sid)!.source;
    const hola = `Hola ${tokensOfText(greetSource).map((t) => `{{${t}}}`).join(' ')}`;
    const v2 = run(fresh(), { type: 'SET_TRANSLATION_DRAFT', partId: sid, locale: 'es-US', text: hola }, { type: 'APPROVE_TRANSLATION', partId: sid, locale: 'es-US' });
    const base2 = newer(greetingText(`${greetSource} Welcome.`));
    const u2 = update(v2, base2);
    expect(ids(u2.comesIn)).toContain('nodes[greeting].content');
    expect(u2.needsLook.some((e) => e.id === `strings.${sid}.approved.es-US` || e.id.endsWith('approved.es-US'))).toBe(true);
  });
  it('when the variant rewrote the English, the base’s new translation of the old English does not come in', () => {
    const v = differing();
    const base = newer(...spanish('payment-standard', 'Pague antes de la fecha (base).'));
    const u = update(v, base);
    expect(partText(u.project, 'payment-standard', 'es-US')).toBe('Pague su saldo de Lakeshore antes de la fecha.');
    expect(u.kept.some((e) => e.id === 'contentParts[payment-standard].approvedLocales.es-US')).toBe(true);
  });
  it('removal on one side: what the variant removed stays removed; what the base removed (untouched) goes', () => {
    const v = run(fresh(), { type: 'DELETE_RULE', ruleId: 'R08' });
    const base = newer({ type: 'DELETE_RULE', ruleId: 'R09' });
    const u = update(v, base);
    expect(u.project.rules.some((r) => r.id === 'R08')).toBe(false);
    expect(u.project.rules.some((r) => r.id === 'R09')).toBe(false);
    expect(ids(u.comesIn)).toContain('rules[R09]');
    // the base changed a rule the variant removed: kept as yours (it stays removed)
    const base2 = newer({ type: 'UPSERT_RULE', rule: { ...ruleOf(BASE, 'R08'), priority: 1 } });
    expect(update(v, base2).kept.find((e) => e.id === 'rules[R08]')?.note).toMatch(/removed or hid/);
  });
  it('a rule that comes in but shows something the variant hid is not brought in (needs a look)', () => {
    const v = run(fresh(), { type: 'DELETE_NODE', nodeId: 'high-volume-note' });
    const base = newer({ type: 'UPSERT_RULE', rule: { id: 'R40', scope: 'credit-statement', mode: 'additive', priority: 10, when: { op: 'gte', path: 'card.missedPayments', value: 1 }, then: { op: 'showSection', targetNodeId: 'high-volume-note' }, version: 1 } as Rule });
    const u = update(v, base);
    expect(u.project.rules.some((r) => r.id === 'R40')).toBe(false);
    expect(u.needsLook.find((e) => e.id === 'rules[R40]')?.note).toMatch(/does not work in your variant/);
  });
  it('the locked parts always take the base’s new value', () => {
    const base = newer({ type: 'SET_PAGE_DESIGN', patch: { paper: 'A4' } }, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'segment', label: 'Segment', type: 'string' }, { key: 'region', label: 'Region', type: 'string' }] });
    const u = update(differing(), base);
    expect(u.project.presentationProfiles).toEqual(base.presentationProfiles);
    expect(u.project.customFields).toEqual(base.customFields);
    expect(ids(u.comesIn)).toEqual(expect.arrayContaining(['customFields[region]']));
  });
  it('merges a made-up top-level field and a made-up component property by structure', () => {
    const v = differing() as Project & { futureSetting: { mode: string; level: number } };
    const base = { ...newer(), futureSetting: { mode: 'calm', level: 3 }, nodes: newer().nodes.map((n) => (n.id === 'greeting' ? { ...n, futureProp: 'dull' } : n.id === 'spend-chart' ? { ...n, futureProp: 'new' } : n)) } as Project;
    const anc = { ...BASE, futureSetting: { mode: 'calm', level: 2 } } as Project;
    const u = mergeVariantUpdate({ ancestor: anc, base, variant: v });
    expect((u.project as any).futureSetting).toEqual({ mode: 'calm', level: 3 });
    expect(ids(u.comesIn)).toContain('futureSetting.level');
    expect((u.project.nodes.find((n) => n.id === 'spend-chart') as any).futureProp).toBe('new');
    expect((u.project.nodes.find((n) => n.id === 'greeting') as any).futureProp).toBe('shiny');
    expect(ids(u.kept)).toContain('nodes[greeting].futureProp');
  });
  it('is deterministic and never silently drops one of the variant’s differences', () => {
    const base = newer(greetingText('Base greeting.'), { type: 'DELETE_NODE', nodeId: 'interest-explainer' }, { type: 'UPSERT_RULE', rule: { ...ruleOf(BASE, 'R06'), priority: 2 } });
    const a = update(differing(), base), b = update(differing(), base);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const mine = compareWithBase(BASE, differing());
    const after = new Map(compareWithBase(base, a.project).map((d) => [d.id, d]));
    const reported = new Set([...ids(a.kept), ...ids(a.needsLook)]);
    for (const d of mine) expect(after.has(d.id) || reported.has(d.id), d.id).toBe(true);
  });
  it('maps the base’s new pinned test to the variant’s copy of its customer', () => {
    const base = newer({ type: 'UPSERT_TEST_CASE', testCase: { id: 'T9', name: 'New', recordId: 'CARD-0002', expect: {} } });
    const u = update(fresh(), base, { 'CARD-0002': 'REC-60002' });
    expect(u.project.testCases!.find((t) => t.id === 'T9')!.recordId).toBe('REC-60002');
  });
  it('one undoable step in the working version', () => {
    const v = differing();
    const u = update(v, newer(greetingText('Base greeting.')));
    const r = applyCommand(v, { type: 'UPDATE_FROM_BASE', project: u.project });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.modelVersion).toBe(v.modelVersion + 1);
    expect(r.label).toMatch(/Update from “Aster Card statement” \(version 3 to 5\)/);
    expect(applyCommand(r.project, { type: 'RESTORE_SNAPSHOT', project: v, label: 'Undo' }).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ use the base's again */

describe('use the base’s again (drops one difference)', () => {
  const v = differing();
  const back = (id: string) => { const r = useBaseAgain(v, BASE, id); if ('error' in r) throw new Error(r.error); return r.project; };
  it('a wording', () => {
    const p = back('nodes[greeting].content');
    expect(compareWithBase(BASE, p).some((d) => d.id === 'nodes[greeting].content')).toBe(false);
    expect(compareWithBase(BASE, p).length).toBe(compareWithBase(BASE, v).length - 1);
  });
  it('a hidden section comes back where the base has it', () => {
    const p = back('nodes[high-volume-note]');
    expect(childrenOf(p, 'doc-root').indexOf('high-volume-note')).toBe(childrenOf(p, 'doc-root').indexOf('rewards-summary') + 1);
    expect(variantLockProblem(BASE, p)).toBeNull();
  });
  it('a section of its own is removed', () => {
    const p = back('nodes[lakeshore-note]');
    expect(p.nodes.some((n) => n.id === 'lakeshore-note')).toBe(false);
  });
  it('a rule, a message translation, a table and the brand', () => {
    expect(ruleOf(back('rules[R06]'), 'R06').priority).toBe(ruleOf(BASE, 'R06').priority);
    expect(partText(back('contentParts[payment-standard].approvedLocales.es-US'), 'payment-standard', 'es-US')).toBeUndefined();
    expect(back('lookupTables[feeByTier].rows').lookupTables![0].rows).toEqual(FEE_BY_TIER.rows);
    expect(back('brand').brand).toBeUndefined();
    const p = back('futureSetting');
    expect('futureSetting' in p).toBe(false);
  });
  it('refuses what would break the variant', () => {
    const withRule = run(differing(), { type: 'UPSERT_RULE', rule: { id: 'R41', scope: 'credit-statement', mode: 'additive', priority: 10, when: { op: 'gte', path: 'card.missedPayments', value: 1 }, then: { op: 'showSection', targetNodeId: 'lakeshore-note' }, version: 1 } as Rule });
    const r = useBaseAgain(withRule, BASE, 'nodes[lakeshore-note]');
    expect('error' in r && r.error).toMatch(/R41/);
    expect('error' in useBaseAgain(v, BASE, 'nothing-like-this')).toBe(true);
  });
  it('goes through the command bus as one step', () => {
    const r = useBaseAgain(v, BASE, 'brand');
    if ('error' in r) throw new Error(r.error);
    const done = applyCommand(v, { type: 'USE_BASE_AGAIN', project: r.project, label: r.label });
    expect(done.ok && done.label).toMatch(/Use the base’s brand again/);
  });
});
