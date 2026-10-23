import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { BASE_STORAGE_GB, MAX_ATTACHMENT_BYTES, PLAN_PRICE_USD, STORAGE_ADDON_GB, STORAGE_ADDON_PRICE_USD } from '@unbent/shared';
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
 * - **Say which kind of app each is, and send the other job away.** Most of these are
 *   notes apps that take files; Unbent is an archive of paper that holds notes. A page
 *   that went feature by feature was a fight on the other app's ground (price, plugins,
 *   encryption, the editor) that Unbent does not need to win, so the reader with a
 *   notebook of writing is told in the lead to use the other app, and the other app's
 *   strengths on its own ground go in `theyDoBetter` without a "but". `whyTheyDiffer`
 *   names the choice under the facts once (a rule the other app holds and we do not, or
 *   two different jobs), so the cells can stay facts.
 * - **Say what we do not do** as plainly as what we do: no end-to-end encryption, no
 *   apps in the stores yet, pictures read only when someone asks. A reader who knows the
 *   other app finds the gap anyway, and then trusts nothing else on the page.
 * - **`weDoBetter` and `theyDoBetter` are both there, and the same shape.** A page that
 *   argued only the other side was as one-sided as one that argued only ours: Unbent's
 *   strengths were left to table cells while the other app's had a heading and prose,
 *   and a reader came away thinking the other app was the choice. Each list is about
 *   what the reader cares about, not a consolation ("great community!").
 * - **Name a trade for what it actually costs.** Not being end-to-end encrypted does not
 *   make searching inside files possible (Joplin searches inside its own, on the device);
 *   it makes searching a whole archive possible without every device holding it. A cell
 *   that said the first taught the reader something false about encryption.
 * - **Say each of our gaps once,** in the row or the point it belongs to, and nowhere
 *   else. The table's cells once each ended in a caveat, and a column of apologies read
 *   as worse than the facts in it.
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
  /** The choice under the facts, said once between the short version and the table. */
  whyTheyDiffer: ReactNode;
  rows: { topic: string; unbent: ReactNode; them: ReactNode }[];
  weDoBetter: { title: string; body: ReactNode }[];
  theyDoBetter: { title: string; body: ReactNode }[];
  switching: { title: string; body: ReactNode };
  sources: { label: string; href: string }[];
}

export const COMPARE_META: PageMeta = {
  title: 'How Unbent compares',
  description:
    'Unbent beside Evernote, Notion and Joplin: price, searching scans and PDFs, structured fields, offline, export, and what each does better than the other.',
  image: CARD_IMAGE,
};

const CHECKED = 'October 2026';

