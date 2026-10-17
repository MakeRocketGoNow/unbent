import { useEffect } from 'react';

/**
 * What a page says about itself to the tab strip, a search result and a link preview:
 * its title, a description, and the picture a card is drawn with.
 *
 * `index.html` carries one title and one description for the whole app, and the Worker
 * serves that same shell for every route, so until this every page was "Unbent" with the
 * front page's sentence under it. For the app behind the sign-in that is right: a note's
 * title in the tab would be a note's title in the window switcher, the history and the
 * browser's sync, and those are the person's own. The pages for people who are not
 * signed in (the front page, `/pricing`, `/why`) are the ones a search lands on and a
 * link to is unfurled from, and each of those has to say what it is.
 *
 * One module writes the head, rather than each page reaching for `document.title`,
 * because the title is shared with the instance marker (`instance-marker.ts`): a dev or
 * preview tab leads with its label, and a page that set the title on its own would wipe
 * the label off, or the marker would wipe the page's title off, depending on which ran
 * last. Both hand their part here and the head is drawn from the two.
 *
 * The same values are what the build writes into a prerendered page's head
 * (`prerender.tsx`), so a crawler that runs no script reads what the tab would show.
 */
export interface PageMeta {
  /** The tab's title and the card's, whole: "Pricing · Unbent", not "Pricing". */
  title: string;
  /** One or two sentences, for the search result and under the card's title. */
  description: string;
  /**
   * The card's picture, as a site-relative path under `public/`. Relative on purpose:
   * the build does not know the origin it will be served on, and the Worker makes it
   * absolute for a prerendered page (`lib/front-pages.ts`); the browser does the same for
   * a page the app drew.
   */
  image: string;
}

export const SITE_NAME = 'Unbent';

/** The front page's, and the whole app's until a page says otherwise; `index.html` carries the same. */
export const DEFAULT_META: PageMeta = {
  title: SITE_NAME,
  description: 'Notes, receipts and scans you can search, and take with you whenever you like.',
  image: '/front/desktop-light.webp',
};

/** `PR 222 · Unbent`. Not doubled if the title already carries it. */
export function instanceTitle(label: string, title: string): string {
  const prefix = `${label} · `;
  return title.startsWith(prefix) ? title : `${prefix}${title}`;
}

let label: string | null = null;
let page: PageMeta | null = null;

/** The instance's label, in front of every title from now on; see `applyInstanceMarker`. */
export function markInstance(instanceLabel: string): void {
  label = instanceLabel;
  draw();
}

/** What the current page says about itself, or `null` for the app's own. */
export function setPageMeta(meta: PageMeta | null): void {
  page = meta;
  draw();
}

/** The title the tab shows for `meta` on an instance labelled `label`. */
export function titleFor(meta: PageMeta | null, instanceLabel: string | null): string {
  const title = meta?.title ?? DEFAULT_META.title;
  return instanceLabel ? instanceTitle(instanceLabel, title) : title;
}

function draw(): void {
  const meta = page ?? DEFAULT_META;
  document.title = titleFor(page, label);
  setMeta('name', 'description', meta.description);
  setMeta('property', 'og:title', meta.title);
  setMeta('property', 'og:description', meta.description);
  // Absolute, as the Open Graph protocol asks, from where the page is actually served.
  // No `og:url`: the address is the page's own, which anything reading a running page
  // already has, and a copy drawn here went stale across the router's redirects.
  setMeta('property', 'og:image', new URL(meta.image, window.location.href).href);
}

/**
 * Sets one `<meta>`'s content, making the tag when `index.html` has none. The tags for
 * the defaults are in `index.html` already, so for them this is an attribute write.
 */
function setMeta(attr: 'name' | 'property', key: string, content: string): void {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attr, key);
    document.head.appendChild(tag);
  }
  tag.content = content;
}

/**
 * Says what this page is while it is mounted, and hands the head back to the app's own
 * when it unmounts, so a move from `/pricing` into the notes does not leave "Pricing" on
 * the tab.
 */
export function usePageMeta(meta: PageMeta): void {
  const { title, description, image } = meta;
  useEffect(() => {
    setPageMeta({ title, description, image });
    return () => setPageMeta(null);
  }, [title, description, image]);
}
