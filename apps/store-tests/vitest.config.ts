import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

/**
 * The per-user store's tests, run against the real thing: a SQLite-backed Durable Object
 * inside workerd, with the schema, triggers and FTS tables production runs. A fake of
 * `ctx.storage.sql` would only ever agree with what it was told, and the point of these
 * tests is the parts a fake gets wrong — a bind count the runtime refuses, a cascade the
 * schema does or does not perform, a plan that reads the whole table.
 *
 * Why its own package rather than a third project in apps/api: Cloudflare's vitest
 * integration peers on vitest 4 only, and every other package here is on 5. Pinning the
 * API to 4 would put two vitest majors in one workspace and risk splitting Better Auth's
 * optional vitest peer into two copies. Isolated here, the integration can break on a
 * toolchain bump without touching the API, and be dropped without touching it either —
 * the live suite still covers the store through the routes.
 *
 * `../api/wrangler.toml`'s `local` environment is the one loaded: it declares the object,
 * a local D1 and R2, and no Workers AI, so the tests need no Cloudflare login. The assets
 * directory it names may not exist in CI, which the plugin tolerates.
 *
 * `isolatedStorage` is left at its default and deliberately not relied on: measured on
 * 2026-09-29, it does not undo a SQLite-backed object's writes between tests, even after
 * the instance is evicted. Every test mints its own object name instead — see
 * test/helpers.ts.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../api/wrangler.toml', environment: 'local' },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    /*
     * An error thrown inside the object — a refused user id in the constructor, an
     * `InvalidFieldValue` a test expects — reaches the test as a rejection the test
     * handles, and is *also* reported by workerd as an uncaught exception in the object's
     * own context, which the plugin forwards to vitest as an unhandled error and vitest
     * then counts as a failed run (measured 2026-09-29: 7 passing tests, exit code 1).
     * The report is an artifact of where the error was thrown, not a leak in the tests,
     * and there is no way to handle it from the test side. So those reports are ignored.
     * An assertion that fails still fails its test; this only stops the object's own
     * throw from failing the run a second time.
     */
    dangerouslyIgnoreUnhandledErrors: true,
    // A seeded store of a few thousand notes is built inside a test; the runtime is quick
    // at it (half a second for 13k rows in the dry run) but a cold workerd is not.
    testTimeout: 60_000,
  },
});
