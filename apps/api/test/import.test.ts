/**
 * Import round-trip: the other half of the disaster-recovery guarantee.
 *
 * `export.test.ts` asserts the archive is real. This asserts it comes back: what one
 * account exports, another can import — same ids, same notebooks, same tags, same fields,
 * same files — and importing it again changes nothing.
 */
import { BlobWriter } from '@zip.js/zip.js';
import { importArchive, writeArchive, type ExportSource } from '@unbent/enex';
import type { ExportPage, FieldDef, NotebookSummary } from '@unbent/shared';
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

/**
 * A notebook's export, built the way the web app builds one: from pages of
 * `/api/export/notes`, each file through its note's route, and the notebooks' definitions.
 * The zip the browser would hand the person, so what is imported below is the real thing.
 */
async function exportNotebook(actor: Actor, notebook: string): Promise<Blob> {
  const source: ExportSource = {
    page: async (filter, cursor) => {
      const params = new URLSearchParams({ notebook: filter.notebook ?? '' });
      if (cursor) params.set('cursor', cursor);
      return json<ExportPage>(await api(actor, `/api/export/notes?${params}`));
    },
    file: async (noteId, filename) => {
      const res = await api(actor, `/api/notes/${noteId}/files/${encodeURIComponent(filename)}`);
      if (!res.ok || !res.body) throw new Error(`file ${filename}: ${res.status}`);
      return res.body;
    },
    notebooks: async () =>
      (await json<{ notebooks: NotebookSummary[] }>(await api(actor, '/api/notebooks'))).notebooks,
    fields: async (id) => (await json<{ fields: FieldDef[] }>(await api(actor, `/api/notebooks/${id}/fields`))).fields,
  };
  const writer = new BlobWriter('application/zip');
  await writeArchive(writer.writable, { notebook }, source, new AbortController().signal);
  return writer.getData();
}

