/**
 * The privacy policy, terms and deletion page, as data.
 *
 * Kept out of the components that render them because the text is the part that changes,
 * and it changes for legal reasons rather than layout ones: a paragraph should be
 * editable without reading JSX. One renderer walks all three; see `LegalDoc.tsx`.
 *
 * Built for an operator rather than exported as constants, which is the change that made
 * this repository publishable. The documents used to name unbent.app's own operator and
 * contact address from constants at the top of this file, so every self-hosted copy served
 * them on somebody else's site, a legal claim that operator never made and could not stand
 * behind. Now the server says who runs the instance and these are
 * filled in, or it says nobody does and the pages say so instead. See `LegalPage.tsx` for
 * the three states and `lib/instance.ts` on the server for where the answer comes from.
 *
 * Two things stay literal, and an operator they do not fit should publish their own
 * documents and point `LEGAL_PRIVACY_URL` and `LEGAL_TERMS_URL` at them: the policy says
 * the service is hosted in the United States, and the terms are governed by Minnesota law.
 * Both are facts about a jurisdiction rather than a name to substitute, and a variable
 * holding "Minnesota" would produce a governing-law clause nobody had read.
 *
 * "Unbent" stays throughout. It is the name of this software, not of whoever runs it.
 *
 * Adapted from the same documents on pushthat.link. Where the boilerplate said something
 * untrue of a notes app it was rewritten rather than kept for symmetry: the privacy policy
 * in particular describes what is actually stored, since that is the half a store listing
 * is answerable for.
 *
 * What it deliberately does not say: which vendors host it, which products store what, or
 * how the code keeps accounts apart. A reader needs to know the country their data sits
 * in and who else can see it; naming the stack tells them nothing they can act on and
 * tells everyone else how the service is built. So it is "our hosting provider" and "an
 * email delivery service", and the operator's postal address is not here at all.
 */

import { INACTIVE_KEPT_DAYS, OWN_FILES_TO_READ, REFUND_DAYS, type AppConfig } from '@unbent/shared';

export interface LegalSection {
  heading?: string;
  /** Paragraphs, rendered in order. */
  body?: string[];
  /** A bulleted list, after the paragraphs. */
  list?: string[];
  /**
   * A numbered list, after the paragraphs: instructions to follow in order, rather than
   * facts that happen to be enumerated.
   *
   * Separate from `list` because the distinction is the reader's, not the renderer's: a
   * bullet says "these are the things", a number says "do this, then this". The deletion
   * page is the reason it exists, where Play requires the steps be prominent and a
   * four-item bulleted list reads as a description of the process rather than the process.
   */
  steps?: string[];
  /**
   * The section's anchor, for a link that has to land on it rather than on the document.
   *
   * Only the refund policy has one, so that `/terms#refunds` can be handed to a merchant
   * of record's review (Paddle's asked for it by address; Stripe's reads the same) or put
   * in a reply to someone asking. It is a section of the terms rather than a page of its
   * own because a refund is a term of the sale. Deliberately not linked from the footer: a
   * Refunds link beside Terms reads as an invitation to leave, and a review accepts terms
   * that contain the policy.
   */
  id?: string;
}

export interface LegalDocument {
  title: string;
  /** ISO date, formatted for display by the renderer. */
  effective: string;
  /** Sits above the first heading, in slightly larger type. */
  intro: string[];
  sections: LegalSection[];
}

/** Who the documents name. `AppConfig['operator']`, minus the "not configured" case. */
export type Operator = NonNullable<AppConfig['operator']>;

/** What else this instance does that the documents have to account for. */
export interface LegalOptions {
  /**
   * Whether errors in the browser are sent to an error-tracking service.
   *
   * Off for a self-hosted instance, which sends them only to its own logs, and its policy
   * must not describe a third party it does not use. See `posthog.ts`.
   */
  errorTracking: boolean;
  /**
   * Whether this instance keeps backups of its own: the daily dumps and, on unbent.app,
   * the nightly copy to a second account (MAK-171; "Durability" in docs/architecture.md).
   *
   * `AppConfig.backups`, true where a backups bucket is bound. The policy and the deletion
   * page describe those copies and the three months a deletion takes to leave them only
   * where they exist; a fork with no bucket keeps the shorter text, which is true of it.
   */
  backups: boolean;
  /**
   * Whether this instance sells a plan: it has billing on (`AppConfig.billing`, where the
   * Stripe secrets are set, MAK-108), or it shows the front page (`AppConfig.frontPage`),
   * which states the price.
   *
   * The front page counts on its own because a price on offer is a sale the terms have to
   * cover, whether or not checkout works yet, and because a merchant of record's review
   * reads the terms for a refund policy before it issues the live keys that turn billing
   * on (Paddle's did, and Stripe's Managed Payments review reads the same). Billing alone
   * left unbent.app unable to pass the review that billing waits on.
   *
   * The terms say what is charged, how it renews, how to cancel and the refund policy, and
   * the policy names Stripe, only where there is a sale. A self-hosted instance charges
   * nothing, and terms describing a price and a payment processor it never uses would be a
   * promise about a sale that cannot happen.
   */
  sellsPlan: boolean;
  /**
   * Whether this instance offers Auto-fill (`AppConfig.autofill`), which sends the note it
   * is pressed on to TypeSafe for Jev to choose its notebook, tags and field values.
   *
   * Named, unlike the hosting provider or the email service, because what goes is the note
   * itself, and someone deciding whether to press the button needs to know who reads it.
   * Off for an instance with no Jev key, which sends nothing anywhere (MAK-230).
   */
  autofill: boolean;
  /**
   * Whether an Auto-fill press also asks Anthropic's model to read the note's pictures and
   * text-less scans and to write its title and text fields (`AppConfig.llm`). Only ever
   * true beside `autofill`: an instance can have the Jev key and no Anthropic key, and its
   * policy must not name a company it never contacts.
   */
  llm: boolean;
}

