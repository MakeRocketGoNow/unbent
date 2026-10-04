import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import * as actions from './store/actions.js';
import { invalidateNoteMembership } from './queries.js';
import { markNewNote } from './useNewNote.js';

/**
 * Answers `/notes?new=1` (see `filters` in routes/notes.tsx): makes an empty note and
 * opens it, as the New button does — the address an app's "New note" shortcut opens.
 *
 * Apart from the button's own `newNote` in `NotesLayout` on purpose, because the two
 * differ in what they may trust. The button files the note under the list on screen;
 * a request from the address files it nowhere, since any filter beside `new=1` is
 * whoever wrote the link's, and filing would make the notebook and tags it names — a
 * link in an email could fill an account with them.
 *
 * Once per request. The effect follows `asked` alone, so it runs again only when a new
 * request arrives; the ref covers StrictMode's second run of the same one. The request
 * is replaced in the history rather than added to, by the note when there is one and by
 * the list when the create fails, so Back does not land on it and a reload cannot make a
 * second — and a create that failed once does not fail in a loop.
 */
export function useNewNoteRequest(asked: 1 | undefined): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const answering = useRef(false);
  useEffect(() => {
    if (asked !== 1 || answering.current) return;
    answering.current = true;
    void (async () => {
      try {
        const created = await actions.createNote({ title: '', body: '', tags: [], notebook: null });
        await queryClient.invalidateQueries({ queryKey: ['notes'] });
        invalidateNoteMembership(queryClient);
        markNewNote(created.id);
        await navigate({
          to: '/notes/$noteId',
          params: { noteId: created.id },
          search: ({ new: _, ...p }) => p,
          replace: true,
        });
      } catch (err) {
        console.error(err);
        await navigate({ to: '/notes', search: ({ new: _, ...p }) => p, replace: true });
      } finally {
        answering.current = false;
      }
    })();
    // `navigate` and the client are stable; the request is what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
}
