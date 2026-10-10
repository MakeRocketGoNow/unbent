import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentTextsSchema,
  copyAttachmentsSchema,
  fetchWebImageSchema,
  filenameSchema,
  serveContentType,
  serveDisposition,
} from '@unbent/shared';
import { z } from 'zod';
import { copyAttachments } from '../lib/copy-attachments.js';
import { serverCanRead } from '../lib/read-attachment.js';
import { fetchWebImage } from '../lib/web-image.js';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { StorageFull, assertRoom, quotaOf, storageFullBody } from '../lib/quota.js';
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

  // A trashed note's files are listed and served, like the note itself (`GET /notes/:id`);
  // everything that writes or copies still asks for a live note.
  .get('/notes/:id/files', async (c) => {
    const files = await c.get('attachments').filesForNote(c.req.param('id'));
    if (!files) return c.json({ error: 'Not found' }, 404);
    return c.json({ files });
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

    /**
     * `?text=supplied`: the client has this file's text already and will put it next, so
     * the read that would otherwise start here is skipped. What the importer sends for a
     * file that arrived with a `text/` or `described/` sidecar — see `storeAttachment`.
     */
    const textSupplied = c.req.query('text') === 'supplied';

    /**
     * `X-Attachment-Id`: the id the file should have, chosen by the client, as a note's
     * can be (`POST /notes`). A file added with no connection is uploaded later from an
     * outbox, and an outbox replays: a request whose answer was lost is sent again. With
     * an id, the second one finds the file the first one made and is answered 200 with
     * it, its body unread — without, it stored the same bytes again as `scan-2.pdf`. An
     * id held by a file of another note is a conflict, not a find.
     */
    const claimed = c.req.header('X-Attachment-Id');
    if (claimed !== undefined) {
      if (!z.string().uuid().safeParse(claimed).success) return c.json({ error: 'X-Attachment-Id must be a UUID' }, 400);
      const { live, existing } = await repo.uploadPrelude(noteId, claimed);
      if (!live) return c.json({ error: 'Not found' }, 404);
      if (existing) {
        await c.req.raw.body?.cancel().catch(() => {});
        if (existing.noteId !== noteId) return c.json({ error: 'That id belongs to another file' }, 409);
        const { filename, contentType, size } = existing;
        // The answer the first request gave, worked out again: it was lost, so the client
        // never heard it. A flat `server` here left a file the server cannot read with
        // nobody reading it — the client that holds the bytes was told not to (review of
        // #236). Where the server can, its reader is already on the first request's bytes.
        const indexing = !textSupplied && serverCanRead(c.env, contentType, size) ? 'server' : 'client';
        return c.json({ filename, contentType, size, path: `files/${filename}`, indexing }, 200);
      }
    } else if (!(await repo.ownsNote(noteId))) {
      return c.json({ error: 'Not found' }, 404);
    }

    const rawName = c.req.header('X-Filename');
    if (!rawName) return c.json({ error: 'X-Filename header required' }, 400);

    // The header is the client's `encodeURIComponent`, since a header cannot carry the
    // name raw. One that will not decode is a bad request, not a crash.
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return c.json({ error: 'X-Filename is not valid percent-encoding' }, 400);
    }
    const parsed = filenameSchema.safeParse(name);
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

    let stored;
    try {
      stored = await storeAttachment(
        c.env,
        c.executionCtx,
        { attachments: repo, notes: c.get('notes') },
        {
          noteId,
          id: claimed,
          filename: parsed.data,
          contentType: c.req.header('Content-Type'),
          body: c.req.raw.body,
          link,
          textSupplied,
          quota: quotaOf(c.env, c.get('plan')),
          declaredBytes: declared > 0 ? declared : undefined,
        },
      );
    } catch (err) {
      // Past the plan's storage: a 402 like a lapsed plan's, with the numbers, so the
      // panel can say how full and point at the Plan page.
      if (err instanceof StorageFull) return c.json(storageFullBody(err), 402);
      throw err;
    }
    const { filename, contentType, size, path, indexing } = stored;

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

    try {
      const result = await copyAttachments(
        c.env.BLOBS,
        { attachments, notes: c.get('notes') },
        { from, to, filenames, move, link, quota: quotaOf(c.env, c.get('plan')) },
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof StorageFull) return c.json(storageFullBody(err), 402);
      throw err;
    }
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

    try {
      await assertRoom(repo, quotaOf(c.env, c.get('plan')), fetched.bytes.byteLength);
    } catch (err) {
      if (err instanceof StorageFull) return c.json(storageFullBody(err), 402);
      throw err;
    }

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

  /**
   * The name in the path is used as the router hands it over, here and in the two routes
   * below that take one.
   *
   * `c.req.param()` has already percent-decoded it, once, which is all the client encoded.
   * Each of these handlers used to decode it again, and a second pass is wrong for any name
   * holding a percent sign: `20% off.pdf` threw a URIError and answered 500, and a name
   * shaped like an escape — `100%41.txt` — silently addressed `100A.txt` instead. The
   * upload is different: its name arrives in a header, which nothing decodes for us.
   */
  .get('/notes/:id/files/:filename', async (c) => {
    const noteId = c.req.param('id');
    const filename = c.req.param('filename');

    const row = await c.get('attachments').resolve(noteId, filename, { includeTrashed: true });
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
   *
   * `readBy` records who wrote the text when it was not a text layer — `vision` for the
   * model, `assistant` for an assistant over MCP — and here it is only ever true of text
   * restored from an archive's `described/` or `written/`: the model runs on the server,
   * an assistant writes through its own tool, and every other caller here sends a text
   * layer. Anything else is refused rather than stored as a layer, so a typo cannot
   * quietly change what the row claims.
   */
  .put('/notes/:id/files/:filename/text', async (c) => {
    const noteId = c.req.param('id');
    const filename = c.req.param('filename');

    const attachmentId = await c.get('attachments').idFor(noteId, filename);
    if (!attachmentId) return c.json({ error: 'Not found' }, 404);

    const body = await c.req.json<{ text?: string; unusable?: boolean; readBy?: unknown }>();
    if (body.readBy !== undefined && body.readBy !== 'vision' && body.readBy !== 'assistant') {
      return c.json({ error: "readBy must be 'vision' or 'assistant' when given" }, 400);
    }

    /**
     * `unusable: true` records that extraction was attempted and produced nothing worth
     * indexing. The row exists so the browser's pass does not retry the same failing
     * scan forever, but it holds no text, so it can never match a search.
     *
     * A scan with no text layer is the vision model's to read, and the model runs only
     * inside an Auto-fill press (MAK-179). The empty row with no `read_by` is exactly what
     * puts the file on that press's list (`needingVision`), where it is told apart from a
     * scan the model already looked at. Until MAK-179 this was the moment the file was
     * sent to the model, after the response: a paid request that the browser's finding
     * started on its own.
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
      readBy: body.readBy === 'vision' || body.readBy === 'assistant' ? body.readBy : null,
    });

    return c.body(null, 204);
  })

  /**
   * Lists attachments that still need text extracted, with their bytes fetchable.
   *
   * Backfill runs on the client because that is where the PDF library lives — the same
   * extraction the import uses. The server only says which files still need it.
   *
   * `?note=` narrows the list, and the count, to one note. The Android app indexes the
   * capture it just uploaded and nothing else, so it asks this way; the web asks unscoped
   * and walks whatever the account has left.
   *
   * The web asks on every open of the app, so both halves read only the files still
   * unread — nothing at all once everything has been. `extractable` and `indexed`, the
   * account's PDF totals, used to come back too; no client read them, and counting them
   * meant reading every PDF each time.
   */
  .get('/attachments/pending-text', requireAuth, withRepos, async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? '25'), 100);
    const note = c.req.query('note') || undefined;
    /*
       `count=0` leaves the count out. The pass reads it from its first page only and
       walks the rest page by page, and counting reads a row per unread PDF: a pass over
       a 10k-file backlog counted it on each of its 400 pages, 4M rows for a number read
       once. Counting stays the default, so a client that does not know to ask still
       gets it.
    */
    const counted = c.req.query('count') !== '0';
    const { files, remaining } = await c.get('attachments').pendingText(limit, note, counted);

    return c.json({
      pending: files.map((p) => ({ noteId: p.noteId, filename: p.filename })),
      ...(remaining !== undefined ? { remaining } : {}),
    });
  })

  /**
   * The text of the files a device names, for its offline search index (MAK-142).
   *
   * Extracted text is the largest thing an account holds after the files themselves, so
   * it is not in the change feed; a device asks for the text of the notebooks it keeps
   * offline and the notes opened on it lately, by file id, and the feed's `hasText` on a
   * file's row is what tells it there is something to ask for. A POST because fifty ids
   * do not belong in an address. One store call, cut on bytes: see `textsById`.
   */
  .post('/attachments/texts', requireAuth, withRepos, zValidator('json', attachmentTextsSchema), async (c) => {
    return c.json(await c.get('attachments').textsById(c.req.valid('json').ids));
  })

  /**
   * Removes a file from a note. The object stays in R2 for thirty-five days under a
   * tombstone the store writes with the row's deletion, and the hourly sweep deletes it
   * then (`DeletedBlobs`), so a store wound back to before this finds the file whole.
   */
  .delete('/notes/:id/files/:filename', async (c) => {
    const filename = c.req.param('filename');
    const key = await c.get('attachments').remove(c.req.param('id'), filename);
    if (!key) return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });
