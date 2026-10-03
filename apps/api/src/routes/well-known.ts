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
  .get('/.well-known/oauth-protected-resource/api/mcp', (c) => resourceMetadata(c.env))
  /**
   * The Digital Asset Links document: which Android apps this origin vouches for.
   *
   * Android reads it for two things. App Links, so that a link to this site opens in the
   * app; and passkeys, because Credential Manager will only offer a credential for a
   * domain to an app that domain has declared. It used to be a static file in the web
   * app, which meant every fork served unbent.app's package and signing keys from its own
   * domain — a claim about somebody else's app — while its own app got nothing.
   *
   * So it is per deployment now, from `ANDROID_ASSET_LINKS`, the same way the operator's
   * name is: unset means this instance vouches for no app, and the response is a 404 that
   * Android treats as exactly that. The value is the document verbatim, a JSON array of
   * statements; see the README's Android section for where the fingerprints come from.
   */
  .get('/.well-known/assetlinks.json', (c) => {
    const raw = c.env.ANDROID_ASSET_LINKS?.trim();
    if (!raw) return c.json({ error: 'Not found' }, 404);
    let statements: unknown;
    try {
      statements = JSON.parse(raw);
    } catch {
      statements = undefined;
    }
    if (!Array.isArray(statements)) {
      // Loud, because the symptom on a phone is "passkeys stopped being offered", which is
      // nowhere near the secret that caused it.
      console.error('[well-known] ANDROID_ASSET_LINKS is not a JSON array of statements');
      return c.json({ error: 'ANDROID_ASSET_LINKS is not valid JSON' }, 500);
    }
    return c.json(statements, 200, {
      // Google fetches it on demand and caches on its side; an hour keeps a corrected
      // value from waiting a day while costing nothing on a document this small.
      'Cache-Control': 'public, max-age=3600',
    });
  })
  /**
   * The Apple App Site Association document: the iOS counterpart of the one above, for the
   * same two things — universal links, and passkeys offered to the app through
   * `webcredentials` — and per deployment from `APPLE_APP_SITE_ASSOCIATION` for the same
   * reason, since its app ids carry a team id that is one developer's.
   *
   * Apple's document is a JSON *object* where Android's is an array, so that is what is
   * checked. The path has no extension and Apple requires `application/json` regardless,
   * which `c.json` sets. Apple's CDN fetches it, not the phone, and caches it on its side;
   * see the README's iOS section for the shape.
   */
  .get('/.well-known/apple-app-site-association', (c) => {
    const raw = c.env.APPLE_APP_SITE_ASSOCIATION?.trim();
    if (!raw) return c.json({ error: 'Not found' }, 404);
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      doc = undefined;
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      // Loud for the same reason as Android's: the symptom is a link opening in Safari or
      // a passkey not offered, nowhere near the secret.
      console.error('[well-known] APPLE_APP_SITE_ASSOCIATION is not a JSON object');
      return c.json({ error: 'APPLE_APP_SITE_ASSOCIATION is not valid JSON' }, 500);
    }
    return c.json(doc, 200, { 'Cache-Control': 'public, max-age=3600' });
  });

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
