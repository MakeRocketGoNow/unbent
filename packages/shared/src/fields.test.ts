import { describe, expect, it } from 'vitest';
import {
  createFieldSchema,
  decodeFieldValue,
  DEFAULT_RATING_SCALE,
  fitRatingScale,
  encodeFieldValue,
  currencySchema,
  expectedFieldValue,
  fieldHasOptions,
  isCurrencyField,
  fieldNameSchema,
  fieldRangeBound,
  fieldSortKey,
  fieldSortsNumerically,
  fieldsByName,
  formatFieldFilter,
  inferFieldType,
  isRatingField,
  isReservedFieldName,
  parseFieldFilter,
  planConversion,
  ratingRendersAsStars,
  ratingSteps,
  withHeldOptions,
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
    const held = withHeldOptions(select, 'Travel');
    expect(encodeFieldValue(held, 'Travel')).toEqual({ text: 'Travel', num: null });
    expect(encodeFieldValue(held, ' Travel ')).toEqual({ text: 'Travel', num: null });
    // A value the note never held is still a new choice.
    expect(encodeFieldValue(held, 'Vet')).toBeNull();
    expect(withHeldOptions(select, undefined)).toBe(select);
    expect(withHeldOptions(select, 'Food')).toBe(select);
    expect(withHeldOptions(def('text'), 'Travel')).toEqual(def('text'));
  });

  it('has a hint for every rejection', () => {
    expect(expectedFieldValue(def('number'))).toMatch(/number/);
    expect(expectedFieldValue(def('select', ['a', 'b']))).toContain('a, b');
    expect(expectedFieldValue(def('select'))).toMatch(/no options/);
    expect(expectedFieldValue(def('multiselect', ['a', 'b']))).toMatch(/list of options from: a, b/);
    expect(expectedFieldValue(def('multiselect'))).toMatch(/no options/);
  });
});

