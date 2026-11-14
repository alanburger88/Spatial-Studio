import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCommand, type Command, type Project, type WordingRule } from '@iss/model';
import { RECORDS, seedProjects } from '@iss/model/fixtures';
import { buildApp } from '../src/app';
import { compliantRewrite, type AssistModel, type AssistTask } from '../src/assistAi';
import type { PackageComposer } from '../src/releasePackage';
import { zipEntries, zipRead } from '../src/zip';

/** Wording rules on the server: approval readiness, validation, the admin-only severity rule, the compliant rewrite, the release record. */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-wording-'));
const stubComposer = (): PackageComposer => ({ async pdf() { return { pdf: Buffer.from('%PDF-1.4\n%%EOF\n'), pageCount: 1, facts: null }; }, async html() { return { facts: null }; } });
const LIVE = { provider: 'anthropic', model: 'test-model', apiKey: 'test-key', timeoutMs: 1000 } as const;
const OFF = { provider: 'offline', model: 'test-model', timeoutMs: 1000 } as const;
const fake = (answer: unknown) => { const seen: AssistTask[] = []; const model: AssistModel = async (_cfg, task) => { seen.push(task); return answer; }; return { model, seen }; };
const must = (r: Partial<WordingRule> & Pick<WordingRule, 'id' | 'kind'>): WordingRule => ({ severity: 'must', ...r }) as WordingRule;

