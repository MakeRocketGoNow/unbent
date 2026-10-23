import { MAX_TAG_LENGTH, MAX_TITLE_LENGTH } from '@unbent/shared';
import { guessContentType } from './content-type-guess.js';
import { enmlToMarkdown } from './enml-to-markdown.js';
import type { ArchiveSource } from './import-archive.js';
import {
  ImportRun,
  applyRenames,
  uploadFiles,
  type ImportClient,
  type ImportFile,
  type ImportOptions,
  type ImportProgress,
} from './import-run.js';
import { JoplinType, joplinTime, parseJoplinItem } from './joplin-item.js';
import { contentHash, withSourceLink } from './note-body.js';
import { nextAvailableFilename, sanitizeLabel, truncate } from './parse.js';
import { fileDestination } from './notion-page.js';
import { BlobWindow, listTar, type TarEntry } from './tar.js';

/**
 * Imports a Joplin export: the `.jex` file from File → Export all → JEX.
 *
 * JEX rather than Joplin's "Markdown + Front Matter" export, because JEX is Joplin's own
 * backup format and loses nothing this app keeps. Every note carries its id, so a second
 * import finds each note already here even after it was edited, which the Markdown export
 * (no ids, only titles and paths) could only guess at by content. Its dates are the ones
 * the person sees in Joplin (`user_created_time`, `user_updated_time`) to the
 * millisecond; tags are items of their own rather than a front-matter list; notebooks
 * keep their nesting through `parent_id`; and each attachment keeps its original name
 * and type, where the Markdown export renames them into one `_resources` folder. It is
 * also one file to pick, where the Markdown export is a folder the person would first
 * have to zip.
 *
 * The archive is a tar of `<id>.md` items (see `joplin-item.ts`) and a `resources/`
 * folder holding each attachment's bytes as `<id>.<extension>`. Notes link their
 * attachments and each other as `:/<id>`; those become `files/` links and links to the
 * imported notes. A nested notebook is named for its whole path (`Work / Receipts`),
 * since notebooks here do not nest and two notebooks called Receipts under different
 * parents are not the same notebook.
 *
 * Left behind on purpose: notes in Joplin's trash, which the person deleted; and notes
 * Joplin could not decrypt when it exported them, which arrive as cipher text and are
 * reported as failures rather than imported as gibberish.
 */

const ITEM_RE = /^([0-9a-f]{32})\.md$/i;
const RESOURCE_RE = /^([0-9a-f]{32})(?:\.[^/]*)?$/i;

/** What a note needs before its file is read again for its body. */
interface NoteRef {
  id: string;
  title: string;
  entry: TarEntry;
}

interface Resource {
  id: string;
  /** The name it is uploaded under, before any de-duplication within a note. */
  name: string;
  mime: string | undefined;
  /** Missing when the export holds the record but not the bytes. */
  entry: TarEntry | undefined;
}

interface Model {
  notes: NoteRef[];
  /** Notebook id to its name here, the path of titles from the top. */
  notebooks: Map<string, string>;
  /** Note id to its tag names. */
  tags: Map<string, string[]>;
  resources: Map<string, Resource>;
  /**
   * Items that could not be read, by their path in the archive. Reported rather than
   * thrown: one damaged or hand-edited item ending the run would leave every other note
   * out, and on every retry, since the file would fail the same way each time.
   */
  unreadable: Array<{ path: string; reason: string }>;
}

