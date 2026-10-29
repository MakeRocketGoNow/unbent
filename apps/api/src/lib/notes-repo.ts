import type { ReadBy } from '@unbent/shared';
import type {
  FeedPage,
  FeedReset,
  FieldDef,
  FieldScale,
  FieldStyle,
  FieldType,
  FieldValue,
  Note,
  NoteFieldsPatch,
  NoteRevision,
  NoteRevisionSummary,
  NoteSummary,
  NotebookDefinition,
  NotebookView,
  OptionEdit,
  RestoredNote,
  NotebookSummary,
  SearchResult,
  SearchResultRow,
  SnapshotPage,
  StaleNote,
  UpdateView,
  ViewQuery,
} from '@unbent/shared';
import { StoreRepo } from './store-client.js';
import type { FileSummary } from '../store/attachments.js';
import type { PressLimits, UsageEntry } from '../store/llm-usage.js';
import type { WriteLimits } from '../store/user-store.js';
import type { CountOptions, ListOptions, SearchFilters } from '../store/notes.js';
import {
  keysOfDeletedNotes,
  nextCursor,
  SCOPE_DRIVEN_SEARCH_MAX,
  toFtsQuery,
  type ExportedNote,
} from '../store/notes-shared.js';

/**
 * The names the routes, the export and the MCP tools import from here, re-exported from
 * where they live: the pure helpers are in store/notes-shared.ts so the store builds its
 * queries from the same code, and nothing importing them had to move.
 */
export { keysOfDeletedNotes, nextCursor, toFtsQuery, type ExportedNote };
export type { CountOptions, FileSummary, ListOptions, SearchFilters };

/**
 * Where a repo asks what a write is held to (`WriteLimits`): the room the account's
 * store may take (MAK-234) and, while no plan holds, the free plan's limits; null for
 * none, or a promise of either. See the constructor below.
 */
export type WriteLimitsSource = () => WriteLimits | null | Promise<WriteLimits | null>;

/**
 * No limits, for a caller that only reads. A write made through a repo built with this
 * is unbounded whatever the plan says, which is the one way to get round the bounds by
 * accident: a new `reposFor` call that passes it and then writes is a review finding.
 */
export const noWriteLimits: WriteLimitsSource = () => null;

/**
 * All note access for one user, answered by that user's store.
 *
 * A facade over `NotesStore` (src/store/notes.ts): one RPC call per method, the same
 * signatures the routes, orchestrators and MCP tools were written against on the shared
 * database. The SQL, and the reasoning behind each query, live with the store; this
 * class is the seam that keeps the callers unaware of where the rows are.
 *
 * Isolation is structural, as it was: a repo is built by `reposFor` from the verified
 * session's user id and bound to that user's object, and no method takes a user id. The
 * object itself refuses a database that is not its user's on every wake.
 *
 * The composites at the end answer what one route asks in one call, where the routes
 * used to make two or three; see `UserStore`.
 */
export class NotesRepo extends StoreRepo {
  /**
   * What each write is held to: the room the account's store may take (MAK-234), as
   * `AttachmentsRepo.record` is given the quota on files, and the free plan's limits
   * while no plan holds. A source rather than a value because the plan row is on the
   * request's context where there is one (`withRepos`) and a database read where there
   * is not (the MCP endpoint), and the repo is built before either has been read.
   * Carried here so every route that writes is bounded without saying so, and a new one
   * cannot forget: the methods below that pass it are the ones `UserStore` takes a
   * limit on, and the two that do not, `appendFileLink` and the deletes, say why.
   */
  constructor(
    store: ConstructorParameters<typeof StoreRepo>[0],
    userId: string,
    private readonly limits: WriteLimitsSource,
  ) {
    super(store, userId);
  }

  /**
   * The search threshold, `SCOPE_DRIVEN_SEARCH_MAX`, on the instance so the live suite can
   * move it. Every notebook and tag the suite creates is under a hundred notes, so left
   * alone every filtered search there takes the scope-driven shape, and the FTS-driven one
   * (what production uses for any larger notebook) goes untested. The search route sets
   * this from a header, and only where `ALLOW_TEST_CREDENTIALS` is on; see `search.ts`.
   * Passed to the store with each search, so the object holds no state for it.
   */
  scopeDrivenSearchMax = SCOPE_DRIVEN_SEARCH_MAX;

  list(opts: ListOptions): Promise<NoteSummary[]> {
    return this.call((s) => s.list(opts));
  }

