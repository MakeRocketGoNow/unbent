import { describe, expect, it } from 'vitest';
import { timeAgo } from './format-time.js';

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
