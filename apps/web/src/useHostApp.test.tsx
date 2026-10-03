import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
} from '@tanstack/react-router';
import { openAttachmentViewer } from './attachment-viewer.js';
import { back, useHostApp } from './useHostApp.js';

// `HOME` comes from the gate, which imports the auth client; nothing here signs in.
vi.mock('./auth-client.js', () => ({ ensureSession: vi.fn() }));
// The viewer loads the PDF renderer, which jsdom cannot; the one viewer here shows an image.
vi.mock('./pdf/render.js', () => ({ acquirePdf: vi.fn(), releasePdf: vi.fn() }));

/** jsdom has no `showModal`/`close`; tracked by hand, as `Sheet.test.tsx` does. */
function openDialog(): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  }) as unknown as () => void;
  dialog.open = true;
  document.body.appendChild(dialog);
  return dialog;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  delete window.UnbentApp;
  delete window.__unbent;
  vi.unstubAllGlobals();
});

describe('back', () => {
  it('closes the dialog on top before anything else', () => {
    const under = openDialog();
    const top = openDialog();
    const goHome = vi.fn();
    expect(back(false, '/notes/abc', goHome)).toBe(true);
    expect(top.open).toBe(false);
    expect(under.open).toBe(true);
    expect(goHome).not.toHaveBeenCalled();
  });

  it('asks a dialog to close the way Escape does, where it can', () => {
    const dialog = openDialog();
    const requestClose = vi.fn();
    Object.assign(dialog, { requestClose });
    back(true, '/notes', vi.fn());
    expect(requestClose).toHaveBeenCalled();
    expect(dialog.close).not.toHaveBeenCalled();
  });

  it('goes to the list from a note the app was opened on', () => {
    const goHome = vi.fn();
    expect(back(false, '/notes/abc', goHome)).toBe(true);
    expect(goHome).toHaveBeenCalledWith('/notes');
  });

  it('leaves history and the list to the app', () => {
    expect(back(true, '/notes/abc', vi.fn())).toBe(false);
    expect(back(false, '/notes', vi.fn())).toBe(false);
  });
});

/** The hook under a real router, on two routes standing in for the list and a note. */
function harness(initial: string, history: RouterHistory = createMemoryHistory({ initialEntries: [initial] })) {
  const rootRoute = createRootRoute({
    component: () => {
      useHostApp();
      return <Outlet />;
    },
  });
  const tree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/notes', component: () => <p>note list</p> }),
    createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId', component: () => <p>one note</p> }),
  ]);
  const router = createRouter({ routeTree: tree, history });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<RouterProvider router={router as any} />);
  return router;
}

function stubScheme() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('useHostApp', () => {
  it('does nothing in a browser', async () => {
    harness('/notes');
    await screen.findByText('note list');
    expect(window.__unbent).toBeUndefined();
  });

  it('tells the app the colour around the page', async () => {
    stubScheme();
    document.documentElement.style.setProperty('--bg', '#fbfaf8');
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    harness('/notes');
    await screen.findByText('note list');
    expect(postMessage).toHaveBeenCalledWith('{"type":"theme","background":"#fbfaf8"}');
    document.documentElement.style.removeProperty('--bg');
  });

  it('opens a note in place when the app asks', async () => {
    stubScheme();
    window.UnbentApp = { postMessage: vi.fn() };
    const router = harness('/notes');
    await screen.findByText('note list');
    await act(async () => {
      expect(window.__unbent?.open?.('/notes/xyz')).toBe(true);
    });
    await screen.findByText('one note');
    expect(router.state.location.pathname).toBe('/notes/xyz');
  });

  it('refuses a path that is not on this site', async () => {
    stubScheme();
    window.UnbentApp = { postMessage: vi.fn() };
    harness('/notes');
    await screen.findByText('note list');
    expect(window.__unbent?.open?.('https://example.com/notes')).toBe(false);
    expect(window.__unbent?.open?.('//example.com/notes')).toBe(false);
  });

  /** The router has no route for these; the caller falls back to loading the address. */
  it('refuses a path the Worker answers rather than the site', async () => {
    stubScheme();
    window.UnbentApp = { postMessage: vi.fn() };
    const router = harness('/notes');
    await screen.findByText('note list');
    expect(window.__unbent?.open?.('/api/attachments/abc')).toBe(false);
    expect(window.__unbent?.open?.('/.well-known/assetlinks.json')).toBe(false);
    expect(window.__unbent?.open?.('/ingest/e')).toBe(false);
    expect(router.state.location.pathname).toBe('/notes');
  });

  it('answers Back from a note opened from outside by going to the list', async () => {
    stubScheme();
    window.UnbentApp = { postMessage: vi.fn() };
    const router = harness('/notes/abc');
    await screen.findByText('one note');
    await act(async () => {
      expect(window.__unbent?.back?.(false)).toBe(true);
    });
    await screen.findByText('note list');
    expect(router.state.location.pathname).toBe('/notes');
  });

  /*
   * iOS's swipe back: the web view walks its history without asking, and the page hears
   * `popstate` afterwards. On the browser's own history rather than the memory one the
   * tests above use, so the move is a real `history.back()` over entries the router
   * pushed, and the event is the one a web view would send.
   */
  describe('when the history moves without asking', () => {
    /**
     * On a note reached from the list, so there is a page behind this one to go back to.
     * The browser's history starts wherever jsdom's window is, so the list is navigated
     * to rather than started on.
     */
    async function onANote() {
      const router = harness('/notes', createBrowserHistory());
      await act(() => router.navigate({ to: '/notes' }));
      await screen.findByText('note list');
      await act(() => router.navigate({ to: '/notes/$noteId', params: { noteId: 'abc' } }));
      await screen.findByText('one note');
    }

    const swipeBack = () =>
      act(async () => {
        const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
        window.history.back();
        await popped;
      });

    it('closes what was open over the page that was left', async () => {
      stubScheme();
      window.UnbentApp = { platform: 'ios', postMessage: vi.fn() };
      await onANote();
      const under = openDialog();
      const top = openDialog();
      await swipeBack();
      await screen.findByText('note list');
      expect(top.open).toBe(false);
      expect(under.open).toBe(false);
    });

    /*
     * The attachment viewer's own entry: pushed at the address it was opened on, and
     * popped by the viewer when its ✕ closes it. A sheet the viewer was opened from is
     * still over the page it belongs to.
     */
    it('leaves a sheet open when the address did not change', async () => {
      stubScheme();
      window.UnbentApp = { platform: 'ios', postMessage: vi.fn() };
      await onANote();
      const sheet = openDialog();
      // The viewer makes its own dialog, so jsdom's missing methods go on the prototype
      // for it, as its own tests do; `openDialog` above carries its own.
      const proto = HTMLDialogElement.prototype;
      const { showModal, close } = proto;
      proto.showModal = function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      };
      proto.close = function (this: HTMLDialogElement) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      };
      try {
        const viewer = openAttachmentViewer({ kind: 'image', src: '/api/x/sample.png', alt: 'A sample' });
        const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
        viewer.close();
        await act(async () => void (await popped));
      } finally {
        Object.assign(proto, { showModal, close });
      }
      expect(sheet.open).toBe(true);
      await screen.findByText('one note');
    });

    it("does nothing in a browser, where Back is the browser's", async () => {
      await onANote();
      const sheet = openDialog();
      await swipeBack();
      await screen.findByText('note list');
      expect(sheet.open).toBe(true);
    });
  });
});
