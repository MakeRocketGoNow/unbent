/**
 * The MCP endpoint, end to end and across tenants.
 *
 * This is the cross-tenant case `isolation.test.ts` requires of any route that touches user
 * data. It lives in its own file because reaching the route means performing a whole OAuth
 * flow first — register a client, authorize as a signed-in user, consent, exchange the code
 * — rather than presenting a cookie, and that machinery would swamp the suite it belongs to.
 *
 * The isolation question here has a second half that no cookie-based route has: a token is
 * bound to a resource as well as a user, so a token that is otherwise perfectly valid must
 * still be refused if it was minted for somewhere else.
 *
 * Runs against a live `wrangler dev` with email/password enabled. See test/README.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env['API_URL'] ?? 'http://localhost:8787';
const ORIGIN = process.env['APP_URL'] ?? 'http://localhost:5173';
const RESOURCE = `${ORIGIN}/api/mcp`;

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

interface Actor {
  cookie: string;
  userId: string;
  token: string;
}

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) throw new Error(`sign-up failed for ${email}: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

async function registerClient(name: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({
      client_name: name,
      application_type: 'native',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error(`registration failed: ${JSON.stringify(body)}`);
  return body.client_id;
}

/**
 * Everything between "a client wants in" and "a client holds a token", as a browser would
 * do it: authorize, land on consent, approve, exchange the code.
 */
