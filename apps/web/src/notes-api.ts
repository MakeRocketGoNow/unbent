import { DEFAULT_NOTE_SORT } from '@unbent/shared';
import type {
  AppConfig,
  AttachmentInfo,
  AutofillSuggestion,
  AutofillUsage,
  ExportFilter,
  ExportPage,
  FieldDef,
  FieldScale,
  FieldType,
  Note,
  NoteFieldsPatch,
  NoteRevision,
  NoteRevisionSummary,
  NoteSort,
  NoteSummary,
  NotebookDefinition,
  NotebookSummary,
  RestoredNote,
  SearchResult,
  SearchResultRow,
  AccountDumps,
  BackupsStatus,
  OperatorAccount,
  OperatorAccountsPage,
  StoreRestores,
} from '@unbent/shared';
import { OPERATOR_PAGE_SIZE } from '@unbent/shared';
import { offlineNow, recheck } from './connectivity.js';
import { SERVED_HEADER } from './sw/routes.js';

/**
 * Thin fetch wrappers over the notes API. Same-origin, so cookies travel automatically.
 *
 * These are hand-written rather than routed through hc<AppType>() because the Hono client
 * infers `unknown` for these response bodies once zValidator is in play; the shared Note
 * types are the contract either way.
 */

/**
 * An API call that returned a non-2xx status.
 *
 * Carries the status as a number so callers can branch on it. The previous shape put the
 * status only in the message, which left the 404 check reading
 * `err.message.startsWith('404')` — a body beginning with a digit or a reworded message
 * would have silently changed which branch ran.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True when `err` is an ApiError with the given status. */
export function isStatus(err: unknown, status: number): boolean {
  return err instanceof ApiError && err.status === status;
}

/**
 * A request that got no answer from the server: no connection, or one that carried
 * nothing for as long as the call was allowed to wait.
 *
 * An `ApiError` with status 0, so everything that already branches on `ApiError` keeps
 * working, but its own class so the offline states can be told from real failures:
 * "Couldn't load that note" in red is the wrong thing to say about a note that simply
 * was never opened on this device.
 */
export class OfflineError extends ApiError {
  constructor() {
    super(0, "You're offline.");
    this.name = 'OfflineError';
  }
}

export function isOfflineError(err: unknown): err is OfflineError {
  return err instanceof OfflineError;
}

/**
 * Every call below goes through this rather than `fetch`, so there is one place that
 * notices the connection may have changed.
 *
 * A fetch that rejects before any answer becomes an `OfflineError`. That, an answer the
 * service worker served from its cache because the network failed (`X-Unbent-Served:
 * cache`), and any answer while the app believes it is offline all ask the connectivity
 * store to check the server (`recheck`) — none of them decides by itself, since a kept
 * file answers with no network and a slow save fails with one (see `connectivity.ts`).
 * The caller's own abort is passed through untouched — the editor cancels uploads, and
 * that is not a lost connection.
 *
 * A write made while the store already says offline fails at once rather than waiting on
 * a socket: the banner has already said changes can't be saved. A read still goes out,
 * because the worker may hold its answer.
 *
 * `timeout` is for the autosave, which must not hang: on a connection that is up and
 * carries nothing, a save with no answer used to leave the editor accepting typing for
 * minutes. After it the save fails, and the check decides whether the editor locks.
 */
