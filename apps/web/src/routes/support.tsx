import { createFileRoute, redirect } from '@tanstack/react-router';
import { ensureSession } from '../auth-client.js';
import { LOGIN } from '../auth-gate.js';
import { configQuery } from '../queries.js';
import { SupportPage } from '../components/SupportPage.js';

/**
 * Support: how to reach a person, and where receipts, refunds, sign-in, export and
 * deletion are handled (`SupportPage`).
 *
 * The pricing page's rules, for the pricing page's reasons: a page, not a doorway, so a
 * signed-in person who follows the link in a receipt reads it rather than landing in
 * their notes; public through `shellFor` (`SUPPORT` in `auth-gate.ts`), since the person
 * it is for may have no session, or no account any more; and on an instance with no front
 * page the sign-in screen instead, so a fork deployed unchanged publishes nobody else's
 * address. The session is asked for beside the config so the shell draws once, with the
 * right way out for whoever is reading.
 */
export const Route = createFileRoute('/support')({
  beforeLoad: async ({ context }) => {
    const [, config] = await Promise.all([
      ensureSession(),
      context.queryClient.ensureQueryData(configQuery()).catch(() => undefined),
    ]);
    if (!config?.frontPage) throw redirect({ to: LOGIN, replace: true });
  },
  component: SupportPage,
});
