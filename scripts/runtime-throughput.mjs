#!/usr/bin/env node
// Measured throughput of a runnable package (phase 7). One run on one machine; not a load test.
//
//   node scripts/runtime-throughput.mjs <package.zip> [--count 5000] [--pdf-count 200] [--pdf-parallel 4] [--json out.json] [--image]
//   node scripts/runtime-throughput.mjs --api http://127.0.0.1:3103 --release harborcare-demo-r1 [...]
//
// It unpacks the package into a new temporary folder (outside this repository), has the package's own engine generate
// synthetic customers (`generate`), and times `node run` with a bare environment: email+SMS+HTML for --count customers,
// then PDF (with HTML, email and SMS) for --pdf-count customers at each --pdf-parallel setting. Peak memory is the
// largest sum of resident memory over the run's process tree (Node and, for PDF, the browser), sampled every 100 ms
// from /proc (Linux only; reported as null elsewhere). With --image it also builds the container image, but only when
// a container daemon answers `docker info`.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, platform, release as osRelease, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const count = Number(opt('count', 5000));
const pdfCount = Number(opt('pdf-count', 200));
const pdfParallel = String(opt('pdf-parallel', '4')).split(',').map(Number);

/* --------------------------------------------------------------- the package */

async function packageZip() {
  const api = opt('api');
  if (api) {
    const rel = opt('release');
    if (!rel) throw new Error('--api needs --release <release id>');
    const r = await fetch(`${api}/api/v1/releases/${rel}/runtime?wait=1`);
    if (!r.ok) throw new Error(`The API answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const file = args.find((a) => !a.startsWith('--') && a.endsWith('.zip'));
  if (!file) throw new Error('Give a package ZIP, or --api <origin> --release <id>.');
  return readFileSync(file);
}

/** A small ZIP reader (stored and deflated entries), enough for the studio's own ZIPs. */
function unzip(zip, into) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  const n = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  let top = null;
  for (let i = 0; i < n; i++) {
    const nameLen = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), offset = zip.readUInt32LE(at + 42);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + size);
    const file = path.join(into, ...name.split('/'));
    if (!file.startsWith(into + path.sep)) throw new Error(`Unsafe path in the ZIP: ${name}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, method === 8 ? inflateRawSync(body) : body);
    top ??= name.split('/')[0];
    at += 46 + nameLen + extra + comment;
  }
  return path.join(into, top);
}

/* --------------------------------------------------------------- measuring */

const env = () => ({ PATH: process.env.PATH, HOME: tmpdir(), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), ...(process.env.CHROMIUM_PATH ? { CHROMIUM_PATH: process.env.CHROMIUM_PATH } : {}) });