  listFull(opts: ListOptions): Promise<ExportedNote[]> {
    return this.call((s) => s.listFull(opts));
  }

  count(opts: CountOptions = {}): Promise<number> {
    return this.call((s) => s.count(opts));
  }

  recountNotes(): Promise<number> {
    return this.call((s) => s.recountNotes());
  }

  /** A live note, or a trashed one too with `includeTrashed`; see `NotesStore.get`. */
  get(id: string, opts?: { includeTrashed?: boolean }): Promise<Note | null> {
    return this.call((s) => s.get(id, opts));
  }

  /** The filenames a live note's body links, parsed in the object; see `NotesStore.linkedFilenames`. */
  linkedFilenames(id: string): Promise<string[] | null> {
    return this.call((s) => s.linkedFilenames(id));
  }

  create(input: {
    id: string;
    title: string;
    body: string;
    tags: string[];
    notebook?: string | null | undefined;
    fields?: NoteFieldsPatch | undefined;
  }): Promise<Note> {
    return this.call(async (s) => s.create(input, await this.limits()));
  }

  duplicate(id: string, newId: string): Promise<Note | null> {
    return this.call(async (s) => s.duplicate(id, newId, await this.limits()));
  }

  /** `create` for an id the client chose, which may be a replay's; see `NotesStore.createOrFind`. */
  createOrFind(input: Parameters<NotesRepo['create']>[0]): Promise<{ note: Note; existing: boolean }> {
    return this.call(async (s) => s.createOrFind(input, await this.limits()));
  }

  /** Many notes in one transaction, all or none; see `NotesStore.createMany`. */
  createMany(
    inputs: Array<Parameters<NotesRepo['create']>[0]>,
    opts: { skipExisting?: boolean | undefined } = {},
  ): Promise<Array<{ id: string; title: string; skipped: boolean }>> {
    return this.call(async (s) => s.createMany(inputs, opts, await this.limits()));
  }

  /** `duplicate` with the same replay rule for the copy's id. */
  duplicateOrFind(id: string, newId: string): Promise<{ note: Note; existing: boolean } | null> {
    return this.call(async (s) => s.duplicateOrFind(id, newId, await this.limits()));
  }

  update(
    id: string,
    patch: {
      title?: string | undefined;
      body?: string | undefined;
      tags?: string[] | undefined;
      notebook?: string | null | undefined;
      fields?: NoteFieldsPatch | undefined;
      ifUpdatedAt?: number | undefined;
      /** Set by the MCP tools: an assistant's write keeps what it replaces. See `NotesStore.update`. */
      by?: 'assistant' | undefined;
    },
  ): Promise<Note | StaleNote | null> {
    return this.call(async (s) => s.update(id, patch, await this.limits()));
  }

  /** A live note's history, newest first, without bodies; null when there is no such note. */
  listRevisions(id: string): Promise<NoteRevisionSummary[] | null> {
    return this.call((s) => s.listRevisions(id));
  }

  getRevision(id: string, revisionId: number): Promise<NoteRevision | null> {
    return this.call((s) => s.getRevision(id, revisionId));
  }

  /** Deletes a live note's whole history; how many copies went, or null for no such note. */
  clearRevisions(id: string): Promise<number | null> {
    return this.call((s) => s.clearRevisions(id));
  }

  /** Puts a copy back, keeping what it replaces; see `NotesStore.restoreRevision`. */
  restoreRevision(id: string, revisionId: number, ifUpdatedAt?: number): Promise<RestoredNote | StaleNote | null> {
    return this.call(async (s) => s.restoreRevision(id, revisionId, ifUpdatedAt, await this.limits()));
  }

  appendToBody(id: string, markdown: string): Promise<boolean> {
    return this.call(async (s) => s.appendToBody(id, markdown, await this.limits()));
  }

  /**
   * `appendToBody` for the link to a file that was just stored, which the store's limit
   * does not hold up: the file itself passed the quota a moment ago, the link is a line,
   * and a refusal here would leave the file recorded and the note not saying so. The
   * MCP `append` tool, which takes any text, goes through `appendToBody`.
   */
  appendFileLink(id: string, markdown: string): Promise<boolean> {
    return this.call((s) => s.appendToBody(id, markdown));
  }

  remove(id: string): Promise<boolean> {
    return this.call((s) => s.remove(id));
  }

  restore(id: string): Promise<boolean> {
    return this.call((s) => s.restore(id));
  }

