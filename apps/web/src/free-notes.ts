import { FREE_NOTES_FULL_CODE, freeNotesFullMessage } from '@unbent/shared';

/**
 * A note the free plan has no room for, refused on the device before it was made
 * (`createNote` and `duplicateNote` in store/actions.ts). Its message is the server's own
 * sentence for the same refusal (`freeNotesFullMessage`), so a caller that shows the
 * message (a batch of dropped files) says what the 402 would have said.
 *
 * Refused here rather than queued and refused by the server, because the outbox replays
 * one entry at a time, oldest first: a kept create at its head would hold back every
 * later save of every other note, on an account the server lets write, until something
 * is deleted for good. The server's refusal is still the rule, for the case the device
 * cannot see (a note made on another device a moment ago), and the outbox keeps that one.
 */
export class FreeNotesFullError extends Error {
  constructor(
    readonly held: number,
    readonly adding = 1,
  ) {
    super(freeNotesFullMessage(held, adding));
    this.name = 'FreeNotesFullError';
  }
}

/**
 * Whether a failure is that refusal: the device's own, the same carried back by name
 * from the tab that holds the outbox (`revive` keeps the name and not the class), or the
 * server's 402 for a note made as a request.
 */
export function isFreeNotesFull(err: unknown): boolean {
  if (err instanceof FreeNotesFullError) return true;
  if (err instanceof Error && err.name === 'FreeNotesFullError') return true;
  return (err as { code?: unknown } | null)?.code === FREE_NOTES_FULL_CODE;
}

const listeners = new Set<() => void>();

/**
 * Asks for the notice that says so (`FreeNotesNotice`), from a control whose press was
 * refused: New, the phone's +, the empty state, the apps' New note shortcut, Duplicate.
 * A listener set rather than state, because the controls and the notice are different
 * components, as `useCreateNote`'s are. A dropped batch says it in its own message
 * instead, and does not ask.
 */
export function showFreeNotesFull(): void {
  for (const listener of listeners) listener();
}

export function onFreeNotesFull(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
