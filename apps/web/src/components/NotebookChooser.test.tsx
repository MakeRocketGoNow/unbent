import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { NOTEBOOK_TEMPLATES } from '@unbent/shared';
import * as actions from '../store/actions.js';
import { NotebookChooser, describeField, freeName } from './NotebookChooser.js';

vi.mock('../store/actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/actions.js')>()),
  applyNotebookTemplate: vi.fn(),
}));

/**
 * The chooser's promises: Blank first and focused, a template previewed before anything is
 * made, and a taken name never merged into without the person asking for exactly that.
 */
const receipts = NOTEBOOK_TEMPLATES.find((t) => t.id === 'receipts')!;

function mount(existing: { name: string }[] = []) {
  const onBlank = vi.fn();
  const onClose = vi.fn();
  const onApplied = vi.fn();
  const onDone = vi.fn();
  render(
    <NotebookChooser existing={existing} onBlank={onBlank} onClose={onClose} onApplied={onApplied} onDone={onDone} />,
  );
  return { onBlank, onClose, onApplied, onDone };
}

describe('NotebookChooser', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(actions.applyNotebookTemplate).mockReset();
  });

  it('puts Blank first and gives it the focus, so a blank notebook is one Enter away', () => {
    const { onBlank } = mount();
    const cards = screen.getAllByRole('listitem').map((li) => li.querySelector('button')!);
    expect(cards[0]!.textContent).toContain('Blank');
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.click(cards[0]!);
    expect(onBlank).toHaveBeenCalledOnce();
  });

  it("shows each template's fields on its card before anything is chosen", () => {
    mount();
    const card = screen.getByRole('button', { name: /^Receipts/ });
    for (const f of receipts.fields) expect(card.textContent).toContain(f.name);
  });

  it('previews a template with its name editable, and creates it as a new notebook only', async () => {
    vi.mocked(actions.applyNotebookTemplate).mockResolvedValue({ id: 'nb', skipped: [] });
    const { onDone, onApplied } = mount([{ name: 'Travel' }]);
    fireEvent.click(screen.getByRole('button', { name: /^Receipts/ }));
    const name = screen.getByLabelText('Notebook name') as HTMLInputElement;
    expect(name.value).toBe('Receipts');
    expect(document.activeElement).toBe(name);
    expect(screen.getByText('Amount in USD')).toBeTruthy();

    fireEvent.change(name, { target: { value: 'Expenses' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create notebook' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Expenses'));
    expect(onApplied).toHaveBeenCalledOnce();
    expect(actions.applyNotebookTemplate).toHaveBeenCalledWith(
      { name: 'Expenses', emoji: receipts.emoji, purpose: receipts.purpose, fields: receipts.fields },
      { create: true },
    );
  });

  it('gives a taken name the next free number, and offers adding to the existing one as its own choice', async () => {
    vi.mocked(actions.applyNotebookTemplate).mockResolvedValue({ id: 'nb', skipped: [] });
    const { onDone } = mount([{ name: 'receipts' }, { name: 'Receipts 2' }]);
    fireEvent.click(screen.getByRole('button', { name: /^Receipts/ }));
    expect((screen.getByLabelText('Notebook name') as HTMLInputElement).value).toBe('Receipts 3');

    fireEvent.click(screen.getByRole('button', { name: 'Add these fields to receipts' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('receipts'));
    expect(vi.mocked(actions.applyNotebookTemplate).mock.calls[0]![1]).toEqual({ create: false });
  });

  it('refuses a name typed back onto one that is taken, rather than sending it', () => {
    mount([{ name: 'Groceries' }]);
    fireEvent.click(screen.getByRole('button', { name: /^Receipts/ }));
    fireEvent.change(screen.getByLabelText('Notebook name'), { target: { value: 'groceries' } });
    expect((screen.getByRole('button', { name: 'Create notebook' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/There is already a notebook called/)).toBeTruthy();
  });

  it('turns a name taken since the list was read into the same choice, with nothing written', async () => {
    vi.mocked(actions.applyNotebookTemplate).mockResolvedValueOnce('taken');
    const { onDone, onApplied } = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Receipts/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create notebook' }));
    await screen.findByRole('button', { name: 'Add these fields to Receipts' });
    expect((screen.getByLabelText('Notebook name') as HTMLInputElement).value).toBe('Receipts 2');
    expect(onDone).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('says what an add left alone before leaving', async () => {
    vi.mocked(actions.applyNotebookTemplate).mockResolvedValue({
      id: 'nb',
      skipped: [{ name: 'Amount', reason: 'Already here as text, not number; left as it is' }],
    });
    const { onDone } = mount([{ name: 'Receipts' }]);
    fireEvent.click(screen.getByRole('button', { name: /^Receipts/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add these fields to Receipts' }));
    expect(await screen.findByText(/One thing was left as it was/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Receipts' }));
    expect(onDone).toHaveBeenCalledWith('Receipts');
  });

  it('goes back a step on Escape from the preview, and out on Escape from the cards', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Receipts/ }));
    fireEvent.keyDown(screen.getByLabelText('Notebook name'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    const card = screen.getByRole('button', { name: /^Receipts/ });
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('freeName', () => {
  it('keeps a free name and numbers a taken one past every number in use', () => {
    expect(freeName('Receipts', [{ name: 'Travel' }])).toBe('Receipts');
    expect(freeName('Receipts', [{ name: 'RECEIPTS' }, { name: 'receipts 2' }])).toBe('Receipts 3');
  });
});

describe('describeField', () => {
  it('says what each kind of field carries', () => {
    expect(describeField({ name: 'Rating', type: 'number', scale: { max: 5, step: 0.5 } })).toBe(
      'Rating out of 5, in halves',
    );
    expect(describeField({ name: 'Amount', type: 'number', currency: 'EUR' })).toBe('Amount in EUR');
    expect(describeField({ name: 'Size', type: 'select', options: ['S', 'M', 'L', 'XL', 'XXL'] })).toBe(
      'Select: S, M, L, XL…',
    );
    expect(describeField({ name: 'Due', type: 'date' })).toBe('Date');
  });
});
