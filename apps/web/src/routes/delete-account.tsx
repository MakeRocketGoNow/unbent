import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { useState } from 'react';
import { Button } from '../components/Button.js';
import { deleteUser, refreshSession, signOut, useSession } from '../auth-client.js';
import { GOODBYE } from '../auth-gate.js';
import { forgetSession } from '../session-memory.js';

/**
 * Caught rather than rejected, the same as the reset page: a link that a mail client has
 * truncated or a person has retyped should explain itself instead of rendering an error.
 */
const search = z.object({
  token: z.string().trim().min(1).max(512).optional().catch(undefined),
});

export const Route = createFileRoute('/delete-account')({
  validateSearch: search,
  component: DeleteAccountPage,
});

/**
 * The confirmation the deletion mail asks for.
 *
 * This page exists so that opening the link is not itself the deletion. Better Auth will
 * delete on a bare GET of its own callback, and anything can fire a GET — a prefetch, a
 * scanner, a restored tab, a mistap. A request without cookies fails, which covers the
 * scanners, but webmail read in the browser that holds the session is exactly the case
 * cookies do not cover. So the link lands here and the destruction happens on a POST that
 * a person pressed, which is the arrangement `/reset-password` already has.
 *
 * Plain shell, so that opening the link in a browser without the session shows this
 * explanation instead of a sign-in redirect that loses the token from view. The session is
 * read to say so *before* the button is pressed rather than after: "wrong browser" is a
 * thing to find out while the link is still unspent.
 */
function DeleteAccountPage() {
  const { token } = Route.useSearch();
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      // The token turns this POST into the deletion; Better Auth spends it and runs the
      // R2 sweep on the way. Nothing before this point has touched the account.
      const res = await deleteUser({ token });
      if (res?.error) {
        setError(res.error.message || 'That link could not be used.');
        setBusy(false);
        return;
      }

      /*
       * Sign out of an account that no longer exists, which is less strange than it reads.
       * Better Auth answers this request by re-writing the session-cache cookie from the
       * session it resolved before deleting, so the browser leaves here holding a signed
       * five-minute claim to a user that is gone — and `/login` turns away anyone it
       * believes is signed in, which would bounce someone who just deleted their account
       * into an app with nothing behind it. The cookies are HttpOnly, so only the server
       * can clear them, and sign-out is what asks it to. Verified: it answers 200 after
       * the row is gone and expires every cookie.
       *
       * Best effort, though. The account is already deleted by this point, so a failure
       * here must not strand the page on a spinner — worst case the stale cookie expires
       * on its own in five minutes.
       */
      await signOut()
        .then(() => refreshSession())
        .catch(() => {});
      // Whatever sign-out managed, the account is gone: this device must not open offline
      // as someone who no longer exists (`session-memory.ts`).
      forgetSession();
      await navigate({ to: GOODBYE });
    } catch (err) {
      setError((err as Error).message || 'That link could not be used.');
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="login">
        <h1>Unbent</h1>
        <p className="bad">
          That link is missing its confirmation code. Deletion links work once and last a
          day; ask for a new one from Settings if this one has been used or has expired.
        </p>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="login">
        <h1>Unbent</h1>
        <p className="muted">Checking…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login">
        <h1>Unbent</h1>
        <p className="bad">
          You are not signed in here, so this link cannot confirm anything from this
          browser.
        </p>
        <p className="muted small">
          Open it in the browser you are signed in with. It has not been used, and it lasts
          a day.
        </p>
      </div>
    );
  }

  return (
    <div className="login">
      <h1>Unbent</h1>
      <p>
        Delete <span className="wrap-anywhere">{session.user.email}</span> and everything in
        it?
      </p>
      <p className="muted small">
        Every note, every attached file, every passkey and connected app. Nothing here has
        been deleted yet, and nothing will be until you press the button. There is no undo
        and no export afterwards.
      </p>
      <Button variant="primary" tone="danger" disabled={busy} onClick={() => void confirm()}>
        {busy ? 'Deleting…' : 'Delete my account'}
      </Button>
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}
