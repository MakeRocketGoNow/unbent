/**
 * The change feed over HTTP: what a device asks to bring its copy of the library up to
 * date, against the live Worker, so the whole path — session, route, object, feed row,
 * socket — is the one production runs. The reader's rules are pinned in
 * `apps/store-tests`; this checks they arrive at the API's shape, and that the push
 * reaches a second connection within a second. See test/README.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { FeedPage, FeedReset, SnapshotPage } from '@unbent/shared';

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

async function feed(since: number, limit = 200): Promise<FeedPage | FeedReset> {
  const res = await fetch(`${BASE}/api/changes?since=${since}&limit=${limit}`, { headers: headers() });
  expect(res.status).toBe(200);
  return res.json() as Promise<FeedPage | FeedReset>;
}

function page(p: FeedPage | FeedReset): FeedPage {
  if (p.reset) throw new Error('unexpected reset');
  return p;
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email: `feed-${Date.now()}@example.test`, password: 'feed-password-123', name: 'F' }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('GET /api/changes', () => {
  it('needs a session', async () => {
    expect((await fetch(`${BASE}/api/changes`, { headers: { Origin: ORIGIN } })).status).toBe(401);
    expect((await fetch(`${BASE}/api/changes/snapshot`, { headers: { Origin: ORIGIN } })).status).toBe(401);
    expect((await fetch(`${BASE}/api/changes/socket`, { headers: { Origin: ORIGIN } })).status).toBe(401);
  });

  it('refuses a bad cursor or limit', async () => {
    expect((await fetch(`${BASE}/api/changes?since=-1`, { headers: headers() })).status).toBe(400);
    expect((await fetch(`${BASE}/api/changes?limit=0`, { headers: headers() })).status).toBe(400);
    expect((await fetch(`${BASE}/api/changes?limit=501`, { headers: headers() })).status).toBe(400);
    expect((await fetch(`${BASE}/api/changes/snapshot?cursor=`, { headers: headers() })).status).toBe(400);
  });

  it('carries a create, an edit, a trash and a purge in order, whole, and a tombstone for what is gone', async () => {
    const start = page(await feed(0));
    const since = start.seq;

    const a = await create({ title: 'Coupons', body: 'First', tags: ['home'], notebook: 'Receipts' });
    await fetch(`${BASE}/api/notes/${a.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ body: 'Second' }) });
    const b = await create({ title: 'Gone', body: '' });
    await fetch(`${BASE}/api/notes/${b.id}`, { method: 'DELETE', headers: headers() });
    await fetch(`${BASE}/api/notes/${b.id}/permanent`, { method: 'DELETE', headers: headers() });

    const p = page(await feed(since));
    expect(p.more).toBe(false);
    expect(p.next).toBe(p.seq);
    expect(p.notes).toEqual([expect.objectContaining({ id: a.id, body: 'Second', tags: ['home'], notebook: 'Receipts', files: [] })]);
    expect(p.notebooks).toEqual([expect.objectContaining({ name: 'Receipts', fieldDefs: [] })]);
    expect(p.tags).toEqual([{ id: expect.any(String), name: 'home' }]);
    expect(p.tombstones).toEqual([{ entity: 'note', id: b.id }]);

    // From there on: nothing until the next write; a trash is an update with `deletedAt`.
    expect(page(await feed(p.next))).toMatchObject({ notes: [], tombstones: [], more: false });
    await fetch(`${BASE}/api/notes/${a.id}`, { method: 'DELETE', headers: headers() });
    expect(page(await feed(p.next)).notes).toEqual([expect.objectContaining({ id: a.id, deletedAt: expect.any(Number) })]);
  });

  it('answers reset for a cursor past the counter or from another epoch', async () => {
    const current = page(await feed(0));
    expect(await feed(current.seq + 1_000_000)).toEqual({ reset: true, seq: expect.any(Number), epoch: expect.any(String) });
    const stale = await fetch(`${BASE}/api/changes?since=${current.seq}&epoch=not-this-history`, { headers: headers() });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ reset: true, seq: expect.any(Number), epoch: current.epoch });
    const same = await fetch(`${BASE}/api/changes?since=${current.seq}&epoch=${current.epoch}`, { headers: headers() });
    expect(((await same.json()) as FeedPage).reset).toBe(false);
  });

  it('pages a snapshot of the whole library by note id, the library itself on the first page', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await create({ title: `S${i}`, body: 'b' })).id);
    const first = (await (await fetch(`${BASE}/api/changes/snapshot?limit=2`, { headers: headers() })).json()) as SnapshotPage;
    expect(first.notebooks).toBeDefined();
    expect(first.tags).toBeDefined();
    expect(first.total).toBeGreaterThanOrEqual(3);
    expect(first.seq).toBe(page(await feed(0)).seq);
    expect(first.notes).toHaveLength(2);
    expect(first.next).toBe(first.notes[1]!.id);
    const seen = [...first.notes.map((n) => n.id)];
    let next = first.next;
    while (next) {
      const more = (await (await fetch(`${BASE}/api/changes/snapshot?limit=2&cursor=${encodeURIComponent(next)}`, { headers: headers() })).json()) as SnapshotPage;
      expect(more.notebooks).toBeUndefined();
      seen.push(...more.notes.map((n) => n.id));
      next = more.next;
    }
    for (const id of ids) expect(seen).toContain(id);
    expect(seen).toEqual([...seen].sort());
  });
});

describe('GET /api/changes/socket', () => {
  it('tells a connected device the feed moved within a second of a write', async () => {
    const url = `${BASE.replace(/^http/, 'ws')}/api/changes/socket`;
    // Node's WebSocket (undici) takes request headers through this non-standard option.
    const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: ORIGIN } } as unknown as string[]);
    const got: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (ev) => reject(new Error(`socket failed: ${String((ev as ErrorEvent).message ?? ev)}`)));
    });
    ws.addEventListener('message', (ev) => got.push(String(ev.data)));
    const before = page(await feed(0)).seq;
    const n = await create({ title: 'Nudge', body: '' });
    const deadline = Date.now() + 1000;
    while (got.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(got.length).toBeGreaterThan(0);
    const { seq } = JSON.parse(got[got.length - 1]!) as { seq: number };
    expect(seq).toBeGreaterThan(before);
    // The number is the feed's; the page from the old cursor carries the note.
    expect(page(await feed(before)).notes.map((x) => x.id)).toContain(n.id);
    ws.send('ping');
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toContain('pong');
    ws.close();
  });

  it('refuses a plain GET with 426', async () => {
    expect((await fetch(`${BASE}/api/changes/socket`, { headers: headers() })).status).toBe(426);
  });

  it('refuses an upgrade from another origin, and takes one with none', async () => {
    const url = `${BASE.replace(/^http/, 'ws')}/api/changes/socket`;
    // Node's fetch refuses to send an `Upgrade` header, so each case is a real handshake.
    const handshake = (origin?: string) =>
      new Promise<'open' | 'refused'>((resolve) => {
        const ws = new WebSocket(url, { headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } } as unknown as string[]);
        ws.addEventListener('open', () => { ws.close(); resolve('open'); });
        ws.addEventListener('error', () => resolve('refused'));
      });
    expect(await handshake('https://elsewhere.example')).toBe('refused');
    expect(await handshake()).toBe('open');
    expect(await handshake(ORIGIN)).toBe('open');
    // Locally the app is reached on more than APP_URL names — the emulator's alias for
    // the host, another worktree's port — and sign-in trusts those, so the socket does too.
    expect(await handshake(`http://127.0.0.1:${new URL(ORIGIN).port}`)).toBe('open');
    expect(await handshake('http://10.0.2.2:5173')).toBe('open');
  });
});
