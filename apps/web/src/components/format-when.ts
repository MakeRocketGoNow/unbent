/** Relative time for note list entries, falling back to a date past a day. */
export function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * A date range as a phrase, or null when there is none.
 *
 * One end alone is still a phrase: an archive question is usually open at one end
 * ("anything before 2020"), which is why the two inputs exist rather than a preset list,
 * and a label that could only describe a closed range would have nothing to say about the
 * commoner case.
 *
 * The dates are `YYYY-MM-DD` and are formatted as local days rather than parsed as
 * instants. `new Date('2026-01-01')` is midnight UTC, which is the previous day in every
 * timezone west of London — a range the user set to January would have read as December.
 */
export function rangeLabel(from?: string, to?: string): string | null {
  const day = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };
  if (from && to) return `${day(from)} – ${day(to)}`;
  // "From", not "Since": it is the word the Android app uses for the same filter, and the
  // word the input under it is labelled with. It also pairs with "Until" — "Since"/"Until"
  // reads as two different kinds of boundary when they are the two ends of one range.
  if (from) return `From ${day(from)}`;
  if (to) return `Until ${day(to)}`;
  return null;
}
