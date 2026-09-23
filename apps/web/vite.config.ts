import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

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

/**
 * pdf.js's WebAssembly image decoders, served at a fixed path the renderer points
 * `wasmUrl` at (see `src/pdf/render.ts`).
 *
 * pdf.js 6 decodes JBIG2 and CCITT fax images — the 1-bit encodings every B&W document
 * scanner writes — and JPEG 2000 with these modules, and without them it drops the image
 * and draws the page blank. It builds each file's URL from a base directory, so they
 * cannot go through Vite's hashed `?url` imports: they are served as-is in development
 * and copied under the same path into the build.
 */
const PDFJS_WASM_PATH = '/pdfjs/wasm/';
const pdfjsWasmDir = join(dirname(require.resolve('pdfjs-dist/package.json')), 'wasm');

function pdfjsWasm(): Plugin {
  // quickjs is the PDF-scripting engine, which the app never enables.
  const files = readdirSync(pdfjsWasmDir).filter(
    (name) => /\.(wasm|js)$/.test(name) && !name.startsWith('quickjs'),
  );
  return {
    name: 'unbent:pdfjs-wasm',
    configureServer(server) {
      server.middlewares.use(PDFJS_WASM_PATH, (req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
        if (!files.includes(name)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        res.end(readFileSync(join(pdfjsWasmDir, name)));
      });
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_WASM_PATH.slice(1)}${name}`,
          source: readFileSync(join(pdfjsWasmDir, name)),
        });
      }
    },
  };
}

/**
 * Ports come from the environment so that a second checkout can run its own pair.
 * `scripts/dev.mjs` derives them from the worktree; started by hand, the defaults are the
 * main checkout's.
 */
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const API_PORT = Number(process.env.API_PORT ?? 8787);

export default defineConfig({
  plugins: [
    // Must precede react(): the plugin generates routeTree.gen.ts from src/routes, and
    // the React plugin has to see the generated file rather than race it.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    pdfjsWasm(),
  ],
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
  optimizeDeps: {
    /**
     * The import worker is created only after Start import is clicked, so Vite cannot
     * discover its dependencies during its initial crawl. Discovering them mid-import makes
     * Vite optimize them and reload the page, resetting the UI while uploads are in progress.
     *
     * Keep this list aligned with runtime package imports in `packages/enex/src`. The
     * frontmatter codec's `yaml` is not here because `@unbent/shared` is imported by the
     * page itself, so the crawl already finds it.
     */
    include: [
      '@unbent/enex > @zip.js/zip.js',
      '@unbent/enex > hast-util-from-html',
      '@unbent/enex > hast-util-to-mdast',
      '@unbent/enex > mdast-util-gfm',
      '@unbent/enex > mdast-util-to-markdown',
      '@unbent/enex > saxes',
      '@unbent/enex > unist-util-visit',
      'pdfjs-dist/legacy/build/pdf.mjs',
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    ],
  },
  worker: {
    format: 'es',
  },
  server: {
    // Bind on all interfaces so Tailscale (and LAN) can reach the SPA. Default is
    // localhost-only, which is why `http://100.x.x.x:5173` times out while SSH works.
    host: true,
    // Vite blocks unknown Host headers (DNS rebinding guard). MagicDNS names fail
    // that check unless we allow them; true is fine for a private Tailscale/LAN bind.
    allowedHosts: true,
    port: WEB_PORT,
    // Falling through to the next free port is worse than not starting: the proxy below
    // forwards the browser's Host header unchanged, so the SPA would load on a port the
    // Worker pairs with a different one and every sign-in would fail as CSRF. Fail loudly.
    strictPort: true,
    proxy: {
      // Proxying keeps the API same-origin in development, so session cookies work
      // without CORS or SameSite workarounds. In production the API Worker serves the
      // built SPA itself, so the same origin is structural rather than arranged.
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
      // The analytics beacon takes the same path through the Worker in development as it
      // does in production; without this the SPA fallback answers with index.html and the
      // SDK reports a JSON parse error rather than a routing mistake.
      '/ingest': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
