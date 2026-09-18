import { describe, expect, it } from 'vitest';
import type { FieldDef, Note, NoteFieldValue } from '@unbent/shared';
import {
  buildNotePatch,
  rememberFieldDefs,
  unstoreableFieldIds,
  type NoteDraft,
} from './note-patch.js';

const amount: FieldDef = {
  id: '11111111-1111-1111-1111-111111111111',
  notebookId: 'nb1',
  name: 'Amount',
  type: 'number',
  options: [],
  scale: null,
  position: 0,
};

const site: FieldDef = {
  id: '22222222-2222-2222-2222-222222222222',
  notebookId: 'nb1',
  name: 'Site',
  type: 'url',
  options: [],
  scale: null,
  position: 1,
};

const kind: FieldDef = {
  id: '33333333-3333-3333-3333-333333333333',
  notebookId: 'nb1',
  name: 'Kind',
  type: 'select',
  options: ['Food'],
  scale: null,
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

  it('sends a field value the type can read', () => {
    expect(
      buildNotePatch(draft({ fields: { [amount.id]: '12.5' } }), note(), [amount]),
    ).toEqual({ fields: { [amount.id]: '12.5' } });
  });

  it('sends a null the draft holds as a clear', () => {
    expect(
      buildNotePatch(draft({ fields: { [amount.id]: null } }), note(), [amount]),
    ).toEqual({ fields: { [amount.id]: null } });
  });

  /*
     Options can be retired without converting the field, and the editor keeps showing a
     value a note already holds. Resending it is not an edit, so it never reaches the
     check that would reject it for not being on the list.
  */
  it('leaves an unchanged retired select value out', () => {
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

  /*
     Filing a note is a notebook change. The current notebook's definitions then no longer
     include Amount — or are undefined while they load — and Amount was empty, so there is
     no stored row to take the type from. Handing the definition we already loaded is what
     keeps the just-typed number in the patch; without it only the notebook would go.
  */
  it('still sends a newly typed field when the note is filed in another notebook', () => {
    const empty = note({ fields: [] });
    expect(
      buildNotePatch(
        draft({
          notebook: 'Taxes',
          fields: { [amount.id]: '12.5' },
        }),
        empty,
        [amount],
      ),
    ).toEqual({ notebook: 'Taxes', fields: { [amount.id]: '12.5' } });
  });

  it('drops that newly typed field when no definition is known, matching a leftover id', () => {
    const empty = note({ fields: [] });
    expect(
      buildNotePatch(
        draft({ notebook: 'Taxes', fields: { [amount.id]: '12.5' } }),
        empty,
        [],
      ),
    ).toEqual({ notebook: 'Taxes' });
    expect(
      buildNotePatch(
        draft({ notebook: 'Taxes', fields: { [amount.id]: '12.5' } }),
        empty,
        undefined,
      ),
    ).toEqual({ notebook: 'Taxes' });
  });
});

describe('rememberFieldDefs', () => {
  it('keeps a previous notebook\'s definitions after the current list is replaced', () => {
    const seen = new Map<string, FieldDef>();
    expect(rememberFieldDefs(seen, [amount])).toEqual([amount]);
    expect(rememberFieldDefs(seen, [])).toEqual([amount]);
    expect(rememberFieldDefs(seen, undefined)).toEqual([amount]);
  });

  it('adds the new notebook\'s definitions without dropping the old', () => {
    const seen = new Map<string, FieldDef>();
    rememberFieldDefs(seen, [amount]);
    const taxesAmount: FieldDef = { ...amount, id: 'taxes-amount', notebookId: 'nb2' };
    expect(rememberFieldDefs(seen, [taxesAmount]).map((d) => d.id).sort()).toEqual(
      ['taxes-amount', amount.id].sort(),
    );
  });
});

describe('unstoreableFieldIds', () => {
  it('names the field whose value the save is leaving behind', () => {
    expect(
      unstoreableFieldIds(draft({ body: 'new', fields: { [amount.id]: '12.' } }), note(), [amount]),
    ).toEqual([amount.id]);
  });

  it('names nothing when every value is one the type can read', () => {
    expect(unstoreableFieldIds(draft({ fields: { [amount.id]: '12.5' } }), note(), [amount])).toEqual(
      [],
    );
    expect(unstoreableFieldIds(draft({ fields: { [amount.id]: null } }), note(), [amount])).toEqual([]);
  });

  /*
     Neither of these is something the user can finish typing, so neither belongs in an
     indicator asking them to: the field is gone, and the retired select value is one the
     note already holds.
  */
  it('names neither a deleted field nor an unchanged retired select', () => {
    expect(
      unstoreableFieldIds(draft({ fields: { [amount.id]: 12, [gone]: 'leftover' } }), note(), [
        amount,
      ]),
    ).toEqual([]);

    const withKind = note({ fields: [value(amount, 12), value(kind, 'Travel')] });
    expect(
      unstoreableFieldIds(
        draft({ fields: { [amount.id]: 12, [kind.id]: 'Travel' } }),
        withKind,
        [amount, kind],
      ),
    ).toEqual([]);
  });
});
