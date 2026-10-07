import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { BackupsStatus, DumpStatus, MirrorStatus, OperatorAccount } from '@unbent/shared';
import { HEALTH_WORD, dumpsHealth, mirrorHealth, type Health } from '../backup-health.js';
import { errorText } from '../notes-api.js';
import { formatBytes } from '../format-bytes.js';
import { formatMoment, timeAgo } from './format-when.js';
import { Button } from './Button.js';
import { RowChevronIcon } from './icons.js';
import { operatorAccountsQuery, operatorBackupsQuery } from '../queries.js';

/**
 * The operator's page (MAK-171, part 5): the backup's health, then every account on the
 * instance. Operator only — the tab is drawn for a session the backups route answers
 * (`use-operator.ts`), and every route it reads answers anyone else 404.
 *
 * Health first, because it is the question the page exists to answer at a glance:
 * two cards, one per half of the backup, each leading with one word. The accounts are
 * a table of what the directory knows; each row is a link to the account's own page,
 * where the three actions live. The actions are not on the rows: each needs a confirm
 * that names the account and what it loses, and a confirm unfolding inside a table row
 * is the layout the issue's "quiet row actions" was warning against, not asking for.
 */
export function Operator() {
  const backups = useQuery(operatorBackupsQuery());
  const accounts = useInfiniteQuery(operatorAccountsQuery());
  const rows = accounts.data?.pages.flatMap((p) => p.accounts);

  return (
    <div className="panel operator-page">
      <div className="panel-head">
        <h2>Operator</h2>
      </div>
      <p className="muted small">
        The backup of this instance, and the accounts on it. Everything here reads other people&apos;s
        accounts, and every read is logged with both ids.
      </p>

      <section className="settings-section">
        <h3>Backup health</h3>
        {backups.data === null ? (
          // Someone who is not an operator typed the address: the tab was never drawn for them.
          <p className="muted small">Not found.</p>
        ) : backups.data ? (
          <BackupHealth status={backups.data} accounts={rows} />
        ) : backups.error ? (
          <p className="bad small">{errorText(backups.error)}</p>
        ) : (
          <p className="muted small">Reading the status files…</p>
        )}
      </section>

      <section className="settings-section">
        <h3>Accounts</h3>
        <p className="muted small">Notes, size and last change are as of the hourly sweep; an account&apos;s own page reads its store.</p>
        {rows ? (
          <AccountsTable
            accounts={rows}
            more={accounts.hasNextPage ? { fetching: accounts.isFetchingNextPage, fetch: () => void accounts.fetchNextPage() } : null}
          />
        ) : accounts.error ? (
          <p className="bad small">{errorText(accounts.error)}</p>
        ) : (
          <p className="muted small">Reading the directory…</p>
        )}
      </section>
    </div>
  );
}

/**
 * The two halves of the backup, or the one sentence for an instance that has neither.
 *
 * An unbound bucket is not a bad state: a fork that arranges its own backups, or a local
 * checkout, has nothing to dump into and nothing to report. Saying so in words, with
 * nothing drawn beside it, is what keeps it from reading as a backup that has failed.
 */
export function BackupHealth({ status, accounts, now = Date.now() }: { status: BackupsStatus; accounts?: OperatorAccount[]; now?: number }) {
  if (!status.bound) {
    return (
      <p className="muted small">
        Backups are not set up on this instance: no backups bucket is bound, so nothing is dumped and
        nothing is mirrored. The README&apos;s &ldquo;Where your notes live&rdquo; says how.
      </p>
    );
  }
  // The file names accounts by id; the table beside it names them by email.
  const nameOf = (id: string) => accounts?.find((a) => a.userId === id)?.email ?? id;
  return (
    <div className="health-cards">
      <DumpsCard status={status.dumps} now={now} nameOf={nameOf} />
      <MirrorCard status={status.mirror} now={now} />
    </div>
  );
}

/**
 * One half of the backup: the word, when it ran, what it did, and why if the word is a
 * bad one. The word is the card's first line and its colour, and the counts are a
 * definition list, because an operator reading "3 dumped, 12 unchanged" wants to land
 * on a number, not parse a sentence.
 */
