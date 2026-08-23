import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '../components/Workspace.js';
import { noteQuery } from '../queries.js';

/**
 * One open note.
 *
 * The loader deliberately does not throw `notFound()`. A note id arrives from shared
 * links and reloads long after the note was deleted, so a 404 is an expected outcome
 * rather than an exceptional one — the id stays in the URL so the link remains copyable
 * and retryable, and the workspace explains what happened. Throwing would replace the
 * whole view with an error page and lose the address.
 *
 * `ensureQueryData` is allowed to reject here only so the failure is cached; the
 * component reads the same query and renders the explanation.
 */
export const Route = createFileRoute('/notes/$noteId')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(noteQuery(params.noteId)).catch(() => undefined),
  component: NoteRoute,
});

function NoteRoute() {
  const { noteId } = Route.useParams();
  return <Workspace noteId={noteId} />;
}
