/**
 * Removing a select or multi-select option, and what becomes of the notes that hold it.
 *
 * The rule is *keep by default*: taking an option off the field's list does not touch a
 * note's stored value, which is what lets a value show as "no longer an option" instead of
 * vanishing. Clearing is the opt-in — a deliberate cleanup the client confirms — and only
 * then are the notes rewritten. This is the real query path, so the two storage shapes are
 * both exercised: a select stores the option as the whole value, a multi-select as one
 * member of a JSON list, and clearing a member must leave the rest of the list intact.
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

let actor: Actor;
let notebookId: string;
let notebook: string;
let category: string; // select
let platforms: string; // multi-select

beforeAll(async () => {
  const stamp = Date.now();
  actor = await signUp(`optremove-${stamp}@example.test`, 'optremove-pass-1', 'O');
  notebook = `OptRemove ${stamp}`;

  // The notebook comes into being when the first note is filed in it.
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
    options: ['Bike', 'Tech', 'Other'],
  })).id;
  platforms = (await post<Field>(actor, `/api/notebooks/${notebookId}/fields`, {
    name: 'Platforms',
    type: 'multiselect',
    options: ['PC', 'PS5', 'Switch'],
  })).id;

  // Two notes on "Other", one on "Tech"; one multi-select note holding "Switch" among others.
  await post(actor, '/api/notes', { title: 'other-1', body: 'x', notebook, fields: { [category]: 'Other' } });
  await post(actor, '/api/notes', { title: 'other-2', body: 'x', notebook, fields: { [category]: 'Other' } });
  await post(actor, '/api/notes', { title: 'tech-1', body: 'x', notebook, fields: { [category]: 'Tech' } });
  await post(actor, '/api/notes', {
    title: 'multi-1',
    body: 'x',
    notebook,
    fields: { [platforms]: ['PC', 'Switch'] },
  });
  await post(actor, '/api/notes', {
    title: 'multi-2',
    body: 'x',
    notebook,
    fields: { [platforms]: ['Switch'] },
  });
});

describe('option usage count', () => {
  it('counts the notes holding a select option', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/option-usage?option=Other`,
      asUser(actor),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notes: 2 });
  });

  it('counts a multi-select option as membership, not equality', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${platforms}/option-usage?option=Switch`,
      asUser(actor),
    );
    // "Switch" is one member of multi-1's ["PC","Switch"] and the whole of multi-2's.
    expect(await res.json()).toEqual({ notes: 2 });
  });

  it('is zero for an option no note uses', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/option-usage?option=Bike`,
      asUser(actor),
    );
    expect(await res.json()).toEqual({ notes: 0 });
  });

  it('404s for a field that is not yours', async () => {
    const other = await signUp(`optremove-other-${Date.now()}@example.test`, 'other-pass-123', 'X');
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/option-usage?option=Other`,
      asUser(other),
    );
    expect(res.status).toBe(404);
  });
});

describe('removing an option, keeping values', () => {
  it('drops the option from the list but leaves the notes holding it', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/option?option=Bike`,
      asUser(actor, { method: 'DELETE' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { field: Field; cleared: number };
    expect(body.field.options).toEqual(['Tech', 'Other']);
    expect(body.cleared).toBe(0);
  });

  it('keeps a select value whose option was removed without clear', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/option?option=Tech`,
      asUser(actor, { method: 'DELETE' }),
    );
    const body = (await res.json()) as { cleared: number };
    expect(body.cleared).toBe(0);
    // The note still holds "Tech" even though it is no longer an option.
    expect(await valueOf(actor, notebook, 'tech-1', category)).toBe('Tech');
  });
});

describe('removing an option, clearing values', () => {
  it('clears a select option from every note that held it', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/option?option=Other&clear=1`,
      asUser(actor, { method: 'DELETE' }),
    );
    const body = (await res.json()) as { field: Field; cleared: number };
    expect(body.cleared).toBe(2);
    expect(body.field.options).toEqual([]);
    expect(await valueOf(actor, notebook, 'other-1', category)).toBeUndefined();
    expect(await valueOf(actor, notebook, 'other-2', category)).toBeUndefined();
  });

  it('clears one member of a multi-select and keeps the rest of the list', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${platforms}/option?option=Switch&clear=1`,
      asUser(actor, { method: 'DELETE' }),
    );
    const body = (await res.json()) as { cleared: number };
    expect(body.cleared).toBe(2);
    // multi-1 kept "PC"; multi-2 held only "Switch", so its value is gone entirely.
    expect(await valueOf(actor, notebook, 'multi-1', platforms)).toEqual(['PC']);
    expect(await valueOf(actor, notebook, 'multi-2', platforms)).toBeUndefined();
  });

  it('404s an option the field does not have', async () => {
    const res = await fetch(
      `${BASE}/api/notebooks/${notebookId}/fields/${category}/option?option=Nope&clear=1`,
      asUser(actor, { method: 'DELETE' }),
    );
    expect(res.status).toBe(404);
  });
});
