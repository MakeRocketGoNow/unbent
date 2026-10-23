import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { REFUND_DAYS } from '@unbent/shared';
import { HOW_TO_DELETE } from '../auth-gate.js';
import { REFUNDS_ID } from '../legal/documents.js';
import { CARD_IMAGE, usePageMeta, type PageMeta } from '../page-meta.js';
import { configQuery } from '../queries.js';
import { FrontShell, SOURCE_URL } from './FrontPage.js';

/** What the tab and a link's card say this page is. */
export const SUPPORT_META: PageMeta = {
  title: 'Support · Unbent',
  description:
    'How to reach a person at Unbent, and where receipts, refunds, cancelling, sign-in, export and account deletion are handled.',
  image: CARD_IMAGE,
};

/** Where a bug or a feature request is filed: GitHub's chooser between the two forms. */
const ISSUES_URL = `${SOURCE_URL}/issues/new/choose`;
/** GitHub's private channel for a vulnerability, and the policy that says what to send. */
const ADVISORY_URL = `${SOURCE_URL}/security/advisories/new`;
const SECURITY_URL = `${SOURCE_URL}/blob/main/SECURITY.md`;

/**
 * Support, `/support`: how to reach a person, and where everything else is.
 *
 * Written for the reader a receipt sends here. Stripe is the merchant of record and its
 * receipts, renewal mails and the dashboard's public details carry a support address for
 * the business; before this page that address was a mailto: in the front page's footer,
 * which Stripe's form would not take and which opened a mail client on anyone who only
 * wanted to know how to cancel. So this is a page, and most of it is not contact at all
 * but the answer: the five things people write to a notes app about (the charge, signing
 * in, getting notes out, a bug, a vulnerability) and the one place each is handled, as a
 * link where the app has one. The address is still here, at the top, for everything the
 * page does not answer, and it is the operator's from the config, as the legal documents'
 * is, so a fork names its own.
 *
 * In the front page's shell and on the story's prose column, since it is read down once
 * rather than scanned, and public under the pricing page's rules (`routes/support.tsx`):
 * the person reading it may have no session, or no account any more.
 */
export function SupportPage() {
  const config = useQuery(configQuery());
  const email = config.data?.operator?.email;
  usePageMeta(SUPPORT_META);

  return (
    <FrontShell>
      <section className="front-hero front-width">
        <h1>Support</h1>
        <p className="front-lead">
          {email ? (
            <>
              Write to <a href={`mailto:${email}`}>{email}</a> from the address on your
              account. A person reads every message, and you will hear back within a few days.
            </>
          ) : (
            <>Most of what people ask about is handled in the app, and this page says where.</>
          )}
        </p>
      </section>

      <article className="front-story front-width">
        <Topic title="Receipts, refunds and cancelling">
          <p>
            Payments are taken by Stripe, which is the seller of record under its Link name:
            the receipt comes from Stripe, and on a card statement the charge begins with{' '}
            <code>LINK.COM*</code> and names Unbent.
          </p>
          <p>
            To change your card, download an invoice or cancel, open{' '}
            <Link to="/settings/plan">Settings, then Plan</Link>, and choose Manage
            subscription. Cancelling stops the next renewal and keeps everything until the year
            already paid for ends.
          </p>
          <p>
            Any charge is refunded in full if you ask within {REFUND_DAYS} days, and no reason
            is needed: write to us from the address the account uses, or use the support link
            in Stripe&apos;s receipt. The{' '}
            <Link to="/terms" hash={REFUNDS_ID}>
              refund policy
            </Link>{' '}
            is in the terms. If you stop paying, nothing is held hostage: the account turns
            read-only, and every note still opens, searches and exports.
          </p>
        </Topic>

        <Topic title="Signing in">
          <p>
            You sign in with a code sent to your email, with Google, or with a passkey. A code
            that does not arrive is usually in a spam folder, or went to a different address
            from the one the account was made with. If you have lost access to the address on
            your account, write to us and say what you can about it, and we will work out how
            to confirm it is yours.
          </p>
        </Topic>

        <Topic title="Your notes">
          <p>
            Your notes are yours. <Link to="/settings/export">Settings, then Export</Link>{' '}
            gives you every note as a Markdown file with its files beside it, at any time and
            for any reason. An Evernote export goes in whole from{' '}
            <Link to="/settings/import">Settings, then Import</Link>.
          </p>
          <p>
            To close your account, read{' '}
            <Link to={HOW_TO_DELETE}>Deleting your Unbent account</Link>: it says what is
            deleted, what is kept and for how long, and what to do if you cannot sign in.
          </p>
        </Topic>

        <Topic title="Bugs and ideas">
          <p>
            Unbent&apos;s code is public, and so is its issue tracker.{' '}
            <a href={ISSUES_URL} rel="noopener noreferrer">
              Report a bug or suggest a feature on GitHub
            </a>
            . Reports are public, so describe what happened without pasting a note; anything
            you would rather not post, send by email instead.
          </p>
        </Topic>

        <Topic title="Security">
          <p>
            If you find a vulnerability, please report it privately rather than in an issue,
            through{' '}
            <a href={ADVISORY_URL} rel="noopener noreferrer">
              GitHub&apos;s private vulnerability reporting
            </a>{' '}
            or by email. The{' '}
            <a href={SECURITY_URL} rel="noopener noreferrer">
              security policy
            </a>{' '}
            says what to include and when to expect a reply.
          </p>
        </Topic>
      </article>
    </FrontShell>
  );
}

/** A heading and the paragraphs under it, on the story's rhythm. */
function Topic({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
