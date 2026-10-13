import type { Message, Port } from './library-channel.js';

/**
 * The channel between tabs, for tests: every port hears what the others post and nothing
 * it posted itself, each message cloned as the browser clones it — so a row shared by
 * reference, or a payload the browser could not clone, fails here first — and delivered
 * on a later turn, as a `BroadcastChannel` delivers. The delivery is a microtask, which
 * a test on fake timers still gets without advancing them.
 */
export function fakeChannel(): { port: () => Port; posted: Message[] } {
  const ports = new Set<{ handlers: Set<(m: Message) => void> }>();
  const posted: Message[] = [];
  return {
    posted,
    port: () => {
      const mine = { handlers: new Set<(m: Message) => void>() };
      ports.add(mine);
      return {
        post: (message) => {
          posted.push(message);
          const copy = structuredClone(message);
          for (const other of ports) {
            if (other === mine) continue;
            queueMicrotask(() => other.handlers.forEach((h) => h(copy)));
          }
        },
        listen: (handler) => {
          mine.handlers.add(handler);
          return () => void mine.handlers.delete(handler);
        },
        close: () => {
          mine.handlers.clear();
          ports.delete(mine);
        },
      };
    },
  };
}
