import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import type { NotebookSummary } from '@unbent/shared';
import * as api from '../notes-api.js';
import { useKeeper } from '../store/use-outbox.js';
import type { KeepStatus } from '../store/keep.js';
import { Settings } from './Settings.js';

vi.mock('../notes-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notes-api.js')>()),
  listNotebooks: vi.fn(),
}));

vi.mock('../store/use-outbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/use-outbox.js')>()),
  useKeeper: vi.fn(() => ({ keeper: null, status: keeping([]) })),
}));

function keeping(ids: string[], counts: Partial<KeepStatus> = {}): KeepStatus {
  return {
    supported: true,
    kept: new Set(ids),
    counted: true,
    wanted: { files: 4, bytes: 400 },
    have: { files: 4, bytes: 400 },
    fetching: false,
    problem: null,
    ...counts,
  };
}

/**
 * When the notebooks page opens its chooser by itself: on an empty list, where making the
 * first notebook is what the page is for, and when the rail's New notebook asked for it.
 */
function mount(notebooks: NotebookSummary[], props: Partial<Parameters<typeof Settings>[0]> = {}) {
  vi.mocked(api.listNotebooks).mockResolvedValue({ notebooks, unfiled: 0 });
  const rootRoute = createRootRoute({ component: () => <Settings onChanged={() => {}} {...props} /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<RouterProvider router={router as any} />);
}

const nb = (name: string): NotebookSummary => ({ id: name, name, count: 0, fields: 0, purpose: null, emoji: null });

describe('Settings, notebooks', () => {
  afterEach(cleanup);

  it('opens the chooser on an empty list, under one line on what a notebook is, with no hint', async () => {
    mount([]);
    expect(await screen.findByRole('button', { name: /^Blank/ })).toBeTruthy();
    expect(screen.getByText('Each note lives in one notebook. Tags can cut across them.')).toBeTruthy();
    expect(screen.queryByText(/Open a notebook to change/)).toBeNull();
    expect(screen.queryByText('No notebooks yet.')).toBeNull();
  });

  it('keeps the chooser shut over a list that has notebooks, and shows the hint', async () => {
    mount([nb('Travel')]);
    expect(await screen.findByText(/Open a notebook to change/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Blank/ })).toBeNull();
  });

  it('opens it when asked, and hands the request back so it can be dropped from the address', async () => {
    const onCreateRequested = vi.fn();
    mount([nb('Travel')], { createRequested: true, onCreateRequested });
    expect(await screen.findByRole('button', { name: /^Blank/ })).toBeTruthy();
    await waitFor(() => expect(onCreateRequested).toHaveBeenCalled());
    // No line about what a notebook is: the list beside the chooser already shows one.
    expect(screen.queryByText(/Each note lives in one notebook/)).toBeNull();
  });

  it('marks only the notebooks kept on this device, and says when their files are still arriving', async () => {
    vi.mocked(useKeeper).mockReturnValue({ keeper: null, status: keeping(['Travel']) });
    mount([nb('Travel'), nb('Recipes')]);
    expect(await screen.findByRole('img', { name: 'Kept on this device' })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: /^Kept/ })).toHaveLength(1);
    cleanup();

    vi.mocked(useKeeper).mockReturnValue({ keeper: null, status: keeping(['Travel'], { have: { files: 1, bytes: 100 } }) });
    mount([nb('Travel'), nb('Recipes')]);
    expect(await screen.findByRole('img', { name: 'Kept on this device; its files are still arriving' })).toBeTruthy();
  });
});
