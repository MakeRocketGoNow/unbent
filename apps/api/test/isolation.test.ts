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

/**
 * Test actors use @example.test addresses. Cleanup runs as a posttest SQL purge rather
 * than API calls: note deletion is a soft delete by design, so dropping the user row and
 * letting the FK cascade is the only way to leave the local database as it was found.
 */

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
  body: { title?: string; body?: string; tags?: string[]; notebook?: string | null },
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

  it('filters by notebook', async () => {
    const notebook = `nb-${Date.now()}`;
    const inNotebook = await createNote(alice, {
      title: 'In notebook',
      body: 'x',
      notebook,
    });
    await createNote(alice, { title: 'No notebook', body: 'x' });

    const { items } = await fetch(
      `${BASE}/api/notes?notebook=${encodeURIComponent(notebook)}`,
      asUser(alice),
    ).then((r) => r.json());
    expect(items.map((i: { id: string }) => i.id)).toEqual([inNotebook.id]);
  });

  it('filters by notebook and tag together', async () => {
    const notebook = `nb-both-${Date.now()}`;
    const tag = `tag-both-${Date.now()}`;
    const match = await createNote(alice, {
      title: 'Both',
      body: 'x',
      notebook,
      tags: [tag],
    });
    await createNote(alice, { title: 'Notebook only', body: 'x', notebook });
    await createNote(alice, { title: 'Tag only', body: 'x', tags: [tag] });

    const { items } = await fetch(
      `${BASE}/api/notes?notebook=${encodeURIComponent(notebook)}&tag=${tag}`,
      asUser(alice),
    ).then((r) => r.json());
    expect(items.map((i: { id: string }) => i.id)).toEqual([match.id]);
  });

  it('counts within a notebook filter', async () => {
    const actor = await signUp(`nbcount-${Date.now()}@example.test`, 'nbcount-pass-1', 'N');
    const notebook = `counted-nb-${Date.now()}`;
    for (let i = 0; i < 3; i += 1) {
      await createNote(actor, { title: `In ${i}`, body: 'x', notebook });
    }
    await createNote(actor, { title: 'Outside', body: 'x' });

    const page = await fetch(
      `${BASE}/api/notes?notebook=${encodeURIComponent(notebook)}&limit=2`,
      asUser(actor),
    ).then((r) => r.json());
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('lists notebooks with counts', async () => {
    const actor = await signUp(`nblist-${Date.now()}@example.test`, 'nblist-pass-123', 'L');
    const notebook = `listed-${Date.now()}`;
    await createNote(actor, { title: 'One', body: 'x', notebook });
    await createNote(actor, { title: 'Two', body: 'x', notebook });

    const { notebooks } = await fetch(`${BASE}/api/notebooks`, asUser(actor)).then((r) =>
      r.json(),
    );
    const entry = notebooks.find((n: { name: string }) => n.name === notebook);
    expect(entry?.count).toBe(2);
  });

  /**
   * Most-used first, because that is the order that makes a long tag list usable.
   *
   * Pinned because the ordering is load-bearing rather than cosmetic: the pickers on both
   * clients show the head of this list, and alphabetically the head of a real archive is
   * whatever begins with a digit — the tags nobody filters by.
   */
  it('lists tags most-used first, breaking ties by name', async () => {
    const actor = await signUp(`taglist-${Date.now()}@example.test`, 'taglist-pass', 'T');
    await createNote(actor, { title: 'One', tags: ['common', 'zeta', 'alpha'] });
    await createNote(actor, { title: 'Two', tags: ['common'] });
    await createNote(actor, { title: 'Three', tags: ['common'] });

    const { tags } = await fetch(`${BASE}/api/tags`, asUser(actor)).then((r) => r.json());

    expect(tags.map((t: { name: string }) => t.name)).toEqual(['common', 'alpha', 'zeta']);
    expect(tags[0].count).toBe(3);
  });

  /**
   * The list is paginated, so a count taken from a page would report the page size — an
   * account with hundreds of notes showed "50 notes" until the total was reported
   * separately.
   */
  it('reports the true total, not the page size', async () => {
    const actor = await signUp(`count-${Date.now()}@example.test`, 'count-pass-1234', 'C');
    for (let i = 0; i < 12; i += 1) {
      await createNote(actor, { title: `Note ${i}`, body: 'x' });
    }

    const page = await fetch(`${BASE}/api/notes?limit=5`, asUser(actor)).then((r) => r.json());
    expect(page.items).toHaveLength(5);
    expect(page.total).toBe(12);
    expect(page.cursor).toBeTruthy();
  });

  it('pages through every note with the cursor', async () => {
    const actor = await signUp(`paging-${Date.now()}@example.test`, 'paging-pass-123', 'P');
    for (let i = 0; i < 12; i += 1) {
      await createNote(actor, { title: `Paged ${i}`, body: 'x' });
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url = `${BASE}/api/notes?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await fetch(url, asUser(actor)).then((r) => r.json());
      for (const item of page.items) seen.add(item.id);
      cursor = page.cursor;
      if (!cursor) break;
    }

    // Every note reachable, none duplicated across pages.
    expect(seen.size).toBe(12);
    expect(cursor).toBeNull();
  });

  it('sorts by title, and pages without skipping duplicates', async () => {
    /**
     * The case the compound cursor exists for. An archive has many notes sharing a title
     * ("Receipt"), and a cursor comparing the title alone would step over every row that
     * shares the boundary title rather than resuming inside the run.
     */
    const actor = await signUp(`titlesort-${Date.now()}@example.test`, 'titlesort-pass-1', 'T');
    for (let i = 0; i < 9; i += 1) {
      await createNote(actor, { title: 'Receipt', body: `x${i}` });
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url = `${BASE}/api/notes?sort=title&order=asc&limit=4${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const page = await fetch(url, asUser(actor)).then((r) => r.json());
      for (const item of page.items) seen.add(item.id);
      cursor = page.cursor;
      if (!cursor) break;
    }

    expect(seen.size).toBe(9);
    expect(cursor).toBeNull();
  });

  it('orders by title alphabetically, ignoring case', async () => {
    const actor = await signUp(`alpha-${Date.now()}@example.test`, 'alpha-pass-123', 'A');
    for (const title of ['banana', 'Apple', 'cherry']) {
      await createNote(actor, { title, body: 'x' });
    }

    const { items } = await fetch(`${BASE}/api/notes?sort=title&order=asc`, asUser(actor)).then(
      (r) => r.json(),
    );
    // Case-insensitive: a binary sort would put 'Apple' before both lowercase titles by
    // accident and 'banana' after 'cherry' in the descending direction.
    expect(items.map((i: { title: string }) => i.title)).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('sorts by creation date independently of edits', async () => {
    const actor = await signUp(`created-${Date.now()}@example.test`, 'created-pass-1', 'C');
    const first = await createNote(actor, { title: 'First', body: 'x' });
    const second = await createNote(actor, { title: 'Second', body: 'x' });

    // Touching the older note makes it the most recently updated, but not the newest.
    await fetch(`${BASE}/api/notes/${first.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify({ body: 'edited' }),
    });

    const byUpdated = await fetch(`${BASE}/api/notes`, asUser(actor)).then((r) => r.json());
    expect(byUpdated.items[0].id).toBe(first.id);

    const byCreated = await fetch(`${BASE}/api/notes?sort=created`, asUser(actor)).then((r) =>
      r.json(),
    );
    expect(byCreated.items[0].id).toBe(second.id);
  });

  it('reverses with order=asc', async () => {
    const actor = await signUp(`ascending-${Date.now()}@example.test`, 'ascend-pass-12', 'A');
    const older = await createNote(actor, { title: 'Older', body: 'x' });
    await createNote(actor, { title: 'Newer', body: 'x' });

    const { items } = await fetch(`${BASE}/api/notes?sort=created&order=asc`, asUser(actor)).then(
      (r) => r.json(),
    );
    expect(items[0].id).toBe(older.id);
  });

  it('rejects a sort it does not implement', async () => {
    const res = await fetch(`${BASE}/api/notes?sort=havoc`, asUser(alice));
    expect(res.status).toBe(400);
  });

  /**
   * Notes with real historical dates, planted through the import endpoint because it is
   * the only path that accepts an explicit `createdAt` — a created note is always "now".
   */
  async function importDated(actor: Actor, title: string, day: string): Promise<string> {
    const at = Date.parse(`${day}T12:00:00Z`);
    const res = await fetch(`${BASE}/api/import/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify({
        title,
        body: 'x',
        createdAt: at,
        updatedAt: at,
        contentHash: `${day}${title}`.padEnd(64, '0').slice(0, 64),
      }),
    });
    if (!res.ok) throw new Error(`import failed: ${res.status} ${await res.text()}`);
    return (await res.json()).id;
  }

  it('filters to a date range, including both end days', async () => {
    const actor = await signUp(`daterange-${Date.now()}@example.test`, 'daterange-pass', 'D');
    await importDated(actor, 'Before', '2022-12-31');
    const first = await importDated(actor, 'On the first day', '2023-01-01');
    const middle = await importDated(actor, 'Middle', '2023-06-15');
    const last = await importDated(actor, 'On the last day', '2023-12-31');
    await importDated(actor, 'After', '2024-01-01');

    const { items, total } = await fetch(
      `${BASE}/api/notes?sort=created&from=2023-01-01&to=2023-12-31`,
      asUser(actor),
    ).then((r) => r.json());

    // Both boundary days are inside the range: an exclusive upper bound would silently
    // drop everything filed on 31 December.
    expect(items.map((i: { id: string }) => i.id).sort()).toEqual([first, middle, last].sort());
    // The count reflects the range too, or the header contradicts the rows beneath it.
    expect(total).toBe(3);
  });

  /**
   * Several `?tag=` params narrow conjunctively rather than as a union.
   *
   * Pinned because AND is what makes multi-tag a widening of the single-tag filter: the
   * one-tag case has to keep meaning exactly what it meant, and the two-tag case has to
   * be the intersection. A union would have returned everything here, which on a real
   * archive is the opposite of filtering.
   */
  it('narrows to notes carrying every tag given', async () => {
    const actor = await signUp(`multitag-${Date.now()}@example.test`, 'multitag-pass', 'M');
    const both = await createNote(actor, { title: 'Both', tags: ['Receipt', 'Medical'] });
    await createNote(actor, { title: 'Receipt only', tags: ['Receipt'] });
    await createNote(actor, { title: 'Medical only', tags: ['Medical'] });
    await createNote(actor, { title: 'Neither', tags: ['Travel'] });

    const two = await fetch(
      `${BASE}/api/notes?tag=Receipt&tag=Medical`,
      asUser(actor),
    ).then((r) => r.json());

    expect(two.items.map((i: { id: string }) => i.id)).toEqual([both.id]);
    // The count has to agree with the rows, or the header contradicts the list.
    expect(two.total).toBe(1);

    // One tag still means what it always did: everything carrying it.
    const one = await fetch(`${BASE}/api/notes?tag=Receipt`, asUser(actor)).then((r) => r.json());
    expect(one.total).toBe(2);
  });

  /** Search takes the same filters as the list, so it has to narrow the same way. */
  it('narrows a search by every tag given', async () => {
    const actor = await signUp(`multitagq-${Date.now()}@example.test`, 'multitagq-pass', 'Q');
    const both = await createNote(actor, {
      title: 'Dentist invoice',
      body: 'zebrafish',
      tags: ['Receipt', 'Medical'],
    });
    await createNote(actor, { title: 'Grocery receipt', body: 'zebrafish', tags: ['Receipt'] });

    const { results } = await fetch(
      `${BASE}/api/search?q=zebrafish&tag=Receipt&tag=Medical`,
      asUser(actor),
    ).then((r) => r.json());

    expect(results.map((r: { id: string }) => r.id)).toEqual([both.id]);
  });

  it('accepts an open-ended range', async () => {
    const actor = await signUp(`openrange-${Date.now()}@example.test`, 'openrange-pass', 'O');
    await importDated(actor, 'Old', '2019-05-05');
    const recent = await importDated(actor, 'Recent', '2023-05-05');

    const onlyFrom = await fetch(`${BASE}/api/notes?sort=created&from=2020-01-01`, asUser(actor)).then(
      (r) => r.json(),
    );
    expect(onlyFrom.items.map((i: { id: string }) => i.id)).toEqual([recent]);

    const onlyTo = await fetch(`${BASE}/api/notes?sort=created&to=2020-01-01`, asUser(actor)).then(
      (r) => r.json(),
    );
    expect(onlyTo.items).toHaveLength(1);
  });

  it('rejects a malformed date', async () => {
    const res = await fetch(`${BASE}/api/notes?from=last-tuesday`, asUser(alice));
    expect(res.status).toBe(400);
  });

  it('narrows search by the same range', async () => {
    const actor = await signUp(`searchrange-${Date.now()}@example.test`, 'searchrange-pw', 'S');
    const token = `rangetoken${Date.now()}`;
    const at = Date.parse('2021-03-03T12:00:00Z');
    for (const [title, when] of [
      ['Old hit', at],
      ['New hit', Date.parse('2024-03-03T12:00:00Z')],
    ] as const) {
      await fetch(`${BASE}/api/import/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
        body: JSON.stringify({
          title,
          body: token,
          createdAt: when,
          updatedAt: when,
          contentHash: `${title}${when}`.padEnd(64, '0').slice(0, 64),
        }),
      });
    }

    const all = await fetch(`${BASE}/api/search?q=${token}`, asUser(actor)).then((r) => r.json());
    expect(all.results).toHaveLength(2);

    const ranged = await fetch(
      `${BASE}/api/search?q=${token}&from=2020-01-01&to=2022-01-01`,
      asUser(actor),
    ).then((r) => r.json());
    expect(ranged.results.map((r: { title: string }) => r.title)).toEqual(['Old hit']);
  });

  it('reads a date range against the updated date under the title sort', async () => {
    // A title sort has no date of its own. The rows show when they were updated, so that
    // is what the range means; before, the range was compared against the title column
    // itself and a date-filtered title sort returned nothing at all.
    const actor = await signUp(`titlerange-${Date.now()}@example.test`, 'titlerange-pw', 'T');
    const old = await importDated(actor, 'Alpha', '2021-04-04');
    await importDated(actor, 'Beta', '2024-04-04');

    const { items, total } = await fetch(
      `${BASE}/api/notes?sort=title&from=2021-01-01&to=2021-12-31`,
      asUser(actor),
    ).then((r) => r.json());
    expect(items.map((i: { id: string }) => i.id)).toEqual([old]);
    expect(total).toBe(1);
  });

  it('counts within a tag filter', async () => {
    const actor = await signUp(`tagcount-${Date.now()}@example.test`, 'tagcount-pass-1', 'T');
    const tag = `counted-${Date.now()}`;
    for (let i = 0; i < 4; i += 1) {
      await createNote(actor, { title: `Tagged ${i}`, body: 'x', tags: [tag] });
    }
    await createNote(actor, { title: 'Untagged', body: 'x' });

    const page = await fetch(`${BASE}/api/notes?tag=${tag}&limit=2`, asUser(actor)).then((r) =>
      r.json(),
    );
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  it('excludes soft-deleted notes from the total', async () => {
    const actor = await signUp(`delcount-${Date.now()}@example.test`, 'delcount-pass-1', 'D');
    const gone = await createNote(actor, { title: 'Goes', body: 'x' });
    await createNote(actor, { title: 'Stays', body: 'x' });

    await fetch(`${BASE}/api/notes/${gone.id}`, {
      method: 'DELETE',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });

    const page = await fetch(`${BASE}/api/notes`, asUser(actor)).then((r) => r.json());
    expect(page.total).toBe(1);
  });

  it('does not count another user notes', async () => {
    const solo = await signUp(`solo-${Date.now()}@example.test`, 'solo-pass-12345', 'S');
    await createNote(alice, { title: 'Alice only', body: 'x' });

    const page = await fetch(`${BASE}/api/notes`, asUser(solo)).then((r) => r.json());
    expect(page.total).toBe(0);
  });

  it('normalizes duplicate and whitespace-only tags', async () => {
    const n = await createNote(alice, { title: 'Tag hygiene', body: 'x' });
    const patch = async (tags: string[]) =>
      fetch(`${BASE}/api/notes/${n.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
        body: JSON.stringify({ tags }),
      }).then((r) => r.json());

    expect((await patch(['dup', 'dup', 'dup'])).tags).toEqual(['dup']);
    expect((await patch([' padded '])).tags).toEqual(['padded']);
  });

  it('reuses one tag row across notes so counts are accurate', async () => {
    const tag = `shared-${Date.now()}`;
    await createNote(alice, { title: 'One', body: 'x', tags: [tag] });
    await createNote(alice, { title: 'Two', body: 'x', tags: [tag] });

    const { tags } = await fetch(`${BASE}/api/tags`, asUser(alice)).then((r) => r.json());
    const entry = tags.find((t: { name: string }) => t.name === tag);
    expect(entry.count).toBe(2);
  });

  it('drops a tag from the list once no note uses it', async () => {
    const tag = `orphan-${Date.now()}`;
    const n = await createNote(alice, { title: 'Temp', body: 'x', tags: [tag] });

    await fetch(`${BASE}/api/notes/${n.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
      body: JSON.stringify({ tags: [] }),
    });

    const { tags } = await fetch(`${BASE}/api/tags`, asUser(alice)).then((r) => r.json());
    expect(tags.map((t: { name: string }) => t.name)).not.toContain(tag);
  });

  it('excludes soft-deleted notes from tag counts', async () => {
    const tag = `counted-${Date.now()}`;
    await createNote(alice, { title: 'Stays', body: 'x', tags: [tag] });
    const gone = await createNote(alice, { title: 'Goes', body: 'x', tags: [tag] });

    await fetch(`${BASE}/api/notes/${gone.id}`, {
      method: 'DELETE',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });

    const { tags } = await fetch(`${BASE}/api/tags`, asUser(alice)).then((r) => r.json());
    expect(tags.find((t: { name: string }) => t.name === tag).count).toBe(1);
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

/**
 * Trash: listing, restore, and permanent delete.
 *
 * The safety property is that `DELETE /notes/:id` is reversible and only
 * `/notes/:id/permanent` destroys anything — and the latter refuses to touch a live note,
 * so a stray call cannot destroy work that was never deleted.
 */
describe('trash', () => {
  it('hides a deleted note from the normal list but keeps it in the trash', async () => {
    const note = await createNote(alice, { title: 'To be trashed', body: 'x' });
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });

    const live = await fetch(`${BASE}/api/notes`, asUser(alice)).then((r) => r.json());
    expect(live.items.some((n: { id: string }) => n.id === note.id)).toBe(false);

    const trash = await fetch(`${BASE}/api/notes?trashed=1`, asUser(alice)).then((r) => r.json());
    expect(trash.items.some((n: { id: string }) => n.id === note.id)).toBe(true);
  });

  it('reports when a trashed note was deleted', async () => {
    const note = await createNote(alice, { title: 'Timestamped', body: 'x' });
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });

    const trash = await fetch(`${BASE}/api/notes?trashed=1`, asUser(alice)).then((r) => r.json());
    const found = trash.items.find((n: { id: string }) => n.id === note.id);
    expect(found.deletedAt).toBeGreaterThan(0);
  });

  it('restores a note back into the live list', async () => {
    const note = await createNote(alice, { title: 'Comes back', body: 'x' });
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });

    const res = await fetch(`${BASE}/api/notes/${note.id}/restore`, {
      method: 'POST',
      ...asUser(alice),
    });
    expect(res.status).toBe(200);

    const live = await fetch(`${BASE}/api/notes`, asUser(alice)).then((r) => r.json());
    expect(live.items.some((n: { id: string }) => n.id === note.id)).toBe(true);

    const trash = await fetch(`${BASE}/api/notes?trashed=1`, asUser(alice)).then((r) => r.json());
    expect(trash.items.some((n: { id: string }) => n.id === note.id)).toBe(false);
  });

  it('refuses to restore a note that was never deleted', async () => {
    const note = await createNote(alice, { title: 'Never deleted', body: 'x' });
    const res = await fetch(`${BASE}/api/notes/${note.id}/restore`, {
      method: 'POST',
      ...asUser(alice),
    });
    expect(res.status).toBe(404);
  });

  it('refuses to permanently delete a live note', async () => {
    const note = await createNote(alice, { title: 'Still live', body: 'x' });

    const res = await fetch(`${BASE}/api/notes/${note.id}/permanent`, {
      method: 'DELETE',
      ...asUser(alice),
    });
    // The two-step delete is the safety property: permanent deletion only ever acts on
    // something already in the trash.
    expect(res.status).toBe(404);

    const still = await fetch(`${BASE}/api/notes/${note.id}`, asUser(alice));
    expect(still.status).toBe(200);
  });

  it('permanently deletes a trashed note', async () => {
    const note = await createNote(alice, { title: 'Gone for good', body: 'x' });
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });

    const res = await fetch(`${BASE}/api/notes/${note.id}/permanent`, {
      method: 'DELETE',
      ...asUser(alice),
    });
    expect(res.status).toBe(204);

    const trash = await fetch(`${BASE}/api/notes?trashed=1`, asUser(alice)).then((r) => r.json());
    expect(trash.items.some((n: { id: string }) => n.id === note.id)).toBe(false);

    const gone = await fetch(`${BASE}/api/notes/${note.id}`, asUser(alice));
    expect(gone.status).toBe(404);
  });

  it("does not expose another user's trash", async () => {
    const note = await createNote(alice, { title: "Alice's trashed note", body: 'x' });
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });

    const bobTrash = await fetch(`${BASE}/api/notes?trashed=1`, asUser(bob)).then((r) => r.json());
    expect(bobTrash.items.some((n: { id: string }) => n.id === note.id)).toBe(false);

    // And bob cannot act on it by id.
    const restore = await fetch(`${BASE}/api/notes/${note.id}/restore`, {
      method: 'POST',
      ...asUser(bob),
    });
    expect(restore.status).toBe(404);

    const purge = await fetch(`${BASE}/api/notes/${note.id}/permanent`, {
      method: 'DELETE',
      ...asUser(bob),
    });
    expect(purge.status).toBe(404);
  });
});

/**
 * Notebooks as an entity.
 *
 * The behaviours here are the ones that were impossible when a notebook was a string on
 * each note: existing while empty, being renamed, and being deleted without taking its
 * notes with it.
 */
describe('notebooks', () => {
  async function listNotebooks(actor: Actor) {
    const res = await fetch(`${BASE}/api/notebooks`, asUser(actor));
    return (await res.json()).notebooks as Array<{ id: string; name: string; count: number }>;
  }

  it('creates an empty notebook that still lists with a zero count', async () => {
    const name = `Empty ${Date.now()}`;
    const res = await fetch(`${BASE}/api/notebooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asUser(alice).headers },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);

    // The headline bug: a notebook with no notes used to be invisible.
    const found = (await listNotebooks(alice)).find((n) => n.name === name);
    expect(found?.count).toBe(0);
  });

  it('counts unfiled notes alongside the notebooks', async () => {
    // A delta rather than an absolute: other tests in this file leave notes of their own,
    // and the count the UI cares about is only ever "is there anything here".
    async function unfiledCount() {
      const res = await fetch(`${BASE}/api/notebooks`, asUser(alice));
      return (await res.json()).unfiled as number;
    }

    const before = await unfiledCount();
    const note = await createNote(alice, { title: 'loose', body: 'x' });
    expect(await unfiledCount()).toBe(before + 1);

    // Trashing takes it back out: the option should disappear again with the note.
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });
    expect(await unfiledCount()).toBe(before);

    // And restoring brings it back, so the option returns with the note.
    await fetch(`${BASE}/api/notes/${note.id}/restore`, { method: 'POST', ...asUser(alice) });
    expect(await unfiledCount()).toBe(before + 1);
  });

  it('drops a trashed note from its notebook count', async () => {
    const name = `Counted ${Date.now()}`;
    const note = await createNote(alice, { title: 'filed', body: 'x', notebook: name });
    expect((await listNotebooks(alice)).find((n) => n.name === name)?.count).toBe(1);

    // The notebook outlives the note, at zero — see 'survives its last note being
    // trashed'. What matters here is that the count follows the note out.
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });
    expect((await listNotebooks(alice)).find((n) => n.name === name)?.count).toBe(0);

    await fetch(`${BASE}/api/notes/${note.id}/restore`, { method: 'POST', ...asUser(alice) });
    expect((await listNotebooks(alice)).find((n) => n.name === name)?.count).toBe(1);
  });

  it('survives its last note being trashed', async () => {
    const name = `Outlives ${Date.now()}`;
    const note = await createNote(alice, { title: 'only note', body: 'x', notebook: name });
    await fetch(`${BASE}/api/notes/${note.id}`, { method: 'DELETE', ...asUser(alice) });

    const found = (await listNotebooks(alice)).find((n) => n.name === name);
    expect(found).toBeDefined();
    expect(found?.count).toBe(0);
  });

  it('rejects a name that differs only in case', async () => {
    const name = `Case ${Date.now()}`;
    const first = await fetch(`${BASE}/api/notebooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asUser(alice).headers },
      body: JSON.stringify({ name }),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${BASE}/api/notebooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asUser(alice).headers },
      body: JSON.stringify({ name: name.toLowerCase() }),
    });
    expect(second.status).toBe(409);
  });

  it('files a note into the existing notebook when the case differs', async () => {
    const name = `Reuse ${Date.now()}`;
    await createNote(alice, { title: 'a', body: 'x', notebook: name });
    await createNote(alice, { title: 'b', body: 'x', notebook: name.toLowerCase() });

    const matching = (await listNotebooks(alice)).filter(
      (n) => n.name.toLowerCase() === name.toLowerCase(),
    );
    // One notebook holding both notes, not two notebooks holding one each.
    expect(matching).toHaveLength(1);
    expect(matching[0]!.count).toBe(2);
  });

  it('renames a notebook and every note follows', async () => {
    const before = `Before ${Date.now()}`;
    const after = `After ${Date.now()}`;
    await createNote(alice, { title: 'follows', body: 'x', notebook: before });
    const nb = (await listNotebooks(alice)).find((n) => n.name === before)!;

    const res = await fetch(`${BASE}/api/notebooks/${nb.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...asUser(alice).headers },
      body: JSON.stringify({ name: after }),
    });
    expect(res.status).toBe(200);

    const listed = await fetch(
      `${BASE}/api/notes?notebook=${encodeURIComponent(after)}`,
      asUser(alice),
    ).then((r) => r.json());
    expect(listed.items.some((n: { title: string }) => n.title === 'follows')).toBe(true);
  });

  it('unfiles notes rather than deleting them', async () => {
    const name = `Doomed ${Date.now()}`;
    const a = await createNote(alice, { title: 'survivor a', body: 'x', notebook: name });
    const b = await createNote(alice, { title: 'survivor b', body: 'x', notebook: name });
    const nb = (await listNotebooks(alice)).find((n) => n.name === name)!;

    const res = await fetch(`${BASE}/api/notebooks/${nb.id}`, {
      method: 'DELETE',
      ...asUser(alice),
    });
    expect(res.status).toBe(204);

    // Deleting an organisational label must never destroy what it organised.
    for (const id of [a.id, b.id]) {
      const note = await fetch(`${BASE}/api/notes/${id}`, asUser(alice));
      expect(note.status).toBe(200);
      expect((await note.json()).notebook).toBeNull();
    }
    expect((await listNotebooks(alice)).some((n) => n.name === name)).toBe(false);
  });

  it('can trash notes while deleting the notebook', async () => {
    const name = `Cascade ${Date.now()}`;
    const a = await createNote(alice, { title: 'to trash a', body: 'x', notebook: name });
    const b = await createNote(alice, { title: 'to trash b', body: 'x', notebook: name });
    const nb = (await listNotebooks(alice)).find((n) => n.name === name)!;

    const res = await fetch(`${BASE}/api/notebooks/${nb.id}?trashNotes=1`, {
      method: 'DELETE',
      ...asUser(alice),
    });
    expect(res.status).toBe(204);

    // Soft-deleted: gone from the live list, present in the trash, notebook gone.
    for (const id of [a.id, b.id]) {
      expect((await fetch(`${BASE}/api/notes/${id}`, asUser(alice))).status).toBe(404);
    }
    const trash = await fetch(`${BASE}/api/notes?trashed=1`, asUser(alice)).then((r) => r.json());
    expect(trash.items.some((n: { id: string }) => n.id === a.id)).toBe(true);
    expect(trash.items.some((n: { id: string }) => n.id === b.id)).toBe(true);
    expect((await listNotebooks(alice)).some((n) => n.name === name)).toBe(false);

    // Restoring leaves the note unfiled — the notebook no longer exists.
    const restore = await fetch(`${BASE}/api/notes/${a.id}/restore`, {
      method: 'POST',
      ...asUser(alice),
    });
    expect(restore.status).toBe(200);
    expect((await restore.json()).notebook).toBeNull();
  });

  it("does not expose or accept changes to another user's notebooks", async () => {
    const name = `Alice only ${Date.now()}`;
    await createNote(alice, { title: 'hers', body: 'x', notebook: name });
    const nb = (await listNotebooks(alice)).find((n) => n.name === name)!;

    expect((await listNotebooks(bob)).some((n) => n.id === nb.id)).toBe(false);

    const rename = await fetch(`${BASE}/api/notebooks/${nb.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...asUser(bob).headers },
      body: JSON.stringify({ name: 'stolen' }),
    });
    expect(rename.status).toBe(404);

    const del = await fetch(`${BASE}/api/notebooks/${nb.id}`, { method: 'DELETE', ...asUser(bob) });
    expect(del.status).toBe(404);
  });

  /**
   * Re-import after deleting the notebook must bring the notebook back.
   *
   * Import is idempotent on content hash, so a second pass skips the note. Skipping used
   * to skip notebook resolution too — deleting the notebook (which unfiles notes) then
   * re-importing left notes unfiled with no notebook row forever.
   */
  it('re-import recreates a deleted notebook and refiles unfiled notes', async () => {
    const name = `Reimport ${Date.now()}`;
    const contentHash = 'a'.repeat(64);
    const payload = {
      title: 'Imported once',
      body: 'same body',
      tags: [] as string[],
      notebook: name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contentHash,
      sourceEnex: `${name}.enex`,
    };

    const first = await fetch(`${BASE}/api/import/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asUser(alice).headers },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string; created: boolean };

    const nb = (await listNotebooks(alice)).find((n) => n.name === name)!;
    await fetch(`${BASE}/api/notebooks/${nb.id}`, { method: 'DELETE', ...asUser(alice) });
    expect((await listNotebooks(alice)).some((n) => n.name === name)).toBe(false);
    expect((await fetch(`${BASE}/api/notes/${id}`, asUser(alice)).then((r) => r.json())).notebook).toBeNull();

    const second = await fetch(`${BASE}/api/import/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asUser(alice).headers },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    expect((await second.json()).created).toBe(false);

    const restored = (await listNotebooks(alice)).find((n) => n.name === name);
    expect(restored).toBeDefined();
    expect(restored!.count).toBe(1);
    expect((await fetch(`${BASE}/api/notes/${id}`, asUser(alice)).then((r) => r.json())).notebook).toBe(
      name,
    );
  });
});

/**
 * Custom fields: definitions on a notebook, values on a note.
 *
 * Every route here touches user data, so the cross-tenant case at the end is not optional
 * — see the file header. Values are exercised through the notes routes because that is
 * how they are written: a field is only ever set through the note that holds it.
 */
describe('notebook fields', () => {
  function json(actor: Actor, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  interface Field {
    id: string;
    name: string;
    type: string;
    options: string[];
    position: number;
    valueCount?: number;
  }
  interface Value {
    fieldId: string;
    name: string;
    type: string;
    value: string | number | boolean;
    notebookId: string;
    notebook: string;
  }

  async function makeNotebook(actor: Actor, name: string): Promise<{ id: string; name: string }> {
    const res = await json(actor, 'POST', '/api/notebooks', { name });
    if (res.status !== 201) throw new Error(`notebook: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function makeField(
    actor: Actor,
    notebookId: string,
    def: { name: string; type: string; options?: string[] },
  ): Promise<Field> {
    const res = await json(actor, 'POST', `/api/notebooks/${notebookId}/fields`, def);
    if (res.status !== 201) throw new Error(`field: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async function getFields(actor: Actor, notebookId: string): Promise<Field[]> {
    const res = await json(actor, 'GET', `/api/notebooks/${notebookId}/fields`);
    if (!res.ok) throw new Error(`fields: ${res.status}`);
    return (await res.json()).fields;
  }

  async function getNote(actor: Actor, id: string) {
    return json(actor, 'GET', `/api/notes/${id}`).then((r) => r.json());
  }

  const byName = (values: Value[] | undefined) =>
    Object.fromEntries((values ?? []).map((v) => [v.name, v.value]));

  let nb: { id: string; name: string };
  let f: Record<string, Field>;

  beforeAll(async () => {
    nb = await makeNotebook(alice, `Receipts ${Date.now()}`);
    f = {};
    for (const def of [
      { name: 'Merchant', type: 'text' },
      { name: 'Amount', type: 'number' },
      { name: 'Paid on', type: 'date' },
      { name: 'Reimbursed', type: 'checkbox' },
      { name: 'Receipt', type: 'url' },
      { name: 'Contact', type: 'email' },
      { name: 'Phone', type: 'phone' },
      { name: 'Category', type: 'select', options: ['Food', 'Travel'] },
    ]) {
      f[def.name] = await makeField(alice, nb.id, def);
    }
  }, 30_000);

  it('lists fields in the order they were made, with types, options and counts', async () => {
    const fields = await getFields(alice, nb.id);
    expect(fields.map((x) => x.name)).toEqual([
      'Merchant', 'Amount', 'Paid on', 'Reimbursed', 'Receipt', 'Contact', 'Phone', 'Category',
    ]);
    expect(fields.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(fields.find((x) => x.name === 'Category')!.options).toEqual(['Food', 'Travel']);
    expect(fields.find((x) => x.name === 'Merchant')!.options).toEqual([]);
    expect(fields.every((x) => x.valueCount === 0)).toBe(true);

    const listed = (await json(alice, 'GET', '/api/notebooks').then((r) => r.json())).notebooks;
    expect(listed.find((n: { id: string }) => n.id === nb.id).fields).toBe(8);
  });

  it('refuses a reserved name, a name taken in another case, and an unknown type', async () => {
    expect((await json(alice, 'POST', `/api/notebooks/${nb.id}/fields`, { name: 'Title', type: 'text' })).status).toBe(400);
    expect((await json(alice, 'POST', `/api/notebooks/${nb.id}/fields`, { name: 'merchant', type: 'text' })).status).toBe(409);
    expect((await json(alice, 'POST', `/api/notebooks/${nb.id}/fields`, { name: 'Odd', type: 'rollup' })).status).toBe(400);
  });

  it('caps a notebook at fifty fields', async () => {
    const full = await makeNotebook(alice, `Full ${Date.now()}`);
    for (let i = 0; i < 50; i++) await makeField(alice, full.id, { name: `F${i}`, type: 'text' });
    const res = await json(alice, 'POST', `/api/notebooks/${full.id}/fields`, { name: 'One more', type: 'text' });
    expect(res.status).toBe(400);
  }, 60_000);

  it('stores a value of every type and reads them back typed', async () => {
    const res = await json(alice, 'POST', '/api/notes', {
      title: 'Lunch',
      body: 'x',
      notebook: nb.name,
      fields: {
        [f['Merchant']!.id]: 'Acme',
        [f['Amount']!.id]: '12.50',
        [f['Paid on']!.id]: '2024-03-01',
        [f['Reimbursed']!.id]: true,
        [f['Receipt']!.id]: 'https://x.test/r/1',
        [f['Contact']!.id]: 'ap@acme.test',
        [f['Phone']!.id]: '+1 555 0100',
        [f['Category']!.id]: 'Food',
      },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.notebookId).toBe(nb.id);
    expect(byName(created.fields)).toEqual({
      Merchant: 'Acme',
      Amount: 12.5,
      'Paid on': '2024-03-01',
      Reimbursed: true,
      Receipt: 'https://x.test/r/1',
      Contact: 'ap@acme.test',
      Phone: '+1 555 0100',
      Category: 'Food',
    });
    // In definition order, and each value knows its notebook.
    expect((created.fields as Value[]).map((v) => v.name)).toEqual([
      'Merchant', 'Amount', 'Paid on', 'Reimbursed', 'Receipt', 'Contact', 'Phone', 'Category',
    ]);
    expect((created.fields as Value[]).every((v) => v.notebookId === nb.id && v.notebook === nb.name)).toBe(true);

    const fetched = await getNote(alice, created.id);
    expect(byName(fetched.fields)).toEqual(byName(created.fields));

    const { items } = await json(alice, 'GET', `/api/notes?notebook=${encodeURIComponent(nb.name)}`).then((r) => r.json());
    const row = items.find((i: { id: string }) => i.id === created.id);
    expect(byName(row.fields).Amount).toBe(12.5);
    expect(row.notebookId).toBe(nb.id);

    expect((await getFields(alice, nb.id)).find((x) => x.name === 'Amount')!.valueCount).toBe(1);
  });

  it('rejects a value the field cannot hold, naming the field, and leaves the note untouched', async () => {
    const created = await json(alice, 'POST', '/api/notes', { title: 'Before', body: '', notebook: nb.name }).then((r) => r.json());

    const bad = await json(alice, 'PATCH', `/api/notes/${created.id}`, {
      title: 'After',
      fields: { [f['Amount']!.id]: 'twelve' },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/^Amount must be a number/);
    expect((await getNote(alice, created.id)).title).toBe('Before');

    for (const [id, value] of [
      [f['Category']!.id, 'Vet'],
      [f['Contact']!.id, 'not an address'],
      [f['Receipt']!.id, 'javascript:alert(1)'],
      [f['Paid on']!.id, 'March 1'],
      [f['Reimbursed']!.id, 'yes'],
    ]) {
      expect((await json(alice, 'PATCH', `/api/notes/${created.id}`, { fields: { [id!]: value } })).status).toBe(400);
    }

    const unknown = await json(alice, 'PATCH', `/api/notes/${created.id}`, {
      fields: { [crypto.randomUUID()]: 'x' },
    });
    expect(unknown.status).toBe(400);
  });

  it('keeps a select value after that option is removed, so a later save of the note still writes', async () => {
    const kind = await makeField(alice, nb.id, {
      name: `Kind ${Date.now()}`,
      type: 'select',
      options: ['A', 'B'],
    });
    const created = await json(alice, 'POST', '/api/notes', {
      title: 'Before',
      body: 'old',
      notebook: nb.name,
      fields: { [kind.id]: 'B' },
    }).then((r) => r.json());

    expect(
      (await json(alice, 'PATCH', `/api/notebooks/${nb.id}/fields/${kind.id}`, { options: ['A'] })).status,
    ).toBe(200);

    const saved = await json(alice, 'PATCH', `/api/notes/${created.id}`, {
      title: 'After',
      body: 'new',
      fields: { [kind.id]: 'B' },
    });
    expect(saved.status).toBe(200);
    const note = await saved.json();
    expect(note.title).toBe('After');
    expect(note.body).toBe('new');
    expect(byName(note.fields)[kind.name]).toBe('B');

    // A value the note never held is still a new choice and still rejected.
    expect(
      (await json(alice, 'PATCH', `/api/notes/${created.id}`, { fields: { [kind.id]: 'C' } })).status,
    ).toBe(400);
    expect((await getNote(alice, created.id)).title).toBe('After');

    const cleared = await json(alice, 'PATCH', `/api/notes/${created.id}`, { fields: { [kind.id]: null } });
    expect(cleared.status).toBe(200);
    expect(byName((await cleared.json()).fields)[kind.name]).toBeUndefined();
  });

  it('merges a patch, and clears a value with null or an empty string', async () => {
    const created = await json(alice, 'POST', '/api/notes', {
      title: 'Merge',
      body: '',
      notebook: nb.name,
      fields: { [f['Merchant']!.id]: 'Acme', [f['Amount']!.id]: 3 },
    }).then((r) => r.json());

    // Only the key in the patch changes.
    let note = await json(alice, 'PATCH', `/api/notes/${created.id}`, { fields: { [f['Amount']!.id]: 4 } }).then((r) => r.json());
    expect(byName(note.fields)).toEqual({ Merchant: 'Acme', Amount: 4 });

    note = await json(alice, 'PATCH', `/api/notes/${created.id}`, {
      fields: { [f['Amount']!.id]: null, [f['Merchant']!.id]: '   ' },
    }).then((r) => r.json());
    expect(note.fields).toBeUndefined();
  });

  it('keeps values when the note moves, marking them with the notebook they belong to', async () => {
    const created = await json(alice, 'POST', '/api/notes', {
      title: 'Mover',
      body: '',
      notebook: nb.name,
      fields: { [f['Merchant']!.id]: 'Acme' },
    }).then((r) => r.json());

    const moved = await json(alice, 'PATCH', `/api/notes/${created.id}`, { notebook: `Elsewhere ${Date.now()}` }).then((r) => r.json());
    expect(moved.notebookId).not.toBe(nb.id);
    expect(byName(moved.fields)).toEqual({ Merchant: 'Acme' });
    expect((moved.fields as Value[])[0]!.notebookId).toBe(nb.id);
    expect((moved.fields as Value[])[0]!.notebook).toBe(nb.name);

    const unfiled = await json(alice, 'PATCH', `/api/notes/${created.id}`, { notebook: null }).then((r) => r.json());
    expect(unfiled.notebookId).toBeNull();
    expect(byName(unfiled.fields)).toEqual({ Merchant: 'Acme' });
  });

  it('previews a type change, then applies it, clearing what cannot be read', async () => {
    const code = await makeField(alice, nb.id, { name: 'Code', type: 'text' });
    const ids: string[] = [];
    for (const value of ['12', 'abc', '7']) {
      const n = await json(alice, 'POST', '/api/notes', { title: value, body: '', notebook: nb.name, fields: { [code.id]: value } }).then((r) => r.json());
      ids.push(n.id);
    }

    const preview = await json(alice, 'GET', `/api/notebooks/${nb.id}/fields/${code.id}/conversion?type=number`).then((r) => r.json());
    expect(preview).toEqual({ values: 3, incompatible: 1 });
    // A preview writes nothing.
    expect(byName((await getNote(alice, ids[1]!)).fields).Code).toBe('abc');

    const changed = await json(alice, 'PATCH', `/api/notebooks/${nb.id}/fields/${code.id}`, { type: 'number' }).then((r) => r.json());
    expect(changed.field.type).toBe('number');
    expect(changed.cleared).toBe(1);

    expect(byName((await getNote(alice, ids[0]!)).fields).Code).toBe(12);
    expect(byName((await getNote(alice, ids[1]!)).fields).Code).toBeUndefined();
    expect(byName((await getNote(alice, ids[2]!)).fields).Code).toBe(7);
    expect((await json(alice, 'GET', `/api/notebooks/${nb.id}/fields/${code.id}/conversion?type=rollup`)).status).toBe(400);
  });

  it('seeds the options from existing values when a field becomes a select', async () => {
    const kind = await makeField(alice, nb.id, { name: 'Kind', type: 'text' });
    for (const value of ['GP', 'Dentist', 'GP']) {
      await json(alice, 'POST', '/api/notes', { title: value, body: '', notebook: nb.name, fields: { [kind.id]: value } });
    }
    const changed = await json(alice, 'PATCH', `/api/notebooks/${nb.id}/fields/${kind.id}`, { type: 'select' }).then((r) => r.json());
    expect(changed.cleared).toBe(0);
    expect(new Set(changed.field.options)).toEqual(new Set(['GP', 'Dentist']));
    expect((await getFields(alice, nb.id)).find((x) => x.id === kind.id)!.valueCount).toBe(3);
  });

  it('renames a field, replaces its options, and reorders the notebook', async () => {
    const own = await makeNotebook(alice, `Order ${Date.now()}`);
    const a = await makeField(alice, own.id, { name: 'A', type: 'select', options: ['x'] });
    const b = await makeField(alice, own.id, { name: 'B', type: 'text' });
    const c = await makeField(alice, own.id, { name: 'C', type: 'text' });

    const renamed = await json(alice, 'PATCH', `/api/notebooks/${own.id}/fields/${a.id}`, { name: 'Alpha', options: ['x', 'y', 'x'] }).then((r) => r.json());
    expect(renamed.field.name).toBe('Alpha');
    expect(renamed.field.options).toEqual(['x', 'y']);
    expect((await json(alice, 'PATCH', `/api/notebooks/${own.id}/fields/${b.id}`, { name: 'alpha' })).status).toBe(409);
    // Re-casing a field's own name is not a clash.
    expect((await json(alice, 'PATCH', `/api/notebooks/${own.id}/fields/${a.id}`, { name: 'ALPHA' })).status).toBe(200);

    expect((await json(alice, 'PUT', `/api/notebooks/${own.id}/fields/order`, { ids: [c.id, a.id, b.id] })).status).toBe(204);
    expect((await getFields(alice, own.id)).map((x) => x.id)).toEqual([c.id, a.id, b.id]);
    // An order that does not name every field once is a stale client.
    expect((await json(alice, 'PUT', `/api/notebooks/${own.id}/fields/order`, { ids: [c.id, a.id] })).status).toBe(400);
    expect((await json(alice, 'PUT', `/api/notebooks/${own.id}/fields/order`, { ids: [c.id, a.id, b.id, crypto.randomUUID()] })).status).toBe(400);
  });

  it('deletes a field together with its values', async () => {
    const gone = await makeField(alice, nb.id, { name: 'Gone', type: 'text' });
    const note = await json(alice, 'POST', '/api/notes', { title: 'Has gone', body: '', notebook: nb.name, fields: { [gone.id]: 'yes', [f['Merchant']!.id]: 'Acme' } }).then((r) => r.json());
    expect(byName(note.fields).Gone).toBe('yes');

    expect((await json(alice, 'DELETE', `/api/notebooks/${nb.id}/fields/${gone.id}`)).status).toBe(204);
    expect((await json(alice, 'DELETE', `/api/notebooks/${nb.id}/fields/${gone.id}`)).status).toBe(404);
    expect(byName((await getNote(alice, note.id)).fields)).toEqual({ Merchant: 'Acme' });
    expect((await getFields(alice, nb.id)).some((x) => x.id === gone.id)).toBe(false);
  });

  it('deletes a notebook together with its fields and their values', async () => {
    const doomed = await makeNotebook(alice, `Doomed ${Date.now()}`);
    const field = await makeField(alice, doomed.id, { name: 'X', type: 'text' });
    const note = await json(alice, 'POST', '/api/notes', { title: 'In doomed', body: '', notebook: doomed.name, fields: { [field.id]: 'v' } }).then((r) => r.json());

    expect((await json(alice, 'DELETE', `/api/notebooks/${doomed.id}`)).status).toBe(204);
    expect((await json(alice, 'GET', `/api/notebooks/${doomed.id}/fields`)).status).toBe(404);
    const after = await getNote(alice, note.id);
    expect(after.notebook).toBeNull();
    expect(after.fields).toBeUndefined();
  });

  it('imports values by name, creating the definitions it lacks and naming what it skipped', async () => {
    const payload = {
      title: 'Imported receipt',
      body: 'from a vault',
      tags: [] as string[],
      notebook: nb.name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contentHash: 'c'.repeat(64),
      fields: { Merchant: 'Acme', Total: 12.5, title: 'shadow', Category: 'Vet' },
    };
    const res = await json(alice, 'POST', '/api/import/note', payload);
    expect(res.status).toBe(201);
    const { id, skippedFields } = await res.json();
    // Reserved, and a select value not among the options.
    expect(skippedFields.sort()).toEqual(['Category', 'title']);

    expect(byName((await getNote(alice, id)).fields)).toEqual({ Merchant: 'Acme', Total: 12.5 });
    const total = (await getFields(alice, nb.id)).find((x) => x.name === 'Total');
    expect(total?.type).toBe('number');

    // A re-run restores a value a deleted field lost, but never overwrites an edit.
    await json(alice, 'PATCH', `/api/notes/${id}`, { fields: { [f['Merchant']!.id]: 'Edited' } });
    await json(alice, 'DELETE', `/api/notebooks/${nb.id}/fields/${total!.id}`);
    const again = await json(alice, 'POST', '/api/import/note', payload);
    expect(again.status).toBe(200);
    expect(byName((await getNote(alice, id)).fields)).toEqual({ Merchant: 'Edited', Total: 12.5 });
  });

  it("does not expose or accept changes to another user's fields", async () => {
    const merchant = f['Merchant']!;
    const aliceNote = await json(alice, 'POST', '/api/notes', { title: 'Hers', body: '', notebook: nb.name, fields: { [merchant.id]: 'Acme' } }).then((r) => r.json());

    expect((await json(bob, 'GET', `/api/notebooks/${nb.id}/fields`)).status).toBe(404);
    expect((await json(bob, 'POST', `/api/notebooks/${nb.id}/fields`, { name: 'Mine', type: 'text' })).status).toBe(404);
    expect((await json(bob, 'PATCH', `/api/notebooks/${nb.id}/fields/${merchant.id}`, { name: 'Stolen' })).status).toBe(404);
    expect((await json(bob, 'GET', `/api/notebooks/${nb.id}/fields/${merchant.id}/conversion?type=number`)).status).toBe(404);
    expect((await json(bob, 'PUT', `/api/notebooks/${nb.id}/fields/order`, { ids: [merchant.id] })).status).toBe(404);
    expect((await json(bob, 'DELETE', `/api/notebooks/${nb.id}/fields/${merchant.id}`)).status).toBe(404);

    // Bob's own note cannot hold a value under alice's field: the id is treated as unknown.
    const bobNote = await json(bob, 'POST', '/api/notes', { title: 'His', body: '' }).then((r) => r.json());
    expect((await json(bob, 'PATCH', `/api/notes/${bobNote.id}`, { fields: { [merchant.id]: 'x' } })).status).toBe(400);
    expect((await json(bob, 'POST', '/api/notes', { title: 'His 2', body: '', fields: { [merchant.id]: 'x' } })).status).toBe(400);

    // And nothing of alice's moved.
    expect((await getFields(alice, nb.id)).find((x) => x.id === merchant.id)!.name).toBe('Merchant');
    expect(byName((await getNote(alice, aliceNote.id)).fields)).toEqual({ Merchant: 'Acme' });
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
    ['GET', '/api/notebooks', {}],
    ['GET', '/api/notebooks/whatever/fields', {}],
    ['POST', '/api/notebooks/whatever/fields', { method: 'POST', body: '{}' }],
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
      notebook: 'Alice Notebook',
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

  it('alice notebooks never appear in bob notebooks', async () => {
    const { notebooks } = await fetch(`${BASE}/api/notebooks`, asUser(bob)).then((r) => r.json());
    expect(notebooks.map((n: { name: string }) => n.name)).not.toContain('Alice Notebook');
  });

  it('a bob notebook filter cannot surface an alice note', async () => {
    const { items } = await fetch(
      `${BASE}/api/notes?notebook=${encodeURIComponent('Alice Notebook')}`,
      asUser(bob),
    ).then((r) => r.json());
    expect(items).toEqual([]);
  });

  it.todo('attachments: bob cannot fetch a blob under an alice note id');
  it.todo('search: alice notes never appear in bob results');
  it.todo('export: a bob zip contains no alice notes');
  it.todo('import: bob cannot write into an alice note id');
});

/**
 * Account deletion.
 *
 * The sweep that empties the account's R2 prefix is unit-tested in `src/lib/blobs.test.ts`
 * instead of here, because no request can observe it: `gc-blobs` only ever reports on the
 * caller's own prefix, so once the account is gone nothing distinguishes a swept prefix
 * from a stranded one. What belongs in a live suite is the other half — that a session on
 * its own cannot destroy an account, which is a property of the real endpoint and its
 * middleware rather than of any function here.
 */
describe('account deletion', () => {
  async function upload(actor: Actor, noteId: string, filename: string, content: string) {
    const res = await fetch(`${BASE}/api/notes/${noteId}/files`, {
      method: 'PUT',
      headers: {
        Cookie: actor.cookie,
        Origin: ORIGIN,
        'X-Filename': encodeURIComponent(filename),
        'Content-Type': 'text/plain',
      },
      body: content,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return res.json();
  }

  async function requestDeletion(actor: Actor, body: Record<string, string> = {}) {
    return fetch(`${BASE}/api/auth/delete-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
      body: JSON.stringify(body),
    });
  }

  /** Everything the account still owns, read back the way its owner would. */
  async function stillThere(actor: Actor, noteId: string) {
    const me = await fetch(`${BASE}/api/me`, asUser(actor)).then((r) => r.json());
    const note = await fetch(`${BASE}/api/notes/${noteId}`, asUser(actor));
    const gc = await fetch(`${BASE}/api/admin/gc-blobs`, {
      method: 'POST',
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    return { user: me.user?.id ?? null, note: note.status, stored: gc.stored };
  }

  /**
   * The case this suite exists for. A session is not a confirmation: the request is
   * answered with mail, and until the link in it comes back the account is untouched.
   * Without this, an empty POST carrying a bearer token from the phone or the CLI was a
   * whole-account wipe for the first day of that token's life.
   */
  it('answers a bare request with mail and deletes nothing', async () => {
    const stamp = Date.now();
    const actor = await signUp(`delete-me-${stamp}@example.test`, 'delete-me-password-123', 'DeleteMe');
    const note = await createNote(actor, { title: 'Keep me', body: 'x', tags: ['tag1'] });
    await upload(actor, note.id, 'important.pdf', '%PDF-1.4 fake content');

    const res = await requestDeletion(actor);
    expect(res.ok).toBe(true);
    expect((await res.json()).message).toBe('Verification email sent');

    expect(await stillThere(actor, note.id)).toEqual({
      user: actor.userId,
      note: 200,
      stored: 1,
    });
  });

  /**
   * And a password is not a shortcut past it. Better Auth checks one when it is sent, but
   * a checked password only proves the session's owner is present — the same thing the
   * session already claimed — so it does not stand in for owning the address.
   */
  it('does not accept a password in place of the link', async () => {
    const stamp = Date.now();
    const password = 'blob-test-password-123';
    const actor = await signUp(`blob-test-${stamp}@example.test`, password, 'BlobTest');
    const note = await createNote(actor, { title: 'With files', body: 'x' });
    await upload(actor, note.id, 'important.pdf', '%PDF-1.4 fake content');

    const res = await requestDeletion(actor, { password });
    expect(res.ok).toBe(true);
    expect((await res.json()).message).toBe('Verification email sent');

    expect(await stillThere(actor, note.id)).toEqual({
      user: actor.userId,
      note: 200,
      stored: 1,
    });
  });

  /** The token is the whole guard, so a made-up one must not spend anything. */
  it('rejects a token it never issued', async () => {
    const stamp = Date.now();
    const actor = await signUp(`bad-token-${stamp}@example.test`, 'bad-token-password-123', 'BadToken');
    const note = await createNote(actor, { title: 'Keep me too', body: 'x' });

    const res = await requestDeletion(actor, { token: 'not-a-token-anyone-issued' });
    expect(res.ok).toBe(false);

    const after = await stillThere(actor, note.id);
    expect(after.user).toBe(actor.userId);
    expect(after.note).toBe(200);
  });
});

describe('tags', () => {
  async function listTags(actor: Actor) {
    const res = await fetch(`${BASE}/api/tags`, asUser(actor));
    return (await res.json()).tags as Array<{ id: string; name: string; count: number }>;
  }

  async function noteTags(actor: Actor, id: string) {
    const res = await fetch(`${BASE}/api/notes/${id}`, asUser(actor));
    return ((await res.json()) as { tags: string[] }).tags;
  }

  function rename(actor: Actor, id: string, name: string, merge = false) {
    return fetch(`${BASE}/api/tags/${id}${merge ? '?merge=1' : ''}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...asUser(actor).headers },
      body: JSON.stringify({ name }),
    });
  }

  it('lists tags by id, so a rename has something stable to address', async () => {
    const name = `Listed ${Date.now()}`;
    await createNote(alice, { title: 'a', body: 'x', tags: [name] });
    const found = (await listTags(alice)).find((t) => t.name === name);
    expect(found?.id).toBeTruthy();
    expect(found?.count).toBe(1);
  });

  it('renames a tag and every note follows', async () => {
    const stamp = Date.now();
    const before = `Recipts ${stamp}`;
    const after = `Receipts ${stamp}`;
    const a = await createNote(alice, { title: 'a', body: 'x', tags: [before, 'keep'] });
    const b = await createNote(alice, { title: 'b', body: 'x', tags: [before] });
    const tag = (await listTags(alice)).find((t) => t.name === before)!;

    const res = await rename(alice, tag.id, after);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: tag.id, name: after, merged: false });

    expect(await noteTags(alice, a.id)).toEqual(expect.arrayContaining([after, 'keep']));
    expect(await noteTags(alice, a.id)).not.toContain(before);
    expect(await noteTags(alice, b.id)).toEqual([after]);

    const tags = await listTags(alice);
    expect(tags.find((t) => t.name === after)?.count).toBe(2);
    expect(tags.find((t) => t.name === before)).toBeUndefined();
  });

  it('refuses a rename onto an existing tag unless asked to merge', async () => {
    const stamp = Date.now();
    const winner = `Winner ${stamp}`;
    const loser = `Loser ${stamp}`;
    const both = await createNote(alice, { title: 'both', body: 'x', tags: [winner, loser] });
    const only = await createNote(alice, { title: 'only', body: 'x', tags: [loser] });
    const tags = await listTags(alice);
    const winnerTag = tags.find((t) => t.name === winner)!;
    const loserTag = tags.find((t) => t.name === loser)!;

    const refused = await rename(alice, loserTag.id, winner);
    expect(refused.status).toBe(409);
    // Nothing moved on a refusal.
    expect(await noteTags(alice, only.id)).toEqual([loser]);

    const merged = await rename(alice, loserTag.id, winner, true);
    expect(merged.status).toBe(200);
    expect(await merged.json()).toEqual({ id: winnerTag.id, name: winner, merged: true });

    // The note that had both keeps one; the note that had only the loser gains the winner.
    expect(await noteTags(alice, both.id)).toEqual([winner]);
    expect(await noteTags(alice, only.id)).toEqual([winner]);
    const after = await listTags(alice);
    expect(after.find((t) => t.name === winner)?.count).toBe(2);
    expect(after.find((t) => t.name === loser)).toBeUndefined();
  });

  it('deletes a tag off every note and leaves the notes alone', async () => {
    const stamp = Date.now();
    const gone = `Gone ${stamp}`;
    const stays = `Stays ${stamp}`;
    const note = await createNote(alice, { title: 'n', body: 'x', tags: [gone, stays] });
    const tag = (await listTags(alice)).find((t) => t.name === gone)!;

    const res = await fetch(`${BASE}/api/tags/${tag.id}`, { method: 'DELETE', ...asUser(alice) });
    expect(res.status).toBe(204);

    expect(await noteTags(alice, note.id)).toEqual([stays]);
    expect((await listTags(alice)).find((t) => t.name === gone)).toBeUndefined();
    const still = await fetch(`${BASE}/api/notes/${note.id}`, asUser(alice));
    expect(still.status).toBe(200);
  });

  it("answers 404 for another user's tag, on both mutations", async () => {
    const name = `Private ${Date.now()}`;
    await createNote(alice, { title: 'p', body: 'x', tags: [name] });
    const tag = (await listTags(alice)).find((t) => t.name === name)!;

    expect((await rename(bob, tag.id, 'Stolen')).status).toBe(404);
    const del = await fetch(`${BASE}/api/tags/${tag.id}`, { method: 'DELETE', ...asUser(bob) });
    expect(del.status).toBe(404);
    // And nothing happened to it.
    expect((await listTags(alice)).find((t) => t.name === name)?.count).toBe(1);
  });
});
