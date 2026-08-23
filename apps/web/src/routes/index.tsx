import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The bare root has no view of its own; `/notes` is the real home.
 *
 * Redirecting rather than rendering the list here means there is exactly one URL for the
 * note list, so links and history entries never disagree about what to call it.
 */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/notes', replace: true });
  },
});
