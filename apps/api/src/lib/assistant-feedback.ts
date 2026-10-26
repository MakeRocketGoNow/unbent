import type { AssistantFeedback, AssistantFeedbackPage, FeedbackCategory } from '@unbent/shared';

/**
 * An assistant's feedback on the tools, kept for the operator (MAK-212; migration 0047).
 *
 * After Axiom's `sendFeedback`: an assistant working through the MCP tools is the only
 * one who sees a tool answer the wrong thing, an error that gives no way forward, or a
 * capability that is not there. The person sees only that it struggled, and is not going
 * to write in about a tool description. So the assistant is given a tool to say so, and
 * what it says lands on the operator page, unread until someone reads it.
 *
 * In D1 rather than the account's note store, because it is the operator's to read across
 * accounts, which the stores are deliberately not built for; and rather than the Worker
 * log, which `client-errors` uses, because a log line is kept a week at most and is read
 * only by someone who goes looking. Rather than mail, because the instance's mail
 * allowance is the sign-in codes' (`code-sends.ts`), and a talkative assistant must not
 * be able to spend it.
 *
 * Bounded four ways, since anything an account can write in a loop has to be: a day's
 * worth per account (`FEEDBACK_PER_DAY`); a day's worth for the whole instance
 * (`FEEDBACK_PER_DAY_INSTANCE`); no repeat of what the account's assistants already sent
 * that day, word for word; and an age (`FEEDBACK_KEPT_MS`), pruned on the write that adds
 * a row, as note history prunes, with no cron. The first three are checked in the
 * insert's own condition, so two calls at once cannot both pass. The repeat is there
 * because a model that has lost track of having sent something sends it again, and
 * twenty copies of one report (what a stuck loop sends before the day's bound stops it)
 * buried everything else on the operator's list when the first version was tried.
 */

/**
 * Feedback one account's assistants may send in a rolling day. Far past what an
 * assistant reporting real problems sends (a session that hits five distinct problems is
 * a bad session) and far short of a loop: a model stuck retrying the call is stopped at
 * twenty rows, not a thousand.
 */
export const FEEDBACK_PER_DAY = 20;

/**
 * Feedback the whole instance keeps in a rolling day. The account's bound alone lets
 * many accounts write without end, into the D1 database that also holds every sign-in,
 * and a fork on Workers Free has half a gigabyte of it: a few dozen throwaway accounts
 * with a connected client, at twenty reports of two thousand characters a day kept for
 * ninety days, would fill it. Five hundred a day is more than any operator reads, and at
 * most about a hundred megabytes over the ninety days. Spending it costs a day of
 * feedback, never a sign-in.
 */
export const FEEDBACK_PER_DAY_INSTANCE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a row is kept, read or not: long enough that an operator back from a few
 * weeks away has not missed anything, and short enough that the table never holds an
 * account's history of what it was doing. The privacy policy states the same number.
 */
export const FEEDBACK_KEPT_MS = 90 * DAY_MS;

/**
 * How many unread rows the operator page lists at once: a few screens of reports above
 * the accounts, where fifty, the first number tried, would put them a long way down.
 */
export const FEEDBACK_LISTED = 20;

