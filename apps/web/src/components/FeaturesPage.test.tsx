import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { keys } from '../queries.js';

const useSession = vi.fn();
vi.mock('../auth-client.js', () => ({ useSession: () => useSession() }));

/** jsdom has no `matchMedia`; the page reads the theme and the motion preference through it. */
let media: Record<string, boolean> = {};
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: media[query] ?? false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const { FeaturesPage, FEATURES_META } = await import('./FeaturesPage.js');

/** The config seeded as `WhyPage.test` seeds it: the footer reads it and jsdom has no server. */
function harness(session: { user: { id: string } } | null) {
  useSession.mockReturnValue({ data: session, isPending: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.config(), {
    providers: [],
    frontPage: true,
    legal: { privacy: '/privacy', terms: '/terms' },
    operator: { name: 'Example Co', email: 'help@example.com', host: 'notes.example.com' },
  });
  const rootRoute = createRootRoute({ component: FeaturesPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/features'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

describe('FeaturesPage', () => {
  afterEach(() => {
    cleanup();
    useSession.mockReset();
    media = {};
  });

  it('shows every feature as a picture or a clip in the reader’s theme, with the trial as the one filled control', async () => {
    const { findByRole, getByText, container } = harness(null);
    expect(await findByRole('heading', { name: 'What Unbent does' })).toBeTruthy();
    expect(document.title).toBe(FEATURES_META.title);
    expect(getByText('Start your free trial').getAttribute('href')).toBe('/login');
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);

    // Every still offers its dark copy to a dark reader and its light one otherwise.
    const stills = [...container.querySelectorAll<HTMLPictureElement>('picture.feature-shot')];
    expect(stills).toHaveLength(13);
    for (const still of stills) {
      const source = still.querySelector('source');
      const img = still.querySelector('img');
      expect(source?.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
      expect(source?.getAttribute('srcset')).toMatch(/^\/features\/[a-z-]+-dark\.webp$/);
      expect(img?.getAttribute('src')).toMatch(/^\/features\/[a-z-]+-light\.webp$/);
      expect(img?.getAttribute('alt')).toBeTruthy();
      expect(img?.getAttribute('loading')).toBe('lazy');
    }

    // Every clip is a muted loop with a poster, both encodings, and a description.
    const clips = [...container.querySelectorAll<HTMLVideoElement>('video')];
    expect(clips).toHaveLength(4);
    for (const clip of clips) {
      expect(clip.muted).toBe(true);
      expect(clip.loop).toBe(true);
      expect(clip.getAttribute('poster')).toMatch(/^\/features\/[a-z-]+-light-poster\.webp$/);
      expect(clip.getAttribute('aria-label')).toBeTruthy();
      expect([...clip.querySelectorAll('source')].map((s) => s.getAttribute('type'))).toEqual(['video/webm', 'video/mp4']);
    }
  });

  it('plays the dark clips for a dark reader', async () => {
    media = { '(prefers-color-scheme: dark)': true };
    const { findByRole, container } = harness(null);
    await findByRole('heading', { name: 'What Unbent does' });
    for (const clip of container.querySelectorAll('video')) {
      expect(clip.getAttribute('poster')).toMatch(/-dark-poster\.webp$/);
      expect(clip.querySelector('source')?.getAttribute('src')).toMatch(/-dark\.webm$/);
    }
  });

  /** Less motion asked for is no motion: the first frame stands in for each clip. */
  it('shows a picture in place of each clip when the reader prefers reduced motion', async () => {
    media = { '(prefers-reduced-motion: reduce)': true };
    const { findByRole, container } = harness(null);
    await findByRole('heading', { name: 'What Unbent does' });
    expect(container.querySelectorAll('video')).toHaveLength(0);
    const posters = [...container.querySelectorAll<HTMLImageElement>('.feature-clip img')];
    expect(posters).toHaveLength(4);
    for (const poster of posters) {
      expect(poster.getAttribute('src')).toMatch(/-poster\.webp$/);
      expect(poster.getAttribute('alt')).toBeTruthy();
    }
  });

  it('gives someone signed in their notes as the way out, and no trial', async () => {
    const { findByRole, getByText, queryByText } = harness({ user: { id: 'u1' } });
    await findByRole('heading', { name: 'What Unbent does' });
    expect(getByText('Open your notes').getAttribute('href')).toBe('/notes');
    expect(queryByText('Start your free trial')).toBeNull();
  });
});
