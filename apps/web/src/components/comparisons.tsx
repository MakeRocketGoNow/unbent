import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { BASE_STORAGE_GB, PLAN_PRICE_USD, STORAGE_ADDON_GB, STORAGE_ADDON_PRICE_USD } from '@unbent/shared';
import { CARD_IMAGE, type PageMeta } from '../page-meta.js';

/**
 * What the comparison pages say (`ComparePage.tsx` draws it), one entry per app.
 *
 * Rules for editing these, because a comparison page is only worth anything while it is
 * true and fair:
 *
 * - **Every claim about the other app has a source,** listed in `sources`: its own pages
 *   where they say it, a dated report where they do not (Evernote's site names no
 *   prices). `checked` says when. Re-check them all and move `checked` together; a page with
 *   one fresh fact and four stale ones still says it was checked.
 * - **Say what we do not do** as plainly as what we do: no end-to-end encryption, no
 *   apps in the stores yet, pictures read only when someone asks. A reader who knows the
 *   other app finds the gap anyway, and then trusts nothing else on the page.
 * - **`theyDoBetter` is never empty,** and is about the thing the reader cares about, not
 *   a consolation ("great community!").
 * - **Unbent's own numbers are the shared constants,** as on the pricing page, so a
 *   price change cannot leave a comparison quoting the old one.
 * - Unbent's facts are the README's and `docs/`, never the front page's adjectives.
 *
 * The same rows in the same order on every page, so a reader who opens two compares
 * like with like. A row whose answer is "the same" is left out rather than padded.
 */
export interface Comparison {
  slug: 'evernote' | 'notion' | 'joplin';
  path: '/compare/evernote' | '/compare/notion' | '/compare/joplin';
  name: string;
  meta: PageMeta;
  /** The line on `/compare`. */
  summary: string;
  lead: string;
  /** Month and year, as the page says it: "October 2026". */
  checked: string;
  chooseUnbent: ReactNode[];
  chooseThem: ReactNode[];
  rows: { topic: string; unbent: ReactNode; them: ReactNode }[];
  theyDoBetter: { title: string; body: ReactNode }[];
  switching: { title: string; body: ReactNode };
  sources: { label: string; href: string }[];
}

export const COMPARE_META: PageMeta = {
  title: 'How Unbent compares',
  description:
    'Unbent beside Evernote, Notion and Joplin: price, searching scans and PDFs, structured fields, offline, export, and what each of them does better.',
  image: CARD_IMAGE,
};

const CHECKED = 'October 2026';

/** Unbent's half of the rows every page shares, in the shared order. */
const US = {
  price: (
    <>
      ${PLAN_PRICE_USD} a year, unlimited notes, {BASE_STORAGE_GB} GB of files ({STORAGE_ADDON_GB} GB
      more for ${STORAGE_ADDON_PRICE_USD} a year). A two-week trial, no free plan.
    </>
  ),
  search: (
    <>
      Note text and the text of every PDF, as it arrives. Photos and image-only scans are
      read when you press Auto-fill on the note, or by your AI assistant; not automatically.
      No handwriting.
    </>
  ),
  fields: <>Typed fields per notebook (date, amount, select, rating and more), a table view, and filters on any field.</>,
  offline: (
    <>
      Yes, in the browser on every device: notes, notebooks and tags are kept on the
      device. Files are kept for the notebooks you choose.
    </>
  ),
  encryption: (
    <>
      Encrypted in transit and at rest. Not end-to-end: the server reads your notes so it
      can search inside files.
    </>
  ),
  export: (
    <>
      Everything, any time, from any browser: a zip of one folder per note, its Markdown
      and its files beside it. Opens with nothing installed.
    </>
  ),
  apps: (
    <>
      A web app for desktop and phone, installable. Android and iOS apps are built but
      not in the stores yet. No web clipper.
    </>
  ),
  ai: (
    <>
      Auto-fill files one note when pressed. An MCP server for Claude, ChatGPT and others,
      over the web; an assistant&apos;s edits are kept in the note&apos;s history and it
      cannot delete anything for good.
    </>
  ),
  sharing: <>None. An account is one person&apos;s.</>,
  source: (
    <>
      Source-available (Elastic License 2.0). You can run your own on Cloudflare&apos;s free
      tier.
    </>
  ),
};

