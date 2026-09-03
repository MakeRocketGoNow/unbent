import { ZipWriter } from '@zip.js/zip.js';
import { serialize } from '@unbent/shared';
import type { Note, NoteSort } from '@unbent/shared';
import { nextCursor, type NotesRepo } from './notes-repo.js';
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
 * The same filters the note list takes, so an export is the view the user was looking at.
 *
 * Deliberately not a sort: the archive is a set of directories on disk, where order is the
 * filesystem's business, and asking for one would only make the query slower.
 */
export interface ExportFilter {
  tags?: string[] | undefined;
  notebook?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /**
   * Not an ordering — the archive is a directory tree. It names the column the date range
   * applies to, so an export of a range covers the same notes the list did.
   */
  sort?: NoteSort | undefined;
}

/**
 * Returns a stream of a zip containing one directory per note.
 *
 * The caller must return this as a Response body immediately rather than awaiting it —
 * the work is driven by consumption, and buffering would defeat the whole design.
 */
export function exportZipStream(
  deps: ExportDeps,
  filter: ExportFilter = {},
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  // Deliberately not awaited: the promise resolves only as the consumer pulls bytes.
  void writeArchive(writable, deps, filter).catch((err) => {
    console.error('Export failed mid-stream:', err);
    // The response has already begun, so the only signal available is an aborted body.
    void writable.abort(err);
  });

  return readable;
}

async function writeArchive(
  writable: WritableStream<Uint8Array>,
  { notes, attachments, blobs }: ExportDeps,
  filter: ExportFilter,
): Promise<void> {
  const zip = new ZipWriter(writable, { bufferedWrite: false });

  let cursor: string | undefined;
  let count = 0;

  for (;;) {
    const page = await notes.list({ limit: PAGE, cursor, ...filter });
    if (page.length === 0) break;

    for (const summary of page) {
      const note = await notes.get(summary.id);
      if (!note) continue; // deleted between listing and reading

      // One directory per note; the writer names the markdown inside it the same way.
      await writeNoteEntry(zip, { attachments, blobs }, note, 'nested');
      count += 1;
    }

    // Asked for rather than rebuilt here: a hand-written cursor is a second copy of the
    // pagination rule, and the two drift the moment the list learns a new ordering.
    const next = nextCursor(page, { limit: PAGE, sort: filter.sort ?? 'updated' });
    if (!next) break;
    cursor = next;
  }

  // A zip with no entries is still a valid zip; an empty account exports an empty archive
  // rather than an error.
  if (count === 0) {
    await zip.add('README.txt', new Blob(['No notes to export.\n']).stream(), {
      level: 0,
      zip64: false,
    });
  }

  await zip.close();
}

/**
 * A note as markdown — frontmatter from its columns, then the body.
 *
 * Shared with the single-note route, which serves this same text directly when a note has
 * no attachments to put beside it. One definition so the two spellings of "a note on
 * disk" cannot disagree about what frontmatter a note carries.
 */
export function noteMarkdown(note: Note): string {
  return serialize({
    id: note.id,
    title: note.title,
    created: new Date(note.createdAt),
    updated: new Date(note.updatedAt),
    tags: note.tags,
    ...(note.notebook ? { notebook: note.notebook } : {}),
    body: note.body,
  });
}

/** What writing one note's entries needs: its blobs, and where to read them from. */
type NoteEntryDeps = Pick<ExportDeps, 'attachments' | 'blobs'>;

/**
 * Writes one note's markdown and its `files/` into an open archive.
 *
 * Shared by the whole-library export and the single-note download so the two can never
 * drift apart on the things that matter: the frontmatter contract `parse` reads back, and
 * the markdown sitting one level above its own `files/` directory, which is what makes the
 * relative `files/…` destinations in the body resolve once unpacked.
 *
 * `layout` is the only difference between the two callers. The library export is 'nested':
 * one directory per note, or notes would collide in a single flat archive. A single-note
 * zip is 'flat' — it is already named for its note, so nesting would just put a folder
 * inside an identically-named folder.
 *
 * The markdown is named for the note rather than a fixed `note.md`: an export of a large
 * library is a folder tree someone will later search in Finder or Spotlight, and a
 * thousand identically-named files make those results useless. It duplicates the
 * directory name, which is the price of every hit being distinguishable.
 */
async function writeNoteEntry(
  zip: ZipWriter<unknown>,
  { attachments, blobs }: NoteEntryDeps,
  note: Note,
  layout: 'nested' | 'flat',
): Promise<void> {
  // Names both the note's directory and its markdown, so the two always agree.
  const base = noteDirName(note.title, note.id);
  const prefix = layout === 'nested' ? `${base}/` : '';

  /*
     `zip64: false` on every entry, and it is not an optimisation.

     Entries are added as streams, so their length is not known when the local header is
     written. zip.js handles that by reserving Zip64 space — `ffffffff` size placeholders
     and extract version 45 — even for a one-kilobyte note. Command-line unzip copes;
     macOS Archive Utility refuses the whole archive with "Error 79 - Inappropriate file
     type or format", which is what a double-click in Finder produces. Forcing 32-bit
     fields writes version 20 headers that it accepts.

     The sizes still arrive in the trailing data descriptor, so streaming is unaffected —
     this only caps an entry at 4GB, which is already far beyond what a Worker response
     can carry.
  */
  // Markdown compresses well.
  await zip.add(`${prefix}${base}.md`, new Blob([noteMarkdown(note)]).stream(), {
    level: 6,
    zip64: false,
  });

  // Attachments stream straight from R2 into the archive — never buffered, so a note
  // with a 90MB video does not blow the Worker's 128MB ceiling. Stored uncompressed:
  // images, PDFs, and video are already compressed, so deflating them burns CPU for
  // roughly nothing.
  //
  // Every stored file is included, not only the ones the body still links. Uploading and
  // then cutting the link keeps the blob (see the Attachments panel), and those leftovers
  // are still part of the note — dropping them here would make the download lossy in a
  // way the library export is not.
  for (const file of await attachments.listForNote(note.id)) {
    const row = await attachments.resolve(note.id, file.filename);
    if (!row) continue;

    const object = await blobs.get(row.r2_key);
    if (!object?.body) continue;

    await zip.add(`${prefix}files/${file.filename}`, object.body, { level: 0, zip64: false });
  }
}

/**
 * Returns a stream of a zip holding one note.
 *
 * Written at the archive root rather than inside a directory: the zip is already named
 * for the note, so unpacking it produces a folder of that name either way, and nesting
 * one more would just be a folder inside an identically-named folder.
 *
 * `files/` stays. It is what keeps the relative destinations in the markdown resolving,
 * and it is the reason an attachment can be called anything at all — including the same
 * name as the note's own markdown — without one silently overwriting the other.
 *
 * Callers hand this straight to a Response rather than awaiting it.
 */
export function exportNoteZipStream(
  deps: NoteEntryDeps,
  note: Note,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  void (async () => {
    const zip = new ZipWriter(writable, { bufferedWrite: false });
    await writeNoteEntry(zip, deps, note, 'flat');
    await zip.close();
  })().catch((err) => {
    console.error('Note export failed mid-stream:', err);
    void writable.abort(err);
  });

  return readable;
}