export async function request(input: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout, signal: callerSignal, ...rest } = init;
  if ((rest.method ?? 'GET').toUpperCase() !== 'GET' && offlineNow()) throw new OfflineError();

  const controller = timeout ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : undefined;
  if (controller && callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const signal = controller?.signal ?? callerSignal;

  let res: Response;
  try {
    res = await fetch(input, { ...rest, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (callerSignal?.aborted) throw err;
    recheck();
    throw new OfflineError();
  } finally {
    clearTimeout(timer);
  }
  if (res.headers.get(SERVED_HEADER) === 'cache' || offlineNow()) recheck();
  return res;
}

/** How much of an error body is worth repeating; the rest is never the useful part. */
const MAX_DETAIL = 200;

/**
 * The message for a failed response, quoting the body only when the body says something.
 *
 * A request that never reached the Worker is answered by the edge instead, with its own
 * HTML error page — and the first 200 characters of that page are the IE conditional
 * comments of 2009, not what went wrong. An ENEX import repeats this message once per
 * note, so a run that outlived its Worker produced dozens of lines of `<!--[if lt IE 7]>`
 * and nothing a reader could act on. Naming the case is what makes it legible.
 */
export async function httpErrorMessage(res: Response): Promise<string> {
  // HTTP/2 has no reason phrase, so `statusText` is routinely empty and must not be padded in.
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  const body = (await res.text().catch(() => '')).trim();
  if (!body) return status;

  // Ours are `{ error }`. A JSON body shaped some other way falls through and is quoted raw.
  if (res.headers.get('Content-Type')?.includes('json')) {
    try {
      const { error } = JSON.parse(body) as { error?: unknown };
      if (typeof error === 'string' && error) return `${status}: ${error}`;
    } catch {
      // Mislabelled as JSON; treat it as text like anything else.
    }
  }

  if (body.startsWith('<')) {
    return `${status} — the request did not reach the API; an error page came back instead`;
  }

  return `${status}: ${body.slice(0, MAX_DETAIL)}`;
}

/**
 * An error's message as a sentence to show: `httpErrorMessage`'s without the status it
 * leads with. "503 Service Unavailable: The server is busy" is right in a log and wrong
 * in a snackbar, and the route's own sentence is the part written to be read. Here, beside
 * the function that builds that shape, so the two change together; an error that is not
 * one of ours comes back as it is.
 */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^\d{3}[^:]*: /, '');
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
  return res.json() as Promise<T>;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export interface NotePage {
  items: NoteSummary[];
  /** Pass back as `cursor` to fetch the next page; null when there are no more. */
  cursor: string | null;
  /** Live notes matching the filter. Only returned for the first page. */
  total: number | null;
}

export async function listNotes(
  opts: {
    tag?: string[];
    notebook?: string;
    field?: string[];
    cursor?: string;
    trashed?: boolean;
    limit?: number;
    sort?: NoteSort;
    order?: 'asc' | 'desc';
    sortField?: string;
    from?: string;
    to?: string;
    /** Count `total` from the notes rather than read the stored count; see `exactCountQuery`. */
    exact?: boolean;
  } = {},
): Promise<NotePage> {
  const params = new URLSearchParams();
  // Repeated rather than joined: a tag name may contain any delimiter we'd pick.
  for (const t of opts.tag ?? []) params.append('tag', t);
  if (opts.notebook) params.set('notebook', opts.notebook);
  for (const f of opts.field ?? []) params.append('field', f);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.order) params.set('order', opts.order);
  if (opts.sortField) params.set('sortField', opts.sortField);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.trashed) params.set('trashed', '1');
  if (opts.exact) params.set('exact', '1');
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return json<NotePage>(await request(`/api/notes${qs ? `?${qs}` : ''}`));
}

export async function getNote(id: string): Promise<Note> {
  return json<Note>(await request(`/api/notes/${id}`));
}

export async function createNote(input: {
  /** An id chosen here, so a note made offline has its address; see `createNoteSchema.id`. */
  id?: string;
  title?: string;
  body?: string;
  tags?: string[];
  notebook?: string | null;
  fields?: NoteFieldsPatch;
}): Promise<Note> {
  return json<Note>(
    await request('/api/notes', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),
  );
}

/** How long a save may go unanswered before it counts as offline. */
export const SAVE_TIMEOUT = 10_000;

/**
 * A save refused because the note was saved somewhere else after the copy it was made
 * from — the 409 `updateNote` gets for a stale `ifUpdatedAt`. Carries the note as it now
 * stands, so the editor can offer it without reading it again.
 *
 * An `ApiError`, so code that only asks "did the save fail" still sees a failure; its own
 * class because the editor must not treat it as one to retry. Retrying would only be
 * refused again, and retrying without the precondition is the overwrite this exists to stop.
 */
export class NoteChangedError extends ApiError {
  constructor(readonly current: Note) {
    super(409, 'This note changed on another device.');
    this.name = 'NoteChangedError';
  }
}

export function isNoteChanged(err: unknown): err is NoteChangedError {
  return err instanceof NoteChangedError;
}