/** The refund policy's anchor in the terms: `/terms#refunds`. See `LegalSection.id`. */
export const REFUNDS_ID = 'refunds';

/** How long a lapsed account is kept, as the sentence says it. */
const KEPT = INACTIVE_KEPT_DAYS === 365 ? 'a year' : `${INACTIVE_KEPT_DAYS} days`;

/** How many files an Auto-fill press reads, as the sentence says it. */
const READ_AT_A_PRESS =
  ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][OWN_FILES_TO_READ] ??
  String(OWN_FILES_TO_READ);

const EFFECTIVE = '2026-10-22';

/**
 * How many "other kinds of service" the policy lists, as the word the sentence needs. Two
 * always (sign-in, email); error tracking, the backups' GitHub job, Stripe, and Auto-fill's
 * TypeSafe and Anthropic each add one.
 */
const COUNT = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'] as const;

/**
 * The privacy policy's own date, moved when its terms change: "How long it is kept"
 * changed on 5 October 2026, when deleted files began staying in storage for thirty-five
 * days, and again on 8 October 2026, when the backups were described (both MAK-171),
 * without moving the terms', which did not. The deletion page restates the policy's
 * retention terms, so it carries this date too.
 *
 * Both dates moved on 9 October 2026 (MAK-209), when the policy gained its section on
 * cookies, its California paragraph and the record of agreement, and both documents began
 * saying how a change is put to people. That is also the first `LEGAL_VERSION`, which is
 * the version people agree to; it moves only for a change worth asking everyone about,
 * and these dates move for every change. `documents.test.ts` checks neither is older.
 *
 * Both moved again on 14 October 2026, when the terms gained the plan, its renewal and
 * the refund policy, and the policy named the merchant of record, Paddle at the time
 * (MAK-108). `LEGAL_VERSION` moved with them only where the instance sells a plan: those
 * sections are drawn only there (`LegalOptions.sellsPlan`), and an instance that sells
 * none stays on the version before (`LEGAL_CHANGES` in `@unbent/shared`). The dates are
 * one pair for every instance all the same, so on such an instance the date above the
 * unchanged text moves and the version does not: the documents' rule that the dates move
 * for every change and the version only for one worth asking about, seen from the other
 * side.
 *
 * The policy's moved again on 16 October 2026, for two disclosures of what was already so:
 * that the checkout sets cookies of its own once Subscribe is pressed, and that an
 * app connected to the account reads and writes notes as its owner does. Neither changed
 * how information is handled, so `LEGAL_VERSION` stayed; the terms' date moved the same
 * day for the venue clause, which is not a reason to ask anyone again either.
 *
 * The same day it gained what Auto-fill sends, to TypeSafe and to Anthropic, and what each
 * keeps (MAK-230). That is how information is handled, and the policy people had agreed
 * to was silent on it, so the version moved with it, where the instance offers Auto-fill
 * (`LegalOptions.autofill`): only there is the text drawn, as with the plan's.
 *
 * It moved on 19 October 2026 for the feedback a connected assistant can send about the
 * tools (MAK-212). The version did not: it is a note an app the person chose to connect
 * writes about our tools, told to leave their notes out of it, which is closer to the
 * connected-app disclosure of the 16th than to Auto-fill sending a note to someone else.
 *
 * It moved on 20 October 2026 because the settings tab it names for disconnecting an app
 * was renamed from Connected apps to AI assistants. Nothing about how information is
 * handled changed, so the version did not.
 *
 * Both moved on 22 October 2026, when the merchant of record changed from Paddle to
 * Stripe before any sale (docs/billing.md says why). The version moved with them, where
 * the instance sells a plan: a different company receives the name, address and card at
 * checkout and holds the record of the purchase, which is how information is handled,
 * and the policy people had agreed to named the other one.
 */
const PRIVACY_EFFECTIVE = '2026-10-22';

