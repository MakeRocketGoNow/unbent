import { useQuery } from '@tanstack/react-query';
import { exactCountQuery, type ExactCountFilter } from '../queries.js';

/**
 * The number a destructive confirmation should name: the stored count it already has,
 * replaced by the count read from the notes once that arrives.
 *
 * Starting from the stored count rather than a placeholder keeps the confirm from
 * appearing with a blank or a spinner where the number goes. The two agree unless a
 * stored count has drifted, so the swap is invisible in every case but the one it exists
 * for. `null` asks for nothing, for a confirm that is not open; hooks cannot be called
 * conditionally, and the pages holding these confirms decide which one is showing.
 */
export function useExactCount(filter: ExactCountFilter | null, stored: number): number {
  const exact = useQuery({ ...exactCountQuery(filter ?? {}), enabled: filter !== null });
  return filter !== null && exact.data !== undefined ? exact.data : stored;
}
