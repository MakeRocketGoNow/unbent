/**
 * Several notes at once: `PATCH /notes` and the three batch verbs under it.
 *
 * Checked over HTTP against the live Worker, because what matters is what the stored rows
 * end up holding after a batch: which notes moved, which kept their date, which were left
 * alone for belonging to someone else. Each case pairs a change with the no-op it must not
 * be confused with, since a batch that wrote nothing would pass every "unchanged" assertion
 * on its own.
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
  tags: string[];
  notebook: string | null;
  updatedAt: number;
  deletedAt?: number;
}

let alice: Actor;
let bob: Actor;

function headers(actor: Actor): HeadersInit {
  return { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN };
}

async function call<T>(actor: Actor, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: headers(actor),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function status(actor: Actor, method: string, path: string, body?: unknown): Promise<number> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: headers(actor),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.status;
}

const create = (actor: Actor, body: Partial<Note> & { body?: string }) =>
  call<Note>(actor, 'POST', '/notes', { title: 'n', body: '', ...body });
const get = (actor: Actor, id: string) => call<Note>(actor, 'GET', `/notes/${id}`);

/** Past the millisecond the notes were created in, so an unchanged date is evidence. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`batch-a-${stamp}@example.test`, 'batch-password-123', 'A');
  bob = await signUp(`batch-b-${stamp}@example.test`, 'batch-password-123', 'B');
});

describe('PATCH /notes', () => {
  it('files a selection into a notebook, creating it, and skips notes already there', async () => {
    const a = await create(alice, { title: 'a' });
    const b = await create(alice, { title: 'b', notebook: 'Coupons' });
    await tick();

    const result = await call<{ matched: number; changed: number }>(alice, 'PATCH', '/notes', {
      ids: [a.id, b.id],
      notebook: 'Coupons',
    });
    expect(result).toEqual({ matched: 2, changed: 1 });

    const [a2, b2] = await Promise.all([get(alice, a.id), get(alice, b.id)]);
    expect(a2.notebook).toBe('Coupons');
    expect(a2.updatedAt).toBeGreaterThan(a.updatedAt);
    // Already in Coupons: not an edit, so its date stands.
    expect(b2.updatedAt).toBe(b.updatedAt);
  });

  it('takes a selection out of every notebook with null', async () => {
    const a = await create(alice, { title: 'a', notebook: 'Coupons' });
    const result = await call<{ matched: number; changed: number }>(alice, 'PATCH', '/notes', {
      ids: [a.id],
      notebook: null,
    });
    expect(result.changed).toBe(1);
    expect((await get(alice, a.id)).notebook).toBeNull();
  });

  it('adds and removes tags per note, leaving each note the rest of its own', async () => {
    const a = await create(alice, { title: 'a', tags: ['podcast'] });
    const b = await create(alice, { title: 'b', tags: ['podcast', 'later'] });
    const c = await create(alice, { title: 'c', tags: ['later'] });
    await tick();

    const result = await call<{ matched: number; changed: number }>(alice, 'PATCH', '/notes', {
      ids: [a.id, b.id, c.id],
      addTags: ['later'],
      removeTags: ['podcast'],
    });
    // The third already had the one and lacked the other: matched, and left alone.
    expect(result).toEqual({ matched: 3, changed: 2 });

    expect((await get(alice, a.id)).tags).toEqual(['later']);
    expect((await get(alice, b.id)).tags).toEqual(['later']);
    expect((await get(alice, c.id)).tags).toEqual(['later']);
  });

  it('leaves a note that already has the tag undated', async () => {
    const a = await create(alice, { title: 'a', tags: ['later'] });
    const b = await create(alice, { title: 'b' });
    await tick();

    const result = await call<{ matched: number; changed: number }>(alice, 'PATCH', '/notes', {
      ids: [a.id, b.id],
      addTags: ['later'],
    });
    expect(result).toEqual({ matched: 2, changed: 1 });
    expect((await get(alice, a.id)).updatedAt).toBe(a.updatedAt);
    expect((await get(alice, b.id)).updatedAt).toBeGreaterThan(b.updatedAt);
  });

  it('adds a tag named in both lists', async () => {
    const a = await create(alice, { title: 'a' });
    await call(alice, 'PATCH', '/notes', { ids: [a.id], addTags: ['x'], removeTags: ['x'] });
    expect((await get(alice, a.id)).tags).toEqual(['x']);
  });

  it("counts out another user's notes and trashed ones without touching them", async () => {
    const mine = await create(alice, { title: 'mine' });
    const theirs = await create(bob, { title: 'theirs' });
    const binned = await create(alice, { title: 'binned' });
    expect(await status(alice, 'DELETE', `/notes/${binned.id}`)).toBe(204);

    const result = await call<{ matched: number; changed: number }>(alice, 'PATCH', '/notes', {
      ids: [mine.id, theirs.id, binned.id, 'no-such-note'],
      notebook: 'Coupons',
    });
    expect(result).toEqual({ matched: 1, changed: 1 });
    expect((await get(bob, theirs.id)).notebook).toBeNull();
  });

  it('refuses a body that names nothing to change', async () => {
    const a = await create(alice, { title: 'a' });
    expect(await status(alice, 'PATCH', '/notes', { ids: [a.id] })).toBe(400);
    expect(await status(alice, 'PATCH', '/notes', { ids: [], notebook: 'x' })).toBe(400);
  });
});

describe('the batch verbs', () => {
  it('trashes, restores and purges a selection, counting only what moved', async () => {
    const a = await create(alice, { title: 'a' });
    const b = await create(alice, { title: 'b' });
    const theirs = await create(bob, { title: 'theirs' });

    expect(
      await call(alice, 'POST', '/notes/trash', { ids: [a.id, b.id, theirs.id] }),
    ).toEqual({ trashed: 2 });
    // A trashed note still reads by id, marked; bob's, named in alice's request, is untouched.
    expect(await call(alice, 'GET', `/notes/${a.id}`)).toHaveProperty('deletedAt');
    expect(await call(bob, 'GET', `/notes/${theirs.id}`)).not.toHaveProperty('deletedAt');
    // Again: already in the trash, nothing to count.
    expect(await call(alice, 'POST', '/notes/trash', { ids: [a.id, b.id] })).toEqual({ trashed: 0 });

    // A live note is not purged: only the trash is, whatever the request names.
    const live = await create(alice, { title: 'live' });
    expect(await call(alice, 'POST', '/notes/purge', { ids: [a.id, live.id] })).toEqual({ deleted: 1 });
    expect(await status(alice, 'GET', `/notes/${live.id}`)).toBe(200);
    expect(await status(alice, 'POST', `/notes/${a.id}/restore`)).toBe(404);

    expect(await call(alice, 'POST', '/notes/restore', { ids: [a.id, b.id, live.id] })).toEqual({
      restored: 1,
    });
    const back = await get(alice, b.id);
    expect(back.updatedAt).toBe(b.updatedAt);
  });

  it('keeps the files of a note restored before the batch purge', async () => {
    const note = await create(alice, { title: 'with-file' });
    const put = await fetch(`${BASE}/api/notes/${note.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: alice.cookie,
        Origin: ORIGIN,
        'X-Filename': encodeURIComponent('scan.pdf'),
        'Content-Type': 'application/pdf',
      },
      body: 'fake-pdf',
    });
    expect(put.status).toBe(201);

    expect(await status(alice, 'DELETE', `/notes/${note.id}`)).toBe(204);
    expect(await status(alice, 'POST', `/notes/${note.id}/restore`)).toBe(200);

    // Named in the purge the way a stale trash selection would name it.
    expect(await call(alice, 'POST', '/notes/purge', { ids: [note.id] })).toEqual({ deleted: 0 });

    const file = await fetch(`${BASE}/api/notes/${note.id}/files/scan.pdf`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('fake-pdf');
  });
});
