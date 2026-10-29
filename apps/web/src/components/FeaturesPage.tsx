import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { TRIAL_DAYS } from '@unbent/shared';
import { useSession } from '../auth-client.js';
import { HOME, LOGIN } from '../auth-gate.js';
import { CARD_IMAGE, usePageMeta, type PageMeta } from '../page-meta.js';
import { useMediaQuery } from '../useMediaQuery.js';
import { FrontShell } from './FrontPage.js';

/**
 * What the tab, a search result and a link's card say this page is. Exported for the
 * build, which writes the same into the page's static copy (`prerender.tsx`).
 */
export const FEATURES_META: PageMeta = {
  title: 'Features · Unbent',
  description:
    'Every feature of Unbent, shown rather than listed: scans dropped on the list, Auto-fill reading a receipt, search inside a photo, notebooks as tables, history, offline, export and the AI assistants it works with.',
  image: CARD_IMAGE,
};

/**
 * Every feature, shown: `/features`.
 *
 * Written for the reader the front page has interested and not yet convinced, who wants
 * to see the thing before trying it. The front page names each feature in a sentence;
 * this page shows each one in a picture of the app as it is, or a clip of it being used,
 * with a paragraph beside it. A competitor's site with a list of nouns and no pictures
 * was the frustration this page answers (2026-10-28).
 *
 * Every picture is of the demo library `pnpm seed:demo` loads, taken by
 * `scripts/shoot-features.mjs` in both themes and at both widths it needs, and shown in
 * the reader's own theme so the page and the app it shows look like the same product. A
 * clip is a short silent loop (WebM and MP4, with its first frame as a poster) rather
 * than a GIF, which would be ten times the bytes and dithered on the screens that show
 * it, and plays only while it is on screen; a reader who has asked for less motion gets
 * the poster alone. When the app changes, the script is run again; a page of stale
 * pictures is worse than one with none.
 *
 * The groups are the order the front page tells the story in (paper comes in, is found,
 * is structured, is kept, is shared with an assistant, is on the phone), and every row is
 * the same shape: a picture and a paragraph, sides alternating, so the eye runs down the
 * page in a zigzag rather than a column. One filled control, the trial, at the end;
 * someone signed in gets their notes instead, as on the pricing page.
 *
 * The media are under `public/features/`, beside the front page's `front/`, and like
 * them kept out of the service worker's precache (`vite.config.ts`): a person using the
 * app must never download pictures of the app.
 */
