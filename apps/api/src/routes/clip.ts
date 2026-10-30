import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { clipRequestSchema } from '@unbent/shared';
import { clipUrl } from '../lib/clip.js';
import { refuseIfPastFree } from '../lib/free-plan.js';
import { quotaOf } from '../lib/quota.js';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * `POST /clip`: a web page kept as a note, fetched and read here. For the clients that
 * hold only an address (a phone's share sheet, a bookmarklet, the web app's own "clip a
 * link") rather than the page; an assistant reaches the same function through the
 * `clip_web_page` tool. Everything it does is `lib/clip.ts`'s.
 *
 * A router of its own at `/clip`, not a verb under `/notes`: it makes a note, but what it
 * is given is a page, and the note's id is an option in the body like every create's.
 *
 * The answer is the note as `POST /notes` answers one (201 made, 200 for an id already
 * held), with `clip.images` beside it: how many pictures were stored and which were not,
 * with why, so a client can say "3 pictures could not be saved" rather than leave the
 * person to find them. A failure is `{ error, code }` with the status `clipUrl` chose; a
 * refusal for the plan or for room is the app's own 402 (`onAppError`), as for any note.
 *
 * The plan: held to the free plan in the store (`HELD_IN_STORE` in
 * lib/plan-middleware.ts), as a note's create and a file's fetch are, with
 * `refuseIfPastFree` before the page is fetched, as the file routes have.
 */
export const clip = new Hono<AppEnv>()
  .use('/clip', requireAuth, withRepos)

  .post('/clip', zValidator('json', clipRequestSchema), async (c) => {
    const input = c.req.valid('json');
    const attachments = c.get('attachments');
    const plan = c.get('plan');
    const result = await clipUrl(
      c.env,
      c.executionCtx,
      { notes: c.get('notes'), attachments },
      input,
      {
        // Loopback only where the other fetchers allow it: local development and the
        // test suite's own page server.
        allowLoopback: c.env.ALLOW_TEST_CREDENTIALS === '1',
        quota: quotaOf(c.env, plan),
        userAgent: c.env.ATTACHMENT_FETCH_USER_AGENT,
        pastFree: () => refuseIfPastFree(c.env, attachments, plan),
      },
    );
    if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status);
    return c.json({ ...result.note, clip: { images: result.images } }, result.existing ? 200 : 201);
  });
