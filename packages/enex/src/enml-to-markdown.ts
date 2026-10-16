import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { visit } from 'unist-util-visit';
import type { EnexResource } from './types.js';

/** Nodes carry arbitrary properties; hast/mdast types are structural enough to alias. */
type Node = {
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
 * Attributes Evernote's clipper sprays over everything. Dropping them is the point of
 * moving to markdown: `style` alone accounts for most of the bulk in a clipped note.
 */
const DROP_ATTRS = new Set(['style', 'class', 'className', 'id', 'bgcolor', 'face', 'color']);

/** Elements that carry no meaning once styling is gone. */
const UNWRAP_TAGS = new Set(['span', 'font', 'center', 'basefont', 'big', 'small']);

/** Elements dropped whole, contents included. */
const DROP_TAGS = new Set(['style', 'script', 'meta', 'link', 'colgroup', 'col']);

function isElement(node: Node, tag?: string): boolean {
  return node.type === 'element' && (tag === undefined || node.tagName === tag);
}

/**
 * Rewrites `<en-media hash>` into an image or link pointing at a relative `files/` path.
 *
 * The hash is an MD5 of the resource's decoded bytes (ENEX does not store it on the
 * resource itself) so resolution is by lookup, never by position. Resources appear in a
 * different order than their references, so pairing them positionally attaches the wrong
 * file to the wrong note.
 */
function resolveMedia(byMd5: Map<string, EnexResource>, used: Set<string>) {
  return (tree: Node) => {
    // Replacements are collected during the walk and applied after it. Mutating
    // parent.children mid-visit makes unist-util-visit skip the next sibling, which
    // silently drops every second attachment in a note that has several.
    const edits: Array<{ parent: Node; index: number; replacement: Node }> = [];

    visit(tree as never, 'element', (node: Node, index: number | undefined, parent: Node | undefined) => {
      if (node.properties?.['dataEn'] !== 'media' || !parent || index === undefined) return;

      const hash = String(node.properties?.['hash'] ?? '');
      const resource = byMd5.get(hash);

      if (!resource) {
        // A reference with no matching resource; real exports do contain these. Leave a
        // visible marker rather than silently dropping content.
        edits.push({
          parent,
          index,
          replacement: { type: 'text', value: `[missing attachment ${hash.slice(0, 8)}]` },
        });
        return;
      }

      used.add(resource.md5);
      const url = `files/${resource.filename}`;

      edits.push({
        parent,
        index,
        replacement: resource.mime.startsWith('image/')
          ? { type: 'element', tagName: 'img', properties: { src: url, alt: resource.filename }, children: [] }
          : {
              type: 'element',
              tagName: 'a',
              properties: { href: url },
              children: [{ type: 'text', value: resource.filename }],
            },
      });
    });

    for (const { parent, index, replacement } of edits) parent.children![index] = replacement;
  };
}

/** Converts Evernote checkboxes into GFM task list items. */
function convertTodos() {
  return (tree: Node) => {
    // Collected then applied, for the same sibling-skipping reason as resolveMedia.
    const edits: Array<{ parent: Node; index: number; checked: boolean }> = [];

    visit(tree as never, 'element', (node: Node, index: number | undefined, parent: Node | undefined) => {
      if (node.properties?.['dataEn'] !== 'todo' || !parent || index === undefined) return;
      edits.push({
        parent,
        index,
        checked: String(node.properties?.['checked'] ?? '') === 'true',
      });
    });

    for (const { parent, index, checked } of edits) {
      // to-mdast recognizes a task item from a leading checkbox input inside an <li>, so
      // the checkbox must stay a sibling of the item text rather than replacing it.
      parent.children![index] = {
        type: 'element',
        tagName: 'input',
        properties: { type: 'checkbox', checked, disabled: true },
        children: [],
      };
    }
  };
}

/** Strips presentational attributes and unwraps styling-only elements. */
function stripPresentation() {
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
 * `<div>` is Evernote's line separator; markdown has no equivalent, and to-mdast would
 * otherwise run adjacent divs together into one paragraph. Converting them to `<p>`
 * preserves the visual line structure the note was written with.
 */
function divsToParagraphs() {
  return (tree: Node) => {
    visit(tree as never, 'element', (node: Node) => {
      if (node.tagName !== 'div') return;
      // A div wrapping block content is a container; only leaf-ish divs are lines.
      const hasBlockChild = (node.children ?? []).some(
        (c) =>
          isElement(c) &&
          ['div', 'p', 'ul', 'ol', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(
            c.tagName ?? '',
          ),
      );
      if (!hasBlockChild) node.tagName = 'p';
    });
  };
}

export interface ConvertResult {
  markdown: string;
  /** md5s of resources actually referenced by an en-media element. */
  usedMd5: Set<string>;
}

/**
 * ENML to Markdown.
 *
 * Uses the unified AST rather than a DOM-based converter like Turndown: ENML's custom
 * elements (`en-media`, `en-todo`) are handled as first-class node transforms instead of
 * regex over HTML, and the pipeline runs without a DOM so it works in a Worker.
 */
export function enmlToMarkdown(enml: string, resources: EnexResource[]): ConvertResult {
  const byMd5 = new Map(resources.map((r) => [r.md5, r]));
  const usedMd5 = new Set<string>();

  // ENML wraps content in <en-note>; strip the XML prolog and doctype first.
  //
  // en-media and en-todo are void elements in ENML, but an HTML parser has never heard of
  // them and so treats them as containers, nesting everything that follows *inside* the
  // tag. That silently swallows sibling attachments and list item text. Rewriting them to
  // known void elements before parsing keeps the tree flat; the transforms below then key
  // off the preserved data-en attribute.
  const inner = enml
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<en-media\b([^>]*?)\/?>/gi, '<img data-en="media"$1>')
    .replace(/<\/en-media\s*>/gi, '')
    .replace(/<en-todo\b([^>]*?)\/?>/gi, '<input data-en="todo"$1>')
    .replace(/<\/en-todo\s*>/gi, '')
    .trim();

  const parsed = fromHtml(inner, { fragment: true }) as unknown as Node;

  // <en-note> is a wrapper with no markdown meaning; lift its children to the root rather
  // than teaching the converter about a tag it will never see again.
  const tree: Node =
    parsed.children?.length === 1 && isElement(parsed.children[0]!, 'en-note')
      ? { type: 'root', children: parsed.children[0]!.children ?? [] }
      : parsed;

  resolveMedia(byMd5, usedMd5)(tree);
  convertTodos()(tree);
  stripPresentation()(tree);
  divsToParagraphs()(tree);

  const mdast = toMdast(tree as never);

  const markdown = toMarkdown(mdast as never, {
    extensions: [gfmToMarkdown()],
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fences: true,
    rule: '-',
    resourceLink: false,
    /**
     * Leave intra-word underscores alone.
     *
     * The default escapes every `_`, turning a filename like `2020_02_29.pdf` into
     * `2021\_01\_23.pdf`: unreadable in the editor and wrong if copied back out.
     * CommonMark does not treat an underscore inside a word as emphasis, so the escape
     * buys nothing. `handle` runs after the default escaping, so undo it there.
     */
  });

  return { markdown: tidy(markdown), usedMd5 };
}

/**
 * Post-processing that is easier and safer on the text than in the AST.
 *
 * - Unescape intra-word underscores. mdast escapes every `_`, turning a filename like
 *   `2020_02_29.pdf` into an unreadable `2020\\_02\\_29.pdf` that is also wrong if copied
 *   back out. CommonMark does not read an underscore inside a word as emphasis, so the
 *   escape buys nothing on the filenames these notes are full of.
 * - Drop trailing-backslash hard breaks. Evernote emits stray `<br>` by the thousand and
 *   each becomes a visible line-break marker that was never meaningful.
 * - Normalize non-breaking spaces and collapse the blank-line runs clipped HTML leaves.
 */
function tidy(markdown: string): string {
  return markdown
    .replace(/\u00a0/g, ' ')
    .replace(/(?<=\w)\\_(?=\w)/g, '_')
    .replace(/\\$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
