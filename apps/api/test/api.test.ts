import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { offlineInterpret, validateActions } from '../src/assistant';
import { seedProjects, RECORDS } from '@iss/model/fixtures';

let ctx: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-api-')), logger: false }); });
afterAll(async () => { await ctx.app.close(); });
const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });

describe('API contract', () => {
  it('health and seeded projects', async () => {
    expect((await inj('GET', '/api/v1/health')).json()).toMatchObject({ status: 'ok', schemaVersion: '1.0.0' });
    const ids = (await inj('GET', '/api/v1/projects')).json().projects.map((p: any) => p.projectId);
    // The two fixture samples and the two example documents with their own data (Northwind Energy, Meridian Wealth).
    expect(ids).toEqual(['aster-card-demo', 'harborcare-demo', 'meridian-wealth-demo', 'northwind-energy-demo']);
  });

  it('optimistic concurrency: If-Match required, stale version → 409, success bumps version', async () => {
    const { project } = (await inj('GET', '/api/v1/projects/aster-card-demo')).json();
    expect((await inj('PUT', '/api/v1/projects/aster-card-demo', { project })).statusCode).toBe(428);
    const edited = { ...project, title: project.title + ' (edited)', modelVersion: project.modelVersion + 1 };
    const ok = await inj('PUT', '/api/v1/projects/aster-card-demo', { project: edited }, { 'if-match': `"${project.modelVersion}"` });
    expect(ok.statusCode).toBe(200);
    const stale = await inj('PUT', '/api/v1/projects/aster-card-demo', { project: edited }, { 'if-match': `"${project.modelVersion}"` });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: edited.modelVersion });
    expect(stale.json().error.correlationId).toBeTruthy();
  });

  it('reset requires confirmation and restores the seed', async () => {
    expect((await inj('POST', '/api/v1/projects/aster-card-demo/reset', {})).statusCode).toBe(400);
    const r = (await inj('POST', '/api/v1/projects/aster-card-demo/reset', { confirm: true })).json();
    expect(r.project.title).toBe(seedProjects()[0].title);
  });

  it('typed error codes: 404 unknown record, 400 invalid, 422 invalid rule in draft', async () => {
    expect((await inj('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: 'CARD-9999' })).statusCode).toBe(404);
    expect((await inj('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: 'nope' })).statusCode).toBe(400);
    const p = seedProjects()[0];
    const bad = { ...p, rules: p.rules.map((r) => (r.id === 'R01' ? { ...r, when: { op: 'eq', path: 'card.hacked', value: 1 } } : r)) };
    const res = await inj('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: 'CARD-0001', project: bad });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INVALID_RULE');
  });

  it('runs are immutable handles; journey issue is write-once', async () => {
    const a = (await inj('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: 'CARD-0002' })).json();
    const b = (await inj('POST', '/api/v1/resolve', { projectId: 'aster-card-demo', recordId: 'CARD-0002' })).json();
    expect(a.runId).toBe(b.runId);
    const j1 = (await inj('POST', '/api/v1/journeys/replay', { projectId: 'aster-card-demo', recordId: 'CARD-0001' })).json();
    const j2 = (await inj('POST', '/api/v1/journeys/replay', { projectId: 'aster-card-demo', recordId: 'CARD-0001', journeyCursor: 3 })).json();
    expect(j1.issued[0].sha256).toBe(j2.issued[0].sha256);
    expect(j2.issued[0].alreadyIssued).toBe(true);
    expect(j2.issued[0].verified).toBe(true);
  });

  it('assistant: allowlist, offline grammar, proposals never mutate, decline recorded', async () => {
    const project = seedProjects()[0];
    const v = validateActions([{ action: 'run_shell', cmd: 'rm -rf /' }, { action: 'select_scenario', recordId: 'CARD-0002' }, { action: 'set_scenario_fields', fields: { 'card.secret': 1 } }], { project, records: RECORDS, recordId: 'CARD-0001', overrides: {}, journeyCursor: null });
    expect(v.ok.map((a) => a.action)).toEqual(['select_scenario']);
    expect(v.rejected).toHaveLength(2);
    const o = offlineInterpret('Show me a Spanish-speaking cardholder who has missed two payments and requests assistance', { project, records: RECORDS, recordId: 'CARD-0001', overrides: {}, journeyCursor: null });
    expect(o.actions).toEqual([{ action: 'set_scenario_fields', fields: { 'customer.locale': 'es-US', 'card.missedPayments': 2, 'card.paymentStatus': 'overdue', 'card.assistanceRequested': true } }]);
    const r = (await inj('POST', '/api/v1/assistant/message', { message: 'Disable R12', context: { projectId: 'aster-card-demo', recordId: 'CARD-0001' } })).json();
    expect(r.mode).toBe('offline');
    expect(r.proposal).toBeUndefined();
    expect(r.rejected[0].reason).toMatch(/mandatory/i);
    const p = (await inj('POST', '/api/v1/assistant/message', { message: 'Change R04 priority to 420', context: { projectId: 'aster-card-demo', recordId: 'CARD-0001' } })).json();
    expect(p.proposal).toMatchObject({ mutationApplied: false, status: 'approval_required' });
    const d = (await inj('POST', `/api/v1/assistant/proposals/${p.proposal.proposalId}/decision`, { approved: false, modelVersion: 1 })).json();
    expect(d).toMatchObject({ approved: false, mutationApplied: false, command: null });
    expect((await inj('POST', `/api/v1/assistant/proposals/${p.proposal.proposalId}/decision`, { approved: true })).statusCode).toBe(409);
  });

  it('assistant offline grammar: synonyms, number words, punctuation-insensitive, persona, rules, export', async () => {
    const [card, eob] = seedProjects();
    const base = { records: RECORDS, recordId: 'CARD-0001', overrides: {}, journeyCursor: null };
    const ask = (m: string, project = card) => offlineInterpret(m, { project, ...base, recordId: project === eob ? 'EOB-0001' : 'CARD-0001' });
    const kinds = (m: string, project = card) => ask(m, project).actions.map((a: any) => a.action);
    // exact existing phrasings keep working
    expect(kinds('Choose assistance case CARD-0002')).toEqual(['select_scenario']);
    expect(kinds('Explain the selected variant')).toEqual(['explain_resolution']);
    expect(kinds('Change R04 priority to 420')).toEqual(['propose_rule_edit']);
    expect(kinds('Run validation')).toEqual(['run_validation']);
    // case/punctuation/number-word insensitive
    expect(ask('SHOW ME a spanish-speaking cardholder... with TWO missed payments!!').actions).toEqual([{ action: 'set_scenario_fields', fields: { 'customer.locale': 'es-US', 'card.missedPayments': 2, 'card.paymentStatus': 'overdue' } }]);
    expect((ask('a cardholder who is three payments late').actions[0] as any).fields['card.missedPayments']).toBe(3);
    // personas by name
    expect(ask('show me the Digital First persona').actions).toEqual([{ action: 'select_scenario', recordId: RECORDS.find((r) => r.documentType === 'credit-statement' && r.personaId === 'P06')!.recordId }]);
    // rule edit synonyms and relative priority
    expect(ask('please set priority of rule 4 to 450').actions).toEqual([{ action: 'propose_rule_edit', ruleId: 'R04', patch: { priority: 450 } }]);
    const r04 = card.rules.find((r) => r.id === 'R04')!;
    expect(ask('raise r4 priority by 20').actions).toEqual([{ action: 'propose_rule_edit', ruleId: 'R04', patch: { priority: r04.priority + 20 } }]);
    expect(ask('turn off R04').actions).toEqual([{ action: 'propose_rule_edit', ruleId: 'R04', patch: { enabled: false } }]);
    // why / rules questions are answered from the engine (explain action + engine facts)
    expect(kinds('Why am I seeing this message?')).toEqual(['explain_resolution']);
    const rules = ask('What rules apply?');
    expect(rules.actions.map((a: any) => a.action)).toEqual(['explain_resolution']);
    expect(rules.reply).toMatch(/engine matched .*run /);
    // project switching, validation, export
    expect(kinds('switch to HarborCare')).toEqual(['open_project']);
    expect(ask('go to the EOB project').actions).toEqual([{ action: 'open_project', projectId: 'harborcare-demo' }]);
    expect(ask('switch to EOB', eob).actions).toEqual([]);
    expect(kinds('is this document compliant?')).toEqual(['run_validation']);
    expect(ask('export PDF').actions).toEqual([{ action: 'navigate_view', view: 'outputs' }]);
    expect(kinds('take me to the journey timeline')).toEqual(['navigate_view']);
  });

  it('assistant offline: unrecognised request is labelled, does nothing, and lists answerable examples', async () => {
    const r = (await inj('POST', '/api/v1/assistant/message', { message: 'What is the airspeed velocity of an unladen swallow?', context: { projectId: 'aster-card-demo', recordId: 'CARD-0001' } })).json();
    expect(r).toMatchObject({ mode: 'offline', understood: false, actions: [], rejected: [] });
    expect(r.proposal).toBeUndefined();
    expect(r.response).toMatch(/did not understand/i);
    expect(r.suggestions).toHaveLength(6);
    // every suggestion is itself understood offline
    for (const q of r.suggestions) {
      const a = (await inj('POST', '/api/v1/assistant/message', { message: q, context: { projectId: 'aster-card-demo', recordId: 'CARD-0001' } })).json();
      expect(a.understood, q).toBe(true);
    }
    const e = (await inj('POST', '/api/v1/assistant/message', { message: 'blorp', context: { projectId: 'harborcare-demo', recordId: 'EOB-0001' } })).json();
    expect(e.understood).toBe(false);
    expect(e.suggestions.join(' ')).toMatch(/EOB-0002/);
    const h = (await inj('POST', '/api/v1/assistant/message', { message: 'help', context: { projectId: 'aster-card-demo', recordId: 'CARD-0001' } })).json();
    expect(h.understood).toBe(true);
    expect(h.suggestions.length).toBeGreaterThan(0);
  });

  it('artifact ids are validated against traversal', async () => {
    expect((await inj('GET', '/api/v1/artifacts/..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(404);
  });
});
