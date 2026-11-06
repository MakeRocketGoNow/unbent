import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MAX_CLIP_HTML_CHARS } from '@unbent/shared';
import * as api from '../notes-api.js';
import * as actions from '../store/actions.js';
import { PAGE, READY } from '../bookmarklet.js';
import { ClipPage, PAGE_WAIT_MS } from './ClipPage.js';

/**
 * The bookmarklet's window: what it takes from the tab that opened it and from nobody
 * else, that nothing is filed until Save, and what it says when the tab never answers,
 * the page is too large, or nobody is signed in.
 */

let session: { user: { id: string } } | null = { user: { id: 'u1' } };
vi.mock('../useAppSession.js', () => ({ useAppSession: () => ({ session, isPending: false, unreachable: false }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search, className }: { children: React.ReactNode; to: string; search?: { redirect?: string }; className?: string }) => (
    <a href={search?.redirect ? `${to}?redirect=${search.redirect}` : to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('../notes-api.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../notes-api.js')>()), getConfig: vi.fn() }));
vi.mock('../store/actions.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../store/actions.js')>()), clipLink: vi.fn() }));

const ADDRESS = 'https://www.example.com/an-article';
let opener: Window;
let frame: HTMLIFrameElement;

function setOpener(value: Window | null) {
  Object.defineProperty(window, 'opener', { value, configurable: true, writable: true });
}

function mount({ url = ADDRESS as string | null, webClip = true } = {}) {
  vi.mocked(api.getConfig).mockResolvedValue({ providers: [], webClip } as unknown as Awaited<ReturnType<typeof api.getConfig>>);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ClipPage url={url ?? undefined} />
    </QueryClientProvider>,
  );
}

/** The page arriving from `source`, as the bookmarklet posts it. */
function post(source: Window, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source, origin: 'https://www.example.com' }));
  });
}

const page = (over: Record<string, unknown> = {}) => ({ type: PAGE, url: ADDRESS, title: 'An article', html: '<p>The article</p>', ...over });

beforeEach(() => {
  session = { user: { id: 'u1' } };
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  opener = frame.contentWindow!;
  vi.spyOn(opener, 'postMessage');
  setOpener(opener);
  vi.mocked(actions.clipLink).mockReset();
});

afterEach(() => {
  cleanup();
  frame.remove();
  setOpener(null);
  vi.useRealTimers();
});

describe('the clip window', () => {
  it('asks the tab that opened it for the page, and files it only on Save', async () => {
    vi.mocked(actions.clipLink).mockResolvedValue({ id: 'n1', title: 'An article' } as api.ClippedNote);
    mount();
    await waitFor(() => expect(opener.postMessage).toHaveBeenCalledWith({ type: READY }, '*'));
    expect(screen.getByRole('status').textContent).toBe('Reading the page…');

    post(opener, page());
    expect(screen.getByText('An article')).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(actions.clipLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Saved' });
    expect(actions.clipLink).toHaveBeenCalledWith({ id: expect.any(String), url: ADDRESS, html: '<p>The article</p>' });
    expect(screen.getByRole('link', { name: 'Open note' }).getAttribute('href')).toBe('/notes/$noteId');
  });

  /* Any site can post to a window; only the opener is the page the person pressed it on. */
  it('takes the page from nobody but the window that opened it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await screen.findByRole('status');
    post(window, page({ title: 'Not this one' }));
    expect(screen.queryByText('Not this one')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(PAGE_WAIT_MS));
    expect(screen.queryByText('Not this one')).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/fetch it from example\.com instead/);
  });

  /* A site's Cross-Origin-Opener-Policy cuts the opener: the server fetches the address. */
  it('clips by the address, and says so, when the tab never answers', async () => {
    setOpener(null);
    vi.mocked(actions.clipLink).mockResolvedValue({ id: 'n1', title: 'An article' } as api.ClippedNote);
    mount();
    expect((await screen.findByRole('note')).textContent).toMatch(/didn't answer from its tab/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Saved' });
    expect(actions.clipLink).toHaveBeenCalledWith({ id: expect.any(String), url: ADDRESS });
  });

  it('says a page is too large to send from its tab, and offers its address instead', async () => {
    vi.mocked(actions.clipLink).mockResolvedValue({ id: 'n1', title: 'x' } as api.ClippedNote);
    mount();
    await screen.findByRole('status');
    post(opener, page({ html: 'x'.repeat(MAX_CLIP_HTML_CHARS + 1) }));
    expect(screen.getByRole('note').textContent).toMatch(/too large to send from its tab \(10 MB; the most is 10 MB\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Saved' });
    expect(vi.mocked(actions.clipLink).mock.calls[0]![0]).not.toHaveProperty('html');
  });

  it('says why a clip was refused, with the page a click away, and tries again under the same id', async () => {
    vi.mocked(actions.clipLink).mockRejectedValue(new api.ApiError(502, '502: The site refused to serve the page.', 'HOST_REFUSED'));
    mount();
    await screen.findByRole('status');
    post(opener, page());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The site refused to serve the page.');
    expect(screen.getByRole('link', { name: 'Open the page' }).getAttribute('href')).toBe(ADDRESS);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(actions.clipLink).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(actions.clipLink).mock.calls.map(([input]) => input.id);
    expect(second).toBe(first);
  });

  /* The page is in a message to this window: it cannot wait across a sign-in. */
  it('asks someone signed out to sign in and press the bookmark again, and asks the tab for nothing', async () => {
    session = null;
    mount();
    expect(await screen.findByText('Sign in to clip this page.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?redirect=/clip');
    expect(opener.postMessage).not.toHaveBeenCalled();
  });

  it('says there is nothing to clip when opened without a page', async () => {
    setOpener(null);
    mount({ url: null });
    expect(await screen.findByText('Nothing to clip here.')).toBeTruthy();
  });

  it('says when the instance does not clip', async () => {
    mount({ webClip: false });
    expect(await screen.findByText("This Unbent doesn't clip web pages.")).toBeTruthy();
    expect(opener.postMessage).not.toHaveBeenCalled();
  });
});
