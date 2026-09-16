import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useEffect, useRef, useState } from 'react';
import { redeemPreviewToken } from '../device-api.js';
import { refreshSession } from '../auth-client.js';
import { HOME } from '../auth-gate.js';

/**
 * The token the dev instance minted, carried back in the URL. Bounded and optional so a
 * stray visit renders an explanation rather than throwing; a one-time token is 32 chars,
 * and anything absent or malformed drops to the "nothing to do here" state.
 */
const search = z.object({
  token: z.string().trim().min(1).max(128).optional().catch(undefined),
});

export const Route = createFileRoute('/preview-signin')({
  validateSearch: search,
  component: PreviewSignInPage,
});

/**
 * The preview's landing point for the sign-in relay.
 *
 * A preview cannot sign in with Google — its hostname changes every PR, so no OAuth callback
 * can be registered for it. Instead its login screen sends the browser to the dev instance,
 * which signs in with Google and redirects back here with a one-time token. This redeems
 * that token for a session of the preview's own and then goes where any sign-in goes.
 *
 * Public — in `auth-gate.ts`'s `PUBLIC` set — because arriving here is precisely the moment
 * before there is a session: gating it would bounce the token to `/login` and strand it. It
 * redeems on mount rather than behind a button because there is nothing for the user to
 * decide; the decision was signing in on the dev instance, and this is the continuation of
 * it. The `landed` pattern mirrors the login screen: refetch the session before navigating,
 * so the guard on `/notes` reads the cookie that verify just set rather than the empty one
 * from before.
 */
function PreviewSignInPage() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // A one-time token is burned on first use, so redeeming twice fails the second time. In
  // development React's StrictMode mounts effects twice, and even in production a fast
  // remount could fire this again — so it runs exactly once.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void (async () => {
      try {
        await redeemPreviewToken(token);
        await refreshSession();
        await navigate({ href: HOME, replace: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not complete sign-in.');
      }
    })();
  }, [token, navigate]);

  if (!token) {
    return (
      <div className="panel device-panel">
        <div className="panel-head">
          <h2>Preview sign-in</h2>
        </div>
        <p className="small muted">
          This page finishes signing in to a preview. Start from the preview's own sign-in
          screen — there is nothing to do here directly.
        </p>
      </div>
    );
  }

  return (
    <div className="panel device-panel">
      <div className="panel-head">
        <h2>{error ? 'Preview sign-in' : 'Signing you in…'}</h2>
      </div>
      {error ? (
        <p className="small bad">{error}</p>
      ) : (
        <p className="small muted">Finishing sign-in from the dev instance.</p>
      )}
    </div>
  );
}