function HealthCard({
  title,
  health,
  ranAt,
  now,
  children,
}: {
  title: string;
  health: Health;
  ranAt: string | null;
  now: number;
  children?: ReactNode;
}) {
  return (
    <section className={`health-card health-${health.state}`} aria-label={`${title}: ${HEALTH_WORD[health.state]}`}>
      <div className="health-head">
        <span className="health-dot" aria-hidden="true" />
        <span className="health-word">{HEALTH_WORD[health.state]}</span>
        <span className="health-title">{title}</span>
      </div>
      {ranAt && (
        <p className="health-when">
          Ran {timeAgo(ranAt, now)}
          <span className="muted"> · {formatMoment(ranAt)}</span>
        </p>
      )}
      {children}
      {health.reasons.length > 0 && (
        <ul className="health-reasons">
          {health.reasons.map((r, i) => (
            <li key={i} className="wrap-anywhere">
              {r}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DumpsCard({ status, now, nameOf }: { status: DumpStatus | null; now: number; nameOf: (id: string) => string }) {
  const health = dumpsHealth(status, now, nameOf);
  return (
    <HealthCard title="Daily dumps" health={health} ranAt={status?.ranAt ?? null} now={now}>
      {status ? (
        <dl className="health-facts">
          <Fact term="Dumped">
            {status.run.dumped.toLocaleString()}
            {status.run.bytes > 0 && <span className="muted"> · {formatBytes(status.run.bytes)}</span>}
          </Fact>
          <Fact term="Unchanged">{status.run.unchanged.toLocaleString()}</Fact>
          <Fact term="Accounts">{status.accounts.toLocaleString()}</Fact>
          {status.run.deferred > 0 && <Fact term="Deferred">{status.run.deferred.toLocaleString()}</Fact>}
        </dl>
      ) : (
        <p className="muted small">No dump run has written a status yet. The first runs at 47 minutes past the hour.</p>
      )}
    </HealthCard>
  );
}

function MirrorCard({ status, now }: { status: MirrorStatus | null; now: number }) {
  const health = mirrorHealth(status, now);
  return (
    <HealthCard title="Nightly mirror" health={health} ranAt={status?.ranAt ?? null} now={now}>
      {status ? (
        <>
          <dl className="health-facts">
            <Fact term="Files">
              {n(status.blobs.copied)} copied
              {status.blobs.live !== null && status.blobs.mirror !== null && (
                <span className="muted">
                  {' '}
                  · {status.blobs.live.toLocaleString()} live, {status.blobs.mirror.toLocaleString()} mirrored
                </span>
              )}
            </Fact>
            <Fact term="Dumps">{n(status.stores.copied)} copied</Fact>
            <Fact term="D1">{status.d1 ? formatBytes(status.d1.bytes) : 'not exported'}</Fact>
            {status.prune && (
              <Fact term="Pruned">
                {status.prune.pruned.toLocaleString()}
                <span className="muted"> · {status.prune.gone.toLocaleString()} gone from live</span>
              </Fact>
            )}
          </dl>
          {status.run.url && (
            <p>
              <a href={status.run.url} rel="noopener noreferrer">
                The run on GitHub
              </a>
            </p>
          )}
        </>
      ) : (
        <p className="muted small">The mirror has not run yet. It runs each night from GitHub, and can be dispatched by hand.</p>
      )}
    </HealthCard>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const n = (v: number | null) => (v === null ? '?' : v.toLocaleString());

/**
 * The directory's view of the live accounts, newest activity first, a page at a time.
 * The server orders and pages (`listOperatorAccounts`); the table draws what has been
 * read and offers the next page as one button, so an instance with thousands of
 * accounts opens as fast as one with seven. The counts are the last sweep's, which is
 * right across accounts and said in the line under the heading; the account's own page
 * reads the store for live ones.
 *
 * Each row opens the account's page, and says so: the email is the link, and a chevron
 * at the row's end is the sign a row that opens shares with a version in a note's
 * history (`RowChevronIcon`). On a phone the row is a card and the chevron sits at its
 * top right. The first version had the email alone, in the page's ink, and nothing told a
 * reader it went anywhere (found in the part 6 rehearsal). The name is drawn only when it
 * says more than the email does; an account whose name is its address showed it twice.
 *
 * The last dump column carries the one thing a glance wants from it: when, or that it
 * failed and why, or that there has never been one. A failed dump is red in the row
 * itself, so the health card's "1 account failed" and the row it means are found with
 * the same eye.
 */
export function AccountsTable({
  accounts,
  more,
  now = Date.now(),
}: {
  accounts: OperatorAccount[];
  /** The next page, while there is one: whether it is being read, and how to ask for it. */
  more: { fetching: boolean; fetch: () => void } | null;
  now?: number;
}) {
  if (accounts.length === 0) return <p className="muted small">No accounts yet.</p>;
  return (
    <div className="operator-table-wrap">
      <table className="operator-table">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Notes</th>
            <th scope="col">Size</th>
            <th scope="col">Last change</th>
            <th scope="col">Last dump</th>
            <th scope="col">
              <span className="visually-hidden">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.userId}>
              <td data-label="Account">
                <Link to="/settings/operator/$userId" params={{ userId: a.userId }} className="operator-account-link">
                  <span className="wrap-anywhere">{a.email}</span>
                  {a.name && a.name.trim().toLowerCase() !== a.email.trim().toLowerCase() && <span className="muted small"> · {a.name}</span>}
                </Link>
              </td>
              <td data-label="Notes">{a.noteCount.toLocaleString()}</td>
              <td data-label="Size">{formatBytes(a.storageBytes)}</td>
              <td data-label="Last change">
                {a.lastActiveAt ? <span title={formatMoment(a.lastActiveAt)}>{timeAgo(a.lastActiveAt, now)}</span> : <span className="muted">—</span>}
              </td>
              <td data-label="Last dump">
                <LastDump account={a} now={now} />
              </td>
              <td className="operator-open">
                <Link to="/settings/operator/$userId" params={{ userId: a.userId }} className="operator-open-link" aria-label={`Open ${a.email}`}>
                  <RowChevronIcon />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more && (
        <p className="operator-more">
          <Button size="small" disabled={more.fetching} onClick={more.fetch}>
            {more.fetching ? 'Reading…' : 'Show more accounts'}
          </Button>
          <span className="muted small"> {accounts.length.toLocaleString()} shown</span>
        </p>
      )}
    </div>
  );
}

/** One account's last dump, as the row and the account page both say it. */
export function LastDump({ account, now = Date.now() }: { account: OperatorAccount; now?: number }) {
  const { dump } = account;
  if (dump.error) {
    return (
      <span className="dump-failed">
        <span className="bad">Failed{dump.triedAt ? ` ${timeAgo(dump.triedAt, now)}` : ''}</span>
        <span className="muted small dump-error wrap-anywhere">{dump.error}</span>
      </span>
    );
  }
  if (dump.at === null) return <span className="muted">Never</span>;
  return (
    <span title={formatMoment(dump.at)}>
      {timeAgo(dump.at, now)}
      {dump.bytes !== null && <span className="muted small"> · {formatBytes(dump.bytes)}</span>}
    </span>
  );
}
