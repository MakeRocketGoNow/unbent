import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
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
  { id: 'f1', notebookId: 'nb1', name: 'Merchant', type: 'text', options: [], position: 0, valueCount: 12 },
  { id: 'f2', notebookId: 'nb1', name: 'Category', type: 'select', options: ['Food', 'Travel'], position: 1, valueCount: 0 },
  { id: 'f3', notebookId: 'nb1', name: 'Amount', type: 'number', options: [], position: 2 },
];

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
  afterEach(cleanup);

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
});
