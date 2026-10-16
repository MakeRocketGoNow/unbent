import { describe, expect, it } from 'vitest';
import type { FieldDef, FieldValue, Note, NoteFieldValue } from '@unbent/shared';
import {
  buildNotePatch,
  holdsTheirChanges,
  rebaseAfterAck,
  rememberFieldDefs,
  seedFromKeepingHeld,
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
  currency: null,
  position: 0,
};

const site: FieldDef = {
  id: '22222222-2222-2222-2222-222222222222',
  notebookId: 'nb1',
  name: 'Site',
  type: 'url',
  options: [],
  scale: null,
  currency: null,
  position: 1,
};

const kind: FieldDef = {
  id: '33333333-3333-3333-3333-333333333333',
  notebookId: 'nb1',
  name: 'Kind',
  type: 'select',
  options: ['Food'],
  scale: null,
  currency: null,
  position: 2,
};

const platforms: FieldDef = {
  id: '55555555-5555-5555-5555-555555555555',
  notebookId: 'nb1',
  name: 'Platforms',
  type: 'multiselect',
  options: ['PC', 'PS5', 'Switch'],
  scale: null,
  currency: null,
  position: 3,
};

const gone = '44444444-4444-4444-4444-444444444444';

function value(
  field: FieldDef,
  stored: FieldValue,
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
     sending it used to 400 the whole PATCH: the body typed in the same breath included.
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
     The server stores a multi-select in the option list's order and the editor holds it
     in the order the options were picked. The same set in another order is not an edit;
     a different set is.
  */
  it('treats a multi-select resent in another order as unchanged, and a changed set as an edit', () => {
    const withPlatforms = note({ fields: [value(amount, 12), value(platforms, ['PC', 'PS5'])] });
    expect(
      buildNotePatch(
        draft({ fields: { [amount.id]: 12, [platforms.id]: ['PS5', 'PC'] } }),
        withPlatforms,
        [amount, platforms],
      ),
    ).toBeNull();
    expect(
      buildNotePatch(
        draft({ fields: { [amount.id]: 12, [platforms.id]: ['PC', 'PS5', 'Switch'] } }),
        withPlatforms,
        [amount, platforms],
      ),
    ).toEqual({ fields: { [platforms.id]: ['PC', 'PS5', 'Switch'] } });
    // A list naming something that is no option is held back, like a half-typed number.
    expect(
      unstoreableFieldIds(
        draft({ fields: { [amount.id]: 12, [platforms.id]: ['PC', 'Xbox'] } }),
        withPlatforms,
        [amount, platforms],
      ),
    ).toEqual([platforms.id]);
  });

  /*
     `encodeFieldValue` answers 'clear' for an emptied input rather than an encoded value.
     Nothing in the UI sends one (`NoteFields` turns '' into null before it reaches the
     draft), but this function is called directly, and a raw '' is a clear, not a value.
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
     include Amount (or are undefined while they load), and Amount was empty, so there is
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

  it('names only a field the editor can type into, when it says which those are', () => {
    // Stored, so the row's type alone says "12." is not a number yet, but carried from a
    // notebook the note has left, there is no input to finish it in.
    const carried = note({ fields: [value(amount, 10)] });
    const typing = draft({ fields: { [amount.id]: '12.' } });
    expect(unstoreableFieldIds(typing, carried, [], new Set())).toEqual([]);
    expect(unstoreableFieldIds(typing, carried, [])).toEqual([amount.id]);
    expect(unstoreableFieldIds(typing, carried, [amount], new Set([amount.id]))).toEqual([amount.id]);
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

/**
 * Whether a save refused as stale can go again without asking: every change made to the
 * note since the draft's copy is one the draft already holds. Each case is paired with the
 * one beside it that must still ask, since a check that always said yes would be the
 * silent overwrite all over again.
 */
describe('holdsTheirChanges', () => {
  const base = { title: 'Trip', body: 'Body', tags: ['a'], notebook: null, fields: [] as NoteFieldValue[] };
  const draftOf = (over: Partial<NoteDraft> = {}): NoteDraft => ({
    title: 'Trip',
    body: 'Body',
    tags: ['a'],
    notebook: null,
    fields: {},
    ...over,
  });

  it('says yes when the other side made the edit the draft already has', () => {
    const current = { ...base, title: 'Trip, renamed' };
    expect(holdsTheirChanges(draftOf({ title: 'Trip, renamed' }), base, current)).toBe(true);
    expect(holdsTheirChanges(draftOf({ title: 'Trip, mine' }), base, current)).toBe(false);
  });

  it('says no when the other side changed something the draft still has the old version of', () => {
    // A body edited here and a title edited there do not collide, but the draft's title is
    // the old one, and saving it on would put that back.
    const current = { ...base, title: 'Trip, renamed' };
    expect(holdsTheirChanges(draftOf({ body: 'Body, edited here' }), base, current)).toBe(false);
  });

  it('compares tags as a set, the way a bulk tag reaches the draft', () => {
    const current = { ...base, tags: ['a', 'b'] };
    expect(holdsTheirChanges(draftOf({ tags: ['b', 'a'], body: 'Body, edited' }), base, current)).toBe(true);
    expect(holdsTheirChanges(draftOf({ tags: ['a'] }), base, current)).toBe(false);
  });

  it('takes a bulk move the draft was told about', () => {
    const current = { ...base, notebook: 'Coupons' };
    expect(holdsTheirChanges(draftOf({ notebook: 'Coupons' }), base, current)).toBe(true);
    expect(holdsTheirChanges(draftOf(), base, current)).toBe(false);
  });

  it('reads field values by what they say, and a cleared value as a change', () => {
    const value = (v: FieldValue): NoteFieldValue[] => [
      { fieldId: amount.id, name: 'Amount', type: 'number', value: v, notebook: 'Receipts' } as NoteFieldValue,
    ];
    const was = { ...base, fields: value(12) };
    expect(holdsTheirChanges(draftOf({ fields: { [amount.id]: '13' } }), was, { ...was, fields: value(13) })).toBe(true);
    expect(holdsTheirChanges(draftOf({ fields: { [amount.id]: 12 } }), was, { ...was, fields: value(13) })).toBe(false);
    expect(holdsTheirChanges(draftOf({ fields: { [amount.id]: 12 } }), was, { ...was, fields: [] })).toBe(false);
    expect(holdsTheirChanges(draftOf({ fields: { [amount.id]: null } }), was, { ...was, fields: [] })).toBe(true);
  });

  it('says yes when nothing the draft can see has changed at all', () => {
    // The date moved for something the draft does not hold: an attachment, say.
    expect(holdsTheirChanges(draftOf({ body: 'Body, edited' }), base, { ...base })).toBe(true);
  });
});

/**
 * What the open draft holds after a save comes back mid-typing: the server's value for
 * whatever the person has not edited, theirs for whatever they have. Each case pairs the
 * taken value with the kept one, since a rebase that always took the server's would
 * throw away typing, and one that never did is the bug.
 */
describe('rebaseAfterAck', () => {
  const base = { title: 'Trip', body: 'Body', tags: ['garden'], notebook: 'Coupons', fields: [] as NoteFieldValue[] };
  // What the answered save carried: the base as typed then, before the typing since.
  const sent: NoteDraft = { title: 'Trip', body: 'Body', tags: ['garden'], notebook: 'Coupons', fields: {} };
  const draftOf = (over: Partial<NoteDraft> = {}): NoteDraft => ({
    title: 'Trip',
    body: 'Body, typing',
    tags: ['garden'],
    notebook: 'Coupons',
    fields: {},
    ...over,
  });

  it('takes the server\'s tags when the person has not edited them, compared as a set', () => {
    const server = { ...base, tags: ['garden', 'receipts'] };
    expect(rebaseAfterAck(draftOf(), sent, server).tags).toEqual(['garden', 'receipts']);
    expect(rebaseAfterAck(draftOf({ tags: ['b', 'a'] }), { ...sent, tags: ['a', 'b'] }, { ...base, tags: ['a', 'b', 'c'] }).tags).toEqual(['a', 'b', 'c']);
    expect(rebaseAfterAck(draftOf({ tags: ['garden', 'tax'] }), sent, server).tags).toEqual(['garden', 'tax']);
    expect(rebaseAfterAck(draftOf({ tags: [] }), sent, server).tags).toEqual([]);
  });

  it('takes a notebook renamed elsewhere unless the person moved the note', () => {
    const server = { ...base, notebook: 'Coupons 2026' };
    expect(rebaseAfterAck(draftOf(), sent, server).notebook).toBe('Coupons 2026');
    expect(rebaseAfterAck(draftOf({ notebook: 'Receipts' }), sent, server).notebook).toBe('Receipts');
  });

  it('takes the title unless the person is editing it, and always keeps the body', () => {
    const server = { ...base, title: 'Trip, renamed', body: 'Body' };
    const rebased = rebaseAfterAck(draftOf(), sent, server);
    expect(rebased.title).toBe('Trip, renamed');
    expect(rebased.body).toBe('Body, typing');
    expect(rebaseAfterAck(draftOf({ title: 'Trip, mine' }), sent, server).title).toBe('Trip, mine');
  });

  it('keeps a title typed and taken back while the save was out', () => {
    // The save sent "Trip x"; the person deleted the " x" before the answer came. The
    // draft equals the base again, and measured against that it took the " x" back.
    const typed = { ...sent, title: 'Trip x' };
    expect(rebaseAfterAck(draftOf({ title: 'Trip' }), typed, { ...base, title: 'Trip x' }).title).toBe('Trip');
  });

  it('takes a field the server rewrote unless the person typed in it', () => {
    const value = (v: FieldValue): NoteFieldValue[] => [
      { fieldId: amount.id, name: 'Amount', type: 'number', value: v, notebook: 'Receipts' } as NoteFieldValue,
    ];
    const was = { ...base, fields: value(12) };
    const sentWith = { ...sent, fields: { [amount.id]: 12 } };
    expect(rebaseAfterAck(draftOf({ fields: { [amount.id]: 12 } }), sentWith, { ...was, fields: value(13) }).fields).toEqual({
      [amount.id]: 13,
    });
    expect(rebaseAfterAck(draftOf({ fields: { [amount.id]: '14' } }), sentWith, { ...was, fields: value(13) }).fields).toEqual({
      [amount.id]: '14',
    });
  });

  it('keeps a half-typed number that the save left out of the patch', () => {
    // Sent and still on the draft: "12." is not a number yet, so the patch omitted it
    // and the answer still has the stored 10. Measured as "unchanged" that would take 10.
    const stored = { ...base, fields: [value(amount, 10)] };
    const typing = { ...sent, fields: { [amount.id]: '12.' } };
    expect(rebaseAfterAck(typing, typing, stored, [amount]).fields).toEqual({ [amount.id]: '12.' });
  });

  it('knows a first value is held only from the definitions when nothing is stored', () => {
    // No stored row to read the type from: without the definition, "12." is an unknown
    // id and the empty answer wins.
    const empty = { ...base, fields: [] };
    const typing = { ...sent, fields: { [amount.id]: '12.' } };
    expect(rebaseAfterAck(typing, typing, empty, [amount]).fields).toEqual({ [amount.id]: '12.' });
    expect(rebaseAfterAck(typing, typing, empty).fields).toEqual({ [amount.id]: null });
  });
});

describe('seedFromKeepingHeld', () => {
  it('keeps a half-typed number the server never stored, and takes everything else', () => {
    const stored = note({ title: 'Trip, saved', fields: [value(amount, 10)] });
    const draft: NoteDraft = {
      title: 'Trip, saved',
      body: 'paid',
      tags: ['tax'],
      notebook: 'Receipts',
      fields: { [amount.id]: '12.' },
    };
    expect(seedFromKeepingHeld(stored, draft, [amount])).toEqual({
      title: 'Trip, saved',
      body: 'paid',
      tags: ['tax'],
      notebook: 'Receipts',
      fields: { [amount.id]: '12.' },
    });
  });

  it('knows a first value is held only from the definitions when nothing is stored', () => {
    const empty = note({ title: 'Trip, saved', fields: [] });
    const draft: NoteDraft = {
      title: 'Trip, saved',
      body: 'paid',
      tags: ['tax'],
      notebook: 'Receipts',
      fields: { [amount.id]: '12.' },
    };
    expect(seedFromKeepingHeld(empty, draft, [amount]).fields).toEqual({ [amount.id]: '12.' });
    expect(seedFromKeepingHeld(empty, draft).fields).toEqual({});
  });

  it('is seedFrom when nothing is being held', () => {
    const stored = note({ title: 'Trip, saved', fields: [value(amount, 10)] });
    const draft: NoteDraft = {
      title: 'Trip, saved',
      body: 'paid',
      tags: ['tax'],
      notebook: 'Receipts',
      fields: { [amount.id]: 10 },
    };
    expect(seedFromKeepingHeld(stored, draft, [amount])).toEqual({
      title: 'Trip, saved',
      body: 'paid',
      tags: ['tax'],
      notebook: 'Receipts',
      fields: { [amount.id]: 10 },
    });
  });
});
