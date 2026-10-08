/**
 * The privacy policy, terms and deletion page, as data.
 *
 * Kept out of the components that render them because the text is the part that changes,
 * and it changes for legal reasons rather than layout ones — a paragraph should be
 * editable without reading JSX. One renderer walks all three; see `LegalDoc.tsx`.
 *
 * Built for an operator rather than exported as constants, which is the change that made
 * this repository publishable. The documents used to name one company and one domain from
 * constants at the top of this file, so every self-hosted copy served `CDeutsch Consulting
 * LLC` and `hello@unbent.app` on somebody else's site — a legal claim that operator never
 * made and could not stand behind. Now the server says who runs the instance and these are
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

import type { AppConfig } from '@unbent/shared';

export interface LegalSection {
  heading?: string;
  /** Paragraphs, rendered in order. */
  body?: string[];
  /** A bulleted list, after the paragraphs. */
  list?: string[];
  /**
   * A numbered list, after the paragraphs — instructions to follow in order, rather than
   * facts that happen to be enumerated.
   *
   * Separate from `list` because the distinction is the reader's, not the renderer's: a
   * bullet says "these are the things", a number says "do this, then this". The deletion
   * page is the reason it exists, where Play requires the steps be prominent and a
   * four-item bulleted list reads as a description of the process rather than the process.
   */
  steps?: string[];
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
   * Whether this instance keeps backups of its own — the daily dumps and, on unbent.app,
   * the nightly copy to a second account (MAK-171; "Durability" in the README).
   *
   * `AppConfig.backups`, true where a backups bucket is bound. The policy and the deletion
   * page describe those copies and the three months a deletion takes to leave them only
   * where they exist; a fork with no bucket keeps the shorter text, which is true of it.
   */
  backups: boolean;
}

const EFFECTIVE = '2026-09-08';

/**
 * How many "other kinds of service" the policy lists, as the word the sentence needs. Two
 * always (sign-in, email); error tracking and the backups' GitHub job each add one.
 */
const COUNT = ['', '', 'Two', 'Three', 'Four'] as const;

/**
 * The privacy policy's own date, moved when its terms change — "How long it is kept"
 * changed on 5 October 2026, when deleted files began staying in storage for thirty-five
 * days, and again on 8 October 2026, when the backups were described (both MAK-171) —
 * without moving the terms', which did not. The deletion page restates the policy's
 * retention terms, so it carries this date too.
 */
const PRIVACY_EFFECTIVE = '2026-10-08';

export interface LegalDocuments {
  privacy: LegalDocument;
  terms: LegalDocument;
  deletion: LegalDocument;
}

/**
 * The three documents, written for the operator publishing them.
 *
 * A function rather than three constants because the operator is not known until the
 * server answers, and because there is no honest default for it — see the header. Cheap
 * enough to call on every render: it builds three object literals and nothing else.
 */
