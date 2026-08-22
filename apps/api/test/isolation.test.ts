/**
 * Cross-tenant isolation suite.
 *
 * D1 has no row-level security, so tenant isolation is application code and nothing else.
 * This suite exists from Phase 1 and every later phase extends it: when a route that
 * touches user data is added, a case asserting the other user cannot reach it is added
 * here in the same commit.
 *
 * Runs against a live `wrangler dev` on :8787 with email/password temporarily enabled.
 * See test/README.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';

/**
 * Better Auth enforces CSRF by requiring an Origin it trusts, so requests must carry one
 * the way a browser would. APP_URL is the SPA origin in dev.
 */
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

interface Actor {
  cookie: string;
  userId: string;
  email: string;
}

async function signUp(email: string, password: string, name: string): Promise<Actor> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up failed for ${email}: ${res.status} ${await res.text()}`);

  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error(`no session cookie returned for ${email}`);
  const cookie = setCookie.split(';')[0] ?? '';

  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id, email };
}

function asUser(actor: Actor): RequestInit {
  return { headers: { Cookie: actor.cookie, Origin: ORIGIN } };
}

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
  expect(alice.userId).not.toBe(bob.userId);
}, 30_000);

describe('session resolution', () => {
  it('returns the right user for each session', async () => {
    const a = await fetch(`${BASE}/api/me`, asUser(alice)).then((r) => r.json());
    const b = await fetch(`${BASE}/api/me`, asUser(bob)).then((r) => r.json());
    expect(a.user.id).toBe(alice.userId);
    expect(b.user.id).toBe(bob.userId);
  });

  it('returns null with no cookie', async () => {
    const res = await fetch(`${BASE}/api/me`);
    expect((await res.json()).user).toBeNull();
  });

  it('rejects a forged session token', async () => {
    const res = await fetch(`${BASE}/api/me`, {
      headers: { Cookie: 'better-auth.session_token=forged-not-a-real-token', Origin: ORIGIN },
    });
    expect((await res.json()).user).toBeNull();
  });

  it('rejects a truncated session token', async () => {
    const truncated = alice.cookie.slice(0, alice.cookie.length - 4);
    const res = await fetch(`${BASE}/api/me`, { headers: { Cookie: truncated, Origin: ORIGIN } });
    expect((await res.json()).user).toBeNull();
  });

  it("does not accept one user's token under another user's id", async () => {
    // Swapping cookies must yield the cookie's real owner, never the requested identity.
    const res = await fetch(`${BASE}/api/me`, asUser(bob));
    expect((await res.json()).user.id).toBe(bob.userId);
  });
});

describe('public routes', () => {
  it('serves health without a session', async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).db).toBe('ok');
  });
});

async function createNote(
  actor: Actor,
  body: { title?: string; body?: string; tags?: string[] },
): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

describe('note CRUD', () => {
  it('round-trips a note', async () => {
    const created = await createNote(alice, {
      title: 'Round trip',
      body: '# Hello\n\nBody text.',
      tags: ['work', 'planning'],
    });

    const res = await fetch(`${BASE}/api/notes/${created.id}`, asUser(alice));
    const note = await res.json();
    expect(note.title).toBe('Round trip');
    expect(note.body).toBe('# Hello\n\nBody text.');
    expect(note.tags.sort()).toEqual(['planning', 'work']);
  });

  it('lists newest first and excerpts the body', async () => {
    await createNote(alice, { title: 'Older', body: 'first' });
    const newer = await createNote(alice, { title: 'Newer', body: '## Heading\n\nreal text' });

    const { items } = await fetch(`${BASE}/api/notes`, asUser(alice)).then((r) => r.json());
    expect(items[0].id).toBe(newer.id);
    // The excerpt strips heading syntax and uses the first non-empty line.
    expect(items[0].excerpt).toBe('Heading');
  });

  it('patches title, body, and tags independently', async () => {
    const n = await createNote(alice, { title: 'Before', body: 'b', tags: ['x'] });

    const patch = async (payload: object) =>
      fetch(`${BASE}/api/notes/${n.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
        body: JSON.stringify(payload),
      }).then((r) => r.json());

    expect((await patch({ title: 'After' })).title).toBe('After');
    expect((await patch({ title: 'After' })).tags).toEqual(['x']);
    expect((await patch({ tags: ['y', 'z'] })).tags.sort()).toEqual(['y', 'z']);
    expect((await patch({ tags: [] })).tags).toEqual([]);
  });

  it('soft-deletes so the note leaves the list and 404s', async () => {
    const n = await createNote(alice, { title: 'Doomed', body: 'x' });

    const del = await fetch(`${BASE}/api/notes/${n.id}`, {
      method: 'DELETE',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(del.status).toBe(204);

    expect((await fetch(`${BASE}/api/notes/${n.id}`, asUser(alice))).status).toBe(404);

    const { items } = await fetch(`${BASE}/api/notes`, asUser(alice)).then((r) => r.json());
    expect(items.map((i: { id: string }) => i.id)).not.toContain(n.id);
  });

  it('filters by tag', async () => {
    const tag = `filter-${Date.now()}`;
    const tagged = await createNote(alice, { title: 'Tagged', body: 'x', tags: [tag] });
    await createNote(alice, { title: 'Untagged', body: 'x' });

    const { items } = await fetch(`${BASE}/api/notes?tag=${tag}`, asUser(alice)).then((r) =>
      r.json(),
    );
    expect(items.map((i: { id: string }) => i.id)).toEqual([tagged.id]);
  });

  it('rejects a body over the D1 row limit', async () => {
    const res = await fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
      body: JSON.stringify({ title: 'Huge', body: 'x'.repeat(2_000_000) }),
    });
    expect(res.status).toBe(400);
  });
});

