import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { PLAN_PRICE_USD, TRIAL_DAYS } from '@unbent/shared';
import { useSession } from '../auth-client.js';
import { HOME, LOGIN } from '../auth-gate.js';
import { usePageMeta, type PageMeta } from '../page-meta.js';
import { FrontShell } from './FrontPage.js';

/**
 * What the tab, a search result and a link's card say this page is. Exported for the
 * build, which writes the same into the page's static copy (`prerender.tsx`).
 */
export const WHY_META: PageMeta = {
  title: 'Why Unbent exists',
  description:
    'Fifteen years of Evernote renewals, thirteen thousand scanned notes, and the notice that doubled the price again: the story behind an Evernote alternative that keeps your notes in Markdown you can take with you.',
  image: '/front/desktop-light.webp',
};

/**
 * What one account paid Evernote, a year at a time: the author's own renewals, from the
 * first in September 2011 to the notice for the one that was not taken. Each row is a
 * run of years at one price, and the last is what was asked, not paid.
 */
const RENEWALS: { years: string; price: string; note?: string }[] = [
  { years: '2011 to 2015', price: '$45' },
  { years: '2016', price: '$59.99' },
  { years: '2017 to 2022', price: '$69.99' },
  { years: '2023', price: '$77.99', note: 'the first renewal after the sale' },
  { years: '2024 and 2025', price: '$129.99' },
  { years: '2026', price: '$249.99', note: 'asked for, and the year I left' },
];

/**
 * Why Unbent exists, `/why`: the origin story (MAK-240).
 *
 * Written for one reader: someone who still uses Evernote, has years of notes in it, and
 * has just been told what the next year will cost. They are deciding whether to leave,
 * and most of what they find when they search for an alternative is a comparison table
 * written by nobody who was there. This page is what happened to one archive, in the
 * first person, with the public facts dated and linked and nothing else about the owner
 * said at all. No grievance and no villain, on purpose: the reader has their own, and a
 * page that argued would be one more thing to be sold. The facts about the owner are the
 * ones on the public record, each with its source; the facts about the archive are the
 * author's own, and the renewals are quoted from the account rather than described.
 *
 * It is also the page a search for "Evernote alternative" or "export Evernote to
 * Markdown" should land on, so those words appear where they fall naturally and nowhere
 * they do not.
 *
 * The register is the README's ("Evernote's owner gave a lot of people a reason to
 * leave") and `docs/billing.md`'s. The one call to action is the trial, the page's only
 * filled control; someone signed in gets their notes as the way out instead, as on the
 * pricing page. The prices are the shared constants, as everywhere.
 *
 * Prose rather than the front page's grid, in a reading column narrower than the front
 * page's band (`.front-story`), because it is read top to bottom once rather than
 * scanned.
 */
