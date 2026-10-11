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
 */
const listeners = new Set<() => void>();
let lapsed = false;
let toldAt = 0;

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

/** For tests. */
export function resetPlanRefused(): void {
  lapsed = false;
  toldAt = 0;
  listeners.clear();
}
