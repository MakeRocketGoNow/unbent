import {
  BLOCK_TAGS,
  dropComments,
  fromHtml,
  htmlToMarkdown,
  isElement,
  type Node as HtmlNode,
  type Transform,
} from '@unbent/clip/html-to-markdown';

/**
 * HTML from the clipboard as the Markdown a person would have typed for it.
 *
 * Its own module, loaded on the first paste that needs it (`loadConverter` in
 * `clipboard.ts`), because what it carries is large: about 65 kB gzipped, most of it the
 * HTML parser (parse5 and its table of named character references). Bundled with the
 * editor it made the chunk every note opens with half as big again (2026-10-30). A paste
 * from a page is an occasional act; opening a note is every visit. The service worker
 * keeps this chunk with the rest of the build, so the first paste waits on the cache,
 * not the network, and works offline.
 *
 * Everything here is about the shape of clipboard HTML in particular: what browsers and
 * the apps people copy from put around and inside a selection. What any HTML becomes in
 * Markdown is `htmlToMarkdown`'s, shared with the ENEX import and the web clipper.
 */

/**
 * The paste's Markdown and whether it is inline (one paragraph, or less), or null when it
 * comes out empty and the plain text should go in instead.
 *
 * Whether to convert at all is the caller's question, answered before this module is
 * loaded; see `pasteHtml` in `clipboard.ts`.
 */
export function markdownFromClipboardHtml(html: string): { markdown: string; inline: boolean } | null {
  const { body, source } = withoutCfHtmlHeader(html);
  const tree = fromHtml(body, { fragment: true }) as unknown as HtmlNode;

  let base: string | null = source;
  walk(tree, (node) => {
    const href = node.properties?.href;
    if (node.tagName === 'base' && typeof href === 'string') base ??= href;
  });

  // `htmlToMarkdown` already tidies what it writes: no trailing spaces, no run of more
  // than one blank line, nothing blank at either end. Not done again here.
  const markdown = htmlToMarkdown(tree, {
    transforms: [dropComments, googleDocsStyles, resolveAddresses(base)],
  });
  if (!markdown) return null;
  return { markdown, inline: isInline(tree) && !markdown.includes('\n\n') };
}

/** Calls `visit` on every element under `node`, depth first. */
function walk(node: HtmlNode, visit: (element: HtmlNode) => void): void {
  for (const child of node.children ?? []) {
    if (child.type === 'element') visit(child);
    walk(child, visit);
  }
}

/**
 * Replaces each child with what `map` answers for it, depth first, children before
 * their parent, so `map` sees a node whose children are already done. An empty list
 * removes the node; its children unwrap it.
 */
function rewrite(node: HtmlNode, map: (child: HtmlNode) => HtmlNode[]): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    rewrite(child, map);
    return map(child);
  });
}

/**
 * Windows puts HTML on its clipboard as CF_HTML: a header of `Key:value` lines (with
 * `SourceURL:`, the page it came from) and then the document. A browser on Windows
 * normally hands a page only the document, but an app that copies the raw format along
 * leaves the header in front, and parsed as HTML it would be the first line of the note.
 * The header is cut off and its `SourceURL` kept, the one place a clipboard says where
 * its HTML came from.
 */
function withoutCfHtmlHeader(html: string): { body: string; source: string | null } {
  if (!/^Version:\d/.test(html)) return { body: html, source: null };
  const start = html.indexOf('<');
  const header = start === -1 ? html : html.slice(0, start);
  const source = /^SourceURL:(\S+)/m.exec(header)?.[1] ?? null;
  return { body: start === -1 ? '' : html.slice(start), source };
}

/**
 * Google Docs, a common source of a formatted paste, says everything with inline
 * styles and wraps the whole selection in `<b style="font-weight:normal">`. Read as
 * written, that `<b>` made the paste one bold run around the headings and lists inside
 * it (they came out as `**# Title…**`), and the bold and italic the person could see,
 * which are spans with a `font-weight` or a `font-style`, were dropped with the styles.
 *
 * So, before the styles go: a `<b>` or `<strong>` whose own style says it is not bold is
 * unwrapped, and a `<span>` styled bold or italic becomes `<strong>` or `<em>`. Inside a
 * heading a bold span is left a span, since the heading is bold already and `## **x**`
 * says nothing more. Any page styled the same way benefits: what is drawn bold is kept
 * bold.
 */
