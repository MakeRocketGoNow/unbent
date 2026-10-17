import { Link } from '@tanstack/react-router';
import { TRIAL_DAYS } from '@unbent/shared';
import { useSession } from '../auth-client.js';
import { HOME, LOGIN } from '../auth-gate.js';
import { usePageMeta } from '../page-meta.js';
import { FrontShell, Pricing } from './FrontPage.js';

/** What the tab and a link's card say this page is. Prices stay out of it, so a change to them cannot leave a card wrong. */
export const PRICING_META = {
  title: 'Pricing · Unbent',
  description:
    'One plan, billed yearly, with a free trial that needs no card. If you stop paying, nothing is held hostage: every note still opens, searches and exports.',
  image: '/front/desktop-light.webp',
};

/**
 * unbent.app's pricing page, `/pricing`: the offer and nothing else.
 *
 * The front page states the price too, in a section a third of the way down a page that
 * is mostly about what Unbent is. Paddle's website review asks for a pricing page by
 * address and reads what is there; a page that is only the prices leaves it nothing to
 * find, and reads the same way to a person who followed a link that said "pricing". The
 * offer itself is `Pricing`, shared with the front page, so the two cannot disagree.
 *
 * Shown to signed-in people as well as signed-out ones, unlike the front page: a person
 * who asked for this page gets it. Only the way out changes with the session: a trial to
 * start, or the notes they already have. Prices are before tax because Paddle adds the
 * buyer's own at checkout (`tax_mode: location` on the catalog), and a page that stated a
 * price with no tax, to a buyer in a country that adds twenty percent, would be the
 * surprise the review exists to prevent.
 */
export function PricingPage() {
  const { data: session } = useSession();
  usePageMeta(PRICING_META);

  return (
    <FrontShell>
      <section className="front-hero front-width">
        <h1>Pricing</h1>
        <p className="front-lead">
          One plan, billed yearly, and a free trial that needs no card. Prices are in US
          dollars, before any sales tax or VAT your country adds at checkout.
        </p>
      </section>

      <section className="front-pricing-page front-width">
        <Pricing />
        <div className="front-cta">
          {session ? (
            <Link to={HOME} className="btn btn-secondary front-cta-button">
              Open your notes
            </Link>
          ) : (
            <>
              <Link to={LOGIN} className="btn btn-primary front-cta-button">
                Start your free trial
              </Link>
              <p className="muted">{TRIAL_DAYS} days free, no card needed.</p>
            </>
          )}
        </div>
      </section>
    </FrontShell>
  );
}
