import { defineConfig } from 'vitest/config';
import path from 'node:path';
const r = (p: string) => path.resolve(__dirname, p);
export default defineConfig({
  resolve: { alias: {
    '@iss/model': r('packages/model/src/index.ts'),
    '@iss/resolver': r('packages/resolver/src/index.ts'),
    '@iss/renderers': r('packages/renderers/src/index.ts'),
    '@iss/scenarios': r('packages/scenarios/src/index.ts'),
    '@iss/validation': r('packages/validation/src/index.ts'),
  } },
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts'], testTimeout: 60000 },
});
