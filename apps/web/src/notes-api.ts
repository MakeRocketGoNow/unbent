import type { Note, NoteSummary } from '@unbent/shared';

/**
 * Thin fetch wrappers over the notes API. Same-origin, so cookies travel automatically.
 *
 * These are hand-written rather than routed through hc<AppType>() because the Hono client
 * infers `unknown` for these response bodies once zValidator is in play; the shared Note
 * types are the contract either way.
 */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export async function listNotes(opts: { tag?: string } = {}): Promise<NoteSummary[]> {
  const params = new URLSearchParams();
  if (opts.tag) params.set('tag', opts.tag);
  const qs = params.toString();
  const { items } = await json<{ items: NoteSummary[] }>(
    await fetch(`/api/notes${qs ? `?${qs}` : ''}`),
  );
  return items;
}

export async function getNote(id: string): Promise<Note> {
  return json<Note>(await fetch(`/api/notes/${id}`));
}

export async function createNote(input: {
  title?: string;
  body?: string;
  tags?: string[];
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
  patch: { title?: string; body?: string; tags?: string[] },
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

export async function listTags(): Promise<Array<{ name: string; count: number }>> {
  const { tags } = await json<{ tags: Array<{ name: string; count: number }> }>(
    await fetch('/api/tags'),
  );
  return tags;
}
