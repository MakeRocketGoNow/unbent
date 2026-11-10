import { fromHtml } from 'hast-util-from-html';
import { toMarkdown } from 'mdast-util-to-markdown';
import { visit } from 'unist-util-visit';
import { nextAvailableFilename, splitExt } from '@unbent/shared/filenames';
import { extractArticle } from './extract.js';
import { streamedInstructions } from './streamed.js';
import { dropComments, dropEmptyLinks, htmlToMarkdown, isElement, type Node, type Transform } from './html-to-markdown.js';
import { clean, hostName, withoutSiteName } from './site.js';

/**
 * A web page as a note: its title, a Markdown body, and the pictures the body points at.
 *
 * The clip does not fetch anything. Pictures are listed with the address to fetch each
 * from and the `files/<filename>` path the Markdown already uses for it, which is how an
 * imported note refers to its attachments too (see `enmlToMarkdown`); the caller fetches
 * them and uploads each under its `filename`, and the links resolve. Keeping the network
 * out of here keeps this a pure function of the page, testable without one, and lets the
 * caller decide where the bytes come from: the API fetching on the server, or a browser
 * extension that already has them.
 *
 * Everything here works on the unified AST and runs without a DOM. The one DOM is
 * linkedom's, inside `extractArticle`.
 */

export interface ClipImage {
  /** Absolute URL to fetch the picture from. */
  url: string;
  /** The relative path the Markdown already points at: `files/<filename>`. */
  path: string;
  filename: string;
  alt: string;
}

export interface Clip {
  title: string;
  /** The note body: a source line, a blank line, then the article as Markdown. */
  markdown: string;
  images: ClipImage[];
  source: { url: string; siteName: string | null; byline: string | null };
  /**
   * The words of the article as a reader reads them: its text, not the source line, a
   * link's address or a picture. See `countWords`.
   */
  wordCount: number;
}

export interface ClipOptions {
  /** Most images a clip keeps; the rest stay as absolute URLs in the Markdown. Default 12. */
  maxImages?: number;
}

/**
 * How many pictures a clip saves by default.
 *
 * Each one is a fetch and an upload, and on a long article (a gallery, a photo essay)
 * the pictures past the first dozen are rarely the ones anyone clipped it for. Those past
 * the cap are not lost: they stay in the note as links to where they were.
 */
const DEFAULT_MAX_IMAGES = 12;

/** Extensions a picture's filename keeps. Anything else is dropped; see `imageFilename`. */
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif']);

/**
 * What the fallback takes out of a page Readability would not read: everything that is
 * the site rather than the page. The first nine are the chrome every site has. `template`
 * and `svg` are there because their text is never what a page shows as text: a template
 * is not rendered at all, and an icon's `<title>` would otherwise land in the note as a
 * stray word beside every button.
 */
const FALLBACK_DROP = new Set([
  'script',
  'style',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'noscript',
  'template',
  'svg',
]);

/** A filename longer than this is cut: it shows in the attachments panel, whole. */
const MAX_STEM_LENGTH = 100;

/**
 * Clips a page: its article when Readability finds one, else the whole page without its
 * chrome.
 *
 * `url` is the page's address, which relative links and pictures resolve against and the
 * source line links to. Throws a `TypeError` when it is not an absolute URL.
 */
export function clipPage(html: string, url: string, opts: ClipOptions = {}): Clip {
  const pageUrl = new URL(url);
  const article = extractArticle(html, url);
  if (article) {
    return clipFragment(
      article.contentHtml,
      url,
      { title: article.title, siteName: article.siteName, byline: article.byline },
      opts,
    );
  }

  // No article: the page's body, less the parts that are the site's rather than the
  // page's. Parsed as a whole document so `<title>` and `<base>` can be read from the head.
  const page = fromHtml(html) as unknown as Node;
  const head = find(page, 'head');
  const body = find(page, 'body') ?? page;
  const siteName = clean(String(findMeta(head, 'og:site_name') ?? '')) ?? (hostName(pageUrl) || null);
  const pageTitle = clean(textOf(find(head, 'title')));
  const title = (pageTitle && withoutSiteName(pageTitle, siteName)) || pageUrl.host;
  const baseHref = find(head, 'base')?.properties?.['href'];
  const base = resolve(typeof baseHref === 'string' ? baseHref : '', pageUrl) ?? pageUrl;

  removeTags(body, FALLBACK_DROP);
  const tree: Node = { type: 'root', children: body.children ?? [] };
  return clipTree(tree, pageUrl, base, { title, siteName, byline: null }, opts);
}

