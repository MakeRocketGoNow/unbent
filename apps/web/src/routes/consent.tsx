import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { FULL_GRANT, type AssistantGrant } from '@unbent/shared';
import { AssistantAccess } from '../components/AssistantAccess.js';
import { Button } from '../components/Button.js';
import { answerConsent, grantIsEmpty, grantSentence } from '../assistant-access.js';
import { oauth2 } from '../auth-client.js';
import { listAssistantGrants, saveAssistantGrant } from '../notes-api.js';
import { notebooksQuery } from '../queries.js';

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
 * Where someone decides whether an AI assistant may use their notes, and how much of
 * them.
 *
 * This is the only screen in the app that grants a *program* standing access, and the
 * consequence is unlike anything else here: not one action, but everything the grant
 * covers, for as long as it lasts. So it says that in words, names who is asking, and
 * gives refusing equal weight: no styling that makes Deny look like the mistake.
 *
 * It also asks what the program gets (MAK-264), because not every assistant is trusted
 * alike: which notebooks, and whether it may change anything. Here, before the first
 * token exists, and not only in Settings afterwards: a limit set after connecting is a
 * limit the assistant spent some minutes without. `AssistantAccess` is the two
 * questions; the sentence under them is what Allow then means, said back in full, so
 * what is agreed to is read once more in plain words before the press.
 *
 * It opens on everything, which is what connecting has always granted and what the
 * assistant most people connect should have. An app that was restricted before opens
 * on what it was given: the provider can bring someone back here for an app that is
 * already connected, and offering "everything" to it again would undo their choice with
 * one careless press.
 *
 * Allow saves the choice and then asks the provider to record the consent, in that
 * order. A saved choice grants nothing until there is a consent, so if the second half
 * fails nothing was given; the other order would connect the app first and restrict it
 * a moment later.
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
  const [grant, setGrant] = useState<AssistantGrant>(FULL_GRANT);
  // Whether what this app was given before has been read; Allow waits for it.
  const [ready, setReady] = useState(false);
  // Set by a press of Allow with nothing picked, and cleared by the next change.
  const [pickSome, setPickSome] = useState(false);
  const notebooks = useQuery(notebooksQuery());

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
    void listAssistantGrants()
      .then((grants) => {
        if (cancelled) return;
        const before = grants[clientId];
        if (before) setGrant(before);
        setReady(true);
      })
      .catch(() => {
        // Not known, which is not the same as nothing: say so, and leave the choice to
        // be made on the page. Whatever is allowed is saved over what was there.
        if (cancelled) return;
        setError('Could not check whether this app was given a limit before. What you choose below is what it gets.');
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function answer(accept: boolean) {
    if (accept && grantIsEmpty(grant)) {
      // Said on the press rather than by a faded button: a disabled Allow gives no
      // reason, and cannot be reached to hear one.
      setPickSome(true);
      return;
    }
    setBusy(true);
    setError(null);
    // The limits first, and the provider only if they saved: see `answerConsent`.
    const result = await answerConsent(accept, clientId!, grant, {
      save: saveAssistantGrant,
      consent: (yes) => oauth2.consent({ accept: yes }),
    });
    if ('error' in result) {
      setError(result.error);
      setBusy(false);
      return;
    }
    // Back to whatever asked for access, carrying either the grant or the refusal.
    // Assigning rather than routing, for the reason `/connect` does the same: the
    // destination belongs to the client and is not a route this SPA can render.
    window.location.href = result.url;
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

      <p>{who} is asking to use your Unbent account. Choose what it gets.</p>

      <AssistantAccess
        value={grant}
        onChange={(next) => {
          setGrant(next);
          setPickSome(false);
        }}
        notebooks={notebooks.data}
        disabled={busy}
        error={pickSome ? 'Pick at least one notebook, or choose All notebooks.' : null}
      />

      {/* What Allow means for the choices above, in full. Not a live region: it changes
          with every tick, and the picker says its own count as it goes. */}
      <p>{grantSentence(who, grant, notebooks.data?.notebooks ?? [])}</p>

      <p className="muted">
        It acts on its own after this, without asking again. You can change what it gets, or
        disconnect it, at any time in Settings, and anything it has already done stays done.
      </p>

      {scope && <p className="small muted">Requested: {scope}</p>}

      {error && <p className="bad">{error}</p>}

      <div className="device-actions">
        <Button variant="primary" disabled={busy || !ready} onClick={() => void answer(true)}>
          {busy ? 'One moment…' : 'Allow access'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void answer(false)}>
          Deny
        </Button>
      </div>
    </section>
  );
}
