import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import type { Passkey } from '@better-auth/passkey';
import { passkey } from '../auth-client.js';

export const Route = createFileRoute('/settings/security')({
  component: SecurityPage,
});

/**
 * Where a passkey gets created, which is the only place it can be.
 *
 * Registration needs a session, so this cannot live on the sign-in screen: you sign in by
 * some other means once, add a passkey here, and every visit after that is a touch of a
 * sensor. That ordering is also what keeps recovery simple — the method that got you here
 * still works if the device holding the passkey is lost.
 *
 * Listing them matters as much as making them. A passkey is tied to one device, so anyone
 * who uses two accumulates entries, and without names and dates they are indistinguishable
 * — which makes the "revoke the one from the laptop I sold" case impossible to do safely.
 */
function SecurityPage() {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const result = await passkey.listUserPasskeys();
      setKeys(result?.data ?? []);
    } catch (err) {
      setError((err as Error).message || 'Could not load your passkeys.');
      setKeys([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  /**
   * The name is the device, since that is the only thing that distinguishes one of these
   * from another later. Defaulted rather than prompted for: the browser is already showing
   * its own dialog, and a second one before it would be a question asked at the wrong time.
   */
  async function add() {
    setBusy(true);
    setError(null);
    try {
      const result = await passkey.addPasskey({ name: defaultPasskeyName() });
      if (result?.error) {
        setError(result.error.message || 'Could not add that passkey.');
      } else {
        await refresh();
      }
    } catch (err) {
      // Dismissing the browser's dialog throws here, and is a choice rather than a fault.
      if (!isCancellation(err)) setError((err as Error).message || 'Could not add that passkey.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await passkey.deletePasskey({ id });
      await refresh();
    } catch (err) {
      setError((err as Error).message || 'Could not remove that passkey.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel">
      <h2>Passkeys</h2>
      <p className="muted">
        Sign in with your fingerprint, face, or screen lock instead of a password. A passkey
        stays on the device that made it, so add one on each device you use.
      </p>

      <Button variant="primary" disabled={busy} onClick={() => void add()}>
        {busy ? 'Waiting for your device…' : 'Add a passkey'}
      </Button>

      {error && <p className="bad">{error}</p>}

      {keys === null ? (
        <p className="muted">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="muted">No passkeys yet.</p>
      ) : (
        <ul className="owned-list">
          {keys.map((k) => (
            <li key={k.id}>
              <span>{k.name || 'Unnamed passkey'}</span>
              {k.createdAt && (
                <span className="muted small">added {k.createdAt.toLocaleDateString()}</span>
              )}
              <Button
                variant="quiet"
                size="small"
                disabled={busy}
                onClick={() => void remove(k.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A name that means something in the list later.
 *
 * The user agent is the only hint the page has about which device this is, and it is a
 * label rather than a security claim, so a rough read of it is fine. Anything unrecognised
 * falls back to the date, which still beats a list of identical rows.
 */
function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone or iPad';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return `Passkey added ${new Date().toLocaleDateString()}`;
}

/** Dismissing the browser's passkey dialog, which is not an error worth showing. */
function isCancellation(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}
