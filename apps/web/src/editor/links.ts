import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, type ChangeSpec, type Text } from '@codemirror/state';
import { GFM } from '@lezer/markdown';
import { ATTACHMENT_PREFIX, relativeAttachmentPath, unescapeMarkdown } from '@unbent/shared';

/**
 * Links and images read from the editor's own syntax tree.
 *
 * The tree is the one reading of the document the editor already has, and it knows the
 * context a fragment loses: a line indented four spaces is a nested list item here and a
 * code block to a parser handed the line alone. The clipboard used to hand the selected
 * text to the shared markdown parser, and a copied third-level bullet carried its
 * attachment link out unrewritten, since the parser saw code (2026-10-29). Everything
 * in the editor that needs a link's parts reads them from here.
 *
 * This is also the one place a note's body is rewritten by position. `@unbent/shared`
 * reads links (the panel's "linked" set, the import's checks, the store's move check)
 * and never rewrites them: until 2026-10-29 it held a second set of rewriters over the
 * remark tree, one per caller, and two parsers that had to agree about nesting, escapes
 * and context disagreed often enough to fill three review rounds. A rewrite here is a
 * `ChangeSpec` on an `EditorState`, dispatched to the open editor or applied to a
 * headless one (`rewriteText`) when no editor is mounted.
 */

/** A node of the syntax tree, as `@codemirror/language` hands it out; `@lezer/common` is not a dependency here. */
export type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

/** What a `[label](url)` or `![alt](url)` is made of, read from the tree's own marks. */
export interface LinkParts {
  /** The label's text, between the brackets, and where it sits. */
  label: string;
  labelFrom: number;
  labelTo: number;
  /**
   * The destination's range: the `URL` node, angle brackets included and the title not.
   * A rewrite of the destination replaces exactly this and leaves the label, a picture
   * inside the label, and the title where they are.
   */
  urlFrom: number;
  urlTo: number;
  /** The destination with its angle brackets and backslash escapes off, as the parser reads it. */
  url: string;
}

/**
 * A link's or image's parts, from the syntax tree rather than a regex over its text.
 *
 * The tree already knows where the label ends and the destination begins: a `]` in a
 * label is escaped as `\]` by any serialiser, and a regex that stopped at the first `]`
 * drew no link at all for an imported `Scan [1].pdf`. The destination is the `URL`
 * node, which excludes the title. Angle brackets come off, and so do backslash escapes:
 * the Evernote importer writes a `(` in a filename as `\(`, and the file's address has
 * to be built from the same name or the viewer under the link asks the server for a file
 * with backslashes in it and draws "Rendering…" for good. A reference link, `[x][ref]`,
 * has no `URL` child and no parts: nothing to hide and no attachment to render.
 */
export function linkParts(state: EditorState, node: SyntaxNode): LinkParts | undefined {
  let labelFrom = -1;
  let labelTo = -1;
  let url: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'LinkMark') {
      if (labelFrom < 0) labelFrom = child.to;
      else if (labelTo < 0) labelTo = child.from;
    } else if (child.name === 'URL' && labelTo >= 0) {
      // Only past the closing bracket: GFM marks a bare address inside the label as a
      // `URL` node as well, and `[https://x](https://y)` goes to `y`.
      url = child;
      break;
    }
  }
  if (labelFrom < 0 || labelTo < 0 || !url) return undefined;
  const raw = state.doc.sliceString(url.from, url.to);
  const inner = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  return {
    label: state.doc.sliceString(labelFrom, labelTo),
    labelFrom,
    labelTo,
    urlFrom: url.from,
    urlTo: url.to,
    url: unescapeMarkdown(inner),
  };
}

/** A link or image in the document, with where the whole of it sits. */
export interface DocumentLink extends LinkParts {
  from: number;
  to: number;
  image: boolean;
}

/**
 * How long a walk may wait for the parse to reach the end of what it walks. The tree
 * is usually there already (the parser keeps ahead of the viewport), and a note too
 * long to finish in this time is walked as far as it got, which is the editor's own
 * rule for its decorations.
 */
const PARSE_WAIT_MS = 200;

/**
 * Every link and image lying whole within one of `ranges`, in document order, by the
 * `URL` range it would be rewritten at. A picture inside a link's label is listed on
 * its own, before the link, since its destination comes first in the text; the two
 * never overlap. One cut across a range's edge is left out: the copied text would not
 * hold all of it, and a rewrite of half a link is worse than none.
 */
export function linksWithin(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DocumentLink[] {
  const links: DocumentLink[] = [];
  if (ranges.length === 0) return links;
  const end = Math.max(...ranges.map((range) => range.to));
  const tree = ensureSyntaxTree(state, end, PARSE_WAIT_MS) ?? syntaxTree(state);
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== 'Link' && node.name !== 'Image') return;
        if (node.from < range.from || node.to > range.to) return;
        const parts = linkParts(state, node.node);
        if (parts) links.push({ ...parts, from: node.from, to: node.to, image: node.name === 'Image' });
      },
    });
  }
  return links.sort((a, b) => a.urlFrom - b.urlFrom);
}

