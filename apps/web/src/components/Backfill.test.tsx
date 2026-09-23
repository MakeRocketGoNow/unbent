import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../notes-api.js';
import type { IndexingState } from '../index-files.js';
import { Backfill } from './Backfill.js';

/**
 * The store is stood in for rather than driven: the real one spawns a Worker on start,
 * which jsdom does not have, and what these rows make of each state is the thing under test.
 */
const store = vi.hoisted(() => ({
  state: {} as IndexingState,
  startIndexing: vi.fn(),
  readImages: vi.fn(),
  stopIndexing: vi.fn(),
}));

vi.mock('../index-files.js', () => ({
  useIndexing: () => store.state,
  startIndexing: store.startIndexing,
  readImages: store.readImages,
  stopIndexing: store.stopIndexing,
}));

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  pendingImages: vi.fn(async () => 12),
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

function mount(vision: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // A fresh element each time: React skips a subtree handed the very same element again,
  // and the store stand-in changes underneath without a prop changing.
  const ui = () => (
    <QueryClientProvider client={client}>
      <Backfill vision={vision} />
    </QueryClientProvider>
  );
  const result = render(ui());
  return { ...result, rerender: () => result.rerender(ui()) };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  store.state = idle;
  vi.clearAllMocks();
  vi.mocked(api.pendingImages).mockResolvedValue(12);
});
afterEach(cleanup);

describe('Backfill', () => {
  it('offers the PDF pass alone without a vision model, and never asks for a count', () => {
    mount(false);
    fireEvent.click(button('Index existing PDFs'));
    expect(store.startIndexing).toHaveBeenCalledWith({ auto: false });
    expect(screen.queryByRole('button', { name: /Read/ })).toBeNull();
    expect(api.pendingImages).not.toHaveBeenCalled();
  });

  it('names the count of images on a button of its own, which reads them and nothing else', async () => {
    mount(true);
    await waitFor(() => expect(button('Read 12 images')).toBeTruthy());
    expect(screen.getByText(/one paid request; stop at any time/)).toBeTruthy();

    fireEvent.click(button('Read 12 images'));
    expect(store.readImages).toHaveBeenCalledTimes(1);
    expect(store.startIndexing).not.toHaveBeenCalled();
  });

  it('leaves the image row out when nothing waits for the model', async () => {
    vi.mocked(api.pendingImages).mockResolvedValue(0);
    mount(true);
    await waitFor(() => expect(api.pendingImages).toHaveBeenCalled());
    expect(button('Index existing PDFs')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Read/ })).toBeNull();
  });

  it("puts Stop in the running row's slot and holds the other row's button", async () => {
    store.state = { ...idle, status: 'running', phase: 'images', images: { read: 3, remaining: 9 } };
    const { rerender } = mount(true);
    expect(screen.getByText('Reading images… 3 read, 9 left')).toBeTruthy();
    expect(button('Index existing PDFs').disabled).toBe(true);
    // The PDF row says nothing about a pass that is not its own.
    expect(screen.getByText(/Read here, in the browser/)).toBeTruthy();

    fireEvent.click(button('Stop'));
    expect(store.stopIndexing).toHaveBeenCalledTimes(1);

    // The request in flight is left to land, so the press has to be seen to have registered.
    store.state = { ...store.state, stopping: true };
    rerender();
    expect(button('Stop').disabled).toBe(true);
    expect(screen.getByText('Stopping after the current request… 3 read, 9 left')).toBeTruthy();

    // The other way round: a PDF pass puts Stop on its own row and holds the image button.
    store.state = { ...idle, status: 'running', progress: partway };
    rerender();
    await waitFor(() => expect(button('Read 12 images').disabled).toBe(true));
    expect(screen.getByText('Indexing PDFs… 3 / 120')).toBeTruthy();
    expect(button('Stop')).toBeTruthy();
  });

  it('takes the count from the pass that just ended rather than the number from before it', async () => {
    // The server's answer to the second ask never lands, so only the pass's own can show 6.
    vi.mocked(api.pendingImages)
      .mockResolvedValueOnce(12)
      .mockImplementation(() => new Promise(() => {}));
    store.state = { ...idle, status: 'running', phase: 'images', images: { read: 6, remaining: 6 } };
    const { rerender } = mount(true);
    await waitFor(() => expect(api.pendingImages).toHaveBeenCalledTimes(1));

    store.state = { ...store.state, status: 'stopped' };
    rerender();
    await waitFor(() => expect(button('Read 6 images')).toBeTruthy());
    expect(screen.getByText('Stopped. Read 6 images, 6 left.')).toBeTruthy();
    // And the server is asked again all the same, for when it knows more than the pass did.
    await waitFor(() => expect(api.pendingImages).toHaveBeenCalledTimes(2));
  });

  it('asks for the count again after a PDF pass only when that pass could have changed it', async () => {
    store.state = { ...idle, status: 'running', progress: partway };
    const { rerender } = mount(true);
    await waitFor(() => expect(api.pendingImages).toHaveBeenCalledTimes(1));

    // Every scan had a text layer: nothing new for the model, so no second ask.
    store.state = { ...idle, status: 'done', progress: { ...partway, unusable: 0 } };
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.pendingImages).toHaveBeenCalledTimes(1);

    // One turned out empty, which is the model's next: ask.
    store.state = { ...idle, status: 'running', progress: partway };
    rerender();
    store.state = { ...idle, status: 'done', progress: { ...partway, unusable: 1 } };
    rerender();
    await waitFor(() => expect(api.pendingImages).toHaveBeenCalledTimes(2));
  });

  it('keeps the image row for its news once nothing is left, with nothing to press', async () => {
    vi.mocked(api.pendingImages).mockResolvedValue(0);
    store.state = { ...idle, status: 'done', phase: 'images', images: { read: 12, remaining: 0 } };
    mount(true);
    await waitFor(() => expect(api.pendingImages).toHaveBeenCalled());
    expect(screen.getByText('Done. Read 12 images.')).toBeTruthy();
    expect(button('Read images').disabled).toBe(true);
  });

  it('reports a stopped PDF pass with what it got through and what it left', () => {
    store.state = {
      ...idle,
      status: 'stopped',
      progress: { done: 40, indexed: 30, unusable: 8, failed: 2, total: 120 },
    };
    mount(false);
    expect(screen.getByText('Stopped. Indexed 30 of 40 PDFs; 80 left.')).toBeTruthy();
    expect(button('Index existing PDFs').disabled).toBe(false);
  });
});
