import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Absolute path to the DOM-free build of decode-named-character-reference.
 *
 * Resolved rather than written literally: the package's `exports` map has no `./index.js`
 * subpath, so an alias by specifier fails to resolve.
 */
const require = createRequire(import.meta.url);
const decodeEntitiesNodeBuild = require
  .resolve('decode-named-character-reference')
  .replace(/index\.dom\.js$/, 'index.js');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // better-auth/react is a linked workspace dependency with its own nested react
    // symlink, which Vite would otherwise pre-bundle into a second React instance —
    // producing "invalid hook call" at runtime. Force one copy.
    dedupe: ['react', 'react-dom'],
    alias: {
      /**
       * Force the DOM-free build of decode-named-character-reference.
       *
       * The package's browser build decodes HTML entities with `document.createElement`.
       * The markdown pipeline pulls it in, and the import runs in a Web Worker where
       * there is no document — without this the worker dies on load with "document is
       * not defined". The `worker` export condition would also select the right build,
       * but Vite's dep optimizer pre-bundles for the browser before worker resolution
       * applies, so the alias is what actually takes effect.
       *
       * The Node build uses a static character map and behaves identically.
       */
      'decode-named-character-reference': decodeEntitiesNodeBuild,
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    proxy: {
      // Proxying keeps the API same-origin in development, so session cookies work
      // without CORS or SameSite workarounds. In production Pages routes /api to the
      // Worker, which is the same origin for real.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
