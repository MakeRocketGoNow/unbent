import { describe, expect, it } from 'vitest';
import { formatFieldValue } from './format-field.js';

describe('formatFieldValue', () => {
  it('reads a checkbox as Yes or No', () => {
    expect(formatFieldValue('checkbox', true)).toBe('Yes');
    expect(formatFieldValue('checkbox', false)).toBe('No');
    expect(formatFieldValue('checkbox', 'true')).toBe('Yes');
  });

  it('gives a number the viewer separators and leaves the rest alone', () => {
    expect(formatFieldValue('number', 1234.5)).toBe((1234.5).toLocaleString());
    expect(formatFieldValue('number', '12')).toBe('12');
    expect(formatFieldValue('date', '2024-03-01')).toBe('2024-03-01');
    expect(formatFieldValue('text', 'Acme')).toBe('Acme');
  });

  it('joins a multi-select with commas', () => {
    expect(formatFieldValue('multiselect', ['PC', 'PS5'])).toBe('PC, PS5');
    expect(formatFieldValue('multiselect', [])).toBe('');
    // A value from another notebook, still a list, reads the same whatever type it is drawn as.
    expect(formatFieldValue('text', ['a', 'b'])).toBe('a, b');
  });
});

describe('a rating', () => {
  const five = { max: 5, step: 0.5 } as const;

  it('draws whole stars up to the scale', () => {
    expect(formatFieldValue('number', 3, five)).toBe('★★★☆☆');
    expect(formatFieldValue('number', 5, five)).toBe('★★★★★');
    expect(formatFieldValue('number', 1, five)).toBe('★☆☆☆☆');
  });

  it('draws a half where the value sits between two stars', () => {
    expect(formatFieldValue('number', 3.5, five)).toBe('★★★½☆');
    expect(formatFieldValue('number', 0.5, five)).toBe('½☆☆☆☆');
    expect(formatFieldValue('number', 4.5, five)).toBe('★★★★½');
  });

  it('reads a wide scale as a number over its max, not a row of ten glyphs', () => {
    expect(formatFieldValue('number', 7, { max: 10, step: 1 })).toBe('7/10');
    expect(formatFieldValue('number', 2.5, { max: 10, step: 0.5 })).toBe('2.5/10');
  });

  it('leaves a plain number alone', () => {
    expect(formatFieldValue('number', 3.5)).toBe((3.5).toLocaleString());
    expect(formatFieldValue('number', 3.5, null)).toBe((3.5).toLocaleString());
  });
});
