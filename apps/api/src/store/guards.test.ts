/*
 * Node's types, for this file only. The API's tsconfig knows the Workers runtime and
 * nothing else, which is right for the code that ships; this test runs under Node in the
 * unit project and reads the source tree, which is the one thing here that needs `fs`.
 * A reference rather than `"node"` in the tsconfig's `types`, so the Worker's own files
 * are still checked against the runtime they run in and cannot quietly import a Node
 * built-in.
 */
/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The rules the per-account store lives by, held by reading the source rather than by
 * remembering them. Each is a line that is easy to cross by accident in a routine change
 * — a helper that fetches, a route that reaches for the database — and expensive to
 * discover afterwards, so each is a test that names the file that crossed it.
 */

const SRC = join(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).split('\\').join('/');

/**
 * The source with its comments removed, so a rule can be *explained* in a comment — this
 * file's own comments name every forbidden thing — without tripping itself. Naive about
 * strings (a `//` inside one ends the line early), which for these patterns only ever
 * makes a match less likely, never a false one.
 */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

describe('the per-account store', () => {
  /**
   * Rule 1: the object touches its SQLite and nothing else. An outbound call held open
   * inside an object keeps it awake and billing, and a store that fetched would be a
   * store whose behaviour depended on the network. R2 bytes, the language model, the
   * auto-fill API and mail all happen in the Worker, before or after the object call;
   * blob keys go through the object, bytes never do.
   */
  it('makes no outbound call and sees no binding but its own storage', () => {
    for (const file of walk(join(SRC, 'store'))) {
      let text = code(file);
      /*
       * The one `fetch(` the store may contain is a handler, not a call: the object's
       * `fetch(request)`, which the Worker forwards a WebSocket upgrade to, since a socket
       * cannot cross RPC. Exactly that declaration, in the class module, is taken out of
       * the text before the check; a `fetch(` anywhere else, or a second one here, fails.
       */
      if (rel(file) === 'store/user-store.ts') {
        const handler = /^  override async fetch\(request: Request\): Promise<Response> \{$/gm;
        expect(text.match(handler)?.length, 'the socket handler, declared once').toBe(1);
        text = text.replace(handler, '');
      }
      for (const forbidden of [/\bfetch\s*\(/, /\bBLOBS\b/, /\benv\.AI\b/, /\bAnthropic\b/, /TYPESAFE/, /RESEND/]) {
        expect(text, `${rel(file)} matches ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  /**
   * Rule 1's other half: the object never reaches the shared database either. `StoreEnv`
   * names nothing, so the compiler refuses a binding; this catches a D1 type or binding
   * named in the source another way. (The cutover's one-time copy was the one exception,
   * and went with the tables it read.)
   */
  it('never names D1 inside the store', () => {
    for (const file of walk(join(SRC, 'store'))) {
      expect(/\bD1Database\b|\benv\.DB\b|\bDB\s*:/.test(code(file)), `${rel(file)} reaches D1`).toBe(false);
    }
  });

  /**
   * `cloudflare:workers` exists only inside workerd. The unit tests run under Node, so a
   * value import of it anywhere in a module graph a unit test reaches breaks that test at
   * import time — and `auth.ts` and the routes are reached by several. The class module
   * and the entry point are the two places allowed to import it as a value; everything
   * else reaches the object through the `USER_STORE` binding and `import type`.
   */
  it('is the only place the Worker imports cloudflare:workers as a value', () => {
    const allowed = new Set(['store/user-store.ts', 'index.ts']);
    for (const file of walk(SRC)) {
      const text = code(file);
      const valueImport = /^import\s+(?!type\b)[^;]*from\s+['"]cloudflare:workers['"]/m;
      if (valueImport.test(text)) {
        expect(allowed.has(rel(file)), `${rel(file)} value-imports cloudflare:workers`).toBe(true);
      }
    }
  });

  /**
   * Note data lives in the object, and a route that queried D1 for it would be reading a
   * frozen table. The routes that may still name `env.DB` are the ones whose data stays in
   * D1 — the health check, the upload-grant claim, connected apps, the agreement to the
   * terms, which is a column on Better Auth's `user` row — and admin.ts, whose one use is
   * the test-fixture purge, which lists the throwaway accounts by their `user` rows. A new
   * route that needs the database is either a control-plane route, added here
   * with a reason, or a mistake.
   */
  it('keeps env.DB out of every route that is not on the control plane', () => {
    const allowed = new Set(['routes/health.ts', 'routes/uploads.ts', 'routes/connected-apps.ts', 'routes/legal.ts', 'routes/admin.ts']);
    for (const file of walk(join(SRC, 'routes'))) {
      if (/\benv\.DB\b/.test(code(file))) {
        expect(allowed.has(rel(file)), `${rel(file)} reaches env.DB`).toBe(true);
      }
    }
  });
});
