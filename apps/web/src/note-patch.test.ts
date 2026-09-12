import { describe, expect, it } from 'vitest';
import type { FieldDef, Note, NoteFieldValue } from '@unbent/shared';
import { buildNotePatch, type NoteDraft } from './note-patch.js';

const amount: FieldDef = {
  id: '11111111-1111-1111-1111-111111111111',
  notebookId: 'nb1',
  name: 'Amount',
  type: 'number',
  options: [],
  position: 0,
};

const site: FieldDef = {
  id: '22222222-2222-2222-2222-222222222222',
  notebookId: 'nb1',
  name: 'Site',
  type: 'url',
  options: [],
  position: 1,
};

const kind: FieldDef = {
  id: '33333333-3333-3333-3333-333333333333',
  notebookId: 'nb1',
  name: 'Kind',
  type: 'select',
  options: ['Food'],
  position: 2,
};

const gone = '44444444-4444-4444-4444-444444444444';

function value(
  field: FieldDef,
  stored: string | number | boolean,
  extras: Partial<NoteFieldValue> = {},
): NoteFieldValue {
  return {
    fieldId: field.id,
    name: field.name,
    type: field.type,
    value: stored,
    notebookId: field.notebookId,
    notebook: 'Receipts',
    ...extras,
  };
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Invoice',
    body: 'paid',
    tags: ['tax'],
    notebook: 'Receipts',
    createdAt: 0,
    updatedAt: 0,
    fields: [value(amount, 12)],
    ...overrides,
  };
}

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    title: 'Invoice',
    body: 'paid',
    tags: ['tax'],
    notebook: 'Receipts',
    fields: { [amount.id]: 12 },
    ...overrides,
  };
}

describe('buildNotePatch', () => {
  it('sends only the body when that is what changed', () => {
    expect(buildNotePatch(draft({ body: 'paid yesterday' }), note(), [amount])).toEqual({
      body: 'paid yesterday',
    });
  });

  it('sends a title, notebook or tag change without the rest of the draft', () => {
    expect(buildNotePatch(draft({ title: 'Invoice 2024' }), note(), [amount])).toEqual({
      title: 'Invoice 2024',
    });
    expect(buildNotePatch(draft({ notebook: 'Taxes' }), note(), [amount])).toEqual({
      notebook: 'Taxes',
    });
    expect(buildNotePatch(draft({ tags: ['tax', 'done'] }), note(), [amount])).toEqual({
      tags: ['tax', 'done'],
    });
  });

  it('returns null when nothing storeable changed, so a save does not hit the network', () => {
    expect(buildNotePatch(draft(), note(), [amount])).toBeNull();
  });

  /*
     A number input emits strings as they are typed. "12." is not a number yet, and
     sending it used to 400 the whole PATCH — the body typed in the same breath included.
  */
  it('keeps a body edit when a number field is only halfway typed', () => {
    expect(
      buildNotePatch(
        draft({ body: 'new', fields: { [amount.id]: '12.' } }),
        note(),
        [amount],
      ),
    ).toEqual({ body: 'new' });
  });

  it('keeps a body edit when a URL is still being written', () => {
    const withSite = note({ fields: [value(amount, 12), value(site, 'https://old.test')] });
    expect(
      buildNotePatch(
        draft({
          body: 'new',
          fields: { [amount.id]: 12, [site.id]: 'http://' },
        }),
        withSite,
        [amount, site],
      ),
    ).toEqual({ body: 'new' });
  });

  it('omits a deleted field id so a stale draft cannot 400 the save', () => {
    expect(
      buildNotePatch(
        draft({ body: 'new', fields: { [amount.id]: 12, [gone]: 'leftover' } }),
        note(),
        [amount],
      ),
    ).toEqual({ body: 'new' });
  });

  it('sends a finished field value, and a clear, and leaves an unchanged retired select out', () => {
    expect(
      buildNotePatch(draft({ fields: { [amount.id]: '12.5' } }), note(), [amount]),
    ).toEqual({ fields: { [amount.id]: '12.5' } });

    expect(
      buildNotePatch(draft({ fields: { [amount.id]: null } }), note(), [amount]),
    ).toEqual({ fields: { [amount.id]: null } });

    const withKind = note({
      fields: [value(amount, 12), value(kind, 'Travel')],
    });
    expect(
      buildNotePatch(
        draft({
          body: 'new',
          fields: { [amount.id]: 12, [kind.id]: 'Travel' },
        }),
        withKind,
        [amount, kind],
      ),
    ).toEqual({ body: 'new' });
  });

  /*
     `encodeFieldValue` answers 'clear' for an emptied input rather than an encoded value.
     Nothing in the UI sends one — `NoteFields` turns '' into null before it reaches the
     draft — but this function is called directly, and a raw '' is a clear, not a value.
  */
  it('reads an emptied field value as a clear rather than sending the empty string', () => {
    const withBoth = note({
      fields: [value(amount, 12), value(site, 'https://old.test'), value(kind, 'Food')],
    });
    expect(
      buildNotePatch(
        draft({ fields: { [amount.id]: 12, [site.id]: '', [kind.id]: '   ' } }),
        withBoth,
        [amount, site, kind],
      ),
    ).toEqual({ fields: { [site.id]: null, [kind.id]: null } });
  });

  it('leaves an emptied field out when the note has nothing to clear', () => {
    expect(
      buildNotePatch(draft({ fields: { [amount.id]: 12, [site.id]: '' } }), note(), [amount, site]),
    ).toBeNull();
  });

  it('treats a number the input re-emitted as a string as unchanged', () => {
    expect(buildNotePatch(draft({ fields: { [amount.id]: '12' } }), note(), [amount])).toBeNull();
  });
});
