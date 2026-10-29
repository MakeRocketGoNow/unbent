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
 */
export function formatAttachmentMarkdown(
  label: string,
  path: string,
  opts: { image?: boolean } = {},
): string {
  return `${opts.image ? '!' : ''}[${label}](${attachmentDestination(path)})`;
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
 * Takes the backslash escapes off a destination as written in the body.
 *
 * CommonMark lets a backslash escape any ASCII punctuation, in a bracketed destination as
 * in a bare one, and the Evernote importer's serialiser escapes every parenthesis it
 * writes bare. Until 2026-10-28 nothing here unescaped, so an imported `Report(R).pdf`
 * was looked up as `Report\(R\` and flagged "Not linked" beside a body that rendered it.
 * Percent-decoding is separate (`decodePathSegment`): the editor keeps the encoded
 * spelling for the address it builds, and only the shared readers want the plain name.
 */
export function unescapeDestination(raw: string): string {
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * A bare destination's name, as regex source: a backslash-escaped punctuation mark, one
 * balanced pair of parentheses, or any character that could not end the destination.
 * Single-quoted, since it holds a backtick, so the regexes that use it are built with
 * `new RegExp` rather than written as literals.
 */
const BARE_NAME_SRC = '(?:\\\\[!-/:-@[-`{-~]|\\([^()\\s<>]*\\)|[^()\\s<>\\\\])+';

/**
 * A link's label, between its brackets, as regex source: a backslash and whatever it
 * escapes, or anything but a bracket. A serialiser writes a bracket in a filename as
 * `\[`, so an imported `Scan [1].pdf` has the label `Scan \[1\].pdf`, and a label that
 * stopped at its first `]` saw no link there at all: the file was "Not linked" and its
 * rename on import never happened. A bare `[` is not taken, so an image inside a link,
 * `[![x](files/a.png)](/notes/n)` (which the Joplin import writes), is matched as the
 * image alone and not from the outer bracket, which removing the file would have eaten.
 */
const LABEL_SRC = '(?:\\\\.|[^\\[\\]\\\\])*';

/**
 * The two spellings of a `files/…` destination, as regex source: bracketed, where the
 * name runs to the closing `>`, and bare, where it ends at whitespace or the `)` that
 * closes the link. A bare name may still hold a backslash-escaped character (`\(`, and
 * the escaped character is never the end) or one balanced pair of parentheses, both of
 * which CommonMark allows and a serialiser or a person writes; see `unescapeDestination`.
 * Two capture groups, bracketed then bare; whichever matched holds the raw name.
 */
const RELATIVE_DESTINATION_SRC = `(?:<files\\/([^>\\n]+)>|files\\/(${BARE_NAME_SRC}))`;

/**
 * Filenames pointed at by relative `files/…` image or link destinations in markdown.
 *
 * Used to mark attachments that are still stored but no longer referenced in the body:
 * removing a link does not delete the file.
 */
export function attachmentFilenamesInMarkdown(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const link of relativeAttachmentLinks(markdown)) names.add(link.filename);
  return names;
}

/**
 * Every same-note `files/…` link or image in some markdown, in order, with positions:
 * the one walk `attachmentFilenamesInMarkdown`, `removeAttachmentLinks`,
 * `rewriteAttachmentLinks` and `absolutizeAttachmentLinks` are built on, so a spelling
 * one of them understands is a spelling all of them do. The filename is as the attachment row has it, with the
 * destination's escapes and encoding taken off.
 */
function relativeAttachmentLinks(
  markdown: string,
): Array<{ from: number; to: number; label: string; filename: string }> {
  const links: Array<{ from: number; to: number; label: string; filename: string }> = [];
  for (const match of markdown.matchAll(RELATIVE_ATTACHMENT_LINK_RE)) {
    const raw = ((match[2] ?? match[3] ?? '') as string).trim();
    if (!raw) continue;
    links.push({
      from: match.index,
      to: match.index + match[0].length,
      label: match[1] as string,
      filename: decodePathSegment(unescapeDestination(raw)),
    });
  }
  return links;
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
  let out = '';
  let last = 0;
  for (const link of relativeAttachmentLinks(markdown)) {
    const renamed = rename(link.filename);
    if (renamed === null) continue;
    out += markdown.slice(last, link.from);
    out += `${link.label}(${attachmentDestination(`${ATTACHMENT_PREFIX}${renamed}`)})`;
    last = link.to;
  }
  return out + markdown.slice(last);
}

/**
 * Removes markdown image/link nodes whose destination is `files/<filename>`.
 *
 * Matched by what the destination names, not by its spelling, so the percent-encoded,
 * bracketed and backslash-escaped forms all go. Leaves surrounding text intact.
 */
