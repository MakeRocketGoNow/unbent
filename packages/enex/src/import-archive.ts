import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, type Entry } from '@zip.js/zip.js';
import { NOTEBOOKS_DIR, parse, parseNotebook, type ParsedNote } from '@unbent/shared';
import { guessContentType } from './content-type-guess.js';
import { importFormat } from './import-format.js';
import {
  ImportRun,
  applyRenames,
  uploadFiles,
  type ImportClient,
  type ImportFile,
  type ImportOptions,
  type ImportProgress,
} from './import-run.js';
import { contentHash } from './note-body.js';

/**
 * Imports what this app's own export produced: the library zip, a single note's zip, or
 * a single note's bare `.md`.
 *
 * The archive is read the way it was written. A note is a markdown file with frontmatter,
 * and its attachments are whatever sits in a `files/` directory beside it — the layout
 * `writeNoteEntry` in the API lays down, nested one directory per note for a library and
 * flat at the root for a single note. Nothing else is assumed: the directory names are
 * ignored (they are a slug and an id fragment, both also in the frontmatter), so an
 * archive someone unpacked, moved around and re-zipped — with a top-level folder added and
 * Finder's `__MACOSX` beside it — reads the same as the original.
 *
 * Every note's metadata comes from its own frontmatter: notebook, tags, dates, custom
 * fields and the id it had. That is the whole reason a zip can move a notebook between
 * two instances — nothing about the notes lives outside the files.
 *
 * What is not about a note lives in `notebooks/`: one `<slug>.yaml` per notebook, naming
 * its fields with their types, options and scales. Those are applied first, before any
 * note, so that values arrive against the definitions they were written under rather
 * than ones inferred from the first value seen — which is how a URL field used to come
 * back as text and a rating as a plain number. An archive without that directory (an
 * older export, or a vault someone assembled by hand) imports exactly as before.
 *
 * Bytes are read as they are needed. `ZipReader` over a `Blob` reads the central
 * directory first and then each entry by byte range, so a multi-gigabyte archive never
 * lands in memory whole; one attachment at a time does, which the upload needs anyway.
 */

/** What the driver reads: a name to decide the format by, and the bytes. */
export interface ArchiveSource {
  name: string;
  blob: Blob;
}

interface NoteFileSource {
  filename: string;
  /** Compressed size, which is what the progress bar counts. */
  size: number;
  bytes: () => Promise<Uint8Array>;
}

interface NoteSource {
  kind: 'note';
  /** Where in the archive the markdown sits. Names the note in the log until its title is read. */
  path: string;
  size: number;
  markdown: () => Promise<string>;
  files: NoteFileSource[];
}

/** A `notebooks/<slug>.yaml` entry, yielded ahead of every note. */
interface NotebookSource {
  kind: 'notebook';
  path: string;
  size: number;
  text: () => Promise<string>;
}

export async function importArchive(
  file: ArchiveSource,
  client: ImportClient,
  options: ImportOptions = {},
): Promise<ImportProgress> {
  const run = new ImportRun(options);
  const { progress } = run;

  try {
    for await (const source of noteSources(file, progress)) {
      if (run.halt.signal.aborted) break;
      if (source.kind === 'notebook') {
        await importNotebook(source, client, run);
        continue;
      }
      await run.attempt(source.path, () =>
        importOne(source, client, run, file.name, options),
      );
    }
  } finally {
    run.release();
  }

  return run.finish();
}