/** Unbent's half of the rows every page shares, in the shared order. */
const US = {
  price: (
    <>
      ${PLAN_PRICE_USD} a year for unlimited notes and {BASE_STORAGE_GB} GB of files ({STORAGE_ADDON_GB} GB
      more for ${STORAGE_ADDON_PRICE_USD} a year). Two weeks free to try.
    </>
  ),
  search: (
    <>
      Note text and the text of every PDF, searched on the server as soon as it arrives, so
      every device finds it. Photos are read when you press Auto-fill.
    </>
  ),
  fields: (
    <>
      Typed fields per notebook (date, amount, select, rating and more), a table view, and
      filters on any field: receipts by month, warranties by when they run out.
    </>
  ),
  offline: (
    <>
      In any browser, phone included: your notes, notebooks and tags are kept on the
      device and searchable there, with the files of the notebooks you choose.
    </>
  ),
  encryption: (
    <>
      Encrypted in transit and at rest. Not end-to-end: the server reads your notes, so it
      can search all of them without every device downloading them first.
    </>
  ),
  export: (
    <>
      Everything, any time, from any browser: a folder per note, its Markdown saved
      exactly as you typed it and its files beside it. Opens with nothing installed.
    </>
  ),
  apps: (
    <>
      A web app for any desktop or phone browser, installable. Android and iOS apps are
      coming.
    </>
  ),
  ai: (
    <>
      Auto-fill reads a scan and fills in its title, notebook and fields. An MCP server
      that Claude, ChatGPT and others connect to over the web, with every edit an
      assistant makes kept in the note&apos;s history.
    </>
  ),
  sharing: <>One person per account.</>,
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
    summary: 'For an archive of scans you are thinking of moving: the job Unbent was built for.',
    lead: `Unbent does the job a lot of people used Evernote for: scan the paperwork once and find it again by what it says. It adds fields you can sort by, files a scan for you, and keeps your notes as files you can take, for $${PLAN_PRICE_USD} a year with no cap on notes.`,
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
    whyTheyDiffer: (
      <>
        <p>
          Evernote and Unbent do the same job, and Evernote did it first: paper goes in, is
          read, and is found again by what it said. Evernote still reads more without being
          asked (a photo, a page of handwriting). The difference is what the archive is made
          of, and what happens when you want to leave.
        </p>
        <p>
          Evernote keeps notes in its own format, exports them from its desktop app a
          notebook at a time, and has changed its owner and roughly doubled its price within
          a year. Unbent was built by someone who left it with 13,000 notes, around one
          rule: the archive is yours. Every note is a Markdown file kept as you typed it,
          the export is plain folders from any browser, and an account that stops paying
          turns read-only rather than locked.
        </p>
      </>
    ),
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
    weDoBetter: [
      {
        title: 'Fields you can sort by',
        body: 'A receipts notebook can carry a date, a total and a shop on every note, shown as a table and filtered by any of them. In Evernote the same receipts are notes in a notebook, with tags.',
      },
      {
        title: 'Filing a scan for you',
        body: 'Press Auto-fill and Unbent reads the scan and fills in its title, its notebook and the date, total and sender. You check it instead of typing it.',
      },
      {
        title: 'An export you can use',
        body: 'Everything at once, from any browser, as plain folders: each note in Markdown with its files beside it, readable with nothing installed and importable back in. Evernote exports ENEX from its desktop app, a notebook or 100 notes at a time.',
      },
      {
        title: 'A price that does not count your notes',
        body: `$${PLAN_PRICE_USD} a year for as many notes as you keep. If you stop paying, the account turns read-only, and every note still opens, searches and exports.`,
      },
      {
        title: 'Assistants you can check',
        body: 'Claude, ChatGPT and others work in your notes over the web, every edit they make is kept in the note’s history and marked as theirs, and none of them can delete anything for good.',
      },
    ],
    theyDoBetter: [
      {
        title: 'Reading pictures without being asked',
        body: 'Evernote reads every image, and the handwriting in it, as it arrives. Unbent reads every PDF as it arrives, but a photo only when you press Auto-fill or ask an assistant.',
      },
      {
        title: 'Getting things in',
        body: 'A web clipper, a document scanner in the phone app, email-in, and native apps in every store.',
      },
      {
        title: 'Sharing, tasks and the rest',
        body: 'Shared notebooks and Spaces, tasks, reminders, a calendar and templates. Unbent does notes, files, fields and search, for one person.',
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
    summary: 'For records you would otherwise keep in a Notion database, when what matters is the text inside the files.',
    lead: 'Unbent is for paperwork: receipts, bills, manuals and scans you find by what is inside them, in notebooks with fields like a Notion database. Notion is a workspace for writing, planning and working with other people.',
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
    whyTheyDiffer: (
      <p>
        Notion is a workspace that stores files; Unbent is an archive that reads them. In
        Notion a PDF is an attachment on a page: found by its name, opened to know what it
        says, and kept under 5 MB on the free plan. In Unbent the file is the point: the text
        of every PDF is read as it arrives and searched from every device, a photo of a
        receipt is read on a press, and the note&apos;s fields hold what the paper said.
        Notion&apos;s databases do more than Unbent&apos;s notebooks in every other way, so
        the question is not which is better but which of the two jobs you have.
      </p>
    ),
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
    weDoBetter: [
      {
        title: 'Finding a file by what it says',
        body: 'Every PDF’s text is searched as soon as it arrives, on every device, and a result says which file matched. In Notion an uploaded PDF is found by its name.',
      },
      {
        title: 'Built for files',
        body: `Drop a stack of PDFs or photos on the list and each becomes a note with its file attached, up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB a file where Notion’s free plan stops at 5 MB.`,
      },
      {
        title: 'Filing a scan for you',
        body: 'Press Auto-fill and Unbent reads the scan and fills in its title, its notebook and its fields, from the date to the total.',
      },
      {
        title: 'Offline in the browser',
        body: 'Your notes and the files of the notebooks you choose are kept on the device, in the browser too, so a phone finds them with no signal.',
      },
      {
        title: 'One price',
        body: `$${PLAN_PRICE_USD} a year, with no seats and no AI credits to count.`,
      },
    ],
    theyDoBetter: [
      {
        title: 'Databases',
        body: 'Relations between databases, formulas, rollups, and boards, calendars, timelines and charts over them. Unbent’s fields are values on a note, with a table and filters.',
      },
      {
        title: 'Working together',
        body: 'Many people in the same page at once, with comments, mentions and permissions. Unbent has no sharing.',
      },
      {
        title: 'Everything that is not paperwork',
        body: 'Wikis, project plans, docs, published sites and a large library of templates. Unbent is for keeping and finding, not for building a workspace.',
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
        'Joplin is a free, open-source notes app you sync yourself, with end-to-end encryption. Unbent is a hosted archive that reads your scans as they arrive. Which to choose, where they differ, and what each does better.',
      image: CARD_IMAGE,
    },
    summary: 'For someone weighing a free, encrypted notes app they sync themselves against a hosted archive that reads their paperwork for them.',
    lead: 'Unbent and Joplin are different kinds of app. Unbent is a hosted archive for paperwork: scans and files, read as they arrive, found by what they say and sorted by their fields, with nothing to set up. Joplin is a free, open-source notes app you sync yourself, with end-to-end encryption. If what you keep is mostly writing, use Joplin: it is good, and free. This page is about the paper.',
    checked: CHECKED,
    chooseUnbent: [
      'What you keep is mostly paper: scans, receipts, bills and manuals you need to find again by what they say.',
      'You want a scan read the moment it arrives, from a phone as much as a desktop, and filed on a press: title, notebook and fields.',
      'You want fields on your notes (a date, a total, who it was from) and a table to sort them by.',
      'You want nothing to set up and nothing to run (no sync target, no server, no master password), and your AI assistant working in it over the web.',
    ],
    chooseThem: [
      'You want end-to-end encryption, so no server can read your notes.',
      'You want it free, and will run your own sync: Dropbox, OneDrive, Nextcloud, or a server of yours.',
      'What you keep is mostly writing, and the files in it are the exception.',
      'You want native desktop apps, Linux included, to-do notes with alarms, a web clipper, and a plugin for the rest.',
    ],
    whyTheyDiffer: (
      <>
        <p>
          Joplin&apos;s rule is that no server ever reads your notes: with end-to-end
          encryption on, the place they sync to holds only ciphertext, and each device
          decrypts its own copy. It is a good rule, and everything the paperless job needs is
          on the other side of it. Reading a scan the moment it arrives, filing it from what
          it says, and searching an archive from a phone that has never downloaded it all
          need something to read the paper, and that something has to be a server. Joplin
          does what it can on the desktop (its OCR runs there, and the text syncs out to the
          phone); Unbent made the other choice.
        </p>
        <p>
          So the server reads your paperwork, and in return leaving is kept trivial: every
          note is a plain file, the export is plain folders from any browser at any time, and
          an account that stops paying turns read-only rather than locked. Which rule you
          want decides this page, and nothing in the table below changes it.
        </p>
      </>
    ),
    rows: [
      {
        topic: 'Price',
        unbent: US.price,
        them: 'Free, syncing through Dropbox, OneDrive, Nextcloud, WebDAV or S3. Joplin Cloud is €28.69 a year (2 GB, 10 MB a note) or €57.48 (30 GB).',
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
        them: 'Offline first: every app keeps your notes on the device, and sync is optional.',
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
    weDoBetter: [
      {
        title: 'Reading paper as it arrives',
        body: 'Every PDF is read on the server the moment it is added, from any device, and a photo on a press, so a receipt scanned on a phone is searchable from that phone straight away. Joplin reads PDFs and images too, but only in its desktop app: nothing is searchable until a desktop has synced it and run over it.',
      },
      {
        title: 'Filing a scan for you',
        body: 'Press Auto-fill and Unbent reads the scan and fills in its title, its notebook and its fields, from the date to the total.',
      },
      {
        title: 'Fields you can sort by',
        body: 'A receipts notebook can carry a date, a total and a shop on every note, shown as a table and filtered by any of them. Joplin has notebooks and tags, and leaves the rest to plugins.',
      },
      {
        title: 'Any browser, nothing to run',
        body: 'Sign in and it is there, on every device, in a browser or installed from one, offline too. No sync target to choose and look after, and no master password that loses everything if it is forgotten. Joplin’s web app is a beta that keeps its notes in that one browser.',
      },
      {
        title: 'Assistants over the web',
        body: 'Claude, ChatGPT and others connect with a sign-in and work in your notes from anywhere, with every edit kept in the note’s history. Joplin’s MCP server is a desktop beta that only that computer can reach.',
      },
    ],
    theyDoBetter: [
      {
        title: 'Privacy',
        body: 'With end-to-end encryption on, the place your notes sync to holds only ciphertext, and each device decrypts and searches its own copy. Unbent’s server can read your notes, which is what lets it read your paperwork and search a whole archive without every device downloading it first.',
      },
      {
        title: 'Price',
        body: `Free, with a sync target you already have: Dropbox, OneDrive, Nextcloud, WebDAV or S3. Joplin Cloud, for nothing to run, starts at €28.69 a year. Unbent is $${PLAN_PRICE_USD} a year.`,
      },
      {
        title: 'Being a notes app',
        body: 'Native apps for Windows, Mac and Linux, to-do notes with alarms, a web clipper, a Markdown editor with a plugin for most things, and an AGPL codebase you can read and change. Unbent is source-available, not open source, has no plugins, and does notes, files, fields and search for one person.',
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
      { label: 'Joplin: the web clipper', href: 'https://joplinapp.org/help/apps/clipper' },
      { label: 'Joplin: alarms on to-dos', href: 'https://joplinapp.org/help/apps/notifications' },
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
