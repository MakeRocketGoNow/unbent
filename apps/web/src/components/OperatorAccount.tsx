import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RESTORE_WINDOW_DAYS, type AccountDump, type OperatorAccount as Account } from '@unbent/shared';
import * as api from '../notes-api.js';
import { ApiError, LoadFailedError, errorText } from '../notes-api.js';
import { formatBytes } from '../format-bytes.js';
import { formatMoment, timeAgo } from '../format-time.js';
import { accountDumpsQuery, keys, operatorAccountsQuery, storeStatsQuery } from '../queries.js';
import { Button } from './Button.js';
import { Confirm } from './Confirm.js';
import { LastDump } from './Operator.js';

/**
 * How long a deleted file's object is kept in the live bucket after its row goes: the
 * sweep's `deleted_blobs` window (part 1 of MAK-171), stated here so a wind-back's reach
 * is honest about its files. The constant lives in the API's sweep; the page states
 * the number and nothing enforces it here.
 */
const DELETED_FILES_KEPT_DAYS = 35;

/** The mirror's lifecycle rule on `stores/`, set by hand on the bucket; stated, not enforced. */
const MIRROR_KEPT_DAYS = 90;

/**
 * One account, for the operator: what the directory and its store say of it, its dumps,
 * and the three things an operator can do to it. Every action goes through `Confirm`
 * with the account and the blast radius named, in the order of how much each loses.
 *
 * Each action is the route it drives and nothing more. The dry run is a press of its own
 * — Preview — and what it shows is what the confirm then names: the moment resolved to a
 * bookmark and the counts the store holds now, or the dump's own first line and whether
 * its rows are one moment. The confirm repeats the request with the word the route
 * wants, and the answer's undo bookmark is kept beside the result as a second
 * confirm, so a wind-back to the wrong moment is one more press rather than a request
 * written by hand from the Worker log.
 *
 * Downloads are links: a dump is a file, and a link to a file middle-clicks, copies and
 * saves with the browser's own download, which a button cannot do.
 */
export function OperatorAccount({ userId }: { userId: string }) {
  const accounts = useQuery(operatorAccountsQuery());
  const account = accounts.data?.find((a) => a.userId === userId) ?? null;
  const stats = useQuery(storeStatsQuery(userId));

  if (accounts.data && !account) {
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
      <p>
        <Link to="/settings/operator">All accounts</Link>
      </p>
      <div className="panel-head">
        <h2 className="wrap-anywhere">{account?.email ?? userId}</h2>
      </div>

      {account && <AccountFacts account={account} />}

      <section className="settings-section">
        <h3>Store</h3>
        <StoreFacts stats={stats.data ?? null} error={stats.error} />
        <p>
          <a href={api.storeDumpUrl(userId)} download>
            Download the store as it is now
          </a>
          <span className="muted"> · SQL, every table</span>
        </p>
      </section>

      <WindBack userId={userId} email={account?.email ?? userId} />
      <LoadDump userId={userId} email={account?.email ?? userId} />
      <Resync userId={userId} email={account?.email ?? userId} />
    </div>
  );
}

