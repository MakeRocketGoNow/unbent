import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createServer, defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { VitePWA } from 'vite-plugin-pwa';

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
 * pdf.js 6 decodes JBIG2 and CCITT fax images (the 1-bit encodings every B&W document
 * scanner writes) and JPEG 2000 with these modules, and without them it drops the image
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
 * The commit this build is made from, for Settings › About, the account menu's instance
 * line and `index.html`. See `src/build-info.ts` for why it is the page's commit and not
 * the server's.
 *
 * Read from git rather than from `GITHUB_SHA`, so a local build and a self-hoster's
 * `pnpm release` say the same thing CI does. `UNBENT_COMMIT` overrides it for a preview:
 * a pull request is checked out at GitHub's merge commit, which is on no branch and in no
 * one's log, and the PR comment names the head instead, so the preview names the head too.
 *
 * The link is to whichever repository CI ran in, so a fork's instance points at the fork.
 * Outside CI there is none: the commit may never have been pushed.
 *
 * Null when there is no git to ask, which the menu answers by drawing no line.
 */
function readBuildInfo() {
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit: string;
  try {
    commit = process.env.UNBENT_COMMIT || git('rev-parse', 'HEAD');
  } catch {
    return null;
  }
  let date: string | null = null;
  try {
    date = git('log', '-1', '--format=%cI', commit) || null;
  } catch {
    // A preview's head is not in its shallow checkout; the line goes without a date.
  }
  let dirty = false;
  if (!process.env.CI) {
    try {
      dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    } catch {
      // Not knowing is not the same as having changes.
    }
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo } = process.env;
  const repoUrl = server && repo ? `${server}/${repo}` : null;
  const url = repoUrl ? `${repoUrl}/commit/${commit}` : null;
  return { commit, date, url, repo: repoUrl, dirty };
}

const BUILD_INFO = readBuildInfo();

/**
 * better-auth/react is a linked workspace dependency with its own nested react symlink,
 * which Vite would otherwise pre-bundle into a second React instance, producing "invalid
 * hook call" at runtime. Force one copy. Shared with the prerender's server, which loads
 * the same components.
 */
const RESOLVE_DEDUPE = ['react', 'react-dom'];

const RESOLVE_ALIAS = {
  /**
   * Force the DOM-free build of decode-named-character-reference.
   *
   * The package's browser build decodes HTML entities with `document.createElement`.
   * The markdown pipeline pulls it in, and the import runs in a Web Worker where
   * there is no document: without this the worker dies on load with "document is
   * not defined". The `worker` export condition would also select the right build,
   * but Vite's dep optimizer pre-bundles for the browser before worker resolution
   * applies, so the alias is what actually takes effect.
   *
   * The Node build uses a static character map and behaves identically.
   */
  'decode-named-character-reference': decodeEntitiesNodeBuild,
};

/** `<meta name="unbent-commit">`, so a deploy's commit can be read without signing in. */
function buildMeta(): Plugin {
  return {
    name: 'unbent:build-meta',
    transformIndexHtml() {
      if (!BUILD_INFO) return [];
      return [
        { tag: 'meta', attrs: { name: 'unbent-commit', content: BUILD_INFO.commit }, injectTo: 'head' },
      ];
    },
  };
}

/**
 * Writes the pages `src/prerender.tsx` lists out as static HTML, after the client build.
 *
 * A crawler and a link preview run no script, so what they read of a page is what the
 * server sends, and for every route that is `index.html`: "Unbent", the front page's
 * sentence, and an empty `#root`. The pages for people who are not signed in are the
 * ones a search lands on, so each of those is rendered here, in Node, to a copy of the
 * built `index.html` with its own head (`PageMeta`) and its markup inside `#root`. The
 * Worker serves the copy for the page's address (`apps/api/src/lib/front-pages.ts`) and
 * the app takes over in the browser (`main.tsx`).
 *
 * Rendered through a second, in-process Vite server in middleware mode rather than a
 * separate SSR build, so the components are loaded exactly as the client build resolved
 * them (the same aliases and dedupe below) and nothing else has to be kept in step. It is
 * given only the plugins and resolution the components need, not this file's: the router
 * plugin would generate the route tree again and the PWA plugin would try to build a
 * worker. Off for a build that is not the client's (the PWA plugin builds the worker as
 * a second build of its own, with no config file, so this never sees it; the guard is
 * against anyone adding one).
 *
 * Addresses in the head stay site-relative: the build does not know the origin it will
 * be served on, and the Worker completes them from the one it is.
 */
