import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The section root has no view of its own.
 *
 * An overview page here would be a list of four links directly beneath a sub-nav holding
 * the same four: a dead click on every visit. Notebooks is the landing child because it
 * is the only one visited repeatedly; maintenance should be arrived at deliberately.
 *
 * `replace` matters: without it, Back from Notebooks lands here and redirects forward
 * again, trapping the user in the section.
 */
export const Route = createFileRoute('/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/notebooks', replace: true });
  },
});