async function tokenFor(cookie: string, clientId: string, resource: string): Promise<string> {
  const { verifier, challenge } = await pkce();
  const authorize = new URL(`${BASE}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: 'http://127.0.0.1:9999/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'openid profile offline_access',
    state: 'test-state',
    resource,
  })) {
    authorize.searchParams.set(key, value);
  }

  const authorizeRes = await fetch(authorize, {
    headers: { Cookie: cookie, Origin: ORIGIN, Accept: 'application/json' },
    redirect: 'manual',
  });
  const authorizeBody = (await authorizeRes.json().catch(() => ({}))) as { url?: string };
  const next = authorizeRes.headers.get('location') ?? authorizeBody.url ?? '';
  if (!next) throw new Error('authorize returned nowhere to go');

  let code: string | null = null;
  if (next.includes('/consent')) {
    const query = new URL(next, ORIGIN).searchParams;
    const consentRes = await fetch(`${BASE}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: ORIGIN,
        Accept: 'application/json',
      },
      body: JSON.stringify({ accept: true, oauth_query: `?${query.toString()}` }),
    });
    const consentBody = (await consentRes.json()) as { url?: string };
    if (consentBody.url) code = new URL(consentBody.url, ORIGIN).searchParams.get('code');
  } else {
    code = new URL(next, ORIGIN).searchParams.get('code');
  }
  if (!code) throw new Error('no authorization code');

  const tokenRes = await fetch(`${BASE}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
  return tokens.access_token;
}

/** One JSON-RPC call. The transport may answer as SSE, so both framings are unwrapped. */
async function mcp(token: string, method: string, params: unknown = {}) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await res.text();
  const streamed = text.split('\n').find((line) => line.startsWith('data: '));
  const body = streamed
    ? JSON.parse(streamed.slice(6))
    : ((): unknown => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })();
  return { status: res.status, body: body as Record<string, any> };
}

/** The text a tool call answered with, whether it succeeded or reported an error. */
function toolText(body: Record<string, any>): string {
  return body?.result?.content?.[0]?.text ?? '';
}

let alice: Actor;
let bob: Actor;
let aliceNoteId: string;

beforeAll(async () => {
  const stamp = Date.now();
  const aliceCookie = await signUp(`mcp-alice-${stamp}@example.test`, 'alice-password-123', 'Alice');
  const bobCookie = await signUp(`mcp-bob-${stamp}@example.test`, 'bob-password-1234', 'Bob');
  const clientId = await registerClient('Test Assistant');

  alice = {
    cookie: aliceCookie,
    userId: '',
    token: await tokenFor(aliceCookie, clientId, RESOURCE),
  };
  bob = { cookie: bobCookie, userId: '', token: await tokenFor(bobCookie, clientId, RESOURCE) };

  const created = await mcp(alice.token, 'tools/call', {
    name: 'create_note',
    arguments: { title: 'Alice private', body: 'alice-only-secret', tags: ['alice-mcp'] },
  });
  aliceNoteId = JSON.parse(toolText(created.body)).id;
  expect(aliceNoteId).toBeTruthy();
}, 60_000);

describe('mcp endpoint', () => {
  it('refuses an unauthenticated call and says where to authorize', async () => {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(401);
    // Without this header a client that has never seen this server cannot discover how to
    // authorize; it is the whole mechanism by which a connection can be set up at all.
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('refuses a token that is not a token', async () => {
    const { status } = await mcp('not-a-real-token', 'tools/list');
    expect(status).toBe(401);
  });

  it('serves the tools to a client holding a valid token', async () => {
    const { status, body } = await mcp(alice.token, 'tools/list');
    expect(status).toBe(200);
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain('search_notes');
    expect(names).toContain('create_note');
    expect(names).toContain('edit_note');
  });

  it('round-trips a note through create, search and read', async () => {
    const found = await mcp(alice.token, 'tools/call', {
      name: 'search_notes',
      arguments: { query: 'alice-only-secret' },
    });
    expect(toolText(found.body)).toContain(aliceNoteId);

    const read = await mcp(alice.token, 'tools/call', {
      name: 'get_note',
      arguments: { noteId: aliceNoteId },
    });
    expect(toolText(read.body)).toContain('alice-only-secret');
  });
});

describe('mcp cross-tenant isolation', () => {
  it('bob cannot read an alice note by id', async () => {
    const { body } = await mcp(bob.token, 'tools/call', {
      name: 'get_note',
      arguments: { noteId: aliceNoteId },
    });
    expect(toolText(body)).toContain('No such note');
    expect(toolText(body)).not.toContain('alice-only-secret');
  });

  it('bob cannot edit an alice note', async () => {
    const { body } = await mcp(bob.token, 'tools/call', {
      name: 'edit_note',
      arguments: { noteId: aliceNoteId, mode: 'append', content: 'bob was here' },
    });
    expect(body.result?.isError).toBe(true);

    // And the note is untouched, which is the part that matters.
    const read = await mcp(alice.token, 'tools/call', {
      name: 'get_note',
      arguments: { noteId: aliceNoteId },
    });
    expect(toolText(read.body)).not.toContain('bob was here');
  });

  it('bob cannot trash an alice note', async () => {
    const { body } = await mcp(bob.token, 'tools/call', {
      name: 'delete_note',
      arguments: { noteId: aliceNoteId },
    });
    expect(body.result?.isError).toBe(true);
  });

  it('alice notes never appear in a bob search', async () => {
    const { body } = await mcp(bob.token, 'tools/call', {
      name: 'search_notes',
      arguments: { query: 'alice-only-secret' },
    });
    expect(toolText(body)).not.toContain(aliceNoteId);
  });

  it('alice tags never appear in a bob tag list', async () => {
    const { body } = await mcp(bob.token, 'tools/call', { name: 'list_tags', arguments: {} });
    expect(toolText(body)).not.toContain('alice-mcp');
  });

  it('will not even issue a token for a resource it does not host', async () => {
    // The audience check on the endpoint is the second line of defence. The first is here:
    // asking for a token bound to somewhere else is refused at authorization with
    // `invalid_target`, so a foreign-audience token for this issuer cannot be obtained in
    // the first place. Asserted because it is the reason the endpoint never sees one.
    const clientId = await registerClient('Other Resource Client');
    const { challenge } = await pkce();
    const authorize = new URL(`${BASE}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid profile',
      state: 'test-state',
      resource: 'https://example.com/somewhere-else',
    })) {
      authorize.searchParams.set(key, value);
    }

    const res = await fetch(authorize, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN, Accept: 'application/json' },
      redirect: 'manual',
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string };
    const outcome = res.headers.get('location') ?? body.url ?? '';

    expect(outcome).toContain('error=invalid_target');
    expect(outcome).not.toContain('code=');
  }, 30_000);

  it('stops honouring a token once the app is disconnected', async () => {
    // The bug this guards against was silent: deleting the consent through the provider's
    // own endpoint left the token working and its refresh token able to mint more, so
    // "Disconnect" disconnected nothing. Access tokens are verified by signature, which
    // cannot know about a revocation, so the endpoint checks the grant still stands.
    const clientId = await registerClient('Disposable Assistant');
    const cookie = await signUp(
      `mcp-revoke-${Date.now()}@example.test`,
      'revoke-password-123',
      'Revoker',
    );
    const token = await tokenFor(cookie, clientId, RESOURCE);

    expect((await mcp(token, 'tools/list')).status).toBe(200);

    const consents = (await fetch(`${BASE}/api/auth/oauth2/get-consents`, {
      headers: { Cookie: cookie, Origin: ORIGIN, Accept: 'application/json' },
    }).then((r) => r.json())) as Array<{ id: string; clientId: string }>;
    const grant = consents.find((c) => c.clientId === clientId);
    expect(grant).toBeTruthy();

    const disconnect = await fetch(`${BASE}/api/connected-apps/${grant!.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(disconnect.status).toBe(204);

    expect((await mcp(token, 'tools/list')).status).toBe(401);
  }, 30_000);

  it('will not disconnect a grant belonging to someone else', async () => {
    const consents = (await fetch(`${BASE}/api/auth/oauth2/get-consents`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN, Accept: 'application/json' },
    }).then((r) => r.json())) as Array<{ id: string }>;
    expect(consents.length).toBeGreaterThan(0);

    const res = await fetch(`${BASE}/api/connected-apps/${consents[0]!.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: bob.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(404);

    // And alice's own access is untouched.
    expect((await mcp(alice.token, 'tools/list')).status).toBe(200);
  });
});
