import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useEffect, useState } from 'react';
import { redeemConnectToken } from '../device-api.js';

/**
 * `next` is where to land once the browser holds a session. Defaulted rather than required
 * so a handoff with no destination still ends somewhere useful.
 */
const search = z.object({
  token: z.string().trim().min(1).max(256).optional().catch(undefined),
  next: z.string().trim().max(512).optional().catch(undefined),
});

export const Route = createFileRoute('/handoff')({
  validateSearch: search,
  component: HandoffPage,
});

/** Only same-origin paths, so a crafted link cannot bounce a fresh session off-site. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/notes';
  return next;
}

/**
 * Signs the browser in on behalf of the native app.
 *
 * The app can sign in without a browser — Android's account sheet hands it a token
 * directly — but that leaves Chrome logged out, and the app's own window *is* Chrome. So
 * the user signed in successfully and then landed on a login page, which is the bug this
 * exists to fix.
 *
 * The app mints a one-time token from its session and opens this page with it; verifying
 * sets the session cookie in the browser. A GET-shaped entry point is required because a
 * navigation cannot POST.
 */
function HandoffPage() {
  const { token, next } = Route.useSearch();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!token) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    redeemConnectToken(token)
      .then(() => {
        if (cancelled) return;
        // Replace, so back does not return to a spent token.
        window.location.replace(safeNext(next));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, next, navigate]);

  if (failed) {
    return (
      <div className="panel device-panel">
        <div className="panel-head">
          <h2>Could not open your notes</h2>
        </div>
        <p className="small muted">
          That link has already been used or has expired. Open the app again.
        </p>
      </div>
    );
  }

  return (
    <div className="panel device-panel">
      <p className="small muted">Opening your notes…</p>
    </div>
  );
}
