import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, type Entry } from '@zip.js/zip.js';
import { MAX_TAG_LENGTH, MAX_TITLE_LENGTH, type FieldValue, type NotebookFileField } from '@unbent/shared';
import { guessContentType } from './content-type-guess.js';
import type { ArchiveSource } from './import-archive.js';
import {
  ImportRun,
  renamedFilesProblem,
  uploadFiles,
  type ImportClient,
  type ImportFile,
  type ImportOptions,
  type ImportProgress,
} from './import-run.js';
import { contentHash } from './note-body.js';
import { atoms, convertValue, inferColumns, notionTimestamp, type NotionColumn } from './notion-columns.js';
import { parseCsv } from './notion-csv.js';
import { parseNotionPage, rewriteNotionBody, type NotionLinkTarget } from './notion-page.js';

/**
 * Imports a Notion workspace export: the "Markdown & CSV" zip.
 *
 * Notion writes one bundle per top-level item. A database is a stub page, a CSV of every
 * row, and a folder holding one markdown page per row with each row's attachments in a
 * folder named for the row. A page tree is a page and a folder of sub-pages, which may
 * hold databases of their own. A loose page is one markdown file. Every page and every
 * database is named `<title> <32 hex digits>`, and that id is what makes the export
 * re-importable: it is a UUID without its dashes, so it becomes the note's id here, and a
 * second import of the same zip finds every note already present.
 *
 * Each top-level bundle is a unit the person can choose to import or not (the picker
 * in the import panel is built from `describeNotion`) and each becomes a notebook: a
 * database's rows are its notes and its columns its fields (see `inferColumns` for how
 * the types are read from untyped CSV); a page tree's pages are its notes, and a
 * database nested inside it adds its columns to the same notebook. Loose pages have no
 * notebook of their own and go into one named by the caller.
 *
 * The export carries no timestamps. Where a database has Notion's created and
 * last-edited columns they become the note's dates; everywhere else the note is dated
 * at import time.
 */

/** A top-level bundle of the export: what the picker lists and what `include` names. */
export interface NotionUnit {
  /** Stable across runs: the bundle's filename base, id included. `pages` for the loose pages. */
  key: string;
  name: string;
  kind: 'database' | 'page' | 'pages';
  notes: number;
  attachments: number;
  /** Columns that become fields, across the unit's databases. */
  fields: number;
  /** A database whose CSV and rows are missing from the export. Nothing to import. */
  empty?: boolean;
}

export interface NotionDescription {
  units: NotionUnit[];
}

export interface NotionImportOptions extends ImportOptions {
  /** Keys of the units to import. Absent means every unit. */
  include?: string[];
  /** The notebook for pages outside any database or page tree. Empty or null for none. */
  pagesNotebook?: string | null;
  /** Whether a column named Tags becomes the note's tags rather than a field. Default true. */
  tagsAsTags?: boolean;
}

export const DEFAULT_PAGES_NOTEBOOK = 'Notion';

type FileEntry = Extract<Entry, { directory: false }>;

const PAGE_RE = /^(.*) ([0-9a-f]{32})\.md$/;
const CSV_RE = /^(.*) ([0-9a-f]{32})(?:_all)?\.csv$/;

/** Whether an entry is named the way Notion names a page or a database file. */
export function isNotionEntryName(filename: string): boolean {
  const name = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  return PAGE_RE.test(name) || CSV_RE.test(name);
}

/**
 * Which importer a zip is for: Notion's, or this app's own.
 *
 * Both are `.zip`, so the name cannot say. Notion's is the one whose files carry a
 * 32-digit id before the extension; the app's own export names its directories with a
 * slug and eight digits, and nothing in it matches.
 */
export async function detectArchiveKind(blob: Blob): Promise<'notion' | 'unbent'> {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    return entries.some((e) => !e.directory && isNotionEntryName(e.filename)) ? 'notion' : 'unbent';
  } finally {
    await reader.close();
  }
}

