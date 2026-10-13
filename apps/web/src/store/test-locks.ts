import type { Locks } from './locks.js';

type Callback = (lock: Lock | null) => Promise<unknown> | unknown;
type Waiter = { callback: Callback; settle: (value: unknown) => void; fail: (err: unknown) => void };

/**
 * A lock manager with the Web Locks semantics the store relies on, for tests: one holder
 * per name; `ifAvailable` answers null at once rather than waiting; a plain request waits
 * its turn and is granted when the holder's callback settles; `steal` takes the lock from
 * its holder, whose request then fails with an `AbortError`; an aborted request leaves
 * the queue. jsdom has no `navigator.locks`.
 */
export function fakeLocks(): Locks & { held: (name: string) => boolean } {
  const holders = new Map<string, Waiter>();
  const queues = new Map<string, Waiter[]>();
  const next = (name: string) => {
    const waiter = queues.get(name)?.shift();
    if (waiter) grant(name, waiter);
  };
  const grant = (name: string, waiter: Waiter) => {
    holders.set(name, waiter);
    Promise.resolve()
      .then(() => waiter.callback({ name, mode: 'exclusive' }))
      .then(
        (value) => {
          if (holders.get(name) !== waiter) return;
          holders.delete(name);
          waiter.settle(value);
          next(name);
        },
        (err: unknown) => {
          if (holders.get(name) !== waiter) return;
          holders.delete(name);
          waiter.fail(err);
          next(name);
        },
      );
  };
  return {
    held: (name) => holders.has(name),
    request(name, options, callback) {
      return new Promise((settle, fail) => {
        const waiter: Waiter = { callback, settle, fail };
        const holder = holders.get(name);
        if (options.steal && holder) {
          holders.delete(name);
          holder.fail(new DOMException('stolen', 'AbortError'));
          return grant(name, waiter);
        }
        if (!holder) return grant(name, waiter);
        // Held elsewhere: answered null at once, without touching the holder's grant.
        if (options.ifAvailable) return Promise.resolve(callback(null)).then(settle, fail);
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        queue.push(waiter);
        options.signal?.addEventListener('abort', () => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          fail(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  };
}
