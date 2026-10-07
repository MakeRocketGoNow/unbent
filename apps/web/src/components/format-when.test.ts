import { describe, it, expect } from 'vitest';
import { formatRevisionWhen, rangeLabel, timeAgo } from './format-when.js';

/**
 * The date range as a phrase.
 *
 * Two things worth pinning. One end alone is still a phrase, because an archive question is
 * usually open at one end and a label that could only describe a closed range would have
 * nothing to say about the commoner case. And the days are read as local days: parsing
 * `YYYY-MM-DD` as an instant gives midnight UTC, which is the previous day everywhere west
 * of London — a range set to January would have read as December.
 */
describe('rangeLabel', () => {
  it('has nothing to say about an absent range', () => {
    expect(rangeLabel(undefined, undefined)).toBeNull();
  });

  /*
   * "From" and "Until", which are the words the Android app uses for the same filter and
   * the words the two inputs are labelled with. It said "Since" here, which read as a
   * different kind of boundary from the "Until" it pairs with — and the two apps naming one
   * filter differently is how people come to think they behave differently. They do not:
   * both send the same `from`/`to` to the same endpoint.
   */
  it('describes a range open at either end, in the same words the phone app uses', () => {
    expect(rangeLabel('2026-01-01', undefined)).toMatch(/^From /);
    expect(rangeLabel(undefined, '2026-03-05')).toMatch(/^Until /);
  });

  it('describes a closed range as one phrase', () => {
    const label = rangeLabel('2026-01-01', '2026-03-05');
    expect(label).toContain('–');
    expect(label).not.toMatch(/^(Since|Until)/);
  });

  /*
   * The timezone trap. Both ends have to name the day that was typed, in every zone the app
   * runs in — this is the assertion that fails if anyone "simplifies" the parse to
   * `new Date(iso)`.
   */
  it('names the day that was picked, not the day before it', () => {
    expect(rangeLabel('2026-01-01', undefined)).toContain('1');
    expect(rangeLabel('2026-01-01', undefined)).toContain('2026');
    expect(rangeLabel('2026-01-01', undefined)).not.toContain('2025');
    expect(rangeLabel(undefined, '2026-03-01')).toContain('Mar');
    expect(rangeLabel(undefined, '2026-03-01')).not.toContain('Feb');
  });
});

/**
 * When a version in a note's history was taken. Always with the time: two versions from
 * one afternoon have nothing else to tell them apart.
 */
describe('formatRevisionWhen', () => {
  const now = new Date(2026, 9, 3, 1, 15).getTime(); // 1:15 AM, 3 October, local
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  it('says Today and Yesterday by calendar day, not by hours elapsed', () => {
    const earlier = new Date(2026, 9, 3, 0, 5);
    expect(formatRevisionWhen(earlier.getTime(), now)).toBe(`Today, ${time(earlier)}`);
    // Two and a quarter hours ago, and yesterday.
    const lateLastNight = new Date(2026, 9, 2, 23, 0);
    expect(formatRevisionWhen(lateLastNight.getTime(), now)).toBe(`Yesterday, ${time(lateLastNight)}`);
  });

  it('lowercases Today and Yesterday in a sentence, and leaves a date alone', () => {
    const earlier = new Date(2026, 9, 3, 0, 5);
    expect(formatRevisionWhen(earlier.getTime(), now, { inSentence: true })).toBe(`today, ${time(earlier)}`);
    const lateLastNight = new Date(2026, 9, 2, 23, 0);
    expect(formatRevisionWhen(lateLastNight.getTime(), now, { inSentence: true })).toBe(`yesterday, ${time(lateLastNight)}`);
    const lastWeek = new Date(2026, 8, 26, 16, 12).getTime();
    expect(formatRevisionWhen(lastWeek, now, { inSentence: true })).toBe(formatRevisionWhen(lastWeek, now));
  });

  it('gives the date after that, with the year only when it is another one', () => {
    const lastWeek = new Date(2026, 8, 26, 16, 12);
    const label = formatRevisionWhen(lastWeek.getTime(), now);
    expect(label).toContain(time(lastWeek));
    expect(label).toContain('26');
    expect(label).not.toContain('2026');
    expect(formatRevisionWhen(new Date(2025, 11, 30, 9, 0).getTime(), now)).toContain('2025');
  });
});


describe('timeAgo', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  it('counts up through minutes and hours, then days', () => {
    expect(timeAgo(now - 20_000, now)).toBe('just now');
    expect(timeAgo(now - 60_000, now)).toBe('1 minute ago');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(timeAgo('2026-10-06T09:00:00Z', now)).toBe('3 hours ago');
    // Hours up to two days, so "stale after 48 hours" reads against the same unit.
    expect(timeAgo(now - 40 * 3_600_000, now)).toBe('40 hours ago');
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3 days ago');
    // Days stay days: a 40-day-old dump must not read as "1 month".
    expect(timeAgo(now - 40 * 86_400_000, now)).toBe('40 days ago');
  });
  it('does not pretend to know an unreadable time', () => {
    expect(timeAgo('yesterday', now)).toBe('at an unknown time');
  });
});