async function importOne(
  source: NoteSource,
  client: ImportClient,
  run: ImportRun,
  sourceFile: string,
  options: ImportOptions,
): Promise<void> {
  const { progress } = run;
  const text = await source.markdown();
  progress.bytesRead += source.size;

  const note = parseNote(text);
  progress.currentTitle = note.title || 'Untitled';

  const result = await client.createNote({
    id: note.id,
    title: note.title,
    body: note.body,
    tags: note.tags,
    notebook: options.notebookTag ?? note.notebook,
    createdAt: note.created.getTime(),
    updatedAt: note.updated.getTime(),
    // The id belongs in the hash. Title and body alone made two empty Untitled drafts
    // (or two receipts typed the same way) look like one note, and the second was
    // skipped — its files uploaded onto the first, or dropped when the names matched.
    // Re-import still matches: same id, same hash, even if a prior run had to mint a
    // fresh row because this id was taken.
    contentHash: await contentHash(note.title, note.body, note.id),
    sourceEnex: sourceFile,
    ...(note.fields ? { fields: note.fields } : {}),
  });

  // Already here: skip the note, but still fill attachments a prior run may have missed.
  // The same rule as the ENEX importer, for the same reason — a run that died mid-upload
  // must be repairable by running it again.
  if (!result.created) {
    run.skipped(result.id);
    if (source.files.length > 0 && client.listFiles) {
      const existing = new Set(await client.listFiles(result.id));
      const missing = source.files.filter((f) => !existing.has(f.filename));
      if (missing.length > 0) {
        await uploadFiles(loadFiles(missing, progress), result.id, client, progress, options);
      }
    }
    return;
  }

  run.created(result.id);
  if (source.files.length === 0) return;

  /**
   * Every file in `files/` is uploaded, linked from the body or not. The export wrote
   * every stored file for the same reason: a file that was attached and then unlinked is
   * still the note's, and the Attachments panel still shows it. The body is left exactly
   * as exported — no appended list of unlinked files, which would change the note and,
   * with it, the hash the next import would be matched on.
   */
  const renames = await uploadFiles(
    loadFiles(source.files, progress),
    result.id,
    client,
    progress,
    options,
  );
  if (renames.size > 0) {
    await client.updateBody?.(result.id, applyRenames(note.body, renames));
  }
}

/**
 * Applies one notebook's definitions, and reports what could not be applied.
 *
 * Not wrapped in `run.attempt`: that counts notes, and this is not one. A file the server
 * refuses, or a field it declines — already here under another type, say — goes into the
 * failure log by name, where a person looking for why a field came back wrong will find
 * it. A host without `importNotebook` (an older CLI against a newer export) reads the
 * entry and moves on, which leaves the import exactly as it was before this file existed.
 */
async function importNotebook(
  source: NotebookSource,
  client: ImportClient,
  run: ImportRun,
): Promise<void> {
  const { progress } = run;
  const text = await source.text();
  progress.bytesRead += source.size;
  if (!client.importNotebook) return;

  let name = source.path;
  try {
    const definition = parseNotebook(text);
    name = definition.name;
    const { skipped } = await client.importNotebook(definition);
    for (const s of skipped) run.problem(`Field "${s.name}" in ${name}`, s.reason);
  } catch (err) {
    if (run.halt.signal.aborted) return;
    run.problem(`Notebook ${name}`, `Definitions not applied: ${(err as Error).message}`);
  }
}

/** Reads each file's bytes only when the upload reaches it. */
async function* loadFiles(
  files: NoteFileSource[],
  progress: ImportProgress,
): AsyncGenerator<ImportFile> {
  for (const file of files) {
    const bytes = await file.bytes();
    progress.bytesRead += file.size;
    yield { filename: file.filename, mime: guessContentType(file.filename, bytes), bytes };
  }
}

function parseNote(text: string): ParsedNote {
  try {
    return parse(text);
  } catch (err) {
    // The codec's message says which field is missing or malformed; the prefix says what
    // that means here, for someone looking at a list of failures from a folder of notes
    // that were never this app's.
    throw new Error(`Not an exported note: ${(err as Error).message}`);
  }
}

