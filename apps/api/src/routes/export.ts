import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { exportQuerySchema } from '@unbent/shared';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import {
  exportNoteZipStream,
  exportZipStream,
  noteDirName,
  noteMarkdown,
  slugify,
  type ExportFilter,
} from '../lib/export.js';
import type { AppEnv } from '../types.js';

/**
 * A filename that says what is inside.
 *
 * A filtered export is a slice, and several slices land in the same downloads folder on
 * the same day. Naming them all `unbent-export-2026-08-29.zip` makes the user open each
 * one to find out which is which, so the scope goes in the name: notebook, then tag, then
 * the date bounds. Slugified because this ends up in a Content-Disposition header and on
 * a filesystem.
 */
function exportFilename(filter: ExportFilter, stamp: string): string {
  const scoped = Boolean(
    filter.notebook || filter.tags?.length || filter.fields?.length || filter.from || filter.to,
  );
  // An unfiltered export keeps the name it has always had, so existing habits and any
  // backup script pointing at it are undisturbed.
  const parts = ['unbent', ...(scoped ? [] : ['export'])];
  if (filter.notebook) parts.push(slugify(filter.notebook));
  // Every tag lands in the name: an export filtered to two tags is a different set
  // than either alone, and a filename naming only the first would describe the wrong
  // archive.
  for (const tag of filter.tags ?? []) parts.push(slugify(tag));
  if (filter.from || filter.to) parts.push(`${filter.from ?? 'start'}-to-${filter.to ?? 'now'}`);
  parts.push(stamp);
  return `${parts.join('-')}.zip`;
}

export const exportRoutes = new Hono<AppEnv>()
  .get('/export', requireAuth, withRepos, zValidator('query', exportQuerySchema), (c) => {
    const stamp = new Date().toISOString().slice(0, 10);
    // Field filters are in the set but not in the name: a filename has no room for
    // "<uuid>:gte:20", and the notebook that scopes them is already there.
    const { tag: tags, notebook, field: fields, from, to, sort } = c.req.valid('query');
    const filter = { tags, notebook, fields, from, to, sort };

    // Returned immediately, before any note is read: the archive is produced as the
    // client consumes it, so nothing is ever held in the Worker's 128MB of memory.
    return new Response(
      exportZipStream(
        {
          notes: c.get('notes'),
          attachments: c.get('attachments'),
          blobs: c.env.BLOBS,
        },
        filter,
      ),
      {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${exportFilename(filter, stamp)}"`,
          'Cache-Control': 'no-store',
        },
      },
    );
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
