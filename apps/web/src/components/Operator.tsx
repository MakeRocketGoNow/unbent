import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FEEDBACK_CATEGORIES,
  OPERATOR_SEARCH_MAX,
  OPERATOR_SORT_FIRST,
  type AssistantFeedback,
  type BackupsStatus,
  type DumpStatus,
  type MirrorStatus,
  type OperatorAccount,
  type OperatorOrder,
  type OperatorSort,
  type OperatorSortDir,
} from '@unbent/shared';
import { HEALTH_WORD, dumpsHealth, mirrorHealth, type Health } from '../backup-health.js';
import { errorText, setFeedbackRead } from '../notes-api.js';
import { formatBytes } from '../format-bytes.js';
import { formatDay, formatMoment, timeAgo } from './format-when.js';
import { Button } from './Button.js';
import { RowChevronIcon, SortDirectionIcon } from './icons.js';
import { keys, operatorAccountsQuery, operatorBackupsQuery, operatorFeedbackQuery } from '../queries.js';

/**
 * The operator's page (MAK-171, part 5): the backup's health, what connected
 * assistants have said about the tools (MAK-212), then every account on the instance.
 * Operator only: the tab is drawn for a session the backups route answers
 * (`use-operator.ts`), and every route it reads answers anyone else 404.
 *
 * Health first, because it is the question the page exists to answer at a glance:
 * two cards, one per half of the backup, each leading with one word. Feedback next,
 * because it is the other thing here that waits on the operator, and below a list of
 * accounts that pages it would be found only by scrolling past all of them. The
 * accounts are a table of what the directory knows; each row is a link to the account's
 * own page, where the actions live. The actions are not on the rows: each needs a
 * confirm that names the account and what it loses, and a confirm unfolding inside a
 * table row is the layout the issue's "quiet row actions" was warning against, not
 * asking for.
 */
