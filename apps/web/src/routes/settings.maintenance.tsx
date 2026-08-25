import { createFileRoute } from '@tanstack/react-router';
import { Maintenance } from '../components/Maintenance.js';
import { noteCountQuery, trashCountQuery } from '../queries.js';

/**
 * Both counts are warmed here so the buttons can name their blast radius on first paint
 * rather than flickering from "Trash is empty" to a real number.
 */
export const Route = createFileRoute('/settings/maintenance')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(trashCountQuery()),
      queryClient.ensureQueryData(noteCountQuery()),
    ]),
  component: Maintenance,
});
