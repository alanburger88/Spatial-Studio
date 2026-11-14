import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOCUMENT_TYPE_LABEL, runtimePackageName, type Project, type ReleasePackageCheck, type RuntimePackageStatus } from '@iss/model';
import { proofRecordProblems } from '@iss/resolver';
import {
  CHANNELS, ENGINE_VERSIONS, RUNTIME_FORMAT, RUNTIME_FORMAT_VERSION, draftProblems, inputSchemaFromDictionary, outputFingerprints, parseInput, proofOf, render,
  type Dictionary, type LoadedRelease,
} from '@iss/runtime';
import { composerFiles, engineBundle, type EngineBundle } from '@iss/runtime/build';
import type { Store, StoredRelease } from './db';
import { releaseTemplate, type PackageComposer } from './releasePackage';
import { versionDrift, type ReleasePackages } from './releases';
import { ZIP_FIXED_DATE, zipEntries, zipFiles, zipRead } from './zip';

/**
 * The runnable package (phase 7 of the template work; design in docs/design/TEMPLATES_AND_CCM.md, format in
 * docs/design/RUNNABLE_PACKAGE.md): one ZIP per release that another system runs to produce the documents itself,
 * with the studio's own engine, instead of rebuilding the template.
 *
 * Rules this builder keeps, like the release package's:
 *  - A function of the release alone (its kept release package, which is itself a function of the release), the
 *    engine source and the pinned page composer. No file states when it was built.
 *  - Synthetic customers only: the proof pack is made from the release package's scenarios, which hold built-in
 *    sample customers and engine-generated ones only.
 *  - Approved content only: `release/` is the release package as it is, which carries approved wording only, and the
 *    engine refuses a template that carries drafts.
 *  - Once built, never replaced: building again only checks the result against the kept ZIP.
 */

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const escHtml = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RuntimeFile { path: string; sha256: string; bytes: number; role: string }
export interface BuiltRuntimePackage {
  fileName: string; folder: string; zip: Buffer; sha256: string; files: RuntimeFile[];
  engine: { version: string; sha256: string }; proofCases: number;
}
export interface RuntimeBuildOptions {
  /** The kept release package of this release (its ZIP). */
  releaseZip: Buffer;
  /** Composes the proof pack's PDFs to record their page counts. Tests replace it. */
  composer: PackageComposer;
  /** The engine to put in (defaults to the one bundled from this studio's source). */
  engine?: EngineBundle;
  onProgress?: (p: { step: string; done: number; total: number }) => void;
}

/* ------------------------------------------------------------------ small scripts at the top of the package */

const launcher = (command: string, what: string) => `#!/usr/bin/env node
// ${what}
// Usage: node ${command} --help. Everything is explained in README.html.
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
import(pathToFileURL(path.join(__dirname, 'engine', 'iss-engine.mjs')).href)
  .then((engine) => engine.main(['${command}', ...process.argv.slice(2)]))
  .then((code) => { process.exitCode = code; }, (e) => { console.error('The engine could not be started: ' + (e && e.message ? e.message : e)); process.exitCode = 70; });
`;

/* ------------------------------------------------------------------ container definition */

function dockerfile(folder: string, composerVersion: string): string {
  return `# A container that runs this runnable package with nothing else to install.
# Build it from the package folder (${folder}/):
#     docker build -f image/Dockerfile -t ${folder} .
# Run it (it listens on port 8787 inside the container; publish it to this machine only):
#     docker run --rm -p 127.0.0.1:8787:8787 ${folder}
#
# The base image is Microsoft's Playwright image for playwright-core ${composerVersion}, the page composer this package
# carries: it has Node.js and the matching Chromium. For a reproducible build, pin it by digest
# (docker pull, then FROM mcr.microsoft.com/playwright@sha256:...).
FROM mcr.microsoft.com/playwright:v${composerVersion}-noble

WORKDIR /package
COPY . /package
ENV NODE_ENV=production
USER pwuser

# The image is only built when the package verifies here: files untouched, browser and fonts present,
# every proof case the same as in the studio.
RUN node verify

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "serve", "--host", "0.0.0.0", "--port", "8787"]
`;
}

/* ------------------------------------------------------------------ README */

interface ReadmeFacts {
  /** Where the document's date comes from, when the template uses dates. */
  dated?: 'run' | 'field' | null;
  title: string; kind: string; number: number; approver: string | null; approvedAt: string; folder: string; fileName: string;
  engine: { version: string; sha256: string }; composerVersion: string; chromium: string | null;
  fonts: { use: string; family: string; stack: string }[]; referencePdfFonts: string[];
  languages: string[]; proof: { cases: number; produced: number; stopped: number; invalid: number };
}

