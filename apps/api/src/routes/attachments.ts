import { Hono } from 'hono';
import {
  FALLBACK_CONTENT_TYPE,
  MAX_ATTACHMENT_BYTES,
  filenameSchema,
  formatAttachmentMarkdown,
  normalizeContentType,
  serveContentType,
  serveDisposition,
} from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
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

    const filename = await repo.availableFilename(noteId, parsed.data);
    const id = crypto.randomUUID();
    const key = repo.buildKey(noteId, id, filename);
    /**
     * Record the declared type, normalized.
     *
     * Kept rather than verified: the search backfill filters on `application/pdf`, and the
     * export needs real types for the files it writes. What makes this safe is that nothing
     * is *served* from it unchecked — see the GET handler, which decides the response type
     * independently. Parameters are stripped here so a stored value like
     * `text/html; charset=utf-8` cannot later differ from what the allowlist compares.
     */
    const contentType =
      normalizeContentType(c.req.header('Content-Type')) || FALLBACK_CONTENT_TYPE;

    const object = await c.env.BLOBS.put(key, c.req.raw.body, {
      httpMetadata: { contentType },
    });

    if (!object) return c.json({ error: 'Upload failed' }, 500);

    // R2 reports the true byte count; Content-Length is a client claim.
    const info = await repo.record({
      id,
      noteId,
      filename,
      contentType,
      size: object.size,
      r2Key: key,
    });

    const path = `files/${filename}`;

    /**
     * Opt-in body link, for clients that cannot write the markdown themselves.
     *
     * The browser editor inserts its own link at the cursor and does not pass this; a
     * share sheet on a phone has neither a cursor nor the note body, so the server links
     * on its behalf. `filename` rather than the requested name: availableFilename may have
     * suffixed a collision, and a link to the name we did not store points at nothing.
     */
    if (c.req.query('link') !== undefined) {
      await c
        .get('notes')
        .appendToBody(
          noteId,
          formatAttachmentMarkdown(filename, path, { image: contentType.startsWith('image/') }),
        );
    }

    // The relative path the editor inserts into the markdown.
    return c.json({ ...info, path }, 201);
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
     */
    if (body.unusable) {
      await c.get('attachments').recordText({ attachmentId, noteId, filename, text: '' });
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
   */
  .get('/attachments/pending-text', requireAuth, withRepos, async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? '25'), 100);
    const [pending, coverage] = await Promise.all([
      c.get('attachments').needingText(limit),
      c.get('attachments').textCoverage(),
    ]);

    return c.json({
      pending: pending.map((p) => ({ noteId: p.noteId, filename: p.filename })),
      remaining: coverage.extractable - coverage.indexed,
      ...coverage,
    });
  })

  .delete('/notes/:id/files/:filename', async (c) => {
    const filename = decodeURIComponent(c.req.param('filename'));
    const key = await c.get('attachments').remove(c.req.param('id'), filename);
    if (!key) return c.json({ error: 'Not found' }, 404);

    await c.env.BLOBS.delete(key);
    return c.body(null, 204);
  });
