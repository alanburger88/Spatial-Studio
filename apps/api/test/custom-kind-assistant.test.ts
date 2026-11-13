import { describe, expect, it } from 'vitest';
import { blankProject, type SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import { planTestData } from '@iss/scenarios';
import { assistantModelContext, offlineInterpret, suggestedQuestions, validateActions, type AssistantContext } from '../src/assistant';
import { draftNewVersion, draftRule, rewriteText, subjectLines, type AssistModel, type AssistTask } from '../src/assistAi';
import { draftTranslations, type TranslateItem, type Translator } from '../src/translate';
import { gymMember, gymProject, run } from '../../../packages/model/test/helpers/customProject';

/**
 * The assistant on a document with its own data: what the offline assistant understands, and exactly what a live model
 * would be told. No model is called here.
 */
const LIVE = { provider: 'anthropic', model: 'test-model', apiKey: 'test-key', timeoutMs: 1000 };
const SAMPLE = /\b(card|cardholder|credit|claims?|eob|statement|bill|balance|benefits|aster|harborcare|member responsibility)\b/i;
const fake = (answer: unknown) => { const seen: AssistTask[] = []; const model: AssistModel = async (_cfg, task) => { seen.push(task); return answer; }; return { model, seen }; };

const project = gymProject({ withSpanish: true });
const generated: SyntheticRecord[] = planTestData(project, [], { outcomes: true, edges: true }).customers.map((c, i) => ({ ...c.record, recordId: `REC-${60001 + i}`, projectId: project.projectId, generated: { label: c.label } }));
const supplied: SyntheticRecord = { ...gymMember({ recordId: 'REC-60090', customer: { givenName: 'Real', familyName: 'Person' } }), imported: true, projectId: project.projectId };
const records = [...generated, supplied];
const ctxFor = (recordId: string, over: Partial<AssistantContext> = {}): AssistantContext => ({ project, records, recordId, overrides: {}, journeyCursor: null, selectedNodeId: null, ...over });

describe('what a live model is told about a document with its own data', () => {
  it('the project’s own fields, rules and customers; nothing about cards or claims; never a supplied customer’s name', () => {
    const current = generated[1];
    const c = assistantModelContext(ctxFor(current.recordId), resolve({ project, record: current }));
    expect(c).toMatchObject({ documentType: 'custom', edgeCasePresets: [], currentCustomer: { id: current.recordId, name: `${current.customer.givenName} ${current.customer.familyName}`, persona: undefined } });
    expect(c.scenarioFields.map((f) => f.path)).toEqual(['documentType', 'recordId', 'customer.givenName', 'customer.familyName', 'customer.locale', 'customer.accessibility.largeText', 'customer.accessibility.highContrast', 'customer.middleName', 'custom.planName', 'custom.monthlyFeeCents', 'custom.renewalDate', 'custom.tier', 'custom.autoRenew', 'custom.visits']);
    expect(c.scenarioFields.find((f) => f.path === 'custom.tier')).toEqual({ path: 'custom.tier', type: 'enum', values: ['basic', 'plus', 'pro'], label: 'Membership tier' });
    expect(c.records).toHaveLength(records.length);
    expect(c.records[0]).toMatchObject({ id: current.recordId, about: current.generated!.label });
    expect(c.records.every((r) => r.id.startsWith('REC-') && r.status === undefined && r.persona === undefined)).toBe(true);
    // a supplied customer is a person's own data: the name is never sent
    expect(c.records.find((r) => r.id === 'REC-60090')!.name).toBeUndefined();
    expect(JSON.stringify(c)).not.toContain('Real Person');
    expect(JSON.stringify(c).match(SAMPLE)?.[0]).toBeUndefined();
  });

  it('writing helpers describe it neutrally and offer only its own data fields', async () => {
    const subjects = fake({ options: ['Your Northside Gym notice is ready'] });
    await subjectLines(LIVE, subjects.model, project, { current: 'Your {{issuer.name}} document is ready' });
    expect(subjects.seen[0].user).toContain('Document type: a customer document on the issuer’s own data');
    expect(`${subjects.seen[0].system}\n${subjects.seen[0].user}`.match(SAMPLE)?.[0]).toBeUndefined();

    const rewrite = fake({ options: ['Your plan renews soon.'] });
    await rewriteText(LIVE, rewrite.model, { text: 'Your plan will renew in the near future.', style: 'one-sms', kind: 'sms', locale: 'en-US', documentType: 'custom' });
    expect(`${rewrite.seen[0].system}\n${rewrite.seen[0].user}`.match(SAMPLE)?.[0]).toBeUndefined();
    // the samples keep their instructions word for word
    await rewriteText(LIVE, rewrite.model, { text: 'Your plan will renew in the near future.', style: 'one-sms', kind: 'sms', locale: 'en-US', documentType: 'eob' });
    expect(rewrite.seen[1].system).toContain('(a credit-card statement or a health-plan explanation of benefits)');
    expect(rewrite.seen[1].user).toContain('(such as THIS IS NOT A BILL)');

    const version = fake({ title: 'Plus members', text: 'Your {{custom.planName}} plan renews on {{custom.renewalDate}}.' });
    const drafted = await draftNewVersion(LIVE, version.model, project, { nodeId: 'renewal-note', brief: 'For Plus members' });
    expect(drafted).toMatchObject({ mode: 'ai', title: 'Plus members' });
    const offered = JSON.parse(/Allowed data fields \(JSON\): (.*)\nBrief/.exec(version.seen[0].user)![1]) as Array<{ token: string }>;
    expect(offered.map((f) => f.token)).toEqual(expect.arrayContaining(['{{customer.givenName}}', '{{custom.planName}}', '{{custom.visits}}']));
    expect(offered.some((f) => /card\.|claim|member\./.test(f.token) || /sessions/.test(f.token))).toBe(false);
    // a draft that reaches for a card field is refused
    const wrong = fake({ title: 'Balance', text: 'Your balance is {{card.newBalanceCents}}.' });
    expect((await draftNewVersion(LIVE, wrong.model, project, { nodeId: 'renewal-note', brief: 'x' })).mode).not.toBe('ai');

    // a rule from a sentence: understood without a model, in this document's own fields
    const none = fake(null);
    const rule = await draftRule(LIVE, none.model, project, 'When membership tier is basic, show We miss you in Message');
    expect(rule).toMatchObject({ mode: 'builtin', draft: { rule: { scope: 'custom', when: { op: 'eq', path: 'custom.tier', value: 'basic' } } } });
    expect(none.seen).toEqual([]);
    // when the built-in reader gives up, the model is given this document's vocabulary only
    await draftRule(LIVE, none.model, project, 'Give long-standing regulars something nice');
    expect(none.seen).toHaveLength(1);
    expect(none.seen[0].user).toContain('custom.sessions.count');
    expect(none.seen[0].user).not.toMatch(/card\.|claim\./);
  });

  it('translation drafts cover its own wording and the neutral fixed wording, not the samples’', async () => {
    let asked: TranslateItem[] = [];
    const translator: Translator = async (_cfg, _locale, items) => { asked = items; return items.map((it) => ({ id: it.id, text: `ES ${it.source}` })); };
    const reply = await draftTranslations(project, 'es-US', undefined, LIVE, translator);
    expect(reply.mode).toBe('ai');
    const ids = asked.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['@heading/content', '@sessions/caption', '@sessions/col.className', '@email/subject', '@sms/text', '@sys/sectionDetails', '@sys/emailSyntheticCueDocument']));
    for (const id of ['@sys/sectionTransactions', '@sys/sectionClaims', '@sys/barNotBill', '@sys/emailSyntheticCue', '@sys/guardNotDetermined', '@fee/label', 'note-pro']) expect(ids).not.toContain(id);
    expect(asked.map((a) => a.source).join('\n').match(SAMPLE)?.[0]).toBeUndefined();
    // without a model there are no bundled drafts for a document that is not one of the samples
    const off = await draftTranslations(project, 'es-US', undefined, { provider: 'offline', model: 'test-model', timeoutMs: 1000 }, translator);
    expect(off).toMatchObject({ mode: 'unavailable', drafts: [] });
  });
});