function readmeHtml(a: ReadmeFacts): string {
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const code = (s: string) => `<pre><code>${escHtml(s)}</code></pre>`;
  const pdfFonts = a.referencePdfFonts.length ? a.referencePdfFonts.map(escHtml).join(', ') : 'not recorded';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(a.title)} — release ${a.number}, runnable package</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:880px;margin:32px auto;padding:0 20px;line-height:1.5}
h1{font-size:24px;margin-bottom:4px}h2{font-size:18px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}
code{background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:13px}pre{background:#f3f4f6;padding:10px 12px;border-radius:4px;overflow-x:auto}pre code{padding:0}
.lead{color:#4b5563}.note{background:#f9fafb;border-left:4px solid #9ca3af;padding:8px 12px}
</style>
</head>
<body>
<h1>${escHtml(a.title)} — release ${a.number}: runnable package</h1>
<p class="lead">${escHtml(a.kind)}. Approved${a.approver ? ` by ${escHtml(a.approver)}` : ''} on ${escHtml(a.approvedAt.slice(0, 10))}. Engine ${escHtml(a.engine.version)}. Package file: <code>${escHtml(a.fileName)}</code>.</p>

<h2>What this is</h2>
<p>This folder produces the documents of one approved release with the same engine InfoSlips Spatial Studio uses, so what you produce is exactly what was approved. You give it customer data as JSON and it gives you the PDF, the interactive web page, the email and the SMS for each customer, with a proof record for each document.</p>
<p class="note">It runs on your machine and makes no outbound connection. It never writes a customer's values to its console output, to <code>results.jsonl</code> or to <code>proof.jsonl</code>. The customers in its proof pack and samples are synthetic: built-in sample customers and customers the engine generated.</p>

<h2>What you need</h2>
<ul>
<li><strong>Node.js 22 or later.</strong> Nothing else for email, SMS and interactive HTML: no installation step, no internet access.</li>
<li><strong>For PDF: a headless Chromium and the document's fonts.</strong> The page composer (playwright-core ${escHtml(a.composerVersion)}) is inside <code>engine/</code>; the browser is not, because it is large and differs per operating system. Either set <code>CHROMIUM_PATH</code> to a Chromium or Chrome executable, or install the matching browser once with <code>node engine/node_modules/playwright-core/cli.js install chromium</code> (that command downloads it from the internet; this package never does so by itself). It was built and checked with Chromium ${escHtml(a.chromium ?? 'as pinned by playwright-core')}.</li>
<li><strong>Fonts for PDF.</strong> Font files are not included: none in the studio's source may be redistributed. Install the first font you are licensed for in each list below. <code>verify</code> fails until the font the studio used is installed.</li>
</ul>
<table>
<tr><th>Used for</th><th>Font</th><th>Fallbacks, in order</th></tr>
${a.fonts.map((f) => row([escHtml(f.use), escHtml(f.family), `<code>${escHtml(f.stack)}</code>`])).join('\n')}
</table>
<p>The studio's own reference PDFs of this release embed: ${pdfFonts}. Email and the interactive web page use the fonts of the reader's device and need nothing on yours.</p>

<h2>First: check this machine</h2>
${code('node verify')}
<p>It checks that no file was changed since the studio built the package, that the engine is the one built for this release, and that this machine produces exactly what the studio produced for every customer of the proof pack (${a.proof.cases} synthetic customers: ${a.proof.produced} produced, ${a.proof.stopped} stopped by a blocking issue, ${a.proof.invalid} with data the contract refuses), PDF included. It says what differs in plain words. The exit code is 0 only when nothing differs. Without a browser use <code>node verify --without-pdf</code>; it then says that PDF was not checked.</p>

<h2>Produce documents from a file</h2>
${code('node run --data customers.jsonl --outputs pdf,html,email,sms --out out')}
<p><code>customers.jsonl</code> has one customer per line, each line one JSON object: the customer record described in <code>contract/input.schema.json</code>, or <code>{"customerRef": "your reference", "data": { …the record… }}</code>. The reference is how you find the customer again in the results; it defaults to the record's <code>recordId</code>. <code>contract/sample-input.json</code> is one such line. <code>--outputs</code> defaults to <code>html,email,sms</code>. <code>--parallel</code> sets how many PDF pages are composed at the same time. A <code>.json</code> file holding one customer or a list of customers, such as <code>contract/sample-input.json</code>, is accepted too.</p>
<p>It writes, in the <code>out</code> folder (which must not hold an earlier run):</p>
<table>
<tr><th>File</th><th>What it holds</th></tr>
${row(['<code>documents/&lt;reference&gt;/</code>', '<code>document.pdf</code>, <code>document.html</code>, <code>email.html</code>, <code>email.txt</code>, <code>sms.txt</code> for each document produced.'])}
${row(['<code>results.jsonl</code>', 'One line per input line: <code>produced</code> with its files and run ID; <code>stopped</code> with the codes of the blocking issues; <code>invalid</code> with what does not match the contract (field names, never values); or <code>failed</code> with the reason.'])}
${row(['<code>proof.jsonl</code>', 'One proof record per document (format <code>proof-record/1</code>): the release, the engine, the run ID, which message each section showed and the rules that decided it, and fingerprints of the data and of every output. No customer values. With the same data again, the studio can confirm the document is exactly what was produced.'])}
${row(['<code>summary.json</code>', 'Counts and timing of the run.'])}
</table>
<p>A line that does not match the contract is reported and skipped; the run goes on. A document with a blocking issue is not produced, exactly as in the studio. Exit codes: 0 done (look at <code>results.jsonl</code>), 2 wrong arguments, 3 the package was changed or is incomplete, 4 PDF asked for but no browser, 5 some documents failed.</p>

${a.dated ? `<h2>The document’s date</h2>
<p>This template uses the document’s date: some of what it says depends on the day it is issued on (see “Dates” in <code>release/README.html</code>). ${a.dated === 'run' ? 'Give the date for the whole run with <code>--issue-date YYYY-MM-DD</code>, or per customer as <code>"issueDate"</code> next to <code>"data"</code>. A customer with no date is stopped (DOCUMENT_DATE_MISSING).' : 'The date is taken from each customer’s data. A date given with <code>--issue-date</code> or a customer’s <code>"issueDate"</code> is used instead.'} A date given for the run is part of the run ID, is stated in <code>results.jsonl</code> and is kept in the proof record (<code>issueDate</code>), so the document can be re-created exactly.</p>
${code('node run --data customers.jsonl --issue-date 2027-01-31 --out out')}

` : ''}<h2>Produce documents over HTTP</h2>
${code('node serve --port 8787')}
<p>Listens on <code>127.0.0.1</code> only (use <code>--host</code> to change that, behind your own access control). <code>POST /render</code> with a customer record, or <code>{"customerRef": "…", "data": {…}, "outputs": ["html", "email", "sms", "pdf"]}</code>, answers 200 with the documents and the proof record (the PDF as base64), 409 when a blocking issue stops the document, 422 when the data does not match the contract. <code>GET /health</code> says whether it is ready and which release it runs. It logs one line per request with no customer data.</p>

<h2>What is inside</h2>
<table>
<tr><th>Path</th><th>What it holds</th></tr>
${row(['<code>release/</code>', 'The frozen release exactly as in its release package: the approved template, wording, data dictionary, images, font list, test scenarios, reference outputs and its manifest.'])}
${row(['<code>engine/iss-engine.mjs</code>', 'The engine: the studio’s resolver and renderers in one JavaScript file. Its version and SHA-256 are in <code>engine/engine.json</code>; <code>node engine/iss-engine.mjs version</code> computes the SHA-256 from the file itself.'])}
${row(['<code>engine/node_modules/playwright-core/</code>', `The page composer used for PDF, version ${escHtml(a.composerVersion)}, as published by Microsoft under the Apache 2.0 licence (its <code>LICENSE</code> and <code>NOTICE</code> are next to it).`])}
${row(['<code>contract/</code>', '<code>input.schema.json</code> (JSON Schema of one customer, generated from the data dictionary), <code>sample-input.json</code> (one synthetic input line) and <code>entry-point.json</code> (the commands and the HTTP routes, for your own tools).'])}
${row(['<code>proof/</code>', 'The proof pack: <code>inputs.jsonl</code> (synthetic customers), <code>expected.json</code> and <code>expected/</code> (what the studio produced for each, with fingerprints). <code>verify</code> runs it.'])}
${row(['<code>run</code>, <code>serve</code>, <code>verify</code>', 'The three commands. Each is a small Node.js script that starts the engine.'])}
${row(['<code>image/Dockerfile</code>', 'A container definition with Node.js and the matching Chromium, so nothing has to be installed. It runs <code>verify</code> while it is built.'])}
${row(['<code>runtime.json</code>', 'The list of every file with its SHA-256 and size, the release and the engine. <code>verify</code> checks every file against it.'])}
</table>

<h2>Upgrading</h2>
<p>A package never changes. A new release of the document, or a fix to the engine, comes as a new package from the studio: a release moves to a newer engine only through a new, approved release. To switch: unpack the new package into its own folder next to the old one, run <code>node verify</code> there, then point your system at it. Do not copy files from one package into another: <code>run</code> refuses to start when a file that decides what a document says was changed, and <code>verify</code> lists every changed file.</p>

<h2>What it can promise</h2>
<ul>
<li><strong>Email, SMS and the interactive web page</strong> are byte-identical to what the studio produces for the same release and the same data, and carry the same run ID.</li>
<li><strong>PDF</strong> is composed by the headless browser as in the studio. Its bytes differ from one composition to the next (the PDF records when it was made), so its proof fingerprint is the SHA-256 of the page source it was composed from plus its page count. With a different browser build or different fonts, pages can break differently; <code>verify</code> reports that.</li>
<li><strong>AFP</strong> is not produced. The studio's AFP output is a simulation.</li>
<li>Languages with approved wording in this release: ${escHtml(a.languages.join(', '))}.</li>
</ul>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ the package */

export async function buildRunnablePackage(release: StoredRelease, frozen: Project, opts: RuntimeBuildOptions): Promise<BuiltRuntimePackage> {
  const progress = opts.onProgress ?? (() => undefined);
  const fileName = runtimePackageName(release.documentId, release.number);
  const folder = fileName.replace(/\.zip$/, '');
  const files: Array<{ path: string; data: Buffer; role: string }> = [];
  const add = (p: string, role: string, data: string | Buffer) => { files.push({ path: p, role, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data }); };

  /* release/: the release package as it is */
  progress({ step: 'Reading the release package', done: 0, total: 1 });
  const rel = new Map(zipEntries(opts.releaseZip).map((e) => [e.name, zipRead(opts.releaseZip, e)]));
  const relText = (p: string): string => { const b = rel.get(p); if (!b) throw new Error(`The release package has no ${p}.`); return b.toString('utf8'); };
  const manifest = JSON.parse(relText('manifest.json'));
  if (manifest.release?.id !== release.id) throw new Error('The release package does not belong to this release.');
  if (relText('template.json') !== json(releaseTemplate(frozen))) throw new Error("The release package does not hold this release's approved template.");
  for (const [p, data] of rel) add(`release/${p}`, p === 'manifest.json' ? 'release-manifest' : 'release', data);
  const template = JSON.parse(relText('template.json')) as Project;
  const drafts = draftProblems(template);
  if (drafts.length) throw new Error(`The template carries unapproved wording: ${drafts.join(' ')}`);
  const loaded: LoadedRelease = { release: { id: release.id, documentId: release.documentId, number: release.number, title: release.title, contentDigest: release.contentDigest }, project: template };
  await tick();

  /* engine/ */
  progress({ step: 'Bundling the engine', done: 0, total: 1 });
  const engine = opts.engine ?? (await engineBundle());
  for (const [k, v] of Object.entries(engine.versions)) if ((release.versions as unknown as Record<string, unknown>)[k] !== v) throw new Error(`The engine's ${k} is ${v}, but release ${release.number} was made with ${(release.versions as unknown as Record<string, unknown>)[k]}.`);
  const composer = composerFiles();
  add('engine/iss-engine.mjs', 'engine', engine.code);
  add('engine/engine.json', 'engine-description', json({
    formatVersion: 1,
    file: 'iss-engine.mjs', sha256: engine.sha256, bytes: engine.code.length,
    engine: engine.versions.engine, renderers: { pagedRenderer: engine.versions.pagedRenderer, htmlRenderer: engine.versions.htmlRenderer, emailRenderer: engine.versions.emailRenderer, smsRenderer: engine.versions.smsRenderer },
    bundledWith: { esbuild: engine.esbuild, format: 'esm', target: 'node22' },
    needs: { node: '>=22', pdf: `a headless Chromium (playwright-core ${composer.version} pins Chromium ${composer.chromiumRevision ?? 'unknown'}); set CHROMIUM_PATH or install it` },
    composer: { package: 'playwright-core', version: composer.version, licence: 'Apache-2.0', path: 'node_modules/playwright-core', loaded: 'only when a PDF is asked for' },
    note: 'One shared engine, not code generated for this template: the template is data (release/template.json). The SHA-256 is of iss-engine.mjs; the engine computes it from its own file when it starts and refuses to run when it differs.',
  }));
  for (const f of composer.files) add(`engine/node_modules/playwright-core/${f.path}`, 'composer', f.data);
  await tick();

  /* contract/ */
  const dictionary = JSON.parse(relText('data/dictionary.json')) as Dictionary;
  const languages: string[] = [manifest.languages?.source, ...(manifest.languages?.targets ?? []).map((t: { locale: string }) => t.locale)].filter(Boolean);
  add('contract/input.schema.json', 'contract-schema', json(inputSchemaFromDictionary(dictionary, { releaseId: release.id, title: release.title, languages })));

  /* proof/: the release package's scenarios, run through the engine as the operator's lines would be */
  const scenarios = JSON.parse(relText('tests/scenarios.json')) as { scenarios: Array<{ id: string; data: Record<string, unknown>; issueDate?: string }> };
  // A scenario produced as issued on a given date (a document that uses dates) keeps that date on its input line.
  const inputs: Array<{ customerRef: string; issueDate?: string; data: Record<string, unknown> }> = scenarios.scenarios.map((s) => ({ customerRef: s.id, ...(s.issueDate ? { issueDate: s.issueDate } : {}), data: s.data }));
  // One line the contract refuses (a synthetic customer without its required name), so `verify` also proves that a bad line is reported, not produced.
  const first = scenarios.scenarios[0];
  if (first) {
    const { givenName: _drop, ...customer } = (first.data.customer ?? {}) as Record<string, unknown>;
    inputs.push({ customerRef: 'invalid-missing-given-name', ...(first.issueDate ? { issueDate: first.issueDate } : {}), data: { ...first.data, customer } });
  }
  const lines = inputs.map((i) => JSON.stringify(i));
  add('proof/inputs.jsonl', 'proof-inputs', lines.join('\n') + '\n');
  const cases: unknown[] = [];
  const counts = { produced: 0, stopped: 0, invalid: 0 };
  let sample: unknown = null;
  for (const [i, input] of inputs.entries()) {
    progress({ step: 'Producing the proof pack', done: i, total: inputs.length });
    const parsed = parseInput(JSON.parse(lines[i]), template);
    if (!parsed.ok) { counts.invalid++; cases.push({ customerRef: input.customerRef, line: i + 1, status: 'invalid', problems: parsed.problems }); continue; }
    const r = render(loaded, parsed.record, new Set(CHANNELS), parsed.issueDate);
    const base = { customerRef: parsed.customerRef, line: i + 1, runId: r.res.runId, contentDigest: r.res.contentDigest, ...(parsed.issueDate ? { issueDate: parsed.issueDate } : {}) };
    if (!r.produced) {
      counts.stopped++;
      cases.push({ ...base, status: 'stopped', blockedBy: r.blockedBy });
      continue;
    }
    counts.produced++;
    sample ??= JSON.parse(lines[i]);
    const dir = `proof/expected/${input.customerRef}`;
    const kept: Record<string, { path: string; sha256: string; bytes: number }> = {};
    const keep = (name: string, data: Buffer) => { add(`${dir}/${name}`, 'proof-expected', data); kept[name] = { path: `${dir}/${name}`, sha256: sha256(data), bytes: data.length }; };
    keep('document.html', r.files.html!);
    keep('email.html', r.files.emailHtml!);
    keep('email.txt', r.files.emailText!);
    keep('sms.txt', r.files.sms!);
    const composed = await opts.composer.pdf(r.files.pagedHtml!);
    const outputs = outputFingerprints(r, composed.pageCount);
    // The record the engine will write for this customer is a valid proof record (the time is the release's own, so nothing here depends on the build).
    const problems = proofRecordProblems(proofOf(loaded, r, parsed.record, parsed.customerRef, release.approvedAt, outputs));
    if (problems.length) throw new Error(`The proof record of ${input.customerRef} is not valid: ${problems.join(' ')}`);
    cases.push({ ...base, status: 'produced', files: kept, outputs });
    await tick();
  }
  add('proof/expected.json', 'proof-expected-index', json({
    formatVersion: 1,
    syntheticOnly: true,
    note: 'What the studio produced for each line of inputs.jsonl with this release. "outputs" are the fingerprints a proof record keeps: HTML, email (email.html) and SMS by the SHA-256 of the exact file; the PDF by the SHA-256 of the page source it was composed from and its page count (PDF bytes differ between compositions). `node verify` produces every line again and compares.',
    inputs: 'proof/inputs.jsonl',
    counts: { cases: cases.length, ...counts },
    cases,
  }));
  add('contract/sample-input.json', 'contract-sample', json(sample ?? {}));
  add('contract/entry-point.json', 'contract-entry-point', json({
    formatVersion: 1,
    release: { id: release.id, number: release.number, title: release.title, documentKind: release.documentType },
    input: { format: 'JSON Lines (one JSON object per line, UTF-8)', line: 'a record as in input.schema.json, or {"customerRef": string, "issueDate": "YYYY-MM-DD", "data": record}', customerRef: 'defaults to data.recordId', ...(template.documentDate ? { issueDate: template.documentDate.source === 'run' ? 'the document’s date: required by this template, per customer ("issueDate") or for the whole run (--issue-date)' : 'optional: the document’s date for this customer, instead of the date in its data' } : {}), maxLineBytes: 2 * 1024 * 1024, check: 'the studio’s own record check (validateRecordShape); a refused line is reported and skipped' },
    commands: {
      run: { command: 'node run --data <file.jsonl> --outputs pdf,html,email,sms --out <folder> [--parallel n] [--issue-date YYYY-MM-DD]', defaultOutputs: ['html', 'email', 'sms'], writes: ['documents/<customerRef>/{document.pdf,document.html,email.html,email.txt,sms.txt}', 'results.jsonl', 'proof.jsonl', 'summary.json'], exitCodes: { 0: 'done', 2: 'wrong arguments', 3: 'the package was changed or is incomplete', 4: 'PDF asked for but no browser', 5: 'some documents failed' } },
      serve: { command: 'node serve [--port 8787] [--host 127.0.0.1] [--parallel n] [--pdf]', routes: { 'POST /render': { body: 'record, or {"customerRef", "data", "outputs"}', answers: { 200: 'produced: outputs and proof', 409: 'stopped by a blocking issue: blockedBy and proof', 422: 'refused by the contract: problems', 503: 'PDF asked for but no browser' } }, 'GET /health': 'engine, release, PDF readiness' } },
      verify: { command: 'node verify [--without-pdf] [--json]', exitCodes: { 0: 'nothing differs', 1: 'something differs, or the browser or a font is missing' } },
      generate: { command: 'node engine/iss-engine.mjs generate --count <n> --out <file.jsonl>', what: 'engine-generated synthetic customers for trying the package out' },
    },
    results: { produced: '{line, customerRef, status: "produced", runId, issueDate (when a date was given), files}', stopped: '{line, customerRef, status: "stopped", runId, issueDate (when a date was given), blockedBy: [issue codes]}', invalid: '{line, customerRef, status: "invalid", problems: [plain words, no values]}', failed: '{line, customerRef, status: "failed", reason}' },
    proof: { schema: 'proof-record/1', producer: 'runtime', issueDate: 'kept in the record when a date was given for the run', fingerprints: { html: 'bytes', email: 'bytes (email.html)', sms: 'bytes', pdf: 'content (SHA-256 of the page source, and page count)' } },
  }));
  await tick();

  /* scripts, container, README */
  add('package.json', 'node-package', json({ name: folder, private: true, type: 'commonjs', description: `Runnable package of ${release.title}, release ${release.number}. See README.html.`, engines: { node: '>=22' } }));
  add('run', 'command', launcher('run', 'Produces documents from a file of customers.'));
  add('serve', 'command', launcher('serve', 'Produces documents over local HTTP (POST /render).'));
  add('verify', 'command', launcher('verify', 'Checks this package on this machine: files, engine, proof pack, browser and fonts.'));
  add('image/Dockerfile', 'container', dockerfile(folder, composer.version));
  const fontsJson = JSON.parse(relText('assets/fonts.json')) as { fonts: Array<{ use: string; family: string; stack: string }>; referencePdfFonts: string[] };
  add('README.html', 'readme', readmeHtml({
    dated: template.documentDate?.source ?? null,
    title: release.title, kind: DOCUMENT_TYPE_LABEL[release.documentType], number: release.number, approver: release.approvedBy?.name ?? null, approvedAt: release.approvedAt, folder, fileName,
    engine: { version: engine.versions.engine, sha256: engine.sha256 }, composerVersion: composer.version, chromium: composer.chromiumRevision,
    fonts: fontsJson.fonts, referencePdfFonts: fontsJson.referencePdfFonts ?? [], languages, proof: { cases: cases.length, ...counts },
  }));

  /* runtime.json lists everything else */
  progress({ step: 'Packing', done: 0, total: 1 });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const contents: RuntimeFile[] = files.map((f) => ({ path: f.path, sha256: sha256(f.data), bytes: f.data.length, role: f.role }));
  const runtime = {
    format: RUNTIME_FORMAT,
    formatVersion: RUNTIME_FORMAT_VERSION,
    release: { id: release.id, documentId: release.documentId, number: release.number, title: release.title, contentDigest: release.contentDigest, kind: release.documentType, approvedAt: release.approvedAt },
    engine: { file: 'engine/iss-engine.mjs', sha256: engine.sha256, bytes: engine.code.length, version: engine.versions.engine, renderers: { pagedRenderer: engine.versions.pagedRenderer, htmlRenderer: engine.versions.htmlRenderer, emailRenderer: engine.versions.emailRenderer, smsRenderer: engine.versions.smsRenderer } },
    releasePackage: { file: `${release.id}.zip`, manifestSha256: sha256(rel.get('manifest.json')!) },
    outputs: [...CHANNELS],
    proof: { cases: cases.length, ...counts },
    syntheticOnly: true,
    notIncluded: ['customer data', 'draft wording and unapproved translations', 'a headless browser', 'font files', 'an AFP print stream'],
    contents,
  };
  const all = [{ path: 'runtime.json', data: Buffer.from(json(runtime), 'utf8') }, ...files];
  await tick();
  const zip = zipFiles(all.map((f) => ({ name: `${folder}/${f.path}`, data: f.data, date: ZIP_FIXED_DATE })));
  return { fileName, folder, zip, sha256: sha256(zip), files: contents, engine: { version: engine.versions.engine, sha256: engine.sha256 }, proofCases: cases.length };
}

/* ------------------------------------------------------------------ build once, keep, serve */

/**
 * What the studio keeps about a runnable package, in a small file next to the ZIP (`runtime-<release>.json` in the
 * artifact folder). It names the release it was built for by id, creation time and content fingerprint, so a record
 * left over from a release that no longer exists (a test reset) is never served for a new one with the same id.
 */
interface KeptRuntime {
  releaseId: string; releaseCreatedAt: string; releaseDigest: string;
  status: 'ready' | 'failed'; file: string | null; sha256: string | null; bytes: number | null; files: number | null;
  builtAt: string; error: string | null; verified: ReleasePackageCheck | null;
  engine: { version: string; sha256: string } | null; proofCases: number | null;
}

export interface RuntimeBuildOutcome {
  status: RuntimePackageStatus;
  built?: { sha256: string; bytes: number; files: number; releasePackageBuilt: boolean };
  verified?: ReleasePackageCheck;
}

export class RuntimePackages {
  private building = new Map<string, { promise: Promise<RuntimeBuildOutcome>; progress: { step: string; done: number; total: number } }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private releasePackages: ReleasePackages, private composer: PackageComposer) {}

  private path(name: string) { return path.join(this.store.artifactDir, name); }
  private recordFile(r: Pick<StoredRelease, 'id'>) { return this.path(`runtime-${r.id}.json`); }
  private record(r: StoredRelease): KeptRuntime | null {
    const f = this.recordFile(r);
    if (!existsSync(f)) return null;
    try {
      const k = JSON.parse(readFileSync(f, 'utf8')) as KeptRuntime;
      return k.releaseId === r.id && k.releaseCreatedAt === r.createdAt && k.releaseDigest === r.contentDigest ? k : null;
    } catch { return null; }
  }
  private save(k: KeptRuntime) {
    const f = this.path(`runtime-${k.releaseId}.json`);
    writeFileSync(`${f}.tmp`, json(k));
    renameSync(`${f}.tmp`, f);
  }
  private kept(r: StoredRelease): KeptRuntime | null {
    const k = this.record(r);
    return k && k.status === 'ready' && k.file && existsSync(this.path(k.file)) ? k : null;
  }

  status(r: StoredRelease): RuntimePackageStatus {
    const fileName = runtimePackageName(r.documentId, r.number);
    const empty: RuntimePackageStatus = { status: 'not-built', fileName, sha256: null, bytes: null, files: null, builtAt: null, progress: null, error: null, verified: null, engine: null, proofCases: null };
    const kept = this.kept(r);
    const job = this.building.get(r.id);
    if (kept) return { status: 'ready', fileName, sha256: kept.sha256, bytes: kept.bytes, files: kept.files, builtAt: kept.builtAt, progress: job ? { ...job.progress } : null, error: null, verified: kept.verified, engine: kept.engine, proofCases: kept.proofCases };
    if (job) return { ...empty, status: 'building', progress: { ...job.progress } };
    const rec = this.record(r);
    return rec?.status === 'failed' ? { ...empty, status: 'failed', error: rec.error, builtAt: rec.builtAt } : empty;
  }

  /** Starts a build when there is no package (or the last build failed); with `verify`, builds a ready one again and compares. */
  prepare(r: StoredRelease, opts: { verify?: boolean } = {}): { status: RuntimePackageStatus; started: boolean; done: Promise<RuntimeBuildOutcome> | null } {
    const running = this.building.get(r.id);
    if (running) return { status: this.status(r), started: false, done: running.promise };
    if (this.kept(r) && !opts.verify) return { status: this.status(r), started: false, done: null };
    const job = { progress: { step: 'Waiting for its turn', done: 0, total: 1 }, promise: null as unknown as Promise<RuntimeBuildOutcome> };
    job.promise = (this.queue = this.queue.then(() => this.build(r, job))) as Promise<RuntimeBuildOutcome>;
    this.building.set(r.id, job);
    return { status: this.status(r), started: true, done: job.promise };
  }

  private async build(r: StoredRelease, job: { progress: { step: string; done: number; total: number } }): Promise<RuntimeBuildOutcome> {
    const now = () => new Date().toISOString();
    const reason = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 400);
    const ids = { releaseId: r.id, releaseCreatedAt: r.createdAt, releaseDigest: r.contentDigest };
    let built: RuntimeBuildOutcome['built'];
    let verified: RuntimeBuildOutcome['verified'];
    try {
      const frozen = this.store.releaseProject(r.id);
      if (!frozen) throw new Error('The release has no stored content.');
      const drift = versionDrift(r, frozen);
      if (drift) throw new Error(drift.replace("this release's package", "this release's runnable package"));
      // The runnable package carries the release package as it is: prepare that first when nobody has.
      let releasePackageBuilt = false;
      if (this.releasePackages.status(r).status !== 'ready') {
        job.progress = { step: 'Preparing the release package first', done: 0, total: 1 };
        const p = this.releasePackages.prepare(r);
        if (p.done) { await p.done; releasePackageBuilt = p.started; }
      }
      const releaseZip = this.releasePackages.zip(r);
      if (!releaseZip) throw new Error(`The release package could not be prepared: ${this.releasePackages.status(r).error ?? 'no reason was given.'}`);
      const pkg = await buildRunnablePackage(r, frozen, { releaseZip, composer: this.composer, onProgress: (p) => { job.progress = p; } });
      const kept = this.kept(r);
      if (kept) {
        verified = { at: now(), same: kept.sha256 === pkg.sha256, sha256: pkg.sha256, error: null };
        this.save({ ...kept, verified });
      } else {
        const file = `runtime-${r.id}-${pkg.sha256.slice(0, 16)}.zip`;
        writeFileSync(this.path(file), pkg.zip);
        this.save({ ...ids, status: 'ready', file, sha256: pkg.sha256, bytes: pkg.zip.length, files: pkg.files.length + 1, builtAt: now(), error: null, verified: null, engine: pkg.engine, proofCases: pkg.proofCases });
        built = { sha256: pkg.sha256, bytes: pkg.zip.length, files: pkg.files.length + 1, releasePackageBuilt };
      }
    } catch (e) {
      const kept = this.kept(r);
      if (kept) {
        verified = { at: now(), same: false, sha256: null, error: reason(e) };
        this.save({ ...kept, verified });
      } else this.save({ ...ids, status: 'failed', file: null, sha256: null, bytes: null, files: null, builtAt: now(), error: reason(e), verified: null, engine: null, proofCases: null });
    } finally {
      this.building.delete(r.id);
    }
    return { status: this.status(r), built, verified };
  }

  zip(r: StoredRelease): Buffer | null {
    const kept = this.kept(r);
    return kept ? readFileSync(this.path(kept.file!)) : null;
  }

  async idle(): Promise<void> { await this.queue.catch(() => undefined); }
}
