/**
 * Import round-trip: the other half of the disaster-recovery guarantee.
 *
 * `export.test.ts` asserts the archive is real. This asserts it comes back: what one
 * account exports, another can import — same ids, same notebooks, same tags, same fields,
 * same files — and importing it again changes nothing.
 */
import { importArchive } from '@unbent/enex';
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

function api(actor: Actor, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Cookie: actor.cookie, Origin: ORIGIN, ...(init.headers ?? {}) },
  });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface NoteJson {
  id: string;
  title: string;
  body: string;
  tags: string[];
  notebook?: string | null;
  createdAt: number;
  updatedAt: number;
  fields?: Array<{ name: string; value: string | number | boolean }>;
}

const sha256 = async (title: string, body: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${title}\n${body}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Posts one note to the import endpoint the way the importers do. */
async function importNote(
  actor: Actor,
  note: {
    id?: string;
    title: string;
    body: string;
    tags?: string[];
    notebook?: string;
    fields?: Record<string, string | number | boolean>;
  },
): Promise<{ status: number; id: string; created: boolean; skippedFields: string[] }> {
  const res = await api(actor, '/api/import/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...note,
      tags: note.tags ?? [],
      createdAt: Date.parse('2024-01-15T09:30:00Z'),
      updatedAt: Date.parse('2024-02-01T10:00:00Z'),
      contentHash: await sha256(note.title, note.body),
    }),
  });
  const body = await json<{ id: string; created: boolean; skippedFields: string[] }>(res);
  return { status: res.status, ...body };
}

