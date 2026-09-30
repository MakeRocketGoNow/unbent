/**
 * The operator's window into a note store, from the outside: what a signed-in user may
 * read of their own store, and what only an operator may do. Runs against a live
 * `wrangler dev`; see test/README.md.
 *
 * The operator's own paths — `?user=` on another account, the SQL route, the copy, the
 * sweep — are exercised only on the refusal side here: the suite signs up throwaway actors, and none
 * of them is in the instance's OPERATOR_EMAILS. The sweep itself is tested against real
 * objects in apps/store-tests.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      wiped: boolean;
    };
    expect(stats.userId).toBe(alice.userId);
    expect(stats.counts.notes).toBe(1);
    expect(stats.counts.tags).toBe(1);
    expect(stats.migrations).toEqual(['0001-init']);
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
  it('is SQL that rebuilds the account, tables then rows then triggers and a search rebuild', async () => {
    const res = await fetch(`${BASE}/api/admin/store/dump`, as(alice));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/sql');
    const sql = await res.text();
    const at = (needle: string) => {
      const i = sql.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    // The order is the point; see the route.
    expect(at('CREATE TABLE notes')).toBeLessThan(at('INSERT INTO notes '));
    expect(at('INSERT INTO notes ')).toBeLessThan(at('CREATE TRIGGER notes_counts_ai'));
    expect(at('CREATE TRIGGER notes_counts_ai')).toBeLessThan(at("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')"));
    expect(sql).toContain("'Counted'");
    expect(sql).toContain("INSERT INTO _meta (key, value) VALUES ('user_id', '" + alice.userId + "')");
    // The paging column never lands in a row; `content_rowid` in the FTS definitions is not it.
    expect(sql).not.toMatch(/INSERT INTO \w+ \(_rowid/);

    // And it loads: sqlite3 rebuilds the account, counts preserved, search working.
    // Skipped where the CLI is not installed; CI's runners and every developer Mac have it.
    let sqlite3: string | null = 'sqlite3';
    try {
      execFileSync(sqlite3, ['--version'], { stdio: 'ignore' });
    } catch {
      sqlite3 = null;
    }
    if (!sqlite3) return;
    const dir = mkdtempSync(join(tmpdir(), 'unbent-dump-'));
    const file = join(dir, 'dump.sql');
    writeFileSync(file, sql);
    const db = join(dir, 'account.db');
    execFileSync(sqlite3, [db], { input: sql });
    const query = (q: string) => execFileSync(sqlite3!, [db, q], { encoding: 'utf8' }).trim();
    expect(query('SELECT COUNT(*) FROM notes')).toBe('1');
    expect(query('SELECT live FROM note_counts')).toBe('1');
    expect(query('SELECT note_count FROM tags')).toBe('1');
    expect(query("SELECT title FROM notes WHERE rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'counted')")).toBe('Counted');
    expect(query('SELECT name FROM _migrations')).toBe('0001-init');
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
    const copy = await fetch(`${BASE}/api/admin/store/copy`, as(alice, { method: 'POST' }));
    expect(copy.status).toBe(404);
    const sweep = await fetch(`${BASE}/api/admin/store/sweep`, as(alice, { method: 'POST' }));
    expect(sweep.status).toBe(404);
  });
});
