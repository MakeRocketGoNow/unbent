import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { FULL_GRANT, type AssistantGrant } from '@unbent/shared';
import { AssistantAccess } from '../components/AssistantAccess.js';
import { Button } from '../components/Button.js';
import { Confirm } from '../components/Confirm.js';
import { SOURCE_URL } from '../components/FrontPage.js';
import { CopiedIcon, CopyIcon } from '../components/icons.js';
import { McpUrl, mcpUrl } from '../components/McpUrl.js';
import { oauth2 } from '../auth-client.js';
import { chatgptInstructions } from '../chatgpt-instructions.js';
import { claudeInstructions } from '../claude-instructions.js';
import { claudeProjectInstructions } from '../claude-project-instructions.js';
import { mcpSetupPrompt } from '../mcp-setup-prompt.js';
import { grantIsEmpty, grantSummary, PICK_SOME_MESSAGE } from '../assistant-access.js';
import { listAssistantGrants, request, saveAssistantGrant } from '../notes-api.js';
import { notebookFieldsQuery, notebooksQuery } from '../queries.js';
import type { InstructionNotebook } from '../standing-instructions.js';

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
 * A labelled button that copies a text built when it is pressed.
 *
 * A labelled button rather than a second icon beside the URL: two copy glyphs side by
 * side would leave the person guessing which copies what. The label holds its width while
 * it reads "Copied" (both words share one grid cell and only one is visible), so the
 * confirmation does not shift what sits beside it. The live region says it for a screen
 * reader, which does not reliably announce a button's own label changing.
 *
 * The text is a function so it is built from what the page knows at the press, not at
 * the last render.
 */
function CopyButton({
  text,
  label,
  copied: copiedLabel,
  name,
  size,
  disabled,
  tip,
}: {
  text: () => string;
  label: string;
  /** What the live region says once it is on the clipboard. */
  copied: string;
  /** The accessible name, when the visible label alone ("Copy") would not say what is copied. */
  name?: string;
  size?: 'small';
  disabled?: boolean;
  tip?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // As in `McpUrl`: a refused clipboard is not worth an error message here.
    }
  }

  return (
    <>
      <Button size={size} disabled={disabled} tip={tip} aria-label={name} onClick={() => void copy()}>
        {copied ? <CopiedIcon /> : <CopyIcon />}
        <span className="copy-label">
          <span aria-hidden={copied}>{label}</span>
          <span aria-hidden={!copied}>Copied</span>
        </span>
      </Button>
      <span className="visually-hidden" role="status">
        {copied ? copiedLabel : ''}
      </span>
    </>
  );
}

/**
 * The account's notebooks with their field definitions, as the standing instructions are
 * built from them. Both come from the local library, so this is a read of the device and
 * no request; `null` until every notebook with fields has answered, so a copy never
 * describes a notebook without the fields it has.
 */
function useInstructionLibrary(): { notebooks: InstructionNotebook[] | null; failed: boolean } {
  const list = useQuery(notebooksQuery());
  const withFields = (list.data?.notebooks ?? []).filter((nb) => nb.fields > 0);
  const fields = useQueries({ queries: withFields.map((nb) => notebookFieldsQuery(nb.id)) });
  const failed = list.isError || fields.some((q) => q.isError);
  if (!list.data || fields.some((q) => !q.data)) return { notebooks: null, failed };
  const byId = new Map(withFields.map((nb, i) => [nb.id, fields[i]!.data!]));
  return {
    notebooks: list.data.notebooks.map((nb) => ({
      name: nb.name,
      purpose: nb.purpose,
      count: nb.count,
      fields: byId.get(nb.id) ?? [],
    })),
    failed,
  };
}

/**
 * Where each text goes. The paths are each app's own words as its help pages give them
 * (checked October 2026); docs/assistants.md says the same at more length, for every
 * device, and is where to correct them when an app moves a setting.
 */
const DESTINATIONS = [
  {
    key: 'claude',
    title: 'Claude, in every chat',
    subject: 'Claude',
    where: 'Paste into Settings › Your Claude › Instructions.',
    build: claudeInstructions,
  },
  {
    key: 'project',
    title: 'A Claude Project for filing',
    subject: 'a Claude Project',
    where: 'Paste into the project’s Set project instructions. Every message there is read as something to file or look up.',
    build: claudeProjectInstructions,
  },
  {
    key: 'chatgpt',
    title: 'ChatGPT',
    subject: 'ChatGPT',
    where: 'Paste into Settings › Personalization › Custom instructions.',
    build: chatgptInstructions,
  },
] as const;

