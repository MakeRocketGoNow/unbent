/**
 * Sorting the note list by a custom field.
 *
 * The cases here are the ones a keyset cursor gets wrong silently: a run of equal values
 * across a page boundary, notes without a value at all (which sort last in *both*
 * directions and page by id alone), and text that only orders correctly under NOCASE.
 * Each is checked by walking every page and counting what came back, because a page that
 * skips or repeats a row looks fine on its own.
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

interface Page {
  items: Array<{ id: string; title: string; fields?: Array<{ fieldId: string; value: unknown }> }>;
  cursor: string | null;
  total: number | null;
}

/** Every title in order, walked page by page at the given size. */
async function walk(actor: Actor, query: string, limit: number): Promise<string[]> {
  const titles: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const url = `${BASE}/api/notes?${query}&limit=${limit}${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
    }`;
    const res = await fetch(url, asUser(actor));
    if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as Page;
    for (const item of page.items) {
      if (seen.has(item.id)) throw new Error(`row repeated across pages: ${item.title}`);
      seen.add(item.id);
      titles.push(item.title);
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  return titles;
}

let actor: Actor;
let notebook: string;
let amount: string;
let status: string;

/** Title → the values it was created with, so expectations read as data. */
const NOTES: Array<{ title: string; amount?: number; status?: string }> = [
  { title: 'ten', amount: 10, status: 'Bargain' },
  { title: 'nine', amount: 9, status: 'full price' },
  { title: 'two-a', amount: 2, status: 'Bargain' },
  { title: 'two-b', amount: 2, status: 'Bargain' },
  { title: 'two-c', amount: 2, status: 'Free' },
  { title: 'blank-a' },
  { title: 'blank-b' },
  { title: 'blank-c', status: 'Bargain' },
  { title: 'minus', amount: -1 },
];

beforeAll(async () => {
  const stamp = Date.now();
  actor = await signUp(`fieldsort-${stamp}@example.test`, 'fieldsort-pass-1', 'F');
  notebook = `Sorted ${stamp}`;

  // The notebook exists once a note is filed in it; the fields are defined on it after.
  const first = NOTES[0]!;
  await post(actor, '/api/notes', { title: first.title, body: 'x', notebook });
  const { notebooks } = (await fetch(`${BASE}/api/notebooks`, asUser(actor)).then((r) =>
    r.json(),
  )) as { notebooks: Array<{ id: string; name: string }> };
  const nb = notebooks.find((n) => n.name === notebook);
  if (!nb) throw new Error('notebook was not created');

  amount = (await post<{ id: string }>(actor, `/api/notebooks/${nb.id}/fields`, {
    name: 'Amount',
    type: 'number',
  })).id;
  status = (await post<{ id: string }>(actor, `/api/notebooks/${nb.id}/fields`, {
    name: 'Status',
    type: 'select',
    options: ['Bargain', 'full price', 'Free'],
  })).id;

  // The first note was created before the fields existed, so its values are set now.
  const existing = (await fetch(`${BASE}/api/notes?notebook=${encodeURIComponent(notebook)}`, asUser(actor)).then((r) => r.json())) as Page;
  const firstId = existing.items[0]!.id;
  await fetch(`${BASE}/api/notes/${firstId}`, asUser(actor, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { [amount]: first.amount, [status]: first.status } }),
  }));

  for (const n of NOTES.slice(1)) {
    const fields: Record<string, unknown> = {};
    if (n.amount !== undefined) fields[amount] = n.amount;
    if (n.status !== undefined) fields[status] = n.status;
    await post(actor, '/api/notes', { title: n.title, body: 'x', notebook, fields });
  }
});

describe('sort by a custom field', () => {
  const scope = () => `notebook=${encodeURIComponent(notebook)}`;

  it('orders numbers numerically, ascending, with the valueless notes last', async () => {
    const titles = await walk(actor, `${scope()}&sortField=${amount}&order=asc`, 4);
    expect(titles[0]).toBe('minus');
    // The three twos are a run that crosses the page boundary at limit 4.
    expect(titles.slice(1, 4).sort()).toEqual(['two-a', 'two-b', 'two-c']);
    expect(titles.slice(4, 6)).toEqual(['nine', 'ten']);
    expect(titles.slice(6).sort()).toEqual(['blank-a', 'blank-b', 'blank-c']);
    expect(titles).toHaveLength(NOTES.length);
  });

  it('descending reverses the values but still puts the valueless notes last', async () => {
    const titles = await walk(actor, `${scope()}&sortField=${amount}&order=desc`, 4);
    expect(titles.slice(0, 2)).toEqual(['ten', 'nine']);
    expect(titles.slice(2, 5).sort()).toEqual(['two-a', 'two-b', 'two-c']);
    expect(titles[5]).toBe('minus');
    expect(titles.slice(6).sort()).toEqual(['blank-a', 'blank-b', 'blank-c']);
    expect(titles).toHaveLength(NOTES.length);
  });

  it('pages a run of valueless notes by id without repeating or skipping', async () => {
    // Limit 2 puts a page boundary inside the blank run in both directions.
    for (const order of ['asc', 'desc']) {
      const titles = await walk(actor, `${scope()}&sortField=${amount}&order=${order}`, 2);
      expect(titles).toHaveLength(NOTES.length);
      expect(titles.slice(-3).sort()).toEqual(['blank-a', 'blank-b', 'blank-c']);
    }
  });

  it('orders text case-insensitively', async () => {
    const titles = await walk(actor, `${scope()}&sortField=${status}&order=asc`, 3);
    // Bargain ×4, then Free, then "full price": a binary sort would put the lowercase
    // option after both capitalised ones.
    expect(titles.slice(0, 4).sort()).toEqual(['blank-c', 'ten', 'two-a', 'two-b']);
    expect(titles.slice(4, 6)).toEqual(['two-c', 'nine']);
    expect(titles.slice(6).sort()).toEqual(['blank-a', 'blank-b', 'minus']);
  });

  it('counts and pages the same rows the list shows', async () => {
    const res = await fetch(`${BASE}/api/notes?${scope()}&sortField=${amount}&limit=4`, asUser(actor));
    const page = (await res.json()) as Page;
    expect(page.total).toBe(NOTES.length);
    expect(page.items).toHaveLength(4);
    expect(page.cursor).toBeTruthy();
  });

  it('rejects a field id that is not one of yours', async () => {
    const other = await signUp(`fieldsort-other-${Date.now()}@example.test`, 'other-pass-123', 'O');
    const res = await fetch(`${BASE}/api/notes?sortField=${amount}`, asUser(other));
    expect(res.status).toBe(400);
    const unknown = await fetch(`${BASE}/api/notes?sortField=${crypto.randomUUID()}`, asUser(actor));
    expect(unknown.status).toBe(400);
    const malformed = await fetch(`${BASE}/api/notes?sortField=not-a-uuid`, asUser(actor));
    expect(malformed.status).toBe(400);
  });
});
