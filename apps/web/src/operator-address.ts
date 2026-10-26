import type { OperatorOrder } from '@unbent/shared';

/**
 * What the operator page's controls do to its address (`routes/settings.operator.tsx`),
 * here rather than in the route so a test can hold them: the route file is code-split,
 * and the router warns about anything else it exports.
 *
 * Each spreads what it was given and changes only its own keys, so a parameter added to
 * the page later survives every control. The first sort handler rebuilt the address from
 * the keys it knew of, and would have dropped Show dismissed when it was added.
 */

/** The accounts' order: both of its keys cleared, then set from `next`, which leaves out a default. */
export function withOrder<T extends object>(prev: T, next: OperatorOrder): T {
  return { ...prev, sort: undefined, dir: undefined, ...next };
}

/** Show dismissed on the assistants' feedback: `?feedback=all`, or nothing for the unread list. */
export function withDismissedShown<T extends object>(prev: T, shown: boolean): T & { feedback: 'all' | undefined } {
  return { ...prev, feedback: shown ? 'all' : undefined };
}
