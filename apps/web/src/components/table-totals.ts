import { SEARCH_DEFAULT_LIMIT, type NoteSummary } from '@unbent/shared';
import { fieldSums } from '../store/derive.js';
import type { TableTotals } from './NoteTable.js';

/**
 * The table's footer: what its number columns add up to, and over which rows.
 *
 * The notebook's own list is totalled over every note the filters match, from the
 * library (`fieldTotalsQuery`, `whole` here), not over the pages loaded, which would make
 * "Total" the sum of the first fifty. Not while the library's first copy (or a copy after
 * a reset) is still arriving, either: the sum would be of the rows landed so far, and
 * would climb as the pages came in under a heading that says it is the whole. On a
 * device with no library (`whole` is `null`) the server keeps no sums, so the loaded rows
 * are totalled once they are all of them. In both cases there is no footer until the sum
 * is whole, rather than one that is short.
 *
 * A search's matches are the best fifty by relevance (`SEARCH_DEFAULT_LIMIT`, which the
 * page never overrides), so they are totalled as they stand and the label says so when
 * the cap was reached: fewer than fifty is every match, and plainly "Total".
 */
export function tableTotalsFor(opts: {
  /** The columns `totalable` allows, by field id; none means no footer. */
  ids: ReadonlySet<string>;
  /** A search's matches, or null when the table is the notebook's own list. */
  searchRows: readonly NoteSummary[] | null;
  /** The library's sums, `null` on a device with no library, absent while they load. */
  whole: Record<string, number> | null | undefined;
  /** Whether the library's copy is the whole account (`useLibraryWhole`). */
  libraryWhole: boolean;
  /** The list's loaded rows, and whether there are more to load. */
  loaded: readonly NoteSummary[];
  hasNextPage: boolean;
}): TableTotals | undefined {
  const { ids, searchRows, whole, libraryWhole, loaded, hasNextPage } = opts;
  if (ids.size === 0) return undefined;
  if (searchRows) {
    return { label: searchRows.length >= SEARCH_DEFAULT_LIMIT ? `Total of top ${SEARCH_DEFAULT_LIMIT}` : 'Total', sums: fieldSums(searchRows, ids) };
  }
  if (whole && libraryWhole) return { label: 'Total', sums: new Map(Object.entries(whole)) };
  if (whole === null && !hasNextPage) return { label: 'Total', sums: fieldSums(loaded, ids) };
  return undefined;
}
