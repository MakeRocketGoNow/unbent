import { describe, it, expect, vi } from 'vitest';
import { countMenuItems, offersCountMenu } from './count-menu.js';

/**
 * What the count's menu promises. Both labels are claims about numbers (how many an export
 * takes, how many a selection picks) and each was the kind of thing that is easy to get
 * subtly wrong: a "Select all" that picks the loaded page, or an export that fades with
 * nothing on a phone to say why.
 */
const base = {
  total: 37,
  everything: false,
  shown: 37,
  more: false,
  exportRunning: false,
  offline: false,
  onExport: () => {},
  onSelectAll: () => {},
};

describe('offersCountMenu', () => {
  const list = { searching: false, notebookMissing: false, loading: false, total: 37 };

  it('is a menu for a count of notes', () => {
    expect(offersCountMenu(list)).toBe(true);
  });

  it('is plain text whenever the count is not a number of notes to act on', () => {
    // A search's query is not part of an export, so its matches are not offered one.
    expect(offersCountMenu({ ...list, searching: true })).toBe(false);
    // "Loading…" is not a number.
    expect(offersCountMenu({ ...list, loading: true })).toBe(false);
    // A count of a notebook that does not exist would be a claim about nothing.
    expect(offersCountMenu({ ...list, notebookMissing: true })).toBe(false);
    expect(offersCountMenu({ ...list, total: 0 })).toBe(false);
  });
});

describe('countMenuItems', () => {
  it('exports every note the filter matches, by number', () => {
    const [exp] = countMenuItems({ ...base, total: 1234, shown: 50, more: true });
    expect(exp!.label).toBe('Export these 1,234 notes');
    expect(countMenuItems({ ...base, total: 1, shown: 1 })[0]!.label).toBe('Export this note');
  });

  it('says how many it selects while the list is not whole', () => {
    expect(countMenuItems(base)[1]!.label).toBe('Select all');
    // A selection names drawn rows; with a page still to come, "all" would be a promise
    // about the 340 beside it that only the 50 drawn can keep.
    expect(countMenuItems({ ...base, total: 340, shown: 50, more: true })[1]!.label).toBe(
      'Select the 50 shown',
    );
  });

  it('waits for a running export, and says so in the item', () => {
    const [exp] = countMenuItems({ ...base, exportRunning: true });
    expect(exp!.disabled).toBe(true);
    expect(exp!.title).toBe('After the current export finishes');
    // In the label too, not only the tooltip: a phone never shows a title.
    expect(exp!.label).not.toBe('Export these 37 notes');
  });

  it('fades Export offline and says so, but not Select all', () => {
    const [exp, select] = countMenuItems({ ...base, offline: true, exportRunning: true });
    expect(exp!.disabled).toBe(true);
    // The connection is named over the running export: it is the reason that can be acted on.
    expect(exp!.title).toBe('Exporting needs a connection');
    expect(select!.disabled).toBeFalsy();
  });

  it('sends an unfiltered list to the whole-library export page instead', () => {
    const [exp, select] = countMenuItems({ ...base, everything: true, offline: true });
    // A link, not an export: the page carries the size and the Trash caveats a menu
    // item cannot. A link has nothing to wait for, so it does not fade offline.
    expect(exp).toEqual({ label: 'Export everything…', to: '/settings/export' });
    expect(select!.label).toBe('Select all');
  });

  it('runs the handlers it was given', () => {
    const onExport = vi.fn();
    const onSelectAll = vi.fn();
    const [exp, select] = countMenuItems({ ...base, onExport, onSelectAll });
    exp!.onSelect!();
    select!.onSelect!();
    expect(onExport).toHaveBeenCalledOnce();
    expect(onSelectAll).toHaveBeenCalledOnce();
  });
});
