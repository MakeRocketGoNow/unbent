import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { FieldDef, FieldType, NoteFieldValue } from '@unbent/shared';
import { NoteFields } from './NoteFields.js';

/**
 * The field block is a form drawn from data: each type has to become the right control,
 * a value has to come back the way the draft stores it, and the two things the block does
 * on its own — showing a value from another notebook, and adding a field in place — have
 * to be right without the server.
 */
const def = (id: string, name: string, type: FieldType, options: string[] = []): FieldDef => ({
  id,
  notebookId: 'nb1',
  name,
  type,
  options,
  position: 0,
});

const defs = [
  def('f-text', 'Merchant', 'text'),
  def('f-num', 'Amount', 'number'),
  def('f-date', 'Paid on', 'date'),
  def('f-check', 'Reimbursed', 'checkbox'),
  def('f-url', 'Receipt', 'url'),
  def('f-email', 'Contact', 'email'),
  def('f-phone', 'Phone', 'phone'),
  def('f-sel', 'Category', 'select', ['Food', 'Travel']),
];

const leftover: NoteFieldValue = {
  fieldId: 'old',
  name: 'Store',
  type: 'text',
  value: 'Old',
  notebookId: 'nb0',
  notebook: 'Coupons',
};

function mount(props: Partial<Parameters<typeof NoteFields>[0]> = {}) {
  const onChange = vi.fn();
  const onAddField = vi.fn(async () => {});
  const utils = render(
    <NoteFields
      definitions={defs}
      values={{}}
      carried={[]}
      notebookId="nb1"
      onChange={onChange}
      onAddField={onAddField}
      {...props}
    />,
  );
  return { ...utils, onChange, onAddField };
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

/** A select's value; the DOM typings here will not cast an HTMLElement to a select directly. */
const selectValue = (label: string) => (screen.getByLabelText(label) as unknown as { value: string }).value;

afterEach(cleanup);

describe('NoteFields', () => {
  it('draws one control per type, labelled by the field, with a way to act on a value', () => {
    mount({
      values: {
        'f-text': 'Acme',
        'f-num': 12.5,
        'f-date': '2024-03-01',
        'f-check': true,
        'f-url': 'https://x.test/r',
        'f-email': 'ap@acme.test',
        'f-phone': '+1 (555) 0100',
        'f-sel': 'Food',
      },
    });
    expect(input('Merchant').type).toBe('text');
    expect(input('Merchant').value).toBe('Acme');
    expect(input('Amount').type).toBe('text');
    expect(input('Amount').inputMode).toBe('decimal');
    expect(input('Amount').value).toBe('12.5');
    expect(input('Paid on').type).toBe('date');
    expect(input('Reimbursed').type).toBe('checkbox');
    expect(input('Reimbursed').checked).toBe(true);
    expect(input('Receipt').type).toBe('url');
    expect(input('Contact').type).toBe('email');
    expect(input('Phone').type).toBe('tel');
    expect(selectValue('Category')).toBe('Food');

    expect(screen.getByText('Open').getAttribute('href')).toBe('https://x.test/r');
    expect(screen.getByText('Email').getAttribute('href')).toBe('mailto:ap@acme.test');
    expect(screen.getByText('Call').getAttribute('href')).toBe('tel:+15550100');
  });

  it('reports an emptied control as null and a typed one as its text', () => {
    const { onChange } = mount({ values: { 'f-num': 3, 'f-check': false } });
    fireEvent.change(input('Amount'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('f-num', null);
    fireEvent.change(input('Amount'), { target: { value: '12.5' } });
    expect(onChange).toHaveBeenLastCalledWith('f-num', '12.5');
    fireEvent.click(input('Reimbursed'));
    expect(onChange).toHaveBeenLastCalledWith('f-check', true);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Travel' } });
    expect(onChange).toHaveBeenLastCalledWith('f-sel', 'Travel');
  });

  /*
     A number input reports "" for "12." and for "-", and this block maps "" to null, so
     the stored amount would be cleared mid-keystroke. The control is a text field so
     those strings reach the draft, where `buildNotePatch` holds them until they are a
     number rather than sending a clear.
  */
  it('keeps a half-typed number as text, not as a clear', () => {
    const { onChange } = mount({ values: { 'f-num': 12 } });
    fireEvent.change(input('Amount'), { target: { value: '12.' } });
    expect(onChange).toHaveBeenLastCalledWith('f-num', '12.');
    fireEvent.change(input('Amount'), { target: { value: '-' } });
    expect(onChange).toHaveBeenLastCalledWith('f-num', '-');
  });

  it('keeps a select value that is no longer an option selectable, and says so', () => {
    mount({ values: { 'f-sel': 'Vet' } });
    expect(selectValue('Category')).toBe('Vet');
    expect(screen.getByText('Vet (no longer an option)')).toBeTruthy();
  });

  it('shows a value from another notebook as text, says where from, and can clear it', () => {
    const { onChange } = mount({ carried: [leftover], values: { old: 'Old' } });
    expect(screen.getByText('from Coupons')).toBeTruthy();
    expect(screen.getByText('Old')).toBeTruthy();
    expect(screen.queryByLabelText('Store')).toBeNull();

    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith('old', null);
  });

  it('drops a foreign value once it is cleared, and never shows one the notebook defines', () => {
    const { unmount } = mount({ carried: [leftover], values: { old: null } });
    expect(screen.queryByText('from Coupons')).toBeNull();
    unmount();

    // The server reports every value; only the ones outside the definitions are foreign.
    mount({ carried: [{ ...leftover, fieldId: 'f-text', name: 'Merchant' }], values: { 'f-text': 'Acme' } });
    expect(screen.queryByText(/from /)).toBeNull();
    expect(input('Merchant').value).toBe('Acme');
  });

  it('opens the add form in place and submits a name, a type and options', async () => {
    const { onAddField } = mount({ definitions: [] });
    fireEvent.click(screen.getByText('Add field'));
    expect(screen.queryByText('Add field')).toBeNull();

    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Kind' } });
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'select' } });
    fireEvent.change(screen.getByLabelText('Options'), { target: { value: 'GP, Dentist, ,Vet' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() =>
      expect(onAddField).toHaveBeenCalledWith({ name: 'Kind', type: 'select', options: ['GP', 'Dentist', 'Vet'] }),
    );
    // Closed again once the field exists.
    await waitFor(() => expect(screen.queryByLabelText('Field name')).toBeNull());
    expect(screen.getByText('Add field')).toBeTruthy();
  });

  it('refuses a reserved name before asking the server, and shows a rejection inline', async () => {
    const { onAddField } = mount({ definitions: [] });
    fireEvent.click(screen.getByText('Add field'));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'title' } });
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Enter' });

    expect(await screen.findByText('That name belongs to the note itself')).toBeTruthy();
    expect(onAddField).not.toHaveBeenCalled();

    onAddField.mockRejectedValueOnce(new Error('This notebook already has a field with that name.'));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Merchant' } });
    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Enter' });
    expect(await screen.findByText('This notebook already has a field with that name.')).toBeTruthy();
    // Still open, with the name kept, so it can be corrected.
    expect((screen.getByLabelText('Field name') as HTMLInputElement).value).toBe('Merchant');

    fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });
    expect(screen.getByText('Add field')).toBeTruthy();
  });

  it('renders nothing for an unfiled note with no values, and only the chip for a bare notebook', () => {
    const { container, unmount } = mount({ definitions: undefined, notebookId: null });
    expect(container.querySelector('.note-fields')).toBeNull();
    unmount();

    mount({ definitions: [] });
    expect(screen.getByText('Add field')).toBeTruthy();
    expect(document.querySelectorAll('.note-field')).toHaveLength(0);
  });

  it('waits for the definitions rather than showing every value as foreign for a frame', () => {
    const { container } = mount({ definitions: undefined, carried: [leftover], values: { old: 'Old' } });
    expect(container.querySelector('.note-fields')).toBeNull();
  });

  it('is read-only in the trash: no editing, no adding, no clearing', () => {
    mount({ readOnly: true, values: { 'f-text': 'Acme', old: 'Old' }, carried: [leftover] });
    expect(input('Merchant').disabled).toBe(true);
    expect(screen.queryByText('Add field')).toBeNull();
    expect(screen.queryByText('Clear')).toBeNull();
  });

  /**
   * The stylesheet targets these names and this order; a wrapper dropped on the way out
   * would not fail a type check. The three cells per row are the grid's contract.
   */
  it('keeps the class names and cell order the stylesheet targets', () => {
    const { container } = mount({ values: { 'f-text': 'Acme' } });
    const block = container.querySelector('.note-fields')!;
    const row = block.querySelector('.note-field')!;
    expect([...row.children].map((c) => `${c.tagName.toLowerCase()}.${c.className.split(' ')[0]}`)).toEqual([
      'span.note-field-glyph',
      'label.note-field-label',
      'input.note-field-input',
      'span.note-field-side',
    ]);
    expect(block.querySelectorAll('.note-field')).toHaveLength(defs.length);
    expect(block.lastElementChild!.className).toBe('note-fields-foot');
    expect(block.querySelector('.note-fields-foot > .note-field-add-hint')).toBeTruthy();
  });
});