export async function updateNote(
  id: string,
  patch: {
    title?: string;
    body?: string;
    tags?: string[];
    notebook?: string | null;
    /** Merged: only the ids given change, and null clears one. */
    fields?: NoteFieldsPatch;
    /**
     * The `updatedAt` of the copy this patch was made from. The save is refused with a
     * `NoteChangedError` when the note has been saved since; see `updateNoteSchema`.
     */
    ifUpdatedAt?: number;
  },
): Promise<Note> {
  const res = await request(`/api/notes/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(patch),
    // The autosave: see `request` for why it must not hang.
    timeout: SAVE_TIMEOUT,
  });
  await throwIfStale(res);
  return json<Note>(res);
}

/**
 * A 409 carrying `stale` is a refused precondition, the same for a save and for a
 * restore, so the two cannot drift apart in how they read one. Anything else falls
 * through to `json`.
 */
async function throwIfStale(res: Response): Promise<void> {
  if (res.status !== 409) return;
  // A clone, so a 409 without a note in it still reaches `json` with its body unread.
  const body = (await res.clone().json().catch(() => null)) as { stale?: Note } | null;
  if (body?.stale) throw new NoteChangedError(body.stale);
}

/**
 * What the model would file a note as. Nothing is written; the editor applies what it
 * wants of the answer — see `planAutofill`. The 422 for a note with nothing to read yet
 * and the 503 for an instance with no key each carry a sentence meant to be shown as is.
 */
export async function autofillNote(id: string): Promise<AutofillSuggestion> {
  return json<AutofillSuggestion>(
    await request(`/api/notes/${encodeURIComponent(id)}/autofill`, { method: 'POST' }),
  );
}

/** The account's Auto-fill this calendar year: presses, the day's cap, and the model's tokens. */
export async function autofillUsage(): Promise<AutofillUsage> {
  return json<AutofillUsage>(await request('/api/autofill/usage'));
}

/** A new note with this one's title, body, filing and files, under `copyId` when given. */
export async function duplicateNote(id: string, copyId?: string): Promise<Note> {
  return json<Note>(
    await request(`/api/notes/${encodeURIComponent(id)}/duplicate`, {
      method: 'POST',
      ...(copyId ? { headers: jsonHeaders, body: JSON.stringify({ id: copyId }) } : {}),
    }),
  );
}

/**
 * A note's history: the copies the server kept of what a write replaced, newest first,
 * without their bodies. Only ever from the server — history is not in the local copy of
 * the library — so offline this is an `OfflineError` like any other request.
 */
export async function listRevisions(noteId: string): Promise<NoteRevisionSummary[]> {
  const res = await request(`/api/notes/${encodeURIComponent(noteId)}/revisions`);
  return (await json<{ revisions: NoteRevisionSummary[] }>(res)).revisions;
}

/** Deletes a note's whole history, for good; how many versions went. The note is not changed. */
export async function clearRevisions(noteId: string): Promise<number> {
  const res = await request(`/api/notes/${encodeURIComponent(noteId)}/revisions`, { method: 'DELETE' });
  return (await json<{ cleared: number }>(res)).cleared;
}

/** One copy from a note's history, with its body. */
export async function getRevision(noteId: string, revisionId: number): Promise<NoteRevision> {
  return json<NoteRevision>(await request(`/api/notes/${encodeURIComponent(noteId)}/revisions/${revisionId}`));
}

/**
 * Puts a copy back as the note's title and body: the note as it then stands, and `kept`,
 * the id of the copy the server kept of what was replaced — null when the version was
 * already what the note said, and nothing happened. With `ifUpdatedAt`, only if the note
 * still carries that date: a `NoteChangedError` otherwise, as a save's precondition gives.
 */
export async function restoreRevision(noteId: string, revisionId: number, opts: { ifUpdatedAt?: number } = {}): Promise<RestoredNote> {
  const res = await request(`/api/notes/${encodeURIComponent(noteId)}/revisions/${revisionId}/restore`, {
    method: 'POST',
    ...(opts.ifUpdatedAt !== undefined ? { headers: jsonHeaders, body: JSON.stringify(opts) } : {}),
  });
  await throwIfStale(res);
  return json<RestoredNote>(res);
}

/**
 * Moves a note to the trash.
 *
 * A refusal is an `ApiError`, as `json` makes it for every other call here, and for the
 * same reader: the outbox tells a note already trashed (404) from a request worth sending
 * again by the status (`gone` in `store/actions.ts`). This threw a bare `Error`, so a
 * trash replayed after its first send had landed was kept and retried for good, and every
 * write queued behind it waited with it.
 */
export async function deleteNote(id: string): Promise<void> {
  const res = await request(`/api/notes/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

/** Restores a trashed note. */
export async function restoreNote(id: string): Promise<Note> {
  return json<Note>(await request(`/api/notes/${id}/restore`, { method: 'POST' }));
}

/**
 * Permanently deletes one trashed note and its attachments. Irreversible. An `ApiError`
 * when refused, for the reason `deleteNote` gives.
 */
export async function deleteNotePermanently(id: string): Promise<void> {
  const res = await request(`/api/notes/${id}/permanent`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

/*
   Several notes at once — the list's selection. Each answers with a count, not the notes;
   the caller refetches the list, which is where the notes are read from anyway.
*/

/**
 * Refiles several notes: into a notebook (null for none), and with tags added or taken
 * away. `matched` is how many ids were live notes of this user's; `changed` how many were
 * actually written — a note already filed there, or already carrying the tag, keeps its date.
 */
export async function updateNotes(
  ids: string[],
  patch: { notebook?: string | null; addTags?: string[]; removeTags?: string[] },
): Promise<{ matched: number; changed: number }> {
  return json(
    await request('/api/notes', {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ ids, ...patch }),
    }),
  );
}

/** Moves several notes to the trash. */
export async function deleteNotes(ids: string[]): Promise<{ trashed: number }> {
  return json(
    await request('/api/notes/trash', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ids }),
    }),
  );
}

/** Restores several trashed notes. */
export async function restoreNotes(ids: string[]): Promise<{ restored: number }> {
  return json(
    await request('/api/notes/restore', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ids }),
    }),
  );
}

/** Permanently deletes several trashed notes and their attachments. Irreversible. */
export async function deleteNotesPermanently(ids: string[]): Promise<{ deleted: number }> {
  return json(
    await request('/api/notes/purge', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ids }),
    }),
  );
}

/**
 * How this instance can be signed in to. Public, so it works before there is a session;
 * the login screen is what asks.
 */
