import { describe, expect, it } from 'vitest';
import { amountText, currencySymbol, formatCurrency, formatFieldValue } from './format-field.js';

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

describe('an amount', () => {
  const money = (n: number, c: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(n);

  it('draws a number with a currency as money in the viewer\'s locale', () => {
    expect(formatFieldValue('number', 1234.5, null, 'USD')).toBe(money(1234.5, 'USD'));
    expect(formatFieldValue('number', '29.99', null, 'EUR')).toBe(money(29.99, 'EUR'));
    expect(formatFieldValue('number', 1235, null, 'JPY')).toBe(money(1235, 'JPY'));
  });

  it('lets a scale win over a currency, since a rating is never money', () => {
    expect(formatFieldValue('number', 3, { max: 5, step: 1 }, 'USD')).toBe('★★★☆☆');
  });

  it('falls back to the number beside the code for a code Intl refuses', () => {
    expect(formatCurrency(12, 'US')).toBe(`${(12).toLocaleString()} US`);
  });

  it('knows the symbol a currency draws with', () => {
    expect(currencySymbol('USD')).toBe(money(0, 'USD').replace(/[\d.,\s]/g, ''));
    expect(currencySymbol('US')).toBe('US');
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

  it('writes a year as it was typed, without the separator a quantity gets', () => {
    expect(formatFieldValue('number', 2026, null, null, 'year')).toBe('2026');
    expect(formatFieldValue('number', 2026)).toBe((2026).toLocaleString());
  });
});

describe('an amount in its input', () => {
  it('is written to the currency\u2019s cents', () => {
    expect(amountText(141.8, 'USD')).toBe('141.80');
    expect(amountText(412, 'USD')).toBe('412.00');
    expect(amountText('141.8', 'USD')).toBe('141.80');
    expect(amountText(-3.5, 'EUR')).toBe('-3.50');
    // Yen has no minor unit.
    expect(amountText(1200, 'JPY')).toBe('1200');
  });

  it('never rounds away a digit the value has', () => {
    expect(amountText(12.345, 'USD')).toBe('12.345');
    expect(amountText(1234.5, 'JPY')).toBe('1234.5');
  });

  it('leaves text that is not a plain decimal as it is', () => {
    expect(amountText('12.', 'USD')).toBe('12.');
    expect(amountText('-', 'USD')).toBe('-');
    expect(amountText('', 'USD')).toBe('');
  });
});
