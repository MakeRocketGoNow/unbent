import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useEffect } from 'react';

/**
 * The preview origin to come back to, carried through the sign-in round trip. Bounded and
 * `catch`-ed so a stray visit renders an explanation rather than an error page; the value
 * itself is not trusted here at all — the API validates it against
 * `isTrustedPreviewOrigin` before a token is ever minted for it.
 */
const search = z.object({
  return: z.string().trim().min(1).max(2048).optional().catch(undefined),
});

export const Route = createFileRoute('/preview-relay')({
  validateSearch: search,
  component: PreviewRelayPage,
});

/**
 * The dev instance's front door for the preview sign-in relay.
 *
 * The relay's whole reason for existing is someone who cannot sign in with Google on a
 * preview, and the common case is that they have no session on the dev instance either.
 * Sending them straight at `/api/preview-relay/start` answered that with `requireAuth`'s
 * JSON 401 — a raw error body on dev.unbent.app, on the one path the feature exists for.
 * It worked only for whoever still had a warm dev cookie.
 *
 * So the browser lands on a *route* first. This one is deliberately absent from
 * `auth-gate.ts`'s `PUBLIC` set, which is what does the work: the root guard sends a
 * signed-out visitor through `/login` (where Google is configured) and `returnTo` brings
 * them back here with `?return=` intact, because it preserves the query for every path but
 * `/device`. By the time this component renders there is a session, and handing off to the
 * API endpoint is all that is left.
 *
 * `location.replace` rather than the router: the destination is an API path that mints a
 * token and 302s to another origin, not a route this SPA can render. `replace` so Back
 * leaves rather than re-firing a handoff whose token is already spent — the same reasoning
 * `/connect` applies when it assigns an app scheme.
 */
function PreviewRelayPage() {
  const { return: origin } = Route.useSearch();

  useEffect(() => {
    if (!origin) return;
    window.location.replace(`/api/preview-relay/start?return=${encodeURIComponent(origin)}`);
  }, [origin]);

  return (
    <div className="panel device-panel">
      <div className="panel-head">
        <h2>Preview sign-in</h2>
      </div>
      <p className="small muted">
        {origin
          ? 'Taking you back to the preview…'
          : "This page hands a preview a sign-in from here. Start from the preview's own sign-in screen — there is nothing to do here directly."}
      </p>
    </div>
  );
}