export async function getConfig(): Promise<AppConfig> {
  return json<AppConfig>(await request('/api/config'));
}

/**
 * Records that the signed-in account agreed to this version of the terms and privacy
 * policy (MAK-209). A 409 means the instance publishes a newer version than the one shown;
 * the caller reloads the config and shows that instead. The answer replaces the session
 * cookie, so the next read of the session carries the new version.
 */
export async function agreeToLegal(version: string): Promise<void> {
  await json(
    await request('/api/legal/agree', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ version }),
    }),
  );
}

/** A tag as the list reports it: its id, which a rename addresses, and how many live notes carry it. */
export interface TagSummary {
  id: string;
  name: string;
  count: number;
}

export async function listTags(): Promise<TagSummary[]> {
  const { tags } = await json<{ tags: TagSummary[] }>(await request('/api/tags'));
  return tags;
}

/**
 * The server refused because the name is taken.
 *
 * Its own class rather than a message, because the tag editor acts on it: a rename that
 * collides is an offer to merge, and the editor has to tell that refusal from a network
 * failure to make the offer.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Renames a tag; every note carrying it follows. Throws `ConflictError` when another tag
 * has the name, unless `merge` is set, which folds this tag into that one.
 */
export async function renameTag(
  id: string,
  name: string,
  opts?: { merge?: boolean },
): Promise<{ id: string; name: string; merged: boolean }> {
  const res = await request(`/api/tags/${id}${opts?.merge ? '?merge=1' : ''}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) throw new ConflictError('A tag with that name already exists.');
  return json(res);
}

/** Takes the tag off every note that carries it. The notes stay. */
export async function deleteTag(id: string): Promise<void> {
  const res = await request(`/api/tags/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await httpErrorMessage(res));
}

export type Notebook = NotebookSummary;

/** The notebook list plus how many notes sit outside every notebook. */
export interface NotebookList {
  notebooks: Notebook[];
  unfiled: number;
}

export async function listNotebooks(): Promise<NotebookList> {
  return json<NotebookList>(await request('/api/notebooks'));
}

/** Creates an empty notebook. Throws with a readable message when the name is taken. */
export async function createNotebook(name: string): Promise<{ id: string; name: string }> {
  const res = await request('/api/notebooks', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) throw new Error('A notebook with that name already exists.');
  return json(res);
}

/**
 * Changes a notebook's name, purpose and/or emoji. Any key may be omitted to leave it
 * untouched; `purpose: null` or `emoji: null` clears it. The route answers 204, so nothing
 * is parsed on success.
 */
export async function updateNotebook(
  id: string,
  patch: { name?: string; purpose?: string | null; emoji?: string | null },
): Promise<void> {
  const res = await request(`/api/notebooks/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (res.status === 409) throw new Error('A notebook with that name already exists.');
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

export async function renameNotebook(id: string, name: string): Promise<void> {
  await updateNotebook(id, { name });
}

/** What applying a notebook definition could not do, by field; see `importNotebook` on the server. */
export type NotebookImportSkip = { name: string; reason: string; kind?: 'emoji' | 'purpose' };

/**
 * Applies a notebook definition — a template's, here — through the archive import's own
 * endpoint. `create` makes a new notebook or answers `'taken'` with nothing written;
 * without it the definition is added to a notebook of that name, which is what the
 * chooser's "Add these fields to …" asks for by name.
 */
export async function importNotebook(
  definition: NotebookDefinition,
  { create }: { create: boolean },
): Promise<{ id: string; skipped: NotebookImportSkip[] } | 'taken'> {
  const res = await request(`/api/import/notebook${create ? '?create=1' : ''}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(definition),
  });
  if (res.status === 409) return 'taken';
  return json(res);
}

/**
 * Deletes a notebook. By default its notes survive, unfiled.
 * Pass `trashNotes: true` to soft-delete those notes into the trash as well.
 */
