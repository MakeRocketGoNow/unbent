import { createFileRoute } from '@tanstack/react-router';
import { Maintenance } from '../components/Maintenance.js';
import { exactCountQuery } from '../queries.js';

/**
 * Both counts are warmed here so the buttons can name their blast radius on first paint
 * rather than flickering from "Trash is empty" to a real number. Exact rather than stored:
 * every number on this page is the size of something it is about to delete.
 */
export const Route = createFileRoute('/settings/maintenance')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(exactCountQuery({ trashed: true })),
      queryClient.ensureQueryData(exactCountQuery()),
    ]),
  component: Maintenance,
});
