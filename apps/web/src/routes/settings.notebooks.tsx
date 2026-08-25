import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Settings } from '../components/Settings.js';
import { keys } from '../queries.js';

export const Route = createFileRoute('/settings/notebooks')({
  component: NotebooksRoute,
});

function NotebooksRoute() {
  const queryClient = useQueryClient();

  return (
    <Settings
      onChanged={() => {
        // Renaming or deleting a notebook changes note membership and the sidebar counts,
        // so both the notebook list and every note list are stale.
        void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
        void queryClient.invalidateQueries({ queryKey: ['notes'] });
      }}
    />
  );
}
