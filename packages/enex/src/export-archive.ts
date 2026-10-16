import { TextReader, ZipWriter } from '@zip.js/zip.js';
import {
  EMPTY_EXPORT_README,
  noteDirName,
  noteMarkdown,
  notebooksToExport,
  serializeNotebook,
  textSidecarPath,
  type ExportFilter,
  type ExportPage,
  type ExportedNote,
  type FieldDef,
  type NotebookSummary,
} from '@unbent/shared';

/**
 * Writes the library export: the zip the importer beside this reads back.
 *
 * Built by the client rather than the Worker. It was one request that streamed the zip
 * from the Worker, reading each note and each of its files as the browser pulled the
 * bytes. A Worker request may make only so many calls to D1 and R2 (a thousand on
 * Workers Free by the platform's limits page) and a library is tens of thousands of
 * them, so the backup could never have finished on the archive it existed for. Now the
 * client asks for a page of notes at a time (`GET /api/export/notes`), fetches each file
 * through the note's own file route, and writes the zip with the names and markdown from
 * `@unbent/shared`: the same archive the Worker used to write. It lives beside the
 * importer so the two halves of the round trip are one package, and so the API's tests
 * can build an archive from a running instance the way the web app does.
 */

/**
 * What an export reads and writes, so the archive's layout can be tested against fakes:
 * a page of notes, a file's bytes, the notebooks and each one's fields.
 *
 * `file` answers null for a file that is no longer there: deleted with its note, or
 * missing from storage, while a long export was on its way to it. That file is skipped
 * and counted rather than failing the archive: the old Worker skipped them too, and
 * throwing away an hour of backup over one file is the worse outcome by far. Anything
 * else it throws still ends the export; retrying is the source's business.
 */
export interface ExportSource {
  page(filter: ExportFilter, cursor: string | undefined, signal?: AbortSignal): Promise<ExportPage>;
  file(noteId: string, filename: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
  notebooks(): Promise<NotebookSummary[]>;
  fields(notebookId: string): Promise<FieldDef[]>;
}

export interface WriteProgress {
  done: number;
  total: number | null;
  /** Files written. */
  files: number;
  /** Files a note listed that were gone by the time they were fetched. */
  skipped: number;
}

/**
 * Writes the archive for `filter` into `writable`. Pure of any UI: the store below
 * drives it, and the tests drive it with a fake source and a blob for the writable.
 *
 * The order is the one the Worker wrote: each note's markdown, then its files under
 * `files/` with their text beside them, then `notebooks/<slug>.yaml` for the notebooks
 * in scope: those come last because a slice only learns which notebooks it touched by
 * walking its notes. The
 * importer reads the zip's central directory and takes the definitions first whatever
 * order they were written in. An export that finds nothing still writes a valid zip,
 * with a README saying so, rather than an empty file that will not open.
 */
export async function writeArchive(
  writable: WritableStream<Uint8Array>,
  filter: ExportFilter,
  source: ExportSource,
  signal: AbortSignal,
  onProgress: (progress: WriteProgress) => void = () => {},
): Promise<WriteProgress> {
  const zip = new ZipWriter(writable, { bufferedWrite: true, useWebWorkers: false });
  const progress: WriteProgress = { done: 0, total: null, files: 0, skipped: 0 };
  const seenNotebooks = new Set<string>();
  const dirs = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    signal.throwIfAborted();
    const page = await source.page(filter, cursor, signal);
    if (page.total !== null) {
      progress.total = page.total;
      onProgress({ ...progress });
    }
    for (const note of page.notes) {
      signal.throwIfAborted();
      await writeNote(zip, note, uniqueDir(dirs, note), source, signal, progress);
      progress.done += 1;
      if (note.notebookId) seenNotebooks.add(note.notebookId);
      onProgress({ ...progress });
    }
    if (!page.cursor) break;
    cursor = page.cursor;
  }

  signal.throwIfAborted();
  const all = await source.notebooks();
  for (const { notebook, path } of notebooksToExport(all, filter, seenNotebooks)) {
    signal.throwIfAborted();
    const fields = await source.fields(notebook.id);
    await zip.add(path, new TextReader(serializeNotebook(notebook, fields)), {
      level: 6,
      zip64: false,
    });
  }

  if (progress.done === 0) {
    await zip.add('README.txt', new TextReader(EMPTY_EXPORT_README), { level: 0, zip64: false });
  }

  await zip.close();
  return progress;
}

/**
 * The directory a note gets in this archive: `noteDirName`, unless an earlier note already
 * took that name, in which case the whole id rather than its first eight characters.
 *
 * zip.js refuses a second entry under a name it has written ("File already exists"), and
 * that refusal ends the whole export: an hour of backup lost to two notes. It happened:
 * notes imported from Notion keep their page ids, which share their leading digits when
 * the pages were made close together, so two same-titled pages from one Notion database
 * mapped to one directory. The short name stays the rule because it is the one a person
 * reads in Finder; the importer ignores directory names, so the longer one restores the
 * same. A numbered suffix past that covers the one case the whole id cannot, the same
 * note listed twice, rather than failing on it.
 */
function uniqueDir(used: Set<string>, note: ExportedNote): string {
  let dir = noteDirName(note.title, note.id);
  if (used.has(dir)) dir = noteDirName(note.title, note.id, Infinity);
  const full = dir;
  for (let n = 2; used.has(dir); n += 1) dir = `${full}-${n}`;
  used.add(dir);
  return dir;
}

/**
 * One note's directory: its markdown, then every stored file under `files/`, each followed
 * by its text under `text/` or `described/` when the page says it has any.
 *
 * Every stored file, not only the ones the body still links. Uploading and then cutting
 * the link keeps the file (see the Attachments panel), and those leftovers are still part
 * of the note: dropping them would make the backup lossy. Files are stored uncompressed:
 * images, PDFs and video are already compressed, so deflating them burns CPU for nothing.
 *
 * `zip64: false` on every entry, as the Worker wrote them: macOS Archive Utility refuses
 * an archive whose headers reserve Zip64 space, which is what a double-click in Finder
 * produces.
 *
 * Counts each file into `progress` as written or skipped; see `ExportSource.file`.
 */
async function writeNote(
  zip: ZipWriter<unknown>,
  note: ExportedNote,
  // Names both the note's directory and its markdown, so the two always agree.
  base: string,
  source: ExportSource,
  signal: AbortSignal,
  progress: WriteProgress,
): Promise<void> {
  await zip.add(`${base}/${base}.md`, new TextReader(noteMarkdown(note)), { level: 6, zip64: false });
  for (const file of note.attachments ?? []) {
    signal.throwIfAborted();
    const bytes = await source.file(note.id, file.filename, signal);
    if (!bytes) {
      progress.skipped += 1;
      continue;
    }
    await zip.add(`${base}/files/${file.filename}`, bytes, { level: 0, zip64: false, signal });
    progress.files += 1;
    /*
       Only beside a file that made it into the archive: text for a file that was gone by
       the time it was fetched would restore as nothing, attached to nothing. Deflated,
       unlike the file, because plain text is what deflate is for.
    */
    if (file.text) {
      await zip.add(`${base}/${textSidecarPath(file.filename, file.readBy)}`, new TextReader(file.text), {
        level: 6,
        zip64: false,
      });
    }
  }
}

