import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * "Validated by veraPDF": a bridge to the free, open-source veraPDF validator when it is installed on this machine.
 * It is looked for at `VERAPDF_PATH` (the program, or the folder it is in) and then on the PATH. The studio never
 * downloads or installs it. When it is found, a PDF is validated against the PDF/UA-1 profile with machine-readable
 * output (`--flavour ua1 --format mrr`), with a time limit, and the verdict, the version and the failed rules come back
 * in plain words. Nothing here says a PDF is accessible on the studio's own checks.
 */

export const VERAPDF_NOT_INSTALLED = 'veraPDF is not installed on this machine';

export interface VeraPdfRule {
  /** `<specification> <clause>-<test>`, e.g. `ISO 14289-1:2014 7.1-3`. */
  id: string;
  specification: string;
  clause: string;
  testNumber: string;
  description: string;
  /** How many times the rule failed in this PDF. */
  count: number;
  /** Set when the rule fails because of what the composing browser cannot write (see `KNOWN_LIMIT_RULES`). */
  knownLimit?: string;
}

export type VeraPdfResult =
  | { status: 'not-installed'; message: string }
  | { status: 'ran'; version: string | null; profile: string; compliant: boolean; failedRules: VeraPdfRule[]; passedRules: number | null; failedChecks: number | null; ranAt: string; durationMs: number }
  | { status: 'error' | 'timeout'; version: string | null; message: string; ranAt: string; durationMs: number };

export interface VeraPdfInstall { executable: string; version: string | null }

const isExecutable = (p: string): boolean => {
  try { if (!statSync(p).isFile()) return false; accessSync(p, constants.X_OK); return true; } catch { return false; }
};
const NAMES = process.platform === 'win32' ? ['verapdf.bat', 'verapdf.cmd', 'verapdf.exe', 'verapdf'] : ['verapdf'];

/** Where veraPDF is: `VERAPDF_PATH` (a program or a folder), else the PATH. Null when it is not installed. */
export function findVeraPdf(env: NodeJS.ProcessEnv = process.env): string | null {
  const given = env.VERAPDF_PATH?.trim();
  if (given) {
    if (isExecutable(given)) return given;
    for (const n of NAMES) { const p = path.join(given, n); if (isExecutable(p)) return p; }
    return null;
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) for (const n of NAMES) { const p = path.join(dir, n); if (isExecutable(p)) return p; }
  return null;
}

function runProgram(exe: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    let child: ReturnType<typeof spawn>;
    try { child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < 20_000_000) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < 100_000) stderr += d; });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** The installed version ("1.26.2"), from `verapdf --version`. Null when it cannot be told. */
export async function veraPdfVersion(exe: string, timeoutMs = 20_000): Promise<string | null> {
  const r = await runProgram(exe, ['--version'], timeoutMs);
  const m = /veraPDF[^\d]*(\d+(?:\.\d+)+)/i.exec(r.stdout + '\n' + r.stderr) ?? /(\d+\.\d+\.\d+)/.exec(r.stdout);
  return m ? m[1] : null;
}

/** Whether veraPDF is installed, and its version (cached for the life of the process, per executable). */
const versions = new Map<string, Promise<string | null>>();
export async function veraPdfStatus(env: NodeJS.ProcessEnv = process.env): Promise<{ installed: false; message: string } | { installed: true; version: string | null }> {
  const exe = findVeraPdf(env);
  if (!exe) return { installed: false, message: VERAPDF_NOT_INSTALLED };
  if (!versions.has(exe)) versions.set(exe, veraPdfVersion(exe));
  return { installed: true, version: await versions.get(exe)! };
}

/**
 * Rules a PDF from the composing browser is expected to fail whatever the document does, with the reason in plain
 * words (docs/design/PDF_ACCESSIBILITY.md). Matched on the clause and test number of PDF/UA-1 (ISO 14289-1).
 */
export const KNOWN_LIMIT_RULES: Array<{ clause: string; test?: string; reason: string }> = [
  { clause: '5', reason: 'The PDF/UA identifier: the composing browser does not write it, so the PDF does not declare PDF/UA conformance.' },
  { clause: '7.1', test: '8', reason: 'The document metadata (XMP) that carries the title and the PDF/UA identifier: the composing browser does not write it.' },
  { clause: '7.1', test: '9', reason: 'The title in the document metadata (XMP): the composing browser writes the title only in the document information.' },
  { clause: '7.1', test: '3', reason: 'Decoration that is neither tagged nor marked as an artifact: the composing browser never writes artifact marks.' },
  { clause: '7.18.5', reason: 'Link descriptions (the link annotation’s Contents): the composing browser does not write them.' },
];
const knownLimitOf = (clause: string, test: string): string | undefined => KNOWN_LIMIT_RULES.find((k) => k.clause === clause && (!k.test || k.test === test))?.reason;

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
};
const decodeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

