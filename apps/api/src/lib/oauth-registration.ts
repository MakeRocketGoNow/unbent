/**
 * What dynamic client registration does with a client that redirects to this machine
 * (MAK-218).
 *
 * The OAuth provider takes a client that sends no `application_type` to be a web client,
 * as the registration spec says to, and a web client may only redirect to https on a
 * public host. A program that signs in through a local redirect — `http://127.0.0.1:53682/
 * callback` — is a native client (RFC 8252), and registers as one only by saying so. The
 * official MCP SDK does not say so: its client metadata has no `application_type` at all,
 * so a stock MCP client was refused before anyone saw a sign-in page, with a message
 * calling its loopback address "non-loopback".
 *
 * So, before the provider sees the request:
 *
 * - A public client (`token_endpoint_auth_method: "none"`) that names no type and
 *   redirects only to http on `localhost`, `127.0.0.1` or `[::1]` is registered as native,
 *   which is what RFC 8252 §7.3 describes and the only thing such a client can be. Those
 *   three are the exact hosts the provider allows a native client over http, so nothing
 *   gets through here that a client sending `"native"` itself could not register.
 * - A client still taken as web that names a loopback redirect is refused here, with a
 *   message that says why and what to send instead. Not a confidential client quietly made
 *   native: a client that holds a secret and redirects to this machine is unusual enough
 *   that it should be told rather than guessed at.
 *
 * Everything else passes untouched, and the provider's own checks still run on the result.
 */
export type RegistrationDecision =
  | { kind: 'native'; body: Record<string, unknown> }
  | { kind: 'refuse'; message: string }
  | null;

const NATIVE_HTTP_LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function loopbackHost(uri: string): { loopback: boolean; http: boolean } {
  try {
    const url = new URL(uri);
    const host = url.hostname.toLowerCase();
    return {
      loopback: NATIVE_HTTP_LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host),
      http: url.protocol === 'http:' && NATIVE_HTTP_LOOPBACK.has(host),
    };
  } catch {
    // Not a URI at all: the provider's own message for that is the right one.
    return { loopback: false, http: false };
  }
}

export function loopbackRegistration(body: unknown): RegistrationDecision {
  if (!body || typeof body !== 'object') return null;
  const metadata = body as Record<string, unknown>;
  const type = metadata['application_type'];
  if (type !== undefined && type !== 'web') return null;
  const uris = Array.isArray(metadata['redirect_uris'])
    ? metadata['redirect_uris'].filter((u): u is string => typeof u === 'string')
    : [];
  const hosts = uris.map(loopbackHost);

  if (
    type === undefined &&
    metadata['token_endpoint_auth_method'] === 'none' &&
    uris.length > 0 &&
    hosts.every((h) => h.http)
  ) {
    return { kind: 'native', body: { ...metadata, application_type: 'native' } };
  }

  const local = uris.find((_, i) => hosts[i]!.loopback);
  if (local === undefined) return null;
  return {
    kind: 'refuse',
    message:
      `${local} is a loopback redirect, and a web client must redirect to https on a public ` +
      'host. A program that signs in through a local redirect is a native client: register ' +
      'it with "application_type": "native", or as a public client ' +
      '("token_endpoint_auth_method": "none") whose redirects are all http on localhost, ' +
      '127.0.0.1 or [::1], which is registered as native without asking.',
  };
}

/**
 * Registration metadata with every empty value taken out: `null`, `""` and `[]` (MAK-224).
 *
 * RFC 7591 metadata is optional field by field, and a client that has nothing to say for
 * one is meant to leave it out. Plenty of clients write it out empty instead — a struct
 * serialized with every field present, a Pydantic model dumped without `exclude_none` —
 * and the provider's schema reads `"contacts": []` as a list that is too short and
 * `"client_uri": null` as a string that is not a string, and refuses the whole
 * registration. The client is then told only that registration failed, and Gemini, which
 * reported exactly that, asks the person for a client id and secret they have no way of
 * getting.
 *
 * For a detail, absent is the meaning every one of these values has, and absent is what
 * the provider fills its defaults in for: an empty `redirect_uris` taken out is still
 * refused as missing, and an empty `scope` gets the same default scopes an omitted one
 * does. Only the top level is touched; a non-empty value is passed through exactly as
 * sent, for the provider's own checks.
 *
 * A *choice* written out empty is different, and kept: `""` or `[]` for how the client
 * authenticates, what kind of app it is, or which grants and responses it wants. Taking
 * one of those out would have the provider pick its default instead of refusing — an
 * empty auth method would be issued a secret it never asked for, then fail at the token
 * endpoint with a worse error than a clear refusal here, and an empty application type
 * could be registered as native by `loopbackRegistration`. `null` is still taken out of
 * them, because that is how a serializer writes a field nobody set.
 *
 * Returns null when there was nothing to take out, so `registerClient` passes the body on as sent.
 */
