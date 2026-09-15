import { describe, expect, it } from 'vitest';
import {
  createFieldSchema,
  decodeFieldValue,
  encodeFieldValue,
  expectedFieldValue,
  fieldNameSchema,
  fieldRangeBound,
  fieldsByName,
  formatFieldFilter,
  inferFieldType,
  isHeldSelectValue,
  isReservedFieldName,
  parseFieldFilter,
  planConversion,
  type FieldType,
  type NoteFieldValue,
} from './fields.js';

const def = (type: FieldType, options: string[] = []) => ({ type, options });

describe('field names', () => {
  it('reserves the keys the exporter writes, whatever the case', () => {
    for (const name of ['id', 'Title', 'TAGS', ' notebook ', 'source', 'body', 'created']) {
      expect(isReservedFieldName(name)).toBe(true);
      expect(fieldNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it('accepts ordinary names and trims them', () => {
    expect(fieldNameSchema.parse('  Merchant ')).toBe('Merchant');
    expect(fieldNameSchema.safeParse('').success).toBe(false);
  });

  it('de-duplicates select options in order', () => {
    const out = createFieldSchema.parse({ name: 'Kind', type: 'select', options: ['a', 'b', 'a'] });
    expect(out.options).toEqual(['a', 'b']);
  });
});

describe('encodeFieldValue', () => {
  it('treats an empty string as clearing, for every type', () => {
    for (const type of ['text', 'number', 'date', 'checkbox', 'url', 'email', 'phone', 'select'] as const) {
      expect(encodeFieldValue(def(type, ['x']), '')).toBe('clear');
      expect(encodeFieldValue(def(type, ['x']), '   ')).toBe('clear');
    }
  });

  it('text and phone keep the trimmed string with no shadow', () => {
    expect(encodeFieldValue(def('text'), '  Acme ')).toEqual({ text: 'Acme', num: null });
    expect(encodeFieldValue(def('phone'), '+1 555 0100')).toEqual({ text: '+1 555 0100', num: null });
    expect(encodeFieldValue(def('text'), 'x'.repeat(1001))).toBeNull();
  });

  it('numbers accept numbers and plain decimal strings', () => {
    expect(encodeFieldValue(def('number'), 12.5)).toEqual({ text: '12.5', num: 12.5 });
    expect(encodeFieldValue(def('number'), '-3')).toEqual({ text: '-3', num: -3 });
    expect(encodeFieldValue(def('number'), '12.50')).toEqual({ text: '12.5', num: 12.5 });
    expect(encodeFieldValue(def('number'), 'abc')).toBeNull();
    expect(encodeFieldValue(def('number'), '1,000')).toBeNull();
    expect(encodeFieldValue(def('number'), true)).toBeNull();
  });

  it('dates take YYYY-MM-DD and shadow UTC midnight', () => {
    expect(encodeFieldValue(def('date'), '2024-03-01')).toEqual({
      text: '2024-03-01',
      num: Date.parse('2024-03-01T00:00:00Z'),
    });
    expect(encodeFieldValue(def('date'), '2024-13-01')).toBeNull();
    expect(encodeFieldValue(def('date'), 'March 1')).toBeNull();
    expect(encodeFieldValue(def('date'), 20240301)).toBeNull();
  });

  it('checkboxes take booleans or their names', () => {
    expect(encodeFieldValue(def('checkbox'), true)).toEqual({ text: 'true', num: 1 });
    expect(encodeFieldValue(def('checkbox'), 'false')).toEqual({ text: 'false', num: 0 });
    expect(encodeFieldValue(def('checkbox'), 'yes')).toBeNull();
    expect(encodeFieldValue(def('checkbox'), 1)).toBeNull();
  });

  it('urls must be http or https', () => {
    expect(encodeFieldValue(def('url'), 'https://x.test/a?b=1')).toEqual({
      text: 'https://x.test/a?b=1',
      num: null,
    });
    expect(encodeFieldValue(def('url'), 'x.test')).toBeNull();
    expect(encodeFieldValue(def('url'), 'javascript:alert(1)')).toBeNull();
    expect(encodeFieldValue(def('url'), 'ftp://x.test')).toBeNull();
  });

  it('emails must look like one', () => {
    expect(encodeFieldValue(def('email'), 'a@b.test')).toEqual({ text: 'a@b.test', num: null });
    expect(encodeFieldValue(def('email'), 'not an email')).toBeNull();
  });

  it('select values must be one of the options', () => {
    expect(encodeFieldValue(def('select', ['Dentist', 'GP']), 'GP')).toEqual({ text: 'GP', num: null });
    expect(encodeFieldValue(def('select', ['Dentist', 'GP']), 'Vet')).toBeNull();
    expect(encodeFieldValue(def('select', []), 'GP')).toBeNull();
  });

  it('keeps a select value a note already holds after that option is removed', () => {
    const select = def('select', ['Food']);
    expect(isHeldSelectValue(select, 'Travel', 'Travel')).toBe(true);
    expect(isHeldSelectValue(select, ' Travel ', 'Travel')).toBe(true);
    // A value the note never held is still a new choice.
    expect(isHeldSelectValue(select, 'Vet', 'Travel')).toBe(false);
    expect(isHeldSelectValue(select, 'Travel', undefined)).toBe(false);
    expect(isHeldSelectValue(def('text'), 'Travel', 'Travel')).toBe(false);
  });

  it('has a hint for every rejection', () => {
    expect(expectedFieldValue(def('number'))).toMatch(/number/);
    expect(expectedFieldValue(def('select', ['a', 'b']))).toContain('a, b');
    expect(expectedFieldValue(def('select'))).toMatch(/no options/);
  });
});

describe('decodeFieldValue', () => {
  it('inverts the encoding for the typed kinds', () => {
    expect(decodeFieldValue('number', '12.5')).toBe(12.5);
    expect(decodeFieldValue('checkbox', 'true')).toBe(true);
    expect(decodeFieldValue('checkbox', 'false')).toBe(false);
    expect(decodeFieldValue('date', '2024-03-01')).toBe('2024-03-01');
    expect(decodeFieldValue('text', 'Acme')).toBe('Acme');
  });
});

describe('inferFieldType', () => {
  it('guesses only the unambiguous kinds', () => {
    expect(inferFieldType(true)).toBe('checkbox');
    expect(inferFieldType(3)).toBe('number');
    expect(inferFieldType('2024-03-01')).toBe('date');
    expect(inferFieldType('https://x.test')).toBe('text');
    expect(inferFieldType('a@b.test')).toBe('text');
    expect(inferFieldType('42')).toBe('text');
  });
});

describe('planConversion', () => {
  const rows = (...texts: string[]) => texts.map((text, i) => ({ id: i, text }));

  it('keeps what reads under the new type and drops the rest', () => {
    const plan = planConversion('text', 'number', rows('12', 'abc', '3.5'));
    expect(plan.keep.map((k) => [k.row.id, k.text, k.num])).toEqual([
      [0, '12', 12],
      [2, '3.5', 3.5],
    ]);
    expect(plan.drop.map((r) => r.id)).toEqual([1]);
    expect(plan.seededOptions).toBeUndefined();
  });

  it('converting to select never clears: the values become the options', () => {
    const plan = planConversion('text', 'select', rows('GP', 'Dentist', 'GP'));
    expect(plan.seededOptions).toEqual(['GP', 'Dentist']);
    expect(plan.drop).toEqual([]);
    expect(plan.keep).toHaveLength(3);
  });

  it('converting to text keeps everything as its printed form', () => {
    const plan = planConversion('checkbox', 'text', rows('true', 'false'));
    expect(plan.keep.map((k) => k.text)).toEqual(['true', 'false']);
    expect(plan.keep.every((k) => k.num === null)).toBe(true);
  });

  it('number to date drops every value', () => {
    expect(planConversion('number', 'date', rows('2024', '3')).drop).toHaveLength(2);
  });
});

describe('fieldsByName', () => {
  const v = (name: string, value: string, notebookId: string, notebook: string): NoteFieldValue => ({
    fieldId: `${notebookId}-${name}`,
    name,
    type: 'text',
    value,
    notebookId,
    notebook,
  });

  it('keys by name, own notebook first', () => {
    const out = fieldsByName([v('Vendor', 'Acme', 'nb1', 'Receipts'), v('Amount', '12', 'nb1', 'Receipts')], 'nb1');
    expect(out).toEqual({ Vendor: 'Acme', Amount: '12' });
  });

  it('suffixes a foreign field whose name the own notebook already uses', () => {
    const out = fieldsByName(
      [v('Vendor', 'Acme', 'nb1', 'Receipts'), v('vendor', 'Old', 'nb2', 'Coupons')],
      'nb1',
    );
    expect(out).toEqual({ Vendor: 'Acme', 'vendor (Coupons)': 'Old' });
  });

  it('keeps a foreign field bare when nothing collides, and on an unfiled note', () => {
    expect(fieldsByName([v('Vendor', 'Acme', 'nb2', 'Coupons')], null)).toEqual({ Vendor: 'Acme' });
  });
});

/**
 * The field filter's wire form: `<fieldId>:<op>[:<value>]`.
 *
 * The id and the op can hold no `:`, so the first two are the separators and the value
 * is whatever follows — which is what lets a select option with a colon in it travel
 * unescaped. Everything unreadable is null, so the route can refuse it rather than
 * silently list an unfiltered archive.
 */
describe('field filters', () => {
  const id = '6f4c1b2e-9c1d-4a6e-8b7f-0123456789ab';

  it('round-trips each op', () => {
    for (const f of [
      { fieldId: id, op: 'eq' as const, value: 'Food' },
      { fieldId: id, op: 'gte' as const, value: '20' },
      { fieldId: id, op: 'lte' as const, value: '2026-01-10' },
      { fieldId: id, op: 'set' as const },
      { fieldId: id, op: 'empty' as const },
    ]) {
      expect(parseFieldFilter(formatFieldFilter(f))).toEqual(f);
    }
  });

  it('keeps every character of the value, colons included', () => {
    expect(parseFieldFilter(`${id}:eq:Time: 10:30`)).toEqual({ fieldId: id, op: 'eq', value: 'Time: 10:30' });
  });

  it('refuses what it cannot read', () => {
    for (const bad of [
      'nonsense',
      `${id}`,
      `${id}:between:1:2`,
      `${id}:eq`,
      `${id}:eq:`,
      `${id}:set:extra`,
      `${id}:gte:soon`,
      `not an id:eq:Food`,
      `${id}:eq:${'x'.repeat(1001)}`,
    ]) {
      expect(parseFieldFilter(bad), bad).toBeNull();
    }
  });

  it('reads a range bound as a number, or as a day with two ends', () => {
    expect(fieldRangeBound('gte', '20')).toBe(20);
    expect(fieldRangeBound('lte', '-1.5')).toBe(-1.5);
    const start = fieldRangeBound('gte', '2026-01-10')!;
    const end = fieldRangeBound('lte', '2026-01-10')!;
    expect(end - start).toBe(24 * 60 * 60 * 1000 - 1);
    expect(fieldRangeBound('gte', 'soon')).toBeNull();
  });
});