/** The slice of D1 this reads and writes, so the test can run it over node's SQLite. */
export interface FeedbackDb {
  prepare(sql: string): { bind(...values: unknown[]): FeedbackStatement };
  batch(statements: FeedbackStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}

export interface FeedbackStatement {
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface NewFeedback {
  userId: string;
  clientId: string;
  category: FeedbackCategory;
  tool: string | null;
  body: string;
}

/**
 * What became of a piece of feedback: kept, or refused as a repeat of the day's, past the
 * account's day's bound (`limit`), or past the instance's (`full`).
 */
export type FeedbackOutcome = 'kept' | 'repeat' | 'limit' | 'full';

/**
 * Keeps one piece of feedback, unless the account has sent the same words or its day's
 * worth in the last day, or the instance has taken its day's worth.
 *
 * One batch, so one round trip and one transaction: the prune, then an insert whose
 * `WHERE` is every bound. Checked in the statement rather than read first, so two calls
 * in flight cannot both find nineteen and both write. The client's name is copied in the
 * same statement from the row it registered, since a deleted client takes that row with
 * it and the page would be left with an opaque id. The instance's count reads at most its
 * bound's rows, on the age index. A refusal reads once more to say which bound it was,
 * so the model is told the right thing; only a refusal pays for that.
 */
export async function recordFeedback(db: FeedbackDb, feedback: NewFeedback, now = Date.now()): Promise<FeedbackOutcome> {
  const since = now - DAY_MS;
  const [, inserted] = await db.batch([
    db.prepare(`DELETE FROM assistant_feedback WHERE created_at < ?1`).bind(now - FEEDBACK_KEPT_MS),
    db
      .prepare(
        `INSERT INTO assistant_feedback (user_id, client_id, client_name, category, tool, body, created_at)
         SELECT ?1, ?2, (SELECT name FROM oauthClient WHERE clientId = ?2), ?3, ?4, ?5, ?6
         WHERE (SELECT COUNT(*) FROM assistant_feedback WHERE user_id = ?1 AND created_at > ?7) < ?8
           AND NOT EXISTS (SELECT 1 FROM assistant_feedback WHERE user_id = ?1 AND created_at > ?7 AND body = ?5)
           AND (SELECT COUNT(*) FROM (SELECT 1 FROM assistant_feedback WHERE created_at > ?7 LIMIT ?9)) < ?9`,
      )
      .bind(
        feedback.userId,
        feedback.clientId,
        feedback.category,
        feedback.tool,
        feedback.body,
        now,
        since,
        FEEDBACK_PER_DAY,
        FEEDBACK_PER_DAY_INSTANCE,
      ),
  ]);
  if ((inserted?.meta.changes ?? 0) > 0) return 'kept';
  const { results } = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM assistant_feedback WHERE user_id = ?1 AND created_at > ?2 AND body = ?3) AS repeat,
              (SELECT COUNT(*) FROM assistant_feedback WHERE user_id = ?1 AND created_at > ?2) AS sent`,
    )
    .bind(feedback.userId, since, feedback.body)
    .all<{ repeat: number; sent: number }>();
  const [why] = results;
  if (why?.repeat) return 'repeat';
  return (why?.sent ?? 0) >= FEEDBACK_PER_DAY ? 'limit' : 'full';
}

interface FeedbackRow {
  id: number;
  user_id: string;
  email: string | null;
  client_id: string;
  client_name: string | null;
  category: FeedbackCategory;
  tool: string | null;
  body: string;
  created_at: number;
  read_at: number | null;
}

/** Where a page of the list ends: the last row's `created_at` and `id`, as `next` carries them. */
export type FeedbackCursor = { createdAt: number; id: number };

/** `next` as the page sends it back: `<created_at>.<id>`. Anything else reads as the first page. */
export function parseFeedbackCursor(raw: string | undefined): FeedbackCursor | null {
  const match = /^(\d{1,16})\.(\d{1,16})$/.exec(raw ?? '');
  if (!match) return null;
  const createdAt = Number(match[1]);
  const id = Number(match[2]);
  return Number.isSafeInteger(createdAt) && Number.isSafeInteger(id) ? { createdAt, id } : null;
}

/**
 * A page of the unread rows, or with `withDismissed` of every row, dismissed or not,
 * newest first, with each account's address. One more than the page is read to say
 * whether there are more, rather than a count, which would read every row of the view to
 * answer a question the page asks only as "is there more". `after` continues from the
 * last page's end, by age and then id, so two reports sent in the same millisecond are
 * neither skipped nor listed twice.
 *
 * The unread view goes in by the partial index of unread rows, and the whole list by the
 * plain age index; each reads only the rows it returns.
 *
 * A left join, so a row is never hidden because its account is gone: the cascade should
 * have taken it, and a row that survived it is worth seeing rather than counting
 * silently against nothing.
 */
export async function listFeedback(
  db: FeedbackDb,
  {
    withDismissed = false,
    after = null,
    limit = FEEDBACK_LISTED,
  }: { withDismissed?: boolean; after?: FeedbackCursor | null; limit?: number } = {},
): Promise<AssistantFeedbackPage> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.user_id, u.email, f.client_id, f.client_name, f.category, f.tool, f.body, f.created_at, f.read_at
       FROM assistant_feedback f LEFT JOIN user u ON u.id = f.user_id
       WHERE ${withDismissed ? '' : 'f.read_at IS NULL AND '}(f.created_at, f.id) < (?2, ?3)
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT ?1`,
    )
    .bind(limit + 1, after?.createdAt ?? Number.MAX_SAFE_INTEGER, after?.id ?? Number.MAX_SAFE_INTEGER)
    .all<FeedbackRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return {
    feedback: page.map(
      (r): AssistantFeedback => ({
        id: r.id,
        userId: r.user_id,
        email: r.email,
        clientId: r.client_id,
        clientName: r.client_name,
        category: r.category,
        tool: r.tool,
        body: r.body,
        createdAt: r.created_at,
        readAt: r.read_at,
      }),
    ),
    next: results.length > limit && last ? `${last.created_at}.${last.id}` : null,
  };
}

/**
 * Dismisses a row from the page, or brings it back (`read: false`, the page's Undo).
 * Answers whether the row exists.
 */
export async function markFeedbackRead(db: FeedbackDb, id: number, read: boolean, now = Date.now()): Promise<boolean> {
  const { meta } = await db
    .prepare(`UPDATE assistant_feedback SET read_at = ?2 WHERE id = ?1`)
    .bind(id, read ? now : null)
    .run();
  return meta.changes > 0;
}
