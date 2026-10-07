import { createFileRoute } from '@tanstack/react-router';
import { OperatorAccount } from '../components/OperatorAccount.js';
import { operatorAccountsQuery } from '../queries.js';

/**
 * One account, for the operator. A sibling of the operator page rather than its child —
 * the trailing underscore, as the notebook page under Notebooks — so the settings layout
 * is around it and the accounts table is not. The account's row comes from the list
 * query the page already holds; the store's own numbers and its dumps are read by the
 * component, since both are live and neither is worth waiting on before the page draws.
 */
export const Route = createFileRoute('/settings/operator_/$userId')({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(operatorAccountsQuery()),
  component: () => <OperatorAccount userId={Route.useParams().userId} />,
});
