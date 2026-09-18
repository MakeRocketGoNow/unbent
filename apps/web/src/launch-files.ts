import { formatAttachmentMarkdown } from '@unbent/shared';
import type { QueryClient } from '@tanstack/react-query';
import { createNote, updateNote, uploadFile } from './notes-api.js';
import { indexUploadedFile } from './index-files.js';
import { invalidateNoteMembership } from './queries.js';

/**
 * Files handed to the installed app by the operating system.
 *
 * The manifest lists this app as a handler for PDFs and images. Where the browser
 * honours that — desktop Chrome and Edge, once the app is installed — opening such a file
 * with the app, dropping it on the Dock icon, or a scanner's "send to application" step
 * launches the app with the files queued on `window.launchQueue`. This is the consumer.
 * Each launch becomes one note, named after the first file, with every file attached and
 * linked from the body, the way the editor links a dropped file.
 *
 * A browser tab has no launch queue, and nothing here runs then. Whether the operating
 * system actually reaches this is the experiment: the manifest and this consumer are the
 * whole of it, and there is deliberately no sheet to name or file the note first. A scan
 * lands unfiled and gets sorted later.
 */

/** The queue Chromium exposes; not in the DOM lib yet. */
interface LaunchParams {
  files: readonly FileSystemFileHandle[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void;
}
declare global {
  interface Window {
    launchQueue?: LaunchQueue;
  }
}

/** Where to go once a note exists; the router is not built when this module loads. */
export type OpenNote = (noteId: string) => void;

export function installLaunchFiles(queryClient: QueryClient, openNote: OpenNote): void {
  const queue = window.launchQueue;
  if (!queue) return;
  queue.setConsumer(async (params) => {
    if (params.files.length === 0) return;
    try {
      const files = await Promise.all(params.files.map((handle) => handle.getFile()));
      const noteId = await noteFromFiles(files);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      invalidateNoteMembership(queryClient);
      openNote(noteId);
    } catch (err) {
      console.error('launch-files', err);
    }
  });
}

/** Creates the note, uploads in order, and writes the links once every upload has landed. */
export async function noteFromFiles(files: File[]): Promise<string> {
  const first = files[0];
  if (!first) throw new Error('No files');
  const created = await createNote({ title: titleFor(first.name), body: '' });
  const links: string[] = [];
  for (const file of files) {
    const uploaded = await uploadFile(created.id, file);
    if (uploaded.indexing !== 'server') indexUploadedFile(created.id, uploaded, file);
    links.push(
      formatAttachmentMarkdown(file.name, uploaded.path, { image: file.type.startsWith('image/') }),
    );
  }
  await updateNote(created.id, { body: links.join('\n\n') + '\n' });
  return created.id;
}

/** `2026-09-18 Water bill.pdf` becomes `2026-09-18 Water bill`. */
export function titleFor(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim();
}
