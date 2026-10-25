import {
  BASE_STORAGE_GB,
  FREE_NOTES,
  FREE_STORAGE_GB,
  GB,
  INACTIVE_KEPT_DAYS,
  fitsFree,
  heldBytes,
  type HeldCounts,
  type PlanSource,
  type PlanState,
} from '@unbent/shared';
import { EmailRejected, canSendEmail, sendEmail, type EmailEnv } from './email.js';
import { noWriteLimits } from './notes-repo.js';
import { billingOn, type StripeEnv } from './stripe.js';
import { LAPSE_DUE_SQL, RENEWAL_GRACE_MS, updatePlanStatement } from './plan.js';
import { reposFor } from './repos.js';
import type { Env } from '../types.js';

/**
 * Telling an account its plan has ended (MAK-108): the mail the sweep sends, once, to
 * each account whose trial, subscription or comp ran out and has not been told.
 *
 * Found by the end date rather than by a state change, since the state is derived
 * (`planStateOf`): a trial that ran out at midnight is inactive from midnight, and this
 * is what notices. Each account is told once per lapse: `lapse_notified_at` is written
 * with the mail and cleared by the webhook or a comp when a paid period is ahead again,
 * so an account that lapses, pays and lapses again is told the second time too.
 *
 * Each message says what the end leaves the account as, from what it holds (the free
 * plan, 2026-10-24): an account within the free plan's limits carries on as a free
 * account, and is told so with its own numbers and what a subscription adds; one past
 * them is read-only, and is told the notes are still there and readable, which is the
 * whole point of that state (MAK-47) and what a person whose trial ran out most needs to
 * hear before they decide anything, and that deleting down to the free plan is a way
 * back as well as subscribing.
 *
 * Runs in the sweep's invocation, ahead of the walk, a few accounts a run
 * (`LAPSE_MAIL_PER_RUN`): one query, then for each account a read of what its store
 * holds, a mail and a mark, every one a subrequest out of the invocation's fifty on
 * Workers Free. What it spent is handed to the walk (`sweepStores`'s `spent`), which
 * budgets its expiries around it, so an instance with billing on stays inside Free's
 * limit on a mail-heavy hour by deferring a few expiries rather than by failing the
 * walk's tail. An instance without mail, or
 * without billing, sends nothing and reads nothing.
 */

/**
 * The most accounts told per run. Two an hour is forty-eight a day, which leaves the
 * sign-in codes more than half of the hundred a day Resend's free tier allows (the
 * tier unbent.app is on) on the day a fortnight's trials end together. Five was the
 * first number, and would have let the mail crowd the codes out; MAK-220 is raising it
 * again once the mail tier allows. Nobody waits on this mail, so a backlog of lapses
 * drains at two an hour and is told a little later, which is the right side to err on.
 */
export const LAPSE_MAIL_PER_RUN = 2;

interface DueRow {
  user_id: string;
  plan: PlanState;
  plan_until: number;
  source: PlanSource | null;
  billing_status: string | null;
  email: string;
}

export type LapseKind = 'trial' | 'subscription' | 'past_due' | 'comp';

/** What each kind of end is called, in the mail's first line. */
const ENDED: Record<LapseKind, { subject: string; line: string }> = {
  trial: { subject: 'Your Unbent trial has ended', line: 'Your free trial of Unbent has ended.' },
  subscription: { subject: 'Your Unbent subscription has ended', line: 'Your Unbent subscription has ended.' },
  past_due: {
    subject: 'Your Unbent renewal could not be collected',
    line: "Your Unbent subscription's renewal could not be collected, so the subscription has stopped.",
  },
  comp: { subject: 'Your Unbent plan has ended', line: 'The plan on your Unbent account has ended.' },
};

const notesOf = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'note' : 'notes'}`;

/**
 * The message for a lapse of each kind, with what the account holds deciding what it
 * says the account is now. `planUrl` is where to subscribe, or where the card is
 * updated from.
 */
export function lapseMessage(kind: LapseKind, planUrl: string, held: HeldCounts): { subject: string; text: string } {
  const { subject, line } = ENDED[kind];
  const years = Math.round(INACTIVE_KEPT_DAYS / 365);
  if (fitsFree(held)) {
    const free = `This account holds ${notesOf(held.notes)} and ${heldBytes(held.attachmentBytes)} of files, within the free plan's ${FREE_NOTES} notes and ${FREE_STORAGE_GB} GB, so it carries on as a free account: everything keeps working as before, up to those numbers.`;
    const more =
      kind === 'past_due'
        ? `Update the card from ${planUrl} and Stripe will try again, and the subscription picks up where it was.`
        : `${kind === 'trial' ? 'Subscribe' : 'Subscribe again'} at ${planUrl} for unlimited notes, ${BASE_STORAGE_GB} GB of files and more Auto-fill.`;
    return { subject, text: `${line}\n\n${free}\n\n${more}` };
  }
  // Only what is over, so the person is not sent to delete files when it is the notes.
  const over: string[] = [];
  if (held.notes > FREE_NOTES) over.push(`${notesOf(held.notes)}, more than the free plan's ${FREE_NOTES}`);
  if (held.attachmentBytes > FREE_STORAGE_GB * GB) over.push(`${heldBytes(held.attachmentBytes)} of files, more than the free plan's ${FREE_STORAGE_GB} GB`);
  const readOnly = `This account holds ${over.join(', and ')}, so it is now read-only.`;
  const still =
    'Your notes are still there, and everything still opens: you can read, search and export them, and delete anything, for as long as you like. What has stopped is editing and adding.';
  const back =
    kind === 'past_due'
      ? `Update the card from ${planUrl} and Stripe will try again; nothing else is needed.`
      : `Subscribe at ${planUrl} to pick up where you left off.`;
  const under = `Or delete down to ${FREE_NOTES} notes and ${FREE_STORAGE_GB} GB of files, emptying the trash, and it carries on as a free account.`;
  const kept = `An account that stays read-only for ${years} year may be deleted, after a reminder to export it first.`;
  return { subject, text: `${line}\n\n${readOnly}\n\n${still}\n\n${back} ${under} ${kept}` };
}

