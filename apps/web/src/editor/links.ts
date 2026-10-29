import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { unescapeMarkdown } from '@unbent/shared';

/**
 * Links and images read from the editor's own syntax tree.
 *
 * The tree is the one reading of the document the editor already has, and it knows the
 * context a fragment loses: a line indented four spaces is a nested list item here and a
 * code block to a parser handed the line alone. The clipboard used to hand the selected
 * text to the shared markdown parser, and a copied third-level bullet carried its
 * attachment link out unrewritten, since the parser saw code (2026-10-29). Everything
 * in the editor that needs a link's parts reads them from here.
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
