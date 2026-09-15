import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import { Confirm } from '../components/Confirm.js';
import { CopyIcon } from '../components/icons.js';
import { oauth2 } from '../auth-client.js';

export const Route = createFileRoute('/settings/connected-apps')({
  component: ConnectedAppsPage,
});

interface Grant {
  id: string;
  clientId: string;
  name: string | null;
  grantedAt: string | null;
}

/**
 * The MCP server URL for this instance, with a button that copies it.
 *
 * The URL is built from the current origin rather than hardcoded, because the same page
 * serves unbent.app and every self-hosted instance — and a self-hosted user pasting a
 * production URL into Claude would get someone else's consent screen.
 */
function McpUrl() {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/api/mcp`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail in older browsers or non-https contexts; the URL is
      // still visible to select and copy by hand, so this is not worth an error message.
    }
  }

  return (
    <span className="mcp-url-wrap">
      <code className="mcp-url">{url}</code>
      <button
        type="button"
        className="mcp-copy"
        onClick={() => void copy()}
        aria-label="Copy URL"
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? '✓' : <CopyIcon />}
      </button>
    </span>
  );
}

/**
 * Every app that can act on this account, and the way to stop one.
 *
 * The consent screen is where access is granted, and a grant with no visible way back is a
 * trap: an assistant connected once keeps working forever, and the only record of it is a
 * row in a table the user cannot see. This page is the other half of that decision, and it
 * is the reason the consent screen can honestly say access can be withdrawn at any time.
 *
 * Revoking goes through `Confirm` like every destructive action here, naming the app, since
 * "Claude stopped working" is a confusing thing to discover later if the button was hit by
 * accident.
 */
function ConnectedAppsPage() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [confirming, setConfirming] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const result = await oauth2.getConsents();
      const rows = result.data ?? [];
      /**
       * The consent rows carry a client id and nothing readable, so each name is a second
       * request. Fetched together rather than in series, and a client that cannot be named
       * still gets a row — it can still be revoked, which is what the page is for.
       */
      const named = await Promise.all(
        rows.map(async (row): Promise<Grant> => {
          let name: string | null = null;
          try {
            const client = await oauth2.publicClient({ query: { client_id: row.clientId } });
            name = client.data?.client_name?.trim() || null;
          } catch {
            name = null;
          }
          return {
            id: row.id,
            clientId: row.clientId,
            name,
            grantedAt: row.createdAt ?? null,
          };
        }),
      );
      setGrants(named);
    } catch (err) {
      setError((err as Error).message || 'Could not load your connected apps.');
      setGrants([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke(grant: Grant) {
    setBusy(true);
    setError(null);
    try {
      /**
       * The app's own endpoint rather than the provider's `deleteConsent`, which only
       * removes the record that permission was given and leaves the app's tokens working.
       * See apps/api/src/lib/connected-apps.ts.
       */
      const res = await fetch(`/api/connected-apps/${encodeURIComponent(grant.id)}/disconnect`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError('Could not disconnect that app.');
      } else {
        setConfirming(null);
        await refresh();
      }
    } catch (err) {
      setError((err as Error).message || 'Could not disconnect that app.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel">
      <h2>Connected apps</h2>
      <p className="muted">
        Apps you have allowed to use your notes on your behalf — an AI assistant, for
        example. Each can read, create and change notes, and move them to the trash, until
        you disconnect it here.
      </p>

      <section className="settings-section">
        <h3>Connect an app</h3>
        <p className="muted">
          Unbent speaks{' '}
          <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">
            MCP
          </a>
          , so Claude, Cursor, ChatGPT and other assistants can work with your notes
          directly. Point the client at this server:
        </p>
        <p>
          <McpUrl />
        </p>
        <p className="muted small">
          The client will open a browser window to ask for permission. Once approved, it
          appears above and stays connected until you disconnect it here.
        </p>
      </section>

      {error && <p className="bad">{error}</p>}

      {grants === null ? (
        <p className="muted">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="muted">Nothing is connected.</p>
      ) : (
        <ul className="owned-list">
          {grants.map((grant) => (
            <li key={grant.id}>
              <span>{grant.name ?? 'Unnamed app'}</span>
              {grant.grantedAt && (
                <span className="muted small">
                  connected {new Date(grant.grantedAt).toLocaleDateString()}
                </span>
              )}
              <Button
                variant="quiet"
                tone="danger"
                size="small"
                disabled={busy}
                onClick={() => setConfirming(grant)}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}

      {confirming && (
        <Confirm
          label="Confirm disconnect app"
          question={<>Disconnect {confirming.name ?? 'this app'}?</>}
          detail="It loses access immediately and will have to be connected again to come back. Notes it has already created or changed are not affected."
          busy={busy}
          onCancel={() => setConfirming(null)}
          actions={[
            {
              label: 'Disconnect',
              busyLabel: 'Disconnecting…',
              tone: 'danger',
              onConfirm: () => revoke(confirming),
            },
          ]}
        />
      )}
    </section>
  );
}
