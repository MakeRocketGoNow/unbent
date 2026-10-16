import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/Button.js';
import { oauth2 } from '../auth-client.js';

/**
 * The authorization query, passed through rather than read.
 *
 * The provider redirects here with the whole OAuth request in the URL (client id, scopes,
 * redirect target, and a signature over all of it) and expects to get it back when the
 * user answers. `looseObject` keeps every parameter, including the ones this screen never
 * looks at, because dropping one would break the signature and fail the authorization.
 *
 * The client plugin is what actually returns them: it reads the current location and
 * attaches the signed query to the consent call. So this schema exists to preserve the
 * params through routing, not to feed them to the request by hand.
 */
const search = z.looseObject({
  client_id: z.string().optional(),
  scope: z.string().optional(),
});

export const Route = createFileRoute('/consent')({
  validateSearch: search,
  component: ConsentPage,
});

/**
 * Where someone decides whether an AI assistant may read and write their notes.
 *
 * This is the only screen in the app that grants a *program* standing access, and the
 * consequence is unlike anything else here: not one action, but everything the person could
 * do, for as long as the grant lasts. So it says that in words, names who is asking, and
 * gives refusing equal weight: no pre-selected Allow, no styling that makes Deny look like
 * the mistake.
 *
 * It is behind the session gate like any other app route, which is what makes the
 * sign-in-then-consent order work: an unauthenticated visit bounces to /login carrying this
 * URL, and comes back with the query intact.
 */
function ConsentPage() {
  const { client_id: clientId, scope } = Route.useSearch();
  const [clientName, setClientName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void oauth2
      .publicClient({ query: { client_id: clientId } })
      .then((result) => {
        if (!cancelled) setClientName(result.data?.client_name?.trim() || null);
      })
      .catch(() => {
        // A client that cannot be named is still a client that can be approved or refused.
        // The screen falls back to saying "an application" rather than blocking on this.
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function answer(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await oauth2.consent({ accept });
      if (result.error) {
        setError(result.error.message || 'That did not work. Try connecting again.');
        setBusy(false);
        return;
      }
      // The provider answers with where the browser goes next: back to whatever asked for
      // access, carrying either the grant or the refusal. Assigning rather than routing,
      // for the reason `/connect` does the same: the destination belongs to the client and
      // is not a route this SPA can render.
      const next = result.data?.url;
      if (next) {
        window.location.href = next;
        return;
      }
      setError('The sign-in service did not say where to go next.');
      setBusy(false);
    } catch (err) {
      setError((err as Error).message || 'That did not work. Try connecting again.');
      setBusy(false);
    }
  }

  if (!clientId) {
    return (
      <section className="settings-panel">
        <h2>Nothing to connect</h2>
        <p className="muted">
          This page is where you approve an app that asked for access to your notes. Open it
          from the app itself rather than directly.
        </p>
      </section>
    );
  }

  const who = clientName ?? 'An application';

  return (
    <section className="settings-panel">
      <h2>Connect {clientName ?? 'an application'}?</h2>

      <p>
        {who} is asking to use your Unbent account. If you allow it, it will be able to read
        every note you have, create new ones, change existing ones, and move notes to the
        trash — the same things you can do.
      </p>

      <p className="muted">
        It acts on its own after this, without asking again. You can disconnect it at any
        time in Settings, and anything it has already done stays done.
      </p>

      {scope && <p className="small muted">Requested: {scope}</p>}

      {error && <p className="bad">{error}</p>}

      <div className="device-actions">
        <Button variant="primary" disabled={busy} onClick={() => void answer(true)}>
          {busy ? 'One moment…' : 'Allow access'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void answer(false)}>
          Deny
        </Button>
      </div>
    </section>
  );
}
