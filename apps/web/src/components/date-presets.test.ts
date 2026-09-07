import { describe, it, expect } from 'vitest';
import { DATE_PRESETS, activePreset } from './date-presets.js';

/**
 * The one-tap date ranges.
 *
 * Two properties matter and both fail silently if broken. They are computed in the user's
 * own zone, because "today" and "this year" are questions about their calendar — building
 * the string with `toISOString` would hand back yesterday for everyone west of London, and
 * the filter would look like it had lost a day's notes. And they are open-ended, because
 * "the last 7 days" means "since a week ago": pinning an end to today makes the filter
 * wrong the moment midnight passes with the sheet still open.
 */
const preset = (key: string) => DATE_PRESETS.find((p) => p.key === key)!;

describe('date presets', () => {
  it('offers the five ranges the Android app does, each named distinctly', () => {
    expect(DATE_PRESETS.map((p) => p.label)).toEqual([
      'Today',
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
      'This year',
    ]);
    expect(new Set(DATE_PRESETS.map((p) => p.key)).size).toBe(DATE_PRESETS.length);
  });

  it('counts back from the given day', () => {
    const today = new Date(2026, 8, 6); // 6 September 2026, local
    expect(preset('today').from(today)).toBe('2026-09-06');
    expect(preset('7').from(today)).toBe('2026-08-30');
    expect(preset('30').from(today)).toBe('2026-08-07');
    expect(preset('90').from(today)).toBe('2026-06-08');
  });

  /* A calendar boundary rather than a rolling window: "this year" is January the first,
     not 365 days ago. */
  it('reads "this year" as the calendar year', () => {
    expect(preset('year').from(new Date(2026, 8, 6))).toBe('2026-01-01');
    expect(preset('year').from(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('crosses a month and a year boundary by the calendar, not by arithmetic', () => {
    expect(preset('7').from(new Date(2026, 0, 3))).toBe('2025-12-27');
    expect(preset('30').from(new Date(2026, 2, 1))).toBe('2026-01-30');
  });

  /*
   * The timezone trap, stated directly. Late-evening local time is already tomorrow in UTC,
   * so a `toISOString` implementation returns the wrong day here and nowhere else.
   */
  it('names the local day even when UTC has moved on', () => {
    const lateEvening = new Date(2026, 8, 6, 23, 30);
    expect(preset('today').from(lateEvening)).toBe('2026-09-06');
    const earlyMorning = new Date(2026, 8, 6, 0, 30);
    expect(preset('today').from(earlyMorning)).toBe('2026-09-06');
  });

  it('recognises a range it set as one of its own', () => {
    const today = new Date(2026, 8, 6);
    expect(activePreset(preset('30').from(today), undefined, today)).toBe('30');
    expect(activePreset(preset('year').from(today), undefined, today)).toBe('year');
  });

  it('claims nothing for a range it did not set', () => {
    const today = new Date(2026, 8, 6);
    expect(activePreset(undefined, undefined, today)).toBeUndefined();
    expect(activePreset('2020-01-01', undefined, today)).toBeUndefined();
  });

  /*
   * A preset is open-ended, so a range with an end is not one however its start reads —
   * the user narrowed it by hand, and a lit pill would name a range that is not on screen.
   */
  it('stops claiming a range once an end is added by hand', () => {
    const today = new Date(2026, 8, 6);
    const from = preset('30').from(today);
    expect(activePreset(from, undefined, today)).toBe('30');
    expect(activePreset(from, '2026-08-20', today)).toBeUndefined();
  });
});
