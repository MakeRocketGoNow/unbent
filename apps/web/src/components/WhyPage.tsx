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
    '15 years of Evernote renewals, 13,000 scanned notes, and the notice that doubled the price again: the story behind an Evernote alternative that keeps your notes in Markdown you can take with you.',
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
 * The public record, dated, each date its source: what a reader who wants the facts
 * checks, set as rows rather than a paragraph so the dates are a column to run down.
 * The author's own numbers are in `RENEWALS`, never here.
 */
const RECORD: { date: string; href: string; event: string }[] = [
  {
    date: 'November 2022',
    href: 'https://siliconangle.com/2022/11/16/22-years-founded-evernote-acquired-italian-technology-company/',
    event: 'Evernote announces its sale to Bending Spoons, an app company in Milan.',
  },
  {
    date: 'February 2023',
    href: 'https://techcrunch.com/2023/02/27/bending-spoons-lays-off-129-evernote-staffers/',
    event: 'The new owner lays off 129 people, saying the product had been unprofitable for years.',
  },
  {
    date: 'July 2023',
    href: 'https://www.engadget.com/evernote-is-relocating-to-europe-after-laying-off-most-of-its-us-workforce-205012133.html',
    event: 'Nearly all of the remaining staff in the United States and Chile are laid off, and the product moves to a team in Europe.',
  },
  {
    date: 'December 2023',
    href: 'https://techcrunch.com/2023/11/29/its-official-evernote-will-restrict-free-users-to-50-notes/',
    event: 'A free account is capped at fifty notes in one notebook.',
  },
  {
    date: 'November 2025',
    href: 'https://www.tamingthetrunk.com/p/evernote-increases-prices-and-adds',
    event:
      'The Personal and Professional plans are retired for Starter, $99 a year with a 1,000-note cap, and Advanced, $249.99 a year with no cap, which existing subscribers are offered at renewal.',
  },
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
          15&nbsp;years of Evernote renewals and 13,000 scanned notes. This is what happened
          to that archive, and the promise Unbent was built on.
        </p>
      </section>

      <article className="front-story front-width">
        <Chapter title="An archive, not a notebook">
          <p>
            I started with Evernote in 2011. By the time I left, the account held about
            13,000 notes, most of them paper: receipts, bills, manuals, letters,
            whole filing cabinets fed through a scanner. Evernote read the text in every scan,
            so a bill could be found by what it said. Paper went in, became searchable, and
            went in the recycling.
          </p>
          <p>
            Nothing in an archive like that can be made again, most of it will never be
            opened, and one day one of them matters. What I was paying for was that it would
            be there.
          </p>
        </Chapter>

        <Chapter title="What changed">
          <dl className="front-story-record">
            {RECORD.map((row) => (
              <div key={row.date}>
                <dt>
                  <Source href={row.href}>{row.date}</Source>
                </dt>
                <dd>{row.event}</dd>
              </div>
            ))}
          </dl>
          <p>
            None of this is unusual. A company bought a product that was losing money and set
            about making it pay. What is easy to miss from the outside is who paid.
          </p>
        </Chapter>

        <Chapter title="What one account paid">
          <p>What my account paid each September:</p>
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
            $45 a year for five years, $70 for six. The first renewal after the sale cost $8
            more; the next nearly doubled. Then, in August 2026,
            the mail came:
          </p>
          <blockquote>
            <p>
              We are sending you this email to inform you that your yearly Evernote
              subscription will renew in 30 days for 249.99 USD.
            </p>
          </blockquote>
          <p>
            Two doublings in three years, for the same notes. The price could do that because
            an archive of 13,000 scans is the thing you cannot move on a whim, and
            it was hard to move because only one app could read it.
          </p>
        </Chapter>

        <Chapter title="What I went looking for">
          <p>I looked for somewhere to take it before deciding to build. The archive needed three things:</p>
          <ul>
            <li>A note that holds several files and tags.</li>
            <li>Search that reads the text inside a scanned PDF.</li>
            <li>A hosted service, so it is on the phone and the laptop without a server of my own.</li>
          </ul>
          <p>
            Notion has the note but, when I looked, did not search inside an attached PDF.
            Obsidian lives on your own device and is not hosted. The Evernote alternative I
            wanted was the one that had just doubled its price.
          </p>
        </Chapter>

        <Chapter title="What Unbent promises instead">
          <p>
            The conclusion is the whole design of Unbent: if you pay someone to keep your
            notes, they still have to be yours, with or without them.
          </p>
          <ul>
            <li>
              <strong>Markdown, byte for byte.</strong> A note is a Markdown file, saved exactly
              as typed: no reflowed lists, no italics quietly rewritten, no escaped characters
              appearing overnight. A format the app rewrites behind your back is one you do
              not own.
            </li>
            <li>
              <strong>An export that needs no Unbent.</strong> One folder per note, its Markdown
              and files beside it. Read it, grep it, back it up, open it in anything, as often
              as you like.
            </li>
            <li>
              <strong>A way in from Evernote.</strong> An export goes in whole, from the
              browser: every note keeps its notebook, tags, dates and scans, and the text in
              every scan is searchable again. That is what export Evernote to Markdown should
              mean: Markdown, not another silo.
            </li>
          </ul>
        </Chapter>

        <Chapter title="What that promise costs us">
          <p>
            If you stop paying, nothing is held hostage: the account turns read-only, every
            note still opens, searches and exports, and stays that way for at least a year,
            with a reminder to export before anything is removed. We cannot hold your archive
            as the reason to renew. Unbent has to earn each year on what it does.
          </p>
          {/* The owner was named in "What changed"; the line trusts the reader to have
              read it rather than explaining the name. */}
          <p>Your notes, unbent.</p>
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
