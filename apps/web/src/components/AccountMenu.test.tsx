import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AppConfig } from '@unbent/shared';
import { keys } from '../queries.js';
import { AccountMenu } from './AccountMenu.js';

const BUILT_IN = { privacy: '/privacy', terms: '/terms' };

/**
 * The account menu, now that two surfaces draw it.
 *
 * It was inline in `Topbar`, which was fine while the topbar was the only place it could
 * be. The phone's note list has no topbar any more, so the drawer offers the same menu —
 * and these pin the parts that would be easy to let drift apart: the address identifies the
 * account rather than acting on it, and signing out is marked as the destructive one.
 */
function harness(
  email = 'someone@example.com',
  onSignOut = () => {},
  config: Partial<AppConfig> = { legal: BUILT_IN },
  withAddress = false,
) {
  const rootRoute = createRootRoute({
    component: () => <AccountMenu email={email} onSignOut={onSignOut} withAddress={withAddress} />,
  });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // Seeded rather than fetched: jsdom has no server, and the menu reads only this one to
  // decide whether this instance has legal documents to link to.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), { providers: ['password'], ...config });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('AccountMenu', () => {
  afterEach(cleanup);

  /* On the rail's floor the trigger is a row with room for the address; its name is the
     same either way, so nothing that reads it aloud notices the difference. */
  it('draws the address beside the avatar when asked, under the same name', async () => {
    const { findByLabelText } = harness('someone@example.com', () => {}, { legal: BUILT_IN }, true);
    const trigger = await findByLabelText('Account: someone@example.com');
    expect(trigger.textContent).toContain('someone@example.com');
    expect(trigger.className).toContain('drawer-item');
  });

  it('shows the first letter of the address, which is all a small circle carries', async () => {
    const { findByText } = harness('casey@example.com');
    expect((await findByText('C')).className).toBe('avatar');
  });

  it('falls back to a question mark rather than an empty circle', async () => {
    const { findByText } = harness('   ');
    expect(await findByText('?')).toBeTruthy();
  });

  it('names the account it belongs to, in the trigger and in the menu', async () => {
    const { findByLabelText, getByTitle } = harness('someone@example.com');
    const trigger = await findByLabelText('Account: someone@example.com');
    fireEvent.click(trigger);
    // Static, not a control: it identifies the account, it does not act on it.
    const label = getByTitle('someone@example.com');
    expect(label.tagName).toBe('SPAN');
  });

  it('offers Sign out as the destructive action, and nothing that is not about the account', async () => {
    const onSignOut = vi.fn();
    const { findByLabelText, getByText, queryByText } = harness('someone@example.com', onSignOut);
    fireEvent.click(await findByLabelText('Account: someone@example.com'));

    // Settings has a gear in the topbar and a row on the drawer's floor; a third route here
    // would sit a thumb's width from Sign out for no gain.
    expect(queryByText('Settings')).toBeNull();

    const out = getByText('Sign out');
    expect(out.className).toContain('danger');
    fireEvent.click(out);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
  /*
   * An instance that publishes neither document offers no way to them, rather than a menu
   * item leading to a page that says there is nothing there.
   */
  it('offers no legal links where the instance publishes none', async () => {
    const { findByLabelText, queryByText } = harness('someone@example.com', () => {}, {});
    fireEvent.click(await findByLabelText('Account: someone@example.com'));
    expect(queryByText('Privacy')).toBeNull();
    expect(queryByText('Terms')).toBeNull();
  });

  it('links to the built-in documents as routes', async () => {
    const { findByLabelText, getByText } = harness();
    fireEvent.click(await findByLabelText('Account: someone@example.com'));
    const privacy = getByText('Privacy');
    expect(privacy.tagName).toBe('A');
    expect(privacy.getAttribute('href')).toBe('/privacy');
  });

  it('links to documents hosted elsewhere as plain anchors', async () => {
    const elsewhere = { privacy: 'https://example.com/p', terms: 'https://example.com/t' };
    const { findByLabelText, getByText } = harness('someone@example.com', () => {}, {
      legal: elsewhere,
    });
    fireEvent.click(await findByLabelText('Account: someone@example.com'));
    expect(getByText('Privacy').getAttribute('href')).toBe('https://example.com/p');
    expect(getByText('Terms').getAttribute('href')).toBe('https://example.com/t');
  });
});
