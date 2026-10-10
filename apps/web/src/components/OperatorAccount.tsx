import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DELETED_FILES_KEPT_DAYS, DUMPS_KEPT_DAYS, MIRROR_KEPT_DAYS, RESTORES_LISTED, RESTORE_WINDOW_DAYS, type AccountDump, type OperatorAccount as Account, type StoreRestore } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, LoadFailedError, errorText } from '../notes-api.js';
import { formatBytes } from '../format-bytes.js';
import { formatMoment, timeAgo } from './format-when.js';
import { accountDumpsQuery, accountRestoresQuery, configQuery, keys, operatorAccountQuery, storeStatsQuery } from '../queries.js';
import { holdPage } from '../busy.js';
import { useAppSession } from '../useAppSession.js';
import { Button } from './Button.js';
import { Confirm } from './Confirm.js';
import { LastDump } from './Operator.js';
import { describePlan } from './Plan.js';

/**
 * One account, for the operator: what the directory and its store say of it, its dumps,
 * and the four things an operator can do to it. Every action goes through `Confirm`
 * with the account and the blast radius named, in the order of how much each loses.
 *
 * Each action is the route it drives and nothing more. The dry run is a press of its own
 * — Preview — and what it shows is what the confirm then names: the moment resolved to a
 * bookmark and the counts the store holds now, or the dump's own first line and whether
 * its rows are one moment. The confirm repeats the request with the word the route
 * wants. Every restore and load is recorded with who asked (migration 0041), and
 * Restores and loads, between the two sections, lists them and offers the newest one's
 * undo as a second confirm, so a wind-back to the wrong moment is one more press rather
 * than a request written by hand from the Worker log, before a reload and after it. An
 * answer keeps its own undo only when the history could not record it.
 *
 * Downloads are links: a dump is a file, and a link to a file middle-clicks, copies and
 * saves with the browser's own download, which a button cannot do.
 */
