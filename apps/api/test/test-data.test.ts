import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';

/** Generated test customers: made for one project, visible only there, replaced on regenerate. */
describe('generated test customers', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-td-')), logger: false, auth: false }); });
  afterAll(async () => { await ctx.app.close(); });
  const inj = (method: any, url: string, payload?: any, headers?: any) => ctx.app.inject({ method, url, payload, headers });
  const P = 'aster-card-demo';
  const records = async (projectId?: string) => (await inj('GET', `/api/v1/records?documentType=credit-statement&full=1${projectId ? `&projectId=${projectId}` : ''}`)).json().records as any[];
  let copyId = '';

  it('planning shows what would be created and stores nothing', async () => {
    const r = await inj('POST', `/api/v1/projects/${P}/test-data/plan`, { outcomes: true, edges: true });
    expect(r.statusCode).toBe(200);
    const plan = r.json();
    expect(plan.existing).toBe(0);
    expect(plan.customers.length).toBeGreaterThan(5);
    expect(plan.customers.length).toBeLessThan(60);
    expect(plan.summary.outcomes.total).toBeGreaterThan(10);
    expect(plan.summary.outcomes.reached).toBe(plan.summary.outcomes.total);
    expect(plan.customers.every((c: any) => c.recordId === null && c.name.includes(' ') && c.label.length > 3)).toBe(true);
    expect((await inj('GET', `/api/v1/projects/${P}/test-data`)).json()).toMatchObject({ count: 0, generatedAt: null, stale: false });
    expect((await records(P)).some((x) => x.generated)).toBe(false);
    expect((await inj('POST', `/api/v1/projects/${P}/test-data/plan`, { outcomes: false, edges: false })).json().error.code).toBe('NOTHING_TO_GENERATE');
  });

  it('generating stores customers for that project only; each one is a real record the document resolves for', async () => {
    const copy = await inj('POST', `/api/v1/projects/${P}/duplicate`, { title: 'Another statement' });
    copyId = copy.json().project.projectId;
    const g = await inj('POST', `/api/v1/projects/${P}/test-data`, { outcomes: true, edges: true });
    expect(g.statusCode).toBe(201);
    const out = g.json();
    expect(out.generated).toBe(out.customers.length);
    expect(out.replaced).toBe(0);
    expect(out.customers.every((c: any) => /^CARD-6\d{4}$/.test(c.recordId))).toBe(true);
    // every target names the customer that reaches it, or says why nothing does
    for (const t of out.targets) expect(t.recordId !== null || (typeof t.reason === 'string' && t.reason.length > 5), t.title).toBe(true);
    for (const t of out.targets.filter((x: any) => x.recordId)) expect(out.customers.some((c: any) => c.recordId === t.recordId)).toBe(true);

    const mine = (await records(P)).filter((x) => x.generated);
    expect(mine).toHaveLength(out.generated);
    expect(mine.every((x) => x.projectId === P && x.generated.label && !x.imported)).toBe(true);
    // not in the shared list, and not in another project of the same kind
    expect((await records()).some((x) => x.generated)).toBe(false);
    expect((await records(copyId)).some((x) => x.generated)).toBe(false);

    const one = mine[0].recordId;
    expect((await inj('POST', '/api/v1/resolve', { projectId: P, recordId: one })).statusCode).toBe(200);
    expect((await inj('POST', '/api/v1/resolve', { projectId: copyId, recordId: one })).json().error.code).toBe('RECORD_OTHER_PROJECT');
    // a rule target's customer really gets that rule
    const ruleTarget = out.targets.find((t: any) => t.kind === 'rule' && t.recordId);
    const res = (await inj('POST', '/api/v1/resolve', { projectId: P, recordId: ruleTarget.recordId })).json();
    expect(res.result.matchedRuleIds).toContain(ruleTarget.targetId);

    const state = (await inj('GET', `/api/v1/projects/${P}/test-data`)).json();
    expect(state).toMatchObject({ count: out.generated, stale: false, options: { outcomes: true, edges: true } });
    expect(state.targets).toHaveLength(out.targets.length);
  });

  it('the project\'s checks, cube and landscape include its generated customers; another project\'s do not', async () => {
    const n = (await records(P)).length;
    const shared = (await records()).length;
    expect(n).toBeGreaterThan(shared);
    const land = (await inj('POST', '/api/v1/analysis/landscape', { projectId: P })).json();
    const landCopy = (await inj('POST', '/api/v1/analysis/landscape', { projectId: copyId })).json();
    const total = (l: any) => (l.clusters ?? []).reduce((s: number, c: any) => s + (c.count ?? c.size ?? c.records?.length ?? 0), 0);
    expect(total(land)).toBeGreaterThan(total(landCopy));
  });

  it('regenerating replaces the previous set; "edge values only" gives a different set', async () => {
    const before = (await records(P)).filter((x) => x.generated).map((x) => x.recordId);
    const g = (await inj('POST', `/api/v1/projects/${P}/test-data`, { outcomes: true, edges: false })).json();
    expect(g.replaced).toBe(before.length);
    expect(g.generated).toBeLessThan(before.length);
    expect(g.targets.every((t: any) => t.kind !== 'edge' && t.kind !== 'empty')).toBe(true);
    const after = (await records(P)).filter((x) => x.generated).map((x) => x.recordId);
    expect(after).toHaveLength(g.generated);
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect((await inj('GET', '/api/v1/records/' + before[0])).statusCode).toBe(404);
  });

  it('plans for the unsaved model when one is sent, and says when saved changes made the customers stale', async () => {
    const p = (await inj('GET', `/api/v1/projects/${P}`)).json().project;
    const fewer = { ...p, rules: p.rules.map((r: any, i: number) => (i === 0 ? { ...r, enabled: false } : r)) };
    const base = (await inj('POST', `/api/v1/projects/${P}/test-data/plan`, { outcomes: true, edges: false })).json();
    const unsaved = (await inj('POST', `/api/v1/projects/${P}/test-data/plan`, { project: fewer, outcomes: true, edges: false })).json();
    expect(unsaved.summary.outcomes.total).toBeLessThan(base.summary.outcomes.total);
    expect((await inj('GET', `/api/v1/projects/${P}/test-data`)).json().stale).toBe(false);
    expect((await inj('PUT', `/api/v1/projects/${P}`, { project: fewer }, { 'if-match': String(p.modelVersion) })).statusCode).toBe(200);
    expect((await inj('GET', `/api/v1/projects/${P}/test-data`)).json().stale).toBe(true);
  });

  it('removing clears only the generated customers; deleting a project removes its own', async () => {
    const shared = (await records()).length;
    expect((await inj('POST', `/api/v1/projects/${copyId}/test-data`, { outcomes: true, edges: false })).statusCode).toBe(201);
    const del = (await inj('DELETE', `/api/v1/projects/${P}/test-data`)).json();
    expect(del.removed).toBeGreaterThan(0);
    expect((await records(P)).some((x) => x.generated)).toBe(false);
    expect((await records()).length).toBe(shared);
    expect((await inj('GET', `/api/v1/projects/${P}/test-data`)).json()).toMatchObject({ count: 0, generatedAt: null });
    const theirs = (await records(copyId)).filter((x) => x.generated);
    expect(theirs.length).toBeGreaterThan(0);
    expect((await inj('DELETE', `/api/v1/projects/${copyId}`)).statusCode).toBe(200);
    expect((await inj('GET', '/api/v1/records/' + theirs[0].recordId)).statusCode).toBe(404);
    const actions = ((await inj('GET', '/api/v1/audit?limit=50')).json().events ?? []).map((e: any) => e.action);
    expect(actions).toContain('testdata.generate');
    expect(actions).toContain('testdata.clear');
  });
});
