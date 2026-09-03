import type {
  AppConfig,
  AttachmentInfo,
  Note,
  NoteSort,
  NoteSummary,
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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
    );
  }
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
    cursor?: string;
    trashed?: boolean;
    limit?: number;
    sort?: NoteSort;
    order?: 'asc' | 'desc';
    from?: string;
    to?: string;
  } = {},
): Promise<NotePage> {
  const params = new URLSearchParams();
  // Repeated rather than joined: a tag name may contain any delimiter we'd pick.
  for (const t of opts.tag ?? []) params.append('tag', t);
  if (opts.notebook) params.set('notebook', opts.notebook);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.order) params.set('order', opts.order);
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
  patch: { title?: string; body?: string; tags?: string[]; notebook?: string | null },
): Promise<Note> {
  return json<Note>(
    await fetch(`/api/notes/${id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify(patch),
    }),
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

export async function listTags(): Promise<Array<{ name: string; count: number }>> {
  const { tags } = await json<{ tags: Array<{ name: string; count: number }> }>(
    await fetch('/api/tags'),
  );
  return tags;
}

export interface Notebook {
  id: string;
  name: string;
  count: number;
}

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

/**
 * Permanently deletes one attachment: D1 row and R2 object.
 * Does not rewrite the note body — callers strip links when needed.
 */
export async function deleteAttachment(noteId: string, filename: string): Promise<void> {
  const res = await fetch(
    `/api/notes/${noteId}/files/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
    );
  }
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
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.sort && (filter.from || filter.to)) params.set('sort', filter.sort);
  const qs = params.toString();
  return `/api/export${qs ? `?${qs}` : ''}`;
}

export async function searchNotes(
  q: string,
  filter: { tag?: string[]; notebook?: string; from?: string; to?: string } = {},
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q });
  for (const t of filter.tag ?? []) params.append('tag', t);
  if (filter.notebook) params.set('notebook', filter.notebook);
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
