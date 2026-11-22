import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { FieldDef, FieldType, NoteFieldValue } from '@unbent/shared';
import { NoteFields } from './NoteFields.js';
import { CLAMP_SETTLE_MS } from './fields-clamp.js';

/**
 * The field block is a form drawn from data: each type has to become the right control,
 * a value has to come back the way the draft stores it, and the two things the block does
 * on its own (showing a value from another notebook, and adding a field in place) have
 * to be right without the server.
 */
const def = (id: string, name: string, type: FieldType, options: string[] = []): FieldDef => ({
  id,
  notebookId: 'nb1',
  name,
  type,
  options,
  scale: null,
  currency: null,
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

/** Kept out of `defs`: the row count below is pinned to eight. */
const multi = def('f-multi', 'Platforms', 'multiselect', ['PC', 'PS5', 'Switch']);
const price: FieldDef = { ...def('f-price', 'Price', 'number'), currency: 'USD' };

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

  it('draws a multi-select as chips with an entry that only takes an option, and reports the list', () => {
    const { onChange } = mount({ definitions: [multi], values: { 'f-multi': ['PC', 'PS5'] } });
    expect(screen.getByLabelText('Remove option PC')).toBeTruthy();
    expect(screen.getByLabelText('Remove option PS5')).toBeTruthy();

    const field = screen.getByLabelText('Add a option');
    fireEvent.change(field, { target: { value: 'switch' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('f-multi', ['PC', 'PS5', 'Switch']);

    // A word that is no option is not a value the field can hold.
    fireEvent.change(field, { target: { value: 'Xbox' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalledWith('f-multi', expect.arrayContaining(['Xbox']));

    fireEvent.click(screen.getByLabelText('Remove option PS5'));
    expect(onChange).toHaveBeenLastCalledWith('f-multi', ['PC']);
  });

  it('reports an emptied multi-select as null, and keeps a retired option the note holds removable', () => {
    const { onChange } = mount({ definitions: [multi], values: { 'f-multi': ['Xbox'] } });
    expect(screen.getByLabelText('Remove option Xbox')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove option Xbox'));
    expect(onChange).toHaveBeenLastCalledWith('f-multi', null);
  });

  it('puts the currency symbol before an amount and still reports the plain number', () => {
    const { onChange, container } = mount({ definitions: [price], values: { 'f-price': 29.99 } });
    const symbol = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })
      .formatToParts(0)
      .find((p) => p.type === 'currency')!.value;
    expect(container.querySelector('.note-field-money > .note-field-affix')!.textContent).toBe(symbol);
    expect(input('Price').value).toBe('29.99');
    fireEvent.change(input('Price'), { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith('f-price', '30');
  });

  it('writes an amount to its cents at rest, and leaves what is typed alone while it has focus', () => {
    const { onChange, rerender } = mount({ definitions: [price], values: { 'f-price': 141.8 } });
    expect(input('Price').value).toBe('141.80');

    // Focus does not reformat, and typing is taken as typed, with no cents added under
    // the cursor even when the draft comes back holding the typed text.
    fireEvent.focus(input('Price'));
    expect(input('Price').value).toBe('141.80');
    fireEvent.change(input('Price'), { target: { value: '141.8' } });
    expect(onChange).toHaveBeenLastCalledWith('f-price', '141.8');
    const again = (value: string) => (
      <NoteFields
        definitions={[price]}
        values={{ 'f-price': value }}
        carried={[]}
        notebookId="nb1"
        onChange={onChange}
        onAddField={vi.fn(async () => {})}
      />
    );
    rerender(again('141.8'));
    expect(input('Price').value).toBe('141.8');

    fireEvent.blur(input('Price'));
    expect(input('Price').value).toBe('141.80');
  });

  it('draws a read-only multi-select as its chips alone', () => {
    mount({ definitions: [multi], values: { 'f-multi': ['PC'] }, readOnly: true });
    expect(screen.getByText('PC')).toBeTruthy();
    expect(screen.queryByLabelText('Add a option')).toBeNull();
    cleanup();
    mount({ definitions: [multi], readOnly: true });
    expect(screen.getByText('Empty')).toBeTruthy();
  });

  it('asks for options when the field being added is a multi-select', async () => {
    const { onAddField } = mount();
    fireEvent.click(screen.getByText('Add field'));
    fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Platforms' } });
    fireEvent.change(screen.getByLabelText('Field type'), { target: { value: 'multiselect' } });
    fireEvent.change(screen.getByLabelText('Options'), { target: { value: 'PC, PS5' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() =>
      expect(onAddField).toHaveBeenCalledWith({ name: 'Platforms', type: 'multiselect', options: ['PC', 'PS5'] }),
    );
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
 * The property list's own two behaviours: an empty value says so, and a long list is
 * limited to a share of the note with the rest a press away. Both are Notion's, and both
 * are what makes thirty rows readable.
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

  describe('limited to a share of the column', () => {
    /*
     * jsdom lays nothing out, so every rect is zeros and the list above is never
     * limited. Here each row is given a height, by its place in the list: forty pixels
     * a row, in a window of 768, leaves room for seven (40% is 307).
     */
    let ROW = 40;
    const twelve = Array.from({ length: 12 }, (_, i) => def(`f${i}`, `Field ${i + 1}`, 'text'));
    const row = (label: string) => screen.getByLabelText(label).closest('.note-field') as HTMLElement;

    function layOut() {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const parent = this.parentElement;
        let bottom = 0;
        if (parent?.classList.contains('note-field')) {
          const rows = Array.from(parent.parentElement!.querySelectorAll(':scope > .note-field'));
          bottom = (rows.indexOf(parent) + 1) * ROW;
        }
        return { top: 0, bottom, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON: () => ({}) };
      });
    }

    afterEach(() => {
      ROW = 40;
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
    });

    it('draws the rows that fit and says how many more there are', () => {
      layOut();
      mount({ definitions: twelve });
      expect(row('Field 7').hidden).toBe(false);
      expect(row('Field 8').hidden).toBe(true);
      const toggle = screen.getByText('5 more');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('shows the whole list on a press, and remembers that for the notebook alone', () => {
      layOut();
      mount({ definitions: twelve });
      fireEvent.click(screen.getByText('5 more'));
      expect(row('Field 12').hidden).toBe(false);
      expect(screen.getByText('Fewer').getAttribute('aria-expanded')).toBe('true');

      // The next note in the same notebook opens whole; another notebook's does not.
      cleanup();
      mount({ definitions: twelve });
      expect(row('Field 12').hidden).toBe(false);
      cleanup();
      mount({ definitions: twelve, notebookId: 'nb2' });
      expect(row('Field 12').hidden).toBe(true);

      // And asking for fewer puts the limit back.
      cleanup();
      mount({ definitions: twelve });
      fireEvent.click(screen.getByText('Fewer'));
      expect(row('Field 8').hidden).toBe(true);
    });

    it('counts the rows drawn above the fields against the same room', () => {
      layOut();
      const lead = (
        <>
          <div className="note-field"><span>Notebook</span></div>
          <div className="note-field"><span>Tags</span></div>
        </>
      );
      mount({ definitions: twelve, lead });
      expect(row('Field 5').hidden).toBe(false);
      expect(row('Field 6').hidden).toBe(true);
      expect(screen.getByText('7 more')).toBeTruthy();
    });

    it('cuts for the note it is showing, not the one it showed before', () => {
      // The workspace keeps the list mounted from note to note. Same notebook, same
      // rows, but the next note's are taller (its tags wrap, say).
      layOut();
      const props = { definitions: twelve, carried: [], notebookId: 'nb1', onChange: vi.fn(), onAddField: vi.fn() };
      const { rerender } = render(<NoteFields {...props} values={{ f0: 'one' }} />);
      expect(row('Field 7').hidden).toBe(false);
      ROW = 60;
      rerender(<NoteFields {...props} values={{ f0: 'another' }} />);
      expect(row('Field 5').hidden).toBe(false);
      expect(row('Field 6').hidden).toBe(true);
    });

    /** Lets a cut that is waiting for the size to stop changing be made. */
    const settle = () => act(() => void vi.advanceTimersByTime(CLAMP_SETTLE_MS));

    /** The observers the component made, so a test can say "the column changed size". */
    function resizes() {
      vi.useFakeTimers();
      const made: Array<() => void> = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            made.push(cb);
          }
          observe() {}
          disconnect() {}
        },
      );
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (cb(0), 1));
      vi.stubGlobal('cancelAnimationFrame', () => {});
      return () => act(() => made.forEach((cb) => cb()));
    }

    it('cuts again when the column changes size', () => {
      layOut();
      const resized = resizes();
      mount({ definitions: twelve });
      vi.stubGlobal('innerHeight', 500);
      resized();
      // Fewer rows fit, and the cut waits for the size to stop changing: a keyboard on
      // its way out, a window being dragged.
      expect(row('Field 7').hidden).toBe(false);
      settle();
      // 40% of 500 is five rows.
      expect(row('Field 5').hidden).toBe(false);
      expect(row('Field 6').hidden).toBe(true);
      expect(screen.getByText('7 more')).toBeTruthy();

      // More room shows its rows at once.
      vi.stubGlobal('innerHeight', 768);
      resized();
      expect(row('Field 7').hidden).toBe(false);
    });

    it('does not hide the row being typed in when the room shrinks under it', () => {
      // The Android app's keyboard: it opens because the field took focus, and it
      // shrinks the page the cut is measured against.
      layOut();
      const resized = resizes();
      mount({ definitions: twelve });
      input('Field 7').focus();
      vi.stubGlobal('innerHeight', 400);
      resized();
      expect(row('Field 7').hidden).toBe(false);
      expect(row('Field 8').hidden).toBe(true);

      // Once focus leaves and the size has stopped changing, the cut settles where the
      // room puts it.
      act(() => input('Field 7').blur());
      settle();
      expect(row('Field 4').hidden).toBe(false);
      expect(row('Field 5').hidden).toBe(true);
    });

    it('cuts a value carried from another notebook like any other row', () => {
      // Carried values are drawn after the notebook's own fields, so they go first.
      layOut();
      mount({ definitions: twelve.slice(0, 9), values: { old: 'Old' }, carried: [leftover] });
      const carriedRow = screen.getByText('Old').closest('.note-field') as HTMLElement;
      expect(carriedRow.hidden).toBe(true);
      fireEvent.click(screen.getByText('3 more'));
      expect(carriedRow.hidden).toBe(false);
    });

    it('does not hold the cut for something focused outside the note', () => {
      layOut();
      const resized = resizes();
      const props = { definitions: twelve, values: {}, carried: [], notebookId: 'nb1', onChange: vi.fn(), onAddField: vi.fn() };
      render(
        <>
          <input aria-label="Search notes" />
          <NoteFields {...props} />
        </>,
      );
      screen.getByLabelText('Search notes').focus();
      vi.stubGlobal('innerHeight', 400);
      resized();
      settle();
      expect(row('Field 4').hidden).toBe(false);
      expect(row('Field 5').hidden).toBe(true);
    });

    it('holds the cut through a keystroke in a field while the room is short', () => {
      // The keyboard is up for Field 2 and the first character lands: the values are a
      // new object, and reading the short room fresh would take Fields 3 to 7.
      layOut();
      const resized = resizes();
      const props = { definitions: twelve, carried: [], notebookId: 'nb1', onChange: vi.fn(), onAddField: vi.fn() };
      const { rerender } = render(<NoteFields {...props} values={{}} />);
      input('Field 2').focus();
      vi.stubGlobal('innerHeight', 400);
      resized();
      rerender(<NoteFields {...props} values={{ f1: 'a' }} />);
      settle();
      expect(row('Field 7').hidden).toBe(false);
      expect(row('Field 8').hidden).toBe(true);
    });

    it('holds the cut while the body is being typed in and the room shrinks', () => {
      // The keyboard again, opened for the body this time: the list must not lose rows
      // and pull the line being typed up the screen.
      layOut();
      const resized = resizes();
      let room = 768;
      const props = { definitions: twelve, values: {}, carried: [], notebookId: 'nb1', onChange: vi.fn(), onAddField: vi.fn() };
      render(
        <div className="workspace-main" ref={(el) => { if (el) Object.defineProperty(el, 'clientHeight', { get: () => room }); }}>
          <NoteFields {...props} />
          <textarea aria-label="Body" />
        </div>,
      );
      // The column was not measurable until the ref ran; this is the first real reading.
      resized();
      settle();
      expect(row('Field 7').hidden).toBe(false);
      expect(row('Field 8').hidden).toBe(true);

      screen.getByLabelText('Body').focus();
      room = 400;
      resized();
      expect(row('Field 7').hidden).toBe(false);

      // The typing ends (and on a phone the keyboard goes): the cut is read fresh.
      // The keyboard has not finished leaving, so the room is still short: the cut waits.
      act(() => screen.getByLabelText('Body').blur());
      expect(row('Field 7').hidden).toBe(false);
      settle();
      expect(row('Field 4').hidden).toBe(false);
      expect(row('Field 5').hidden).toBe(true);
    });

    it('leaves a list alone when only a row or two would go', () => {
      layOut();
      mount({ definitions: twelve.slice(0, 9) });
      expect(row('Field 9').hidden).toBe(false);
      expect(screen.queryByText(/^\d+ more$/)).toBeNull();
    });

    it('shows a field just added, which the limit would have hidden', async () => {
      layOut();
      const { onAddField } = mount({ definitions: twelve });
      fireEvent.click(screen.getByText('Add field'));
      fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Colour' } });
      fireEvent.click(screen.getByText('Add'));
      await waitFor(() => expect(onAddField).toHaveBeenCalled());
      await waitFor(() => expect(row('Field 12').hidden).toBe(false));
      // Not a standing preference: nothing is written for the notebook's later visits.
      expect(localStorage.getItem('unbent.noteFieldsWhole')).toBeNull();
    });

    it('shows the whole list when Auto-fill wrote to a row past the cut', () => {
      layOut();
      const props = { definitions: twelve, values: {}, carried: [], notebookId: 'nb1', onChange: vi.fn(), onAddField: vi.fn() };
      const { rerender } = render(<NoteFields {...props} />);
      // A press that wrote only what is already drawn leaves the limit alone.
      rerender(<NoteFields {...props} filled={{ ids: new Set(['f1']), start: 0 }} />);
      expect(row('Field 8').hidden).toBe(true);
      rerender(<NoteFields {...props} filled={{ ids: new Set(['f1', 'f9']), start: 0 }} />);
      expect(row('Field 10').hidden).toBe(false);
      expect(row('Field 12').hidden).toBe(false);
      // And it stays open when the marks clear, rather than closing under the eye.
      rerender(<NoteFields {...props} />);
      expect(row('Field 12').hidden).toBe(false);
    });

    it('lets Fewer hold while the marks of an Auto-fill press are still showing', () => {
      // The workspace hands over a new `filled` object on every render, around the same
      // set of ids for as long as the marks last.
      layOut();
      const props = { definitions: twelve, values: {}, carried: [], notebookId: 'nb1', onChange: vi.fn(), onAddField: vi.fn() };
      const ids = new Set(['f9']);
      const { rerender } = render(<NoteFields {...props} filled={{ ids, start: 0 }} />);
      expect(row('Field 12').hidden).toBe(false);
      fireEvent.click(screen.getByText('Fewer'));
      rerender(<NoteFields {...props} filled={{ ids, start: 0 }} />);
      expect(row('Field 12').hidden).toBe(true);
    });

    it('limits the list again once the notebook has been left and come back to', async () => {
      layOut();
      const props = { definitions: twelve, values: {}, carried: [], onChange: vi.fn(), onAddField: vi.fn(async () => {}) };
      const { rerender } = render(<NoteFields {...props} notebookId="nb1" />);
      fireEvent.click(screen.getByText('Add field'));
      fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Colour' } });
      fireEvent.click(screen.getByText('Add'));
      await waitFor(() => expect(row('Field 12').hidden).toBe(false));

      rerender(<NoteFields {...props} notebookId="nb2" />);
      rerender(<NoteFields {...props} notebookId="nb1" />);
      expect(row('Field 12').hidden).toBe(true);
    });
  });
});
