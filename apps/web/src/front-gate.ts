import { redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { ensureSession } from './auth-client.js';
import { LOGIN } from './auth-gate.js';
import { configQuery } from './queries.js';

/**
 * The `beforeLoad` of a page that exists only on an instance with a front page: the
 * comparisons, for the rules `/why` and `/pricing` keep inline. A fork deployed unchanged
 * compares nobody's product with anything, so there it is the sign-in screen. The session
 * is asked for beside the config so the page draws once, with the right way out for
 * whoever is reading.
 */
export async function requireFrontPage({ context }: { context: { queryClient: QueryClient } }): Promise<void> {
  const [, config] = await Promise.all([
    ensureSession(),
    context.queryClient.ensureQueryData(configQuery()).catch(() => undefined),
  ]);
  if (!config?.frontPage) throw redirect({ to: LOGIN, replace: true });
}
