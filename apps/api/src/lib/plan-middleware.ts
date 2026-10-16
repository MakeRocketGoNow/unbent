import { PLAN_INACTIVE_CODE, PLAN_INACTIVE_MESSAGE } from '@unbent/shared';
import { createMiddleware } from 'hono/factory';
import { billingOn } from './paddle.js';
import { planFor, planStateOf } from './plan.js';
import type { AppEnv } from '../types.js';

/**
 * Read-only for an account whose plan has ended (MAK-108, decided in MAK-47): every
 * write is refused with a 402, except a delete. Reads, search, export and an assistant's
 * reads all keep working, so an expired trial or a lapsed subscription loses nothing and
 * can take everything away; the one state and the one code path for both.
 *
 * Global, in front of every `/api` route, and deny by default: a request that is not a
 * read is refused unless `exemptFromPlan` says otherwise. The alternative (a middleware
 * mounted on each mutating route) is the one a new route forgets, and the forgetting is
 * silent. This way a new route is read-only for a lapsed account until someone adds it
 * here with a reason, and `plan-middleware.test.ts` reads the app's route table and
 * fails on a mutating route it has not been told about.
 *
 * Runs after `sessionMiddleware` and before the routes' own `requireAuth`, so a request
 * with no session passes through to the 401 it would get anyway: the plan is the
 * account's, and there is no account to ask about. An instance with billing off never
 * reads a row. One D1 read by key per write let through, which the outbox's replay pays
 * once per entry; the row goes on the context for the upload routes, which also want the
 * quota.
 */

const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The writes a lapsed account may still make, by method and path. Each is one of:
 *
 *   - a delete, in whatever verb it comes (the trash, emptying it, deleting for good, a
 *     notebook, a tag, a file, a note's history) and the way back out of the trash,
 *     which creates nothing and is the undo of the one write that is allowed;
 *   - the account itself: signing in and out, passkeys, its name, deleting it
 *     (Better Auth's routes), agreeing to the terms, disconnecting an app;
 *   - the way out of being lapsed: the checkout, the portal, the webhook;
 *   - a read that travels as a POST, because its arguments are a body: the search index's
 *     fetch of files' text;
 *   - derived data the device writes back about files that are already there: a PDF's
 *     text layer, read by the browser's pass, which is not the person's writing and
 *     whose refusal would only make that pass fail on every open;
 *   - the operator's and the maintenance routes under `/admin`, which are the operator's
 *     to run, or self-scoped deletions and recounts; the test fixtures' purge is one;
 *   - the browser's error reports, which carry nothing of the account's;
 *   - the MCP endpoint, one POST for every tool: the write tools check for themselves
 *     (mcp/plan-gate.ts), so the reads keep answering;
 *   - the upload link's PUT, which carries no session for this to read: the route checks
 *     the plan of the account the link names, once it has claimed it.
 *
 * Patterns are matched against the whole path; `:x` stands for one segment. Order does
 * not matter: nothing here is a deny rule.
 */
const EXEMPT: ReadonlyArray<[method: string, pattern: string]> = [
  ['*', '/api/auth/*'],
  ['*', '/api/billing/*'],
  ['POST', '/api/legal/agree'],
  ['POST', '/api/connected-apps/:x/disconnect'],
  ['POST', '/api/client-errors'],
  ['*', '/api/admin/*'],
  ['*', '/api/mcp'],
  ['PUT', '/api/uploads/:x'],
  ['DELETE', '*'],
  ['POST', '/api/notes/trash'],
  ['POST', '/api/notes/restore'],
  ['POST', '/api/notes/purge'],
  ['POST', '/api/notes/:x/restore'],
  ['POST', '/api/attachments/texts'],
  ['PUT', '/api/notes/:x/files/:x/text'],
];

function matches(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) return path.startsWith(pattern.slice(0, -1)) || path === pattern.slice(0, -2);
  const want = pattern.split('/');
  const have = path.split('/');
  if (want.length !== have.length) return false;
  return want.every((seg, i) => seg === ':x' || seg === have[i]);
}

/** Whether a lapsed account may make this request. Pure, for the route-table test. */
export function exemptFromPlan(method: string, path: string): boolean {
  if (READS.has(method)) return true;
  return EXEMPT.some(([m, pattern]) => (m === '*' || m === method) && matches(pattern, path));
}

export const requireActivePlan = createMiddleware<AppEnv>(async (c, next) => {
  if (!billingOn(c.env) || exemptFromPlan(c.req.method, c.req.path)) return next();
  const userId = c.get('userId');
  if (!userId) return next();
  const row = await planFor(c.env.DB, userId);
  if (planStateOf(row, Date.now()) === 'inactive') {
    return c.json({ code: PLAN_INACTIVE_CODE, error: PLAN_INACTIVE_MESSAGE }, 402);
  }
  c.set('plan', row);
  await next();
});
