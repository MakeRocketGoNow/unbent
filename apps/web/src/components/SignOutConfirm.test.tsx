import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SignOutConfirm } from './SignOutConfirm.js';
import { useSignOut } from '../useSignOut.js';

vi.mock('../store/library.js', () => ({ settleWrites: vi.fn() }));
vi.mock('../auth-client.js', () => ({ signOut: vi.fn(async () => ({})), refreshSession: vi.fn(async () => null) }));
vi.mock('../offline-cache.js', () => ({ clearOfflineCaches: vi.fn(async () => {}) }));
vi.mock('../import-run.js', () => ({ claimImportFor: vi.fn() }));
vi.mock('../session-memory.js', () => ({ forgetSession: vi.fn() }));
vi.mock('../app-bridge.js', () => ({ isHosted: () => false, postToApp: () => false }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(async () => {}) }));
import { settleWrites } from '../store/library.js';
import { signOut } from '../auth-client.js';
import { clearOfflineCaches } from '../offline-cache.js';

/**
 * Sign out with changes the server has not taken: asked, with the count, and the wipe
 * waits for the answer. With nothing waiting, no question.
 */
function Host() {
  const signOutAndLeave = useSignOut();
  return (
    <>
      <button onClick={signOutAndLeave}>Sign out</button>
      <SignOutConfirm />
    </>
  );
}

const flush = () => act(async () => {});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('signing out with unsynced changes', () => {
  it('asks with the count, and Cancel signs nobody out', async () => {
    vi.mocked(settleWrites).mockResolvedValue(2);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(screen.getByText("2 changes haven't synced yet. Sign out anyway?")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(screen.queryByText(/synced yet/)).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(clearOfflineCaches).not.toHaveBeenCalled();
  });

  it('leaving anyway signs out and wipes', async () => {
    vi.mocked(settleWrites).mockResolvedValue(1);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(screen.getByText("1 change hasn't synced yet. Sign out anyway?")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    await flush();
    expect(signOut).toHaveBeenCalled();
    expect(clearOfflineCaches).toHaveBeenCalled();
  });

  it('asks nothing when the outbox drained', async () => {
    vi.mocked(settleWrites).mockResolvedValue(0);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(screen.queryByText(/synced yet/)).toBeNull();
    expect(signOut).toHaveBeenCalled();
  });
});
