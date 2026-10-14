/**
 * Holding a Web Lock as a thing with a lifetime, for the two locks the store takes: the
 * account's library (`library-lock.ts`) and its outbox's leadership (`leader.ts`).
 *
 * The Web Locks API hands a lock to a callback and keeps it for as long as the callback's
 * promise is pending, so "hold this until I say" is a promise whose resolver is kept
 * aside, and "was it taken from me" is the request's own promise rejecting after the
 * grant — which is also how it rejects when it was never granted and aborted. Both
 * callers had the same twenty lines telling those apart; this is them once.
 */

/** The one call of Web Locks the store uses, so a test can stand in for the browser (`test-locks.ts`). */
export interface Locks {
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown> | unknown): Promise<unknown>;
}

/** The browser's Web Locks, where there are any. */
export const browserLocks = (): Locks | undefined => (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined);

export interface Hold {
  /** Lets go of the lock, for the next request in its queue. Idempotent. */
  release: () => void;
  /** Settles when the lock was taken from this holder with `steal`; never for a release. */
  lost: Promise<void>;
}

/**
 * One request that probes and holds. Granted, the answer comes the moment it is, not when
 * the lock is let go, and the lock is kept until `release`. Null when it is held elsewhere
 * (`ifAvailable`), when `signal` aborted before its turn, or when Web Locks refused —
 * the last said in the console, since it is the one that is a fault.
 */
export function holdLock(locks: Locks, name: string, options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal } = {}): Promise<Hold | null> {
  const asked: LockOptions = { mode: 'exclusive' };
  if (options.ifAvailable) asked.ifAvailable = true;
  if (options.steal) asked.steal = true;
  if (options.signal) asked.signal = options.signal;
  return new Promise((resolve) => {
    let granted = false;
    let release: () => void = () => {};
    let taken: () => void = () => {};
    const hold: Hold = {
      release: () => release(),
      lost: new Promise<void>((r) => (taken = r)),
    };
    locks
      .request(name, asked, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        granted = true;
        resolve(hold);
        return new Promise<void>((done) => {
          release = done;
        });
      })
      .then(
        () => {},
        (err: unknown) => {
          if (granted) {
            taken();
            return;
          }
          if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn(`[locks] ${name} could not be asked for:`, err);
          resolve(null);
        },
      );
  });
}
