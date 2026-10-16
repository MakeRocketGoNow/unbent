import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { FieldDef } from '@unbent/shared';
import { FieldsPicker } from './FieldsPicker.js';

/**
 * The sheet's Fields page.
 *
 * What is pinned: that every definition gets a row whatever is set, that a choice writes
 * the filter to the URL and "Any" takes it off again, that a range writes each end on
 * its own, and that a change to one field leaves the others' filters alone. The URL is
 * where the filters live, so it is where a change can be observed: read as `href` for
 * the reason `ActiveFilters.test.tsx` gives.
 */
const def = (id: string, name: string, type: FieldDef['type'], options: string[] = []): FieldDef => ({
  id,
  notebookId: 'nb',
  name,
  type,
  options,
  scale: null,
  currency: null,
  position: 0,
});
const DEFS = [
  def('cat', 'Category', 'select', ['Food', 'Travel']),
  def('paid', 'Reimbursed', 'checkbox'),
  def('amt', 'Amount', 'number'),
  def('on', 'Paid on', 'date'),
  def('who', 'Merchant', 'text'),
];

function harness(selected: string[], initial = '/notes?notebook=Receipts') {
  const rootRoute = createRootRoute({
    component: () => <FieldsPicker defs={DEFS} selected={selected} />,
  });
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rendered = render(<RouterProvider router={router as any} />);
  return { ...rendered, history };
}

const url = (history: { location: { href: string } }) => decodeURIComponent(history.location.href);
const select = (el: HTMLElement) => el as unknown as HTMLSelectElement;
const input = (el: HTMLElement) => el as unknown as HTMLInputElement;

describe('FieldsPicker', () => {
  afterEach(cleanup);

  it('offers every field, with the control its type wants', async () => {
    const { findByLabelText, getByLabelText } = harness([]);
    const cat = select(await findByLabelText('Category'));
    expect([...cat.options].map((o) => o.textContent)).toEqual(['Any', 'Food', 'Travel', 'Is set', 'Is empty']);
    const paid = select(getByLabelText('Reimbursed'));
    expect([...paid.options].map((o) => o.textContent)).toEqual(['Any', 'Checked', 'Unchecked', 'Is set', 'Is empty']);
    expect(input(getByLabelText('Amount, minimum')).type).toBe('number');
    expect(input(getByLabelText('Paid on, from')).type).toBe('date');
    const who = select(getByLabelText('Merchant'));
    expect([...who.options].map((o) => o.textContent)).toEqual(['Any', 'Is set', 'Is empty']);
  });

  it('shows what is set', async () => {
    const { findByLabelText, getByLabelText } = harness(['cat:eq:Food', 'amt:gte:20', 'who:empty']);
    expect((select(await findByLabelText('Category'))).value).toBe('eq:Food');
    expect(input(getByLabelText('Amount, minimum')).value).toBe('20');
    expect(input(getByLabelText('Amount, maximum')).value).toBe('');
    expect((select(getByLabelText('Merchant'))).value).toBe('empty');
  });

  it('writes a choice to the URL and leaves the other fields alone', async () => {
    const { findByLabelText, history } = harness(['amt:gte:20']);
    fireEvent.change(await findByLabelText('Category'), { target: { value: 'eq:Travel' } });
    await waitFor(() => expect(url(history)).toContain('cat:eq:Travel'));
    expect(url(history)).toContain('amt:gte:20');
  });

  it('takes a choice off again with Any', async () => {
    const { findByLabelText, history } = harness(['cat:eq:Food', 'amt:gte:20']);
    fireEvent.change(await findByLabelText('Category'), { target: { value: '' } });
    await waitFor(() => expect(url(history)).not.toContain('cat:'));
    expect(url(history)).toContain('amt:gte:20');
  });

  it('writes each end of a range on its own', async () => {
    const { findByLabelText, getByLabelText, history } = harness(['on:gte:2026-01-01']);
    fireEvent.change(await findByLabelText('Paid on, to'), { target: { value: '2026-03-05' } });
    await waitFor(() => expect(url(history)).toContain('on:lte:2026-03-05'));
    expect(url(history)).toContain('on:gte:2026-01-01');
    // Emptying an end drops only that end.
    fireEvent.change(getByLabelText('Paid on, from'), { target: { value: '' } });
    await waitFor(() => expect(url(history)).not.toContain('on:gte'));
  });
});
