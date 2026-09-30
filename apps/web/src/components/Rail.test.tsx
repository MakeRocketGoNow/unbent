import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { keys } from '../queries.js';
import { filters } from '../routes/notes.js';
import { usePersistentState } from '../usePersistentState.js';
import { Rail, RailHandle, useRailWidth, type RailPref } from './Rail.js';
import { useRef } from 'react';

/**
 * The desktop's navigation rail.
 *
 * The rows are `NotebookNav`'s and are pinned there. What is the rail's own: it reads
 * where it stands from the router — the notebook from the notes' search params, the
 * destination from the path — and it remembers whether it is open, by width until the
 * user chooses and by the user's choice after.
 *
 * jsdom has no `matchMedia`; the stub below answers the rail's width query and can be
 * flipped, the way `useMediaQuery.test.ts` does.
 */
function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return (next: boolean) => {
    matches = next;
    listeners.forEach((fn) => fn());
  };
}

/** The shell's share of the arrangement: the stored preference and the class it sets. */
function Shell() {
  const [pref, setPref] = usePersistentState<RailPref>('rail', 'auto', (raw) =>
    raw === 'open' || raw === 'collapsed' ? raw : undefined,
  );
  const width = useRailWidth();
  const shellRef = useRef<HTMLDivElement>(null);
  return (
    <div
      data-testid="shell"
      className={`shell wide rail-${pref}`}
      style={width.style}
      ref={shellRef}
    >
      <Rail pref={pref} onPref={setPref} email="someone@example.com" onSignOut={() => {}} />
      <RailHandle containerRef={shellRef} width={width} onCollapse={() => setPref('collapsed')} />
      <Outlet />
    </div>
  );
}

function harness(initial: string, wide = true) {
  const setWide = stubMatchMedia(wide);
  const rootRoute = createRootRoute({ component: Shell });
  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notes',
    validateSearch: filters,
    component: () => <p>notes</p>,
  });
  const trashRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/trash',
    component: () => <p>trash</p>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <p>settings</p>,
  });
  const routeTree = rootRoute.addChildren([notesRoute, trashRoute, settingsRoute]);
  const history = createMemoryHistory({ initialEntries: [initial] });
  const router = createRouter({ routeTree, history });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.notebooks(), {
    notebooks: [{ id: '1', name: 'Coupons', count: 5 }],
    unfiled: 0,
  });
  // The query selects `total` out of a page, so the cache holds the page shape.
  client.setQueryData(keys.trashCount(), { items: [], cursor: null, total: 2 });
  // The account menu reads the instance config for legal links; seeded, jsdom has no server.
  client.setQueryData(keys.config(), { providers: ['password'] });
  return {
    ...render(
      <QueryClientProvider client={client}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    ),
    history,
    setWide,
  };
}

const current = (c: HTMLElement) =>
  [...c.querySelectorAll('.rail .current')].map((e) => e.textContent);

