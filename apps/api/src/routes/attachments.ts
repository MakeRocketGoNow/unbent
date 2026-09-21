import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  MAX_ATTACHMENT_BYTES,
  copyAttachmentsSchema,
  fetchWebImageSchema,
  filenameSchema,
  serveContentType,
  serveDisposition,
} from '@unbent/shared';
import { z } from 'zod';
import { copyAttachments } from '../lib/copy-attachments.js';
import { readWithLlm, readersFrom } from '../lib/read-attachment.js';
import { canUseLlm, readableByLlm } from '../lib/llm.js';
import { fetchWebImage } from '../lib/web-image.js';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { storeAttachment } from '../lib/store-attachment.js';
import type { AppEnv } from '../types.js';

/**
 * Attachment upload and serving.
 *
 * Blobs are proxied through the Worker rather than served by R2 presigned URLs. Presigning
 * needs S3 credentials and SigV4 signing inside the Worker (real secrets, versus a binding
 * that is already there), and a presigned URL cannot be revoked before it expires — a
 * leaked link to a private note's attachment would stay live. Authorization here is a
 * scoped DB lookup we control. R2 egress is free either way, and immutable caching means
 * the browser fetches each blob once.
 */
export const attachments = new Hono<AppEnv>()
  .use('/notes/:id/files', requireAuth, withRepos)
  .use('/notes/:id/files/*', requireAuth, withRepos)

  .get('/notes/:id/files', async (c) => {
    const noteId = c.req.param('id');
    if (!(await c.get('attachments').ownsNote(noteId))) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json({ files: await c.get('attachments').listForNote(noteId) });
  })

  /**
   * Upload. The body streams straight into R2 and is never buffered, so the Worker's
   * 128MB memory ceiling does not bound attachment size — Cloudflare's 100MB request cap
   * does, and we reject above that with a clear error rather than a truncated object.
   *
   * What happens to the bytes once they are accepted lives in lib/store-attachment.ts,
   * shared with the MCP server; this handler is the checks that belong to HTTP.
   */
  .put('/notes/:id/files', async (c) => {
    const noteId = c.req.param('id');
    const repo = c.get('attachments');

    if (!(await repo.ownsNote(noteId))) return c.json({ error: 'Not found' }, 404);

    const rawName = c.req.header('X-Filename');
    if (!rawName) return c.json({ error: 'X-Filename header required' }, 400);

    const parsed = filenameSchema.safeParse(decodeURIComponent(rawName));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid filename' }, 400);
    }

    const declared = Number(c.req.header('Content-Length') ?? '0');
    if (declared > MAX_ATTACHMENT_BYTES) {
      return c.json(
        { error: `Attachment exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit` },
        413,
      );
    }

    if (!c.req.raw.body) return c.json({ error: 'Empty body' }, 400);

    /**
     * Opt-in body link, for clients that cannot write the markdown themselves.
     *
     * The browser editor inserts its own link at the cursor and does not pass this; a
     * share sheet on a phone has neither a cursor nor the note body, so the server links
     * on its behalf.
     */
    const link = c.req.query('link') !== undefined;

    const { filename, contentType, size, path, indexing } = await storeAttachment(
      c.env,
      c.executionCtx,
      { attachments: repo, notes: c.get('notes') },
      {
        noteId,
        filename: parsed.data,
        contentType: c.req.header('Content-Type'),
        body: c.req.raw.body,
        link,
      },
    );

    // `path` is the relative destination the editor inserts into the markdown.
    return c.json({ filename, contentType, size, path, indexing }, 201);
  })

  /**
   * Copies files from another of the user's notes into this one.
   *
   * What a paste across notes calls, and what the Attachments panel's copy-to and move-to
   * call. The editor could have downloaded the bytes and re-uploaded them, but a scan is
   * tens of megabytes and the phone's radio is slow; a copy between two keys in R2 is one
   * request and no bytes through the client. Both notes must be this user's and live —
   * the source check is inside `copyAttachments`, through the same scoped resolve the
   * download uses, so a note id from another account reads as missing.
   *
   * Under `/files/copy` rather than a verb on the source: the destination is what changes,
   * and the panel reads its own note's list after this, so the URL names that note.
   */
  .post('/notes/:id/files/copy', zValidator('json', copyAttachmentsSchema), async (c) => {
    const to = c.req.param('id');
    const { from, filenames, move, link } = c.req.valid('json');
    const attachments = c.get('attachments');

    if (!(await attachments.ownsNote(to))) return c.json({ error: 'Not found' }, 404);
    if (from === to) return c.json({ error: 'Source and destination are the same note' }, 400);
    if (!(await attachments.ownsNote(from))) return c.json({ error: 'Source note not found' }, 404);

    const result = await copyAttachments(
      c.env.BLOBS,
      { attachments, notes: c.get('notes') },
      { from, to, filenames, move, link },
    );
    return c.json(result);
  })

  /**
   * Fetches a picture off the web and stores it on the note.
   *
   * What "Save web images" calls, once per address. The Worker fetches because the
   * browser cannot — see `lib/web-image.ts` for that and for the address policy. The body
   * is not rewritten here: the client holds the draft and puts `files/<name>` in place of
   * the address itself, from the name in the answer, which may be suffixed.
   */
  .post('/notes/:id/files/fetch', zValidator('json', fetchWebImageSchema), async (c) => {
    const noteId = c.req.param('id');
    const repo = c.get('attachments');
    if (!(await repo.ownsNote(noteId))) return c.json({ error: 'Not found' }, 404);

    const { url } = c.req.valid('json');
    const fetched = await fetchWebImage(url, {
      allowLoopback: c.env.ALLOW_TEST_CREDENTIALS === '1',
    });
    if (!fetched.ok) return c.json({ error: fetched.error }, fetched.status);

    const filename = await repo.availableFilename(noteId, fetched.filename);
    const id = crypto.randomUUID();
    const key = repo.buildKey(noteId, id, filename);
    const object = await c.env.BLOBS.put(key, fetched.bytes, {
      httpMetadata: { contentType: fetched.contentType },
    });
    if (!object) return c.json({ error: 'Upload failed' }, 500);

    const info = await repo.record({
      id,
      noteId,
      filename,
      contentType: fetched.contentType,
      size: object.size,
      r2Key: key,
    });
    return c.json({ ...info, path: `files/${filename}`, url }, 201);
  })

  .get('/notes/:id/files/:filename', async (c) => {
    const noteId = c.req.param('id');
    const filename = decodeURIComponent(c.req.param('filename'));

    const row = await c.get('attachments').resolve(noteId, filename);
    if (!row) return c.json({ error: 'Not found' }, 404);

    // R2 handles If-None-Match itself and skips streaming the body on a match.
    const object = await c.env.BLOBS.get(row.r2_key, { onlyIf: c.req.raw.headers });
    if (!object) return c.json({ error: 'Not found' }, 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    // The key embeds an immutable attachment id, so the bytes at this URL never change.
    headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    headers.set('X-Content-Type-Options', 'nosniff');

    /**
     * Serve a safe type rather than the one the uploader declared.
     *
     * `writeHttpMetadata` restores whatever was stored on the R2 object, which came from a
     * client header or an ENEX `<mime>` field — neither verified against the bytes. Echoing
     * it means a file uploaded as `text/html` runs as a same-origin document with access to
     * the session. Anything not known-inert is downgraded to a binary type and marked
     * `attachment`, so the browser saves it instead of executing it.
     */
    headers.set('Content-Type', serveContentType(row.content_type));
    // `?download=1` forces a save — needed for PDFs, which are otherwise inline for preview.
    const disposition =
      c.req.query('download') === '1' ? 'attachment' : serveDisposition(row.content_type);
    headers.set(
      'Content-Disposition',
      `${disposition}; filename="${encodeURIComponent(filename)}"`,
    );

    /**
     * A second, independent barrier.
     *
     * If a type is ever added to the allowlist that turns out to be scriptable, this CSP
     * still denies the document an origin, script execution, and subresource loads. The
     * allowlist should be sufficient on its own; this is what makes a mistake in it
     * non-catastrophic.
     */
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'");

    // A conditional hit returns metadata with no body: that is a 304, not an empty 200.
    if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });

    return new Response(object.body, { headers });
  })

  /**
   * Stores text extracted from an attachment, for search.
   *
   * A separate call rather than part of the upload because extraction happens on the
   * client after the bytes are already sent, and because it is optional — an attachment
   * with no usable text simply never gets one.
   */
  .put('/notes/:id/files/:filename/text', async (c) => {
    const noteId = c.req.param('id');
    const filename = decodeURIComponent(c.req.param('filename'));

    const attachmentId = await c.get('attachments').idFor(noteId, filename);
    if (!attachmentId) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json<{ text?: string; unusable?: boolean }>();

    /**
     * `unusable: true` records that extraction was attempted and produced nothing worth
     * indexing. The row exists so a backfill pass does not retry the same failing scan
     * forever, but it holds no text, so it can never match a search.
     *
     * Unless the vision model can read it: a scan with no text layer is exactly what that
     * reader is for, and this is the moment the browser says the layer had nothing. Read
     * after the response, as an upload's server-side read is; a failure leaves the empty
     * row standing, which the backfill offers to the model again.
     */
    if (body.unusable) {
      const repo = c.get('attachments');
      await repo.recordText({ attachmentId, noteId, filename, text: '' });
      const { llm } = readersFrom(c.env);
      const row = await repo.resolve(noteId, filename);
      if (llm && row && readableByLlm(row.content_type, row.size)) {
        c.executionCtx.waitUntil(
          (async () => {
            try {
              const stored = await c.env.BLOBS.get(row.r2_key);
              if (!stored) return;
              await readWithLlm(
                llm,
                repo,
                { id: row.id, noteId, filename, contentType: row.content_type, size: row.size, r2Key: row.r2_key },
                await stored.arrayBuffer(),
              );
            } catch (err) {
              // Left for the backfill, and logged by id for the reason the upload gives.
              console.error('read after empty layer:', row.id, (err as Error).message);
            }
          })(),
        );
      }
      return c.body(null, 204);
    }

    if (typeof body.text !== 'string' || body.text.length === 0) {
      return c.json({ error: 'text required' }, 400);
    }

    await c.get('attachments').recordText({
      attachmentId,
      noteId,
      filename,
      // D1 caps a row at 2MB; long scans are truncated rather than rejected.
      text: body.text.slice(0, 500_000),
    });

    return c.body(null, 204);
  })

  /**
   * Lists attachments that still need text extracted, with their bytes fetchable.
   *
   * Backfill runs on the client because that is where the PDF library lives — the same
   * extraction the import uses. The server only says which files still need it.
   *
   * `?note=` narrows the list, and the counts, to one note. The Android app indexes the
   * capture it just uploaded and nothing else, so it asks this way; the web asks unscoped
   * and walks whatever the account has left.
   */
  .get('/attachments/pending-text', requireAuth, withRepos, async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? '25'), 100);
    const note = c.req.query('note') || undefined;
    const [pending, coverage] = await Promise.all([
      c.get('attachments').needingText(limit, note),
      c.get('attachments').textCoverage(note),
    ]);

    return c.json({
      pending: pending.map((p) => ({ noteId: p.noteId, filename: p.filename })),
      remaining: coverage.extractable - coverage.indexed,
      ...coverage,
    });
  })

  /**
   * Reads a few of the files still waiting for the vision model, and says how many wait.
   *
   * The counterpart of `pending-text` for the reader that lives on the server: pictures,
   * and PDFs the text layer had nothing for. The browser's pass fetches bytes to run
   * pdf.js on; this one runs here, where the bytes and the key are, and the client only
   * asks again until nothing is left. A few per call because each is seconds and a
   * request per file, and a person watching a count go down can stop.
   *
   * A POST although it changes nothing a client sees directly: every file read is a
   * paid request, so nothing that treats GET as safe may start one on its own. It is
   * what the Import panel's button runs, never the pass a tab opening starts — see
   * `startIndexing`.
   */
  .post(
    '/attachments/read',
    requireAuth,
    withRepos,
    zValidator('json', z.object({ limit: z.number().int().min(1).max(10).default(3) })),
    async (c) => {
      if (!canUseLlm(c.env)) {
        return c.json({ error: 'Reading images is not set up on this instance' }, 503);
      }
      const repo = c.get('attachments');
      const { llm } = readersFrom(c.env);
      const counts = { read: 0, empty: 0, failed: 0 };
      for (const file of await repo.needingVision(c.req.valid('json').limit)) {
        try {
          if (!readableByLlm(file.contentType, file.size)) {
            // Past the caps: recorded as the model's empty answer, so it is not offered again.
            await repo.recordText({ attachmentId: file.id, noteId: file.noteId, filename: file.filename, text: '', readBy: 'vision' });
            counts.empty += 1;
            continue;
          }
          const stored = await c.env.BLOBS.get(file.r2Key);
          if (!stored) {
            counts.failed += 1;
            continue;
          }
          const outcome = await readWithLlm(llm!, repo, file, await stored.arrayBuffer());
          counts[outcome === 'vision' ? 'read' : 'empty'] += 1;
        } catch (err) {
          // One unreadable file must not stop the pass; it stays pending for the next. The
          // id rather than the name, which comes from the archive and can say too much.
          console.error('read:', file.id, (err as Error).message);
          counts.failed += 1;
        }
      }
      return c.json({ ...counts, remaining: await repo.visionPending() });
    },
  )

  .delete('/notes/:id/files/:filename', async (c) => {
    const filename = decodeURIComponent(c.req.param('filename'));
    const key = await c.get('attachments').remove(c.req.param('id'), filename);
    if (!key) return c.json({ error: 'Not found' }, 404);

    await c.env.BLOBS.delete(key);
    return c.body(null, 204);
  });
