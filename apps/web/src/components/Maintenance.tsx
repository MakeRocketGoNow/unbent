import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../notes-api.js';
import { deleteUser, useSession } from '../auth-client.js';
import { Backfill } from './Backfill.js';
import { SampleNotes } from './SampleNotes.js';
import { Confirm } from './Confirm.js';
import { Button } from './Button.js';
import { useMaintenance } from './use-maintenance.js';
import { autofillUsageQuery, configQuery, noteCountQuery, trashCountQuery } from '../queries.js';
import { useExactCount } from './use-exact-count.js';

type Pending = 'trashed' | 'all' | 'account' | null;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Operations over the whole account, gathered into one page and ordered by blast radius.
 *
 * The destructive ones lived at the bottom of the import panel, which meant the only route
 * to "delete all notes" was through Import, and they vanished mid-run, when a failed
 * import is exactly when you want them. The indexing passes followed for the same reason:
 * they run over files that arrived by any route, not only an import, and under Import they
 * read as a footnote to a form. A maintenance page has to list every operation of this
 * kind to be worth trusting, so emptying the trash appears here as well as in the trash
 * view.
 *
 * Weight runs opposite to blast radius: the passes that change nothing come first as
 * ordinary buttons, sweeping is one too, and wiping the account is the quietest control
 * on the page.
 */
