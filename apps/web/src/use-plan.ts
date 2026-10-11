import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountPlan, BillingConfig } from '@unbent/shared';
import { onPlanRefused } from './plan-refused.js';
import { configQuery, keys, planQuery } from './queries.js';

/**
 * The account's plan, for the pages that draw it or turn read-only on it (MAK-108).
 *
 * `billing` is the instance's half from `/api/config`, which is the first question: on
 * an instance that sells nothing there is no plan, nothing is asked, and `inactive` is
 * false for good. `plan` is the server's answer, undefined until it has one; `inactive`
 * is the one bit most callers want, and is false while the answer is still on its way —
 * an editor that locked itself for the length of a request on every open would read as
 * broken, and a lapsed write is refused by the server anyway.
 *
 * Worked out against the clock here too, not only on the server: the answer is read a
 * minute at a time, and a tab left open over a trial's end would otherwise go on taking
 * edits the server refuses. A timer wakes this at the end, and at each local midnight
 * before it so the banner's "in 2 days" turns over. And when the outbox is told by a
 * refusal that the plan ended, the plan is read again at once (`onPlanRefused`), so the
 * banner and the read-only editor appear without waiting a minute.
 */
export function usePlan(): { billing: BillingConfig | undefined; plan: AccountPlan | undefined; inactive: boolean; now: number } {
  const config = useQuery(configQuery());
  const billing = config.data?.billing;
  const plan = useQuery(planQuery(billing !== undefined));
  const until = plan.data?.state !== 'inactive' ? plan.data?.until ?? null : null;
  const now = useClock(until);

  const data = plan.data;
  const inactive = data !== undefined && (data.state === 'inactive' || (data.until !== null && data.until <= now));
  return { billing, plan: data, inactive, now };
}

/**
 * The two reasons to read the plan again that are not the query's own, from one place:
 * the outbox's word that a write was refused for the plan, and the clock reaching the
 * end the plan named — a renewing subscription's end is its renewal, and the webhook
 * has moved the date by the time the timer fires, or will shortly. Mounted once, by the
 * banner, which is on every signed-in page; `usePlan` itself is on several components
 * at once, and a listener per caller made one refusal three reads, each cancelling the
 * last.
 */
export function usePlanRefresh(): void {
  const queryClient = useQueryClient();
  const { plan, now } = usePlan();
  const until = plan?.state !== 'inactive' ? plan?.until ?? null : null;
  const reached = until !== null && until <= now;
  useEffect(() => {
    if (reached) void queryClient.invalidateQueries({ queryKey: keys.plan() });
  }, [reached, queryClient]);
  useEffect(
    () =>
      onPlanRefused(() => {
        void queryClient.invalidateQueries({ queryKey: keys.plan() });
      }),
    [queryClient],
  );
}

const DAY = 24 * 60 * 60 * 1000;

/** The next moment the plan's reading changes: the end itself, or the next local midnight before it. */
function nextBoundary(until: number | null, now: number): number | null {
  if (until === null) return null;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.min(until, midnight.getTime());
}

/** The time, re-read at each boundary of `until`; the render's clock otherwise. */
function useClock(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = nextBoundary(until, Date.now());
    if (at === null || at <= Date.now()) return;
    // A timer past about 24 days overflows to "now", so the wait is capped and set again.
    const timer = setTimeout(() => setNow(Date.now()), Math.min(at - Date.now() + 50, DAY));
    return () => clearTimeout(timer);
  }, [until, now]);
  return now;
}
