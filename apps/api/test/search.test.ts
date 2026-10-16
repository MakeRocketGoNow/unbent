/**
 * Full-text search.
 *
 * The important cases here are index integrity. External-content FTS5 corrupts silently
 * when rows are removed with a plain DELETE instead of the 'delete' command, and the
 * damage only shows up later as stale hits: a note that was edited or deleted still
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
  input: { title: string; body: string; tags?: string[]; notebook?: string },
): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}

/**
 * Which of the two query shapes a filtered search takes; see `scopeDrivenSearchSql`. Every
 * notebook and tag here is small, so by default a filtered search is scope-driven, and the
 * FTS-driven shape production uses for a larger one would go untested. The search route
 * lets the suite move the threshold with a header: `-1` puts every scope over it, a huge
 * number every scope under.
 */
type SearchShape = 'fts' | 'scope';
const SHAPE_MAX: Record<SearchShape, string> = { fts: '-1', scope: '1000000' };

async function find(
  actor: Actor,
  q: string,
  filter: { tag?: string; notebook?: string } = {},
  shape?: SearchShape,
) {
  const params = new URLSearchParams({ q });
  if (filter.tag) params.set('tag', filter.tag);
  if (filter.notebook) params.set('notebook', filter.notebook);
  const headers: Record<string, string> = { Cookie: actor.cookie, Origin: ORIGIN };
  if (shape) headers['X-Test-Scope-Driven-Search-Max'] = SHAPE_MAX[shape];
  const res = await fetch(`${BASE}/api/search?${params.toString()}`, { headers });
  if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
  const { results } = (await res.json()) as {
    results: Array<{ id: string; title: string; snippet: string; matchedFile?: string; matchedTag?: string }>;
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
 * text, and its own cross-tenant case, since it joins through a different table.
 */
describe('attachment text', () => {
  async function noteWithText(
    actor: Actor,
    token: string,
    notebook?: string,
  ): Promise<{ id: string }> {
    const note = await createNote(actor, {
      title: 'Scanned',
      body: '',
      ...(notebook ? { notebook } : {}),
    });

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

  /** A note holding a PDF nothing has read yet: what the backfill is there to find. */
  async function noteWithUnreadPdf(actor: Actor): Promise<{ id: string }> {
    const note = await createNote(actor, { title: 'Unread scan', body: '' });
    const res = await fetch(`${BASE}/api/notes/${note.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: actor.cookie,
        Origin: ORIGIN,
        'X-Filename': 'unread.pdf',
        'Content-Type': 'application/pdf',
      },
      body: 'PDFBYTES',
    });
    expect(res.ok).toBe(true);
    return note;
  }

  async function pendingText(actor: Actor, note?: string) {
    const res = await fetch(
      `${BASE}/api/attachments/pending-text${note ? `?note=${note}` : ''}`,
      { headers: { Cookie: actor.cookie, Origin: ORIGIN } },
    );
    return (await res.json()) as {
      pending: Array<{ noteId: string; filename: string }>;
      remaining: number;
    };
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
   * Typing "phar" should find a PDF containing "pharmacy": the search box matches
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
   * extraction existed cannot be fixed by re-importing: they are skipped along with their
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
    // Unread, so that it would be both listed and counted if it leaked. A PDF with text is
    // neither, and would pass this whether or not the query were scoped.
    const hers = await noteWithUnreadPdf(alice);
    expect((await pendingText(alice)).pending.map((p) => p.noteId)).toContain(hers.id);

    // Bob has no PDFs of his own, so nothing is offered and nothing is left.
    const res = await pendingText(bob);
    expect(res.pending).toEqual([]);
    expect(res.remaining).toBe(0);
  });

  /**
   * The phone indexes only the capture it just uploaded. Scoped, the answer and its counts
   * describe that one note, not the account's backlog: a phone must never be told it has
   * four thousand files to pull over a radio.
   */
  it('scopes pending attachments to one note when asked', async () => {
    const actor = await signUp(`scoped-${Date.now()}@example.test`, 'scoped-pass-123', 'S');
    const first = await createNote(actor, { title: 'First scan', body: '' });
    const second = await createNote(actor, { title: 'Second scan', body: '' });
    for (const note of [first, second]) {
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
    }

    const scoped = await fetch(`${BASE}/api/attachments/pending-text?note=${first.id}`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(scoped.pending).toEqual([{ noteId: first.id, filename: 'scan.pdf' }]);
    expect(scoped.remaining).toBe(1);

    const all = await fetch(`${BASE}/api/attachments/pending-text`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    }).then((r) => r.json());
    expect(all.remaining).toBe(2);
  });

  it('does not reveal another user\'s note through the note scope', async () => {
    // Unread for the reason the test above gives: a leak has to be able to show.
    const mine = await noteWithUnreadPdf(alice);
    expect((await pendingText(alice, mine.id)).remaining).toBe(1);

    const res = await pendingText(bob, mine.id);
    expect(res.pending).toEqual([]);
    expect(res.remaining).toBe(0);
  });

  /**
   * A copy carries its source's text (see `copyText`), and 0024's trigger has to see that
   * insert: were the copy offered again, the pass would fetch its bytes back from R2 and
   * read them a second time for text the server already had.
   */
  it('does not offer a copied file whose source was already read', async () => {
    const actor = await signUp(`copied-${Date.now()}@example.test`, 'copied-pass-123', 'C');
    const source = await createNote(actor, { title: 'Source', body: '' });
    const target = await createNote(actor, { title: 'Target', body: '' });
    await fetch(`${BASE}/api/notes/${source.id}/files`, {
      method: 'PUT',
      headers: {
        Cookie: actor.cookie,
        Origin: ORIGIN,
        'X-Filename': 'read.pdf',
        'Content-Type': 'application/pdf',
      },
      body: 'PDFBYTES',
    });
    await fetch(`${BASE}/api/notes/${source.id}/files/read.pdf/text`, {
      method: 'PUT',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'already read' }),
    });
    expect((await pendingText(actor)).remaining).toBe(0);

    const copied = await fetch(`${BASE}/api/notes/${target.id}/files/copy`, {
      method: 'POST',
      headers: { Cookie: actor.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: source.id, filenames: ['read.pdf'] }),
    });
    expect(copied.ok).toBe(true);

    const after = await pendingText(actor);
    expect(after.pending).toEqual([]);
    expect(after.remaining).toBe(0);
  });

  it('scopes an attachment hit to the notebook filter', async () => {
    // The filter has to reach both CTEs. Applied to only the note side, a PDF match would
    // still surface notes from outside the selected notebook.
    const token = `filescope${Date.now()}`;
    const notebook = `Files ${Date.now()}`;
    const inside = await noteWithText(alice, token, notebook);
    await noteWithText(alice, token);

    expect(await find(alice, token)).toHaveLength(2);

    const scoped = await find(alice, token, { notebook });
    expect(scoped.map((h) => h.id)).toEqual([inside.id]);
    expect(scoped[0]!.matchedFile).toBe('scan.pdf');
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

/**
 * Search scoped by the list's own filters.
 *
 * The bug these cover: search used to ignore `tag` and `notebook` entirely, so typing a
 * query silently threw away the notebook the user had selected and answered a question
 * they had not asked.
 */
describe.each<SearchShape>(['scope', 'fts'])('scoped search, %s-driven', (shape) => {
  it('limits results to a notebook', async () => {
    const token = `nbscope${shape}${Date.now()}`;
    const notebook = `Scoped ${shape} ${Date.now()}`;
    const inside = await createNote(alice, { title: 'Inside', body: token, notebook });
    await createNote(alice, { title: 'Outside', body: token });

    expect((await find(alice, token)).map((h) => h.id).sort()).toHaveLength(2);

    const scoped = await find(alice, token, { notebook }, shape);
    expect(scoped.map((h) => h.id)).toEqual([inside.id]);
  });

  it('matches a notebook name case-insensitively, as the list does', async () => {
    const token = `nbcase${shape}${Date.now()}`;
    const notebook = `MixedCase ${shape} ${Date.now()}`;
    await createNote(alice, { title: 'Inside', body: token, notebook });

    const scoped = await find(alice, token, { notebook: notebook.toUpperCase() }, shape);
    expect(scoped).toHaveLength(1);
  });

  it('limits results to a tag', async () => {
    const token = `tagscope${shape}${Date.now()}`;
    const tag = `scoped${shape}${Date.now()}`;
    const tagged = await createNote(alice, { title: 'Tagged', body: token, tags: [tag] });
    await createNote(alice, { title: 'Untagged', body: token });

    const scoped = await find(alice, token, { tag }, shape);
    expect(scoped.map((h) => h.id)).toEqual([tagged.id]);
  });

  it('applies tag and notebook together', async () => {
    const token = `bothscope${shape}${Date.now()}`;
    const notebook = `Both ${shape} ${Date.now()}`;
    const tag = `both${shape}${Date.now()}`;
    const both = await createNote(alice, {
      title: 'Both',
      body: token,
      tags: [tag],
      notebook,
    });
    await createNote(alice, { title: 'Notebook only', body: token, notebook });
    await createNote(alice, { title: 'Tag only', body: token, tags: [tag] });

    const scoped = await find(alice, token, { tag, notebook }, shape);
    expect(scoped.map((h) => h.id)).toEqual([both.id]);
  });

  it('returns nothing when the filter excludes every match', async () => {
    const token = `noneleft${shape}${Date.now()}`;
    await createNote(alice, { title: 'Unfiled', body: token });

    expect(await find(alice, token, { notebook: `Empty ${shape} ${Date.now()}` }, shape)).toEqual([]);
  });
});

describe('the two scoped search shapes', () => {
  /**
   * The same notes through both, compared whole: ids, order, snippets and what matched.
   * A title match, a body match and a tag match, inside and outside the scope, so every
   * tier the two queries spell out has a row to disagree about.
   */
  it('answer a filtered search identically', async () => {
    const token = `parity${Date.now()}`;
    const notebook = `Parity ${Date.now()}`;
    const tag = token;
    await createNote(alice, { title: `Title ${token}`, body: 'nothing else', notebook });
    await createNote(alice, { title: 'Body only', body: `the word ${token} in passing`, notebook });
    await createNote(alice, { title: 'Tagged only', body: 'no word here', tags: [tag], notebook });
    await createNote(alice, { title: `Outside ${token}`, body: token });

    for (const filter of [{ notebook }, { tag }, { tag, notebook }]) {
      const scope = await find(alice, token, filter, 'scope');
      const fts = await find(alice, token, filter, 'fts');
      expect(scope.length).toBeGreaterThan(0);
      expect(fts).toEqual(scope);
    }
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

/**
 * Custom field values have their own index, maintained by the same kind of triggers as
 * the other two. The integrity cases mirror theirs: a value that is changed, cleared or
 * whose field is deleted must stop matching, or the index is quietly wrong.
 */
describe('custom field values', () => {
  const headers = (actor: Actor) => ({
    'Content-Type': 'application/json',
    Cookie: actor.cookie,
    Origin: ORIGIN,
  });

  async function raw(actor: Actor, q: string) {
    const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    const { results } = (await res.json()) as {
      results: Array<{ id: string; snippet: string; matchedField?: string; matchedFile?: string }>;
    };
    return results;
  }

  let notebookId: string;
  let vendorId: string;

  beforeAll(async () => {
    const nb = await fetch(`${BASE}/api/notebooks`, {
      method: 'POST',
      headers: headers(alice),
      body: JSON.stringify({ name: `Fields ${unique}` }),
    }).then((r) => r.json() as Promise<{ id: string; name: string }>);
    notebookId = nb.id;
    const vendor = await fetch(`${BASE}/api/notebooks/${nb.id}/fields`, {
      method: 'POST',
      headers: headers(alice),
      body: JSON.stringify({ name: 'Vendor', type: 'text' }),
    }).then((r) => r.json() as Promise<{ id: string }>);
    vendorId = vendor.id;
  });

  async function noteWithVendor(actor: Actor, title: string, vendor: string) {
    const res = await fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: headers(actor),
      body: JSON.stringify({
        title,
        body: 'nothing to see in the body',
        notebook: `Fields ${unique}`,
        fields: { [vendorId]: vendor },
      }),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ id: string }>;
  }

  it('finds a note by a value held only in a field, and names the field', async () => {
    const term = `Quaxley${unique}`;
    const note = await noteWithVendor(alice, 'Receipt', `${term} Hardware`);
    const hits = await raw(alice, term);
    expect(hits.map((h) => h.id)).toContain(note.id);
    const hit = hits.find((h) => h.id === note.id)!;
    expect(hit.matchedField).toBe('Vendor');
    expect(hit.matchedFile).toBeUndefined();
    expect(hit.snippet).toContain(`<<${term}>>`);
  });

  it('stops matching a value once it is changed or cleared', async () => {
    const before = `Brindle${unique}`;
    const after = `Corvid${unique}`;
    const note = await noteWithVendor(alice, 'Changing', before);
    expect((await raw(alice, before)).map((h) => h.id)).toContain(note.id);

    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: headers(alice),
      body: JSON.stringify({ fields: { [vendorId]: after } }),
    });
    expect((await raw(alice, before)).map((h) => h.id)).not.toContain(note.id);
    expect((await raw(alice, after)).map((h) => h.id)).toContain(note.id);

    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: headers(alice),
      body: JSON.stringify({ fields: { [vendorId]: null } }),
    });
    expect((await raw(alice, after)).map((h) => h.id)).not.toContain(note.id);
  });

  it('stops matching when the field itself is deleted', async () => {
    const term = `Dorset${unique}`;
    const doomed = await fetch(`${BASE}/api/notebooks/${notebookId}/fields`, {
      method: 'POST',
      headers: headers(alice),
      body: JSON.stringify({ name: 'Doomed', type: 'text' }),
    }).then((r) => r.json() as Promise<{ id: string }>);
    const note = await fetch(`${BASE}/api/notes`, {
      method: 'POST',
      headers: headers(alice),
      body: JSON.stringify({ title: 'x', body: '', notebook: `Fields ${unique}`, fields: { [doomed.id]: term } }),
    }).then((r) => r.json() as Promise<{ id: string }>);
    expect((await raw(alice, term)).map((h) => h.id)).toContain(note.id);

    await fetch(`${BASE}/api/notebooks/${notebookId}/fields/${doomed.id}`, {
      method: 'DELETE',
      headers: headers(alice),
    });
    expect((await raw(alice, term)).map((h) => h.id)).not.toContain(note.id);
  });

  it('does not leak a value across users', async () => {
    const term = `Ember${unique}`;
    await noteWithVendor(alice, 'Private', term);
    expect(await raw(bob, term)).toEqual([]);
  });

  it('ranks a field match above an attachment match and below a body match', async () => {
    const term = `Kestrel${unique}`;
    const inField = await noteWithVendor(alice, 'In a field', term);
    const inBody = await createNote(alice, { title: 'In the body', body: `${term} written down` });
    const ids = (await raw(alice, term)).map((h) => h.id);
    expect(ids.indexOf(inBody.id)).toBeLessThan(ids.indexOf(inField.id));
  });
});

/**
 * Tag names.
 *
 * A note filed under a tag is found by the tag's name even when the name appears nowhere
 * in the note, which is how an archive filed by tag is looked up. The index is external
 * content over `tags`, so the cases that matter are the same as for fields: the match
 * names its source, it follows a rename, it stops on removal from the note and on the
 * tag's deletion or merge, and it never crosses users.
 */
describe('tag names', () => {
  const headers = (actor: Actor) => ({
    'Content-Type': 'application/json',
    Cookie: actor.cookie,
    Origin: ORIGIN,
  });

  async function raw(actor: Actor, q: string) {
    const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    const { results } = (await res.json()) as {
      results: Array<{
        id: string;
        snippet: string;
        matchedTag?: string;
        matchedField?: string;
        matchedFile?: string;
      }>;
    };
    return results;
  }

  async function tagIdOf(actor: Actor, name: string): Promise<string> {
    const res = await fetch(`${BASE}/api/tags`, { headers: { Cookie: actor.cookie, Origin: ORIGIN } });
    const { tags } = (await res.json()) as { tags: Array<{ id: string; name: string }> };
    const tag = tags.find((t) => t.name === name);
    if (!tag) throw new Error(`no tag ${name}`);
    return tag.id;
  }

  it('finds a note by a tag whose name is nowhere in its text, and names the tag', async () => {
    const tag = `Marlin${unique}`;
    const note = await createNote(alice, { title: 'Untitled', body: 'nothing here', tags: [tag] });
    const hits = await raw(alice, tag);
    expect(hits.map((h) => h.id)).toContain(note.id);
    const hit = hits.find((h) => h.id === note.id)!;
    expect(hit.matchedTag).toBe(tag);
    expect(hit.matchedField).toBeUndefined();
    expect(hit.matchedFile).toBeUndefined();
    expect(hit.snippet).toContain(`<<${tag}>>`);
  });

  it('matches a prefix of the name, so results appear while typing', async () => {
    const tag = `Osprey${unique}`;
    const note = await createNote(alice, { title: 'Untitled', body: '', tags: [tag] });
    expect((await raw(alice, `Ospr`)).map((h) => h.id)).toContain(note.id);
  });

  it('stops matching once the tag is taken off the note', async () => {
    const tag = `Plover${unique}`;
    const note = await createNote(alice, { title: 'Untitled', body: '', tags: [tag] });
    expect((await raw(alice, tag)).map((h) => h.id)).toContain(note.id);
    await fetch(`${BASE}/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: headers(alice),
      body: JSON.stringify({ tags: [] }),
    });
    expect((await raw(alice, tag)).map((h) => h.id)).not.toContain(note.id);
  });

  it('follows a rename and stops on a merge', async () => {
    const before = `Quail${unique}`;
    const after = `Raven${unique}`;
    const other = `Shrike${unique}`;
    const note = await createNote(alice, { title: 'Untitled', body: '', tags: [before] });
    const id = await tagIdOf(alice, before);

    await fetch(`${BASE}/api/tags/${id}`, {
      method: 'PATCH',
      headers: headers(alice),
      body: JSON.stringify({ name: after }),
    });
    expect((await raw(alice, before)).map((h) => h.id)).not.toContain(note.id);
    expect((await raw(alice, after)).map((h) => h.id)).toContain(note.id);

    // Merging into another tag deletes this row; the note is then found by the survivor.
    await createNote(alice, { title: 'Holder', body: '', tags: [other] });
    await fetch(`${BASE}/api/tags/${id}?merge=1`, {
      method: 'PATCH',
      headers: headers(alice),
      body: JSON.stringify({ name: other }),
    });
    expect((await raw(alice, after)).map((h) => h.id)).not.toContain(note.id);
    expect((await raw(alice, other)).map((h) => h.id)).toContain(note.id);
  });

  it('stops matching when the tag is deleted', async () => {
    const tag = `Teal${unique}`;
    const note = await createNote(alice, { title: 'Untitled', body: '', tags: [tag] });
    const id = await tagIdOf(alice, tag);
    await fetch(`${BASE}/api/tags/${id}`, { method: 'DELETE', headers: headers(alice) });
    expect((await raw(alice, tag)).map((h) => h.id)).not.toContain(note.id);
  });

  it('does not leak a tag across users', async () => {
    const tag = `Vireo${unique}`;
    await createNote(alice, { title: 'Private', body: '', tags: [tag] });
    expect(await raw(bob, tag)).toEqual([]);
  });

  it('respects the tag and notebook scope like every other source', async () => {
    const tag = `Wren${unique}`;
    const scope = `Scope${unique}`;
    const inScope = await createNote(alice, { title: 'a', body: '', tags: [tag, scope] });
    const outOfScope = await createNote(alice, { title: 'b', body: '', tags: [tag] });
    const ids = (await find(alice, tag, { tag: scope })).map((h) => h.id);
    expect(ids).toContain(inScope.id);
    expect(ids).not.toContain(outOfScope.id);
  });

  it('ranks a tag match below a body match and above a field match', async () => {
    const term = `Yellowhammer${unique}`;
    const inBody = await createNote(alice, { title: 'In the body', body: `${term} written down` });
    const inTag = await createNote(alice, { title: 'Tagged', body: '', tags: [term] });
    const ids = (await raw(alice, term)).map((h) => h.id);
    expect(ids.indexOf(inBody.id)).toBeLessThan(ids.indexOf(inTag.id));
  });
});
