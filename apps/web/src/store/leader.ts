import type { LeaderElection } from '@tanstack/offline-transactions';

/** The one call of Web Locks this uses, so a test can stand in for the browser (`test-locks.ts`). */
export interface Locks {
  request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown> | unknown): Promise<unknown>;
}

/** The browser's Web Locks, where there are any. */
export const browserLocks = (): Locks | undefined => (typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined);

/**
 * Which tab replays an account's outbox: the one holding a Web Lock named for the
 * account, and the first to ask for it once the holder lets go.
 *
 * The outbox library's own `WebLocksLeader` asks once, at the outbox's start, with
 * `ifAvailable`, and a tab that loses never asks again. A tab opened beside another was
 * then a follower for good: close the leading tab and the survivor kept making every
 * write a request of its own, offline it could save nothing, and its banner blamed
 * "another Unbent tab" that no longer existed — until someone reloaded it. Its lock was
 * also named for the whole origin, so a window holding a different account's library
 * stopped this account's outbox from ever replaying, and its probe and its hold were two
 * requests, so two tabs starting together could both lead and both replay.
 *
 * This one asks the same way to answer the outbox promptly — the executor's start waits
 * on the answer, and the library's open waits on the executor — but a tab that loses then
 * leaves a request in the lock's queue. The browser grants it the moment the holder's
 * page goes, closes its library or signs out, and the executor is told through
 * `onLeadershipChange`, which is how it replays what waited. One request probes and
 * holds, so there is no gap for a second leader.
 *
 * Without Web Locks nobody leads, as the library's own class decides: an outbox replayed
 * from two tabs at once is two copies of every write.
 */
export class OutboxLeader implements LeaderElection {
  private leader = false;
  private readonly listeners = new Set<(isLeader: boolean) => void>();
  /** Lets go of the lock this tab holds; null while it holds none. */
  private release: (() => void) | null = null;
  /** The request waiting its turn in the lock's queue; null while there is none. */
  private queued: AbortController | null = null;

  constructor(
    private readonly name: string,
    private readonly locks: Locks | undefined = browserLocks(),
  ) {}

  async requestLeadership(): Promise<boolean> {
    if (!this.locks) return false;
    if (this.leader) return true;
    if (await this.hold({ ifAvailable: true })) return true;
    this.queue();
    return false;
  }

  releaseLeadership(): void {
    this.queued?.abort();
    this.queued = null;
    this.release?.();
    this.release = null;
    this.lost();
  }

  isLeader(): boolean {
    return this.leader;
  }

  onLeadershipChange(callback: (isLeader: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }

  /**
   * One request that probes and holds: granted, the callback keeps the lock until
   * `release` is called, and the answer is given the moment it is granted rather than
   * when it is let go. Settles false when the lock is held elsewhere (`ifAvailable`), when
   * the request is aborted before its turn, or when Web Locks refuse.
   */
  private hold(options: { ifAvailable?: boolean; signal?: AbortSignal }): Promise<boolean> {
    const asked: LockOptions = { mode: 'exclusive' };
    if (options.ifAvailable) asked.ifAvailable = true;
    if (options.signal) asked.signal = options.signal;
    return new Promise<boolean>((resolve) => {
      let granted = false;
      this.locks!.request(this.name, asked, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        granted = true;
        this.queued = null;
        this.leader = true;
        resolve(true);
        for (const listener of this.listeners) listener(true);
        return new Promise<void>((done) => {
          this.release = done;
        });
      }).then(
        () => {
          // The hold ended: `release` was called, or the lock was taken from this tab.
          if (granted) this.lost();
        },
        (err: unknown) => {
          if (!granted && !(err instanceof DOMException && err.name === 'AbortError')) {
            console.warn('[outbox] the leader lock could not be asked for:', err);
          }
          resolve(false);
          if (granted) this.lost();
        },
      );
    });
  }

  /** Waits in the lock's queue, so this tab leads once the holder lets go. */
  private queue(): void {
    if (this.queued || this.leader) return;
    const waiting = new AbortController();
    this.queued = waiting;
    void this.hold({ signal: waiting.signal }).then((granted) => {
      if (!granted && this.queued === waiting) this.queued = null;
    });
  }

  private lost(): void {
    if (!this.leader) return;
    this.leader = false;
    this.release = null;
    for (const listener of this.listeners) listener(false);
  }
}
