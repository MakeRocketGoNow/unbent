import { serialize } from './frontmatter.js';
import { fieldsByName } from './fields.js';
import { NOTEBOOKS_DIR } from './notebook-file.js';
import { UNFILED } from './schemas.js';
import type { AttachmentInfo, Note, NotebookSummary, NoteSort } from './schemas.js';

/**
 * The shape of an export on disk, shared by whoever writes one.
 *
 * The library export is built in the browser (see the web app's `export-archive.ts`), a
 * single note's download on the server, and the importer reads both back. One definition
 * of the names and the markdown keeps the three from drifting: a directory named one way
 * by the browser and another by the Worker would be two archives that look the same and
 * restore differently.
 */

/** Filesystem-safe slug for a note directory name. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks left by NFKD
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
    // Every value the note carries, by field name, including any left over from a
    // notebook it has since left — an export that dropped those would be a lossy backup.
    ...(note.fields?.length ? { fields: fieldsByName(note.fields, note.notebookId ?? null) } : {}),
    body: note.body,
  });
}

/**
 * One of a note's files as an export page names it, with the text this instance holds for
 * it when there is any: what the file's own text layer gave, or what the vision model read
 * from it (`readBy: 'vision'`). Both are absent for a file with no text, or an empty row.
 */
export interface ExportedAttachment extends Pick<AttachmentInfo, 'filename' | 'contentType'> {
  text?: string;
  readBy?: 'vision';
}

/** A whole note with the names of its files: what one export page carries. */
export interface ExportedNote extends Note {
  attachments?: ExportedAttachment[];
}

/**
 * Where a file's text sits in the archive, beside its `files/` directory.
 *
 * Without it a restore read every file again: each PDF back through extraction, and each
 * picture and text-less scan back to pending for the vision model — a paid call per file,
 * on an instance that may have no key at all, producing different words than the ones
 * search and Auto-fill were built on. So the text travels with the file, as a plain
 * `<filename>.txt` a person can `grep` in the unpacked folder.
 *
 * The directory says who wrote it — `text/` for the file's own text layer, `described/`
 * for the vision model — which is the one other thing the row records. That keeps the
 * filename exactly the file's, needs no index, and leaves a hand-unpacked archive readable.
 * A file never has both; the export writes one or neither.
 */
export const TEXT_DIR = 'text';
export const DESCRIBED_DIR = 'described';

export function textSidecarPath(filename: string, readBy: 'vision' | null | undefined): string {
  return `${readBy === 'vision' ? DESCRIBED_DIR : TEXT_DIR}/${filename}.txt`;
}

/** One page of `GET /api/export/notes`. */
export interface ExportPage {
  notes: ExportedNote[];
  /** Pass back as `cursor` for the next page; null when there are no more. */
  cursor: string | null;
  /** How many notes the export holds. Only on the first page. */
  total: number | null;
}

/**
 * The same filters the note list takes, so an export is the view the user was looking at.
 *
 * Deliberately not a sort: the archive is a set of directories on disk, where order is the
 * filesystem's business. `sort` names the column a date range applies to, so an export of
 * a range covers the same notes the list did, and orders nothing.
 */
export interface ExportFilter {
  tags?: string[] | undefined;
  notebook?: string | undefined;
  fields?: string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sort?: NoteSort | undefined;
}

/** Whether a filter narrows the export to a slice of the library. */
export function isExportSlice(filter: ExportFilter): boolean {
  return Boolean(
    filter.notebook || filter.tags?.length || filter.fields?.length || filter.from || filter.to,
  );
}

/**
 * A filename that says what is inside.
 *
 * A filtered export is a slice, and several slices land in the same downloads folder on
 * the same day. Naming them all `unbent-export-2026-08-29.zip` makes the user open each
 * one to find out which is which, so the scope goes in the name: notebook, then tags, then
 * the date bounds. Field filters are in the set but not in the name: a filename has no
 * room for `<uuid>:gte:20`, and the notebook that scopes them is already there.
 */
export function exportFilename(filter: ExportFilter, stamp: string): string {
  // An unfiltered export keeps the name it has always had, so existing habits and any
  // backup script pointing at it are undisturbed.
  const parts = ['unbent', ...(isExportSlice(filter) ? [] : ['export'])];
  if (filter.notebook) parts.push(slugify(filter.notebook));
  // Every tag lands in the name: an export filtered to two tags is a different set
  // than either alone, and a filename naming only the first would describe the wrong
  // archive.
  for (const tag of filter.tags ?? []) parts.push(slugify(tag));
  if (filter.from || filter.to) parts.push(`${filter.from ?? 'start'}-to-${filter.to ?? 'now'}`);
  parts.push(stamp);
  return `${parts.join('-')}.zip`;
}

/**
 * Which notebooks an archive carries a `notebooks/<slug>.yaml` for.
 *
 * All of them for an unfiltered export, empty ones included — a backup that dropped a
 * notebook because it happened to hold no notes that day would not be a backup of the
 * account. A filtered export is a slice, so it carries the notebooks its notes are in,
 * plus the one the filter named even if nothing matched inside it; a person exporting a
 * notebook to move it wants its shape to arrive whether or not its notes did.
 *
 * Returns each notebook with the filename it gets. Two names can share a slug ("A/B" and
 * "A B"); the name inside the file is the one the importer reads, so the filename only
 * has to be distinct.
 */
export function notebooksToExport(
  all: NotebookSummary[],
  filter: ExportFilter,
  seenNotebookIds: ReadonlySet<string>,
): Array<{ notebook: NotebookSummary; path: string }> {
  const named =
    filter.notebook && filter.notebook !== UNFILED ? filter.notebook.trim().toLowerCase() : null;
  const inScope = isExportSlice(filter)
    ? all.filter((nb) => seenNotebookIds.has(nb.id) || nb.name.toLowerCase() === named)
    : all;
  const used = new Set<string>();
  return inScope.map((notebook) => {
    let base = slugify(notebook.name);
    for (let n = 2; used.has(base); n += 1) base = `${slugify(notebook.name)}-${n}`;
    used.add(base);
    return { notebook, path: `${NOTEBOOKS_DIR}/${base}.yaml` };
  });
}

/** What an archive holds when the export found nothing: still a valid zip, and it says so. */
export const EMPTY_EXPORT_README = 'No notes to export.\n';
