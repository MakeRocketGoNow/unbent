import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { keys } from '../queries.js';
import { NotebookDrawer } from './NotebookDrawer.js';

/**
 * Where the notes are, on a phone: `NotebookNav` in a sheet from the side.
 *
 * The rows themselves (their order, which one is marked as where you are, the tags
 * clearing on a scope change) are pinned in `NotebookNav.test.tsx`. What is the drawer's
 * own, and pinned here: it closes once a scope is picked, its head carries the account,
 * and its rows never inherit the router's own idea of "active".
 *
 * jsdom has no `showModal`, so it is stubbed the way `Sheet.test.tsx` does.
 */
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
}

const NOTEBOOKS = {
  data: {
    notebooks: [
      { id: '1', name: 'Coupons', count: 5 },
      { id: '2', name: 'Podcast Bookmarks', count: 3 },
    ],
    unfiled: 4,
  },
};

function harness(props: Partial<Parameters<typeof NotebookDrawer>[0]> = {}) {
  stubDialog();
  const onClose = vi.fn();
  const full = {
    open: true,
    onClose,
    notebook: undefined,
    selectedTags: [],
    notebooks: NOTEBOOKS,
    trashed: 1,
    tags: [{ name: 'Receipt', count: 3 }],
    views: [],
    saved: undefined,
    email: 'someone@example.com',
    onSignOut: () => {},
    ...props,
  };
  const rootRoute = createRootRoute({ component: () => <NotebookDrawer {...full} /> });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // The account menu on the drawer's floor reads the instance config to decide whether
  // there are legal documents to link to. Seeded rather than fetched: jsdom has no server.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: ['password'] });
  return {
    ...render(
      <QueryClientProvider client={client}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>,
    ),
    history,
    onClose,
  };
}

const rows = (c: HTMLElement) =>
  [...c.querySelectorAll('.drawer-item')].map((e) => e.textContent);

describe('NotebookDrawer', () => {
  // The sheet reads the breakpoint to decide whether its head drags; jsdom has no
  // matchMedia. Phone width, which is where this surface lives.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('closes once a scope is picked, since the list behind it has changed', async () => {
    const { findByText, onClose } = harness();
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  /*
   * `current`, not `active`: TanStack Router puts its own `active` class on a `<Link>` whose
   * target matches the route, so a destination on the floor would light up as the current
   * *scope*: Trash permanently, while the trash is open. This is the regression that
   * caught, and the reason the class is spelled the way it is.
   */
  it('does not mark a destination as the current scope', async () => {
    const { findByRole } = harness({ notebook: 'Coupons' });
    const trash = await findByRole('link', { name: /^Trash/ });
    expect(trash.className).not.toContain('current');
    expect(trash.getAttribute('aria-current')).toBeNull();
  });

  /* Keep's drawer is headed by its name and closed by the scrim, the back gesture or a
     row; a ✕ beside the wordmark made a navigation panel read as a dialog. */
  it('has no close button, unlike the bottom sheet', async () => {
    const { findByText, queryByLabelText } = harness();
    await findByText('All notes');
    expect(queryByLabelText('Close')).toBeNull();
  });

  /* The tags ride with the rows, so the phone gets the section too. */
  it('lists the tags under the notebooks on a phone', async () => {
    const { findByRole } = harness();
    const head = await findByRole('button', { name: 'Tags' });
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });

  /* Sign out is rare and disruptive; it stays behind the avatar rather than becoming a
     row a thumb's width under Settings. */
  it('carries the account in its head, which is the only place it is on a phone', async () => {
    const { findByLabelText, container } = harness();
    const account = await findByLabelText('Account: someone@example.com');
    expect(account.closest('.sheet-head')).toBeTruthy();
    expect(rows(container)).not.toContain('Sign out');
  });
});
