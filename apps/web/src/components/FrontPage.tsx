import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { configQuery } from '../queries.js';
import { useSession } from '../auth-client.js';
import { FEATURES, FRONT, HOME, LOGIN, PRICING, SUPPORT, WHY } from '../auth-gate.js';
import { EnexHelp, JoplinHelp, NotionHelp } from './ImportHelp.js';
import { LegalLink } from './LegalLink.js';
import { ProviderIcon } from './provider-icons.js';
import { BASE_STORAGE_GB, FREE_NOTES, FREE_STORAGE_GB, PLAN_PRICE_USD, STORAGE_ADDON_GB, STORAGE_ADDON_PRICE_USD, TRIAL_DAYS } from '@unbent/shared';
import {
  AutofillFeatureIcon,
  DisconnectFeatureIcon,
  ExportFeatureIcon,
  FieldsFeatureIcon,
  FilingFeatureIcon,
  OfflineFeatureIcon,
  PhoneAppsFeatureIcon,
  PlainFilesFeatureIcon,
  ReadOnlyFeatureIcon,
  ScanInFeatureIcon,
  ScanTextFeatureIcon,
  SearchFilesFeatureIcon,
  SourceFeatureIcon,
} from './icons.js';

/**
 * Where the code is. A constant rather than configuration because this page is only ever
 * shown by the public instance (see `routes/index.tsx`), which is this repository's.
 */
export const SOURCE_URL = 'https://github.com/MakeRocketGoNow/unbent';
/** The two places the page sends a reader who wants the detail behind a claim. */
const ASSISTANTS_DOC_URL = `${SOURCE_URL}/blob/main/docs/assistants.md`;
const FILES_README_URL = `${SOURCE_URL}#your-notes-are-files`;

/**
 * unbent.app's front page, for someone who is not signed in.
 *
 * Written for a person arriving from a link with no idea what this is, and who is not a
 * developer: someone leaving Evernote with years of scans, or dreading its next price.
 * The order answers their questions as they come up: what this is for, what it looks
 * like, whether it will find their paperwork, what it does with AI (both the reader who
 * wants an assistant in it and the one who wants none near their notes), how their notes
 * get in, what they keep if they leave, what else is in it, and what it costs.
 *
 * The words are the buyer's, not the code's. "Markdown", "byte-identical" and the rest
 * are true and are kept, one click away in the README and the docs, where the reader who
 * wants proof goes looking; here a note is "a plain text file, saved exactly as you typed
 * it". The first version of this page led with the Markdown promise, and read as a page
 * for developers (2026-10-17). The one-line description is shared with the README, the
 * page's metadata, the sign-in screen and the Play listing, so the five say one thing.
 *
 * One action, Start your free trial, and it is the only filled control on the page. The
 * header's Sign in is for people who already have an account and is drawn as the link it
 * is. Both go to the sign-in screen today, because an account is created by signing in;
 * when checkout exists (MAK-108) the trial is where it would branch.
 *
 * The prices are the shared constants (`packages/shared/src/plan.ts`), which the Plan page
 * quotes too and which Stripe's catalog is kept in step with (MAK-108): one place to change
 * a number, and this page and the checkout agree.
 *
 * The screenshots are of the demo library `pnpm seed:demo` loads, never of anyone's real
 * notes, which is a rule about this repository and not only about this page. They are WebP
 * in `public/front/`, which keeps them out of the service worker's precache (it takes PNGs,
 * for the app icons): every visit to the app would otherwise download pictures of the app.
 */
