import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useEffect, useRef, useState } from 'react';
import { redeemPreviewToken } from '../device-api.js';
import { refreshSession } from '../auth-client.js';
import { LOGIN, takeRelayRedirect } from '../auth-gate.js';

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
 * A preview cannot sign in with Google: its hostname changes every PR, so no OAuth callback
 * can be registered for it. Instead its login screen sends the browser to the dev instance,
 * which signs in with Google and redirects back here with a one-time token. This redeems
 * that token for a session of the preview's own and then goes where any sign-in goes.
 *
 * Public (in `auth-gate.ts`'s `PUBLIC` set) because arriving here is precisely the moment
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
  // remount could fire this again, so it runs exactly once.
  const started = useRef(false);

  useEffect(() => {
    /**
     * Take the spent token out of the address bar before anything renders an error beside
     * it. It is burned either way by this point, but a one-time token has no business
     * sitting in history, in a referrer, or in whatever the user copies when they paste the
     * URL into a bug report.
     */
    const spend = () => navigate({ href: '/preview-signin', replace: true });

    if (!token || started.current) return;
    started.current = true;
    void (async () => {
      try {
        await redeemPreviewToken(token);
        // Confirm the redeem actually established a session before sending the browser at a
        // gated route. A 200 from verify that somehow left no cookie (a cookie the browser
        // refused, a store hiccup) would otherwise bounce off the guard on `/notes` back to
        // `/login`, a loop with nothing on screen explaining it. Better to say so here.
        const session = await refreshSession();
        if (!session) {
          await spend();
          setError('Signed in on the dev instance, but this preview did not receive a session.');
          return;
        }
        await navigate({ href: takeRelayRedirect(), replace: true });
      } catch (e) {
        await spend();
        setError(e instanceof Error ? e.message : 'Could not complete sign-in.');
      }
    })();
  }, [token, navigate]);

  // `!error` as well as `!token`: a failed redeem clears the token from the URL, and without
  // that second condition the very next render would fall into this branch and replace the
  // explanation with "there is nothing to do here".
  if (!token && !error) {
    return (
      <div className="panel device-panel">
        <div className="panel-head">
          <h2>Preview sign-in</h2>
        </div>
        <p className="small muted">
          This page finishes signing in to a preview. Start from the preview's own sign-in
          screen: there is nothing to do here directly.
        </p>
        <p className="small">
          <Link to={LOGIN}>Go to sign-in</Link>
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
        <>
          <p className="small bad">{error}</p>
          {/* A relay that failed is not the end of the road: a preview still offers a
              password and a code by mail, and a second try at the relay starts there too. */}
          <p className="small">
            <Link to={LOGIN}>Back to sign-in</Link>
          </p>
        </>
      ) : (
        <p className="small muted">Finishing sign-in from the dev instance.</p>
      )}
    </div>
  );
}
