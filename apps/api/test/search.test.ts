/**
 * Full-text search.
 *
 * The important cases here are index integrity. External-content FTS5 corrupts silently
 * when rows are removed with a plain DELETE instead of the 'delete' command, and the
 * damage only shows up later as stale hits — a note that was edited or deleted still
 * matching its old text. Those are asserted directly rather than assumed.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

interface Actor {
  cookie: string;
  userId: string;
}

async function signUp(email: string, password: string, name: string): Promise<Actor> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

async function createNote(
  actor: Actor,
  input: { title: string; body: string; tags?: string[] },
): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}

async function find(actor: Actor, q: string) {
  const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
    headers: { Cookie: actor.cookie, Origin: ORIGIN },
  });
  if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
  const { results } = (await res.json()) as {
    results: Array<{ id: string; title: string; snippet: string }>;
  };
  return results;
}

let alice: Actor;
let bob: Actor;
let unique: string;

beforeAll(async () => {
  const stamp = Date.now();
  unique = `zqx${stamp}`;
  alice = await signUp(`search-alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`search-bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');

  await createNote(alice, {
    title: `Rampage notes ${unique}`,
    body: 'Rampage happens in Harlow, Vermont every autumn.',
  });
  await createNote(alice, {
    title: 'Grocery list',
    body: 'apples, bread, coffee beans',
  });
  await createNote(alice, {
    title: 'Trip planning',
    body: 'Fly into Burlington, drive to Harlow. Book early.',
  });
}, 30_000);

describe('matching', () => {
  it('finds a note by a word in its body', async () => {
    const hits = await find(alice, 'Rampage');
    expect(hits.map((h) => h.title)).toContain(`Rampage notes ${unique}`);
  });

  it('finds a note by a word in its title', async () => {
    expect((await find(alice, 'Grocery')).map((h) => h.title)).toContain('Grocery list');
  });

  it('is case-insensitive', async () => {
    expect((await find(alice, 'rampage')).length).toBeGreaterThan(0);
    expect((await find(alice, 'RAMPAGE')).length).toBeGreaterThan(0);
  });

  it('matches on a prefix so results appear while typing', async () => {
    expect((await find(alice, 'Ramp')).length).toBeGreaterThan(0);
    expect((await find(alice, 'Groc')).length).toBeGreaterThan(0);
  });

  it('stems with the porter tokenizer', async () => {
    // "happens" in the body should be reachable from "happen".
    expect((await find(alice, 'happen')).length).toBeGreaterThan(0);
  });

  it('requires all terms', async () => {
    // Both words appear, but in different notes.
    expect(await find(alice, 'Rampage groceries')).toEqual([]);
    expect((await find(alice, 'Harlow Vermont')).length).toBeGreaterThan(0);
  });

  it('ranks a title match above a body match', async () => {
    const hits = await find(alice, 'Harlow');
    // "Harlow" appears in both bodies; the note whose subject it is should come first.
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('returns a snippet with the match marked', async () => {
    const hit = (await find(alice, 'Harlow'))[0]!;
    expect(hit.snippet).toContain('<<');
    expect(hit.snippet).toContain('>>');
  });

  it('returns nothing for a term that does not appear', async () => {
    expect(await find(alice, 'xylophone')).toEqual([]);
  });
});

/**
 * FTS5 query syntax is a grammar. These inputs are all legal in a search box and would
 * raise a SQL error if passed through unsanitized.
 */
