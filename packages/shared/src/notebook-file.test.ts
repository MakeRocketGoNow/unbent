import { describe, expect, it } from 'vitest';
import type { FieldDef } from './fields.js';
import { NotebookFileError, parseNotebook, serializeNotebook } from './notebook-file.js';

const def = (over: Partial<FieldDef> & { name: string; type: FieldDef['type'] }): FieldDef => ({
  id: `id-${over.name}`,
  notebookId: 'nb1',
  options: [],
  scale: null,
  currency: null,
  position: 0,
  ...over,
});

describe('the notebook definitions file', () => {
  it('round-trips every kind of definition with its order intact', () => {
    const fields = [
      def({ name: 'Url', type: 'url' }),
      def({ name: 'Price', type: 'number' }),
      def({ name: 'Category', type: 'select', options: ['Bike', 'Toys & Collectibles'] }),
      def({ name: 'Priority', type: 'number', scale: { max: 5, step: 0.5 } }),
      def({ name: 'Captured', type: 'date' }),
      def({ name: 'Image', type: 'url' }),
      def({ name: 'Platforms', type: 'multiselect', options: ['PC', 'PS5'] }),
      def({ name: 'Cost', type: 'number', currency: 'EUR' }),
    ];

    const text = serializeNotebook({ name: 'Coupons' }, fields);
    expect(parseNotebook(text)).toEqual({
      name: 'Coupons',
      fields: [
        { name: 'Url', type: 'url' },
        { name: 'Price', type: 'number' },
        { name: 'Category', type: 'select', options: ['Bike', 'Toys & Collectibles'] },
        { name: 'Priority', type: 'number', scale: { max: 5, step: 0.5 } },
        { name: 'Captured', type: 'date' },
        { name: 'Image', type: 'url' },
        { name: 'Platforms', type: 'multiselect', options: ['PC', 'PS5'] },
        { name: 'Cost', type: 'number', currency: 'EUR' },
      ],
    });
  });

  it('writes options, scale and currency only where the type can use them', () => {
    const text = serializeNotebook({ name: 'Coupons' }, [
      def({ name: 'Store', type: 'text', options: ['stale'], currency: 'USD' }),
      def({ name: 'Rating', type: 'number', scale: { max: 10, step: 1 }, currency: 'USD' }),
    ]);
    expect(text).not.toContain('options');
    expect(text).not.toContain('currency');
    expect(text).toContain('max: 10');
  });

  it('keeps names YAML would otherwise misread', () => {
    const parsed = parseNotebook(
      serializeNotebook({ name: 'Re: things' }, [def({ name: 'Yes', type: 'checkbox' })]),
    );
    expect(parsed.name).toBe('Re: things');
    expect(parsed.fields[0]?.name).toBe('Yes');
  });

  it('reads a notebook with no fields', () => {
    expect(parseNotebook('name: Empty\n')).toEqual({ name: 'Empty', fields: [] });
    expect(parseNotebook(serializeNotebook({ name: 'Empty' }, []))).toEqual({ name: 'Empty', fields: [] });
  });

  it('round-trips a notebook emoji and purpose', () => {
    const text = serializeNotebook(
      { name: 'Coupons', emoji: '🧾', purpose: 'Paper coupons: store, expiry, what they are for.' },
      [def({ name: 'Store', type: 'text' })],
    );
    expect(parseNotebook(text)).toEqual({
      name: 'Coupons',
      emoji: '🧾',
      purpose: 'Paper coupons: store, expiry, what they are for.',
      fields: [{ name: 'Store', type: 'text' }],
    });
  });

  it('writes a notebook with no emoji or purpose exactly as it did before either existed', () => {
    const fields = [def({ name: 'Store', type: 'text' })];
    const text = serializeNotebook({ name: 'Coupons', emoji: null, purpose: null }, fields);
    expect(text).toBe('name: Coupons\nfields:\n  - name: Store\n    type: text\n');
    expect(serializeNotebook({ name: 'Coupons' }, fields)).toBe(text);
  });

  it('refuses an emoji or purpose the settings page would refuse', () => {
    expect(() => parseNotebook('name: X\nemoji: book\n')).toThrow(/emoji/);
    expect(() => parseNotebook('name: X\nemoji: 🧾📚\n')).toThrow(NotebookFileError);
    expect(() => parseNotebook(`name: X\npurpose: ${'a'.repeat(501)}\n`)).toThrow(/purpose/);
    // Blank clears, as it does in the editor, rather than being refused.
    expect(parseNotebook('name: X\npurpose: "  "\n').purpose).toBeNull();
  });

  it('refuses what the field editor refuses, and says where', () => {
    expect(() => parseNotebook('name: X\nfields:\n  - name: title\n    type: text\n')).toThrow(
      NotebookFileError,
    );
    expect(() => parseNotebook('name: X\nfields:\n  - name: A\n    type: colour\n')).toThrow(
      /fields\.0\.type/,
    );
    expect(() => parseNotebook('name: ""\n')).toThrow(NotebookFileError);
    expect(() => parseNotebook('- not\n- a mapping\n')).toThrow(NotebookFileError);
    expect(() => parseNotebook('name: [unterminated\n')).toThrow(/Malformed YAML/);
  });
});

describe('option colours in the definitions file', () => {
  it('writes each option colour by name and reads it back as the index', () => {
    const text = serializeNotebook({ name: 'Coupons' }, [
      def({ name: 'Category', type: 'select', options: ['Bike', 'Toys'], optionColors: { Bike: 3, Toys: 5, Gone: 0 } }),
    ]);
    expect(text).toContain('colors:');
    expect(text).toContain('Bike: green');
    expect(text).not.toContain('Gone');
    expect(parseNotebook(text).fields[0]).toEqual({
      name: 'Category',
      type: 'select',
      options: ['Bike', 'Toys'],
      optionColors: { Bike: 3, Toys: 5 },
    });
  });

  it('writes no colours for a field the server sent none for, and reads a file without them', () => {
    const text = serializeNotebook({ name: 'Coupons' }, [def({ name: 'Category', type: 'select', options: ['Bike'] })]);
    expect(text).not.toContain('colors');
    expect(parseNotebook(text).fields[0]).not.toHaveProperty('optionColors');
  });

  it('accepts an index for a colour and refuses a name the palette does not have', () => {
    const parsed = parseNotebook('name: Coupons\nfields:\n  - name: Category\n    type: select\n    options: [Bike]\n    colors: {Bike: 7}\n');
    expect(parsed.fields[0]?.optionColors).toEqual({ Bike: 7 });
    expect(() =>
      parseNotebook('name: Coupons\nfields:\n  - name: Category\n    type: select\n    options: [Bike]\n    colors: {Bike: mauve}\n'),
    ).toThrow(/Not a colour: mauve/);
  });
});