/** Joplin's id as a note id here: the same 32 digits, dashed as a UUID is. */
export function joplinIdToNoteId(id: string): string | undefined {
  const lower = id.toLowerCase();
  const dashed = `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
  // Joplin mints v4 UUIDs, but the server takes an id only if it is a real one, and an
  // item made by another tool may not be; that note gets a fresh id and is recognised by
  // its content instead.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(dashed) ? dashed : undefined;
}

/**
 * The name an attachment is stored under.
 *
 * Joplin's title for a resource is the file's original name, usually with its extension;
 * one pasted from the clipboard has none, and one made by an older client may have no
 * title at all. The extension Joplin stored is added when the title lacks it, so the
 * stored type and the preview both have something to go on.
 *
 * Cleaned by the ENEX importer's rules, since a title is the same kind of label an
 * Evernote `<file-name>` is: separators and control characters out, a leading dot
 * dropped (`filenameSchema` reserves it, so `.env` would be refused), and a long title
 * cut to the limit with its extension kept. A name the upload refuses costs the note
 * every attachment after it, on every run. A title with no letter or digit left is
 * named for the resource's id instead.
 */
function resourceName(id: string, props: Record<string, string>): string {
  const ext = (props.file_extension ?? '').replace(/[^0-9a-z]/gi, '').toLowerCase();
  const label = sanitizeLabel(props.title || props.filename || '');
  const base = /[\p{L}\p{N}]/u.test(label) ? label : id;
  return ext && !base.toLowerCase().endsWith(`.${ext}`) ? truncate(base, `.${ext}`) : truncate(base, '');
}

async function readModel(window: BlobWindow, entries: TarEntry[], signal: AbortSignal): Promise<Model> {
  const folders = new Map<string, { title: string; parent: string }>();
  const tagNames = new Map<string, string>();
  const noteTags: Array<{ note: string; tag: string }> = [];
  const records = new Map<string, Record<string, string>>();
  const blobs = new Map<string, TarEntry>();
  const notes: NoteRef[] = [];
  const unreadable: Model['unreadable'] = [];

  for (const entry of entries) {
    if (signal.aborted) break;
    const parts = entry.name.split('/');
    const base = parts[parts.length - 1]!;
    if (parts[parts.length - 2] === 'resources') {
      const id = RESOURCE_RE.exec(base)?.[1];
      if (id) blobs.set(id.toLowerCase(), entry);
      continue;
    }
    if (!ITEM_RE.test(base)) continue;

    let item: ReturnType<typeof parseJoplinItem>;
    try {
      item = parseJoplinItem(await window.text(entry));
    } catch (err) {
      unreadable.push({ path: entry.name, reason: (err as Error).message });
      continue;
    }
    const { props } = item;
    const id = (props.id ?? '').toLowerCase();
    if (!id) continue;
    // In Joplin's trash: the person deleted it, so it is not brought back here.
    const deleted = props.deleted_time && props.deleted_time !== '0';

    switch (item.type) {
      case JoplinType.note:
        if (!deleted) notes.push({ id, title: item.title, entry });
        break;
      case JoplinType.folder:
        if (!deleted) folders.set(id, { title: item.title, parent: (props.parent_id ?? '').toLowerCase() });
        break;
      case JoplinType.tag:
        tagNames.set(id, item.title);
        break;
      case JoplinType.noteTag:
        if (props.note_id && props.tag_id) {
          noteTags.push({ note: props.note_id.toLowerCase(), tag: props.tag_id.toLowerCase() });
        }
        break;
      case JoplinType.resource:
        records.set(id, { ...props, title: item.title });
        break;
    }
  }

  const notebooks = new Map<string, string>();
  const pathOf = (id: string, seen: Set<string>): string | undefined => {
    const known = notebooks.get(id);
    if (known !== undefined) return known;
    const folder = folders.get(id);
    // A notebook that is its own ancestor is a broken export; it is named for itself.
    if (!folder || seen.has(id)) return undefined;
    seen.add(id);
    const parent = folder.parent ? pathOf(folder.parent, seen) : undefined;
    const title = folder.title.trim() || 'Untitled';
    const path = (parent ? `${parent} / ${title}` : title).slice(0, MAX_TAG_LENGTH).trim();
    notebooks.set(id, path);
    return path;
  };
  for (const id of folders.keys()) pathOf(id, new Set());

  const tags = new Map<string, string[]>();
  for (const { note, tag } of noteTags) {
    const name = tagNames.get(tag)?.trim();
    // A tag longer than a tag may be here would refuse the whole note; it is dropped.
    if (!name || name.length > MAX_TAG_LENGTH) continue;
    const list = tags.get(note) ?? [];
    if (!list.includes(name)) list.push(name);
    tags.set(note, list);
  }

  const resources = new Map<string, Resource>();
  for (const [id, props] of records) {
    resources.set(id, { id, name: resourceName(id, props), mime: props.mime || undefined, entry: blobs.get(id) });
  }

  return { notes, notebooks, tags, resources, unreadable };
}

/** A markdown link or image whose destination is a Joplin item: `[text](:/<id>)`, maybe with an anchor or a title. */
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*<?:\/([0-9a-f]{32})(#[^)\s>]*)?>?(?:\s+"[^"\n]*")?\s*\)/gi;
/** An `<img>` Joplin writes to give a picture a size: `<img src=":/<id>" width="300">`. */
const IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*(["']):\/([0-9a-f]{32})\1[^>]*>/gi;
/** An `<a href=":/<id>">`, which an HTML note or a pasted snippet may hold. */
const ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(["']):\/([0-9a-f]{32})(#[^"']*)?\1[^>]*>([\s\S]*?)<\/a>/gi;

export type JoplinLinkTarget = { kind: 'file'; name: string } | { kind: 'note'; href: string };

/**
 * A body with Joplin's `:/<id>` links pointed at what they mean here: an attachment's
 * `files/` link, or the imported note's address. The `<img>` Joplin writes for a resized
 * picture becomes a plain markdown image, since the editor here does not draw raw HTML and
 * a picture shown at its own size beats a tag shown as text. A markdown link this cannot
 * resolve (to a note left out of the export, or an attachment whose bytes are missing) is
 * reduced to its text: `:/<id>` opens nothing here, and a link that goes nowhere should
 * not look like one. The run's failure list names a missing attachment.
 */
export function rewriteJoplinLinks(body: string, resolve: (id: string) => JoplinLinkTarget | null): string {
  const dest = (target: JoplinLinkTarget, anchor = '') =>
    target.kind === 'file' ? fileDestination(target.name) : `${target.href}${anchor}`;

  return body
    .replace(MD_LINK_RE, (whole, bang: string, text: string, id: string, anchor: string | undefined) => {
      const target = resolve(id.toLowerCase());
      if (!target) return text.trim() === '' ? whole : text;
      return `${target.kind === 'file' ? bang : ''}[${text}](${dest(target, anchor)})`;
    })
    .replace(IMG_RE, (whole, _q: string, id: string) => {
      const target = resolve(id.toLowerCase());
      if (!target || target.kind !== 'file') return whole;
      const alt = /\balt\s*=\s*(["'])(.*?)\1/i.exec(whole)?.[2] ?? target.name;
      return `![${alt}](${dest(target)})`;
    })
    .replace(ANCHOR_RE, (whole, _q: string, id: string, anchor: string | undefined, text: string) => {
      const target = resolve(id.toLowerCase());
      if (!target) return whole;
      return `[${text.replace(/<[^>]*>/g, '').trim() || (target.kind === 'file' ? target.name : 'link')}](${dest(target, anchor)})`;
    });
}

/** The ids of the items a body links to, in order of first appearance. */
function linkedIds(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/:\/([0-9a-f]{32})/gi)) ids.add(m[1]!.toLowerCase());
  return [...ids];
}

export async function importJoplin(
  file: ArchiveSource,
  client: ImportClient,
  options: ImportOptions = {},
): Promise<ImportProgress> {
  const run = new ImportRun(options);
  const { progress } = run;
  const window = new BlobWindow(file.blob);

  try {
    /*
       Every item is read before the first note, since a note's notebook, tags and files
       are items of their own. On an archive-sized export that is many seconds on a phone,
       so the running state says what it is doing, and Stop is heard here as well as
       between notes: `halt` is the caller's signal or the breaker's.
    */
    progress.currentTitle = 'Reading the export…';
    options.onProgress?.({ ...progress });
    const model = await readModel(window, await listTar(window, run.halt.signal), run.halt.signal);
    for (const { path, reason } of model.unreadable) run.problem(path, reason);
    if (model.notes.length === 0 && !run.halt.signal.aborted) {
      throw new Error('This Joplin export holds no notes.');
    }
    progress.notesTotal = model.notes.length;

    // Every note this run brings in, so a link between two of them stays a link.
    const noteIds = new Map<string, string>();
    for (const n of model.notes) {
      const id = joplinIdToNoteId(n.id);
      if (id) noteIds.set(n.id, id);
    }
    const now = Date.now();

    for (const note of model.notes) {
      if (run.halt.signal.aborted) break;
      await run.attempt(note.title || 'Untitled', () =>
        importNote(note, model, { client, run, window, file, options, noteIds, now }),
      );
    }
  } finally {
    run.release();
  }

  return run.finish();
}

interface NoteContext {
  client: ImportClient;
  run: ImportRun;
  window: BlobWindow;
  file: ArchiveSource;
  options: ImportOptions;
  noteIds: Map<string, string>;
  now: number;
}

async function importNote(ref: NoteRef, model: Model, ctx: NoteContext): Promise<void> {
  const { client, run, window, options } = ctx;
  const { progress } = run;

  const { props, body: raw } = parseJoplinItem(await window.text(ref.entry));
  progress.bytesRead += ref.entry.size;

  if (props.encryption_applied === '1') {
    throw new Error('Joplin exported this note still encrypted. Unlock it in Joplin and export again.');
  }

  // An HTML note (a web clip, mostly) is converted with the converter Evernote's notes
  // go through, which is the same markup with fewer surprises. Its `:/<id>` sources come
  // through as markdown destinations, rewritten below with everything else.
  const source = props.markup_language === '2' ? enmlToMarkdown(raw, []).markdown : raw;

  // Each attachment the note links, once, under a name no other of its files has.
  const files: Array<{ name: string; resource: Resource & { entry: TarEntry } }> = [];
  const named = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of linkedIds(source)) {
    const resource = model.resources.get(id);
    if (!resource) continue;
    if (!resource.entry) {
      run.problem(ref.title || 'Untitled', `Attachment "${resource.name}" is missing from the export.`);
      continue;
    }
    // `scan.pdf`, then `scan-2.pdf`: two attachments of one note cannot share a name.
    const name = nextAvailableFilename(resource.name, taken);
    taken.add(name);
    named.set(id, name);
    files.push({ name, resource: resource as Resource & { entry: TarEntry } });
  }

  const linked = rewriteJoplinLinks(source, (id) => {
    const file = named.get(id);
    if (file) return { kind: 'file', name: file };
    const note = ctx.noteIds.get(id);
    return note ? { kind: 'note', href: `/notes/${note}` } : null;
  });
  const sourceUrl = /^https?:\/\//i.test(props.source_url ?? '') ? props.source_url!.slice(0, 2000) : undefined;
  const body = withSourceLink(linked, sourceUrl);

  const title = (ref.title.trim() || 'Untitled').slice(0, MAX_TITLE_LENGTH);
  const created = joplinTime(props.user_created_time) ?? joplinTime(props.created_time);
  const updated = joplinTime(props.user_updated_time) ?? joplinTime(props.updated_time);
  const notebook = model.notebooks.get((props.parent_id ?? '').toLowerCase());
  const id = ctx.noteIds.get(ref.id);

  const result = await client.createNote({
    ...(id ? { id } : {}),
    title,
    body,
    tags: (model.tags.get(ref.id) ?? []).slice(0, 100),
    ...(notebook ? { notebook } : {}),
    createdAt: created ?? updated ?? ctx.now,
    updatedAt: updated ?? created ?? ctx.now,
    // Joplin's id even when it could not be kept as the note's: two empty Untitled notes
    // are two notes.
    contentHash: await contentHash(title, body, ref.id),
    sourceEnex: ctx.file.name.slice(0, 255),
    ...(sourceUrl ? { sourceUrl } : {}),
  });

  // Already here: the same rule as the other importers. Skip the note, fill in any
  // attachment a prior run that died mid-upload never stored.
  if (!result.created) {
    run.skipped(result.id);
    if (files.length > 0 && client.listFiles) {
      const existing = new Set(await client.listFiles(result.id));
      const missing = files.filter((f) => !existing.has(f.name));
      if (missing.length > 0) {
        await uploadFiles(loadFiles(missing, window, progress), result.id, client, progress, options);
      }
    }
    return;
  }

  run.created(result.id);
  if (files.length === 0) return;
  const renames = await uploadFiles(loadFiles(files, window, progress), result.id, client, progress, options);
  if (renames.size > 0) {
    await client.updateBody?.(result.id, applyRenames(body, renames));
  }
}

/** Reads each attachment's bytes only when the upload reaches it. */
async function* loadFiles(
  files: Array<{ name: string; resource: Resource & { entry: TarEntry } }>,
  window: BlobWindow,
  progress: ImportProgress,
): AsyncGenerator<ImportFile> {
  for (const { name, resource } of files) {
    const bytes = await window.bytesOf(resource.entry);
    progress.bytesRead += resource.entry.size;
    // Joplin's own type first: it read the file when it was attached. The guess is for a
    // record without one, or with only the catch-all Joplin gives a type it did not know.
    const mime = resource.mime && resource.mime !== 'application/octet-stream' ? resource.mime : guessContentType(name, bytes);
    yield { filename: name, mime, bytes };
  }
}