export function Maintenance() {
  const [pending, setPending] = useState<Pending>(null);
  const [sweep, setSweep] = useState<api.GcResult | null>(null);
  const { busy, result, error, run, reset } = useMaintenance();

  /*
     The stored counts, until a confirmation opens; then the count read from the notes
     themselves, which is the number a permanent delete should name (see `useExactCount`).
     The page used to count exactly on every visit, and counting every note reads every
     note: 13k rows at 13k notes to label two buttons most visits never press.
  */
  const trashStored = useQuery(trashCountQuery()).data ?? 0;
  const notesStored = useQuery(noteCountQuery()).data ?? 0;
  const trashed = useExactCount(pending === 'trashed' ? { trashed: true } : null, trashStored);
  const notes = useExactCount(pending === 'all' ? {} : null, notesStored);

  /**
   * Account deletion is confirmed by mail, so an instance with none does not offer the
   * endpoint and this section does not exist. Absent config reads as absent feature: a
   * button that answers 404 looks like a broken app rather than a configured one.
   */
  const config = useQuery(configQuery());
  const { data: session } = useSession();
  const address = session?.user.email;

  const queryClient = useQueryClient();
  const [recounting, setRecounting] = useState(false);
  const [recounted, setRecounted] = useState<string | null>(null);
  const [recountError, setRecountError] = useState<string | null>(null);

  /**
   * Not `run` either, for the reason `requestAccountDeletion` gives: the outcome belongs
   * under the button that asked for it, not in the result line at the foot of the page,
   * three sections away from a control that sits near the top.
   */
  async function recount() {
    setRecounting(true);
    setRecounted(null);
    setRecountError(null);
    try {
      const { corrected } = await api.recountNotes();
      setRecounted(
        corrected === 0
          ? 'Every count was already right.'
          : `Corrected ${plural(corrected, 'count')}.`,
      );
      // Not awaited: the button should stop saying "Recounting…" when the answer is in,
      // not once every list behind this page has refetched the numbers it corrected.
      if (corrected > 0) void queryClient.invalidateQueries();
    } catch (err) {
      setRecountError((err as Error).message || 'Could not recount.');
    } finally {
      setRecounting(false);
    }
  }

  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  /**
   * Deliberately not `run` from useMaintenance: nothing was deleted, so there is nothing
   * to invalidate, and the outcome is not "deleted 47 notes" but "go and read your mail",
   * which belongs beside the control that caused it rather than in the page's result line.
   *
   * No `callbackURL` either. The API pins where the link lands, so that every caller gets
   * the same ending whether or not it knew to ask; passing one here would only be this
   * client agreeing with itself.
   */
  async function requestAccountDeletion() {
    setSending(true);
    setSendError(null);
    try {
      const res = await deleteUser({});
      if (res?.error) {
        setSendError(res.error.message || 'Could not send the confirmation.');
      } else {
        setSentTo(address ?? null);
        setPending(null);
      }
    } catch (err) {
      setSendError((err as Error).message || 'Could not send the confirmation.');
    } finally {
      setSending(false);
    }
  }

  const purge = (scope: 'trashed' | 'all') =>
    run(async () => {
      const r = await api.purgeNotes(scope);
      setPending(null);
      return `Deleted ${plural(r.notesDeleted, 'note')} and ${plural(r.filesDeleted, 'file')}.`;
    });

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Maintenance</h2>
      </div>

      <p className="muted small">
        Passes over everything you have. The first keeps search complete; the rest are
        permanent, and none of them touch the export, so take one first if you are unsure.
      </p>

      <section className="settings-section">
        <h3>Files not yet searchable</h3>
        <p className="muted small">
          Search reads the text inside attachments. Files added before that existed, or
          uploaded from the phone, may not have theirs yet; this pass catches up. Nothing is
          changed or deleted, and it can be stopped and run again.
        </p>
        <Backfill />
      </section>

      {/* After the indexing passes, which the page's opening line calls the first, and
          before anything that removes: this one only adds. Here as well as on the empty
          list, because the list offers it only while the account is empty, and a second
          run is how a preview picks up a seed that changed since the first. */}
      {config.data?.ownStores && <SampleNotes layout="section" />}

      {/*
          Second because it is the other pass that changes nothing a person wrote: the
          counts are derived from the notes, so the worst a recount can do is put a right
          number where a wrong one was. Laid out as one of the indexing passes' rows
          (a small button with its outcome beside it, the same width of button), so the two
          sections read as one kind of control and their status lines start at one edge.
      */}
      <section className="settings-section">
        <h3>Note counts</h3>
        <p className="muted small">
          The numbers beside notebooks and tags are kept up to date as notes change, rather
          than counted every time they are shown. If one ever looks wrong, this counts them
          all again from the notes.
        </p>
        <div className="backfill-row">
          <Button size="small" disabled={recounting} onClick={() => void recount()}>
            {recounting ? 'Recounting…' : 'Recount'}
          </Button>
          {recounted && <span className="good small">{recounted}</span>}
          {recountError && <span className="bad small">{recountError}</span>}
        </div>
      </section>

      {config.data?.autofill && <AutofillUsageSection />}

      <section className="settings-section">
        <h3>Empty trash</h3>
        <p className="muted small">
          Permanently deletes every note in the Trash, and their attachments. Deleting a
          note normally only moves it here, so this is the step that lets the storage go:
          the notes at once, their files 35 days later.
        </p>

        {/*
            A way to look before you leap, offered before the button rather than only
            inside the confirm.

            A count is enough to decide on one note and not nearly enough to decide on
            fifty: the honest reaction to "Empty trash (47 notes)" is "what is in there?",
            and until now the only answer was to leave the page and come back. The
            confirm already offered this link, but a confirm only appears once the user
            has committed to the thing they wanted to check first.

            Deliberately a link to /trash rather than a list of trashed notes inline. The
            sibling section lists orphaned files because those exist nowhere else in the
            app; trashed notes already have a view built for them, with restore and
            per-note actions, and a read-only copy here would be a worse version of a
            page we already have.
        */}
        {trashed > 0 && (
          <p className="muted small">
            <Link to="/trash">Review the trash</Link> to restore anything you want to keep.
          </p>
        )}

        <Button
          variant="primary"
          tone="danger"
          disabled={busy || trashed === 0}
          onClick={() => {
            reset();
            setPending('trashed');
          }}
        >
          {trashed === 0 ? 'Trash is empty' : `Empty trash (${plural(trashed, 'note')})`}
        </Button>

        {pending === 'trashed' && (
          <Confirm
            label="Confirm empty trash"
            question={`Permanently delete ${plural(trashed, 'note')} and their attachments?`}
            detail={
              <>
                This cannot be undone. <Link to="/trash">Review the trash</Link> first if
                you want to restore anything.
              </>
            }
            busy={busy}
            onCancel={() => setPending(null)}
            actions={[
              {
                label: 'Empty trash',
                busyLabel: 'Deleting…',
                tone: 'danger',
                onConfirm: () => purge('trashed'),
              },
            ]}
          />
        )}
      </section>

      <section className="settings-section">
        <h3>Orphaned files</h3>
        <p className="muted small">
          Storage objects with no attachment record: leftovers from an interrupted upload
          or import. Files you unlinked from a note still have a record and are not
          orphans; delete those from the note&apos;s Attachments list.
        </p>

        {/*
            Checked before deleting, using the dry run the API has always supported. The
            old single button destroyed first and reported the count afterwards, which is
            no help at all if the number is a surprise.
        */}
        {/* Said rather than hidden: someone testing the sweep on a preview should learn
            why it is not there, not wonder whether it was removed. The API refuses too. */}
        {config.data?.ownStores ? (
          <p className="muted small">
            Not on this preview: its notes are its own, but its files are the dev
            instance&apos;s, so every one of them would look like an orphan here.
          </p>
        ) : (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              reset();
              setSweep(null);
              void run(async () => {
                const r = await api.gcBlobs(false);
                setSweep(r);
                // A file deleted in the last 35 days is still stored and still accounted
                // for (the server keeps it for a restore), so it is neither an orphan nor
                // quite "referenced"; said separately, or the count would not add up.
                const held = r.awaitingDeletion > 0 ? `, ${r.awaitingDeletion} deleted and waiting to leave storage` : '';
                return r.orphaned === 0
                  ? `Nothing to sweep: ${plural(r.stored, 'file')}, all accounted for${held}.`
                  : `${r.orphaned} of ${plural(r.stored, 'file')} stored have no attachment record${held}.`;
              });
            }}
          >
            Check for orphaned files
          </Button>
        )}

        {sweep && sweep.orphaned > 0 && (
          <>
            <details className="failures">
              <summary className="small">
                {sweep.orphaned > sweep.keys.length
                  ? `Show the first ${sweep.keys.length} of ${sweep.orphaned}`
                  : `Show ${plural(sweep.orphaned, 'file')}`}
              </summary>
              <ul className="small">
                {sweep.keys.map((key) => (
                  <li key={key}>{key}</li>
                ))}
              </ul>
            </details>

            <Button
              variant="primary"
              tone="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.gcBlobs(true);
                  setSweep(null);
                  return `Removed ${plural(r.deleted, 'orphaned file')}.`;
                })
              }
            >
              Delete {plural(sweep.orphaned, 'orphaned file')}
            </Button>
          </>
        )}
      </section>

      <section className="settings-section">
        <h3>Delete all notes</h3>
        <p className="muted small">
          Empties the account: every note, trashed or not, and every attachment. Mainly
          useful for repeating a trial import.
        </p>
        {/* Outlined in red, like the notebook page's Delete notebook, rather than filled like
            Empty trash above it: nothing else on this page can do as much, so it is not the
            loud one. It was `quiet` once, which left a lone red caption at the foot of the
            section; that variant is for actions repeated down a list, not one per page. */}
        <Button
          variant="secondary"
          tone="danger"
          disabled={busy}
          onClick={() => {
            reset();
            setPending(pending === 'all' ? null : 'all');
          }}
        >
          Delete all notes
        </Button>

        {pending === 'all' && (
          <Confirm
            label="Confirm delete all notes"
            question={`Permanently delete all ${plural(notes, 'note')} and their attachments?`}
            detail={
              <>
                There is no undo. <Link to="/settings/export">Export first</Link> if you
                want a copy. Type <code>DELETE</code> to confirm.
              </>
            }
            requireTyped="DELETE"
            busy={busy}
            onCancel={() => setPending(null)}
            actions={[
              {
                label: 'Delete everything',
                busyLabel: 'Deleting…',
                tone: 'danger',
                onConfirm: () => purge('all'),
              },
            ]}
          />
        )}
      </section>

      {config.data?.accountDeletion && (
        <section className="settings-section">
          <h3>Delete account</h3>
          <p className="muted small">
            Ends the account itself rather than emptying it: every note and attachment, the
            passkeys registered to it, and the apps it has connected. The action above
            leaves you signed in to an empty account; this one leaves you with none.
          </p>
          <p className="muted small">
            Confirming it takes a link sent to{' '}
            <span className="wrap-anywhere">{address ?? 'your address'}</span>, so nothing
            here deletes anything on its own.
          </p>

          {/*
              No `requireTyped`, unlike "Delete all notes" above, and the difference is the
              point rather than an oversight. Typing DELETE exists there because that button
              *is* the irreversible step. Here the button only sends mail (the irreversible
              step is the link, in an inbox, behind a session), so demanding the word would
              be friction guarding nothing, and would teach the habit of typing it without
              reading on the one page where the other control means it.
          */}
          <Button
            variant="secondary"
            tone="danger"
            disabled={busy || sending}
            onClick={() => {
              setSendError(null);
              setPending(pending === 'account' ? null : 'account');
            }}
          >
            {sentTo ? 'Send the link again' : 'Delete account'}
          </Button>

          {pending === 'account' && (
            <Confirm
              label="Confirm delete account"
              question="Delete this account and everything in it?"
              detail={
                <>
                  A link goes to{' '}
                  <span className="wrap-anywhere">{address ?? 'your address'}</span> and
                  nothing is deleted until you open it.{' '}
                  <Link to="/settings/export">Export first</Link> if you want a copy: there
                  is no way back once it is done.
                </>
              }
              busy={sending}
              onCancel={() => setPending(null)}
              actions={[
                {
                  label: 'Email me the link',
                  busyLabel: 'Sending…',
                  tone: 'danger',
                  onConfirm: requestAccountDeletion,
                },
              ]}
            />
          )}

          {/* Below the button, not above it: a message that pushes the control it came
              from down the page is motion nobody asked for. */}
          {sentTo && (
            <p className="good small">
              Sent to <span className="wrap-anywhere">{sentTo}</span>. Nothing has been
              deleted yet: the link opens a page here that asks once more. It works only in
              a browser signed in to this account, and expires in a day.
            </p>
          )}
          {sendError && <p className="bad small">{sendError}</p>}
        </section>
      )}

      {result && <p className="good small">{result}</p>}
      {error && <p className="bad small">{error}</p>}
    </div>
  );
}

