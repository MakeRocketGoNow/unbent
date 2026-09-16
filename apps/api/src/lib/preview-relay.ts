import type { Env } from '../types.js';

/**
 * The preview sign-in relay: how a per-PR preview borrows a session from the dev instance.
 *
 * A preview lives at `https://unbent-pr-<N>.<subdomain>.workers.dev`, a hostname that
 * changes every PR and so can never have an OAuth callback registered against it — the same
 * wall `wrangler.toml` documents around why `dev.unbent.app` exists at all. The relay works
 * around it without registering anything per preview: the preview sends the browser to the
 * dev instance, which *can* sign in with Google, and the dev instance mints a one-time token
 * (the same `oneTimeToken()` mechanism the Android `/connect` flow uses) and redirects back.
 * The preview redeems the token for its own host-only session cookie.
 *
 * Two env vars turn it on, and both name origins rather than being booleans, because the
 * relay is a cross-origin handoff and each side has to know the other's exact address:
 *
 *   PREVIEW_RELAY_ORIGIN     the dev instance a preview bounces to, e.g. https://dev.unbent.app.
 *                            Set on the *preview* env so its login screen knows where to send
 *                            people. Absent means the preview offers no relay button.
 *
 *   PREVIEW_RELAY_SUBDOMAIN  the account's workers.dev subdomain, e.g. of2668. Set on the
 *                            *dev* env so `/api/preview-relay/start` can recognise a
 *                            legitimate preview host to hand a token to. Absent means the
 *                            dev instance relays to nothing.
 *
 * The subdomain is configured rather than inferred precisely because this is a security
 * boundary: the token minted here grants a session, so the host it is handed to must be one
 * we know is ours. Anyone can register their own `*.workers.dev` account, so "ends in
 * workers.dev" is not enough — it has to be *our* subdomain, which only configuration knows.
 */

/**
 * Whether this instance is a relay *source* — the dev instance that mints tokens for
 * previews. True only where `PREVIEW_RELAY_SUBDOMAIN` is set, which is the dev deploy alone:
 * production sets neither relay variable, and a preview sets only `PREVIEW_RELAY_ORIGIN`.
 *
 * This is the switch the `/api/preview-relay/*` route is gated on. Where it is false the
 * route answers 404, so the endpoint does not exist on production rather than existing and
 * refusing every request — the same "off means off, not hidden" line the auth plugins draw,
 * and what keeps `config.test.ts`'s "advertisement and endpoints agree" reading true.
 *
 * It is exactly the same condition `isTrustedPreviewOrigin` short-circuits on, named once so
 * the mount gate and the trust check cannot drift apart.
 */
export function previewRelayEnabled(env: Env): boolean {
  return Boolean(env.PREVIEW_RELAY_SUBDOMAIN?.trim());
}

/**
 * The dev instance a preview's login screen bounces to, or undefined if this instance
 * offers no relay. Read into `/api/config` so the SPA draws the button only where it works,
 * the same "absent means not offered" contract the rest of the config uses.
 *
 * Normalised to a bare origin (no trailing slash, no path) so it can be compared and have
 * a path appended without worrying about how it was written.
 */
export function previewRelayOrigin(env: Env): string | undefined {
  const raw = env.PREVIEW_RELAY_ORIGIN?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    // A misconfigured value is treated as none rather than crashing the config route: a
    // login screen with no relay button is a better failure than a login screen that 500s.
    return undefined;
  }
}

/**
 * Whether `origin` is a preview host this dev instance may hand a session token to.
 *
 * This is the load-bearing check of the whole relay. `/api/preview-relay/start` mints a
 * one-time token against the caller's dev session and redirects it to `origin`; a lax check
 * would let any site that could get a signed-in user to click a link collect that token and
 * with it a session. So the rules are deliberately strict and exact, the same lesson the
 * Android `/connect` route's `ALLOWED_REDIRECTS` learned — an exact match, never a prefix,
 * because `unbent-pr-1` is a prefix of `unbent-pr-1-evil`.
 *
 *   - The scheme must be exactly `https:`. A token over http is a token in the clear.
 *   - The host must be exactly `unbent-pr-<digits>.<our subdomain>.workers.dev`. The digits
 *     are a real PR number, so `\d+` and nothing else — no dots, no dashes, nothing that
 *     could smuggle another label in. `<our subdomain>` comes from configuration, not from
 *     the URL, so an attacker's own workers.dev account does not match.
 *   - There must be no userinfo, and the port must be the default. `https://a@evil/` and
 *     `https://host:1234/` are both ways to make a host look like ours without being it.
 *
 * The dev instance's own origin is intentionally *not* accepted here: a relay to itself is
 * not a preview sign-in, and keeping the two apart means this function has exactly one job.
 */
export function isTrustedPreviewOrigin(env: Env, origin: string): boolean {
  // Lowercased because the comparison below is against `URL.hostname`, which the URL parser
  // has already lowercased. workers.dev subdomains are lowercase to begin with, so this only
  // ever rescues a config typo — an operator who set `Of2668` would otherwise have every
  // legitimate preview silently rejected, with nothing pointing at the capitalization.
  const subdomain = env.PREVIEW_RELAY_SUBDOMAIN?.trim().toLowerCase();
  if (!subdomain) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  // A bare origin has none of these; their presence means the string is dressed up to read
  // like our host while pointing somewhere else.
  if (url.username || url.password || url.port || url.search || url.hash) return false;
  // `new URL('https://host/path').pathname` is '/', never empty — anything longer is a path
  // smuggled into what should be an origin.
  if (url.pathname !== '/') return false;

  const expected = new RegExp(
    `^unbent-pr-\\d+\\.${escapeRegExp(subdomain)}\\.workers\\.dev$`,
  );
  return expected.test(url.hostname);
}

/** Escape a configured value before putting it in a RegExp, so a dot in it stays a dot. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
