import { describe, expect, it } from 'vitest';
import type { AutofillSuggestion, FieldDef } from '@unbent/shared';
import type { NoteDraft } from './note-patch.js';
import {
  applyAutofill,
  describeChanges,
  isEmptyChanges,
  isPlaceholderTitle,
  planAutofill,
} from './autofill.js';

const amount: FieldDef = {
  id: 'f-amount',
  notebookId: 'nb-receipts',
  name: 'Amount',
  type: 'number',
  options: [],
  scale: null,
  currency: 'USD',
  position: 0,
};
const via: FieldDef = { ...amount, id: 'f-via', name: 'Paid via', type: 'multiselect', options: ['Card', 'Cash'], currency: null };

const suggestion: AutofillSuggestion = {
  title: { value: 'Acme Hardware', confidence: 0.8 },
  notebook: { id: 'nb-receipts', name: 'Receipts', confidence: 0.9 },
  tags: [
    { name: 'home', confidence: 0.9 },
    { name: 'taxes', confidence: 0.8 },
  ],
  fields: [
    { field: amount, value: 12.5, confidence: 0.9 },
    { field: via, value: ['Card'], confidence: 0.8 },
  ],
  read: { attachments: ['scan.pdf'], pending: [] },
};

const fresh: NoteDraft = { title: '', body: '', tags: [], notebook: null, fields: {} };

describe('planning a fill', () => {
  it('fills everything on a note that has nothing, and asks about nothing', () => {
    const { fill, replace } = planAutofill(fresh, suggestion);
    expect(fill).toEqual({
      title: 'Acme Hardware',
      notebook: 'Receipts',
      tags: ['home', 'taxes'],
      fields: [
        { def: amount, value: 12.5 },
        { def: via, value: ['Card'] },
      ],
    });
    expect(isEmptyChanges(replace)).toBe(true);
  });

  it('keeps what is set and offers to replace it, while still filling the empties', () => {
    const filed: NoteDraft = {
      ...fresh,
      title: 'My own title',
      tags: ['Home'],
      notebook: 'receipts',
      fields: { 'f-amount': 20 },
    };
    const { fill, replace } = planAutofill(filed, suggestion);
    // The notebook matches by name, whatever the case; "home" is already there.
    expect(fill).toEqual({ tags: ['taxes'], fields: [{ def: via, value: ['Card'] }] });
    expect(replace).toEqual({ title: 'Acme Hardware', tags: [], fields: [{ def: amount, value: 12.5 }] });
  });

  it('bundles the fields with a move, since they belong to the notebook the note would go to', () => {
    const elsewhere: NoteDraft = { ...fresh, notebook: 'Coupons' };
    const { fill, replace } = planAutofill(elsewhere, suggestion);
    expect(fill).toEqual({ title: 'Acme Hardware', tags: ['home', 'taxes'], fields: [] });
    expect(replace).toMatchObject({ notebook: 'Receipts', fields: suggestion.fields.map((f) => ({ def: f.field, value: f.value })) });
  });

  it('proposes nothing for a value the note already holds', () => {
    const same: NoteDraft = { ...fresh, title: 'Acme Hardware', notebook: 'Receipts', fields: { 'f-amount': '12.5', 'f-via': ['Card'] } };
    const { fill, replace } = planAutofill(same, suggestion);
    expect(fill).toEqual({ tags: ['home', 'taxes'], fields: [] });
    expect(isEmptyChanges(replace)).toBe(true);
  });
});

