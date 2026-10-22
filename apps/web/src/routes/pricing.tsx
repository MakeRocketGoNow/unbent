import { createFileRoute, redirect } from '@tanstack/react-router';
import { ensureSession } from '../auth-client.js';
import { LOGIN } from '../auth-gate.js';
import { configQuery } from '../queries.js';
import { PricingPage } from '../components/PricingPage.js';

/**
 * The pricing page a merchant of record's review asks for: the offer, on a page of its own.
 *
 * It began as a redirect to the front page's pricing section, and that was wrong twice
 * over: the bare root sends anyone signed in to their notes, so a signed-in person who
 * asked for pricing landed in their note list and read it as a bug, and a reviewer sent
 * to a marketing page and scrolled to a section had to trust the scroll. So this is a
 * page (`PricingPage`), shown to anyone, with one rule kept from the root: no front page,
 * no prices, and the sign-in screen instead, so a fork deployed unchanged advertises
 * nothing here either. Public through `shellFor` (`PRICING` in `auth-gate.ts`).
 *
 * The session is asked for alongside the config so the page draws once, with the right
 * way out for whoever is reading it, rather than drawing Sign in and then changing its
 * mind.
 */
export const Route = createFileRoute('/pricing')({
  beforeLoad: async ({ context }) => {
    const [, config] = await Promise.all([
      ensureSession(),
      context.queryClient.ensureQueryData(configQuery()).catch(() => undefined),
    ]);
    if (!config?.frontPage) throw redirect({ to: LOGIN, replace: true });
  },
  component: PricingPage,
});
