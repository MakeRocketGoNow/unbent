import { Hono } from 'hono';
import { MAX_ATTACHMENT_BYTES, filenameSchema } from '@unbent/shared';
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
    const contentType = c.req.header('Content-Type') ?? 'application/octet-stream';

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

    // The relative path the editor inserts into the markdown.
    return c.json({ ...info, path: `files/${filename}` }, 201);
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
    // Never let a stored file be interpreted as markup in our own origin.
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);

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

    const { text } = await c.req.json<{ text?: string }>();
    if (typeof text !== 'string' || text.length === 0) {
      return c.json({ error: 'text required' }, 400);
    }

    await c.get('attachments').recordText({
      attachmentId,
      noteId,
      filename,
      // D1 caps a row at 2MB; long scans are truncated rather than rejected.
      text: text.slice(0, 500_000),
    });

    return c.body(null, 204);
  })

  .delete('/notes/:id/files/:filename', async (c) => {
    const filename = decodeURIComponent(c.req.param('filename'));
    const key = await c.get('attachments').remove(c.req.param('id'), filename);
    if (!key) return c.json({ error: 'Not found' }, 404);

    await c.env.BLOBS.delete(key);
    return c.body(null, 204);
  });
