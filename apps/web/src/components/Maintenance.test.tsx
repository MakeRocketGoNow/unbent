import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AppConfig } from '@unbent/shared';
import { keys } from '../queries.js';

const deleteUser = vi.fn();

vi.mock('../auth-client.js', () => ({
  deleteUser: (body: unknown) => deleteUser(body),
  useSession: () => ({ data: { user: { email: 'someone@example.com' } } }),
}));

const { Maintenance } = await import('./Maintenance.js');

/**
 * The account-deletion section of the maintenance page.
 *
 * Every other control here destroys something the moment it is confirmed. This one sends
 * mail and destroys nothing, which is the distinction the page has to carry without
 * making it sound optional — so what is pinned below is that the copy never claims a
 * deletion happened, and that the section is absent where the endpoint does not exist.
 */
function harness(config: Partial<AppConfig> = { accountDeletion: true }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seeded rather than fetched: jsdom has no server, and these three are the only queries
  // the panel reads — the indexing section asks for a fourth only where `vision` is set.
  client.setQueryData(keys.config(), { providers: ['password'], ...config });
  client.setQueryData(keys.exactCount({ trashed: true }), { items: [], cursor: null, total: 0 });
  client.setQueryData(keys.exactCount({}), { items: [], cursor: null, total: 3 });

  const rootRoute = createRootRoute({ component: () => <Maintenance /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/maintenance'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('Maintenance: files not yet searchable', () => {
  afterEach(cleanup);

  /**
   * The indexing passes moved here from Import, where they read as a step of importing.
   * Pinned as the first section: weight runs opposite to blast radius on this page, and
   * these change nothing, so they come before anything that deletes.
   */
  it('offers the indexing passes first, before anything permanent', async () => {
    harness();
    expect(await screen.findByRole('button', { name: 'Index existing PDFs' })).toBeTruthy();
    const headings = [...document.querySelectorAll('.settings-section h3')].map((h) => h.textContent);
    expect(headings[0]).toBe('Files not yet searchable');
    // Without a vision model there is nothing paid to offer, and nothing is asked for.
    expect(screen.queryByRole('button', { name: /Read/ })).toBeNull();
  });
});

describe('Maintenance: note counts', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * The recount's answer is shown under its own button. The page's shared result line is
   * at the foot, three sections away, and "Corrected 2 counts" read there would have to
   * be connected back up the page by the reader.
   */
  it('says under the button whether anything needed correcting', async () => {
    const answers = [{ corrected: 0 }, { corrected: 2 }];
    // The page's own counts refetch on mount too; only the recount takes an answer.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('/api/admin/recount-notes')
          ? new Response(JSON.stringify(answers.shift()), { status: 200 })
          : new Response(JSON.stringify({ items: [], cursor: null, total: 3 }), { status: 200 }),
      ),
    );
    harness();

    const button = await screen.findByRole('button', { name: 'Recount' });
    fireEvent.click(button);
    const already = await screen.findByText('Every count was already right.');
    expect(already.closest('.settings-section')?.querySelector('h3')?.textContent).toBe('Note counts');

    fireEvent.click(await screen.findByRole('button', { name: 'Recount' }));
    expect(await screen.findByText('Corrected 2 counts.')).toBeTruthy();
    expect(screen.queryByText('Every count was already right.')).toBeNull();
  });
});

describe('Maintenance: delete account', () => {
  afterEach(() => {
    cleanup();
    deleteUser.mockReset();
  });

  /**
   * The instance decides whether this exists at all. Deletion is confirmed by mail, so
   * where there is none the endpoint answers 404 and a button for it would read as a
   * broken app rather than a configured one.
   */
  it('is absent where the instance does not offer deletion', async () => {
    const { queryByRole, findByRole } = harness({ accountDeletion: false });
    // The rest of the page is still there, so this is an absent section rather than an
    // unrendered panel.
    await findByRole('button', { name: 'Delete all notes' });
    expect(queryByRole('button', { name: 'Delete account' })).toBeNull();
  });

  /** Nothing leaves until the confirm is answered — the first click only asks. */
  it('sends nothing on the first click', async () => {
    const { findByRole } = harness();
    fireEvent.click(await findByRole('button', { name: 'Delete account' }));
    expect(deleteUser).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Confirm delete account' })).toBeTruthy();
  });

  /**
   * Deliberately no typed gate, unlike "Delete all notes" on the same page. That button is
   * itself the irreversible step; this one sends mail, and the irreversible step is the
   * link. Pinned so the two do not get "made consistent" later without the reasoning.
   */
  it('does not demand a typed word to send mail', async () => {
    const { findByRole } = harness();
    fireEvent.click(await findByRole('button', { name: 'Delete account' }));
    expect(screen.queryByLabelText('Type DELETE to confirm')).toBeNull();
    const send = (await findByRole('button', {
      name: 'Email me the link',
    })) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  /** The outcome is mail, and the copy has to say so rather than imply a deletion. */
  it('reports that a link was sent, not that anything was deleted', async () => {
    deleteUser.mockResolvedValue({ data: { success: true } });
    const { findByRole, findByText } = harness();

    fireEvent.click(await findByRole('button', { name: 'Delete account' }));
    fireEvent.click(await findByRole('button', { name: 'Email me the link' }));

    const sent = await findByText(/Nothing has been deleted yet/);
    // Named in the message itself, not only in the copy above it: which address to go and
    // look in is the one thing this state exists to say.
    expect(sent.textContent).toContain('someone@example.com');
    // The client sends no callbackURL: the API pins where the link lands, for every caller.
    expect(deleteUser).toHaveBeenCalledWith({});
    // And the way back if the mail never arrives.
    expect(await findByRole('button', { name: 'Send the link again' })).toBeTruthy();
  });

  /** A refusal has to be visible, and must not leave a success message behind. */
  it('surfaces a refusal without claiming the link was sent', async () => {
    deleteUser.mockResolvedValue({ error: { message: 'Session is not fresh' } });
    const { findByRole, findByText } = harness();

    fireEvent.click(await findByRole('button', { name: 'Delete account' }));
    fireEvent.click(await findByRole('button', { name: 'Email me the link' }));

    expect(await findByText('Session is not fresh')).toBeTruthy();
    expect(screen.queryByText(/Nothing has been deleted yet/)).toBeNull();
  });
});
