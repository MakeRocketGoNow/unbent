/**
 * What the button under a page of notes says.
 *
 * It carries how much of the list is on screen — "50 of 900" — because that is a fact
 * about paging, and this is the control that acts on it. The list's header used to say it
 * ("50 of 900 notes"), in a row it shares with the filter, sort and view icons and New,
 * where it was the one thing that truncated; the header now states the total alone, which
 * is short at any width, and the part that changes as pages load sits where loading
 * happens. Without a total — a later page's response omits it — the words stand alone.
 */
export function loadMoreLabel(loaded: number, total: number | null, fetching: boolean): string {
  if (fetching) return 'Loading…';
  return total !== null && total > loaded ? `Load more · ${loaded} of ${total}` : 'Load more';
}
