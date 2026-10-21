import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import { Confirm } from '../components/Confirm.js';
import { CopiedIcon, CopyIcon } from '../components/icons.js';
import { oauth2 } from '../auth-client.js';
import { mcpSetupPrompt } from '../mcp-setup-prompt.js';
import { request } from '../notes-api.js';

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
 * serves unbent.app and every self-hosted instance, and a self-hosted user pasting a
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
        data-tip={copied ? 'Copied' : 'Copy'}
      >
        {copied ? '✓' : <CopyIcon />}
      </button>
    </span>
  );
}

/**
 * Copies `mcpSetupPrompt` for this instance, for a person whose assistant is a coding
 * agent that can edit its own config.
 *
 * A labelled button rather than a second icon beside the URL: two copy glyphs side by
 * side would leave the person guessing which copies what. The label holds its width while
 * it reads "Copied" (both words share one grid cell and only one is visible), so the
 * confirmation does not shift what sits beside it. The live region says it for a screen
 * reader, which does not reliably announce a button's own label changing.
 */
function CopySetupPrompt() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(mcpSetupPrompt(`${window.location.origin}/api/mcp`));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // As in `McpUrl`: the URL is on screen to copy by hand.
    }
  }

  return (
    <>
      <Button onClick={() => void copy()}>
        {copied ? <CopiedIcon /> : <CopyIcon />}
        <span className="copy-label">
          <span aria-hidden={copied}>Copy setup prompt</span>
          <span aria-hidden={!copied}>Copied</span>
        </span>
      </Button>
      <span className="visually-hidden" role="status">
        {copied ? 'Setup prompt copied' : ''}
      </span>
    </>
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
 *
 * Called "AI assistants" in the settings tabs, though the route is still `connected-apps`
 * so older links keep working. "Connected apps" read as account sign-ins or integrations,
 * and nothing about it said this was where Claude goes. "MCP" was considered and rejected:
 * it names the protocol, which only people who already know it would look under, while a
 * person who wants Claude in their notes looks for the word AI. Every client that connects
 * in practice is an assistant; the intro still says "and other apps" for the one that is
 * not.
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
       * still gets a row: it can still be revoked, which is what the page is for.
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
      setError((err as Error).message || 'Could not load your connected assistants.');
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
      // Through `request`, so a disconnect tried with no connection says so at once.
      const res = await request(`/api/connected-apps/${encodeURIComponent(grant.id)}/disconnect`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError('Could not disconnect that assistant.');
      } else {
        setConfirming(null);
        await refresh();
      }
    } catch (err) {
      setError((err as Error).message || 'Could not disconnect that assistant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>AI assistants</h2>
      </div>
      <p className="muted small">
        Assistants and other apps you have allowed to use your notes on your behalf. Each
        can read, create and change notes, and move them to the trash, until you disconnect
        it here.
      </p>

      <section className="settings-section">
        <h3>Connect an assistant</h3>
        <p className="muted small">
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
          Using a coding agent like Claude Code, Codex or Cursor? Paste it this prompt and
          it adds the server itself.
        </p>
        <p>
          <CopySetupPrompt />
        </p>
        <p className="muted small">
          Either way, the client will open a browser window to ask for permission. Once
          approved, it appears below and stays connected until you disconnect it here.
        </p>
      </section>

      {error && <p className="bad small">{error}</p>}

      {grants === null ? (
        <p className="muted small">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="muted small">Nothing is connected.</p>
      ) : (
        <ul className="owned-list">
          {grants.map((grant) => (
            <li key={grant.id}>
              <span>{grant.name ?? 'Unnamed assistant'}</span>
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
          label="Confirm disconnect assistant"
          question={<>Disconnect {confirming.name ?? 'this assistant'}?</>}
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
