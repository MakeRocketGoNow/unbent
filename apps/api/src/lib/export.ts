import { ZipWriter } from '@zip.js/zip.js';
import { serialize } from '@unbent/shared';
import type { NotesRepo } from './notes-repo.js';
import type { AttachmentsRepo } from './attachments-repo.js';

/**
 * Streaming folder-tree export — the backup mechanism.
 *
 * `wrangler d1 export` fails on any database containing an FTS5 table and leaves the
 * database wedged in a "processing export" state (workers-sdk#6305, #9519), so D1's own
 * export can never be the backup here. This zip is it, which is why it ships before search
 * and attachments rather than after.
 *
 * Everything streams. A Worker has 128MB of memory and a corpus can be far larger, so no
 * step may buffer the whole archive: entries are added to a ZipWriter whose output is a
 * TransformStream already being consumed by the HTTP response.
 */

/** Filesystem-safe slug for a note directory name. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks left by NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

/**
 * Directory name for a note: `{slug}-{id8}`.
 *
 * The id suffix is not decoration — two notes titled "Meeting notes" would otherwise
 * collide into one directory and the second would overwrite the first.
 */
export function noteDirName(title: string, id: string): string {
  return `${slugify(title)}-${id.replace(/-/g, '').slice(0, 8)}`;
}

/** Page size: D1 caps bound parameters at 100, which an `IN` clause of ids must fit. */
const PAGE = 100;

export interface ExportDeps {
  notes: NotesRepo;
  attachments: AttachmentsRepo;
  blobs: R2Bucket;
}

/**
 * Returns a stream of a zip containing one directory per note.
 *
 * The caller must return this as a Response body immediately rather than awaiting it —
 * the work is driven by consumption, and buffering would defeat the whole design.
 */
export function exportZipStream(deps: ExportDeps): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  // Deliberately not awaited: the promise resolves only as the consumer pulls bytes.
  void writeArchive(writable, deps).catch((err) => {
    console.error('Export failed mid-stream:', err);
    // The response has already begun, so the only signal available is an aborted body.
    void writable.abort(err);
  });

  return readable;
}

async function writeArchive(
  writable: WritableStream<Uint8Array>,
  { notes, attachments, blobs }: ExportDeps,
): Promise<void> {
  const zip = new ZipWriter(writable, { bufferedWrite: false });

  let cursor: string | undefined;
  let count = 0;

  for (;;) {
    const page = await notes.list({ limit: PAGE, cursor });
    if (page.length === 0) break;

    for (const summary of page) {
      const note = await notes.get(summary.id);
      if (!note) continue; // deleted between listing and reading

      const dir = noteDirName(note.title, note.id);
      const markdown = serialize({
        id: note.id,
        title: note.title,
        created: new Date(note.createdAt),
        updated: new Date(note.updatedAt),
        tags: note.tags,
        ...(note.notebook ? { notebook: note.notebook } : {}),
        body: note.body,
      });

      // Markdown compresses well.
      await zip.add(`${dir}/note.md`, new Blob([markdown]).stream(), { level: 6 });
      count += 1;

      // Attachments stream straight from R2 into the archive — never buffered, so a note
      // with a 90MB video does not blow the Worker's 128MB ceiling. Stored uncompressed:
      // images, PDFs, and video are already compressed, so deflating them burns CPU for
      // roughly nothing.
      for (const file of await attachments.listForNote(note.id)) {
        const row = await attachments.resolve(note.id, file.filename);
        if (!row) continue;

        const object = await blobs.get(row.r2_key);
        if (!object?.body) continue;

        await zip.add(`${dir}/files/${file.filename}`, object.body, { level: 0 });
      }
    }

    if (page.length < PAGE) break;
    cursor = String(page[page.length - 1]?.updatedAt);
  }

  // A zip with no entries is still a valid zip; an empty account exports an empty archive
  // rather than an error.
  if (count === 0) {
    await zip.add('README.txt', new Blob(['No notes to export.\n']).stream(), { level: 0 });
  }

  await zip.close();
}
