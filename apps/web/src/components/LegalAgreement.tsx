import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AppConfig } from '@unbent/shared';
import { refreshSession } from '../auth-client.js';
import { agreeToLegal, isStatus } from '../notes-api.js';
import { keys } from '../queries.js';
import { Button } from './Button.js';
import { LegalLink } from './LegalLink.js';

/**
 * Pages that stay open to an account that has not agreed (MAK-209): what the terms promise
 * someone who does not agree to them. "If you do not, delete your account" is the terms'
 * own answer to a change, and taking an export first is the advice everywhere else in the
 * app; an account that existed before an update holds notes its owner must be able to
 * take with them without agreeing to anything new.
 */
export const OPEN_WITHOUT_AGREEMENT: ReadonlySet<string> = new Set([
  '/settings/export',
  '/settings/maintenance',
]);

/** Whether the signed-in app should ask for an agreement before showing `pathname`. */
export function needsAgreement(
  legal: AppConfig['legal'] | undefined,
  agreed: string | null | undefined,
  pathname: string,
): boolean {
  if (!legal?.version) return false;
  if (OPEN_WITHOUT_AGREEMENT.has(pathname.replace(/\/$/, ''))) return false;
  return agreed !== legal.version;
}

/** What the signed-in shell draws, as far as the agreement decides it. See `agreementGate`. */
export type AgreementGate =
  | { kind: 'open' }
  | { kind: 'wait' }
  | { kind: 'ask'; legal: NonNullable<AppConfig['legal']> & { version: string } };

/**
 * What the signed-in shell draws, as far as the agreement decides it: the app, the
 * agreement in its place, or nothing yet.
 *
 * - **Never asked without the server.** A session remembered for offline use does not
 *   carry the version, and asking someone with no connection to agree to something the
 *   server cannot record would lock them out of their notes. So an unreachable session
 *   opens the app at once, without waiting on a config fetch that cannot answer either.
 * - **Wait for the config**, so the app is not drawn and then replaced by the agreement.
 * - **A config that could not be fetched opens the app**, as the remembered session does.
 *
 * Pure, and here rather than in `AppShell`, so these three rules are tested by name: a
 * regression in any of them either locks people out offline or lets the app through
 * without asking.
 */
export function agreementGate(opts: {
  unreachable: boolean;
  config: { isPending: boolean; data?: AppConfig };
  agreed: string | null | undefined;
  pathname: string;
}): AgreementGate {
  if (opts.unreachable) return { kind: 'open' };
  if (opts.config.isPending) return { kind: 'wait' };
  const legal = opts.config.data?.legal;
  if (!legal?.version || !needsAgreement(legal, opts.agreed, opts.pathname)) return { kind: 'open' };
  return { kind: 'ask', legal: { ...legal, version: legal.version } };
}

/**
 * The agreement to the terms and privacy policy, asked for in place of the app (MAK-209).
 *
 * After sign-in rather than on the sign-in screen, because signing in and signing up are
 * the same press here: a code by email, Google or a passkey makes the account if there is
 * none. A box to tick on that screen would ask everyone who returns, on every device,
 * forever, and still record nothing. Asked here, it is asked once per version, the answer
 * is kept with the account, and the Android and iOS apps get it for free, since past
 * their native sign-in screens they are this site.
 *
 * Its own press, "Agree and continue", with both documents linked above it. Not a "by
 * continuing you agree" line, which the sign-in screen used to carry and now gives only as
 * notice: an agreement someone can be held to is one they visibly made, to documents they
 * were shown.
 *
 * The same screen says when the documents have changed since someone agreed, with what
 * changed if the instance says (`LEGAL_CHANGE`). It always offers a way out — signing out,
 * or taking an export and deleting the account — because asking someone to agree with no
 * alternative is not asking.
 */
export function LegalAgreement({
  legal,
  agreed,
  onSignOut,
}: {
  legal: NonNullable<AppConfig['legal']> & { version: string };
  /** The version this account agreed to before, if any. */
  agreed: string | null | undefined;
  onSignOut: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updated = Boolean(agreed);

  const agree = async () => {
    setBusy(true);
    setError(null);
    try {
      await agreeToLegal(legal.version);
      // The answer replaced the session cookie; reading the session again is what lets
      // the app through. Busy until then, so the button cannot be pressed twice.
      await refreshSession();
    } catch (err) {
      if (isStatus(err, 409)) {
        // The documents changed under this page. Reloading the config shows the new
        // version, and this screen draws again around it, with nothing recorded.
        await queryClient.invalidateQueries({ queryKey: keys.config() });
        setError('The terms changed while this page was open. Please read them again.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not record your agreement.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h1>Unbent</h1>
      {updated ? (
        <>
          <h2>We’ve updated our terms</h2>
          <p>
            The <LegalLink href={legal.terms}>Terms of Service</LegalLink> and{' '}
            <LegalLink href={legal.privacy}>Privacy Policy</LegalLink> have changed since you
            last agreed to them. Please read them, and agree to keep using Unbent.
          </p>
          {legal.change && <p className="muted">{legal.change}</p>}
        </>
      ) : (
        <>
          <h2>Before you start</h2>
          <p>
            Please read the <LegalLink href={legal.terms}>Terms of Service</LegalLink> and the{' '}
            <LegalLink href={legal.privacy}>Privacy Policy</LegalLink>, and agree to them to use
            Unbent.
          </p>
          <p className="muted">
            The short version: your notes are yours, nothing is sold or used for advertising,
            and you can export or delete everything at any time.
          </p>
        </>
      )}

      <div className="login-actions">
        <Button variant="primary" size="large" disabled={busy} onClick={() => void agree()}>
          {busy ? 'Saving…' : 'Agree and continue'}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onSignOut}>
          Sign out
        </Button>
      </div>

      {error && <p className="bad" role="alert">{error}</p>}

      <p className="login-legal">
        Don’t agree? You can still <Link to="/settings/export">export your notes</Link> and{' '}
        <Link to="/settings/maintenance">delete your account</Link>.
      </p>
    </div>
  );
}
