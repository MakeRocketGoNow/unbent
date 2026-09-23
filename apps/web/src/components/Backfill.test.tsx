import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { IndexingState } from '../index-files.js';
import { Backfill } from './Backfill.js';

/**
 * The store is stood in for rather than driven: the real one spawns a Worker on start,
 * which jsdom does not have, and what this row makes of each state is the thing under test.
 */
const store = vi.hoisted(() => ({
  state: {} as IndexingState,
  startIndexing: vi.fn(),
  stopIndexing: vi.fn(),
}));

vi.mock('../index-files.js', () => ({
  useIndexing: () => store.state,
  startIndexing: store.startIndexing,
  stopIndexing: store.stopIndexing,
}));

const idle: IndexingState = {
  status: 'idle',
  phase: 'pdfs',
  progress: null,
  images: null,
  remaining: 0,
  stopping: false,
  error: null,
};

const partway = { done: 3, indexed: 2, unusable: 1, failed: 0, total: 120 };

beforeEach(() => {
  store.state = idle;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('Backfill', () => {
  it('starts the pass the instance can run', () => {
    render(<Backfill vision={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Index existing PDFs' }));
    expect(store.startIndexing).toHaveBeenCalledWith({ auto: false, images: false });
    expect(screen.getByText(/before PDF search existed/)).toBeTruthy();
  });

  it("offers Stop in the button's place while a pass runs, and says when it was pressed", () => {
    store.state = { ...idle, status: 'running', progress: partway };
    const { rerender } = render(<Backfill vision={false} />);
    expect(screen.queryByRole('button', { name: /Index/ })).toBeNull();
    expect(screen.getByText('Indexing PDFs… 3 / 120')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(store.stopIndexing).toHaveBeenCalledTimes(1);

    // The file in flight is left to finish, so the press has to be seen to have landed.
    store.state = { ...store.state, stopping: true };
    rerender(<Backfill vision={false} />);
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Stopping after the current file… 3 / 120')).toBeTruthy();
  });

  it('reports a stopped pass with what it got through and what it left', () => {
    store.state = {
      ...idle,
      status: 'stopped',
      progress: { done: 40, indexed: 30, unusable: 8, failed: 2, total: 120 },
    };
    render(<Backfill vision={false} />);
    expect(screen.getByText('Stopped. Indexed 30 of 40 PDFs; 80 left.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Index existing PDFs' })).toBeTruthy();
    cleanup();

    store.state = { ...idle, status: 'stopped', phase: 'images', images: { read: 12, remaining: 1356 } };
    render(<Backfill vision />);
    expect(screen.getByText('Stopped. Read 12 images, 1,356 left.')).toBeTruthy();
  });
});