describe('wording rules in approval, validation, the AI route and releases (sign-in off)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, releasePackage: { composer: stubComposer() } }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const project = async (id: string): Promise<Project> => (await inj('GET', `/api/v1/projects/${id}`)).json().project;
  const apply = async (id: string, ...cmds: Command[]): Promise<Project> => {
    let p = await project(id);
    const v = p.modelVersion;
    for (const c of cmds) { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); p = r.project; }
    const put = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: v + 1 } }, { 'if-match': `"${v}"` });
    expect(put.statusCode, put.body).toBe(200);
    return put.json().project;
  };
  const EOB = 'harborcare-demo';

  it('a broken “must” rule blocks approval, one entry per rule and text; a “should” only warns; fixing it lets the document be approved', async () => {
    const before = (await inj('GET', `/api/v1/projects/${EOB}/workflow`)).json().readiness;
    expect(before.ready).toBe(true);
    const p = await project(EOB);
    const part = p.contentParts.find((c) => c.id === 'eob-processing')!;
    await apply(EOB,
      { type: 'UPSERT_CONTENT_PART', part: { ...part, approvedLocales: { ...part.approvedLocales, 'en-US': `${part.approvedLocales['en-US']} Your claim is pending adjudication.` } } },
      { type: 'ADD_WORDING_RULE', rule: must({ id: 'plain', kind: 'banned', phrase: 'adjudication', replacement: 'review' }) },
      { type: 'ADD_WORDING_RULE', rule: must({ id: 'claim-word', kind: 'banned', severity: 'should', phrase: 'claim' }) },
    );
    const r = (await inj('GET', `/api/v1/projects/${EOB}/workflow`)).json().readiness;
    expect(r.ready).toBe(false);
    const wording = r.blocking.filter((g: any) => g.code.startsWith('WORDING_'));
    expect(wording).toEqual([expect.objectContaining({ code: 'WORDING_BANNED', severity: 'blocking', nodeId: 'eob-processing', source: 'rules-static', details: { check: 'own:plain@eob-processing', textId: 'eob-processing' } })]);
    expect(wording[0].message).toMatch(/uses “adjudication”, which the wording rules do not allow\. Write “review” instead\./);
    expect((await inj('POST', `/api/v1/projects/${EOB}/workflow`, { action: 'submit' })).statusCode).toBe(200);
    const refused = await inj('POST', `/api/v1/projects/${EOB}/workflow`, { action: 'approve' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('APPROVAL_BLOCKED');

    // Validate & Compare: the rules suite runs the wording rules; the "should" rule is a warning there
    const v = (await inj('POST', '/api/v1/validate', { projectId: EOB, recordId: RECORDS.find((x) => x.documentType === 'eob')!.recordId, suites: ['rules'] })).json();
    const issues = v.issues.filter((i: any) => i.code.startsWith('WORDING_'));
    expect(issues.some((i: any) => i.severity === 'blocking' && i.details.wordingRule === 'plain' && i.details.match === 'adjudication')).toBe(true);
    expect(issues.some((i: any) => i.severity === 'warning' && i.details.wordingRule === 'claim-word')).toBe(true);

    // Fixed: the readiness check clears and the approval makes a release that records the rules in force
    const now = await project(EOB);
    const p2 = now.contentParts.find((c) => c.id === 'eob-processing')!;
    await apply(EOB, { type: 'UPSERT_CONTENT_PART', part: { ...p2, approvedLocales: { ...p2.approvedLocales, 'en-US': p2.approvedLocales['en-US']!.replace('adjudication', 'review') } } });
    expect((await inj('GET', `/api/v1/projects/${EOB}/workflow`)).json().readiness.ready).toBe(true);
    const ok = await inj('POST', `/api/v1/projects/${EOB}/workflow`, { action: 'approve' });
    expect(ok.statusCode, ok.body).toBe(200);
    const id = ok.json().release.release.id;
    const lib = (await inj('GET', `/api/v1/releases/${id}/library`)).json();
    // the EOB sample's own four rules (D106) come first, then the two added here; the sample also follows the house
    // wording rules from the library (six rules, linked at version 1)
    const sampleOwn = [{ id: 'harbor-not-a-bill' }, { id: 'harbor-no-patient' }, { id: 'harbor-no-insurance-company' }, { id: 'harbor-short-sentences' }];
    const house = { itemId: 'house-wording-rules', title: 'House wording rules', version: 1, rules: 6 };
    expect(lib.wordingRules).toMatchObject({ house, own: [...sampleOwn, { id: 'plain' }, { id: 'claim-word' }], mustFindings: 0 });
    expect(lib.wordingRules.shouldFindings).toBeGreaterThan(0);
    const z = await inj('GET', `/api/v1/releases/${id}/package?wait=1`);
    expect(z.statusCode).toBe(200);
    const files = new Map(zipEntries(z.rawPayload).map((e) => [e.name, zipRead(z.rawPayload, e)]));
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.wordingRules).toMatchObject({ house, houseKept: 0, mustFindings: 0, own: [...sampleOwn, { id: 'plain', kind: 'banned', severity: 'must', phrase: 'adjudication', replacement: 'review' }, { id: 'claim-word' }] });
    expect(files.get('README.html')!.toString('utf8')).toMatch(/<h2>Wording rules<\/h2>[\s\S]*no finding against a “must” rule/);
  });

  it('a document without wording rules has no wording entry anywhere', async () => {
    // Both samples have wording rules of their own since D106: a new document from the card starter has none.
    const made = await inj('POST', '/api/v1/projects', { templateId: 'credit-card-statement', title: 'Without wording rules' });
    expect(made.statusCode).toBe(201);
    expect(made.json().project.wordingRules).toBeUndefined();
    const r = (await inj('GET', `/api/v1/projects/${made.json().project.projectId}/workflow`)).json().readiness;
    expect(r.blocking.some((g: any) => g.code.startsWith('WORDING_'))).toBe(false);
  });

  it('“Suggest compliant wording”: only the text and the rules go to the model; the answer is checked with the same checker', async () => {
    const p = applyCommand(await project('aster-card-demo'), { type: 'ADD_WORDING_RULE', rule: must({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent', replacement: 'past due' }) });
    if (!p.ok) throw new Error(p.message);
    const text = 'Your account is delinquent, {{customer.givenName}}.';
    // a compliant answer is returned, labelled AI
    const good = fake({ options: ['Your account is past due, {{customer.givenName}}.'] });
    const ok = await compliantRewrite(LIVE as any, good.model, p.project, { text, scope: 'messages', locale: 'en-US' });
    expect(ok.mode).toBe('ai');
    expect(ok.options.map((o) => o.text)).toEqual(['Your account is past due, {{customer.givenName}}.']);
    // the house wording rules the card sample follows from the library, then its own rules (D106), are in force too,
    // before the one added here
    const houseRules = '- The text must not use “click here” (write “select” instead).\n- The text must not use “guaranteed”.\n- The document must include “(fictional)”; keep it if the text has it.\n- Write “use”, not “utilize” (should).\n- Write “to”, not “in order to” (should).\n- No sentence should have more than 40 words.\n';
    const sampleRules = houseRules + '- The document must include “not a legal statement”; keep it if the text has it.\n- The text should not use “kindly” (write “please” instead).\n- No sentence should have more than 25 words.\n- The text should not use “relationship specialist” (write “relationship team” instead).\n';
    expect(good.seen[0].user).toBe(`House wording rules:\n${sampleRules}- The text must not use “delinquent” (write “past due” instead).\nKind of text: message.\nText:\n${text}`);
    for (const r of RECORDS.slice(0, 20)) expect(good.seen[0].user + good.seen[0].system).not.toContain((r as any).customer?.familyName ?? '§');
    // an answer that still breaks a "must" rule is refused, saying why
    const bad = await compliantRewrite(LIVE as any, fake({ options: ['Your DELINQUENT account, {{customer.givenName}}.'] }).model, p.project, { text, scope: 'messages', locale: 'en-US' });
    expect(bad.mode).toBe('unavailable');
    expect(bad.options).toEqual([]);
    expect(bad.message).toMatch(/still broke a “must” rule \(Banned: “delinquent”\)/);
    // a changed data field is refused too
    expect((await compliantRewrite(LIVE as any, fake({ options: ['Your account is past due.'] }).model, p.project, { text, scope: 'messages', locale: 'en-US' })).mode).toBe('unavailable');
    // no key: the normal "needs an AI key" state, and the model is never asked
    const none = fake({ options: ['x'] });
    const off = await compliantRewrite(OFF as any, none.model, p.project, { text, scope: 'messages', locale: 'en-US' });
    expect(off.mode).toBe('unavailable');
    expect(off.message).toMatch(/AI key/);
    expect(none.seen).toEqual([]);
    // through the route (no key in tests), with the unsaved document
    const route = await inj('POST', '/api/v1/projects/aster-card-demo/assist/rewrite', { text, style: 'compliant', scope: 'messages', project: p.project });
    expect(route.statusCode).toBe(200);
    expect(route.json().mode).toBe('unavailable');
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/assist/rewrite', { text, style: 'compliant', scope: 'poster', project: p.project })).statusCode).toBe(400);
    // a document with no rule for this text: nothing to meet (the card as the fixtures build it; the stored sample has rules since D106)
    expect((await compliantRewrite(LIVE as any, good.model, seedProjects()[0], { text, scope: 'messages', locale: 'en-US' })).message).toMatch(/No wording rule applies/);
  });

  it('a project file with invalid own rules is refused', async () => {
    const p = await project('aster-card-demo');
    const put = await inj('PUT', '/api/v1/projects/aster-card-demo', { project: { ...p, modelVersion: p.modelVersion + 1, wordingRules: [{ id: 'x', kind: 'banned', severity: 'often', phrase: 'p' }] } }, { 'if-match': `"${p.modelVersion}"` });
    expect(put.statusCode).toBe(422);
    expect(put.json().error.message).toMatch(/own wording rules are not valid/);
  });
});

describe('only an admin decides whether a house rule is a “must” or a “should” (sign-in on)', () => {
  let ctx: Ctx;
  const saved = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, { cookie: string }> = {};
  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: true, releasePackage: { composer: stubComposer() } });
    const login = async (email: string, password: string) => {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      return { cookie: String([r.headers['set-cookie']].flat()[0]).split(';')[0] };
    };
    cookies.admin = await login('admin@example.test', 'correct horse battery');
    for (const role of ['author', 'approver']) {
      await ctx.app.inject({ method: 'POST', url: '/api/v1/users', payload: { email: `${role}@example.test`, name: `${role} person`, role, password: 'a long enough password' }, headers: cookies.admin });
      cookies[role] = await login(`${role}@example.test`, 'a long enough password');
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const inj = (method: any, url: string, payload: any, role: string) => ctx.app.inject({ method, url, payload, headers: cookies[role] });
  const rules = (...r: WordingRule[]) => ({ rules: r });

  it('authors propose rules as “should”; an admin raises one to “must”; an approver approves but cannot change a severity', async () => {
    expect((await inj('GET', '/api/v1/library', undefined, 'author')).json().can.setSeverity).toBe(false);
    expect((await inj('GET', '/api/v1/library', undefined, 'admin')).json().can.setSeverity).toBe(true);
    const asMust = await inj('POST', '/api/v1/library', { kind: 'wording-rules', title: 'House rules', content: rules(must({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent' })) }, 'author');
    expect(asMust.statusCode).toBe(403);
    expect(asMust.json().error).toMatchObject({ code: 'SEVERITY_ADMIN_ONLY', message: 'Only an admin can make a rule a “must” (“delinquent”). Save it as a “should”; an admin can raise it.' });
    const created = await inj('POST', '/api/v1/library', { kind: 'wording-rules', title: 'House rules', content: rules(must({ id: 'no-delinquent', kind: 'banned', severity: 'should', phrase: 'delinquent' })) }, 'author');
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id;
    // the admin raises it in the draft
    expect((await inj('PUT', `/api/v1/library/${id}/draft`, { content: rules(must({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent' })) }, 'admin')).statusCode).toBe(200);
    // the author cannot lower it again, but can add a "should" rule beside it
    const lower = await inj('PUT', `/api/v1/library/${id}/draft`, { content: rules(must({ id: 'no-delinquent', kind: 'banned', severity: 'should', phrase: 'delinquent' })) }, 'author');
    expect(lower.statusCode).toBe(403);
    expect(lower.json().error.message).toMatch(/Only an admin can change whether a rule is a “must” or a “should” \(“delinquent” was a “must”\)/);
    expect((await inj('PUT', `/api/v1/library/${id}/draft`, { content: rules(must({ id: 'no-delinquent', kind: 'banned', phrase: 'delinquent' }), must({ id: 'kindly', kind: 'banned', severity: 'should', phrase: 'kindly' })) }, 'author')).statusCode).toBe(200);
    // the approver approves the version as it is …
    expect((await inj('POST', `/api/v1/library/${id}/approve`, {}, 'approver')).statusCode).toBe(200);
    // … but cannot draft a change of severity (or any change: approvers do not edit)
    const approverEdit = await inj('PUT', `/api/v1/library/${id}/draft`, { content: rules(must({ id: 'no-delinquent', kind: 'banned', severity: 'should', phrase: 'delinquent' })) }, 'approver');
    expect(approverEdit.statusCode).toBe(403);
    // a new version from the author keeps the approved severities
    expect((await inj('PUT', `/api/v1/library/${id}/draft`, { content: rules(must({ id: 'no-delinquent', kind: 'banned', severity: 'should', phrase: 'delinquent' })) }, 'author')).statusCode).toBe(403);
    expect((await inj('GET', `/api/v1/library/${id}/versions/1`, undefined, 'author')).json().content.rules.map((r: WordingRule) => r.severity)).toEqual(['must', 'should']);
  });
});