export function legalDocuments(operator: Operator, opts: LegalOptions): LegalDocuments {
  const privacy: LegalDocument = {
    title: 'Privacy Policy',
    effective: PRIVACY_EFFECTIVE,
    intro: [
      `This policy describes what Unbent collects, why, and what happens to it. Unbent is a ` +
        `notes application: a website at ${operator.host} and an Android app that talks to it. It is ` +
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
            'from it altogether — nothing is counted for them at all.',
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
          'Session records — for each device you sign in from, we store the IP address and browser ' +
            'user agent alongside the session, so that a session can be identified and revoked. ' +
            'Sessions expire after thirty days of disuse.',
          'Your content — the notes you write, their titles, tags and notebooks, and any files you ' +
            'attach. Text extracted from PDFs you upload, so that searching finds words inside them.',
          'Nothing else. We do not collect your location, your contacts, your device identifiers, ' +
            'or anything from other apps.',
        ],
      },
      {
        heading: 'How it is used',
        body: [
          'To run the service and nothing else: to show you your notes, to search them, to sync ' +
            'between your devices, and to sign you in. Email is used to reach you about your own ' +
            'account — a sign-in code, a password reset, a verification link. There is no marketing ' +
            'mail, and no newsletter to unsubscribe from.',
          'We do not sell personal information, and we do not share it for advertising or for ' +
            'anyone else to build a profile from.',
        ],
      },
      {
        heading: 'Where it is stored, and who else touches it',
        body: [
          'Unbent is hosted in the United States. Your notes, files and account records are ' +
            'stored with our hosting provider there, which also keeps ordinary request logs, as ' +
            'any web host does. Text inside PDFs you upload is extracted on those same systems ' +
            'so that search can find it; the file is used for that and nothing else.',
          `${COUNT[2 + Number(opts.errorTracking) + Number(opts.backups)]} other kinds of service ` +
            `are involved, each for one narrow job:`,
        ],
        list: [
          'A sign-in provider, if you choose to sign in with one — Google, for example. The ' +
            'provider tells us your email address, name and profile image; we tell it nothing ' +
            'about your notes.',
          'An email delivery service, for the messages described above — sign-in codes, password ' +
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
                'GitHub, whose servers run the nightly job that copies our backups — your notes, ' +
                  'your files and our sign-in records — to a second account with our hosting ' +
                  'provider, as described under “How long it is kept”. The copy passes through ' +
                  'those servers on the way and none of your content is kept on them.',
              ]
            : []),
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
            'until you empty the trash — at which point the note is gone for good. Files you ' +
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
        heading: 'Do Not Track',
        body: [
          'There is nothing to honour or ignore: Unbent does not track you across websites, with or ' +
            'without a Do Not Track signal.',
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
          'If this policy changes in a way that affects how your information is handled, the ' +
            'effective date above changes with it. Continuing to use Unbent after that means the ' +
            'new version applies.',
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
        `${operator.host} and its Android app, operated by ${operator.name}. Using Unbent means agreeing to ` +
        `them. If you do not agree, please do not use it.`,
    ],
    sections: [
      {
        heading: 'The service',
        body: [
          'Unbent stores notes and files you choose to put into it, and lets you search and ' +
            'organise them from a browser or an Android phone. We may add, change or remove ' +
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
            'removes your notes, files and account record, and cannot be undone.',
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
            'located in Hennepin County, Minnesota, and both of us consent to the jurisdiction of ' +
            'those courts. If you are a consumer elsewhere, this does not deprive you of the ' +
            'protection of your own country’s mandatory laws.',
        ],
      },
      {
        heading: 'Changes to these terms',
        body: [
          'We may update these terms. When we do, the effective date above changes, and material ' +
            'changes will be announced in the app before they take effect. Continuing to use ' +
            'Unbent afterwards means accepting the new version; if you do not, delete your account.',
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
   * `/settings/maintenance` — where the control actually is — returned a 403 in the console,
   * because the reviewer following the link has no session and never will.
   *
   * Play asks a store listing's deletion URL for three specific things, and each is a
   * section below rather than a paragraph that happens to mention them: name the app and the
   * developer, feature the steps prominently, and say what is deleted, what is kept, and for
   * how long.
   *
   * It is a `LegalDocument` because it has to say the same things `privacy` says about
   * deletion and retention, and two prose copies of one fact drift apart — one gets corrected
   * and the other quietly becomes a lie a store listing points at. Everything here is stated
   * in the Privacy Policy's "Deleting your account" and "How long it is kept"; change both
   * together, or neither.
   *
   * No `effective` date of its own in the sense the legal documents have one — it carries
   * the privacy policy's, because it is a restatement of that policy's retention terms
   * rather than a separate promise, and moves when they do.
   */
  const deletion: LegalDocument = {
    title: 'Deleting your Unbent account',
    effective: PRIVACY_EFFECTIVE,
    intro: [
      `Unbent is a notes application — a website at ${operator.host} and an Android app — operated ` +
        `by ${operator.name}. You can delete your account and everything in it yourself, at any time, ` +
        `without asking us.`,
      `This page explains how, and exactly what deletion removes. It is the same process ` +
        `described in the Privacy Policy.`,
    ],
    sections: [
      {
        heading: 'How to delete your account',
        body: [
          'From the Android app or the website, signed in as the account you want to delete:',
        ],
        steps: [
          'Open Settings, then Maintenance.',
          'Press Delete account, and confirm when asked.',
          'We email a confirmation link to the address on the account. Nothing has been ' +
            'deleted at this point — the press only sends the mail, so a stray tap costs you ' +
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
          'All of it, permanently. Deletion cannot be undone, and there is no export afterwards ' +
            '— so if any of it matters, use Settings, then Export first, which gives you the ' +
            'whole account as a zip of ordinary Markdown files with your attachments beside them.',
        ],
        list: [
          'Your notes, including everything in the trash, and their titles, tags and notebooks.',
          'Every file you attached, and the text extracted from PDFs for search.',
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
            : ['Nothing else of your account or its contents is kept.']),
          'Two other things outlive it, neither of which is your notes, and both are ordinary ' +
            'infrastructure rather than anything we keep on purpose. Our hosting provider ' +
            'retains routine server request logs, as any web host does. Mail we have already ' +
            'sent you — a sign-in code, the deletion link itself — may persist for a short ' +
            'period in our email provider’s own logs.',
          'We may also keep a record where the law requires us to, which for a notes account is ' +
            'not the ordinary case.',
        ],
      },
    ],
  };

  return { privacy, terms, deletion };
}
