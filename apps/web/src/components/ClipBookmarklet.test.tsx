import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../notes-api.js';
import { bookmarkletFor } from '../bookmarklet.js';
import { ClipBookmarklet } from './ClipBookmarklet.js';

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

afterEach(cleanup);

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
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(anchor, click);
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/Drag it to your bookmarks bar/);
  });

  it('is not drawn where the instance does not clip', async () => {
    const { container } = mount(false);
    await vi.waitFor(() => expect(api.getConfig).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});