  purgeOne(id: string): Promise<{ deleted: boolean; keys: string[] }> {
    return this.call((s) => s.purgeOne(id));
  }

  removeMany(ids: string[]): Promise<string[]> {
    return this.call((s) => s.removeMany(ids));
  }

  restoreMany(ids: string[]): Promise<string[]> {
    return this.call((s) => s.restoreMany(ids));
  }

  purgeMany(ids: string[]): Promise<{ deleted: number; keys: string[] }> {
    return this.call((s) => s.purgeMany(ids));
  }

  updateMany(
    ids: string[],
    patch: {
      notebook?: string | null | undefined;
      addTags?: string[] | undefined;
      removeTags?: string[] | undefined;
      fields?: NoteFieldsPatch | undefined;
      /** Who is writing, for the notes' history; see `NotesStore.updateMany`. */
      by?: 'assistant' | undefined;
    },
  ): Promise<{ matched: string[]; changed: string[] }> {
    return this.call(async (s) => s.updateMany(ids, patch, await this.limits()));
  }

  importNote(input: {
    id?: string | undefined;
    title: string;
    body: string;
    tags: string[];
    notebook?: string | undefined;
    createdAt: number;
    updatedAt: number;
    contentHash: string;
    sourceEnex?: string | undefined;
    fields?: Record<string, FieldValue> | undefined;
  }): Promise<{ id: string; created: boolean; skippedFields: string[] }> {
    return this.call(async (s) => s.importNote(input, await this.limits()));
  }

  setBody(id: string, body: string): Promise<void> {
    return this.call(async (s) => s.setBody(id, body, await this.limits()));
  }

  search(rawQuery: string, limit: number, filters: SearchFilters = {}): Promise<SearchResult[]> {
    const max = this.scopeDrivenSearchMax;
    return this.call((s) => s.search(rawQuery, limit, filters, max));
  }

  /** A search with a line per file of each match, for MCP; see `UserStore.searchWithFiles`. */
  searchWithFiles(
    rawQuery: string,
    limit: number,
    filters: SearchFilters = {},
    opts: { vision?: boolean } = {},
  ): Promise<{ results: SearchResult[]; summaries: Record<string, FileSummary[]> }> {
    const max = this.scopeDrivenSearchMax;
    return this.call((s) => s.searchWithFiles(rawQuery, limit, filters, max, opts));
  }

  /** A search with each match's list row, for a table; see `UserStore.searchRows`. */
  searchRows(rawQuery: string, limit: number, filters: SearchFilters = {}): Promise<SearchResultRow[]> {
    const max = this.scopeDrivenSearchMax;
    return this.call((s) => s.searchRows(rawQuery, limit, filters, max));
  }

  purge(scope: 'trashed' | 'all', limit?: number): Promise<{ notes: number; keys: string[]; remaining: number }> {
    return this.call((s) => s.purge(scope, limit));
  }

  listTags(): Promise<Array<{ id: string; name: string; count: number; color: number | null }>> {
    return this.call((s) => s.listTags());
  }

  /** The tags of one notebook's or tag's notes, counted within it; see `NotesStore.tagCounts`. */
  tagCounts(filter: {
    notebook?: string | undefined;
    tags?: string[] | undefined;
  }): Promise<Array<{ id: string; name: string; count: number }>> {
    return this.call((s) => s.tagCounts(filter));
  }

  /** One notebook by name, with its fields, or null; see `NotesStore.notebookByName`. */
  notebookByName(name: string): Promise<{ id: string; name: string; fields: FieldDef[] } | null> {
    return this.call((s) => s.notebookByName(name));
  }

  /** Where a set of notes is filed, and that notebook's fields when it is one; see `NotesStore.fieldTargets`. */
  fieldTargets(ids: string[]): Promise<{
    matched: string[];
    notebooks: Array<{ id: string | null; name: string | null; notes: number; example: string }>;
    fields: FieldDef[];
  }> {
    return this.call((s) => s.fieldTargets(ids));
  }

  sampleTitles(
    exclude: string,
    perGroup: number,
    tagLimit: number,
  ): Promise<{ notebooks: Map<string, string[]>; tags: Array<{ id: string; name: string; examples: string[] }> }> {
    return this.call((s) => s.sampleTitles(exclude, perGroup, tagLimit));
  }

  renameTag(
    id: string,
    name: string,
    opts?: { merge?: boolean | undefined },
  ): Promise<{ id: string; name: string; merged: boolean } | 'conflict' | 'missing'> {
    return this.call(async (s) => s.renameTag(id, name, opts, await this.limits()));
  }

