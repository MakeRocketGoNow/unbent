import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as actions from './store/actions.js';
import { invalidateNoteMembership } from './queries.js';
import { markNewNote } from './useNewNote.js';

/**
 * What the New note controls do: make an empty note filed where it is asked to be, and
 * open it with the caret in its title.
 *
 * One action for every control that makes a note from the notes view — the desktop's New
 * button, the phone's floating +, and the empty state's New note — so they cannot drift
 * apart in how a note is made, how the lists hear of it or where it opens. It goes through
 * `actions.createNote`, so with no connection the note is made on the device and sent from
 * the outbox like any other write. `/notes?new=1` stays apart (`useNewNoteRequest`), for
 * the reason given there.
 *
 * The search params are kept on the way to the note: the list beside it is the list it was
 * made from.
 */
export function useCreateNote(): (filing: { tags: string[]; notebook: string | null }) => Promise<void> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async (filing) => {
    try {
      const created = await actions.createNote({
        // No name, rather than the literal string "Untitled". The title field's
        // placeholder already says that word, and a placeholder is not data: a stored
        // "Untitled" is written into the frontmatter of the exported markdown, sorted
        // under U by the title sort, and — titles being in the FTS index — returned by a
        // search for "untitled", all to say the note has no name yet. Android has always
        // created notes with an empty title; this is the web agreeing with it.
        title: '',
        body: '',
        tags: filing.tags,
        notebook: filing.notebook,
      });
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      invalidateNoteMembership(queryClient);
      // A new note starts with its name, so the title takes the caret rather than the
      // body. Recorded here, before navigating, because it is a fact about this note's
      // creation and the workspace it opens has no other way to know it.
      markNewNote(created.id);
      void navigate({ to: '/notes/$noteId', params: { noteId: created.id }, search: (p) => p });
    } catch (err) {
      console.error(err);
    }
  };
}
