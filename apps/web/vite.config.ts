import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const r = (p: string) => path.resolve(__dirname, '../../', p);
const api = process.env.API_URL ?? 'http://127.0.0.1:3001';
// Separate optimizer cache per dev-server port so parallel instances never invalidate each other.
const portArg = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 'default';

/** Review links (wave 4): the public review page is sent with the same hardening headers as its API replies. */
const reviewHeaders = (req: { url?: string }, res: { setHeader(k: string, v: unknown): unknown }, next: () => void) => {
  if (req.url?.startsWith('/review/')) {
    // Vite's own page middleware sets Cache-Control later: keep it at no-store for this page.
    const set = res.setHeader.bind(res);
    res.setHeader = (k: string, v: unknown) => set(k, k.toLowerCase() === 'cache-control' ? 'no-store' : v);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex');
  }
  next();
};
const reviewPageHeaders = { name: 'review-page-headers', configureServer(s: any) { s.middlewares.use(reviewHeaders); }, configurePreviewServer(s: any) { s.middlewares.use(reviewHeaders); } };

export default defineConfig({
  plugins: [react(), reviewPageHeaders],
  cacheDir: `node_modules/.vite/port-${portArg}`,
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'zustand', 'immer', '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-link', '@tiptap/core'] },
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
