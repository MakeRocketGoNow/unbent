import { describe, expect, it } from 'vitest';
import {
  atoms,
  convertValue,
  fieldNameFor,
  inferColumns,
  notionTimestamp,
  parseNotionDate,
  parseNotionNumber,
  starCount,
} from './notion-columns.js';

describe('Notion values', () => {
  it('reads a date in the words Notion writes, with or without a time, a zone, or a range', () => {
    expect(parseNotionDate('August 2, 2026')).toEqual({ date: '2026-08-02' });
    expect(parseNotionDate('September 12, 2026 10:19 AM')).toEqual({
      date: '2026-09-12',
      time: { hour: 10, minute: 19 },
    });
    expect(parseNotionDate('March 3, 2026 12:30 PM')?.time).toEqual({ hour: 12, minute: 30 });
    expect(parseNotionDate('March 3, 2026 12:05 AM')?.time).toEqual({ hour: 0, minute: 5 });
    expect(parseNotionDate('April 14, 2026 9:44 AM (CDT)')?.date).toBe('2026-04-14');
    expect(parseNotionDate('January 1, 2026 → January 5, 2026')).toEqual({ date: '2026-01-01' });
    expect(parseNotionDate('2026-03-01')).toEqual({ date: '2026-03-01' });
    for (const bad of ['Foo 3, 2026', 'August 32, 2026', 'yesterday', '', '12']) {
      expect(parseNotionDate(bad)).toBeNull();
    }
  });

  it('turns a dated time into the importer\'s own clock, and a bare day into nothing', () => {
    expect(notionTimestamp('September 12, 2026 10:19 AM')).toBe(new Date(2026, 8, 12, 10, 19).getTime());
    expect(notionTimestamp('September 12, 2026')).toBeNull();
  });

  it('reads a number with separators, a sign, a currency symbol or code, and refuses the rest', () => {
    expect(parseNotionNumber('22')).toEqual({ value: 22 });
    expect(parseNotionNumber('1,234.5')).toEqual({ value: 1234.5 });
    expect(parseNotionNumber('-3')).toEqual({ value: -3 });
    expect(parseNotionNumber('$29.99')).toEqual({ value: 29.99, currency: 'USD' });
    expect(parseNotionNumber('-$5')).toEqual({ value: -5, currency: 'USD' });
    expect(parseNotionNumber('€1.50')).toEqual({ value: 1.5, currency: 'EUR' });
    expect(parseNotionNumber('CA$10')).toEqual({ value: 10, currency: 'CAD' });
    expect(parseNotionNumber('CHF 12')).toEqual({ value: 12, currency: 'CHF' });
    expect(parseNotionNumber('12 kr')).toEqual({ value: 12, currency: 'SEK' });
    for (const bad of ['12%', 'abc', '$', '1.2.3', '', '12 apples']) {
      expect(parseNotionNumber(bad)).toBeNull();
    }
  });

  it('counts a run of stars and splits a multi-select', () => {
    expect(starCount('★★★')).toBe(3);
    expect(starCount('⭐⭐')).toBe(2);
    expect(starCount('★★ ')).toBe(2);
    expect(starCount('3 stars')).toBeNull();
    expect(atoms('PC, PS5, Switch')).toEqual(['PC', 'PS5', 'Switch']);
    expect(atoms('Solo')).toEqual(['Solo']);
  });

  it('names a field from a column, dropping Notion\'s prefix and dodging reserved names', () => {
    expect(fieldNameFor('userDefined:URL')).toBe('URL');
    expect(fieldNameFor(' Merchant ')).toBe('Merchant');
    expect(fieldNameFor('title')).toBe('title (Notion)');
    expect(fieldNameFor('x'.repeat(200))).toHaveLength(100);
  });
});

