import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoLoad } from './useAutoLoad.js';

/**
 * A stand-in for `IntersectionObserver`, which jsdom does not implement. Like the real
 * one, it reports once on `observe` (with whatever `inView` says) and again only when
 * a test says the element moved.
 */
let inView = false;
const observers: { cb: IntersectionObserverCallback; init?: IntersectionObserverInit; live: boolean }[] = [];
class FakeObserver {
  private entry: { cb: IntersectionObserverCallback; init?: IntersectionObserverInit; live: boolean };
  constructor(cb: IntersectionObserverCallback, init?: IntersectionObserverInit) {
    this.entry = { cb, init, live: true };
    observers.push(this.entry);
  }
  observe() {
    this.entry.cb([{ isIntersecting: inView } as IntersectionObserverEntry], this as never);
  }
  disconnect() {
    this.entry.live = false;
  }
}

function move(into: boolean) {
  inView = into;
  for (const o of observers.filter((o) => o.live)) {
    o.cb([{ isIntersecting: into } as IntersectionObserverEntry], {} as never);
  }
}

function mount(props: { enabled: boolean; loaded: number; onLoad: () => void }, el: HTMLElement) {
  const hook = renderHook((p: typeof props) => useAutoLoad(p), { initialProps: props });
  act(() => hook.result.current(el));
  return hook;
}

afterEach(() => {
  vi.unstubAllGlobals();
  observers.length = 0;
  inView = false;
  document.body.innerHTML = '';
});

describe('useAutoLoad', () => {
  it('asks for a page when the button comes within range', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const onLoad = vi.fn();
    mount({ enabled: true, loaded: 50, onLoad }, document.body.appendChild(document.createElement('button')));
    expect(onLoad).not.toHaveBeenCalled();
    act(() => move(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing while a page is on its way', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    inView = true;
    const onLoad = vi.fn();
    mount({ enabled: false, loaded: 50, onLoad }, document.body.appendChild(document.createElement('button')));
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('looks again when a page arrives and the button is still in range', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    inView = true;
    const onLoad = vi.fn();
    const hook = mount({ enabled: true, loaded: 50, onLoad }, document.body.appendChild(document.createElement('button')));
    expect(onLoad).toHaveBeenCalledTimes(1);
    hook.rerender({ enabled: false, loaded: 50, onLoad });
    hook.rerender({ enabled: true, loaded: 100, onLoad });
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('does not ask again for a page that failed until the list changes', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    inView = true;
    const onLoad = vi.fn();
    const hook = mount({ enabled: true, loaded: 50, onLoad }, document.body.appendChild(document.createElement('button')));
    hook.rerender({ enabled: false, loaded: 50, onLoad });
    // The page failed: nothing more was loaded, and the button is pressable again.
    hook.rerender({ enabled: true, loaded: 50, onLoad });
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('watches against the nearest scrolling ancestor, a screen ahead', () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const scroller = document.body.appendChild(document.createElement('div'));
    scroller.style.overflowY = 'auto';
    const button = scroller.appendChild(document.createElement('div')).appendChild(document.createElement('button'));
    mount({ enabled: true, loaded: 50, onLoad: vi.fn() }, button);
    expect(observers[0]!.init?.root).toBe(scroller);
    expect(observers[0]!.init?.rootMargin).toMatch(/^0px 0px \d+px 0px$/);
  });

  it('leaves the button to be pressed where there is no observer', () => {
    const onLoad = vi.fn();
    mount({ enabled: true, loaded: 50, onLoad }, document.body.appendChild(document.createElement('button')));
    expect(onLoad).not.toHaveBeenCalled();
  });
});
