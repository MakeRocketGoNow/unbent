/**
 * The date ranges worth one tap.
 *
 * Two inputs can express any range, which is why they stay, but they cannot express one
 * quickly: "the last 30 days" is a question this archive gets asked constantly — it is a
 * paperless-office corpus, and most lookups are recent receipts — and answering it by
 * opening two calendars and counting back is friction with no payoff.
 *
 * **Open-ended on purpose.** "The last 7 days" means "since a week ago", and pinning an end
 * to today would make the filter wrong the moment midnight passed with the sheet still
 * open. The API's range is inclusive at both ends, so an absent end means "up to now" and
 * keeps meaning it. This is Android's `DatePreset` and its reasoning, ported.
 *
 * **The day is the user's, not UTC.** These answer a question about someone's own calendar —
 * "today", "this year" — so the boundary has to be their midnight. Built from local
 * year/month/day rather than `toISOString`, which would hand back the previous day for
 * anyone west of London. `rangeLabel` in `format-when.ts` records the same trap from the
 * reading end.
 */
export interface DatePreset {
  key: string;
  label: string;
  /** The first day of this range, as the API's `YYYY-MM-DD`. */
  from: (today?: Date) => string;
}

/** A local date as the API's day string. Never `toISOString`; see the note above. */
function day(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/** `days` ago, in the user's zone. */
function daysAgo(n: number, today: Date): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  d.setDate(d.getDate() - n);
  return day(d);
}

export const DATE_PRESETS: DatePreset[] = [
  { key: 'today', label: 'Today', from: (t = new Date()) => daysAgo(0, t) },
  { key: '7', label: 'Last 7 days', from: (t = new Date()) => daysAgo(7, t) },
  { key: '30', label: 'Last 30 days', from: (t = new Date()) => daysAgo(30, t) },
  { key: '90', label: 'Last 90 days', from: (t = new Date()) => daysAgo(90, t) },
  // A calendar year rather than a rolling window: "this year" is a boundary, not a span.
  { key: 'year', label: 'This year', from: (t = new Date()) => day(new Date(t.getFullYear(), 0, 1)) },
];

/**
 * Which preset the current range is, if any.
 *
 * A range with an end is never a preset, however its start reads: the presets are all
 * open-ended, so `from` matching while `to` is set means the user narrowed a preset by hand
 * and the pill would be claiming a range that is no longer the one on screen.
 */
export function activePreset(
  from: string | undefined,
  to: string | undefined,
  today = new Date(),
): string | undefined {
  if (!from || to) return undefined;
  return DATE_PRESETS.find((p) => p.from(today) === from)?.key;
}