export function WhyPage() {
  const { data: session } = useSession();
  usePageMeta(WHY_META);

  return (
    <FrontShell>
      <section className="front-hero front-width">
        <h1>Why Unbent exists</h1>
        {/* Short enough to balance into even lines, and the numbers held together: a lead
            that broke after "thirteen" and left two words on its last line read badly. */}
        <p className="front-lead front-story-lead">
          Fifteen&nbsp;years of Evernote renewals and thirteen&nbsp;thousand scanned notes.
          This is what happened to that archive, and the promise Unbent was built on.
        </p>
      </section>

      <article className="front-story front-width">
        <Chapter title="An archive, not a notebook">
          <p>
            I started with Evernote in 2011. By the time I left, the account held about
            thirteen thousand notes, and most of them were not notes in the usual sense. They
            were paper: receipts, bills, manuals, letters, the contents of filing cabinets fed
            through a document scanner a sheet at a time. Evernote read the text in every
            scan, so a bill could be found by what it said, and that was the whole point. The
            archive was where paper went to become searchable, and then the paper went in the
            recycling.
          </p>
          <p>
            That is a different relationship with an app than a to-do list has. Nothing in it
            can be made again, most of it will never be opened, and one day one of them
            matters. What I was paying for was that it would be there.
          </p>
        </Chapter>

        <Chapter title="What changed">
          <p>
            In{' '}
            <Source href="https://siliconangle.com/2022/11/16/22-years-founded-evernote-acquired-italian-technology-company/">
              November 2022
            </Source>{' '}
            Evernote announced that it was being bought by Bending Spoons, an app company in
            Milan. In{' '}
            <Source href="https://techcrunch.com/2023/02/27/bending-spoons-lays-off-129-evernote-staffers/">
              February 2023
            </Source>{' '}
            the new owner laid off 129 people, saying the product had been unprofitable for
            years, and that{' '}
            <Source href="https://www.engadget.com/evernote-is-relocating-to-europe-after-laying-off-most-of-its-us-workforce-205012133.html">
              July
            </Source>{' '}
            nearly everyone left in the United States and Chile, moving the product to a team
            in Europe. From{' '}
            <Source href="https://techcrunch.com/2023/11/29/its-official-evernote-will-restrict-free-users-to-50-notes/">
              December 2023
            </Source>{' '}
            a free account could hold fifty notes in one notebook. In{' '}
            <Source href="https://www.tamingthetrunk.com/p/evernote-increases-prices-and-adds">
              November 2025
            </Source>{' '}
            the Personal and Professional plans were retired for two new ones: Starter, at $99
            a year with a thousand-note cap, and Advanced, at $249.99 a year, the only plan
            with no cap, which is the one existing subscribers were offered at renewal.
          </p>
          <p>
            None of this is a secret plan against anyone, and none of it is unusual. A company
            bought a product that was losing money and set about making it pay. The part that
            is easy to miss from the outside is who it landed on.
          </p>
        </Chapter>

        <Chapter title="What one account paid">
          <p>The renewals tell it better than I can. What my account paid each September:</p>
          <table>
            <tbody>
              {RENEWALS.map((row) => (
                <tr key={row.years}>
                  <th scope="row">{row.years}</th>
                  <td>{row.price}</td>
                  <td className="muted">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Forty-five dollars a year for the first five years, seventy for the next six. The
            sale closed in early 2023, and that September cost eight dollars more. The next
            one nearly doubled. Then, in August 2026, the mail came that every long-time
            subscriber was getting:
          </p>
          <blockquote>
            <p>
              Your yearly Evernote subscription will renew soon. We are sending you this email
              to inform you that your yearly Evernote subscription will renew in 30 days for
              249.99 USD.
            </p>
          </blockquote>
          <p>
            Two doublings in three years, with the same notes in it. The price could do that
            because the people it landed on were the ones who had been there longest, and an
            archive of thirteen thousand scans is exactly the thing you cannot move on a whim.
            Leaving was hard, and it was hard because the notes were in a format that only one
            app could read.
          </p>
        </Chapter>

        <Chapter title="What I went looking for">
          <p>
            I did look for somewhere to take it before deciding to build. What the archive
            needed was short to say and hard to find: a note that can hold several files and
            carry tags, search that reads the text inside a scanned PDF, and a hosted service,
            so the archive is on the phone and the laptop without a server of my own to run.
            Notion has the note, but did not, when I looked, search inside an attached PDF.
            Obsidian keeps its notes on your own device and is not a hosted service. The
            Evernote alternative I wanted was the one that had just doubled its price.
          </p>
        </Chapter>

        <Chapter title="What a note you pay to keep should be">
          <p>
            The conclusion I came to is short, and it is the whole design of Unbent. If you pay
            someone to keep your notes, the notes have to be yours in a way that does not
            depend on them.
          </p>
          <ul>
            <li>
              <strong>Markdown, byte for byte.</strong> A note is a Markdown file with
              frontmatter, saved exactly as typed. No reflowed lists, no italics quietly
              rewritten, no escaped characters appearing in your text overnight. A format the
              app rewrites behind your back is a format you do not actually own.
            </li>
            <li>
              <strong>An export that needs no Unbent.</strong> One folder per note, its Markdown
              and its files beside it. Read it, grep it, back it up, open it in anything. You
              can take it as often as you like, and nothing in it refers to us.
            </li>
            <li>
              <strong>A way in from where you are.</strong> An Evernote export goes in whole,
              from the browser: each notebook becomes a notebook, every note keeps its tags,
              its dates and its scans, and the text in every scan is searchable again. That is
              what it means to export Evernote to Markdown rather than to another silo.
            </li>
          </ul>
        </Chapter>

        <Chapter title="What that promise costs us">
          <p>
            A promise like that has a price, and it is ours rather than yours. If you stop
            paying, nothing is held hostage: the account turns read-only, every note still
            opens, searches and exports, and it stays that way for at least a year, with a
            reminder to export before anything is removed. We cannot hold your archive as the
            reason to renew, so Unbent has to be worth paying for on what it does this year.
            That is the right way round, and it is the only side of it I would want to be on.
          </p>
          <p>
            Evernote&apos;s owner is called Bending Spoons. The name is the whole brief: your
            notes, unbent.
          </p>
        </Chapter>

        <div className="front-cta">
          {session ? (
            <Link to={HOME} className="btn btn-secondary front-cta-button">
              Open your notes
            </Link>
          ) : (
            <>
              {/* An anchor wearing the filled button's shape: the one thing this page is
                  for, and a real link, as the front page's is. */}
              <Link to={LOGIN} className="btn btn-primary front-cta-button">
                Start your free trial
              </Link>
              <p className="muted">
                {TRIAL_DAYS} days free, no card needed. Then ${PLAN_PRICE_USD} a year.
              </p>
            </>
          )}
        </div>
      </article>
    </FrontShell>
  );
}

/** A heading and the paragraphs under it, on the story's rhythm. */
function Chapter({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * A dated fact's source: the date is the link, so the sentence reads as a sentence and
 * the reader who wants the record can take it. Off-site, so a plain anchor.
 */
function Source({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} rel="noopener noreferrer">
      {children}
    </a>
  );
}
