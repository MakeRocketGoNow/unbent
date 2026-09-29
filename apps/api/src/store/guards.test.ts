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
      const text = code(file);
      for (const forbidden of [/\bfetch\s*\(/, /\bBLOBS\b/, /\benv\.AI\b/, /\bAnthropic\b/, /TYPESAFE/, /RESEND/]) {
        expect(text, `${rel(file)} matches ${forbidden}`).not.toMatch(forbidden);
      }
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
   * table that is about to be frozen and then dropped. The routes that may still name
   * `env.DB` are the ones whose data stays in D1 — the health check, the upload-grant
   * claim, connected apps — plus the blob sweep and test-fixture purge in admin.ts, which
   * move onto the object with the cutover and come off this list then. A new route that
   * needs the database is either a control-plane route, added here with a reason, or a
   * mistake.
   */
  it('keeps env.DB out of every route that is not on the control plane', () => {
    const allowed = new Set(['routes/health.ts', 'routes/uploads.ts', 'routes/connected-apps.ts', 'routes/admin.ts']);
    for (const file of walk(join(SRC, 'routes'))) {
      if (/\benv\.DB\b/.test(code(file))) {
        expect(allowed.has(rel(file)), `${rel(file)} reaches env.DB`).toBe(true);
      }
    }
  });
});