describe('multi-select', () => {
  const platforms = def('multiselect', ['PC', 'PS5', 'Switch']);

  it('is the other type that carries options', () => {
    expect(fieldHasOptions('select')).toBe(true);
    expect(fieldHasOptions('multiselect')).toBe(true);
    expect(fieldHasOptions('text')).toBe(false);
  });

  it('stores the chosen options as a JSON list in the option order, each once', () => {
    expect(encodeFieldValue(platforms, ['Switch', 'PC', ' PC '])).toEqual({
      text: '["PC","Switch"]',
      num: null,
    });
  });

  it('reads one option given as a bare string, which is what a select value looks like', () => {
    expect(encodeFieldValue(platforms, 'PS5')).toEqual({ text: '["PS5"]', num: null });
  });

  it('refuses a list with anything that is not an option, and non-lists', () => {
    expect(encodeFieldValue(platforms, ['PC', 'Xbox'])).toBeNull();
    expect(encodeFieldValue(platforms, 3)).toBeNull();
    expect(encodeFieldValue(platforms, true)).toBeNull();
    expect(encodeFieldValue(def('multiselect'), ['PC'])).toBeNull();
  });

  it('clears on an empty list or a list of blanks', () => {
    expect(encodeFieldValue(platforms, [])).toBe('clear');
    expect(encodeFieldValue(platforms, ['', '  '])).toBe('clear');
  });

  it('decodes the list back, and reads anything else as one option', () => {
    expect(decodeFieldValue('multiselect', '["PC","Switch"]')).toEqual(['PC', 'Switch']);
    expect(decodeFieldValue('multiselect', 'PC')).toEqual(['PC']);
    expect(decodeFieldValue('multiselect', '[1]')).toEqual(['[1]']);
  });

  it('keeps the retired options a note holds, and still takes a live one beside them', () => {
    const shrunk = def('multiselect', ['PC']);
    const held = withHeldOptions(shrunk, '["PC","PS5"]');
    expect(held.options).toEqual(['PC', 'PS5']);
    expect(encodeFieldValue(held, ['PS5', 'PC'])).toEqual({ text: '["PC","PS5"]', num: null });
    // Adding a retired option the note never held is still a new choice.
    expect(encodeFieldValue(held, ['PC', 'Switch'])).toBeNull();
  });

  it('is what a list value with no definition infers to', () => {
    expect(inferFieldType(['PC'])).toBe('multiselect');
  });

  it('sorts by the stored list text, which is what the SQL ordered by', () => {
    const d = { id: 'f', type: 'multiselect' as const };
    const held: NoteFieldValue = {
      fieldId: 'f', name: 'Platforms', type: 'multiselect', value: ['PC', 'PS5'], notebookId: 'nb', notebook: 'Games',
    };
    expect(fieldSortKey(d, [held])).toBe('["PC","PS5"]');
    expect(fieldSortKey(d, [])).toBe('');
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

  it('select to multi-select carries every value across as a list of one', () => {
    const plan = planConversion('select', 'multiselect', rows('GP', 'Dentist', 'GP'));
    expect(plan.seededOptions).toEqual(['GP', 'Dentist']);
    expect(plan.drop).toEqual([]);
    expect(plan.keep.map((k) => k.text)).toEqual(['["GP"]', '["Dentist"]', '["GP"]']);
  });

  it('multi-select to select keeps the single choices, seeds every option, and drops the rest', () => {
    const plan = planConversion('multiselect', 'select', rows('["PC"]', '["PC","PS5"]', '["Switch"]'));
    expect(plan.seededOptions).toEqual(['PC', 'PS5', 'Switch']);
    expect(plan.keep.map((k) => [k.row.id, k.text])).toEqual([
      [0, 'PC'],
      [2, 'Switch'],
    ]);
    expect(plan.drop.map((r) => r.id)).toEqual([1]);
  });

  it('multi-select to text joins the options, and to a number drops them', () => {
    expect(planConversion('multiselect', 'text', rows('["PC","PS5"]')).keep[0]?.text).toBe('PC, PS5');
    expect(planConversion('multiselect', 'number', rows('["PC"]')).drop).toHaveLength(1);
  });

  it('text to multi-select seeds an option per distinct value', () => {
    const plan = planConversion('text', 'multiselect', rows('PC, PS5', 'PC, PS5', 'Switch'));
    expect(plan.seededOptions).toEqual(['PC, PS5', 'Switch']);
    expect(plan.drop).toEqual([]);
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

describe('fieldSortKey', () => {
  const held = (fieldId: string, type: FieldType, value: NoteFieldValue['value']): NoteFieldValue => ({
    fieldId,
    name: 'F',
    type,
    value,
    notebookId: 'nb',
    notebook: 'Coupons',
  });

  it('numeric types sort by their shadow', () => {
    expect(fieldSortsNumerically('number')).toBe(true);
    expect(fieldSortsNumerically('date')).toBe(true);
    expect(fieldSortsNumerically('checkbox')).toBe(true);
    for (const t of ['text', 'url', 'email', 'phone', 'select'] as const) {
      expect(fieldSortsNumerically(t)).toBe(false);
    }
  });

  it('reads the shadow a numeric type stores', () => {
    expect(fieldSortKey({ id: 'a', type: 'number' }, [held('a', 'number', 12.5)])).toBe(12.5);
    expect(fieldSortKey({ id: 'a', type: 'date' }, [held('a', 'date', '2024-03-01')])).toBe(
      Date.parse('2024-03-01T00:00:00Z'),
    );
    expect(fieldSortKey({ id: 'a', type: 'checkbox' }, [held('a', 'checkbox', true)])).toBe(1);
    expect(fieldSortKey({ id: 'a', type: 'checkbox' }, [held('a', 'checkbox', false)])).toBe(0);
  });

  it('reads the text for everything else, including a retired select option', () => {
    expect(fieldSortKey({ id: 'a', type: 'select' }, [held('a', 'select', 'Travel')])).toBe('Travel');
    expect(fieldSortKey({ id: 'a', type: 'text' }, [held('a', 'text', 'hello')])).toBe('hello');
  });

  it('is the empty string when the note holds no value', () => {
    expect(fieldSortKey({ id: 'a', type: 'number' }, undefined)).toBe('');
    expect(fieldSortKey({ id: 'a', type: 'text' }, [held('b', 'text', 'other')])).toBe('');
  });
});

describe('ratings', () => {
  const rated = (max: number, step: 1 | 0.5) => ({
    type: 'number' as const,
    options: [],
    scale: { max, step },
  });

  it('takes a whole rating inside the scale', () => {
    expect(encodeFieldValue(rated(5, 1), 4)).toEqual({ text: '4', num: 4 });
    expect(encodeFieldValue(rated(5, 1), '1')).toEqual({ text: '1', num: 1 });
    expect(encodeFieldValue(rated(10, 1), 10)).toEqual({ text: '10', num: 10 });
  });

  it('refuses a rating off either end', () => {
    // 0 is out of range deliberately: an unlit row means "no value", never "rated zero".
    expect(encodeFieldValue(rated(5, 1), 0)).toBeNull();
    expect(encodeFieldValue(rated(5, 1), 6)).toBeNull();
    expect(encodeFieldValue(rated(5, 1), -2)).toBeNull();
  });

  it('takes a half only where the scale allows halves', () => {
    expect(encodeFieldValue(rated(5, 0.5), 3.5)).toEqual({ text: '3.5', num: 3.5 });
    expect(encodeFieldValue(rated(5, 0.5), 1.5)).toEqual({ text: '1.5', num: 1.5 });
    expect(encodeFieldValue(rated(5, 1), 3.5)).toBeNull();
  });

  it('refuses a value between the steps, on either step size', () => {
    // The remainder is taken on doubled integers, so 3.3 cannot slip through the way it
    // would with `3.3 % 0.5` in floating point.
    expect(encodeFieldValue(rated(5, 0.5), 3.3)).toBeNull();
    expect(encodeFieldValue(rated(5, 0.5), 2.25)).toBeNull();
    expect(encodeFieldValue(rated(10, 1), 7.5)).toBeNull();
  });

  it('leaves a plain number unbounded', () => {
    expect(encodeFieldValue(def('number'), 0)).toEqual({ text: '0', num: 0 });
    expect(encodeFieldValue(def('number'), 12.5)).toEqual({ text: '12.5', num: 12.5 });
    expect(encodeFieldValue(def('number'), -3)).toEqual({ text: '-3', num: -3 });
  });

  it('still clears on an emptied input', () => {
    expect(encodeFieldValue(rated(5, 0.5), '')).toBe('clear');
  });

  it('says what a rejected rating should have been', () => {
    expect(expectedFieldValue(rated(5, 1))).toBe('must be a whole rating from 1 to 5');
    expect(expectedFieldValue(rated(10, 0.5))).toBe('must be a rating from 1 to 10, in halves');
    expect(expectedFieldValue(def('number'))).toBe('must be a number');
  });

  it('draws five or fewer as stars, and wider scales as text', () => {
    expect(ratingRendersAsStars({ max: 5, step: 0.5 })).toBe(true);
    expect(ratingRendersAsStars({ max: 5, step: 1 })).toBe(true);
    expect(ratingRendersAsStars({ max: 10, step: 1 })).toBe(false);
  });

  it('knows a rating from a plain number', () => {
    expect(isRatingField({ type: 'number', scale: { max: 5, step: 1 } })).toBe(true);
    expect(isRatingField({ type: 'number', scale: null })).toBe(false);
    expect(isRatingField({ type: 'text', scale: null })).toBe(false);
  });

  it('lists the values a scale allows', () => {
    expect(ratingSteps({ max: 3, step: 1 })).toEqual([1, 2, 3]);
    expect(ratingSteps({ max: 3, step: 0.5 })).toEqual([1, 1.5, 2, 2.5, 3]);
    expect(ratingSteps({ max: 5, step: 0.5 })).toHaveLength(9);
  });

  it('bounds a scale to something a row of glyphs can show', () => {
    const scaled = (scale: unknown) =>
      createFieldSchema.safeParse({ name: 'Rating', type: 'number', scale }).success;
    expect(scaled({ max: 5, step: 0.5 })).toBe(true);
    expect(scaled({ max: 11, step: 1 })).toBe(false);
    expect(scaled({ max: 1, step: 1 })).toBe(false);
    expect(scaled({ max: 5, step: 0.25 })).toBe(false);
  });
});

describe('currency', () => {
  it('is an ISO 4217 code by shape', () => {
    expect(currencySchema.safeParse('USD').success).toBe(true);
    expect(currencySchema.safeParse('ZZZ').success).toBe(true);
    for (const bad of ['usd', 'US', 'USDD', '$', '']) expect(currencySchema.safeParse(bad).success).toBe(false);
  });

  it('cannot be set on a rating', () => {
    const both = { name: 'Price', type: 'number', scale: { max: 5, step: 1 }, currency: 'USD' };
    expect(createFieldSchema.safeParse(both).success).toBe(false);
    expect(createFieldSchema.safeParse({ ...both, scale: null }).success).toBe(true);
    expect(createFieldSchema.safeParse({ ...both, currency: null }).success).toBe(true);
  });

  it('knows an amount from a plain number and from a rating', () => {
    expect(isCurrencyField({ type: 'number', scale: null, currency: 'USD' })).toBe(true);
    expect(isCurrencyField({ type: 'number', currency: 'EUR' })).toBe(true);
    expect(isCurrencyField({ type: 'number', scale: null, currency: null })).toBe(false);
    expect(isCurrencyField({ type: 'number', scale: { max: 5, step: 1 }, currency: 'USD' })).toBe(false);
    expect(isCurrencyField({ type: 'text', currency: 'USD' })).toBe(false);
  });
});

describe('re-scaling a rating', () => {
  const rows = (...texts: string[]) => texts.map((text) => ({ text }));

  it('keeps every value when the scale widens', () => {
    const plan = planConversion('number', 'number', rows('1', '3', '5'), { max: 10, step: 1 });
    expect(plan.keep).toHaveLength(3);
    expect(plan.drop).toHaveLength(0);
  });

  it('clears what no longer fits when the scale narrows', () => {
    const plan = planConversion('number', 'number', rows('3', '7', '10'), { max: 5, step: 1 });
    expect(plan.keep.map((k) => k.text)).toEqual(['3']);
    expect(plan.drop).toHaveLength(2);
  });

  it('clears the halves when half steps are dropped', () => {
    const plan = planConversion('number', 'number', rows('2', '3.5', '4'), { max: 5, step: 1 });
    expect(plan.keep.map((k) => k.text)).toEqual(['2', '4']);
    expect(plan.drop).toHaveLength(1);
  });

  it('clears a plain number that is out of range when a scale arrives', () => {
    const plan = planConversion('number', 'number', rows('0', '4', '250'), { max: 5, step: 1 });
    expect(plan.keep.map((k) => k.text)).toEqual(['4']);
    expect(plan.drop).toHaveLength(2);
  });

  it('keeps a rating when the scale goes away', () => {
    const plan = planConversion('number', 'number', rows('1', '3.5', '5'), null);
    expect(plan.keep).toHaveLength(3);
    expect(plan.drop).toHaveLength(0);
  });

  it('carries a rating into text intact', () => {
    const plan = planConversion('number', 'text', rows('3.5'));
    expect(plan.keep.map((k) => k.text)).toEqual(['3.5']);
  });
});

describe('fitting a rating scale to the values a field holds', () => {
  const rows = (...texts: string[]) => texts.map((text) => ({ text }));

  it('starts on the default when the values fit in five', () => {
    expect(fitRatingScale('number', rows('1', '3', '5'))).toEqual({ max: 5, step: 0.5 });
    expect(fitRatingScale('number', [])).toEqual({ max: 5, step: 0.5 });
  });

  it('widens to the highest value, so scores out of ten keep their numbers', () => {
    const scale = fitRatingScale('number', rows('7', '8', '10', '3'));
    expect(scale).toEqual({ max: 10, step: 1 });
    expect(planConversion('number', 'number', rows('7', '10'), scale).drop).toHaveLength(0);
  });

  it('keeps half steps on a wide scale when a value needs them', () => {
    expect(fitRatingScale('number', rows('7.5', '9'))).toEqual({ max: 9, step: 0.5 });
  });

  it('ignores what no rating could hold rather than stretching for it', () => {
    expect(fitRatingScale('number', rows('0', '250', '3.7', '8'))).toEqual({ max: 8, step: 1 });
    expect(fitRatingScale('number', rows('70', '85'))).toEqual(DEFAULT_RATING_SCALE);
  });

  it('reads values the way the conversion does, for the type they are leaving', () => {
    expect(fitRatingScale('text', rows('9', 'abc', '0x8'))).toEqual({ max: 9, step: 1 });
    expect(fitRatingScale('multiselect', rows('["9"]', '["PC","PS5"]'))).toEqual({ max: 9, step: 1 });
  });
});
