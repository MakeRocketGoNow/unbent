import { z } from 'zod';

/**
 * Bounding the sign-in codes an instance sends in a day (MAK-206).
 *
 * The code endpoint is a form that sends a mail to any address typed into it, and the
 * instance's mail allowance is finite: unbent.app is on Resend's free tier, a hundred a
 * UTC day, past which every send is refused until midnight and every sign-in by code
 * with it. Better Auth bounds the endpoint per IP only, and loosely (three a minute,
 * which is thousands a day), so one scanner, or a loop someone forgot, can spend the
 * whole day's allowance before breakfast. The addresses it invents bounce, which costs
 * reputation on top.
 *
 * Three counts, kept in D1 (`code_sends`, migration 0046) because they must hold across
 * isolates, and checked in a hook before the code is made:
 *
 * - **One address, one code a minute.** A person who did not get the code presses again
 *   after a moment, not within seconds; anything faster is a page in a retry loop.
 * - **One address, a few codes a day.** Enough for a flaky mail provider and a typo or
 *   two, far short of what a loop sends to one target.
 * - **A day's share for addresses with no account.** This is the one that protects what
 *   matters. A bot cannot know a real address, so it cycles invented ones, and each of
 *   those is a send to a stranger. Capping the strangers' share leaves the rest of the
 *   allowance to people who already have an account and are signing in on a new device,
 *   however bad the day. The share is sized to the free tier; an instance on a paid
 *   tier, with no daily cap, can raise it.
 *
 * The day's bound holds for an address with an account too, and that is a cost accepted
 * with open eyes: anyone who knows someone's address can spend its six codes in six
 * minutes, and a person whose only way in is a code is then shut out until midnight UTC.
 * Loosening it for accounts was the alternative, and it is worse: one known address
 * asking once a minute would then spend the sixty kept for every account by mid-morning,
 * shutting everyone out instead of one person. Someone with Google or a passkey on the
 * account still gets in.
 *
 * Not a per-IP rule, deliberately. Any per-IP bound either stops nothing (a thousand a
 * day from one address drains the allowance) or hurts the people behind one IP: a
 * carrier's NAT, an office, a room at a meetup trying the app together, which is the
 * very day this exists for.
 *
 * A refusal is a 429 with a sentence, since the web screen and both native sign-in
 * screens show the server's `message` as it is. The strangers' refusal tells a stranger
 * apart from an account, which the code endpoint otherwise avoids (it answers the same
 * whether or not an address is known). That is accepted: it is only tellable on a day
 * someone is already burning the budget, and the alternative, a silent success that
 * sends nothing, strands a real newcomer on the app's busiest day with a code that never
 * comes.
 */

/**
 * The least time between two codes to the same address. Kept on the day's row, so it
 * starts again at midnight UTC: a code at 23:59:50 and another ten seconds later both go.
 * One extra code a day to one address is not worth a second row.
 */
export const ADDRESS_CODE_INTERVAL_MS = 60_000;

/** Codes one address may be sent in a UTC day. */
export const ADDRESS_CODES_PER_DAY = 6;

/**
 * Codes sent to addresses with no account in a UTC day. Forty of Resend Free's hundred:
 * the other sixty stay for accounts, and the lapse mail's forty-eight (`LAPSE_MAIL_PER_RUN`)
 * has never yet shared a day with a full forty here.
 */
export const STRANGER_CODES_PER_DAY = 40;

export type CodeRefusal = 'interval' | 'address' | 'strangers';

/** What the screen says. Every one ends with somewhere else to go, since the person is at the door. */
export const CODE_REFUSAL_MESSAGES: Record<CodeRefusal, string> = {
  interval: 'A code was sent to that address a moment ago. Give it a minute, then ask for another.',
  address: 'That address has had its codes for today. Try again tomorrow, or sign in another way.',
  strangers:
    'Codes to addresses without an account are paused for the rest of today. Sign in another way, or try again tomorrow.',
};

/** The slice of D1 this reads and writes. */
export interface CodeSendsDb {
  prepare(sql: string): {
    bind(...values: unknown[]): CodeSendsStatement;
  };
  batch(statements: CodeSendsStatement[]): Promise<Array<{ results?: unknown[] }>>;
}

export interface CodeSendsStatement {
  all<T>(): Promise<{ results: T[] }>;
}

const STRANGERS = 'strangers';

/**
 * The routes that send a code by email, each with whether it sends one to an address no
 * account has. Every route of Better Auth's email-code plugin that mails a code calls the
 * same `sendVerificationOTP`, so on this instance every one of them is the sign-in code
 * email and spends the same allowance; a route left off this list is a way round every
 * bound here. The two password-reset routes send only to an address an account has, and
 * stay mounted with passwords off, since the plugin does not ask. `/email-otp/request-email-change`
 * sends too (to the new address), but only with the plugin's `changeEmail` on, which this
 * instance does not turn on; turning it on means adding it here.
 *
 * Left out on purpose: the link mails of password sign-in (`/request-password-reset`,
 * `/send-verification-email`). They spend the same allowance, and someone who knows an
 * address can loop either up to Better Auth's per-IP limit, but they exist only on an
 * instance that turns passwords on, they never reach an address with no account, and a
 * refusal there needs sentences about links, not codes. Bounding them is its own change.
 */
const SEND_ROUTE = '/email-otp/send-verification-otp';
const CODE_ROUTES: Record<string, { toStrangers: boolean }> = {
  [SEND_ROUTE]: { toStrangers: true },
  '/email-otp/request-password-reset': { toStrangers: false },
  '/forget-password/email-otp': { toStrangers: false },
};

