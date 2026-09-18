import { describe, expect, it } from 'vitest';
import type { FieldDef } from './fields.js';
import { NotebookFileError, parseNotebook, serializeNotebook } from './notebook-file.js';

const def = (over: Partial<FieldDef> & { name: string; type: FieldDef['type'] }): FieldDef => ({
  id: `id-${over.name}`,
  notebookId: 'nb1',
  options: [],
  scale: null,
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
    ];

    const text = serializeNotebook('Coupons', fields);
    expect(parseNotebook(text)).toEqual({
      name: 'Coupons',
      fields: [
        { name: 'Url', type: 'url' },
        { name: 'Price', type: 'number' },
        { name: 'Category', type: 'select', options: ['Bike', 'Toys & Collectibles'] },
        { name: 'Priority', type: 'number', scale: { max: 5, step: 0.5 } },
        { name: 'Captured', type: 'date' },
        { name: 'Image', type: 'url' },
      ],
    });
  });

  it('writes options and scale only where the type can use them', () => {
    const text = serializeNotebook('Coupons', [
      def({ name: 'Store', type: 'text', options: ['stale'] }),
      def({ name: 'Rating', type: 'number', scale: { max: 10, step: 1 } }),
    ]);
    expect(text).not.toContain('options');
    expect(text).toContain('max: 10');
  });

  it('keeps names YAML would otherwise misread', () => {
    const parsed = parseNotebook(
      serializeNotebook('Re: things', [def({ name: 'Yes', type: 'checkbox' })]),
    );
    expect(parsed.name).toBe('Re: things');
    expect(parsed.fields[0]?.name).toBe('Yes');
  });

  it('reads a notebook with no fields', () => {
    expect(parseNotebook('name: Empty\n')).toEqual({ name: 'Empty', fields: [] });
    expect(parseNotebook(serializeNotebook('Empty', []))).toEqual({ name: 'Empty', fields: [] });
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
