import { useQuery } from '@tanstack/react-query';
import { FREE_NOTES } from '@unbent/shared';
import { noteCountQuery, trashCountQuery } from './queries.js';
import { usePlan } from './use-plan.js';

/**
 * How many notes a free account holds, live and trashed together, when that is the free
 * plan's whole count or more: what New says instead of making a note the server would
 * refuse (`FREE_NOTES_FULL`). Null for an account a plan holds, one under the count,
 * and while the counts are still being read, so New is never held back by a guess.
 *
 * Counted from the local copy (`noteCountQuery` and `trashCountQuery` derive from the
 * library's rows), which is what the server counts within a pull: a note made or purged
 * on another device a moment ago can make this one off by that note, and then the
 * server's own answer decides, which the outbox keeps and the strip says. The device's
 * count is the courtesy of saying so before the press rather than after it; the store's
 * is the rule.
 */
export function useFreeNotesFull(): number | null {
  const { plan } = usePlan();
  const free = plan?.state === 'free';
  const live = useQuery({ ...noteCountQuery(), enabled: free });
  const trashed = useQuery({ ...trashCountQuery(), enabled: free });
  if (!free || live.data === undefined || trashed.data === undefined) return null;
  const held = live.data + trashed.data;
  return held >= FREE_NOTES ? held : null;
}
