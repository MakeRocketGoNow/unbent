import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatTrace, installRailWatch } from './rail-watch.js';

/**
 * The recorder has one job — say when the rail's list reached its top on its own, and what
 * came just before — and two ways to be useless: reporting a person scrolling up as the
 * bug, and missing the jump. jsdom does no layout, so the list's position is an own
 * property each test moves by hand, and frames are run by hand too.
 */
describe('installRailWatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let frames: FrameRequestCallback[];
  let uninstall: () => void;
  let list: HTMLElement;
  let top: number;

  const runFrame = () => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(performance.now());
  };

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    document.body.innerHTML = '<aside class="rail"><nav class="drawer-list"><a href="/a">A</a><a href="/b">B</a></nav></aside>';
    list = document.querySelector('.drawer-list')!;
    top = 0;
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top });
    uninstall = installRailWatch();
  });

  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('reports the list going to its top with no wheel turned up', () => {
    runFrame();
    top = 650;
    runFrame();
    top = 0;
    runFrame();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/client-errors');
    const body = JSON.parse(init.body as string);
    expect(body.kind).toBe('error');
    expect(body.message).toMatch(/^Rail scroll reset: 650 to 0/);
    expect(body.stack).toContain('frame top=650');
  });

  it('does not report a person scrolling up to the top', () => {
    runFrame();
    top = 650;
    runFrame();
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    top = 0;
    runFrame();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // jsdom has no `scrollTo`; `focus` is wrapped the same way and scrolls a list as surely.
  it('notes a call that could move the rail, with where it came from', () => {
    runFrame();
    top = 650;
    runFrame();
    document.querySelector('a')!.focus();
    top = 0;
    runFrame();

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.stack).toMatch(/call focus a\.#0 /);
  });

  it('keeps names out: a link is its index, never its text', () => {
    runFrame();
    top = 650;
    runFrame();
    document.querySelectorAll('a')[1]!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    top = 0;
    runFrame();

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.stack).toContain('hover a.#1');
    expect(body.stack).not.toContain(' B');
  });

  it('sends at most three reports a load', () => {
    runFrame();
    for (let i = 0; i < 5; i += 1) {
      top = 100;
      runFrame();
      top = 0;
      runFrame();
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('formatTrace', () => {
  it('drops the oldest lines to fit, keeping the moment of the jump', () => {
    const entries = Array.from({ length: 500 }, (_, i) => [i, `event ${i} ${'x'.repeat(20)}`] as [number, string]);
    const trace = formatTrace(entries, 500);
    expect(trace.length).toBeLessThanOrEqual(3900);
    expect(trace.endsWith(`-1 event 499 ${'x'.repeat(20)}`)).toBe(true);
    expect(trace).not.toContain('event 0 ');
  });
});
