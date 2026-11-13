import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RECORD_ID_PREFIX, projectContentDigest, type Project, type SyntheticRecord } from '@iss/model';
import { proofRecordProblems, type ProofOutput } from '@iss/resolver';
import { planTestData } from '@iss/scenarios';
import { parseInput, parseInputLine, MAX_LINE_BYTES } from './contract';
import { CHANNELS, ENGINE_VERSIONS, RUNTIME_FORMAT, RUNTIME_FORMAT_VERSION, draftProblems, isChannel, outputFingerprints, proofOf, render, sha256, type Channel, type LoadedRelease, type Rendered } from './core';
import { PdfComposer, RuntimeProblem, requiredPdfFonts } from './pdf';

/**
 * The command line of a runnable package (`run`, `serve`, `verify`, `generate`, `version`). Bundled with the engine
 * into engine/iss-engine.mjs; the small `run`, `serve` and `verify` files at the top of the package call `main`.
 *
 * Customer data stays with the operator: nothing here opens an outbound connection (the HTTP server only listens),
 * and nothing writes a customer's values to the console or to results.jsonl (references, run IDs, issue codes and
 * field paths only).
 */

/* ------------------------------------------------------------------ the package on disk */

export interface PackageFileEntry { path: string; sha256: string; bytes: number; role: string }
export interface RuntimeManifest {
  format: string; formatVersion: number;
  release: { id: string; documentId: string; number: number; title: string; contentDigest: string; kind: string; approvedAt: string };
  engine: { file: string; sha256: string; bytes: number; version: string; renderers: Record<string, string> };
  contents: PackageFileEntry[];
}

interface Pkg {
  root: string;
  engineDir: string;
  manifest: RuntimeManifest;
  loaded: LoadedRelease;
  engineSha256: string;
}

class Stop extends Error { constructor(message: string, readonly exitCode: number) { super(message); } }

const out = (s: string) => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

function engineFile(): string { return fileURLToPath(import.meta.url); }

/** SHA-256 of this engine file, computed from its bytes on disk every time it starts. */
export function selfSha256(): string { return sha256(readFileSync(engineFile())); }

function readJson<T>(file: string, what: string): T {
  if (!existsSync(file)) throw new Stop(`${what} is missing (${file}). The package is incomplete: unpack it again.`, 3);
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { throw new Stop(`${what} cannot be read (${file}). The package is damaged: unpack it again.`, 3); }
}

/** Files whose content no longer matches the package's own list. */
function changedFiles(root: string, entries: PackageFileEntry[]): Array<{ path: string; problem: 'missing' | 'changed' }> {
  const bad: Array<{ path: string; problem: 'missing' | 'changed' }> = [];
  for (const e of entries) {
    const file = path.join(root, ...e.path.split('/'));
    if (!existsSync(file)) { bad.push({ path: e.path, problem: 'missing' }); continue; }
    if (sha256(readFileSync(file)) !== e.sha256) bad.push({ path: e.path, problem: 'changed' });
  }
  return bad;
}

/** The files `run` and `serve` refuse to start without: the template, the release record and the engine itself. */
const RUN_CRITICAL = new Set(['release/template.json', 'release/manifest.json', 'release/assets/fonts.json', 'engine/engine.json']);

