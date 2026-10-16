/**
 * Editing a select's or multi-select's options by what changes, over HTTP — the route the
 * notebook editor's rename and sort use. The store's rules are pinned in its own tests;
 * these pin what the route makes of each answer: a rename moves the notes that held the
 * old name, a rename onto an existing option is a 409 that says `merge` until the body
 * asks for one, and every other refusal is a 400 with the store's sentence.
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
  const res = await fetch(`${BASE}${path}`, asUser(actor, { method: 'POST', body: JSON.stringify(body) }));
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface Field {
  id: string;
  name: string;
  options: string[];
}

interface NoteItem {
  id: string;
  title: string;
  fields?: Array<{ fieldId: string; value: unknown }>;
}

/** The value a note holds for one field, or undefined when it holds none. */
async function valueOf(actor: Actor, notebook: string, title: string, fieldId: string): Promise<unknown> {
  const res = await fetch(`${BASE}/api/notes?notebook=${encodeURIComponent(notebook)}`, asUser(actor));
  const page = (await res.json()) as { items: NoteItem[] };
  const note = page.items.find((n) => n.title === title);
  return note?.fields?.find((f) => f.fieldId === fieldId)?.value;
}

async function edit(body: unknown): Promise<Response> {
  return fetch(
    `${BASE}/api/notebooks/${notebookId}/fields/${category}/options`,
    asUser(actor, { method: 'POST', body: JSON.stringify(body) }),
  );
}

let actor: Actor;
let notebookId: string;
let notebook: string;
let category: string; // select
let platforms: string; // multi-select

beforeAll(async () => {
  const stamp = Date.now();
  actor = await signUp(`optedit-${stamp}@example.test`, 'optedit-pass-1', 'O');
  notebook = `OptEdit ${stamp}`;

  await post(actor, '/api/notes', { title: 'seed', body: 'x', notebook });
  const { notebooks } = (await fetch(`${BASE}/api/notebooks`, asUser(actor)).then((r) => r.json())) as {
    notebooks: Array<{ id: string; name: string }>;
  };
  const nb = notebooks.find((n) => n.name === notebook);
  if (!nb) throw new Error('notebook was not created');
  notebookId = nb.id;

  category = (await post<Field>(actor, `/api/notebooks/${notebookId}/fields`, {
    name: 'Category',
    type: 'select',
    options: ['Grocery', 'Groceries', 'Tech'],
  })).id;
  platforms = (await post<Field>(actor, `/api/notebooks/${notebookId}/fields`, {
    name: 'Platforms',
    type: 'multiselect',
    options: ['PC', 'Switch'],
  })).id;

  await post(actor, '/api/notes', { title: 'tech-1', body: 'x', notebook, fields: { [category]: 'Tech' } });
  await post(actor, '/api/notes', { title: 'groc-1', body: 'x', notebook, fields: { [category]: 'Grocery' } });
  await post(actor, '/api/notes', { title: 'groc-2', body: 'x', notebook, fields: { [category]: 'Groceries' } });
  await post(actor, '/api/notes', {
    title: 'multi-1',
    body: 'x',
    notebook,
    fields: { [platforms]: ['PC', 'Switch'] },
  });
});

describe('renaming an option', () => {
  it('renames it in place and moves the notes that held it', async () => {
    const res = await edit({ rename: [{ from: 'Tech', to: 'Electronics' }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { field: Field; renamed: Array<{ from: string; to: string; notes: number }> };
    expect(body.field.options).toEqual(['Grocery', 'Groceries', 'Electronics']);
    expect(body.renamed).toEqual([{ from: 'Tech', to: 'Electronics', notes: 1 }]);
    expect(await valueOf(actor, notebook, 'tech-1', category)).toBe('Electronics');
  });

  it('moves a multi-select member and keeps the rest of the list', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${platforms}/options`,
      asUser(actor, { method: 'POST', body: JSON.stringify({ rename: [{ from: 'Switch', to: 'Switch 2' }] }) }),
    );
    expect(res.status).toBe(200);
    expect(await valueOf(actor, notebook, 'multi-1', platforms)).toEqual(['PC', 'Switch 2']);
  });
});

describe('merging two options', () => {
  it('is a 409 that says merge, and changes nothing, until merge is asked for', async () => {
    const res = await edit({ rename: [{ from: 'Grocery', to: 'Groceries' }] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; merge?: boolean };
    expect(body.merge).toBe(true);
    expect(body.error).toContain('Groceries');
    expect(await valueOf(actor, notebook, 'groc-1', category)).toBe('Grocery');
  });

  it('folds the two into one with merge', async () => {
    const res = await edit({ rename: [{ from: 'Grocery', to: 'Groceries' }], merge: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { field: Field };
    expect(body.field.options).toEqual(['Groceries', 'Electronics']);
    expect(await valueOf(actor, notebook, 'groc-1', category)).toBe('Groceries');
    expect(await valueOf(actor, notebook, 'groc-2', category)).toBe('Groceries');
  });
});

describe('sorting and refusals', () => {
  it('sorts the list alphabetically', async () => {
    const res = await edit({ add: ['Books'], sort: 'alpha' });
    const body = (await res.json()) as { field: Field };
    expect(body.field.options).toEqual(['Books', 'Electronics', 'Groceries']);
  });

  it('is a 400 with the store\'s sentence for an option the field lacks', async () => {
    const res = await edit({ rename: [{ from: 'Nope', to: 'Yes' }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('"Nope"');
  });

  it('is a 400 for an edit that asks for nothing', async () => {
    expect((await edit({})).status).toBe(400);
  });

  it('404s a field that is not yours', async () => {
    const other = await signUp(`optedit-other-${Date.now()}@example.test`, 'other-pass-123', 'X');
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/options`,
      asUser(other, { method: 'POST', body: JSON.stringify({ sort: 'alpha' }) }),
    );
    expect(res.status).toBe(404);
  });
});
