import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { exportPageQuerySchema, noteDirName, noteMarkdown } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import { exportNoteZipStream } from '../lib/export.js';
import { nextCursor } from '../lib/notes-repo.js';
import type { AppEnv } from '../types.js';

export const exportRoutes = new Hono<AppEnv>()
  /**
   * One page of the library, whole notes with their bodies and the names of their files,
   * for the browser to write into an archive.
   *
   * The export used to be one request that streamed the whole zip, and it read each note
   * and each of its files from here as it went. A Worker request may make only so many
   * calls to D1 and R2 — a thousand on Workers Free by the platform's limits page — and
   * a library is tens of thousands of them, so the backup could never have completed on
   * the archive it existed for. This page is one statement. The client walks the cursor,
   * fetches each file through the note's own file route, and writes the zip itself; see
   * the web app's `export-archive.ts`, and `@unbent/shared`'s `export-format.ts` for the
   * names and markdown the two ends agree on.
   *
   * The same filters as the note list, through the same `notes.list`, so a filter cannot
   * mean one thing on screen and another in the zip. A directory tree has no order worth
   * choosing, so `sort` says only which column a date range applies to and which one the
   * cursor walks; the web app sends `created` when there is no range, since a note edited
   * mid-export would otherwise jump above an `updated` cursor and be missed. `total` comes
   * on the first page, for a progress count.
   */
  .get('/export/notes', requireAuth, withRepos, zValidator('query', exportPageQuerySchema), async (c) => {
    const { tag: tags, notebook, field: fields, from, to, sort, cursor, limit } = c.req.valid('query');
    const repo = c.get('notes');
    const filter = { tags, notebook, fields, from, to, sort };
    const [notes, total] = await Promise.all([
      repo.listFull({ limit, cursor, ...filter }),
      cursor ? Promise.resolve<number | null>(null) : repo.count(filter),
    ]);
    return c.json({ notes, cursor: nextCursor(notes, { limit, sort }), total });
  })

  /**
   * One note, as a file the user can keep.
   *
   * The shape depends on whether the note has attachments, because the simplest complete
   * artifact does: with files it is a zip of the markdown beside a `files/` directory, so
   * the relative `files/…` links resolve once unpacked; with none it is that same markdown
   * served bare, since wrapping a single text file in an archive only adds a step before
   * reading it. Either way the file is named for the note, so both land in a downloads
   * folder as something recognisable.
   *
   * The user is never asked which — the wrong answer is silently lossy, and they have no
   * way to know that at the moment of clicking.
   *
   * `notes.get` returns only live notes, so a trashed note 404s here. That matches the
   * library export, which also omits the trash.
   */
  .get('/notes/:id/export', requireAuth, withRepos, async (c) => {
    const note = await c.get('notes').get(c.req.param('id'));
    if (!note) return c.json({ error: 'Not found' }, 404);

    const base = noteDirName(note.title, note.id);
    const files = await c.get('attachments').listForNote(note.id);

    /**
     * Filenames are quoted and percent-encoded, and a `filename*` form carries the
     * original bytes for clients that read it. `noteDirName` is already restricted to
     * `[a-z0-9-]`, so this is belt-and-braces rather than the thing standing between us
     * and a header injection.
     */
    const disposition = (name: string) =>
      `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;

    if (files.length === 0) {
      return new Response(noteMarkdown(note), {
        headers: {
          // charset is not optional here: titles and bodies are routinely non-ASCII, and
          // a downloaded .md opened as latin-1 mangles every one of them.
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': disposition(`${base}.md`),
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(exportNoteZipStream({ attachments: c.get('attachments'), blobs: c.env.BLOBS }, note), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': disposition(`${base}.zip`),
        'Cache-Control': 'no-store',
      },
    });
  });
