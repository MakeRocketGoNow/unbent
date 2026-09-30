import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ImportProgress } from '@unbent/enex';
import type { ImportRunState } from '../import-run.js';
import { emptySkipLog } from './import-skips.js';
import { ImportSnackbar } from './ImportSnackbar.js';

let state: ImportRunState;
vi.mock('../import-run.js', () => ({ useImportRun: () => state }));

const progress = (p: Partial<ImportProgress>): ImportProgress => ({
  processed: 0,
  created: 0,
  skipped: 0,
  failed: 0,
  filesUploaded: 0,
  filesIndexed: 0,
  bytesRead: 0,
  notesTotal: 0,
  currentTitle: '',
  ...p,
});

function run(patch: Partial<ImportRunState>): ImportRunState {
  return {
    status: 'running',
    file: new File(['x'], 'Notes.enex'),
    zip: null,
    progress: progress({}),
    failures: [],
    skips: emptySkipLog,
    error: null,
    startedAt: 0,
    endedAt: null,
    run: 1,
    ...patch,
  };
}

async function mount(path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <ImportSnackbar />
      </>
    ),
  });
  const page = (p: string) =>
    createRoute({ getParentRoute: () => rootRoute, path: p, component: () => <p>{p}</p> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page('/notes'), page('/settings/import')]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByText(path);
}

afterEach(cleanup);

describe('ImportSnackbar', () => {
  it('says a run is going, with a link to the import page', async () => {
    state = run({});
    await mount('/notes');
    expect(screen.getByRole('status').textContent).toContain('Importing Notes.enex…');
    expect(screen.getByRole('link', { name: 'View' }).getAttribute('href')).toBe('/settings/import');
  });

  /* An ENEX's percentage is bytes read, which runs ahead of the notes; an archive's is notes. */
  it('gives a percentage only when the run knows how many notes there are', async () => {
    state = run({ progress: progress({ processed: 47, notesTotal: 100 }) });
    await mount('/notes');
    expect(screen.getByRole('status').textContent).toContain('· 45%');
  });

  it('is not shown on the import page, which says all of it already', async () => {
    state = run({});
    await mount('/settings/import');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a finished run with failures until it is dismissed', async () => {
    state = run({ status: 'done', progress: progress({ created: 12, failed: 2 }), endedAt: 1 });
    await mount('/notes');
    const card = screen.getByRole('status');
    expect(card.textContent).toContain('Imported 12 notes; 2 failed.');
    expect(card.className).toContain('error');
  });

  it('shows nothing when there is no run', async () => {
    state = run({ status: 'idle' });
    await mount('/notes');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
