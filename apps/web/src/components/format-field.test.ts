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
});
