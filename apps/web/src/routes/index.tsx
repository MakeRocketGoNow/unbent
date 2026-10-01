import { createFileRoute, redirect } from '@tanstack/react-router';
import { ensureSession } from '../auth-client.js';
import { HOME, LOGIN } from '../auth-gate.js';
import { configQuery } from '../queries.js';
import { FrontPage } from '../components/FrontPage.js';

/**
 * The bare root: a doorway for most people, and a page for one.
 *
 * Signed in, it is `/notes`, as it always was — redirected rather than rendered, so there
 * is exactly one URL for the note list and links and history never disagree about what to
 * call it.
 *
 * Signed out, it depends on the instance. The public one (`frontPage` in `/api/config`)
 * shows what Unbent is, what it costs and the way in; somebody arriving from a link to
 * unbent.app used to meet a sign-in form and nothing else. Every other instance sends them
 * to the sign-in screen, because the page states the public instance's prices and a fork
 * deployed unchanged must not publish somebody else's offer. A config that will not load
 * counts as "no front page": the sign-in screen is the one page every instance has.
 *
 * The session is asked first, so a signed-in visit never waits on the config.
 */
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    if (await ensureSession()) throw redirect({ to: HOME, replace: true });
    const config = await context.queryClient
      .ensureQueryData(configQuery())
      .catch(() => undefined);
    if (!config?.frontPage) throw redirect({ to: LOGIN, replace: true });
  },
  component: FrontPage,
});