export function Operator({
  search = '',
  onSearch,
  order = {},
  onOrder,
  withDismissed = false,
  onWithDismissed,
}: {
  search?: string;
  onSearch: (q: string) => void;
  /** The accounts' order, as the address holds it: what is left out is the default. */
  order?: OperatorOrder;
  onOrder: (order: OperatorOrder) => void;
  /** Whether the feedback list shows the dismissed reports beside the unread (`?feedback=all`). */
  withDismissed?: boolean;
  onWithDismissed: (shown: boolean) => void;
}) {
  const backups = useQuery(operatorBackupsQuery());
  const feedback = useInfiniteQuery(operatorFeedbackQuery(withDismissed));
  const queryClient = useQueryClient();
  // Read the list again after each dismiss or Undo, so a full page fills from the older
  // rows behind it. Safe because the list keeps every row it has touched (`FeedbackList`):
  // what the refetch brings arrives below, and nothing above it moves.
  const setRead = async (id: number, read: boolean) => {
    await setFeedbackRead(id, read);
    void queryClient.invalidateQueries({ queryKey: keys.operatorFeedback() });
  };
  // The search as asked of the server: trimmed, and once typing settles, as the notes
  // page's is. The address holds every keystroke, so the field stays a plain controlled
  // input; a name typed at speed is still one request, not one a letter.
  const [term, setTerm] = useState(search.trim());
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const accounts = useInfiniteQuery(operatorAccountsQuery(term, order));
  // By id, keeping the first copy: a row whose email changed between pages can come back
  // on a later one (`listOperatorAccounts`), and the copy that stays is the one in the
  // slot it was drawn in, so the column keeps reading in order until the refetch.
  let rows: OperatorAccount[] | undefined;
  if (accounts.data) {
    const seen = new Map<string, OperatorAccount>();
    for (const a of accounts.data.pages.flatMap((p) => p.accounts)) if (!seen.has(a.userId)) seen.set(a.userId, a);
    rows = [...seen.values()];
  }

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
          <BackupHealth status={backups.data} />
        ) : backups.error ? (
          <p className="bad small">{errorText(backups.error)}</p>
        ) : (
          <p className="muted small">Reading the status files…</p>
        )}
      </section>

      <section className="settings-section">
        <h3>Assistant feedback</h3>
        <p className="muted small">
          What assistants connected to an account said about the tools, newest first. Each was told to leave the
          person&apos;s notes out of it. Dismissed or not, it goes after ninety days.
        </p>
        <div className="operator-list-controls">
          <label className="checkbox-row">
            <input type="checkbox" checked={withDismissed} onChange={(e) => onWithDismissed(e.target.checked)} />
            <span>Show dismissed</span>
          </label>
        </div>
        {feedback.data ? (
          <FeedbackList
            // A list of its own for each view: what a press did in one is not what the other shows.
            key={String(withDismissed)}
            rows={feedback.data.pages.flatMap((p) => p.feedback)}
            withDismissed={withDismissed}
            setRead={setRead}
            more={feedback.hasNextPage ? { fetching: feedback.isFetchingNextPage, fetch: () => void feedback.fetchNextPage() } : null}
          />
        ) : feedback.error ? (
          <p className="bad small">{errorText(feedback.error)}</p>
        ) : (
          <p className="muted small">Reading the feedback…</p>
        )}
      </section>

      <section className="settings-section">
        <h3>Accounts</h3>
        <p className="muted small">Notes, size and last change are as of the hourly sweep; an account&apos;s own page reads its store.</p>
        <div className="operator-list-controls">
          <AccountSearch search={search} onSearch={onSearch} />
          <AccountSortPicker order={order} onOrder={onOrder} />
        </div>
        {rows ? (
          <AccountsTable
            accounts={rows}
            search={term}
            order={order}
            onOrder={onOrder}
            stale={accounts.isPlaceholderData}
            // Not while the rows are the last search's: the button would read the new
            // search's first page, not continue the rows on screen.
            more={
              accounts.hasNextPage && !accounts.isPlaceholderData
                ? { fetching: accounts.isFetchingNextPage, fetch: () => void accounts.fetchNextPage() }
                : null
            }
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
export function BackupHealth({ status, now = Date.now() }: { status: BackupsStatus; now?: number }) {
  if (!status.bound) {
    return (
      <p className="muted small">
        Backups are not set up on this instance: no backups bucket is bound, so nothing is dumped and
        nothing is mirrored. The repository&apos;s docs/architecture.md says how, under &ldquo;Where
        your notes live&rdquo;.
      </p>
    );
  }
  // The file names accounts by id; the route attaches their emails, since the list
  // beside it pages and may not hold the account. An id whose `user` row is gone shows
  // as itself: the list could not name it either, since it joins `user` too.
  const nameOf = (id: string) => status.names[id] ?? id;
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
 * The assistants' feedback, one row each: what it is about, what the assistant said, and
 * when, from which app, for which account. The account is a link to its page, as in the
 * table below, since "who was this" is where an operator goes next.
 *
 * Dismiss is the row's one action, quiet as a dense list's actions are, and it deletes
 * nothing (the row is marked read and ages out with the rest), which is why it needs no
 * confirm. In the unread list the row stays where it was as one line with Undo, rather
 * than leaving the list: a dismiss pressed on the wrong row is then undone where the eye
 * already is, and the rows below do not jump up under the pointer. With the dismissed
 * shown (`withDismissed`), nothing leaves: a dismissed report is drawn quieter, says when
 * it was dismissed, and offers Mark unread, and each press only turns the row from one
 * to the other. Every row this list has acted on is kept here with what was last done to
 * it, beside what the query holds, so a refetch (on focus, on the interval) neither takes
 * an Undo away mid-thought nor, once the server has stopped listing the row, loses the
 * row an Undo brings back. They leave when the page does. Rows nobody touched are the
 * query's alone, so an Undo on a list with more behind it can send the newest of the
 * older rows back out of the loaded pages at the bottom: that is paging, far from the
 * pointer, and keeping every row ever shown to stop it would keep the list from ever
 * shrinking back.
 *
 * The body keeps its line breaks: an assistant writing a bug report writes steps.
 */
export function FeedbackList({
  rows: loaded,
  withDismissed = false,
  setRead,
  more,
  now = Date.now(),
}: {
  /** What the query has read, every page of it, newest first. */
  rows: AssistantFeedback[];
  withDismissed?: boolean;
  setRead: (id: number, read: boolean) => Promise<void>;
  /** The next page, while there is one: whether it is being read, and how to ask for it. */
  more: { fetching: boolean; fetch: () => void } | null;
  now?: number;
}) {
  // `at` is when the press here landed, which is when a row it dismissed was dismissed.
  const [touched, setTouched] = useState<ReadonlyMap<number, { row: AssistantFeedback; read: boolean; at: number }>>(new Map());
  // Every request in flight, so a second press before the first answers keeps both disabled.
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [failed, setFailed] = useState<{ id: number; message: string } | null>(null);
  const byId = new Map(loaded.map((f) => [f.id, f] as const));
  for (const [id, { row }] of touched) if (!byId.has(id)) byId.set(id, row);
  const rows = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  // What a press here last did wins over what the query read, which may be from before it.
  const stateOf = (f: AssistantFeedback): { read: boolean; at: number | null } => {
    const t = touched.get(f.id);
    return t ? { read: t.read, at: t.read ? t.at : null } : { read: f.readAt !== null, at: f.readAt };
  };

  async function toggle(row: AssistantFeedback, read: boolean) {
    setBusy((b) => new Set(b).add(row.id));
    setFailed(null);
    try {
      await setRead(row.id, read);
      setTouched((t) => new Map(t).set(row.id, { row, read, at: Date.now() }));
    } catch (err) {
      setFailed({ id: row.id, message: errorText(err) });
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(row.id);
        return next;
      });
    }
  }

  if (rows.length === 0) {
    return (
      <p className="muted small">
        {withDismissed ? 'Nothing in the last ninety days.' : 'Nothing unread.'} When an assistant reports a problem with the tools, it is
        listed here.
      </p>
    );
  }
  return (
    <>
      <ul className="dump-list feedback-list">
        {rows.map((f) => {
          const label = FEEDBACK_CATEGORIES[f.category] ?? f.category;
          // Capitalised where it starts the row's last line, and not inside the sentence a dismissed row is.
          const app = f.clientName || 'An app with no name';
          const appInSentence = f.clientName || 'an app with no name';
          // Which report a button acts on, for a screen reader's list of buttons, where twenty
          // that are all called Dismiss say nothing. It starts with the visible word, so a
          // person who says "click Dismiss" still reaches it.
          const what = `${label.toLowerCase()} from ${appInSentence}`;
          const { read, at: dismissedAt } = stateOf(f);
          if (read && !withDismissed) {
            return (
              <li key={f.id} className="dump-row feedback-row">
                <span className="dump-name">
                  <span className="muted">Dismissed: {what}.</span>
                  {failed?.id === f.id && <span className="bad small">{failed.message}</span>}
                </span>
                <span className="dump-actions">
                  <Button
                    variant="quiet"
                    size="small"
                    aria-label={`Undo dismissing ${what}`}
                    disabled={busy.has(f.id)}
                    onClick={() => void toggle(f, false)}
                  >
                    Undo
                  </Button>
                </span>
              </li>
            );
          }
          return (
            <li key={f.id} className={`dump-row feedback-row${read ? ' feedback-dismissed' : ''}`}>
              <span className="dump-name feedback-text">
                <span className="feedback-about">
                  <strong>{label}</strong>
                  {f.tool && (
                    <>
                      {' '}
                      <span className="muted">in</span> <code className="wrap-anywhere">{f.tool}</code>
                    </>
                  )}
                </span>
                <span className="feedback-body">{f.body}</span>
                <span className="muted small">
                  <span title={formatMoment(f.createdAt)}>{timeAgo(f.createdAt, now)}</span> · {app} for{' '}
                  <Link to="/settings/operator/$userId" params={{ userId: f.userId }}>
                    {f.email ?? f.userId}
                  </Link>
                  {read && (
                    <>
                      {' '}
                      · {dismissedAt === null ? 'dismissed' : <span title={formatMoment(dismissedAt)}>dismissed {timeAgo(dismissedAt, now)}</span>}
                    </>
                  )}
                </span>
                {failed?.id === f.id && <span className="bad small">{failed.message}</span>}
              </span>
              <span className="dump-actions">
                {read ? (
                  <Button variant="quiet" size="small" aria-label={`Mark ${what} unread`} disabled={busy.has(f.id)} onClick={() => void toggle(f, false)}>
                    Mark unread
                  </Button>
                ) : (
                  <Button variant="quiet" size="small" aria-label={`Dismiss ${what}`} disabled={busy.has(f.id)} onClick={() => void toggle(f, true)}>
                    Dismiss
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {more && (
        <p className="operator-more">
          <Button size="small" disabled={more.fetching} onClick={more.fetch}>
            {more.fetching ? 'Reading…' : 'Show more feedback'}
          </Button>
          <span className="muted small"> {rows.length.toLocaleString()} shown</span>
        </p>
      )}
    </>
  );
}

/**
 * The accounts search: a piece of an email or a name, answered by the server, since the
 * list pages and the account looked for may be on a page not yet read. Controlled by the
 * address (`?q=`), so Back from an account's page puts the search back in the field.
 * Escape clears it, as it clears the notes search.
 *
 * Above the table and as wide as an address needs, not the panel's width: it belongs to
 * the list under it, and a field across the whole page read as the page's search.
 */
export function AccountSearch({ search, onSearch }: { search: string; onSearch: (q: string) => void }) {
  return (
    <div className="operator-search">
      <input
        className="search-field"
        type="search"
        value={search}
        placeholder="Search by email or name"
        aria-label="Search accounts"
        maxLength={OPERATOR_SEARCH_MAX}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && search !== '') onSearch('');
        }}
      />
    </div>
  );
}

/** The order asked for, with the defaults filled in: by email, and each sort's first direction. */
export function effectiveOrder(order: OperatorOrder): { sort: OperatorSort; dir: OperatorSortDir } {
  const sort = order.sort ?? 'email';
  return { sort, dir: order.dir ?? OPERATOR_SORT_FIRST[sort] };
}

/**
 * The order for the address, with the defaults left out, so the page as it opens has a
 * plain address and one query key, whichever way it was reached.
 */
export function canonicalOrder(sort: OperatorSort, dir: OperatorSortDir): OperatorOrder {
  return { ...(sort !== 'email' ? { sort } : {}), ...(dir !== OPERATOR_SORT_FIRST[sort] ? { dir } : {}) };
}

/** Pressing a heading: the column it names, or the other way if it is already the one. */
export function nextOrder(current: OperatorOrder, sort: OperatorSort): OperatorOrder {
  const now = effectiveOrder(current);
  if (now.sort !== sort) return canonicalOrder(sort, OPERATOR_SORT_FIRST[sort]);
  return canonicalOrder(sort, now.dir === 'asc' ? 'desc' : 'asc');
}

/** The table's sortable columns, in their order, with how each says its two directions. */
const SORT_COLUMNS: { sort: OperatorSort; label: string; asc: string; desc: string }[] = [
  { sort: 'email', label: 'Account', asc: 'Email, A to Z', desc: 'Email, Z to A' },
  { sort: 'created', label: 'Created', asc: 'Oldest account first', desc: 'Newest account first' },
  { sort: 'notes', label: 'Notes', asc: 'Fewest notes first', desc: 'Most notes first' },
  { sort: 'size', label: 'Size', asc: 'Smallest first', desc: 'Largest first' },
  { sort: 'active', label: 'Last change', asc: 'Changed longest ago first', desc: 'Changed most recently first' },
  { sort: 'dump', label: 'Last dump', asc: 'Oldest dump first', desc: 'Newest dump first' },
];

/**
 * The order as a picker, for a phone, where the table is a column of cards and has no
 * heading row to press. Every column both ways, each said as what comes first, since
 * "Notes, descending" is a spreadsheet's word for "most notes first". Drawn only at the
 * width the headings go (the stylesheet hides it otherwise): on a desktop the headings
 * are the control, and a second one beside them would be two ways to say one thing.
 */
export function AccountSortPicker({ order, onOrder }: { order: OperatorOrder; onOrder: (order: OperatorOrder) => void }) {
  const { sort, dir } = effectiveOrder(order);
  return (
    <label className="operator-sort">
      <span className="muted small">Sort</span>
      <select
        className="search-field"
        value={`${sort}:${dir}`}
        onChange={(e) => {
          const [s, d] = e.target.value.split(':') as [OperatorSort, OperatorSortDir];
          onOrder(canonicalOrder(s, d));
        }}
      >
        {SORT_COLUMNS.flatMap((c) =>
          (c.sort === 'email' ? (['asc', 'desc'] as const) : (['desc', 'asc'] as const)).map((d) => (
            <option key={`${c.sort}:${d}`} value={`${c.sort}:${d}`}>
              {c[d]}
            </option>
          )),
        )}
      </select>
    </label>
  );
}

/**
 * The directory's view of the live accounts, by email unless a heading says otherwise, a
 * page at a time. The order is
 * the address because the address is how an operator finds an account, and it stays put
 * where activity moved every hour. Every heading sorts, by the server, which also
 * searches and pages (`listOperatorAccounts`): a list read a page at a time cannot be
 * sorted by the rows it happens to hold, so a heading that sorted only those would put
 * the largest of the first fifty at the top and call it the largest. Pressed once, a
 * column goes the way its question is usually asked (newest, largest, most first);
 * again, the other way. The table draws what has been
 * read and offers the next page as one button, so an instance with thousands of
 * accounts opens as fast as one with seven. The counts are the last sweep's, which is
 * right across accounts and said in the line under the heading; the account's own page
 * reads the store for live ones.
 *
 * Each row opens the account's page, and says so: the email is the link, and a chevron
 * at the row's end is the sign a row that opens shares with a version in a note's
 * history (`RowChevronIcon`). It is a second way to the same page, so it is out of the
 * tab order and the accessibility tree (one link per row for a keyboard or a reader)
 * and a 44px target on a phone, where the row is a card and the chevron sits alone at its
 * top right. The first version had the email alone, in the page's ink, and nothing told a
 * reader it went anywhere (found in the part 6 rehearsal). The name is drawn only when it
 * says more than the email does; an account whose name is its address showed it twice.
 * Created is the day the account was made, a date rather than "41 days ago", since when
 * someone joined is read as a date. An account with no write recorded says "Never" under
 * Last change, as one never dumped does under Last dump: it used to show when it was made
 * there, muted, which the Created column now says on its own.
 *
 * While a new search is being answered the last answer stays and dims (`stale`), as the
 * note list does between notebooks: emptying to a loading line on every pause in the
 * field made the table jump.
 *
 * The last dump column carries the one thing a glance wants from it: when, or that it
 * failed and why, or that there has never been one. A failed dump is red in the row
 * itself, so the health card's "1 account failed" and the row it means are found with
 * the same eye.
 */
export function AccountsTable({
  accounts,
  more,
  search = '',
  order = {},
  onOrder,
  stale = false,
  now = Date.now(),
}: {
  accounts: OperatorAccount[];
  order?: OperatorOrder;
  onOrder: (order: OperatorOrder) => void;
  /** The next page, while there is one: whether it is being read, and how to ask for it. */
  more: { fetching: boolean; fetch: () => void } | null;
  /** The search these accounts answer, or `''` for every account. */
  search?: string;
  /** Whether these are the last search's accounts while the next one is answered. */
  stale?: boolean;
  now?: number;
}) {
  if (accounts.length === 0) {
    // An empty answer still on screen is the last search's, and says nothing of this one.
    if (stale) return <p className="muted small">Searching…</p>;
    return (
      <p className="muted small wrap-anywhere">
        {search ? <>No account&apos;s email or name has &ldquo;{search}&rdquo; in it.</> : 'No accounts yet.'}
      </p>
    );
  }
  const current = effectiveOrder(order);
  return (
    <div className="operator-table-wrap" aria-busy={stale}>
      <table className="operator-table">
        <thead>
          <tr>
            {SORT_COLUMNS.map((c) => {
              const state = current.sort === c.sort ? current.dir : null;
              return (
                <th key={c.sort} scope="col" aria-sort={state === 'asc' ? 'ascending' : state === 'desc' ? 'descending' : undefined}>
                  <button
                    type="button"
                    className="note-th-sort"
                    // The direction is in the name, as the notes table's are: the arrow is not read aloud.
                    aria-label={`Sort by ${c.label}${state ? `, ${state === 'asc' ? 'ascending' : 'descending'}` : ''}`}
                    onClick={() => onOrder(nextOrder(order, c.sort))}
                  >
                    {c.label}
                    {state && <SortDirectionIcon direction={state} />}
                  </button>
                </th>
              );
            })}
            <th scope="col" aria-hidden="true" />
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
              <td data-label="Created">
                <span title={formatMoment(a.createdAt)}>{formatDay(a.createdAt)}</span>
              </td>
              <td data-label="Notes">{a.noteCount.toLocaleString()}</td>
              <td data-label="Size">{formatBytes(a.storageBytes)}</td>
              <td data-label="Last change">
                {a.lastActiveAt ? (
                  <span title={formatMoment(a.lastActiveAt)}>{timeAgo(a.lastActiveAt, now)}</span>
                ) : (
                  <span className="muted">Never</span>
                )}
              </td>
              <td data-label="Last dump">
                <LastDump account={a} now={now} />
              </td>
              <td className="operator-open">
                <Link to="/settings/operator/$userId" params={{ userId: a.userId }} className="operator-open-link" tabIndex={-1} aria-hidden="true">
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
