import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { back, useHostApp } from './useHostApp.js';

// `HOME` comes from the gate, which imports the auth client; nothing here signs in.
vi.mock('./auth-client.js', () => ({ ensureSession: vi.fn() }));

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
function harness(initial: string) {
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
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [initial] }) });
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
});