/** Percent-decodes when valid, leaving a literal `%` alone rather than throwing. */
export function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A state parsed with the editor's grammar, for a caller that holds a body and no view
 * (the attachments panel before the editor has mounted, say). Code languages are left
 * out: nothing here reads inside a fence.
 */
export function markdownState(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [markdown({ extensions: [GFM] })] });
}

/** `text` with `changesFor`'s changes applied, through a headless state; see `markdownState`. */
export function rewriteText(text: string, changesFor: (state: EditorState) => ChangeSpec[]): string {
  const state = markdownState(text);
  const changes = changesFor(state);
  return changes.length === 0 ? text : state.update({ changes }).state.doc.toString();
}

/** Every link and image in the document. */
function allLinks(state: EditorState): DocumentLink[] {
  return linksWithin(state, [{ from: 0, to: state.doc.length }]);
}

/** Whether a link's destination is on the web, as opposed to the note's own file. */
function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * The web images in the document, each address once, in document order: what "Save web
 * images" fetches. Read from the same tree `relinkWebImageChanges` rewrites, and by the
 * same reading of each destination, so every address fetched is one the relink will
 * find. The shared module's `remoteImageUrls` reads the body through remark, which
 * decodes character references where the tree does not: an address with `&amp;` in it
 * was fetched under one spelling and looked up under the other, and the picture kept
 * its web link while the head said it was saved (2026-10-29).
 */
export function webImageUrls(state: EditorState): string[] {
  const urls: string[] = [];
  for (const link of allLinks(state)) {
    if (link.image && isWebUrl(link.url) && !urls.includes(link.url)) urls.push(link.url);
  }
  return urls;
}

/** The note's own file a link points at, by the name the attachment row has, or null. */
export function attachmentFilenameOf(link: Pick<DocumentLink, 'url'>): string | null {
  if (!link.url.startsWith(ATTACHMENT_PREFIX)) return null;
  const filename = decodePath(link.url.slice(ATTACHMENT_PREFIX.length));
  return filename === '' ? null : filename;
}

/**
 * What removing `from..to` should take with it: the range itself, or, when it is all its
 * line holds, the line, and one blank line beside it when the line is a paragraph of its
 * own, so a removed-only paragraph does not leave a double gap.
 *
 * The blank line goes only when both sides are blank (or the document's edge). A link
 * that shares its paragraph with a line of text keeps the paragraph's gap: taking the
 * blank beside `text\n![x](files/x.png)\n\nmore` merged the two paragraphs into one,
 * which the text remover this replaced never did (2026-10-29). At the end of the
 * document the break before the blank goes too, so the note does not end in a newline
 * it did not have.
 *
 * `floor` is where an earlier removal in the same transaction ended: a blank line it
 * took is not taken again, since CodeMirror refuses two changes over one span.
 */
export function removalRange(doc: Text, from: number, to: number, floor = 0): { from: number; to: number } {
  const line = doc.lineAt(from);
  const alone =
    doc.lineAt(to).number === line.number &&
    doc.sliceString(line.from, from).trim() === '' &&
    doc.sliceString(to, line.to).trim() === '';
  if (!alone) return { from, to };
  const previous = line.number > 1 ? doc.line(line.number - 1) : null;
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  const blank = (l: { text: string } | null) => l === null || l.text.trim() === '';
  let start = line.from;
  let end = Math.min(line.to + 1, doc.length);
  if (blank(previous) && blank(next)) {
    if (previous && previous.from >= floor) {
      start = previous.from;
      if (next === null && start > floor) start -= 1; // the break before the last paragraph
    } else if (next) {
      end = Math.min(next.to + 1, doc.length);
    }
  }
  return { from: start, to: end };
}

/**
 * The changes that take every link and image to the note's own `filename` out of the
 * document. Matched by what the destination names, not its spelling, so the
 * percent-encoded, bracketed and backslash-escaped forms all go. Each goes by
 * `removalRange`; a picture inside a removed link's label goes with its container, and
 * is not a second change over the same span.
 */
export function removeAttachmentLinkChanges(state: EditorState, filename: string): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let last = 0;
  for (const link of allLinks(state).sort((a, b) => a.from - b.from)) {
    if (link.from < last || attachmentFilenameOf(link) !== filename) continue;
    const range = removalRange(state.doc, link.from, link.to, last);
    changes.push({ ...range, insert: '' });
    last = range.to;
  }
  return changes;
}

/**
 * The changes that point each web image (`![alt](http…)`) at the file it was saved as,
 * for the images `stored` answers a name for. The destination only: alt and title stay
 * as written, and an image `stored` has no name for keeps its web link, since a fetch
 * that failed is better left a working web link than made a broken local one.
 */
export function relinkWebImageChanges(state: EditorState, stored: (url: string) => string | null): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  for (const link of allLinks(state)) {
    if (!link.image || !isWebUrl(link.url)) continue;
    const filename = stored(link.url);
    if (filename === null) continue;
    changes.push({ from: link.urlFrom, to: link.urlTo, insert: relativeAttachmentPath(filename) });
  }
  return changes;
}
