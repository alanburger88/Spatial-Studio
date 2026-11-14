import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app';
import { REVIEW_LINK_LIMITS, reviewTokenHash } from '../src/reviewLinks';
import type { PackageComposer } from '../src/releasePackage';

/**
 * Review links (docs/design/WAVE4_TEAMS.md section 1), against the real API. PDF composition is replaced by a stand-in;
 * everything else (the frozen project, resolving, the web page, email and SMS renderers) is the real thing.
 * Each `it` names the rule it checks.
 */

type Ctx = Awaited<ReturnType<typeof buildApp>>;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'iss-review-links-'));
const CARD = 'aster-card-demo';
const DEAD = 'This review link is not available. Ask the person who sent it for a new one.';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function stubComposer(): PackageComposer {
  return { async pdf(html: string) { return { pdf: Buffer.from(`%PDF-1.4\n% ${sha(html)}\n%%EOF\n`), pageCount: 2, facts: null }; }, async html() { return { facts: null }; } };
}

function helpers(getCtx: () => Ctx) {
  const inj = (method: any, url: string, payload?: any, headers?: any, extra: Record<string, unknown> = {}) => getCtx().app.inject({ method, url, payload, headers, ...extra });
  const json = async (method: any, url: string, payload?: any, headers?: any) => (await inj(method, url, payload, headers)).json();
  const project = async (id: string, headers?: any) => (await json('GET', `/api/v1/projects/${id}`, undefined, headers)).project;
  const save = async (id: string, edit: (p: any) => void, headers?: any) => {
    const p: any = await project(id, headers);
    edit(p);
    const r = await inj('PUT', `/api/v1/projects/${id}`, { project: { ...p, modelVersion: p.modelVersion + 1 } }, { 'if-match': `"${p.modelVersion}"`, ...(headers ?? {}) });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    return r.json().project;
  };
  const approve = async (id: string, headers?: any) => {
    const wf = (a: string) => inj('POST', `/api/v1/projects/${id}/workflow`, { action: a }, headers);
    const state = (await json('GET', `/api/v1/projects/${id}/workflow?checks=0`, undefined, headers)).state;
    if (state !== 'draft') expect((await wf('reopen')).statusCode).toBe(200);
    expect((await wf('submit')).statusCode).toBe(200);
    const r = await wf('approve');
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    return r.json().release.release as { id: string; number: number; modelVersion: number };
  };
  /** The card sample ships with Spanish wording missing on purpose (a demo blocker): approve it as the release tests do. */
  const makeCardApprovable = async (headers?: any) => {
    const readiness = (await json('GET', `/api/v1/projects/${CARD}/workflow`, undefined, headers)).readiness;
    const ids = [...new Set((readiness.blocking as any[]).filter((b) => b.code === 'REQUIRED_TRANSLATION_MISSING').map((b) => b.nodeId as string))];
    await save(CARD, (p) => { for (const part of p.contentParts) if (ids.includes(part.id)) part.approvedLocales['es-US'] = `ES aprobado: ${part.approvedLocales['en-US']}`; }, headers);
  };
  const duplicate = async (from: string, title: string, headers?: any) => (await json('POST', `/api/v1/projects/${from}/duplicate`, { title }, headers)).project.projectId as string;
  const makeLink = (id: string, body: Record<string, unknown>, headers?: any) => inj('POST', `/api/v1/projects/${id}/review-links`, body, headers);
  const review = (token: string, rest = '', extra?: Record<string, unknown>) => inj('GET', `/api/v1/review/${token}${rest}`, undefined, undefined, extra);
  const comment = (token: string, body: Record<string, unknown>, extra?: Record<string, unknown>) => inj('POST', `/api/v1/review/${token}/comments`, body, undefined, extra);
  return { inj, json, project, save, approve, makeCardApprovable, duplicate, makeLink, review, comment };
}

const dbText = (ctx: Ctx): string => {
  const db = (ctx.store as any).db;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
};

