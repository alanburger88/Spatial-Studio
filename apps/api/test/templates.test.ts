import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { TEMPLATES, validateStyles } from '@iss/model';

let ctx: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { ctx = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'iss-tpl-')), logger: false }); });
afterAll(async () => { await ctx.app.close(); });
const inj = (method: any, url: string, payload?: any) => ctx.app.inject({ method, url, payload });

describe('templates', () => {
  it('lists the four templates', async () => {
    const r = (await inj('GET', '/api/v1/templates')).json();
    expect(r.templates.map((t: any) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
    expect(r.templates).toHaveLength(4);
  });

  it('creates an editable project from each template that resolves', async () => {
    for (const [templateId, recordId] of [['credit-card-statement', 'CARD-0001'], ['explanation-of-benefits', 'EOB-0001'], ['blank-letter', 'CARD-0001']]) {
      const c = await inj('POST', '/api/v1/projects', { templateId, title: `New ${templateId}` });
      expect(c.statusCode).toBe(201);
      const p = c.json().project;
      expect(p).toMatchObject({ modelVersion: 1, title: `New ${templateId}` });
      const list = (await inj('GET', '/api/v1/projects')).json().projects;
      expect(list.find((x: any) => x.projectId === p.projectId)).toMatchObject({ sample: false });
      const res = await inj('POST', '/api/v1/resolve', { projectId: p.projectId, recordId });
      expect(res.statusCode).toBe(200);
    }
  });

  it('blank letter has the greeting token and can target EOB data', async () => {
    const p = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Plain letter' })).json().project;
    expect(p.documentType).toBe('credit-statement');
    expect(JSON.stringify(p.nodes.find((n: any) => n.id === 'greeting'))).toContain('customer.givenName');
    expect(p.rules).toEqual([]);
    const e = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Plain EOB letter', documentType: 'eob' })).json().project;
    expect(e.documentType).toBe('eob');
    expect((await inj('POST', '/api/v1/resolve', { projectId: e.projectId, recordId: 'EOB-0001' })).statusCode).toBe(200);
  });

  it('gives duplicate titles unique ids and rejects bad input', async () => {
    const a = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Twin' })).json().project;
    const b = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Twin' })).json().project;
    expect(a.projectId).not.toBe(b.projectId);
    expect((await inj('POST', '/api/v1/projects', { templateId: 'nope', title: 'Twin' })).statusCode).toBe(404);
    expect((await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'x' })).statusCode).toBe(400);
  });

  it('a created project accepts styles and brand through the save API', async () => {
    const p = (await inj('POST', '/api/v1/projects', { templateId: 'blank-letter', title: 'Styled letter' })).json().project;
    const styles = [{ id: 'lead', name: 'Lead', kind: 'paragraph', fontSizePt: 14 }];
    expect(validateStyles(styles as any)).toEqual([]);
    const next = { ...p, styles, brand: { primary: '#123456', accent: '#654321' }, nodes: p.nodes.map((n: any) => (n.id === 'letter-body' ? { ...n, styleId: 'lead' } : n)) };
    const put = await ctx.app.inject({ method: 'PUT', url: `/api/v1/projects/${p.projectId}`, headers: { 'if-match': '"1"' }, payload: { project: next } });
    expect(put.statusCode).toBe(200);
    const html = await inj('POST', '/api/v1/compose/html', { projectId: p.projectId, recordId: 'CARD-0001' });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('--iss-brand-primary:#123456');
    expect(html.body).toContain('iss-st-lead');
  });
});
