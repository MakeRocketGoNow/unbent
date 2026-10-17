import { createFileRoute, redirect } from '@tanstack/react-router';
import { FRONT } from '../auth-gate.js';
import { PRICING_ANCHOR } from '../components/FrontPage.js';

/**
 * The pricing page Paddle's review asks for: the front page, scrolled to its prices.
 *
 * A redirect rather than a page, so there is one place that states the price. The root
 * route then does what it does for the bare root: someone signed in goes to their notes,
 * and an instance with no front page sends them to sign in, so a fork gets no pricing
 * page either. Public in `auth-gate.ts` (`PRICING`), for the reason given there.
 */
export const Route = createFileRoute('/pricing')({
  beforeLoad: () => {
    throw redirect({ to: FRONT, hash: PRICING_ANCHOR, replace: true });
  },
});