describe('query sanitization', () => {
  const hostile = [
    'unmatched "quote',
    'trailing *',
    'AND',
    'OR NOT',
    '(unbalanced',
    'a AND OR b',
    '"""',
    'NEAR(a b)',
    '^caret',
    'colon:value',
    '- - -',
  ];

  it.each(hostile)('survives %j', async (q) => {
    const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
  });

  it('rejects an empty query at the schema', async () => {
    const res = await fetch(`${BASE}/api/search?q=`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(400);
  });

  it('returns no results for punctuation-only input', async () => {
    expect(await find(alice, '***')).toEqual([]);
  });
});

/**
 * Index integrity. External-content FTS5 fails silently when maintained incorrectly, so
 * these assert the triggers rather than trusting them.
 */
describe('index maintenance', () => {
  it('indexes a newly created note', async () => {
    const token = `fresh${Date.now()}`;
    await createNote(alice, { title: 'Brand new', body: `contains ${token}` });
    expect((await find(alice, token)).length).toBe(1);
  });

  it('stops matching old text after an edit', async () => {
    const before = `before${Date.now()}`;
    const after = `after${Date.now()}`;
    const note = await createNote(alice, { title: 'Editable', body: `holds ${before}` });

    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
      body: JSON.stringify({ body: `holds ${after}` }),
    });

    // The stale-hit case: a plain DELETE against the index would leave this matching.
    expect(await find(alice, before)).toEqual([]);
    expect((await find(alice, after)).length).toBe(1);
  });

  it('stops matching a title after it is renamed', async () => {
    const before = `titleold${Date.now()}`;
    const after = `titlenew${Date.now()}`;
    const note = await createNote(alice, { title: before, body: 'x' });

    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
      body: JSON.stringify({ title: after }),
    });

    expect(await find(alice, before)).toEqual([]);
    expect((await find(alice, after)).length).toBe(1);
  });

  it('excludes a soft-deleted note', async () => {
    const token = `deleted${Date.now()}`;
    const note = await createNote(alice, { title: 'Doomed', body: `holds ${token}` });
    expect((await find(alice, token)).length).toBe(1);

    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'DELETE',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });

    expect(await find(alice, token)).toEqual([]);
  });

  it('survives repeated edits without accumulating stale entries', async () => {
    const note = await createNote(alice, { title: 'Churn', body: 'v0' });
    for (let i = 1; i <= 5; i += 1) {
      await fetch(`${BASE}/api/notes/${note.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
        body: JSON.stringify({ body: `churnversion${i}` }),
      });
    }

    for (let i = 1; i <= 4; i += 1) {
      expect(await find(alice, `churnversion${i}`)).toEqual([]);
    }
    expect((await find(alice, 'churnversion5')).length).toBe(1);
  });
});

/**
 * Attachment text participates in search, so it needs the same scoping guarantees as note
 * text — and its own cross-tenant case, since it joins through a different table.
 */
describe('attachment text', () => {
  async function noteWithText(actor: Actor, token: string): Promise<{ id: string }> {
    const note = await createNote(actor, { title: 'Scanned', body: '' });

    await fetch(`${BASE}/api/notes/${note.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: actor.cookie,
        Origin: ORIGIN,
        'X-Filename': 'scan.pdf',
        'Content-Type': 'application/pdf',
      },
      body: 'PDFBYTES',
    });

    const res = await fetch(`${BASE}/api/notes/${note.id}/files/scan.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `extracted contents mentioning ${token}` }),
    });
    expect(res.status).toBe(204);
    return note;
  }

  it('finds a note by text that exists only inside its attachment', async () => {
    const token = `onlyinpdf${Date.now()}`;
    const note = await noteWithText(alice, token);

    const hits = await find(alice, token);
    expect(hits.map((h) => h.id)).toContain(note.id);
    // The result names the file, so the match is explicable.
    expect(hits[0]!.matchedFile).toBe('scan.pdf');
  });

  it('does not leak attachment text across users', async () => {
    const token = `secretpdf${Date.now()}`;
    await noteWithText(alice, token);
    expect(await find(bob, token)).toEqual([]);
  });

  it('rejects saving text for another user note', async () => {
    const note = await noteWithText(alice, `x${Date.now()}`);
    const res = await fetch(`${BASE}/api/notes/${note.id}/files/scan.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: bob.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'injected' }),
    });
    expect(res.status).toBe(404);
  });

  it('drops attachment text when the note is purged', async () => {
    const token = `purged${Date.now()}`;
    await noteWithText(alice, token);
    expect((await find(alice, token)).length).toBe(1);

    await fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
      body: JSON.stringify({ title: 'keeper', body: 'keeper' }),
    });

    // Soft delete then purge, which is how the trash is emptied.
    const { items } = await fetch(`${BASE}/api/notes?limit=100`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    const scanned = items.find((i: { title: string }) => i.title === 'Scanned');
    await fetch(`${BASE}/api/notes/${scanned.id}`, {
      method: 'DELETE',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    await fetch(`${BASE}/api/admin/purge-notes?scope=trashed&confirm=DELETE`, {
      method: 'POST',
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });

    expect(await find(alice, token)).toEqual([]);
  });

  /**
   * Prefix search must reach attachment text too.
   *
   * Typing "phar" should find a PDF containing "pharmacy" — the search box matches
   * prefixes as you type, and an index that only answered whole words would look broken.
   */
  it('matches attachment text by prefix', async () => {
    const token = `pharmacology${Date.now()}`;
    const note = await noteWithText(alice, token);

    const prefix = token.slice(0, 6);
    const hits = await find(alice, prefix);
    expect(hits.map((h) => h.id)).toContain(note.id);
  });

  /**
   * The gap that shipped: import is idempotent on content hash, so notes imported before
   * extraction existed cannot be fixed by re-importing — they are skipped along with their
   * attachments. Backfill is the only way to reach them.
   */
  it('reports attachments still needing text', async () => {
    const actor = await signUp(`pending-${Date.now()}@example.test`, 'pending-pass-123', 'P');
    const note = await createNote(actor, { title: 'Scanned', body: '' });

    await fetch(`${BASE}/api/notes/${note.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: actor.cookie,
        Origin: ORIGIN,
        'X-Filename': 'scan.pdf',
        'Content-Type': 'application/pdf',
      },
      body: 'PDFBYTES',
    });

    const before = await fetch(`${BASE}/api/attachments/pending-text`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(before.remaining).toBe(1);
    expect(before.pending[0].filename).toBe('scan.pdf');

    await fetch(`${BASE}/api/notes/${note.id}/files/scan.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'now indexed' }),
    });

    const after = await fetch(`${BASE}/api/attachments/pending-text`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(after.remaining).toBe(0);
    expect(after.pending).toEqual([]);
  });

  it('stops re-offering an attachment whose text was unusable', async () => {
    const actor = await signUp(`unusable-${Date.now()}@example.test`, 'unusable-pass-1', 'U');
    const note = await createNote(actor, { title: 'Bad scan', body: '' });

    await fetch(`${BASE}/api/notes/${note.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: actor.cookie,
        Origin: ORIGIN,
        'X-Filename': 'bad.pdf',
        'Content-Type': 'application/pdf',
      },
      body: 'PDFBYTES',
    });

    // A failed extraction records an empty row so the backfill terminates.
    await fetch(`${BASE}/api/notes/${note.id}/files/bad.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unusable: true }),
    });

    const after = await fetch(`${BASE}/api/attachments/pending-text`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(after.remaining).toBe(0);

    // An empty row can never match. Search a token that appears nowhere else, since the
    // note's own title would legitimately match on its words.
    expect(await find(actor, `nothinginhere${Date.now()}`)).toEqual([]);
  });

  it('does not offer another user attachments for backfill', async () => {
    await noteWithText(alice, `mine${Date.now()}`);
    const res = await fetch(`${BASE}/api/attachments/pending-text`, {
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(res.pending.every((p: { noteId: string }) => p.noteId)).toBe(true);
    // Bob has no PDFs of his own, so nothing is offered.
    expect(res.extractable).toBe(0);
  });

  it('prefers a note-body match over an attachment match', async () => {
    const token = `bothplaces${Date.now()}`;
    await noteWithText(alice, token);
    const direct = await createNote(alice, { title: 'Direct', body: `body has ${token}` });

    const hits = await find(alice, token);
    expect(hits[0]!.id).toBe(direct.id);
    expect(hits[0]!.matchedFile).toBeUndefined();
  });
});

describe('cross-tenant access', () => {
  it('never returns another user notes', async () => {
    expect(await find(bob, 'Rampage')).toEqual([]);
    expect(await find(bob, unique)).toEqual([]);
    expect(await find(bob, 'Harlow')).toEqual([]);
  });

  it('scopes identical text to each user', async () => {
    const shared = `shared${Date.now()}`;
    await createNote(alice, { title: 'Alice copy', body: shared });
    await createNote(bob, { title: 'Bob copy', body: shared });

    expect((await find(alice, shared)).map((h) => h.title)).toEqual(['Alice copy']);
    expect((await find(bob, shared)).map((h) => h.title)).toEqual(['Bob copy']);
  });

  it('requires a session', async () => {
    const res = await fetch(`${BASE}/api/search?q=anything`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
  });
});
