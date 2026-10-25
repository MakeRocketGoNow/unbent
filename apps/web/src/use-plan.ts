import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountPlan, BillingConfig } from '@unbent/shared';
import { onPlanFreed, onPlanRefused, planIs } from './plan-refused.js';
import { configQuery, keys, planQuery } from './queries.js';

/**
 * The account's plan, for the pages that draw it or turn read-only on it (MAK-108).
 *
 * `billing` is the instance's half from `/api/config`, which is the first question: on
 * an instance that sells nothing there is no plan, nothing is asked, and `inactive` is
 * false for good. `plan` is the server's answer, undefined until it has one; `inactive`
 * is the one bit most callers want, and is false while the answer is still on its way:
 * an editor that locked itself for the length of a request on every open would read as
 * broken, and a lapsed write is refused by the server anyway.
 *
 * Read again when the clock passes an instant the plan named, rather than locked by the
 * clock here: since the free plan (2026-10-24), what a trial's or a plan's end leaves
 * the account as is what it holds, which only the server can say, so a page that locked
 * itself at `readOnlyAt` would lock a free account's editor for as long as the read took
 * and longer offline. A timer wakes this at `until`, at `readOnlyAt` (for a renewing
 * subscription a grace past `until`, since the renewal's webhook lands after the period
 * ends), and at each local midnight before them so the banner's "in 2 days" turns over,
 * and `usePlanRefresh` reads the plan then. An edit made in the moment between is the
 * server's to refuse, and the outbox keeps it. When the outbox is told by a refusal that
 * the plan ended, the plan is read again at once (`onPlanRefused`), so the banner and the
 * read-only editor appear without waiting a minute; and when a read-only account deletes
 * for good, it is read again too (`onPlanFreed`), since that may have taken it under the
 * free plan, and the editor opens again with nothing pressed.
 */
export function usePlan(): {
  billing: BillingConfig | undefined;
  plan: AccountPlan | undefined;
  inactive: boolean;
  now: number;
  /** The plan could not be read and there is no earlier answer to show: the page's own state, since `plan` is simply undefined. */
  unavailable: boolean;
} {
  const config = useQuery(configQuery());
  const billing = config.data?.billing;
  const plan = useQuery(planQuery(billing !== undefined));
  const now = useClock(boundariesOf(plan.data));

  const data = plan.data;
  const inactive = data !== undefined && data.state === 'inactive';
  return { billing, plan: data, inactive, now, unavailable: data === undefined && plan.isError };
}

/** The instants the plan's reading changes at, for a plan that still has one ahead: none for one that has ended, free or read-only. */
function boundariesOf(plan: AccountPlan | undefined): number[] {
  if (!plan || plan.state === 'inactive' || plan.state === 'free') return [];
  return [plan.until, plan.readOnlyAt].filter((t): t is number => t !== null);
}

/**
 * The two reasons to read the plan again that are not the query's own, from one place:
 * the outbox's word that a write was refused for the plan, and the clock reaching an
 * instant the plan named: its end, where a renewing subscription's end is its renewal
 * and the webhook has moved the date by the time the timer fires, or will shortly; and
 * the grace's end after it, in case it has not. Mounted once, by the banner, which is on
 * every signed-in page; `usePlan` itself is on several components at once, and a
 * listener per caller made one refusal three reads, each cancelling the last.
 */
export function usePlanRefresh(): void {
  const queryClient = useQueryClient();
  const { plan, now, inactive } = usePlan();
  // The outbox holds a refused write back while this says inactive, and replays it the
  // moment it says otherwise; see `planIs`. Only once the plan has been read: an answer
  // still on its way is not a plan that is active.
  useEffect(() => {
    if (plan !== undefined) planIs(inactive);
  }, [plan, inactive]);
  // The latest boundary passed, so each one passing is one read and a second render at
  // the same moment is none.
  const passed = boundariesOf(plan).filter((t) => t <= now).reduce<number | null>((last, t) => (last === null || t > last ? t : last), null);
  useEffect(() => {
    if (passed !== null) void queryClient.invalidateQueries({ queryKey: keys.plan() });
  }, [passed, queryClient]);
  useEffect(
    () =>
      onPlanRefused(() => {
        void queryClient.invalidateQueries({ queryKey: keys.plan() });
      }),
    [queryClient],
  );
  useEffect(
    () =>
      onPlanFreed(() => {
        void queryClient.invalidateQueries({ queryKey: keys.plan() });
      }),
    [queryClient],
  );
}

const DAY = 24 * 60 * 60 * 1000;

/** The next moment the plan's reading changes: the nearest boundary still ahead, or the next local midnight before it. */
function nextBoundary(boundaries: number[], now: number): number | null {
  const ahead = boundaries.filter((t) => t > now);
  if (ahead.length === 0) return null;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.min(...ahead, midnight.getTime());
}

/** The time, re-read at each of the plan's boundaries; the render's clock otherwise. */
function useClock(boundaries: number[]): number {
  const [now, setNow] = useState(() => Date.now());
  // By value, so a new array of the same instants each render sets no new timer.
  const key = boundaries.join(',');
  useEffect(() => {
    const at = nextBoundary(key === '' ? [] : key.split(',').map(Number), Date.now());
    if (at === null) return;
    // A timer past about 24 days overflows to "now", so the wait is capped and set again.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(at - Date.now() + 50, DAY));
    return () => clearTimeout(timer);
  }, [key, now]);
  return now;
}
