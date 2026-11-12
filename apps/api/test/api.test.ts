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
    expect(ids).toEqual(['aster-card-demo', 'harborcare-demo']);
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

  it('artifact ids are validated against traversal', async () => {
    expect((await inj('GET', '/api/v1/artifacts/..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(404);
  });
});
