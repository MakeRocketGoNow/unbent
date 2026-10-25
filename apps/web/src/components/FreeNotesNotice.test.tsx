import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';

vi.mock('../app-bridge.js', () => ({ isHosted: vi.fn(() => false) }));
import { isHosted } from '../app-bridge.js';
import { showFreeNotesFull } from '../free-notes.js';

const { FreeNotesNotice } = await import('./FreeNotesNotice.js');

/**
 * The free plan's full notice: nothing until a refused press asks for it, then the count
 * and the ways out, with the plan a link on the web and a sentence inside the apps,
 * where the Plan page draws no buttons (as `PlanBanner` says it).
 */
function mount() {
  const rootRoute = createRootRoute({ component: () => <FreeNotesNotice /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/notes'] }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />);
}

afterEach(() => {
  cleanup();
  vi.mocked(isHosted).mockReturnValue(false);
});

describe('FreeNotesNotice', () => {
  it('says the free plan is full when asked, with a link to the plan', async () => {
    mount();
    await act(async () => {});
    expect(screen.queryByText(/The free plan holds/)).toBeNull();
    act(() => showFreeNotesFull());
    expect(await screen.findByText('The free plan holds 100 notes, counting the trash. Delete some and empty the trash, or subscribe for unlimited notes.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Plan' })).toBeTruthy();
  });

  it('points at the web inside the apps, rather than at a page with no buttons', async () => {
    vi.mocked(isHosted).mockReturnValue(true);
    mount();
    await act(async () => {});
    act(() => showFreeNotesFull());
    expect(await screen.findByText(/or subscribe on the web for unlimited notes\./)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
