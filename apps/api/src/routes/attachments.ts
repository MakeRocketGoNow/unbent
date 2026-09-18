import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  FALLBACK_CONTENT_TYPE,
  MAX_ATTACHMENT_BYTES,
  copyAttachmentsSchema,
  filenameSchema,
  formatAttachmentMarkdown,
  normalizeContentType,
  serveContentType,
  serveDisposition,
} from '@unbent/shared';
import { copyAttachments } from '../lib/copy-attachments.js';
import { canExtractOnServer, extractOnServer } from '../lib/extract-text.js';
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
     * Extract the text here, where the deployment can.
     *
     * Every client then gets a searchable PDF without doing anything: the editor, the
     * phone, the import, and whatever comes next. After the response rather than before
     * it, because the upload should return the moment the bytes are safe and conversion
     * is a second or more of waiting on another service; `waitUntil` gives it thirty
     * seconds. A failure of any kind leaves the row pending, and the browser's passes
     * remain the fallback — only a conversion that read the file and found nothing writes
     * the empty row. The response says which way it went, so a client that would extract
     * on its own knows not to.
     */
    const indexing = canExtractOnServer(c.env, contentType, object.size) ? 'server' : 'client';
    if (indexing === 'server') {
      const ai = c.env.AI!;
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const stored = await c.env.BLOBS.get(key);
            if (!stored) return;
            const extracted = await extractOnServer(ai, filename, await stored.blob());
            if (!extracted) return;
            await repo.recordText({
              attachmentId: id,
              noteId,
              filename,
              text: extracted.quality.usable ? extracted.text : '',
            });
          } catch {
            // Left pending for the browser's passes.
          }
        })(),
      );
    }

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
    return c.json({ ...info, path, indexing }, 201);
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
    const { from, filenames, move } = c.req.valid('json');
    const attachments = c.get('attachments');

    if (!(await attachments.ownsNote(to))) return c.json({ error: 'Not found' }, 404);
    if (from === to) return c.json({ error: 'Source and destination are the same note' }, 400);
    if (!(await attachments.ownsNote(from))) return c.json({ error: 'Source note not found' }, 404);

    const result = await copyAttachments(
      c.env.BLOBS,
      { attachments, notes: c.get('notes') },
      { from, to, filenames, move },
    );
    return c.json(result);
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

  .delete('/notes/:id/files/:filename', async (c) => {
    const filename = decodeURIComponent(c.req.param('filename'));
    const key = await c.get('attachments').remove(c.req.param('id'), filename);
    if (!key) return c.json({ error: 'Not found' }, 404);

    await c.env.BLOBS.delete(key);
    return c.body(null, 204);
  });