export function OperatorAccount({ userId }: { userId: string }) {
  const row = useQuery(operatorAccountQuery(userId));
  const account = row.data ?? null;
  const stats = useQuery(storeStatsQuery(userId));
  // Moved each time a section below asks to change the store — in `finally`, since a
  // request that failed may still have been applied — and each section is keyed on the
  // others'. An answer a section keeps can carry an undo (when the history failed to
  // record it), a bookmark from before that section's change, so once another section
  // has changed the store since, pressing it would throw that change away too, under a
  // confirm that names only its own — the reason the history offers its newest row's
  // undo and no other (MAK-189, MAK-198). Remounting drops the stale answer.
  const [windBacks, setWindBacks] = useState(0);
  const [loads, setLoads] = useState(0);
  const [undos, setUndos] = useState(0);
  // A wiped or loading store answers null for its last write because it cannot read its
  // feed, not because nothing was written: unknown, so the sweep's value stands in.
  const live = stats.data && !stats.data.wiped && !stats.data.loading ? stats.data.lastWriteAt : undefined;
  // The address of an account deleted from this page, kept here because the row it came
  // from is gone the moment the list is refetched.
  const [deleted, setDeleted] = useState<string | null>(null);

  // Before the null check: a deleted account's row reads as null once refetched, and
  // "No such account" is the wrong thing to say about one just deleted on purpose.
  if (deleted !== null) {
    return (
      <div className="panel operator-page">
        <div className="panel-head">
          <h2 className="wrap-anywhere">{deleted}</h2>
          <Link to="/settings/operator" className="link small">
            All accounts
          </Link>
        </div>
        <p className="good small">Deleted. The account, its notes and files, and its sign-ins are gone.</p>
      </div>
    );
  }

  if (row.data === null) {
    return (
      <div className="panel operator-page">
        <div className="panel-head">
          <h2>No such account</h2>
        </div>
        <p className="muted small">
          Nothing in the directory has this id. <Link to="/settings/operator">All accounts</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="panel operator-page">
      {/* The way back on the right of the heading, where the notebook page keeps its
          "All notebooks": the two sub-pages under Settings should put it in one place. */}
      <div className="panel-head">
        <h2 className="wrap-anywhere">{account?.email ?? userId}</h2>
        <Link to="/settings/operator" className="link small">
          All accounts
        </Link>
      </div>

      {account && <AccountFacts account={account} lastWriteAt={live} reading={stats.isPending} />}

      {account?.plan && <PlanSection userId={userId} email={account.email} plan={account.plan} />}

      <section className="settings-section">
        <h3>Store</h3>
        <StoreFacts
          stats={stats.data ?? null}
          error={stats.error}
          userId={userId}
          email={account?.email ?? userId}
          onChanged={() => setUndos((n) => n + 1)}
        />
        <p>
          <a href={api.storeDumpUrl(userId)} download>
            Download the store as it is now
          </a>
          <span className="muted"> · SQL, every table</span>
        </p>
      </section>

      <WindBack key={`wind-back-${loads}-${undos}`} userId={userId} email={account?.email ?? userId} onChanged={() => setWindBacks((n) => n + 1)} />
      <RestoreHistory key={`history-${windBacks}-${loads}`} userId={userId} email={account?.email ?? userId} onChanged={() => setUndos((n) => n + 1)} />
      <LoadDump key={`load-${windBacks}-${undos}`} userId={userId} email={account?.email ?? userId} onChanged={() => setLoads((n) => n + 1)} />
      <Resync userId={userId} email={account?.email ?? userId} />
      <DeleteAccount userId={userId} email={account?.email ?? userId} account={account} stats={stats.data ?? null} onDeleted={setDeleted} />
    </div>
  );
}

/**
 * `lastWriteAt` is the store's own answer, read with the stats: undefined until they
 * have loaded or while the store cannot answer (wiped, or a dump being loaded into it),
 * otherwise the newest write or null for a store never written to. The
 * directory's `lastActiveAt` is the same value as of the last hourly sweep, which is
 * what the accounts list shows; on this page, which reads the store anyway,
 * it was up to an hour stale, or days for an account the sweep had not reached since
 * (MAK-190). Shown only while the live one is not here yet, and said to be the sweep's.
 * `reading` is whether the stats are still on their way: once a read has failed, "Reading
 * the store…" would sit there for good above the error that says why.
 */
function AccountFacts({ account, lastWriteAt, reading }: { account: Account; lastWriteAt: number | null | undefined; reading: boolean }) {
  return (
    <dl className="about-list operator-facts">
      <div>
        <dt>Account id</dt>
        <dd>
          <code className="wrap-anywhere">{account.userId}</code>
        </dd>
      </div>
      {account.name && (
        <div>
          <dt>Name</dt>
          <dd>{account.name}</dd>
        </div>
      )}
      <div>
        <dt>Created</dt>
        <dd>{formatMoment(account.createdAt)}</dd>
      </div>
      <div>
        <dt>Last change</dt>
        <dd>
          {lastWriteAt === undefined ? (
            account.lastActiveAt ? (
              <>
                {timeAgo(account.lastActiveAt)} · {formatMoment(account.lastActiveAt)} <span className="muted">· as of the last sweep</span>
              </>
            ) : reading ? (
              <span className="muted">Reading the store…</span>
            ) : (
              <span className="muted">None recorded</span>
            )
          ) : lastWriteAt ? (
            `${timeAgo(lastWriteAt)} · ${formatMoment(lastWriteAt)}`
          ) : (
            <span className="muted">Nothing written yet</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Last dump</dt>
        <dd>
          <LastDump account={account} />
        </dd>
      </div>
    </dl>
  );
}

/** The counts an operator reads before an action, labelled; the rest of the tables by their names. */
const TABLE_LABELS: Record<string, string> = {
  notes: 'Notes',
  notebooks: 'Notebooks',
  notebook_fields: 'Fields',
  tags: 'Tags',
  attachments: 'Files',
  attachment_text: 'Files with text',
  note_revisions: 'Revisions',
  deleted_blobs: 'Deleted files held',
  changes: 'Feed rows',
};

/**
 * What the store itself says: its counts, the schema it is on, and whether it is in a
 * state where those are not the point — wiped, or refusing everything while a dump is
 * loaded into it. Live, unlike the directory's numbers above.
 */
function StoreFacts({
  stats,
  error,
  userId,
  email,
  onChanged,
}: {
  stats: api.StoreStats | null;
  error: Error | null;
  userId: string;
  email: string;
  onChanged: () => void;
}) {
  if (error) return <p className="bad small">{errorText(error)}</p>;
  if (!stats) return <p className="muted small">Reading the store…</p>;
  if (stats.loading) return <LoadingStore loading={stats.loading} userId={userId} email={email} onChanged={onChanged} />;
  if (stats.wiped) return <p className="muted small">The store is empty: wiped, and nothing has woken it since.</p>;
  const schema = stats.migrations[stats.migrations.length - 1] ?? 'none';
  return (
    <dl className="health-facts store-facts">
      {Object.entries(stats.counts)
        .filter(([table]) => table in TABLE_LABELS)
        .map(([table, count]) => (
          <div key={table}>
            <dt>{TABLE_LABELS[table]}</dt>
            <dd>{count.toLocaleString()}</dd>
          </div>
        ))}
      <div>
        <dt>Size</dt>
        <dd>{formatBytes(stats.databaseSize)}</dd>
      </div>
      <div>
        <dt>Schema</dt>
        <dd>{schema}</dd>
      </div>
    </dl>
  );
}

/**
 * A store that is being loaded, or was left so by a load that failed: refusing every
 * request until it is whole. The store's own marker carries the two ways back, so they
 * are offered here — from any page that reads the store, after a reload, by a second
 * operator — and not only in the state of the page that pressed Load. Undo is the same
 * confirm the load's own outcome offers.
 */
function LoadingStore({
  loading,
  userId,
  email,
  onChanged,
}: {
  loading: NonNullable<api.StoreStats['loading']>;
  userId: string;
  email: string;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function undo() {
    const release = holdPage();
    setBusy(true);
    setError(null);
    try {
      await api.restoreStore(userId, { bookmark: loading.undo! });
    } catch (err) {
      setError(errorText(err));
    } finally {
      release();
      setAsked(false);
      setBusy(false);
      invalidateStore(queryClient, userId);
      onChanged();
    }
  }
  return (
    <>
      <p className="bad small">
        Loading {loading.key} since {formatMoment(loading.startedAt)}, {loading.pages} pages so far, and refusing every request until it is
        whole. If the load that started it has ended, there are two ways back.
        {loading.before && <> The dump taken before it, {loading.before.split('/').pop()}, is in the list below; loading it puts the store back.</>}
        {loading.undo ? <> Or undo the load, which winds back to the bookmark it took as it began.</> : <> Or load the dump it was loading again.</>}
      </p>
      {loading.undo &&
        (!asked ? (
          <Button tone="danger" disabled={busy} onClick={() => setAsked(true)}>
            Undo the load
          </Button>
        ) : (
          <UndoLoadConfirm email={email} busy={busy} stopped onCancel={() => setAsked(false)} onConfirm={() => undo()} />
        ))}
      {error && <p className="bad small">{error}</p>}
    </>
  );
}

/**
 * What an action that changes the store makes stale: its counts, the accounts list (and
 * the account's row under it), and the restore history, which has a new row.
 */
function invalidateStore(queryClient: ReturnType<typeof useQueryClient>, userId: string) {
  void queryClient.invalidateQueries({ queryKey: keys.storeStats(userId) });
  void queryClient.invalidateQueries({ queryKey: keys.operatorAccounts() });
  void queryClient.invalidateQueries({ queryKey: keys.accountRestores(userId) });
}

/** "12 notes, 3 files and 40 revisions": the counts a confirm names as what is at stake. */
export function describeCounts(stats: api.StoreStats): string {
  const c = stats.counts;
  return `${plural(c['notes'] ?? 0, 'note')}, ${plural(c['attachments'] ?? 0, 'file')} and ${plural(c['note_revisions'] ?? 0, 'revision')}`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/** `datetime-local` wants the viewer's local time without an offset, to the minute. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The preview step: the control's own state, cleared whenever the moment changes. */
type WindBackStep = { kind: 'idle' } | { kind: 'previewing' } | { kind: 'preview'; at: number; preview: api.RestorePreview };

/**
 * What the last wind-back did, kept apart from the preview step on purpose: the undo
 * bookmark lives here, and a stray touch of the moment field or a second Preview must
 * not throw away the one press that puts a wrong wind-back right (found in review).
 */
type WindBackOutcome = { kind: 'done'; at: number; result: api.RestoreResult; undoAsked: boolean } | { kind: 'undone'; result: api.RestoreResult };

/**
 * The confirm that undoes a wind-back, from the history's newest row or from this page's
 * own answer when the history could not record it. One component for both so the two
 * cannot drift apart in what they say is lost; `UndoLoadConfirm` is its twin.
 */
function UndoWindBackConfirm({ email, busy, onCancel, onConfirm }: { email: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm
      label="Confirm undo wind back"
      question={`Put ${email} back as it was before the wind-back?`}
      detail={
        <>
          Restores to the bookmark the wind-back returned, which is the store as it stood just before it. Anything written since the
          wind-back is lost, and every device resyncs again.
        </>
      }
      busy={busy}
      onCancel={onCancel}
      actions={[{ label: 'Undo the wind-back', busyLabel: 'Restoring…', tone: 'danger', onConfirm }]}
    />
  );
}

/**
 * The confirm that undoes a load, from the history's newest row, the load's own answer,
 * or the store's loading marker. `stopped` is a load that emptied the store and did not
 * fill it: the store has refused every write since, so nothing written since is lost,
 * and saying so would name a loss that cannot happen.
 */
function UndoLoadConfirm({
  email,
  busy,
  stopped = false,
  onCancel,
  onConfirm,
}: {
  email: string;
  busy: boolean;
  stopped?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Confirm
      label="Confirm undo load"
      question={`Put ${email}'s store back as it was before the load?`}
      detail={
        stopped ? (
          'Winds back to the bookmark the load took as it began, the store as it stood just before it was emptied. Every device resyncs.'
        ) : (
          <>
            Winds back to the bookmark the load took as it began, the store as it stood just before it was emptied. Anything written since
            the load is lost, and every device resyncs again.
          </>
        )
      }
      busy={busy}
      onCancel={onCancel}
      actions={[{ label: 'Undo the load', busyLabel: 'Restoring…', tone: 'danger', onConfirm }]}
    />
  );
}

/**
 * Wind the store back to a moment in the last thirty days.
 *
 * Preview is the first step and a press of its own, because the confirm has to name what
 * the store holds now and the route's dry run is where that comes from — and because a
 * moment outside the window is refused there, before anything is at stake. The confirm
 * names the account, the moment, and what is lost: everything written after it. The
 * undo is offered on the wind-back's row in the history just below, which is where it
 * is after a reload too; the answer keeps its own only when the history could not
 * record it, so the one way back is never on screen twice.
 *
 * Where the runtime keeps no history — `wrangler dev` — the route answers 501, and the
 * section says so in place of the control rather than offering a preview that fails.
 */
function WindBack({ userId, email, onChanged }: { userId: string; email: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  // Read when the field is focused, not on every render: the bounds should not move
  // under the field while it is being typed in, but a page left open for an hour must
  // not grey out the last hour, which is when an operator most often wants to go.
  const [now, setNow] = useState(() => Date.now());
  // The field starts at now, not an hour back: a default in the past read as the page
  // being on the wrong clock, and it never matched what the operator wanted anyway. The
  // moment is theirs to type.
  const [at, setAt] = useState(() => toLocalInput(now));
  const [step, setStep] = useState<WindBackStep>({ kind: 'idle' });
  const [outcome, setOutcome] = useState<WindBackOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);

  const refresh = () => invalidateStore(queryClient, userId);

  async function preview() {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) {
      setError('Pick a moment first.');
      return;
    }
    setError(null);
    setStep({ kind: 'previewing' });
    try {
      setStep({ kind: 'preview', at: ms, preview: await api.previewRestore(userId, { at: ms }) });
    } catch (err) {
      setStep({ kind: 'idle' });
      if (err instanceof ApiError && err.status === 501) setUnsupported(errorText(err));
      else setError(errorText(err));
    }
  }

  async function windBack(ms: number) {
    // Held for the whole request, like an upload: the update notice's Reload waits for
    // nothing to be in flight (`busy.ts`), and a reload here drops the request and the
    // undo bookmark its answer carries.
    const release = holdPage();
    setBusy(true);
    setError(null);
    try {
      const result = await api.restoreStore(userId, { at: ms });
      setOutcome({ kind: 'done', at: ms, result, undoAsked: false });
    } catch (err) {
      setError(errorText(err));
    } finally {
      release();
      // Closed either way: after a failure the confirm's counts are of a store that may
      // already have been wound back, and a second press on it would restore again,
      // leaving the way back to before the first one in the Worker log alone.
      setStep({ kind: 'idle' });
      setBusy(false);
      refresh();
      onChanged();
    }
  }

  // `record` is the history row of the change being undone, sent as `ifNewest` so the
  // press is refused if another operator restored or loaded since; see `RestoreHistory`.
  async function undo(bookmark: string, record?: number) {
    const release = holdPage();
    setBusy(true);
    setError(null);
    try {
      setOutcome({ kind: 'undone', result: await api.restoreStore(userId, { bookmark }, record) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      release();
      // Closed either way, as the wind-back's own confirm is: a second press on a confirm
      // whose restore may already have been applied would restore again.
      setOutcome((o) => (o && o.kind === 'done' ? { ...o, undoAsked: false } : o));
      setBusy(false);
      refresh();
      onChanged();
    }
  }

  return (
    <section className="settings-section">
      <h3>Wind back to a moment</h3>
      <p className="muted small">
        Puts the store back as it was at a moment in the last {RESTORE_WINDOW_DAYS} days, from the history the platform keeps of it.
        Everything written after that moment is lost; the files a wound-back note names are still stored for {DELETED_FILES_KEPT_DAYS} days
        after their deletion, so they come back with it. Preview first: it shows what the store holds now, and nothing changes.
      </p>

      {unsupported ? (
        <p className="muted small">{unsupported}</p>
      ) : (
        <div className="operator-row">
          <label>
            <span className="muted">Moment</span>
            <input
              type="datetime-local"
              className="search-field"
              value={at}
              min={toLocalInput(now - RESTORE_WINDOW_DAYS * 86_400_000)}
              max={toLocalInput(now)}
              onFocus={() => setNow(Date.now())}
              disabled={busy || step.kind === 'previewing'}
              onChange={(e) => {
                setAt(e.target.value);
                setStep({ kind: 'idle' });
              }}
            />
          </label>
          <Button disabled={busy || step.kind === 'previewing'} onClick={() => void preview()}>
            {step.kind === 'previewing' ? 'Previewing…' : 'Preview'}
          </Button>
        </div>
      )}

      {step.kind === 'preview' && (
        <Confirm
          label="Confirm wind back"
          question={`Wind back ${email} to ${formatMoment(step.at)}?`}
          detail={
            <>
              Every note, file record and revision written after that moment is lost. The store now holds{' '}
              {describeCounts(step.preview.current)}; what it held at that moment is what it will hold after. Every device of the
              account resyncs from a snapshot. Undo is offered under Restores and loads below for the {RESTORE_WINDOW_DAYS} days its bookmark lasts, until something
              else changes the store.
            </>
          }
          busy={busy}
          onCancel={() => setStep({ kind: 'idle' })}
          actions={[{ label: 'Wind back', busyLabel: 'Winding back…', tone: 'danger', onConfirm: () => windBack(step.at) }]}
        />
      )}

      {outcome?.kind === 'done' && (
        <>
          <p className="good small">
            Wound back to {formatMoment(outcome.at)}.
            {outcome.result.stats && <> The store now holds {describeCounts(outcome.result.stats)}.</>}
            {!outcome.result.feedEpoch && <> The feed was not given a new epoch; resync the devices below.</>}
          </p>
          {/* The history's row is where the undo lives; this is the fallback for a row
              that was not written, when the answer is the only copy on screen. */}
          {outcome.result.recorded ? (
            // Said, as the load's answer says it: the button used to sit here, and an
            // operator who just pressed something destructive should not have to look.
            outcome.result.undo && <p className="muted small">Undo is on its row under Restores and loads, just below.</p>
          ) : outcome.result.undo ? (
            <>
              <p className="muted small">The history could not record this wind-back, so its undo is offered here instead.</p>
              {!outcome.undoAsked ? (
                <Button tone="danger" disabled={busy} onClick={() => setOutcome({ ...outcome, undoAsked: true })}>
                  Undo the wind-back
                </Button>
              ) : (
                <UndoWindBackConfirm email={email} busy={busy} onCancel={() => setOutcome({ ...outcome, undoAsked: false })} onConfirm={() => undo(outcome.result.undo!, outcome.result.record)} />
              )}
            </>
          ) : (
            <p className="muted small">The undo bookmark did not survive the restart; the Worker log has it on the &quot;restore scheduled&quot; line.</p>
          )}
        </>
      )}

      {outcome?.kind === 'undone' && (
        <p className="good small">
          Put back as it was before the wind-back.
          {outcome.result.stats && <> The store now holds {describeCounts(outcome.result.stats)}.</>}
        </p>
      )}

      {error && <p className="bad small">{error}</p>}
    </section>
  );
}

/** A dump's file name, from its key in the bucket. */
const dumpName = (key: string) => key.split('/').pop() ?? key;

/** What a row of the history did, in a line: what was asked, of what. */
function describeRestore(row: StoreRestore, rows: StoreRestore[]): string {
  if (row.kind === 'moment') return `Wound back to ${row.toAt === null ? 'a moment' : formatMoment(row.toAt)}`;
  if (row.kind === 'load') return `Loaded ${row.dump ? dumpName(row.dump) : 'a dump'}`;
  if (row.undoes === null) return 'Restored to a bookmark';
  const undone = rows.find((r) => r.id === row.undoes);
  if (undone?.kind === 'moment' && undone.toAt !== null) return `Undid the wind-back to ${formatMoment(undone.toAt)}`;
  if (undone?.kind === 'load' && undone.dump) return `Undid the load of ${dumpName(undone.dump)}`;
  return 'Undid an earlier restore';
}

/**
 * Whether a row's undo can still be pressed: a wind-back or a load that finished, that
 * has a bookmark inside its window, and that nothing has undone. Asked of the newest row
 * only (`RestoreHistory` says why).
 */
function undoable(row: StoreRestore, now: number): boolean {
  return (
    (row.kind === 'moment' || row.kind === 'load') &&
    row.state === 'applied' &&
    row.undo !== null &&
    row.undoneBy === null &&
    // From the start, not from `appliedAt`: a load's bookmark is taken as it begins and
    // it finishes minutes later, so near the edge the finish would offer a bookmark the
    // runtime has already let go. The start is never later than the bookmark.
    row.startedAt > now - RESTORE_WINDOW_DAYS * 86_400_000
  );
}

/**
 * Every wind-back, undo and load of the store, newest first, with who asked (migration
 * 0041, MAK-198): so the page is the record of what was done to the account, and a
 * second operator, or the same one a week later, can see it.
 *
 * Only the newest row offers its undo. An undo is a restore to the bookmark taken just
 * before the row's change, so on the newest row it takes back that change and loses only
 * what was written since. On an older row the same bookmark is from before every row
 * above it, and pressing it would throw all of those away too — a wind-back to a moment,
 * under a gentler name. Offering it per row was considered and rejected for that reason:
 * the form above reaches the same place, within a second, under a confirm that says what
 * is lost, so a second way there would only be the easier one to press by mistake. A
 * newest row the store never answered for (`started`) offers nothing either, since the
 * older bookmarks are from before it too (`lib/restores.ts`).
 *
 * Between the wind-back form and the dumps, so a wind-back's undo appears just under
 * the form it came from. The load's own outcome says the undo is up here.
 */
function RestoreHistory({ userId, email, onChanged }: { userId: string; email: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const history = useQuery(accountRestoresQuery(userId));
  // The row whose undo was asked for, by id: a newer row arriving under an open confirm
  // closes it, rather than leaving it pointed at a row that is no longer the newest.
  const [asked, setAsked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState<{ kind: StoreRestore['kind']; result: api.RestoreResult } | null>(null);

  const rows = history.data?.restores ?? [];
  const newest = rows[0];
  const offered = newest && undoable(newest, Date.now()) ? newest : null;

  async function undo(row: StoreRestore) {
    const release = holdPage();
    setBusy(true);
    setError(null);
    setUndone(null);
    try {
      // The row's id goes with it: if another operator has restored or loaded since this
      // list was read, the route refuses rather than throw their change away.
      setUndone({ kind: row.kind, result: await api.restoreStore(userId, { bookmark: row.undo! }, row.id) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      release();
      // Closed either way, as every confirm here is: a second press on a restore that may
      // already have been applied would restore again.
      setAsked(null);
      setBusy(false);
      invalidateStore(queryClient, userId);
      onChanged();
    }
  }

  return (
    <section className="settings-section">
      {/* Not "History": the section above means the platform's thirty days of it, and
          a note's History sheet is another thing again. This is a log of what operators did. */}
      <h3>Restores and loads</h3>
      <p className="muted small">
        Every wind-back, undo and load of this store, newest first, and who asked for it. Only the newest can be undone here: an older
        one&apos;s bookmark is from before everything above it, so to go further back, wind back to a moment.
      </p>

      {history.error ? (
        <p className="bad small">{errorText(history.error)}</p>
      ) : !history.data ? (
        <p className="muted small">Reading the history…</p>
      ) : rows.length === 0 ? (
        <p className="muted small">Nothing has been wound back or loaded.</p>
      ) : (
        <ul className="dump-list">
          {rows.map((row) => {
            const when = row.appliedAt ?? row.startedAt;
            const isOffered = offered?.id === row.id;
            return (
              <li key={row.id} className="dump-row">
                <span className="dump-name">
                  <span>{describeRestore(row, rows)}</span>
                  <span className="muted small">
                    {formatMoment(when)} · {row.operator ? `by ${row.operator.email ?? row.operator.id}` : 'operator not recorded'}
                    {/* A load is `started` for the minutes it streams, so its row cannot say no
                        answer came: the store's own notice above says whether it is loading. */}
                    {row.state === 'started' &&
                      (row.kind === 'load' ? (
                        <> · not finished; the store above says whether it is still loading</>
                      ) : (
                        <> · no answer came back; the Worker log says whether it applied</>
                      ))}
                    {row.state === 'failed' && <> · stopped partway</>}
                    {row.undoneBy !== null && <> · undone</>}
                    {/* A load's way back once its bookmark is gone, or where the runtime gave none. */}
                    {row.kind === 'load' && row.before && <> · the store before it is {dumpName(row.before)}</>}
                    {row === newest && row.kind === 'moment' && row.state === 'applied' && row.undo === null && (
                      <> · its undo bookmark did not survive the restart</>
                    )}
                  </span>
                </span>
                {isOffered && (
                  <span className="dump-actions">
                    <Button variant="quiet" tone="danger" size="small" disabled={busy} onClick={() => setAsked(asked === row.id ? null : row.id)}>
                      Undo
                    </Button>
                  </span>
                )}
                {isOffered &&
                  asked === row.id &&
                  (row.kind === 'load' ? (
                    <UndoLoadConfirm email={email} busy={busy} onCancel={() => setAsked(null)} onConfirm={() => undo(row)} />
                  ) : (
                    <UndoWindBackConfirm email={email} busy={busy} onCancel={() => setAsked(null)} onConfirm={() => undo(row)} />
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {history.data?.more && <p className="muted small">The {RESTORES_LISTED} most recent.</p>}

      {undone && (
        <p className="good small">
          Put back as it was before the {undone.kind === 'load' ? 'load' : 'wind-back'}.
          {undone.result.stats && <> The store now holds {describeCounts(undone.result.stats)}.</>}
        </p>
      )}
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}

type LoadStep = { kind: 'idle' } | { kind: 'previewing'; dump: AccountDump } | { kind: 'preview'; dump: AccountDump; preview: api.LoadPreview };

/**
 * What the last load did, apart from the preview step for the reason `WindBackOutcome`
 * gives. `failed` is a load that emptied the store and did not fill it: the store is
 * refusing every request, and the two ways back the route handed over are kept here
 * and offered, since the Worker log is otherwise the only place they exist.
 */
type LoadOutcome =
  | { kind: 'done'; dump: AccountDump; result: api.LoadResult; undoAsked: boolean }
  | { kind: 'failed'; dump: AccountDump; message: string; undo: string | null; before: string | null; undoAsked: boolean }
  | { kind: 'undone'; result: api.RestoreResult };

/**
 * When a dump's first line says it was taken — `-- Unbent note store of account <id>,
 * dumped <time>` — as the viewer reads a time, or null when the line is not a dump's.
 */
export function dumpedAt(header: string): string | null {
  const raw = /, dumped (\S+)/.exec(header)?.[1];
  if (!raw) return null;
  const formatted = formatMoment(raw);
  return formatted || raw;
}

/**
 * Replace the store with one of its dumps from the backups bucket.
 *
 * The list is what the bucket holds under the account: the daily dumps of the last
 * `DUMPS_KEPT_DAYS`, and the dump the load route writes before it replaces a store, which is
 * how a load is undone once the bookmark's thirty days are up. Anything older is in the
 * mirror alone, and the paragraph under the list gives the command that brings one back,
 * since a dump can only be loaded from this bucket.
 */
function LoadDump({ userId, email, onChanged }: { userId: string; email: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const dumps = useQuery(accountDumpsQuery(userId));
  const [step, setStep] = useState<LoadStep>({ kind: 'idle' });
  const [outcome, setOutcome] = useState<LoadOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    invalidateStore(queryClient, userId);
    void queryClient.invalidateQueries({ queryKey: keys.accountDumps(userId) });
  };

  async function preview(dump: AccountDump) {
    setError(null);
    setStep({ kind: 'previewing', dump });
    try {
      setStep({ kind: 'preview', dump, preview: await api.previewLoad(userId, dump.key) });
    } catch (err) {
      setStep({ kind: 'idle' });
      setError(errorText(err));
    }
  }

  async function load(dump: AccountDump) {
    // Held as `windBack` holds: an archive's load is a dump, then a page per 8 MB, then
    // the finish, and a reload partway leaves the store emptied and refusing.
    const release = holdPage();
    setBusy(true);
    setError(null);
    try {
      const result = await api.loadDump(userId, dump.key);
      setOutcome({ kind: 'done', dump, result, undoAsked: false });
    } catch (err) {
      if (err instanceof LoadFailedError) {
        setOutcome({ kind: 'failed', dump, message: errorText(err), undo: err.undo, before: err.before, undoAsked: false });
      } else {
        setError(errorText(err));
      }
    } finally {
      release();
      // Closed either way, as `windBack` closes its own: the confirm quoted a store that
      // may no longer exist.
      setStep({ kind: 'idle' });
      setBusy(false);
      refresh();
      onChanged();
    }
  }

  // `record` is the history row of the change being undone, sent as `ifNewest` so the
  // press is refused if another operator restored or loaded since; see `RestoreHistory`.
  async function undo(bookmark: string, record?: number) {
    const release = holdPage();
    setBusy(true);
    setError(null);
    try {
      setOutcome({ kind: 'undone', result: await api.restoreStore(userId, { bookmark }, record) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      release();
      // Closed either way, as the load's own confirm is.
      setOutcome((o) => (o && o.kind !== 'undone' ? { ...o, undoAsked: false } : o));
      setBusy(false);
      refresh();
      onChanged();
    }
  }

  const unbound = dumps.error instanceof ApiError && dumps.error.status === 501;

  return (
    <section className="settings-section">
      <h3>Load a dump</h3>
      <p className="muted small">
        Replaces the whole store with a dump from the backups bucket: the way back from a fault noticed after the {RESTORE_WINDOW_DAYS}{' '}
        days of history. The bucket keeps each daily dump {DUMPS_KEPT_DAYS} days. A dump of the store as it stands is written first and listed
        here, so a load can be undone.
      </p>

      {unbound ? (
        <p className="muted small">{errorText(dumps.error)}</p>
      ) : dumps.error ? (
        <p className="bad small">{errorText(dumps.error)}</p>
      ) : !dumps.data ? (
        <p className="muted small">Listing the bucket…</p>
      ) : dumps.data.dumps.length === 0 ? (
        <p className="muted small">No dumps of this account in the bucket yet.</p>
      ) : (
        <ul className="dump-list">
          {dumps.data.dumps.map((d) => (
            <li key={d.key} className="dump-row">
              <span className="dump-name">
                <span>{d.name}</span>
                <span className="muted small">
                  {formatBytes(d.size)} · {timeAgo(d.uploadedAt)}
                </span>
              </span>
              <span className="dump-actions">
                <a href={api.dumpDownloadUrl(userId, d.name)} download>
                  Download
                </a>
                <Button
                  variant="quiet"
                  tone="danger"
                  size="small"
                  disabled={busy || step.kind === 'previewing'}
                  onClick={() => void preview(d)}
                >
                  {step.kind === 'previewing' && step.dump.key === d.key ? 'Reading…' : 'Load'}
                </Button>
              </span>
              {step.kind === 'preview' && step.dump.key === d.key && (
                <Confirm
                  label="Confirm load dump"
                  question={`Replace ${email}'s store with the dump ${d.name}?`}
                  detail={
                    <>
                      {dumpedAt(step.preview.dump.header) ? `Taken ${dumpedAt(step.preview.dump.header)}. ` : ''}
                      {step.preview.dump.oneMoment === false &&
                        'The store was written to while this dump was read, so rows read after the write may be from after it. '}
                      The store now holds {describeCounts(step.preview.current)}, and every one of them is replaced by the dump&apos;s rows.
                      A dump of the store as it stands is written first and appears in this list, so the load can be undone. Every
                      device of the account resyncs from a snapshot.
                    </>
                  }
                  busy={busy}
                  onCancel={() => setStep({ kind: 'idle' })}
                  actions={[{ label: 'Load dump', busyLabel: 'Loading…', tone: 'danger', onConfirm: () => load(d) }]}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {!unbound && (
        <p className="muted small">
          For a dump older than {DUMPS_KEPT_DAYS} days, which the mirror keeps {MIRROR_KEPT_DAYS}, bring it back from the second account first, from a laptop with
          the mirror credential and the dumps bucket&apos;s write key; it then appears in this list. The buckets named are production&apos;s (the
          dev instance&apos;s is <code>unbent-dev-backups</code>):
        </p>
      )}
      {!unbound && (
        <pre className="operator-command">
          <code>{`rclone copy mirror:unbent-mirror/stores/${userId}/ dumps:unbent-backups/stores/${userId}/`}</code>
        </pre>
      )}

      {outcome?.kind === 'done' && (
        <>
          <p className="good small">
            Loaded {outcome.dump.name}. The store now holds {describeCounts(outcome.result.stats)}, and every device of the account resyncs.
            {outcome.result.before && <> The store as it stood is {outcome.result.before.split('/').pop()}, in the list above.</>}
            {outcome.result.migrated.length > 0 && <> Schema files the dump lacked were applied: {outcome.result.migrated.join(', ')}.</>}
            {outcome.result.foreignKeyViolations > 0 && (
              <> {outcome.result.foreignKeyViolations.toLocaleString()} rows point at a parent the dump does not hold.</>
            )}
          </p>
          {/* As the wind-back's outcome: the history's row holds the undo, and this one is
              offered only when that row was not written. */}
          {outcome.result.undo ? (
            outcome.result.recorded ? (
              <p className="muted small">Undo is on its row under Restores and loads, above.</p>
            ) : (
              <>
                <p className="muted small">The history could not record this load, so its undo is offered here instead.</p>
                {!outcome.undoAsked ? (
                  <Button tone="danger" disabled={busy} onClick={() => setOutcome({ ...outcome, undoAsked: true })}>
                    Undo the load
                  </Button>
                ) : (
                  <UndoLoadConfirm email={email} busy={busy} onCancel={() => setOutcome({ ...outcome, undoAsked: false })} onConfirm={() => undo(outcome.result.undo!, outcome.result.record)} />
                )}
              </>
            )
          ) : (
            outcome.result.before && (
              <p className="muted small">This runtime keeps no bookmarks; to undo, load {outcome.result.before.split('/').pop()} from the list above.</p>
            )
          )}
        </>
      )}

      {outcome?.kind === 'failed' && (
        <>
          <p className="bad small">
            Loading {outcome.dump.name} stopped partway: {outcome.message.replace(/^The load failed: /, '').replace(/\.?$/, '.')} The store is
            refusing every request until it is whole again.
            {outcome.before && <> The dump taken before it, {outcome.before.split('/').pop()}, is in the list above; loading it puts the store back.</>}
            {!outcome.undo && !outcome.before && <> Load a dump from the list above to make it whole.</>}
          </p>
          {outcome.undo &&
            (!outcome.undoAsked ? (
              <Button tone="danger" disabled={busy} onClick={() => setOutcome({ ...outcome, undoAsked: true })}>
                Undo the load
              </Button>
            ) : (
              <UndoLoadConfirm
                email={email}
                busy={busy}
                stopped
                onCancel={() => setOutcome({ ...outcome, undoAsked: false })}
                onConfirm={() => undo(outcome.undo!)}
              />
            ))}
        </>
      )}

      {outcome?.kind === 'undone' && (
        <p className="good small">
          Put back as it was before the load.
          {outcome.result.stats && <> The store now holds {describeCounts(outcome.result.stats)}.</>}
        </p>
      )}

      {error && <p className="bad small">{error}</p>}
    </section>
  );
}

/**
 * A new feed epoch: every device of the account starts over from a snapshot. Not
 * destructive — nothing is written to the store and nothing deleted — but it is minutes
 * of copying on every phone the account has, so it is asked, with a neutral confirm
 * rather than a red one.
 */
function Resync({ userId, email }: { userId: string; email: string }) {
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resync() {
    const release = holdPage();
    setBusy(true);
    setError(null);
    try {
      await api.resyncDevices(userId);
      setDone(true);
      setAsked(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      release();
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>Resync devices</h3>
      <p className="muted small">
        Names a new history for the account&apos;s change feed, so every device drops its place in it and copies the library again from a
        snapshot. For a device that is showing something the store does not hold. Nothing is written and nothing is deleted.
      </p>
      <Button disabled={busy} onClick={() => setAsked((v) => !v)}>
        Resync devices
      </Button>
      {asked && (
        <Confirm
          label="Confirm resync devices"
          question={`Resync every device of ${email}?`}
          detail="Each device drops its place in the change feed and copies the library again from a snapshot. Nothing is deleted and nothing is written; on a phone the copy takes minutes."
          busy={busy}
          onCancel={() => setAsked(false)}
          actions={[{ label: 'Resync', busyLabel: 'Resyncing…', tone: 'neutral', onConfirm: resync }]}
        />
      )}
      {done && <p className="good small">Done. Every device of the account will copy the library again.</p>}
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}

/**
 * Deleting the account: for a sign-up that should not exist — a bot, a test account,
 * someone who asked by other means. The same deletion a person makes of their own from
 * Maintenance, by the same server code, without the emailed link that proves an account
 * is theirs.
 *
 * Last on the page, below everything that can be undone, and typed to confirm as
 * "Delete all notes" is, since it is the one action here with no undo at all: a wind-back
 * and a load each record a bookmark to go back to, and this leaves no account to load a
 * dump into. The confirm names what goes from the store's own counts, falling back to
 * the sweep's while those are not in, and says that the dumps stay — they are not
 * deleted, and age out under the bucket's rules.
 *
 * Not offered on the operator's own account, which the server refuses too: that deletion
 * is Maintenance's, with its link, and this one would end the session making it.
 */
/**
 * The account's plan, and the comp (MAK-108): the one way an account is paid for without
 * Paddle — the owner, a gifted friend, someone whose trial ran out mid-import. An end
 * date or none, and the storage to give it; a comp of an account that has a Paddle
 * subscription is refused by the route, and the sentence says so. Ending a comp makes
 * the account read-only at once, which is a confirm: it is someone else's account.
 *
 * Only where the instance sells a plan — the row carries `plan` only then — and drawn
 * above the store's facts, since it is the first thing an operator looking at an
 * account that has written to say it cannot write wants to see.
 */
function PlanSection({ userId, email, plan }: { userId: string; email: string; plan: NonNullable<Account['plan']> }) {
  const queryClient = useQueryClient();
  const { title, sentence } = describePlan(plan, 'operator');
  const [until, setUntil] = useState('');
  const [storageGb, setStorageGb] = useState(String(plan.storageGb));
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const subscribed = plan.subscription !== null && plan.subscription.status !== 'canceled';

  async function send(body: Parameters<typeof api.compAccount>[1]) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api.compAccount(userId, body);
      setEnding(false);
      setDone(body.action === 'end' ? 'Ended. The account is read-only.' : 'Comped.');
      void queryClient.invalidateQueries({ queryKey: keys.operatorAccount(userId) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>Plan</h3>
      <p>
        <strong>{title}.</strong> {sentence}
        {' '}
        <span className="muted">{plan.storageGb} GB of storage.</span>
      </p>
      {subscribed ? (
        <p className="muted small">Paid through Paddle. To comp this account instead, cancel the subscription in Paddle first.</p>
      ) : (
        <div className="operator-row">
          <label>
            <span className="muted">Comp until</span>
            <input type="date" className="search-field" value={until} onChange={(e) => setUntil(e.target.value)} disabled={busy} />
          </label>
          <label>
            <span className="muted">Storage, GB</span>
            <input type="number" className="search-field" min={1} max={10000} value={storageGb} onChange={(e) => setStorageGb(e.target.value)} disabled={busy} />
          </label>
          <Button
            disabled={busy || !/^\d+$/.test(storageGb) || Number(storageGb) < 1}
            onClick={() =>
              void send({
                action: 'comp',
                // End of the chosen day, in this browser's zone, or no end.
                until: until ? new Date(`${until}T23:59:59`).getTime() : null,
                storageGb: Number(storageGb),
              })
            }
          >
            {busy ? 'Saving…' : until ? 'Comp until then' : 'Comp with no end'}
          </Button>
          {plan.source === 'comp' && plan.state === 'active' && !ending && (
            <Button variant="quiet" tone="danger" disabled={busy} onClick={() => setEnding(true)}>
              End comp
            </Button>
          )}
        </div>
      )}
      {ending && (
        <Confirm
          label="Confirm ending the comp"
          question={<>End the comp on {email}?</>}
          detail="The account turns read-only now: everything still opens and exports, and nothing can be edited until they subscribe."
          actions={[{ label: 'End comp', busyLabel: 'Ending…', tone: 'danger', onConfirm: () => send({ action: 'end' }) }]}
          busy={busy}
          onCancel={() => setEnding(false)}
        />
      )}
      {error && <p className="bad small">{error}</p>}
      {done && <p className="good small">{done}</p>}
    </section>
  );
}

function DeleteAccount({
  userId,
  email,
  account,
  stats,
  onDeleted,
}: {
  userId: string;
  email: string;
  account: Account | null;
  stats: api.StoreStats | null;
  onDeleted: (email: string) => void;
}) {
  const queryClient = useQueryClient();
  const { session } = useAppSession();
  const config = useQuery(configQuery());
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session?.user.id === userId) {
    return (
      <section className="settings-section">
        <h3>Delete account</h3>
        {/* Maintenance draws its control only where mail can confirm it; on an instance
            with none, pointing there would send the operator to something that is not drawn. */}
        <p className="muted small">
          This is your own account.{' '}
          {config.data?.accountDeletion === false ? (
            'An account deletes itself with a link sent by email, and this instance cannot send one.'
          ) : (
            <>
              Delete it from <Link to="/settings/maintenance">Maintenance</Link>, which confirms by email.
            </>
          )}
        </p>
      </section>
    );
  }

  // The store's own counts when it can give them; a wiped or loading store reports zeros
  // that are not its size, so the sweep's note count stands in, as `live` does above.
  const counted = stats && !stats.wiped && !stats.loading ? stats : null;
  const notes = counted ? counted.counts['notes'] : account?.noteCount;
  const files = counted ? counted.counts['attachments'] : undefined;
  // Only what there is: "and its 0 files" names nothing, and a bot's account often has neither.
  const what = [notes ? plural(notes, 'note') : null, files ? plural(files, 'file') : null].filter(Boolean).join(' and ');

  async function remove() {
    const release = holdPage();
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(userId);
      // The page says so and stays, as every other action here ends in a line saying it
      // is done; going straight to the list left the operator to read success from a
      // row's absence. The sections that read the store unmount with it, so nothing asks
      // after the wiped store again. The list is refetched without the account.
      onDeleted(email);
      void queryClient.invalidateQueries({ queryKey: keys.operatorAccounts() });
      void queryClient.invalidateQueries({ queryKey: keys.operatorBackups() });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    } finally {
      release();
    }
  }

  return (
    <section className="settings-section">
      <h3>Delete account</h3>
      <p className="muted small">
        Deletes the account, every note and file in it, and every way of signing in to it. There is no undo. Its dumps are not deleted: they
        stay in the backups bucket for {DUMPS_KEPT_DAYS} days and in the mirror for {MIRROR_KEPT_DAYS}.
      </p>
      <Button tone="danger" disabled={busy} onClick={() => setAsked((v) => !v)}>
        Delete account
      </Button>
      {asked && (
        <Confirm
          label="Confirm delete account"
          question={`Delete ${email}${what ? ` and its ${what}` : ''}?`}
          detail={
            <>
              Everything goes now, and anyone signed in to it is signed out within five minutes. There is no undo. Type <code>DELETE</code> to confirm.
            </>
          }
          requireTyped="DELETE"
          busy={busy}
          onCancel={() => setAsked(false)}
          actions={[{ label: 'Delete account', busyLabel: 'Deleting…', tone: 'danger', onConfirm: remove }]}
        />
      )}
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}