export function FrontPage() {
  return (
    <FrontShell>
      <section className="front-hero front-width">
        {/* Three beats, each kept whole: a line may break between sentences, never inside
            one, so a width that fits two beats shows "Keep everything. Find anything." over
            "Take it all with you." and never "Find" over "anything." */}
        <h1>
          <span className="front-beat">Keep everything.</span>{' '}
          <span className="front-beat">Find anything.</span>{' '}
          <span className="front-beat">Take it all with you.</span>
        </h1>
        <p className="front-lead">
          Unbent keeps your notes, receipts and scanned paperwork together and finds them by
          what they say, even a photo of a receipt. Everything is an ordinary file you can
          download whenever you like, and if you ever stop paying, nothing is held hostage.
        </p>
        <div className="front-cta">
          {/* An anchor wearing the filled button's shape, which the stylesheet allows for
              exactly this: it goes somewhere (it can be opened in a new tab and copied),
              so it is a link, and it is the one thing this page is for, so it is filled.
              `Button` deliberately renders no anchors; see its header. */}
          <Link to={LOGIN} className="btn btn-primary front-cta-button">
            Start your free trial
          </Link>
          <p className="muted">{TRIAL_DAYS} days free, no card needed. Then ${PLAN_PRICE_USD} a year.</p>
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
      {/* Under the two pictures, where someone who wants more of them is looking; the
          features page is the rest of this page's claims, shown. */}
      <p className="front-more front-width">
        <Link to={FEATURES}>See every feature, in pictures</Link>
      </p>

      {/* The lead section is the paperless office, named as such, because it is the use
          the app was built for and the one its buyer is searching for. Its four cards are
          the workflow in order (a scan comes in, is filed, is found, is counted), two by
          two rather than three and an orphan. */}
      <Section
        title="Your paperless office"
        intro="Scan the bills, receipts, manuals and letters once and recycle the paper. Unbent files them, tags them, and finds them by what is written on them."
      >
        <div className="front-grid front-grid-pairs">
          <Point icon={<ScanInFeatureIcon />} title="Scan it, drop it in">
            Drop a stack of PDFs or photos on the list and each becomes a note with the file
            attached. Install the app and your scanner can send straight to it.
          </Point>
          <Point icon={<AutofillFeatureIcon />} title="One press files a scan">
            Press Auto-fill and an AI reads the scan and fills in its title, its notebook and
            any empty fields: the date, the total, who it was from. You check it instead of
            typing it, and it only runs when you press it.
          </Point>
          <Point icon={<SearchFilesFeatureIcon />} title="Search inside your files">
            Search reaches the text in every PDF you attach, and pictures and scans are read
            too, so a photo of a receipt turns up under the name of the shop.
          </Point>
          <Point icon={<FieldsFeatureIcon />} title="Notebooks that work like a spreadsheet">
            Give a notebook dates, amounts, ratings or choices, then see it as a table and
            filter by any of them. Receipts by month, warranties by when they run out.
          </Point>
        </div>
      </Section>

      <Section
        title="Works with your AI assistant. Off until you say so."
        intro={
          <div className="front-intro">
            <p className="muted">
              Unbent is a full MCP server, so Claude, ChatGPT, Cursor or any assistant you
              already use can work in your notes the moment you connect it. Not a toy: it can
              search, read the text of a scanned bill or look at the picture itself, write and
              edit notes, file a batch into a notebook, fill in fields across a hundred
              receipts, and manage notebooks and tags. About thirty tools, under the same
              rules the app has.
            </p>
            <p className="muted">
              And it is yours to switch on. Unbent never sends your notes to a model on its
              own: the one feature that uses AI, Auto-fill, runs only when you press it, and
              your assistant runs on your own account, not ours. Settings › AI assistants shows
              everything you have let in, and disconnecting it ends its access that second.{' '}
              <a href={ASSISTANTS_DOC_URL} rel="noopener noreferrer">
                Connecting an assistant
              </a>
              .
            </p>
          </div>
        }
      >
        <div className="front-grid">
          <Point icon={<ScanTextFeatureIcon />} title="Reads your scans">
            The text inside every PDF, and the picture itself when there is none, so
            &ldquo;what did I pay the plumber in March&rdquo; is a question it can answer.
          </Point>
          <Point icon={<FilingFeatureIcon />} title="Does the filing">
            Imported a thousand receipts into a notebook with new fields? Ask your assistant
            to fill them in. It reads a page of summaries at a time and writes the values,
            and a value you set yourself is never touched.
          </Point>
          <Point icon={<DisconnectFeatureIcon />} title="On a leash">
            Access you grant once and take back in one click. No assistant can delete
            anything for good, and every edit one makes is kept in the note&apos;s history,
            so you can see what it did and put it back.
          </Point>
        </div>
      </Section>

      <Section
        title="Bring what you have"
        intro="Leaving should be easy, and staying should never depend on it being hard: that goes for the app you are leaving, too."
      >
        {/* Four cards, so two by two: three across left "Start empty" alone on a row. */}
        <div className="front-grid front-grid-pairs">
          <Point title="From Evernote" help={<EnexHelp />}>
            Import an .enex export. Each file becomes a notebook, and every note keeps its
            tags, dates and attachments.
          </Point>
          <Point title="From Notion" help={<NotionHelp />}>
            Import a Markdown &amp; CSV export. Each database becomes a notebook, with its
            columns as the notebook&apos;s fields.
          </Point>
          <Point title="From Joplin" help={<JoplinHelp />}>
            Import a JEX export. Every note keeps its notebook, tags, dates and attachments,
            and links between notes still work.
          </Point>
          <Point title="Start empty">
            Nothing to bring? Sign in and write. Notebooks, tags and fields can come later, or
            not at all.
          </Point>
        </div>
      </Section>

      <Section
        title="Yours, not ours"
        intro="Your notes are ordinary files, kept the way you wrote them, and the way out is always open."
      >
        <div className="front-grid">
          <Point icon={<PlainFilesFeatureIcon />} title="Plain files, never rewritten">
            Every note is a plain text file, saved exactly as you typed it. Unbent never
            reformats your writing behind your back.{' '}
            <a href={FILES_README_URL} rel="noopener noreferrer">
              How the files are kept
            </a>
            .
          </Point>
          <Point icon={<ExportFeatureIcon />} title="Export everything, any time">
            Download your whole library as a folder: one folder per note, with its files
            beside it. Open it on any computer with nothing from us installed, or import it
            back into any Unbent.
          </Point>
          <Point icon={<ReadOnlyFeatureIcon />} title="Read-only, not gone">
            If a trial ends or you stop paying, an account of up to {FREE_NOTES} notes stays
            free and a larger one turns read-only. Every note still opens, searches and
            exports, for at least a year. Nothing is held hostage.
          </Point>
        </div>
      </Section>

      <Section title="Also in it">
        <div className="front-grid">
          {/* Coming soon because neither app is in a store yet, and a visitor who goes
              looking for one should not come back empty-handed after reading that it
              exists. Said in the title rather than as a badge beside it: a pill here
              would be the only one on the page, and would look like a control. Once an
              app ships, this says so and links its store page. */}
          <Point icon={<PhoneAppsFeatureIcon />} title="Android and iOS apps, coming soon">
            The same notes on your phone, and a share sheet that files a page, a photo or a
            stack of scans as a note. Until then, Unbent works in your phone&apos;s browser.
          </Point>
          <Point icon={<OfflineFeatureIcon />} title="Offline, with history">
            Your library lives on each device too, so the app opens with no connection and
            syncs when it is back. Every note keeps what an edit replaced, so you can put it
            back.
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
        <Pricing />
      </Section>
    </FrontShell>
  );
}