/**
 * Every route above, for the Turnstile check in `auth.ts` to stand in front of: the same
 * list, so a route that spends the allowance is also one a script has to earn a token
 * for. One list read twice rather than two that could drift.
 */
export const CODE_ROUTE_PATHS: readonly string[] = Object.keys(CODE_ROUTES);

/**
 * The address a request to Better Auth would mail a code to, or null when it mails none.
 *
 * The hook runs before the route checks its input, so this repeats the checks that decide
 * whether anything is sent: an address the route refuses as malformed, a `type` it does
 * not know or none, and the `change-email` type it refuses on this route, send nothing
 * and must count nothing. Of
 * the types it accepts, only `sign-in` mails an address no account has; the others answer
 * success and send nothing. Counting those would spend the strangers' share on requests
 * that cost no allowance, and then tell a real newcomer their code is paused.
 */
/** The types the send route mails a code for; it refuses any other, `change-email` included. */
const SENT_TYPES = new Set<unknown>(['sign-in', 'email-verification', 'forget-password']);

export function codeRequestOf(
  path: string | undefined,
  body: unknown,
): { email: string; toStrangers: boolean } | null {
  const route = path ? CODE_ROUTES[path] : undefined;
  if (!route) return null;
  const { email: raw, type } = (body ?? {}) as { email?: unknown; type?: unknown };
  if (typeof raw !== 'string') return null;
  const email = raw.toLowerCase();
  if (!z.email().safeParse(email).success) return null;
  if (path === SEND_ROUTE && !SENT_TYPES.has(type)) return null;
  return { email, toStrangers: route.toStrangers && (path !== SEND_ROUTE || type === 'sign-in') };
}

export function codeSendsDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface Row {
  scope: string;
  count: number;
  last_at: number;
}

/**
 * Counts a code to the address, if every bound allows it. The bounds are the upsert's own
 * conditions rather than a read before it: separate round trips let a parallel burst all
 * read the same count and all pass, which is the shape of the very traffic this is for.
 * Each statement is atomic in SQLite, so a burst is counted one at a time and the last
 * code under each bound is the last one allowed. A strangers' count past its share makes
 * the SELECT empty, so a new address row is never written; an existing one is updated
 * only inside its own day's count and interval. `RETURNING` says which happened.
 */
const COUNT_ADDRESS =
  'INSERT INTO code_sends (day, scope, count, last_at) ' +
  'SELECT ?1, ?2, 1, ?3 ' +
  "WHERE ?4 OR COALESCE((SELECT count FROM code_sends WHERE day = ?1 AND scope = 'strangers'), 0) < ?5 " +
  'ON CONFLICT (day, scope) DO UPDATE SET count = count + 1, last_at = excluded.last_at ' +
  'WHERE count < ?6 AND excluded.last_at - last_at >= ?7 ' +
  'RETURNING count';

/**
 * Counts the code against the strangers' share, only if the statement before it counted
 * it against the address: in the same batch, that is the address row carrying this
 * request's time. Two requests to one address in the same millisecond, the second refused
 * by the interval, would count one stranger too many; that errs towards refusing.
 */
const COUNT_STRANGER =
  'INSERT INTO code_sends (day, scope, count, last_at) ' +
  "SELECT ?1, 'strangers', 1, ?3 " +
  'WHERE EXISTS (SELECT 1 FROM code_sends WHERE day = ?1 AND scope = ?2 AND last_at = ?3) ' +
  'ON CONFLICT (day, scope) DO UPDATE SET count = count + 1, last_at = excluded.last_at';

/**
 * Counts a request for a code to `email`, or says why it must not be sent.
 *
 * `known` is whether an account has the address; the caller looks it up, since Better
 * Auth's own adapter is the right reader of its `user` table. Counted before the send
 * and only when allowed, in one batch, which a D1 batch runs as one transaction. An
 * allowed request costs that batch; a refusal costs one more read, to say which bound
 * refused it.
 */
export async function recordCodeRequest(
  db: CodeSendsDb,
  email: string,
  known: boolean,
  now = Date.now(),
): Promise<CodeRefusal | null> {
  const day = codeSendsDay(now);
  const address = `address:${email.toLowerCase()}`;
  const [, counted] = await db.batch([
    // Yesterday and before, by the key's prefix: nothing to read when there is nothing to delete.
    db.prepare('DELETE FROM code_sends WHERE day < ?1').bind(day),
    db
      .prepare(COUNT_ADDRESS)
      .bind(day, address, now, known ? 1 : 0, STRANGER_CODES_PER_DAY, ADDRESS_CODES_PER_DAY, ADDRESS_CODE_INTERVAL_MS),
    ...(known ? [] : [db.prepare(COUNT_STRANGER).bind(day, address, now)]),
  ]);
  if (counted?.results?.length) return null;

  const { results } = await db
    .prepare('SELECT scope, count, last_at FROM code_sends WHERE day = ?1 AND scope IN (?2, ?3)')
    .bind(day, address, STRANGERS)
    .all<Row>();
  const byScope = new Map(results.map((r) => [r.scope, r]));
  const own = byScope.get(address);
  if (own && own.count >= ADDRESS_CODES_PER_DAY) return 'address';
  if (own && now - own.last_at < ADDRESS_CODE_INTERVAL_MS) return 'interval';
  if (!known && (byScope.get(STRANGERS)?.count ?? 0) >= STRANGER_CODES_PER_DAY) return 'strangers';
  // Not reached within a day, since a row's count and time only grow; the interval is the nearest sentence.
  return 'interval';
}
