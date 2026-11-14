import { defineConfig } from 'vitest/config';
import path from 'node:path';
const r = (p: string) => path.resolve(__dirname, p);
export default defineConfig({
  resolve: { alias: {
    '@iss/resolver': r('packages/resolver/src/index.ts'),
    '@iss/renderers': r('packages/renderers/src/index.ts'),
    '@iss/scenarios': r('packages/scenarios/src/index.ts'),
    '@iss/validation': r('packages/validation/src/index.ts'),
    '@iss/runtime/build': r('packages/runtime/src/build.ts'),
    '@iss/runtime': r('packages/runtime/src/index.ts'),
    '@iss/model/fixtures': r('packages/model/src/fixtures.ts'),
    '@iss/model/samples/index': r('packages/model/src/samples/index.ts'),
    '@iss/model': r('packages/model/src/index.ts'),
  } },
  // Unit tests never call a live AI model, whatever keys the machine has: they would cost money and stop being repeatable.
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts'], testTimeout: 60000, env: { AI_PROVIDER: 'offline', AI_API_KEY: '', ANTHROPIC_API_KEY: '' } },
});