export async function deleteNotebook(
  id: string,
  opts?: { trashNotes?: boolean },
): Promise<void> {
  const params = new URLSearchParams();
  if (opts?.trashNotes) params.set('trashNotes', '1');
  const qs = params.toString();
  const res = await request(`/api/notebooks/${id}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

// --- Custom fields ---------------------------------------------------------------------

export async function listNotebookFields(
  notebookId: string,
  { counts = false }: { counts?: boolean } = {},
): Promise<FieldDef[]> {
  const { fields } = await json<{ fields: FieldDef[] }>(
    await request(`/api/notebooks/${notebookId}/fields${counts ? '?counts=1' : ''}`),
  );
  return fields;
}

/** Adds a field. Throws with a readable message when the name is taken. */
export async function createNotebookField(
  notebookId: string,
  input: {
    name: string;
    type: FieldType;
    options: string[];
    scale?: FieldScale | null;
    currency?: string | null;
  },
): Promise<FieldDef> {
  const res = await request(`/api/notebooks/${notebookId}/fields`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (res.status === 409) throw new Error('This notebook already has a field with that name.');
  return json(res);
}

/**
 * Renames, retypes, or re-options a field. A type change reports how many values it had
 * to clear; ask `previewFieldConversion` first to name that number before committing.
 */
export async function updateNotebookField(
  notebookId: string,
  fieldId: string,
  patch: {
    name?: string;
    type?: FieldType;
    options?: string[];
    scale?: FieldScale | null;
    currency?: string | null;
  },
): Promise<{ field: FieldDef; cleared: number }> {
  const res = await request(`/api/notebooks/${notebookId}/fields/${fieldId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (res.status === 409) throw new Error('This notebook already has a field with that name.');
  return json(res);
}

export async function previewFieldConversion(
  notebookId: string,
  fieldId: string,
  type: FieldType,
  scale?: FieldScale | null | 'fit',
): Promise<{ values: number; incompatible: number; scale: FieldScale | null }> {
  const query = new URLSearchParams({ type });
  // Absent means "whatever the field has now", which is what the repo assumes; an
  // explicit empty scale is how a rating becoming a plain number asks for the count, and
  // `fit` asks the server to pick the scale the values suggest and name it in the answer.
  if (scale !== undefined) {
    query.set('scale', scale === 'fit' ? 'fit' : scale ? `${scale.max}:${scale.step}` : '');
  }
  return json(
    await request(`/api/notebooks/${notebookId}/fields/${fieldId}/conversion?${query}`),
  );
}

/** Sets the order. `ids` must be every field of the notebook, each once. */
export async function reorderNotebookFields(notebookId: string, ids: string[]): Promise<void> {
  const res = await request(`/api/notebooks/${notebookId}/fields/order`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

/** Deletes a field and every value under it. */
export async function deleteNotebookField(notebookId: string, fieldId: string): Promise<void> {
  const res = await request(`/api/notebooks/${notebookId}/fields/${fieldId}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

/** How many notes still hold a select/multi-select option — the number a removal confirms. */
export async function countOptionUsage(
  notebookId: string,
  fieldId: string,
  option: string,
): Promise<number> {
  const query = new URLSearchParams({ option });
  const { notes } = await json<{ notes: number }>(
    await request(`/api/notebooks/${notebookId}/fields/${fieldId}/option-usage?${query}`),
  );
  return notes;
}

/**
 * Removes one option from a select or multi-select. `clear` also takes it off the notes
 * that held it; left off, those notes keep the value as "(no longer an option)". Returns
 * how many notes were cleared.
 */
export async function removeNotebookFieldOption(
  notebookId: string,
  fieldId: string,
  option: string,
  clear: boolean,
): Promise<{ field: FieldDef; cleared: number }> {
  const query = new URLSearchParams({ option, ...(clear ? { clear: '1' } : {}) });
  return json(
    await request(`/api/notebooks/${notebookId}/fields/${fieldId}/option?${query}`, {
      method: 'DELETE',
    }),
  );
}

export interface UploadedFile {
  filename: string;
  contentType: string;
  size: number;
  /** Relative path to insert into the markdown, e.g. `files/diagram.png`. */
  path: string;
  /**
   * Who is extracting the file's text for search: the server, in the background, or
   * nobody yet, in which case the client that has the bytes should. Absent from a server
   * older than the field, which means the same as `client`.
   */
  indexing?: 'server' | 'client';
}

/**
 * Uploads one file to a note. The body is sent as a raw stream rather than multipart so
 * the Worker can pipe it straight into R2 without buffering.
 */
export async function uploadFile(
  noteId: string,
  file: File,
  /**
   * `id`: the id the file should have, for an upload made from the outbox, which may be
   * sent twice — the server answers a second one with the file the first one made.
   */
  opts: { signal?: AbortSignal; id?: string } = {},
): Promise<UploadedFile> {
  const res = await request(`/api/notes/${noteId}/files`, {
    method: 'PUT',
    headers: {
      'X-Filename': encodeURIComponent(file.name),
      'Content-Type': file.type || 'application/octet-stream',
      ...(opts.id ? { 'X-Attachment-Id': opts.id } : {}),
    },
    body: file,
    // The editor aborts an upload the user walked away from; see editor/attach.ts.
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let message = detail || `${res.status}`;
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? message;
    } catch {
      // Not JSON: the edge's own error page, say. The text is the message.
    }
    // With the status, so the outbox can tell a refusal from a server that is down.
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<UploadedFile>;
}

/**
 * URL that downloads one note as a file.
 *
 * A URL rather than a fetch wrapper on purpose: this is meant for an anchor's href, so
 * the browser streams the response straight to disk. Reading it into JS first would
 * buffer a note's whole attachment payload in memory — the thing the streaming export was
 * built to avoid — and would lose Save-Link-As and middle-click besides.
 *
 * What arrives is a `.md` for a note with no attachments and a `.zip` of its folder when
 * it has them; the server decides and names the file in Content-Disposition.
 */
export function noteDownloadUrl(noteId: string): string {
  return `/api/notes/${encodeURIComponent(noteId)}/export`;
}

/** Attachment metadata for one note — includes files no longer linked in the body. */
export async function listAttachments(noteId: string): Promise<AttachmentInfo[]> {
  const { files } = await json<{ files: AttachmentInfo[] }>(
    await request(`/api/notes/${noteId}/files`),
  );
  return files;
}

/** A web image fetched into a note by the server; `url` is the address it came from. */
export interface FetchedWebImage extends AttachmentInfo {
  path: string;
  url: string;
}

/**
 * Asks the server to fetch a picture off the web and store it on the note. The server
 * fetches because the browser cannot read a cross-origin image; see the route for the
 * address policy. Rejections carry a reason worth showing: not an image, too large, the
 * site refused.
 */
export async function fetchWebImage(noteId: string, url: string): Promise<FetchedWebImage> {
  return json(
    await request(`/api/notes/${encodeURIComponent(noteId)}/files/fetch`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ url }),
    }),
  );
}

/** One file after a copy between notes: the name asked for, and the name it has now. */
export interface CopiedAttachment extends AttachmentInfo {
  from: string;
  path: string;
  /** True when the source file was deleted afterwards; only ever for a move. */
  moved: boolean;
}

/**
 * Copies files from another note into this one, server side, and says what each is
 * called here — a name already taken in the destination is suffixed. `move` deletes
 * each source file the source body no longer links; see the route for why that guard.
 */
export async function copyAttachments(
  toNoteId: string,
  input: { from: string; filenames: string[]; move?: boolean; link?: boolean },
): Promise<{ files: CopiedAttachment[]; missing: string[] }> {
  return json(
    await request(`/api/notes/${encodeURIComponent(toNoteId)}/files/copy`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),
  );
}

/**
 * Permanently deletes one attachment: D1 row and R2 object.
 * Does not rewrite the note body — callers strip links when needed.
 */
export async function deleteAttachment(noteId: string, filename: string): Promise<void> {
  const res = await request(
    `/api/notes/${noteId}/files/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

/**
 * The query string of an export page for a filter, the tags repeated rather than joined:
 * a tag name may contain any delimiter we'd pick. Built here because assembling outbound
 * API query strings is this module's job.
 *
 * `sort` is always sent, because it names the column the pages' cursor walks as well as
 * the one a date range applies to. Beside a date range it is the filter's, so the range
 * means what the list showing it meant. Otherwise it is `created`, which never changes:
 * walking `updated`, the list's default, a note edited in another tab or on the phone
 * while a long export is running jumps above the cursor and is silently left out.
 */
export function exportQuery(
  filter: ExportFilter,
  page: { cursor?: string | undefined; limit?: number | undefined } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  // Named notes take no other filter (the server refuses the pair), and the server walks
  // them by `created`, which a note edited mid-export cannot move under the cursor.
  if (filter.ids?.length) {
    for (const id of filter.ids) params.append('id', id);
    params.set('sort', 'created');
    if (page.cursor) params.set('cursor', page.cursor);
    if (page.limit) params.set('limit', String(page.limit));
    return params;
  }
  for (const t of filter.tags ?? []) params.append('tag', t);
  if (filter.notebook) params.set('notebook', filter.notebook);
  for (const f of filter.fields ?? []) params.append('field', f);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  params.set('sort', filter.from || filter.to ? (filter.sort ?? DEFAULT_NOTE_SORT) : 'created');
  if (page.cursor) params.set('cursor', page.cursor);
  if (page.limit) params.set('limit', String(page.limit));
  return params;
}

/**
 * One page of the export: whole notes with their bodies and the names of their files.
 * The browser walks the cursor and writes the archive itself; see `export-archive.ts`.
 */
export type { ExportPage, ExportedNote } from '@unbent/shared';

export async function exportPage(
  filter: ExportFilter,
  cursor?: string,
  limit?: number,
): Promise<ExportPage> {
  const qs = exportQuery(filter, { cursor, limit }).toString();
  return json<ExportPage>(await request(`/api/export/notes${qs ? `?${qs}` : ''}`));
}

/** A search match, with its note's list row when the search asked for rows. */
export type SearchHit = SearchResult | SearchResultRow;

/**
 * `rows` asks for each match's list row as well, for a table drawing the search in its
 * columns — see `rows` on the search query. The sidebar's results draw a title and a
 * snippet and leave it off, since the rows cost the server a page's worth of reads.
 */
export async function searchNotes(
  q: string,
  filter: { tag?: string[]; notebook?: string; field?: string[]; from?: string; to?: string } = {},
  rows = false,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q });
  for (const t of filter.tag ?? []) params.append('tag', t);
  if (filter.notebook) params.set('notebook', filter.notebook);
  for (const f of filter.field ?? []) params.append('field', f);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (rows) params.set('rows', '1');
  const { results } = await json<{ results: SearchHit[] }>(
    await request(`/api/search?${params.toString()}`),
  );
  return results;
}

export interface PurgeResult {
  scope: 'trashed' | 'all';
  notesDeleted: number;
  filesDeleted: number;
}

/**
 * Permanently deletes notes and their attachments. Irreversible — the confirmation token
 * is required by the server, so this cannot fire from a stray call.
 *
 * A page per request, until the server says nothing is left: one request may make only
 * so many database calls, and an account's worth of deletes is more than that. A request
 * that deletes nothing ends it too, in case the server's count of what is left is wrong.
 */
export async function purgeNotes(scope: 'trashed' | 'all'): Promise<PurgeResult> {
  const total: PurgeResult = { scope, notesDeleted: 0, filesDeleted: 0 };
  try {
    for (;;) {
      const page = await json<PurgeResult & { remaining: number }>(
        await request(`/api/admin/purge-notes?scope=${scope}&confirm=DELETE`, { method: 'POST' }),
      );
      total.notesDeleted += page.notesDeleted;
      total.filesDeleted += page.filesDeleted;
      if (page.remaining === 0 || page.notesDeleted === 0) return total;
    }
  } catch (err) {
    // A failure after some pages has already destroyed notes for good, and saying only
    // what went wrong would read as though nothing happened. The likeliest one is the
    // 503 of a day whose database reads have run out, partway through a large trash.
    if (total.notesDeleted === 0) throw err;
    const n = total.notesDeleted;
    throw new Error(
      `${n} ${n === 1 ? 'note was' : 'notes were'} permanently deleted before this stopped: ${(err as Error).message}`,
    );
  }
}

export interface GcResult {
  stored: number;
  /** Rows' keys and the keys of files deleted in the last 35 days together. */
  referenced: number;
  /** Of `referenced`, the files deleted in the last 35 days, kept for a restore and counted as referenced. */
  awaitingDeletion: number;
  orphaned: number;
  deleted: number;
  dryRun: boolean;
  /** The orphaned keys themselves, capped server-side at 50. */
  keys: string[];
}

/** Sweeps R2 objects with no attachment row. Dry run unless `apply` is true. */
export async function gcBlobs(apply: boolean): Promise<GcResult> {
  return json<GcResult>(
    await request(`/api/admin/gc-blobs${apply ? '?apply=1' : ''}`, { method: 'POST' }),
  );
}

/** Counts every notebook, tag and total again from the notes; `corrected` is how many were wrong. */
export async function recountNotes(): Promise<{ corrected: number }> {
  return json<{ corrected: number }>(await request('/api/admin/recount-notes', { method: 'POST' }));
}

// --- The operator page (MAK-171, part 5) -------------------------------------------------
//
// Every call here is to an operator-only route, which answers anyone else as if it did not
// exist; the page is drawn only once `operatorBackups` has answered (`use-operator.ts`).
// The three actions drive the restore, load and feed-epoch routes exactly as a hand-written
// request would: the dry run is the first call, and the confirm repeats it with the word.

/** What `GET /api/admin/store/stats?user=` reports of one store. */
export interface StoreStats {
  userId: string;
  databaseSize: number;
  migrations: string[];
  counts: Record<string, number>;
  wiped: boolean;
  /**
   * Set while a dump is being loaded: the counts are zero and the store refuses every
   * data call. `undo` is the bookmark the load took as it began and `before` the dump
   * the route wrote first — the two ways back, kept by the store itself so a load that
   * failed is recoverable from any page that reads it, not only the one that pressed.
   */
  loading: { id: string; key: string; startedAt: number; pages: number; undo: string | null; before: string | null } | null;
  /** The store's newest write, read live; the directory's `lastActiveAt` is the same as of the last sweep. */
  lastWriteAt: number | null;
}

export async function operatorBackups(): Promise<BackupsStatus> {
  return json<BackupsStatus>(await request('/api/admin/backups'));
}

/** One page of live accounts by email, narrowed to `q` when given; `after` is the previous page's `next`. */
export async function operatorAccountsPage(after = '', q = ''): Promise<OperatorAccountsPage> {
  const qs = new URLSearchParams({ limit: String(OPERATOR_PAGE_SIZE), ...(after ? { after } : {}), ...(q ? { q } : {}) });
  return json<OperatorAccountsPage>(await request(`/api/admin/accounts?${qs}`));
}

/** One account as the list shows it, or null for an id the directory does not hold live. */
export async function operatorAccount(userId: string): Promise<OperatorAccount | null> {
  const res = await request(`/api/admin/accounts/${encodeURIComponent(userId)}`);
  if (res.status === 404) return null;
  return json<OperatorAccount>(res);
}

export async function storeStats(userId: string): Promise<StoreStats> {
  return json<StoreStats>(await request(`/api/admin/store/stats?user=${encodeURIComponent(userId)}`));
}

export async function accountDumps(userId: string): Promise<AccountDumps> {
  return json<AccountDumps>(await request(`/api/admin/accounts/${encodeURIComponent(userId)}/dumps`));
}

/** One account's restores and loads, newest first. */
export async function accountRestores(userId: string): Promise<StoreRestores> {
  return json<StoreRestores>(await request(`/api/admin/accounts/${encodeURIComponent(userId)}/restores`));
}

/** Where a dump in the bucket downloads from; a link, since a download is a navigation. */
export function dumpDownloadUrl(userId: string, name: string): string {
  return `/api/admin/accounts/${encodeURIComponent(userId)}/dumps/${encodeURIComponent(name)}`;
}

/** Where the store as it stands downloads from. */
export function storeDumpUrl(userId: string): string {
  return `/api/admin/store/dump?user=${encodeURIComponent(userId)}`;
}

/** The restore route's dry run: the moment resolved to a bookmark, and the store as it is now. */
export interface RestorePreview {
  dryRun: true;
  user: string;
  bookmark: string;
  current: StoreStats;
}

/** The restore route's answer once it has wound the store back. */
export interface RestoreResult {
  restored: true;
  user: string;
  /** The bookmark that puts the store back as it was before this restore, if it survived the restart. */
  undo: string | null;
  /** Whether the restore history holds it, and so offers its undo; false when that write failed. */
  recorded: boolean;
  /**
   * Its row in the history, which a restore started; the answer's own undo sends it as
   * `ifNewest`, since a row whose settle failed is still the account's newest.
   */
  record: number;
  feedEpoch: string | null;
  stats: StoreStats | null;
  note: string;
}

export async function previewRestore(userId: string, to: { at: number } | { bookmark: string }): Promise<RestorePreview> {
  return json<RestorePreview>(
    await request('/api/admin/store/restore', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ user: userId, ...to }) }),
  );
}

/**
 * `ifNewest` is the newest history row the page saw: the route refuses with 409 when
 * another has been written since, rather than undo beneath it.
 */
export async function restoreStore(userId: string, to: { at: number } | { bookmark: string }, ifNewest?: number): Promise<RestoreResult> {
  return json<RestoreResult>(
    await request('/api/admin/store/restore', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ user: userId, ...to, ...(ifNewest === undefined ? {} : { ifNewest }), confirm: 'RESTORE' }),
    }),
  );
}

