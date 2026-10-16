/**
 * The stored note counts (0023) against the notes they count, after every kind of write.
 *
 * Each step changes something through the ordinary API and then asks the recount to count
 * everything again from the rows: a recount that corrects anything means a trigger missed
 * that write. That is the whole claim the stored counts make (that nothing has to be
 * recounted), so it is checked the way a drifted count would be noticed, and against the
 * live Worker's D1 rather than stock SQLite, which is where 0017 learned the difference.
 *
 * The recount only proves the stored numbers match what the recount thinks is true, so the
 * served numbers are also compared with an exact count of the same filter, which reads the
 * notes and never the stored counts.
 *
 * A trigger lost to a future table rebuild fails this too: the counts would stop moving and
 * the first step after the rebuild would need correcting.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

let cookie = '';

/** `UNFILED` from the shared schemas, the notebook filter for notes in no notebook. */
const UNFILED_QUERY = `notebook=${encodeURIComponent('[unfiled]')}`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: ORIGIN,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  // Trashing and restoring answer 204, with nothing to parse.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface Note {
  id: string;
}

const create = (body: { title: string; tags?: string[]; notebook?: string }) =>
  call<Note>('POST', '/notes', { body: '', tags: [], ...body });

/** The total the list reports for a filter, stored when it can be or exact when asked. */
async function total(query: string, exact: boolean): Promise<number> {
  const sep = query ? '&' : '';
  const page = await call<{ total: number }>(
    'GET',
    `/notes?limit=1${sep}${query}${exact ? '&exact=1' : ''}`,
  );
  return page.total;
}

/**
 * Every count the app shows, served stored and counted exact, must agree, and the
 * recount must find nothing to fix.
 */
async function expectCountsConsistent(step: string): Promise<void> {
  const { corrected } = await call<{ corrected: number }>('POST', '/admin/recount-notes');
  expect(corrected, `recount corrected something after: ${step}`).toBe(0);

  const { notebooks, unfiled } = await call<{
    notebooks: Array<{ name: string; count: number }>;
    unfiled: number;
  }>('GET', '/notebooks');
  for (const nb of notebooks) {
    const q = `notebook=${encodeURIComponent(nb.name)}`;
    expect(nb.count, `${nb.name} after: ${step}`).toBe(await total(q, true));
    expect(await total(q, false), `${nb.name} total after: ${step}`).toBe(nb.count);
  }
  expect(unfiled, `unfiled after: ${step}`).toBe(await total(UNFILED_QUERY, true));

  const { tags } = await call<{ tags: Array<{ name: string; count: number }> }>('GET', '/tags');
  for (const t of tags) {
    const q = `tag=${encodeURIComponent(t.name)}`;
    expect(t.count, `tag ${t.name} after: ${step}`).toBe(await total(q, true));
    expect(await total(q, false), `tag ${t.name} total after: ${step}`).toBe(t.count);
  }

  expect(await total('', false), `all notes after: ${step}`).toBe(await total('', true));
  expect(await total('trashed=1', false), `trash after: ${step}`).toBe(
    await total('trashed=1', true),
  );
}