export interface LegalDocuments {
  privacy: LegalDocument;
  terms: LegalDocument;
  deletion: LegalDocument;
}

/**
 * The three documents, written for the operator publishing them.
 *
 * A function rather than three constants because the operator is not known until the
 * server answers, and because there is no honest default for it; see the header. Cheap
 * enough to call on every render: it builds three object literals and nothing else.
 */
export function legalDocuments(operator: Operator, opts: LegalOptions): LegalDocuments {
  const privacy: LegalDocument = {
    title: 'Privacy Policy',
    effective: PRIVACY_EFFECTIVE,
    intro: [
      `This policy describes what Unbent collects, why, and what happens to it. Unbent is a ` +
        `notes application: a website at ${operator.host} and Android and iOS apps that talk to it. It is ` +
        `operated by ${operator.name}.`,
      `The short version: your notes are yours, nothing is sold or shared for advertising, ` +
        `nothing tracks you or builds a profile of you, and you can export or delete ` +
        `everything at any time without asking anyone.`,
    ],
    sections: [
      {
        heading: 'What we collect',
        body: [
          'Only what running the service requires. There is no advertising network, no profile ' +
            'built from how you use the app, and nothing that can follow you to another site.',
          'We do count page views, so that we know which parts of Unbent are worth working on. ' +
            'It is aggregate and anonymous: no cookie is set, no identifier is assigned to you, ' +
            'and nothing about it is tied to your account or to anything you write. It cannot ' +
            'tell us that a particular person visited a particular page, and we could not ' +
            'reconstruct that if we wanted to. Visitors from the European Union are excluded ' +
            'from it altogether: nothing is counted for them at all.',
          ...(opts.errorTracking
            ? [
                'When something in the app goes wrong, a report of the error is sent to an ' +
                  'error-tracking service so that it can be fixed: the message, where in the ' +
                  'code it happened, and the shape of the page you were on with any note ' +
                  'identifier removed. No cookie is set and no identifier is assigned to you, ' +
                  'it is not tied to your account, and it never contains what a note says. If ' +
                  'your browser sends a Do Not Track signal, nothing is sent at all.',
              ]
            : []),
        ],
        list: [
          'Account details — your email address, and the name and profile image your sign-in ' +
            'provider gives us if you use one. A password is stored only if you set one, and only ' +
            'as a hash. Passkeys are stored as public keys, which cannot be used to sign in as you ' +
            'anywhere else.',
          'Your agreement — which version of the Terms of Service and this policy you agreed ' +
            'to, and when, so that we can show what you agreed to and ask again when they change.',
          'Session records — for each device you sign in from, we store the IP address and browser ' +
            'user agent alongside the session, so that a session can be identified and revoked. ' +
            'Sessions expire after thirty days of disuse.',
          'Your content — the notes you write, their titles, tags and notebooks, and any files you ' +
            'attach. Text extracted from PDFs you upload, so that searching finds words inside them' +
            (opts.autofill && opts.llm
              ? ', and what Auto-fill reads off a picture or a scan when you press it.'
              : '.'),
          ...(opts.autofill
            ? [
                'Your use of Auto-fill — how many times you have pressed it, and how much work each ' +
                  'press took, so that its limits can be applied.',
              ]
            : []),
          'Feedback from your assistant — if an app you have connected uses its feedback tool to ' +
            'tell us about a problem with our tools, what it wrote, which app sent it and from which ' +
            'account, so that we can improve them. The app is told never to include anything from ' +
            'your notes. Feedback is kept for ninety days, and goes sooner if the account is deleted.',
          ...(opts.sellsPlan
            ? [
                'Your plan — whether the account is on a trial or a plan, when that ends, how much ' +
                  'storage it includes, and the identifiers Stripe gives your customer record and ' +
                  'subscription, so that the two can be matched. Your card and billing address go ' +
                  'to Stripe and never reach us.',
              ]
            : []),
          'Nothing else. We do not collect your location, your contacts, your device identifiers, ' +
            'or anything from other apps.',
        ],
      },
      {
        heading: 'How it is used',
        body: [
          'To run the service and nothing else: to show you your notes, to search them, to sync ' +
            'between your devices, and to sign you in. Email is used to reach you about your own ' +
            'account: a sign-in code, a password reset, a verification link' +
            (opts.sellsPlan ? ', and word that a trial or a plan has ended' : '') +
            '. There is no marketing mail, and no newsletter to unsubscribe from.',
          ...(opts.autofill
            ? [
                'Auto-fill suggests where a note belongs and what its fields say. It is the one ' +
                  'thing that sends what a note says to another company for it to read, and it does ' +
                  'so only when you press it, for that note alone, never when you upload or in the ' +
                  'background. The services that answer it are named below, with what each receives.',
              ]
            : []),
          'We do not sell personal information, and we do not share it for advertising or for ' +
            'anyone else to build a profile from.',
          'If you connect another app to your account, such as an assistant, it can read and ' +
            'change your notes as you can, for as long as it stays connected. That is your ' +
            'choice, made when the app asks and undone from Settings, then AI assistants. ' +
            'What that app does with what it reads is governed by its own policy, not this one.',
        ],
      },
      {
        heading: 'Where it is stored, and who else touches it',
        body: [
          'Unbent is hosted in the United States. Your notes, files and account records are ' +
            'stored with our hosting provider there, which also keeps ordinary request logs, as ' +
            'any web host does. Text inside PDFs you upload is extracted on those same systems ' +
            (opts.autofill
              ? 'so that search can find it, and so that Auto-fill can read it when you press it.'
              : 'so that search can find it; the file is used for that and nothing else.'),
          `${COUNT[2 + Number(opts.errorTracking) + Number(opts.backups) + Number(opts.sellsPlan) + Number(opts.autofill) + Number(opts.autofill && opts.llm)]} other kinds of service ` +
            `are involved, each for one narrow job:`,
        ],
        list: [
          'A sign-in provider, if you choose to sign in with one (Google or Apple, for example). The ' +
            'provider tells us your email address, name and profile image; we tell it nothing ' +
            'about your notes.',
          'An email delivery service, for the messages described above: sign-in codes, password ' +
            'resets, verification links. It sees your email address and the contents of those ' +
            'messages, which never include your notes.',
          ...(opts.errorTracking
            ? [
                'An error-tracking service, which receives the error reports described above ' +
                  'and nothing else. It never sees your notes, your files or your address.',
              ]
            : []),
          ...(opts.backups
            ? [
                'GitHub, whose servers run the nightly job that copies our backups (your notes, ' +
                  'your files and our sign-in records) to a second account with our hosting ' +
                  'provider, as described under “How long it is kept”. The copy passes through ' +
                  'those servers on the way and none of your content is kept on them.',
              ]
            : []),
          ...(opts.sellsPlan
            ? [
                'Stripe, which sells the plan as merchant of record through its Managed Payments ' +
                  'service, under its Link name. When you start a checkout we give it your ' +
                  'account’s email address and an identifier for the account, so the purchase can ' +
                  'be matched to it; it then collects your name, billing address and payment ' +
                  'details on its own page, under its own privacy policy, and tells us only ' +
                  'whether the account is paid for, until when, and how much storage it ' +
                  'includes. It never sees your notes.',
              ]
            : []),
          ...(opts.autofill
            ? [
                'TypeSafe, whose model chooses a notebook, tags and field values for a note when you ' +
                  'press Auto-fill on it, and at no other time. It receives that note’s title, its ' +
                  'text, and the names and text of its files, and the names of your notebooks, tags ' +
                  'and fields, with a notebook’s purpose if you wrote one, a field’s options, and a ' +
                  'few titles of notes already filed under each. It does not use what it receives to ' +
                  'train any model, and keeps it under its own privacy policy, in the United States.',
              ]
            : []),
          ...(opts.autofill && opts.llm
            ? [
                'Anthropic, whose model reads the pictures and text-less scans in a note when you ' +
                  'press Auto-fill on it, and writes a title and text field values from what the ' +
                  `note says, and at no other time. It receives up to ${READ_AT_A_PRESS} of that note’s files to ` +
                  'read, the note’s title and text with the names and text of its files, and the ' +
                  'names of the fields it is asked to fill. It does not use what it receives to ' +
                  'train its models, and deletes it within thirty days, except where its own terms ' +
                  'require keeping something longer, such as to investigate misuse.',
              ]
            : []),
        ],
      },
      {
        heading: 'Cookies, and what is kept on your device',
        body: [
          'Unbent sets one kind of cookie: the one that keeps you signed in. There are no ' +
            'advertising, analytics or tracking cookies, and no other company sets a cookie ' +
            'or stores anything on your device through Unbent' +
            (opts.sellsPlan
              ? ', with one exception: when you press Subscribe, you are taken to Stripe’s own ' +
                'checkout page, which sets cookies of its own, under its own policy, for the ' +
                'purchase. Nothing of Stripe’s loads on our pages.'
              : '.'),
          'Because all of it is needed to give you the service you asked for, none of it needs ' +
            'your consent, and there is no cookie banner to dismiss. Clearing this site’s data ' +
            'in your browser removes all of it, and signs you out.',
          'What Unbent keeps on your device is there to run the app for you, and nothing else:',
        ],
        list: [
          'A sign-in cookie, and beside it a short-lived signed copy of your session, so that ' +
            'every page does not have to look it up again. Both are removed when you sign out.',
          'Your notes, notebooks and tags, and the files you open or choose to keep offline, in ' +
            'your browser’s own storage, so that the app opens and works without a connection. ' +
            'They are removed from the device when you sign out.',
          'The app itself, so that it loads with no connection.',
          'Your preferences on this device, such as how wide the sidebar is or how notebooks are ' +
            'sorted, and which account was last signed in here, so that losing your connection ' +
            'is not mistaken for signing out.',
        ],
      },
      {
        heading: 'Getting your data out',
        body: [
          'Settings has an Export that streams your entire account as a zip of ordinary Markdown ' +
            'files with your attachments beside them. It is a plain folder tree that any unzip ' +
            'program reads, and nothing in this app is needed to open it. There is no limit on how ' +
            'often you may use it.',
        ],
      },
      {
        heading: 'Deleting your account',
        body: [
          'Settings, then Maintenance, has a Delete account control. Pressing it sends a ' +
            'confirmation link to your email address; the account is deleted only when you open ' +
            'that link and confirm, so a stray press deletes nothing. The link works once and ' +
            'expires in a day.',
          'Deleting removes your notes, files, tags, notebooks, passkeys, linked sign-in accounts ' +
            'and the account record itself. It cannot be undone and there is no export afterwards, ' +
            'so take one first if any of it matters.',
          `If you cannot sign in to delete the account yourself, write to ${operator.email} from ` +
            `the address on the account and we will do it for you.`,
        ],
      },
      {
        heading: 'How long it is kept',
        body: [
          'Your notes stay until you delete them. Deleting a note moves it to trash, where it stays ' +
            'until you empty the trash, at which point the note is gone for good. Files you ' +
            'delete, from a note or with it, are removed from our storage about 35 days later. ' +
            'Everything else is kept for as long as the account exists, and removed when it is ' +
            'deleted. Sent email may persist for a short period in our email provider’s own logs.',
          ...(opts.backups
            ? [
                'We also keep backups, so that a fault on our side can be put right: a daily copy ' +
                  'of each account’s notes, kept for 14 days, and a nightly copy of those, of every ' +
                  'file, and of our sign-in records, which include your email address, in a second ' +
                  'account with our hosting provider, kept for up to 90 days. A note, a file or an ' +
                  'account you delete leaves every one of them within about three months. They are ' +
                  'for restoring the service after a fault, not a way to bring one note back; keep ' +
                  'an export for that.',
              ]
            : []),
          ...(opts.autofill
            ? [
                'What an Auto-fill press sends is kept by the service that receives it as described ' +
                  'above, not by us, and deleting the note or the account here does not reach it.',
              ]
            : []),
          ...(opts.sellsPlan
            ? [
                `An account whose trial or plan has ended is kept, read-only, for ${KEPT}, ` +
                  `and may then be deleted, after we have emailed you to export it first. Stripe ` +
                  `keeps its own record of what you bought for as long as tax law requires.`,
              ]
            : []),
        ],
      },
      {
        heading: 'Your rights',
        body: [
          'You can see, correct, export and delete your information yourself, from within the app, ' +
            'without asking us. If you are in Europe or the United Kingdom, the same rights apply ' +
            'to you under the GDPR, along with the right to object to processing and to complain to ' +
            'your data protection authority; we process your information in order to provide the ' +
            'service you asked for. Note that your information is stored in the United States.',
          'If you are in California, you have the right to know what personal information we ' +
            'collect and how it is used, to have it corrected or deleted, and not to be treated ' +
            'differently for asking. Everything this policy describes applies to you. We do not ' +
            'sell or share your personal information, as California law uses those words, and ' +
            'we have not done so in the past twelve months.',
          `For anything you cannot do from the app, write to ${operator.email}.`,
        ],
      },
      {
        heading: 'Security',
        body: [
          'Connections use HTTPS. Passwords, where they exist, are stored hashed, and each ' +
            'account’s data is kept separate from every other’s. No system is perfectly secure, ' +
            'and we do not claim otherwise.',
        ],
      },
      {
        heading: 'Children',
        body: [
          'Unbent is not intended for children under 13, and we do not knowingly collect their ' +
            'information. If you believe a child has created an account, write to us and we will ' +
            'remove it.',
        ],
      },
      {
        heading: 'Do Not Track and Global Privacy Control',
        body: [
          'There is nothing to honour or ignore: Unbent does not track you across websites, with or ' +
            'without a Do Not Track signal. A Global Privacy Control signal asks a site not to sell ' +
            'or share your information, which Unbent never does, so it changes nothing either.',
          ...(opts.errorTracking
            ? [
                'The one thing that does read it is error reporting, which is switched off ' +
                  'entirely when the signal is present.',
              ]
            : []),
        ],
      },
      {
        heading: 'Changes',
        body: [
          'If this policy changes, the effective date above changes with it. When the change ' +
            'affects how your information is handled, you will be asked to agree to the new ' +
            'version in the app before you go on using it, and if you do not, you can still ' +
            'export your notes and delete your account.',
        ],
      },
      {
        heading: 'Contact',
        body: [
          `Questions, requests or complaints about privacy go to ${operator.email}.`,
        ],
      },
    ],
  };

  const terms: LegalDocument = {
    title: 'Terms of Service',
    effective: EFFECTIVE,
    intro: [
      `These terms govern your use of Unbent, a notes service consisting of the website at ` +
        `${operator.host} and its Android and iOS apps, operated by ${operator.name}. You agree to them, ` +
        `and to the Privacy Policy, when the app asks you to before you first use it. If you do ` +
        `not agree, please do not use it.`,
    ],
    sections: [
      {
        heading: 'The service',
        body: [
          'Unbent stores notes and files you choose to put into it, and lets you search and ' +
            'organise them from a browser, an Android phone or an iPhone. We may add, change or remove ' +
            'features, and we may stop offering the service altogether. If we discontinue it we ' +
            'will give you reasonable notice and time to export your notes.',
          'The service is provided as it is. We do not promise it will be uninterrupted or ' +
            'error-free, and you should keep your own copies of anything you cannot afford to ' +
            'lose. Settings has an Export for exactly that purpose.',
        ],
      },
      {
        heading: 'Your account',
        body: [
          'You must be old enough to enter a binding contract where you live, and at least 13. You ' +
            'are responsible for what happens under your account and for keeping your sign-in ' +
            'method secure. Tell us promptly if you believe someone else has access to it.',
          'Accounts are for people. Do not share one, and do not create an account on someone ' +
            'else’s behalf without their knowledge.',
        ],
      },
      ...(opts.sellsPlan ? payment(operator) : []),
      {
        heading: 'Your content is yours',
        body: [
          'You keep every right you have in the notes and files you put into Unbent. We claim no ' +
            'ownership of them. You give us only the permission needed to run the service for you: ' +
            'to store your content, transmit it to your own devices, index it so you can search it, ' +
            'and back it up. Nothing here lets us publish your notes, show them to anyone else, or ' +
            'use them to train anything.',
          'You are responsible for what you store, and for having the right to store it.',
        ],
      },
      {
        heading: 'Acceptable use',
        body: ['Do not use Unbent to:'],
        list: [
          'break the law, or store material that is illegal to possess;',
          'store or distribute material that sexually exploits children;',
          'infringe someone else’s copyright, trademark or other rights;',
          'distribute malware, or use the service to attack anyone;',
          'harass, threaten or impersonate another person;',
          'send unsolicited bulk email or other spam;',
          'attempt to access another account, or any part of the system you were not given access ' +
            'to;',
          'interfere with the service’s operation, including by overwhelming it with automated ' +
            'requests.',
        ],
      },
      {
        heading: 'Moderation',
        body: [
          'Unbent is private storage, not a publishing platform. We do not read your notes, and we ' +
            'do not monitor them. We may access account information or content where we genuinely ' +
            'need to in order to comply with the law, to respond to a valid legal request, to ' +
            'investigate a suspected violation of these terms, to answer a support request you have ' +
            'made, or to protect the safety of anyone.',
        ],
      },
      {
        heading: 'Ending it',
        body: [
          'You may delete your account at any time, from Settings, then Maintenance. We email a ' +
            'confirmation link and delete the account once you open it and confirm. Deletion ' +
            'removes your notes, files and account record, and cannot be undone.' +
            (opts.sellsPlan
              ? ' It also cancels your plan at once, so nothing renews; what is left of the ' +
                'year is not refunded, except as “Refunds” describes.'
              : ''),
          'We may suspend or close an account that breaks these terms or the law, or where we are ' +
            'required to. Except where the law or an ongoing investigation prevents it, we will ' +
            'tell you why and give you an opportunity to export your notes first.',
        ],
      },
      {
        heading: 'Disclaimers',
        body: [
          'Unbent is provided “as is” and “as available”, without warranties of any kind, whether ' +
            'express or implied, including any implied warranties of merchantability, fitness for a ' +
            'particular purpose, title or non-infringement. We do not warrant that the service will ' +
            'meet your requirements, that it will be available without interruption, or that any ' +
            'defect will be corrected.',
          'Some jurisdictions do not allow the exclusion of certain warranties, so parts of this ' +
            'section may not apply to you.',
        ],
      },
      {
        heading: 'Limitation of liability',
        body: [
          `To the fullest extent the law allows, ${operator.name} is not liable for any indirect, ` +
            `incidental, special, consequential or punitive damages, or for lost profits, lost ` +
            `data or loss of goodwill, arising out of your use of or inability to use Unbent — ` +
            `even if we were told such damages were possible.`,
          'Where liability cannot be excluded, our total liability for any claim relating to the ' +
            'service is limited to the greater of the amount you paid us in the twelve months ' +
            'before the claim, or one hundred US dollars.',
          'Some jurisdictions do not allow these limitations, so parts of this section may not ' +
            'apply to you.',
        ],
      },
      {
        heading: 'Indemnity',
        body: [
          `You agree to hold ${operator.name} harmless from claims brought by a third party arising out ` +
            `of content you stored through the service, your use of the service, or your breach ` +
            `of these terms.`,
        ],
      },
      {
        heading: 'Governing law',
        body: [
          'These terms are governed by the laws of the State of Minnesota, without regard to its ' +
            'conflict of law rules. Any dispute will be brought in the state or federal courts ' +
            'located in Dakota County, Minnesota, and both of us consent to the jurisdiction of ' +
            'those courts. If you are a consumer elsewhere, this does not deprive you of the ' +
            'protection of your own country’s mandatory laws.',
        ],
      },
      {
        heading: 'Changes to these terms',
        body: [
          'We may update these terms. When we do, the effective date above changes. When the ' +
            'change is material, the app will ask you to agree to the new version before you go ' +
            'on using it. If you do not agree, you can still export your notes and delete your ' +
            'account, and the version you agreed to before applies until you do.',
        ],
      },
      {
        heading: 'General',
        body: [
          'These terms, together with the Privacy Policy, are the entire agreement between you and ' +
            `${operator.name} about Unbent. If a provision is found unenforceable, the rest remains in ` +
            `effect. Our failure to enforce a provision is not a waiver of it. You may not ` +
            `transfer your rights under these terms; we may transfer ours to a successor.`,
        ],
      },
      {
        heading: 'Contact',
        body: [
          `Questions about these terms, and reports of anyone misusing the service, go to ` +
            `${operator.email}.`,
        ],
      },
    ],
  };

  /**
   * How to delete your account, as a page anyone can read without signing in.
   *
   * This exists for the Google Play listing, which requires a public URL where the deletion
   * process is explained, and which checks that the URL loads. Pointing it at
   * `/settings/maintenance` (where the control actually is) returned a 403 in the console,
   * because the reviewer following the link has no session and never will.
   *
   * Play asks a store listing's deletion URL for three specific things, and each is a
   * section below rather than a paragraph that happens to mention them: name the app and the
   * developer, feature the steps prominently, and say what is deleted, what is kept, and for
   * how long.
   *
   * It is a `LegalDocument` because it has to say the same things `privacy` says about
   * deletion and retention, and two prose copies of one fact drift apart: one gets corrected
   * and the other quietly becomes a lie a store listing points at. Everything here is stated
   * in the Privacy Policy's "Deleting your account" and "How long it is kept"; change both
   * together, or neither.
   *
   * No `effective` date of its own in the sense the legal documents have one: it carries
   * the privacy policy's, because it is a restatement of that policy's retention terms
   * rather than a separate promise, and moves when they do.
   */
  const deletion: LegalDocument = {
    title: 'Deleting your Unbent account',
    effective: PRIVACY_EFFECTIVE,
    intro: [
      `Unbent is a notes application (a website at ${operator.host} and Android and iOS apps) operated ` +
        `by ${operator.name}. You can delete your account and everything in it yourself, at any time, ` +
        `without asking us.`,
      `This page explains how, and exactly what deletion removes. It is the same process ` +
        `described in the Privacy Policy.`,
    ],
    sections: [
      {
        heading: 'How to delete your account',
        body: [
          'From the Android or iOS app or the website, signed in as the account you want to delete:',
        ],
        steps: [
          'Open Settings, then Maintenance.',
          'Press Delete account, and confirm when asked.',
          'We email a confirmation link to the address on the account. Nothing has been ' +
            'deleted at this point: the press only sends the mail, so a stray tap costs you ' +
            'nothing.',
          'Open that link in the same browser you are signed in with, and press Delete my ' +
            'account. The account is deleted at that press. The link works once and expires ' +
            'after a day.',
        ],
      },
      {
        heading: 'If you cannot sign in',
        body: [
          `You do not need a working sign-in to be rid of the account. Write to ` +
            `${operator.email} from the address on the account and we will delete it for you.`,
        ],
      },
      {
        heading: 'What is deleted',
        body: [
          'All of it, permanently. Deletion cannot be undone, and there is no export afterwards, ' +
            'so if any of it matters, use Settings, then Export first, which gives you the ' +
            'whole account as a zip of ordinary Markdown files with your attachments beside them.',
        ],
        list: [
          'Your notes, including everything in the trash, and their titles, tags and notebooks.',
          'Every file you attached, and the text ' +
            (opts.autofill && opts.llm ? 'read from them' : 'extracted from PDFs') +
            ' for search.',
          'Your account record and email address, any password hash, and your passkeys.',
          'Any linked sign-in account, such as Google, and any app you connected to Unbent.',
          'Your sessions, which signs the account out of every device it was signed in on.',
        ],
      },
      {
        heading: 'What is kept, and for how long',
        body: [
          'The deletion is immediate and final rather than a scheduled one you could change your ' +
            'mind about, and nothing can be restored for you afterwards.',
          ...(opts.backups
            ? [
                'Copies of your account do remain for a while in our backups, which exist so that ' +
                  'a fault on our side can be put right, and which we do not use to bring back an ' +
                  'account its owner deleted: a daily copy of your notes, kept for 14 days, and a ' +
                  'nightly copy of your notes, your files and our sign-in records in a second ' +
                  'account with our hosting provider, kept for up to 90 days. Every one of them is ' +
                  'gone within about three months of the deletion.',
              ]
            : [`Nothing else of your account or its contents is kept${opts.autofill ? ' by us' : ''}.`]),
          ...(opts.autofill
            ? [
                `What an Auto-fill press sent to ${opts.llm ? 'TypeSafe or Anthropic' : 'TypeSafe'} ` +
                  'is kept by them as the Privacy Policy describes, not by us, and deletion here ' +
                  'does not reach it.',
              ]
            : []),
          'Two other things outlive it, neither of which is your notes, and both are ordinary ' +
            'infrastructure rather than anything we keep on purpose. Our hosting provider ' +
            'retains routine server request logs, as any web host does. Mail we have already ' +
            'sent you (a sign-in code, the deletion link itself) may persist for a short ' +
            'period in our email provider’s own logs.',
          'We may also keep a record where the law requires us to, which for a notes account is ' +
            'not the ordinary case.',
        ],
      },
    ],
  };

  return { privacy, terms, deletion };
}

