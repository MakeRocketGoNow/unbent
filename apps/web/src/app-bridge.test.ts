import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptHostLayout, exposeToApp, isHosted, postToApp, savesTo } from './app-bridge.js';

/**
 * The bridge's two promises to the rest of the site: in a browser it is silent, and inside
 * the app every message arrives as one JSON string. Pages call `postToApp` without asking
 * first, so the silent half is what keeps the site working anywhere but the app.
 */
describe('app bridge', () => {
  afterEach(() => {
    delete window.UnbentApp;
    delete window.__unbent;
    document.documentElement.className = '';
    document.head.querySelector('meta[name="viewport"]')?.remove();
  });

  function viewport(content: string): HTMLMetaElement {
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = content;
    document.head.appendChild(meta);
    return meta;
  }

  /**
   * The iOS app gives a page the whole screen only when the page asks, and the page asks
   * only there: in a browser and in the Android app the layout is left exactly as it was.
   */
  it('takes the whole screen inside the iOS app, and says so', () => {
    const meta = viewport('width=device-width, initial-scale=1.0');
    const postMessage = vi.fn();
    window.UnbentApp = { platform: 'ios', postMessage };

    adoptHostLayout();
    adoptHostLayout();

    expect(document.documentElement.classList.contains('host-ios')).toBe(true);
    expect(meta.content).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    expect(postMessage).toHaveBeenCalledWith('{"type":"edge-to-edge"}');
  });

  /** A restored page runs no script again, and the app has put it back in the safe area. */
  it('asks for the screen again when the page comes back from the back/forward cache', () => {
    viewport('width=device-width, initial-scale=1.0');
    const postMessage = vi.fn();
    window.UnbentApp = { platform: 'ios', postMessage };
    adoptHostLayout();
    adoptHostLayout();
    postMessage.mockClear();

    // An ordinary first showing is not a restore; the page has only just asked.
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith('{"type":"edge-to-edge"}');
  });

  it('leaves the layout alone in a browser and in the Android app', () => {
    const meta = viewport('width=device-width, initial-scale=1.0');
    adoptHostLayout();
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    adoptHostLayout();

    expect(document.documentElement.classList.contains('host-ios')).toBe(false);
    expect(meta.content).toBe('width=device-width, initial-scale=1.0');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('is silent in a browser', () => {
    expect(isHosted()).toBe(false);
    expect(postToApp({ type: 'signed-out' })).toBe(false);
  });

  it('hands the app each message as JSON', () => {
    const postMessage = vi.fn();
    window.UnbentApp = { postMessage };
    expect(isHosted()).toBe(true);
    expect(postToApp({ type: 'theme', background: '#fbfaf8' })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith('{"type":"theme","background":"#fbfaf8"}');
  });

  /** Android's bridge object carries methods only, so saying nothing has to mean Android. */
  it('names where the app saves a file, taking a host that does not say for Android', () => {
    expect(savesTo()).toBe('Downloads');
    window.UnbentApp = { postMessage: vi.fn() };
    expect(savesTo()).toBe('Downloads');
    window.UnbentApp = { platform: 'android', postMessage: vi.fn() };
    expect(savesTo()).toBe('Downloads');
    window.UnbentApp = { platform: 'ios', postMessage: vi.fn() };
    expect(savesTo()).toBe('Files');
  });

  it('leaves a later registration in place when an earlier one is torn down', () => {
    const first = exposeToApp({ back: () => false });
    const second = { back: () => true };
    const undo = exposeToApp(second);
    first();
    expect(window.__unbent).toBe(second);
    undo();
    expect(window.__unbent).toBeUndefined();
  });
});
