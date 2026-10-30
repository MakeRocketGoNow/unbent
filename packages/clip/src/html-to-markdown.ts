import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { visit } from 'unist-util-visit';

/**
 * HTML to Markdown, without a DOM.
 *
 * This began as the body of the ENEX importer's ENML converter (`@unbent/enex/enml`) and
 * was lifted out when the web clipper needed the same thing for arbitrary pages. Evernote's
 * ENML is HTML with two custom elements, so everything here that is not about those
 * elements applies to a web page unchanged; the ENML converter now composes these pieces
 * with its own transforms (`en-media`, `en-todo`, the `<en-note>` wrapper) and calls
 * `htmlToMarkdown` on the result, so the two cannot drift apart.
 *
 * It uses the unified AST (hast to mdast to Markdown) rather than a DOM-based converter
 * like Turndown so it runs anywhere: in a browser Web Worker, where there is no document,
 * and in the API Worker on Cloudflare, where there is none either.
 */

/**
 * A hast or mdast node. The unified types are structural enough that one loose alias
 * covers every transform here, and keeps the transforms from casting at each step.
 */
export type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  url?: string;
  alt?: string;
  [key: string]: unknown;
};

/**
 * The root `fromHtml` answers. Spelled from its return type rather than imported from
 * `hast`, so callers can hand a parsed tree back without this package depending on
 * `@types/hast` as well.
 */
export type HastRoot = ReturnType<typeof fromHtml>;

/**
 * The parser `htmlToMarkdown` uses, for a caller that reads the tree before converting
 * it (the editor's paste looks in it for a `<base href>` to resolve addresses against)
 * and then hands the same tree on. Re-exported rather than depended on by that caller, so the
 * parser and the converter are always one version, and an app that converts HTML has
 * one package to declare.
 */
export { fromHtml };

/** A transform over the parsed tree, run in place. */
export type Transform = (tree: Node) => void;

/**
 * Attributes that only style. Dropping them is the point of moving to Markdown: in a
 * note clipped by Evernote's clipper `style` alone accounts for most of the bulk, and a
 * web page's `class` and `id` mean nothing once its stylesheet is gone.
 */
export const DROP_ATTRS = new Set(['style', 'class', 'className', 'id', 'bgcolor', 'face', 'color']);

/** Elements that carry no meaning once styling is gone. */
export const UNWRAP_TAGS = new Set(['span', 'font', 'center', 'basefont', 'big', 'small']);

/** Elements dropped whole, contents included. */
export const DROP_TAGS = new Set(['style', 'script', 'meta', 'link', 'colgroup', 'col']);

export function isElement(node: Node, tag?: string): boolean {
  return node.type === 'element' && (tag === undefined || node.tagName === tag);
}

/** Strips presentational attributes and unwraps styling-only elements. */
export function stripPresentation(): Transform {
  return (tree: Node) => {
    visit(tree as never, 'element', (node: Node, index: number | undefined, parent: Node | undefined) => {
      if (node.properties) {
        for (const attr of Object.keys(node.properties)) {
          if (DROP_ATTRS.has(attr)) delete node.properties[attr];
        }
      }

      if (!parent || index === undefined) return;

      if (DROP_TAGS.has(node.tagName ?? '')) {
        parent.children!.splice(index, 1);
        return index;
      }

      if (UNWRAP_TAGS.has(node.tagName ?? '')) {
        parent.children!.splice(index, 1, ...(node.children ?? []));
        return index;
      }
      return undefined;
    });
  };
}

/**
 * Elements that make a `<div>` holding one a container rather than a line; see
 * `divsToParagraphs`. Every element a browser lays out as a block of its own.
 */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
]);

/**
 * `<div>` is Evernote's line separator, and plenty of web pages use it the same way;
 * Markdown has no equivalent, and to-mdast would otherwise run adjacent divs together
 * into one paragraph. Converting them to `<p>` preserves the visual line structure the
 * text was written with.
 *
 * A div wrapping block content is a container and is left alone: made a `<p>`, it would
 * fold everything inside it into one paragraph. `BLOCK_TAGS` says which children make it
 * one: every block element, which a web page needs (an article Readability hands back is
 * an `<article>` and a code sample is a `<pre>`, each inside a div) and which ENML needs
 * too, where a div can hold a `<pre>`, an `<hr>` or a `<dl>`. The ENML converter kept a
 * shorter list of its own until 2026-10-30, because the import's dedupe hash covers its
 * output; `enmlToMarkdown` says what that cost and why it went.
 */
export function divsToParagraphs(): Transform {
  return (tree: Node) => {
    visit(tree as never, 'element', (node: Node) => {
      if (node.tagName !== 'div') return;
      const hasBlockChild = (node.children ?? []).some((c) => isElement(c) && BLOCK_TAGS.has(c.tagName ?? ''));
      if (!hasBlockChild) node.tagName = 'p';
    });
  };
}

