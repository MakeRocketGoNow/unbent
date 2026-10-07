import { createFileRoute } from '@tanstack/react-router';
import { Operator } from '../components/Operator.js';
import { operatorAccountsQuery, operatorBackupsQuery } from '../queries.js';

/**
 * The operator's page (MAK-171, part 5). No guard here beyond the loader: both reads
 * answer a non-operator 404, so the page is an error for anyone who types the address,
 * and the tab that leads to it is drawn only for a session the first read answers.
 */
export const Route = createFileRoute('/settings/operator')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([queryClient.ensureQueryData(operatorBackupsQuery()), queryClient.ensureInfiniteQueryData(operatorAccountsQuery())]),
  component: Operator,
});
