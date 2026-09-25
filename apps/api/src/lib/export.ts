import { ZipWriter } from '@zip.js/zip.js';
import { noteDirName, noteMarkdown } from '@unbent/shared';
import type { Note } from '@unbent/shared';
import type { AttachmentsRepo } from './attachments-repo.js';

/**
 * A single note's download, as a zip.
 *
 * The library export is not here. It used to be: one request that streamed a zip of every
 * note, reading each note and each of its files as the client pulled the bytes. A Worker
 * request may make only so many calls to D1 and R2 — a thousand on Workers Free by the
 * platform's limits page — and a library of a few thousand notes is tens of thousands of
 * them, so that request could never finish on the archive it was the backup for. The
 * browser builds the archive now, a page of notes per request (`GET /api/export/notes`)
 * and a request per file, with the same names and markdown from `@unbent/shared`, so the
 * zip it writes is the one this used to write. One note is a handful of calls, so its
 * download stays here, where the bytes and the key are.
 */

/** What writing one note's entries needs: its blobs, and where to read them from. */
interface NoteEntryDeps {
  attachments: AttachmentsRepo;
  blobs: R2Bucket;
}

/**
 * Writes one note's markdown and its `files/` into an open archive, at the archive root.
 *
 * The markdown sits one level above its own `files/` directory, which is what makes the
 * relative `files/…` destinations in the body resolve once unpacked — the same layout the
 * library export gives each note's directory, so a single note's zip unpacks to a folder
 * that could have come out of the library's tree.
 *
 * The markdown is named for the note rather than a fixed `note.md`: an export of a large
 * library is a folder tree someone will later search in Finder or Spotlight, and a
 * thousand identically-named files make those results useless.
 */
async function writeNoteEntry(
  zip: ZipWriter<unknown>,
  { attachments, blobs }: NoteEntryDeps,
  note: Note,
): Promise<void> {
  // Names both the note's directory and its markdown, so the two always agree.
  const base = noteDirName(note.title, note.id);

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
  await zip.add(`${base}.md`, new Blob([noteMarkdown(note)]).stream(), {
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

    await zip.add(`files/${file.filename}`, object.body, { level: 0, zip64: false });
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
 * Callers hand this straight to a Response rather than awaiting it: the work is driven by
 * consumption, and buffering would hold the note's files in the Worker's memory.
 */
export function exportNoteZipStream(
  deps: NoteEntryDeps,
  note: Note,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  void (async () => {
    const zip = new ZipWriter(writable, { bufferedWrite: false });
    await writeNoteEntry(zip, deps, note);
    await zip.close();
  })().catch((err) => {
    console.error('Note export failed mid-stream:', err);
    void writable.abort(err);
  });

  return readable;
}