/**
 * The terms' two sections about money, for an instance that sells a plan.
 *
 * What a merchant of record's review reads for (Paddle's did, by address; Stripe's
 * Managed Payments reads the same): that there is a price, that Stripe is the merchant of
 * record, that the plan renews and how to stop it, and a refund policy.
 *
 * No numbers: not the price, the storage or the trial's length. The front page and the
 * checkout state those, and terms that quoted `plan.ts`'s constants would be rewritten by a
 * price change without their effective date moving or anyone being asked to agree, which
 * is the one way legal text must never change. The refund window and how long a lapsed
 * account is kept are here because they are promises, not prices.
 *
 * Three promises here are behaviour, not prose, and hold only while the code keeps them:
 * cancelling keeps the year already paid for (`planStateOf` reads a canceled subscription
 * as active until its period ends); a lapsed account reads, searches, exports and
 * deletes (`requireActivePlan`); and a refunded plan is cancelled at once rather than
 * left renewing, which Stripe itself would do (`refundEffectOf` in the API's billing
 * events, acted on by the webhook with `ensureSubscriptionCanceled`, the call account
 * deletion makes). Deleting an account a year after it lapsed is a right reserved, not
 * a job: "may", by decision (`INACTIVE_KEPT_DAYS`).
 */
function payment(operator: Operator): LegalSection[] {
  return [
    {
      heading: 'Plans and payment',
      body: [
        'A new account starts with a free trial, with no card asked for. After that, writing ' +
          'in Unbent needs a plan, billed yearly, and more storage can be added to it. The ' +
          'price, and what a plan includes, are the ones shown on our pricing page and at ' +
          'checkout when you subscribe. Prices are in US dollars, and sales tax or VAT is ' +
          'added where it applies.',
        'Our order process is conducted by Stripe, through its Managed Payments service. Stripe is the ' +
          'merchant of record for every order, under its Link name: it takes the payment, issues ' +
          'the receipt and handles tax, and its own buyer terms apply to the purchase alongside ' +
          'these.',
        'A plan renews automatically each year, and is charged again at the price then current, ' +
          'until you cancel it. If the price is going to change we will email you at least 30 ' +
          'days before the renewal it applies to.',
        'You can cancel at any time, on the website, from Settings, then Plan, then Manage ' +
          'subscription. Cancelling stops the next renewal; the account keeps everything it had until the end ' +
          'of the year already paid for.',
        `When a trial ends without a plan, or a plan ends, the account becomes read-only rather ` +
          `than disappearing: every note still opens, searches and exports, and you can still ` +
          `delete, but nothing new can be written until you subscribe again. A read-only ` +
          `account is kept for ${KEPT}, and we will email you to export it before then. After ` +
          `that we may delete it, as if you had deleted it yourself.`,
      ],
    },
    {
      heading: 'Refunds',
      id: REFUNDS_ID,
      body: [
        `If Unbent is not for you, ask for a refund within ${REFUND_DAYS} days of any charge (` +
          `the first year or a renewal, the plan or added storage) and you will get the whole ` +
          `of that charge back. No reason is needed. Write to ${operator.email} from the ` +
          `address the account used, or ask Stripe directly through the support link in your receipt.`,
        'A refunded plan is cancelled, so it does not renew. After ' +
          `${REFUND_DAYS} days a charge is not refunded, though cancelling still stops the ` +
          'next one. Where the law where you live gives you a longer right to cancel or to a ' +
          'refund, you have it regardless of this section.',
      ],
    },
  ];
}