function openPackage(opts: { checkAll: boolean }): { pkg: Pkg | null; problems: string[] } {
  const engineDir = path.dirname(engineFile());
  const root = path.dirname(engineDir);
  const problems: string[] = [];
  const manifest = readJson<RuntimeManifest>(path.join(root, 'runtime.json'), 'The package list (runtime.json)');
  if (manifest.format !== RUNTIME_FORMAT || manifest.formatVersion !== RUNTIME_FORMAT_VERSION) throw new Stop(`runtime.json is not a runnable package of format ${RUNTIME_FORMAT} version ${RUNTIME_FORMAT_VERSION}; this engine cannot run it.`, 3);
  const engineSha256 = selfSha256();
  const engineJson = readJson<{ sha256: string; version: string }>(path.join(engineDir, 'engine.json'), 'The engine description (engine/engine.json)');
  if (engineSha256 !== manifest.engine.sha256 || engineSha256 !== engineJson.sha256) problems.push(`The engine file (${manifest.engine.file}) has been changed since the package was built: its SHA-256 is ${engineSha256}, the package says ${manifest.engine.sha256}.`);
  if (manifest.engine.version !== ENGINE_VERSIONS.engine) problems.push(`This engine is ${ENGINE_VERSIONS.engine}, but the package was built for ${manifest.engine.version}.`);
  for (const [k, v] of Object.entries(ENGINE_VERSIONS)) if (manifest.engine.renderers[k] !== undefined && manifest.engine.renderers[k] !== v) problems.push(`The engine's ${k} is ${v}, but the package was built with ${manifest.engine.renderers[k]}.`);
  const entries = opts.checkAll ? manifest.contents.filter((e) => e.path !== manifest.engine.file) : manifest.contents.filter((e) => RUN_CRITICAL.has(e.path));
  for (const c of changedFiles(root, entries)) problems.push(c.problem === 'missing' ? `${c.path} is missing.` : `${c.path} has been changed since the package was built.`);
  const releaseManifest = readJson<{ templateDigest: string; versions: Record<string, string | null> }>(path.join(root, 'release', 'manifest.json'), 'The release manifest (release/manifest.json)');
  const project = readJson<Project>(path.join(root, 'release', 'template.json'), 'The template (release/template.json)');
  problems.push(...draftProblems(project).map((p) => `${p} Drafts cannot be produced: only approved wording runs.`));
  if (projectContentDigest(project) !== releaseManifest.templateDigest) problems.push('release/template.json is not the approved template of this release (its content fingerprint differs from the release manifest).');
  if (releaseManifest.versions.engine !== ENGINE_VERSIONS.engine) problems.push(`The release was approved with engine ${releaseManifest.versions.engine}; this engine is ${ENGINE_VERSIONS.engine}.`);
  const r = manifest.release;
  const pkg: Pkg = { root, engineDir, manifest, engineSha256, loaded: { release: { id: r.id, documentId: r.documentId, number: r.number, title: r.title, contentDigest: r.contentDigest }, project } };
  return { pkg, problems };
}

/** Opens the package for producing documents: refuses when anything that decides what a document says was changed. */
function openForProduction(): Pkg {
  const { pkg, problems } = openPackage({ checkAll: false });
  if (problems.length) throw new Stop(`The package cannot be used:\n  - ${problems.join('\n  - ')}\nUnpack the package again from the file the studio gave you, then run: node verify`, 3);
  return pkg!;
}

/* ------------------------------------------------------------------ arguments */

function parseArgs(argv: string[], spec: Record<string, 'string' | 'flag'>): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Stop(`Unexpected argument: ${a}. See: node run --help`, 2);
    const [k, inline] = a.slice(2).split('=', 2);
    const kind = spec[k];
    if (!kind) throw new Stop(`Unknown option --${k}.`, 2);
    if (kind === 'flag') { o[k] = true; continue; }
    const v = inline ?? argv[++i];
    if (v === undefined) throw new Stop(`--${k} needs a value.`, 2);
    o[k] = v;
  }
  return o;
}

function channelsOf(v: string | boolean | undefined, fallback: Channel[]): Channel[] {
  if (v === undefined || v === true) return fallback;
  const list = String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((c) => !isChannel(c));
  if (bad.length) throw new Stop(`Unknown output ${bad.join(', ')}. Choose from ${CHANNELS.join(', ')}${bad.includes('afp') ? ' (AFP is a simulation in the studio and is not produced by this package)' : ''}.`, 2);
  if (!list.length) throw new Stop('--outputs needs at least one of pdf, html, email, sms.', 2);
  return CHANNELS.filter((c) => list.includes(c));
}

function parallelOf(v: string | boolean | undefined): number {
  if (v === undefined || v === true) return Math.max(1, Math.min(4, availableParallelism()));
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new Stop('--parallel must be a whole number from 1 to 64.', 2);
  return n;
}

