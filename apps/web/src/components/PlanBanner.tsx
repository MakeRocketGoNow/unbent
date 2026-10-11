import { Link } from '@tanstack/react-router';
import { isHosted } from '../app-bridge.js';
import { usePlan, usePlanRefusalListener } from '../use-plan.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Calendar days from `now`'s day to `when`'s, in the viewer's zone: "tomorrow" is the
 * next date, not the next twenty-four hours, so a trial ending at nine tomorrow morning
 * is tomorrow's all evening.
 */
function daysAhead(when: number, now: number): number {
  const day = (t: number) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
  return Math.round((day(when) - day(now)) / DAY);
}

/** How close to the end of a trial the banner starts saying so. */
export const TRIAL_WARNING_DAYS = 3;

/**
 * One line across the top of the signed-in column when the plan needs saying (MAK-108):
 * the account is read-only because its plan ended, or its trial is about to. Shaped and
 * placed like the offline banner, since it is the same kind of sentence — a state of the
 * whole account that every page is under — and quiet for the same reason: nothing has
 * gone wrong, and the sentence says what still works.
 *
 * Silent for the rest of a trial. A fortnight of "13 days left" would teach people to
 * stop reading it before the day it matters; the Plan page always has the date.
 *
 * Inside the apps the way out is the web, and the line says so instead of linking to a
 * page whose buttons are not drawn there (see `Plan`).
 */
export function PlanBanner({ now: fixed }: { now?: number } = {}) {
  const { plan, inactive, now: clock } = usePlan();
  usePlanRefusalListener();
  const now = fixed ?? clock;
  const hosted = isHosted();
  let line: string | null = null;
  if (inactive) {
    line = 'Your plan has ended, so your notes are read-only. Everything still opens, searches and exports.';
  } else if (plan?.state === 'trial' && plan.until !== null && plan.until - now <= TRIAL_WARNING_DAYS * DAY) {
    const days = daysAhead(plan.until, now);
    line = `Your free trial ends ${days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}.`;
  }
  return (
    <div className="plan-status" role="status">
      {line && (
        <p className="plan-banner">
          <span>{line}</span>{' '}
          {hosted ? (
            <span>Subscribe on the web.</span>
          ) : (
            <Link to="/settings/plan">Subscribe</Link>
          )}
        </p>
      )}
    </div>
  );
}
