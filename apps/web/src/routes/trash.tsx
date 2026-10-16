import { createFileRoute, Outlet } from '@tanstack/react-router';
import { TrashLayout } from '../components/TrashLayout.js';
import { trashQuery } from '../queries.js';

/**
 * Deleted notes, awaiting restore or permanent deletion.
 *
 * A path rather than the old `?trash=1` flag: the trash is a different view of different
 * records, not a filter over the same ones. It takes no notebook or tag filters: the
 * trash is a flat record of what was deleted, and a filter hiding the note someone is
 * hunting for would defeat the point of having it.
 */
export const Route = createFileRoute('/trash')({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureInfiniteQueryData(trashQuery()),
  component: () => (
    <TrashLayout>
      <Outlet />
    </TrashLayout>
  ),
});
