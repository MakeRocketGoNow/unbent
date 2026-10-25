/**
 * Word from the outbox that the server refused a note write for room the account's plan
 * does not have, and what the rest of the app needs of it: the account's store past the
 * room its plan allows (MAK-234), or, on the free plan, a new note past its count
 * (`FREE_NOTES_FULL`, 2026-10-24), which is the same kind of refusal with the same way
 * out and is carried here by the same path. The shape of `plan-refused.ts`, for the other 402 with a code, and for the
 * same reason: the answer changes when the person acts (deletes something, or adds
 * storage), so the refused entry is kept rather than ended, and ending it would roll the
 * row back to the server's copy and lose the text that was typed.
 *
 * The kept entry sits at the head of the queue, which runs oldest first, so every write
 * behind it waits with it. The way back under the limit is a delete, a purge or an
 * emptied trash, and those go to the server directly rather than behind the kept entry
 * (`roundTheQueue` in store/actions.ts, as a lapsed plan's deletes do). A direct write
 * that goes through while the refusal stands says so here (`storeFreed`), and the
 * outbox's online detector hears it and replays the kept entry at once, rather than
 * when the executor's own clock came round; a replay refused again keeps the word, and
 * a queued write the server takes clears it (`storeAccepted`).
 *
 * What is kept is the server's own sentence, which names the numbers and the way out;
 * the strip shows it (`SyncingLine`), since the queue's three places to show itself
 * are the glyph on the note, the strip and the question at sign-out, and the strip is
 * the one with room for a sentence. A set of listeners rather than a DOM event, so a
 * test can call it without a window.
 */
let sentence: string | null = null;
/** Which of the two the refusal was: the store's room, or the free plan's count of notes. */
let refusedFor: StoreRefusal | null = null;
const listeners = new Set<() => void>();
const freedListeners = new Set<() => void>();

function tell(): void {
  for (const listener of listeners) listener();
}

/**
 * What was refused: `room` is the store past the room the plan allows, where clearing
 * a note's history is one way out; `notes` is the free plan's count, where it is not.
 */
export type StoreRefusal = 'room' | 'notes';

/** The server refused a note write, with this sentence, for the store's room or the free plan's count. */
export function storeRefused(message: string, of: StoreRefusal = 'room'): void {
  if (sentence === message && refusedFor === of) return;
  sentence = message;
  refusedFor = of;
  tell();
}

/** What the waiting refusal is for, or null while nothing is refused; see `StoreRefusal`. */
export function storeRefusedFor(): StoreRefusal | null {
  return refusedFor;
}

/** The server took a queued write: there is room, and nothing need go round the queue. */
export function storeAccepted(): void {
  if (sentence === null) return;
  sentence = null;
  refusedFor = null;
  tell();
}

/** Whether a note write refused for the store's size is waiting in the outbox. */
export function storeFull(): boolean {
  return sentence !== null;
}

/** The server's sentence for the refusal, or null while nothing is refused. */
export function storeFullMessage(): string | null {
  return sentence;
}

/** Told when the refusal appears, changes its words, or goes. */
export function onStoreFull(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A direct write went through while a refusal stands: there may be room now, so the kept entry is worth sending. */
export function storeFreed(): void {
  if (sentence === null) return;
  for (const listener of freedListeners) listener();
}

export function onStoreFreed(listener: () => void): () => void {
  freedListeners.add(listener);
  return () => freedListeners.delete(listener);
}

/** For tests. */
export function resetStoreFull(): void {
  sentence = null;
  refusedFor = null;
  listeners.clear();
  freedListeners.clear();
}
