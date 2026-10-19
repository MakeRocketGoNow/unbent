import { createResourceServerChallenge } from '@better-auth/oauth-provider';
import { verifyJwsAccessToken } from 'better-auth/oauth2';
import { getAuth, mcpIssuer, mcpResource } from '../auth.js';
import type { Env } from '../types.js';

/**
 * The claims this code reads off a verified token.
 *
 * The verifier hands back jose's `JWTPayload`, a wider structural type than anything here
 * needs. Declared locally rather than imported so the API does not take a direct dependency
 * on jose for one type used in one place, the same reasoning as `AuthInstance` in auth.ts.
 */
export interface AccessTokenClaims {
  sub?: unknown;
  scope?: unknown;
  client_id?: unknown;
  [claim: string]: unknown;
}

/**
 * Cache key for the signing keys, so they are read once per isolate rather than once per
 * tool call. The verifier caches against object identity, so this must be a stable module
 * constant: a fresh object per request would defeat it silently.
 */
const jwksCacheKey = {};

/**
 * Wraps an MCP request handler in the access-token check every call must pass.
 *
 * Two things are being checked, and only one of them is "is this signed by us". The other
 * is the audience: a token this same instance minted, for this same user, for a *different*
 * resource is valid and unexpired and must still be refused here. Binding to `mcpResource`
 * is what does that, and it is the check that stops a token leaking sideways between
 * servers a client has connected to.
 *
 * The keys are read through the auth instance rather than fetched over HTTP. The published
 * key set at /api/auth/jwks is the same material, and the packaged helpers reach it by URL,
 * which a Worker cannot do to itself. In local development that URL is the SPA's origin,
 * which is a Vite proxy that may not even be running; in production it is the Worker's own
 * hostname, and a Worker fetching itself is a request that leaves and has to come back. An
 * in-process call has neither problem and is faster than both.
 *
 * The cost of not using the packaged wrapper is that the challenge is built here. That is
 * `createResourceServerChallenge`, the same function it would have used, so an
 * unauthenticated caller still gets the RFC 9728 header pointing at the discovery document.
 */
export function protectMcp(
  env: Env,
  handler: (request: Request, claims: AccessTokenClaims) => Promise<Response>,
): (request: Request) => Promise<Response> {
  const resource = mcpResource(env);

  return async (request: Request) => {
    const authorization = request.headers.get('authorization') ?? '';
    const [scheme, token] = authorization.split(' ');

    try {
      if (!token || scheme?.toLowerCase() !== 'bearer') {
        throw new Error('missing authorization header');
      }
      const claims = (await verifyJwsAccessToken(token, {
        jwksFetch: () => getAuth(env).api.getJwks(),
        jwksCacheKey,
        verifyOptions: { issuer: await issuerFor(env, request), audience: resource },
      })) as AccessTokenClaims;

      if (!(await grantStillStands(env, claims))) {
        throw new Error('this application has been disconnected');
      }

      return await handler(request, claims);
    } catch (error) {
      return challenge(error, resource);
    }
  };
}

/**
 * The issuer to expect in a token, which is not necessarily the one this instance would
 * advertise today.
 *
 * Better Auth stamps `iss` from the base URL it resolved for the request that minted the
 * token. Deployed that is `APP_URL` and nothing moves. Locally it is whichever hostname the
 * Worker was reached on (localhost, a Tailscale name, the emulator's 10.0.2.2) because
 * `baseURLFor` deliberately trusts several, and the SPA's port is not the Worker's. Checking
 * against a guess therefore rejects perfectly good tokens in development, which is exactly
 * what happened: a token issued at :8802 measured against a :5202 expectation.
 *
 * So the value is read from the auth context, which is the same resolution the provider
 * performed when it signed the token. `mcpIssuer` remains the answer whenever that context
 * has a fixed base URL, and is the fallback here.
 */
