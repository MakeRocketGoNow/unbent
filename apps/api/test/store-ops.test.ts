/**
 * The operator's window into a note store, from the outside: what a signed-in user may
 * read of their own store, and what only an operator may do. Runs against a live
 * `wrangler dev`; see test/README.md.
 *
 * The operator's own paths — `?user=` on another account, the SQL route, the sweep — are
 * exercised only on the refusal side here: the suite signs up throwaway actors, and none
 * of them is in the instance's OPERATOR_EMAILS. The sweep itself is tested against real
 * objects in apps/store-tests.
 */
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
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id };
}

const as = (actor: Actor, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), Cookie: actor.cookie, Origin: ORIGIN },
});

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`ops-alice-${stamp}@example.test`, 'ops-alice-password-1', 'Alice');
  bob = await signUp(`ops-bob-${stamp}@example.test`, 'ops-bob-password-12', 'Bob');
  await fetch(`${BASE}/api/notes`, as(alice, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Counted', body: 'one note', tags: ['t'] }),
  }));
}, 30_000);

describe('store stats', () => {
  it('reports the caller\'s own store', async () => {
    const stats = (await fetch(`${BASE}/api/admin/store/stats`, as(alice)).then((r) => r.json())) as {
      userId: string;
      counts: { notes: number; tags: number };
      migrations: string[];
      migratedFromD1: boolean;
      wiped: boolean;
    };
    expect(stats.userId).toBe(alice.userId);
    expect(stats.counts.notes).toBe(1);
    expect(stats.counts.tags).toBe(1);
    expect(stats.migrations).toEqual(['0001-init']);
    expect(stats.migratedFromD1).toBe(true);
    expect(stats.wiped).toBe(false);
  });

  it('refuses to name another account for anyone but an operator', async () => {
    const res = await fetch(`${BASE}/api/admin/store/stats?user=${alice.userId}`, as(bob));
    expect(res.status).toBe(404);
  });

  it('requires a session', async () => {
    expect((await fetch(`${BASE}/api/admin/store/stats`, { headers: { Origin: ORIGIN } })).status).toBe(401);
  });
});

describe('store dump', () => {
  it('streams the schema first and then every row, table by table', async () => {
    const res = await fetch(`${BASE}/api/admin/store/dump`, as(alice));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('x-ndjson');
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const [schema, ...rows] = lines;
    expect((schema!.schema as string[]).some((s) => s.startsWith('CREATE TABLE notes'))).toBe(true);
    expect((schema!.schema as string[]).some((s) => s.includes('notes_fts'))).toBe(true);
    const notes = rows.filter((r) => r.table === 'notes');
    expect(notes).toHaveLength(1);
    expect((notes[0]!.row as { title: string }).title).toBe('Counted');
    expect((notes[0]!.row as Record<string, unknown>)._rowid).toBeUndefined();
    expect(rows.filter((r) => r.table === 'tags')).toHaveLength(1);
    expect(rows.filter((r) => r.table === 'note_tags')).toHaveLength(1);
  });

  it('is the caller\'s own unless they are an operator', async () => {
    expect((await fetch(`${BASE}/api/admin/store/dump?user=${alice.userId}`, as(bob))).status).toBe(404);
  });
});

describe('operator-only routes', () => {
  it('answer a non-operator as if they did not exist', async () => {
    const sql = await fetch(`${BASE}/api/admin/store/sql`, as(alice, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT COUNT(*) AS n FROM notes' }),
    }));
    expect(sql.status).toBe(404);
    const sweep = await fetch(`${BASE}/api/admin/store/sweep`, as(alice, { method: 'POST' }));
    expect(sweep.status).toBe(404);
  });
});
