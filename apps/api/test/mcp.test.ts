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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  await agreeToTerms(cookie);
  return cookie;
}

/**
 * Agrees to the instance's terms, as a person does on first opening the app: connecting
 * an app is refused until they have (`refuseGrantsWithoutAgreement`), and these actors
 * connect one. Nothing to do where the instance publishes no documents.
 */
async function agreeToTerms(cookie: string): Promise<void> {
  const config = (await (await fetch(`${BASE}/api/config`)).json()) as { legal?: { version?: string } };
  const version = config.legal?.version;
  if (!version) return;
  const res = await fetch(`${BASE}/api/legal/agree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) throw new Error(`agreeing to the terms failed: ${res.status} ${await res.text()}`);
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
  it('answers get_note and create_note with a link to the note on the instance\'s own origin', async () => {
    // APP_URL is the SPA's origin, not the Worker's port the call was made on: the link
    // has to open the app, which in development is served by Vite.
    const read = await mcp(alice.token, 'tools/call', { name: 'get_note', arguments: { noteId: aliceNoteId } });
    expect(JSON.parse(toolText(read.body)).url).toBe(`${ORIGIN}/notes/${aliceNoteId}`);
    const created = await mcp(alice.token, 'tools/call', {
      name: 'create_note',
      arguments: { title: 'Coyote vs. Acme', body: '' },
    });
    const note = JSON.parse(toolText(created.body));
    expect(note.url).toBe(`${ORIGIN}/notes/${note.id}`);
  });

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
    expect(names).toContain('update_notebook');
  });

  it('sets a notebook purpose through update_notebook and reads it back from list_notebooks', async () => {
    const name = `Purpose over MCP ${Date.now()}`;
    const created = await mcp(alice.token, 'tools/call', {
      name: 'create_notebook',
      arguments: { name },
    });
    const notebookId = JSON.parse(toolText(created.body)).id as string;

    const purpose = 'Things I want to buy someday; not receipts or purchases.';
    await mcp(alice.token, 'tools/call', {
      name: 'update_notebook',
      arguments: { notebookId, purpose },
    });

    // The purpose the agent set is what list_notebooks reports, so an agent can read what it
    // wrote and file against it rather than only setting it blind.
    const listed = await mcp(alice.token, 'tools/call', { name: 'list_notebooks', arguments: {} });
    const nb = JSON.parse(toolText(listed.body)).notebooks.find(
      (n: { id: string }) => n.id === notebookId,
    );
    expect(nb.purpose).toBe(purpose);

    // Passing null clears it, and a notebook without a purpose omits the key rather than
    // carrying a null.
    await mcp(alice.token, 'tools/call', {
      name: 'update_notebook',
      arguments: { notebookId, purpose: null },
    });
    const cleared = await mcp(alice.token, 'tools/call', { name: 'list_notebooks', arguments: {} });
    const after = JSON.parse(toolText(cleared.body)).notebooks.find(
      (n: { id: string }) => n.id === notebookId,
    );
    expect(after.purpose).toBeUndefined();
  });

  it('sets a notebook emoji through update_notebook and reads it back from list_notebooks', async () => {
    const name = `Emoji over MCP ${Date.now()}`;
    const created = await mcp(alice.token, 'tools/call', {
      name: 'create_notebook',
      arguments: { name },
    });
    const notebookId = JSON.parse(toolText(created.body)).id as string;

    const find = async () => {
      const listed = await mcp(alice.token, 'tools/call', { name: 'list_notebooks', arguments: {} });
      return JSON.parse(toolText(listed.body)).notebooks.find(
        (n: { id: string }) => n.id === notebookId,
      );
    };
    // Unset, the key is absent rather than null, like a purpose.
    expect((await find()).emoji).toBeUndefined();

    await mcp(alice.token, 'tools/call', {
      name: 'update_notebook',
      arguments: { notebookId, emoji: '🧾' },
    });
    expect((await find()).emoji).toBe('🧾');

    await mcp(alice.token, 'tools/call', {
      name: 'update_notebook',
      arguments: { notebookId, emoji: null },
    });
    expect((await find()).emoji).toBeUndefined();
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

/*
 * MAK-119's "done when": an assistant can replace any note's text without asking, so what
 * it replaced has to be there afterwards, however recently the note was last saved.
 */
describe('mcp edits and the note history', () => {
  const asAlice = () => ({ Cookie: alice.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' });

  it('an edit_note replace that guts a note is undone from its history', async () => {
    const created = await mcp(alice.token, 'tools/call', {
      name: 'create_note',
      arguments: { title: 'Minutes', body: 'Agreed: ship on Friday.\n\nOpen: who tells the client.' },
    });
    const noteId = JSON.parse(toolText(created.body)).id as string;
    // Typed in the editor a moment before: inside the window, so by the typing rule
    // alone the edit below would keep nothing.
    const typed = 'Agreed: ship on Friday.\n\nOpen: who tells the client. Dana will.';
    await fetch(`${BASE}/api/notes/${noteId}`, { method: 'PATCH', headers: asAlice(), body: JSON.stringify({ body: typed }) });

    const edit = await mcp(alice.token, 'tools/call', {
      name: 'edit_note',
      arguments: { noteId, mode: 'replace', find: typed, content: 'TODO' },
    });
    expect(edit.body.result?.isError).toBeFalsy();

    const listed = await fetch(`${BASE}/api/notes/${noteId}/revisions`, { headers: asAlice() }).then((r) => r.json());
    const revisions = listed.revisions as Array<{ id: number; cause?: string; size: number }>;
    expect(revisions[0]).toMatchObject({ cause: 'assistant', size: typed.length });

    const restored = await fetch(`${BASE}/api/notes/${noteId}/revisions/${revisions[0]!.id}/restore`, {
      method: 'POST',
      headers: asAlice(),
    });
    expect(restored.status).toBe(200);
    const answer = await restored.json();
    expect(answer.note.body).toBe(typed);
    expect(answer.kept).toEqual(expect.any(Number));

    // And the assistant's version is in the history in its turn.
    const again = await fetch(`${BASE}/api/notes/${noteId}/revisions`, { headers: asAlice() }).then((r) => r.json());
    expect(again.revisions[0]).toMatchObject({ id: answer.kept, cause: 'restore', size: 'TODO'.length });

    // The same version again changes nothing, and says so.
    const same = await fetch(`${BASE}/api/notes/${noteId}/revisions/${revisions[0]!.id}/restore`, { method: 'POST', headers: asAlice() });
    expect(await same.json()).toMatchObject({ kept: null, note: { body: typed } });

    // An undo of that restore names the date it left, and is refused once the note has moved on.
    const stale = await fetch(`${BASE}/api/notes/${noteId}/revisions/${again.revisions[0].id}/restore`, {
      method: 'POST',
      headers: asAlice(),
      body: JSON.stringify({ ifUpdatedAt: 1 }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).stale.body).toBe(typed);
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

/**
 * An agent's write that changes nothing leaves the note's date alone.
 *
 * Worth checking through MCP specifically, and not just over the REST route, because these
 * tools are the writers most likely to re-send what is already there: `update_note_tags`
 * promises in its own description that tags already present are "left alone",
 * `move_notes` files up to five hundred notes at a time into a notebook many already belong to,
 * and an agent re-running a step it already ran is ordinary. Before the repo compared
 * values, every one of those re-dated the note.
 */
describe('a write through MCP that changes nothing', () => {
  /** A fresh note, plus a tick so a same-millisecond write could not be mistaken for none. */
  async function note(args: Record<string, unknown>) {
    const created = await mcp(alice.token, 'tools/call', {
      name: 'create_note',
      arguments: args,
    });
    const ref = JSON.parse(toolText(created.body));
    await new Promise((resolve) => setTimeout(resolve, 5));
    return ref as { id: string; updatedAt: string; tags: string[]; notebook: string | null };
  }

  it('leaves the date alone when update_note re-sends the stored title and body', async () => {
    const before = await note({ title: 'Coupons', body: 'Line one' });

    const after = JSON.parse(
      toolText(
        (
          await mcp(alice.token, 'tools/call', {
            name: 'update_note',
            arguments: { noteId: before.id, title: 'Coupons', body: 'Line one' },
          })
        ).body,
      ),
    );
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('keeps update_note_tags honest about leaving present tags alone', async () => {
    const before = await note({ title: 'Coupons', body: 'Body', tags: ['deals'] });

    // Adding a tag the note already carries, and removing one it never had.
    const after = await mcp(alice.token, 'tools/call', {
      name: 'update_note_tags',
      arguments: { noteIds: [before.id], add: ['deals'], remove: ['absent'] },
    });
    const result = JSON.parse(toolText(after.body));
    expect(result).toEqual({
      noteIds: [before.id],
      urls: { [before.id]: `${ORIGIN}/notes/${before.id}` },
      changed: 0,
      missing: [],
    });

    const read = JSON.parse(
      toolText(
        (await mcp(alice.token, 'tools/call', { name: 'get_note', arguments: { noteId: before.id } }))
          .body,
      ),
    );
    expect(read.tags).toEqual(['deals']);
    expect(read.updatedAt).toBe(before.updatedAt);
  });

  it('treats a tag named in another case as the tag there is (MAK-127)', async () => {
    // The case that started it: an assistant tagging "receipts" beside Receipts made a
    // second tag, and removing "receipts" left Receipts on the note without a word.
    const tag = `Receipts ${crypto.randomUUID().slice(0, 8)}`;
    const before = await note({ title: 'Coupons', body: 'Body', tags: [tag] });
    const other = await note({ title: 'Coupons too', body: 'Body', tags: [tag.toLowerCase()] });
    expect(other.tags).toEqual([tag]);

    const added = JSON.parse(
      toolText(
        (
          await mcp(alice.token, 'tools/call', {
            name: 'update_note_tags',
            arguments: { noteIds: [before.id], add: [tag.toUpperCase()] },
          })
        ).body,
      ),
    );
    expect(added.changed).toBe(0);

    const listed = JSON.parse(
      toolText((await mcp(alice.token, 'tools/call', { name: 'list_notes', arguments: { tag: [tag.toLowerCase()] } })).body),
    );
    expect(listed.notes.map((n: { id: string }) => n.id).sort()).toEqual([before.id, other.id].sort());

    const removed = JSON.parse(
      toolText(
        (
          await mcp(alice.token, 'tools/call', {
            name: 'update_note_tags',
            arguments: { noteIds: [before.id, other.id], remove: [tag.toLowerCase()] },
          })
        ).body,
      ),
    );
    // Both notes: under exact matching only the note spelled "receipts" would have lost it.
    expect(removed.changed).toBe(2);
  });

  it('leaves the date alone when move_notes re-files a note where it already is', async () => {
    const before = await note({ title: 'Coupons', body: 'Body', notebook: 'Podcast Bookmarks' });

    const after = await mcp(alice.token, 'tools/call', {
      name: 'move_notes',
      arguments: { noteIds: [before.id], notebook: 'Podcast Bookmarks' },
    });
    expect(JSON.parse(toolText(after.body))).toEqual({
      notebook: 'Podcast Bookmarks',
      notebookUrl: `${ORIGIN}/notes?notebook=Podcast+Bookmarks`,
      noteIds: [before.id],
      urls: { [before.id]: `${ORIGIN}/notes/${before.id}` },
      changed: 0,
      missing: [],
    });

    const read = JSON.parse(
      toolText(
        (await mcp(alice.token, 'tools/call', { name: 'get_note', arguments: { noteId: before.id } }))
          .body,
      ),
    );
    expect(read.updatedAt).toBe(before.updatedAt);
  });

  it('still bumps the date for an edit_note replace that changes the body', async () => {
    const before = await note({ title: 'Coupons', body: 'Line one' });

    const after = JSON.parse(
      toolText(
        (
          await mcp(alice.token, 'tools/call', {
            name: 'edit_note',
            arguments: { noteId: before.id, mode: 'replace', find: 'one', content: 'two' },
          })
        ).body,
      ),
    );
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime());
  });

  it('leaves the date alone when an edit_note replace substitutes text for itself', async () => {
    const before = await note({ title: 'Coupons', body: 'Line one' });

    // An agent retrying a replace it already applied: the body it writes back is the body
    // already stored.
    const after = JSON.parse(
      toolText(
        (
          await mcp(alice.token, 'tools/call', {
            name: 'edit_note',
            arguments: { noteId: before.id, mode: 'replace', find: 'one', content: 'one' },
          })
        ).body,
      ),
    );
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

/**
 * update_note with `ifUpdatedAt`: an assistant that read a note, and a person who saved it
 * in the editor before the assistant wrote. The precondition is what turns that into a
 * refusal carrying the person's text, rather than the assistant's write landing over it.
 */
describe('a write through MCP against a copy that has since changed', () => {
  it('refuses update_note and hands back the note as it now stands', async () => {
    const created = JSON.parse(
      toolText(
        (
          await mcp(alice.token, 'tools/call', {
            name: 'create_note',
            arguments: { title: 'Coupons', body: 'Read by the assistant' },
          })
        ).body,
      ),
    ) as { id: string; updatedAt: string };
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The person saves from the editor.
    const saved = await fetch(`${BASE}/api/notes/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: alice.cookie, Origin: ORIGIN },
      body: JSON.stringify({ body: 'Saved by the person' }),
    });
    expect(saved.status).toBe(200);

    const refused = await mcp(alice.token, 'tools/call', {
      name: 'update_note',
      arguments: { noteId: created.id, body: 'Written by the assistant', ifUpdatedAt: created.updatedAt },
    });
    expect(refused.body.result?.isError).toBe(true);
    expect(toolText(refused.body)).toContain('changed after you read it');
    expect(toolText(refused.body)).toContain('Saved by the person');

    const read = JSON.parse(
      toolText(
        (await mcp(alice.token, 'tools/call', { name: 'get_note', arguments: { noteId: created.id } })).body,
      ),
    ) as { body: string; updatedAt: string };
    expect(read.body).toBe('Saved by the person');

    // Against the copy it just read, the same write goes through.
    const retried = await mcp(alice.token, 'tools/call', {
      name: 'update_note',
      arguments: { noteId: created.id, body: 'Written by the assistant', ifUpdatedAt: read.updatedAt },
    });
    expect(retried.body.result?.isError).toBeFalsy();
  });
});