/**
 * Reads veraPDF's machine-readable report (MRR, XML): the verdict, the profile and every failed rule with its
 * description and the number of failed checks. Throws when the text is not such a report.
 */
export function parseVeraPdfReport(xml: string): { compliant: boolean; profile: string; failedRules: VeraPdfRule[]; passedRules: number | null; failedChecks: number | null; version: string | null } {
  const vr = /<validationReport\b[^>]*>/.exec(xml);
  if (!vr) {
    const err = /<taskException[^>]*>[\s\S]*?<exceptionMessage>([\s\S]*?)<\/exceptionMessage>/.exec(xml);
    throw new Error(err ? `veraPDF could not validate the PDF: ${decodeXml(err[1]).trim()}` : 'veraPDF did not return a validation report.');
  }
  const compliant = attr(vr[0], 'isCompliant') === 'true';
  const profile = attr(vr[0], 'profileName') ?? 'PDF/UA-1';
  const details = /<details\b[^>]*>/.exec(xml.slice(vr.index));
  const num = (v: string | null) => (v !== null && /^\d+$/.test(v) ? Number(v) : null);
  const failedRules: VeraPdfRule[] = [];
  const ruleRe = /<rule\b([^>]*)>([\s\S]*?)<\/rule>/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(xml))) {
    const head = `<rule ${m[1]}>`;
    if ((attr(head, 'status') ?? '').toLowerCase() !== 'failed') continue;
    const specification = attr(head, 'specification') ?? '';
    const clause = attr(head, 'clause') ?? '';
    const testNumber = attr(head, 'testNumber') ?? '';
    const description = decodeXml((/<description>([\s\S]*?)<\/description>/.exec(m[2])?.[1] ?? '').trim());
    const count = num(attr(head, 'failedChecks')) ?? (m[2].match(/<check\b[^>]*status="failed"/g) ?? []).length;
    const knownLimit = knownLimitOf(clause, testNumber);
    failedRules.push({ id: `${specification} ${clause}-${testNumber}`.trim(), specification, clause, testNumber, description, count, ...(knownLimit ? { knownLimit } : {}) });
  }
  const version = /<releaseDetails\b[^>]*\bid="(?:core|gui|validation-model)"[^>]*\bversion="([^"]+)"/.exec(xml)?.[1] ?? null;
  return { compliant, profile, failedRules, passedRules: details ? num(attr(details[0], 'passedRules')) : null, failedChecks: details ? num(attr(details[0], 'failedChecks')) : null, version };
}

/**
 * Validates PDF bytes against PDF/UA-1 with veraPDF, when it is installed. The PDF is written to a private temporary
 * folder that is removed afterwards. `timeoutMs` stops a run that hangs (the Java start-up alone takes seconds).
 */
export async function runVeraPdf(pdf: Uint8Array, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<VeraPdfResult> {
  const exe = findVeraPdf(opts.env ?? process.env);
  if (!exe) return { status: 'not-installed', message: VERAPDF_NOT_INSTALLED };
  const ranAt = new Date().toISOString();
  const t0 = Date.now();
  const dir = mkdtempSync(path.join(tmpdir(), 'iss-verapdf-'));
  try {
    const file = path.join(dir, 'document.pdf');
    writeFileSync(file, pdf);
    const r = await runProgram(exe, ['--flavour', 'ua1', '--format', 'mrr', file], opts.timeoutMs ?? 120_000);
    const durationMs = Date.now() - t0;
    const versionGuess = (await (versions.get(exe) ?? Promise.resolve(null)).catch(() => null)) ?? null;
    if (r.timedOut) return { status: 'timeout', version: versionGuess, message: `veraPDF did not finish within ${Math.round((opts.timeoutMs ?? 120_000) / 1000)} seconds and was stopped.`, ranAt, durationMs };
    try {
      const rep = parseVeraPdfReport(r.stdout);
      return { status: 'ran', version: rep.version ?? versionGuess, profile: rep.profile, compliant: rep.compliant, failedRules: rep.failedRules, passedRules: rep.passedRules, failedChecks: rep.failedChecks, ranAt, durationMs };
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)) + (r.stderr.trim() ? ` (${r.stderr.trim().split('\n').slice(-1)[0].slice(0, 300)})` : '');
      return { status: 'error', version: versionGuess, message: why, ranAt, durationMs };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