describe('review links (sign-in off: the local admin)', () => {
  let ctx: Ctx;
  const h = helpers(() => ctx);
  let release: { id: string; number: number; modelVersion: number };
  let token = '';
  let linkId = '';
  beforeAll(async () => {
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: false, extraSamples: false, releasePackage: { composer: stubComposer() } });
    await h.makeCardApprovable();
    release = await h.approve(CARD);
  });
  afterAll(async () => { await ctx.app.close(); });

  it('rule 4: a link is made with a 43-character URL-safe token shown once; the studio keeps only its SHA-256', async () => {
    const r = await h.makeLink(CARD, { releaseId: release.id, label: 'Marketing check', customers: ['CARD-0001', 'CARD-0002'] });
    expect(r.statusCode, r.body).toBe(201);
    const out = r.json();
    token = out.token; linkId = out.link.id;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.path).toBe(`/review/${token}`);
    expect(out.link).toMatchObject({ label: 'Marketing check', status: 'active', target: { kind: 'release', releaseNumber: release.number, version: release.modelVersion }, customers: ['CARD-0001', 'CARD-0002'], outputs: ['pdf', 'html', 'email', 'sms'], opens: 0, comments: 0, mayRevoke: true });
    expect(JSON.stringify(out.link)).not.toContain(token);
    // The stored row holds no token, only its hash; nothing in the database holds the token.
    const row = (ctx.store as any).db.prepare('SELECT * FROM review_links WHERE link_id=?').get(linkId);
    expect(row.token_hash).toBe(reviewTokenHash(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(dbText(ctx)).not.toContain(token);
    // ... and the list never shows it again.
    const list = await h.json('GET', `/api/v1/projects/${CARD}/review-links`);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.links[0]).toMatchObject({ id: linkId, status: 'active' });
    // Two links never share a token.
    const again = (await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001'] })).json();
    expect(again.token).not.toBe(token);
    expect((await h.inj('POST', `/api/v1/projects/${CARD}/review-links/${again.link.id}/revoke`)).statusCode).toBe(200);
  });

  it('rule 12: the summary and every public reply carry no-store, no-referrer and noindex, and set no cookie', async () => {
    for (const rest of ['', '/comments', '/output?customer=CARD-0001&output=sms', '/pdf?customer=CARD-0001']) {
      const r = await h.review(token, rest);
      expect(r.statusCode, `${rest} ${r.body.slice(0, 200)}`).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-robots-tag']).toBe('noindex');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const dead = await h.review('A'.repeat(43));
    expect(dead.headers['cache-control']).toBe('no-store');
    expect(dead.headers['referrer-policy']).toBe('no-referrer');
    expect(dead.headers['x-robots-tag']).toBe('noindex');
    const posted = await h.comment(token, { name: 'Pat', body: 'Header check', customer: 'CARD-0001', output: 'sms' });
    expect(posted.statusCode).toBe(201);
    expect(posted.headers['cache-control']).toBe('no-store');
    expect(posted.headers['set-cookie']).toBeUndefined();
  });

  it('rules 1 and 13: the summary names the document and version, the banner, the choices, and no component ids', async () => {
    const s = (await h.review(token)).json();
    expect(s.banner).toBe('Review copy: synthetic data. Not for distribution.');
    expect(s).toMatchObject({ label: 'Marketing check', version: { kind: 'release', releaseNumber: release.number, version: release.modelVersion }, newerExists: false, withdrawn: false });
    expect(s.document.title).toBeTruthy();
    expect(s.customers.map((c: any) => c.key)).toEqual(['CARD-0001', 'CARD-0002']);
    expect(s.outputs.map((o: any) => o.id)).toEqual(['pdf', 'html', 'email', 'sms']);
    expect(s.languages.map((l: any) => l.code)).toContain('en-US');
    expect(s.parts.length).toBeGreaterThan(2);
    const p = await h.project(CARD);
    for (const part of s.parts) expect(p.nodes.map((n: any) => n.id)).not.toContain(part.key);
    // Nothing of the studio: no rules, fields, other customers, releases or users.
    const text = JSON.stringify(s);
    for (const r of p.rules) expect(text).not.toContain(`"${r.id}"`);
    expect(text).not.toContain('CARD-0003');
    expect(text).not.toContain('Local admin');
  });

  it('outputs: web page, email, text message and PDF for one customer, in a chosen language', async () => {
    const html = (await h.review(token, '/output?customer=CARD-0001&output=html')).json();
    expect(html.html).toContain('<html');
    expect(html.customer.key).toBe('CARD-0001');
    const email = (await h.review(token, '/output?customer=CARD-0002&output=email')).json();
    expect(email.email.subject).toBeTruthy();
    expect(email.email.html).toContain('<');
    const sms = (await h.review(token, '/output?customer=CARD-0001&output=sms')).json();
    expect(typeof sms.sms.text).toBe('string');
    const pdf = await h.review(token, '/pdf?customer=CARD-0001');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    const es = (await h.review(token, '/output?customer=CARD-0001&output=html&language=es-US')).json();
    expect(es.language.code).toBe('es-US');
    // Outside what the link allows: another customer, an unknown output or language.
    expect((await h.review(token, '/output?customer=CARD-0003&output=html')).json().error.code).toBe('CUSTOMER_NOT_AVAILABLE');
    expect((await h.review(token, '/output?customer=CARD-0001&output=afp')).json().error.code).toBe('OUTPUT_NOT_AVAILABLE');
    expect((await h.review(token, '/output?customer=CARD-0001&output=html&language=fr-FR')).json().error.code).toBe('LANGUAGE_NOT_AVAILABLE');
  });

  it('rule 7: unknown, malformed, expired and revoked tokens get the same reply and status', async () => {
    const answers: Array<{ status: number; code: string; message: string }> = [];
    const answer = async (t: string, rest = '') => { const r = await h.review(t, rest); answers.push({ status: r.statusCode, code: r.json().error.code, message: r.json().error.message }); };
    await answer('B'.repeat(43));
    await answer('not-a-token');
    await answer(token.slice(0, 42) + (token.endsWith('A') ? 'B' : 'A'));
    // Expired: a link whose time has passed.
    const exp = (await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001'] })).json();
    (ctx.store as any).db.prepare('UPDATE review_links SET expires_at=? WHERE link_id=?').run(new Date(Date.now() - 1000).toISOString(), exp.link.id);
    await answer(exp.token);
    await answer(exp.token, '/comments');
    // Revoked.
    const rev = (await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001'] })).json();
    expect((await h.review(rev.token)).statusCode).toBe(200);
    const done = await h.inj('POST', `/api/v1/projects/${CARD}/review-links/${rev.link.id}/revoke`);
    expect(done.json().link.status).toBe('revoked');
    await answer(rev.token);
    await answer(rev.token, '/output?customer=CARD-0001&output=sms');
    const post = await h.comment(rev.token, { name: 'X', body: 'y', customer: 'CARD-0001', output: 'sms' });
    answers.push({ status: post.statusCode, code: post.json().error.code, message: post.json().error.message });
    for (const a of answers) expect(a).toEqual({ status: 404, code: 'REVIEW_LINK_NOT_AVAILABLE', message: DEAD });
    // The list says which is which (to the studio only).
    const list = (await h.json('GET', `/api/v1/projects/${CARD}/review-links`)).links;
    expect(list.find((l: any) => l.id === exp.link.id).status).toBe('expired');
    expect(list.find((l: any) => l.id === rev.link.id).status).toBe('revoked');
  });

  it('rule 2: an imported or supplied customer cannot be put in a link; a customer that later becomes supplied stops showing', async () => {
    // Imported (shared by every credit-statement document).
    const { recordId: _drop, ...row } = (await h.json('GET', '/api/v1/records/CARD-0002')).record;
    const imp = await h.json('POST', '/api/v1/records/import', { documentType: 'credit-statement', format: 'json', data: [row] });
    const importedId = imp.imported[0].recordId;
    // Supplied (a copy a person made) and generated (made by the engine).
    const supplied = (await h.json('POST', `/api/v1/projects/${CARD}/records`, { copyOf: 'CARD-0001' })).record.recordId;
    const gen = await h.inj('POST', `/api/v1/projects/${CARD}/test-data`, {});
    expect(gen.statusCode, gen.body.slice(0, 200)).toBeLessThan(300);
    const generated = (await h.json('GET', `/api/v1/projects/${CARD}/test-data`)).customers?.map((c: any) => c.recordId).filter(Boolean)[0]
      ?? ((ctx.store as any).projectRecords(CARD, 'generated')[0]?.recordId as string);
    expect(generated).toBeTruthy();

    const opts = await h.json('GET', `/api/v1/projects/${CARD}/review-links/options?releaseId=${release.id}`);
    const kind = (id: string) => opts.customers.find((c: any) => c.recordId === id);
    expect(kind('CARD-0001')).toMatchObject({ kind: 'sample', allowed: true, reason: null });
    expect(kind(importedId)).toMatchObject({ kind: 'imported', allowed: false });
    expect(kind(supplied)).toMatchObject({ kind: 'supplied', allowed: false });
    expect(kind(generated)).toMatchObject({ kind: 'generated', allowed: true });
    expect(kind(importedId).reason).toMatch(/never/);

    for (const bad of [importedId, supplied]) {
      const r = await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001', bad] });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('CUSTOMER_NOT_ALLOWED');
    }

    // A generated customer in a link, then edited by a person (it becomes "supplied"): the link stops showing it.
    const made = (await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001', generated] })).json();
    expect((await h.review(made.token)).json().customers.map((c: any) => c.key)).toEqual(['CARD-0001', generated]);
    expect((await h.review(made.token, `/output?customer=${generated}&output=sms`)).statusCode).toBe(200);
    const rec = (ctx.store as any).projectRecord(generated);
    const put = await h.inj('PUT', `/api/v1/projects/${CARD}/records/${generated}`, { record: { ...rec, customer: { ...rec.customer, givenName: 'Edited' } } });
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200);
    expect((ctx.store as any).projectRecordOrigin(CARD, generated)).toBe('supplied');
    expect((await h.review(made.token)).json().customers.map((c: any) => c.key)).toEqual(['CARD-0001']);
    const gone = await h.review(made.token, `/output?customer=${generated}&output=sms`);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('CUSTOMER_NOT_AVAILABLE');
    expect((await h.review(made.token, `/pdf?customer=${generated}`)).statusCode).toBe(404);
    expect((await h.comment(made.token, { name: 'A', body: 'b', customer: generated, output: 'sms' })).statusCode).toBe(404);
    expect(JSON.stringify((await h.review(made.token)).json())).not.toContain('Edited');
  });

  it('rule 1: a link to version N keeps showing version N after the document changes, and says a newer one exists', async () => {
    const id = await h.duplicate(CARD, 'Review link versions');
    const v1 = await h.project(id);
    const made = (await h.makeLink(id, { version: v1.modelVersion, customers: ['CARD-0001'] })).json();
    expect(made.link.target).toMatchObject({ kind: 'version', version: v1.modelVersion });
    const before = (await h.review(made.token, '/output?customer=CARD-0001&output=html')).json().html as string;
    const firstPart = v1.contentParts.find((c: any) => before.includes(c.approvedLocales['en-US']?.slice(0, 30) ?? '\u0000'));
    expect(firstPart).toBeTruthy();
    const v2 = await h.save(id, (p) => { p.title = 'Renamed after the link'; p.contentParts.find((c: any) => c.id === firstPart.id).approvedLocales['en-US'] = 'WORDING CHANGED AFTER THE LINK WAS MADE'; });
    expect(v2.modelVersion).toBe(v1.modelVersion + 1);
    const s = (await h.review(made.token)).json();
    expect(s.document.title).toBe(v1.title);
    expect(s.version).toMatchObject({ kind: 'version', version: v1.modelVersion });
    expect(s.newerExists).toBe(true);
    expect(JSON.stringify(s)).not.toContain('Renamed after the link');
    const after = (await h.review(made.token, '/output?customer=CARD-0001&output=html')).json().html as string;
    expect(after).not.toContain('WORDING CHANGED AFTER THE LINK WAS MADE');
    expect(after).toBe(before);
    // A release link says so once a later release exists.
    const r1 = await h.approve(id);
    const relLink = (await h.makeLink(id, { releaseId: r1.id, customers: ['CARD-0001'] })).json();
    expect((await h.review(relLink.token)).json().newerExists).toBe(false);
    await h.save(id, (p) => { p.title = 'Second release'; });
    await h.approve(id);
    expect((await h.review(relLink.token)).json().newerExists).toBe(true);
    // Rule 6: withdrawing the release does not revoke the link, but the page says it was withdrawn.
    expect((await h.inj('POST', `/api/v1/releases/${r1.id}/withdraw`, { stage: 'test', reason: 'Wrong wording' })).statusCode).toBeLessThan(300);
    const w = await h.review(relLink.token);
    expect(w.statusCode).toBe(200);
    expect(w.json().withdrawn).toBe(true);
    // Rule 6: deleting the document revokes its links.
    expect((await h.inj('DELETE', `/api/v1/projects/${id}`)).statusCode).toBe(200);
    for (const t of [made.token, relLink.token]) expect((await h.review(t)).json().error).toMatchObject({ code: 'REVIEW_LINK_NOT_AVAILABLE', message: DEAD });
  });

  it('rule 3: draft translations are never shown, and a language with drafts only cannot be chosen', async () => {
    const id = await h.duplicate(CARD, 'Review link drafts');
    const saved = await h.save(id, (p) => {
      for (const c of p.contentParts) {
        if (c.approvedLocales['es-US']) c.draftLocales = { ...(c.draftLocales ?? {}), 'es-US': `DRAFTMARK ${c.id}` };
        c.draftLocales = { ...(c.draftLocales ?? {}), 'fr-FR': `BROUILLON ${c.id}` };
      }
      p.languages = ['es-US', 'fr-FR'];
    });
    const opts = await h.json('GET', `/api/v1/projects/${id}/review-links/options?version=${saved.modelVersion}`);
    expect(opts.languages.map((l: any) => l.code)).toEqual(['en-US', 'es-US']);
    expect((await h.makeLink(id, { version: saved.modelVersion, customers: ['CARD-0001'], languages: ['fr-FR'] })).json().error.code).toBe('INVALID_LANGUAGES');
    const made = (await h.makeLink(id, { version: saved.modelVersion, customers: ['CARD-0001'] })).json();
    expect(made.link.languages).toEqual(['en-US', 'es-US']);
    for (const output of ['html', 'email', 'sms']) {
      const r = (await h.review(made.token, `/output?customer=CARD-0001&output=${output}&language=es-US`)).json();
      const text = JSON.stringify(r);
      expect(text).not.toContain('DRAFTMARK');
      expect(text).not.toContain('BROUILLON');
    }
    const es = (await h.review(made.token, '/output?customer=CARD-0001&output=html&language=es-US')).json().html as string;
    const approvedEs = saved.contentParts.map((c: any) => c.approvedLocales['es-US']).filter(Boolean).map((t: string) => t.slice(0, 20));
    expect(approvedEs.some((t: string) => es.includes(t)) || es.includes('lang="es')).toBe(true);
    await h.inj('DELETE', `/api/v1/projects/${id}`);
  });

  it('rules 9 and 11: comments are stored on the version, marked as from the link, and the studio can answer and resolve them', async () => {
    const s = (await h.review(token)).json();
    const part = s.parts[1];
    const r = await h.comment(token, { name: '  Jordan   Reviewer ', body: 'The fee line is hard to read.', customer: 'CARD-0002', output: 'pdf', language: 'en-US', part: part.key });
    expect(r.statusCode, r.body).toBe(201);
    const c = r.json().comment;
    expect(c).toMatchObject({ author: 'Jordan Reviewer (review link: Marketing check)', body: 'The fee line is hard to read.', part: part.name, customer: { key: 'CARD-0002' }, output: { id: 'pdf' }, resolved: false });
    // In the studio: a review comment on the link's version, marked as from the link, never as a user.
    const studio = await h.json('GET', `/api/v1/projects/${CARD}/comments`);
    const mine = studio.comments.find((x: any) => x.id === c.id);
    expect(mine).toMatchObject({ authorName: 'Jordan Reviewer (review link: Marketing check)', author: `review-link:${linkId}`, modelVersion: release.modelVersion, mine: false, parentId: null, reviewLink: { linkId, label: 'Marketing check', recordId: 'CARD-0002', output: 'pdf', locale: 'en-US', status: 'active' } });
    // Whole-document comments are allowed too, and an unknown part is refused.
    expect((await h.comment(token, { name: 'Jordan', body: 'Overall fine.', customer: 'CARD-0001', output: 'html' })).json().comment.part).toBeNull();
    expect((await h.comment(token, { name: 'Jordan', body: 'x', customer: 'CARD-0001', output: 'html', part: 'payment-guidance' })).json().error.code).toBe('UNKNOWN_PART');
    // The studio answers and resolves it; the link holder sees both.
    const reply = await h.inj('POST', `/api/v1/projects/${CARD}/comments`, { parentId: c.id, body: 'Thanks, we will enlarge it.' });
    expect(reply.statusCode).toBe(201);
    expect((await h.inj('POST', `/api/v1/projects/${CARD}/comments/${c.id}/resolve`, { resolved: true })).statusCode).toBe(200);
    const seen = (await h.review(token, '/comments')).json().comments.find((x: any) => x.id === c.id);
    expect(seen.resolved).toBe(true);
    expect(seen.replies).toEqual([expect.objectContaining({ body: 'Thanks, we will enlarge it.', fromStudio: true })]);
    // Rule 11: opens and comments are counted on the list; the activity log has the events with ids and counts only.
    const l = (await h.json('GET', `/api/v1/projects/${CARD}/review-links`)).links.find((x: any) => x.id === linkId);
    expect(l.opens).toBeGreaterThan(0);
    expect(l.lastOpenedAt).toBeTruthy();
    expect(l.comments).toBeGreaterThanOrEqual(3);
    const audit = (await h.json('GET', `/api/v1/audit?projectId=${CARD}&action=review-link.&limit=500`)).events;
    const actions = new Set(audit.map((e: any) => e.action));
    for (const a of ['review-link.create', 'review-link.revoke', 'review-link.open', 'review-link.comment']) expect(actions, a).toContain(a);
    expect(audit.filter((e: any) => e.action === 'review-link.open' && e.detail.linkId === linkId)).toHaveLength(1);
    const made = audit.find((e: any) => e.action === 'review-link.create' && e.detail.linkId === linkId);
    expect(made).toMatchObject({ userName: 'Local admin', modelVersion: release.modelVersion, detail: { target: 'release', releaseNumber: release.number, customers: 2, expiresInDays: 7 } });
    const got = audit.find((e: any) => e.action === 'review-link.comment' && e.detail.commentId === c.id);
    expect(got).toMatchObject({ user: null, userName: 'Review link', detail: { linkId, recordId: 'CARD-0002', output: 'pdf', length: 29 } });
    // Never the token, the label, the typed name, the text or a customer's name.
    const all = JSON.stringify((ctx.store as any).db.prepare('SELECT * FROM audit').all());
    for (const banned of [token, 'Marketing check', 'Jordan', 'fee line', 'hard to read']) expect(all, banned).not.toContain(banned);
    const names = (await h.review(token)).json().customers.map((x: any) => x.name);
    for (const n of names) expect(all, n).not.toContain(n);
  });

  it('rule 9: a link holder sees only the comments made through the same link, and never internal comments', async () => {
    const other = (await h.makeLink(CARD, { releaseId: release.id, label: 'Other team', customers: ['CARD-0001'] })).json();
    const a = (await h.comment(token, { name: 'Ana', body: 'From link A', customer: 'CARD-0001', output: 'sms' })).json().comment;
    const b = (await h.comment(other.token, { name: 'Ben', body: 'From link B', customer: 'CARD-0001', output: 'sms' })).json().comment;
    const p = await h.project(CARD);
    expect((await h.inj('POST', `/api/v1/projects/${CARD}/comments`, { nodeId: p.nodes[1].id, body: 'Internal studio note' })).statusCode).toBe(201);
    expect((await h.inj('POST', `/api/v1/projects/${CARD}/comments`, { parentId: b.id, body: 'Reply to B only' })).statusCode).toBe(201);
    const seenA = JSON.stringify((await h.review(token, '/comments')).json());
    const seenB = JSON.stringify((await h.review(other.token, '/comments')).json());
    expect(seenA).toContain('From link A');
    expect(seenA).not.toContain('From link B');
    expect(seenA).not.toContain('Reply to B only');
    expect(seenA).not.toContain('Internal studio note');
    expect(seenB).toContain('From link B');
    expect(seenB).toContain('Reply to B only');
    expect(seenB).not.toContain('From link A');
    expect(seenB).not.toContain('Internal studio note');
    expect(a.id).not.toBe(b.id);
  });

  it('rule 9: names and comments are plain text, cleaned, and limited (name 80, comment 2,000)', async () => {
    const base = { customer: 'CARD-0001', output: 'sms' };
    expect((await h.comment(token, { ...base, name: '   ', body: 'x' })).json().error.code).toBe('NAME_REQUIRED');
    expect((await h.comment(token, { ...base, name: 'n'.repeat(81), body: 'x' })).json().error.code).toBe('NAME_TOO_LONG');
    expect((await h.comment(token, { ...base, name: 'n'.repeat(80), body: 'x' })).statusCode).toBe(201);
    expect((await h.comment(token, { ...base, name: 'Pat', body: '  ' })).json().error.code).toBe('EMPTY_COMMENT');
    expect((await h.comment(token, { ...base, name: 'Pat', body: 'b'.repeat(2001) })).json().error.code).toBe('COMMENT_TOO_LONG');
    expect((await h.comment(token, { ...base, name: 'Pat', body: 'b'.repeat(2000) })).statusCode).toBe(201);
    const r = (await h.comment(token, { ...base, name: 'Pat‮\u0007', body: '<script>alert(1)</script>‮hello' })).json().comment;
    expect(r.author).toBe('Pat (review link: Marketing check)');
    expect(r.body).toBe('<script>alert(1)</script>hello'); // stored and shown as text, never as HTML
  });

  it('rule 10: at most 30 comments an hour and 200 in all per link', async () => {
    const t = (await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001'] })).json();
    const base = { name: 'Rate', customer: 'CARD-0001', output: 'sms' };
    for (let i = 0; i < REVIEW_LINK_LIMITS.commentsPerHour; i++) expect((await h.comment(t.token, { ...base, body: `c${i}` })).statusCode).toBe(201);
    const over = await h.comment(t.token, { ...base, body: 'one too many' });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('COMMENT_RATE');
    // Older comments count towards the total: 200 in all.
    const db = (ctx.store as any).db;
    db.prepare('UPDATE review_link_comments SET created_at=? WHERE link_id=?').run(new Date(Date.now() - 2 * 3600e3).toISOString(), t.link.id);
    const st = db.prepare('INSERT INTO review_link_comments(comment_id,link_id,record_id,output,locale,created_at) VALUES (?,?,?,?,?,?)');
    for (let i = REVIEW_LINK_LIMITS.commentsPerHour; i < REVIEW_LINK_LIMITS.commentsTotal - 1; i++) st.run(`cmt-old-${i}`, t.link.id, 'CARD-0001', 'sms', 'en-US', new Date(Date.now() - 3 * 3600e3).toISOString());
    expect((await h.comment(t.token, { ...base, body: 'the 200th' })).statusCode).toBe(201);
    const full = await h.comment(t.token, { ...base, body: 'the 201st' });
    expect(full.statusCode).toBe(429);
    expect(full.json().error.code).toBe('COMMENT_LIMIT');
  });

  it('rule 10: output requests are limited to 120 a minute per link', async () => {
    const t = (await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001'], outputs: ['sms'] })).json();
    for (let i = 0; i < REVIEW_LINK_LIMITS.outputsPerMinute; i++) expect((await h.review(t.token, '/output?customer=CARD-0001&output=sms')).statusCode).toBe(200);
    const over = await h.review(t.token, '/output?customer=CARD-0001&output=sms');
    expect(over.statusCode).toBe(429);
    expect((await h.review(t.token, '/pdf?customer=CARD-0001')).json().error.code).toBe('OUTPUT_NOT_AVAILABLE');
    // Another link is not affected.
    expect((await h.review(token, '/output?customer=CARD-0001&output=sms')).statusCode).toBe(200);
  });

  it('rules 2, 3, 5 and 10: what a new link may hold', async () => {
    const twelve = Array.from({ length: 13 }, (_, i) => `CARD-${String(i + 1).padStart(4, '0')}`);
    const make = (body: Record<string, unknown>) => h.makeLink(CARD, { releaseId: release.id, ...body });
    expect((await make({ customers: [] })).json().error.code).toBe('INVALID_CUSTOMERS');
    expect((await make({ customers: twelve })).json().error.code).toBe('INVALID_CUSTOMERS');
    expect((await make({ customers: ['CARD-0001', 'CARD-0001'] })).json().error.code).toBe('INVALID_CUSTOMERS');
    expect((await make({ customers: ['CARD-9999'] })).json().error.code).toBe('UNKNOWN_CUSTOMER');
    expect((await make({ customers: ['CARD-0001'], outputs: [] })).json().error.code).toBe('INVALID_OUTPUTS');
    expect((await make({ customers: ['CARD-0001'], outputs: ['afp'] })).json().error.code).toBe('INVALID_OUTPUTS');
    for (const d of [0, 31, 'never', 1.5, -1]) expect((await make({ customers: ['CARD-0001'], expiresInDays: d })).json().error.code).toBe('INVALID_EXPIRY');
    const one = (await make({ customers: ['CARD-0001'], expiresInDays: 1 })).json().link;
    expect(Date.parse(one.expiresAt) - Date.parse(one.createdAt)).toBe(86400_000);
    const thirty = (await make({ customers: twelve.slice(0, 12), expiresInDays: 30 })).json().link;
    expect(Date.parse(thirty.expiresAt) - Date.parse(thirty.createdAt)).toBe(30 * 86400_000);
    expect((await make({ customers: ['CARD-0001'], label: 'L'.repeat(81) })).json().error.code).toBe('LABEL_TOO_LONG');
    expect((await h.makeLink(CARD, { customers: ['CARD-0001'] })).json().error.code).toBe('TARGET_REQUIRED');
    expect((await h.makeLink(CARD, { releaseId: 'harborcare-demo-r1', customers: ['CARD-0001'] })).statusCode).toBe(404);
    expect((await h.makeLink(CARD, { version: 999, customers: ['CARD-0001'] })).statusCode).toBe(404);
    // At most 20 active links per document (expired and revoked ones do not count).
    const id = await h.duplicate(CARD, 'Review link count');
    const v = (await h.project(id)).modelVersion;
    for (let i = 0; i < REVIEW_LINK_LIMITS.activePerDocument; i++) expect((await h.makeLink(id, { version: v, customers: ['CARD-0001'] })).statusCode).toBe(201);
    const full = await h.makeLink(id, { version: v, customers: ['CARD-0001'] });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('TOO_MANY_LINKS');
    const first = (await h.json('GET', `/api/v1/projects/${id}/review-links`)).links[0];
    await h.inj('POST', `/api/v1/projects/${id}/review-links/${first.id}/revoke`);
    expect((await h.makeLink(id, { version: v, customers: ['CARD-0001'] })).statusCode).toBe(201);
    await h.inj('DELETE', `/api/v1/projects/${id}`);
  });

  it('rule 11: no IP address or browser detail is stored', async () => {
    const extra = { remoteAddress: '203.0.113.77', headers: { 'user-agent': 'UniqueReviewAgent/9.9 (ZZTop)', 'x-forwarded-for': '198.51.100.23' } };
    const r1 = await ctx.app.inject({ method: 'GET', url: `/api/v1/review/${token}`, ...extra });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({ method: 'POST', url: `/api/v1/review/${token}/comments`, payload: { name: 'Ida', body: 'IP check', customer: 'CARD-0001', output: 'sms' }, ...extra });
    expect(r2.statusCode).toBe(201);
    const text = dbText(ctx);
    for (const banned of ['203.0.113.77', '198.51.100.23', 'UniqueReviewAgent', 'ZZTop']) expect(text).not.toContain(banned);
    // Nor in any file the studio writes.
    const dir = (ctx.store as any).artifactDir as string;
    for (const f of readdirSync(dir)) expect(readFileSync(path.join(dir, f)).toString('latin1')).not.toContain('UniqueReviewAgent');
  });
});

describe('review links (sign-in on: roles, and a token is accepted nowhere else)', () => {
  let ctx: Ctx;
  const h = helpers(() => ctx);
  const saved = { AUTH: process.env.AUTH, ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  const cookies: Record<string, string> = {};
  const as = (who: string) => ({ cookie: cookies[who] });
  let release: { id: string; number: number; modelVersion: number };
  let token = '';

  beforeAll(async () => {
    process.env.ADMIN_EMAIL = 'admin@example.test';
    process.env.ADMIN_PASSWORD = 'correct horse battery';
    ctx = await buildApp({ dataDir: tmp(), logger: false, auth: true, extraSamples: false, releasePackage: { composer: stubComposer() } });
    const login = async (email: string, password: string) => String([(await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } })).headers['set-cookie']].flat()[0]).split(';')[0];
    cookies.admin = await login('admin@example.test', 'correct horse battery');
    for (const role of ['author', 'reviewer', 'approver'] as const) {
      for (const n of ['', '2']) {
        const r = await h.inj('POST', '/api/v1/users', { email: `${role}${n}@example.test`, name: `${role} ${n}`.trim(), role, password: 'a long password' }, as('admin'));
        expect(r.statusCode).toBe(201);
        cookies[`${role}${n}`] = await login(`${role}${n}@example.test`, 'a long password');
      }
    }
    await h.makeCardApprovable(as('admin'));
    release = await h.approve(CARD, as('admin'));
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('roles: author, reviewer, approver and admin can make a link; the list needs a session', async () => {
    for (const who of ['author', 'reviewer', 'approver', 'admin']) {
      const r = await h.makeLink(CARD, { releaseId: release.id, label: `By ${who}`, customers: ['CARD-0001'] }, as(who));
      expect(r.statusCode, `${who} ${r.body.slice(0, 200)}`).toBe(201);
      if (who === 'reviewer') token = r.json().token;
    }
    expect((await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001'] })).statusCode).toBe(401);
    expect((await h.inj('GET', `/api/v1/projects/${CARD}/review-links`)).statusCode).toBe(401);
    const list = await h.inj('GET', `/api/v1/projects/${CARD}/review-links`, undefined, as('reviewer2'));
    expect(list.statusCode).toBe(200);
    expect(list.json().links.find((l: any) => l.label === 'By author')).toMatchObject({ createdBy: { name: 'author' }, mayRevoke: false });
    expect(list.json().links.find((l: any) => l.label === 'By reviewer')).toMatchObject({ mayRevoke: false });
  });

  it('roles: a link is revoked by its creator, an approver or an admin, not by another author or reviewer', async () => {
    const mk = async (who: string) => (await h.makeLink(CARD, { releaseId: release.id, customers: ['CARD-0001'] }, as(who))).json().link.id as string;
    const revoke = (id: string, who: string) => h.inj('POST', `/api/v1/projects/${CARD}/review-links/${id}/revoke`, {}, as(who));
    const a = await mk('author');
    expect((await revoke(a, 'author2')).statusCode).toBe(403);
    expect((await revoke(a, 'reviewer')).statusCode).toBe(403);
    expect((await revoke(a, 'author')).statusCode).toBe(200);
    const r = await mk('reviewer');
    expect((await revoke(r, 'reviewer2')).statusCode).toBe(403);
    expect((await revoke(r, 'approver')).statusCode).toBe(200);
    const b = await mk('author');
    expect((await revoke(b, 'admin')).statusCode).toBe(200);
    expect((await revoke(b, 'admin')).json().alreadyRevoked).toBe(true);
  });

  it('the public routes work without a session; a reviewer answers and resolves a link comment', async () => {
    const s = await h.review(token);
    expect(s.statusCode).toBe(200);
    const c = (await h.comment(token, { name: 'Outside', body: 'Looks fine', customer: 'CARD-0001', output: 'html' })).json().comment;
    expect((await h.inj('POST', `/api/v1/projects/${CARD}/comments`, { parentId: c.id, body: 'Thanks' }, as('reviewer2'))).statusCode).toBe(201);
    expect((await h.inj('POST', `/api/v1/projects/${CARD}/comments/${c.id}/resolve`, { resolved: true }, as('author2'))).statusCode).toBe(200);
    const seen = (await h.review(token, '/comments')).json().comments.find((x: any) => x.id === c.id);
    expect(seen).toMatchObject({ resolved: true, replies: [expect.objectContaining({ body: 'Thanks', author: 'reviewer 2' })] });
  });

  it('rule 8: a token is refused on every non-review route, and never becomes a session', async () => {
    // Every route the API registers, read from its source files.
    const src = path.resolve(__dirname, '../src');
    const files = [...readdirSync(src).map((f) => path.join(src, f)), ...readdirSync(path.join(src, 'routes')).map((f) => path.join(src, 'routes', f))].filter((f) => f.endsWith('.ts'));
    const routes = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/app\.(get|post|put|patch|delete)(?:<[^(]*?>)?\(\s*'([^']+)'/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
    expect(routes.size).toBeGreaterThan(80);
    const publicRoutes = new Set(['GET /api/v1/health', 'GET /api/v1/session', 'POST /api/v1/auth/login', 'POST /api/v1/auth/logout']);
    const reviewRoutes = [...routes].filter((r) => r.includes('/api/v1/review/'));
    expect(reviewRoutes.sort()).toEqual(['GET /api/v1/review/:token', 'GET /api/v1/review/:token/comments', 'GET /api/v1/review/:token/output', 'GET /api/v1/review/:token/pdf', 'POST /api/v1/review/:token/comments']);
    const carriers = (t: string) => [
      { cookie: `iss_session=${t}` },
      { authorization: `Bearer ${t}` },
      { 'x-review-token': t, cookie: `iss_review=${t}` },
    ];
    let checked = 0;
    for (const r of routes) {
      if (publicRoutes.has(r) || r.includes('/api/v1/review/')) continue;
      const [method, pattern] = r.split(' ');
      const url = pattern.replace(/:([A-Za-z]+)/g, (_m, name) => (name === 'projectId' ? CARD : token)).replace(/\*$/, token);
      for (const headers of carriers(token)) {
        const res = await ctx.app.inject({ method: method as any, url: `${url}${url.includes('?') ? '&' : '?'}token=${token}`, headers, payload: method === 'GET' || method === 'DELETE' ? undefined : { token } });
        expect(res.statusCode, `${r} with ${Object.keys(headers).join('+')}`).toBe(401);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
    // The session route does not recognise it either, and the review routes set no cookie.
    const s = (await ctx.app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: `iss_session=${token}` } })).json();
    expect(s).toMatchObject({ authEnabled: true, user: null });
    expect((await h.review(token)).headers['set-cookie']).toBeUndefined();
    // A session cookie does not widen what a review route shows.
    const withSession = (await ctx.app.inject({ method: 'GET', url: `/api/v1/review/${token}`, headers: as('admin') })).json();
    const without = (await h.review(token)).json();
    expect(Object.keys(withSession).sort()).toEqual(Object.keys(without).sort());
  });
});