export function FeaturesPage() {
  const { data: session } = useSession();
  usePageMeta(FEATURES_META);

  return (
    <FrontShell>
      <section className="front-hero front-width">
        {/* The heading alone: a lead that explained the pictures ("the app as it is, in
            your theme, not a mock-up") was taken out on 2026-10-29, since the pictures
            say it and a reader who scrolled past it lost nothing. */}
        <h1>What Unbent does</h1>
      </section>

      <div className="features front-width">
        <Group
          title="Paper comes in"
          intro="Scan it, drop it on the list, and let one press name and file it."
        >
          <Feature
            title="Drop a stack of scans on the list"
            media={
              <Clip
                name="drop"
                label="Three scanned receipts dragged onto the Receipts list become three notes, each with its scan attached."
              />
            }
          >
            Each file becomes a note with the scan attached, filed in the notebook you are
            looking at. Drop thirty at once and they land in order. With the app installed,
            a scanner can send straight to it.
          </Feature>
          <Feature
            title="One press reads the scan and fills in the note"
            media={
              <Clip
                name="autofill"
                label="Auto-fill pressed on a note that is only a scan: the title, a tag, the vendor, amount, date and category fill in."
              />
            }
          >
            Auto-fill reads the receipt and writes its title, a tag and the fields: who it
            was from, the amount, the date, the category. You check it instead of typing it,
            and Undo is one press. It runs only when you press it, and never on its own.
          </Feature>
          <Feature
            title="Bring everything from Evernote, Notion or Joplin"
            media={<Still name="import" alt="The Import settings page, listing the exports it takes: .enex, an Unbent zip, a Notion zip, a Joplin .jex, and PDFs or images." />}
          >
            An Evernote .enex, a Notion export or a Joplin .jex keeps notebooks, tags, dates
            and attachments, and the text already inside every scan. An interrupted import
            is safe to run again: nothing duplicates.
          </Feature>
        </Group>

        <Group title="Finding it again" intro="Search reads what the paper says, not only the title you gave it.">
          <Feature
            title="Search inside PDFs and photos"
            media={
              <Clip
                name="search"
                label="Typing a word into search finds a receipt by the text on its photo, and opens it."
              />
            }
          >
            The word typed here is printed on a photo of a receipt and nowhere else in the
            library, and search finds the note by it. Every PDF&apos;s text is searched, and
            a picture or a scan with no text in it is read.
          </Feature>
          <Feature
            title="Filters you can keep"
            media={
              <Clip
                name="views"
                label="Two saved views of the Receipts notebook opened in turn: Not reimbursed, as a table with a total, then Dining."
              />
            }
          >
            Narrow a notebook by a field, a tag or a range of dates, sort it, see it as a
            table, and keep that as a view beside the notebook. Not reimbursed, Unused
            coupons, Up next: one click each, with a total under the amounts.
          </Feature>
          <Feature
            title="Act on many notes at once"
            media={<Still name="select" alt="Three receipts selected in the list, with a bar offering to move, tag, export or delete them together." />}
          >
            Select a handful, or a whole list, and move, tag, export or delete them
            together.
          </Feature>
        </Group>

        <Group
          title="Notebooks that know what is in them"
          intro="Give a notebook fields and it becomes a list you can sort, filter and add up."
        >
          <Feature
            title="Fields on every note"
            media={<Still name="note" alt="A receipt open beside the list: its notebook, a tag, and the vendor, amount, date, category and reimbursed fields above the scan." />}
          >
            A receipt&apos;s notebook has a vendor, an amount, a date, a category and a
            checkbox. Dates, money, ratings, choices, links, addresses: each kind is drawn as
            what it is, and edited in place.
          </Feature>
          <Feature
            title="The notebook as a table"
            media={<Still name="table" alt="The Receipts notebook as a table: a column per field, sortable, with the amounts totalled underneath." />}
          >
            The same notebook as a spreadsheet: a column per field, sortable, with totals
            under the numbers. Pick the columns, and edit a cell without opening the note.
          </Feature>
          <Feature
            title="Fields you define"
            media={<Still name="notebook" alt="A notebook's settings: its name, its purpose, and its fields with their types and options." />}
          >
            Name a notebook&apos;s purpose and its fields in its settings. Auto-fill reads the
            purpose when it decides where a note belongs, and the options of a choice are
            yours to spell.
          </Feature>
          <Feature
            title="Or as cards"
            media={<Still name="cards" alt="A restaurants notebook shown as cards, each with the first lines of the note and its fields." />}
          >
            List, cards or table, remembered per notebook: recipes as cards, receipts as a
            table, everything else as a list.
          </Feature>
        </Group>

        <Group
          title="Yours to keep"
          intro="Plain files, every version kept, on every device, and the way out always open."
        >
          <Feature
            title="Every edit is kept"
            media={<Still name="history" alt="The History sheet over a note, showing a version's changes with the lines it would add and remove marked." />}
          >
            A note keeps what an edit replaced, whether you made it or an assistant did, with
            the changes marked. Any version can be put back, and putting it back is kept
            too.
          </Feature>
          <Feature
            title="Works with no connection"
            media={<Still name="offline" alt="The Offline settings page: how much of the device the library uses, which notebooks are kept offline, and the files kept from opening them." />}
          >
            Your library lives on each device as well as on the server. The app opens on a
            plane, what you write waits its turn, and whole notebooks can be kept offline,
            files and all.
          </Feature>
          <Feature
            title="Export everything, any time"
            media={<Still name="export" alt="The Export settings page, showing the folder an export produces: one folder per note, its Markdown file and its files beside it." />}
          >
            One folder per note, with its files beside it, as plain text you can open with
            nothing installed, or import back into any Unbent. Nothing is held hostage.
          </Feature>
        </Group>

        <Group
          title="Your AI assistant, on a leash"
          intro="Connect the assistant you already use, and disconnect it the moment you like."
        >
          <Feature
            title="Claude, ChatGPT, Cursor or any other"
            media={<Still name="assistants" alt="The AI assistants settings page, with the address an assistant connects to and the instructions to paste into it." />}
          >
            Unbent is an MCP server. Point an assistant at it and it can search, read your
            scans, write notes, file a batch into a notebook and fill in fields across a
            hundred receipts, under the same rules the app has. It cannot delete anything
            for good, every edit it makes is in the note&apos;s history, and disconnecting it
            ends its access that second.
          </Feature>
        </Group>

        <Group title="On your phone" intro="The same app at phone width, and Android and iOS apps on the way.">
          <div className="features-phones">
            <Still name="list" phone alt="The note list on a phone." />
            <Still name="note" phone alt="A receipt open on a phone, its fields above the scan." />
            <Still name="cards" phone alt="A notebook as cards on a phone." />
          </div>
          <Feature
            title="Light and dark"
            media={
              <div className="features-pair">
                <img src="/features/note-light.webp" width={1280} height={800} loading="lazy" decoding="async" alt="A note in the light theme." />
                <img src="/features/note-dark.webp" width={1280} height={800} loading="lazy" decoding="async" alt="The same note in the dark theme." />
              </div>
            }
          >
            Both themes follow your device. Every other picture on this page already did.
          </Feature>
        </Group>

        <div className="front-cta features-cta">
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
      </div>
    </FrontShell>
  );
}

