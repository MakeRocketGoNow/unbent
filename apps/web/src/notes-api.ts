import type {
  AppConfig,
  AttachmentInfo,
  FieldDef,
  FieldScale,
  FieldType,
  Note,
  NoteFieldsPatch,
  NoteSort,
  NoteSummary,
  NotebookSummary,
  SearchResult,
} from '@unbent/shared';

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
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return json<NotePage>(await fetch(`/api/notes${qs ? `?${qs}` : ''}`));
}

export async function getNote(id: string): Promise<Note> {
  return json<Note>(await fetch(`/api/notes/${id}`));
}

export async function createNote(input: {
  title?: string;
  body?: string;
  tags?: string[];
  notebook?: string | null;
  fields?: NoteFieldsPatch;
}): Promise<Note> {
  return json<Note>(
    await fetch('/api/notes', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),
  );
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
  },
): Promise<Note> {
  return json<Note>(
    await fetch(`/api/notes/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify(patch),
    }),
  );
}

/** A new note with this one's title, body, filing and files. */
export async function duplicateNote(id: string): Promise<Note> {
  return json<Note>(
    await fetch(`/api/notes/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
  );
}

export async function deleteNote(id: string): Promise<void> {
  const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

/** Restores a trashed note. */
export async function restoreNote(id: string): Promise<Note> {
  return json<Note>(await fetch(`/api/notes/${id}/restore`, { method: 'POST' }));
}

/** Permanently deletes one trashed note and its attachments. Irreversible. */
export async function deleteNotePermanently(id: string): Promise<void> {
  const res = await fetch(`/api/notes/${id}/permanent`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

/**
 * How this instance can be signed in to. Public, so it works before there is a session;
 * the login screen is what asks.
 */
export async function getConfig(): Promise<AppConfig> {
  return json<AppConfig>(await fetch('/api/config'));
}

/** A tag as the list reports it: its id, which a rename addresses, and how many live notes carry it. */
export interface TagSummary {
  id: string;
  name: string;
  count: number;
}

export async function listTags(): Promise<TagSummary[]> {
  const { tags } = await json<{ tags: TagSummary[] }>(await fetch('/api/tags'));
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
  const res = await fetch(`/api/tags/${id}${opts?.merge ? '?merge=1' : ''}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) throw new ConflictError('A tag with that name already exists.');
  return json(res);
}

/** Takes the tag off every note that carries it. The notes stay. */
export async function deleteTag(id: string): Promise<void> {
  const res = await fetch(`/api/tags/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await httpErrorMessage(res));
}

export type Notebook = NotebookSummary;

/** The notebook list plus how many notes sit outside every notebook. */
export interface NotebookList {
  notebooks: Notebook[];
  unfiled: number;
}

export async function listNotebooks(): Promise<NotebookList> {
  return json<NotebookList>(await fetch('/api/notebooks'));
}

/** Creates an empty notebook. Throws with a readable message when the name is taken. */
export async function createNotebook(name: string): Promise<{ id: string; name: string }> {
  const res = await fetch('/api/notebooks', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) throw new Error('A notebook with that name already exists.');
  return json(res);
}

export async function renameNotebook(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/notebooks/${id}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) throw new Error('A notebook with that name already exists.');
  await json(res);
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
  const res = await fetch(`/api/notebooks/${id}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

// --- Custom fields ---------------------------------------------------------------------

export async function listNotebookFields(notebookId: string): Promise<FieldDef[]> {
  const { fields } = await json<{ fields: FieldDef[] }>(
    await fetch(`/api/notebooks/${notebookId}/fields`),
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
  const res = await fetch(`/api/notebooks/${notebookId}/fields`, {
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
  const res = await fetch(`/api/notebooks/${notebookId}/fields/${fieldId}`, {
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
  scale?: FieldScale | null,
): Promise<{ values: number; incompatible: number }> {
  const query = new URLSearchParams({ type });
  // Absent means "whatever the field has now", which is what the repo assumes; an
  // explicit empty scale is how a rating becoming a plain number asks for the count.
  if (scale !== undefined) query.set('scale', scale ? `${scale.max}:${scale.step}` : '');
  return json(
    await fetch(`/api/notebooks/${notebookId}/fields/${fieldId}/conversion?${query}`),
  );
}

/** Sets the order. `ids` must be every field of the notebook, each once. */
export async function reorderNotebookFields(notebookId: string, ids: string[]): Promise<void> {
  const res = await fetch(`/api/notebooks/${notebookId}/fields/order`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

/** Deletes a field and every value under it. */
export async function deleteNotebookField(notebookId: string, fieldId: string): Promise<void> {
  const res = await fetch(`/api/notebooks/${notebookId}/fields/${fieldId}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
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
  opts: { signal?: AbortSignal } = {},
): Promise<UploadedFile> {
  const res = await fetch(`/api/notes/${noteId}/files`, {
    method: 'PUT',
    headers: {
      'X-Filename': encodeURIComponent(file.name),
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
    // The editor aborts an upload the user walked away from; see editor/attach.ts.
    signal: opts.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail ? JSON.parse(detail).error ?? detail : `${res.status}`);
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
    await fetch(`/api/notes/${noteId}/files`),
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
    await fetch(`/api/notes/${encodeURIComponent(noteId)}/files/fetch`, {
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
    await fetch(`/api/notes/${encodeURIComponent(toNoteId)}/files/copy`, {
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
  const res = await fetch(
    `/api/notes/${noteId}/files/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new ApiError(res.status, await httpErrorMessage(res));
}

/**
 * The URL of the export endpoint for a filter.
 *
 * A URL rather than a fetch: the archive is generated as it downloads, so the browser has
 * to consume the response directly — pulling it into JS would defeat the streaming design
 * and cap the export at the tab's memory. Built here because assembling outbound API query
 * strings is this module's job; components deal in filters, not querystrings.
 */
export function exportUrl(filter: {
  tag?: string[];
  notebook?: string;
  field?: string[];
  from?: string;
  to?: string;
  /**
   * Carried so the export's date range means the same column the list's did. It orders
   * nothing — see `exportQuerySchema`.
   */
  sort?: NoteSort;
}): string {
  const params = new URLSearchParams();
  for (const t of filter.tag ?? []) params.append('tag', t);
  if (filter.notebook) params.set('notebook', filter.notebook);
  for (const f of filter.field ?? []) params.append('field', f);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.sort && (filter.from || filter.to)) params.set('sort', filter.sort);
  const qs = params.toString();
  return `/api/export${qs ? `?${qs}` : ''}`;
}

export async function searchNotes(
  q: string,
  filter: { tag?: string[]; notebook?: string; field?: string[]; from?: string; to?: string } = {},
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q });
  for (const t of filter.tag ?? []) params.append('tag', t);
  if (filter.notebook) params.set('notebook', filter.notebook);
  for (const f of filter.field ?? []) params.append('field', f);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  const { results } = await json<{ results: SearchResult[] }>(
    await fetch(`/api/search?${params.toString()}`),
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
 */
export async function purgeNotes(scope: 'trashed' | 'all'): Promise<PurgeResult> {
  return json<PurgeResult>(
    await fetch(`/api/admin/purge-notes?scope=${scope}&confirm=DELETE`, { method: 'POST' }),
  );
}

export interface GcResult {
  stored: number;
  referenced: number;
  orphaned: number;
  deleted: number;
  dryRun: boolean;
  /** The orphaned keys themselves, capped server-side at 50. */
  keys: string[];
}

/** Sweeps R2 objects with no attachment row. Dry run unless `apply` is true. */
export async function gcBlobs(apply: boolean): Promise<GcResult> {
  return json<GcResult>(
    await fetch(`/api/admin/gc-blobs${apply ? '?apply=1' : ''}`, { method: 'POST' }),
  );
}