  deleteTag(id: string): Promise<boolean> {
    return this.call((s) => s.deleteTag(id));
  }

  recolorTag(id: string, color: number): Promise<boolean> {
    return this.call(async (s) => s.recolorTag(id, color, await this.limits()));
  }

  countUnfiledNotes(): Promise<number> {
    return this.call((s) => s.countUnfiledNotes());
  }

  listNotebooks(): Promise<NotebookSummary[]> {
    return this.call((s) => s.listNotebooks());
  }

  createNotebook(name: string): Promise<{ id: string; name: string } | null> {
    return this.call(async (s) => s.createNotebook(name, await this.limits()));
  }

  updateNotebook(
    id: string,
    patch: { name?: string | undefined; purpose?: string | null | undefined; emoji?: string | null | undefined },
  ): Promise<'ok' | 'conflict' | 'missing'> {
    return this.call(async (s) => s.updateNotebook(id, patch, await this.limits()));
  }

  deleteNotebook(id: string, opts?: { trashNotes?: boolean | undefined }): Promise<boolean> {
    return this.call((s) => s.deleteNotebook(id, opts));
  }

  /** Every saved view of the account, by notebook in order (MAK-249). */
  listViews(): Promise<NotebookView[]> {
    return this.call((s) => s.listViews());
  }

  createView(notebookId: string, name: string, query: ViewQuery): Promise<NotebookView | 'conflict' | 'missing'> {
    return this.call(async (s) => s.createView(notebookId, name, query, await this.limits()));
  }

  updateView(id: string, patch: UpdateView): Promise<NotebookView | 'conflict' | 'missing'> {
    return this.call(async (s) => s.updateView(id, patch, await this.limits()));
  }

  deleteView(id: string): Promise<boolean> {
    return this.call((s) => s.deleteView(id));
  }

  listFields(notebookId: string, opts?: { counts?: boolean | undefined }): Promise<FieldDef[] | null> {
    return this.call((s) => s.listFields(notebookId, opts));
  }

  fieldById(id: string): Promise<FieldDef | null> {
    return this.call((s) => s.fieldById(id));
  }

  listAllFields(): Promise<FieldDef[]> {
    return this.call((s) => s.listAllFields());
  }

  createField(
    notebookId: string,
    input: {
      name: string;
      type: FieldType;
      options: string[];
      scale?: FieldScale | null | undefined;
      currency?: string | null | undefined;
      style?: FieldStyle | null | undefined;
    },
  ): Promise<FieldDef | 'missing' | 'conflict' | 'full'> {
    return this.call(async (s) => s.createField(notebookId, input, await this.limits()));
  }

  updateField(
    notebookId: string,
    fieldId: string,
    patch: {
      name?: string | undefined;
      type?: FieldType | undefined;
      options?: string[] | undefined;
      scale?: FieldScale | null | undefined;
      currency?: string | null | undefined;
      style?: FieldStyle | null | undefined;
    },
  ): Promise<{ field: FieldDef; cleared: number } | 'missing' | 'conflict'> {
    return this.call(async (s) => s.updateField(notebookId, fieldId, patch, await this.limits()));
  }

  previewConversion(
    notebookId: string,
    fieldId: string,
    to: FieldType,
    toScale?: FieldScale | null | 'fit' | undefined,
    toStyle?: FieldStyle | null | undefined,
  ): Promise<{ values: number; incompatible: number; scale: FieldScale | null } | null> {
    return this.call((s) => s.previewConversion(notebookId, fieldId, to, toScale, toStyle));
  }

  reorderFields(notebookId: string, ids: string[]): Promise<boolean> {
    return this.call(async (s) => s.reorderFields(notebookId, ids, await this.limits()));
  }

  deleteField(notebookId: string, fieldId: string): Promise<boolean> {
    return this.call((s) => s.deleteField(notebookId, fieldId));
  }

  countOptionUsage(notebookId: string, fieldId: string, option: string): Promise<number | null> {
    return this.call((s) => s.countOptionUsage(notebookId, fieldId, option));
  }

  removeFieldOption(
    notebookId: string,
    fieldId: string,
    option: string,
    clear: boolean,
  ): Promise<{ field: FieldDef; cleared: number } | null> {
    return this.call((s) => s.removeFieldOption(notebookId, fieldId, option, clear));
  }