/** The API calls `importArchive` needs, over this actor's session. */
function archiveClient(actor: Actor) {
  return {
    createNote: async (input: object) =>
      json<{ id: string; created: boolean }>(
        await api(actor, '/api/import/note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    uploadFile: async (noteId: string, filename: string, mime: string, bytes: Uint8Array) =>
      json<{ filename: string }>(
        await api(actor, `/api/notes/${noteId}/files`, {
          method: 'PUT',
          headers: { 'X-Filename': encodeURIComponent(filename), 'Content-Type': mime },
          body: bytes as unknown as BodyInit,
        }),
      ),
    listFiles: async (noteId: string) =>
      (await json<{ files: Array<{ filename: string }> }>(
        await api(actor, `/api/notes/${noteId}/files`),
      )).files.map((f) => f.filename),
    updateBody: async (noteId: string, body: string) => {
      await json(
        await api(actor, `/api/notes/${noteId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }),
      );
    },
  };
}

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`imp-alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`imp-bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
}, 30_000);

describe('an imported note keeps its id', () => {
  it('lands at the address the export gave it', async () => {
    const id = crypto.randomUUID();
    const result = await importNote(alice, { id, title: 'Kept', body: 'body' });

    expect(result.status).toBe(201);
    expect(result.id).toBe(id);
    const note = await json<NoteJson>(await api(alice, `/api/notes/${id}`));
    expect(note.title).toBe('Kept');
  });

  it('is recognised by that id on a second import, even once edited', async () => {
    const id = crypto.randomUUID();
    await importNote(alice, { id, title: 'Edited later', body: 'original' });
    await json(
      await api(alice, `/api/notes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'changed by hand' }),
      }),
    );

    // The same export, imported again: the hash no longer matches, the id still does.
    const again = await importNote(alice, { id, title: 'Edited later', body: 'original' });

    expect(again.status).toBe(200);
    expect(again.created).toBe(false);
    expect(again.id).toBe(id);
    const note = await json<NoteJson>(await api(alice, `/api/notes/${id}`));
    expect(note.body).toBe('changed by hand');
  });

  it('gets a fresh id when someone else already holds that one', async () => {
    const id = crypto.randomUUID();
    await importNote(alice, { id, title: 'Shared zip', body: 'same file, two people' });

    const bobs = await importNote(bob, { id, title: 'Shared zip', body: 'same file, two people' });

    expect(bobs.status).toBe(201);
    expect(bobs.created).toBe(true);
    expect(bobs.id).not.toBe(id);
    // And each sees only their own.
    expect((await api(bob, `/api/notes/${id}`)).status).toBe(404);
    expect((await api(alice, `/api/notes/${bobs.id}`)).status).toBe(404);
  });

  it('still dedupes by content when the note carries no id', async () => {
    const first = await importNote(alice, { title: 'No id', body: 'hashed' });
    const second = await importNote(alice, { title: 'No id', body: 'hashed' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('does not collapse two notes that share their text when each has its own id', async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const first = await importNote(alice, { id: firstId, title: 'Untitled', body: '' });
    const second = await importNote(alice, { id: secondId, title: 'Untitled', body: '' });

    expect(first.created).toBe(true);
    expect(first.id).toBe(firstId);
    expect(second.created).toBe(true);
    expect(second.id).toBe(secondId);

    const again = await importNote(alice, { id: firstId, title: 'Untitled', body: '' });
    expect(again.created).toBe(false);
    expect(again.id).toBe(firstId);
  });
});

describe('an export imported into another account', () => {
  it('arrives with the same notes, notebooks, tags, fields and files', async () => {
    const stamp = Date.now();
    const notebook = `Moved ${stamp}`;
    const created = await json<NoteJson>(
      await api(alice, '/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Round trip ${stamp}`,
          body: 'Read [the plan](files/plan.txt) and the rest.\n',
          tags: ['moving', 'two words'],
          notebook,
        }),
      }),
    );
    await json(
      await api(alice, `/api/notes/${created.id}/files`, {
        method: 'PUT',
        headers: { 'X-Filename': 'plan.txt', 'Content-Type': 'text/plain' },
        body: 'the plan',
      }),
    );
    // A custom field, so its value has to cross too.
    const nb = (
      await json<{ notebooks: Array<{ id: string; name: string }> }>(
        await api(alice, '/api/notebooks'),
      )
    ).notebooks.find((n) => n.name === notebook)!;
    const field = await json<{ id: string }>(
      await api(alice, `/api/notebooks/${nb.id}/fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Priority', type: 'number' }),
      }),
    );
    await json(
      await api(alice, `/api/notes/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { [field.id]: 3 } }),
      }),
    );
    const original = await json<NoteJson>(await api(alice, `/api/notes/${created.id}`));

    const exported = await api(alice, `/api/export?notebook=${encodeURIComponent(notebook)}`);
    const zip = { name: 'unbent-moved.zip', blob: await exported.blob() };

    const progress = await importArchive(zip, archiveClient(bob));

    expect(progress.created).toBe(1);
    expect(progress.failed).toBe(0);
    expect(progress.filesUploaded).toBe(1);

    // Alice holds the exported id on this same instance, so Bob's copy gets a fresh one —
    // the id survives only across instances, which one dev server cannot stage. Find the
    // copy by the notebook that came with it instead.
    const listed = await json<{ items: NoteJson[] }>(
      await api(bob, `/api/notes?notebook=${encodeURIComponent(notebook)}`),
    );
    expect(listed.items).toHaveLength(1);
    const copy = await json<NoteJson>(await api(bob, `/api/notes/${listed.items[0]!.id}`));
    expect(copy.id).not.toBe(created.id);
    expect(copy.title).toBe(original.title);
    expect(copy.body).toBe(original.body);
    expect(copy.tags.sort()).toEqual(['moving', 'two words']);
    expect(copy.notebook).toBe(notebook);
    // Frontmatter timestamps are whole seconds; that is the codec's precision, not a loss here.
    expect(Math.floor(copy.createdAt / 1000)).toBe(Math.floor(original.createdAt / 1000));
    expect(Math.floor(copy.updatedAt / 1000)).toBe(Math.floor(original.updatedAt / 1000));
    expect(copy.fields?.map((f) => [f.name, f.value])).toEqual([['Priority', 3]]);

    const files = await json<{ files: Array<{ filename: string; contentType: string }> }>(
      await api(bob, `/api/notes/${copy.id}/files`),
    );
    expect(files.files).toEqual([
      expect.objectContaining({ filename: 'plan.txt', contentType: 'text/plain' }),
    ]);
    expect(await (await api(bob, `/api/notes/${copy.id}/files/plan.txt`)).text()).toBe('the plan');

    // Importing the same archive again is a no-op.
    const again = await importArchive(zip, archiveClient(bob));
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(1);
    expect(again.filesUploaded).toBe(0);
  });
});
