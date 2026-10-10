import { useQuery } from '@tanstack/react-query';
import type { AccountPlan, BillingConfig } from '@unbent/shared';
import { configQuery, planQuery } from './queries.js';

/**
 * The account's plan, for the pages that draw it or turn read-only on it (MAK-108).
 *
 * `billing` is the instance's half from `/api/config`, which is the first question: on
 * an instance that sells nothing there is no plan, nothing is asked, and `inactive` is
 * false for good. `plan` is the server's answer, undefined until it has one; `inactive`
 * is the one bit most callers want, and is false while the answer is still on its way —
 * an editor that locked itself for the length of a request on every open would read as
 * broken, and a lapsed write is refused by the server anyway.
 */
export function usePlan(): { billing: BillingConfig | undefined; plan: AccountPlan | undefined; inactive: boolean } {
  const config = useQuery(configQuery());
  const billing = config.data?.billing;
  const plan = useQuery(planQuery(billing !== undefined));
  return { billing, plan: plan.data, inactive: plan.data?.state === 'inactive' };
}
