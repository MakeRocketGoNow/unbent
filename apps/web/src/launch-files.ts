import type { QueryClient } from '@tanstack/react-query';
import { notesFromFiles } from './file-notes.js';

/**
 * Files handed to the installed app by the operating system.
 *
 * The manifest lists this app as a handler for PDFs and images. Where the browser
 * honours that — desktop Chrome and Edge, once the app is installed — opening such a file
 * with the app, dropping it on the Dock icon, or a scanner's "send to application" step
 * launches the app with the files queued on `window.launchQueue`, which `launch-queue.ts`
 * reads and hands here. Each file becomes one note, named after it, with the file attached
 * and linked from the body (`file-notes.ts`) — the same thing a drop on the note list
 * does, so a launch and a drop agree. A launch used to make one note of every file; now
 * that the list drop makes one per file, a scanner sending three pages would otherwise
 * land as three notes one way and one note the other. The first note opens.
 *
 * Whether the operating system actually reaches this is the experiment: the manifest and
 * this handler are the whole of it, and there is deliberately no sheet to name or file the
 * note first. A scan lands unfiled and gets sorted later.
 */

/** Where to go once a note exists; the router is not built when this module loads. */
export type OpenNote = (noteId: string) => void;

/** The launch queue's handler for files: makes the notes, then opens the first. */
export function launchFiles(queryClient: QueryClient, openNote: OpenNote) {
  return async (files: File[]): Promise<void> => {
    const [first] = await notesFromFiles(files, { notebook: null, tags: [] }, null, queryClient);
    if (first) openNote(first);
  };
}

export { titleFor } from './file-notes.js';