/** What an import source holds: its notebook definitions first, then its notes in archive order. */
async function* noteSources(
  file: ArchiveSource,
  progress: ImportProgress,
): AsyncGenerator<NoteSource | NotebookSource> {
  if (importFormat(file.name) === 'markdown') {
    progress.notesTotal = 1;
    yield {
      kind: 'note',
      path: file.name,
      size: file.blob.size,
      markdown: () => file.blob.text(),
      files: [],
    };
    return;
  }

  // No web workers of its own: this already runs off the main thread, and zip.js would
  // otherwise need its inflate worker's URL resolved by the bundler that built this one.
  const reader = new ZipReader(new BlobReader(file.blob), { useWebWorkers: false });
  try {
    const { groups, notebooks } = groupEntries(await reader.getEntries(), progress);

    // The note count is known now, before the first note is touched — every group that
    // holds a markdown file is one note. This is what the bar divides by, so it measures
    // notes done rather than bytes read. Set once, not per note, or the bar's denominator
    // would grow as the run went and it could never reach the end.
    progress.notesTotal = groups.reduce((n, group) => n + group.notes.length, 0);

    // Definitions before notes, whatever order the zip lists them in: the export writes
    // them last, since a filtered export only learns its notebooks by walking the notes.
    for (const entry of notebooks) {
      yield {
        kind: 'notebook',
        path: entry.filename,
        size: entry.compressedSize,
        text: () => entry.getData(new TextWriter()),
      };
    }

    for (const group of groups) {
      for (const entry of group.notes) {
        yield {
          kind: 'note',
          path: entry.filename,
          size: entry.compressedSize,
          markdown: () => entry.getData(new TextWriter()),
          files: group.files.map((f) => ({
            filename: f.name,
            size: f.entry.compressedSize,
            bytes: () => f.entry.getData(new Uint8ArrayWriter()),
          })),
        };
      }
    }
  } finally {
    await reader.close();
  }
}

type FileEntry = Extract<Entry, { directory: false }>;

/** One note directory's worth of entries: its markdown, and what is under its `files/`. */
interface EntryGroup {
  notes: FileEntry[];
  files: Array<{ name: string; entry: FileEntry }>;
}

/** What the archive holds, sorted: note directories, and the definitions files. */
interface ArchiveEntries {
  groups: EntryGroup[];
  notebooks: FileEntry[];
}

/**
 * Sorts the archive's entries into note directories, setting the definitions aside.
 *
 * A definitions file is any `.yaml` in a directory called `notebooks` — at the root, as
 * the export writes it, or under whatever top-level folder a re-pack added, for the same
 * reason directory names are ignored for notes. It is never mistaken for one: a note is
 * markdown and sits in its own `{slug}-{id}` directory.
 *
 * Grouping is by path rather than by reading in order, because nothing guarantees the
 * order: this app's own export writes a note's markdown before its files, but a zip
 * someone re-packed after unpacking may list them any way the tool felt like. A directory
 * with markdown and no `files/` is a note without attachments; `files/` with no markdown
 * beside it belongs to nothing and is skipped.
 *
 * Skipped outright: directory entries, which carry no bytes; Finder's `__MACOSX` tree,
 * which is resource forks for every file in the archive; and any dotfile, which is
 * `.DS_Store` and its relatives — the upload would refuse the name anyway. Their bytes
 * still count as read, so the progress bar can reach the end of the file.
 */
function groupEntries(entries: Entry[], progress: ImportProgress): ArchiveEntries {
  const groups = new Map<string, EntryGroup>();
  const notebooks: FileEntry[] = [];
  const groupFor = (dir: string): EntryGroup => {
    let group = groups.get(dir);
    if (!group) {
      group = { notes: [], files: [] };
      groups.set(dir, group);
    }
    return group;
  };

  for (const entry of entries) {
    if (entry.directory) continue;

    // Windows tools write backslashes; a leading `./` or `/` is a tool's habit, not a path.
    const segments = entry.filename
      .replace(/\\/g, '/')
      .replace(/^(\.?\/)+/, '')
      .split('/');
    const name = segments.pop() ?? '';

    const junk = segments[0] === '__MACOSX' || name.startsWith('.') || name === '';
    if (junk) {
      progress.bytesRead += entry.compressedSize;
      continue;
    }

    if (segments[segments.length - 1] === 'files') {
      groupFor(segments.slice(0, -1).join('/')).files.push({ name, entry });
    } else if (segments[segments.length - 1] === NOTEBOOKS_DIR && /\.ya?ml$/i.test(name)) {
      notebooks.push(entry);
    } else if (/\.(md|markdown)$/i.test(name)) {
      groupFor(segments.join('/')).notes.push(entry);
    } else {
      progress.bytesRead += entry.compressedSize;
    }
  }

  const result: EntryGroup[] = [];
  for (const group of groups.values()) {
    if (group.notes.length > 0) {
      result.push(group);
    } else {
      for (const f of group.files) progress.bytesRead += f.entry.compressedSize;
    }
  }
  return { groups: result, notebooks };
}