/**
 * Clips HTML the caller already extracted or wants whole: a pasted fragment, a selection,
 * a page Readability refused.
 *
 * Relative links and pictures resolve against `url`, as they would on the page the
 * fragment came from. `meta.siteName` falls back to the URL's host.
 */
export function clipFragment(
  html: string,
  url: string,
  meta: { title: string; siteName?: string | null; byline?: string | null },
  opts: ClipOptions = {},
): Clip {
  const pageUrl = new URL(url);
  const tree = fromHtml(html, { fragment: true }) as unknown as Node;
  return clipTree(
    tree,
    pageUrl,
    pageUrl,
    {
      title: clean(meta.title) ?? pageUrl.host,
      siteName: clean(meta.siteName) ?? (hostName(pageUrl) || null),
      byline: clean(meta.byline),
    },
    opts,
  );
}

interface ClipMeta {
  title: string;
  siteName: string | null;
  byline: string | null;
}

/** The part both entry points share: links and pictures, then Markdown, then the body. */
function clipTree(tree: Node, pageUrl: URL, base: URL, meta: ClipMeta, opts: ClipOptions): Clip {
  const images: ClipImage[] = [];
  dropTitleHeading(tree, meta.title);
  // Counted here, on the page's own text, before it becomes Markdown: in the Markdown a
  // link's address and a picture's path are text too, and telling them apart again
  // would be parsing what was just written.
  const wordCount = countWords(tree);

  const article = htmlToMarkdown(tree, {
    transforms: [dropComments, rewriteLinksAndImages(base, images, opts.maxImages ?? DEFAULT_MAX_IMAGES), dropEmptyLinks],
  });

  const source = sourceLine(pageUrl.href, meta.siteName ?? pageUrl.host, meta.byline);
  return {
    title: meta.title,
    markdown: article ? `${source}\n\n${article}` : source,
    images,
    source: { url: pageUrl.href, siteName: meta.siteName, byline: meta.byline },
    wordCount,
  };
}

/**
 * Elements whose text runs on into the text beside them. Every other element is a
 * break, so `<p>end.</p><p>Start</p>` is two words and not `end.Start`, while
 * `un<em>believ</em>able` stays one. Listing the inline ones rather than the blocks
 * means an element nobody thought of splits words, which miscounts by one at most,
 * where gluing two paragraphs together would.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins',
  'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
]);

const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * The words in a tree's text.
 *
 * By `Intl.Segmenter` rather than by splitting on spaces, which would count a sentence
 * of Japanese or Chinese as one word and a lone dash as another. A picture has no text
 * (its alt is an attribute) and neither has a link's address, so neither is counted; a
 * code block is, since it is read too.
 */
export function countWords(tree: Node): number {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'text') {
      parts.push(node.value ?? '');
      return;
    }
    const inline = isElement(node) && INLINE_TAGS.has(node.tagName ?? '');
    if (!inline) parts.push(' ');
    for (const child of node.children ?? []) walk(child);
    if (!inline) parts.push(' ');
  };
  walk(tree);
  let count = 0;
  for (const segment of WORDS.segment(parts.join(''))) if (segment.isWordLike) count += 1;
  return count;
}

/**
 * `Clipped from [Acme Workshop](https://…), by Pat Example`.
 *
 * Serialised through mdast rather than written as a template, so a site name with a
 * bracket in it, or an address with a space or a parenthesis, still makes one link.
 * A byline that already starts with "By" (as most do: Readability takes it from the
 * page as printed) loses it, so the line does not read "by By".
 */
function sourceLine(url: string, site: string, byline: string | null): string {
  const author = byline?.replace(/^by\s+/i, '').trim();
  const children: Node[] = [
    { type: 'text', value: 'Clipped from ' },
    { type: 'link', url, children: [{ type: 'text', value: site }] },
  ];
  if (author) children.push({ type: 'text', value: `, by ${author}` });
  return toMarkdown({ type: 'paragraph', children } as never, { resourceLink: false }).trim();
}