/** The load route's dry run: the dump read from its head and tail, and the store as it is now. */
export interface LoadPreview {
  dryRun: true;
  user: string;
  dump: {
    key: string;
    size: number;
    uploadedAt: string;
    owner: string | null;
    /** The file's first line, which says when it was taken. */
    header: string;
    /** False when the store was written to while it was dumped; null when the file does not say. */
    oneMoment: boolean | null;
  };
  current: StoreStats;
}

export interface LoadResult {
  loaded: true;
  user: string;
  key: string;
  /** The dump of the store as it stood, written before it was replaced; null when the store was already loading. */
  before: string | null;
  undo: string | null;
  /** As on `RestoreResult`. */
  recorded: boolean;
  record: number;
  feedEpoch: string;
  migrated: string[];
  foreignKeyViolations: number;
  stats: StoreStats;
  note: string;
}

export async function previewLoad(userId: string, dump: string): Promise<LoadPreview> {
  return json<LoadPreview>(await request('/api/admin/store/load', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ user: userId, dump }) }));
}

/**
 * A load that failed after the store was emptied. The route's 502 then carries the two
 * ways back — the bookmark the load took as it began, and the dump it wrote first — and
 * a message alone would throw them away on the one path where they matter most: the
 * store is refusing every request until one of them is used.
 */