interface NoteJson {
  id: string;
  title: string;
  body: string;
  tags: string[];
  notebook?: string | null;
  createdAt: number;
  updatedAt: number;
  fields?: Array<{ name: string; value: string | number | boolean | string[] }>;
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
    fields?: Record<string, string | number | boolean | string[]>;
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

/**
 * The API calls `importArchive` needs, over this actor's session. `indexing` collects what
 * each upload said about reading its file, so a test can tell whether the Worker started.
 */
function archiveClient(actor: Actor, indexing: string[] = []) {
  return {
    createNote: async (input: object) =>
      json<{ id: string; created: boolean }>(
        await api(actor, '/api/import/note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),
    uploadFile: async (
      noteId: string,
      filename: string,
      mime: string,
      bytes: Uint8Array,
      options?: { textSupplied?: boolean },
    ) => {
      const query = options?.textSupplied ? '?text=supplied' : '';
      const stored = await json<{ filename: string; indexing?: string }>(
        await api(actor, `/api/notes/${noteId}/files${query}`, {
          method: 'PUT',
          headers: { 'X-Filename': encodeURIComponent(filename), 'Content-Type': mime },
          body: bytes as unknown as BodyInit,
        }),
      );
      indexing.push(stored.indexing ?? 'none');
      return stored;
    },
    saveFileText: async (noteId: string, filename: string, text: string, readBy?: 'vision') => {
      const res = await api(actor, `/api/notes/${noteId}/files/${encodeURIComponent(filename)}/text`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(readBy ? { text, readBy } : { text }),
      });
      if (!res.ok) throw new Error(`text ${filename}: ${res.status} ${await res.text()}`);
    },
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
    importNotebook: async (definition: object) =>
      json<{ id: string; skipped: Array<{ name: string; reason: string; kind?: string }> }>(
        await api(actor, '/api/import/notebook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(definition),
        }),
      ),
  };
}

interface FieldJson {
  id: string;
  name: string;
  type: string;
  options: string[];
  scale: { max: number; step: number } | null;
  currency: string | null;
}

async function fieldsOf(actor: Actor, notebook: string): Promise<FieldJson[]> {
  const nb = (
    await json<{ notebooks: Array<{ id: string; name: string }> }>(await api(actor, '/api/notebooks'))
  ).notebooks.find((n) => n.name === notebook);
  if (!nb) throw new Error(`no notebook ${notebook}`);
  return (await json<{ fields: FieldJson[] }>(await api(actor, `/api/notebooks/${nb.id}/fields`))).fields;
}

async function notebookOf(actor: Actor, notebook: string): Promise<NotebookSummary> {
  const nb = (
    await json<{ notebooks: NotebookSummary[] }>(await api(actor, '/api/notebooks'))
  ).notebooks.find((n) => n.name === notebook);
  if (!nb) throw new Error(`no notebook ${notebook}`);
  return nb;
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

  /**
   * Ids are unique per account, not per instance: each account's notes live in a database
   * of their own, so the same archive imported by two people keeps its ids for both, and
   * `(owner, id)` is the key anything cross-account would use. On the shared database the
   * second import had to mint a fresh id because the column was one primary key for
   * everyone; that was the constraint, never the intent.
   */
  it('keeps the id when someone else holds the same one in their own account', async () => {
    const id = crypto.randomUUID();
    await importNote(alice, { id, title: 'Shared zip', body: 'same file, two people' });

    const bobs = await importNote(bob, { id, title: 'Shared zip', body: 'same file, two people' });

    expect(bobs.status).toBe(201);
    expect(bobs.created).toBe(true);
    expect(bobs.id).toBe(id);
    // And each sees only their own copy under that id.
    const alices = await json<NoteJson>(await api(alice, `/api/notes/${id}`));
    const bobsNote = await json<NoteJson>(await api(bob, `/api/notes/${id}`));
    expect(alices.title).toBe('Shared zip');
    expect(bobsNote.title).toBe('Shared zip');
    await api(alice, `/api/notes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alice edited hers' }),
    });
    expect((await json<NoteJson>(await api(bob, `/api/notes/${id}`))).title).toBe('Shared zip');
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

    const zip = { name: 'unbent-moved.zip', blob: await exportNotebook(alice, notebook) };

    const progress = await importArchive(zip, archiveClient(bob));

    expect(progress.created).toBe(1);
    expect(progress.failed).toBe(0);
    expect(progress.filesUploaded).toBe(1);

    // The exported id survives into Bob's account, although Alice still holds it in hers:
    // each account is its own database. Found by the notebook that came with it, which is
    // how a restore is judged, and then read back by the id it kept.
    const listed = await json<{ items: NoteJson[] }>(
      await api(bob, `/api/notes?notebook=${encodeURIComponent(notebook)}`),
    );
    expect(listed.items).toHaveLength(1);
    const copy = await json<NoteJson>(await api(bob, `/api/notes/${listed.items[0]!.id}`));
    expect(copy.id).toBe(created.id);
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

describe('the text read from files, across an import', () => {
  /**
   * A restore used to read every file again: each PDF through extraction, each picture
   * back to pending for the vision model. The archive now carries the text beside each
   * file, and the import records it rather than reading anything.
   */
  it('arrives as it was, with nothing left pending and nothing read again', async () => {
    const stamp = Date.now();
    const notebook = `Paperwork ${stamp}`;
    const source = await signUp(`imp-txt-a-${stamp}@example.test`, 'txt-password-1234', 'A');
    const target = await signUp(`imp-txt-b-${stamp}@example.test`, 'txt-password-1234', 'B');

    const created = await json<NoteJson>(
      await api(source, '/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Statement and receipt', body: '', notebook }),
      }),
    );
    const files = [
      { filename: 'statement.pdf', mime: 'application/pdf', text: 'Balance due 42.00\nPage 2 of 2' },
      { filename: 'receipt.jpg', mime: 'image/jpeg', text: 'Receipt from Acme, 3 items', readBy: 'vision' as const },
    ];
    // `text=supplied` here too: a local Worker may hold a real vision key, and these bytes
    // are not a picture worth paying to read.
    for (const f of files) {
      await json(
        await api(source, `/api/notes/${created.id}/files?text=supplied`, {
          method: 'PUT',
          headers: { 'X-Filename': f.filename, 'Content-Type': f.mime },
          body: `${f.filename} bytes`,
        }),
      );
      const res = await api(source, `/api/notes/${created.id}/files/${f.filename}/text`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: f.text, ...(f.readBy ? { readBy: f.readBy } : {}) }),
      });
      expect(res.ok).toBe(true);
    }

    const pending = async (actor: Actor) => ({
      text: (await json<{ remaining: number }>(await api(actor, '/api/attachments/pending-text'))).remaining,
      vision: (await json<{ remaining: number }>(await api(actor, '/api/attachments/pending-vision'))).remaining,
    });
    expect(await pending(source)).toEqual({ text: 0, vision: 0 });

    const zip = { name: 'unbent-paperwork.zip', blob: await exportNotebook(source, notebook) };
    const indexing: string[] = [];
    const progress = await importArchive(zip, archiveClient(target, indexing), { extractText: true });
    expect(progress).toMatchObject({ created: 1, failed: 0, filesUploaded: 2, filesIndexed: 2 });

    // The Worker was told before the bytes landed that the text would follow, so it started
    // no read of its own — no extraction, and no vision request — and nothing waits.
    expect(indexing).toEqual(['client', 'client']);
    expect(await pending(target)).toEqual({ text: 0, vision: 0 });

    const read = async (actor: Actor) => {
      const [note] = (await json<{ notes: Array<{ attachments?: Array<Record<string, string>> }> }>(
        await api(actor, `/api/export/notes?notebook=${encodeURIComponent(notebook)}`),
      )).notes;
      return note!.attachments!.sort((a, b) => a.filename!.localeCompare(b.filename!));
    };
    expect(await read(target)).toEqual(await read(source));
    expect((await read(target)).find((a) => a.filename === 'receipt.jpg')).toMatchObject({ readBy: 'vision' });
  });
});

describe('notebook definitions across an import', () => {
  it('rebuild the notebook as it was, not as its values suggest', async () => {
    const stamp = Date.now();
    const notebook = `Shopping ${stamp}`;
    await json(
      await api(alice, '/api/notebooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: notebook }),
      }),
    );
    const nb = (
      await json<{ notebooks: Array<{ id: string; name: string }> }>(await api(alice, '/api/notebooks'))
    ).notebooks.find((n) => n.name === notebook)!;
    // Its icon, and the guidance Auto-fill files by: neither lives on a note.
    await api(alice, `/api/notebooks/${nb.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '🛒', purpose: 'Things to buy: where, how much, whether ordered.' }),
    });
    const field = async (body: object) =>
      json<FieldJson>(
        await api(alice, `/api/notebooks/${nb.id}/fields`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const url = await field({ name: 'Url', type: 'url' });
    const status = await field({ name: 'Status', type: 'select', options: ['Want', 'Ordered', 'Passed'] });
    const priority = await field({ name: 'Priority', type: 'number', scale: { max: 5, step: 0.5 } });
    await field({ name: 'Image', type: 'url' });
    await json(
      await api(alice, '/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Bike',
          notebook,
          fields: { [url.id]: 'https://x.test/bike', [status.id]: 'Want', [priority.id]: 4.5 },
        }),
      }),
    );