/**
 * Attaching a file by URL.
 *
 * The bytes come from a throwaway HTTP server in this process rather than from the
 * internet, so the suite needs no network and can serve exactly the awkward cases —
 * a body with no declared length, a declared length far past the cap, a generic type —
 * and can count what was fetched, which is how the cross-tenant case proves that nothing
 * was downloaded on a stranger's behalf. The Worker reaches it on loopback, which is
 * where `wrangler dev` runs; nothing here would hold on the deployed instance, where
 * loopback is the Worker itself.
 */
describe('add_attachment', () => {
  const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const hits: Record<string, number> = {};
  const seen: Record<string, { ua: string | undefined; referer: string | undefined }> = {};
  let files: Server;
  let origin: string;
  let carol: Actor;
  let dave: Actor;
  let carolNoteId: string;

  beforeAll(async () => {
    files = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      hits[path] = (hits[path] ?? 0) + 1;
      switch (path) {
        case '/report.pdf':
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF.length });
          return res.end(PDF);
        case '/named.pdf':
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': PDF.length,
            'Content-Disposition': 'attachment; filename="Lab Results (2026).pdf"',
          });
          return res.end(PDF);
        case '/unsized.txt':
          // No Content-Length: node sends this chunked.
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('hello, ');
          return res.end('world');
        case '/generic':
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': PDF.length,
          });
          return res.end(PDF);
        case '/hotlinked.jpg': {
          // Serves only a browser on one of its own pages, as a hotlink check does.
          seen[path] = { ua: req.headers['user-agent'], referer: req.headers['referer'] };
          const fromBrowser = /Chrome\//.test(req.headers['user-agent'] ?? '');
          const fromShop = req.headers['referer'] === 'http://shop.example.com/';
          if (!fromBrowser || !fromShop) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('hotlinking not allowed');
          }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PICTURE.length });
          return res.end(PICTURE);
        }
        case '/blocked.png':
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          return res.end('access denied');
        case '/huge':
          // Declares a body it never sends; the Worker must refuse on the header alone.
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 200 * 1024 * 1024 });
          res.flushHeaders();
          setTimeout(() => res.destroy(), 500);
          return;
        default:
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('no such file');
      }
    });
    await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;

    // Actors of this block's own, so a grant revoked by an earlier case cannot reach here.
    const stamp = Date.now();
    const carolCookie = await signUp(`mcp-carol-${stamp}@example.test`, 'carol-password-12', 'Carol');
    const daveCookie = await signUp(`mcp-dave-${stamp}@example.test`, 'dave-password-123', 'Dave');
    const clientId = await registerClient('Attachment Assistant');
    carol = { cookie: carolCookie, userId: '', token: await tokenFor(carolCookie, clientId, RESOURCE) };
    dave = { cookie: daveCookie, userId: '', token: await tokenFor(daveCookie, clientId, RESOURCE) };

    const created = await mcp(carol.token, 'tools/call', {
      name: 'create_note',
      arguments: { title: 'Carol scans', body: 'Before any attachment.' },
    });
    carolNoteId = JSON.parse(toolText(created.body)).id;
    expect(carolNoteId).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => files.close(() => resolve()));
  });

  async function add(token: string, args: Record<string, unknown>) {
    const { body } = await mcp(token, 'tools/call', { name: 'add_attachment', arguments: args });
    const text = toolText(body);
    return { isError: body.result?.isError === true, text, json: () => JSON.parse(text) };
  }

  async function noteBody(actor: Actor, noteId: string): Promise<string> {
    const res = await fetch(`${BASE}/api/notes/${noteId}`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    return ((await res.json()) as { body: string }).body;
  }

  async function listFiles(actor: Actor, noteId: string): Promise<string[]> {
    const res = await fetch(`${BASE}/api/notes/${noteId}/files`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    return ((await res.json()) as { files: Array<{ filename: string }> }).files.map((f) => f.filename);
  }

  it('is offered', async () => {
    const { body } = await mcp(carol.token, 'tools/list');
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain('add_attachment');
  });

  it('asks as a browser on the page the caller names', async () => {
    const result = await add(carol.token, {
      noteId: carolNoteId,
      url: `${origin}/hotlinked.jpg`,
      referer: 'http://shop.example.com/mens/shoe-123.html',
      link: false,
    });
    expect(result.isError).toBe(false);
    expect(result.json()).toMatchObject({ filename: 'hotlinked.jpg', contentType: 'image/png' });
    // Another site is told the origin of the page, as Chrome would tell it.
    expect(seen['/hotlinked.jpg']?.referer).toBe('http://shop.example.com/');
    expect(seen['/hotlinked.jpg']?.ua).toMatch(/Chrome\//);
  });

  it('refuses a referer that is not a web page', async () => {
    const result = await add(carol.token, {
      noteId: carolNoteId,
      url: `${origin}/report.pdf`,
      referer: 'file:///page.html',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('referer');
  });

  it('points a refused fetch at the upload link, which a browser can use', async () => {
    const result = await add(carol.token, { noteId: carolNoteId, url: `${origin}/blocked.png` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('403');
    expect(result.text).toContain('prepare_attachment_upload');
    expect(result.text).toContain('browser');
  });

  it('fetches the file, stores it, and links it at the end of the note', async () => {
    const result = await add(carol.token, { noteId: carolNoteId, url: `${origin}/report.pdf` });
    expect(result.isError).toBe(false);
    const stored = result.json();
    expect(stored).toMatchObject({
      noteId: carolNoteId,
      filename: 'report.pdf',
      path: 'files/report.pdf',
      markdown: '[report.pdf](files/report.pdf)',
      contentType: 'application/pdf',
      size: PDF.length,
      linked: true,
    });
    expect(['server', 'client']).toContain(stored.indexing);

    expect(await noteBody(carol, carolNoteId)).toBe(
      'Before any attachment.\n\n[report.pdf](files/report.pdf)',
    );

    // The bytes are the ones the source served, and they come back the way an upload would.
    const served = await fetch(`${BASE}/api/notes/${carolNoteId}/files/report.pdf`, {
      headers: { Cookie: carol.cookie, Origin: ORIGIN },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PDF);
  });

  it('uses the given filename, suffixes a collision, and leaves the body alone when asked', async () => {
    const before = await noteBody(carol, carolNoteId);
    const result = await add(carol.token, {
      noteId: carolNoteId,
      url: `${origin}/report.pdf`,
      filename: 'Insurance card.pdf',
      link: false,
    });
    expect(result.isError).toBe(false);
    expect(result.json()).toMatchObject({
      filename: 'Insurance card.pdf',
      // Whitespace in the destination needs the angle brackets, or the link does not render.
      markdown: '[Insurance card.pdf](<files/Insurance card.pdf>)',
      linked: false,
    });
    expect(await noteBody(carol, carolNoteId)).toBe(before);

    const again = await add(carol.token, {
      noteId: carolNoteId,
      url: `${origin}/report.pdf`,
      filename: 'Insurance card.pdf',
      link: false,
    });
    expect(again.json().filename).toBe('Insurance card-2.pdf');
  });

  it("takes the source's Content-Disposition name over the URL's", async () => {
    const result = await add(carol.token, { noteId: carolNoteId, url: `${origin}/named.pdf`, link: false });
    expect(result.isError).toBe(false);
    expect(result.json().filename).toBe('Lab Results (2026).pdf');
  });

  it('takes a body whose length the source did not declare', async () => {
    const result = await add(carol.token, { noteId: carolNoteId, url: `${origin}/unsized.txt`, link: false });
    expect(result.isError).toBe(false);
    expect(result.json()).toMatchObject({ filename: 'unsized.txt', contentType: 'text/plain', size: 12 });
    const served = await fetch(`${BASE}/api/notes/${carolNoteId}/files/unsized.txt`, {
      headers: { Cookie: carol.cookie, Origin: ORIGIN },
    });
    expect(await served.text()).toBe('hello, world');
  });

  it('reads the type off the filename when the source only says "binary"', async () => {
    const result = await add(carol.token, {
      noteId: carolNoteId,
      url: `${origin}/generic`,
      filename: 'scan.pdf',
      link: false,
    });
    expect(result.isError).toBe(false);
    expect(result.json().contentType).toBe('application/pdf');
  });

  it('refuses a file larger than an attachment may be, before reading it', async () => {
    const before = await listFiles(carol, carolNoteId);
    const result = await add(carol.token, { noteId: carolNoteId, url: `${origin}/huge` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('at most');
    expect(await listFiles(carol, carolNoteId)).toEqual(before);
  });

  it('refuses a reference that is not a download link, and says what to do', async () => {
    const result = await add(carol.token, { noteId: carolNoteId, url: 'file://abc-123/upload.pdf' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Only http and https');
    expect(result.text).toContain('download URL');
  });

  it('refuses a private-network address (SSRF), before fetching anything', async () => {
    // A link-local address is refused whatever the loopback setting — the server must not
    // be pointed at its own metadata endpoint or a neighbour on the private network. This
    // is the same guard the web-image fetch applies, shared so the two cannot disagree.
    const before = await listFiles(carol, carolNoteId);
    const result = await add(carol.token, {
      noteId: carolNoteId,
      url: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(result.isError).toBe(true);
    expect(await listFiles(carol, carolNoteId)).toEqual(before);
  });

  it("reports the source's refusal rather than storing its error page", async () => {
    const before = await listFiles(carol, carolNoteId);
    const result = await add(carol.token, { noteId: carolNoteId, url: `${origin}/missing.pdf` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('404');
    expect(await listFiles(carol, carolNoteId)).toEqual(before);
  });

  it('tells get_note readers how to link each file', async () => {
    const { body } = await mcp(carol.token, 'tools/call', {
      name: 'get_note',
      arguments: { noteId: carolNoteId },
    });
    const note = JSON.parse(toolText(body)) as {
      attachments: Array<{ filename: string; path: string; markdown: string }>;
    };
    expect(note.attachments).toContainEqual(
      expect.objectContaining({
        filename: 'Insurance card.pdf',
        path: 'files/Insurance card.pdf',
        markdown: '[Insurance card.pdf](<files/Insurance card.pdf>)',
      }),
    );
  });

  it('fetches nothing for a note that is not the caller\'s', async () => {
    const fetched = hits['/report.pdf'] ?? 0;
    const result = await add(dave.token, { noteId: carolNoteId, url: `${origin}/report.pdf` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No such note');
    expect(hits['/report.pdf'] ?? 0).toBe(fetched);
    expect(await listFiles(carol, carolNoteId)).not.toContain('report-2.pdf');
  });
});

/**
 * Uploading a file the assistant holds, through a link prepare_attachment_upload mints.
 *
 * The PUT goes to the link exactly as the tool hands it out — on the SPA origin, through
 * whatever sits in front of the Worker — with no cookie and no bearer token, because the
 * request is curl in an agent's shell and the link is the only credential it has. What
 * these prove is that the link is enough, that it is enough only once, and that it is not
 * spent by a request that was wrong on its face.
 */
describe('prepare_attachment_upload', () => {
  // Not a real PNG: the type comes from the name, and nothing here decodes the image.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  let erin: Actor;
  let frank: Actor;
  let erinNoteId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    const erinCookie = await signUp(`mcp-erin-${stamp}@example.test`, 'erin-password-123', 'Erin');
    const frankCookie = await signUp(`mcp-frank-${stamp}@example.test`, 'frank-password-12', 'Frank');
    const clientId = await registerClient('Upload Assistant');
    erin = { cookie: erinCookie, userId: '', token: await tokenFor(erinCookie, clientId, RESOURCE) };
    frank = { cookie: frankCookie, userId: '', token: await tokenFor(frankCookie, clientId, RESOURCE) };

    const created = await mcp(erin.token, 'tools/call', {
      name: 'create_note',
      arguments: { title: 'Erin screenshots', body: 'Before any upload.' },
    });
    erinNoteId = JSON.parse(toolText(created.body)).id;
    expect(erinNoteId).toBeTruthy();
  }, 60_000);

  async function prepare(token: string, args: Record<string, unknown>) {
    const { body } = await mcp(token, 'tools/call', { name: 'prepare_attachment_upload', arguments: args });
    const text = toolText(body);
    return { isError: body.result?.isError === true, text, json: () => JSON.parse(text) };
  }

  /** As curl --data-binary would send it: a length, and a Content-Type that means nothing. */
  function put(url: string, bytes: Uint8Array) {
    return fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bytes,
    });
  }

  async function files(actor: Actor, noteId: string) {
    const res = await fetch(`${BASE}/api/notes/${noteId}/files`, {
      headers: { Cookie: actor.cookie, Origin: ORIGIN },
    });
    return ((await res.json()) as { files: Array<{ filename: string }> }).files.map((f) => f.filename);
  }

  it('is offered', async () => {
    const { body } = await mcp(erin.token, 'tools/list');
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain('prepare_attachment_upload');
  });

  it('takes the bytes on a link alone, stores them, and answers as add_attachment does', async () => {
    const link = await prepare(erin.token, { noteId: erinNoteId, filename: 'Screen shot 1.png' });
    expect(link.isError).toBe(false);
    const { uploadUrl, method, expiresAt } = link.json();
    expect(uploadUrl.startsWith(`${ORIGIN}/api/uploads/`)).toBe(true);
    expect(method).toBe('PUT');
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const res = await put(uploadUrl, PNG);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      noteId: erinNoteId,
      filename: 'Screen shot 1.png',
      path: 'files/Screen shot 1.png',
      markdown: '![Screen shot 1.png](<files/Screen shot 1.png>)',
      // From the extension, not the request's form-encoded header.
      contentType: 'image/png',
      size: PNG.length,
      linked: true,
    });

    const note = await fetch(`${BASE}/api/notes/${erinNoteId}`, {
      headers: { Cookie: erin.cookie, Origin: ORIGIN },
    });
    expect(((await note.json()) as { body: string }).body).toBe(
      'Before any upload.\n\n![Screen shot 1.png](<files/Screen shot 1.png>)',
    );
    const served = await fetch(`${BASE}/api/notes/${erinNoteId}/files/Screen%20shot%201.png`, {
      headers: { Cookie: erin.cookie, Origin: ORIGIN },
    });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it('takes the file from the curl command the tool prints, as printed', async () => {
    const { example } = (await prepare(erin.token, { noteId: erinNoteId, filename: 'from-curl.png', link: false })).json();
    const path = join(mkdtempSync(join(tmpdir(), 'unbent-upload-')), 'local name.png');
    writeFileSync(path, PNG);

    // The placeholder is the only thing an assistant fills in; the rest runs as given.
    const [, url] = /curl -T <path to the file> "(.+)"$/.exec(example) ?? [];
    expect(url).toBeTruthy();
    const out = execFileSync('curl', ['-sS', '-T', path, url!], { encoding: 'utf8' });
    expect(JSON.parse(out)).toMatchObject({ filename: 'from-curl.png', contentType: 'image/png', size: PNG.length });
  });

  it('works once', async () => {
    const { uploadUrl } = (await prepare(erin.token, { noteId: erinNoteId, filename: 'once.pdf', link: false })).json();
    expect((await put(uploadUrl, PNG)).status).toBe(201);

    const again = await put(uploadUrl, PNG);
    expect(again.status).toBe(404);
    expect(((await again.json()) as { error: string }).error).toContain('prepare_attachment_upload');
    expect((await files(erin, erinNoteId)).filter((f) => f.startsWith('once'))).toEqual(['once.pdf']);
  });

  it('is not spent by a request that sent no length', async () => {
    const { uploadUrl } = (await prepare(erin.token, { noteId: erinNoteId, filename: 'chunked.txt', link: false })).json();
    const chunked = await fetch(uploadUrl, {
      method: 'PUT',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(chunked.status).toBe(411);

    expect((await put(uploadUrl, new TextEncoder().encode('hello'))).status).toBe(201);
  });

  it('opens nothing for a token that was never minted', async () => {
    const res = await put(`${ORIGIN}/api/uploads/not-a-real-token`, PNG);
    expect(res.status).toBe(404);
  });

  /*
     A browser on any page can send the bytes, so an assistant in a tab can hand over a
     picture it fetched there. The preflight is what a browser sends first; without the
     right answer to it the PUT never leaves the page.

     These go to the Worker, not through the SPA origin the link is built on: in
     development that origin is Vite, whose own CORS layer answers every preflight before
     its proxy sees it — and is there to keep other sites from reading the dev server's
     source, so it stays. In production the Worker is the SPA origin and answers itself.
  */
  const viaWorker = (uploadUrl: string) => uploadUrl.replace(ORIGIN, BASE);

  it('answers a preflight from any origin, without credentials', async () => {
    const res = await fetch(`${BASE}/api/uploads/any-token`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://shop.example.com',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('PUT,OPTIONS');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('lets another origin read the answer to a PUT, and to a refused one', async () => {
    const uploadUrl = viaWorker(
      (await prepare(erin.token, { noteId: erinNoteId, filename: 'from-a-page.png', link: false })).json().uploadUrl,
    );
    const headers = { Origin: 'https://shop.example.com', 'Content-Type': 'image/png' };

    const res = await fetch(uploadUrl, { method: 'PUT', headers, body: PNG });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({ filename: 'from-a-page.png', contentType: 'image/png' });

    const again = await fetch(uploadUrl, { method: 'PUT', headers, body: PNG });
    expect(again.status).toBe(404);
    expect(again.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('opens no other route to other origins', async () => {
    const res = await fetch(`${BASE}/api/notes`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://shop.example.com', 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('mints nothing for a note that is not the caller\'s', async () => {
    const result = await prepare(frank.token, { noteId: erinNoteId, filename: 'intruder.png' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No such note');
    expect(result.text).not.toContain('uploads/');
  });

  it('stores nothing on a note trashed after its link was made', async () => {
    const created = await mcp(erin.token, 'tools/call', {
      name: 'create_note',
      arguments: { title: 'Soon trashed', body: '' },
    });
    const doomed = JSON.parse(toolText(created.body)).id;
    const { uploadUrl } = (await prepare(erin.token, { noteId: doomed, filename: 'late.png' })).json();
    await mcp(erin.token, 'tools/call', { name: 'delete_note', arguments: { noteId: doomed } });

    const res = await put(uploadUrl, PNG);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('no longer there');
  });
});

/**
 * Reorganising an account through MCP, end to end.
 *
 * The handlers have unit tests against a mocked repo and the store has its own; what
 * neither proves is that a field written to a set of notes, a count taken inside a
 * notebook and a tag folded into another survive the real path — the tool's schema, the
 * RPC to the object and the SQL — in the order an assistant would actually use them:
 * look at what a notebook's notes carry, give them a field, retire the tag the field
 * replaced, and remove the notebook that is left over.
 */
describe('reorganising notebooks and tags through MCP', () => {
  async function call(name: string, args: Record<string, unknown>) {
    const res = await mcp(alice.token, 'tools/call', { name, arguments: args });
    return JSON.parse(toolText(res.body));
  }

  it('counts tags inside a notebook, sets a field on its notes, merges a tag and deletes a notebook', async () => {
    const stamp = Date.now();
    const notebook = `Coupons ${stamp}`;
    const year = `Year 2025 ${stamp}`;
    const kept = `Deals ${stamp}`;

    const { id: notebookId } = await call('create_notebook', { name: notebook });
    await call('create_notebook_field', { notebookId, name: 'Year', type: 'number' });
    const a = await call('create_note', { title: 'Acme 10% off', notebook, tags: [year, kept] });
    const b = await call('create_note', { title: 'Acme free shipping', notebook, tags: [year] });
    const c = await call('create_note', { title: 'Report (final) v2', notebook });

    // Only this notebook's notes are counted, and the tag that defines the set is left out.
    const inNotebook = await call('list_tags', { notebook });
    expect(inNotebook.tags.map((t: { name: string; count: number }) => [t.name, t.count])).toEqual([
      [year, 2],
      [kept, 1],
    ]);
    const alongside = await call('list_tags', { tag: [year] });
    expect(alongside.tags.map((t: { name: string; count: number }) => [t.name, t.count])).toEqual([
      [kept, 1],
    ]);

    const untagged = await call('list_notes', { notebook, untagged: true });
    expect(untagged.notes.map((n: { id: string }) => n.id)).toEqual([c.id]);

    // A compact page is wider than a full one and carries only what a batch write is
    // checked against; a full page that wide is refused.
    const compact = await call('list_notes', { notebook, compact: true, limit: 500, sort: 'title', order: 'asc' });
    expect(compact.total).toBe(3);
    expect(compact.notes).toEqual([
      { id: a.id, title: 'Acme 10% off', notebook, tags: expect.arrayContaining([year, kept]) },
      { id: b.id, title: 'Acme free shipping', notebook, tags: [year] },
      { id: c.id, title: 'Report (final) v2', notebook, tags: [] },
    ]);
    const tooWide = await mcp(alice.token, 'tools/call', {
      name: 'list_notes',
      arguments: { notebook, limit: 500 },
    });
    expect(tooWide.body.result?.isError).toBe(true);

    // The total comes with the first page; the page after it does not count again.
    const first = await call('list_notes', { notebook, limit: 2 });
    expect(first.total).toBe(3);
    const second = await call('list_notes', { notebook, limit: 2, cursor: first.cursor });
    expect(second.returned).toBe(1);
    expect('total' in second).toBe(false);

    // The second call re-sends what is there, and says so rather than re-dating the notes.
    const set = await call('update_note_fields', { noteIds: [a.id, b.id], fields: { Year: 2025 } });
    expect(set).toEqual({
      noteIds: expect.arrayContaining([a.id, b.id]),
      urls: { [a.id]: `${ORIGIN}/notes/${a.id}`, [b.id]: `${ORIGIN}/notes/${b.id}` },
      changed: 2,
      missing: [],
    });
    const again = await call('update_note_fields', { noteIds: [a.id, b.id], fields: { Year: 2025 } });
    expect(again.changed).toBe(0);

    const byField = await call('list_notes', {
      notebook,
      fields: [{ field: 'Year', op: 'eq', value: '2025' }],
    });
    expect(byField.total).toBe(2);
    const empty = await call('list_notes', { notebook, fields: [{ field: 'Year', op: 'empty' }] });
    expect(empty.notes.map((n: { id: string }) => n.id)).toEqual([c.id]);

    // A rename onto a name that is taken is refused until merge is asked for.
    const refused = await mcp(alice.token, 'tools/call', {
      name: 'rename_tag',
      arguments: { tag: year, name: kept },
    });
    expect(refused.body.result?.isError).toBe(true);
    const merged = await call('rename_tag', { tag: year, name: kept, merge: true });
    expect(merged.merged).toBe(true);
    expect((await call('list_tags', { notebook })).tags).toEqual([
      expect.objectContaining({ name: kept, count: 2 }),
    ]);

    expect(await call('delete_tag', { tag: kept })).toEqual({ tag: kept, deleted: true, notes: 2 });

    const gone = await call('delete_notebook', { notebookId });
    expect(gone).toEqual({ id: notebookId, name: notebook, deleted: true, unfiled: 3 });
    // The notes outlive the notebook, filed nowhere.
    expect((await call('get_note', { noteId: a.id })).notebook ?? null).toBeNull();
  });
});

describe('list_notes cursors (MAK-217)', () => {
  async function call(name: string, args: Record<string, unknown>) {
    return mcp(alice.token, 'tools/call', { name, arguments: args });
  }

  it('are printable, page on, and a mangled one is refused rather than read as page one', async () => {
    const notebook = `Cursors ${Date.now()}`;
    for (const title of ['One', 'Two', 'Three']) await call('create_note', { title, notebook });

    const first = JSON.parse(toolText((await call('list_notes', { notebook, limit: 2, sort: 'title', order: 'asc' })).body));
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = JSON.parse(
      toolText((await call('list_notes', { notebook, limit: 2, sort: 'title', order: 'asc', cursor: first.cursor })).body),
    );
    expect(second.notes.map((n: { title: string }) => n.title)).toEqual(['Two']);

    // The shape of the cursor that went wrong: the separator written back as six characters.
    const mangled = await call('list_notes', { notebook, limit: 2, cursor: `1790651018892\\u001f${aliceNoteId}` });
    expect(mangled.body.result?.isError ?? Boolean(mangled.body.error)).toBe(true);
    expect(JSON.stringify(mangled.body)).toContain('Not a cursor from a previous page');

    // The HTTP list refuses the same cursor with a 400, rather than answering page one.
    const res = await fetch(`${BASE}/api/notes?cursor=${encodeURIComponent('not-a-cursor!')}`, {
      headers: { Cookie: alice.cookie, Origin: ORIGIN },
    });
    expect(res.status).toBe(400);
  });
});

describe('list_notes compact with include (MAK-216)', () => {
  async function call(name: string, args: Record<string, unknown>) {
    return JSON.parse(toolText((await mcp(alice.token, 'tools/call', { name, arguments: args })).body));
  }

  it('carries just the named fields beside each title', async () => {
    const notebook = `Watch Later ${Date.now()}`;
    const { id: notebookId } = await call('create_notebook', { name: notebook });
    await call('create_notebook_field', { notebookId, name: 'Type', type: 'select', options: ['Movie', 'Series'] });
    await call('create_notebook_field', { notebookId, name: 'URL', type: 'url' });
    await call('create_notebook_field', { notebookId, name: 'Notes', type: 'text' });
    await call('create_note', {
      title: 'Coyote Returns',
      notebook,
      fields: { Type: 'Movie', URL: 'https://example.com/coyote', Notes: 'long' },
    });

    const page = await call('list_notes', { notebook, compact: true, include: ['type', 'URL'] });
    expect(page.notes).toEqual([
      {
        id: expect.any(String),
        title: 'Coyote Returns',
        notebook,
        tags: [],
        fields: { Type: 'Movie', URL: 'https://example.com/coyote' },
      },
    ]);
  });
});
