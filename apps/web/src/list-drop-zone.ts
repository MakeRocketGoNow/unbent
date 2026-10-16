import { carriesFiles } from './editor/drop-cursor.js';

/**
 * Makes the note list take dragged files: one note per file, filed where the list is
 * scoped (`file-notes.ts`).
 *
 * The list is the other drop target beside the note, and the two disambiguate by where
 * the file is let go rather than by a mode or a sheet: on the open note it attaches
 * there (`noteDropZone`), on the list it is a note of its own. The window's guard
 * (`file-drop-guard.ts`) refuses everything else, the trash's list included, which has
 * no zone on purpose: a file dropped on the trash would be a note made and deleted in
 * one gesture.
 *
 * What the drag will do is said during it, in a sentence over the list rather than a
 * pointer alone: "Drop to add 12 notes to Receipts". The count comes from the drag's
 * items, which a browser exposes during dragover when the files themselves are withheld
 * until the drop; a browser that hides the count too gets the sentence without one.
 *
 * `accept` is asked on every dragover and answers the sentence, or null to refuse (the
 * plan has ended), in which case the pointer says no and the drop does nothing. A batch
 * still landing is not a reason: a second drop waits its turn (`file-notes.ts`). Plain
 * DOM listeners rather than React's, so this is tested beside the note's zone the same
 * way. Returns the cleanup.
 */
export interface ListDropTarget {
  /** The sentence to show for `count` files, or null to refuse the drag. */
  accept(count: number): string | null;
  /** The sentence while a drag is over the list, null when it leaves or ends. */
  onHover(sentence: string | null): void;
  onFiles(files: File[]): void;
}

export function listDropZone(zone: HTMLElement, target: ListDropTarget): () => void {
  // Not a drag something inside the list already claimed, and not one over a sheet drawn
  // above it in the top layer: the move and tags sheets are children of the column.
  const ours = (event: DragEvent) =>
    !event.defaultPrevented && carriesFiles(event) && !(event.target instanceof Element && event.target.closest('dialog'));

  const over = (event: DragEvent) => {
    if (!ours(event)) return;
    // Claims the drag; without it the browser opens the file when it is let go.
    event.preventDefault();
    const sentence = target.accept(fileCount(event));
    if (event.dataTransfer) event.dataTransfer.dropEffect = sentence ? 'copy' : 'none';
    target.onHover(sentence);
  };

  const leave = (event: DragEvent) => {
    // Fires for every element the pointer crosses inside the list; only leaving the list
    // clears the sentence. The next dragover draws it again.
    const to = event.relatedTarget;
    if (to instanceof Node && zone.contains(to)) return;
    target.onHover(null);
  };

  const drop = (event: DragEvent) => {
    if (!ours(event)) return;
    event.preventDefault();
    target.onHover(null);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0 || !target.accept(files.length)) return;
    target.onFiles(files);
  };

  zone.addEventListener('dragover', over);
  zone.addEventListener('dragleave', leave);
  zone.addEventListener('drop', drop);
  return () => {
    zone.removeEventListener('dragover', over);
    zone.removeEventListener('dragleave', leave);
    zone.removeEventListener('drop', drop);
  };
}

/** How many files the drag carries, as far as the browser says during it; 0 when it does not. */
function fileCount(event: DragEvent): number {
  const items = event.dataTransfer?.items;
  if (!items) return 0;
  let n = 0;
  for (let i = 0; i < items.length; i++) if (items[i]?.kind === 'file') n++;
  return n;
}

/**
 * "Drop to add 12 notes to Receipts"; "Drop to add a note" for one file with nowhere to
 * file it; "Drop to add notes to Receipts" when the browser withholds the count.
 */
export function dropSentence(count: number, place: string | null): string {
  const what = count === 0 ? 'notes' : count === 1 ? 'a note' : `${count} notes`;
  return `Drop to add ${what}${place ? ` to ${place}` : ''}`;
}
