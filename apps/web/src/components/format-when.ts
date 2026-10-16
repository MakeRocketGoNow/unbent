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
 * When a copy in a note's history was taken: "Today, 4:12 PM", "Yesterday, 4:12 PM",
 * then the date. Always with the time, unlike `formatWhen`: two copies from one
 * afternoon are told apart by nothing else, and "3h ago" for both would make the list a
 * guess. The year only when it is not this one.
 *
 * Capitalised to head a row or a sheet; `inSentence` gives "today, 4:12 PM" for the
 * middle of one, decided here because only this knows which words it starts with.
 */
export function formatRevisionWhen(ms: number, now = Date.now(), { inSentence = false } = {}): string {
  const at = new Date(ms);
  const today = new Date(now);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // Whole local days between the two, by calendar date rather than by 24-hour spans:
  // 11 PM yesterday is "Yesterday" at 1 AM.
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return `${inSentence ? 'today' : 'Today'}, ${time}`;
  if (days === 1) return `${inSentence ? 'yesterday' : 'Yesterday'}, ${time}`;
  const date = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
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
 * timezone west of London: a range the user set to January would have read as December.
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
  // word the input under it is labelled with. It also pairs with "Until": "Since"/"Until"
  // reads as two different kinds of boundary when they are the two ends of one range.
  if (from) return `From ${day(from)}`;
  if (to) return `Until ${day(to)}`;
  return null;
}

/**
 * A moment as a distance from now: `just now`, `3 hours ago`, `2 days ago`.
 *
 * For the operator page, where "when did the backup last run?" is a question about
 * staleness, and a reader judging it wants hours, not a timestamp to subtract from. The
 * absolute time goes beside it (`title`, or a second line) for the record. Days are the
 * largest unit: past a month the number is the point, and "1 month ago" would hide that
 * a dump is 40 days old. `now` is a parameter for the tests.
 */
export function timeAgo(when: number | string, now = Date.now()): string {
  const at = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(at)) return 'at an unknown time';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** A day alone, for a date that is a deadline rather than a moment: "24 Oct 2026". */
export function formatDay(when: number | string): string {
  const at = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** The absolute form beside the relative one: the viewer's locale, date and time. */
export function formatMoment(when: number | string): string {
  const at = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
