/**
 * What happens to custom field values when the notebook that defined them is deleted.
 *
 * The rule is that no value is ever destroyed by deleting a notebook: the definitions are
 * tombstoned (0017) so every value stays readable on the note holding it, labelled with
 * the deleted notebook's name. Two cases motivated it and both are checked here — a note
 * that had already moved away and was losing data it was promised it would keep, and a
 * note cascaded to the trash, where a restore used to return the note stripped.
 *
 * The rest is the other half of the bargain: a tombstone must be invisible everywhere a
 * field can be listed, counted, sorted by or named, or it would reappear as a ghost
 * notebook in the UI. That is the failure mode with the most places to get it wrong, so
 * each listing is asserted rather than assumed.
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

function asUser(actor: Actor, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: actor.cookie, Origin: ORIGIN },
  };
}

async function post<T>(actor: Actor, path: string, body: unknown): Promise<T> {
  const res = await fetch(
    `${BASE}${path}`,
    asUser(actor, { method: 'POST', body: JSON.stringify(body) }),
  );
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function patch<T>(actor: Actor, path: string, body: unknown): Promise<T> {
  const res = await fetch(
    `${BASE}${path}`,
    asUser(actor, { method: 'PATCH', body: JSON.stringify(body) }),
  );
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function get<T>(actor: Actor, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, asUser(actor));
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface FieldValue {
  fieldId: string;
  name: string;
  value: unknown;
  notebook: string;
}

interface Note {
  id: string;
  title: string;
  fields?: FieldValue[];
}

interface Notebook {
  id: string;
  name: string;
  count: number;
  fields: number;
}

/** A fresh notebook with one text field, and the ids for both. */
async function notebookWithField(
  actor: Actor,
  name: string,
  field: string,
): Promise<{ notebookId: string; fieldId: string }> {
  const nb = await post<{ id: string }>(actor, '/api/notebooks', { name });
  const f = await post<{ id: string }>(actor, `/api/notebooks/${nb.id}/fields`, {
    name: field,
    type: 'text',
  });
  return { notebookId: nb.id, fieldId: f.id };
}

function valuesOf(note: Note): Array<[string, unknown, string]> {
  return (note.fields ?? []).map((f) => [f.name, f.value, f.notebook]);
}

let actor: Actor;

beforeAll(async () => {
  actor = await signUp(`nbdelete-${Date.now()}@example.test`, 'nbdelete-pass-1', 'N');
});

describe('deleting a notebook keeps the values its fields held', () => {
  it('leaves a note that had already moved away untouched', async () => {
    // The bug this covers was scoped by field rather than by note, so deleting a notebook
    // stripped values from notes that had left it long before and were otherwise
    // uninvolved — the opposite of 0014's promise that a note keeps what it carries.
    const { notebookId, fieldId } = await notebookWithField(actor, `Coupons ${Date.now()}`, 'Merchant');
    await post(actor, '/api/notebooks', { name: `Podcasts ${Date.now()}` });
    const note = await post<Note>(actor, '/api/notes', {
      title: 'Left',
      body: '',
      notebook: (await get<{ notebooks: Notebook[] }>(actor, '/api/notebooks')).notebooks.find(
        (n) => n.id === notebookId,
      )!.name,
      fields: { [fieldId]: 'Globex' },
    });

    const elsewhere = (await get<{ notebooks: Notebook[] }>(actor, '/api/notebooks')).notebooks.find(
      (n) => n.name.startsWith('Podcasts '),
    )!;
    await patch(actor, `/api/notes/${note.id}`, { notebook: elsewhere.name });

    const before = await get<Note>(actor, `/api/notes/${note.id}`);
    expect(valuesOf(before)).toHaveLength(1);

    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}`,
      asUser(actor, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);

    const after = await get<Note>(actor, `/api/notes/${note.id}`);
    const [name, value, label] = valuesOf(after)[0]!;
    expect([name, value]).toEqual(['Merchant', 'Globex']);
    // Still labelled with the deleted notebook's name, which no longer has a row.
    expect(label).toMatch(/^Coupons /);
  });

  it('returns a cascaded note from the trash with its values intact', async () => {
    // The cascade button offers a recoverable delete. Destroying the values on the way to
    // the trash made that claim false: the note came back stripped.
    const stamp = Date.now();
    const { notebookId, fieldId } = await notebookWithField(actor, `Receipts ${stamp}`, 'Vendor');
    const nbName = (await get<{ notebooks: Notebook[] }>(actor, '/api/notebooks')).notebooks.find(
      (n) => n.id === notebookId,
    )!.name;
    const note = await post<Note>(actor, '/api/notes', {
      title: 'Cascaded',
      body: '',
      notebook: nbName,
      fields: { [fieldId]: 'Initech' },
    });

    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}?trashNotes=1`,
      asUser(actor, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);

    // Visible in the trash, still carrying the value and its origin label.
    const trash = await get<{ items: Note[] }>(actor, '/api/notes?trashed=1');
    const trashed = trash.items.find((n) => n.id === note.id);
    expect(trashed && valuesOf(trashed)).toEqual([['Vendor', 'Initech', nbName]]);

    await post(actor, `/api/notes/${note.id}/restore`, {});

    const restored = await get<Note>(actor, `/api/notes/${note.id}`);
    expect(restored.title).toBe('Cascaded');
    expect(valuesOf(restored)).toEqual([['Vendor', 'Initech', nbName]]);
  });
});

