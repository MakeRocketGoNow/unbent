import { createFileRoute, redirect } from '@tanstack/react-router';
import { LOGIN } from '../auth-gate.js';
import { configQuery } from '../queries.js';
import { FrontPage, PRICING_ANCHOR } from '../components/FrontPage.js';

/**
 * The pricing page Paddle's review asks for: the front page, scrolled to its prices.
 *
 * The same page as the bare root rather than one of its own, so there is one place that
 * states the price. Two differences from `/`. It does not send someone signed in to their
 * notes: `/` is a doorway and that is the right answer there, but a person who asked for
 * the pricing page asked for a page, and their notes in its place read as a bug (it was
 * a redirect at first, and that is how it was reported). And it is not a redirect to
 * `/#pricing`, so the address in the review, a listing or a message stays the one the
 * person typed. What it keeps is the instance rule: no front page, no prices, and the
 * sign-in screen instead, so a fork deployed unchanged advertises nothing here either.
 * Public through `shellFor` (`PRICING` in `auth-gate.ts`).
 */
export const Route = createFileRoute('/pricing')({
  beforeLoad: async ({ context }) => {
    const config = await context.queryClient
      .ensureQueryData(configQuery())
      .catch(() => undefined);
    if (!config?.frontPage) throw redirect({ to: LOGIN, replace: true });
  },
  component: () => <FrontPage scrollTo={PRICING_ANCHOR} />,
});
