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
 * What the log says about a refused registration (MAK-224): enough to tell which rule
 * refused which kind of client, and nothing that names a person.
 *
 * The registration endpoint is unauthenticated and refusals were silent, so when an
 * assistant could not connect the only evidence was its own one-line message. This is the
 * request's shape — the fields it sent, how it wants to authenticate, which grants, which
 * redirect *hosts* — beside the provider's reason. Hosts and not whole redirects, because
 * a relay's path can carry a per-user id (Google's does); the client's name, because it
 * is the program's and is how the line is found.
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
    client_name: typeof metadata['client_name'] === 'string' ? metadata['client_name'].slice(0, 80) : undefined,
    fields: Object.keys(metadata).sort(),
    token_endpoint_auth_method: metadata['token_endpoint_auth_method'],
    application_type: metadata['application_type'],
    grant_types: metadata['grant_types'],
    scope: metadata['scope'],
    redirect_hosts: [...new Set(hosts)],
    redirect_count: uris.length,
  };
}