/**
 * The header and footer of the public pages, around their content: the front page, the
 * pricing page (`PricingPage`), the story (`WhyPage`) and support (`SupportPage`). One component so they cannot
 * drift apart, and so each is recognisably the same site.
 *
 * The header's nav is the three pages a visitor deciding whether to try the app goes
 * looking for (Features, Pricing, Why), as links, with the one they are on marked
 * `aria-current`; the comparisons and support stay in the footer, since the first are
 * for a search to land on and the second is for after. A site with the features
 * somewhere a visitor could not find them was the frustration the features page
 * answers, so the nav is on every public page, the front page included.
 *
 * The header's other link is the way back for people who already have an account, drawn
 * as the link it is. On the front page that is always Sign in, since `/` sends anyone
 * signed in to their notes before this renders; the pricing page is shown to signed-in
 * people too, and offering them a sign-in they do not need would be the kind of control
 * that teaches people the page does not know who they are. The route has asked for the
 * session before rendering, so the link does not flip after the page has drawn.
 */
export function FrontShell({ children }: { children: ReactNode }) {
  const config = useQuery(configQuery());
  const legal = config.data?.legal;
  const operator = config.data?.operator;
  const { data: session } = useSession();

  return (
    <div className="front">
      <header className="front-header front-width">
        {/* The brand is a link home on every page but the front page itself, where it
            is already there; a link to the page it is on would be a control that does
            nothing, so it is text there. */}
        <Link to={FRONT} className="front-brand" activeOptions={{ exact: true }} activeProps={{ 'aria-current': 'page' }}>
          <img src="/icons/icon-192.png" alt="" width={28} height={28} />
          Unbent
        </Link>
        <nav className="front-nav" aria-label="Unbent">
          <Link to={FEATURES} activeProps={{ 'aria-current': 'page' }}>
            Features
          </Link>
          <Link to={PRICING} activeProps={{ 'aria-current': 'page' }}>
            Pricing
          </Link>
          <Link to={WHY} activeProps={{ 'aria-current': 'page' }}>
            Why
          </Link>
        </nav>
        {session ? (
          <Link to={HOME} className="front-signin">
            Your notes
          </Link>
        ) : (
          <Link to={LOGIN} className="front-signin">
            Sign in
          </Link>
        )}
      </header>

      <main>{children}</main>

      <footer className="front-footer front-width">
        <nav aria-label="About Unbent">
          {/* The story first, since it is about the product and the rest is about the
              operator; a router link, since it is a page of this site. */}
          <Link to={WHY}>Why Unbent</Link>
          {legal && <LegalLink href={legal.privacy}>Privacy</LegalLink>}
          {legal && <LegalLink href={legal.terms}>Terms</LegalLink>}
          {/* A page rather than the mailto: it was, which opened a mail client on anyone
              who only wanted to know how to cancel, and which Stripe's public details
              would not take as a support address. The page carries the address too. */}
          <Link to={SUPPORT}>Support</Link>
          {/* The mark says where the link goes before the word does: the one footer
              link that leaves for another site. The sign-in screen's copy of it, so
              there is one GitHub mark in the app. */}
          <a href={SOURCE_URL} rel="noopener noreferrer" className="front-source">
            <ProviderIcon provider="github" />
            Source
          </a>
        </nav>
        {operator && <p className="muted">Unbent is run by {operator.name}.</p>}
      </footer>
    </div>
  );
}