/** A heading, one sentence under it, and the features it groups. */
function Group({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="front-section features-group">
      <h2>{title}</h2>
      <p className="front-intro muted">{intro}</p>
      {children}
    </section>
  );
}

/**
 * One feature: its picture, and a title and paragraph beside it. The side the picture
 * takes alternates down the page by the stylesheet, not by a prop, so adding a row in
 * the middle of a group does not mean renumbering the rest.
 */
function Feature({ title, media, children }: { title: string; media: ReactNode; children: ReactNode }) {
  return (
    <article className="feature">
      <div className="feature-text">
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
      <div className="feature-media">{media}</div>
    </article>
  );
}

/**
 * A screenshot in whichever theme the reader is in, as the front page's `Shot`:
 * `<picture>` rather than CSS, so a browser downloads only the one it shows. The files
 * are `scripts/shoot-features.mjs`'s, at the desktop frame or the phone's, whose
 * proportions reserve the picture's box before it arrives. Lazy, because the page is
 * long and most of its pictures are below the fold.
 */
function Still({ name, phone = false, alt }: { name: string; phone?: boolean; alt: string }) {
  const file = phone ? `${name}-phone` : name;
  const [width, height] = phone ? [390, 844] : [1280, 800];
  return (
    <picture className={`feature-shot${phone ? ' feature-shot-phone' : ''}`}>
      <source srcSet={`/features/${file}-dark.webp`} media="(prefers-color-scheme: dark)" />
      <img src={`/features/${file}-light.webp`} width={width} height={height} loading="lazy" decoding="async" alt={alt} />
    </picture>
  );
}

/**
 * A short silent loop of the app being used, in the reader's theme.
 *
 * Played only while it is on screen, and never for a reader who has asked for less
 * motion, who gets the first frame as a picture instead. The theme is read with
 * `useMediaQuery` rather than `<source media>`, which `<video>` does not honour; the
 * static copy of the page, drawn with no window, carries the light clip, as it carries
 * the light poster, and the app redraws it once it runs. `label` says what the clip
 * shows, since a video has no alt text.
 */
function Clip({ name, label }: { name: string; label: string }) {
  const dark = useMediaQuery('(prefers-color-scheme: dark)');
  const still = useMediaQuery('(prefers-reduced-motion: reduce)');
  const ref = useRef<HTMLVideoElement>(null);
  const file = `/features/${name}-${dark ? 'dark' : 'light'}`;

  useEffect(() => {
    const video = ref.current;
    if (!video || still || typeof IntersectionObserver === 'undefined') return;
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.4 },
    );
    watcher.observe(video);
    return () => watcher.disconnect();
  }, [still, file]);

  if (still) {
    return (
      <div className="feature-shot feature-clip">
        <img src={`${file}-poster.webp`} width={1920} height={1200} loading="lazy" decoding="async" alt={label} />
      </div>
    );
  }
  return (
    <div className="feature-shot feature-clip">
      <video
        key={file}
        ref={ref}
        width={1920}
        height={1200}
        muted
        loop
        playsInline
        preload="metadata"
        poster={`${file}-poster.webp`}
        aria-label={label}
      >
        <source src={`${file}.webm`} type="video/webm" />
        <source src={`${file}.mp4`} type="video/mp4" />
      </video>
    </div>
  );
}