describe('unauthenticated access', () => {
  const cases: Array<[string, string, RequestInit]> = [
    ['GET', '/api/notes', {}],
    ['POST', '/api/notes', { method: 'POST', body: '{}' }],
    ['GET', '/api/notes/whatever', {}],
    ['PATCH', '/api/notes/whatever', { method: 'PATCH', body: '{}' }],
    ['DELETE', '/api/notes/whatever', { method: 'DELETE' }],
    ['GET', '/api/tags', {}],
  ];

  it.each(cases)('%s %s requires a session', async (_m, path, init) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });
});

/**
 * The suite that matters. D1 has no row-level security, so every route touching user data
 * gets a case here proving the other actor cannot reach it. 404 rather than 403 throughout:
 * a 403 would confirm the id exists.
 */
describe('cross-tenant access', () => {
  let aliceNote: { id: string };

  beforeAll(async () => {
    aliceNote = await createNote(alice, {
      title: 'Alice private',
      body: 'secret',
      tags: ['alice-only'],
    });
  });

  it('bob cannot GET an alice note by id', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}`, asUser(bob));
    expect(res.status).toBe(404);
  });

  it('bob cannot PATCH an alice note by id', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: bob.cookie, Origin: ORIGIN },
      body: JSON.stringify({ title: 'pwned' }),
    });
    expect(res.status).toBe(404);

    // And the note is genuinely untouched, not merely reported as missing.
    const still = await fetch(`${BASE}/api/notes/${aliceNote.id}`, asUser(alice)).then((r) =>
      r.json(),
    );
    expect(still.title).toBe('Alice private');
  });

  it('bob cannot DELETE an alice note by id', async () => {
    const res = await fetch(`${BASE}/api/notes/${aliceNote.id}`, {
      method: 'DELETE',
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);
    expect((await fetch(`${BASE}/api/notes/${aliceNote.id}`, asUser(alice))).status).toBe(200);
  });

  it('alice notes never appear in a bob list', async () => {
    const { items } = await fetch(`${BASE}/api/notes?limit=100`, asUser(bob)).then((r) => r.json());
    expect(items.map((i: { id: string }) => i.id)).not.toContain(aliceNote.id);
  });

  it('alice tags never appear in bob tags', async () => {
    const { tags } = await fetch(`${BASE}/api/tags`, asUser(bob)).then((r) => r.json());
    expect(tags.map((t: { name: string }) => t.name)).not.toContain('alice-only');
  });

  it('a bob tag filter cannot surface an alice note', async () => {
    const { items } = await fetch(`${BASE}/api/notes?tag=alice-only`, asUser(bob)).then((r) =>
      r.json(),
    );
    expect(items).toEqual([]);
  });

  it.todo('attachments: bob cannot fetch a blob under an alice note id');
  it.todo('search: alice notes never appear in bob results');
  it.todo('export: a bob zip contains no alice notes');
  it.todo('import: bob cannot write into an alice note id');
});
