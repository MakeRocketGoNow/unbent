import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { NotebookEditor } from '../components/NotebookEditor.js';
import { keys, notebookFieldCountsQuery } from '../queries.js';

/**
 * One notebook's custom fields.
 *
 * A page under Notebooks rather than a panel inside its row: a notebook can have a dozen
 * fields, each with a type and options, and the list of notebooks is a list, not a place
 * to unfold a form. The trailing underscore in the filename keeps this a sibling of the
 * notebooks page rather than its child — that page has no outlet, and this one wants the
 * settings layout around it, not the notebook list.
 */
export const Route = createFileRoute('/settings/notebooks_/$notebookId')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(notebookFieldCountsQuery(params.notebookId)),
  component: NotebookEditorRoute,
});

function NotebookEditorRoute() {
  const { notebookId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <NotebookEditor
      notebookId={notebookId}
      onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: keys.notebookFields(notebookId) });
        // The notebook list carries a name, field count and purpose, and every note row
        // shows its values.
        void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
        void queryClient.invalidateQueries({ queryKey: ['notes'] });
        void queryClient.invalidateQueries({ queryKey: ['note'] });
      }}
      // The notebook is gone; the list is where to be.
      onDeleted={() => void navigate({ to: '/settings/notebooks' })}
    />
  );
}
