import { describe, expect, it } from 'vitest';
import { applyCommand, translationStatus, type Command, type Project, type SyntheticRecord, type WordingRule } from '@iss/model';
import { checkWording, documentBlockers, replaceOccurrences, setTextCommands, wordingTexts } from '@iss/scenarios';
import { EXAMPLES } from '../../../scripts/audit-examples';
import { compliantRewrite, type AssistModel, type AssistTask } from '../src/assistAi';
import { draftTranslations, type TranslateItem, type Translator } from '../src/translate';

/**
 * Blockers phase 5 (wave 4, item 6): AI drafts for wording blockers. The assistant policy is unchanged (D65): what a model
 * is sent holds no customer value, a translation is stored as a DRAFT and never approved, the blocker stays listed until a
 * person approves, and a suggested rewording is one undoable change. No live model is called: stand-ins only.
 */

const ex = (id: string) => { const e = EXAMPLES.find((x) => x.id === id)!; return { project: e.project as Project, records: e.customers as SyntheticRecord[] }; };
const ASTER = ex('aster-card-demo'), HARBOR = ex('harborcare-demo');
const LIVE = { provider: 'anthropic', model: 'test-model', apiKey: 'test-key', timeoutMs: 1000 };
const OFF = { provider: 'offline', model: 'test-model', timeoutMs: 1000 };
const run = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; };

/** Every string (4+ characters) and large number a customer's data holds that the document itself does not. */
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
const MISSING = 'required-translation-missing~payment-standard~es-US';

describe('draft the translation for a missing required translation', () => {
  it('the translator is sent the document’s English text only, never a customer value', async () => {
    const sent: TranslateItem[][] = [];
    const fake: Translator = async (_cfg, _locale, items) => { sent.push(items); return items.map((i) => ({ id: i.id, text: 'Su pago vence el {{card.dueDate}}.' })); };
    const r = await draftTranslations(ASTER.project, 'es-US', ['payment-standard'], LIVE, fake);
    expect(r.mode).toBe('ai');
    expect(sent.flat().map((i) => i.id)).toEqual(['payment-standard']);
    const body = JSON.stringify(sent);
    const values = customerValues(ASTER.project, ASTER.records);
    expect(values.length).toBeGreaterThan(50);
    for (const v of values) expect(body.includes(v), `sent a customer value: ${v}`).toBe(false);
  });

  it('is stored as a draft with where it came from, never approved; the blocker stays listed until a person approves', async () => {
    const blockersBefore = documentBlockers(ASTER.project, ASTER.records).blockers.find((b) => b.id === MISSING);
    expect(blockersBefore?.customerCount).toBe(6);
    // Without a key the built-in example gets the labelled sample draft (the same helper as Content & Translations).
    const sample = await draftTranslations(ASTER.project, 'es-US', ['payment-standard'], OFF);
    expect(sample.mode).toBe('sample');
    expect(sample.drafts).toEqual([expect.objectContaining({ id: 'payment-standard', tokenCheck: expect.objectContaining({ ok: true }) })]);
    // What the blocker detail applies: one command, the drafts with their origin.
    const p = run(ASTER.project, { type: 'SET_TRANSLATION_DRAFTS', locale: 'es-US', items: [{ id: 'payment-standard', text: sample.drafts[0].text }], origin: 'sample' });
    const row = translationStatus(p, 'es-US').rows.find((x) => x.partId === 'payment-standard')!;
    expect(row.status.status).toBe('draft');
    expect(row.origin).toBe('sample');
    expect(row.status.approvedText ?? null).toBeNull();
    expect(p.contentParts.find((c) => c.id === 'payment-standard')!.approvedLocales['es-US']).toBeUndefined();
    const still = documentBlockers(p, ASTER.records).blockers.find((b) => b.id === MISSING);
    expect(still?.recordIds).toEqual(blockersBefore!.recordIds);
    // Only a person's approval clears it.
    const approved = run(p, { type: 'APPROVE_TRANSLATION', partId: 'payment-standard', locale: 'es-US' });
    expect(documentBlockers(approved, ASTER.records).blockers.some((b) => b.id === MISSING)).toBe(false);
  });

  it('without a key and without a sample (a document with its own data and no bundled draft), it says so and drafts nothing', async () => {
    const north = ex('northwind-energy-demo');
    const r = await draftTranslations(north.project, 'es-US', ['pay-credit'], OFF);
    expect(r.mode).toBe('unavailable');
    expect(r.drafts).toEqual([]);
    expect(r.message).toMatch(/AI translation is not turned on, and there are no bundled sample drafts/);
  });
});