async function issuerFor(env: Env, request: Request): Promise<string> {
  const { baseURL } = await getAuth(env).$context;
  if (baseURL) return baseURL;
  // A dynamic base URL leaves the context's value empty, so reconstruct it the way the
  // provider does: this request's own origin, plus the auth base path.
  const fallback = new URL(request.url).origin;
  return fallback ? `${fallback}/api/auth` : mcpIssuer(env);
}

/**
 * Whether the user still wants this application to have access.
 *
 * Signature checking alone cannot answer that. A token is valid for its whole lifetime by
 * construction, so someone who disconnects an assistant in Settings would otherwise keep
 * being read for up to an hour afterwards, and "disconnect" would mean "disconnect
 * shortly", which is not what the word promises or what the settings page says.
 *
 * So each call checks that the consent row is still there. That is one indexed lookup on
 * (clientId, userId), against the cost of the alternative: the user watching an app they
 * just revoked continue to work. Tokens with no client id are refused rather than waved
 * through, since a token that cannot be attributed cannot be revoked either.
 */
async function grantStillStands(env: Env, claims: AccessTokenClaims): Promise<boolean> {
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : null;
  const userId = typeof claims.sub === 'string' ? claims.sub : null;
  if (!clientId || !userId) return false;

  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM oauthConsent WHERE clientId = ?1 AND userId = ?2 LIMIT 1`,
  )
    .bind(clientId, userId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * The 401 an MCP client is waiting for.
 *
 * The `WWW-Authenticate` header is the whole point. It names the document that says who
 * issues tokens for this resource, which is how a client that has never seen this server
 * learns where to send the user; without it a client can only report that it was refused,
 * and connecting becomes impossible rather than merely manual.
 *
 * `createResourceServerChallenge` builds that header, but only for the typed errors Better
 * Auth's own verifier raises; handed anything else it returns undefined. Verification here
 * can also fail with a plain `Error` (a missing header, a malformed token), and an early
 * version of this function let those through with no header at all: a 401 that told the
 * client nothing. So the header is constructed directly when the packaged builder declines,
 * to the same RFC 9728 shape it would have produced.
 *
 * The body is a JSON-RPC error rather than a bare message because the caller is speaking
 * JSON-RPC and will try to parse whatever comes back.
 */
function challenge(error: unknown, resource: string): Response {
  const built = createResourceServerChallenge(error, resource);
  const message = built?.message ?? (error instanceof Error ? error.message : 'unauthorized');
  const headers = new Headers(built?.headers as HeadersInit | undefined);
  headers.set('Content-Type', 'application/json');
  if (!headers.has('WWW-Authenticate')) {
    headers.set(
      'WWW-Authenticate',
      `Bearer resource_metadata="${resourceMetadataUrl(resource)}"`,
    );
  }
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }),
    { status: built?.statusCode ?? 401, headers },
  );
}

/**
 * Where the protected-resource document for a resource lives (RFC 9728): the well-known
 * segment goes between the origin and the resource's own path, so a resource at
 * https://unbent.app/api/mcp is described at
 * https://unbent.app/.well-known/oauth-protected-resource/api/mcp. routes/well-known.ts
 * serves both that and the bare form.
 */
function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * The user a verified token belongs to.
 *
 * `sub` is the subject claim, which this provider sets to the user id. Read through a
 * function rather than inline so there is one place that knows that, and one place that
 * fails loudly if a token ever arrives without it: an unscoped repo is not something to
 * construct from `undefined`.
 */
export function userIdFrom(claims: AccessTokenClaims): string {
  const sub = claims.sub;
  if (typeof sub !== 'string' || !sub) {
    throw new Error('access token has no subject claim');
  }
  return sub;
}

/**
 * The OAuth client a verified token was issued to: which assistant is calling. Only the
 * feedback tool reads it, to say which assistant a report came from. A token without one
 * never gets this far (`grantStillStands` refuses it), so the throw is the same loud
 * failure as `userIdFrom`'s rather than a case to handle.
 */
export function clientIdFrom(claims: AccessTokenClaims): string {
  const clientId = claims.client_id;
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('access token has no client id');
  }
  return clientId;
}
