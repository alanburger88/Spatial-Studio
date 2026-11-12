import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const r = (p: string) => path.resolve(__dirname, '../../', p);
const api = process.env.API_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@iss/model': r('packages/model/src/index.ts'),
      '@iss/resolver': r('packages/resolver/src/index.ts'),
      '@iss/renderers': r('packages/renderers/src/index.ts'),
      '@iss/scenarios': r('packages/scenarios/src/index.ts'),
      '@iss/validation': r('packages/validation/src/index.ts'),
    },
  },
  server: { proxy: { '/api': { target: api, changeOrigin: true } }, fs: { allow: [r('.')] } },
  preview: { proxy: { '/api': { target: api, changeOrigin: true } } },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 2500 },
});
