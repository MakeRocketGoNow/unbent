import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { OPERATOR_SEARCH_MAX } from '@unbent/shared';
import { Operator } from '../components/Operator.js';
import { operatorAccountsQuery, operatorBackupsQuery } from '../queries.js';

/**
 * The operator's page (MAK-171, part 5). No guard here beyond the loader: both reads
 * answer a non-operator 404, so the page is an error for anyone who types the address,
 * and the tab that leads to it is drawn only for a session the first read answers.
 *
 * `?q=` is the accounts search, in the address so that Back from an account's page comes
 * back to the same search, and a search can be reloaded or sent. Not among the loader's
 * dependencies, as the notes page's `q` is not: the router changes nothing in the address
 * until a dependency's loader resolves, so every pause in the field would have waited on
 * D1 before the search took. The loader reads it from the location instead, so a reload
 * or a link with a search opens on its answer; after that the page's query fetches each
 * one: a change of `q` alone keeps this route's match, and the router does not run its
 * loader again for that. The loader parses the location with the route's own schema,
 * because the router hands it the search before `validateSearch` has run: read raw,
 * `?q=123` arrived as a number the page's schema discards.
 */
// Not trimmed here: the field is controlled by `q`, and a trim would eat the space
// between two words as it was typed. The page and the loader trim what they ask for.
// Cut rather than refused past `OPERATOR_SEARCH_MAX`, as the server cuts it, so a long
// hand-made link searches for its start instead of opening on every account.
const search = z.object({ q: z.string().transform((q) => q.slice(0, OPERATOR_SEARCH_MAX)).optional().catch(undefined) });

export const Route = createFileRoute('/settings/operator')({
  validateSearch: search,
  loader: ({ context: { queryClient }, location }) =>
    Promise.all([
      queryClient.ensureQueryData(operatorBackupsQuery()),
      queryClient.ensureInfiniteQueryData(operatorAccountsQuery((search.parse(location.search).q ?? '').trim())),
    ]),
  component: OperatorRoute,
});

function OperatorRoute() {
  const { q = '' } = Route.useSearch();
  const navigate = Route.useNavigate();
  // `replace`: each keystroke in the field is not a page of its own to go Back through.
  // `resetScroll: false`: the router scrolls `.settings` to its top after every navigation
  // otherwise (`scrollToTopSelectors` in main.tsx), and the field sits below the health
  // cards, so each letter typed threw the page, and the field, back up out of view.
  const onSearch = useCallback(
    (next: string) => void navigate({ search: next ? { q: next } : {}, replace: true, resetScroll: false }),
    [navigate],
  );
  return <Operator search={q} onSearch={onSearch} />;
}
