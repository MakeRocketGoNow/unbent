/**
 * Puts the parts of a page that React streamed in where they belong, as the page's own
 * scripts would have done in a browser.
 *
 * A page rendered with React's streaming (`renderToPipeableStream`, which is how Next.js's
 * app router and Yahoo's article pages are sent) writes what is ready first and the rest
 * as it arrives: a placeholder in the page where an article will go, and the article
 * itself near the end, inside `<div hidden id="S:1">`. A one-line script then moves it
 * into place: `$RC("B:1","S:1")`. A clip runs no scripts, and Readability ignores what is
 * hidden, so on such a page the article was simply not there, and a clip kept whatever
 * had been sent first: a byline, a date and "2 min read" (2026-11-09).
 *
 * The calls are read in `withoutScriptsAndStyles`, which takes the scripts out, and left
 * in their place as the empty template React itself writes for the same instruction on a
 * page that allows no inline script (`data-rci` for a boundary, `data-rri` for one with
 * styles, `data-rsi` for a segment). So this reads one form, and a page sent in that form
 * already is read the same way.
 *
 * Paired by the ids the instructions name, never by showing every hidden element: a page
 * hides a great deal on purpose (a menu, a dialog, another edition's text), and a clip of
 * all of it would be worse than the byline. And never by matching numbers between the two
 * kinds of id: a boundary's and a segment's are counted separately, so `B:1` and `S:1` are
 * a pair only when an instruction says so.
 *
 * What React does, step for step, from its inline runtime (`completeBoundary` and
 * `completeSegment` in react-dom's `ReactDOMFizzInstructionSetInlineSource`): a boundary's
 * template sits just after the comment that opens it (`<!--$?-->`); everything from there
 * to the comment that closes it (`<!--/$-->`, counting nested ones) is the fallback, a
 * spinner or a skeleton, and is removed; the hidden element's children go where it was. A
 * segment's children replace its placeholder. Instructions run in the order they came,
 * because a segment can fill a placeholder inside a boundary's content before that
 * boundary is completed. An instruction whose ids are not both in the page does nothing,
 * which is also what a page sent by the bookmarklet meets: its tab already ran them.
 */

interface StreamedNode {
  nodeType: number;
  data?: string;
  parentNode: StreamedNode | null;
  previousSibling: StreamedNode | null;
  nextSibling: StreamedNode | null;
  firstChild: StreamedNode | null;
  insertBefore(node: StreamedNode, before: StreamedNode | null): void;
  removeChild(node: StreamedNode): void;
  getAttribute?(name: string): string | null;
}

interface StreamedDocument {
  getElementById(id: string): StreamedNode | null;
  querySelectorAll(selector: string): Iterable<StreamedNode>;
}

const COMMENT = 8;

export function placeStreamed(document: StreamedDocument): void {
  for (const instruction of [...document.querySelectorAll('template[data-rci], template[data-rri], template[data-rsi]')]) {
    const get = (name: string) => instruction.getAttribute?.(name) ?? null;
    if (get('data-rsi') !== null) {
      completeSegment(document, get('data-sid'), get('data-pid'));
    } else {
      completeBoundary(document, get('data-bid'), get('data-sid'));
    }
    instruction.parentNode?.removeChild(instruction);
  }
}

function completeBoundary(document: StreamedDocument, boundaryId: string | null, contentId: string | null): void {
  const boundary = boundaryId ? document.getElementById(boundaryId) : null;
  const content = contentId ? document.getElementById(contentId) : null;
  const start = boundary?.previousSibling;
  const parent = start?.parentNode;
  if (!content || !start || !parent || start.nodeType !== COMMENT) return;

  content.parentNode?.removeChild(content);
  let node = start.nextSibling;
  let depth = 0;
  while (node) {
    if (node.nodeType === COMMENT) {
      const mark = node.data;
      if (mark === '/$') {
        if (depth === 0) break;
        depth -= 1;
      } else if (mark === '$' || mark === '$?' || mark === '$!') {
        depth += 1;
      }
    }
    const next = node.nextSibling;
    parent.removeChild(node);
    node = next;
  }
  while (content.firstChild) parent.insertBefore(content.firstChild, node);
  start.data = '$';
}

function completeSegment(document: StreamedDocument, contentId: string | null, placeholderId: string | null): void {
  const content = contentId ? document.getElementById(contentId) : null;
  const placeholder = placeholderId ? document.getElementById(placeholderId) : null;
  const parent = placeholder?.parentNode;
  if (!content || !placeholder || !parent) return;

  content.parentNode?.removeChild(content);
  while (content.firstChild) parent.insertBefore(content.firstChild, placeholder);
  parent.removeChild(placeholder);
}

/** React's streaming instructions in a script's text: `$RC("B:1","S:1")` and the like. */
const INSTRUCTION = /\$R([CRS])\(\s*"([^"\\]{1,64})"\s*,\s*"([^"\\]{1,64})"/g;

/**
 * The streaming instructions in a script, as the templates `placeStreamed` reads, or ''
 * when it has none. Ids are kept to what React writes (a prefix, a letter, a colon and a
 * number), so nothing from a script is written into the page as markup.
 */
export function streamedInstructions(script: string): string {
  if (!script.includes('$R')) return '';
  let out = '';
  for (const [, kind, first, second] of script.matchAll(INSTRUCTION)) {
    if (!SAFE_ID.test(first!) || !SAFE_ID.test(second!)) continue;
    out +=
      kind === 'S'
        ? `<template data-rsi="" data-sid="${first}" data-pid="${second}"></template>`
        : `<template data-r${kind === 'C' ? 'c' : 'r'}i="" data-bid="${first}" data-sid="${second}"></template>`;
  }
  return out;
}

const SAFE_ID = /^[\w-]*[A-Z]:[0-9a-z]+$/i;
