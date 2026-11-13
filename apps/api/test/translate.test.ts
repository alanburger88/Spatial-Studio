import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCommand, translationStatus, type Project } from '@iss/model';
import { buildApp } from '../src/app';
import { draftTranslations, type Translator } from '../src/translate';
import { offlineInterpret } from '../src/assistant';

let ctx: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-tr-')), logger: false }); });
afterAll(async () => { await ctx.app.close(); });
const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
const project = async (id: string): Promise<Project> => (await inj('GET', `/api/v1/projects/${id}`)).json().project;
const LIVE = { provider: 'anthropic', model: 'test-model', apiKey: 'test-key', timeoutMs: 1000 };
const OFF = { provider: 'offline', model: 'test-model', timeoutMs: 1000 };

describe('first-pass translation drafts', () => {
  it('without an AI key the sample projects get labelled sample drafts for Spanish; nothing is saved or approved', async () => {
    const r = await inj('POST', '/api/v1/projects/aster-card-demo/translate', { locale: 'es-US', forceOffline: true });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mode).toBe('sample');
    expect(body.drafts.length).toBeGreaterThan(100);
    expect(body.drafts.every((d: any) => d.tokenCheck.ok)).toBe(true);
    expect(body.skipped).toEqual([]);
    expect(body.message).toMatch(/not been reviewed/);
    // every kind of text is covered: messages, labels, headings, fixed wording, email and SMS
    const ids = body.drafts.map((d: any) => d.id);
    for (const id of ['payment-standard', '@billing-summary/label', '@title/payment-standard', '@sys/pageOf', '@email/subject', '@sms/text']) expect(ids, id).toContain(id);
    // the stored project is untouched
    const p = await project('aster-card-demo');
    expect(translationStatus(p, 'es-US').summary.drafts).toBe(0);
    expect(translationStatus(p, 'es-US').summary.approved).toBe(0);
  });

  it('a sample is not offered once the English text has been changed, and only requested ids are returned', async () => {
    const p = await project('aster-card-demo');
    const r1 = applyCommand(p, { type: 'UPDATE_NODE', nodeId: 'billing-summary', patch: { label: 'Statement balance' } });
    if (!r1.ok) throw new Error(r1.message);
    const body = (await inj('POST', '/api/v1/projects/aster-card-demo/translate', { locale: 'es-US', forceOffline: true, ids: ['@billing-summary/label', '@payment-due/label'], project: r1.project })).json();
    expect(body.drafts.map((d: any) => d.id)).toEqual(['@payment-due/label']);
    expect(body.skipped).toEqual([{ id: '@billing-summary/label', reason: expect.stringMatching(/English text was changed/) }]);
  });

  it('other languages and projects need live AI: the reply explains, it is not an error', async () => {
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/translate', { locale: 'fr-FR' })).statusCode).toBe(400); // not a project language yet
    const p = await project('aster-card-demo');
    const added = applyCommand(p, { type: 'ADD_LANGUAGE', locale: 'fr-FR' });
    if (!added.ok) throw new Error(added.message);
    const body = (await inj('POST', '/api/v1/projects/aster-card-demo/translate', { locale: 'fr-FR', forceOffline: true, project: added.project })).json();
    expect(body.mode).toBe('unavailable');
    expect(body.drafts).toEqual([]);
    expect(body.message).toMatch(/AI_API_KEY/);
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/translate', { locale: 'en-US' })).statusCode).toBe(400);
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/translate', { locale: 'xx-XX' })).statusCode).toBe(400);
  });

  it('with live AI the translator output is treated as untrusted: token checks, unknown ids dropped, markup refused', async () => {
    const p0 = await project('harborcare-demo');
    const added = applyCommand(p0, { type: 'ADD_LANGUAGE', locale: 'fr-FR' });
    if (!added.ok) throw new Error(added.message);
    const asked: string[] = [];
    const fake: Translator = async (_cfg, locale, items) => {
      asked.push(...items.map((i) => i.id));
      expect(locale).toBe('fr-FR');
      return [
        { id: 'not-a-bill-banner', text: 'CECI N’EST PAS UNE FACTURE.' },
        { id: 'claim-identifiers', text: 'Identifiant de la demande.' }, // dropped the {{claim.claimId}} token
        { id: 'eob-covered', text: '<script>alert(1)</script>' }, // markup the English text does not have
        { id: 'made-up-id', text: 'ignored' },
        { id: '@sys/pageOf', text: 'Page {page} sur {total}' },
      ];
    };
    const body = await draftTranslations(added.project, 'fr-FR', ['not-a-bill-banner', 'claim-identifiers', 'eob-covered', '@sys/pageOf'], LIVE, fake);
    expect(body.mode).toBe('ai');
    expect(asked.sort()).toEqual(['@sys/pageOf', 'claim-identifiers', 'eob-covered', 'not-a-bill-banner']);
    const byId = Object.fromEntries(body.drafts.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['@sys/pageOf', 'claim-identifiers', 'not-a-bill-banner']);
    expect(byId['not-a-bill-banner'].tokenCheck.ok).toBe(true);
    expect(byId['@sys/pageOf'].tokenCheck.ok).toBe(true);
    expect(byId['claim-identifiers'].tokenCheck).toMatchObject({ ok: false, missing: ['claim.claimId'] });
    expect(body.skipped).toEqual([{ id: 'eob-covered', reason: expect.stringMatching(/markup/) }]);
    // a draft that lost a data field can be stored as a draft but never approved
    let p = added.project;
    const stored = applyCommand(p, { type: 'SET_TRANSLATION_DRAFTS', locale: 'fr-FR', origin: 'ai', items: body.drafts.map((d) => ({ id: d.id, text: d.text })) });
    if (!stored.ok) throw new Error(stored.message);
    p = stored.project;
    expect(applyCommand(p, { type: 'APPROVE_TRANSLATIONS', locale: 'fr-FR', ids: ['not-a-bill-banner', 'claim-identifiers'] }).ok).toBe(false);
    const ok = applyCommand(p, { type: 'APPROVE_TRANSLATIONS', locale: 'fr-FR', ids: ['not-a-bill-banner', '@sys/pageOf'] });
    expect(ok.ok).toBe(true);
  });

  it('when live AI does not answer, the sample projects fall back to the sample drafts and say so', async () => {
    const p = await project('aster-card-demo');
    const failing: Translator = async () => null;
    const body = await draftTranslations(p, 'es-US', ['payment-standard'], LIVE, failing);
    expect(body.mode).toBe('sample');
    expect(body.providerStatus).toMatch(/did not answer/);
    expect((await draftTranslations(p, 'es-US', ['payment-standard'], OFF, failing)).mode).toBe('sample');
  });

  it('the assistant routes translation and channel-wording requests to the right screen', async () => {
    const p = await project('aster-card-demo');
    const base = { project: p, records: [], recordId: 'CARD-0001', overrides: {}, journeyCursor: null, selectedNodeId: null } as any;
    expect(offlineInterpret('translate this document into Spanish', base).actions).toContainEqual({ action: 'navigate_view', view: 'content' });
    expect(offlineInterpret('I want to change the email subject line', base).actions).toContainEqual({ action: 'navigate_view', view: 'channels' });
    // an ordinary scenario request is not hijacked
    expect(offlineInterpret('show me a Spanish customer', base).actions).not.toContainEqual({ action: 'navigate_view', view: 'content' });
  });
});