export const COMPARISONS: readonly Comparison[] = [
  {
    slug: 'evernote',
    path: '/compare/evernote',
    name: 'Evernote',
    meta: {
      title: 'Unbent vs Evernote',
      description:
        'An Evernote alternative for scanned paperwork: Unbent beside Evernote on price, search inside PDFs and scans, fields, export, and what Evernote still does better.',
      image: CARD_IMAGE,
    },
    summary: 'For an archive of scans you are thinking of moving. The closest of the three, and the one Unbent was built to replace.',
    lead: 'Unbent does the job a lot of people used Evernote for: scan the paperwork once, find it again by what it says. It costs less, keeps your notes as files you can take, and does a good deal less besides.',
    checked: CHECKED,
    chooseUnbent: [
      'Your Evernote is mostly scans, receipts and documents, and you mainly need to find them.',
      `You want to pay $${PLAN_PRICE_USD} a year for unlimited notes rather than $99 for 1,000 or $249.99 for no cap.`,
      'You want fields on your notes (a date, a total, who it was from) and a table to sort them by.',
      'You want an export you can open without the app, from any browser, as often as you like.',
    ],
    chooseThem: [
      'You rely on its web clipper, its document scanner, or its native apps.',
      'You search photos and handwriting without thinking about it, and need that to keep working.',
      'You share notebooks with other people.',
      'Your archive is large and the price is not the problem.',
    ],
    rows: [
      {
        topic: 'Price',
        unbent: US.price,
        them: 'Free for 50 notes and one notebook. Starter is $99 a year for 1,000 notes; Advanced is $249.99 a year with no cap on notes.',
      },
      {
        topic: 'Searching inside files',
        unbent: US.search,
        them: 'PDFs, Office documents, images and handwriting in images, read automatically.',
      },
      { topic: 'Fields and tables', unbent: US.fields, them: 'None. Notebooks, tags and spaces.' },
      { topic: 'Offline', unbent: US.offline, them: 'Offline notes on its apps.' },
      { topic: 'Encryption', unbent: US.encryption, them: 'Encrypted in transit and at rest on Google Cloud. Not end-to-end.' },
      {
        topic: 'Export',
        unbent: US.export,
        them: 'ENEX or HTML, from the desktop app only, a notebook or up to 100 notes at a time. ENEX is a format only another notes app reads.',
      },
      {
        topic: 'Apps',
        unbent: US.apps,
        them: 'Windows, Mac, iOS, Android and the web, with a web clipper.',
      },
      {
        topic: 'AI and assistants',
        unbent: US.ai,
        them: 'A built-in AI assistant, semantic search and transcription, and an MCP server for paid plans.',
      },
      { topic: 'Sharing', unbent: US.sharing, them: 'Shared notes and notebooks, Spaces, and business plans.' },
    ],
    theyDoBetter: [
      {
        title: 'Reading pictures without being asked',
        body: 'Evernote reads every image and the handwriting in it as it arrives. Unbent reads a PDF’s text as it arrives, but a photo or an image-only scan only when you press Auto-fill or ask an assistant, so an archive of phone photos is less searchable on day one.',
      },
      {
        title: 'Getting things in',
        body: 'A web clipper, a document scanner in the phone app, email-in, and native apps in every store. Unbent takes files dropped in, shared to it, or sent from a scanner, and its phone apps are not in the stores yet.',
      },
      {
        title: 'Working with other people',
        body: 'Shared notebooks and Spaces. Unbent has no sharing at all.',
      },
      {
        title: 'Breadth',
        body: 'Tasks, reminders, a calendar, templates and nearly two decades of features. Unbent does notes, files, fields and search, and means to stay that size.',
      },
    ],
    switching: {
      title: 'Moving from Evernote',
      body: (
        <>
          <p>
            Export each notebook from Evernote&apos;s desktop app as an <code>.enex</code> file
            and drop the files on Unbent&apos;s import page, in the browser. Each note keeps its
            notebook, tags, dates and files, and the text Evernote read from your scans comes
            with them, so they are searchable again straight away. An interrupted import picks
            up where it stopped, and running one twice does not duplicate anything.
          </p>
          <p>
            The longer story, of one 13,000-note archive and why it moved, is{' '}
            <Link to="/why">Why Unbent exists</Link>.
          </p>
        </>
      ),
    },
    sources: [
      { label: 'Evernote: compare plans', href: 'https://evernote.com/compare-plans' },
      { label: 'Evernote: security', href: 'https://evernote.com/security' },
      { label: 'Evernote: exporting notes', href: 'https://help.evernote.com/hc/articles/209005557' },
      { label: 'Evernote: searching text in files', href: 'https://help.evernote.com/hc/articles/360040282613' },
      { label: 'Taming the Trunk: the 2025 plans and prices', href: 'https://www.tamingthetrunk.com/p/evernote-increases-prices-and-adds' },
    ],
  },
  {
    slug: 'notion',
    path: '/compare/notion',
    name: 'Notion',
    meta: {
      title: 'Unbent vs Notion',
      description:
        'Notion databases for scanned paperwork? Unbent beside Notion on searching inside PDFs, fields, offline, export, price, and what Notion does better.',
      image: CARD_IMAGE,
    },
    summary: 'For records you would otherwise keep in a Notion database. Notion does far more; Unbent searches what is inside the files.',
    lead: 'Notion is a workspace for writing, planning and working with other people. Unbent does one narrower thing: keeps your paperwork and notes, with fields like a Notion database, and finds them by what is inside the files.',
    checked: CHECKED,
    chooseUnbent: [
      'Most of what you keep is files: receipts, bills, statements, manuals, scans.',
      'You need to find a PDF by a word inside it, not only by its title.',
      'You want your notes to work offline on a phone’s browser, and on the web.',
      'You want a price that does not depend on how many seats or AI credits you use.',
    ],
    chooseThem: [
      'You work with other people in the same pages.',
      'You need relations, formulas, rollups, boards, calendars and timelines.',
      'You build wikis, project plans or published sites.',
      'Your notes are mostly writing, not files.',
    ],
    rows: [
      {
        topic: 'Price',
        unbent: US.price,
        them: 'Free for one person, with 5 MB per upload. Plus from $10 a member a month billed yearly; Business, with the full AI features, from $20.',
      },
      {
        topic: 'Searching inside files',
        unbent: US.search,
        them: 'Ordinary search does not read an uploaded PDF’s text; Notion AI can read a file when asked, and Enterprise Search, in beta, reaches inside files.',
      },
      {
        topic: 'Fields and tables',
        unbent: US.fields,
        them: 'Databases with typed properties, relations, formulas and rollups, and many views of each.',
      },
      {
        topic: 'Offline',
        unbent: US.offline,
        them: 'In the desktop and phone apps since August 2025, not in the browser. Pages are downloaded by hand, or recent ones automatically on paid plans; a database’s first 50 rows.',
      },
      { topic: 'Encryption', unbent: US.encryption, them: 'Encrypted in transit and at rest on AWS. Not end-to-end.' },
      {
        topic: 'Export',
        unbent: US.export,
        them: 'A whole workspace as Markdown and CSV or HTML, emailed as a link; PDF with sub-pages on Business and above.',
      },
      { topic: 'Apps', unbent: US.apps, them: 'Mac, Windows, iOS, Android and the web, with a web clipper.' },
      {
        topic: 'AI and assistants',
        unbent: US.ai,
        them: 'Notion AI across the workspace on Business and above, agents on credits, a public API and a hosted MCP server.',
      },
      { topic: 'Sharing', unbent: US.sharing, them: 'Real-time collaboration, comments, guests and published pages.' },
    ],
    theyDoBetter: [
      {
        title: 'Databases',
        body: 'Relations between databases, formulas, rollups, and boards, calendars, timelines and charts over them. Unbent’s fields are typed values on a note, a table and filters, and stop there.',
      },
      {
        title: 'Working together',
        body: 'Many people in the same page at once, with comments, mentions and permissions. Unbent has no sharing.',
      },
      {
        title: 'Everything that is not paperwork',
        body: 'Wikis, project plans, docs, published sites and a large library of templates. Unbent is for keeping and finding, not for building a workspace.',
      },
      {
        title: 'Native apps today',
        body: 'Desktop and phone apps in every store. Unbent’s phone apps are built and not in the stores yet; until then it is the browser.',
      },
    ],
    switching: {
      title: 'Moving from Notion',
      body: (
        <p>
          Export the workspace from Notion as Markdown &amp; CSV, including files, and open the
          zip on Unbent&apos;s import page. You choose which databases and pages to bring in;
          each becomes a notebook, a database&apos;s columns become its fields, and attached
          PDFs become searchable by what they say. Nothing has to move all at once: bring the
          paperwork and leave the rest where it works.
        </p>
      ),
    },
    sources: [
      { label: 'Notion: pricing', href: 'https://www.notion.com/pricing' },
      { label: 'Notion: working offline', href: 'https://www.notion.com/help/guides/working-offline-in-notion-everything-you-need-to-know' },
      { label: 'Notion: security and privacy', href: 'https://www.notion.com/help/security-and-privacy' },
      { label: 'Notion: exporting your content', href: 'https://www.notion.com/help/export-your-content' },
      { label: 'Notion: importing data', href: 'https://www.notion.com/help/import-data-into-notion' },
      { label: 'Notion: MCP', href: 'https://developers.notion.com/docs/mcp' },
    ],
  },
  {
    slug: 'joplin',
    path: '/compare/joplin',
    name: 'Joplin',
    meta: {
      title: 'Unbent vs Joplin',
      description:
        'Joplin is open source and end-to-end encrypted; Unbent is a hosted archive. How they compare on searching scans, fields, encryption, offline and export, and what Joplin does better.',
      image: CARD_IMAGE,
    },
    summary: 'For someone weighing an open-source app they run themselves against a hosted one. Joplin wins on privacy.',
    lead: 'Joplin is open source and end-to-end encrypted, and you bring the place it syncs to. Unbent is a hosted service built around one job: an archive of paperwork you find by what it says and sort by its fields.',
    checked: CHECKED,
    chooseUnbent: [
      'You want nothing to set up: no sync target, no server, no plugins to choose.',
      'Your notes are mostly scans and files, and you sort them by date, total or sender.',
      'Your archive is large and you do not want every device to hold all of it.',
      'You want your notes in any browser, and your AI assistant to work in them over the web.',
    ],
    chooseThem: [
      'You want end-to-end encryption, so no server can read your notes.',
      'You want it open source, and are happy to run your own sync.',
      'You want native desktop apps, Linux included, and a plugin for everything.',
    ],
    rows: [
      {
        topic: 'Price',
        unbent: US.price,
        them: 'Free, syncing through Dropbox, OneDrive, Nextcloud, WebDAV or S3. Joplin Cloud from €2.99 a month (2 GB, 10 MB a note) or €5.99 (30 GB).',
      },
      {
        topic: 'Searching inside files',
        unbent: US.search,
        them: 'PDFs and images, read by the desktop app and searchable everywhere once synced. No handwriting.',
      },
      { topic: 'Fields and tables', unbent: US.fields, them: 'None built in; community plugins.' },
      {
        topic: 'Offline',
        unbent: US.offline,
        them: 'Offline first: every app keeps the whole library on the device, and sync is optional.',
      },
      {
        topic: 'Encryption',
        unbent: US.encryption,
        them: 'End-to-end encryption on every app, off by default. A lost master password cannot be recovered.',
      },
      {
        topic: 'Export',
        unbent: US.export,
        them: 'JEX, Markdown, HTML and PDF from the desktop app; the library is on your disk already.',
      },
      {
        topic: 'Apps',
        unbent: US.apps,
        them: 'Windows, Mac, Linux, iOS, Android and a terminal app, with a web clipper. A web app in beta.',
      },
      {
        topic: 'AI and assistants',
        unbent: US.ai,
        them: 'AI chat, semantic search and an MCP server on the desktop since version 3.7, in beta; the MCP server is local to the computer.',
      },
      { topic: 'Sharing', unbent: US.sharing, them: 'Shared notebooks on Joplin Cloud Pro and Teams.' },
      {
        topic: 'Source',
        unbent: US.source,
        them: 'The apps are open source (AGPL). Joplin Server is under its own personal-use licence.',
      },
    ],
    theyDoBetter: [
      {
        title: 'Privacy',
        body: 'With end-to-end encryption on, the place your notes sync to holds only ciphertext. Unbent’s server can read your notes; that is how it searches inside your files, and it is a real trade.',
      },
      {
        title: 'Open source and extensible',
        body: 'An AGPL codebase and a large plugin library, nearly a decade old. Unbent is source-available, not open source, and has no plugins.',
      },
      {
        title: 'Native apps everywhere',
        body: 'Desktop apps for Windows, Mac and Linux, and phone apps in the stores today.',
      },
    ],
    switching: {
      title: 'Trying Unbent beside Joplin',
      body: (
        <p>
          Unbent does not import Joplin&apos;s own export yet. What it takes today is files: drop
          a folder of PDFs and photos on the note list and each becomes a note with its file
          attached, searchable by the text in it. If you are mainly here for the paperwork,
          that is the part worth trying first, and your Joplin library stays where it is
          while you decide.
        </p>
      ),
    },
    sources: [
      { label: 'Joplin: plans', href: 'https://joplinapp.org/plans/' },
      { label: 'Joplin: OCR', href: 'https://joplinapp.org/help/apps/ocr' },
      { label: 'Joplin: end-to-end encryption', href: 'https://joplinapp.org/help/apps/sync/e2ee' },
      { label: 'Joplin: import and export', href: 'https://joplinapp.org/help/apps/import_export' },
      { label: 'Joplin: the web app', href: 'https://joplinapp.org/help/apps/web' },
      { label: 'Joplin: version 3.7', href: 'https://joplinapp.org/news/20260831-release-3-7/' },
      { label: 'Joplin: AI and MCP', href: 'https://joplinapp.org/help/apps/ai_mcp/' },
      { label: 'Joplin: licence', href: 'https://github.com/laurent22/joplin/blob/dev/LICENSE' },
    ],
  },
];

/** One comparison by its slug, for the routes and the build. */
export function comparison(slug: Comparison['slug']): Comparison {
  const found = COMPARISONS.find((c) => c.slug === slug);
  if (!found) throw new Error(`No comparison for ${slug}`);
  return found;
}
