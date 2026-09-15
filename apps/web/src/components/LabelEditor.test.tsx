import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LabelEditor, type LabelItem } from './LabelEditor.js';

/**
 * The editor's two states and the way between them.
 *
 * What these pin is the shape Keep's editing screen has and the Android app copied: a
 * resting row offers only a pencil, an editing row offers a trash can and a check, the
 * field commits on Enter and leaves on Escape, and a rename to the same name is a cancel
 * rather than a request the server would refuse.
 */
const ITEMS: LabelItem[] = [
  { id: '1', name: 'Coupons', count: 5 },
  { id: '2', name: 'Receipts', count: 12 },
];

function harness(over: Partial<Parameters<typeof LabelEditor>[0]> = {}) {
  const onRename = vi.fn(async () => true);
  const onDelete = vi.fn();
  const onCreate = vi.fn(async () => true);
  const utils = render(
    <LabelEditor
      kind="notebook"
      items={ITEMS}
      busy={false}
      onCreate={onCreate}
      onRename={onRename}
      onDelete={onDelete}
      emptyText="None."
      hint="A hint."
      {...over}
    />,
  );
  return { ...utils, onRename, onDelete, onCreate };
}

describe('LabelEditor', () => {
  afterEach(cleanup);

  it('offers a resting row only its pencil, and no way to delete', () => {
    const { getByLabelText, queryByLabelText } = harness();
    expect(getByLabelText('Rename Coupons')).toBeTruthy();
    expect(queryByLabelText('Delete Coupons')).toBeNull();
  });

  it('turns the row into a field with a trash can and a check, caret at the end', () => {
    const { getByText, getByLabelText } = harness();
    fireEvent.click(getByText('Coupons'));
    const field = getByLabelText('Rename Coupons') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.value).toBe('Coupons');
    expect(field.selectionStart).toBe('Coupons'.length);
    expect(getByLabelText('Delete Coupons')).toBeTruthy();
    expect(getByLabelText('Save')).toBeTruthy();
  });

  it('commits on Enter and closes once the rename went through', async () => {
    const { getByText, getByLabelText, onRename, queryByLabelText } = harness();
    fireEvent.click(getByText('Coupons'));
    const field = getByLabelText('Rename Coupons');
    fireEvent.change(field, { target: { value: 'Vouchers' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onRename).toHaveBeenCalledWith(ITEMS[0], 'Vouchers'));
    await waitFor(() => expect(queryByLabelText('Save')).toBeNull());
  });

  it('keeps the row open when the rename was refused', async () => {
    const { getByText, getByLabelText, onRename } = harness();
    onRename.mockResolvedValueOnce(false);
    fireEvent.click(getByText('Coupons'));
    const field = getByLabelText('Rename Coupons');
    fireEvent.change(field, { target: { value: 'Receipts' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onRename).toHaveBeenCalled());
    expect(getByLabelText('Save')).toBeTruthy();
  });

  it('treats an unchanged name as a cancel rather than a request', () => {
    const { getByText, getByLabelText, onRename, queryByLabelText } = harness();
    fireEvent.click(getByText('Coupons'));
    fireEvent.keyDown(getByLabelText('Rename Coupons'), { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
    expect(queryByLabelText('Save')).toBeNull();
  });

  it('leaves on Escape without renaming', () => {
    const { getByText, getByLabelText, onRename, queryByLabelText } = harness();
    fireEvent.click(getByText('Coupons'));
    const field = getByLabelText('Rename Coupons');
    fireEvent.change(field, { target: { value: 'Nope' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(queryByLabelText('Save')).toBeNull();
    expect(getByText('Coupons')).toBeTruthy();
  });

  it('asks the caller to delete, from the editing state only', () => {
    const { getByText, getByLabelText, onDelete } = harness();
    fireEvent.click(getByText('Receipts'));
    fireEvent.click(getByLabelText('Delete Receipts'));
    expect(onDelete).toHaveBeenCalledWith(ITEMS[1]);
  });

  it('makes a new one from a row that becomes a field', async () => {
    const { getByText, getByLabelText, onCreate } = harness();
    fireEvent.click(getByText('Create new notebook'));
    const field = getByLabelText('New notebook name');
    fireEvent.change(field, { target: { value: 'Travel' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Travel'));
    await waitFor(() => expect(getByText('Create new notebook')).toBeTruthy());
  });

  /* A tag exists only on a note, so the tag editor offers no way to make one. */
  it('has no create row when nothing can be created', () => {
    const { queryByText } = harness({ kind: 'tag', onCreate: undefined });
    expect(queryByText(/Create new/)).toBeNull();
  });

  it('offers a find field only once the list is long, and filters by it', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: `Tag ${i}`, count: 1 }));
    const { getByLabelText, queryByText } = harness({ kind: 'tag', items: many, findable: true });
    fireEvent.change(getByLabelText('Find a tag'), { target: { value: 'Tag 11' } });
    expect(queryByText('Tag 11')).toBeTruthy();
    expect(queryByText('Tag 3')).toBeNull();
  });

  it('says nothing under a list that has not arrived', () => {
    const { queryByText } = harness({ items: null });
    expect(queryByText('A hint.')).toBeNull();
    expect(queryByText('None.')).toBeNull();
  });

  /* The tag list wants the trailing number alone: in an archive the count is the information. */
  it('draws the trailing count when no renderNameCount is given', () => {
    const { getByText } = harness({ kind: 'tag', onCreate: undefined });
    expect(getByText('5')).toBeTruthy();
    expect(getByText('12')).toBeTruthy();
  });

  /* A caller that gives renderNameCount puts the count against the name and takes the
     trailing number off — a notebook's note count, hard against the notebook name. */
  it('moves the count against the name and drops the trailing one', () => {
    const items: LabelItem[] = [
      { id: '1', name: 'Coupons', count: 5 },
      { id: '2', name: 'Travel', count: 0 },
    ];
    const { getByText, queryAllByText } = harness({
      items,
      renderNameCount: (item) => (item.count > 0 ? <span>{item.count}</span> : null),
    });
    // The count for Coupons sits inside its name button, not as a trailing sibling.
    const nameButton = getByText('Coupons').closest('button');
    expect(nameButton?.textContent).toContain('5');
    // The empty notebook shows no count at all, not a bare zero, anywhere on its row.
    expect(queryAllByText('0')).toHaveLength(0);
  });
});