export function lapseKind(row: { plan: PlanState; source: PlanSource | null; billing_status?: string | null }): LapseKind {
  if (row.plan === 'trial') return 'trial';
  if (row.source === 'comp') return 'comp';
  // A renewal Stripe is still trying to collect, or gave up on without cancelling
  // (`unpaid`): the card is the way back, not a checkout.
  return row.billing_status === 'past_due' || row.billing_status === 'unpaid' ? 'past_due' : 'subscription';
}

/**
 * Tells up to `limit` accounts whose plan has run out. Returns how many were told, and
 * how many subrequests it took (the query, and each store read, send and mark) for the walk's
 * budget. The mark is written after the mail is accepted, so a mail that fails is tried again on
 * the next run rather than lost; one that is accepted and then fails to be marked would
 * be sent twice, which is the better of the two mistakes.
 *
 * Except a mail the provider refuses outright (a 4xx: an address it will not take, a
 * suppressed one), which is marked as told all the same. The query takes the oldest
 * ends first, and a run's worth of addresses refused for good would otherwise hold
 * every slot on every run and no later account would ever be told.
 */
export async function notifyLapsedPlans(
  env: StripeEnv & EmailEnv & Pick<Env, 'USER_STORE' | 'STORE_JURISDICTION'> & { DB: D1Database; APP_URL?: string | undefined },
  now = Date.now(),
  limit = LAPSE_MAIL_PER_RUN,
): Promise<{ told: number; subrequests: number }> {
  const none = { told: 0, subrequests: 0 };
  if (!billingOn(env) || !canSendEmail(env)) return none;
  // The cron has no request to settle the address from (lib/app-url.ts); a deployed
  // instance with billing on has set it, as docs/billing.md says, and one that has not is
  // told rather than mailed a link to nowhere.
  const appUrl = env.APP_URL?.trim();
  if (!appUrl) {
    console.warn('[billing] APP_URL is not set, so no lapse mail can name where to subscribe; none sent');
    return none;
  }
  const { results } = await env.DB.prepare(LAPSE_DUE_SQL).bind(now, limit, now - RENEWAL_GRACE_MS).all<DueRow>();
  let subrequests = 1;
  const planUrl = `${appUrl.replace(/\/$/, '')}/settings/plan`;
  let told = 0;
  for (const row of results) {
    const kind = lapseKind(row);
    // What the account holds decides what the mail says it is now. A store that cannot
    // answer is the account's turn deferred, unmarked, to the next run: a guess would
    // tell a free account it is read-only, or a read-only one that it is free.
    subrequests += 1;
    let held: HeldCounts;
    try {
      const usage = await reposFor(env, row.user_id, noWriteLimits).attachments.usage();
      held = { notes: usage.notes, attachmentBytes: usage.attachmentBytes };
    } catch (err) {
      console.error(`[billing] lapse mail for user=${row.user_id} waits: its store could not say what it holds:`, (err as Error).message);
      continue;
    }
    subrequests += 1;
    try {
      await sendEmail(env, { to: row.email, ...lapseMessage(kind, planUrl, held) });
    } catch (err) {
      // A 4xx but not a rate limit or a timeout, which are the provider's day, not the address's.
      if (err instanceof EmailRejected && err.status < 500 && err.status !== 429 && err.status !== 408) {
        console.error(`[billing] lapse mail for user=${row.user_id} refused by the provider; marked as told:`, err.message);
        subrequests += 1;
        await updatePlanStatement(env.DB, row.user_id, { lapseNotifiedAt: now }, now).run();
        continue;
      }
      console.error(`[billing] lapse mail for user=${row.user_id} failed; will retry next run:`, (err as Error).message);
      continue;
    }
    subrequests += 1;
    await updatePlanStatement(env.DB, row.user_id, { lapseNotifiedAt: now }, now).run();
    console.log(`[billing] told user=${row.user_id} their ${kind} ended, ${fitsFree(held) ? 'now free' : 'now read-only'}`);
    told += 1;
  }
  return { told, subrequests };
}
