import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { AccountMenu } from './AccountMenu.js';

/**
 * The account menu, now that two surfaces draw it.
 *
 * It was inline in `Topbar`, which was fine while the topbar was the only place it could
 * be. The phone's note list has no topbar any more, so the drawer offers the same menu —
 * and these pin the parts that would be easy to let drift apart: the address identifies the
 * account rather than acting on it, and signing out is marked as the destructive one.
 */
function harness(email = 'someone@example.com', onSignOut = () => {}) {
  const rootRoute = createRootRoute({
    component: () => <AccountMenu email={email} onSignOut={onSignOut} />,
  });
  const history = createMemoryHistory({ initialEntries: ['/notes'] });
  const router = createRouter({ routeTree: rootRoute, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

describe('AccountMenu', () => {
  afterEach(cleanup);

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

  it('offers Settings as a link and Sign out as the destructive action', async () => {
    const onSignOut = vi.fn();
    const { findByLabelText, getByText } = harness('someone@example.com', onSignOut);
    fireEvent.click(await findByLabelText('Account: someone@example.com'));

    // Settings navigates, so it has to be a real link — middle-click and copy still work.
    expect(getByText('Settings').tagName).toBe('A');

    const out = getByText('Sign out');
    expect(out.className).toContain('danger');
    fireEvent.click(out);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