describe('Rail', () => {
  // The router restores scroll on navigation and jsdom has no window.scrollTo.
  vi.stubGlobal('scrollTo', () => {});
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.stubGlobal('scrollTo', () => {});
  });

  it('marks the notebook from the notes URL, and only there', async () => {
    const { container, findByText } = harness('/notes?notebook=Coupons');
    await findByText('notes');
    expect(current(container)).toEqual(['Coupons5']);
  });

  it('marks Trash beside the trash and Settings beside settings, and no place', async () => {
    const trash = harness('/trash');
    await trash.findByText('trash');
    expect(current(trash.container)).toEqual(['Trash2']);
    cleanup();

    const settings = harness('/settings');
    await settings.findByText('settings');
    expect(current(settings.container)).toEqual(['Settings']);
  });

  /* Until the user has chosen, the width decides; the button says what a click will do. */
  it('follows the window until a choice is made', async () => {
    const { findByRole, getByTestId, setWide } = harness('/notes', true);
    expect((await findByRole('button', { name: 'Collapse sidebar' })).getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId('shell').className).toContain('rail-auto');

    setWide(false);
    await findByRole('button', { name: 'Expand sidebar' });
    expect(getByTestId('shell').className).toContain('rail-auto');
  });

  /* A click settles it: the class changes, the choice is stored, and the width no longer
     has a say. */
  it('remembers the choice, and stops following the window', async () => {
    const { findByRole, getByTestId, setWide } = harness('/notes', true);
    fireEvent.click(await findByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => expect(getByTestId('shell').className).toContain('rail-collapsed'));
    expect(localStorage.getItem('unbent.rail')).toBe('"collapsed"');

    fireEvent.click(await findByRole('button', { name: 'Expand sidebar' }));
    await waitFor(() => expect(getByTestId('shell').className).toContain('rail-open'));
    expect(localStorage.getItem('unbent.rail')).toBe('"open"');

    // Narrowing the window changes nothing once the user has spoken.
    setWide(false);
    expect(getByTestId('shell').className).toContain('rail-open');
    expect((await findByRole('button', { name: 'Collapse sidebar' })).getAttribute('aria-expanded')).toBe('true');
  });

  it('honours a stored choice on a fresh load', async () => {
    localStorage.setItem('unbent.rail', '"collapsed"');
    const { findByRole, getByTestId } = harness('/notes', true);
    await findByRole('button', { name: 'Expand sidebar' });
    expect(getByTestId('shell').className).toContain('rail-collapsed');
  });

  /* Collapsed, the rows keep their words as tooltips and as names; the stylesheet does
     the clipping, which jsdom cannot show. */
  it('gives a strip its tooltips', async () => {
    localStorage.setItem('unbent.rail', '"collapsed"');
    const { findByRole } = harness('/notes', true);
    const trash = await findByRole('link', { name: /^Trash/ });
    expect(trash.getAttribute('title')).toBe('Trash');
    expect(trash.textContent).toContain('Trash');
  });

  /* What the top bar held: the wordmark home, and the account, on the floor under
     Settings so the menu it opens is never clipped by the scrolling rows. */
  it('carries the wordmark and the account, the account last on the floor', async () => {
    const { findByRole, container } = harness('/notes');
    const home = await findByRole('link', { name: 'Unbent' });
    expect(home.getAttribute('href')).toBe('/notes');
    const account = await findByRole('button', { name: 'Account: someone@example.com' });
    expect(account.closest('.drawer-foot')).toBeTruthy();
    const foot = container.querySelector('.drawer-foot')!;
    expect(foot.lastElementChild?.contains(account)).toBe(true);
    expect(account.textContent).toContain('someone@example.com');
  });

  /* The open rail is sized by its handle, like the list; the width reaches the
     stylesheet as a custom property on the shell, where the filter panel can inherit it. */
  it('is sized by its handle, remembered, and exposed to the shell as a custom property', async () => {
    const { findByRole, getByTestId } = harness('/notes');
    const handle = await findByRole('separator', { name: 'Resize navigation' });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');
    expect(getByTestId('shell').style.getPropertyValue('--rail-open-width')).toBe('240px');

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('320'));
    expect(localStorage.getItem('unbent.railWidth')).toBe('320');
    expect(getByTestId('shell').style.getPropertyValue('--rail-open-width')).toBe('320px');

    // Past the ceiling is clamped, not stored past it.
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(localStorage.getItem('unbent.railWidth')).toBe('320'));
  });

  /* Dragging on past the floor is a request to collapse, not a width of zero. */
  it('collapses when dragged past its floor, keeping the width it had', async () => {
    localStorage.setItem('unbent.railWidth', '176');
    const { findByRole, getByTestId } = harness('/notes');
    const handle = await findByRole('separator', { name: 'Resize navigation' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    await waitFor(() => expect(getByTestId('shell').className).toContain('rail-collapsed'));
    expect(localStorage.getItem('unbent.rail')).toBe('"collapsed"');
    expect(localStorage.getItem('unbent.railWidth')).toBe('176');
    expect(getByTestId('shell').style.getPropertyValue('--rail-open-width')).toBe('176px');
  });

  it('picks a notebook without closing anything, from any screen', async () => {
    const { findByRole, history } = harness('/trash');
    fireEvent.click(await findByRole('link', { name: /^Coupons/ }));
    await waitFor(() => {
      expect(history.location.pathname).toBe('/notes');
      expect(history.location.href).toContain('Coupons');
    });
  });
});
