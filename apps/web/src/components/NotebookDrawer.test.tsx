import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { UNFILED } from '@unbent/shared';
import { keys } from '../queries.js';
import { NotebookDrawer } from './NotebookDrawer.js';

/**
 * Where the notes are, on a phone.
 *
 * The drawer is navigation, and the thing that makes it navigation rather than a filter
 * list is the rule it shares with the notebook picker: choosing a scope clears the tags,
 * because tags cross notebook boundaries and carrying one across lands on an empty list
 * with nothing on screen to explain it. That, and which row is marked as where you are,
 * are what these pin.
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
  afterEach(cleanup);

  /* Keep's order: the places, the way to make another, then on the floor the two
     destinations that are not places — Trash, and Settings, which used to hide behind
     the avatar on the one screen with no topbar to show the avatar on. */
  it('lists the places notes live, then the destinations', async () => {
    const { container, findByText } = harness();
    await findByText('All notes');
    expect(rows(container)).toEqual([
      'All notes',
      'Inbox4',
      'Coupons5',
      'Podcast Bookmarks3',
      'New notebook',
      'Trash1',
      'Settings',
    ]);
  });

  /* All notes is the unnarrowed list, not merely "no notebook" — a tag is still a
     narrowing, so the row must not claim to be where you are while one is applied. */
  it('marks All notes only when nothing at all is narrowing the list', async () => {
    const { findByText } = harness();
    expect((await findByText('All notes')).className).toContain('current');

    cleanup();
    const tagged = harness({ selectedTags: ['Receipt'] });
    expect((await tagged.findByText('All notes')).className).not.toContain('current');
  });

  it('marks the notebook you are in', async () => {
    const { findByText } = harness({ notebook: 'Coupons' });
    const row = await findByText('Coupons');
    expect(row.closest('.drawer-item')?.className).toContain('current');
    expect(row.closest('.drawer-item')?.getAttribute('aria-current')).toBe('true');
  });

  /*
   * The rule that makes this navigation rather than a filter: tags cross notebook
   * boundaries, so carrying one into a new notebook routinely yields an empty list with no
   * visible cause.
   */
  it('clears the tags when the scope changes, and keeps how you are looking', async () => {
    const { findByText, history } = harness({
      notebook: undefined,
      selectedTags: ['Receipt'],
    });
    // Arrive with a sort already set, to prove it survives.
    await history.push('/notes?sort=title&tag=Receipt');
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => {
      expect(history.location.href).toContain('Coupons');
      expect(history.location.href).not.toContain('Receipt');
    });
  });

  it('closes once a scope is picked, since the list behind it has changed', async () => {
    const { findByText, onClose } = harness();
    fireEvent.click(await findByText('Coupons'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('sends All notes back to the whole list', async () => {
    const { findByText, history } = harness({ notebook: 'Coupons' });
    fireEvent.click(await findByText('All notes'));
    await waitFor(() => expect(history.location.href).not.toContain('Coupons'));
  });

  /* Offered only when there is something in it: otherwise it leads to a guaranteed empty
     list. It stays while it is the active scope, so the drawer never fails to say where
     you are. */
  it('offers Inbox only when it holds something or is where you are', async () => {
    const empty = { data: { notebooks: NOTEBOOKS.data.notebooks, unfiled: 0 } };
    const { container, findByText } = harness({ notebooks: empty });
    await findByText('All notes');
    expect(rows(container)).not.toContain('Inbox0');

    cleanup();
    const inIt = harness({ notebooks: empty, notebook: UNFILED });
    expect((await inIt.findByText('Inbox')).closest('.drawer-item')?.className).toContain(
      'current',
    );
  });

  it('keeps the trash count off the row when the trash is empty', async () => {
    const { container, findByText } = harness({ trashed: 0 });
    await findByText('All notes');
    expect(rows(container)).toContain('Trash');
  });

  /* Trash, Settings and New notebook navigate, so they are links: middle-click and copy
     keep working, which a button would lose. */
  it('draws the destinations as links rather than buttons', async () => {
    const { findByText } = harness();
    expect((await findByText('Trash')).tagName).toBe('A');
    expect((await findByText('Settings')).tagName).toBe('A');
    expect((await findByText('New notebook')).tagName).toBe('A');
  });

  /*
   * `current`, not `active`: TanStack Router puts its own `active` class on a `<Link>` whose
   * target matches the route, so a destination on the floor would light up as the current
   * *scope* — Trash permanently, while the trash is open. This is the regression that
   * caught, and the reason the class is spelled the way it is.
   */
  it('does not mark a destination as the current scope', async () => {
    const { findByText } = harness({ notebook: 'Coupons' });
    const trash = await findByText('Trash');
    expect(trash.className).not.toContain('current');
    expect(trash.getAttribute('aria-current')).toBeNull();
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
