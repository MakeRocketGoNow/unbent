/**
 * The privacy policy and terms, as data.
 *
 * Kept out of the components that render them because the text is the part that changes,
 * and it changes for legal reasons rather than layout ones — a paragraph should be
 * editable without reading JSX. One renderer walks both; see `LegalDoc.tsx`.
 *
 * Adapted from the same documents on pushthat.link, which is the other app this company
 * runs. Where the boilerplate said something untrue of a notes app it was rewritten rather
 * than kept for symmetry: the privacy policy in particular now describes what the code
 * actually stores, since that is the half a store listing is answerable for.
 */

export interface LegalSection {
  heading?: string;
  /** Paragraphs, rendered in order. */
  body?: string[];
  /** A bulleted list, after the paragraphs. */
  list?: string[];
}

export interface LegalDocument {
  title: string;
  /** ISO date, formatted for display by the renderer. */
  effective: string;
  /** Sits above the first heading, in slightly larger type. */
  intro: string[];
  sections: LegalSection[];
}

/** One place to change the address, which appears in both documents many times. */
export const CONTACT_EMAIL = 'hello@unbent.app';

/** The legal entity behind both this and PushThat. */
export const ENTITY = 'CDeutsch Consulting LLC';

const EFFECTIVE = '2026-09-06';

export const privacy: LegalDocument = {
  title: 'Privacy Policy',
  effective: EFFECTIVE,
  intro: [
    `This policy describes what Unbent collects, why, and what happens to it. Unbent is a ` +
      `notes application: a website at unbent.app and an Android app that talks to it. It is ` +
      `operated by ${ENTITY}.`,
    `The short version: your notes are yours, nothing is sold or shared for advertising, ` +
      `there is no tracking or analytics of any kind, and you can export or delete ` +
      `everything at any time without asking anyone.`,
  ],
  sections: [
    {
      heading: 'What we collect',
      body: [
        'Only what running the service requires. There is no analytics package, no advertising ' +
          'network, no third-party tracking script, and no profile built from how you use the app.',
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
        'Unbent runs on Cloudflare. Your notes and account records are in a Cloudflare D1 ' +
          'database, and your attached files are in Cloudflare R2 storage, both in the United ' +
          'States. Cloudflare also keeps ordinary request logs, as any web host does.',
        'Three other services are involved, each for one narrow job:',
      ],
      list: [
        'Cloudflare Workers AI extracts text from PDFs you upload, so that search can find words ' +
          'inside them. The file is sent for that purpose and not retained for any other.',
        'Google, if you choose to sign in with a Google account. Google tells us your email ' +
          'address, name and profile image; we tell Google nothing about your notes.',
        'Resend delivers the transactional email described above — sign-in codes, password ' +
          'resets, verification links. It sees your email address and the contents of those ' +
          'messages, which never include your notes.',
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
        `If you cannot sign in to delete the account yourself, write to ${CONTACT_EMAIL} from ` +
          `the address on the account and we will do it for you.`,
      ],
    },
    {
      heading: 'How long it is kept',
      body: [
        'Your notes stay until you delete them. Deleting a note moves it to trash, where it stays ' +
          'until you empty the trash — at which point the note and its files are gone for good. ' +
          'Everything else is kept for as long as the account exists, and removed when it is ' +
          'deleted. Sent email may persist for a short period in our email provider’s own logs.',
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
        `For anything you cannot do from the app, write to ${CONTACT_EMAIL}.`,
      ],
    },
    {
      heading: 'Security',
      body: [
        'Connections use HTTPS. Passwords, where they exist, are stored hashed. Data is separated ' +
          'per account at the application layer, and this separation is covered by an automated ' +
          'test suite that runs against every change. No system is perfectly secure, and we do ' +
          'not claim otherwise.',
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
        `Questions, requests or complaints about privacy go to ${CONTACT_EMAIL}.`,
      ],
    },
  ],
};

export const terms: LegalDocument = {
  title: 'Terms of Service',
  effective: EFFECTIVE,
  intro: [
    `These terms govern your use of Unbent, a notes service consisting of the website at ` +
      `unbent.app and its Android app, operated by ${ENTITY}. Using Unbent means agreeing to ` +
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
        `To the fullest extent the law allows, ${ENTITY} is not liable for any indirect, ` +
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
        `You agree to hold ${ENTITY} harmless from claims brought by a third party arising out ` +
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
          `${ENTITY} about Unbent. If a provision is found unenforceable, the rest remains in ` +
          `effect. Our failure to enforce a provision is not a waiver of it. You may not ` +
          `transfer your rights under these terms; we may transfer ours to a successor.`,
      ],
    },
    {
      heading: 'Contact',
      body: [
        `Questions about these terms, and reports of anyone misusing the service, go to ` +
          `${CONTACT_EMAIL}.`,
      ],
    },
  ],
};
