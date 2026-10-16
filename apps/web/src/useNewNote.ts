import { useSyncExternalStore } from 'react';

/**
 * The note the New note button just made, while it is still the one being opened.
 *
 * A module-level id rather than router state or a search param, for the same reasons
 * `cameFromList` is one: it records how this note came to be on screen, not anything about
 * the note, so it must neither ride along in a link nor survive a reload. Opening a note's
 * URL in a fresh tab is opening an existing note, whoever created it a second ago.
 *
 * An id rather than a boolean. A bare flag can only be cleared by whoever reads it, and if
 * the navigation never lands (a create that fails after the flag is set, a Back pressed
 * mid-flight) it stays set and takes the focus of whatever note is opened next. Matching
 * on the id makes that impossible: it can only ever answer for the note it was set for.
 */
let newNoteId: string | null = null;
const subscribers = new Set<() => void>();

function setNewNoteId(next: string | null) {
  if (newNoteId === next) return;
  newNoteId = next;
  for (const fn of subscribers) fn();
}

/**
 * Records that this note has just been created, before navigating to it.
 *
 * Set before the navigation rather than after, so the workspace it opens sees it during
 * the mount that navigation triggers rather than a render later, with the editor below
 * already holding the caret.
 */
export function markNewNote(id: string) {
  setNewNoteId(id);
}

/** Whether `noteId` is the note that was just created; see `newNoteId`. */
export function useIsNewNote(noteId: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    () => newNoteId === noteId,
    () => false,
  );
}

/*
   Any pointer press ends the claim, as it does for the arrow keys' flag.

   The workspace only reads this while mounting a note, so within one visit the answer is
   settled long before this fires. What it prevents is the visit after: leaving a new note
   and clicking back into it later would otherwise put the caret in the title of a note
   that has had a name for ten minutes.

   The click that creates the note is not at risk. Its pointerdown has already been and
   gone by the time the button's click handler runs, so this clears nothing and the flag is
   set after it.
*/
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => setNewNoteId(null), true);
}