/**
 * The page with its scripts and styles taken out, before anything parses it.
 *
 * Much of a modern page's weight is inline framework data and CSS that never becomes
 * content, and every kilobyte handed to a parser becomes many more on the heap, so what
 * a caller limits is what is left after this. A `<script type="application/ld+json">`
 * stays: it is where Readability reads a page's title and byline.
 *
 * A small tokenizer rather than a pattern for the two elements, for two reasons. HTML
 * allows a literal `<style>` where it is not a tag (in a comment, an attribute's value,
 * a `<title>`, a script's JSON), and a pattern taking one for a tag cut the article out
 * of the note with no error, on exactly the pages about HTML that mention it. And this
 * runs on pages from anywhere before any size limit on the parse: a pattern looking for
 * each closing tag rereads the page, which took 87 s on 720 KB of unclosed ones. Here
 * every search starts where the last ended.
 *
 * One thing a script says is kept: React's instructions for moving the parts of a page it
 * streamed into place (`$RC("B:1","S:1")`), left as the empty templates React writes for
 * them on a page with no inline scripts, which `placeStreamed` carries out before
 * Readability reads the page. Without them a streamed article is a hidden element that
 * Readability skips.
 *
 * What it cannot read it leaves for the parser: a tag, a comment or a `<title>` with no
 * end keeps the rest of the page. The only cut is an unclosed script or style, which an
 * HTML parser reads as running to the end of the page too.
 */
export function withoutScriptsAndStyles(html: string): string {
  const token = /<!--|<\/?[a-z][^\s/>]*/gi;
  let out = '';
  let from = 0;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    if (match[0] === '<!--') {
      const end = html.indexOf('-->', token.lastIndex);
      if (end === -1) break;
      token.lastIndex = end + 3;
      continue;
    }
    const tagEnd = endOfTag(html, token.lastIndex);
    if (tagEnd === -1) break;
    token.lastIndex = tagEnd + 1;
    const name = match[0].slice(1).toLowerCase();
    if (name !== 'script' && name !== 'style' && name !== 'title' && name !== 'textarea') continue;

    // The element's text is not markup, whatever it mentions, so it is stepped over whole.
    const closing = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
    closing.lastIndex = tagEnd + 1;
    const close = closing.exec(html);
    const closeEnd = close ? html.indexOf('>', closing.lastIndex) : -1;
    const kept =
      name === 'title' || name === 'textarea' || /type\s*=\s*["']?application\/ld\+json/i.test(html.slice(match.index, tagEnd));
    if (kept) {
      if (closeEnd === -1) break;
      token.lastIndex = closeEnd + 1;
      continue;
    }
    out += html.slice(from, match.index);
    if (closeEnd === -1) return out;
    // React's streaming instructions are the one thing in a script a clip needs: where
    // the parts of the page sent later belong. See `placeStreamed`.
    if (name === 'script') out += streamedInstructions(html.slice(tagEnd + 1, close!.index));
    from = closeEnd + 1;
    token.lastIndex = from;
  }
  return out + html.slice(from);
}

/**
 * Where the tag whose attributes start at `at` ends, or -1. A `>` inside a quoted value
 * does not end it, and a quote counts only where a value starts, after its `=`, so the
 * apostrophe in `title=it's` is not one. Reading one wrong can only leave a script in
 * for the parser, which reads it properly, so a mistake here costs bytes and not words.
 */
function endOfTag(html: string, at: number): number {
  let afterEquals = false;
  for (let i = at; i < html.length; i += 1) {
    const ch = html[i]!;
    if (ch === '>') return i;
    if (afterEquals && (ch === '"' || ch === "'")) {
      i = html.indexOf(ch, i + 1);
      if (i === -1) return -1;
      afterEquals = false;
    } else if (ch === '=') {
      afterEquals = true;
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f') {
      afterEquals = false;
    }
  }
  return -1;
}

/**
 * Makes every link absolute, and every picture either a `files/` path the caller will
 * fill or, past the cap, an absolute address.
 *
 * Runs before the cleaning transforms, which is what `htmlToMarkdown`'s `transforms` are
 * for: it reads `width` and `height` to spot a tracking pixel, and `srcset` and
 * `data-src` for a picture whose `src` is a lazy-loading placeholder.
 */