async function openPdf(pkg: Pkg, parallel: number): Promise<PdfComposer> {
  try { return await PdfComposer.open(pkg.engineDir, parallel); } catch (e) {
    if (e instanceof RuntimeProblem) throw new Stop(e.message, 4);
    throw e;
  }
}

/* ------------------------------------------------------------------ producing one document */

interface Produced {
  status: 'produced' | 'stopped';
  rendered: Rendered;
  pdf?: Buffer;
  outputs: ProofOutput[];
}

async function produce(pkg: Pkg, record: SyntheticRecord, channels: Set<Channel>, pdf: PdfComposer | null): Promise<Produced> {
  const rendered = render(pkg.loaded, record, channels);
  if (!rendered.produced) return { status: 'stopped', rendered, outputs: [] };
  let composed: { pdf: Buffer; pages: number } | undefined;
  if (rendered.files.pagedHtml !== undefined) composed = await pdf!.compose(rendered.files.pagedHtml);
  return { status: 'produced', rendered, pdf: composed?.pdf, outputs: outputFingerprints(rendered, composed?.pages ?? null) };
}

/** A reason for a failure that never carries the customer's data. */
const failureReason = (e: unknown): string => (e instanceof RuntimeProblem ? e.message : `The engine could not produce this document (${(e as Error)?.name ?? 'error'}).`);

const safeName = (ref: string): string => ref.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'customer';

/* ------------------------------------------------------------------ run */

const RUN_HELP = `Produces documents from a file of customers, one JSON object per line.

  node run --data customers.jsonl --outputs pdf,html,email,sms --out <folder>

  --data       the input file (JSON Lines). Each line is a customer record as described in contract/input.schema.json,
               or { "customerRef": "<your reference>", "data": <record> }. The reference defaults to the record id.
  --outputs    any of pdf, html, email, sms (default: html,email,sms). PDF needs a headless browser.
  --out        the folder to write to. It must not hold the results of an earlier run.
  --parallel   PDF pages composed at the same time (default: the number of processor cores, at most 4).

Writes documents/<reference>/ (document.pdf, document.html, email.html, email.txt, sms.txt), results.jsonl (one line
per input line: produced, stopped with the blocking issue codes, or invalid with what is wrong) and proof.jsonl (one
proof record per document). A document with a blocking issue is not produced. Customer values are never written to
results.jsonl, proof.jsonl or the console.`;