/**
 * The free plan, the paid one, its price and what happens when it lapses: the one
 * statement of the offer, which the front page draws under its Pricing heading and the
 * pricing page draws as the page. The merchant of record's review reads the pricing page
 * and a visitor reads the front page, and the two must say the same thing; the numbers
 * are the shared constants, so they also agree with the Plan page and the checkout.
 *
 * Free first and quieter: it is the floor under the plan, not a second product, so its
 * card has no border to compete with the one being sold, and lists what it holds and
 * that every feature comes with it rather than repeating the plan's list. Its Auto-fill
 * is the one feature with a limit of its own, a pool of presses (`AUTOFILL_FREE_PRESSES`),
 * said as that and without the number, which is the instance's to set; "everything
 * else, Auto-fill included" said more than the free plan gives.
 */
export function Pricing() {
  return (
    <div className="front-pricing">
      <div className="front-plan front-plan-free">
        <p className="front-amount">
          <strong>Free</strong>
        </p>
        <ul>
          <li>Up to {FREE_NOTES} notes, counting the trash, in as many notebooks as you like</li>
          <li>{FREE_STORAGE_GB} GB of attachments</li>
          <li>Every feature the plan has, with a set number of Auto-fill presses</li>
        </ul>
        <p className="muted">For a small library, for as long as you like. No card.</p>
      </div>
      <div className="front-plan">
        <p className="front-amount">
          <strong>${PLAN_PRICE_USD}</strong> a year
        </p>
        <ul>
          <li>Unlimited notes</li>
          <li>{BASE_STORAGE_GB} GB of attachments, and {STORAGE_ADDON_GB} GB more for ${STORAGE_ADDON_PRICE_USD} a year</li>
          <li>The web app and AI assistants, with Android and iOS apps coming soon</li>
          <li>Auto-fill, which reads a scan and fills in its title, notebook and fields</li>
          <li>Every note&apos;s history, and your library on each device, offline too</li>
          <li>Export everything, as often as you like</li>
        </ul>
        <p className="muted">
          {TRIAL_DAYS} days free, with no card needed to start. Billed yearly, which is $
          {PLAN_PRICE_USD / 12} a month.
        </p>
      </div>
      <div className="front-lapse">
        <h3>If you stop paying</h3>
        <p>
          Nothing is held hostage. When a trial ends or a plan lapses, an account within
          the free plan carries on as a free one. A larger one turns read-only: every note
          still opens, searches and exports, and you can still delete, down to the free
          plan if you like. It is kept that way for at least a year, and you will be
          reminded to export before anything is removed.
        </p>
      </div>
    </div>
  );
}

/**
 * A heading and what it introduces, on the page's one vertical rhythm. An intro is usually
 * one sentence; the assistant section's is two paragraphs with a link, so a node is taken
 * too and drawn as given, inside its own `.front-intro`.
 */
function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="front-section front-width">
      <h2>{title}</h2>
      {typeof intro === 'string' ? <p className="front-intro muted">{intro}</p> : intro}
      {children}
    </section>
  );
}

/**
 * One claim and its paragraph. `help` sits under the paragraph: the import notes, which
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
