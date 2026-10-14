/**
 * Word from the outbox that the server refused a write because the plan has ended
 * (MAK-108), and the one thing the rest of the store needs to know from it.
 *
 * The outbox lives below the React tree and holds no query client; `onPlanRefused` is
 * how the thing that should happen next — the plan read again, so the banner and the
 * read-only editor appear — reaches `usePlan`, which listens. Told once a minute at
 * most: the refused entry is kept and tried again on the executor's own clock, and a
 * read of the plan on every try would be a read a minute for as long as the tab is open.
 *
 * `planLapsed` is the outbox's own memory of it. A refused entry is kept at the head of
 * the queue, which runs one entry at a time, oldest first, so every write queued behind
 * it waits with it — and a lapsed account is promised its deletes. So while a refusal
 * is waiting, the deletes go to the server directly rather than behind it
 * (`trashNotes` and the rest in actions.ts), and the flag is cleared the moment any
 * queued write is accepted, which is the server saying the plan is active again. A set
 * of listeners rather than a DOM event, so a test can call it without a window.
 *
 * The plan's own word closes the loop (`planIs`): once the page has read the plan and it
 * says inactive, the kept entry is not sent again until the plan says otherwise. Without
 * that the executor replayed it on its own clock, about once a minute, and every replay
 * was a request answered 402 and a read of the plan after it — two requests a minute
 * from a holder tab left open on a lapsed account, for as long as it was open. And the
 * moment the plan reads as active again — the checkout done, the plan re-read — the
 * executor is nudged (`onPlanActive`, which the outbox's online detector listens to), so
 * the kept edit lands at once rather than when the next minute's replay came round.
 */
const listeners = new Set<() => void>();
const activeListeners = new Set<() => void>();
let lapsed = false;
let toldAt = 0;
/** The plan as the page last read it: true once it said inactive, false once it said otherwise. */
let knownInactive = false;

/** How long a refusal's word is kept to itself before the listeners hear it again. */
export const REFUSAL_TELL_MS = 60_000;

export function onPlanRefused(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function planRefused(now = Date.now()): void {
  lapsed = true;
  if (now - toldAt < REFUSAL_TELL_MS) return;
  toldAt = now;
  for (const listener of listeners) listener();
}

/** The server took a queued write: the plan is active, and nothing need go round the queue. */
export function planAccepted(): void {
  lapsed = false;
}

/** Whether a write refused for the plan is waiting in the outbox. */
export function planLapsed(): boolean {
  return lapsed;
}

/**
 * What the page read the plan to be, from `usePlanRefresh` each time its answer
 * changes. Inactive holds the kept entry back from the wire; active again lets it go,
 * at once.
 */
export function planIs(inactive: boolean): void {
  const was = knownInactive;
  knownInactive = inactive;
  if (inactive || !(was || lapsed)) return;
  lapsed = false;
  for (const listener of activeListeners) listener();
}

/** Whether the kept entry should wait rather than be sent: the plan was read, and said inactive. */
export function planHeld(): boolean {
  return lapsed && knownInactive;
}

/** Told when the plan reads as active again after a refusal: the outbox replays now. */
export function onPlanActive(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

/** For tests. */
export function resetPlanRefused(): void {
  lapsed = false;
  knownInactive = false;
  toldAt = 0;
  listeners.clear();
  activeListeners.clear();
}