const googleDocsStyles: Transform = (tree) => restyle(tree, false);

function restyle(node: HtmlNode, inHeading: boolean): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== 'element') return [child];
    const heading = inHeading || /^h[1-6]$/.test(child.tagName ?? '');
    restyle(child, heading);
    const style = typeof child.properties?.style === 'string' ? child.properties.style : '';
    const weight = /font-weight\s*:\s*(\w+)/i.exec(style)?.[1]?.toLowerCase();
    const bold = weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
    const notBold = weight === 'normal' || weight === 'lighter' || Number(weight) < 600;
    const italic = /font-style\s*:\s*(italic|oblique)/i.test(style);
    if ((child.tagName === 'b' || child.tagName === 'strong') && weight !== undefined && notBold) {
      return child.children ?? [];
    }
    if (child.tagName !== 'span') return [child];
    const strong = bold && !inHeading;
    if (!strong && !italic) return [child];
    let children = child.children ?? [];
    if (italic) children = [{ type: 'element', tagName: 'em', properties: {}, children }];
    if (strong) children = [{ type: 'element', tagName: 'strong', properties: {}, children }];
    return children;
  });
}

/**
 * Every link and picture made to point somewhere real.
 *
 * Copied from a browser, links and pictures are already absolute: the browser writes the
 * selection with its addresses resolved. Other apps (a saved page opened from disk, a
 * mail client) can write them relative, and a relative destination in a note resolves
 * against Unbent, where `files/…` names one of this note's own attachments, which a
 * picture from elsewhere never is. So a relative address is resolved against the source
 * the clipboard names (`SourceURL`, or a `<base href>`), and one with nothing to resolve
 * against is let go: a link keeps its words, a picture goes.
 *
 * A picture is kept only from the web (`http:` or `https:`), which the preview draws as
 * it is; the sanitizer allows exactly those. A `data:` picture is the bytes themselves,
 * often megabytes of base64 in the middle of the text, and a `blob:` or `file:` one names
 * something on the other app's side that is gone by the time anyone reads the note.
 *
 * Nothing is fetched. Bringing a web picture into the note as an attachment, so it
 * survives the page going away, is what the API's `/notes/:id/files/fetch` route is for;
 * the note's "Save web images" already counts a pasted one and brings it in on request.
 * Doing that on paste itself is a later step.
 */
function resolveAddresses(base: string | null): Transform {
  return (tree) =>
    rewrite(tree, (child) => {
      if (child.type !== 'element') return [child];
      const props = child.properties ?? {};
      // A named anchor: the converter would write an empty link.
      if (child.tagName === 'a' && typeof props.href !== 'string') return child.children ?? [];
      if (child.tagName === 'a' && typeof props.href === 'string') {
        const href = absolute(props.href, base);
        if (href === null) return child.children ?? [];
        props.href = href;
      }
      if (child.tagName === 'img') {
        const src = typeof props.src === 'string' ? absolute(props.src, base) : null;
        if (src === null || !/^https?:/i.test(src)) return [];
        props.src = src;
      }
      return [child];
    });
}

/**
 * The address as written when it is absolute already (so a pasted link reads as it did
 * on the page, not normalised), resolved against `base` when it is relative, or null.
 */
function absolute(address: string, base: string | null): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  // `new URL` in a `try` rather than `URL.canParse`, which the older WebKit an iPhone
  // app may be running on does not have.
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    // relative; resolved below if there is a base
  }
  if (!base) return null;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

/**
 * Whether the cleaned tree is no more than one paragraph's worth of text: phrasing alone,
 * or a single `<p>` of it. That goes in where the cursor is, mid-sentence if that is where
 * it is pasted; anything with a block in it (a heading, a list, a second paragraph) is
 * set apart on lines of its own; see `apart` in `clipboard.ts`.
 */
function isInline(tree: HtmlNode): boolean {
  const significant = (nodes: HtmlNode[] = []) =>
    nodes.filter((node) => node.type === 'element' || (node.type === 'text' && (node.value ?? '').trim() !== ''));
  let nodes = significant(tree.children);
  if (nodes.length === 1 && isElement(nodes[0]!, 'p')) nodes = significant(nodes[0]!.children);
  return !nodes.some((node) => node.type === 'element' && BLOCK_TAGS.has(node.tagName ?? ''));
}