export class LoadFailedError extends ApiError {
  constructor(
    message: string,
    readonly undo: string | null,
    readonly before: string | null,
  ) {
    super(502, message);
    this.name = 'LoadFailedError';
  }
}

export async function loadDump(userId: string, dump: string): Promise<LoadResult> {
  const res = await request('/api/admin/store/load', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ user: userId, dump, confirm: 'LOAD' }) });
  if (!res.ok && res.headers.get('Content-Type')?.includes('json')) {
    const body = (await res.clone().json().catch(() => null)) as { error?: string; loading?: boolean; undo?: string | null; before?: string | null } | null;
    if (body?.loading) throw new LoadFailedError(body.error ?? `${res.status}`, body.undo ?? null, body.before ?? null);
  }
  return json<LoadResult>(res);
}

/**
 * Deletes someone else's account and everything in it (`DELETE /api/admin/accounts/:id`).
 * The operator's own is refused: Settings deletes that, with its emailed link.
 */
export async function deleteAccount(userId: string): Promise<{ deleted: string }> {
  const id = encodeURIComponent(userId);
  return json<{ deleted: string }>(await request(`/api/admin/accounts/${id}?confirm=${id}`, { method: 'DELETE' }));
}

/** Names a new feed epoch, so every device of the account starts over from a snapshot. */
export async function resyncDevices(userId: string): Promise<{ user: string; epoch: string }> {
  return json<{ user: string; epoch: string }>(
    await request(`/api/admin/store/feed-epoch?user=${encodeURIComponent(userId)}`, { method: 'POST' }),
  );
}
