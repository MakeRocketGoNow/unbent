import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom/worker';
import { clean, hostName, withoutSiteName } from './site.js';

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

  const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
  const pageTitle = document.querySelector('title')?.textContent;
  const lang = document.documentElement?.getAttribute('lang');

  if (!isProbablyReaderable(document as never)) return null;

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
