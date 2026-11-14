import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectFileProblems, validateRule, type Project } from '@iss/model';
import { buildApp } from '../src/app';
import type { AssistModel, AssistTask } from '../src/assistAi';
import { draftSetupSpec } from '../src/setupAi';
import { gymSetup } from '../../../packages/model/test/helpers/setupSpec';
import { SAMPLE_WORDING, visibleText } from '../../../packages/model/test/helpers/customProject';

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-setup-'));

/**
 * A stand-in for the model: returns whatever `answer` holds (or throws it) and records what it was asked.
 * It replaces the real call for the whole app, so nothing in this file can reach a live model.
 */
let answer: unknown = null;
const seen: AssistTask[] = [];
const model: AssistModel = async (_cfg, task) => { seen.push(task); if (answer instanceof Error) throw answer; return answer; };
/** The environment says "a live model is configured" (with a key that is not one), so the routes take the model path. */
const saved: Record<string, string | undefined> = {};
const LIVE_ENV = { AI_PROVIDER: 'anthropic', AI_API_KEY: 'not-a-real-key', AUTH: undefined, ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined } as const;
const setEnv = (env: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(env)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const restoreEnv = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

/** The gym setup in the form a model returns it: every property present, empty where it does not apply. */
function asModelOutput(spec = gymSetup()): Record<string, unknown> {
  const empty = { text: '', fields: [], list: '', columns: [], totalColumn: '', name: '', versions: [], label: '', url: '' };
  return {
    title: spec.title, issuerName: spec.issuerName, accent: spec.accent ?? '', summary: spec.summary,
    fields: spec.fields.map((f) => ({ label: f.label, type: f.type, choices: f.choices ?? [], columns: f.columns ?? [], example: f.example ?? '', required: !!f.required })),
    sections: spec.sections.map((s) => (s.type === 'messages'
      ? { ...empty, type: s.type, name: s.name, versions: s.versions.map((v) => ({ title: v.title, text: v.text, fallback: !!v.fallback, when: v.when ? { ...v.when, value: String(v.when.value) } : { field: '', test: 'is', value: '' } })) }
      : { ...empty, ...s })),
    email: spec.email ?? { subject: '', intro: '' }, sms: spec.sms ?? '',
  };
}

const DESCRIPTION = 'A membership renewal notice for our gym. It shows the plan, the monthly fee and the renewal date, lists the fees charged, and tells members whose payment failed to update their payment details.';
const MEMBERS_CSV = [
  'First Name,Last Name,Language,Plan name,Monthly fee,Renewal date,Payment status,Renews automatically,Visits this month,Locker',
  'Ana,Silva,es-US,Flex,49.00,2026-12-01,paid,yes,9,A12',
  'Ben,Okoro,en-US,Max,120,2026-12-15,failed,no,2,B07',
  'Cy,Lee,en-US,Flex,forty,15/12/2026,unknown,yes,3,C01',
].join('\n');
const MEMBERS_JSON = [
  { firstName: 'Dana', lastName: 'Novak', planName: 'Flex', monthlyFee: 49, renewalDate: '2026-12-01', paymentStatus: 'paid', renewsAutomatically: true, visitsThisMonth: 14, fees: [{ description: 'Membership', chargedOn: '2026-11-01', amount: 49, quantity: 1 }, { description: 'Towels', chargedOn: '2026-11-03', amount: 5.5, quantity: 2 }] },
  { firstName: 'Eli', lastName: 'Marsh', planName: 'Max', monthlyFee: 120, renewalDate: '2026-12-15', paymentStatus: 'failed', renewsAutomatically: false, visitsThisMonth: 1, fees: [] },
];

describe('setting a new document up from a description or sample data', () => {
  let ctx: Ctx;
  beforeAll(async () => { setEnv(LIVE_ENV); ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, assistModel: model }); });
  afterAll(async () => { await ctx.app.close(); restoreEnv(); });
  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });
  const json = async (method: any, url: string, payload?: any) => (await inj(method, url, payload)).json();
  const draft = (payload: any) => inj('POST', '/api/v1/projects/setup/draft', payload);
  const create = (payload: any) => inj('POST', '/api/v1/projects/setup', payload);
  const projectIds = async () => ((await json('GET', '/api/v1/projects')).projects as any[]).map((p) => p.projectId).sort();
  const customers = async (id: string) => (await json('GET', `/api/v1/records?documentType=custom&full=1&projectId=${id}`)).records as any[];
  const audits = async (action: string) => (await json('GET', `/api/v1/audit?action=${action}`)).events as any[];

  it('a description with a live model gives an AI proposal: the checked setup, the project it would become, what it creates and what it does, and nothing is stored', async () => {
    const before = await projectIds();
    const auditBefore = (await json('GET', '/api/v1/audit')).events.length;
    answer = asModelOutput();
    seen.length = 0;
    const r = await draft({ description: DESCRIPTION });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ mode: 'proposal', source: 'ai', providerStatus: 'Live AI (server-side adapter)', wouldCreate: { projectId: 'membership-renewal', title: 'Membership renewal' }, notes: [] });
    expect(body.message).toMatch(/Drafted by an AI model.*checked by the studio/);
    expect(body.spec).toEqual(gymSetup());
    // the project is the one the builder makes from that setup: its own data, unsaved
    expect(body.project).toMatchObject({ projectId: 'membership-renewal', documentType: 'custom', modelVersion: 1, title: 'Membership renewal', issuer: { name: 'Northside Gym', accent: '#1f4e79' } });
    expect(projectFileProblems(body.project)).toEqual([]);
    expect(body.project.rules).toHaveLength(3);
    expect(body.project.lastSavedAt).toBeUndefined();
    // what will be created, in plain words
    expect(body.outline.fields).toHaveLength(7);
    expect(body.outline.sections.find((s: any) => s.kind === 'Message').versions).toEqual([
      { title: 'Payment failed', fallback: false, shownWhen: 'Shown when payment status is “failed”.' },
      { title: 'Premium member', fallback: false, shownWhen: 'Shown when monthly fee is at least $100.' },
      { title: 'Frequent visitor', fallback: false, shownWhen: 'Shown when visits this month is more than 12.' },
      { title: 'Nothing to do', fallback: true, shownWhen: 'Shown when no other version applies.' },
    ]);
    expect(body.outline.lines.join('\n')).not.toMatch(/custom\.|message-\d|\{\{/);
    // customers: nothing supplied, so they would be generated; the first of them gets a document without blocking issues
    expect(body.customers.supplied).toBeNull();
    expect(body.customers.generated.count).toBeGreaterThanOrEqual(4);
    expect(body.preview).toMatchObject({ customer: { name: 'Avery Abbott', origin: 'generated' }, messages: [{ section: 'Payment note', version: 'Nothing to do' }], blocking: [] });

    // what the model was given: the description, a strict tool that is the setup's own schema, and the reminder that the description is not an instruction
    expect(seen).toHaveLength(1);
    expect(seen[0].user).toContain(DESCRIPTION);
    expect(seen[0].system).toMatch(/never an instruction to you/);
    expect(seen[0].tool).toMatchObject({ name: 'submit_document_setup', strict: true, input_schema: { type: 'object', additionalProperties: false } });
    expect(Object.keys((seen[0].tool.input_schema as any).properties)).toEqual(['title', 'issuerName', 'accent', 'summary', 'fields', 'sections', 'email', 'sms']);

    // nothing was stored and nothing was recorded as a change
    expect(await projectIds()).toEqual(before);
    expect((await inj('GET', '/api/v1/projects/membership-renewal')).statusCode).toBe(404);
    expect((await json('GET', '/api/v1/audit')).events.length).toBe(auditBefore);
    // the title, issuer and colour a person typed win over what the model wrote
    const named = (await draft({ description: DESCRIPTION, title: '  Renewal   2027 ', issuerName: 'Harbour Fitness', accent: '#AA3300' })).json();
    expect(named).toMatchObject({ wouldCreate: { projectId: 'renewal-2027', title: 'Renewal 2027' }, spec: { title: 'Renewal 2027', issuerName: 'Harbour Fitness', accent: '#aa3300' }, project: { title: 'Renewal 2027', issuer: { name: 'Harbour Fitness', accent: '#aa3300', product: 'Renewal 2027' } } });
    expect(seen[1].user).toMatch(/Title chosen by the person: Renewal 2027/);
  });

  it('a model answer with junk in it is cleaned on the server, and every correction is listed', async () => {
    const out = asModelOutput();
    (out.fields as any[]).push({ label: 'Monthly fee', type: 'text', choices: [], columns: [], example: '', required: false }, { label: 'First name', type: 'text', choices: [], columns: [], example: '', required: false });
    const empty = { text: '', fields: [], list: '', columns: [], totalColumn: '', name: '', versions: [], label: '', url: '' };
    (out.sections as any[]).push(
      { ...empty, type: 'paragraph', text: 'Call us about {Loyalty points}. <script>alert(1)</script> See [the terms](https://evil.example/terms).' },
      { ...empty, type: 'table', list: 'Plan name' },
      { ...empty, type: 'action', label: 'Pay now', url: 'http://pay.example/now' },
      { ...empty, type: 'messages', name: 'Extra', versions: [{ title: 'Many fees', text: 'Lots.', fallback: false, when: { field: 'Fees', test: 'moreThan', value: '3' } }, { title: 'Else', text: 'Fine.', fallback: true, when: { field: '', test: 'is', value: '' } }, { title: 'Also else', text: 'Also.', fallback: true, when: { field: '', test: 'is', value: '' } }] },
      { ...empty, type: 'hologram' },
    );
    (out as any).documentType = 'credit-statement';
    answer = out;
    const body = (await draft({ description: DESCRIPTION })).json();
    expect(body).toMatchObject({ mode: 'proposal', source: 'ai' });
    expect(body.spec.fields).toHaveLength(7);
    expect(body.spec.sections.slice(8)).toEqual([
      { type: 'paragraph', text: 'Call us about Loyalty points. alert(1) See the terms.' },
      { type: 'messages', name: 'Extra', versions: [{ title: 'Else', text: 'Fine.', fallback: true }] },
    ]);
    const all = body.notes.join('\n');
    for (const expected of [
      /Two data fields are called “Monthly fee”/, /“First name” was left out as a data field/, /mentions “\{Loyalty points\}”, which is not one of the data fields/, /markup and the characters < and > are not allowed/, /a link inside the text was turned into plain words/,
      /A table for “Plan name” was left out: it is not a list/, /The button “Pay now” was left out: its link must be a web address that starts with https:\/\//, /“Many fees” of “Extra” was left out: its condition tests “Fees”, which is a list/,
      /More than one version of “Extra” was marked/, /unknown kind “hologram”/, /Ignored “documentType”/,
    ]) expect(all).toMatch(expected);
    expect(body.project.documentType).toBe('custom');
    expect(JSON.stringify(body.project)).not.toMatch(/evil|pay\.example|<script/);
    expect(projectFileProblems(body.project)).toEqual([]);
    expect(body.preview.blocking).toEqual([]);
  });

  it('when the model fails or returns nothing usable, the answer is a clear "unavailable", never an error', async () => {
    for (const bad of [null, new Error('socket hang up'), 'I cannot help with that', 42, [], {}, { title: 'Empty', fields: [], sections: [] }, { title: 'Only fields', fields: [{ label: 'Fee', type: 'amount' }], sections: [{ type: 'unknown' }] }]) {
      answer = bad;
      const r = await draft({ description: DESCRIPTION });
      expect(r.statusCode, String(bad)).toBe(200);
      expect(r.json(), String(bad)).toMatchObject({ mode: 'unavailable', providerStatus: 'Live AI did not answer' });
      expect(r.json().message).toMatch(/did not return a usable setup/);
      expect(r.json().spec).toBeUndefined();
    }
    // with sample data at hand the studio still proposes something, and says the description was not used
    answer = null;
    const body = (await draft({ description: DESCRIPTION, sampleData: { format: 'csv', data: MEMBERS_CSV } })).json();
    expect(body).toMatchObject({ mode: 'proposal', source: 'builtin' });
    expect(body.notes[0]).toBe('The AI model did not return a usable setup, so your description was not used: this setup comes from the data alone.');
  });

  it('without a model: sample data gives a built-in proposal; a description alone says it needs an AI key or a data file', async () => {
    seen.length = 0;
    const alone = await draft({ description: DESCRIPTION, forceOffline: true });
    expect(alone.statusCode).toBe(200);
    expect(alone.json()).toEqual({ mode: 'unavailable', providerStatus: 'Guided Assistant (offline)', message: expect.stringMatching(/needs a live AI model, and no AI key is configured.*or supply a data file/), notes: [] });

    // data only: no model is asked even though one is configured
    const body = (await draft({ sampleData: { format: 'csv', data: MEMBERS_CSV }, title: 'Member notice' })).json();
    expect(seen).toHaveLength(0);
    expect(body).toMatchObject({ mode: 'proposal', source: 'builtin', wouldCreate: { projectId: 'member-notice', title: 'Member notice' } });
    expect(body.message).toMatch(/Set up by the studio from your sample data, without an AI model/);
    expect(body.spec.fields.map((f: any) => `${f.label}:${f.type}`)).toEqual(['Plan name:choice', 'Monthly fee:text', 'Renewal date:text', 'Payment status:text', 'Renews automatically:yesNo', 'Visits this month:number', 'Locker:text']);
    expect(body.spec.sections.map((s: any) => s.type)).toEqual(['heading', 'paragraph', 'keyFigures']);
    expect(body.project.rules).toEqual([]);
    expect(body.notes.join('\n')).toMatch(/“First Name”, “Last Name” are used as the customer’s name/);
    expect(body.notes.join('\n')).toMatch(/No messages or rules were set up/);
    // the rows as customers: all three fit the fields the studio guessed from them, and each column's use is listed
    expect(body.customers.supplied).toMatchObject({ total: 3, accepted: 3, rejectedCount: 0, rejected: [] });
    expect(body.customers.supplied.matching.map((m: any) => m.field)).toEqual(['First name', 'Last name', 'Language', 'Plan name', 'Monthly fee', 'Renewal date', 'Payment status', 'Renews automatically', 'Visits this month', 'Locker']);
    expect(body.preview).toMatchObject({ customer: { name: 'Ana Silva', origin: 'supplied' }, blocking: [] });

    // a description that cannot be used (no key) is said so, and the data alone is used
    const both = (await draft({ description: DESCRIPTION, sampleData: { format: 'json', data: MEMBERS_JSON }, forceOffline: true })).json();
    expect(both).toMatchObject({ mode: 'proposal', source: 'builtin' });
    expect(both.notes[0]).toBe('No AI key is configured, so your description was not used: this setup comes from the data alone.');
    expect(both.spec.fields.find((f: any) => f.label === 'Fees')).toMatchObject({ type: 'list', columns: [{ label: 'Description', type: 'text' }, { label: 'Charged on', type: 'date' }, { label: 'Amount', type: 'amount' }, { label: 'Quantity', type: 'number' }] });
    expect(both.spec.sections.at(-1)).toMatchObject({ type: 'table', list: 'Fees', totalColumn: 'Amount' });
    expect(both.customers.supplied).toMatchObject({ total: 2, accepted: 2, rejectedCount: 0 });
    expect(seen).toHaveLength(0);
  });

  it('with a description and data, the model is told the shape of the data only, and the rows are matched to the fields it chose', async () => {
    answer = asModelOutput();
    seen.length = 0;
    const r = await draft({ description: DESCRIPTION, sampleData: { format: 'csv', data: MEMBERS_CSV } });
    const body = r.json();
    expect(body).toMatchObject({ mode: 'proposal', source: 'ai' });
    expect(seen).toHaveLength(1);
    const sent = `${seen[0].system}\n${seen[0].user}`;
    // field names, guessed types and the values of choices
    expect(sent).toContain('{"label":"Plan name","type":"choice","choices":["Flex","Max"]}');
    expect(sent).toContain('{"label":"Monthly fee","type":"text"}');
    expect(sent).toMatch(/You are given its shape only/);
    expect(sent).toMatch(/The data has the customer’s name\. It has the customer’s language\./);
    // never a row: no names, no values that are not the values of a choice
    expect(sent).not.toMatch(/Ana|Silva|Okoro|Cy,|A12|B07|C01|2026-12|49\.00|forty/);

    // the rows against the fields of the model's setup: two fit, the third is rejected with reasons a person can act on
    const s = body.customers.supplied;
    expect(s).toMatchObject({ total: 3, accepted: 2, rejectedCount: 1 });
    expect(s.rejected).toEqual([{ row: 3, reasons: ['Monthly fee: expected a whole number of cents, got "forty".', 'Renewal date: expected a date YYYY-MM-DD, got "15/12/2026".', 'Payment status: “unknown” is not one of paid, failed, pending.'] }]);
    expect(Object.fromEntries(s.matching.map((m: any) => [m.column, m.field]))).toMatchObject({ 'First Name': 'First name', Language: 'Language', 'Monthly fee': 'Monthly fee', 'Payment status': 'Payment status', Locker: null });
    expect(s.matching.find((m: any) => m.column === 'Locker').reason).toBe('No data field has this name, so the column is not used.');
    expect(s.notes).toEqual(['“Monthly fee” is read as dollars for “Monthly fee” (49 or 49.00 is $49.00).']);
    // the first supplied customer is the one previewed
    expect(body.preview).toMatchObject({ customer: { name: 'Ana Silva', origin: 'supplied' }, messages: [{ section: 'Payment note', version: 'Nothing to do' }], blocking: [] });
  });

  it('refuses a request it cannot read, with a reason', async () => {
    const code = async (payload: any) => { const r = await draft(payload); return `${r.statusCode} ${r.json().error?.code}`; };
    expect(await code({})).toBe('400 NOTHING_TO_SET_UP');
    expect(await code({ description: '   ' })).toBe('400 NOTHING_TO_SET_UP');
    expect(await code({ description: 'x'.repeat(2001) })).toBe('400 TOO_LONG');
    expect(await code({ description: 7 })).toBe('400 INVALID');
    expect(await code({ sampleData: 'a,b\n1,2' })).toBe('400 INVALID_SAMPLE_DATA');
    expect(await code({ sampleData: { format: 'csv', data: 'only,a,heading' } })).toBe('400 INVALID_SAMPLE_DATA');
    expect(await code({ sampleData: { format: 'json', data: '{oops' } })).toBe('400 INVALID_SAMPLE_DATA');
    expect(await code({ sampleData: { format: 'json', data: Array.from({ length: 501 }, (_, i) => ({ fee: i })) } })).toBe('413 IMPORT_TOO_LARGE');
    expect(await code({ description: DESCRIPTION, title: 'x' })).toBe('400 INVALID_TITLE');
    expect(await code({ description: DESCRIPTION, issuerName: 'N'.repeat(61) })).toBe('400 INVALID_ISSUER_NAME');
    expect(await code({ description: DESCRIPTION, accent: 'red' })).toBe('400 INVALID_ACCENT');
  });

  let createdId = '';
  it('creates the document from an approved setup with generated customers, and records that the setup was an AI suggestion', async () => {
    seen.length = 0;
    const r = await create({ spec: gymSetup(), title: 'Membership renewal', customers: 'generate', source: 'ai' });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    createdId = body.project.projectId;
    expect(createdId).toBe('membership-renewal');
    expect(body).toMatchObject({ source: 'ai', notes: [], project: { documentType: 'custom', modelVersion: 1, title: 'Membership renewal', issuer: { name: 'Northside Gym', accent: '#1f4e79' } }, customers: { supplied: null, startingCustomerOnly: false }, preview: { blocking: [] } });
    // creating never asks a model: the setup is built by the studio
    expect(seen).toHaveLength(0);
    expect(body.customers.generated).toBeGreaterThanOrEqual(4);
    expect(body.customers.total).toBe(body.customers.generated);
    const stored: Project = (await json('GET', `/api/v1/projects/${createdId}`)).project;
    expect(stored.nodes.map((n) => n.id)).toEqual(body.project.nodes.map((n: any) => n.id));
    for (const rule of stored.rules) expect(validateRule(rule, stored)).toEqual([]);
    expect((await json('GET', '/api/v1/projects')).projects.find((p: any) => p.projectId === createdId)).toMatchObject({ documentType: 'custom', sample: false, ruleCount: 3 });
    // a new draft, with the creation in the history and in the audit trail
    expect((await json('GET', `/api/v1/projects/${createdId}/workflow?checks=0`)).state).toBe('draft');
    expect((await json('GET', `/api/v1/projects/${createdId}/versions`)).versions[0]).toMatchObject({ modelVersion: 1, label: 'Set up from a description (AI suggestion, approved by a person)' });
    const [entry] = await audits('project.create');
    expect(entry).toMatchObject({ projectId: createdId, detail: { title: 'Membership renewal', setup: 'ai', customers: body.customers.total, generated: body.customers.generated, supplied: 0, rejected: 0 } });
    // no wording in the audit trail
    expect(JSON.stringify(entry.detail)).not.toMatch(/did not go through|Fees are charged/);

    // every generated customer resolves without a blocking issue, and every message version is reached by one of them
    const mine = await customers(createdId);
    expect(mine).toHaveLength(body.customers.total);
    const chosen = new Set<string>();
    for (const c of mine) {
      const res = await json('POST', '/api/v1/resolve', { projectId: createdId, recordId: c.recordId });
      expect(res.findings.filter((f: any) => f.severity === 'blocking'), c.generated?.label).toEqual([]);
      chosen.add(res.result.selectedVariants['message-5']);
    }
    expect([...chosen].sort()).toEqual(['message-5-v1', 'message-5-v2', 'message-5-v3', 'message-5-v4']);
    expect((await json('GET', `/api/v1/projects/${createdId}/workflow`)).readiness).toMatchObject({ ready: true, blocking: [] });
    // the same title again is a second document, never a replacement
    const again = (await create({ spec: gymSetup(), title: 'Membership renewal', customers: 'generate' })).json();
    expect(again.project.projectId).toBe('membership-renewal-2');
    expect(again.source).toBe('builtin');
  });

  it('the created document composes as pages, PDF, web page, email and SMS with the customer’s own values', async () => {
    const mine = await customers(createdId);
    const failed = mine.find((c) => c.custom.paymentStatus === 'failed')!;
    const run = { projectId: createdId, recordId: failed.recordId };
    const pages = await inj('POST', '/api/v1/compose/pages', run);
    expect(pages.statusCode).toBe(200);
    expect(pages.json().pageCount).toBeGreaterThanOrEqual(1);
    expect(pages.json().diagnostics.filter((d: any) => d.severity === 'blocking' || d.severity === 'error')).toEqual([]);
    const pdf = await inj('POST', '/api/v1/compose/pdf', run);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const html = await inj('POST', '/api/v1/compose/html', run);
    expect(html.statusCode).toBe(200);
    const text = visibleText(html.payload);
    for (const s of [`Hello ${failed.customer.givenName} ${failed.customer.familyName},`, 'membership renews soon', 'Monthly fee', 'did not go through', 'Fees are charged monthly in advance', 'Manage your membership', 'Description']) expect(text).toContain(s);
    expect(text.match(SAMPLE_WORDING)?.[0]).toBeUndefined();
    expect(text).not.toMatch(/\{\{|\{First name\}|custom\./);
    const email = await inj('POST', '/api/v1/compose/email', run);
    expect(email.statusCode).toBe(200);
    expect(email.json().subject).toMatch(/^Your .+ membership renews on \w{3} \d{1,2}, \d{4}$/);
    expect(email.json().text).toContain(`Hello ${failed.customer.givenName}, here is what your renewal looks like.`);
    expect(email.json().text).toContain('Payment failed');
    expect(email.json().parity.ok).toBe(true);
    const sms = await inj('POST', '/api/v1/compose/sms', run);
    expect(sms.statusCode).toBe(200);
    expect(sms.json().text).toMatch(/^DEMO Northside Gym: Your .+ membership renews on .+\. Details: https:\/\/example\.com\/membership$/);
    const parity = await json('POST', '/api/v1/parity', run);
    expect(parity.report.checks.filter((c: any) => c.status === 'mismatch')).toEqual([]);
  });

  it('creates with supplied customers: rows that fit are stored as the document’s own, rows that do not are reported and never dropped silently', async () => {
    const r = await create({ spec: gymSetup(), title: 'Renewal with our members', customers: 'supplied', sampleData: { format: 'csv', data: MEMBERS_CSV } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    const id = body.project.projectId;
    expect(body.customers).toMatchObject({ total: 2, generated: 0, startingCustomerOnly: false, supplied: { total: 3, accepted: 2, rejectedCount: 1 } });
    expect(body.customers.supplied.rejected[0]).toMatchObject({ row: 3, reasons: expect.arrayContaining(['Monthly fee: expected a whole number of cents, got "forty".']) });
    const mine = await customers(id);
    expect(mine.map((c) => `${c.customer.givenName} ${c.customer.familyName} ${c.customer.locale} ${c.custom.monthlyFeeCents} ${c.custom.paymentStatus}`)).toEqual(['Ana Silva es-US 4900 paid', 'Ben Okoro en-US 12000 failed']);
    expect(mine.every((c) => /^REC-6\d{4}$/.test(c.recordId) && c.projectId === id && c.imported === true && !c.generated)).toBe(true);
    // supplied customers belong to this document alone
    expect((await customers(createdId)).some((c) => c.customer.givenName === 'Ana')).toBe(false);
    // the preview is the first supplied customer; Ben's payment failed, so he gets that version
    expect(body.preview).toMatchObject({ customer: { name: 'Ana Silva', origin: 'supplied' }, blocking: [] });
    const ben = await json('POST', '/api/v1/resolve', { projectId: id, recordId: mine[1].recordId });
    expect(ben.result.selectedVariants['message-5']).toBe('message-5-v1');
    expect(ben.findings.filter((f: any) => f.severity === 'blocking')).toEqual([]);
    expect((await audits('project.create'))[0]).toMatchObject({ projectId: id, detail: { setup: 'builtin', customers: 2, supplied: 2, rejected: 1, generated: 0 } });

    // no row fits: the document is still created, with one starting customer, and the answer says so
    const none = (await create({ spec: gymSetup(), title: 'Renewal nobody fits', customers: 'supplied', sampleData: { format: 'csv', data: 'Monthly fee\nabc\n' } })).json();
    expect(none.customers).toMatchObject({ total: 1, generated: 1, startingCustomerOnly: true, supplied: { total: 1, accepted: 0, rejectedCount: 1 } });
    expect(none.notes.at(-1)).toBe('None of the supplied rows could be used, so one starting customer was created to preview the document with.');
    expect(await customers(none.project.projectId)).toHaveLength(1);
    expect(none.preview.blocking).toEqual([]);
  });

  it('creates with both: the supplied customers plus generated ones that cover what the supplied ones do not', async () => {
    const r = await create({ spec: gymSetup(), title: 'Renewal with both', customers: 'both', sampleData: { format: 'json', data: JSON.stringify(MEMBERS_JSON) } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.customers.supplied).toMatchObject({ total: 2, accepted: 2, rejectedCount: 0 });
    expect(body.customers.generated).toBeGreaterThanOrEqual(1);
    expect(body.customers.total).toBe(2 + body.customers.generated);
    const mine = await customers(body.project.projectId);
    expect(mine).toHaveLength(body.customers.total);
    const dana = mine.find((c) => c.customer.givenName === 'Dana');
    // amounts written in dollars became whole cents, in the list too
    expect(dana.custom).toMatchObject({ monthlyFeeCents: 4900, renewsAutomatically: true, fees: [{ description: 'Membership', chargedOn: '2026-11-01', amountCents: 4900, quantity: 1 }, { description: 'Towels', chargedOn: '2026-11-03', amountCents: 550, quantity: 2 }] });
    expect(mine.filter((c) => c.generated).length).toBe(body.customers.generated);
    for (const c of mine) expect((await json('POST', '/api/v1/resolve', { projectId: body.project.projectId, recordId: c.recordId })).findings.filter((f: any) => f.severity === 'blocking'), c.customer.givenName).toEqual([]);
    const page = (await inj('POST', '/api/v1/compose/html', { projectId: body.project.projectId, recordId: dana.recordId })).payload;
    // Dana visited 14 times: she gets the "Frequent visitor" version
    for (const s of ['Hello Dana Novak,', 'Towels', '$5.50', '$54.50', 'You came in 14 times this month']) expect(visibleText(page)).toContain(s);
  });

  it('a tampered setup cannot bring in another kind of document, a project of its own, images, links or rules the studio would not make', async () => {
    const spec: any = {
      ...gymSetup(),
      documentType: 'credit-statement', projectId: 'aster-card-demo', schemaVersion: '9.9.9',
      nodes: [{ id: 'evil', type: 'image', image: { src: 'https://evil.example/track.png', alt: '' } }],
      rules: [{ id: 'R99', scope: 'custom', mode: 'obligation', priority: 1, when: { op: 'eq', path: 'documentType', value: 'custom' }, then: { op: 'requireNodes', nodeIds: ['evil'] }, version: 1 }],
      brand: { primary: '#000000', accent: '#000000', logoDataUri: 'https://evil.example/logo.png' },
    };
    spec.sections = [
      ...spec.sections,
      { type: 'image', src: 'https://evil.example/banner.png' },
      { type: 'paragraph', text: '![x](https://evil.example/pixel.gif) <img src="https://evil.example/a.png"> [Win a prize](https://evil.example/prize) {{card.creditLimitCents}} {{customer.accessibility.largeText}}', image: { src: 'https://evil.example/b.png' }, visibleWhen: { op: 'eq', path: 'card.tier', value: 'premium' } },
      { type: 'action', label: 'Claim', url: 'https://evil.example/claim?next=javascript:alert(1)' },
      { type: 'action', label: 'Call', url: 'javascript:alert(document.cookie)' },
      { type: 'action', label: 'Plain http', url: 'http://evil.example/plain' },
      { type: 'messages', name: 'Injected', versions: [
        { title: 'Code', text: 'x', when: { field: 'Monthly fee', test: 'is', value: '1); DROP TABLE projects;--' } },
        { title: 'Path', text: 'y', when: { field: 'customer.locale', test: 'is', value: 'en-US' }, rule: { op: 'requireNodes' } },
        { title: 'Op', text: 'z', when: { field: 'Visits this month', test: '__proto__', value: 1 } },
        { title: 'Else', text: 'Standard.', fallback: true },
      ] },
    ];
    const r = await create({ spec, title: 'Tampered notice', customers: 'generate', project: { projectId: 'tampered-notice', documentType: 'eob', nodes: [{ id: 'doc-root', type: 'container', children: [] }], rules: [], contentParts: [], presentationProfiles: [] }, documentType: 'eob' });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    const p: Project = body.project;
    expect(p).toMatchObject({ projectId: 'tampered-notice', documentType: 'custom', schemaVersion: '1.0.0', title: 'Tampered notice' });
    expect(p.brand).toBeUndefined();
    expect(p.nodes.some((n) => n.id === 'evil' || n.type === 'image' || n.image || n.visibleWhen)).toBe(false);
    // the only web address anywhere in the project is the setup's own button
    const urls = [...new Set(JSON.stringify(p).match(/[a-z]+:\/\/[^"\\ )]+/g))];
    expect(urls).toEqual(['https://example.com/membership']);
    expect(JSON.stringify(p)).not.toMatch(/evil|javascript|pixel\.gif|\.png|<img|DROP TABLE|__proto__|requireNodes/);
    // the data tokens typed into the text are plain words now, not fields of another kind of document
    const injectedText = p.nodes.find((n) => n.id === 'text-9')!;
    expect(JSON.stringify(injectedText.content)).not.toMatch(/"token"|\{\{/);
    expect(JSON.stringify(p)).not.toMatch(/"path":"(card|claim|member)\.|\{\{(card|claim|member)\./);
    // rules: only the three the gym setup asks for, each one valid for this document
    expect(p.rules.map((x) => `${x.id} ${x.mode} ${x.then.op}`)).toEqual(['R01 exclusive selectVariant', 'R02 exclusive selectVariant', 'R03 exclusive selectVariant']);
    for (const rule of p.rules) expect(validateRule(rule, p)).toEqual([]);
    const injected = p.nodes.find((n) => n.name === 'Injected')!;
    expect(injected.variantIds).toHaveLength(1);
    expect(projectFileProblems(p)).toEqual([]);
    const all = body.notes.join('\n');
    for (const expected of [/Ignored “documentType”, “projectId”, “schemaVersion”, “nodes”, “rules” and 1 more/, /unknown kind “image”/, /The button “Claim” was left out/, /The button “Call” was left out/, /The button “Plain http” was left out/, /“Code” of “Injected” was left out: “Monthly fee” is an amount/, /“Path” of “Injected” was left out: its condition uses “customer\.locale”, which is not one of the data fields/, /“Op” of “Injected” was left out/]) expect(all).toMatch(expected);
    // the sample projects are untouched and the document resolves
    expect((await json('GET', '/api/v1/projects/aster-card-demo')).project.documentType).toBe('credit-statement');
    expect(body.preview.blocking).toEqual([]);
    const [first] = await customers('tampered-notice');
    expect((await inj('POST', '/api/v1/compose/html', { projectId: 'tampered-notice', recordId: first.recordId })).statusCode).toBe(200);
  });

  it('refuses to create from nothing, or without saying which customers to use', async () => {
    const before = await projectIds();
    const code = async (payload: any) => { const r = await create(payload); return `${r.statusCode} ${r.json().error?.code}`; };
    expect(await code({ title: 'No setup', customers: 'generate' })).toBe('400 INVALID_SETUP');
    expect(await code({ spec: 'a notice please', title: 'No setup', customers: 'generate' })).toBe('400 INVALID_SETUP');
    expect(await code({ spec: {}, title: 'Empty setup', customers: 'generate' })).toBe('422 EMPTY_SETUP');
    expect(await code({ spec: { sections: [{ type: 'hologram' }], fields: [{ type: 'text' }] }, title: 'Empty after check', customers: 'generate' })).toBe('422 EMPTY_SETUP');
    expect(await code({ spec: gymSetup(), customers: 'generate' })).toBe('400 INVALID_TITLE');
    expect(await code({ spec: gymSetup(), title: 'No choice' })).toBe('400 INVALID');
    expect(await code({ spec: gymSetup(), title: 'No choice', customers: 'all' })).toBe('400 INVALID');
    expect(await code({ spec: gymSetup(), title: 'No data', customers: 'supplied' })).toBe('400 SAMPLE_DATA_REQUIRED');
    expect(await code({ spec: gymSetup(), title: 'No data', customers: 'both', sampleData: { format: 'csv', data: '' } })).toBe('400 INVALID_SAMPLE_DATA');
    expect(await code({ spec: gymSetup(), title: 'Bad colour', customers: 'generate', accent: '#12' })).toBe('400 INVALID_ACCENT');
    expect(await projectIds()).toEqual(before);
  });

  it('the model-backed draft itself: off without a key, and it never passes on more than the shape of the data', async () => {
    const OFF = { provider: 'offline', model: 'test-model', timeoutMs: 1000 };
    const LIVE = { provider: 'anthropic', model: 'test-model', apiKey: 'not-a-real-key', timeoutMs: 1000 };
    seen.length = 0;
    expect(await draftSetupSpec(OFF, model, { description: DESCRIPTION })).toMatchObject({ mode: 'unavailable', message: expect.stringMatching(/no AI key is configured/), notes: [] });
    expect(seen).toHaveLength(0);
    answer = asModelOutput();
    const ok = await draftSetupSpec(LIVE, model, { description: `${'d'.repeat(2500)} TAIL`, dataShape: { fields: [{ label: 'Tier', type: 'choice', choices: ['basic', 'pro'] }], customerName: false, customerLanguage: false, rows: 12 } });
    expect(ok).toMatchObject({ mode: 'ai', notes: [] });
    expect(ok.spec).toEqual(gymSetup());
    // the description is cut at 2,000 characters; a long task asks for more room and time, and is not retried
    expect(seen[0].user).not.toContain('TAIL');
    expect(seen[0].user).toContain('sample data for 12 customers');
    expect(seen[0].user).toContain('The data has no customer name.');
    expect(seen[0]).toMatchObject({ maxTokens: 16000, timeoutMs: 180000 });
  });
});

describe('setting a document up: who may do what', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    setEnv({ ...LIVE_ENV, AUTH: 'on', ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'correct horse battery' });
    ctx = await buildApp({ dataDir: tmp(), logger: false, assistModel: model });
  });
  afterAll(async () => { await ctx.app.close(); restoreEnv(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const login = async (email: string, password: string) => String([(await inj('POST', '/api/v1/auth/login', { email, password })).headers['set-cookie']].flat()[0]).split(';')[0];

  it('anyone signed in may ask for a proposal; creating the document needs edit rights', async () => {
    const admin = await login('admin@example.test', 'correct horse battery');
    for (const role of ['author', 'reviewer', 'approver']) expect((await inj('POST', '/api/v1/users', { email: `${role}@example.test`, name: `${role} person`, role, password: 'password-123' }, { cookie: admin })).statusCode).toBe(201);
    const author = await login('author@example.test', 'password-123');
    const reviewer = await login('reviewer@example.test', 'password-123');
    const approver = await login('approver@example.test', 'password-123');
    answer = asModelOutput();
    const payload = { description: DESCRIPTION };
    // not signed in: nothing
    expect((await inj('POST', '/api/v1/projects/setup/draft', payload)).statusCode).toBe(401);
    expect((await inj('POST', '/api/v1/projects/setup', { spec: gymSetup(), title: 'Anonymous', customers: 'generate' })).statusCode).toBe(401);
    for (const cookie of [reviewer, approver, author, admin]) {
      const r = await inj('POST', '/api/v1/projects/setup/draft', payload, { cookie });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ mode: 'proposal', source: 'ai' });
    }
    const make = (cookie: string, title: string) => inj('POST', '/api/v1/projects/setup', { spec: gymSetup(), title, customers: 'generate', source: 'ai' }, { cookie });
    const refused = await make(reviewer, 'By a reviewer');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Reviewers can comment but not edit.' });
    expect((await make(approver, 'By an approver')).statusCode).toBe(403);
    const made = await make(author, 'By an author');
    expect(made.statusCode).toBe(201);
    expect((await make(admin, 'By an admin')).statusCode).toBe(201);
    const projects = (await inj('GET', '/api/v1/projects', undefined, { cookie: admin })).json().projects.map((p: any) => p.projectId);
    expect(projects).toEqual(expect.arrayContaining(['by-an-author', 'by-an-admin']));
    expect(projects).not.toEqual(expect.arrayContaining(['by-a-reviewer']));
    // the audit trail names who created it and that the setup was an AI suggestion; proposals leave no trace
    const events = (await inj('GET', '/api/v1/audit', undefined, { cookie: admin })).json().events;
    expect(events.filter((e: any) => e.action === 'project.create').map((e: any) => `${e.userName}:${e.detail.setup}`).sort()).toEqual(['Administrator:ai', 'author person:ai']);
    expect(events.some((e: any) => /setup\/draft/.test(JSON.stringify(e)))).toBe(false);
    // a new document starts as a draft: creating it approves nothing
    expect((await inj('GET', '/api/v1/projects/by-an-author/workflow?checks=0', undefined, { cookie: admin })).json().state).toBe('draft');
  });
});

describe('setup: re-checking an edited setup', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-setup-edit-')), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });

  it('an edited setup is rebuilt and previewed as it stands, without a model and without storing anything', async () => {
    const data = JSON.stringify([{ firstName: 'Ada', lastName: 'Okoye', plan: 'Flex', monthlyFee: 49.5, renewalDate: '2026-12-01' }]);
    const first = (await inj('POST', '/api/v1/projects/setup/draft', { sampleData: { format: 'json', data }, title: 'Gym renewal' })).json();
    expect(first.mode).toBe('proposal');
    const before = (await inj('GET', '/api/v1/projects')).json().projects.length;
    // the person removes a field and a section, and rewrites the heading
    const dropped = first.spec.fields[0].label;
    const spec = { ...first.spec, fields: first.spec.fields.slice(1), sections: first.spec.sections.filter((s: any) => s.type !== 'keyFigures').map((s: any) => (s.type === 'heading' ? { ...s, text: 'Your renewal' } : s)) };
    const again = (await inj('POST', '/api/v1/projects/setup/draft', { spec, source: 'builtin', sampleData: { format: 'json', data }, title: 'Gym renewal' })).json();
    expect(again).toMatchObject({ mode: 'proposal', source: 'builtin' });
    expect(again.spec.fields.map((f: any) => f.label)).not.toContain(dropped);
    expect(again.outline.fields).toHaveLength(first.outline.fields.length - 1);
    expect(JSON.stringify(again.outline.sections)).toContain('Your renewal');
    expect(again.outline.sections.some((s: any) => /key figures/i.test(s.kind))).toBe(false);
    expect(again.preview.blocking).toEqual([]);
    expect((await inj('GET', '/api/v1/projects')).json().projects.length).toBe(before);
    // junk in an edited setup is cleaned and noted, never trusted
    const junk = (await inj('POST', '/api/v1/projects/setup/draft', { spec: { ...spec, documentType: 'eob', sections: [...spec.sections, { type: 'table', list: 'No such list' }, { type: 'action', label: 'Go', url: 'javascript:alert(1)' }] }, title: 'Gym renewal' })).json();
    expect(junk.mode).toBe('proposal');
    expect(junk.project.documentType).toBe('custom');
    expect(junk.notes.length).toBeGreaterThan(0);
    expect(JSON.stringify(junk.project)).not.toContain('javascript:');
    expect((await inj('POST', '/api/v1/projects/setup/draft', { spec: 'nope' })).statusCode).toBe(400);
  });
});

