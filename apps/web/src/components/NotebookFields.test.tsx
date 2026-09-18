import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import type { FieldDef } from '@unbent/shared';
import { keys } from '../queries.js';
import * as api from '../notes-api.js';
import { NotebookFields } from './NotebookFields.js';

/**
 * The management page, rendered against seeded queries and a real router. What is worth
 * pinning without a server: that each row offers its type and its order, that the ends
 * of the list cannot move past themselves, that a select field gets its options editor,
 * and that a delete names what it will take.
 */

/** A select's value; the DOM typings here will not cast an HTMLElement to a select directly. */
const selectValue = (label: string) => (screen.getByLabelText(label) as unknown as { value: string }).value;

const fields: FieldDef[] = [
  { id: 'f1', notebookId: 'nb1', name: 'Merchant', type: 'text', options: [], scale: null, position: 0, valueCount: 12 },
  { id: 'f2', notebookId: 'nb1', name: 'Category', type: 'select', options: ['Food', 'Travel'], scale: null, position: 1, valueCount: 0 },
  { id: 'f3', notebookId: 'nb1', name: 'Amount', type: 'number', options: [], scale: null, position: 2 },
];

const rating: FieldDef = {
  id: 'f4',
  notebookId: 'nb1',
  name: 'Stars',
  type: 'number',
  options: [],
  scale: { max: 10, step: 0.5 },
  position: 0,
  valueCount: 5,
};

function mount(seed: FieldDef[] = fields) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.notebookFields('nb1'), seed);
  client.setQueryData(keys.notebooks(), {
    notebooks: [{ id: 'nb1', name: 'Receipts', count: 3, fields: seed.length }],
    unfiled: 0,
  });

  const onChanged = vi.fn();
  const rootRoute = createRootRoute({
    component: () => <NotebookFields notebookId="nb1" onChanged={onChanged} />,
  });
  const notebooksRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings/notebooks' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([notebooksRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return { onChanged };
}

