import { routeOf } from './report-error.js';

/**
 * A recorder for one bug: the rail's list jumping back to its top on its own.
 *
 * Temporary, and on purpose not clever. On a desktop with a mouse wheel the rail's
 * `.drawer-list` sometimes goes from wherever it was scrolled to 0 in one frame, a moment
 * after a navigation or a few seconds after a load. A probe pasted into the console caught
 * it once and found nothing in the page's code moving it — no `scrollTop`, `scrollTo`,
 * `scrollIntoView` or `focus` on the rail, no change to its rows, height or overflow — and
 * every attempt to make it happen with synthetic input failed. So instead of being
 * reproduced on demand it is recorded where it happens: from the first frame of every
 * load, the last two seconds of what the rail did and what the person did are kept, and
 * when the list reaches 0 without a wheel turned upwards just before, they are sent to the
 * Worker's log through the same endpoint as a crash (`/api/client-errors`).
 *
 * What it keeps is shapes, never names: an index into the rail's links and a class, not a
 * notebook's or a tag's title, which are the person's own (AGENTS.md, "Real notes stay out
 * of the repo" — the log is not the repo, but it is not the place for them either).
 *
 * Remove it, and its line in `main.tsx`, once the cause is found.
 */

/** How far back a report reaches. */
const WINDOW_MS = 2000;

/** Reports per page load; one is usually the answer, three show whether it is the same. */
const MAX_REPORTS = 3;

/** An upward wheel this recent is the person scrolling to the top, not the bug. */
const WHEEL_GRACE_MS = 400;

/** The endpoint caps `stack` at 4000; the trace is cut to fit rather than refused. */
const MAX_TRACE = 3900;

type Entry = [t: number, what: string];

