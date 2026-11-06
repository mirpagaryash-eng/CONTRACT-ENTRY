import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'client',
  base: './',
  resolve: { alias: [{ find: /^\.\/api$/, replacement: resolve('client/src/preview-api.js') }] },
  build: {
    outDir: '../preview-dist', emptyOutDir: true,
    assetsInlineLimit: 1_000_000,
    rollupOptions: { input: resolve('client/preview.html') },
  },
});
