import { describe, it, expect } from 'vitest';
import { rangeLabel } from './format-when.js';

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
