import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { insertUploads } from './attach.js';
import { carriesFiles, refuseFile, showDropAt } from './drop-cursor.js';

/**
 * Where a file let go on the note, but not on its text, goes: the point of the text
 * nearest the pointer.
 *
 * - **Above the text** — the title, the properties, the attachments, the formatting bar —
 *   at the top. The attachments row on purpose, though a file let go there reads as
 *   "attach this": a note's files live in its text, so attaching one is putting it there,
 *   and the top is the text nearest the row. Sending it to the end instead would be the
 *   one place on the note where the drop point jumped away from the pointer.
 * - **Below it,** at the end. On a new note that is the whole empty page.
 * - **Level with a line,** in a margin or over something drawn across it, before or after
 *   the block that line belongs to, whichever side of the text the pointer is on.
 *
 * The block, not the line. Rich mode draws a fenced code block and a table line by line,
 * so the line beside the pointer can be a row of either, and a file set apart there by
 * blank lines (`ownParagraph`) went inside the fence as literal text, or cut the table in
 * two and left the rows under it without a header. A list and a quote split the same way.
 * The top-level block of the markdown — a paragraph, a list, a quote, a fence, a table —
 * is the unit a file put beside the text can go before or after without breaking it.
 *
 * By position alone, deliberately. Sending everything that comes before the body in the
 * page to the top was tried, so that the title and the bar, which stick while the body
 * scrolls beneath them, would not aim at the line hidden behind them — but on a phone the
 * bar is docked to the bottom of the screen and comes before the body all the same, and a
 * file let go on it went to the top of the note. A note scrolled down under a sticky title
 * now takes the file at the line behind it, which is at least the line the pointer was on.
 */
function landingFor(view: EditorView, x: number, y: number): number {
  const box = view.contentDOM.getBoundingClientRect();
  if (y < box.top) return 0;
  if (y >= box.bottom) return view.state.doc.length;
  const block = blockAround(view, view.lineBlockAtHeight(y - view.documentTop));
  return x < box.left ? block.from : block.to;
}

/**
 * The lines of the top-level markdown block around `line`, or `line` itself where it holds
 * none: a blank line between two blocks, where a file already splits nothing.
 */
function blockAround(view: EditorView, line: { from: number; to: number }): { from: number; to: number } {
  let node = syntaxTree(view.state).resolveInner(line.from, 1);
  // Up to the child of the document; the document itself, with no parent, is a blank line.
  while (node.parent?.parent) node = node.parent;
  if (!node.parent) return line;
  const { doc } = view.state;
  return {
    from: Math.min(line.from, doc.lineAt(node.from).from),
    to: Math.max(line.to, doc.lineAt(node.to).to),
  };
}

/**
 * Makes the whole note take a dragged file, not only the lines it already has.
 *
 * The editor is as tall as its text, so the drop target was the text alone — on a new
 * note, the one line of its placeholder — and a file let go anywhere else on the note,
 * the empty page under it included, was not taken: the browser opened it in place of the
 * app. `zone` is the element around the editor, the note's column; a file over any part of
 * it the editor did not claim goes to the point `landingFor` picks, as a paragraph of its
 * own (`ownParagraph`), since it was not aimed into the middle of anything. The editor's
 * drop point draws that place during the drag, as it does over the text, so what is shown
 * is where the drop goes.
 *
 * The editor's own handlers run first — its content is inside the zone — and a drag they
 * claimed arrives here with its default prevented, so a drop on the text still lands
 * exactly where it was let go. A note that takes no changes refuses the file with the
 * pointer, as the editor does.
 *
 * Plain DOM listeners rather than React's, so the rules live beside the editor's own and
 * are tested the same way. Returns the cleanup.
 */
export function noteDropZone(zone: HTMLElement, view: EditorView): () => void {
  /*
     Whether this drag is the note's to take. Not over a sheet open on top of the note —
     History is one — which is a child of the column in the page, so its events bubble
     through here, but is drawn above the note in the top layer, with the note behind it
     inert. A file let go on it is left to the window's guard (`refuseStrayFileDrops`).
  */
  const ours = (event: DragEvent) =>
    !event.defaultPrevented &&
    carriesFiles(event) &&
    !(event.target instanceof Element && event.target.closest('dialog'));

  const over = (event: DragEvent) => {
    if (!ours(event)) return;
    // Claims the drag; without it the browser opens the file when it is let go.
    event.preventDefault();
    if (view.state.readOnly) refuseFile(view, event);
    else showDropAt(view, landingFor(view, event.clientX, event.clientY));
  };

  const leave = (event: DragEvent) => {
    // Fires for every element the pointer crosses inside the zone, the editor's own
    // included; only a departure from the note clears the point. The next dragover over
    // the text or the zone draws it again wherever it now belongs.
    const to = event.relatedTarget;
    if (to instanceof Node && zone.contains(to)) return;
    showDropAt(view, null);
  };

  const drop = (event: DragEvent) => {
    if (!ours(event)) return;
    event.preventDefault();
    showDropAt(view, null);
    if (view.state.readOnly) return;
    const at = landingFor(view, event.clientX, event.clientY);
    void insertUploads(view, [...(event.dataTransfer?.files ?? [])], at, { ownParagraph: true });
  };

  zone.addEventListener('dragover', over);
  zone.addEventListener('dragleave', leave);
  zone.addEventListener('drop', drop);
  // Nothing to clear on the way out: the zone comes off when the view goes or the view
  // mode changes, neither of which can happen in the middle of a drag.
  return () => {
    zone.removeEventListener('dragover', over);
    zone.removeEventListener('dragleave', leave);
    zone.removeEventListener('drop', drop);
  };
}
