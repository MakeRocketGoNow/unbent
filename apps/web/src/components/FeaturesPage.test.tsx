import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

    // Every clip is a muted loop with a poster, both encodings, and a description. The
    // video is mounted once the row is near, which under jsdom (no observer) is at once.
    await waitFor(() => expect(container.querySelectorAll('video')).toHaveLength(4));
    const clips = [...container.querySelectorAll<HTMLVideoElement>('video')];
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
    await waitFor(() => expect(container.querySelectorAll('video')).toHaveLength(4));
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
      expect(poster.getAttribute('src')).toMatch(/-light-poster\.webp$/);
      expect(poster.closest('picture')?.querySelector('source')?.getAttribute('srcset')).toMatch(/-dark-poster\.webp$/);
      expect(poster.getAttribute('alt')).toBeTruthy();
    }
  });

  /** A loop beside text must be pausable (WCAG 2.2.2), and stay paused when scrolled back into view. */
  it('pauses a clip on a press and plays it on the next', async () => {
    const { findByRole, container } = harness(null);
    await findByRole('heading', { name: 'What Unbent does' });
    await waitFor(() => expect(container.querySelectorAll('video')).toHaveLength(4));
    const clip = container.querySelector('video')!;
    const pause = vi.spyOn(clip, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(clip, 'play').mockImplementation(() => Promise.resolve());
    expect(clip.getAttribute('data-tip')).toBe('Pause');
    expect(clip.tabIndex).toBe(0);
    fireEvent.click(clip);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(clip.getAttribute('data-tip')).toBe('Play');
    expect(clip.getAttribute('aria-description')).toMatch(/^Paused/);
    fireEvent.keyDown(clip, { key: ' ' });
    expect(play).toHaveBeenCalledTimes(1);
    expect(clip.getAttribute('data-tip')).toBe('Pause');
  });

  /**
   * The page promises pictures of the app as it is; a scene renamed in the script, or a
   * name mistyped here, would ship a broken picture with every other test green. Every
   * address the page names, in either theme and with motion or without, must be a file
   * under `public/`, and every file under `public/features/` must be named by the page,
   * or it is weight in the repository for nothing.
   */
  it('names only media files that exist, and every one that is committed', async () => {
    const named = new Set<string>();
    const collect = (root: HTMLElement) => {
      for (const el of root.querySelectorAll('img[src], source[src], source[srcset], video[poster]')) {
        for (const attr of ['src', 'srcset', 'poster']) {
          const value = el.getAttribute(attr);
          if (value?.startsWith('/features/')) named.add(value);
        }
      }
    };
    for (const prefs of [{}, { '(prefers-color-scheme: dark)': true }, { '(prefers-reduced-motion: reduce)': true }]) {
      media = prefs;
      const { findByRole, container } = harness(null);
      await findByRole('heading', { name: 'What Unbent does' });
      await waitFor(() => expect(container.querySelectorAll('video, .feature-clip img').length).toBeGreaterThanOrEqual(4));
      collect(container);
      cleanup();
    }
    const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public');
    for (const file of named) expect(existsSync(resolve(publicDir, `.${file}`)), file).toBe(true);
    const committed = readdirSync(resolve(publicDir, 'features')).map((f) => `/features/${f}`);
    expect(committed.filter((f) => !named.has(f))).toEqual([]);
  });

  /** The nav is on every public page, and `aria-current` is what says where the reader is. */
  it('carries the public pages’ nav, with this page marked as the current one', async () => {
    const { findByRole, container } = harness(null);
    await findByRole('heading', { name: 'What Unbent does' });
    const links = [...container.querySelectorAll<HTMLAnchorElement>('nav.front-nav a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Features', '/features'],
      ['Pricing', '/pricing'],
      ['Why', '/why'],
    ]);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['page', null, null]);
    // The brand is the way home from here, and text only on the front page itself.
    expect(container.querySelector('a.front-brand')?.getAttribute('href')).toBe('/');
  });

  it('gives someone signed in their notes as the way out, and no trial', async () => {
    const { findByRole, getByText, queryByText } = harness({ user: { id: 'u1' } });
    await findByRole('heading', { name: 'What Unbent does' });
    expect(getByText('Open your notes').getAttribute('href')).toBe('/notes');
    expect(queryByText('Start your free trial')).toBeNull();
  });
});
