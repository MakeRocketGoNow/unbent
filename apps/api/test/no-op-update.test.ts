/**
 * A save that changes nothing leaves `updated_at` alone.
 *
 * The date is not bookkeeping: the user reads it, sorts by it, and for an imported note it
 * is a real modification date carried over from Evernote. Autosave means a client can fire
 * a PATCH for a space typed and deleted, and before this the API re-dated the note for any
 * key that was merely *present*, so the note's date tracked when it was last looked at
 * rather than last changed.
 *
 * Checked over HTTP against the live Worker rather than by unit-testing the comparison,
 * because the property that matters is what the stored row ends up holding. The cases are
 * paired on purpose: each no-op sits next to the real edit it must not swallow, since a
 * guard that never writes would pass every no-op assertion on its own.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

interface Actor {
  cookie: string;
}

async function signUp(email: string, password: string, name: string): Promise<Actor> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
}

interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  notebook: string | null;
  updatedAt: number;
}

let actor: Actor;

function headers(): HeadersInit {
  return { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN };
}

async function create(body: unknown): Promise<Note> {
  const res = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Note>;
}

async function patch(id: string, body: unknown): Promise<Note> {
  const res = await fetch(`${BASE}/api/notes/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Note>;
}

/**
 * `updated_at` is milliseconds, so a write in the same millisecond as the create would be
 * indistinguishable from no write at all. Waiting past the boundary is what makes an
 * unchanged date evidence rather than a coincidence.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

beforeAll(async () => {
  actor = await signUp(`noop-${Date.now()}@example.test`, 'noop-password-123', 'N');
});

describe('a patch that changes nothing', () => {
  it('leaves the date alone when the body is byte-identical', async () => {
    const note = await create({ title: 'Coupons', body: 'Line one\nLine two' });
    await tick();

    const same = await patch(note.id, { body: 'Line one\nLine two' });
    expect(same.updatedAt).toBe(note.updatedAt);
    expect(same.body).toBe('Line one\nLine two');
  });

  it('leaves the date alone for a whole draft the editor re-sent unchanged', async () => {
    const note = await create({
      title: 'Coupons',
      body: 'Body',
      tags: ['deals'],
      notebook: 'Podcast Bookmarks',
    });
    await tick();

    // What the web editor would send if it did not diff, and what the phone's title field
    // sends on every settled keystroke.
    const same = await patch(note.id, {
      title: 'Coupons',
      body: 'Body',
      tags: ['deals'],
      notebook: 'Podcast Bookmarks',
    });
    expect(same.updatedAt).toBe(note.updatedAt);
  });

  it('treats tags as a set, so a client resending them in its own order is not an edit', async () => {
    const note = await create({ title: 'Coupons', body: 'Body', tags: ['deals', 'food'] });
    await tick();

    const reordered = await patch(note.id, { tags: ['food', 'deals'] });
    expect(reordered.updatedAt).toBe(note.updatedAt);
    expect(reordered.tags).toEqual(['deals', 'food']);

    // Duplicates collapse the way `setTags` would have written them.
    const duplicated = await patch(note.id, { tags: ['deals', 'deals', 'food'] });
    expect(duplicated.updatedAt).toBe(note.updatedAt);
  });

  it('leaves the date alone when a note is filed into the notebook it is already in', async () => {
    // What `move_notes` does over MCP, fifty notes at a time.
    const note = await create({ title: 'Coupons', body: 'Body', notebook: 'Podcast Bookmarks' });
    await tick();

    const same = await patch(note.id, { notebook: 'Podcast Bookmarks' });
    expect(same.updatedAt).toBe(note.updatedAt);
    expect(same.notebook).toBe('Podcast Bookmarks');
  });

  it('still reports a missing note rather than silently succeeding', async () => {
    const res = await fetch(`${BASE}/api/notes/00000000-0000-4000-8000-000000000000`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ title: 'Anything' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('a patch that does change something', () => {
  it('bumps the date and stores whitespace exactly as given', async () => {
    const note = await create({ title: 'Coupons', body: 'Line one' });
    await tick();

    // Trailing whitespace is a real edit: in Markdown two trailing spaces are a line
    // break, so comparison is exact rather than trimmed.
    const spaced = await patch(note.id, { body: 'Line one ' });
    expect(spaced.updatedAt).toBeGreaterThan(note.updatedAt);
    expect(spaced.body).toBe('Line one ');
    await tick();

    // And taking it back out is another edit, not a return to "unchanged".
    const removed = await patch(note.id, { body: 'Line one' });
    expect(removed.updatedAt).toBeGreaterThan(spaced.updatedAt);
    expect(removed.body).toBe('Line one');
  });

  it('bumps the date for a real title, tag and notebook change', async () => {
    const note = await create({
      title: 'Coupons',
      body: 'Body',
      tags: ['deals', 'food'],
      notebook: 'Podcast Bookmarks',
    });
    await tick();

    const renamed = await patch(note.id, { title: 'Coupons and deals' });
    expect(renamed.updatedAt).toBeGreaterThan(note.updatedAt);
    expect(renamed.title).toBe('Coupons and deals');
    await tick();

    const untagged = await patch(renamed.id, { tags: ['deals'] });
    expect(untagged.updatedAt).toBeGreaterThan(renamed.updatedAt);
    expect(untagged.tags).toEqual(['deals']);
    await tick();

    const unfiled = await patch(untagged.id, { notebook: null });
    expect(unfiled.updatedAt).toBeGreaterThan(untagged.updatedAt);
    expect(unfiled.notebook ?? null).toBeNull();
  });

  it('applies one changed key out of several unchanged ones', async () => {
    const note = await create({ title: 'Coupons', body: 'Body', tags: ['deals'] });
    await tick();

    // The mixed case is the one a naive "any key present" guard and a naive "nothing
    // changed" guard both get wrong.
    const edited = await patch(note.id, { title: 'Coupons', body: 'Body rewritten', tags: ['deals'] });
    expect(edited.updatedAt).toBeGreaterThan(note.updatedAt);
    expect(edited.body).toBe('Body rewritten');
    expect(edited.title).toBe('Coupons');
    expect(edited.tags).toEqual(['deals']);
  });
});