/** A page id as the note id it becomes: the same 32 digits, dashed as a UUID is. */
export function notionIdToNoteId(id: string): string {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

interface PageFile {
  dir: string;
  /** The filename without the id and extension: the title as Notion truncated it. */
  base: string;
  id: string;
  entry: FileEntry;
}

interface CsvFile {
  dir: string;
  base: string;
  id: string;
  entry: FileEntry;
}

interface Attachment {
  dir: string;
  name: string;
  entry: FileEntry;
}

interface Dir {
  pages: PageFile[];
  csvs: CsvFile[];
  files: Attachment[];
}

type Tree = Map<string, Dir>;

const join = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`);

/**
 * The archive's files sorted into directories.
 *
 * Notion wraps everything in one `Export-<uuid>` folder, and a zip someone re-packed
 * may wrap it in another or in none; a single wrapping folder is stripped when the
 * pages and databases sit under it rather than beside it. Directory entries, Finder's
 * `__MACOSX` tree and dotfiles are skipped, as the archive importer skips them.
 */
function readTree(entries: Entry[]): Tree {
  const files = entries
    .filter((e): e is FileEntry => !e.directory)
    .map((entry) => ({ entry, segments: entry.filename.replace(/\\/g, '/').replace(/^(\.?\/)+/, '').split('/') }))
    .filter(({ segments }) => segments[0] !== '__MACOSX' && !segments[segments.length - 1]!.startsWith('.'));

  const firsts = new Set(files.map((f) => f.segments[0]));
  const wrapped = firsts.size === 1 && files.every((f) => f.segments.length > 1);
  const rootHasNotion = files.some((f) => f.segments.length === 1 && isNotionEntryName(f.segments[0]!));
  const strip = wrapped && !rootHasNotion ? 1 : 0;

  const tree: Tree = new Map();
  const dirFor = (dir: string): Dir => {
    let d = tree.get(dir);
    if (!d) {
      d = { pages: [], csvs: [], files: [] };
      tree.set(dir, d);
    }
    return d;
  };

  for (const { entry, segments } of files) {
    const parts = segments.slice(strip);
    const name = parts.pop() ?? '';
    if (name === '') continue;
    const dir = parts.join('/');
    const page = PAGE_RE.exec(name);
    const csv = CSV_RE.exec(name);
    if (page) dirFor(dir).pages.push({ dir, base: page[1]!, id: page[2]!, entry });
    else if (csv) dirFor(dir).csvs.push({ dir, base: csv[1]!, id: csv[2]!, entry });
    else dirFor(dir).files.push({ dir, name, entry });
  }
  return tree;
}

interface Database {
  csv: CsvFile;
  /** Where its row pages sit. */
  rowsDir: string;
  columns: NotionColumn[];
}

/** One page to import, with the database whose columns name its properties, if it is a row. */
interface Located {
  page: PageFile;
  database: Database | null;
}

interface Unit extends NotionUnit {
  notebook: string | null;
  pages: Located[];
  /** The fields the unit's notebook gets, from every database in it, first name wins. */
  definitions: NotebookFileField[];
}

interface Model {
  tree: Tree;
  units: Unit[];
  /** Every path in the archive, for resolving a page's relative links. */
  byPath: Map<string, { kind: 'file'; file: Attachment } | { kind: 'page'; page: PageFile } | { kind: 'csv' }>;
  /**
   * The page id that owns each attachment folder, by the folder's path.
   *
   * Notion names a row's attachment folder after the row's title, with no id, so two rows
   * with the same title share one folder name. Both pages would otherwise claim it: the
   * files landing on whichever the run reached first, and duplicated onto the other. The
   * owner is the page whose body links a file in the folder; a folder no page links (a
   * file too big for Notion, which the export kept but never referenced) falls to the page
   * that matches the folder's base name, so an orphan still lands on its own note rather
   * than nowhere or on a stranger.
   */
  folderOwner: Map<string, string>;
}

/** A link destination that points into a folder, relative to a page's own directory. */
const RELATIVE_LINK = /\]\(\s*<?([^)>\s][^)>]*?)\/[^)>]+>?\s*\)/g;

/**
 * Which page owns each attachment folder.
 *
 * A folder is any directory holding files; its candidates are the pages in its parent
 * whose own folder it would be: same base name. When one candidate's body links into
 * it, that page owns it; otherwise the first candidate by archive order does, which for
 * the common case of a unique name is the only one. Reading bodies is scoped to folders
 * with more than one candidate, which a real export has a handful of.
 */
async function resolveFolderOwners(tree: Tree): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  for (const [dir, d] of tree) {
    if (d.files.length === 0) continue;
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    const base = dir.includes('/') ? dir.slice(dir.lastIndexOf('/') + 1) : dir;
    const candidates = (tree.get(parent)?.pages ?? []).filter((p) => p.base === base);
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      owner.set(dir, candidates[0]!.id);
      continue;
    }
    let linker: PageFile | undefined;
    for (const page of candidates) {
      const body = await page.entry.getData(new TextWriter());
      RELATIVE_LINK.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RELATIVE_LINK.exec(body))) {
        let path: string;
        try {
          path = decodeURIComponent(m[1]!);
        } catch {
          continue;
        }
        if (join(page.dir, path) === dir) {
          linker = page;
          break;
        }
      }
      if (linker) break;
    }
    owner.set(dir, (linker ?? candidates[0]!).id);
  }
  return owner;
}

async function readModel(entries: Entry[], options: NotionImportOptions): Promise<Model> {
  const tree = readTree(entries);
  const byPath: Model['byPath'] = new Map();
  for (const [dir, d] of tree) {
    for (const f of d.files) byPath.set(join(dir, f.name), { kind: 'file', file: f });
    for (const p of d.pages) byPath.set(join(dir, `${p.base} ${p.id}.md`), { kind: 'page', page: p });
    for (const c of d.csvs) {
      byPath.set(join(dir, `${c.base} ${c.id}_all.csv`), { kind: 'csv' });
      byPath.set(join(dir, `${c.base} ${c.id}.csv`), { kind: 'csv' });
    }
  }

  const databases = new Map<CsvFile, Database>();
  const database = async (csv: CsvFile): Promise<Database> => {
    let db = databases.get(csv);
    if (!db) {
      const [header = [], ...rows] = parseCsv(await csv.entry.getData(new TextWriter()));
      db = {
        csv,
        rowsDir: join(csv.dir, csv.base),
        columns: inferColumns(header, rows, { tagsAsTags: options.tagsAsTags ?? true }),
      };
      databases.set(csv, db);
    }
    return db;
  };

  /**
   * Everything under a page's or a row's own folder: sub-pages, nested databases with
   * their rows, each recursively. A page beside a database file with the same id is the
   * database's stub, not a page.
   */
  const descended = new Set<string>();
  async function descend(dir: string, into: Located[], dbs: Database[]): Promise<void> {
    const d = tree.get(dir);
    if (!d) return;
    // Two rows can share a title, so two rows can name the same folder: the shared
    // attachment folder that `resolveFolderOwners` sorts out. Walk it once, or a sub-page
    // sitting in it (a row's own sub-page) would be added, counted and imported twice.
    if (descended.has(dir)) return;
    descended.add(dir);
    const stubs = new Set(d.csvs.map((c) => c.id));
    for (const csv of d.csvs) {
      const db = await database(csv);
      dbs.push(db);
      for (const row of tree.get(db.rowsDir)?.pages ?? []) {
        into.push({ page: row, database: db });
        await descend(join(db.rowsDir, row.base), into, dbs);
      }
    }
    for (const page of d.pages) {
      if (stubs.has(page.id)) continue;
      into.push({ page, database: null });
      await descend(join(dir, page.base), into, dbs);
    }
  }

  const folderOwner = await resolveFolderOwners(tree);
  /** The folder a page owns and thus uploads, or undefined when it owns none. */
  const ownedFolder = (page: PageFile): string | undefined => {
    const dir = join(page.dir, page.base);
    return folderOwner.get(dir) === page.id ? dir : undefined;
  };
  const attachmentsUnder = (pages: Located[]) =>
    pages.reduce((n, { page }) => {
      const dir = ownedFolder(page);
      return n + (dir ? (tree.get(dir)?.files.length ?? 0) : 0);
    }, 0);

  const definitionsOf = (dbs: Database[]): NotebookFileField[] => {
    const seen = new Set<string>();
    const out: NotebookFileField[] = [];
    for (const db of dbs) {
      for (const col of db.columns) {
        if (col.kind !== 'field' || !col.field) continue;
        const key = col.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(col.field);
      }
    }
    return out;
  };

  const root = tree.get('') ?? { pages: [], csvs: [], files: [] };
  const rootCsvs = new Map(root.csvs.map((c) => [c.id, c]));
  const units: Unit[] = [];
  const loose: Located[] = [];

  for (const page of root.pages) {
    const key = `${page.base} ${page.id}`;
    const text = await page.entry.getData(new TextWriter());
    const parsed = parseNotionPage(text, new Set());
    const name = (parsed.title || page.base).slice(0, MAX_TAG_LENGTH);
    const csv = rootCsvs.get(page.id);

    if (csv) {
      const db = await database(csv);
      const pages: Located[] = [];
      const dbs: Database[] = [db];
      for (const row of tree.get(db.rowsDir)?.pages ?? []) {
        pages.push({ page: row, database: db });
        await descend(join(db.rowsDir, row.base), pages, dbs);
      }
      const definitions = definitionsOf(dbs);
      units.push({
        key, name, kind: 'database', notebook: name, pages, definitions,
        notes: pages.length, attachments: attachmentsUnder(pages), fields: definitions.length,
      });
      continue;
    }

    // Before the stub rule: a page whose folder holds a database is a page tree, even
    // when its body is nothing but the link to that database.
    const under = tree.get(page.base);
    if (under && (under.pages.length > 0 || under.csvs.length > 0)) {
      const pages: Located[] = [{ page, database: null }];
      const dbs: Database[] = [];
      await descend(page.base, pages, dbs);
      const definitions = definitionsOf(dbs);
      units.push({
        key, name, kind: 'page', notebook: name, pages, definitions,
        notes: pages.length, attachments: attachmentsUnder(pages), fields: definitions.length,
      });
      continue;
    }

    // A stub whose database never made it into the export: a page holding one link to a CSV.
    if (/^\s*\[[^\]]*\]\([^)]*\.csv\)\s*$/.test(parsed.body)) {
      units.push({ key, name, kind: 'database', notebook: null, pages: [], definitions: [], notes: 0, attachments: 0, fields: 0, empty: true });
      continue;
    }

    loose.push({ page, database: null });
  }

  // A database with rows but no stub page: a hand-made zip of one folder and its CSV.
  for (const csv of root.csvs) {
    if (root.pages.some((p) => p.id === csv.id)) continue;
    const db = await database(csv);
    const pages: Located[] = [];
    const dbs: Database[] = [db];
    for (const row of tree.get(db.rowsDir)?.pages ?? []) {
      pages.push({ page: row, database: db });
      await descend(join(db.rowsDir, row.base), pages, dbs);
    }
    const definitions = definitionsOf(dbs);
    const name = csv.base.slice(0, MAX_TAG_LENGTH);
    units.push({
      key: `${csv.base} ${csv.id}`, name, kind: 'database', notebook: name, pages, definitions,
      notes: pages.length, attachments: attachmentsUnder(pages), fields: definitions.length,
    });
  }

  if (loose.length > 0) {
    const notebook = options.pagesNotebook === undefined ? DEFAULT_PAGES_NOTEBOOK : options.pagesNotebook || null;
    units.push({
      key: 'pages', name: 'Pages', kind: 'pages', notebook, pages: loose, definitions: [],
      notes: loose.length, attachments: attachmentsUnder(loose), fields: 0,
    });
  }

  return { tree, units, byPath, folderOwner };
}

/** What the archive holds, unit by unit, for the picker. Reads only the CSVs and the top-level pages. */
export async function describeNotion(file: ArchiveSource, options: NotionImportOptions = {}): Promise<NotionDescription> {
  const reader = new ZipReader(new BlobReader(file.blob), { useWebWorkers: false });
  try {
    const model = await readModel(await reader.getEntries(), options);
    return {
      units: model.units.map(({ key, name, kind, notes, attachments, fields, empty }) => ({
        key, name, kind, notes, attachments, fields, ...(empty ? { empty } : {}),
      })),
    };
  } finally {
    await reader.close();
  }
}

export async function importNotion(
  file: ArchiveSource,
  client: ImportClient,
  options: NotionImportOptions = {},
): Promise<ImportProgress> {
  const run = new ImportRun(options);
  const { progress } = run;
  const reader = new ZipReader(new BlobReader(file.blob), { useWebWorkers: false });

  try {
    const model = await readModel(await reader.getEntries(), options);
    const chosen = model.units.filter(
      (u) => !u.empty && (options.include === undefined || options.include.includes(u.key)),
    );
    const located = chosen.flatMap((u) => u.pages.map((p) => ({ ...p, unit: u })));
    progress.notesTotal = located.length;

    // Every page this run brings in, so a link between two of them can be kept as one.
    const imported = new Set(located.map((l) => l.page.id));
    const hrefFor = (id: string) => (imported.has(id) ? `/notes/${notionIdToNoteId(id)}` : null);
    const now = Date.now();

    for (const unit of chosen) {
      if (unit.notebook && unit.definitions.length > 0 && client.importNotebook) {
        try {
          const { skipped } = await client.importNotebook({ name: unit.notebook, fields: unit.definitions });
          for (const s of skipped) run.problem(`Field "${s.name}" in ${unit.notebook}`, s.reason);
        } catch (err) {
          if (run.halt.signal.aborted) break;
          run.problem(`Notebook ${unit.notebook}`, `Definitions not applied: ${(err as Error).message}`);
        }
      }
    }

    for (const loc of located) {
      if (run.halt.signal.aborted) break;
      await run.attempt(loc.page.base, () =>
        importPage(loc, loc.unit.notebook, model, { client, run, file, options, hrefFor, now }),
      );
    }
  } finally {
    await reader.close();
    run.release();
  }

  return run.finish();
}

interface PageContext {
  client: ImportClient;
  run: ImportRun;
  file: ArchiveSource;
  options: NotionImportOptions;
  hrefFor: (id: string) => string | null;
  now: number;
}

async function importPage(
  loc: Located,
  notebook: string | null,
  model: Model,
  ctx: PageContext,
): Promise<void> {
  const { client, run, options } = ctx;
  const { progress } = run;
  const { page, database } = loc;

  const text = await page.entry.getData(new TextWriter());
  progress.bytesRead += page.entry.compressedSize;

  const known = new Set(database?.columns.map((c) => c.source) ?? []);
  const parsed = parseNotionPage(text, known);
  const title = (parsed.title || page.base || 'Untitled').slice(0, MAX_TITLE_LENGTH);
  progress.currentTitle = title;

  const fields: Record<string, FieldValue> = {};
  const tags: string[] = [];
  const sections: string[] = [];
  let createdAt: number | undefined;
  let updatedAt: number | undefined;
  for (const [source, raw] of parsed.props) {
    const column = database?.columns.find((c) => c.source === source);
    if (!column) continue;
    switch (column.kind) {
      case 'field': {
        const value = convertValue(column, raw);
        if (value !== null) fields[column.name] = value;
        break;
      }
      case 'tags':
        // A part longer than a tag may be is not a tag but a sentence that happened to
        // sit in the column; it is dropped rather than refusing the whole note.
        tags.push(...atoms(raw).filter((t) => t.length <= MAX_TAG_LENGTH));
        break;
      case 'created':
        createdAt = notionTimestamp(raw) ?? undefined;
        break;
      case 'updated':
        updatedAt = notionTimestamp(raw) ?? undefined;
        break;
      case 'body':
        if (raw.trim()) sections.push(`## ${column.name}\n\n${raw.trim()}`);
        break;
      case 'title':
        break;
    }
  }

  // The folder this page owns holds its attachments; a link may also reach a file
  // elsewhere. Ownership, not the base name, is what keeps two rows with the same title
  // from each claiming the one folder they share (see `resolveFolderOwners`).
  const folder = join(page.dir, page.base);
  const uploads = new Map<string, Attachment>();
  if (model.folderOwner.get(folder) === page.id) {
    for (const f of model.tree.get(folder)?.files ?? []) uploads.set(f.name, f);
  }

  const resolve = (path: string): NotionLinkTarget | null => {
    const full = join(page.dir, path).replace(/^(\.\/)+/, '');
    const hit = model.byPath.get(full);
    if (!hit) return null;
    if (hit.kind === 'file') {
      uploads.set(hit.file.name, hit.file);
      return { kind: 'file', name: hit.file.name };
    }
    if (hit.kind === 'page') {
      const href = ctx.hrefFor(hit.page.id);
      return href ? { kind: 'page', href } : null;
    }
    return { kind: 'database' };
  };
  const body = [...sections, rewriteNotionBody(parsed.body, { resolve, page: ctx.hrefFor })]
    .filter((s) => s.trim() !== '')
    .join('\n\n');

  const id = notionIdToNoteId(page.id);
  const result = await client.createNote({
    id,
    title,
    body,
    tags: [...new Set(tags)].slice(0, 100),
    ...(notebook ? { notebook } : {}),
    createdAt: createdAt ?? updatedAt ?? ctx.now,
    updatedAt: updatedAt ?? createdAt ?? ctx.now,
    contentHash: await contentHash(title, body, id),
    sourceEnex: ctx.file.name,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  });

  const files = [...uploads.values()];

  // Already here: the same rule as the other importers. Skip the note, fill in any
  // attachment a prior run that died mid-upload never stored.
  if (!result.created) {
    run.skipped(result.id);
    if (files.length > 0 && client.listFiles) {
      const existing = new Set(await client.listFiles(result.id));
      const missing = files.filter((f) => !existing.has(f.name));
      if (missing.length > 0) {
        await uploadFiles(loadFiles(missing, progress), result.id, client, progress, options);
      }
    }
    return;
  }

  run.created(result.id);
  if (files.length === 0) return;
  const renames = await uploadFiles(loadFiles(files, progress), result.id, client, progress, options);
  if (renames.size > 0) run.problem(title, renamedFilesProblem(renames));
}

/** Reads each attachment's bytes only when the upload reaches it. */
async function* loadFiles(files: Attachment[], progress: ImportProgress): AsyncGenerator<ImportFile> {
  for (const file of files) {
    const bytes = await file.entry.getData(new Uint8ArrayWriter());
    progress.bytesRead += file.entry.compressedSize;
    yield { filename: file.name, mime: guessContentType(file.name, bytes), bytes };
  }
}
