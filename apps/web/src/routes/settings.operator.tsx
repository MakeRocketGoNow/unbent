import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
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
 * one. The loader parses that location with the route's own schema, because the router
 * hands it the search before `validateSearch` has run: read raw, `?q=%20acme` warmed a key
 * the page never read, and `?q=123` arrived as a number.
 */
const search = z.object({ q: z.string().trim().optional().catch(undefined) });

export const Route = createFileRoute('/settings/operator')({
  validateSearch: search,
  loader: ({ context: { queryClient }, location }) =>
    Promise.all([
      queryClient.ensureQueryData(operatorBackupsQuery()),
      queryClient.ensureInfiniteQueryData(operatorAccountsQuery(search.parse(location.search).q ?? '')),
    ]),
  component: OperatorRoute,
});

function OperatorRoute() {
  const { q = '' } = Route.useSearch();
  const navigate = Route.useNavigate();
  // `replace`: each settled pause in the field is not a page of its own to go Back through.
  const onSearch = useCallback((next: string) => void navigate({ search: next ? { q: next } : {}, replace: true }), [navigate]);
  return <Operator search={q} onSearch={onSearch} />;
}
