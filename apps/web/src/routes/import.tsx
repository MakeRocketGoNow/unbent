import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Kept as a redirect: `/import` was in the topbar for the app's whole life, so a bookmark
 * or an open tab should land on the moved page rather than a blank 404.
 */
export const Route = createFileRoute('/import')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/import', replace: true });
  },
});