export async function cmdRun(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { data: 'string', outputs: 'string', out: 'string', parallel: 'string', help: 'flag' });
  if (a.help) { out(RUN_HELP); return 0; }
  if (typeof a.data !== 'string') throw new Stop('Say which file to read: --data customers.jsonl', 2);
  if (typeof a.out !== 'string') throw new Stop('Say where to write: --out <folder>', 2);
  const channels = new Set(channelsOf(a.outputs, ['html', 'email', 'sms']));
  const parallel = parallelOf(a.parallel);
  const dataFile = path.resolve(a.data);
  if (!existsSync(dataFile)) throw new Stop(`There is no input file at ${dataFile}.`, 2);
  const outDir = path.resolve(a.out);
  if (existsSync(path.join(outDir, 'results.jsonl'))) throw new Stop(`${outDir} already holds the results of a run. Choose another folder, so earlier results are never overwritten.`, 2);
  const pkg = openForProduction();
  const pdf = channels.has('pdf') ? await openPdf(pkg, parallel) : null;
  mkdirSync(path.join(outDir, 'documents'), { recursive: true });
  const results = openSync(path.join(outDir, 'results.jsonl'), 'w');
  const proofs = openSync(path.join(outDir, 'proof.jsonl'), 'w');
  const used = new Set<string>();
  const counts = { lines: 0, produced: 0, stopped: 0, invalid: 0, failed: 0, files: 0 };
  const started = process.hrtime.bigint();

  /** Work on several lines at once (the PDF pages are composed in parallel); results are written in input order. */
  type Done = { result: Record<string, unknown>; proof?: unknown };
  const window: Array<Promise<Done>> = [];
  const flush = async (keep: number) => {
    while (window.length > keep) {
      const d = await window.shift()!;
      writeSync(results, JSON.stringify(d.result) + '\n');
      if (d.proof) writeSync(proofs, JSON.stringify(d.proof) + '\n');
    }
  };
  const handle = async (text: string, line: number): Promise<Done> => {
    const parsed = parseInputLine(text, pkg.loaded.project);
    if (!parsed.ok) { counts.invalid++; return { result: { line, customerRef: parsed.customerRef, status: 'invalid', problems: parsed.problems } }; }
    try {
      const p = await produce(pkg, parsed.record, channels, pdf);
      const producedAt = new Date().toISOString();
      const proof = proofOf(pkg.loaded, p.rendered, parsed.record, parsed.customerRef, producedAt, p.outputs);
      if (p.status === 'stopped') { counts.stopped++; return { result: { line, customerRef: parsed.customerRef, status: 'stopped', runId: p.rendered.res.runId, blockedBy: p.rendered.blockedBy }, proof }; }
      let name = safeName(parsed.customerRef);
      for (let i = 2; used.has(name); i++) name = `${safeName(parsed.customerRef)}~${i}`;
      used.add(name);
      const dir = path.join(outDir, 'documents', name);
      mkdirSync(dir, { recursive: true });
      const files: string[] = [];
      const put = (file: string, data: Buffer | undefined) => { if (!data) return; writeFileSync(path.join(dir, file), data); files.push(`documents/${name}/${file}`); };
      put('document.pdf', p.pdf);
      put('document.html', p.rendered.files.html);
      put('email.html', p.rendered.files.emailHtml);
      put('email.txt', p.rendered.files.emailText);
      put('sms.txt', p.rendered.files.sms);
      counts.produced++; counts.files += files.length;
      return { result: { line, customerRef: parsed.customerRef, status: 'produced', runId: p.rendered.res.runId, files }, proof };
    } catch (e) {
      counts.failed++;
      return { result: { line, customerRef: parsed.customerRef, status: 'failed', reason: failureReason(e) } };
    }
  };

  const rl = createInterface({ input: createReadStream(dataFile, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  const depth = pdf ? parallel * 2 : 1;
  try {
    for await (const text of rl) {
      line++;
      if (!text.trim()) continue;
      counts.lines++;
      window.push(handle(text, line));
      await flush(depth - 1);
    }
    await flush(0);
  } finally {
    closeSync(results); closeSync(proofs);
    await pdf?.close();
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const usage = process.resourceUsage();
  const summary = { lines: counts.lines, produced: counts.produced, stopped: counts.stopped, invalid: counts.invalid, failed: counts.failed, files: counts.files, outputs: [...channels], parallel: pdf ? parallel : null, seconds: Number(seconds.toFixed(3)), documentsPerSecond: seconds > 0 ? Number((counts.produced / seconds).toFixed(2)) : null, engineMaxRssKiB: usage.maxRSS };
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  err(`${counts.lines} line${counts.lines === 1 ? '' : 's'} read: ${counts.produced} produced, ${counts.stopped} stopped by a blocking issue, ${counts.invalid} invalid, ${counts.failed} failed. ${seconds.toFixed(1)} s. Results: ${path.join(outDir, 'results.jsonl')}`);
  return counts.failed ? 5 : 0;
}

/* ------------------------------------------------------------------ serve */

const SERVE_HELP = `Produces documents over local HTTP.

  node serve [--port 8787] [--host 127.0.0.1] [--parallel 4] [--pdf]

  POST /render   body: a customer record, or { "customerRef": "...", "data": <record>, "outputs": ["html","email","sms","pdf"] }
                 answers 200 with the documents and the proof record, 409 when a blocking issue stops the document,
                 422 when the record does not match the contract.
  GET  /health   whether the engine is ready, and which release it runs.

It listens on 127.0.0.1 only unless --host says otherwise. --pdf starts the headless browser at once (otherwise it
starts on the first PDF request). Nothing a customer is sent in is logged.`;

const MAX_BODY = MAX_LINE_BYTES;

function send(res: ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(); resolveBody(null); return; } chunks.push(c); });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function cmdServe(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { port: 'string', host: 'string', parallel: 'string', pdf: 'flag', help: 'flag' });
  if (a.help) { out(SERVE_HELP); return 0; }
  const port = a.port === undefined ? 8787 : Number(a.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Stop('--port must be a port number.', 2);
  const host = typeof a.host === 'string' ? a.host : '127.0.0.1';
  const parallel = parallelOf(a.parallel);
  const pkg = openForProduction();
  let pdf: PdfComposer | null = null;
  let pdfOpening: Promise<PdfComposer> | null = null;
  let pdfProblem: string | null = null;
  const getPdf = async (): Promise<PdfComposer> => {
    if (pdf) return pdf;
    pdfOpening ??= PdfComposer.open(pkg.engineDir, parallel).then((p) => { pdf = p; pdfProblem = null; return p; }, (e) => { pdfOpening = null; pdfProblem = e instanceof RuntimeProblem ? e.message : 'The headless browser could not be started.'; throw e; });
    return pdfOpening;
  };
  if (a.pdf) await getPdf().catch(() => { throw new Stop(pdfProblem ?? 'The headless browser could not be started.', 4); });
  let served = 0;

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = (req.url ?? '/').split('?')[0];
    let status = 500;
    try {
      if (req.method === 'GET' && url === '/health') {
        status = 200;
        send(res, 200, { status: 'ok', engine: { version: ENGINE_VERSIONS.engine, sha256: pkg.engineSha256 }, release: pkg.manifest.release, outputs: CHANNELS, pdf: pdf ? 'ready' : pdfProblem ? 'unavailable' : 'starts on first request', ...(pdfProblem ? { pdfProblem } : {}), served });
        return;
      }
      if (url !== '/render') { status = 404; send(res, 404, { error: 'Not found. Use POST /render or GET /health.' }); return; }
      if (req.method !== 'POST') { status = 405; res.setHeader('Allow', 'POST'); send(res, 405, { error: 'Use POST.' }); return; }
      const body = await readBody(req);
      if (!body) { status = 413; send(res, 413, { error: `The request is larger than ${MAX_BODY} bytes.` }); return; }
      let value: any;
      try { value = JSON.parse(body.toString('utf8')); } catch { status = 400; send(res, 400, { status: 'invalid', problems: ['The body is not valid JSON.'] }); return; }
      let channels: Channel[] = ['html', 'email', 'sms'];
      if (value && typeof value === 'object' && 'outputs' in value) {
        try { channels = channelsOf(Array.isArray(value.outputs) ? value.outputs.join(',') : String(value.outputs), channels); } catch (e) { status = 400; send(res, 400, { status: 'invalid', problems: [(e as Error).message] }); return; }
        const { outputs: _o, ...rest } = value;
        value = rest;
      }
      const parsed = parseInput(value, pkg.loaded.project);
      if (!parsed.ok) { status = 422; send(res, 422, { status: 'invalid', customerRef: parsed.customerRef, problems: parsed.problems }); return; }
      let composer: PdfComposer | null = null;
      if (channels.includes('pdf')) {
        try { composer = await getPdf(); } catch { status = 503; send(res, 503, { status: 'unavailable', problems: [pdfProblem ?? 'The headless browser could not be started.'] }); return; }
      }
      const p = await produce(pkg, parsed.record, new Set(channels), composer);
      const proof = proofOf(pkg.loaded, p.rendered, parsed.record, parsed.customerRef, new Date().toISOString(), p.outputs);
      served++;
      if (p.status === 'stopped') { status = 409; send(res, 409, { status: 'stopped', customerRef: parsed.customerRef, runId: p.rendered.res.runId, blockedBy: p.rendered.blockedBy, proof }); return; }
      const f = p.rendered.files;
      status = 200;
      send(res, 200, {
        status: 'produced', customerRef: parsed.customerRef, runId: p.rendered.res.runId,
        outputs: {
          ...(f.html ? { html: f.html.toString('utf8') } : {}),
          ...(f.emailHtml ? { email: { subject: p.rendered.email!.subject, preheader: p.rendered.email!.preheader, html: f.emailHtml.toString('utf8'), text: f.emailText!.toString('utf8') } } : {}),
          ...(f.sms ? { sms: { text: f.sms.toString('utf8'), ...p.rendered.smsInfo } } : {}),
          ...(p.pdf ? { pdf: { base64: p.pdf.toString('base64'), bytes: p.pdf.length } } : {}),
        },
        proof,
      });
    } catch (e) {
      status = 500;
      if (!res.headersSent) send(res, 500, { status: 'failed', problems: [failureReason(e)] });
    } finally {
      // One line per request: method, route, status and time. Never a body, a reference or a value.
      err(`${new Date().toISOString()} ${req.method} ${url === '/render' || url === '/health' ? url : '(other)'} ${status} ${Date.now() - t0} ms`);
    }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok()); });
  const addr = server.address();
  const shown = typeof addr === 'object' && addr ? `http://${addr.family === 'IPv6' ? `[${addr.address}]` : addr.address}:${addr.port}` : String(addr);
  out(`Serving release ${pkg.manifest.release.number} of “${pkg.manifest.release.title}” at ${shown} (POST /render, GET /health).${host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' ? ' Warning: it is reachable from other machines; put it behind your own access control.' : ''}`);
  await new Promise<void>((done) => {
    const stop = () => { server.close(() => done()); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
  await (pdf as PdfComposer | null)?.close();
  return 0;
}

/* ------------------------------------------------------------------ verify */

interface ExpectedCase {
  customerRef: string; line: number; status: 'produced' | 'stopped' | 'invalid';
  runId?: string; contentDigest?: string; dataFingerprint?: string; blockedBy?: string[];
  files?: Record<string, { path: string; sha256: string; bytes: number }>;
  outputs?: ProofOutput[];
}
interface ExpectedPack { formatVersion: number; inputs: string; cases: ExpectedCase[] }

const VERIFY_HELP = `Checks this package on this machine, before go-live and after any upgrade.

  node verify [--without-pdf] [--json]

It checks that no file was changed since the package was built, that the engine is the one built for this release,
then produces every customer of the proof pack (proof/inputs.jsonl) and compares each output with the expected one
(proof/expected.json and proof/expected/). PDF needs a headless browser and the fonts the document uses; it is checked
unless --without-pdf is given. The exit code is 0 only when nothing differs.`;

export async function cmdVerify(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { 'without-pdf': 'flag', json: 'flag', parallel: 'string', help: 'flag' });
  if (a.help) { out(VERIFY_HELP); return 0; }
  const withPdf = !a['without-pdf'];
  const differences: string[] = [];
  const notes: string[] = [];
  const { pkg, problems } = openPackage({ checkAll: true });
  differences.push(...problems);
  const p = pkg!;
  const expected = readJson<ExpectedPack>(path.join(p.root, 'proof', 'expected.json'), 'The proof pack (proof/expected.json)');
  const inputs = readFileSync(path.join(p.root, ...expected.inputs.split('/')), 'utf8').split('\n');
  let pdf: PdfComposer | null = null;
  if (withPdf) {
    try {
      pdf = await PdfComposer.open(p.engineDir, parallelOf(a.parallel));
      const fonts = requiredPdfFonts(readJson(path.join(p.root, 'release', 'assets', 'fonts.json'), 'The font list (release/assets/fonts.json)'));
      const missingAll = await pdf.missingFonts(fonts.allOf);
      for (const f of missingAll) differences.push(`The font “${f}” is not installed. The studio composed this document's PDFs with it; install it (or a licensed copy) so PDFs come out the same.`);
      if (fonts.oneOf.length) {
        const missingOne = await pdf.missingFonts(fonts.oneOf);
        if (missingOne.length === fonts.oneOf.length) differences.push(`None of the fonts the PDF needs is installed: install one of ${fonts.oneOf.map((f) => `“${f}”`).join(', ')}.`);
      }
    } catch (e) {
      if (e instanceof RuntimeProblem) differences.push(e.message);
      else throw e;
      pdf = null;
    }
  } else notes.push('PDF was not checked (--without-pdf). Run verify without it before producing PDFs.');

  let checked = 0;
  const channels = new Set<Channel>(withPdf && pdf ? CHANNELS : ['html', 'email', 'sms']);
  try {
    const jobs = expected.cases.map(async (c) => {
      const label = `Proof case ${c.customerRef}`;
      const text = inputs[c.line - 1];
      if (text === undefined) { differences.push(`${label}: its input line ${c.line} is missing from ${expected.inputs}.`); return; }
      const parsed = parseInputLine(text, p.loaded.project);
      if (!parsed.ok) {
        if (c.status !== 'invalid') differences.push(`${label}: the input is refused now (${parsed.problems.join(' ')}), but was accepted when the package was built.`);
        checked++;
        return;
      }
      if (c.status === 'invalid') { differences.push(`${label}: the input is accepted now, but was refused when the package was built.`); return; }
      let made: Produced;
      try { made = await produce(p, parsed.record, channels, pdf); } catch (e) { differences.push(`${label}: ${failureReason(e)}`); return; }
      const r = made.rendered;
      if (r.res.runId !== c.runId) differences.push(`${label}: the run ID is ${r.res.runId}; the studio gave ${c.runId}.`);
      if (r.res.contentDigest !== c.contentDigest) differences.push(`${label}: what the document says differs from what the studio worked out.`);
      if (made.status !== c.status) differences.push(`${label}: the document is ${made.status === 'stopped' ? `stopped (${r.blockedBy.join(', ')})` : 'produced'} now; in the studio it was ${c.status === 'stopped' ? `stopped (${(c.blockedBy ?? []).join(', ')})` : 'produced'}.`);
      else if (made.status === 'stopped' && r.blockedBy.join(',') !== (c.blockedBy ?? []).join(',')) differences.push(`${label}: it is stopped by ${r.blockedBy.join(', ')} now; in the studio by ${(c.blockedBy ?? []).join(', ')}.`);
      const proof = proofOf(p.loaded, r, parsed.record, parsed.customerRef, new Date().toISOString(), made.outputs);
      const shape = proofRecordProblems(proof);
      if (shape.length) differences.push(`${label}: the proof record is not valid (${shape.join(' ')}).`);
      if (made.status === 'produced') {
        const now: Record<string, Buffer | undefined> = { 'document.html': r.files.html, 'email.html': r.files.emailHtml, 'email.txt': r.files.emailText, 'sms.txt': r.files.sms };
        for (const [name, want] of Object.entries(c.files ?? {})) {
          const got = now[name];
          if (!got) continue;
          const file = path.join(p.root, ...want.path.split('/'));
          const kept = existsSync(file) ? readFileSync(file) : null;
          if (sha256(got) !== want.sha256) differences.push(`${label}: ${name} differs from the studio's (SHA-256 ${sha256(got)}, expected ${want.sha256}).`);
          else if (!kept || !kept.equals(got)) differences.push(`${label}: the expected ${name} in ${want.path} no longer matches the studio's fingerprint of it.`);
        }
        const wantPdf = c.outputs?.find((o) => o.channel === 'pdf');
        const gotPdf = made.outputs.find((o) => o.channel === 'pdf');
        if (wantPdf && gotPdf) {
          if (gotPdf.sha256 !== wantPdf.sha256) differences.push(`${label}: the PDF's page source differs from the studio's.`);
          if (wantPdf.pages != null && gotPdf.pages !== wantPdf.pages) differences.push(`${label}: the PDF has ${gotPdf.pages} page${gotPdf.pages === 1 ? '' : 's'}; in the studio it had ${wantPdf.pages}. Check the fonts and the browser version.`);
        }
      }
      checked++;
    });
    await Promise.all(jobs);
  } finally {
    await pdf?.close();
  }
  const ok = differences.length === 0;
  const report = { ok, release: p.manifest.release, engine: { version: ENGINE_VERSIONS.engine, sha256: p.engineSha256 }, proofCases: expected.cases.length, checked, pdfChecked: !!pdf, differences, notes };
  if (a.json) out(JSON.stringify(report, null, 2));
  else {
    out(`Release ${p.manifest.release.number} of “${p.manifest.release.title}”, engine ${ENGINE_VERSIONS.engine} (SHA-256 ${p.engineSha256}).`);
    out(`${checked} of ${expected.cases.length} proof cases produced and compared${pdf ? ', PDF included' : ', PDF not included'}.`);
    for (const n of notes) out(`Note: ${n}`);
    if (ok) out('Verified: this machine produces exactly what the studio approved.');
    else { out(`NOT verified. ${differences.length} difference${differences.length === 1 ? '' : 's'}:`); for (const d of differences) out(`  - ${d}`); }
  }
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ generate */

const GENERATE_HELP = `Writes synthetic customers for this release, made by the engine (for trying the package out and for load tests).

  node engine/iss-engine.mjs generate --count 5000 --out customers.jsonl

They are worked out from the release's own rules, starting from the synthetic customers of the proof pack. They are
never real people.`;

export async function cmdGenerate(argv: string[]): Promise<number> {
  const a = parseArgs(argv, { count: 'string', out: 'string', help: 'flag' });
  if (a.help) { out(GENERATE_HELP); return 0; }
  const count = Number(a.count ?? 100);
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000) throw new Stop('--count must be a whole number from 1 to 1000000.', 2);
  const pkg = openForProduction();
  const project = pkg.loaded.project;
  const expected = readJson<ExpectedPack>(path.join(pkg.root, 'proof', 'expected.json'), 'The proof pack (proof/expected.json)');
  const bases = readFileSync(path.join(pkg.root, ...expected.inputs.split('/')), 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => parseInputLine(l, project)).filter((x): x is Extract<typeof x, { ok: true }> => x.ok).map((x) => x.record);
  const plan = planTestData(project, bases, { outcomes: true, edges: true });
  const pool = [...plan.customers.map((c) => c.record), ...bases.map(({ recordId: _id, ...rest }) => rest)];
  const prefix = RECORD_ID_PREFIX[project.documentType] ?? 'REC';
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = pool[i % pool.length];
    const record = { ...base, recordId: `${prefix}-${String(100000 + i)}`, documentType: project.documentType };
    lines.push(JSON.stringify({ customerRef: `synthetic-${i + 1}`, data: record }));
  }
  const text = lines.join('\n') + '\n';
  if (typeof a.out === 'string') { writeFileSync(path.resolve(a.out), text); err(`${count} synthetic customers written to ${path.resolve(a.out)} (${pool.length} different customers, repeated with their own record ids).`); }
  else process.stdout.write(text);
  return 0;
}

