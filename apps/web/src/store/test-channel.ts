import { PRIVATE, type Message, type Port } from './library-channel.js';

/**
 * The channels between tabs, for tests: every port hears what the others post on the
 * account's channel and nothing it posted itself, a port opened with a client id alone
 * hears what is posted for that client, and each message is cloned as the browser
 * clones it — so a row shared by reference, or a payload the browser could not clone,
 * fails here first — and delivered on a later turn, as a `BroadcastChannel` delivers.
 * The delivery is a microtask, which a test on fake timers still gets without advancing
 * them.
 */
export function fakeChannel(): { port: (clientId?: string) => Port; posted: Message[] } {
  const ports = new Set<{ clientId: string | undefined; handlers: Set<(m: Message) => void> }>();
  const posted: Message[] = [];
  return {
    posted,
    port: (clientId) => {
      const mine = { clientId, handlers: new Set<(m: Message) => void>() };
      ports.add(mine);
      return {
        post: (message) => {
          posted.push(message);
          const copy = structuredClone(message);
          const addressed = PRIVATE.has(message.type) && 'client' in message ? message.client : null;
          for (const other of ports) {
            if (other === mine) continue;
            if (addressed !== null && other.clientId !== addressed) continue;
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
