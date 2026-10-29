/**
 * Markdown rendering pipeline, shared so preview and any future server-side render agree.
 *
 * rehype-sanitize is non-negotiable and deliberately runs last in the hast phase: imported
 * ENML is untrusted HTML from Evernote exports, and notes can contain arbitrary inline
 * HTML. Rendering unsanitized would be stored XSS against the note's own owner.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';

/** Same-note attachment links are relative and always begin with this prefix. */
export const ATTACHMENT_PREFIX = 'files/';

/**
 * A path as a markdown link destination.
 *
 * CommonMark destinations cannot contain whitespace unless wrapped in angle brackets.
 * Dropped files keep their original names, so a PDF like `Treatment Plan.pdf` must become
 * `[Treatment Plan.pdf](<files/Treatment Plan.pdf>)`: without the brackets the preview
 * shows the raw markdown instead of a link, and PDFs never get an inline viewer.
 *
 * A parenthesis or a backslash takes the brackets too. Bare, a `(` or `)` is legal only
 * in a balanced pair and a `\` escapes what follows, so the name has two spellings
 * (`files/Report(R).pdf` and `files/Report\(R\).pdf`, which is what a markdown
 * serialiser writes) and every reader of the body has to know both. Bracketed, the name
 * ends at the `>`, the one form every reader already handled. A backslash is still an
 * escape inside the brackets, so one in the name is doubled: written single, `a\(b.pdf`
 * would be read back as `a(b.pdf` and flagged "Not linked" by the readers this exists
 * to satisfy.
 */
function attachmentDestination(path: string): string {
  return /[\s()\\]/.test(path) ? `<${path.replace(/\\/g, '\\\\')}>` : path;
}

/**
 * Build a markdown link or image for an attachment path; see `attachmentDestination`.
 *
 * The label is nearly always the filename, and a bracket or a backslash in a filename
 * is escaped there as any serialiser would: written bare, `[a]b.pdf](files/a]b.pdf)` is
 * no link at all, and the panel called the file "Not linked" the moment it was added. A
 * balanced pair would survive, but the readers take the escaped form either way.
 */
export function formatAttachmentMarkdown(
  label: string,
  path: string,
  opts: { image?: boolean } = {},
): string {
  return `${opts.image ? '!' : ''}[${label.replace(/[[\]\\]/g, '\\$&')}](${attachmentDestination(path)})`;
}

/**
 * Decode a path segment the way the renderer does: percent-decoding when valid,
 * otherwise leaving the literal alone (a lone `%` is not encoding).
 */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Takes the backslash escapes off a run of markdown as written in the body: a
 * destination, or a label.
 *
 * CommonMark lets a backslash escape any ASCII punctuation, in a bracketed destination as
 * in a bare one, and the Evernote importer's serialiser escapes every parenthesis it
 * writes bare and every bracket in a label. The parser below does this itself; this is
 * for the editor, which reads a link's raw text out of its own syntax tree and has to
 * take the escapes off the same way, for the address it builds and for the alt it
 * draws. Percent-decoding is separate (`decodePathSegment`): the editor keeps the
 * encoded spelling for the address it builds, and only the readers here want the plain
 * name.
 */
