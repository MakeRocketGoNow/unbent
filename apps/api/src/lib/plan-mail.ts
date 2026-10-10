import { INACTIVE_KEPT_DAYS, type PlanSource, type PlanState } from '@unbent/shared';
import { canSendEmail, sendEmail, type EmailEnv } from './email.js';
import { billingOn, type PaddleEnv } from './paddle.js';
import { LAPSE_DUE_SQL, updatePlanStatement } from './plan.js';

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
 * Runs in the sweep's invocation, a few accounts a run (`LAPSE_MAIL_PER_RUN`), each mail
 * one subrequest. That is sized for Workers Paid, where unbent.app runs: an instance
 * with billing on is one an operator switched on, and the five settings that turn it on
 * say so. An instance without mail, or without billing, sends nothing and reads nothing.
 */

/** The most accounts told per run: five mails, on top of the sweep's own budget. */
export const LAPSE_MAIL_PER_RUN = 5;

interface DueRow {
  user_id: string;
  plan: PlanState;
  plan_until: number;
  source: PlanSource | null;
  email: string;
}

/** The message for a lapse of each kind. `planUrl` is where to subscribe. */
export function lapseMessage(kind: 'trial' | 'subscription' | 'comp', planUrl: string): { subject: string; text: string } {
  const still =
    'Your notes are still there, and everything still opens: you can read, search and export them, and delete anything, for as long as you like. What has stopped is editing and adding.';
  const keep = `Subscribe at ${planUrl} to pick up where you left off. An account that stays read-only for ${Math.round(INACTIVE_KEPT_DAYS / 365)} year is deleted, with reminders to export first.`;
  switch (kind) {
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

export function lapseKind(row: { plan: PlanState; source: PlanSource | null }): 'trial' | 'subscription' | 'comp' {
  if (row.plan === 'trial') return 'trial';
  return row.source === 'comp' ? 'comp' : 'subscription';
}

/**
 * Tells up to `limit` accounts whose plan has run out. Returns how many were told. The
 * mark is written after the mail is accepted, so a mail that fails is tried again on
 * the next run rather than lost; one that is accepted and then fails to be marked would
 * be sent twice, which is the better of the two mistakes.
 */
export async function notifyLapsedPlans(
  env: PaddleEnv & EmailEnv & { DB: D1Database; APP_URL?: string | undefined },
  now = Date.now(),
  limit = LAPSE_MAIL_PER_RUN,
): Promise<number> {
  if (!billingOn(env) || !canSendEmail(env)) return 0;
  // The cron has no request to settle the address from (lib/app-url.ts); a deployed
  // instance with billing on has set it, as the README says, and one that has not is
  // told rather than mailed a link to nowhere.
  const appUrl = env.APP_URL?.trim();
  if (!appUrl) {
    console.warn('[billing] APP_URL is not set, so no lapse mail can name where to subscribe; none sent');
    return 0;
  }
  const { results } = await env.DB.prepare(LAPSE_DUE_SQL).bind(now, limit).all<DueRow>();
  const planUrl = `${appUrl.replace(/\/$/, '')}/settings/plan`;
  let told = 0;
  for (const row of results) {
    const kind = lapseKind(row);
    try {
      await sendEmail(env, { to: row.email, ...lapseMessage(kind, planUrl) });
    } catch (err) {
      console.error(`[billing] lapse mail for user=${row.user_id} failed; will retry next run:`, (err as Error).message);
      continue;
    }
    await updatePlanStatement(env.DB, row.user_id, { lapseNotifiedAt: now }, now).run();
    console.log(`[billing] told user=${row.user_id} their ${kind} ended`);
    told += 1;
  }
  return told;
}