/**
 * "1.2 million", "84 thousand", "1,412": a large count of tokens is read as a magnitude,
 * not to the unit. Under ten thousand the number is written out, since "1.4 thousand" is
 * longer than the number it rounds.
 */
const compact = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('en');
const tokenCount = (n: number) => (n < 10_000 ? exact.format(n) : compact.format(n));

/**
 * What Auto-fill has cost this account this calendar year (MAK-180): the presses, and the
 * tokens the language model read and wrote inside them. Here because Maintenance is where
 * the account's other whole-account figures are, until the plans decide where usage lives
 * (MAK-108).
 *
 * Read-only, so it sits with the passes that change nothing, after them and before
 * anything that deletes. A sentence rather than a table of figures: the page's other
 * sections report in a line, and three numbers do not need a grid to be read. Tokens
 * rather than money, because the price is the model's and changes, and the counter keeps
 * what was used. "Read" counts every kind of input (fresh, from the cache, into it)
 * since a person cannot act on that split; the server keeps it apart for the bill.
 *
 * The day's cap is said only where one applies, with today's count beside it, and the
 * year's as a share of what the account gets, so neither 429 a press can meet is a
 * surprise to someone who looked here first. "This account", since the numbers are the
 * account's: a trial's are smaller than a paying account's.
 */