export function removeAttachmentLinks(markdown: string, filename: string): string {
  let out = '';
  let last = 0;
  for (const link of relativeAttachmentLinks(markdown)) {
    if (link.filename !== filename) continue;
    out += markdown.slice(last, link.from);
    last = link.to;
  }
  out += markdown.slice(last);
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
 * `a(b.pdf` made a link no reader could take back. The server and the worker decode the
 * segment, so `%28` reaches the same file.
 */
function segment(value: string): string {
  return encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * A link or image whose destination is `files/…` in either spelling: the label, then the
 * bracketed name or the bare one. See `RELATIVE_DESTINATION_SRC`.
 */
const RELATIVE_ATTACHMENT_LINK_RE = new RegExp(
  `(!?\\[${LABEL_SRC}\\])\\(\\s*${RELATIVE_DESTINATION_SRC}\\s*\\)`,
  'g',
);

/**
 * Rewrites every same-note `files/…` link to the absolute form `attachmentUrl` produces.
 *
 * Run on the way *out* of a note (the editor's copy handler), never on the stored body,
 * which stays relative so an exported folder works in any editor. The label is kept as
 * written; only the destination changes. Angle brackets are dropped along with the
 * spaces that needed them: the encoded URL has none.
 */
export function absolutizeAttachmentLinks(
  markdown: string,
  opts: { noteId: string; origin?: string },
): string {
  let out = '';
  let last = 0;
  for (const link of relativeAttachmentLinks(markdown)) {
    out += markdown.slice(last, link.from);
    out += `${link.label}(${attachmentUrl(opts.noteId, link.filename, opts.origin)})`;
    last = link.to;
  }
  return out + markdown.slice(last);
}

/** A link in pasted text that names another note's file, with where it sits in the text. */
export interface AbsoluteAttachmentLink {
  from: number;
  to: number;
  /** The `![alt]` or `[text]` part, verbatim, so a rewrite keeps the image mark. */
  label: string;
  noteId: string;
  filename: string;
}

/**
 * An absolute attachment destination, with or without an origin, with or without angle
 * brackets. The note id and filename groups stop at anything that could end a URL or a
 * markdown destination; the filename is unescaped and percent-decoded by the caller.
 *
 * The filename takes the bare grammar of `RELATIVE_DESTINATION_SRC`. `attachmentUrl`
 * encodes a parenthesis now, but until 2026-10-28 it left one as it was, so a copied
 * `Report(R).pdf` link had a balanced pair in its address, and a group that stopped at
 * the first `)` cut the name to `Report(R` and pasted it back as a link to a file that
 * does not exist. Such links are still on clipboards and in other apps' notes.
 */
const ABSOLUTE_ATTACHMENT_LINK_RE = new RegExp(
  `(!?\\[${LABEL_SRC}\\])\\(\\s*<?(?:https?:\\/\\/[^/\\s<>]+)?\\/api\\/notes\\/([^/\\s<>)]+)\\/files\\/(${BARE_NAME_SRC}?)>?\\s*\\)`,
  'g',
);

/**
 * Every absolute attachment link in some markdown, in order, with positions.
 *
 * The positions are what the editor needs: it inserts pasted text first and rewrites the
 * links in place once the files have been copied, and a rewrite by position is one
 * transaction that leaves the cursor and the undo history alone. A whole-string
 * `relativizeAttachmentLinks` is built on the same walk for callers that hold text rather
 * than a document.
 */
export function findAbsoluteAttachmentLinks(markdown: string): AbsoluteAttachmentLink[] {
  const links: AbsoluteAttachmentLink[] = [];
  for (const match of markdown.matchAll(ABSOLUTE_ATTACHMENT_LINK_RE)) {
    const [whole, label, noteId, filename] = match;
    if (!label || !noteId || !filename) continue;
    links.push({
      from: match.index,
      to: match.index + whole.length,
      label,
      noteId: decodePathSegment(noteId),
      // A query the panel's download link carries (`?download=1`) is not part of the name.
      filename: decodePathSegment(unescapeDestination(filename).split('?')[0] ?? ''),
    });
  }
  return links;
}

/** The distinct files some markdown links absolutely, each named once per note. */
export function absoluteAttachmentRefs(markdown: string): Array<{ noteId: string; filename: string }> {
  const seen = new Set<string>();
  const refs: Array<{ noteId: string; filename: string }> = [];
  for (const { noteId, filename } of findAbsoluteAttachmentLinks(markdown)) {
    const key = `${noteId}${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ noteId, filename });
  }
  return refs;
}

/** The markdown a link should become once its file is stored in the note as `filename`. */
export function relativeAttachmentLink(link: Pick<AbsoluteAttachmentLink, 'label'>, filename: string): string {
  return `${link.label}(${attachmentDestination(`${ATTACHMENT_PREFIX}${filename}`)})`;
}

/**
 * Turns absolute attachment links back into `files/…` links, for text arriving in a note.
 *
 * `rename` answers, for each link, the filename the file now has in the destination note
 * (which may differ from the source's, since a name already taken there is suffixed)
 * or null to leave that link as it is. Leaving it absolute is the honest fallback when the
 * copy failed: the link still opens for the owner, and nothing pretends the file is here.
 */
export function relativizeAttachmentLinks(
  markdown: string,
  rename: (ref: { noteId: string; filename: string }) => string | null,
): string {
  let out = '';
  let last = 0;
  for (const link of findAbsoluteAttachmentLinks(markdown)) {
    const renamed = rename(link);
    if (renamed === null) continue;
    out += markdown.slice(last, link.from) + relativeAttachmentLink(link, renamed);
    last = link.to;
  }
  return out + markdown.slice(last);
}

/**
 * A remote image: `![alt](http…)`, in either destination spelling. As with the relative
 * form, a bracketed address runs to the `>` and may hold spaces; a bare one ends at the `)`.
 */
const REMOTE_IMAGE_LINK_RE =
  /(!\[[^\]]*\])\(\s*(?:<(https?:\/\/[^>\n]+)>|(https?:\/\/[^\s<>)]+))\s*\)/gi;

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
  const seen = new Set<string>();
  for (const match of markdown.matchAll(REMOTE_IMAGE_LINK_RE)) {
    const url = (match[2] ?? match[3] ?? '').trim();
    if (url) seen.add(url);
  }
  return [...seen];
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
  return markdown.replace(REMOTE_IMAGE_LINK_RE, (whole, label: string, bracketed, bare) => {
    const filename = stored(((bracketed ?? bare ?? '') as string).trim());
    if (filename === null) return whole;
    return formatAttachmentMarkdown(label.slice(2, -1), `${ATTACHMENT_PREFIX}${filename}`, {
      image: true,
    });
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
