import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Settings } from '../components/Settings.js';
import { notebooksQuery, keys } from '../queries.js';

/** Notebook management. A route rather than a toggle, so it survives a reload. */
export const Route = createFileRoute('/settings')({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(notebooksQuery()),
  component: SettingsRoute,
});

function SettingsRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return (
    <Settings
      onClose={() => void navigate({ to: '/notes' })}
      onChanged={() => {
        // Renaming or deleting a notebook changes note membership and the sidebar counts,
        // so both the notebook list and every note list are stale.
        void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
        void queryClient.invalidateQueries({ queryKey: ['notes'] });
      }}
    />
  );
}
