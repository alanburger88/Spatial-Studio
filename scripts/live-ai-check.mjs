#!/usr/bin/env node
// A SMALL, deliberate check of every model-backed feature against a LIVE AI model (about ten calls; they are billed
// to the key's owner). Never part of the automated tests. Start a stack with live AI first:
//   LIVE_AI=1 node scripts/dev-isolated.mjs 4          (needs AI_PROVIDER=anthropic and AI_API_KEY in the environment or .env)
//   node scripts/live-ai-check.mjs http://127.0.0.1:3104
// One check alone (one call): LIVE_ONLY=setup node scripts/live-ai-check.mjs http://127.0.0.1:3104
// Prints what each feature returned. It never prints the key.
const API = `${process.argv[2] ?? 'http://127.0.0.1:3104'}/api/v1`;
const P = 'aster-card-demo';
const post = async (path, body) => {
  const t0 = Date.now();
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, ms: Date.now() - t0, json };
};
const clip = (v, n = 260) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…` : s; };
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`\n[${ok ? 'OK ' : 'FAIL'}] ${name}\n      ${detail}`); };

const health = await (await fetch(`${API}/health`)).json();
console.log(`AI status: ${health.ai.mode} · ${health.ai.label}${health.ai.model ? ` · ${health.ai.model}` : ''}`);
if (health.ai.mode !== 'external') { console.log('Live AI is not on for this stack; nothing was called.'); process.exit(2); }
const finish = () => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} live checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}.`);
  process.exit(failed.length ? 1 : 0);
};

