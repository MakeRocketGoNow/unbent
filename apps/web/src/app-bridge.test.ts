import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposeToApp, isHosted, postToApp, savesTo } from './app-bridge.js';

/**
 * The bridge's two promises to the rest of the site: in a browser it is silent, and inside
 * the app every message arrives as one JSON string. Pages call `postToApp` without asking
 * first, so the silent half is what keeps the site working anywhere but the app.
 */
describe('app bridge', () => {
  afterEach(() => {
    delete window.UnbentApp;
    delete window.__unbent;
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
