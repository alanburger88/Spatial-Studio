import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional local, uncommitted .env at the repository root (e.g. AI_PROVIDER/AI_API_KEY for live AI).
// Values already set in the real environment win. Never read by the browser bundle.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { buildApp } = await import('./app');

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '127.0.0.1';
const { app } = await buildApp({ logger: process.env.NODE_ENV !== 'test' });
await app.listen({ port, host });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.close().then(() => process.exit(0)); });