/* ------------------------------------------------------------------ entry */

const HELP = `InfoSlips Spatial Studio runnable package.

  node run --data customers.jsonl --outputs pdf,html,email,sms --out <folder>
  node serve [--port 8787]
  node verify
  node engine/iss-engine.mjs version | generate --count N --out file

Add --help to any command for its options. README.html explains everything in plain words.`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'run': return await cmdRun(rest);
      case 'serve': return await cmdServe(rest);
      case 'verify': return await cmdVerify(rest);
      case 'generate': return await cmdGenerate(rest);
      case 'version': case '--version': {
        out(JSON.stringify({ format: RUNTIME_FORMAT, formatVersion: RUNTIME_FORMAT_VERSION, ...ENGINE_VERSIONS, sha256: selfSha256() }, null, 2));
        return 0;
      }
      case undefined: case 'help': case '--help': out(HELP); return 0;
      default: err(`Unknown command ${cmd}.\n\n${HELP}`); return 2;
    }
  } catch (e) {
    if (e instanceof Stop) { err(e.message); return e.exitCode; }
    err(`Unexpected failure: ${(e as Error)?.name ?? 'error'}${e instanceof RuntimeProblem ? `: ${e.message}` : ''}.`);
    return 70;
  }
}

/** Run directly: node engine/iss-engine.mjs <command> ... */
if (process.argv[1] && path.resolve(process.argv[1]) === engineFile()) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
