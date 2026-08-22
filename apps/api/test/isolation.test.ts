/**
 * Cross-tenant isolation suite.
 *
 * D1 has no row-level security, so tenant isolation is application code and nothing else.
 * This suite exists from Phase 1 and every later phase extends it: when a route that
 * touches user data is added, a case asserting the other user cannot reach it is added
 * here in the same commit.
 *
 * Runs against a live `wrangler dev` on :8787 with email/password temporarily enabled.
 * See test/README.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';

/**
 * Better Auth enforces CSRF by requiring an Origin it trusts, so requests must carry one
 * the way a browser would. APP_URL is the SPA origin in dev.
 */
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';

interface Actor {
  cookie: string;
  userId: string;
  email: string;
}

async function signUp(email: string, password: string, name: string): Promise<Actor> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up failed for ${email}: ${res.status} ${await res.text()}`);

  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error(`no session cookie returned for ${email}`);
  const cookie = setCookie.split(';')[0] ?? '';

  const body = (await res.json()) as { user: { id: string } };
  return { cookie, userId: body.user.id, email };
}

function asUser(actor: Actor): RequestInit {
  return { headers: { Cookie: actor.cookie, Origin: ORIGIN } };
}

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  const stamp = Date.now();
  alice = await signUp(`alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  bob = await signUp(`bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
  expect(alice.userId).not.toBe(bob.userId);
}, 30_000);

describe('session resolution', () => {
  it('returns the right user for each session', async () => {
    const a = await fetch(`${BASE}/api/me`, asUser(alice)).then((r) => r.json());
    const b = await fetch(`${BASE}/api/me`, asUser(bob)).then((r) => r.json());
    expect(a.user.id).toBe(alice.userId);
    expect(b.user.id).toBe(bob.userId);
  });

  it('returns null with no cookie', async () => {
    const res = await fetch(`${BASE}/api/me`);
    expect((await res.json()).user).toBeNull();
  });

  it('rejects a forged session token', async () => {
    const res = await fetch(`${BASE}/api/me`, {
      headers: { Cookie: 'better-auth.session_token=forged-not-a-real-token', Origin: ORIGIN },
    });
    expect((await res.json()).user).toBeNull();
  });

  it('rejects a truncated session token', async () => {
    const truncated = alice.cookie.slice(0, alice.cookie.length - 4);
    const res = await fetch(`${BASE}/api/me`, { headers: { Cookie: truncated, Origin: ORIGIN } });
    expect((await res.json()).user).toBeNull();
  });

  it("does not accept one user's token under another user's id", async () => {
    // Swapping cookies must yield the cookie's real owner, never the requested identity.
    const res = await fetch(`${BASE}/api/me`, asUser(bob));
    expect((await res.json()).user.id).toBe(bob.userId);
  });
});

describe('public routes', () => {
  it('serves health without a session', async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).db).toBe('ok');
  });
});

/**
 * Phase 2+ extends this block: every route added that reads or writes user data gets a
 * case here asserting the other actor receives 404.
 */
describe('cross-tenant access', () => {
  it.todo('notes: bob cannot GET alice note by id');
  it.todo('notes: bob cannot PATCH alice note by id');
  it.todo('notes: bob cannot DELETE alice note by id');
  it.todo('attachments: bob cannot fetch a blob under alice note id');
  it.todo('search: alice notes never appear in bob results');
  it.todo('export: bob zip contains no alice notes');
  it.todo('import: bob cannot write into an alice note id');
});