/**
 * Serialises an already-cleaned hast tree to Markdown.
 *
 * The options are the house style every imported note has been written in since the
 * ENEX importer: `-` bullets, `_italic_` and `**bold**` (different characters, so a run of
 * one is never read as the other), fenced code, `-` rules, and links always in the
 * `[text](url)` form even when the text is the URL. Changing any of them changes every
 * note an import or a clip writes from then on, and the ENML tests pin them.
 */
export function hastToMarkdown(tree: Node, opts: { tidyInsideCode?: boolean } = {}): string {
  const mdast = toMdast(tree as never);

  const markdown = toMarkdown(mdast as never, {
    extensions: [gfmToMarkdown()],
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fences: true,
    rule: '-',
    resourceLink: false,
  });

  return opts.tidyInsideCode ? tidy(markdown) : tidyOutsideCode(markdown);
}

export interface HtmlToMarkdownOptions {
  /**
   * Transforms to run on the parsed tree before the cleaning ones. For a caller that
   * passes a string and so never holds the tree: a transform that rewrites links or
   * images has to see them before `stripPresentation` takes the attributes it might key
   * on.
   */
  transforms?: Transform[];
  /**
   * Run the text clean-up over code blocks too, which damages them; see `tidyOutsideCode`.
   * For the ENEX import alone, whose dedupe hash covers this output.
   */
  tidyInsideCode?: boolean;
}

/**
 * HTML to Markdown: parse (when given a string), clean, serialise.
 *
 * Takes an HTML fragment as a string, or a tree the caller already parsed with `fromHtml`
 * and transformed. A tree is changed in place, so a caller that wants it afterwards must
 * pass a copy.
 */
export function htmlToMarkdown(input: string | HastRoot | Node, opts: HtmlToMarkdownOptions = {}): string {
  const tree = (typeof input === 'string' ? fromHtml(input, { fragment: true }) : input) as unknown as Node;

  for (const transform of opts.transforms ?? []) transform(tree);
  stripPresentation()(tree);
  divsToParagraphs()(tree);

  return hastToMarkdown(tree, { tidyInsideCode: opts.tidyInsideCode ?? false });
}

/**
 * Post-processing that is easier and safer on the text than in the AST.
 *
 * - Unescape intra-word underscores. mdast escapes every `_`, turning a filename like
 *   `2020_02_29.pdf` into an unreadable `2020\\_02\\_29.pdf` that is also wrong if copied
 *   back out. CommonMark does not read an underscore inside a word as emphasis, so the
 *   escape buys nothing on the filenames these notes are full of. (The serialiser has a
 *   `handle` hook that could do this in the AST, but it runs after the escaping, so the
 *   text is where it can be undone.)
 * - Drop trailing-backslash hard breaks. Evernote emits stray `<br>` by the thousand and
 *   each becomes a visible line-break marker that was never meaningful.
 * - Normalize non-breaking spaces and collapse the blank-line runs clipped HTML leaves.
 */
function tidy(markdown: string): string {
  return markdown
    .replace(/ /g, ' ')
    .replace(/(?<=\w)\\_(?=\w)/g, '_')
    .replace(/\\$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * `tidy`, leaving code blocks exactly as they came.
 *
 * Its rules are about prose, and inside a code block each one breaks something: a line's
 * trailing backslash is a shell continuation, blank lines and trailing spaces are the
 * sample's own, and `\\_` means what it says. On a documentation page, the thing people
 * most often clip or paste code from, `docker run \\` lost its backslash silently.
 *
 * By lines rather than in the AST for the reason `tidy` gives. The serialiser writes every
 * code block fenced (`fences: true`) and always with a fence longer than any run inside
 * it, so a line that closes the fence cannot be part of the code. A fence can follow a
 * list marker or a quote's `>`. A backtick fence's opening line holds no other backtick,
 * which is what tells it from inline code that happens to start a line.
 */
function tidyOutsideCode(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let blank = false;
  for (const line of markdown.split('\n')) {
    if (fence !== null) {
      out.push(line);
      const closing = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = null;
      continue;
    }
    const opening = /^[\s>]*(?:(?:[-*+]|\d+[.)])\s+[\s>]*)*(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1]![0] === '`' && opening[2]!.includes('`'))) fence = opening[1]!;

    const tidied = line
      .replace(/\u00a0/g, ' ')
      .replace(/(?<=\w)\\_(?=\w)/g, '_')
      .replace(/\\$/, '')
      .replace(/[ \t]+$/, '');
    // One blank line at most between blocks, as `tidy`'s run of newlines does.
    if (tidied === '' && blank) continue;
    blank = tidied === '';
    out.push(tidied);
  }
  return out.join('\n').trim();
}
