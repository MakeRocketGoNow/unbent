import type { RawEnv } from './types.js';
import { app } from './app.js';
import { withAppUrl } from './lib/app-url.js';
import { MANIFEST_PATH, serveManifest } from './lib/manifest.js';
import { dumpStores } from './lib/backups.js';
import { cronJob } from './lib/cron.js';
import { sweepStores } from './lib/sweep.js';
import { LAPSE_MAIL_PER_RUN, notifyLapsedPlans } from './lib/plan-mail.js';

/**
 * The per-account note store, exported so the runtime can construct it. This is one of
 * the two files allowed to import from `cloudflare:workers` as a value (the class module
 * is the other); everywhere else reaches the object through the `USER_STORE` binding and
 * an `import type`, so the Node-run unit tests never load a module that only exists in
 * workerd. A static test in src/store/ holds that line.
 *
 * The routes themselves are composed in app.ts, which imports none of this, so a unit
 * test can read the route table (`plan-middleware.test.ts` does) without loading the
 * object class.
 */
export { UserStore } from './store/user-store.js';

/** Consumed by the SPA through `hc<AppType>()` for end-to-end types with no codegen. */
export type { AppType } from './app.js';

/**
 * The entry point settles `APP_URL` before Hono sees the request, so every route and
 * every Better Auth instance downstream can keep treating it as a plain string. See
 * lib/app-url.ts for what happens when a deployment has not set one.
 */
export default {
  fetch(request: Request, env: RawEnv, ctx: ExecutionContext): Response | Promise<Response> {
    // Ahead of Hono, so the manifest costs an asset read and not a session lookup; see
    // lib/manifest.ts.
    if (new URL(request.url).pathname === MANIFEST_PATH) return serveManifest(request, env);
    return app.fetch(request, withAppUrl(env, request), ctx);
  },
  /**
   * Two jobs on one trigger, `17,47 * * * *` in wrangler.toml: at :17 the walk over every
   * account's note store, one batch an hour (lib/sweep.ts), and at :47 the daily dumps
   * into the backups bucket, which do nothing where no bucket is bound (lib/backups.ts).
   * One trigger rather than two so that both run on every instance from one line, and
   * each is its own invocation with its own subrequests, so neither can spend the
   * other's. Told apart by the minute the run was scheduled for (`cronJob`). `waitUntil`
   * so neither is cut off at the handler's return.
   *
   * The sweep's run also tells a few accounts whose plan has run out (MAK-108,
   * lib/plan-mail.ts), before the walk. The mail names the address in `APP_URL`, which
   * no request is here to settle, so an instance that has not set it sends none and
   * says so. What the mail spent is handed to the walk, which budgets its expiries
   * around it: the two share one invocation's subrequests, and on Workers Free that is
   * fifty for both.
   */
  scheduled(controller: ScheduledController, env: RawEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(
      cronJob(controller.scheduledTime) === 'sweep'
        ? notifyLapsedPlans(env)
            .catch((err): { told: number; subrequests: number } => {
              console.error('[billing] lapse mail failed:', err);
              // A failure mid-run spent at most the query and a send and a mark per slot.
              return { told: 0, subrequests: 1 + 2 * LAPSE_MAIL_PER_RUN };
            })
            .then(({ subrequests }) => sweepStores(env, { spent: subrequests }))
        : dumpStores(env),
    );
  },
};