  editFieldOptions(
    notebookId: string,
    fieldId: string,
    edit: OptionEdit,
    patch: { name?: string | undefined; currency?: string | null | undefined } = {},
  ): Promise<
    | {
        field: FieldDef;
        renamed: Array<{ from: string; to: string; notes: number }>;
        removed: Array<{ option: string; notes: number }>;
        added: string[];
      }
    | 'missing'
    | 'conflict'
    | { refused: string; merge?: true }
  > {
    return this.call(async (s) => s.editFieldOptions(notebookId, fieldId, edit, patch, await this.limits()));
  }

  importNotebook(
    definition: NotebookDefinition,
    opts: { create?: boolean } = {},
  ): Promise<
    | {
        id: string;
        skipped: Array<{ name: string; reason: string; kind?: 'emoji' | 'purpose' }>;
      }
    | 'conflict'
  > {
    return this.call(async (s) => s.importNotebook(definition, opts, await this.limits()));
  }

  // --- Composites ----------------------------------------------------------------------

  /**
   * `GET /notes`: the page and, when `count` is given, the total, in one call; with
   * `summaries`, a line per file of each note too (`UserStore.listPage`).
   */
  listPage(
    list: ListOptions,
    count: CountOptions | null,
    opts: { summaries?: boolean; vision?: boolean } = {},
  ): Promise<{ items: NoteSummary[]; total: number | null; summaries?: Record<string, FileSummary[]> }> {
    return this.call((s) => s.listPage(list, count, opts));
  }

  /**
   * `GET /export/notes`: whole notes, the texts held for their files, the total and the
   * cursor to continue from, in one call. The store computes the cursor because it can
   * cut the page short on bytes; see `UserStore.exportPage`.
   */
  exportPage(list: ListOptions, count: CountOptions | null): Promise<{
    notes: ExportedNote[];
    total: number | null;
    texts: Array<{ noteId: string; filename: string; text: string; readBy: ReadBy | null }>;
    cursor: string | null;
  }> {
    return this.call((s) => s.exportPage(list, count));
  }

  /** A note with its files, for MCP's `get_note`. Null when there is no such live note. */
  getWithFiles(id: string, opts: { vision?: boolean } = {}): Promise<{ note: Note; files: FileSummary[] } | null> {
    return this.call((s) => s.getWithFiles(id, opts));
  }

  /** `GET /changes`: what changed after `since`, whole, or `reset`; see `UserStore.changesSince`. */
  changesSince(since: number, limit: number, epoch?: string): Promise<FeedPage | FeedReset> {
    // Awaited and named: the stub types a union return as an intersection of promise
    // shapes that does not assign to the plain union, although the value is one.
    return this.call(async (s) => (await s.changesSince(since, limit, epoch)) as FeedPage | FeedReset);
  }

  /** `GET /changes/snapshot`: a page of the whole library by note id; see `UserStore.snapshotPage`. */
  snapshotPage(cursor: string | null, limit: number): Promise<SnapshotPage> {
    return this.call((s) => s.snapshotPage(cursor, limit));
  }

  /** The notebooks, the unfiled count, and every field when asked, in one call. */
  notebooksOverview(opts: { fields?: boolean | undefined } = {}): Promise<{ notebooks: NotebookSummary[]; unfiled: number; fields?: FieldDef[] }> {
    return this.call((s) => s.notebooksOverview(opts));
  }

  /**
   * The first half of auto-fill: the note and its own unread files, and with `press` the
   * press counted against the day's cap. Null when there is no such live note.
   */
  autofillPrelude(id: string, ownFilesToRead: number, press?: PressLimits) {
    // The press passes no limits when Auto-fill is not set up on the instance, and that
    // answer comes first: a store with no room is not what stops such a press.
    return this.call(async (s) => s.autofillPrelude(id, ownFilesToRead, press, press === undefined ? null : await this.limits()));
  }

  /** What a press cost beyond its files' readings; see `UserStore.recordLlmUsage`. */
  recordLlmUsage(entries: UsageEntry[]): Promise<void> {
    return this.call((s) => s.recordLlmUsage(entries));
  }

  /** This calendar year's presses and tokens. */
  autofillUsage() {
    return this.call((s) => s.autofillUsage());
  }

  /** The second half: everything the model is shown beside the note. */
  autofillContext(id: string, perGroup: number, tagLimit: number) {
    return this.call((s) => s.autofillContext(id, perGroup, tagLimit));
  }
}
