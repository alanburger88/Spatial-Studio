// Generates release evidence from the RUNNING API (real composition, never copied samples):
// reports/evidence/exports/*.pdf|*.html and reports/evidence/manifests/*.json
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/api/v1';
const out = 'reports/evidence';
mkdirSync(`${out}/exports`, { recursive: true }); mkdirSync(`${out}/manifests`, { recursive: true });
const cases = JSON.parse(readFileSync('fixtures/expected_scenarios.json', 'utf8')).cases;
const post = (p, body) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
for (const id of ['aster-card-demo', 'harborcare-demo']) await post(`/projects/${id}/reset`, { confirm: true });
const jobs = [
  ['card-standard', 'aster-card-demo', 'CARD-0001', {}],
  ['card-assistance', 'aster-card-demo', 'CARD-0002', {}],
  ['card-250-rows', 'aster-card-demo', 'CARD-0001', cases['card-250-rows'].overrides],
  ['eob-covered', 'harborcare-demo', 'EOB-0001', {}],
  ['eob-under-review', 'harborcare-demo', 'EOB-0002', {}],
];
const summary = [];
for (const [name, projectId, recordId, overrides] of jobs) {
  const t0 = Date.now();
  const pdf = await post('/compose/pdf', { projectId, recordId, overrides, outputContext: { profileId: 'paged-pdf' } });
  const pdfMs = Date.now() - t0;
  if (!pdf.ok) throw new Error(`${name} pdf ${pdf.status} ${await pdf.text()}`);
  writeFileSync(`${out}/exports/${name}.pdf`, Buffer.from(await pdf.arrayBuffer()));
  const html = await post('/compose/html', { projectId, recordId, overrides, outputContext: { profileId: 'html-responsive' } });
  writeFileSync(`${out}/exports/${name}.html`, await html.text());
  const res = await (await post('/resolve', { projectId, recordId, overrides })).json();
  const pages = await (await post('/compose/pages', { projectId, recordId, overrides, verifyPdf: true })).json();
  const parity = await (await post('/parity', { projectId, recordId, overrides })).json();
  const afp = await (await post('/compose/afp-sim', { projectId, recordId, overrides })).json();
  const m = { name, projectId, recordId, runId: res.runId, contentDigest: res.contentDigest, rulesDigest: res.rulesDigest, modelVersion: res.modelVersion, engine: res.engineVersion,
    result: res.result, trace: res.trace.map((t) => ({ ruleId: t.ruleId, matched: t.matched, outcome: t.outcome, inputs: t.predicateInputs })),
    semanticManifest: res.semanticManifest, composition: { engine: pages.engine, pageCount: pages.pageCount, pdfPageCount: pages.pdfPageCount, pages: pages.pages, diagnostics: pages.diagnostics, durationMs: pages.durationMs },
    pdf: { file: `exports/${name}.pdf`, sha256: pdf.headers.get('x-sha256'), pageCount: Number(pdf.headers.get('x-page-count')), artifactId: pdf.headers.get('x-artifact-id'), wallMs: pdfMs },
    html: { file: `exports/${name}.html`, sha256: html.headers.get('x-sha256') }, parity: parity.report, afpSimulation: { simulationOnly: afp.simulationOnly, afpBytesGenerated: afp.afpBytesGenerated, label: afp.label, pageCount: afp.pageCount } };
  writeFileSync(`${out}/manifests/${name}.json`, JSON.stringify(m, null, 2));
  summary.push({ name, recordId, selected: res.result.selectedVariants, rules: res.result.matchedRuleIds.join(' '), pages: pages.pageCount, pdfPages: pages.pdfPageCount, parity: parity.report.ok, pdfMs });
  console.log(name, JSON.stringify(summary.at(-1)));
}
writeFileSync(`${out}/manifests/summary.json`, JSON.stringify(summary, null, 2));
