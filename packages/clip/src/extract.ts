import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom/worker';
import { clean, hostName, withoutSiteName } from './site.js';
import { placeStreamed } from './streamed.js';

/**
 * Finds the article in a web page: the part a person meant to keep when they clipped it,
 * without the navigation, the sidebars, the comment form and the footer around it.
 *
 * Readability is Firefox's Reader View, so a clip keeps what Reader View would show, which
 * is the behaviour people already know from every browser's reader mode. Writing our own
 * scoring would be a long tail of sites done worse.
 *
 * Readability needs a DOM, and the API runs on Cloudflare Workers, which has none, so the
 * page is parsed with linkedom: a small DOM written for servers. This is the only module
 * in the package that touches a DOM; everything after it (`clip.ts`, `html-to-markdown.ts`)
 * works on the unified AST, so it runs anywhere. The browser has a real DOM and could run
 * Readability on it directly, which is why the web app is not meant to import this.
 *
 * It imports `linkedom/worker`, the package's single-file build for workers, rather than
 * the main entry: the main entry reaches for the optional `canvas` package through a
 * CommonJS `require` in a `try`, which a Worker bundle cannot carry, and the worker build
 * has the canvas stub inlined instead. Nothing here may use a Node built-in (`fs`, `path`,
 * `Buffer`) for the same reason.
 */

export interface Article {
  /** Readability's title, trimmed, falling back to the `<title>`, then the URL's host. */
  title: string;
  byline: string | null;
  /** Readability's site name, else `og:site_name`, else the URL's host without `www.`. */
  siteName: string | null;
  excerpt: string | null;
  /** The article's cleaned HTML, from Readability, with its links made absolute. */
  contentHtml: string;
  /** The page's language, from `<html lang>`. */
  lang: string | null;
}

/**
 * The article in `html`, fetched from `url`, or null when the page has none.
 *
 * Null when Readability's own quick check says the page is not an article
 * (`isProbablyReaderable`: a home page, a list of links, a search result) or when its full
 * parse finds nothing. The quick check is a gate and not only a hint, because on a page
 * that fails it the parse still answers, with whichever one block scored best: one column
 * of a front page, or one list of many. A clip of that is worse than a clip of the whole
 * page, which is what the caller falls back to.
 *
 * `url` must be absolute: it is what relative links and pictures are resolved against.
 * Throws a `TypeError` when it is not a URL at all.
 */
export function extractArticle(html: string, url: string): Article | null {
  const pageUrl = new URL(url);

  // linkedom's `baseURI` is the document's `<base href>` when there is one, else
  // `location.href` from the globals handed to parseHTML. Readability resolves every link
  // and picture against `baseURI`, so `location` is what makes a relative path absolute.
  // Passing it as a global keeps it on this document: linkedom's window is a proxy that
  // reads the globals first, and nothing is written to the real `globalThis`.
  const { document } = parseHTML(html, { location: pageUrl });

  absoluteBase(document, pageUrl);
  // Before anything reads the page: a streamed article is hidden until it is placed, and
  // the quick check below reads only what is visible.
  placeStreamed(document as never);

  const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
  const pageTitle = document.querySelector('title')?.textContent;
  const lang = document.documentElement?.getAttribute('lang');

  if (!isProbablyReaderable(document as never)) return null;

  joinSplitArticle(document as unknown as Root);
  dropCaptionCopies(document as unknown as Root);

  // parse() rewrites the document as it scores it, so everything read from the page
  // itself is read above, before this.
  const parsed = new Readability(document as never).parse();
  if (!parsed?.content) return null;

  const siteName = clean(parsed.siteName) ?? clean(ogSiteName) ?? (hostName(pageUrl) || null);
  const title = clean(parsed.title) ?? clean(pageTitle);

  return {
    title: (title && withoutSiteName(title, siteName)) || pageUrl.host,
    byline: clean(parsed.byline),
    siteName,
    excerpt: clean(parsed.excerpt),
    contentHtml: parsed.content,
    lang: clean(parsed.lang) ?? clean(lang),
  };
}

/**
 * Makes a `<base href>` absolute, or removes it when it cannot be.
 *
 * linkedom answers `baseURI` with the attribute as written, so a page with
 * `<base href="/blog/">` would hand Readability a relative base, every `new URL` against
 * it would throw, and Readability would leave each link as it found it: relative, and
 * broken in a note. Resolving it against the page's own address first is what a browser
 * does.
 */
function absoluteBase(document: { querySelector(selector: string): BaseElement | null }, pageUrl: URL): void {
  const base = document.querySelector('base[href]');
  if (!base) return;
  try {
    base.setAttribute('href', new URL(base.getAttribute('href') ?? '', pageUrl).href);
  } catch {
    base.remove();
  }
}

interface BaseElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/** A paragraph counts towards a box only at this length: a caption or a dateline does not. */
const BODY_PARAGRAPH_CHARS = 80;

/** Names a box is never joined under, whatever it holds: Readability's own unlikely list. */
const NOT_THE_ARTICLE = /comment|sidebar|related|recommend|promo|teaser|card|footer|newsletter|share|social|widget/i;

