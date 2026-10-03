import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { AppConfig } from '@unbent/shared';
import type { BuildInfo } from '../build-info.js';
import { About } from './About.js';

const SHA = '3d544d9e0b7f4a1c2d3e4f5a6b7c8d9e0f1a2b3c';
const ci: BuildInfo = {
  commit: SHA,
  date: '2026-10-03T14:20:00Z',
  url: `https://github.com/example/unbent/commit/${SHA}`,
  repo: 'https://github.com/example/unbent',
  dirty: false,
};

/** Under a router, since the built-in legal documents are routes. */
async function harness(config: Partial<AppConfig>, build: BuildInfo | null, host = 'notes.example.com') {
  const rootRoute = createRootRoute({
    component: () => <About config={config as AppConfig} host={host} build={build} />,
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <RouterProvider router={router as any} />,
  );
  await screen.findByText('About');
}

describe('About', () => {
  afterEach(cleanup);

  it('links the short commit to GitHub, with the whole SHA on hover and the date under it', async () => {
    await harness({}, ci);
    const link = screen.getByText('3d544d9');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(ci.url);
    expect(link.getAttribute('title')).toBe(SHA);
    expect(screen.getByText(/^Committed /).textContent).toContain('2026');
  });

  it('shows a local build as text, and says when it carried uncommitted changes', async () => {
    await harness({}, { ...ci, url: null, repo: null, dirty: true, date: null });
    expect(screen.getByText('3d544d9').tagName).toBe('SPAN');
    expect(screen.getByText('Built with uncommitted changes')).toBeTruthy();
    // No repository to point at outside CI.
    expect(screen.queryByText('Source code')).toBeNull();
  });

  it('says so rather than leaving a gap when the build recorded nothing', async () => {
    await harness({}, null);
    expect(screen.getByText('Not recorded in this build')).toBeTruthy();
  });

  it('names production by its address alone', async () => {
    await harness({}, ci, 'notes.example.com');
    expect(screen.getByText('notes.example.com')).toBeTruthy();
    expect(screen.queryByText(/^PR /)).toBeNull();
  });

  it('on a preview, says which one and whose notes it reads', async () => {
    await harness({ instanceLabel: 'PR 9', previewRelay: { origin: 'https://dev.example.com' } } as Partial<AppConfig>, ci);
    expect(screen.getByText("PR 9 · notes are dev.example.com's")).toBeTruthy();
  });

  it('links to the source, and to the legal documents only where the instance has them', async () => {
    await harness({ legal: { privacy: '/privacy', terms: 'https://example.com/terms' } }, ci);
    expect(screen.getByText('github.com/example/unbent').getAttribute('href')).toBe(ci.repo);
    expect(screen.getByText('Privacy').getAttribute('href')).toBe('/privacy');
    expect(screen.getByText('Terms').getAttribute('href')).toBe('https://example.com/terms');
    cleanup();
    await harness({}, ci);
    expect(screen.queryByText('Legal')).toBeNull();
  });
});