describe('NotebookFields', () => {
  beforeAll(() => {
    vi.stubGlobal('scrollTo', () => {});
  });
  beforeEach(() => {
    vi.spyOn(api, 'previewFieldConversion');
    vi.spyOn(api, 'updateNotebookField');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('names the notebook and lists its fields with their types and value counts', async () => {
    mount();
    expect(await screen.findByText('Fields in Receipts')).toBeTruthy();
    expect(screen.getByText('Merchant')).toBeTruthy();
    expect(selectValue('Type of Merchant')).toBe('text');
    expect(selectValue('Type of Amount')).toBe('number');
    expect(screen.getByTitle('12 notes with a value').textContent).toBe('12');
  });

  it('cannot move the first field up or the last one down', async () => {
    mount();
    await screen.findByText('Merchant');
    expect((screen.getByLabelText('Move Merchant up') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Move Merchant down') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Move Amount down') as HTMLButtonElement).disabled).toBe(true);
  });

  it('gives a select field an editor for its options, and only a select field', async () => {
    mount();
    await screen.findByText('Category');
    expect(screen.getByLabelText('Remove option Food')).toBeTruthy();
    expect(screen.getByLabelText('Remove option Travel')).toBeTruthy();
    // One editor for the one select field; the new-field form only shows one for a select.
    expect(screen.getAllByLabelText('Add a option')).toHaveLength(1);
  });

  it('asks before deleting, naming how many notes lose a value', async () => {
    mount();
    await screen.findByText('Merchant');
    fireEvent.click(screen.getAllByText('Delete')[0]!);
    await waitFor(() => expect(screen.getByText('Its values on 12 notes will be deleted.')).toBeTruthy());
    expect(screen.getByText('Delete field')).toBeTruthy();

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Delete field')).toBeNull());

    fireEvent.click(screen.getAllByText('Delete')[1]!);
    await waitFor(() => expect(screen.getByText('No note has a value for it.')).toBeTruthy());
  });

  it('opens the rename in place and refuses a reserved name', async () => {
    mount();
    fireEvent.click(await screen.findByText('Merchant'));
    const input = screen.getByLabelText('Field name') as HTMLInputElement;
    expect(input.value).toBe('Merchant');
    fireEvent.change(input, { target: { value: 'title' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('That name belongs to the note itself')).toBeTruthy();
  });

  it('shows the options editor in the new-field form only for a select', async () => {
    mount([]);
    expect(await screen.findByText(/No fields yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Add a option')).toBeNull();
    fireEvent.change(screen.getByLabelText('New field type'), { target: { value: 'select' } });
    expect(screen.getByLabelText('Add a option')).toBeTruthy();
  });

  /*
     Tightening a rating used to PATCH immediately. The server cleared every value that
     no longer fit — a 7 on a scale dropped from 10 to 5, a 3.5 once half steps went —
     and the confirmation that a type change gets never ran. The tests below are that
     bug: the picker asks first, names the count, and writes only after Confirm.
  */
  it('asks before narrowing a rating, naming how many values will be cleared', async () => {
    vi.mocked(api.previewFieldConversion).mockResolvedValue({ values: 5, incompatible: 2 });
    vi.mocked(api.updateNotebookField).mockResolvedValue({
      field: { ...rating, scale: { max: 5, step: 0.5 } },
      cleared: 2,
    });
    mount([rating]);
    await screen.findByText('Stars');
    fireEvent.change(screen.getByLabelText('Rating scale maximum'), { target: { value: '5' } });

    expect(await screen.findByText((_, node) => node?.textContent === 'Change Stars to out of 5?')).toBeTruthy();
    expect(screen.getByText('5 notes have a value. 2 of them can\'t be read that way and will be cleared.')).toBeTruthy();
    expect(screen.getByText('Change and clear 2 values')).toBeTruthy();
    expect(api.updateNotebookField).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Change and clear 2 values'));
    await waitFor(() =>
      // A tighten writes the scale alone, the same body `changeScale` sends when nothing
      // needs confirming — one intent, one shape.
      expect(api.updateNotebookField).toHaveBeenCalledWith('nb1', 'f4', { scale: { max: 5, step: 0.5 } }),
    );
  });

  it('does not write a narrower scale if the confirmation is cancelled', async () => {
    vi.mocked(api.previewFieldConversion).mockResolvedValue({ values: 5, incompatible: 2 });
    mount([rating]);
    await screen.findByText('Stars');
    fireEvent.change(screen.getByLabelText('Rating scale maximum'), { target: { value: '5' } });
    await screen.findByText((_, node) => node?.textContent === 'Change Stars to out of 5?');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText((_, node) => node?.textContent === 'Change Stars to out of 5?')).toBeNull());
    expect(api.updateNotebookField).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Rating scale maximum') as unknown as { value: string }).value).toBe('10');
    // The checkbox draws from the same `field.scale`, so it snaps back with the select.
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('asks before dropping half steps', async () => {
    vi.mocked(api.previewFieldConversion).mockResolvedValue({ values: 5, incompatible: 1 });
    mount([rating]);
    await screen.findByText('Stars');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByText((_, node) => node?.textContent === 'Drop half steps on Stars?')).toBeTruthy();
    expect(api.updateNotebookField).not.toHaveBeenCalled();
  });

  /*
     A plain number gaining a scale is a type change in the picker's terms, not a tighten:
     `field.scale` is null, so the confirm keeps sending `type` and the field is written as
     a rating rather than just re-scaled.
  */
  it('still sends the type when a plain number becomes a rating', async () => {
    const plain: FieldDef = { ...rating, scale: null };
    vi.mocked(api.previewFieldConversion).mockResolvedValue({ values: 4, incompatible: 1 });
    vi.mocked(api.updateNotebookField).mockResolvedValue({
      field: { ...plain, scale: { max: 5, step: 0.5 } },
      cleared: 1,
    });
    mount([plain]);
    await screen.findByText('Stars');
    fireEvent.change(screen.getByLabelText('Type of Stars'), { target: { value: 'rating' } });

    await screen.findByText((_, node) => node?.textContent === 'Change Stars to Rating?');
    fireEvent.click(screen.getByText('Change and clear 1 value'));
    await waitFor(() =>
      expect(api.updateNotebookField).toHaveBeenCalledWith('nb1', 'f4', {
        type: 'number',
        scale: { max: 5, step: 0.5 },
      }),
    );
  });

  /*
     Both halves of the scale can differ from what the server holds at once. The question
     then has to name the halves as well as the max: they are exactly what gets cleared,
     and "out of 5" alone reads as though they survive.
  */
  it('names the lost half steps as well as the new max when both change', async () => {
    const halfStepTen: FieldDef = { ...rating, scale: { max: 10, step: 0.5 } };
    vi.mocked(api.previewFieldConversion).mockResolvedValue({ values: 5, incompatible: 3 });
    mount([halfStepTen]);
    await screen.findByText('Stars');

    // A rating drawn out of 10 with halves, moving to 5 without them.
    fireEvent.change(screen.getByLabelText('Rating scale maximum'), { target: { value: '5' } });
    await screen.findByText((_, node) => node?.textContent === 'Change Stars to out of 5?');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() =>
      expect(screen.queryByText((_, node) => node?.textContent === 'Change Stars to out of 5?')).toBeNull(),
    );

    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      await screen.findByText((_, node) => node?.textContent === 'Drop half steps on Stars?'),
    ).toBeTruthy();
    expect(api.updateNotebookField).not.toHaveBeenCalled();
  });

  /*
     If the preview cannot be fetched, the count is unknown — and writing anyway is the
     original bug, clearing values without ever naming them. The error surfaces instead.
  */
  it('does not write a narrower scale when the preview fails', async () => {
    vi.mocked(api.previewFieldConversion).mockRejectedValue(new Error('Network down'));
    mount([rating]);
    await screen.findByText('Stars');
    fireEvent.change(screen.getByLabelText('Rating scale maximum'), { target: { value: '5' } });

    expect(await screen.findByText('Network down')).toBeTruthy();
    expect(api.updateNotebookField).not.toHaveBeenCalled();
  });

  it('writes a wider scale without asking, because nothing can be cleared', async () => {
    const five: FieldDef = { ...rating, scale: { max: 5, step: 1 } };
    vi.mocked(api.previewFieldConversion).mockResolvedValue({ values: 3, incompatible: 0 });
    vi.mocked(api.updateNotebookField).mockResolvedValue({
      field: { ...five, scale: { max: 10, step: 1 } },
      cleared: 0,
    });
    mount([five]);
    await screen.findByText('Stars');
    fireEvent.change(screen.getByLabelText('Rating scale maximum'), { target: { value: '10' } });
    await waitFor(() =>
      expect(api.updateNotebookField).toHaveBeenCalledWith('nb1', 'f4', { scale: { max: 10, step: 1 } }),
    );
    expect(screen.queryByLabelText('Confirm change rating scale')).toBeNull();
  });
});
