import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { FULL_GRANT, type AssistantGrant, type NotebookSummary } from '@unbent/shared';
import { AssistantAccess } from './AssistantAccess.js';

const nb = (id: string, name: string, count = 3): NotebookSummary => ({ id, name, count, fields: 0, purpose: null, emoji: null });
const library = { notebooks: [nb('a', 'Coupons', 12), nb('b', 'Receipts', 7), nb('c', 'Travel', 26)], unfiled: 172 };

/** The picker, holding its own value as the consent screen does, with the last value it gave on show. */
function Harness({ start = FULL_GRANT, loading = false, error }: { start?: AssistantGrant; loading?: boolean; error?: string }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <AssistantAccess value={value} onChange={setValue} notebooks={loading ? undefined : library} error={error} />
      {/* Not an <output>, which is a status of its own and would be found beside the picker's. */}
      <pre data-testid="value">{JSON.stringify(value)}</pre>
    </>
  );
}
const value = () => JSON.parse(screen.getByTestId('value').textContent!) as AssistantGrant;

describe('AssistantAccess', () => {
  afterEach(cleanup);

  it('opens on everything, with both questions and all four answers in view', () => {
    render(<Harness />);
    expect(screen.getByRole('group', { name: 'What it can see' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'What it can do' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /^All notebooks/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /^Read and change/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /^Only some notebooks/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Read only/ })).toBeTruthy();
    // No list until it is asked for: nothing to tick while every notebook is given.
    expect(screen.queryByRole('list', { name: 'Notebooks it can see' })).toBeNull();
  });

  it('starts "only some" from nothing picked, the Inbox included', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: /^Only some notebooks/ }));
    expect(value()).toEqual({ notebooks: [], unfiled: false, readOnly: false });
    const list = screen.getByRole('list', { name: 'Notebooks it can see' });
    expect(within(list).getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([false, false, false, false]);
    expect(screen.getByRole('status').textContent).toBe('0 of 3 notebooks picked');
  });

  it('picks notebooks by id, and the Inbox as its own answer', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: /^Only some notebooks/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Travel/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Coupons/ }));
    // In the notebooks' order, whatever order they were ticked in.
    expect(value().notebooks).toEqual(['a', 'c']);
    fireEvent.click(screen.getByRole('checkbox', { name: /Inbox/ }));
    expect(value()).toEqual({ notebooks: ['a', 'c'], unfiled: true, readOnly: false });
    expect(screen.getByRole('status').textContent).toBe('2 of 3 notebooks picked, and the Inbox');
    fireEvent.click(screen.getByRole('checkbox', { name: /Travel/ }));
    expect(value().notebooks).toEqual(['a']);
  });

  it('finds a notebook by typing, without losing what is already picked', () => {
    render(<Harness start={{ notebooks: ['a'], unfiled: false, readOnly: false }} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a notebook' }), { target: { value: 'rec' } });
    const list = screen.getByRole('list', { name: 'Notebooks it can see' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox', { name: /Receipts/ }));
    expect(value().notebooks).toEqual(['a', 'b']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a notebook' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No notebook matches “zzz”.')).toBeTruthy();
    // The count is of everything picked, not of what the filter shows.
    expect(screen.getByRole('status').textContent).toBe('2 of 3 notebooks picked');
  });

  it('gives everything back, Inbox and all, when "All notebooks" is chosen again', () => {
    render(<Harness start={{ notebooks: ['a'], unfiled: false, readOnly: true }} />);
    fireEvent.click(screen.getByRole('radio', { name: /^All notebooks/ }));
    expect(value()).toEqual({ notebooks: null, unfiled: true, readOnly: true });
  });

  it('keeps reading only apart from which notebooks', () => {
    render(<Harness start={{ notebooks: ['b'], unfiled: true, readOnly: false }} />);
    fireEvent.click(screen.getByRole('radio', { name: /^Read only/ }));
    expect(value()).toEqual({ notebooks: ['b'], unfiled: true, readOnly: true });
    fireEvent.click(screen.getByRole('radio', { name: /^Read and change/ }));
    expect(value().readOnly).toBe(false);
  });

  it('drops the id of a notebook that is gone the first time the list is changed', () => {
    render(<Harness start={{ notebooks: ['a', 'deleted-since'], unfiled: false, readOnly: false }} />);
    expect(screen.getByRole('status').textContent).toBe('1 of 3 notebooks picked');
    fireEvent.click(screen.getByRole('checkbox', { name: /Receipts/ }));
    expect(value().notebooks).toEqual(['a', 'b']);
  });

  it('says why it cannot be allowed, tied to the list it is about', () => {
    render(<Harness start={{ notebooks: [], unfiled: false, readOnly: false }} error="Pick at least one notebook, or choose All notebooks." />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Pick at least one notebook, or choose All notebooks.');
    expect(screen.getByRole('list', { name: 'Notebooks it can see' }).getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('says the notebooks are loading until there are some to pick from', () => {
    render(<Harness start={{ notebooks: [], unfiled: false, readOnly: false }} loading />);
    expect(screen.getByText('Loading your notebooks…')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Notebooks it can see' })).toBeNull();
  });
});
