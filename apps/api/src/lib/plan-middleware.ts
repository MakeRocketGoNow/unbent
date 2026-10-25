import { PLAN_INACTIVE_CODE, PLAN_INACTIVE_MESSAGE } from '@unbent/shared';
import { createMiddleware } from 'hono/factory';
import { billingOn } from './stripe.js';
import { lapsed, planFor } from './plan.js';
import type { AppEnv } from '../types.js';

/**
 * The plan's rule for writes (MAK-108, decided in MAK-47; the free plan, 2026-10-24). An
 * account whose plan has ended is on the free plan: under its limits it writes as
 * before, and past them it is read-only, every write refused with a 402 except a
 * delete. Reads, search, export and an assistant's reads all keep working, so an
 * expired trial or a lapsed subscription loses nothing and can take everything away;
 * the one state and the one code path for every way of lapsing.
 *
 * Which of the two a lapsed account is, is what it holds, and that is its store's. So
 * this does not decide it: on the routes whose writes go to the store with the free
 * plan's limits (`HELD_IN_STORE`), a lapsed account is let through and the store
 * refuses there (`UserStore.assertFree`), in the call that would write, so no request
 * pays a second call to the object to ask first. What is left here is the rest.
 *
 * Global, in front of every `/api` route, and deny by default: a request that is not a
 * read, from an account with no plan holding, is refused unless `exemptFromPlan` or
 * `HELD_IN_STORE` says otherwise. The alternative (a middleware mounted on each
 * mutating route) is the one a new route forgets, and the forgetting is silent. This way
 * a new route is read-only for a lapsed account until someone adds it here with a
 * reason, and `plan-middleware.test.ts` reads the app's route table and fails on a
 * mutating route it has not been told about.
 *
 * Runs after `sessionMiddleware` and before the routes' own `requireAuth`, so a request
 * with no session passes through to the 401 it would get anyway: the plan is the
 * account's, and there is no account to ask about. An instance with billing off never
 * reads a row. One D1 read by key per write let through, which the outbox's replay pays
 * once per entry; the row goes on the context for the repos, which carry the free
 * plan's limits and the store's room from it, and for the upload routes, which also
 * want the quota.
 */

const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The writes any account may make whatever it holds, by method and path: the read-only
 * account's whole list. Each is one of:
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

/**
 * The writes the free plan holds an account to, in its store: every one ends in a store
 * method that takes the free plan's limits (`freeOnly` or the whole pair in
 * `UserStore`), so a lapsed account's request goes through to it, and the store answers
 * `PLAN_INACTIVE` for an account past the limits and `FREE_NOTES_FULL` for a note past
 * the count. A route belongs here only when every write it makes is one of those; a
 * route that writes anything the store does not hold (a row in D1, a call out) stays
 * off it, and is refused a lapsed account by the rule below until it has a check of
 * its own.
 *
 *   - notes made, changed, duplicated or put back from their history, one or many;
 *   - notebooks, their fields, and tags, made or changed;
 *   - files added to a note, copied or fetched, whose row the store records;
 *   - the imports, of a note, a notebook's definition or Evernote's ENML;
 *   - an Auto-fill press, which the store counts and refuses in the call that reads
 *     the note.
 */
const HELD_IN_STORE: ReadonlyArray<[method: string, pattern: string]> = [
  ['POST', '/api/notes'],
  ['PATCH', '/api/notes'],
  ['PATCH', '/api/notes/:x'],
  ['POST', '/api/notes/:x/revisions/:x/restore'],
  ['POST', '/api/notes/:x/duplicate'],
  ['POST', '/api/notes/:x/autofill'],
  ['POST', '/api/notebooks'],
  ['PATCH', '/api/notebooks/:x'],
  ['POST', '/api/notebooks/:x/fields'],
  ['PUT', '/api/notebooks/:x/fields/order'],
  ['PATCH', '/api/notebooks/:x/fields/:x'],
  ['POST', '/api/notebooks/:x/fields/:x/options'],
  ['PATCH', '/api/tags/:x'],
  ['PUT', '/api/notes/:x/files'],
  ['POST', '/api/notes/:x/files/copy'],
  ['POST', '/api/notes/:x/files/fetch'],
  ['POST', '/api/import/note'],
  ['POST', '/api/import/notebook'],
  ['POST', '/api/import/enml'],
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

/** Whether this write's store call carries the free plan's limits, so a lapsed account goes on to it. Pure, for the route-table test. */
export function heldInStore(method: string, path: string): boolean {
  return HELD_IN_STORE.some(([m, pattern]) => m === method && matches(pattern, path));
}

export const requireActivePlan = createMiddleware<AppEnv>(async (c, next) => {
  if (!billingOn(c.env) || exemptFromPlan(c.req.method, c.req.path)) return next();
  const userId = c.get('userId');
  if (!userId) return next();
  const row = await planFor(c.env.DB, userId);
  // The row goes on the context either way: the repos read the free plan's limits off
  // it (`writeLimitsOf`), and the upload routes the quota.
  if (lapsed(row, Date.now()) && !heldInStore(c.req.method, c.req.path)) {
    return c.json({ code: PLAN_INACTIVE_CODE, error: PLAN_INACTIVE_MESSAGE }, 402);
  }
  c.set('plan', row);
  await next();
});
