import type { EditorView } from '@codemirror/view';
import { insertUploads } from './attach.js';
import { showDropAt } from './drop-cursor.js';

/**
 * Where a file let go on the note, but not on its text, goes: the point of the text
 * nearest the pointer.
 *
 * - **Above the text** — the title, the properties, the formatting bar — at the top.
 * - **Below it,** at the end. On a new note that is the whole empty page.
 * - **Level with a line,** in a margin or over something drawn across it, at that line's
 *   start or end, whichever side of the text the pointer is on. The line is the
 *   document's, not the wrapped row the pointer is level with: a file put beside a
 *   paragraph goes before or after it, not into it.
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
  const line = view.lineBlockAtHeight(y - view.documentTop);
  return x < box.left ? line.from : line.to;
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
  const files = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

  const over = (event: DragEvent) => {
    if (event.defaultPrevented || !files(event)) return;
    // Claims the drag; without it the browser opens the file when it is let go.
    event.preventDefault();
    if (view.state.readOnly) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      showDropAt(view, null);
      return;
    }
    showDropAt(view, landingFor(view, event.clientX, event.clientY));
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
    if (event.defaultPrevented || !files(event)) return;
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