export function installRailWatch(): () => void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return () => {};

  const log: Entry[] = [];
  const now = () => Math.round(performance.now());
  const note = (what: string) => {
    log.push([now(), what]);
    const floor = now() - WINDOW_MS;
    while (log.length > 0 && log[0]![0] < floor) log.shift();
  };
  const inRail = (el: unknown): el is Element => el instanceof Element && el.closest('.rail') !== null;
  /** A rail element by shape: its tag, its classes, and which of the rail's links it is. */
  const shape = (el: Element | null): string => {
    if (!el) return 'none';
    const links = el.closest('.rail')?.querySelectorAll('a, button');
    const index = links ? Array.prototype.indexOf.call(links, el.closest('a, button')) : -1;
    return `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim().replace(/\s+/g, '.')}#${index}`;
  };
  /** Where a call came from: the app's own frames, file and position only. */
  const caller = () =>
    (new Error().stack ?? '')
      .split('\n')
      .slice(3, 8)
      .map((line) => line.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\/assets\//, ''))
      .join(' < ');

  /*
   * The calls that could move the list, wrapped where they are looked up so a call on any
   * element of the rail is seen. Only rail elements are noted, and the wrapper costs a
   * `closest` per call, which none of these is hot enough to notice.
   */
  const restores: (() => void)[] = [];
  const wrap = <T extends object>(proto: T, name: keyof T & string) => {
    const original = proto[name] as unknown;
    if (typeof original !== 'function') return;
    (proto as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      if (inRail(this)) note(`call ${name} ${shape(this)} ${caller()}`);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restores.push(() => ((proto as Record<string, unknown>)[name] = original));
  };
  for (const name of ['scrollTo', 'scroll', 'scrollBy', 'scrollIntoView'] as const) wrap(Element.prototype, name);
  wrap(Element.prototype as unknown as { scrollIntoViewIfNeeded?: unknown }, 'scrollIntoViewIfNeeded');
  wrap(HTMLElement.prototype, 'focus');
  wrap(HTMLElement.prototype, 'blur');
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (scrollTop?.set && scrollTop.get) {
    const { get, set } = scrollTop;
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      enumerable: scrollTop.enumerable ?? false,
      get,
      set(this: Element, value: number) {
        if (inRail(this)) note(`set scrollTop=${Math.round(value)} ${shape(this)} ${caller()}`);
        set.call(this, value);
      },
    });
    restores.push(() => Object.defineProperty(Element.prototype, 'scrollTop', scrollTop));
  }
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
      note(`${name} ${routeOf() ?? ''}`);
      return original.apply(this, args);
    };
    restores.push(() => (history[name] = original));
  }

  /* What the person did. Captured, so nothing the app stops can hide it. */
  let lastUpWheel = -Infinity;
  let lastHover: Element | null = null;
  const listeners: [EventTarget, string, EventListener][] = [
    [document, 'wheel', (e) => {
      const w = e as WheelEvent;
      if (!inRail(w.target)) return;
      if (w.deltaY < 0) lastUpWheel = now();
      note(`wheel dy=${Math.round(w.deltaY)} mode=${w.deltaMode}`);
    }],
    [document, 'pointerover', (e) => {
      const target = (e.target as Element | null)?.closest?.('.rail a, .rail button') ?? null;
      if (target && target !== lastHover) note(`hover ${shape(target)}`);
      lastHover = target;
    }],
    [document, 'pointerdown', (e) => inRail(e.target) && note(`pointerdown ${shape(e.target as Element)}`)],
    [document, 'click', (e) => inRail(e.target) && note(`click ${shape(e.target as Element)}`)],
    [document, 'focusin', (e) => inRail(e.target) && note(`focusin ${shape(e.target as Element)}`)],
    [document, 'keydown', (e) => note(`key ${(e as KeyboardEvent).key}`)],
    [window, 'popstate', () => note('popstate')],
    [window, 'resize', () => note(`resize ${innerWidth}x${innerHeight}`)],
    [document, 'visibilitychange', () => note(`visibility ${document.visibilityState}`)],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener, { capture: true, passive: true });

  /* The list itself, every frame: where it is, how tall, whether it can scroll. */
  let list: Element | null = null;
  let observer: MutationObserver | null = null;
  let prev: { top: number; height: number; client: number; overflow: string } | null = null;
  let sent = 0;
  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);
    const current = document.querySelector('.rail .drawer-list');
    if (current !== list) {
      note(`list ${current ? 'mounted' : 'gone'}`);
      list = current;
      prev = null;
      observer?.disconnect();
      const rail = document.querySelector('.rail');
      if (rail) {
        observer = new MutationObserver((records) => {
          const kinds = new Set(records.map((r) => (r.type === 'attributes' ? `@${r.attributeName}` : `+${r.addedNodes.length}-${r.removedNodes.length}`)));
          note(`dom ${records.length} ${[...kinds].slice(0, 6).join(' ')}`);
        });
        observer.observe(rail, { subtree: true, childList: true, attributes: true });
      }
    }
    if (!list) return;
    const next = {
      top: Math.round(list.scrollTop),
      height: list.scrollHeight,
      client: list.clientHeight,
      overflow: getComputedStyle(list).overflowY,
    };
    if (!prev || next.top !== prev.top || next.height !== prev.height || next.client !== prev.client || next.overflow !== prev.overflow) {
      note(`frame top=${next.top} h=${next.height} ch=${next.client} ov=${next.overflow}`);
    }
    if (prev && prev.top > 0 && next.top === 0 && now() - lastUpWheel > WHEEL_GRACE_MS && sent < MAX_REPORTS) {
      sent += 1;
      send(prev.top, shape(document.activeElement), log);
    }
    prev = next;
  };
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, { capture: true });
    for (const restore of restores.reverse()) restore();
  };
}

/** The trace, newest last, each line its age in milliseconds before the jump. */
export function formatTrace(entries: readonly Entry[], at: number): string {
  const lines = entries.map(([t, what]) => `${t - at} ${what}`);
  let trace = lines.join('\n');
  // The oldest lines go first: what came just before the jump is the part that matters.
  while (trace.length > MAX_TRACE && lines.length > 1) {
    lines.shift();
    trace = lines.join('\n');
  }
  return trace.slice(-MAX_TRACE);
}

function send(from: number, active: string, entries: readonly Entry[]): void {
  try {
    const at = Math.round(performance.now());
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'error',
        message: `Rail scroll reset: ${from} to 0 at ${at} ms after load, active ${active}`.slice(0, 1000),
        stack: formatTrace(entries, at),
        route: routeOf(),
      }),
      keepalive: true,
    }).catch(() => {});
    // Also on the page, for a console that happens to be open.
    console.warn('[rail-watch] scroll reset', { from, at, active, trace: formatTrace(entries, at) });
  } catch {
    // A recorder that throws is worse than none.
  }
}