describe('recognising a placeholder title', () => {
  it('treats a blank or whitespace title as a placeholder', () => {
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('   ')).toBe(true);
  });

  it('treats a scanner timestamp as a placeholder', () => {
    // What ScanSnap leaves: `2026_09_18_15_38_48.pdf` → this title.
    expect(isPlaceholderTitle('2026_09_18_15_38_48')).toBe(true);
    expect(isPlaceholderTitle('  2026_09_18_15_38_48  ')).toBe(true);
    // The date-only and hyphenated shapes a file handler might also produce.
    expect(isPlaceholderTitle('2026_09_18')).toBe(true);
    expect(isPlaceholderTitle('2026-09-18')).toBe(true);
  });

  it('treats a scanner timestamp that kept its file extension as a placeholder', () => {
    // How a scan imported from Evernote is titled: the whole file name, extension and all.
    expect(isPlaceholderTitle('2014_03_07_09_12_44.pdf')).toBe(true);
    expect(isPlaceholderTitle('2014_03_07_09_12_44.PDF')).toBe(true);
    expect(isPlaceholderTitle('2014_03_07_09_12_44.jpeg')).toBe(true);
    expect(isPlaceholderTitle('2014-03-07.pdf')).toBe(true);
  });

  it('leaves a title someone chose alone, even one that opens with a year', () => {
    expect(isPlaceholderTitle('Acme Hardware')).toBe(false);
    expect(isPlaceholderTitle('2026 tax plan')).toBe(false);
    expect(isPlaceholderTitle('2026-09-18 Water bill')).toBe(false);
    // Out-of-range parts are not a real stamp, so not a placeholder.
    expect(isPlaceholderTitle('2026_13_40_15_38_48')).toBe(false);
    expect(isPlaceholderTitle('2026_09_18_99_38_48')).toBe(false);
    // An extension only rides on a complete stamp; it widens nothing else.
    expect(isPlaceholderTitle('2026 tax plan.pdf')).toBe(false);
    expect(isPlaceholderTitle('2026-09-18 Water bill.pdf')).toBe(false);
    expect(isPlaceholderTitle('2014_03_07_09_12_44.pdf.pdf')).toBe(false);
    expect(isPlaceholderTitle('2014_03_07_09_12_44.')).toBe(false);
  });

  it('fills a scanner-titled note without offering to replace the title', () => {
    for (const title of ['2026_09_18_15_38_48', '2014_03_07_09_12_44.pdf']) {
      const { fill, replace } = planAutofill({ ...fresh, title }, suggestion);
      expect(fill.title).toBe('Acme Hardware');
      expect(replace.title).toBeUndefined();
    }
  });

  it('treats a title that is only one of the note’s file names as a placeholder', () => {
    // Whatever the device's naming — a phone's scanner, a camera — with or without the
    // extension, and whatever the case.
    const files = ['Scanned_20250311-0942.pdf', 'IMG_4012.JPG'];
    expect(isPlaceholderTitle('Scanned_20250311-0942', files)).toBe(true);
    expect(isPlaceholderTitle('Scanned_20250311-0942.pdf', files)).toBe(true);
    expect(isPlaceholderTitle('  scanned_20250311-0942  ', files)).toBe(true);
    expect(isPlaceholderTitle('IMG_4012', files)).toBe(true);
    expect(isPlaceholderTitle('img_4012.jpg', files)).toBe(true);
  });

  it('leaves a title alone that differs from every file name, however little', () => {
    const files = ['Lease renewal.pdf'];
    expect(isPlaceholderTitle('Lease renewal (signed)', files)).toBe(false);
    expect(isPlaceholderTitle('Lease', files)).toBe(false);
    // The same shape with no file behind it is not a placeholder: it is the file's name
    // that makes it one, not how it looks.
    expect(isPlaceholderTitle('Scanned_20250311-0942')).toBe(false);
    expect(isPlaceholderTitle('Scanned_20250311-0942', ['Scanned_20250311-0943.pdf'])).toBe(false);
  });

  it('fills over a file-name title, and still offers to replace a chosen one', () => {
    const files = ['Scanned_20250311-0942.pdf'];
    const named = planAutofill({ ...fresh, title: 'Scanned_20250311-0942' }, suggestion, files);
    expect(named.fill.title).toBe('Acme Hardware');
    expect(named.replace.title).toBeUndefined();

    const chosen = planAutofill({ ...fresh, title: 'Hardware run' }, suggestion, files);
    expect(chosen.fill.title).toBeUndefined();
    expect(chosen.replace.title).toBe('Acme Hardware');
  });
});

describe('applying and describing', () => {
  it('lands in a new draft, with the tags added to the ones there', () => {
    const draft: NoteDraft = { ...fresh, tags: ['old'], fields: { 'f-other': 'kept' } };
    const next = applyAutofill(draft, planAutofill(draft, suggestion).fill);
    expect(next).not.toBe(draft);
    expect(next).toEqual({
      title: 'Acme Hardware',
      body: '',
      tags: ['old', 'home', 'taxes'],
      notebook: 'Receipts',
      fields: { 'f-other': 'kept', 'f-amount': 12.5, 'f-via': ['Card'] },
    });
    // Nothing to apply leaves the draft's own objects in place, so autosave sees no edit.
    const untouched = applyAutofill(draft, { tags: [], fields: [] });
    expect(untouched.tags).toBe(draft.tags);
    expect(untouched.fields).toBe(draft.fields);
  });

  it('names what changed the way a sentence would', () => {
    expect(describeChanges(planAutofill(fresh, suggestion).fill)).toBe('the title, the notebook, 2 tags and 2 fields');
    expect(describeChanges({ tags: ['x'], fields: [{ def: amount, value: 1 }] })).toBe('a tag and Amount');
    expect(describeChanges({ notebook: 'Receipts', tags: [], fields: [] })).toBe('the notebook');
    expect(describeChanges({ tags: [], fields: [] })).toBe('nothing');
  });
});