/**
 * Puts an article the site split into separate boxes back into one, before Readability
 * picks the box it keeps.
 *
 * Some sites cut the body of a story in two (or more) to put a video, an ad or a "most
 * read" block in the middle, and wrap each part in its own layout column, so the parts are
 * cousins in the page rather than neighbours. Readability keeps one block and joins only
 * that block's siblings, so it kept one part: on a news site found on 2026-11-06, the
 * second third of the story with none of its pictures, or the first two thirds without the
 * ending, depending on how the ads around them scored. A paste of the same story was whole,
 * because a selection runs from the first sentence to the last.
 *
 * The parts are told by what they share: the same tag and class, each holding at least two
 * body paragraphs with few links among them, under different parents, and together most of
 * the page's body text. Every one of those is a guard against joining something that is not
 * an article. Siblings are left to Readability, which already joins them. A row of story
 * cards fails on paragraphs (a card has one excerpt) or on links (its title is one), and a
 * thread of comments on the name. The parts go into the first one in page order and the
 * others are removed, so what stood between them (the video, the ad) stays out, where it
 * was. Pages that fail any test are left exactly as they came.
 */
function joinSplitArticle(document: Root): void {
  // Each body paragraph's length, added to every box above it: one walk up per paragraph
  // rather than a count of paragraphs inside every element on the page.
  const textIn = new Map<Element, number>();
  const paragraphsIn = new Map<Element, number>();
  let pageText = 0;
  for (const p of document.querySelectorAll('p')) {
    const length = squash(p.textContent).length;
    if (length < BODY_PARAGRAPH_CHARS) continue;
    pageText += length;
    for (let box = p.parentElement; box; box = box.parentElement) {
      textIn.set(box, (textIn.get(box) ?? 0) + length);
      paragraphsIn.set(box, (paragraphsIn.get(box) ?? 0) + 1);
    }
  }
  if (pageText === 0) return;

  const groups = new Map<string, Element[]>();
  for (const box of textIn.keys()) {
    const className = squash(box.getAttribute('class'));
    if (!className || (paragraphsIn.get(box) ?? 0) < 2) continue;
    if (NOT_THE_ARTICLE.test(className) || NOT_THE_ARTICLE.test(box.getAttribute('id') ?? '')) continue;
    if (linkShare(box) > 0.25) continue;
    const key = `${box.tagName} ${className}`;
    groups.set(key, [...(groups.get(key) ?? []), box]);
  }

  let best: Element[] | null = null;
  let bestText = 0;
  for (const parts of groups.values()) {
    if (parts.length < 2) continue;
    if (parts.some((part) => parts.some((other) => other !== part && part.contains(other)))) continue;
    if (new Set(parts.map((part) => part.parentElement)).size < parts.length) continue;
    const total = parts.reduce((sum, part) => sum + (textIn.get(part) ?? 0), 0);
    if (total * 2 < pageText) continue;
    // The layout columns around the parts often share a class too, and hold the same text
    // and more. The innermost group is the article's own; a column's would bring the
    // author's box and the share buttons beside the story into it.
    if (best) {
      const inner = best[0]!.contains(parts[0]!);
      if (!inner && (parts[0]!.contains(best[0]!) || total <= bestText)) continue;
    }
    best = parts;
    bestText = total;
  }
  if (!best) return;

  // `querySelectorAll` and so the map walk the page in order, so the first part is first.
  const [first, ...rest] = best;
  for (const part of rest) {
    first!.append(...Array.from(part.childNodes));
    part.remove();
  }
}

/**
 * Removes the copies of a picture's caption that a page hides with its stylesheet.
 *
 * A lightbox (the viewer that opens a picture full size) often keeps its own copy of the
 * caption inside the `<figure>`, beside the `<figcaption>`, hidden until it opens. A
 * browser's copy leaves hidden text out, so a paste had the caption once; the clipper gets
 * the page without its stylesheet, and the clip had it twice. A copy is told by its text,
 * which is the caption's word for word, and an element holding a picture is never one.
 */
function dropCaptionCopies(document: Root): void {
  for (const caption of document.querySelectorAll('figure figcaption')) {
    const figure = caption.parentElement?.closest('figure');
    const text = squash(caption.textContent);
    if (!figure || !text) continue;
    for (const element of figure.querySelectorAll('*')) {
      if (!element.isConnected || element.contains(caption) || caption.contains(element)) continue;
      if (element.querySelector('img, picture, video, svg')) continue;
      if (squash(element.textContent) === text) element.remove();
    }
  }
}

/** The share of a box's text that sits inside links. */
function linkShare(box: Element): number {
  const all = squash(box.textContent).length;
  if (all === 0) return 0;
  let linked = 0;
  for (const link of box.querySelectorAll('a')) linked += squash(link.textContent).length;
  return linked / all;
}

function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The little of linkedom's DOM these passes use. The package is typed without the DOM's
 * own types (see its tsconfig), so they are named here as `BaseElement` is above.
 */
interface Root {
  querySelectorAll(selector: string): Iterable<Element>;
}

interface Element extends Root {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly parentElement: Element | null;
  readonly childNodes: ArrayLike<object>;
  readonly isConnected: boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): Element | null;
  closest(selector: string): Element | null;
  contains(other: Element): boolean;
  append(...nodes: object[]): void;
  remove(): void;
}
