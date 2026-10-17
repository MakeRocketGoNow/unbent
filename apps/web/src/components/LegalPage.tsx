import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { legalDocuments } from '../legal/documents.js';
import { LegalDoc } from './LegalDoc.js';
import { LegalLink } from './LegalLink.js';

/** Which of the three documents a route wants. */
export type LegalWhich = 'privacy' | 'terms' | 'deletion';

const TITLE: Record<LegalWhich, string> = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  deletion: 'Deleting your Unbent account',
};

/**
 * How each document is named in the two sentences below.
 *
 * Two forms rather than one because they sit in different grammar: "has not published *a
 * privacy policy*", but "*The privacy policy* is at". One string used in both produced "Its
 * a privacy policy is at", and terms are plural besides: "The terms *are* at".
 */
const NOUN: Record<LegalWhich, { indefinite: string; definite: string; verb: string }> = {
  privacy: { indefinite: 'a privacy policy', definite: 'The privacy policy', verb: 'is' },
  terms: { indefinite: 'terms of service', definite: 'The terms', verb: 'are' },
  deletion: {
    indefinite: 'a page about deleting an account',
    definite: 'The page about deleting an account',
    verb: 'is',
  },
};

/**
 * One of the three legal documents, in whichever of three states this instance is in.
 *
 * The documents are built from `/api/config` rather than imported as constants, because an
 * instance that has not said who runs it must not publish somebody else's legal entity
 * (see `legal/documents.ts`). That leaves three cases, and each of them is a page somebody
 * can arrive at from a store listing, so none may be an error:
 *
 * - The operator is named and the documents are the built-in ones: render them.
 * - The operator publishes their own elsewhere: say so and link onward. Deliberately not a
 *   redirect: an automatic bounce to another domain from a page a reviewer or a reader
 *   opened deserves a sentence first.
 * - Nothing is configured: say that too. This is the state a fresh checkout is in, and a
 *   blank page or a 404 would read as a broken app rather than an unconfigured one.
 *
 * Nothing renders while the config is loading. It is one cached request that the sign-in
 * screen has usually already made, and a flash of "not published" before the document
 * arrives would be worse than a moment of nothing.
 */
export function LegalPage({ which }: { which: LegalWhich }) {
  const config = useQuery(configQuery());

  if (config.isPending) return null;

  if (config.isError) {
    return (
      <article className="preview legal">
        <h1>{TITLE[which]}</h1>
        <p className="bad">Couldn&apos;t load this page. {(config.error as Error).message}</p>
        <BackToApp />
      </article>
    );
  }

  const { operator, legal } = config.data ?? {};
  // Built-in exactly when the server said so, which it only does for an instance that also
  // named an operator. Reading the link rather than re-deriving the rule keeps the two
  // halves from disagreeing about which documents this instance publishes.
  const builtIn = legal?.privacy.startsWith('/') ?? false;

  if (operator && builtIn) {
    // The documents describe an error-tracking service only where this instance has one, so
    // that a self-hosted policy does not name a third party it never contacts; and the
    // backups, with the ninety days a deletion takes to leave them, only where it keeps any;
    // and a price, its renewal and the refund policy only where the server says it sells a
    // plan: read from the link, like `builtIn` above, rather than worked out again from
    // `billing` and `frontPage`, so the terms drawn here and the server's sentence about a
    // change to them answer the same rule. See `LegalOptions.sellsPlan`. TypeSafe and
    // Anthropic, which an Auto-fill press sends a note to, only where a press can reach each.
    const docs = legalDocuments(operator, {
      errorTracking: Boolean(config.data?.posthog),
      backups: Boolean(config.data?.backups),
      sellsPlan: Boolean(legal?.sellsPlan),
      autofill: Boolean(config.data?.autofill),
      llm: Boolean(config.data?.llm),
    });
    return <LegalDoc doc={docs[which]} />;
  }

  // For terms, point at the terms; everything else has only the policy to offer.
  const elsewhere = builtIn ? undefined : which === 'terms' ? legal?.terms : legal?.privacy;

  return (
    <article className="preview legal">
      <h1>{TITLE[which]}</h1>
      <p>This instance has not published {NOUN[which].indefinite}.</p>
      {elsewhere && (
        <p>
          {NOUN[which].definite} {NOUN[which].verb} at{' '}
          <LegalLink href={elsewhere}>{elsewhere}</LegalLink>.
        </p>
      )}
      <BackToApp />
    </article>
  );
}

/* The same destination `LegalDoc` uses, and for the same reason: `/` sends each reader
   where they belong: notes, front page or sign-in. */
function BackToApp() {
  return (
    <p className="legal-back">
      <Link to="/">Back to Unbent</Link>
    </p>
  );
}