describe('suggest wording that follows the rules', () => {
  const MUST: WordingRule = { id: 'aster-relationship-team', kind: 'banned', severity: 'must', phrase: 'relationship specialist', replacement: 'relationship team', appliesTo: 'messages' };
  const withMust = () => run(ASTER.project, { type: 'UPDATE_WORDING_RULE', ruleId: 'aster-relationship-team', rule: MUST });

  it('a "must" wording rule makes a blocker; the rewrite is sent only the text and the rules, never a customer value', async () => {
    const p = withMust();
    const b = documentBlockers(p, ASTER.records).blockers.find((x) => x.code === 'WORDING_BANNED' && x.finding.details?.wordingRule === 'aster-relationship-team');
    expect(b).toBeDefined();
    expect(b!.customerCount).toBeGreaterThan(0);
    const t = wordingTexts(p).find((x) => x.id === b!.finding.details?.textId)!;
    const seen: AssistTask[] = [];
    const model: AssistModel = async (_c, task) => { seen.push(task); return { options: ['Contact your assigned relationship specialist now.', 'Contact your relationship team.'] }; };
    const r = await compliantRewrite(LIVE, model, p, { text: t.text, scope: t.scope, locale: 'en-US' });
    // The option that still breaks the "must" rule is dropped; the other is offered.
    expect(r.mode).toBe('ai');
    expect(r.options.map((o) => o.text)).toEqual(['Contact your relationship team.']);
    const sent = `${seen[0].system}\n${seen[0].user}`;
    for (const v of customerValues(p, ASTER.records)) expect(sent.includes(v), `sent a customer value: ${v}`).toBe(false);
    expect(seen[0].user).toContain('relationship specialist');
  });

  it('using a suggestion is ONE change; it clears the blocker, and the document before it is the undo', () => {
    const p = withMust();
    const b = documentBlockers(p, ASTER.records).blockers.find((x) => x.code === 'WORDING_BANNED' && x.finding.details?.wordingRule === 'aster-relationship-team')!;
    // The built-in path: the rule's own replacement, shown as a before and after.
    const f = checkWording(p).findings.find((x) => x.id === b.finding.details?.findingId)!;
    const t = wordingTexts(p).find((x) => x.id === f.textId)!;
    const after = replaceOccurrences(t.text, f.occurrences, f.replacement!);
    expect(after).toBe('Contact your assigned relationship team.');
    const cmds = setTextCommands(p, [{ textId: t.id, locale: t.locale, text: after }]);
    if ('reason' in cmds) throw new Error(cmds.reason);
    expect(cmds.commands).toHaveLength(1);
    const changed = run(p, cmds.commands[0]);
    expect(documentBlockers(changed, ASTER.records).blockers.some((x) => x.id === b.id)).toBe(false);
    expect(changed.contentParts.find((c) => c.id === 'relationship-manager')!.approvedLocales['en-US']).toBe(after);
    // the wording before the change is untouched in the previous project: one undo step restores it
    expect(p.contentParts.find((c) => c.id === 'relationship-manager')!.approvedLocales['en-US']).toBe(t.text);
  });

  it('a required disclosure is never rewritten by the assistant', () => {
    const disclosure = ASTER.project.contentParts.find((c) => c.type === 'disclosure')!;
    const r = setTextCommands(ASTER.project, [{ textId: disclosure.id, locale: 'en-US', text: 'Something else.' }]);
    expect('reason' in r && r.reason).toMatch(/approved disclosure text/);
  });

  it('the studio’s own "reads as a demand for money" check: a rewrite must pass it too, and only the text is sent', async () => {
    const seen: AssistTask[] = [];
    const model: AssistModel = async (_c, task) => { seen.push(task); return { options: ['Amount due now: {{claim.patientResponsibilityCents}}.', 'Your share, once the review is complete: {{claim.patientResponsibilityCents}}.'] }; };
    const text = 'Amount you owe: {{claim.patientResponsibilityCents}}.';
    const r = await compliantRewrite(LIVE, model, HARBOR.project, { text, scope: 'messages', locale: 'en-US', tone: true });
    expect(r.mode).toBe('ai');
    expect(r.options.map((o) => o.text)).toEqual(['Your share, once the review is complete: {{claim.patientResponsibilityCents}}.']);
    expect(seen[0].user).toMatch(/not read as a demand for money/);
    for (const v of customerValues(HARBOR.project, HARBOR.records)) expect(`${seen[0].system}\n${seen[0].user}`.includes(v), v).toBe(false);
    // Without a key nothing is called, and the answer says why.
    const off: AssistTask[] = [];
    const o = await compliantRewrite(OFF, async (_c, t) => { off.push(t); return null; }, HARBOR.project, { text, scope: 'messages', locale: 'en-US', tone: true });
    expect(o.mode).toBe('unavailable');
    expect(o.message).toMatch(/AI key/);
    expect(off).toHaveLength(0);
  });
});
