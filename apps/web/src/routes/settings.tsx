import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SettingsLayout } from '../components/SettingsLayout.js';
import { notebooksQuery } from '../queries.js';

/**
 * Everything that configures the app, behind one topbar entry.
 *
 * The loader sits on the layout rather than the notebooks child so entering the section
 * from any page has the notebook list warm — it is the landing child, and the one page
 * here anyone visits repeatedly.
 */
export const Route = createFileRoute('/settings')({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(notebooksQuery()),
  component: () => (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  ),
});