export function unescapeMarkdown(raw: string): string {
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** An inline link or image in some markdown, with where it sits in the text. */
interface InlineLink {
  image: boolean;
  from: number;
  to: number;
  /** The `![alt]` or `[text]` part, verbatim, so a rewrite keeps it as written. */
  label: string;
  /**
   * Where the `(` after the label is. A rewrite of the destination replaces from here to
   * `to` and leaves the label alone, so an image inside the label (its own entry in the
   * list) is still rewritten on its own, in place, rather than copied into the new text.
   */
  destFrom: number;
  /** The destination as the parser reads it: brackets and backslash escapes off. */
  url: string;
  /** The link's title, if it had one, so a rewrite keeps it. */
  title: string | null;
}

/**
 * Parses markdown with the grammar the preview uses (`remarkDisableSetext` is part of
 * it), minus the plugins that only shape output, so what is a link here is a link there.
 */
const linkParser = unified().use(remarkParse).use(remarkDisableSetext).use(remarkGfm).freeze();

/**
 * Every inline link and image in some markdown, in order, with positions: the one walk
 * every reader and rewriter of link destinations here is built on.
 *
 * It is the markdown parser, not a regex. Until 2026-10-28 six hand-written regexes read
 * link syntax, one per reader, and each had its own idea of where a label or a destination
 * ended. None of them knew a backslash escape (which a serialiser writes for a parenthesis
 * or a bracket in a filename) or a balanced pair of parentheses; one stopped at the first
 * `)`, another at the first `]`, and a third took an image inside a link from the outer
 * bracket. Each was found and fixed one at a time, and each fix turned up the next. The
 * parser already answers what a link means, with the escapes and the title handled, and
 * with the positions a rewrite by slice needs, so that is what every reader asks now.
 *
 * Reference links, autolinks and the bare URLs GFM recognises are left out: they have no
 * `[label](destination)` to rewrite, and none of the readers wants them.
 */
function inlineLinks(markdown: string): InlineLink[] {
  if (markdown === lastParsed.markdown) return lastParsed.links;
  const links = parseInlineLinks(markdown);
  lastParsed = { markdown, links };
  return links;
}

/**
 * The last body parsed and what was found in it. Two readers run on every keystroke of
 * the body (the attachments panel's "linked" set and the count of web images in the
 * head), and a parse is about 1.5 ms per kilobyte of body, measured in Node on
 * 2026-10-28, against nothing for the regexes it replaced: a 100 KB clipped page is
 * 150 ms. One entry is enough, since both ask about the same draft in the same render,
 * and a string compare of two equal bodies is a memcmp. The callers defer the value they
 * pass in as well, so the keystroke is painted before the parse runs. If a long note
 * still types slowly, the next step is to read the links out of the editor's own
 * incremental syntax tree instead of parsing the body again here.
 */
let lastParsed: { markdown: string; links: InlineLink[] } = { markdown: '', links: [] };

function parseInlineLinks(markdown: string): InlineLink[] {
  // Nothing to find is the common case for a note of a few lines, and `[` is in every
  // inline link and image; the parse is the cost worth skipping, not the walk.
  if (!markdown.includes('[')) return [];
  const links: InlineLink[] = [];
  visit(linkParser.parse(markdown) as never, (node: MdLinkNode) => {
    if (node.type !== 'link' && node.type !== 'image') return;
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) return;
    const image = node.type === 'image';
    if (markdown.slice(from, from + (image ? 2 : 1)) !== (image ? '![' : '[')) return;
    const labelEnd = node.children?.length
      ? (node.children[node.children.length - 1]!.position?.end.offset ?? -1)
      : closingBracket(markdown, from + (image ? 2 : 1));
    // What follows the label has to be `](`: a reference link, `[x][ref]`, is a
    // `linkReference` node the walk never sees, so this guards the walk's own reading of
    // where the label ends, which for an image is a scan over the text.
    if (labelEnd < 0 || markdown[labelEnd] !== ']' || markdown[labelEnd + 1] !== '(') return;
    links.push({
      image,
      from,
      to,
      label: markdown.slice(from, labelEnd + 1),
      destFrom: labelEnd + 1,
      url: node.url ?? '',
      title: node.title ?? null,
    });
  });
  return links;
}

interface MdLinkNode {
  type: string;
  url?: string;
  title?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdLinkNode[];
}

/**
 * Where the `]` closing a label that opened at `from` is, or -1. An image's alt has no
 * children in the tree to take the position from, so it is found the way the parser found
 * it: a backslash hides what follows, a bracket pair inside the label nests, and a code
 * span binds tighter than either, so a bracket inside one is text. A backtick run with no
 * closing run of the same length is a literal backtick, as it is to the parser.
 */
