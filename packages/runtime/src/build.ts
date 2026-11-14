import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSIONS } from './core';

/**
 * Builds the engine of a runnable package: the command line (src/cli.ts) with the resolver, the renderers and the
 * data contract bundled by esbuild into ONE plain JavaScript file that runs with Node alone. Studio-side only; this
 * file is not part of the bundle.
 *
 * The bundle is the same bytes every time it is built from the same source with the same esbuild: paths in it are
 * relative to the repository, nothing in it states when it was built.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);

export interface EngineBundle {
  /** engine/iss-engine.mjs */
  code: Buffer;
  sha256: string;
  esbuild: string;
  versions: typeof ENGINE_VERSIONS;
}

let cached: Promise<EngineBundle> | null = null;

/** Built once per process (the source does not change while the studio runs). */
export function engineBundle(): Promise<EngineBundle> {
  cached ??= buildEngineBundle().catch((e) => { cached = null; throw e; });
  return cached;
}

export async function buildEngineBundle(): Promise<EngineBundle> {
  const esbuild = (await import('esbuild')) as typeof import('esbuild');
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(here, 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    minify: false,
    sourcemap: false,
    legalComments: 'eof',
    charset: 'utf8',
    // The page composer is loaded only when a PDF is asked for, from the copy next to the engine.
    external: ['playwright-core', 'playwright', 'esbuild'],
    // Resolve the workspace packages the way the studio does (their source), never a stale copy.
    alias: {
      '@iss/model': path.join(repoRoot, 'packages/model/src/index.ts'),
      '@iss/resolver': path.join(repoRoot, 'packages/resolver/src/index.ts'),
      '@iss/renderers': path.join(repoRoot, 'packages/renderers/src/index.ts'),
      '@iss/scenarios': path.join(repoRoot, 'packages/scenarios/src/index.ts'),
    },
    banner: { js: `// InfoSlips Spatial Studio runnable package engine. Engine ${ENGINE_VERSIONS.engine}; renderers ${ENGINE_VERSIONS.pagedRenderer}, ${ENGINE_VERSIONS.htmlRenderer}, ${ENGINE_VERSIONS.emailRenderer}, ${ENGINE_VERSIONS.smsRenderer}.\n// Its SHA-256 is in engine.json next to it; \`node engine/iss-engine.mjs version\` computes it from this file.` },
    logLevel: 'silent',
  });
  if (result.errors.length) throw new Error(`The engine could not be bundled: ${result.errors.map((e) => e.text).join('; ')}`);
  const code = Buffer.from(result.outputFiles[0].contents);
  return { code, sha256: createHash('sha256').update(code).digest('hex'), esbuild: (esbuild as { version: string }).version, versions: ENGINE_VERSIONS };
}

/**
 * The pinned page composer the package carries (playwright-core, Apache-2.0), file by file as published, with its
 * licence and notices. The browser itself is not included: it is a few hundred megabytes and differs per platform.
 */
export function composerFiles(): { version: string; chromiumRevision: string | null; files: Array<{ path: string; data: Buffer }> } {
  const dir = path.dirname(require.resolve('playwright-core/package.json'));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string };
  let chromiumRevision: string | null = null;
  try { chromiumRevision = (JSON.parse(readFileSync(path.join(dir, 'browsers.json'), 'utf8')).browsers as Array<{ name: string; revision: string; browserVersion?: string }>).find((b) => b.name === 'chromium')?.browserVersion ?? null; } catch { /* not listed */ }
  const files: Array<{ path: string; data: Buffer }> = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) files.push({ path: r, data: readFileSync(path.join(dir, r)) });
    }
  };
  walk('');
  return { version: pkg.version, chromiumRevision, files };
}