function prerender(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'unbent:prerender',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      if (config.build.ssr || config.build.lib) return;
      const server = await createServer({
        configFile: false,
        root: config.root,
        mode: config.mode,
        logLevel: 'warn',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, watch: null },
        plugins: [react()],
        resolve: { dedupe: RESOLVE_DEDUPE, alias: RESOLVE_ALIAS },
        define: { __UNBENT_BUILD__: JSON.stringify(BUILD_INFO) },
      });
      try {
        const { PAGES, render } = (await server.ssrLoadModule('/src/prerender.tsx')) as typeof import('./src/prerender.js');
        const shell = readFileSync(join(config.build.outDir, 'index.html'), 'utf8');
        for (const [path, page] of Object.entries(PAGES)) {
          const file = join(config.build.outDir, page.file);
          writeFileSync(file, prerenderedPage(shell, await render(path), page.meta, path));
          config.logger.info(`prerendered ${path} -> ${page.file}`);
        }
      } finally {
        await server.close();
      }
    },
  };
}

/**
 * The built shell with one page's head and markup in it. Each replacement insists on
 * finding its target, so a change to `index.html` that moves one fails the build here
 * rather than shipping a page with the wrong title.
 */
function prerenderedPage(shell: string, html: string, meta: { title: string; description: string; image: string }, path: string): string {
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const replace = (page: string, target: RegExp, replacement: string) => {
    if (!target.test(page)) throw new Error(`prerender: index.html has no ${target}`);
    return page.replace(target, replacement);
  };
  let page = shell;
  page = replace(page, /<title>[^<]*<\/title>/, `<title>${escape(meta.title)}</title>`);
  page = replace(page, /<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${escape(meta.description)}" />`);
  page = replace(page, /<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escape(meta.title)}" />`);
  page = replace(page, /<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escape(meta.description)}" />`);
  page = replace(
    page,
    /<meta property="og:image" content="[^"]*"\s*\/?>/,
    `<meta property="og:image" content="${escape(meta.image)}" />\n    <meta property="og:url" content="${escape(path)}" />\n    <link rel="canonical" href="${escape(path)}" />`,
  );
  page = replace(page, /<div id="root"><\/div>/, `<div id="root">${html}</div>`);
  return page;
}

/**
 * Ports come from the environment so that a second checkout can run its own pair.
 * `scripts/dev.mjs` derives them from the worktree; started by hand, the defaults are the
 * main checkout's.
 */
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const API_PORT = Number(process.env.API_PORT ?? 8787);

export default defineConfig({
  define: {
    __UNBENT_BUILD__: JSON.stringify(BUILD_INFO),
  },
  plugins: [
    // Must precede react(): the plugin generates routeTree.gen.ts from src/routes, and
    // the React plugin has to see the generated file rather than race it.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    pdfjsWasm(),
    buildMeta(),
    prerender(),
    /*
     * The service worker that lets the installed app open with no connection. See
     * `src/sw/sw.ts`.
     *
     * `injectManifest`, so the plugin's whole job is to build that file and write this
     * build's file list into it. The worker's behaviour is ours, written against Workbox's
     * runtime modules, which are pinned to the exact version the plugin's `workbox-build`
     * carries and move with it as one Dependabot group. Registration is `workbox-window`,
     * not the plugin's virtual module (`src/sw-register.ts`). Held at that distance on
     * purpose: `apps/store-tests` is on a vitest major of its own because a plugin lagged
     * its host, and if this one ever lags Vite, a small plugin that writes the file list
     * replaces it without the worker changing.
     *
     * `manifest: false` because `public/manifest.webmanifest` is written by hand: its file
     * handlers are what a scanner hands files to, and generating one would replace it.
     * Off in development, where Vite serves modules the worker would cache under names the
     * next edit changes; the worker is tried against the built app the Worker serves.
     */
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      manifest: false,
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{html,js,mjs,css,wasm,png,svg,webmanifest}'],
        globIgnores: [
          /*
           * pdf.js's pure-JavaScript stand-ins for its WebAssembly decoders, for browsers
           * without WebAssembly (none this app runs in). Half a megabyte that would be
           * fetched on every install and never read.
           */
          '**/*_nowasm_fallback.js',
          /*
           * The import worker parses ENEX and Markdown and uploads as it goes, so it has
           * nothing to do offline; it is the largest chunk after pdf.js and loads only
           * when an import starts, which the HTTP cache already covers.
           */
          '**/import-worker-*.js',
          /*
           * The story's static copy (`src/prerender.tsx`), a page for people who are not
           * signed in. The shell draws the same page offline, and the asset layer answers
           * `/why.html` with a redirect to `/why`, which a precache fill cannot store
           * under the file's name.
           */
          'why.html',
        ],
      },
    }),
  ],
  resolve: {
    dedupe: RESOLVE_DEDUPE,
    alias: RESOLVE_ALIAS,
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
        // The change feed's push is a WebSocket at /api/changes/socket, and the proxy
        // forwards an upgrade only when told to; without this the socket never opens in
        // development, while in production the Worker serves the page itself and there
        // is no proxy to cross.
        ws: true,
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
