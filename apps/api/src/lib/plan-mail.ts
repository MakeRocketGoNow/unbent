import { INACTIVE_KEPT_DAYS, type PlanSource, type PlanState } from '@unbent/shared';
import { EmailRejected, canSendEmail, sendEmail, type EmailEnv } from './email.js';
import { billingOn, type PaddleEnv } from './paddle.js';
import { LAPSE_DUE_SQL, RENEWAL_GRACE_MS, updatePlanStatement } from './plan.js';

/**
 * Telling an account its plan has ended (MAK-108): the mail the sweep sends, once, to
 * each account whose trial, subscription or comp ran out and has not been told.
 *
 * Found by the end date rather than by a state change, since the state is derived
 * (`planStateOf`): a trial that ran out at midnight is inactive from midnight, and this
 * is what notices. Each account is told once per lapse — `lapse_notified_at` is written
 * with the mail and cleared by the webhook or a comp when a paid period is ahead again
 * — so an account that lapses, pays and lapses again is told the second time too.
 *
 * Every message says the notes are still there and readable, which is the whole point
 * of the read-only state (MAK-47), and what a person whose trial ran out most needs to
 * hear before they decide anything.
 *
 * Runs in the sweep's invocation, ahead of the walk, a few accounts a run
 * (`LAPSE_MAIL_PER_RUN`): one query, then a mail and a mark per account, every one a
 * subrequest out of the invocation's fifty on Workers Free. What it spent is handed to
 * the walk (`sweepStores`'s `spent`), which budgets its expiries around it, so an
 * instance with billing on stays inside Free's limit on a mail-heavy hour by deferring
 * a few expiries rather than by failing the walk's tail. An instance without mail, or
 * without billing, sends nothing and reads nothing.
 */

/** The most accounts told per run: five mails and their marks, out of the sweep's budget. */
export const LAPSE_MAIL_PER_RUN = 5;

interface DueRow {
  user_id: string;
  plan: PlanState;
  plan_until: number;
  source: PlanSource | null;
  paddle_status: string | null;
  email: string;
}

export type LapseKind = 'trial' | 'subscription' | 'past_due' | 'comp';

/** The message for a lapse of each kind. `planUrl` is where to subscribe, or where the card is updated from. */
export function lapseMessage(kind: LapseKind, planUrl: string): { subject: string; text: string } {
  const still =
    'Your notes are still there, and everything still opens: you can read, search and export them, and delete anything, for as long as you like. What has stopped is editing and adding.';
  const keep = `Subscribe at ${planUrl} to pick up where you left off. An account that stays read-only for ${Math.round(INACTIVE_KEPT_DAYS / 365)} year is deleted, with reminders to export first.`;
  switch (kind) {
    case 'past_due':
      return {
        subject: 'Your Unbent renewal could not be collected',
        text: `Your Unbent subscription's renewal could not be collected, so the account is now read-only.\n\n${still}\n\nUpdate the card from ${planUrl} and Paddle will try again; nothing else is needed. An account that stays read-only for ${Math.round(INACTIVE_KEPT_DAYS / 365)} year is deleted, with reminders to export first.`,
      };
    case 'trial':
      return {
        subject: 'Your Unbent trial has ended',
        text: `Your free trial of Unbent has ended.\n\n${still}\n\n${keep}`,
      };
    case 'subscription':
      return {
        subject: 'Your Unbent subscription has ended',
        text: `Your Unbent subscription has ended, so your account is now read-only.\n\n${still}\n\n${keep}`,
      };
    case 'comp':
      return {
        subject: 'Your Unbent plan has ended',
        text: `The plan on your Unbent account has ended, so the account is now read-only.\n\n${still}\n\n${keep}`,
      };
  }
}

export function lapseKind(row: { plan: PlanState; source: PlanSource | null; paddle_status?: string | null }): LapseKind {
  if (row.plan === 'trial') return 'trial';
  if (row.source === 'comp') return 'comp';
  // A renewal Paddle is still trying to collect: the card is the way back, not a checkout.
  return row.paddle_status === 'past_due' ? 'past_due' : 'subscription';
}

/**
 * Tells up to `limit` accounts whose plan has run out. Returns how many were told, and
 * how many subrequests it took — the query, each send and each mark — for the walk's
 * budget. The mark is written after the mail is accepted, so a mail that fails is tried again on
 * the next run rather than lost; one that is accepted and then fails to be marked would
 * be sent twice, which is the better of the two mistakes.
 *
 * Except a mail the provider refuses outright (a 4xx: an address it will not take, a
 * suppressed one), which is marked as told all the same. The query takes the oldest
 * ends first, and five addresses refused for good would otherwise hold the five slots
 * on every run and no later account would ever be told.
 */
export async function notifyLapsedPlans(
  env: PaddleEnv & EmailEnv & { DB: D1Database; APP_URL?: string | undefined },
  now = Date.now(),
  limit = LAPSE_MAIL_PER_RUN,
): Promise<{ told: number; subrequests: number }> {
  const none = { told: 0, subrequests: 0 };
  if (!billingOn(env) || !canSendEmail(env)) return none;
  // The cron has no request to settle the address from (lib/app-url.ts); a deployed
  // instance with billing on has set it, as the README says, and one that has not is
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
    subrequests += 1;
    try {
      await sendEmail(env, { to: row.email, ...lapseMessage(kind, planUrl) });
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
    console.log(`[billing] told user=${row.user_id} their ${kind} ended`);
    told += 1;
  }
  return { told, subrequests };
}