const CHOICES = new Set(['token_endpoint_auth_method', 'application_type', 'grant_types', 'response_types']);

export function withoutEmptyMetadata(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const entries = Object.entries(body as Record<string, unknown>);
  const kept = entries.filter(([k, v]) => !(v === null || (!CHOICES.has(k) && (v === '' || (Array.isArray(v) && v.length === 0)))));
  return kept.length === entries.length ? null : Object.fromEntries(kept);
}

/**
 * What the log says about a refused registration (MAK-224): enough to tell which rule
 * refused which kind of client, and nothing that names a person.
 *
 * The registration endpoint is unauthenticated and refusals were silent, so when an
 * assistant could not connect the only evidence was its own one-line message. This is the
 * request's shape — the fields it sent, how it wants to authenticate, which grants and
 * responses, which redirect *hosts* — beside the provider's reason. Hosts and not whole
 * redirects, because a relay's path can carry a per-user id (Google's does); the client's
 * name, because it is the program's and is how the line is found.
 *
 * Every value is cut short, the keys and redirects counted off after a few dozen, and
 * anything that is not a string or a list of them reduced to its type: the endpoint
 * answers anyone, and a summary that copied what it was sent would let anyone write lines
 * of any size into the Worker's log.
 */
export function registrationSummary(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { body: typeof body };
  const metadata = body as Record<string, unknown>;
  const uris = Array.isArray(metadata['redirect_uris']) ? metadata['redirect_uris'] : [];
  const hosts = uris.map((u) => {
    try {
      return new URL(String(u)).host;
    } catch {
      return '(not a URI)';
    }
  });
  return {
    client_name: clip(metadata['client_name'], 80),
    fields: Object.keys(metadata).sort().slice(0, 40).map((k) => k.slice(0, 40)),
    token_endpoint_auth_method: clip(metadata['token_endpoint_auth_method']),
    application_type: clip(metadata['application_type']),
    grant_types: clip(metadata['grant_types']),
    response_types: clip(metadata['response_types']),
    scope: clip(metadata['scope'], 200),
    redirect_hosts: [...new Set(hosts)].slice(0, 10).map((h) => h.slice(0, 100)),
    redirect_count: uris.length,
  };
}

/** A value for the log, bounded: a string cut short, a list of the first few, else its type. */
function clip(value: unknown, length = 60): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.slice(0, length);
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => (typeof v === 'string' ? v.slice(0, length) : typeof v));
  return typeof value;
}

/**
 * Dynamic client registration, with what this server adds done around Better Auth's own.
 *
 * Metadata a client wrote out empty is taken out before Better Auth sees it (MAK-224), a
 * client that redirects to this machine is registered as native or told why not
 * (MAK-218), and a refusal is logged with its reason (MAK-224); `withoutEmptyMetadata`,
 * `loopbackRegistration` and `registrationSummary` say why each. Both are done around the handler, from the route, rather than in the auth config's
 * hooks, because Better Auth checks a request's body against its schema before any hook
 * runs: an empty `contacts` was refused before a `before` hook could take it out, and an
 * `after` hook never heard of the refusal. The loopback rules (MAK-218) used to be a
 * `before` hook too, and run here now, after the empty details are taken out, so every
 * change made to a registration is made in this one function, in the order read below.
 *
 * `handler` is Better Auth's, passed in so this can be tested without one. A body that is
 * not JSON goes through untouched, so the provider's own message for it is the one the
 * client gets.
 */
export async function registerClient(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const trimmed = withoutEmptyMetadata(body);
  // What was taken out, so a refusal still says whether empty metadata was part of it.
  const emptied = trimmed ? Object.keys(body as Record<string, unknown>).filter((k) => !(k in trimmed)) : [];
  const decision = loopbackRegistration(trimmed ?? body);
  const sent = decision?.kind === 'native' ? decision.body : (trimmed ?? body);
  const response =
    decision?.kind === 'refuse'
      ? Response.json(
          { error: 'invalid_redirect_uri', error_description: decision.message },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        )
      : await handler(new Request(request, { body: sent === body ? text : JSON.stringify(sent) }));
  // A 429 is this server's own rate limit, not the provider judging the client; logging
  // those would be ten lines a minute from anyone who cared to send them.
  if (response.status >= 400 && response.status !== 429) {
    const answer = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown; error_description?: unknown; message?: unknown } | null;
    console.warn(
      '[oauth] registration refused',
      JSON.stringify({
        status: response.status,
        error: answer?.error,
        reason: answer?.error_description ?? answer?.message,
        request: registrationSummary(sent),
        emptied: emptied.length > 0 ? emptied.sort().slice(0, 40) : undefined,
      }),
    );
  }
  return response;
}