const STANDING_INSTRUCTIONS_DOC = `${SOURCE_URL}/blob/main/docs/assistants.md#standing-instructions`;

/**
 * "Tell it when to use Unbent": the standing instructions for each place they are
 * pasted (`standing-instructions.ts` says what they do and why they are short).
 *
 * Rows ruled like the connected assistants below, so the page keeps one shape for "a
 * thing and its action", with the copy at the right edge where it lines up down the
 * list. Each row says where its text is pasted, since that is the step people get stuck
 * on, and the name of the setting is different in every app. The paragraph says that the
 * assistant keeps its own memory, because the first question anyone asks of this is
 * whether Unbent replaces it; that the texts go stale when the notebooks change, because
 * nothing can update a text once it is pasted into someone else's settings; and where a
 * notebook's purpose is set, since that is the one sentence in the text that says what a
 * notebook is for.
 */
function StandingInstructions() {
  const { notebooks, failed } = useInstructionLibrary();
  const url = mcpUrl();
  const tip = notebooks ? undefined : failed ? 'Could not read your notebooks' : 'Reading your notebooks…';

  return (
    <section className="settings-section">
      <h3>Tell it when to use Unbent</h3>
      <p className="muted small">
        An assistant uses Unbent when you ask it to. Paste one of these into its standing
        instructions and “file this” or “look up X in my notes” come here without naming
        Unbent; it keeps its own memory for everything else. Each names your notebooks,
        their purposes and their fields, so copy it again after you change them. A
        notebook’s purpose, set under <Link to="/settings/notebooks">Notebooks</Link>, is
        what tells the assistant what belongs in it.
      </p>
      <ul className="owned-list instructions-list">
        {DESTINATIONS.map((d) => (
          <li key={d.key}>
            <span>
              <span>{d.title}</span>
              <span className="muted small">{d.where}</span>
            </span>
            <CopyButton
              size="small"
              label="Copy"
              name={`Copy instructions for ${d.subject}`}
              copied={`Instructions for ${d.subject} copied`}
              disabled={!notebooks}
              tip={tip}
              text={() => d.build(url, notebooks ?? [])}
            />
          </li>
        ))}
      </ul>
      <p className="muted small">
        Each assistant asks you to confirm its writes until you trust it.{' '}
        <a href={STANDING_INSTRUCTIONS_DOC} target="_blank" rel="noopener noreferrer">
          More on what these do
        </a>
        .
      </p>
    </section>
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
 * Each row also says what its assistant was given (MAK-264), in the words the consent
 * screen used, and "Change access" opens the consent screen's own two questions under
 * that row, where the row is, rather than on a page of their own: what is being changed
 * is one assistant's, and it stays in view with its name above it. One row is open at a
 * time. Save is what applies it, since a tick that took effect as it was made would let
 * a slip of the thumb hand an assistant a notebook for as long as it took to notice;
 * the assistant is held to what is saved from its next call.
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
  // What each restricted assistant was given, by client id; null until read, and when
  // it could not be. A client not in it is unrestricted.
  const [access, setAccess] = useState<Record<string, AssistantGrant> | null>(null);
  // The row whose access is open for changing, and the choice being made in it.
  const [editing, setEditing] = useState<{ clientId: string; draft: AssistantGrant; pickSome: boolean } | null>(null);
  // Said once after a save, for a screen reader: the row's own line changing is silent.
  const [saved, setSaved] = useState('');
  const notebooks = useQuery(notebooksQuery());

  /*
   * Focus follows the editor. "Change access" is not drawn on a row whose editor is
   * open, and Save and Cancel go with the editor when it closes, so both ways the
   * button that was pressed is removed from under the focus, which then falls to the
   * top of the page: a keyboard or a screen reader starts the whole settings page
   * again to get back to the row it was on. So opening moves focus to the first
   * question's chosen answer, and closing puts it back on that row's "Change access".
   */
  const editor = useRef<HTMLDivElement>(null);
  const changeButtons = useRef(new Map<string, HTMLButtonElement>());
  const wasEditing = useRef<string | null>(null);
  const editingId = editing?.clientId ?? null;
  useEffect(() => {
    if (editingId) editor.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
    else if (wasEditing.current) changeButtons.current.get(wasEditing.current)?.focus();
    wasEditing.current = editingId;
  }, [editingId]);

  async function refresh() {
    try {
      const [result, given] = await Promise.all([
        oauth2.getConsents(),
        // Read beside the connections. If it fails the rows still list and can still be
        // disconnected; they say nothing about access rather than guess at it.
        listAssistantGrants().catch(() => null),
      ]);
      setAccess(given);
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

  async function saveAccess() {
    if (!editing) return;
    if (grantIsEmpty(editing.draft, notebooks.data?.notebooks)) {
      setEditing({ ...editing, pickSome: true });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveAssistantGrant(editing.clientId, editing.draft);
      const name = grants?.find((g) => g.clientId === editing.clientId)?.name ?? 'This assistant';
      setSaved(`${name}: ${grantSummary(editing.draft, notebooks.data?.notebooks)}.`);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message || 'Could not save that.');
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
        Assistants and other apps you have allowed to use your notes on your behalf. What
        each can see and do is beside its name under Connected, where you can change it or
        disconnect it.
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
          <CopyButton
            label="Copy setup prompt"
            copied="Setup prompt copied"
            text={() => mcpSetupPrompt(mcpUrl())}
          />
        </p>
        <p className="muted small">
          Either way, the client will open a browser window to ask for permission. Once
          approved, it appears under Connected below and stays connected until you
          disconnect it there.
        </p>
      </section>

      <StandingInstructions />

      {/* Headed now that the standing instructions sit between it and the paragraph that
          says a connected assistant "appears below". */}
      <section className="settings-section">
        <h3>Connected</h3>
        {error && <p className="bad small">{error}</p>}
        {/* The rows below then say nothing of access and offer no way to change it,
            which without this line looked like the feature not being there. */}
        {grants !== null && grants.length > 0 && access === null && (
          <p className="muted small">
            What each assistant can see and do could not be loaded just now. Reload the page to see it and change it.
          </p>
        )}

        {grants === null ? (
          <p className="muted small">Loading…</p>
        ) : grants.length === 0 ? (
          <p className="muted small">Nothing is connected.</p>
        ) : (
          <ul className="owned-list">
            {grants.map((grant) => {
              const given = access ? (access[grant.clientId] ?? FULL_GRANT) : null;
              const open = editing?.clientId === grant.clientId ? editing : null;
              const name = grant.name ?? 'Unnamed assistant';
              return (
                <li key={grant.id} className="connected-app">
                  <div className="connected-app-row">
                    <div className="connected-app-what">
                      <span>{name}</span>
                      <span className="muted small">
                        {given && grantSummary(given, notebooks.data?.notebooks)}
                        {given && grant.grantedAt && ' · '}
                        {grant.grantedAt && `connected ${new Date(grant.grantedAt).toLocaleDateString()}`}
                      </span>
                    </div>
                    <div className="connected-app-actions">
                      {given && !open && (
                        <Button
                          variant="quiet"
                          size="small"
                          // One row at a time: opening a second would throw away what
                          // was being chosen in the first without a word.
                          disabled={busy || editing !== null}
                          tip={editing ? 'Save or cancel the one you are changing first.' : undefined}
                          ref={(el) => {
                            if (el) changeButtons.current.set(grant.clientId, el);
                            else changeButtons.current.delete(grant.clientId);
                          }}
                          aria-label={`Change access for ${name}`}
                          onClick={() => {
                            setSaved('');
                            setEditing({ clientId: grant.clientId, draft: given, pickSome: false });
                          }}
                        >
                          Change access
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        tone="danger"
                        size="small"
                        disabled={busy}
                        aria-label={`Disconnect ${name}`}
                        onClick={() => setConfirming(grant)}
                      >
                        Disconnect
                      </Button>
                    </div>
                  </div>
                  {open && (
                    <div className="connected-app-edit" ref={editor}>
                      <AssistantAccess
                        value={open.draft}
                        onChange={(draft) => setEditing({ clientId: grant.clientId, draft, pickSome: false })}
                        notebooks={notebooks.data}
                        failed={notebooks.isError}
                        disabled={busy}
                        error={open.pickSome ? PICK_SOME_MESSAGE : null}
                      />
                      <div className="device-actions">
                        <Button disabled={busy} onClick={() => void saveAccess()}>
                          {busy ? 'Saving…' : 'Save'}
                        </Button>
                        <Button variant="quiet" disabled={busy} onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <span className="visually-hidden" role="status">
          {saved}
        </span>
      </section>

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
