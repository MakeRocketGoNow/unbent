import { createFileRoute } from '@tanstack/react-router';
import { Maintenance } from '../components/Maintenance.js';
import { exactCountQuery } from '../queries.js';

/**
 * Both counts are warmed here so the buttons can name their blast radius on first paint
 * rather than flickering from "Trash is empty" to a real number. Exact rather than stored:
 * every number on this page is the size of something it is about to delete.
 *
 * Only when the page is actually opened. The link to it sits in the settings rail and in
 * the indexing status, and a hover preloads it; an exact count of every note reads each
 * one, 13k rows at 13k notes, for a pointer passing by.
 */
export const Route = createFileRoute('/settings/maintenance')({
  loader: ({ context: { queryClient }, preload }) =>
    preload
      ? undefined
      : Promise.all([
          queryClient.ensureQueryData(exactCountQuery({ trashed: true })),
          queryClient.ensureQueryData(exactCountQuery()),
        ]),
  component: Maintenance,
});