function rewriteLinksAndImages(base: URL, images: ClipImage[], maxImages: number): Transform {
  // One picture used twice (a hero repeated as a thumbnail, an icon in every row) is
  // fetched once: the second `<img>` points at the path the first one was given.
  const byUrl = new Map<string, string>();
  const taken = new Set<string>();

  return (tree: Node) => {
    visit(tree as never, 'element', (node: Node, index: number | undefined, parent: Node | undefined) => {
      if (!parent || index === undefined) return undefined;
      const props = node.properties ?? {};

      // A named anchor, `<h2><a id="x"></a>Title</h2>` above all: the converter would write
      // an empty link, `## []()Title`, in every heading of a page marked up that way.
      if (node.tagName === 'a' && typeof props['href'] !== 'string') {
        parent.children!.splice(index, 1, ...(node.children ?? []));
        return index;
      }

      if (node.tagName === 'a' && typeof props['href'] === 'string') {
        const href = props['href'].trim();
        // A `javascript:` link does something on the page and nothing in a note. Its
        // text stays; the link goes. Asked of the parsed address, since a URL parser takes
        // a tab inside the word or a control character before it for the same scheme.
        const resolved = resolve(href, base);
        if (resolved?.protocol === 'javascript:') {
          parent.children!.splice(index, 1, ...(node.children ?? []));
          return index;
        }
        props['href'] = resolved?.href ?? href;
        return undefined;
      }

      // The converter writes these as links to their files, and Readability's own path has
      // made them absolute already; the whole-page fallback has not, and a relative one
      // in a note would resolve against Unbent rather than the site.
      if (node.tagName === 'video' || node.tagName === 'audio' || node.tagName === 'source') {
        for (const key of ['src', 'poster']) {
          if (typeof props[key] === 'string') props[key] = resolve(props[key], base)?.href ?? props[key];
        }
        return undefined;
      }

      if (node.tagName !== 'img') return undefined;

      const src = pictureUrl(props, base);
      if (!src || isTrackingPixel(props)) {
        parent.children!.splice(index, 1);
        return index;
      }

      const known = byUrl.get(src.href);
      if (known) {
        props['src'] = known;
      } else if (images.length < maxImages) {
        const filename = nextAvailableFilename(imageFilename(src, images.length + 1), taken);
        taken.add(filename);
        const path = `files/${filename}`;
        const alt = typeof props['alt'] === 'string' ? props['alt'].trim() : '';
        images.push({ url: src.href, path, filename, alt });
        byUrl.set(src.href, path);
        props['src'] = path;
      } else {
        props['src'] = src.href;
      }
      // The note shows one picture, so the alternatives go: a `files/` path has no
      // `srcset`, and one left behind would point back at the site.
      delete props['srcSet'];
      delete props['dataSrc'];
      return undefined;
    });
  };
}

/**
 * The address a picture would be fetched from, or null when there is none worth keeping.
 *
 * `src` when it is a real address. When it is missing or empty, the first `srcset`
 * candidate (or `data-src`, which lazy-loading scripts swap in). When it is a `data:` URI,
 * which is what a lazy-loading page puts in `src` until the picture scrolls into view,
 * the largest `srcset` candidate, since a page that offers several is offering the
 * clearest one to anyone who can take it. A `data:` URI with nothing better beside it is
 * dropped: a placeholder is a grey box, and a real picture inlined as data has no address
 * to fetch it from.
 */
function pictureUrl(props: Record<string, unknown>, base: URL): URL | null {
  const src = typeof props['src'] === 'string' ? props['src'].trim() : '';
  const candidates = parseSrcset(typeof props['srcSet'] === 'string' ? props['srcSet'] : '');
  const lazy = typeof props['dataSrc'] === 'string' ? props['dataSrc'].trim() : '';

  let chosen: string | undefined;
  if (src && !/^data:/i.test(src)) chosen = src;
  else if (!src) chosen = candidates[0]?.url ?? (lazy || undefined);
  else chosen = largest(candidates)?.url ?? (lazy || undefined);
  if (!chosen || /^data:/i.test(chosen)) return null;

  const url = resolve(chosen, base);
  // Only what can be fetched over the web is worth a file: a `blob:` or `file:` address
  // means nothing off the machine that clipped it.
  return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url : null;
}

/**
 * A picture drawn 1 pixel (or 0) wide or tall is a tracking pixel, not content. Read from
 * the attributes, the only size there is without fetching it.
 */
function isTrackingPixel(props: Record<string, unknown>): boolean {
  const tiny = (value: unknown) => value !== undefined && value !== '' && Number(value) <= 1;
  return tiny(props['width']) || tiny(props['height']);
}

interface SrcsetCandidate {
  url: string;
  /** Width in pixels for a `w` descriptor, density for `x`; 1 when there is neither. */
  size: number;
  unit: 'w' | 'x';
}

/**
 * Splits a `srcset` into its candidates.
 *
 * Not on commas alone: an image CDN's address often has commas in it
 * (`/w_300,h_200/photo.jpg`), and a candidate is only ended by a comma after whitespace
 * or at the very end of its URL, which is how the HTML standard's parser reads it too.
 */
