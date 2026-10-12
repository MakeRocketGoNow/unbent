import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SignOutConfirm } from './SignOutConfirm.js';
import { useSignOut } from '../useSignOut.js';

vi.mock('../store/library.js', () => ({ settleWrites: vi.fn(), subscribeWrites: vi.fn(() => () => {}) }));
vi.mock('../auth-client.js', () => ({ signOut: vi.fn(async () => ({})), refreshSession: vi.fn(async () => null) }));
vi.mock('../offline-cache.js', () => ({ clearOfflineCaches: vi.fn(async () => {}) }));
vi.mock('../import-run.js', () => ({ claimImportFor: vi.fn() }));
vi.mock('../session-memory.js', () => ({ forgetSession: vi.fn() }));
vi.mock('../app-bridge.js', () => ({ isHosted: () => false, postToApp: () => false }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(async () => {}) }));
import { settleWrites, subscribeWrites } from '../store/library.js';
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

  it('puts focus on Cancel, the safe choice', async () => {
    vi.mocked(settleWrites).mockResolvedValue(2);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('comes down and goes on signing out once the outbox drains, and shows the count as it falls', async () => {
    vi.mocked(settleWrites).mockResolvedValue(3);
    let heard: (pending: number) => void = () => {};
    vi.mocked(subscribeWrites).mockImplementation((l) => {
      heard = l;
      return () => {};
    });
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(screen.getByText(/3 changes haven't synced yet/)).toBeTruthy();
    await act(async () => heard(1));
    expect(screen.getByText(/1 change hasn't synced yet/)).toBeTruthy();
    await act(async () => heard(0));
    expect(screen.queryByText(/synced yet/)).toBeNull();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a second press answers the first question with stay, and asks again', async () => {
    vi.mocked(settleWrites).mockResolvedValue(2);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(screen.getAllByText(/synced yet/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when the outbox drained', async () => {
    vi.mocked(settleWrites).mockResolvedValue(0);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(screen.queryByText(/synced yet/)).toBeNull();
    expect(signOut).toHaveBeenCalled();
  });

  it('asks without a count when the outbox could not be read, rather than signing out', async () => {
    vi.mocked(settleWrites).mockResolvedValue(null);
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(screen.getByText("This device may still have changes that haven't synced. Sign out anyway?")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(signOut).not.toHaveBeenCalled();
    expect(clearOfflineCaches).not.toHaveBeenCalled();
  });
});