describe('the offline assistant on a document with its own data', () => {
  const say = (message: string, over: Partial<AssistantContext> = {}) => offlineInterpret(message, ctxFor(generated[0].recordId, over));

  it('offers only questions that apply to it', () => {
    expect(suggestedQuestions(project)).toEqual(['Why is this message showing?', 'What rules apply?', 'Run validation', 'Change R01 priority to 220', 'Open cube', 'Open landscape', 'Translate this document', 'Edit the email wording']);
    const blank = blankProject({ projectId: 'empty-doc', title: 'Empty' });
    expect(suggestedQuestions(blank)).toEqual(['What rules apply?', 'Run validation', 'Open cube', 'Open landscape', 'Translate this document', 'Edit the email wording']);
    // every suggestion is something it then understands
    for (const q of suggestedQuestions(project)) expect(say(q).understood, q).toBe(true);
    expect(suggestedQuestions(project).join(' ').match(SAMPLE)?.[0]).toBeUndefined();
  });

  it('answers from the engine in the document’s own names, and says what it cannot do', () => {
    const who = `${generated[0].customer.givenName} ${generated[0].customer.familyName}`;
    expect(say('What rules apply?').reply).toContain(`For ${who} the engine matched “Rare visitors who do not renew automatically”`);
    expect(say('Why is this message showing?').actions).toEqual([{ action: 'explain_resolution', nodeId: 'renewal-note' }]);
    expect(say('Change R01 priority to 220').actions).toEqual([{ action: 'propose_rule_edit', ruleId: 'R01', patch: { priority: 220 } }]);
    expect(say('Run validation').actions).toEqual([{ action: 'run_validation' }]);
    expect(say('Open cube').actions).toEqual([{ action: 'navigate_view', view: 'cube' }]);
    expect(say('Translate this document').actions).toEqual([{ action: 'navigate_view', view: 'content' }]);
    expect(say(`show me ${generated[3].customer.givenName} ${generated[3].customer.familyName}`).actions).toEqual([{ action: 'select_scenario', recordId: generated[3].recordId }]);
    expect(say('generate test customers').actions).toEqual([{ action: 'navigate_view', view: 'rules-data' }]);

    const edge = say('show the spanish edge case');
    expect(edge).toMatchObject({ understood: true, actions: [] });
    expect(edge.reply).toMatch(/no ready-made edge cases for a document with its own data/);
    // card and claim requests are not understood here, and nothing is set or switched by everyday words
    for (const q of ['Show me a customer who missed 2 payments and asked for assistance', 'Show me a claim that was denied pending review', 'premium customers who prefer paper', 'open the claims table', 'go to the bank details']) {
      const r = say(q);
      expect(r.actions.filter((a: any) => a.action === 'set_scenario_fields' || a.action === 'open_project' || a.action === 'generate_edge_case'), q).toEqual([]);
    }
    expect(say('switch to HarborCare').actions).toEqual([{ action: 'open_project', projectId: 'harborcare-demo' }]);
    for (const q of ['What rules apply?', 'help', 'show the spanish edge case', 'Show me a claim that was denied pending review', 'gibberish request']) {
      const r = say(q);
      expect(`${r.reply} ${(r.suggestions ?? []).join(' ')}`.match(SAMPLE)?.[0], q).toBeUndefined();
    }
    // a model that asks for a card preset anyway is refused in plain words
    const refused = validateActions([{ action: 'generate_edge_case', preset: 'zero-transactions' }], ctxFor(generated[0].recordId));
    expect(refused.ok).toEqual([]);
    expect(refused.rejected[0].reason).toBe('Ready-made edge cases are not available for a document with its own data. Generate test customers instead.');
  });

  it('a blank project with no rules or messages gets honest answers', () => {
    const blank = blankProject({ projectId: 'empty-doc', title: 'Empty' });
    const one: SyntheticRecord = { recordId: 'REC-60001', documentType: 'custom', customer: { givenName: 'Avery', familyName: 'Abbott', locale: 'en-US' } };
    const ask = (message: string) => offlineInterpret(message, { project: blank, records: [one], recordId: one.recordId, overrides: {}, journeyCursor: null, selectedNodeId: null });
    expect(ask('What rules apply?')).toMatchObject({ understood: true, actions: [], reply: expect.stringContaining('This document has no rules yet, so every customer gets the same document.') });
    expect(ask('Why is this message showing?')).toMatchObject({ understood: true, actions: [], reply: expect.stringContaining('This document has no message that varies by customer yet') });
    // with a message added, the same question is explained from the engine
    const withNote = run(gymProject(), { type: 'DELETE_RULE', ruleId: 'R01' });
    expect(offlineInterpret('Why is this message showing?', { project: withNote, records: [gymMember()], recordId: 'REC-60001', overrides: {}, journeyCursor: null, selectedNodeId: null }).actions).toEqual([{ action: 'explain_resolution', nodeId: 'renewal-note' }]);
  });
});
