import { type AttachmentInfo, attachmentUrl, formatAttachmentMarkdown } from '@unbent/shared';
import { request } from './notes-api.js';
import { VIEW_HEADER } from './sw/routes.js';

/**
 * Puts one attachment on the system clipboard, as a link and, for a picture, as a picture.
 *
 * A page can write only a few types to the clipboard: plain text, HTML, and PNG. Not a
 * PDF, in any browser. So what goes across for every kind of file is a link that names
 * the note: `[Sample receipt.pdf](<origin>/api/notes/<id>/files/…)`. Pasted into another
 * Unbent note, the editor recognises it and copies the file across on the server (see
 * editor/clipboard.ts); pasted anywhere else it is a link that opens for the owner.
 *
 * An image goes as PNG too, so a paste into a chat or a document shows the picture. The
 * editor still prefers the link when both arrive: a link is copied key to key with no
 * bytes through the browser and keeps the original file, where the PNG would be a
 * re-encoded upload. A JPEG is converted through a canvas for the PNG slot only: that
 * copy is for other apps, and the original is what the link reaches.
 *
 * The blobs are handed over as promises created inside the click. Safari refuses a
 * clipboard write that starts after the gesture has ended, and a fetch of the picture
 * takes long enough to end it; a promise made synchronously keeps the write inside.
 * Browsers that cannot take a promise, or an image the fetch could not turn into a PNG,
 * fall back to the text alone: the link is the part that matters inside the app.
 */
export type CopiedAs = 'image' | 'link';

export async function copyAttachmentToClipboard(
  noteId: string,
  file: AttachmentInfo,
  opts: { origin: string },
): Promise<CopiedAs> {
  const image = file.contentType.startsWith('image/');
  const url = attachmentUrl(noteId, file.filename, opts.origin);
  const markdown = formatAttachmentMarkdown(file.filename, url, { image });
  const html = image
    ? `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(file.filename)}">`
    : `<a href="${escapeAttribute(url)}">${escapeText(file.filename)}</a>`;

  const clipboard = navigator.clipboard;
  const Item = globalThis.ClipboardItem;
  if (clipboard?.write && Item) {
    const parts: Record<string, Blob | Promise<Blob>> = {
      'text/plain': new Blob([markdown], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    };
    // Started now, inside the gesture; see above.
    if (image) parts['image/png'] = fetchAsPng(url);
    try {
      await clipboard.write([new Item(parts)]);
      return image ? 'image' : 'link';
    } catch {
      // Fall through to the text-only write: the link is the part that matters.
    }
  }

  await clipboard.writeText(markdown);
  return 'link';
}

/**
 * The picture as PNG, converting through a canvas when it is stored as something else.
 *
 * Marked as a view (`VIEW_HEADER`): the copy is of a picture on screen, so the service
 * worker answers from the copy it kept and an image can be copied with no connection.
 */
async function fetchAsPng(url: string): Promise<Blob> {
  const res = await request(url, { headers: { [VIEW_HEADER]: '1' } });
  if (!res.ok) throw new Error(`${res.status}`);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('Could not encode PNG'))), 'image/png');
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