function AccountFacts({ account }: { account: Account }) {
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
        <dd>{account.lastActiveAt ? `${timeAgo(account.lastActiveAt)} · ${formatMoment(account.lastActiveAt)}` : <span className="muted">None recorded</span>}</dd>
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
function StoreFacts({ stats, error }: { stats: api.StoreStats | null; error: Error | null }) {
  if (error) return <p className="bad small">{errorText(error)}</p>;
  if (!stats) return <p className="muted small">Reading the store…</p>;
  if (stats.loading) {
    return (
      <p className="bad small">
        Loading {stats.loading.key} since {formatMoment(stats.loading.startedAt)}, {stats.loading.pages} pages so far, and refusing every
        request until it is whole. If the load that started it has ended, load a dump again below: the one it was loading, or the
        before-load dump it wrote first. The Worker log&apos;s &quot;load for user&quot; lines have its undo bookmark.
      </p>
    );
  }
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
 * Wind the store back to a moment in the last thirty days.
 *
 * Preview is the first step and a press of its own, because the confirm has to name what
 * the store holds now and the route's dry run is where that comes from — and because a
 * moment outside the window is refused there, before anything is at stake. The confirm
 * names the account, the moment, and what is lost: everything written after it. The
 * answer keeps the undo bookmark as a second confirm beside the result.
 *
 * Where the runtime keeps no history — `wrangler dev` — the route answers 501, and the
 * section says so in place of the control rather than offering a preview that fails.
 */
function WindBack({ userId, email }: { userId: string; email: string }) {
  const queryClient = useQueryClient();
  // Read once: the input's bounds should not move under it on every render.
  const [now] = useState(() => Date.now());
  const [at, setAt] = useState(() => toLocalInput(now - 3_600_000));
  const [step, setStep] = useState<WindBackStep>({ kind: 'idle' });
  const [outcome, setOutcome] = useState<WindBackOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.storeStats(userId) });
    void queryClient.invalidateQueries({ queryKey: keys.operatorAccounts() });
  };

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
    setBusy(true);
    setError(null);
    try {
      const result = await api.restoreStore(userId, { at: ms });
      setStep({ kind: 'idle' });
      setOutcome({ kind: 'done', at: ms, result, undoAsked: false });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function undo(bookmark: string) {
    setBusy(true);
    setError(null);
    try {
      setOutcome({ kind: 'undone', result: await api.restoreStore(userId, { bookmark }) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      refresh();
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
              account resyncs from a snapshot. Undo is offered afterwards, and the bookmark it uses lasts {RESTORE_WINDOW_DAYS} days.
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
          {outcome.result.undo ? (
            !outcome.undoAsked ? (
              <Button tone="danger" disabled={busy} onClick={() => setOutcome({ ...outcome, undoAsked: true })}>
                Undo the wind-back
              </Button>
            ) : (
              <Confirm
                label="Confirm undo wind back"
                question={`Put ${email} back as it was before the wind-back?`}
                detail={
                  <>
                    Restores to the bookmark the wind-back returned, which is the store as it stood just before it. Anything written
                    since the wind-back is lost, and every device resyncs again.
                  </>
                }
                busy={busy}
                onCancel={() => setOutcome({ ...outcome, undoAsked: false })}
                actions={[{ label: 'Undo the wind-back', busyLabel: 'Restoring…', tone: 'danger', onConfirm: () => undo(outcome.result.undo!) }]}
              />
            )
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
 * fourteen days, and the dump the load route writes before it replaces a store, which is
 * how a load is undone once the bookmark's thirty days are up. Anything older is in the
 * mirror alone, and the paragraph under the list gives the command that brings one back,
 * since a dump can only be loaded from this bucket.
 */
function LoadDump({ userId, email }: { userId: string; email: string }) {
  const queryClient = useQueryClient();
  const dumps = useQuery(accountDumpsQuery(userId));
  const [step, setStep] = useState<LoadStep>({ kind: 'idle' });
  const [outcome, setOutcome] = useState<LoadOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.storeStats(userId) });
    void queryClient.invalidateQueries({ queryKey: keys.accountDumps(userId) });
    void queryClient.invalidateQueries({ queryKey: keys.operatorAccounts() });
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
    setBusy(true);
    setError(null);
    try {
      const result = await api.loadDump(userId, dump.key);
      setStep({ kind: 'idle' });
      setOutcome({ kind: 'done', dump, result, undoAsked: false });
    } catch (err) {
      if (err instanceof LoadFailedError) {
        setStep({ kind: 'idle' });
        setOutcome({ kind: 'failed', dump, message: errorText(err), undo: err.undo, before: err.before, undoAsked: false });
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function undo(bookmark: string) {
    setBusy(true);
    setError(null);
    try {
      setOutcome({ kind: 'undone', result: await api.restoreStore(userId, { bookmark }) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const unbound = dumps.error instanceof ApiError && dumps.error.status === 501;
  // The route says how long the bucket keeps a dump; 14 is only the sentence's number until it has answered.
  const keptDays = dumps.data?.keptDays ?? 14;

  return (
    <section className="settings-section">
      <h3>Load a dump</h3>
      <p className="muted small">
        Replaces the whole store with a dump from the backups bucket: the way back from a fault noticed after the {RESTORE_WINDOW_DAYS}{' '}
        days of history. The bucket keeps each daily dump {keptDays} days. A dump of the store as it stands is written first and listed
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
          For a dump older than {keptDays} days, which the mirror keeps {MIRROR_KEPT_DAYS}, bring it back from the second account first, from a laptop with
          the mirror credential and the dumps bucket&apos;s write key; it then appears in this list:
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
          {outcome.result.undo ? (
            !outcome.undoAsked ? (
              <Button tone="danger" disabled={busy} onClick={() => setOutcome({ ...outcome, undoAsked: true })}>
                Undo the load
              </Button>
            ) : (
              <Confirm
                label="Confirm undo load"
                question={`Put ${email}'s store back as it was before the load?`}
                detail={
                  <>
                    Winds back to the bookmark the load took as it began, the store as it stood just before it was emptied. Anything
                    written since the load is lost, and every device resyncs again.
                  </>
                }
                busy={busy}
                onCancel={() => setOutcome({ ...outcome, undoAsked: false })}
                actions={[{ label: 'Undo the load', busyLabel: 'Restoring…', tone: 'danger', onConfirm: () => undo(outcome.result.undo!) }]}
              />
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
            The load of {outcome.dump.name} failed: {outcome.message} The store is empty and refusing every request until it is whole again.
            {outcome.before && <> The dump taken before it, {outcome.before.split('/').pop()}, is in the list above; loading it puts the store back.</>}
            {!outcome.undo && !outcome.before && <> Load a dump from the list above to make it whole.</>}
          </p>
          {outcome.undo &&
            (!outcome.undoAsked ? (
              <Button tone="danger" disabled={busy} onClick={() => setOutcome({ ...outcome, undoAsked: true })}>
                Undo the load
              </Button>
            ) : (
              <Confirm
                label="Confirm undo load"
                question={`Put ${email}'s store back as it was before the load?`}
                detail="Winds back to the bookmark the load took as it began, the store as it stood just before it was emptied. Every device resyncs."
                busy={busy}
                onCancel={() => setOutcome({ ...outcome, undoAsked: false })}
                actions={[{ label: 'Undo the load', busyLabel: 'Restoring…', tone: 'danger', onConfirm: () => undo(outcome.undo!) }]}
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
    setBusy(true);
    setError(null);
    try {
      await api.resyncDevices(userId);
      setDone(true);
      setAsked(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
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
      <Button disabled={busy} onClick={() => setAsked(true)}>
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
