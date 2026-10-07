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

/** The absolute form beside the relative one: the viewer's locale, date and time. */
export function formatMoment(when: number | string): string {
  const at = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
