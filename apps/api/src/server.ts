import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '127.0.0.1';
const { app } = await buildApp({ logger: process.env.NODE_ENV !== 'test' });
await app.listen({ port, host });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.close().then(() => process.exit(0)); });