function closingBracket(markdown: string, from: number): number {
  let depth = 0;
  for (let i = from; i < markdown.length; i++) {
    const c = markdown[i];
    if (c === '\\') i++;
    else if (c === '`') {
      const close = codeSpanEnd(markdown, i);
      if (close >= 0) i = close;
    } else if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The index of the last backtick closing the code span that opens at `open`, or -1. */
function codeSpanEnd(markdown: string, open: number): number {
  let length = 0;
  while (markdown[open + length] === '`') length++;
  const fence = '`'.repeat(length);
  let at = open + length;
  for (;;) {
    const next = markdown.indexOf(fence, at);
    if (next < 0) return -1;
    let run = 0;
    while (markdown[next + run] === '`') run++;
    if (run === length) return next + run - 1;
    at = next + run;
  }
}

/** A replacement of one span of the markdown. */
interface Edit {
  from: number;
  to: number;
  text: string;
}

/** The `(destination "title")` a link's would become with `dest` in it, the title kept. */
function destinationText(link: Pick<InlineLink, 'title'>, dest: string): string {
  const title = link.title === null ? '' : ` "${link.title.replace(/["\\]/g, '\\$&')}"`;
  return `(${dest}${title})`;
}

/** The edit that repoints `link` at `dest` and touches nothing else of it. */
function destinationEdit(link: InlineLink, dest: string): Edit {
  return { from: link.destFrom, to: link.to, text: destinationText(link, dest) };
}

/** The edit that takes `link` out whole, label and all. */
function removalEdit(link: InlineLink): Edit {
  return { from: link.from, to: link.to, text: '' };
}

/**
 * Applies `rewrite`'s edits and leaves the rest of the markdown as it was.
 *
 * A link's label can hold an image (`[![alt](files/a.png)](files/b.pdf)`, the clickable
 * picture every exporter writes), and the walk lists both. A rewrite that replaced the
 * outer link whole, label included, then wrote the inner image's replacement after it,
 * and the body held the image twice, once as the label still said it (2026-10-29). So a
 * destination edit replaces only the destination, which no inner link overlaps, and
 * the edits go in by position, with one inside a span already replaced (an image in a
 * removed link's label) dropped: it went with its container.
 */
function rewriteLinks<L extends InlineLink>(
  markdown: string,
  links: L[],
  rewrite: (link: L) => Edit | null,
): string {
  const edits: Edit[] = [];
  for (const link of links) {
    const edit = rewrite(link);
    if (edit) edits.push(edit);
  }
  edits.sort((a, b) => a.from - b.from);
  let out = '';
  let last = 0;
  for (const edit of edits) {
    if (edit.from < last) continue;
    out += markdown.slice(last, edit.from) + edit.text;
    last = edit.to;
  }
  return out + markdown.slice(last);
}

/**
 * Every same-note `files/…` link or image in some markdown. The filename is as the
 * attachment row has it, with the destination's escapes and encoding taken off.
 */
function relativeAttachmentLinks(markdown: string): Array<InlineLink & { filename: string }> {
  const links: Array<InlineLink & { filename: string }> = [];
  // Every same-note link spells `files/` somewhere in its destination, in any of the
  // forms; a body without it (most notes, and a note a move just cut a link out of) is
  // answered without the parse.
  if (!markdown.includes(ATTACHMENT_PREFIX)) return links;
  for (const link of inlineLinks(markdown)) {
    if (!link.url.startsWith(ATTACHMENT_PREFIX)) continue;
    const filename = decodePathSegment(link.url.slice(ATTACHMENT_PREFIX.length));
    if (filename) links.push({ ...link, filename });
  }
  return links;
}

/**
 * Filenames pointed at by relative `files/…` image or link destinations in markdown.
 *
 * Used to mark attachments that are still stored but no longer referenced in the body:
 * removing a link does not delete the file.
 */
export function attachmentFilenamesInMarkdown(markdown: string): Set<string> {
  return new Set(relativeAttachmentLinks(markdown).map((link) => link.filename));
}

/**
 * Repoints same-note `files/…` links at other names, keeping each label as written.
 *
 * `rename` answers the name a link should point at instead, or null to leave that link
 * alone. Matched by the name a destination means, in any of its spellings, and written
 * back by `attachmentDestination`'s rule; the importer uses it when the server stored a
 * resource under a suffixed name because the note already held one by that name.
 */
export function rewriteAttachmentLinks(
  markdown: string,
  rename: (filename: string) => string | null,
): string {
  return rewriteLinks(markdown, relativeAttachmentLinks(markdown), (link) => {
    const renamed = rename(link.filename);
    return renamed === null
      ? null
      : destinationEdit(link, attachmentDestination(`${ATTACHMENT_PREFIX}${renamed}`));
  });
}

/**
 * Removes markdown image/link nodes whose destination is `files/<filename>`.
 *
 * Matched by what the destination names, not by its spelling, so the percent-encoded,
 * bracketed and backslash-escaped forms all go. Leaves surrounding text intact.
 */
export function removeAttachmentLinks(markdown: string, filename: string): string {
  const out = rewriteLinks(markdown, relativeAttachmentLinks(markdown), (link) =>
    link.filename === filename ? removalEdit(link) : null,
  );
  // Collapse runs of blank lines left behind by a removed-only paragraph.
  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * The URL an attachment is served at, for text that leaves its note.
 *
 * `files/<name>` only means something inside the note that holds the file. The moment
 * that markdown is copied (to another note, to another app), the relative path points
 * at nothing, or worse, at a different note's file of the same name. This is the
 * self-describing form the clipboard carries instead: it names the note, so a paste can
 * find the bytes and copy them across, and it is a real link anywhere else. `origin` is
 * prepended when the text may be pasted outside the app, where a path alone is not a URL.
 */
export function attachmentUrl(noteId: string, filename: string, origin = ''): string {
  return `${origin}/api/notes/${segment(noteId)}/files/${segment(filename)}`;
}

/**
 * A path segment for a markdown destination. `encodeURIComponent` leaves `(` and `)` as
 * they are, and a bare one in a destination either has to balance or ends the link, so
 * `a(b.pdf` made a link other apps' parsers cannot read to the end. The server and the
 * worker decode the segment, so `%28` reaches the same file.
 */
function segment(value: string): string {
  return encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * The `files/<filename>` destination a link to one of the note's own files is written
 * with, bracketed when the name needs it; see `attachmentDestination`. For the editor,
 * which rewrites a pasted link's destination in place once its file is here.
 */
export function relativeAttachmentPath(filename: string): string {
  return attachmentDestination(`${ATTACHMENT_PREFIX}${filename}`);
}

/**
 * An absolute attachment address, with or without an origin: a URL, not markdown, so
 * the one regex left here is on the shape of a path. The note id and the filename are
 * percent-decoded by `parseAbsoluteAttachmentUrl`.
 */
const ABSOLUTE_ATTACHMENT_URL_RE = /^(?:https?:\/\/[^/]+)?\/api\/notes\/([^/?#]+)\/files\/([^?#]+)/;

/**
 * The note and file an absolute attachment address names, decoded, or null for any
 * other destination. What `attachmentUrl` writes for a copied link, read back on paste;
 * the editor finds the links themselves in its own syntax tree and asks this of each
 * destination. A query the panel's download link carries (`?download=1`) is not part of
 * the name, and the pattern stops at it.
 */
export function parseAbsoluteAttachmentUrl(url: string): { noteId: string; filename: string } | null {
  const match = ABSOLUTE_ATTACHMENT_URL_RE.exec(url);
  return match ? { noteId: decodePathSegment(match[1]!), filename: decodePathSegment(match[2]!) } : null;
}

/**
 * Whether some text could hold an absolute attachment link at all: the address's path
 * appears in it. For claiming a paste before the text is in a document, where alone
 * knowing whether that address is a link is possible (in a code block it is not), so
 * this errs towards claiming, and a claimed paste with no link in it is a plain paste.
 */
export function mayHoldAbsoluteAttachmentLink(text: string): boolean {
  return /\/api\/notes\/[^/\s]+\/files\//.test(text);
}

/** Every image drawn from the web: `![alt](http…)`, whichever way the address is spelled. */
function remoteImages(markdown: string): InlineLink[] {
  return inlineLinks(markdown).filter((link) => link.image && /^https?:\/\//i.test(link.url));
}

/**
 * The distinct web addresses a note's images are drawn from.
 *
 * A note converted from a bookmark by an assistant, or clipped from a page, links its
 * pictures to the site they came from. Those rot, get hotlink-blocked, are in no export
 * and no search: Evernote never left an image on the web, and neither should a note
 * here. This is what "Save web images" counts and fetches; `localizeImageLinks` is how
 * the links are rewritten once the files are stored.
 */
export function remoteImageUrls(markdown: string): string[] {
  return [...new Set(remoteImages(markdown).map((image) => image.url))];
}

/**
 * Points remote images at the files they were saved as.
 *
 * `stored` answers, for a web address, the filename the file now has in this note, or
 * null to leave that image where it was: a fetch that failed stays a working web link
 * rather than becoming a broken local one. The label is kept; only the destination
 * changes, bracketed when the name needs it.
 */
export function localizeImageLinks(
  markdown: string,
  stored: (url: string) => string | null,
): string {
  return rewriteLinks(markdown, remoteImages(markdown), (image) => {
    const filename = stored(image.url);
    return filename === null
      ? null
      : destinationEdit(image, attachmentDestination(`${ATTACHMENT_PREFIX}${filename}`));
  });
}

/**
 * Rewrites relative attachment paths to API URLs at render time.
 *
 * The markdown stored in D1 is never mutated: `files/diagram.png` stays relative on disk
 * so an exported folder works in any editor. Only the rendered output points at the API.
 */
export function remarkResolveAttachments(opts: { noteId: string }) {
  return (tree: unknown) => {
    visit(tree as never, (node: { type: string; url?: string }) => {
      if (node.type !== 'image' && node.type !== 'link') return;
      const url = node.url;
      if (typeof url !== 'string' || !url.startsWith(ATTACHMENT_PREFIX)) return;

      // remark hands back the URL exactly as written, so it may already be
      // percent-encoded (`files/my%20photo.png`) or raw (`<files/my photo.png>`).
      // Normalize by decoding first, then encoding each segment exactly once:
      // encoding blindly would turn `%20` into `%2520` and break the image.
      const filename = url.slice(ATTACHMENT_PREFIX.length);
      const encoded = filename
        .split('/')
        .map((segment) => {
          let decoded = segment;
          try {
            decoded = decodeURIComponent(segment);
          } catch {
            // A lone `%` is not valid encoding; treat the segment as literal.
          }
          return encodeURIComponent(decoded);
        })
        .join('/');
      node.url = `/api/notes/${encodeURIComponent(opts.noteId)}/files/${encoded}`;
    });
  };
}

/**
 * Marker the renderer turns into an inline PDF viewer.
 *
 * Deliberately a class on an ordinary link rather than an embed element. Emitting an
 * `<iframe>` here would mean teaching rehype-sanitize to permit iframes, and a sanitizer
 * that permits them permits *any* note content to author one, including imported ENML,
 * which is untrusted. Instead this stage marks a link it built itself, and the viewer is
 * mounted client-side from the marked anchor's href.
 */
export const PDF_EMBED_CLASS = 'unbent-pdf';

/** Attachment links pointing at a PDF, by extension on the resolved path. */
const PDF_PATH = /\.pdf$/i;

/** What the renderer knows about the files a note actually stores. */
export interface RenderOptions {
  noteId: string;
  /**
   * Filenames whose stored `content_type` is `application/pdf`.
   *
   * The extension is the usual signal, and for anything uploaded through the editor it is
   * the only one needed. This exists for the files where it lies: an ENEX `<file-name>` is
   * a display label, so a real export carries PDFs named `Menu Card`, and those notes
   * are already imported under that name. The attachment row records the declared type, so
   * the note itself can say which of its files are documents.
   *
   * Trusted because of where it comes from: the note's own attachment rows, not its
   * markdown. Note content can name any file it likes; it cannot put a name in this set.
   */
  pdfFilenames?: ReadonlySet<string>;
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
}

/**
 * Flags resolved attachment links that point at a PDF.
 *
 * Runs after sanitization, so any class an author wrote is already stripped and the marker
 * cannot be forged from note content. It only inspects URLs this pipeline produced: the
 * `/api/notes/` prefix is written by `remarkResolveAttachments`, never by the author.
 */
export function rehypeMarkPdfEmbeds(opts: { pdfFilenames?: ReadonlySet<string> } = {}) {
  return (tree: unknown) => {
    visit(tree as never, (node: HastNode) => {
      if (node.type !== 'element' || node.tagName !== 'a') return;

      const href = node.properties?.['href'];
      if (typeof href !== 'string' || !href.startsWith('/api/notes/')) return;

      let path = href.split('?')[0] ?? '';
      try {
        path = decodeURIComponent(path);
      } catch {
        // A malformed escape means the link is not one we produced; leave it alone.
        return;
      }

      // The name is the last segment of a path this pipeline built, so it is the stored
      // filename, the same key the attachment rows are listed under.
      const filename = path.slice(path.lastIndexOf('/') + 1);
      if (!PDF_PATH.test(path) && !opts.pdfFilenames?.has(filename)) return;

      node.properties = { ...node.properties, className: [PDF_EMBED_CLASS] };
    });
  };
}

/**
 * Marker on the link the renderer wraps each image in, which the preview pane turns into
 * a way to open the image at full size.
 */
export const IMAGE_ZOOM_CLASS = 'unbent-zoom';

interface HastParent extends HastNode {
  children?: HastNode[];
}

/**
 * Wraps every image in a link to itself.
 *
 * The preview pane is for reading, and an image in it should open when clicked: that is
 * what every notes app does, and it is what people try. The pane renders the pipeline's
 * HTML as a string it does not own node by node, so the control has to be in the markup:
 * a link around the image is the one that is honest without any script at all. It
 * focuses and activates from the keyboard, it can be middle-clicked into a new tab, and
 * the pane intercepts an ordinary click to open its viewer instead.
 *
 * An image already inside a link is left alone: `[![alt](img)](url)` is a picture that
 * goes somewhere, and a link inside a link is not HTML. Runs after sanitization, so the
 * marker cannot be forged from note content, and the `href` it writes is an image source
 * the sanitizer has already passed.
 */
export function rehypeLinkImages() {
  const walk = (node: HastParent, insideLink: boolean) => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i] as HastParent;
      if (child.type !== 'element') continue;

      if (child.tagName === 'img' && !insideLink) {
        const src = child.properties?.['src'];
        if (typeof src !== 'string' || !src) continue;
        children[i] = {
          type: 'element',
          tagName: 'a',
          properties: { href: src, className: [IMAGE_ZOOM_CLASS] },
          children: [child],
        } as HastParent;
        continue;
      }

      walk(child, insideLink || child.tagName === 'a');
    }
  };
  return (tree: unknown) => walk(tree as HastParent, false);
}

/** Permits the classes remark-gfm emits for task lists, which the default schema drops. */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    input: [...(defaultSchema.attributes?.['input'] ?? []), 'checked', 'disabled', 'type'],
    li: [...(defaultSchema.attributes?.['li'] ?? []), 'className'],
    ul: [...(defaultSchema.attributes?.['ul'] ?? []), 'className'],
  },
};

/**
 * Disable setext headings (`Title` followed by a line of `---` or `===`).
 *
 * While indenting a list, the next line is often a lone `-` before any text is typed.
 * CommonMark treats that as a setext underline, promoting the parent item text
 * to a huge H2 in preview. Headings in Unbent are ATX-only via the toolbar, so setext
 * parsing buys nothing and breaks nested lists.
 */
function remarkDisableSetext() {
  // @ts-expect-error: unified plugin `this` typing.
  const self = this;
  const data = self.data();
  const extensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  extensions.push({ disable: { null: ['setextUnderline'] } });
}

/**
 * A note body reduced to the prose someone would read, for a list row.
 *
 * Parsed with the same grammar the renderer uses, then flattened: headings, emphasis,
 * links and code keep their words and lose their marks; list items and table rows read
 * in order; a task keeps its box. Three kinds of node contribute nothing, on purpose:
 *
 * - **Images and attachment links.** A note that is one scanned PDF used to excerpt as
 *   `[Scan.pdf](<files/Scan.pdf>)`: the markup was the whole line. The list shows a
 *   note's files as their own line, from the attachment rows rather than from the body,
 *   so repeating them here as prose would say it twice and say it worse. An image's alt
 *   is nearly always its filename, so it goes with the image.
 * - **Raw HTML.** Imported ENML leaves inline tags behind, and a row is not the place to
 *   render them.
 * - **Rules and footnote marks.** Layout, not content.
 *
 * Blocks are joined with a middle dot rather than a newline: the row shows one line,
 * and `milk · eggs · bread` reads as the list it was, where the newline would have been
 * folded into a space and lost. The same separator the row already uses between field
 * values.
 *
 * Only the head of the body is parsed. A 140-character excerpt is decided well inside
 * the first few kilobytes, and an archive page lists fifty of these per request.
 */
export function excerptMarkdown(markdown: string, max = 140): string {
  const parts: string[] = [];
  let length = 0;
  const separator = ' · ';

  for (const block of parseHead(markdown)) {
    for (const text of blockTexts(block, 'excerpt')) {
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (!cleaned) continue;
      parts.push(cleaned);
      length += cleaned.length + separator.length;
      if (length > max) break;
    }
    if (length > max) break;
  }

  const joined = parts.join(separator);
  return joined.length > max ? `${joined.slice(0, max - 1).trimEnd()}…` : joined;
}

/** How much of the body the excerpt reads. See `excerptMarkdown`. */
const EXCERPT_HEAD_CHARS = 4000;

/** The loose node shape the excerpt walks; `@types/mdast` is not a dependency. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  checked?: boolean | null;
  children?: MdNode[];
}

function parseHead(markdown: string): MdNode[] {
  return parseBlocks(markdown.slice(0, EXCERPT_HEAD_CHARS));
}

function parseBlocks(markdown: string): MdNode[] {
  const tree = unified().use(remarkParse).use(remarkDisableSetext).use(remarkGfm).parse(markdown) as MdNode;
  return tree.children ?? [];
}

/**
 * What the flattening is for. An excerpt sits under a row that already lists the note's
 * files, so it drops their links, images and raw HTML. A search snippet is there to show
 * where the term was, and the term is as often a file's name as anything: there a link
 * keeps its label, an image its alt and raw HTML its words, and only the markup goes.
 */
type FlattenMode = 'excerpt' | 'snippet';

/**
 * One block's text, as the segments the excerpt joins.
 *
 * A paragraph or heading is one segment. Containers open up: each item of a list and each
 * row of a table is its own segment, so a to-do list reads item by item rather than as
 * one run-on. A blockquote's own blocks are yielded as they are.
 */
function* blockTexts(node: MdNode, mode: FlattenMode): Generator<string> {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      yield inlineText(node, mode);
      return;
    case 'code':
      yield node.value ?? '';
      return;
    case 'html':
      if (mode === 'snippet') yield withoutTags(node.value ?? '');
      return;
    case 'blockquote':
    case 'footnoteDefinition':
      for (const child of node.children ?? []) yield* blockTexts(child, mode);
      return;
    case 'list':
      for (const item of node.children ?? []) {
        // Nested lists sit inside the item; their items come out as segments of their own.
        const own = (item.children ?? []).filter((c) => c.type !== 'list');
        const nested = (item.children ?? []).filter((c) => c.type === 'list');
        const text = own.map((c) => [...blockTexts(c, mode)].join(' ')).join(' ');
        const box = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
        yield `${box}${text}`;
        for (const list of nested) yield* blockTexts(list, mode);
      }
      return;
    case 'table':
      for (const row of node.children ?? []) {
        yield (row.children ?? []).map((cell) => inlineText(cell, mode)).join(' ');
      }
      return;
    default:
      // thematicBreak, definition, yaml: nothing to read.
      return;
  }
}

/** The words of an inline run, marks removed and, for an excerpt, the two non-prose kinds dropped. */
function inlineText(node: MdNode, mode: FlattenMode): string {
  switch (node.type) {
    case 'text':
      // A `**` or `~~` the snippet's window cut from its partner is left as text by the
      // parse. Only text: in code the characters are the content.
      return mode === 'snippet' ? (node.value ?? '').replace(/\*\*|~~/g, '') : (node.value ?? '');
    case 'inlineCode':
      return node.value ?? '';
    case 'break':
      return ' ';
    case 'image':
      return mode === 'snippet' ? (node.alt ?? '') : '';
    case 'html':
      return mode === 'snippet' ? withoutTags(node.value ?? '') : '';
    case 'imageReference':
    case 'footnoteReference':
      return '';
    case 'link': {
      // A same-note attachment is shown by the row's file line, not repeated as its label.
      if (mode === 'excerpt' && typeof node.url === 'string' && node.url.startsWith(ATTACHMENT_PREFIX)) return '';
      const label = (node.children ?? []).map((c) => inlineText(c, mode)).join('');
      // FTS5 marks a matched phrase as one run, so a phrase across `](` opens its mark in
      // the label and closes it in the destination, which is dropped. Closed here, or the
      // mark would run to the end of the snippet.
      const unclosed = label.lastIndexOf(HIT_OPEN) > label.lastIndexOf(HIT_CLOSE);
      return unclosed && node.url?.includes(HIT_CLOSE) ? label + HIT_CLOSE : label;
    }
    default:
      return (node.children ?? []).map((c) => inlineText(c, mode)).join('');
  }
}

/** Raw HTML's words. The result is drawn as text, never as markup, so this only has to read well. */
function withoutTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

/** A run of a search snippet, and whether it is the matched term. */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

/**
 * A search snippet as the words it shows, with the matched terms marked.
 *
 * FTS5 cuts snippets from the body as stored, which is markdown, so a hit on an attached
 * file came back as `[Scan.pdf](<files/Scan.pdf>)` with the name highlighted twice. This
 * flattens it the way the list's excerpt is flattened (`excerptMarkdown`, with the
 * snippet's differences in `FlattenMode`), and both search engines' snippets come
 * through it, since they are cut alike.
 *
 * The `<<` and `>>` markers are swapped for private-use characters before the parse, so
 * the grammar sees a word where the term was, and they come out of the text nodes
 * wherever the parse put them. A marker inside a link's destination goes with the
 * destination: the label beside it still shows the term. Cutting the markers out first
 * and mapping offsets back through the parse was the other way, and remark does not keep
 * the offsets of text it unescapes.
 *
 * A snippet is a window of about two dozen tokens, so it often opens or closes inside a
 * link. Those edges are mended before the parse (`mendEdges`); a stray `**` the window cut
 * from its partner is dropped from the text the parse leaves (`inlineText`). If flattening leaves nothing (a window that was
 * all destination), the snippet is shown as it came rather than as an empty line.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  // A matched term never holds `<` or `>`, so a literal `<<` in the prose before one does not swallow it.
  const marked = snippet.replace(/<<([^<>]*)>>/g, `${HIT_OPEN}$1${HIT_CLOSE}`);
  const blocks = parseBlocks(mendEdges(marked)).flatMap((b) => [...blockTexts(b, 'snippet')]);
  const text = blocks
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.replace(HIT_MARKS, '').trim() !== '')
    .join(' · ');
  return splitHits(text.replace(HIT_MARKS, '').trim() ? text : marked);
}

const HIT_OPEN = '\uE000';
const HIT_CLOSE = '\uE001';
const HIT_MARKS = /[\uE000\uE001]/g;

/**
 * A snippet's first and last few characters, with the half of a link the window cut
 * reduced to its words: `…pdf](files/Scan.pdf) and` opens with `…pdf and`, and
 * `see [Scan.pdf](<files/Sc…` closes with `see Scan.pdf…`. A destination the window
 * opens inside (`…Scan.pdf>) and`) is dropped when it is plainly one: it ends in `>)`, or
 * it has a slash in it, as every `files/` destination does. A dot alone is not enough:
 * `…etc.) and` is prose, and dropping it was worse than showing a `…Scan.pdf)` the window
 * cut after the slash.
 */
function mendEdges(text: string): string {
  return text
    .replace(/^(…?)([^[\]\n]*)\]\((?:<[^>\n]*>|[^)\s]*)\)/, '$1$2')
    .replace(/^(…?)[^\s()[\]<]*(?:>\)|\/[^\s()[\]]*\))\s*/, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]*?(…?)$/, '$1$2')
    .replace(/\[(?=[^\]\n]*$)/, '');
}

