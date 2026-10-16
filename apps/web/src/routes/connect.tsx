import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useState } from 'react';
import { Button } from '../components/Button.js';
import { mintConnectToken } from '../device-api.js';

/**
 * `redirect` is the app's deep link. Optional and `catch`-ed so a stray visit to /connect
 * renders an explanation rather than an error page.
 */
const search = z.object({
  redirect: z.string().trim().min(1).max(512).optional().catch(undefined),
});

export const Route = createFileRoute('/connect')({
  validateSearch: search,
  component: ConnectPage,
});

/**
 * Only ever hand a token to the app that asked for it.
 *
 * The redirect target arrives in a query string, which anything on the phone can write. A
 * malicious app could open this page with its own scheme and collect a session for these
 * notes. An allowlist of exact strings is what stops that; it is deliberately not a
 * "starts with" check, since `unbent://` also prefixes `unbent-evil://`.
 */
const ALLOWED_REDIRECTS = [
  'unbent://connect',
  // The debug build uses its own scheme, so a debug install sitting beside a release one
  // cannot capture the other's token.
  'unbent-debug://connect',
];

function isAllowed(redirect: string | undefined): redirect is string {
  return redirect !== undefined && ALLOWED_REDIRECTS.includes(redirect);
}

/**
 * Connects a phone, without the user reading a code out.
 *
 * The route guard gates on the session, so reaching this component means signed in, by
 * whichever provider, which is the point: Google, GitHub, and anything added later all
 * arrive here the same way. An unauthenticated visit is sent to `/login` and comes back
 * with the `redirect` still in the URL.
 *
 * The device-code flow at /device stays for the CLI, which has no browser to hand a
 * redirect back to.
 */
function ConnectPage() {
  const { redirect } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function connect() {
    if (!isAllowed(redirect)) return;
    setBusy(true);
    setError(null);
    try {
      const token = await mintConnectToken();
      setDone(true);
      // Hand the token back to the app. Assigning rather than routing: the destination is
      // an app scheme, not a route this SPA knows how to render.
      window.location.href = `${redirect}?token=${encodeURIComponent(token)}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect this device.');
      setBusy(false);
    }
  }

  if (!isAllowed(redirect)) {
    return (
      <div className="panel device-panel">
        <div className="panel-head">
          <h2>Connect a device</h2>
        </div>
        <p className="small muted">
          Open this page from the Unbent app on your phone. There is nothing to do here
          otherwise.
        </p>
      </div>
    );
  }

  return (
    <div className="panel device-panel">
      <div className="panel-head">
        <h2>Connect this phone</h2>
      </div>
      <p className="small muted">
        The Unbent app on this phone is asking to use your account, so it can save things
        you share to it. Connect it only if you just opened the app yourself.
      </p>
      <div className="device-actions">
        <Button variant="primary" onClick={() => void connect()} disabled={busy || done}>
          {done ? 'Connected' : busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
      {error && <p className="small bad">{error}</p>}
    </div>
  );
}
