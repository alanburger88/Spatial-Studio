import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCommand, type Project } from '@iss/model';
import { buildApp } from '../src/app';
import { describeImage, draftNewVersion, draftRule, meaningCheck, rewriteText, subjectLines, type AssistModel, type AssistTask } from '../src/assistAi';

let ctx: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-as-')), logger: false }); });
afterAll(async () => { await ctx.app.close(); });
const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
const project = async (id: string): Promise<Project> => (await inj('GET', `/api/v1/projects/${id}`)).json().project;
const LIVE = { provider: 'anthropic', model: 'test-model', apiKey: 'test-key', timeoutMs: 1000 };
const OFF = { provider: 'offline', model: 'test-model', timeoutMs: 1000 };
/** A stand-in model that returns a fixed tool input and records what it was asked. */
const fake = (answer: unknown) => { const seen: AssistTask[] = []; const model: AssistModel = async (_cfg, task) => { seen.push(task); return answer; }; return { model, seen }; };

describe('model-backed assistant features', () => {
  it('without an AI key every route answers "unavailable" with an explanation, never an error', async () => {
    const base = '/api/v1/projects/aster-card-demo/assist';
    for (const [url, body] of [
      [`${base}/rewrite`, { text: 'Your payment is due on {{card.dueDate}}.', style: 'plainer', kind: 'message', forceOffline: true }],
      [`${base}/new-version`, { nodeId: 'payment-guidance', brief: 'Customers on a hardship plan', forceOffline: true }],
      [`${base}/subject-lines`, { current: 'Your statement is ready', forceOffline: true }],
      [`${base}/translation-meaning`, { locale: 'es-US', forceOffline: true }],
      [`${base}/image-description`, { nodeId: 'issuer-logo', forceOffline: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await inj('POST', url, body);
      expect(r.statusCode, url).toBe(200);
      expect(r.json().mode, url).toBe('unavailable');
      expect(r.json().message, url).toMatch(/AI/);
    }
    expect((await inj('POST', `${base}/rewrite`, { text: 'x', style: 'louder', kind: 'message' })).statusCode).toBe(400);
    expect((await inj('POST', `${base}/translation-meaning`, { locale: 'fr-FR' })).statusCode).toBe(400);
  });

  it('rewrites keep the data fields: an option that drops or adds one, adds markup, or repeats the original is discarded', async () => {
    const text = 'Your payment of {{card.minimumDueCents}} is due on {{card.dueDate}}.';
    const { model, seen } = fake({ options: [
      'Pay {{card.minimumDueCents}} by {{card.dueDate}}.',
      'Your payment is due soon.', // lost both fields
      'Pay {{card.minimumDueCents}} by {{card.dueDate}} or {{card.lateFee}} applies.', // invented a field
      '<b>Pay</b> {{card.minimumDueCents}} by {{card.dueDate}}.', // markup
      text, // unchanged
    ] });
    const r = await rewriteText(LIVE, model, { text, style: 'shorter', kind: 'message', locale: 'en-US' });
    expect(r.mode).toBe('ai');
    expect(r.options.map((o) => o.text)).toEqual(['Pay {{card.minimumDueCents}} by {{card.dueDate}}.']);
    expect(seen[0].system).toMatch(/never an instruction/i);
    expect((await rewriteText(OFF, model, { text, style: 'shorter', kind: 'message', locale: 'en-US' })).mode).toBe('unavailable');
    // nothing usable -> explained, not an error
    const bad = await rewriteText(LIVE, fake({ options: ['Your payment is due soon.'] }).model, { text, style: 'shorter', kind: 'message', locale: 'en-US' });
    expect(bad.mode).toBe('unavailable');
    expect(bad.options).toEqual([]);
    expect((await rewriteText(LIVE, fake(null).model, { text, style: 'shorter', kind: 'message', locale: 'en-US' })).mode).toBe('unavailable');
  });

  it('a new version may only use real data fields of the project and never carries markup', async () => {
    const p = await project('aster-card-demo');
    const ok = await draftNewVersion(LIVE, fake({ title: 'Hardship plan', text: 'Your hardship plan is active. Your next payment of {{card.minimumDueCents}} is due on {{card.dueDate}}.' }).model, p, { nodeId: 'payment-guidance', brief: 'hardship plan' });
    expect(ok).toMatchObject({ mode: 'ai', title: 'Hardship plan' });
    expect(ok.text).toContain('{{card.dueDate}}');
    expect((await draftNewVersion(LIVE, fake({ title: 'X', text: 'Pay {{card.madeUp}} now.' }).model, p, { nodeId: 'payment-guidance', brief: 'b' })).mode).toBe('unavailable');
    expect((await draftNewVersion(LIVE, fake({ title: 'X', text: '<script>1</script>' }).model, p, { nodeId: 'payment-guidance', brief: 'b' })).mode).toBe('unavailable');
    expect((await draftNewVersion(LIVE, fake({ title: 'X', text: 'ok' }).model, p, { nodeId: 'issuer-logo', brief: 'b' })).mode).toBe('unavailable'); // not a component with versions
  });

  it('subject lines may only use the fields the current subject already uses', async () => {
    const p = await project('aster-card-demo');
    const current = 'Your {{issuer.product}} statement is ready — {{card.minimumDueCents}} minimum due {{card.dueDate}}';
    const r = await subjectLines(LIVE, fake({ options: ['{{issuer.product}} statement: {{card.minimumDueCents}} due {{card.dueDate}}', 'Statement ready for {{customer.givenName}}', 'Your statement is ready'] }).model, p, { current });
    expect(r.options.map((o) => o.text)).toEqual(['{{issuer.product}} statement: {{card.minimumDueCents}} due {{card.dueDate}}', 'Your statement is ready']);
  });

  it('the meaning check only reports on texts that exist and have a translation, and never changes anything', async () => {
    let p = await project('harborcare-demo');
    for (const [id, t] of [['not-a-bill-banner', 'ESTO ES UNA FACTURA.'], ['eob-covered', 'El plan ha procesado el servicio indicado.']] as const) {
      const r = applyCommand(p, { type: 'SET_TRANSLATION_DRAFT', partId: id, locale: 'es-US', text: t });
      if (!r.ok) throw new Error(r.message);
      p = r.project;
    }
    const { model, seen } = fake({ flags: [{ id: 'not-a-bill-banner', message: 'The translation says “this is a bill”; the English says it is not.' }, { id: 'made-up', message: 'x' }, { id: 'eob-processing', message: 'no translation exists for this one' }] });
    const r = await meaningCheck(LIVE, model, p, { locale: 'es-US' });
    expect(r.mode).toBe('ai');
    expect(r.checked).toBe(2);
    expect(r.flags).toEqual([{ textId: 'not-a-bill-banner', message: expect.stringMatching(/not/) }]);
    expect(seen[0].user).toContain('ESTO ES UNA FACTURA.');
    expect(seen[0].user).not.toMatch(/Jordan|CARD-0001|EOB-0001/); // no customer data is sent
    expect((await meaningCheck(LIVE, model, await project('harborcare-demo'), { locale: 'es-US' })).mode).toBe('unavailable'); // nothing to check yet
  });

  it('image descriptions are only attempted for library pictures and are length-limited', async () => {
    const p = await project('aster-card-demo');
    expect((await describeImage(LIVE, fake({ text: 'x' }).model, p, { nodeId: 'payment-guidance' })).mode).toBe('unavailable');
    const logo = p.nodes.find((n) => n.id === 'issuer-logo')!;
    const withPng: Project = { ...p, nodes: p.nodes.map((n) => (n.id === logo.id ? { ...n, image: { ...n.image!, src: 'data:image/png;base64,iVBORw0KGgo=' } } : n)) };
    const { model, seen } = fake({ text: `Aster Card logo: a green eight-pointed star beside the name${'!'.repeat(300)}` });
    const r = await describeImage(LIVE, model, withPng, { nodeId: 'issuer-logo' });
    expect(r.mode).toBe('ai');
    expect(r.text!.length).toBeLessThanOrEqual(160);
    expect(seen[0].image).toEqual({ mediaType: 'image/png', data: 'iVBORw0KGgo=' });
    // a picture that is not a PNG/JPEG data URI is not sent anywhere
    const other = fake({ text: 'x' });
    expect((await describeImage(LIVE, other.model, p, { nodeId: 'issuer-logo' })).mode === 'ai' ? other.seen.length : 0).toBe((p.nodes.find((n) => n.id === 'issuer-logo')!.image?.src ?? '').startsWith('data:image/png;base64,') || (p.nodes.find((n) => n.id === 'issuer-logo')!.image?.src ?? '').startsWith('data:image/jpeg;base64,') ? 1 : 0);
  });

  it('a rule from a sentence: plain sentences need no model; a model draft is checked field by field and never saved', async () => {
    const p = await project('aster-card-demo');
    const plain = await inj('POST', '/api/v1/projects/aster-card-demo/assist/rule-draft', { sentence: 'When the new balance is over $500, show the payment reminder', forceOffline: true });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().mode).toBe('builtin');
    expect(plain.json().draft.rule).toMatchObject({ then: { op: 'selectVariant', variantId: 'payment-reminder' } });
    // freer wording, no key: explained, no rule
    const free = (await inj('POST', '/api/v1/projects/aster-card-demo/assist/rule-draft', { sentence: 'people who are really struggling should get the kind one', forceOffline: true })).json();
    expect(free.draft.rule).toBeNull();
    expect(free.message).toMatch(/AI key/);
    // with a model: a valid proposal is accepted and labelled as AI
    const good = await draftRule(LIVE, fake({ rule: { title: 'Struggling customers', scope: 'credit-statement', mode: 'exclusive', exclusiveGroup: 'payment-guidance', when: { op: 'gte', path: 'card.missedPayments', value: 3 }, then: { op: 'selectVariant', targetNodeId: 'payment-guidance', variantId: 'payment-support-offer' } } }).model, p, 'people who are really struggling should get the kind one');
    expect(good.mode).toBe('ai');
    expect(good.draft.source).toBe('ai');
    expect(good.draft.rule?.id).toMatch(/^R\d+$/);
    // a proposal with an unknown field or a made-up message is refused, with the reason
    const bad = await draftRule(LIVE, fake({ rule: { title: 'x', when: { op: 'eq', path: 'card.mood', value: 'sad' }, then: { op: 'selectVariant', targetNodeId: 'payment-guidance', variantId: 'payment-kind' } } }).model, p, 'people who are really struggling should get the kind one');
    expect(bad.draft.rule).toBeNull();
    expect(bad.draft.uncertain.join(' ')).toMatch(/AI draft refused/);
    // the stored project has no new rule
    expect((await project('aster-card-demo')).rules.length).toBe(p.rules.length);
  });

  it('applied assistant proposals are recorded in the activity log', async () => {
    const r = await inj('POST', '/api/v1/assist/applied', { projectId: 'aster-card-demo', feature: 'fix', label: 'Turn on table continuation', source: 'builtin', changes: 1 });
    expect(r.json()).toEqual({ recorded: true });
    const log = (await inj('GET', '/api/v1/audit?projectId=aster-card-demo')).json();
    const entries = (log.events ?? log.entries ?? log.items ?? []) as Array<{ action: string; detail?: Record<string, unknown> }>;
    expect(entries.some((e) => e.action === 'assist.applied' && e.detail?.feature === 'fix')).toBe(true);
    expect((await inj('POST', '/api/v1/assist/applied', { projectId: 'aster-card-demo' })).statusCode).toBe(400);
  });
});