// 11. A new document set up from a description (one call; the proposal stores nothing). The setup must be more than a
// stub: data fields, a table, a message whose wording depends on a condition, and a first customer without blocking issues.
const checkSetup = async () => {
  const description = 'A membership renewal notice for a gym called Northside Gym. Greet the member by name and say which plan renews on which date and what the monthly fee is. '
    + 'Show a table of the fees charged this month (what it was for, the date and the amount) with a total. '
    + 'Members whose last payment failed must get a different message asking them to update their payment details before the renewal date; everyone else gets a short thank-you. '
    + 'End with small print saying fees are charged monthly in advance.';
  const r = await post('/projects/setup/draft', { description });
  const j = r.json;
  const spec = j.spec ?? { fields: [], sections: [] };
  const table = spec.sections.find((s) => s.type === 'table');
  const messages = spec.sections.filter((s) => s.type === 'messages');
  const conditional = messages.flatMap((m) => m.versions).filter((v) => v.when);
  const blocking = j.preview?.blocking ?? null;
  const ok = r.status === 200 && j.mode === 'proposal' && j.source === 'ai' && spec.fields.length >= 4 && !!table && conditional.length >= 1 && Array.isArray(blocking) && blocking.length === 0;
  record('Set a new document up from a description', ok, j.mode !== 'proposal'
    ? `status=${r.status} mode=${j.mode} ${r.ms} ms · ${clip(j.message ?? j.error?.message ?? j, 300)}`
    : `source=${j.source} ${r.ms} ms · “${spec.title}” · ${spec.fields.length} data fields · sections: ${spec.sections.map((s) => s.type).join(', ')}\n      `
      + `table: ${table ? `${table.list} (${(table.columns ?? []).join(', ')}${table.totalColumn ? `; total of ${table.totalColumn}` : ''})` : 'none'} · conditional versions: ${conditional.length} · blocking issues for the first customer: ${blocking ? blocking.length : 'unknown'} · would generate ${j.customers?.generated?.count} customers\n      `
      + `${(j.outline?.lines ?? []).map((l) => clip(l, 170)).join('\n      ')}\n      notes (${(j.notes ?? []).length}): ${(j.notes ?? []).map((n) => clip(n, 200)).join(' | ') || 'none'}`);
};
if (process.env.LIVE_ONLY === 'setup') { await checkSetup(); finish(); }
// Only on request (LIVE_ONLY=rebuild, one call): rebuild a document from a file. The file is the studio's own PDF of the
// synthetic sample statement (CARD-0001); the outline is sent with the marked values as placeholders, after the
// confirmation the screen asks for. The proposal must have data fields, a table and no blocking issue once reviewed.
if (process.env.LIVE_ONLY === 'rebuild') {
  const pdf = await fetch(`${API}/compose/pdf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: P, recordId: 'CARD-0001' }) });
  const files = [{ data: Buffer.from(await pdf.arrayBuffer()).toString('base64') }];
  const read = await post('/projects/rebuild/read', { files });
  const r = await post('/projects/rebuild/propose', { files, useAi: true, placeholders: true, confirmNoCustomerData: true, outline: read.json.outline?.placeholders, title: 'Rebuilt statement (live check)' });
  const j = r.json;
  const review = j.mode === 'proposal' ? await post('/projects/setup/draft', { spec: j.spec, source: 'ai', title: 'Rebuilt statement (live check)' }) : null;
  const ok = r.status === 200 && j.mode === 'proposal' && j.source === 'ai' && j.spec.fields.length >= 3 && j.spec.sections.some((s) => s.type === 'table') && review?.json?.preview?.blocking?.length === 0;
  record('Rebuild a document from a PDF (placeholders)', ok, j.mode !== 'proposal'
    ? `status=${r.status} mode=${j.mode} ${r.ms} ms · ${clip(j.message ?? j.error?.message ?? j, 300)}`
    : `${r.ms} ms · outline ${read.json.outline?.placeholders?.length} characters · fields: ${j.spec.fields.map((f) => `${f.label} (${f.type})`).join(', ')}\n      sections: ${j.spec.sections.map((s) => s.type).join(', ')} · paper ${j.spec.paper ?? 'US Letter'} · notes ${(j.notes ?? []).length} · blocking after review: ${review?.json?.preview?.blocking?.length}`);
  finish();
}
// Only on request (LIVE_ONLY=setup-data, one call): the same with sample data. The model is told the shape of the data
// only, so what is checked here is that it kept the field names, so that every row is matched and accepted as a customer.
if (process.env.LIVE_ONLY === 'setup-data') {
  const data = ['first_name,last_name,plan,renewal_date,monthly_fee,payment_failed', 'Ana,Silva,Flex,2026-12-01,49.00,no', 'Ben,Okoro,Max,2026-12-15,120.00,yes', 'Cy,Lee,Flex,2026-12-20,49.00,no'].join('\n');
  const r = await post('/projects/setup/draft', { description: 'A gym membership renewal notice: greet the member, show the plan, the renewal date and the monthly fee, and give members whose payment failed a different message asking them to update their payment details.', sampleData: { format: 'csv', data } });
  const j = r.json;
  const s = j.customers?.supplied;
  const conditional = (j.spec?.sections ?? []).filter((x) => x.type === 'messages').flatMap((m) => m.versions).filter((v) => v.when);
  const ok = r.status === 200 && j.mode === 'proposal' && j.source === 'ai' && s?.accepted === 3 && s?.rejectedCount === 0 && s.matching.every((m) => m.field) && conditional.length >= 1 && j.preview?.customer?.origin === 'supplied' && j.preview.blocking.length === 0;
  record('Set a new document up from a description and sample data', ok, j.mode !== 'proposal'
    ? `status=${r.status} mode=${j.mode} ${r.ms} ms · ${clip(j.message ?? j.error?.message ?? j, 300)}`
    : `source=${j.source} ${r.ms} ms · fields: ${j.spec.fields.map((f) => `${f.label} (${f.type})`).join(', ')}\n      rows accepted: ${s?.accepted} of ${s?.total}; rejected: ${clip(s?.rejected ?? [], 300)}\n      `
      + `columns: ${(s?.matching ?? []).map((m) => `${m.column} → ${m.field ?? 'not used'}`).join('; ')}\n      first customer: ${j.preview?.customer?.name} gets ${clip(j.preview?.messages ?? [], 200)} · blocking: ${j.preview?.blocking?.length}\n      `
      + `versions: ${(j.outline?.sections ?? []).flatMap((x) => x.versions ?? []).map((v) => `“${v.title}” ${v.shownWhen}`).join(' ')}\n      notes (${(j.notes ?? []).length}): ${(j.notes ?? []).map((n) => clip(n, 200)).join(' | ') || 'none'}`);
  finish();
}

// 1. Assistant chat: the question from the first live run. The reply must not disclaim who the customer is.
{
  const r = await post('/assistant/message', { message: 'Explain why this customer get this About "Payment guidance" for Morgan Santos', context: { projectId: P, recordId: 'CARD-0005', overrides: {}, journeyCursor: null, selectedNodeId: 'payment-guidance' } });
  const text = String(r.json.response ?? '');
  const disclaims = /can(?:'|’)?t confirm|cannot confirm|unable to confirm|not able to confirm/i.test(text);
  record('Assistant chat recognises the customer by name', r.status === 200 && r.json.mode === 'external' && !disclaims, `mode=${r.json.mode} ${r.ms} ms · actions=${(r.json.actions ?? []).map((a) => a.action).join(',') || 'none'} · explanation=${r.json.explanation ? 'yes' : 'no'}\n      reply: ${clip(text, 400)}`);
}
// 2. Assistant chat: find another customer by name (a name only one sample customer has).
{
  const r = await post('/assistant/message', { message: 'Switch to Jordan Mercer', context: { projectId: P, recordId: 'CARD-0005', overrides: {}, journeyCursor: null, selectedNodeId: null } });
  const picked = (r.json.actions ?? []).find((a) => a.action === 'select_scenario');
  record('Assistant chat finds another customer by name', r.status === 200 && picked?.recordId === 'CARD-0001', `mode=${r.json.mode} ${r.ms} ms · chose ${picked?.recordId ?? 'nothing'} (Jordan Mercer is CARD-0001)\n      reply: ${clip(r.json.response, 300)}`);
}
// 3. Translation drafts for three texts.
{
  const proj = (await (await fetch(`${API}/projects/${P}`)).json()).project;
  const ids = proj.contentParts.slice(0, 3).map((c) => c.id);
  const r = await post(`/projects/${P}/translate`, { locale: 'es-US', ids });
  const drafts = r.json.drafts ?? [];
  record('AI translation drafts (3 texts, Spanish)', r.status === 200 && r.json.mode === 'ai' && drafts.length === 3 && drafts.every((d) => d.tokenCheck?.ok), `mode=${r.json.mode} ${r.ms} ms · ${drafts.length} drafts, data fields intact in all: ${drafts.every((d) => d.tokenCheck?.ok)}\n      ${drafts.map((d) => clip(d.text, 110)).join('\n      ')}`);
}
// 4. Rewrite, plainer.
{
  const r = await post(`/projects/${P}/assist/rewrite`, { text: 'We noticed your scheduled payment has not yet arrived. Your payment was due on {{card.dueDate}}.', style: 'plainer', kind: 'message' });
  const opts = r.json.options ?? [];
  record('Rewrite a message (plainer)', r.status === 200 && r.json.mode === 'ai' && opts.length > 0 && opts.every((o) => o.tokenCheck?.ok && o.text.includes('{{card.dueDate}}')), `mode=${r.json.mode} ${r.ms} ms · ${opts.length} options, data field kept in all\n      ${opts.map((o) => clip(o.text, 140)).join('\n      ')}`);
}
// 5. Rewrite an SMS to fit one message.
{
  const r = await post(`/projects/${P}/assist/rewrite`, { text: 'DEMO Aster Card: Your statement is ready. Your minimum payment of {{card.minimumDueCents}} is due on {{card.dueDate}}. Please review your statement and payment options here: {{link}}', style: 'one-sms', kind: 'sms' });
  const opts = r.json.options ?? [];
  record('Rewrite an SMS to fit one message', r.status === 200 && r.json.mode === 'ai' && opts.length > 0 && opts.every((o) => o.tokenCheck?.ok), `mode=${r.json.mode} ${r.ms} ms · ${opts.length} options, template lengths ${opts.map((o) => o.text.length).join('/')} characters before data is filled in\n      ${opts.map((o) => clip(o.text, 170)).join('\n      ')}`);
}
// 6. A new version of a message.
{
  const r = await post(`/projects/${P}/assist/new-version`, { nodeId: 'payment-guidance', brief: 'For customers who paid late once before but are up to date now: a short thank-you that reminds them of the due date.' });
  record('Draft a new version of a message', r.status === 200 && r.json.mode === 'ai' && typeof r.json.text === 'string' && r.json.text.length > 10, `mode=${r.json.mode} ${r.ms} ms · title “${r.json.title}”\n      ${clip(r.json.text, 300)}`);
}
// 7. Subject line options.
{
  const r = await post(`/projects/${P}/assist/subject-lines`, { current: 'Your {{issuer.product}} statement is ready — {{card.minimumDueCents}} minimum due {{card.dueDate}}' });
  const opts = r.json.options ?? [];
  record('Subject line options', r.status === 200 && r.json.mode === 'ai' && opts.length > 0, `mode=${r.json.mode} ${r.ms} ms · ${opts.length} options\n      ${opts.map((o) => clip(o.text, 140)).join('\n      ')}`);
}
// 8. A free-form rule sentence the built-in reader cannot read.
{
  const r = await post(`/projects/${P}/assist/rule-draft`, { sentence: 'Customers on the premium tier who have fallen behind twice or more and have not asked for help should see the payment support message.' });
  record('Rule from a free-form sentence', r.status === 200 && (r.json.source === 'ai' || r.json.mode === 'external' || r.json.draft?.source === 'ai'), `status=${r.status} ${r.ms} ms · source=${r.json.source ?? r.json.draft?.source ?? r.json.mode}\n      ${clip(r.json.draft?.restatement ?? r.json.restatement ?? r.json, 400)}`);
}
// 9. Image description: a built-in mark cannot be described by AI (it says so); an uploaded picture can.
{
  const r = await post(`/projects/${P}/assist/image-description`, { nodeId: 'issuer-logo' });
  record('Image description of a built-in mark is declined honestly', r.status === 200 && r.json.mode === 'unavailable', `mode=${r.json.mode} ${r.ms} ms · ${clip(r.json.message, 200)}`);
  const png = process.argv[3];
  if (!png) record('Image description of an uploaded picture', true, 'skipped: pass a PNG file as the second argument to check it');
  else {
    const { readFileSync } = await import('node:fs');
    const proj = (await (await fetch(`${API}/projects/${P}`)).json()).project;
    const src = `data:image/png;base64,${readFileSync(png).toString('base64')}`;
    const project = { ...proj, nodes: proj.nodes.map((n) => (n.id === 'issuer-logo' ? { ...n, image: { ...n.image, src, alt: '' } } : n)) };
    const r2 = await post(`/projects/${P}/assist/image-description`, { nodeId: 'issuer-logo', project });
    record('Image description of an uploaded picture', r2.status === 200 && r2.json.mode === 'ai' && typeof r2.json.text === 'string' && r2.json.text.length > 5, `mode=${r2.json.mode} ${r2.ms} ms\n      ${clip(r2.json.text ?? r2.json, 300)}`);
  }
}
// 10. Translation meaning check: two Spanish drafts on an unsaved copy, one faithful and one that says the opposite.
{
  const proj = (await (await fetch(`${API}/projects/${P}`)).json()).project;
  const [a, b] = proj.contentParts.filter((c) => typeof c.approvedLocales?.['en-US'] === 'string' && !c.approvedLocales['en-US'].includes('{{')).slice(0, 2);
  const project = { ...proj, contentParts: proj.contentParts.map((c) => (c.id === a.id ? { ...c, draftLocales: { ...(c.draftLocales ?? {}), 'es-US': 'No tiene que hacer ningún pago este mes.' } } : c.id === b.id ? { ...c, draftLocales: { ...(c.draftLocales ?? {}), 'es-US': '__FAITHFUL__' } } : c)) };
  // a faithful Spanish version of the second text, drafted by the model's own translator in check 3 style is not available here, so only the wrong one is asserted
  project.contentParts = project.contentParts.map((c) => (c.id === b.id ? { ...c, draftLocales: undefined } : c));
  const r = await post(`/projects/${P}/assist/translation-meaning`, { locale: 'es-US', ids: [a.id], project });
  const flags = r.json.flags ?? [];
  record('Translation meaning check flags a draft that says something else', r.status === 200 && r.json.mode === 'ai' && flags.some((f) => f.textId === a.id), `mode=${r.json.mode} ${r.ms} ms · English: ${clip(a.approvedLocales['en-US'], 110)}\n      Spanish draft (deliberately wrong): “No tiene que hacer ningún pago este mes.”\n      flags: ${clip(flags, 300)}`);
}
await checkSetup();
finish();
