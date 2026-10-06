import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { IndexingState } from '../index-files.js';
import { Backfill } from './Backfill.js';

/**
 * The store is stood in for rather than driven: the real one spawns a Worker on start,
 * which jsdom does not have, and what the row makes of each state is the thing under test.
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

const idle: IndexingState = { status: 'idle', progress: null, remaining: 0, stopping: false, error: null };

const partway = { done: 3, indexed: 2, unusable: 1, failed: 0, total: 120 };

function mount() {
  // A fresh element each time: React skips a subtree handed the very same element again,
  // and the store stand-in changes underneath without a prop changing.
  const result = render(<Backfill />);
  return { ...result, rerender: () => result.rerender(<Backfill />) };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  store.state = idle;
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('Backfill', () => {
  it('offers the PDF pass and starts it on press, with nothing paid on offer', () => {
    mount();
    expect(screen.getByText(/Read here, in the browser/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Read/ })).toBeNull();

    fireEvent.click(button('Index existing PDFs'));
    expect(store.startIndexing).toHaveBeenCalledWith({ auto: false });
  });

  it("puts Stop in the button's slot while the pass runs, and holds it once pressed", () => {
    store.state = { ...idle, status: 'running', progress: partway };
    const { rerender } = mount();
    expect(screen.getByText('Indexing PDFs… 3 / 120')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Index existing PDFs' })).toBeNull();

    fireEvent.click(button('Stop'));
    expect(store.stopIndexing).toHaveBeenCalledTimes(1);

    // The file in flight is left to finish, so the press has to be seen to have registered.
    store.state = { ...store.state, stopping: true };
    rerender();
    expect(button('Stop').disabled).toBe(true);
    expect(screen.getByText('Stopping after the current file… 3 / 120')).toBeTruthy();
  });

  it('reports a stopped pass with what it got through and what it left', () => {
    store.state = {
      ...idle,
      status: 'stopped',
      progress: { done: 40, indexed: 30, unusable: 8, failed: 2, total: 120 },
    };
    mount();
    expect(screen.getByText('Stopped. Indexed 30 of 40 PDFs; 80 left.')).toBeTruthy();
    expect(button('Index existing PDFs').disabled).toBe(false);
  });

  it('says what the pass the app ran on its own left alone', () => {
    store.state = { ...idle, status: 'deferred', remaining: 4084 };
    mount();
    expect(screen.getByText('4,084 PDFs are not searchable yet.')).toBeTruthy();
  });
});
