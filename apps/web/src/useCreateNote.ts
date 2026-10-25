import { useState, useSyncExternalStore } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as actions from './store/actions.js';
import { invalidateNoteMembership } from './queries.js';
import { markNewNote } from './useNewNote.js';
import { isFreeNotesFull, showFreeNotesFull } from './free-notes.js';

/** What a control asks to be made: where to file it, and, for a note with content, its text. */
export interface NewNote {
  tags: string[];
  notebook: string | null;
  /** Absent for a blank note, which starts with no name; see below. */
  title?: string;
  body?: string;
}

/**
 * What the New note controls do: make a note filed where it is asked to be, and open it,
 * with the caret in its title when it is blank.
 *
 * One action for every control that makes a note from the notes view (the desktop's New
 * button, the phone's floating +, and the empty state's New note and sample note), so they
 * cannot drift apart in how a note is made, how the lists hear of it or where it opens. It
 * goes through `actions.createNote`, so with no connection the note is made on the device
 * and sent from the outbox like any other write. `/notes?new=1` stays apart
 * (`useNewNoteRequest`), for the reason given there.
 *
 * The search params are kept on the way to the note: the list beside it is the list it was
 * made from. Resolves true once the note is made and open, false when it could not be made;
 * the failure is logged, as it always has been for New, and the control is usable again.
 */
export function useCreateNote(): (note: NewNote) => Promise<boolean> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async (note) => {
    // One at a time, decided here rather than by a disabled button: `disabled` arrives
    // with the next render, and two presses that land before it (a double tap on a slow
    // phone, a held Enter) would each make a note. The sample note made twice is two
    // copies of the same text in an account that had none. A flag of its own rather than
    // `creating`, and let go as soon as the note exists: `creating` lasts until the note
    // is open, and a navigation that never settled would then refuse every New after it.
    if (writing) return false;
    writing = true;
    setCreating(+1);
    try {
      let created;
      try {
        created = await actions.createNote({
          // No name for a blank note, rather than the literal string "Untitled". The title
          // field's placeholder already says that word, and a placeholder is not data: a
          // stored "Untitled" is written into the frontmatter of the exported markdown,
          // sorted under U by the title sort, and (titles being in the FTS index) returned
          // by a search for "untitled", all to say the note has no name yet. Android has
          // always created notes with an empty title; this is the web agreeing with it.
          title: note.title ?? '',
          body: note.body ?? '',
          tags: note.tags,
          notebook: note.notebook,
        });
      } finally {
        writing = false;
      }
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      invalidateNoteMembership(queryClient);
      // A blank note starts with its name, so the title takes the caret rather than the
      // body. Recorded here, before navigating, because it is a fact about this note's
      // creation and the workspace it opens has no other way to know it. A note made with
      // a title already has one, and opens like any other.
      if (!note.title) markNewNote(created.id);
      await navigate({ to: '/notes/$noteId', params: { noteId: created.id }, search: (p) => p });
      return true;
    } catch (err) {
      // The free plan full, said by its notice rather than logged: it is an answer, not a
      // fault (`roomForNotes` in the actions).
      if (isFreeNotesFull(err)) showFreeNotesFull();
      else console.error(err);
      return false;
    } finally {
      setCreating(-1);
    }
  };
}

/*
   Whether a note is being made through `useCreateNote` right now, from the press until the
   note is open.

   Module-level, like `markNewNote`, because the controls that make a note and the views
   that must hold still while it is made are different components: the empty state's
   button, and the pane or list that decides whether to draw the empty state at all.
*/
let creating = 0;
/** A note is being written, from the press until it exists; see the guard in `useCreateNote`. */
let writing = false;
const listeners = new Set<() => void>();

function setCreating(delta: number) {
  creating += delta;
  for (const fn of listeners) fn();
}

/** True while a note is being made and opened; see `useCreateNote`. */
export function useCreatingNote(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => creating > 0,
    () => false,
  );
}

/**
 * Keeps an empty state on screen while the note it asked for is being made.
 *
 * The note lands in the local copy before the view has moved to it, so for a moment the
 * account is no longer empty and the note is not open yet. Drawn as it is, that moment
 * shows whatever an account with a note and nothing open shows ("Select a note, or create
 * one." in the desktop's pane) for a frame, between the empty state and the note. So a
 * view that was drawing its empty state goes on drawing it until the note is open, and
 * only then, if the account still has notes, gives way. A note arriving from elsewhere
 * while nothing is being made here is not held for: the state leaves at once, as it should.
 *
 * What it drew last time is state set during the render, React's way of remembering the
 * previous render, rather than a ref written there: a render React throws away would still
 * have written the ref, and the hold would then follow a frame that never reached the
 * screen.
 */
export function useHoldWhileCreating(shown: boolean): boolean {
  const making = useCreatingNote();
  const [was, setWas] = useState(false);
  const held = shown || (making && was);
  if (held !== was) setWas(held);
  return held;
}
