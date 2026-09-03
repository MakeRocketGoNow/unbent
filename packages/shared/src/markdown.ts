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
 * Build a markdown link or image for an attachment path.
 *
 * CommonMark destinations cannot contain whitespace unless wrapped in angle brackets.
 * Dropped files keep their original names, so a PDF like `Treatment Plan.pdf` must become
 * `[Treatment Plan.pdf](<files/Treatment Plan.pdf>)` — without the brackets the preview
 * shows the raw markdown instead of a link, and PDFs never get an inline viewer.
 */
export function formatAttachmentMarkdown(
  label: string,
  path: string,
  opts: { image?: boolean } = {},
): string {
  const dest = /\s/.test(path) ? `<${path}>` : path;
  return `${opts.image ? '!' : ''}[${label}](${dest})`;
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
 * Filenames pointed at by relative `files/…` image or link destinations in markdown.
 *
 * Used to mark attachments that are still stored but no longer referenced in the body —
 * removing a link does not delete the file.
 */
export function attachmentFilenamesInMarkdown(markdown: string): Set<string> {
  const names = new Set<string>();
  // Covers `[…](files/x)`, `[…](<files/x y>)`, and image forms with a leading `!`.
  const re = /!\[[^\]]*]\(\s*<?files\/([^)\n>]+)>?\s*\)|\[[^\]]*]\(\s*<?files\/([^)\n>]+)>?\s*\)/g;
  for (const match of markdown.matchAll(re)) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (!raw) continue;
    names.add(decodePathSegment(raw));
  }
  return names;
}

/** Escape a string for use inside a RegExp character class / pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes markdown image/link nodes whose destination is `files/<filename>`.
 *
 * Handles both raw and percent-encoded destinations, and angle-bracket destinations
 * used when the path contains spaces. Leaves surrounding text intact.
 */
export function removeAttachmentLinks(markdown: string, filename: string): string {
  const variants = new Set([filename, encodeURIComponent(filename)]);
  let out = markdown;
  for (const name of variants) {
    const dest = escapeRegExp(`${ATTACHMENT_PREFIX}${name}`);
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(\\s*<?${dest}>?\\s*\\)`, 'g'), '');
  }
  // Collapse runs of blank lines left behind by a removed-only paragraph.
  return out.replace(/\n{3,}/g, '\n\n');
}

/**
 * Rewrites relative attachment paths to API URLs at render time.
 *
 * The markdown stored in D1 is never mutated — `files/diagram.png` stays relative on disk
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
      // Normalize by decoding first, then encoding each segment exactly once —
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
 * that permits them permits *any* note content to author one — including imported ENML,
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
   * Trusted because of where it comes from — the note's own attachment rows, not its
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
 * cannot be forged from note content. It only inspects URLs this pipeline produced — the
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
      // filename — the same key the attachment rows are listed under.
      const filename = path.slice(path.lastIndexOf('/') + 1);
      if (!PDF_PATH.test(path) && !opts.pdfFilenames?.has(filename)) return;

      node.properties = { ...node.properties, className: [PDF_EMBED_CLASS] };
    });
  };
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
  // @ts-expect-error — unified plugin `this` typing.
  const self = this;
  const data = self.data();
  const extensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  extensions.push({ disable: { null: ['setextUnderline'] } });
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
     * renders as one run-on paragraph — surprising in a notes app, where people press
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
    .use(rehypeStringify)
    .processSync(markdown)
    .toString();
}
