import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '../components/Workspace.js';
import { noteQuery } from '../queries.js';

/**
 * A trashed note, read-only.
 *
 * Autosave is off in this view: a note in the bin is a record of what was deleted, and
 * writing to it would be editing something the user believes is gone.
 */
export const Route = createFileRoute('/trash/$noteId')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(noteQuery(params.noteId)).catch(() => undefined),
  component: TrashedNoteRoute,
});

function TrashedNoteRoute() {
  const { noteId } = Route.useParams();
  return <Workspace noteId={noteId} readOnly />;
}
