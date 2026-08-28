import { Hono } from 'hono';
import { requireAuth } from '../lib/session.js';
import { withRepos } from '../lib/repos-middleware.js';
import {
  exportNoteZipStream,
  exportZipStream,
  noteDirName,
  noteMarkdown,
} from '../lib/export.js';
import type { AppEnv } from '../types.js';

export const exportRoutes = new Hono<AppEnv>()
  .get('/export', requireAuth, withRepos, (c) => {
    const stamp = new Date().toISOString().slice(0, 10);

    // Returned immediately, before any note is read: the archive is produced as the
    // client consumes it, so nothing is ever held in the Worker's 128MB of memory.
    return new Response(
      exportZipStream({
        notes: c.get('notes'),
        attachments: c.get('attachments'),
        blobs: c.env.BLOBS,
      }),
      {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="unbent-export-${stamp}.zip"`,
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
