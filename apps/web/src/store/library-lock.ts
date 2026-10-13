import { browserLocks, holdLock, type Locks } from './locks.js';
import { libraryLockName } from './names.js';

/**
 * One tab holds an account's library on a device; the others read the server and can take
 * it over.
 *
 * Until 2026-10-13 every tab of the origin opened the library: each its own connection to
 * the SQLite file, taking turns on its one access handle through wa-sqlite's cooperative
 * lock; each a connection to the outbox's IndexedDB database; one of them the leader of
 * each collection, through which the others' writes went by message; one of them the
 * outbox's leader. Four schemes, none of which knew about the others, and the states they
 * made between them were never designed: a follower left behind by a closed leader, an
 * open waiting for good on a handle a frozen tab held, a wipe blocked on a connection in
 * a tab on the sign-in screen, a list half copied through a leader that stopped
 * answering. Forty commits in four days bounded and queued and broadcast around them, and
 * each fix moved the wedge rather than removing it.
 *
 * So the library is one tab's. A Web Lock named for the account says whose: a tab that
 * finds it held does not open the library, reads the server as a browser without a file
 * system does, and says so where the library's status is said, with the way to take it
 * over one press away. The lock is taken with `steal`, and the tab that held it closes
 * its library and stands aside — waiting in the lock's queue, so when the taking tab
 * goes, this one has it back without a press. A tab that has not been asked anything
 * also waits: close the holding tab and the next one opens the library on its own.
 *
 * The trade is no editing of one account in two tabs of one device at once; the second
 * tab's writes are requests, as they were when it was not the outbox's leader. Under it
 * the cross-tab paths of the libraries are still there and still untested, because
 * nothing exercises them now.
 *
 * Without Web Locks the library is held by whoever asks, which is the one-tab world this
 * assumes anyway.
 */
export interface LibraryHold {
  /** Lets go of the library, for the next tab in the queue. */
  release: () => void;
  /** Settles when another tab took the library over; never for a release. */
  taken: Promise<void>;
}

let locks: Locks | undefined = browserLocks();

/** For tests: the lock manager to use in place of the browser's. */
export function setLocksForTests(fake: Locks | undefined): void {
  locks = fake;
}

/** A hold nothing can contest, for a browser without Web Locks. */
function uncontested(): LibraryHold {
  return { release: () => {}, taken: new Promise(() => {}) };
}

/**
 * Holds the account's library for this tab, or answers null when another tab has it. With
 * `takeOver`, takes it from that tab, whose hold is then told. One request probes and
 * holds, so no two tabs can both believe they hold it.
 */
export async function holdLibrary(userId: string, takeOver = false): Promise<LibraryHold | null> {
  const manager = locks;
  if (!manager) return uncontested();
  const held = await holdLock(manager, libraryLockName(userId), takeOver ? { steal: true } : { ifAvailable: true });
  return held && { release: held.release, taken: held.lost };
}

/**
 * Settles once the account's library is free to hold: a request in the lock's queue,
 * granted and let go at once. The caller then asks to hold it; a tab that lost that race
 * to another waiter simply waits again. Rejects when `signal` aborts first. Never settles
 * without Web Locks, where nothing is ever held elsewhere.
 */
export function whenLibraryFree(userId: string, signal: AbortSignal): Promise<void> {
  const manager = locks;
  if (!manager) return new Promise(() => {});
  return manager.request(libraryLockName(userId), { mode: 'exclusive', signal }, () => undefined).then(() => {});
}
