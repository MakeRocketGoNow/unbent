import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { MAX_ATTACHMENT_BYTES } from '@unbent/shared';
import { appLinks } from '../lib/app-links.js';
import { chooseContentType } from '../lib/fetch-attachment.js';
import { billingOn } from '../lib/stripe.js';
import { PlanRefused, planRefusedBody, refuseIfPastFree } from '../lib/free-plan.js';
import { planFor } from '../lib/plan.js';
import { reposFor } from '../lib/repos.js';
import { StorageFull, quotaOf, storageFullBody, writeLimitsOf } from '../lib/quota.js';
import { storeAttachment } from '../lib/store-attachment.js';
import { claimUploadGrant } from '../lib/upload-grants.js';
import type { AppEnv } from '../types.js';

/** Said whenever a link cannot be used, since the fix is the same whatever the reason. */
const ASK_AGAIN = 'Ask for a new one with prepare_attachment_upload.';

/**
 * Any origin may send the PUT, so an assistant working inside a browser (with a picture
 * open in a tab, say, after `add_attachment` was refused by its host) can hand over
 * bytes it already holds. Without this the preflight fails and the browser never sends
 * the request at all.
 *
 * A wildcard widens nothing, because the token is the whole of the authority: whoever
 * holds the link can already use it from curl, and whoever does not cannot use it from
 * any origin. What must never ride along is a cookie, so credentials stay off: `*` and
 * credentials cannot be combined anyway, and the route reads no session. The CORS rule is
 * on this path alone; every other route answers with the session and must keep refusing
 * other origins.
 *
 * Content-Length is listed though a browser sets it itself, since a client that names it
 * should not fail the preflight over it. Nothing is exposed: the answer is JSON in the
 * body, which a CORS-allowed response can already read.
 */
const anyOrigin = cors({
  origin: '*',
  allowMethods: ['PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Content-Length'],
  maxAge: 600,
  credentials: false,
});

/**
 * Where a file goes that an assistant holds on its own machine: the other half of the MCP
 * tool prepare_attachment_upload, which mints the link this route is reached by.
 *
 * Authorized by the token in the path and nothing else: no cookie, no bearer token. That
 * is the point of it: the request comes from curl in an agent's shell, or from a page in a
 * browser, which has the file but should never hold the OAuth token its client signed in
 * with. The token names one note of one user's and works once; see lib/upload-grants.ts
 * and migration 0029.
 *
 * The link stores and links the file itself, rather than waiting for a third step that
 * confirms it. Object stores that hand out presigned URLs need that step because nothing of
 * theirs runs when the bytes land; here the Worker is the thing receiving them, so the
 * answer to the PUT is already the answer add_attachment gives, and there is no half-done
 * upload for anyone to forget to finish.
 */
export const uploads = new Hono<AppEnv>().use('/uploads/*', anyOrigin).put('/uploads/:token', async (c) => {
  /*
     The request's own faults first, before the link is claimed: a curl invocation that
     sent no length, or a file over the limit, should cost the assistant a corrected
     command, not the link as well.

     A length is required because the body streams into R2, which must know it up front
     (see `storeAttachment`). curl's -T and --data-binary both send one.
  */
  const length = c.req.header('Content-Length');
  if (!length) return c.json({ error: 'Content-Length required: send the file with curl -T.' }, 411);
  const declared = Number(length);
  if (declared > MAX_ATTACHMENT_BYTES) {
    return c.json(
      { error: `Attachment exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit` },
      413,
    );
  }
  if (declared === 0 || !c.req.raw.body) return c.json({ error: 'Empty body' }, 400);

  const grant = await claimUploadGrant(c.env.DB, c.req.param('token'));
  if (!grant) {
    return c.json({ error: `This upload link is unknown, already used, or expired. ${ASK_AGAIN}` }, 404);
  }

  /*
     The plan, since this route has no session for `requireActivePlan` to read: the link
     was minted by a tool the gate let through, but a plan can end in the minutes between.
     Its limits go with the repos, as any other write's do, and the store decides when the
     file's row is recorded: an account past the free plan is refused there with the same
     402 as every other write, so the assistant relaying it reads one sentence, and the
     object put first is deleted (`storeAttachment`).
  */
  const plan = billingOn(c.env) ? await planFor(c.env.DB, grant.userId) : undefined;
  // The same row answers the quota; `quotaFor` would read it a second time.
  const quota = quotaOf(c.env, plan);

  const { attachments, notes } = reposFor(c.env, grant.userId, () => writeLimitsOf(c.env, plan));
  // Trashed, or gone, in the minutes since the link was made.
  if (!(await attachments.ownsNote(grant.noteId))) {
    return c.json({ error: 'The note this link was for is no longer there.' }, 404);
  }
  // Past the free plan in the minutes since: refused before the bytes are taken in.
  let usedBytes: number | undefined;
  try {
    usedBytes = await refuseIfPastFree(c.env, attachments, plan);
  } catch (err) {
    if (err instanceof PlanRefused) return c.json(planRefusedBody(err), 402);
    throw err;
  }

  /*
     The type the assistant declared when it asked for the link, else the extension. The
     request's own Content-Type is ignored: curl's --data-binary labels every body
     application/x-www-form-urlencoded, and -T sends none, so what the header says is an
     accident of the command line and not a claim about the file.
  */
  const contentType = chooseContentType(grant.contentType, grant.filename);

  try {
    const stored = await storeAttachment(
      c.env,
      c.executionCtx,
      { attachments, notes },
      {
        noteId: grant.noteId,
        filename: grant.filename,
        contentType,
        body: c.req.raw.body,
        link: grant.link,
        quota,
        declaredBytes: declared,
        usedBytes,
      },
    );
    // add_attachment's answer, url included, since prepare_attachment_upload promises the
    // assistant the same JSON from here.
    return c.json(
      { noteId: grant.noteId, url: appLinks(c.env.APP_URL).note(grant.noteId), ...stored, linked: grant.link },
      201,
    );
  } catch (err) {
    if (err instanceof StorageFull) return c.json(storageFullBody(err), 402);
    if (err instanceof PlanRefused) return c.json(planRefusedBody(err), 402);
    // A transfer cut short: the link is spent, and nothing was attached.
    console.error('Upload through a prepared link failed:', err);
    return c.json({ error: `The upload did not complete, and nothing was attached. ${ASK_AGAIN}` }, 400);
  }
});
