import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { LOGIN } from '../auth-gate.js';
import { EnexHelp, NotionHelp } from './ImportHelp.js';
import { LegalLink } from './LegalLink.js';
import {
  AndroidFeatureIcon,
  AssistantFeatureIcon,
  FieldsFeatureIcon,
  SearchFilesFeatureIcon,
  SourceFeatureIcon,
} from './icons.js';

/**
 * Where the code is. A constant rather than configuration because this page is only ever
 * shown by the public instance (see `routes/index.tsx`), which is this repository's.
 */
const SOURCE_URL = 'https://github.com/MakeRocketGoNow/unbent';

/**
 * unbent.app's front page, for someone who is not signed in.
 *
 * Written for a person arriving from a link with no idea what this is: what it promises,
 * what it looks like, how their notes get in, what it costs and what happens if they stop
 * paying — in that order, because each answers the question the one before it raises. The
 * promise and its wording are the README's, so the page and the repository make the same
 * claim.
 *
 * One action, Start your free trial, and it is the only filled control on the page. The
 * header's Sign in is for people who already have an account and is drawn as the link it
 * is. Both go to the sign-in screen today, because an account is created by signing in;
 * when checkout exists (MAK-108) the trial is where it would branch.
 *
 * The prices are unbent.app's, written here rather than served, because they are copy on a
 * page rather than data anything computes with. Billing is what will make them true or
 * false, so when it lands it should be the source and this should read from it.
 *
 * The screenshots are of the demo library `pnpm seed:demo` loads — never of anyone's real
 * notes, which is a rule about this repository and not only about this page. They are WebP
 * in `public/front/`, which keeps them out of the service worker's precache (it takes PNGs,
 * for the app icons): every visit to the app would otherwise download pictures of the app.
 */
