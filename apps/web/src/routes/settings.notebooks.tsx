import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Settings } from '../components/Settings.js';
import { keys } from '../queries.js';

export const Route = createFileRoute('/settings/notebooks')({
  /*
   * `?new=1`: open the chooser of Blank and templates, as the rail's New notebook does. A
   * request rather than a state, like the notes page's `?new=1`: acted on once and
   * dropped, so Back or a reload does not reopen it. Only `1` counts.
   */
  validateSearch: z.object({ new: z.literal(1).optional().catch(undefined) }),
  component: NotebooksRoute,
});

function NotebooksRoute() {
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const handled = useCallback(() => void navigate({ search: {}, replace: true }), [navigate]);

  return (
    <Settings
      createRequested={search.new === 1}
      onCreateRequested={handled}
      onChanged={() => {
        // Renaming or deleting a notebook changes note membership and the sidebar counts,
        // so both the notebook list and every note list are stale.
        void queryClient.invalidateQueries({ queryKey: keys.notebooks() });
        void queryClient.invalidateQueries({ queryKey: ['notes'] });
      }}
    />
  );
}