/*
 * The property list's own two behaviours: an empty value says so, and once a notebook has
 * enough fields, the empty ones can be put away. Both are Notion's, and both are what
 * makes thirty rows readable.
 */
describe('NoteFields as a property list', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('says Empty where a value is missing, and draws a chosen select as a chip', () => {
    mount({ values: { 'f-sel': 'Food' } });
    expect(input('Merchant').placeholder).toBe('Empty');
    const sel = screen.getByLabelText('Category');
    expect(sel.getAttribute('data-filled')).toBe('true');
    cleanup();
    mount();
    expect(screen.getByLabelText('Category').getAttribute('data-filled')).toBeNull();
  });

  it('offers to hide the empties only once the list is long, and remembers the choice', () => {
    // Eight definitions is the threshold; one value leaves seven empty.
    const { getByText, queryByLabelText } = mount({ values: { 'f-text': 'Acme' } });
    fireEvent.click(getByText('Hide 7 empty'));
    expect(queryByLabelText('Amount')).toBeNull();
    expect(input('Merchant').value).toBe('Acme');
    expect(getByText('Show 7 empty')).toBeTruthy();

    // A short list is read whole: no toggle.
    cleanup();
    const { queryByText } = mount({ definitions: defs.slice(0, 3) });
    expect(queryByText(/empty$/)).toBeNull();

    // And the preference sticks for the next note.
    cleanup();
    const again = mount({ values: { 'f-text': 'Acme' } });
    expect(again.queryByLabelText('Amount')).toBeNull();
    expect(again.getByText('Show 7 empty')).toBeTruthy();
  });
});
