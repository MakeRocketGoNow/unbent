import { useQuery } from '@tanstack/react-query';
import { operatorBackupsQuery } from './queries.js';

/**
 * Whether this session runs the instance, for the one control that depends on it: the
 * Operator tab in Settings.
 *
 * `/api/config` is public and answers before there is a session, so it cannot say who
 * is an operator; the operator routes answer anyone else as if they did not exist. So
 * the question is put to the one the page reads first, the backup's health, once per session
 * (`operatorBackupsQuery` does not ask again on a 404):
 * an answer means an operator, a 404 means not (the query keeps that as `null` for the
 * session), and anything else (offline, a 5xx) means not known yet, which draws
 * nothing until the query's own retry answers. The page itself reads the same query, so
 * the answer is not fetched twice.
 */
export function useOperator(): boolean {
  const { data } = useQuery(operatorBackupsQuery());
  // `null` is the route's 404, kept for the session; `undefined` is not known yet.
  return data !== undefined && data !== null;
}
