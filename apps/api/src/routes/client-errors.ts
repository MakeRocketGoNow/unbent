import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppEnv } from '../types.js';

/**
 * Where a crash in the browser goes, so that it lands in the Worker's logs.
 *
 * The app's editor runs inside a WebView in the Android app, which means a large share of
 * what users actually experience as a broken app is JavaScript that never reaches this
 * Worker at all. Play's own crash reporting does not see it either: to Android the process
 * is healthy, because a thrown exception in a WebView is not a crash. Without this the only
 * report is somebody describing a blank screen.
 *
 * Deliberately not a third-party crash reporter. Both Crashlytics and Sentry would answer
 * this better, and both would put another company in the privacy policy for a problem this
 * endpoint covers with logging we already pay for. See the README.
 *
 * Unauthenticated on purpose. The errors most worth seeing are the ones that stop a page
 * working, and a page that fails on load has no session to send — gating this would lose
 * exactly the reports that matter most. `sessionMiddleware` still runs ahead of it, so a
 * signed-in report carries a user id and an anonymous one does not.
 *
 * The bound on what can be written here is the schema below, not the caller: anything on
 * the internet can POST to it. Every field is length-capped, unknown keys are dropped, and
 * the whole thing is logged as one line rather than interpolated anywhere it could be read
 * as markup. Nothing here reaches the database, so a flood costs log volume rather than
 * storage, and Workers' own rate limiting is the backstop.
 */
const reportSchema = z
  .object({
    /** The thrown value's message, already stringified by the reporter. */
    message: z.string().trim().min(1).max(1000),
    /** Truncated client-side; capped again here because the client is not to be trusted. */
    stack: z.string().max(4000).optional(),
    /**
     * Where it happened — the route, never the full URL. A note id in a path is not
     * interesting enough to be worth logging an address that identifies what someone was
     * reading.
     */
    route: z.string().max(200).optional(),
    /** 'error' for a thrown exception, 'rejection' for an unhandled promise. */
    kind: z.enum(['error', 'rejection']),
  })
  .strict();

export const clientErrors = new Hono<AppEnv>().post(
  '/client-errors',
  zValidator('json', reportSchema),
  async (c) => {
    const report = c.req.valid('json');
    const userId = c.get('userId');

    /*
     * One `console.error` rather than several, because Workers Logs indexes a line at a
     * time and a report split across calls is a report you cannot search for.
     *
     * The user agent comes from the request rather than from the body: the client cannot
     * be trusted to describe itself, and this is the field that answers "is this only the
     * WebView?", which is the first question every one of these reports raises.
     */
    console.error(
      'Client error:',
      JSON.stringify({
        kind: report.kind,
        message: report.message,
        route: report.route,
        stack: report.stack,
        userId: userId ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      }),
    );

    // 204: the client has nothing to do with the answer, and a body would only be parsed
    // by a reporter that must never itself throw.
    return c.body(null, 204);
  },
);