    const zip = { name: 'unbent-shopping.zip', blob: await exportNotebook(alice, notebook) };
    const progress = await importArchive(zip, archiveClient(bob));
    expect(progress).toMatchObject({ created: 1, failed: 0 });

    expect(await notebookOf(bob, notebook)).toMatchObject({
      emoji: '🛒',
      purpose: 'Things to buy: where, how much, whether ordered.',
    });

    // Same types, options, scale and order — including the field no note had a value for,
    // which inference from values could never have brought back.
    const copied = await fieldsOf(bob, notebook);
    expect(copied.map(({ name, type, options, scale }) => ({ name, type, options, scale }))).toEqual([
      { name: 'Url', type: 'url', options: [], scale: null },
      { name: 'Status', type: 'select', options: ['Want', 'Ordered', 'Passed'], scale: null },
      { name: 'Priority', type: 'number', options: [], scale: { max: 5, step: 0.5 } },
      { name: 'Image', type: 'url', options: [], scale: null },
    ]);
    const listed = await json<{ items: NoteJson[] }>(
      await api(bob, `/api/notes?notebook=${encodeURIComponent(notebook)}`),
    );
    const copy = await json<NoteJson>(await api(bob, `/api/notes/${listed.items[0]!.id}`));
    expect(copy.fields?.map((f) => [f.name, f.value])).toEqual([
      ['Url', 'https://x.test/bike'],
      ['Status', 'Want'],
      ['Priority', 4.5],
    ]);
  });

  it('add to a notebook that already exists, and never alter what it has', async () => {
    const stamp = Date.now();
    const notebook = `Receipts ${stamp}`;
    const client = archiveClient(bob);
    await client.importNotebook({
      name: notebook,
      emoji: '🧾',
      purpose: 'Paper receipts, one per note.',
      fields: [
        { name: 'Merchant', type: 'text' },
        { name: 'Kind', type: 'select', options: ['Food'] },
        { name: 'Score', type: 'number', scale: { max: 5, step: 1 } },
        { name: 'Price', type: 'number' },
        { name: 'Fee', type: 'number', currency: 'USD' },
      ],
    });

    const second = await client.importNotebook({
      name: notebook,
      // The notebook has its own of both: kept, and the archive's named as not applied.
      emoji: '🧮',
      purpose: 'Something else entirely.',
      fields: [
        // Same type: nothing to do. Different type: left alone, and said so.
        { name: 'merchant', type: 'url' },
        // A select's options merge; a case-only duplicate is not a new option.
        { name: 'Kind', type: 'select', options: ['food', 'Travel'] },
        // A scale is never changed on the way in — tightening one clears values.
        { name: 'Score', type: 'number', scale: { max: 10, step: 0.5 } },
        // New, so it appends after what was there.
        { name: 'Paid', type: 'checkbox' },
        // A currency is display only: a plain number gains one, a number in another
        // currency keeps its own and says so.
        { name: 'Price', type: 'number', currency: 'EUR' },
        { name: 'Fee', type: 'number', currency: 'EUR' },
      ],
    });
    expect(second.skipped).toEqual([
      { kind: 'emoji', name: '🧮', reason: 'Already 🧾 here; left as it is' },
      { kind: 'purpose', name: 'Something else entirely.', reason: 'Already has a purpose of its own; left as it is' },
      { name: 'merchant', reason: 'Already here as text, not url; left as it is' },
      { name: 'Fee', reason: 'Already here in USD, not EUR; left as it is' },
    ]);
    expect(await notebookOf(bob, notebook)).toMatchObject({
      emoji: '🧾',
      purpose: 'Paper receipts, one per note.',
    });

    // The same values again are not a conflict, and say nothing.
    const third = await client.importNotebook({ name: notebook, emoji: '🧾', fields: [] });
    expect(third.skipped).toEqual([]);

    const fields = await fieldsOf(bob, notebook);
    expect(fields.map(({ name, type, options, scale, currency }) => ({ name, type, options, scale, currency }))).toEqual([
      { name: 'Merchant', type: 'text', options: [], scale: null, currency: null },
      { name: 'Kind', type: 'select', options: ['Food', 'Travel'], scale: null, currency: null },
      { name: 'Score', type: 'number', options: [], scale: { max: 5, step: 1 }, currency: null },
      { name: 'Price', type: 'number', options: [], scale: null, currency: 'EUR' },
      { name: 'Fee', type: 'number', options: [], scale: null, currency: 'USD' },
      { name: 'Paid', type: 'checkbox', options: [], scale: null, currency: null },
    ]);
  });

  it('give an existing notebook the emoji and purpose it does not have', async () => {
    const notebook = `Bare ${Date.now()}`;
    await json(
      await api(bob, '/api/notebooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: notebook }),
      }),
    );
    const result = await archiveClient(bob).importNotebook({
      name: notebook,
      emoji: '📦',
      purpose: 'Shipping labels.',
      fields: [],
    });
    expect(result.skipped).toEqual([]);
    expect(await notebookOf(bob, notebook)).toMatchObject({ emoji: '📦', purpose: 'Shipping labels.' });
  });

  it('make a multi-select from a list value, and add the options a later value needs', async () => {
    const notebook = `Games ${Date.now()}`;
    const first = await importNote(bob, { title: 'One', body: '', notebook, fields: { Platforms: ['PC', 'PS5'] } });
    expect(first.skippedFields).toEqual([]);
    // A list with no definition makes a multi-select, with the list as its first options.
    let [platforms] = await fieldsOf(bob, notebook);
    expect(platforms).toMatchObject({ name: 'Platforms', type: 'multiselect', options: ['PC', 'PS5'] });

    // A later value naming an option the field lacks adds it rather than being dropped:
    // add, never alter, applied to a value.
    const second = await importNote(bob, { title: 'Two', body: '', notebook, fields: { Platforms: ['Switch'] } });
    expect(second.skippedFields).toEqual([]);
    [platforms] = await fieldsOf(bob, notebook);
    expect(platforms!.options).toEqual(['PC', 'PS5', 'Switch']);

    const note = await json<NoteJson>(await api(bob, `/api/notes/${second.id}`));
    expect(note.fields?.map((f) => [f.name, f.value])).toEqual([['Platforms', ['Switch']]]);

    // The same for a select: a value the options lack is an option the notebook gains.
    const kind = await importNote(bob, { title: 'Three', body: '', notebook, fields: { Kind: 'RPG' } });
    expect(kind.skippedFields).toEqual([]);
    const nb = (await json<{ notebooks: Array<{ id: string; name: string }> }>(await api(bob, '/api/notebooks'))).notebooks.find((n) => n.name === notebook)!;
    const kindField = (await fieldsOf(bob, notebook)).find((f) => f.name === 'Kind')!;
    await api(bob, `/api/notebooks/${nb.id}/fields/${kindField.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'select' }),
    });
    const strategy = await importNote(bob, { title: 'Four', body: '', notebook, fields: { Kind: 'Strategy' } });
    expect(strategy.skippedFields).toEqual([]);
    expect((await fieldsOf(bob, notebook)).find((f) => f.name === 'Kind')!.options).toEqual(['RPG', 'Strategy']);
  });

  it('refuse a file the field editor would refuse', async () => {
    const res = await api(bob, '/api/import/notebook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', fields: [{ name: 'title', type: 'text' }] }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * A syncing client sends Evernote's own markup and the server converts it. The key it
 * files the note under has to tell apart the same notes the ENEX importer does, or a note
 * with its own attachment under a shared file name is lost on this path too.
 */
describe('an Evernote note sent as ENML', () => {
  async function importEnml(actor: Actor, over: { md5: string; tags?: string[] }) {
    const res = await api(actor, '/api/import/enml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Parking receipt ${runStamp}`,
        enml: `<en-note><en-media hash="${over.md5}" type="image/jpeg"/></en-note>`,
        tags: over.tags ?? [],
        createdAt: Date.parse('2024-01-15T09:30:00Z'),
        updatedAt: Date.parse('2024-01-15T09:30:00Z'),
        resources: [{ md5: over.md5, filename: 'scan.jpg', mime: 'image/jpeg' }],
      }),
    });
    return json<{ id: string; created: boolean }>(res);
  }

  const runStamp = Date.now();
  const first = '5d41402abc4b2a76b9719d911017c592';
  const second = '7d793037a0760186574b0282f2f435e7';

  it('keeps two notes whose text matches but whose attachment does not', async () => {
    const a = await importEnml(alice, { md5: first });
    const b = await importEnml(alice, { md5: second });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it('recognises the same note sent again, whatever order its tags arrive in', async () => {
    const a = await importEnml(alice, { md5: first, tags: ['car', 'receipts'] });
    const again = await importEnml(alice, { md5: first, tags: ['receipts', 'car'] });

    expect(a.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.id).toBe(a.id);
  });
});