beforeAll(async () => {
  const email = `counts-${crypto.randomUUID()}@example.com`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      email,
      password: 'counts-password-1234',
      name: 'Counts',
    }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('stored note counts', () => {
  // Long for one test: every step re-checks every count, a couple of hundred requests in
  // all, and the other suites share the same Worker.
  it('stay equal to the notes through every kind of write', { timeout: 60_000 }, async () => {
    await expectCountsConsistent('a new account');

    const a = await create({
      title: 'A',
      tags: ['red', 'blue'],
      notebook: 'Coupons',
    });
    const b = await create({ title: 'B', tags: ['red'], notebook: 'Coupons' });
    const c = await create({ title: 'C', tags: ['blue'] });
    const d = await create({ title: 'D', notebook: 'Podcast Bookmarks' });
    await expectCountsConsistent('creating notes, filed and unfiled');
    expect(await total('notebook=Coupons', false)).toBe(2);
    expect(await total('tag=red', false)).toBe(2);
    expect(await total(UNFILED_QUERY, false)).toBe(1);

    await call('PATCH', `/notes/${a.id}`, { body: 'edited' });
    await expectCountsConsistent('a body edit');

    await call('PATCH', `/notes/${a.id}`, { notebook: 'Podcast Bookmarks' });
    await expectCountsConsistent('moving a note between notebooks');

    await call('PATCH', `/notes/${c.id}`, { notebook: 'Coupons' });
    await call('PATCH', `/notes/${d.id}`, { notebook: null });
    await expectCountsConsistent('filing and unfiling');

    await call('PATCH', `/notes/${a.id}`, { tags: ['blue', 'green'] });
    await expectCountsConsistent('replacing tags');

    await call('DELETE', `/notes/${a.id}`);
    await expectCountsConsistent('trashing a tagged, filed note');
    expect(await total('tag=blue', false)).toBe(1);

    await call('POST', `/notes/${a.id}/restore`);
    await expectCountsConsistent('restoring it');
    expect(await total('tag=blue', false)).toBe(2);

    await call('PATCH', '/notes', {
      ids: [b.id, c.id],
      notebook: 'Podcast Bookmarks',
      addTags: ['green'],
      removeTags: ['red'],
    });
    await expectCountsConsistent('a batch move and retag');

    await call('POST', '/notes/trash', { ids: [a.id, b.id] });
    await expectCountsConsistent('a batch trash');
    await call('POST', '/notes/restore', { ids: [a.id] });
    await expectCountsConsistent('a batch restore');

    const copy = await call<Note>('POST', `/notes/${a.id}/duplicate`);
    await expectCountsConsistent('duplicating a note');

    await call('POST', '/import/note', {
      title: 'Imported',
      body: '',
      tags: ['red', 'imported'],
      notebook: 'Coupons',
      createdAt: 1_600_000_000_000,
      updatedAt: 1_600_000_000_000,
      contentHash: 'a'.repeat(64),
    });
    await expectCountsConsistent('importing a note');

    const { tags } = await call<{ tags: Array<{ id: string; name: string }> }>('GET', '/tags');
    const green = tags.find((t) => t.name === 'green')!;
    await call('PATCH', `/tags/${green.id}?merge=1`, { name: 'blue' });
    await expectCountsConsistent('merging one tag into another');

    const imported = tags.find((t) => t.name === 'imported')!;
    await call('DELETE', `/tags/${imported.id}`);
    await expectCountsConsistent('deleting a tag');

    const { notebooks } = await call<{
      notebooks: Array<{ id: string; name: string }>;
    }>('GET', '/notebooks');
    const coupons = notebooks.find((nb) => nb.name === 'Coupons')!;
    const podcasts = notebooks.find((nb) => nb.name === 'Podcast Bookmarks')!;
    await call('PATCH', `/notebooks/${podcasts.id}`, { name: 'Podcasts' });
    await expectCountsConsistent('renaming a notebook');

    await call('DELETE', `/notebooks/${coupons.id}`);
    await expectCountsConsistent('deleting a notebook, keeping its notes');

    await call('DELETE', `/notebooks/${podcasts.id}?trashNotes=1`);
    await expectCountsConsistent('deleting a notebook and trashing its notes');

    // The duplicate went to the trash with its notebook; delete it for good from there.
    await call('DELETE', `/notes/${copy.id}/permanent`);
    await expectCountsConsistent('deleting one trashed note for good');

    await call('POST', '/admin/purge-notes?scope=trashed&confirm=DELETE');
    await expectCountsConsistent('emptying the trash');

    await create({ title: 'E', tags: ['red'], notebook: 'Coupons' });
    await call('POST', '/admin/purge-notes?scope=all&confirm=DELETE');
    await expectCountsConsistent('deleting every note');
    expect(await total('', false)).toBe(0);
  });
});
