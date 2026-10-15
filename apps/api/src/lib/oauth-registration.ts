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
 * Absent is the meaning every one of these values has, and absent is what the provider
 * fills its defaults in for, so this changes no decision it makes: an empty
 * `redirect_uris` taken out is still refused as missing, and an empty `scope` gets the
 * same default scopes an omitted one does. Only the top level is touched; a non-empty
 * value is passed through exactly as sent, for the provider's own checks.
 *
 * Returns null when there was nothing to take out, so the hook leaves the body alone.
 */
export function withoutEmptyMetadata(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const entries = Object.entries(body as Record<string, unknown>);
  const kept = entries.filter(([, v]) => !(v === null || v === '' || (Array.isArray(v) && v.length === 0)));
  return kept.length === entries.length ? null : Object.fromEntries(kept);
}

/**
 * What the log says about a refused registration (MAK-224): enough to tell which rule
 * refused which kind of client, and nothing that names a person.
 *
 * The registration endpoint is unauthenticated and refusals were silent, so when an
 * assistant could not connect the only evidence was its own one-line message. This is the
 * request's shape — the fields it sent, how it wants to authenticate, which grants, which
 * redirect *hosts* — beside the provider's reason. Hosts and not whole redirects, because
 * a relay's path can carry a per-user id (Google's does); the client's name, because it
 * is the program's and is how the line is found.
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