describe('inferColumns', () => {
  const header = [
    'Name', 'Done', 'Played', 'Rating', 'Price', 'Site', 'Platforms', 'Genre', 'Notes',
    'Tags', 'Added On', 'Last Updated', 'Essay', 'Contact', 'Phone', 'Blank',
  ];
  const rows = [
    ['Skyloom', 'Yes', 'October 11, 2024', '★★★', '$29.99', 'https://a.test', 'PC, Switch', 'Strategy', 'Tight combat.', 'Co-op, Indie', 'September 12, 2026 10:19 AM', 'September 12, 2026 10:30 AM', 'x'.repeat(1001), 'a@b.test', '+1 555 0100', ''],
    ['Mind Maze', 'No', 'January 20, 2024', '★★★★★', '$9.99', 'https://b.test', 'PC, Switch', 'Puzzle', 'Small, clever, warm.', 'Indie', 'September 13, 2026 8:00 AM', 'September 13, 2026 8:00 AM', 'short', 'c@d.test', '(555) 010-0200', ''],
    ['Neon', 'Yes', 'August 30, 2023', '⭐⭐⭐⭐', '$49.99', 'https://c.test', 'PS5, PC', 'Strategy', 'Brutal. Stylish.', '', 'September 14, 2026 9:00 PM', 'September 14, 2026 9:05 PM', '', 'e@f.test', '555-0300', ''],
  ];

  it('types every column from its values, and sets the ones that are not fields aside', () => {
    const cols = inferColumns(header, rows);
    expect(cols.map((c) => [c.name, c.kind, c.field?.type ?? null])).toEqual([
      ['Name', 'title', null],
      ['Done', 'field', 'checkbox'],
      ['Played', 'field', 'date'],
      ['Rating', 'field', 'number'],
      ['Price', 'field', 'number'],
      ['Site', 'field', 'url'],
      ['Platforms', 'field', 'multiselect'],
      ['Genre', 'field', 'select'],
      ['Notes', 'field', 'text'],
      ['Tags', 'tags', null],
      ['Added On', 'created', null],
      ['Last Updated', 'updated', null],
      ['Essay', 'body', null],
      ['Contact', 'field', 'email'],
      ['Phone', 'field', 'phone'],
      ['Blank', 'field', 'text'],
    ]);
    const by = Object.fromEntries(cols.map((c) => [c.name, c.field]));
    expect(by['Rating']).toEqual({ name: 'Rating', type: 'number', scale: { max: 5, step: 1 } });
    expect(by['Price']).toEqual({ name: 'Price', type: 'number', currency: 'USD' });
    expect(by['Platforms']).toEqual({ name: 'Platforms', type: 'multiselect', options: ['PC', 'Switch', 'PS5'] });
    expect(by['Genre']).toEqual({ name: 'Genre', type: 'select', options: ['Strategy', 'Puzzle'] });
  });

  it('keeps a column named Tags as a field when asked to, under a name that is not reserved', () => {
    const cols = inferColumns(header, rows, { tagsAsTags: false });
    expect(cols.find((c) => c.source === 'Tags')?.field).toEqual({
      name: 'Tags (Notion)',
      type: 'multiselect',
      options: ['Co-op', 'Indie'],
    });
  });

  it('is conservative: too few repeats means text, mixed currencies mean text, a lone row means text', () => {
    // Nine distinct values in ten rows is a text column that happens to repeat once.
    const names = inferColumns(['Name', 'Studio'], [...Array(10)].map((_, i) => ['G', `Studio ${i === 9 ? 0 : i}`]));
    expect(names[1]?.field?.type).toBe('text');
    // Parts that mostly differ are not options, whatever recurs among them.
    const cities = inferColumns(
      ['Name', 'Where'],
      [['A', 'Roanoke Building, Minneapolis, MN'], ['B', 'Annex, Minneapolis, MN'], ['C', 'Loft, St Paul, MN']],
    );
    expect(cities[1]?.field?.type).toBe('text');
    const one = inferColumns(['Name', 'Genre', 'Where'], [['A', 'RPG', 'PC, PS5']]);
    expect(one.map((c) => c.field?.type)).toEqual([undefined, 'text', 'text']);
    const mixed = inferColumns(['Name', 'Cost'], [['A', '$1'], ['B', '€2']]);
    expect(mixed[1]?.field?.type).toBe('text');
    const some = inferColumns(['Name', 'Cost'], [['A', '$1'], ['B', '2']]);
    expect(some[1]?.field?.type).toBe('text');
    const address = inferColumns(
      ['Name', 'Address'],
      [['A', '10 High Street, Roanoke Building'], ['B', '4 Low Road, Annex']],
    );
    expect(address[1]?.field?.type).toBe('text');
  });

  it('widens a star rating past five when a value needs it, up to the scale cap', () => {
    const cols = inferColumns(['Name', 'Stars'], [['A', '★★★★★★★'], ['B', '★']]);
    expect(cols[1]?.field?.scale).toEqual({ max: 7, step: 1 });
    const wide = inferColumns(['Name', 'Stars'], [['A', '★'.repeat(12)]]);
    expect(wide[1]?.field?.scale).toEqual({ max: 10, step: 1 });
  });

  it('only calls a stamp column created or updated by its name', () => {
    const cols = inferColumns(['Name', 'Bookmarked At'], [['A', 'April 14, 2026 9:44 AM (CDT)']]);
    expect(cols[1]).toMatchObject({ kind: 'field', field: { type: 'date' } });
  });
});

describe('convertValue', () => {
  const cols = inferColumns(
    ['Name', 'Done', 'Played', 'Rating', 'Price', 'Platforms', 'Genre', 'Notes'],
    [
      ['A', 'Yes', 'August 2, 2026', '★★', '$5', 'PC, PS5', 'RPG', 'x'],
      ['B', 'No', 'August 3, 2026', '★', '$6', 'PC, PS5', 'RPG', 'y'],
    ],
  );
  const by = Object.fromEntries(cols.map((c) => [c.name, c]));

  it('reads each value as its field stores it', () => {
    expect(convertValue(by['Done']!, 'Yes')).toBe(true);
    expect(convertValue(by['Done']!, 'No')).toBe(false);
    expect(convertValue(by['Played']!, 'August 2, 2026')).toBe('2026-08-02');
    expect(convertValue(by['Rating']!, '★★')).toBe(2);
    expect(convertValue(by['Price']!, '$5.50')).toBe(5.5);
    expect(convertValue(by['Platforms']!, 'PS5, PC')).toEqual(['PS5', 'PC']);
    expect(convertValue(by['Genre']!, 'RPG')).toBe('RPG');
    expect(convertValue(by['Notes']!, ' text ')).toBe('text');
  });

  it('is null for a blank, for a value the type cannot read, and for a column that is not a field', () => {
    expect(convertValue(by['Done']!, '')).toBeNull();
    expect(convertValue(by['Done']!, 'Maybe')).toBeNull();
    expect(convertValue(by['Played']!, 'soon')).toBeNull();
    expect(convertValue(by['Rating']!, '7')).toBeNull();
    expect(convertValue(by['Name']!, 'A')).toBeNull();
  });
});
