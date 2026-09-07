import { Hono } from 'hono';
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';
import { getAuth, mcpIssuer, mcpResource } from '../auth.js';
import type { AppEnv } from '../types.js';

/**
 * The OAuth discovery documents, served from the origin root.
 *
 * An MCP client starts by asking the *root* of the origin who issues tokens here — that is
 * how the specs are written, and it is not negotiable from our side. Better Auth serves
 * these too, but only under its own base path, because its router answers 404 for anything
 * outside /api/auth before a plugin's hook ever runs. So the documents are re-served here,
 * where the client actually looks.
 *
 * The paths with `/api/auth` and `/api/mcp` on the end are not decoration. When an
 * authorization server or a resource lives under a path rather than at a bare origin, the
 * discovery URL is built by inserting the well-known segment *before* that path, so
 * https://unbent.app/api/mcp is described at
 * /.well-known/oauth-protected-resource/api/mcp. Clients try that form first; the bare
 * form is served alongside it because some try only that.
 *
 * These are all public by necessity: a client reads them before it has any credential.
 *
 * wrangler.toml must route these paths to the Worker. Without that they are served by the
 * SPA fallback, which answers index.html with a 200 — a failure that looks like a client
 * bug rather than a routing one, because nothing errors.
 */
export const wellKnown = new Hono<AppEnv>()
  .get('/.well-known/oauth-authorization-server', (c) =>
    oauthProviderAuthServerMetadata(getAuth(c.env))(c.req.raw),
  )
  .get('/.well-known/oauth-authorization-server/api/auth', (c) =>
    oauthProviderAuthServerMetadata(getAuth(c.env))(c.req.raw),
  )
  .get('/.well-known/openid-configuration', (c) =>
    oauthProviderOpenIdConfigMetadata(getAuth(c.env))(c.req.raw),
  )
  .get('/.well-known/openid-configuration/api/auth', (c) =>
    oauthProviderOpenIdConfigMetadata(getAuth(c.env))(c.req.raw),
  )
  /**
   * The protected-resource document (RFC 9728), which says "this endpoint is guarded, and
   * here is who issues tokens for it". Built here rather than taken from the plugin: the
   * plugin serves its own copy from a request hook that, like everything else above, never
   * runs for a path outside the auth base path.
   *
   * Deliberately minimal. `scopes_supported` is omitted because this server has none to
   * advertise — consent grants access to the notes, and a client that asks for a scope is
   * told at the token endpoint rather than being invited to guess from here.
   */
  .get('/.well-known/oauth-protected-resource', (c) => resourceMetadata(c.env))
  .get('/.well-known/oauth-protected-resource/api/mcp', (c) => resourceMetadata(c.env));

function resourceMetadata(env: AppEnv['Bindings']): Response {
  return Response.json(
    {
      resource: mcpResource(env),
      authorization_servers: [mcpIssuer(env)],
      bearer_methods_supported: ['header'],
    },
    {
      // Matches what the plugin sets on its own metadata: this changes about never, and a
      // client reads it on every fresh connection.
      headers: { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=15' },
    },
  );
}
