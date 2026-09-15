import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { MAX_BODY_BYTES, importEnmlSchema, importNoteSchema } from '@unbent/shared';
// Deep import rather than the package root: the barrel re-exports pdf-text, which pulls
// pdfjs into the Worker bundle for a conversion that never touches a PDF.
import { enmlToMarkdown } from '@unbent/enex/enml';
import { contentHash, withSourceLink } from '@unbent/enex/note-body';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import type { AppEnv } from '../types.js';

/**
 * Import endpoint for ENEX and other bulk sources.
 *
 * Deliberately one note per request rather than a batch: an import of 13,000 notes will be
 * interrupted, and per-note idempotency means a resumed run skips what already landed
 * without any server-side progress tracking. Attachments then go through the normal
 * attachment route, so there is one upload path rather than two.
 */
export const importRoutes = new Hono<AppEnv>().post(
  '/import/note',
  requireAuth,
  withRepos,
  zValidator('json', importNoteSchema),
  async (c) => {
    const input = c.req.valid('json');

    const { id, created, skippedFields } = await c.get('notes').importNote({
      id: input.id,
      title: input.title,
      body: input.body,
      tags: input.tags,
      notebook: input.notebook,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      contentHash: input.contentHash,
      sourceEnex: input.sourceEnex,
      fields: input.fields,
    });

    // `created: false` tells the client this note was already imported, so it can skip
    // re-uploading the attachments too — the expensive part of a resumed run.
    // `skippedFields` names any custom field values that could not be stored, so the
    // client can report them rather than the import quietly dropping data.
    return c.json({ id, created, skippedFields }, created ? 201 : 200);
  },
);

/**
 * The same import, for clients that hold ENML rather than Markdown.
 *
 * A syncing client (evernote-backup and anything like it) pulls notes straight from
 * Evernote's API, so what it has is ENML. Converting there would mean a second
 * implementation of `enmlToMarkdown` in another language, which would drift from this one
 * and have to relearn every quirk the original already encodes. Converting here keeps one
 * definition of what Evernote's markup means.
 *
 * Attachments still go through the normal upload route afterwards. Only their metadata
 * arrives here — the converter needs an md5 to resolve `<en-media hash>` into a `files/`
 * link, not the bytes, which are far larger than the note and would make this request the
 * expensive one.
 */
export const importEnmlRoutes = new Hono<AppEnv>().post(
  '/import/enml',
  requireAuth,
  withRepos,
  zValidator('json', importEnmlSchema),
  async (c) => {
    const input = c.req.valid('json');

    // Resources arrive without bytes, which enmlToMarkdown does not read — it matches on
    // md5 to decide which links to rewrite. An empty array keeps the shared type honest
    // rather than widening it for this one caller.
    const { markdown, usedMd5 } = enmlToMarkdown(
      input.enml,
      input.resources.map((r) => ({ ...r, bytes: new Uint8Array() })),
    );
    const body = withSourceLink(markdown, input.sourceUrl);

    // ENML expands and contracts unpredictably, so a note under the ENML cap can still
    // convert to a body D1 will not store. Rejecting here names the real problem instead
    // of surfacing as a database error several layers down.
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      return c.json({ error: 'Converted note body is too large to store.' }, 413);
    }

    const { id, created } = await c.get('notes').importNote({
      title: input.title,
      body,
      tags: input.tags,
      notebook: input.notebook,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      contentHash: await contentHash(input.title, body),
      sourceEnex: input.sourceEnex,
    });

    // The md5s actually referenced come back so the client knows which attachments the
    // body links to, and which it should append as unreferenced — the same distinction the
    // ENEX importer makes, but the client cannot compute it without having converted.
    return c.json(
      { id, created, usedMd5: [...usedMd5] },
      created ? 201 : 200,
    );
  },
);