/**
 * The year's spend cap as a share, never an amount (see `AutofillUsage.yearUsed`), rounded
 * to whole percent and said in words at the ends, where "0%" would read as nothing used
 * and "100%" as a figure rather than a state.
 */
function yearUsedSentence(share: number): string {
  const percent = Math.round(share * 100);
  const much = share >= 1 ? 'All' : percent < 1 ? 'Under 1%' : `About ${percent}%`;
  return `${much} of this account's Auto-fill for the year has been used.`;
}

function AutofillUsageSection() {
  const usage = useQuery(autofillUsageQuery());
  const u = usage.data;
  const read = u?.models.reduce((n, m) => n + m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens, 0) ?? 0;
  const written = u?.models.reduce((n, m) => n + m.outputTokens, 0) ?? 0;

  return (
    <section className="settings-section">
      <h3>Auto-fill this year</h3>
      <p className="muted small">
        Each press of Auto-fill files a note from what it says. Where this instance has a
        language model, the press also reads the note&apos;s pictures and writes its title and
        fields with it, and that model is paid for by the token.
      </p>
      {/* A figure already on screen stays when a refetch fails; the error is for none at all.
          Offline is not a failure: the counter is the server's, and the page says so in
          the phrase the app uses for every read that needs it. */}
      {!u ? (
        usage.isError ? (
          api.isOfflineError(usage.error) ? (
            <p className="muted small">Not available offline.</p>
          ) : (
            <p className="bad small">Could not load this year&apos;s usage.</p>
          )
        ) : (
          <p className="muted small">Loading…</p>
        )
      ) : (
        <p className="small">
          {u.presses === 0 ? (
            'No presses yet this year.'
          ) : (
            <>
              {u.presses} {u.presses === 1 ? 'press' : 'presses'} since 1 January
              {read + written > 0 && (
                <>
                  , in which the model read {tokenCount(read)} tokens and wrote{' '}
                  {tokenCount(written)}
                </>
              )}
              .
            </>
          )}
          {u.dailyCap !== null && (
            <>
              {' '}
              This account can use Auto-fill {u.dailyCap === 1 ? 'once' : u.dailyCap === 2 ? 'twice' : `${u.dailyCap} times`} a
              day, and {u.today === 0 ? 'none have' : u.today === 1 ? '1 has' : `${u.today} have`} been
              used today.
            </>
          )}
          {u.yearUsed !== null && <> {yearUsedSentence(u.yearUsed)}</>}
        </p>
      )}
    </section>
  );
}