describe('a tombstoned definition stays out of sight', () => {
  let fieldId: string;
  let noteId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    const made = await notebookWithField(actor, `Hidden ${stamp}`, 'Policy');
    fieldId = made.fieldId;
    const nbName = (await get<{ notebooks: Notebook[] }>(actor, '/api/notebooks')).notebooks.find(
      (n) => n.id === made.notebookId,
    )!.name;
    const note = await post<Note>(actor, '/api/notes', {
      title: 'Holds a tombstoned value',
      body: '',
      notebook: nbName,
      fields: { [fieldId]: 'AB-1234' },
    });
    noteId = note.id;
    await fetch(`${BASE}/api/notebooks/${made.notebookId}`, asUser(actor, { method: 'DELETE' }));
  });

  it('is gone from the notebook listing', async () => {
    const { notebooks } = await get<{ notebooks: Notebook[] }>(actor, '/api/notebooks');
    expect(notebooks.some((n) => n.name.startsWith('Hidden '))).toBe(false);
  });

  it('cannot be sorted by', async () => {
    const res = await fetch(`${BASE}/api/notes?sortField=${fieldId}`, asUser(actor));
    expect(res.status).toBe(400);
  });

  it('still reads back on the note that holds it', async () => {
    const note = await get<Note>(actor, `/api/notes/${noteId}`);
    const [name, value] = valuesOf(note)[0]!;
    expect([name, value]).toEqual(['Policy', 'AB-1234']);
  });
});

describe('tombstones are swept once nothing needs them', () => {
  // A tombstone exists only to keep its values readable. The proof it is gone is that its
  // notebook name and field name are free again: a live definition would collide.
  async function recreate(name: string, field: string): Promise<number> {
    const nb = await post<{ id: string }>(actor, '/api/notebooks', { name });
    const res = await fetch(
      `${BASE}/api/notebooks/${nb.id}/fields`,
      asUser(actor, { method: 'POST', body: JSON.stringify({ name: field, type: 'text' }) }),
    );
    return res.status;
  }

  it('sweeps at once when the notebook held no values', async () => {
    const name = `Empty ${Date.now()}`;
    const { notebookId } = await notebookWithField(actor, name, 'Ref');
    await fetch(`${BASE}/api/notebooks/${notebookId}`, asUser(actor, { method: 'DELETE' }));
    expect(await recreate(name, 'Ref')).toBe(201);
  });

  it('sweeps when the last value is cleared', async () => {
    const name = `Cleared ${Date.now()}`;
    const { notebookId, fieldId } = await notebookWithField(actor, name, 'Merchant');
    const note = await post<Note>(actor, '/api/notes', {
      title: 'Clears',
      body: '',
      notebook: name,
      fields: { [fieldId]: 'Acme' },
    });
    await fetch(`${BASE}/api/notebooks/${notebookId}`, asUser(actor, { method: 'DELETE' }));

    // The editor shows a value from a deleted notebook read-only with a Clear; this is it.
    await patch(actor, `/api/notes/${note.id}`, { fields: { [fieldId]: null } });
    expect(valuesOf(await get<Note>(actor, `/api/notes/${note.id}`))).toEqual([]);
    expect(await recreate(name, 'Merchant')).toBe(201);
  });

  it('sweeps when the note holding the last value is purged', async () => {
    const name = `Purged ${Date.now()}`;
    const { notebookId, fieldId } = await notebookWithField(actor, name, 'Vendor');
    const note = await post<Note>(actor, '/api/notes', {
      title: 'Doomed',
      body: '',
      notebook: name,
      fields: { [fieldId]: 'Initech' },
    });
    await fetch(
      `${BASE}/api/notebooks/${notebookId}?trashNotes=1`,
      asUser(actor, { method: 'DELETE' }),
    );
    await fetch(`${BASE}/api/notes/${note.id}/permanent`, asUser(actor, { method: 'DELETE' }));
    expect(await recreate(name, 'Vendor')).toBe(201);
  });
});
