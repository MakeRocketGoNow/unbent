/**
 * A save made against an older copy of a note is refused, not written over the newer one.
 *
 * The case this exists for: a note open in a desktop tab, the same note edited on a phone,
 * then one keystroke on the desktop. Before `ifUpdatedAt`, that keystroke's autosave sent
 * the desktop's whole body and the phone's edit was gone without a word. The editor now
 * says which copy its patch was written against, and the API answers 409 with the note as
 * it stands, so the client has both sides without another round trip.
 *
 * The batch `PATCH /notes` takes no precondition, deliberately: it refiles — a notebook,
 * tags added and taken away — and carries nothing a client read, so it has no stale copy
 * to write back. Its "add this tag" lands on whatever tags the note has now.
 *
 * Checked over HTTP against the live Worker, as `no-op-update.test.ts` is, because the
 * property that matters is what the stored row ends up holding. See test/README.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: number;
}

let cookie: string;

function headers(): HeadersInit {
  return { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN };
}

async function create(body: unknown): Promise<Note> {
  const res = await fetch(`${BASE}/api/notes`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<Note>;
}

function patch(id: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/api/notes/${id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(body) });
}

async function read(id: string): Promise<Note> {
  const res = await fetch(`${BASE}/api/notes/${id}`, { headers: headers() });
  return res.json() as Promise<Note>;
}

/** `updated_at` is milliseconds; see `tick` in no-op-update.test.ts. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: `stale-${Date.now()}@example.test`, password: 'stale-password-123', name: 'S' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('a save carrying ifUpdatedAt', () => {
  it('is refused with 409 and the current note when another device saved first', async () => {
    const desktop = await create({ title: 'Coupons', body: 'Opened on the desktop' });
    await tick();

    // The phone saves; the desktop tab still holds `desktop`.
    const phone = await patch(desktop.id, { body: 'Edited on the phone', ifUpdatedAt: desktop.updatedAt });
    expect(phone.status).toBe(200);
    const phoneNote = (await phone.json()) as Note;

    const res = await patch(desktop.id, { body: 'Typed on the desktop', ifUpdatedAt: desktop.updatedAt });
    expect(res.status).toBe(409);
    const { stale } = (await res.json()) as { stale: Note };
    expect(stale).toMatchObject({ id: desktop.id, body: 'Edited on the phone', updatedAt: phoneNote.updatedAt });

    // Nothing was written: the phone's edit is what is stored.
    expect((await read(desktop.id)).body).toBe('Edited on the phone');
  });

  it('goes through against the copy as it now stands, which is what Keep mine sends', async () => {
    const note = await create({ title: 'Coupons', body: 'One' });
    await tick();
    const moved = (await (await patch(note.id, { body: 'Two' })).json()) as Note;
    await tick();

    expect((await patch(note.id, { body: 'Three', ifUpdatedAt: note.updatedAt })).status).toBe(409);
    const res = await patch(note.id, { body: 'Three', ifUpdatedAt: moved.updatedAt });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Note).body).toBe('Three');
  });

  it('is not a conflict when the patch would change nothing', async () => {
    // Both devices made the same edit: writing it again overwrites nothing.
    const note = await create({ title: 'Coupons', body: 'Same' });
    await tick();
    const moved = (await (await patch(note.id, { title: 'Renamed' })).json()) as Note;

    const res = await patch(note.id, { title: 'Renamed', ifUpdatedAt: note.updatedAt });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Note).updatedAt).toBe(moved.updatedAt);
  });

  it('is refused for a title, tag or notebook change as well as a body', async () => {
    const note = await create({ title: 'Coupons', body: 'Body', tags: ['deals'] });
    await tick();
    await patch(note.id, { body: 'Body, edited elsewhere' });

    for (const change of [{ title: 'Other' }, { tags: ['food'] }, { notebook: 'Podcast Bookmarks' }]) {
      const res = await patch(note.id, { ...change, ifUpdatedAt: note.updatedAt });
      expect(res.status).toBe(409);
    }
    expect(await read(note.id)).toMatchObject({ title: 'Coupons', tags: ['deals'] });
  });

  it('writes unconditionally without it, as every save did before', async () => {
    const note = await create({ title: 'Coupons', body: 'One' });
    await tick();
    await patch(note.id, { body: 'Two' });
    const res = await patch(note.id, { body: 'Three' });
    expect(res.status).toBe(200);
    expect((await read(note.id)).body).toBe('Three');
  });

  it('still answers 404 for a note that does not exist', async () => {
    const res = await patch('00000000-0000-4000-8000-000000000000', { title: 'x', ifUpdatedAt: 1 });
    expect(res.status).toBe(404);
  });
});

describe('the batch refile', () => {
  it('lands on the tags a note has now, so it has nothing stale to write back', async () => {
    const note = await create({ title: 'Coupons', body: 'Body', tags: ['deals'] });
    await tick();
    // Another device adds a tag after this client listed the note.
    await patch(note.id, { tags: ['deals', 'food'] });

    const res = await fetch(`${BASE}/api/notes`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ ids: [note.id], addTags: ['receipts'] }),
    });
    expect(res.status).toBe(200);
    expect((await read(note.id)).tags).toEqual(['deals', 'food', 'receipts']);
  });
});
