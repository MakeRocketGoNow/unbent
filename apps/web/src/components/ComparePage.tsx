import { Link } from '@tanstack/react-router';
import { PLAN_PRICE_USD, TRIAL_DAYS } from '@unbent/shared';
import { useSession } from '../auth-client.js';
import { HOME, LOGIN, WHY } from '../auth-gate.js';
import { usePageMeta } from '../page-meta.js';
import { FrontShell } from './FrontPage.js';
import { COMPARE_META, COMPARISONS, comparison, type Comparison } from './comparisons.js';

/**
 * Unbent beside another app, one page each: `/compare/evernote`, `/compare/notion`,
 * `/compare/joplin`, `/compare/paperless-ngx`, and `/compare` listing them.
 *
 * Written for someone already weighing the two, who knows the other app better than we
 * do and will stop trusting a table the moment it is one-sided. So every page has the same
 * seven parts in the same order: who should pick which (both halves), why the two differ
 * (the choice under the facts, named once so the table can be facts), the facts side by
 * side, what Unbent does better, what the other app does better (the part a vendor's
 * comparison usually leaves out), how to move, and when the facts were checked, with
 * their sources. The
 * content is data (`comparisons.tsx`) and this is the one layout, so a price that changes
 * is a line to edit and the pages cannot drift into as many designs.
 *
 * Not linked from the front page, deliberately: the front page sells Unbent on its own
 * terms and does not name anyone else. These are for a search ("Evernote alternative",
 * "Joplin vs"), for the story to point at, and for sending to someone who asked. The build
 * writes each one out as static HTML (`prerender.tsx`), as it does the story, so a crawler
 * and a link's card read the page and not the shell.
 *
 * The story's reading column and rhythm (`.front-story`), widened for the table
 * (`.compare`); the one filled control is the trial, as on the story.
 */
export function ComparePage({ comparison: c }: { comparison: Comparison }) {
  usePageMeta(c.meta);
  return (
    <FrontShell>
      <section className="front-hero front-width">
        <h1>{`Unbent and ${c.name}`}</h1>
        <p className="front-lead front-story-lead">{c.lead}</p>
      </section>

      <article className="front-story compare front-width">
        <section>
          <h2>The short version</h2>
          {/* Both halves, side by side and the same weight: a reader who belongs with the
              other app should be able to tell from here and stop reading. */}
          <div className="compare-verdict">
            <div>
              <h3>Choose Unbent if</h3>
              <ul>
                {c.chooseUnbent.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>{`Choose ${c.name} if`}</h3>
              <ul>
                {c.chooseThem.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section>
          <h2>Why they differ</h2>
          {/* The choice underneath the table, usually a rule the other app holds and we do
              not, or the other way round. Said once, here, in prose: the cells below can
              then be facts, and a reader who has decided from the short version can leave
              knowing why. Most of these pages are not two apps for one job but two jobs,
              and this is where that is said. */}
          {c.whyTheyDiffer}
        </section>

        <section>
          <h2>Side by side</h2>
          {/* A real table, with the topic as each row's heading. Below the phone
              breakpoint each row stacks and every cell names its column from
              `data-label`, since three columns of sentences do not fit a phone. */}
          <table className="compare-table">
            <thead>
              <tr>
                <td />
                <th scope="col">Unbent</th>
                <th scope="col">{c.name}</th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((row) => (
                <tr key={row.topic}>
                  <th scope="row">{row.topic}</th>
                  <td data-label="Unbent">{row.unbent}</td>
                  <td data-label={c.name}>{row.them}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Ours first and theirs straight after, the same shape and weight: the page once
            had only theirs, and argued the other app's case better than its own. */}
        <section>
          <h2>What Unbent does better</h2>
          <ul>
            {c.weDoBetter.map((point) => (
              <li key={point.title}>
                <strong>{point.title}.</strong> {point.body}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>{`What ${c.name} does better`}</h2>
          <ul>
            {c.theyDoBetter.map((point) => (
              <li key={point.title}>
                <strong>{point.title}.</strong> {point.body}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>{c.switching.title}</h2>
          {c.switching.body}
        </section>

        <section className="compare-checked">
          <p className="muted">
            {`What this page says about ${c.name} was checked in ${c.checked}, against the sources below.`}{' '}
            Prices and features change; if something here has,{' '}
            <Link to="/support">we would like to know</Link>.
          </p>
          <ul className="compare-sources">
            {c.sources.map((source) => (
              <li key={source.href}>
                <a href={source.href} rel="noopener noreferrer">
                  {source.label}
                </a>
              </li>
            ))}
          </ul>
        </section>

        <OtherComparisons current={c.slug} />
        <TrialCta />
      </article>
    </FrontShell>
  );
}

/** `/compare`: one line on each comparison, and the story beside them. */
export function CompareIndexPage() {
  usePageMeta(COMPARE_META);
  return (
    <FrontShell>
      <section className="front-hero front-width">
        <h1>How Unbent compares</h1>
        {/* What Unbent is, then what the others are, by name: a reader arriving from a
            search has none of the context the pages below assume, and "the apps it is
            weighed against" meant nothing until they were named. */}
        <p className="front-lead front-story-lead">
          Unbent keeps scanned paperwork: receipts, bills, manuals and letters, read as they
          arrive and found again by what they say, as files you can take with you. The apps
          people compare it with mostly do something broader. Evernote, Notion and Joplin
          are notes apps that also hold files, and Paperless-ngx is a document system you
          run on your own machine. Each page below says who the two apps suit, where they
          differ, and what each does better than the other.
        </p>
      </section>
      <article className="front-story compare front-width">
        <ul className="compare-index">
          {COMPARISONS.map((c) => (
            <li key={c.slug}>
              <Link to={c.path}>{`Unbent and ${c.name}`}</Link>
              <p className="muted">{c.summary}</p>
            </li>
          ))}
        </ul>
        <p>
          The longer story, of one archive and why Unbent was built for it, is{' '}
          <Link to={WHY}>Why Unbent exists</Link>.
        </p>
        <TrialCta />
      </article>
    </FrontShell>
  );
}

/** The other comparisons and the story, so a reader who landed on one from a search finds the rest. */
function OtherComparisons({ current }: { current: Comparison['slug'] }) {
  const others = COMPARISONS.filter((c) => c.slug !== current);
  return (
    <section>
      <h2>More comparisons</h2>
      <ul>
        {others.map((c) => (
          <li key={c.slug}>
            <Link to={c.path}>{`Unbent and ${c.name}`}</Link>
          </li>
        ))}
        <li>
          <Link to={WHY}>Why Unbent exists</Link>
        </li>
      </ul>
    </section>
  );
}

/** The story's way out: the trial, or someone's notes when they are signed in. */
function TrialCta() {
  const { data: session } = useSession();
  return (
    <div className="front-cta">
      {session ? (
        <Link to={HOME} className="btn btn-secondary front-cta-button">
          Open your notes
        </Link>
      ) : (
        <>
          <Link to={LOGIN} className="btn btn-primary front-cta-button">
            Start your free trial
          </Link>
          <p className="muted">
            {TRIAL_DAYS} days free, no card needed. Then ${PLAN_PRICE_USD} a year.
          </p>
        </>
      )}
    </div>
  );
}

export const EvernoteComparison = () => <ComparePage comparison={comparison('evernote')} />;
export const NotionComparison = () => <ComparePage comparison={comparison('notion')} />;
export const JoplinComparison = () => <ComparePage comparison={comparison('joplin')} />;
export const PaperlessNgxComparison = () => <ComparePage comparison={comparison('paperless-ngx')} />;
