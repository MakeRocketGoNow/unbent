import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../notes-api.js';
import { bookmarkletFor } from '../bookmarklet.js';
import { ClipBookmarklet } from './ClipBookmarklet.js';

let touch = false;
vi.mock('../useMediaQuery.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../useMediaQuery.js')>()), useMediaQuery: () => touch }));
vi.mock('../notes-api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../notes-api.js')>()), getConfig: vi.fn() }));

/** The install link: for this instance, only where it clips, and inert when pressed here. */
function mount(webClip: boolean) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [], ...(webClip ? { webClip } : {}) } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ClipBookmarklet />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  touch = false;
  delete window.UnbentApp;
});

/** Whether `mount` drew nothing, once the config has answered. */
async function drawsNothing(view: ReturnType<typeof mount>) {
  await vi.waitFor(() => expect(api.getConfig).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  return view.container.textContent === '';
}

describe('the bookmarklet install link', () => {
  it('is a draggable link to this instance', async () => {
    mount(true);
    const link = await screen.findByText('Clip to Unbent');
    const anchor = link.closest('a')!;
    expect(anchor.getAttribute('href')).toBe(bookmarkletFor(window.location.origin));
    expect(anchor.getAttribute('draggable')).toBe('true');
  });

  /* Pressed on this page it would clip Unbent's own settings. */
  it('says what to do with it rather than running here', async () => {
    mount(true);
    const anchor = (await screen.findByText('Clip to Unbent')).closest('a')!;
    expect(screen.getByRole('status').textContent).toBe('');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(anchor, click);
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/Drag it to your bookmarks bar/);
  });

  it('is not drawn where the instance does not clip', async () => {
    expect(await drawsNothing(mount(false))).toBe(true);
  });

  /* No bookmarks bar to drag it to; the share sheet clips there. */
  it('is not drawn inside the apps or on a touch device', async () => {
    window.UnbentApp = { postMessage: vi.fn() };
    expect(await drawsNothing(mount(true))).toBe(true);
    cleanup();
    delete window.UnbentApp;
    touch = true;
    expect(await drawsNothing(mount(true))).toBe(true);
  });
});
