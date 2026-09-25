import { TextReader, ZipWriter } from '@zip.js/zip.js';
import {
  EMPTY_EXPORT_README,
  noteDirName,
  noteMarkdown,
  notebooksToExport,
  serializeNotebook,
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
 * bytes. A Worker request may make only so many calls to D1 and R2 — a thousand on
 * Workers Free by the platform's limits page — and a library is tens of thousands of
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
 */
export interface ExportSource {
  page(filter: ExportFilter, cursor: string | undefined): Promise<ExportPage>;
  file(noteId: string, filename: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  notebooks(): Promise<NotebookSummary[]>;
  fields(notebookId: string): Promise<FieldDef[]>;
}

export interface WriteProgress {
  done: number;
  total: number | null;
  files: number;
}

/**
 * Writes the archive for `filter` into `writable`. Pure of any UI: the store below
 * drives it, and the tests drive it with a fake source and a blob for the writable.
 *
 * The order is the one the Worker wrote: each note's markdown, then its files under
 * `files/`, then `notebooks/<slug>.yaml` for the notebooks in scope — those come last
 * because a slice only learns which notebooks it touched by walking its notes. The
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
  const progress: WriteProgress = { done: 0, total: null, files: 0 };
  const seenNotebooks = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    signal.throwIfAborted();
    const page = await source.page(filter, cursor);
    if (page.total !== null) {
      progress.total = page.total;
      onProgress({ ...progress });
    }
    for (const note of page.notes) {
      signal.throwIfAborted();
      await writeNote(zip, note, source, signal);
      progress.done += 1;
      progress.files += note.attachments?.length ?? 0;
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
    await zip.add(path, new TextReader(serializeNotebook(notebook.name, fields)), {
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
 * One note's directory: its markdown, then every stored file under `files/`.
 *
 * Every stored file, not only the ones the body still links. Uploading and then cutting
 * the link keeps the file (see the Attachments panel), and those leftovers are still part
 * of the note — dropping them would make the backup lossy. Files are stored uncompressed:
 * images, PDFs and video are already compressed, so deflating them burns CPU for nothing.
 *
 * `zip64: false` on every entry, as the Worker wrote them: macOS Archive Utility refuses
 * an archive whose headers reserve Zip64 space, which is what a double-click in Finder
 * produces.
 */
async function writeNote(
  zip: ZipWriter<unknown>,
  note: ExportedNote,
  source: ExportSource,
  signal: AbortSignal,
): Promise<void> {
  // Names both the note's directory and its markdown, so the two always agree.
  const base = noteDirName(note.title, note.id);
  await zip.add(`${base}/${base}.md`, new TextReader(noteMarkdown(note)), { level: 6, zip64: false });
  for (const file of note.attachments ?? []) {
    signal.throwIfAborted();
    const bytes = await source.file(note.id, file.filename, signal);
    await zip.add(`${base}/files/${file.filename}`, bytes, { level: 0, zip64: false, signal });
  }
}

