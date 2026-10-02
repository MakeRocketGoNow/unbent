/**
 * A note's id can be the client's. A note made offline needs its address before the
 * server has heard of it, and a request replayed after a lost answer must find its note
 * rather than make a second one: `POST /notes` and `POST /notes/:id/duplicate` take an
 * optional id, answer 201 when they made the note and 200 with the note that already
 * holds the id when they did not. Live, because the status codes are the route's.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

let cookie: string;
const headers = (): HeadersInit => ({ 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN });

beforeAll(async () => {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: `ids-${Date.now()}@example.test`, password: 'ids-password-123', name: 'I' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('POST /notes with an id', () => {
  it('makes the note under that id, and a replay finds it', async () => {
    const id = crypto.randomUUID();
    const made = await fetch(`${BASE}/api/notes`, { method: 'POST', headers: headers(), body: JSON.stringify({ id, title: 'Coupons', body: 'First' }) });
    expect(made.status).toBe(201);
    expect(((await made.json()) as { id: string }).id).toBe(id);
    const again = await fetch(`${BASE}/api/notes`, { method: 'POST', headers: headers(), body: JSON.stringify({ id, title: 'Replayed', body: 'Second' }) });
    expect(again.status).toBe(200);
    const note = (await again.json()) as { id: string; title: string; existing?: unknown };
    expect(note).toMatchObject({ id, title: 'Coupons' });
    expect(note).not.toHaveProperty('existing');
  });

  it('refuses an id that is not a UUID', async () => {
    const res = await fetch(`${BASE}/api/notes`, { method: 'POST', headers: headers(), body: JSON.stringify({ id: 'not-a-uuid', title: 'x' }) });
    expect(res.status).toBe(400);
  });
});

describe('POST /notes/:id/duplicate with an id', () => {
  it('copies under that id, and a replay finds the copy', async () => {
    const source = (await (await fetch(`${BASE}/api/notes`, { method: 'POST', headers: headers(), body: JSON.stringify({ title: 'Source', body: 'b' }) })).json()) as { id: string };
    const copyId = crypto.randomUUID();
    const made = await fetch(`${BASE}/api/notes/${source.id}/duplicate`, { method: 'POST', headers: headers(), body: JSON.stringify({ id: copyId }) });
    expect(made.status).toBe(201);
    expect((await made.json()) as { id: string }).toMatchObject({ id: copyId, title: 'Source' });
    const again = await fetch(`${BASE}/api/notes/${source.id}/duplicate`, { method: 'POST', headers: headers(), body: JSON.stringify({ id: copyId }) });
    expect(again.status).toBe(200);
    expect((await again.json()) as { id: string }).toMatchObject({ id: copyId, title: 'Source' });
    // Without a body, as every caller today sends it: a fresh copy with a server id.
    const plain = await fetch(`${BASE}/api/notes/${source.id}/duplicate`, { method: 'POST', headers: headers() });
    expect(plain.status).toBe(201);
    expect(((await plain.json()) as { id: string }).id).not.toBe(copyId);
  });
});