function splitHits(text: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  for (const piece of text.split(/([\uE000\uE001])/)) {
    if (piece === HIT_OPEN) hit = true;
    else if (piece === HIT_CLOSE) hit = false;
    else if (piece) {
      const last = parts[parts.length - 1];
      if (last && last.hit === hit) last.text += piece;
      else parts.push({ text: piece, hit });
    }
  }
  return parts;
}

export function renderMarkdown(markdown: string, opts: RenderOptions): string {
  return unified()
    .use(remarkParse)
    .use(remarkDisableSetext)
    .use(remarkGfm)
    /**
     * Treat a single newline as a line break.
     *
     * CommonMark folds a lone newline into a space, so a note written as separate lines
     * renders as one run-on paragraph: surprising in a notes app, where people press
     * Enter expecting a new line rather than a new paragraph. This is what chat apps and
     * GitHub comments do; note that it is not part of GFM itself, which covers tables,
     * task lists, strikethrough, and autolinks.
     *
     * Runs after remark-gfm so GFM's own block constructs are parsed first.
     */
    .use(remarkBreaks)
    .use(remarkResolveAttachments, { noteId: opts.noteId })
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, schema)
    // After sanitize, so a forged marker in the source is already gone.
    .use(rehypeMarkPdfEmbeds, { pdfFilenames: opts.pdfFilenames })
    .use(rehypeLinkImages)
    .use(rehypeStringify)
    .processSync(markdown)
    .toString();
}