export function FrontPage() {
  const config = useQuery(configQuery());
  const legal = config.data?.legal;
  const operator = config.data?.operator;

  return (
    <div className="front">
      <header className="front-header front-width">
        <span className="front-brand">
          <img src="/icons/icon-192.png" alt="" width={28} height={28} />
          Unbent
        </span>
        <Link to={LOGIN} className="front-signin">
          Sign in
        </Link>
      </header>

      <main>
        <section className="front-hero front-width">
          <h1>Notes in Markdown that you can always take with you.</h1>
          <p className="front-lead">
            Unbent keeps your writing, your receipts and your scans in plain Markdown. A note you
            save is byte-identical to what you typed, and an export is an ordinary folder you
            can open without us.
          </p>
          <div className="front-cta">
            {/* An anchor wearing the filled button's shape, which the stylesheet allows for
                exactly this: it goes somewhere — it can be opened in a new tab and copied —
                so it is a link, and it is the one thing this page is for, so it is filled.
                `Button` deliberately renders no anchors; see its header. */}
            <Link to={LOGIN} className="btn btn-primary front-cta-button">
              Start your free trial
            </Link>
            <p className="muted">14 days free, no card needed. Then $36 a year.</p>
          </div>
        </section>

        <figure className="front-shots front-width">
          <Shot
            name="desktop"
            width={1280}
            height={800}
            alt="Unbent in a desktop browser: notebooks in a sidebar, a list of notes, and a note open beside them."
          />
          <Shot
            name="phone"
            width={390}
            height={844}
            alt="Unbent on a phone: the list of notes."
          />
        </figure>

        <Section title="Yours to take with you">
          <div className="front-grid">
            <Point title="Byte for byte">
              The Markdown is the note, not a copy of one. No reflowed lists, no italics quietly
              rewritten, no escaped characters appearing in your text overnight.
            </Point>
            <Point title="A plain folder tree">
              Export is one folder per note: its Markdown, and its files beside it. Read it, grep
              it, back it up — nothing from this app is needed to open it.
            </Point>
            <Point title="Still feels like a notes app">
              A formatting toolbar, headings, checklists, tables and code, styled as you type.
              The Markdown is underneath, where you can always get at it.
            </Point>
          </div>
        </Section>

        <Section
          title="Three ways in"
          intro="Leaving should be easy, and staying should never depend on it being hard — that goes for the app you are leaving, too."
        >
          <div className="front-grid">
            <Point title="From Evernote" help={<EnexHelp />}>
              Import an .enex export. Each file becomes a notebook, and every note keeps its
              tags, dates and attachments.
            </Point>
            <Point title="From Notion" help={<NotionHelp />}>
              Import a Markdown &amp; CSV export. Each database becomes a notebook, with its
              columns as the notebook&apos;s fields.
            </Point>
            <Point title="Start empty">
              Nothing to bring? Sign in and write. Notebooks, tags and fields can come later, or
              not at all.
            </Point>
          </div>
        </Section>

        <Section title="What else is in it">
          <div className="front-grid">
            <Point icon={<SearchFilesFeatureIcon />} title="Search inside your files">
              Search reaches the text in the PDFs you attach, and pictures and scans are read
              too, so a photo of a receipt turns up under the name of the shop.
            </Point>
            <Point icon={<FieldsFeatureIcon />} title="Fields on a notebook">
              Give a notebook dates, amounts, ratings or choices, then see it as a table and
              filter by any of them.
            </Point>
            <Point icon={<AssistantFeatureIcon />} title="Your AI assistant, if you want one">
              An MCP server lets Claude and other assistants search, read and file your notes —
              once you connect them, and only until you disconnect them.
            </Point>
            <Point icon={<AndroidFeatureIcon />} title="An Android app">
              The same notes on your phone, and a share sheet that files a page, a photo or a
              stack of scans as a note.
            </Point>
            <Point icon={<SourceFeatureIcon />} title="Run it yourself">
              The source is public, and Unbent runs on Cloudflare&apos;s free tier.{' '}
              <a href={SOURCE_URL} rel="noopener noreferrer">
                Read the code
              </a>
              .
            </Point>
          </div>
        </Section>

        <Section title="Pricing">
          <div className="front-pricing">
            <div className="front-plan">
              <p className="front-amount">
                <strong>$36</strong> a year
              </p>
              <ul>
                <li>Unlimited notes</li>
                <li>10 GB of attachments, and 25 GB more for $12 a year</li>
                <li>The web app, the Android app and AI assistants</li>
                <li>Export everything, as often as you like</li>
              </ul>
              <p className="muted">14 days free, with no card needed to start. Billed yearly.</p>
            </div>
            <div className="front-lapse">
              <h3>If you stop paying</h3>
              <p>
                Nothing is held hostage. When a trial ends or a plan lapses, the account turns
                read-only: every note still opens, searches and exports, and you can still
                delete. It stays that way for a year, with reminders to export, before the
                account is deleted.
              </p>
            </div>
          </div>
        </Section>
      </main>

      <footer className="front-footer front-width">
        <nav aria-label="About Unbent">
          {legal && <LegalLink href={legal.privacy}>Privacy</LegalLink>}
          {legal && <LegalLink href={legal.terms}>Terms</LegalLink>}
          {operator && <a href={`mailto:${operator.email}`}>Contact</a>}
          <a href={SOURCE_URL} rel="noopener noreferrer">
            Source
          </a>
        </nav>
        {operator && <p className="muted">Unbent is run by {operator.name}.</p>}
      </footer>
    </div>
  );
}

/** A heading and what it introduces, on the page's one vertical rhythm. */
function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section className="front-section front-width">
      <h2>{title}</h2>
      {intro && <p className="front-intro muted">{intro}</p>}
      {children}
    </section>
  );
}

/**
 * One claim and its paragraph. `help` sits under the paragraph — the import notes, which
 * are a click away rather than spelled out, because most people reading them have not
 * decided yet and only the ones who have need the menus.
 */
function Point({
  title,
  icon,
  help,
  children,
}: {
  title: string;
  icon?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="front-point">
      {icon && <span className="front-point-icon">{icon}</span>}
      <h3>{title}</h3>
      <p>{children}</p>
      {help}
    </div>
  );
}

/**
 * A screenshot in whichever theme the reader is in, so the page they are reading and the
 * app it shows look like the same product. `<picture>` rather than CSS, so a browser
 * downloads only the one it shows.
 *
 * `width` and `height` are the shot's own proportions, which reserve its box before the
 * file arrives; the stylesheet scales it from there.
 */
function Shot({
  name,
  width,
  height,
  alt,
}: {
  name: string;
  width: number;
  height: number;
  alt: string;
}) {
  return (
    <picture className={`front-shot front-shot-${name}`}>
      <source srcSet={`/front/${name}-dark.webp`} media="(prefers-color-scheme: dark)" />
      <img src={`/front/${name}-light.webp`} width={width} height={height} alt={alt} />
    </picture>
  );
}