function treeRssKiB(root) {
  if (platform() !== 'linux') return null;
  const kids = new Map();
  const rss = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(Number(d));
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${d}/status`, 'utf8'));
      rss.set(Number(d), m ? Number(m[1]) : 0);
    } catch { /* the process ended meanwhile */ }
  }
  let sum = 0;
  const walk = (pid) => { sum += rss.get(pid) ?? 0; for (const k of kids.get(pid) ?? []) walk(k); };
  walk(root);
  return sum;
}

function timed(cwd, argv) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, argv, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.stdout.on('data', () => {});
    let peak = null;
    const sample = () => { const v = treeRssKiB(child.pid); if (v !== null) peak = Math.max(peak ?? 0, v); };
    const timer = setInterval(sample, 100);
    child.on('exit', (code) => {
      clearInterval(timer);
      resolve({ code, seconds: Number(process.hrtime.bigint() - t0) / 1e9, peakTreeRssMiB: peak === null ? null : Math.round(peak / 1024), stderr: err.trim().split('\n').slice(-2).join(' ') });
    });
  });
}

/* --------------------------------------------------------------- the run */

const zip = await packageZip();
const work = mkdtempSync(path.join(tmpdir(), 'iss-throughput-'));
const pkg = unzip(zip, work);
const runtime = JSON.parse(readFileSync(path.join(pkg, 'runtime.json'), 'utf8'));
const machine = { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)), os: `${platform()} ${osRelease()}`, node: process.version };
console.error(`Package ${runtime.release.id} (${runtime.release.title}), engine ${runtime.engine.version}, unpacked to ${pkg}`);

const results = { note: 'One run on one development machine, not a load test. Customers are engine-generated synthetic customers, repeated with their own record ids.', machine, release: runtime.release, engine: runtime.engine.version, runs: [] };

const gen = spawnSync(process.execPath, ['engine/iss-engine.mjs', 'generate', '--count', String(Math.max(count, pdfCount)), '--out', path.join(work, 'customers.jsonl')], { cwd: pkg, env: env(), encoding: 'utf8' });
if (gen.status !== 0) throw new Error(`generate failed: ${gen.stderr}`);
results.generated = gen.stderr.trim();
const lines = readFileSync(path.join(work, 'customers.jsonl'), 'utf8').split('\n').filter(Boolean);
writeFileSync(path.join(work, 'pdf.jsonl'), lines.slice(0, pdfCount).join('\n') + '\n');
writeFileSync(path.join(work, 'bulk.jsonl'), lines.slice(0, count).join('\n') + '\n');

const record = async (label, file, outputs, parallel) => {
  const out = path.join(work, `out-${results.runs.length + 1}`);
  const argv = ['run', '--data', file, '--outputs', outputs, '--out', out, ...(parallel ? ['--parallel', String(parallel)] : [])];
  const r = await timed(pkg, argv);
  const summary = existsSync(path.join(out, 'summary.json')) ? JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8')) : null;
  const docs = summary?.produced ?? 0;
  const row = {
    label, outputs, parallel: parallel ?? null, exitCode: r.code, customers: summary?.lines ?? null, produced: docs, stopped: summary?.stopped ?? null, invalid: summary?.invalid ?? null, failed: summary?.failed ?? null, files: summary?.files ?? null,
    wallSeconds: Number(r.seconds.toFixed(2)),
    documentSetsPerSecond: Number((docs / r.seconds).toFixed(2)),
    documentSetsPerCoreHour: Math.floor((docs / r.seconds) * 3600 / machine.cores),
    peakTreeRssMiB: r.peakTreeRssMiB, engineMaxRssMiB: summary ? Math.round(summary.engineMaxRssKiB / 1024) : null,
  };
  results.runs.push(row);
  console.error(JSON.stringify(row));
  rmSync(out, { recursive: true, force: true });
};

await record('email+SMS+HTML', path.join(work, 'bulk.jsonl'), 'html,email,sms');
for (const p of pdfParallel) await record(`PDF+HTML+email+SMS, ${p} pages in parallel`, path.join(work, 'pdf.jsonl'), 'pdf,html,email,sms', p);

/* --------------------------------------------------------------- the container image, only when a daemon answers */
const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15000 });
results.container = info.status === 0 && info.stdout.trim()
  ? { daemon: `Docker ${info.stdout.trim()}`, built: false }
  : { daemon: null, built: false, why: `No container daemon answered \`docker info\`${info.error ? ` (${info.error.code})` : ''}; no image was built.` };
if (flag('image') && results.container.daemon) {
  const b = spawnSync('docker', ['build', '-f', 'image/Dockerfile', '-t', path.basename(pkg), '.'], { cwd: pkg, encoding: 'utf8', timeout: 1_800_000 });
  results.container = { ...results.container, built: b.status === 0, output: (b.stderr || b.stdout).trim().split('\n').slice(-5).join('\n') };
}

const json = JSON.stringify(results, null, 2);
if (opt('json')) writeFileSync(opt('json'), json + '\n');
console.log(json);
rmSync(work, { recursive: true, force: true });
