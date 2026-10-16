import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { DatePicker } from './DatePicker.js';
import { DATE_PRESETS } from './date-presets.js';

/**
 * The date range as a page of choices.
 *
 * The arithmetic is `date-presets.ts`'s and is tested there. What is left here is the page's
 * own behaviour: which row claims to be current, that picking one clears the other end, and
 * that the custom fields are revealed rather than always shown, but are already open when
 * a custom range is what is set, so the page never hides the state it is in.
 */
function harness(from?: string, to?: string, entry = '/notes') {
  const onDone = vi.fn();
  const rootRoute = createRootRoute({
    component: () => <DatePicker from={from} to={to} onDone={onDone} />,
  });
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...render(<RouterProvider router={router as any} />), history, onDone };
}

const options = (c: HTMLElement) =>
  [...c.querySelectorAll('.date-option')].map((e) => e.textContent);
const current = (c: HTMLElement) =>
  [...c.querySelectorAll('.date-option.current')].map((e) => e.textContent);

describe('DatePicker', () => {
  afterEach(cleanup);

  it('offers the presets, then Any time, then Custom — the order of how often each is wanted', async () => {
    const { container, findByText } = harness();
    await findByText('Any time');
    expect(options(container)).toEqual([
      ...DATE_PRESETS.map((p) => p.label),
      'Any time',
      'Custom…',
    ]);
  });

  it('marks Any time when no range is set', async () => {
    const { container, findByText } = harness();
    await findByText('Any time');
    expect(current(container)).toEqual(['Any time']);
  });

  it('marks the preset that matches the range', async () => {
    const from = DATE_PRESETS.find((p) => p.key === '30')!.from();
    const { container, findByText } = harness(from, undefined);
    await findByText('Any time');
    expect(current(container)).toEqual(['Last 30 days']);
  });

  /*
   * Every preset is open-ended, so setting one has to clear any end already there: a stale
   * `to` would silently narrow the range the row names.
   */
  it('clears the far end when a preset is picked', async () => {
    const { findByText, history } = harness('2020-01-01', '2020-06-01');
    fireEvent.click(await findByText('This year'));
    await waitFor(() => {
      expect(history.location.href).toContain('from=');
      expect(history.location.href).not.toContain('to=');
    });
  });

  it('clears both ends for Any time', async () => {
    const { findByText, history } = harness('2020-01-01', '2020-06-01');
    fireEvent.click(await findByText('Any time'));
    await waitFor(() => {
      expect(history.location.href).not.toContain('from');
      expect(history.location.href).not.toContain('to=');
    });
  });

  /* Two labelled fields and a calendar each is more than the page should show when the
     presets answer the question most of the time. */
  it('keeps the custom fields away until they are asked for', async () => {
    const { container, findByText } = harness();
    await findByText('Custom…');
    expect(container.querySelector('.date-range')).toBeNull();
    fireEvent.click(await findByText('Custom…'));
    await waitFor(() => expect(container.querySelector('.date-range')).toBeTruthy());
  });

  /* A range that is set but is not a preset is by definition custom, and the page has to
     open showing it rather than hiding the state it is in behind a row. */
  it('opens with the fields already shown when a custom range is what is set', async () => {
    const { container, findByText } = harness('2019-03-04', '2019-05-06');
    await findByText('Custom…');
    expect(container.querySelector('.date-range')).toBeTruthy();
    expect(current(container)).toEqual(['Custom…']);
  });

  /* The props mirror the URL in the app, so the harness starts at one that carries the
     start: otherwise `prev` is empty and this would be testing the harness. */
  it('writes a hand-typed end without disturbing the start', async () => {
    const { container, findByText, history } = harness('2019-03-04', undefined, '/notes?from=2019-03-04');
    await findByText('Custom…');
    const inputs = container.querySelectorAll('.date-range input');
    fireEvent.change(inputs[1]!, { target: { value: '2019-09-09' } });
    await waitFor(() => {
      expect(history.location.href).toContain('2019-03-04');
      expect(history.location.href).toContain('2019-09-09');
    });
  });

  /*
   * A preset is one tap and the whole answer, so the page has nothing left to say. Being
   * returned to the filters is what makes this a sub-page rather than somewhere you get
   * stranded, and it is what the phone app does.
   */
  it('goes back once a preset has answered the question', async () => {
    const { findByText, onDone } = harness();
    fireEvent.click(await findByText('Last 30 days'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('goes back for Any time too, which is just as final an answer', async () => {
    const { findByText, onDone } = harness('2020-01-01');
    fireEvent.click(await findByText('Any time'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  /* Custom opens the fields rather than answering, so it must not take the page away. */
  it('stays put for Custom, which asks a question rather than answering one', async () => {
    const { findByText, onDone } = harness();
    fireEvent.click(await findByText('Custom…'));
    await waitFor(() => expect(onDone).not.toHaveBeenCalled());
  });

  /* A custom range is usually two fields; leaving after the first would take the second
     away mid-edit. */
  it('stays put while the custom fields are being filled in', async () => {
    const { container, findByText, onDone } = harness('2019-03-04', undefined, '/notes?from=2019-03-04');
    await findByText('Custom…');
    const inputs = container.querySelectorAll('.date-range input');
    fireEvent.change(inputs[1]!, { target: { value: '2019-09-09' } });
    await waitFor(() => expect(onDone).not.toHaveBeenCalled());
  });

  it('says which option is in effect to a screen reader, not only in colour', async () => {
    const { findByText } = harness();
    expect((await findByText('Any time')).getAttribute('aria-pressed')).toBe('true');
    expect((await findByText('Today')).getAttribute('aria-pressed')).toBe('false');
  });

});
