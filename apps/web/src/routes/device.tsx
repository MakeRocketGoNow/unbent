import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import {
  approveDeviceCode,
  claimDeviceCode,
  denyDeviceCode,
  type DeviceCodeInfo,
} from '../device-api.js';

/**
 * `user_code` is optional so `/device` alone is a usable destination: a CLI can tell
 * someone to "open /device and type the code" without templating a URL, and it is what a
 * user lands on if they retype the address from memory. `catch` drops a malformed code
 * rather than erroring: the form below can always ask for it again.
 */
const search = z.object({
  user_code: z.string().trim().min(1).max(64).optional().catch(undefined),
});

export const Route = createFileRoute('/device')({
  validateSearch: search,
  component: DevicePage,
});

type Outcome = 'approved' | 'denied';

/**
 * Approves a device: the browser half of the CLI sign-in.
 *
 * The route guard already gates on the session, so reaching this component means signed
 * in; an unauthenticated visit is redirected to `/login` carrying this URL, code included,
 * and comes back here once there is a session. That is why the code lives in a search
 * param rather than component state: it has to survive a sign-in round trip.
 */
function DevicePage() {
  const { user_code } = Route.useSearch();
  const [code, setCode] = useState(user_code ?? '');
  const [info, setInfo] = useState<DeviceCodeInfo | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Claiming is what attaches this session to the code, so it must happen before approve
   * or deny will be accepted. Doing it on arrival means the user sees what they are being
   * asked to approve before they are asked to approve it.
   */
  const claim = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await claimDeviceCode(trimmed));
    } catch {
      // Deliberately not echoing the server's message: for a bad code it is a 400 with
      // wording aimed at the CLI, and "check the code" is the only useful action here.
      setInfo(null);
      setError('That code was not recognized. It may have expired — codes last 30 minutes.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (user_code) void claim(user_code);
  }, [user_code, claim]);

  async function decide(kind: Outcome) {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      await (kind === 'approved' ? approveDeviceCode : denyDeviceCode)(info.user_code);
      setOutcome(kind);
    } catch {
      setError(`Could not ${kind === 'approved' ? 'approve' : 'deny'} that code. It may have expired.`);
    } finally {
      setBusy(false);
    }
  }

  if (outcome) {
    return (
      <div className="panel device-panel">
        <div className="panel-head">
          <h2>{outcome === 'approved' ? 'Device connected' : 'Request denied'}</h2>
        </div>
        <p className="small muted">
          {outcome === 'approved'
            ? 'You can return to the terminal — it picks this up within a few seconds. Signing out everywhere also signs out this device.'
            : 'Nothing was granted. If you did not start this, no further action is needed.'}
        </p>
        {/* A way off this page. Without it the browser sits on /device?user_code=… after
            approving, and going back to the app later (or restoring the tab) reopens a
            code that is by then used or expired, which reads as sign-in dumping you on a
            broken page rather than as a stale URL. */}
        <Link to="/notes" className="link">
          Go to your notes
        </Link>
      </div>
    );
  }

  return (
    <div className="panel device-panel">
      <div className="panel-head">
        <h2>Connect a device</h2>
      </div>

      {info ? (
        <>
          <p className="small muted">
            {info.client_id ? <code>{info.client_id}</code> : 'A program'} is asking for
            access to your notes. Approve only if you started this yourself, just now.
          </p>
          {/* Shown back so the user can compare it against what their terminal printed,
              the one check that catches a code typed into the wrong window. */}
          <p className="device-code">{info.user_code}</p>
          <div className="device-actions">
            <Button variant="primary" disabled={busy} onClick={() => void decide('approved')}>
              Approve
            </Button>
            <Button variant="secondary" tone="danger" disabled={busy} onClick={() => void decide('denied')}>
              Deny
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">
            Enter the code shown in your terminal.
          </p>
          <form
            className="device-form"
            onSubmit={(e) => {
              e.preventDefault();
              void claim(code);
            }}
          >
            <input
              type="text"
              value={code}
              autoFocus
              // Codes are generated uppercase; accepting any case and normalizing beats
              // rejecting someone who typed what they saw in lowercase.
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD1234"
              aria-label="Device code"
              className="device-input"
            />
            <Button type="submit" variant="primary" disabled={busy || !code.trim()}>
              Continue
            </Button>
          </form>
        </>
      )}

      {error && <p className="small bad">{error}</p>}
    </div>
  );
}
