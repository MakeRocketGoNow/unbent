import { fromHtml } from 'hast-util-from-html';
import { visit } from 'unist-util-visit';
import { htmlToMarkdown, isElement, type Node } from '@unbent/clip/html-to-markdown';
import type { EnexResource } from './types.js';

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

  // The cleaning (styling stripped, divs made paragraphs) and the serialisation are the
  // web clipper's too, and live in `@unbent/clip`; ENML only adds its own elements first.
  return { markdown: htmlToMarkdown(tree, { blockTags: ENML_BLOCK_TAGS }), usedMd5 };
}

/**
 * The children that keep an ENML `<div>` a container rather than a line.
 *
 * Shorter than the clipper's `BLOCK_TAGS` on purpose, and frozen: it is the list every
 * note imported so far was converted with. With the longer one, a div around a `<pre>`,
 * an `<hr>` or a `<dl>` (all of which ENML allows) would convert differently, and since
 * an import's dedupe hash (`enexNoteHash`) is taken over the converted body, importing
 * the same export again would no longer recognise those notes as already there. The rest of the longer list (`article`, `section` and the like) is HTML5,
 * which ENML does not allow, so it would change nothing here either way.
 */
const ENML_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'div',
  'p',
  'ul',
  'ol',
  'table',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
