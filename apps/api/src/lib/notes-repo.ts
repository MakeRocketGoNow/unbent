import type {
  FieldDef,
  FieldScale,
  FieldType,
  FieldValue,
  Note,
  NoteFieldsPatch,
  NoteSummary,
  NotebookDefinition,
  NotebookSummary,
  SearchResult,
} from '@unbent/shared';
import { StoreRepo } from './store-client.js';
import type { AttachmentInfo } from '@unbent/shared';
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
export type { CountOptions, ListOptions, SearchFilters };

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
   * The search threshold, `SCOPE_DRIVEN_SEARCH_MAX`, on the instance so the live suite can
   * move it. Every notebook and tag the suite creates is under a hundred notes, so left
   * alone every filtered search there takes the scope-driven shape, and the FTS-driven one
   * — what production uses for any larger notebook — goes untested. The search route sets
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

  get(id: string): Promise<Note | null> {
    return this.call((s) => s.get(id));
  }

  create(input: {
    id: string;
    title: string;
    body: string;
    tags: string[];
    notebook?: string | null | undefined;
    fields?: NoteFieldsPatch | undefined;
  }): Promise<Note> {
    return this.call((s) => s.create(input));
  }

  duplicate(id: string, newId: string): Promise<Note | null> {
    return this.call((s) => s.duplicate(id, newId));
  }

  update(
    id: string,
    patch: {
      title?: string | undefined;
      body?: string | undefined;
      tags?: string[] | undefined;
      notebook?: string | null | undefined;
      fields?: NoteFieldsPatch | undefined;
    },
  ): Promise<Note | null> {
    return this.call((s) => s.update(id, patch));
  }

  appendToBody(id: string, markdown: string): Promise<boolean> {
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
    patch: { notebook?: string | null | undefined; addTags?: string[] | undefined; removeTags?: string[] | undefined },
  ): Promise<{ matched: string[]; changed: string[] }> {
    return this.call((s) => s.updateMany(ids, patch));
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
    return this.call((s) => s.importNote(input));
  }

  setBody(id: string, body: string): Promise<void> {
    return this.call((s) => s.setBody(id, body));
  }

  search(rawQuery: string, limit: number, filters: SearchFilters = {}): Promise<SearchResult[]> {
    const max = this.scopeDrivenSearchMax;
    return this.call((s) => s.search(rawQuery, limit, filters, max));
  }

  purge(scope: 'trashed' | 'all', limit?: number): Promise<{ notes: number; keys: string[]; remaining: number }> {
    return this.call((s) => s.purge(scope, limit));
  }

  listTags(): Promise<Array<{ id: string; name: string; count: number }>> {
    return this.call((s) => s.listTags());
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
    return this.call(async (s) => s.renameTag(id, name, opts));
  }

  deleteTag(id: string): Promise<boolean> {
    return this.call((s) => s.deleteTag(id));
  }

  countUnfiledNotes(): Promise<number> {
    return this.call((s) => s.countUnfiledNotes());
  }

  listNotebooks(): Promise<NotebookSummary[]> {
    return this.call((s) => s.listNotebooks());
  }

  createNotebook(name: string): Promise<{ id: string; name: string } | null> {
    return this.call((s) => s.createNotebook(name));
  }

  updateNotebook(
    id: string,
    patch: { name?: string | undefined; purpose?: string | null | undefined; emoji?: string | null | undefined },
  ): Promise<'ok' | 'conflict' | 'missing'> {
    return this.call((s) => s.updateNotebook(id, patch));
  }

  deleteNotebook(id: string, opts?: { trashNotes?: boolean | undefined }): Promise<boolean> {
    return this.call((s) => s.deleteNotebook(id, opts));
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
    input: { name: string; type: FieldType; options: string[]; scale?: FieldScale | null | undefined; currency?: string | null | undefined },
  ): Promise<FieldDef | 'missing' | 'conflict' | 'full'> {
    return this.call(async (s) => s.createField(notebookId, input));
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
    },
  ): Promise<{ field: FieldDef; cleared: number } | 'missing' | 'conflict'> {
    return this.call(async (s) => s.updateField(notebookId, fieldId, patch));
  }

  previewConversion(
    notebookId: string,
    fieldId: string,
    to: FieldType,
    toScale?: FieldScale | null | undefined,
  ): Promise<{ values: number; incompatible: number } | null> {
    return this.call((s) => s.previewConversion(notebookId, fieldId, to, toScale));
  }

  reorderFields(notebookId: string, ids: string[]): Promise<boolean> {
    return this.call((s) => s.reorderFields(notebookId, ids));
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

  importNotebook(definition: NotebookDefinition): Promise<{
    id: string;
    skipped: Array<{ name: string; reason: string; kind?: 'emoji' | 'purpose' }>;
  }> {
    return this.call((s) => s.importNotebook(definition));
  }

  // --- Composites ----------------------------------------------------------------------

  /** `GET /notes`: the page and, when `count` is given, the total, in one call. */
  listPage(list: ListOptions, count: CountOptions | null): Promise<{ items: NoteSummary[]; total: number | null }> {
    return this.call((s) => s.listPage(list, count));
  }

  /**
   * `GET /export/notes`: whole notes, the texts held for their files, the total and the
   * cursor to continue from, in one call. The store computes the cursor because it can
   * cut the page short on bytes; see `UserStore.exportPage`.
   */
  exportPage(list: ListOptions, count: CountOptions | null): Promise<{
    notes: ExportedNote[];
    total: number | null;
    texts: Array<{ noteId: string; filename: string; text: string; readBy: 'vision' | null }>;
    cursor: string | null;
  }> {
    return this.call((s) => s.exportPage(list, count));
  }

  /** A note with its files, for MCP's `get_note`. Null when there is no such live note. */
  getWithFiles(id: string): Promise<{ note: Note; files: AttachmentInfo[] } | null> {
    return this.call((s) => s.getWithFiles(id));
  }

  /** The notebooks, the unfiled count, and every field when asked, in one call. */
  notebooksOverview(opts: { fields?: boolean | undefined } = {}): Promise<{ notebooks: NotebookSummary[]; unfiled: number; fields?: FieldDef[] }> {
    return this.call((s) => s.notebooksOverview(opts));
  }

  /** The first half of auto-fill: the note and its own unread files. Null when there is no such live note. */
  autofillPrelude(id: string, ownFilesToRead: number) {
    return this.call((s) => s.autofillPrelude(id, ownFilesToRead));
  }

  /** The second half: everything the model is shown beside the note. */
  autofillContext(id: string, perGroup: number, tagLimit: number) {
    return this.call((s) => s.autofillContext(id, perGroup, tagLimit));
  }
}