function parseSrcset(srcset: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let rest = srcset;
  for (;;) {
    rest = rest.replace(/^[\s,]+/, '');
    if (!rest) return out;
    const urlMatch = /^\S+/.exec(rest)!;
    let url = urlMatch[0];
    rest = rest.slice(url.length);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const end = rest.indexOf(',');
      descriptor = (end === -1 ? rest : rest.slice(0, end)).trim();
      rest = end === -1 ? '' : rest.slice(end + 1);
    }
    const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(descriptor);
    out.push({
      url,
      size: m ? Number(m[1]) : 1,
      unit: m ? (m[2]!.toLowerCase() as 'w' | 'x') : 'x',
    });
  }
}

/** The widest candidate when they give widths, else the densest. */
function largest(candidates: SrcsetCandidate[]): SrcsetCandidate | undefined {
  const widths = candidates.filter((c) => c.unit === 'w');
  const pool = widths.length ? widths : candidates;
  return pool.reduce<SrcsetCandidate | undefined>((best, c) => (!best || c.size > best.size ? c : best), undefined);
}

/**
 * A filename for a picture, from the last segment of its address.
 *
 * `image-<n>` when the address has no usable name (`/`, `/photo/`, a query string
 * alone). The extension is kept only when it names a picture format; anything else
 * (`.php`, `.aspx`, a CDN's `.jpg@2x`) is dropped rather than kept as a lie, and the server
 * works out the type from the bytes when the file is uploaded. Characters a filename may
 * not hold are replaced, and a long name is cut.
 */
function imageFilename(url: URL, n: number): string {
  const segment = url.pathname.split('/').pop() ?? '';
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape: keep the segment as written.
  }
  const name = decoded
    .replace(/[\u0000-\u001f\u007f/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  const [stem, ext] = splitExt(name);
  const kept = IMAGE_EXTENSIONS.has(ext.slice(1).toLowerCase()) ? ext : '';
  const shortStem = Array.from(stem).slice(0, MAX_STEM_LENGTH).join('').trim();
  return shortStem ? `${shortStem}${kept}` : `image-${n}${kept}`;
}

/**
 * Removes a heading at the very start of the article that only repeats the title.
 *
 * The note's title carries it, so a body that opens with it again shows it twice.
 * Readability usually drops it itself; a fragment, or a page it would not read, still has
 * it. Only an `h1` or `h2` that is the first thing in the article (through any wrappers)
 * and says exactly the title, ignoring case and spacing, goes: a heading further down, or
 * one that says more, is the article's own.
 */
function dropTitleHeading(tree: Node, title: string): void {
  const want = normalise(title);
  let parent: Node = tree;
  for (;;) {
    const children = parent.children ?? [];
    const index = children.findIndex((c) => isElement(c) || (c.type === 'text' && (c.value ?? '').trim() !== ''));
    const first = children[index];
    if (!first || !isElement(first)) return;
    if (first.tagName === 'h1' || first.tagName === 'h2') {
      if (normalise(textOf(first)) === want) children.splice(index, 1);
      return;
    }
    parent = first;
  }
}

/** Removes every element named in `tags`, contents included. */
function removeTags(tree: Node, tags: Set<string>): void {
  visit(tree as never, 'element', (node: Node, index: number | undefined, parent: Node | undefined) => {
    if (!parent || index === undefined || !tags.has(node.tagName ?? '')) return undefined;
    parent.children!.splice(index, 1);
    return index;
  });
}

/** The first element called `tag` in document order, or undefined. */
function find(tree: Node | undefined, tag: string): Node | undefined {
  if (!tree) return undefined;
  let found: Node | undefined;
  visit(tree as never, 'element', (node: Node) => {
    if (node.tagName !== tag) return undefined;
    found = node;
    return false;
  });
  return found;
}

/** The `content` of `<meta property="…">` (or `name="…"`), or undefined. */
function findMeta(head: Node | undefined, property: string): unknown {
  if (!head) return undefined;
  let content: unknown;
  visit(head as never, 'element', (node: Node) => {
    if (node.tagName !== 'meta') return undefined;
    const p = node.properties ?? {};
    if (p['property'] !== property && p['name'] !== property) return undefined;
    content = p['content'];
    return false;
  });
  return content;
}

/** A node's text, as a reader would see it. */
function textOf(node: Node | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `href` against `base`, or null when it is not an address at all. */
function resolve(href: string, base: URL): URL | null {
  if (!href) return null;
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}
