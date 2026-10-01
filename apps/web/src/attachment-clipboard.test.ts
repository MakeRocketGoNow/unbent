import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyAttachmentToClipboard } from './attachment-clipboard.js';

/**
 * What goes on the clipboard for a file: a link that names the note in every case, and a
 * PNG beside it for a picture. jsdom has no clipboard, so both APIs are stubbed and what
 * matters is what each is handed.
 */

const NOTE = 'note-1';
const ORIGIN = 'https://app.example';
const pdf = { filename: 'Sample receipt.pdf', contentType: 'application/pdf', size: 10 };
const png = { filename: 'photo.png', contentType: 'image/png', size: 10 };

class FakeItem {
  constructor(readonly parts: Record<string, Blob | Promise<Blob>>) {}
}

function stubClipboard(write: ((items: FakeItem[]) => Promise<void>) | undefined) {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    value: { write, writeText },
    configurable: true,
  });
  vi.stubGlobal('ClipboardItem', write ? FakeItem : undefined);
  return { writeText };
}

async function text(part: Blob | Promise<Blob> | undefined): Promise<string> {
  return (await part)!.text();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyAttachmentToClipboard', () => {
  it('writes a link that names the note, as text and as HTML', async () => {
    const written: FakeItem[] = [];
    stubClipboard(async (items) => void written.push(...items));

    expect(await copyAttachmentToClipboard(NOTE, pdf, { origin: ORIGIN })).toBe('link');
    const { parts } = written[0]!;
    expect(await text(parts['text/plain'])).toBe(
      `[Sample receipt.pdf](${ORIGIN}/api/notes/note-1/files/Sample%20receipt.pdf)`,
    );
    expect(await text(parts['text/html'])).toBe(
      `<a href="${ORIGIN}/api/notes/note-1/files/Sample%20receipt.pdf">Sample receipt.pdf</a>`,
    );
    expect(parts['image/png']).toBeUndefined();
  });

  it('adds the picture as PNG for an image, fetched from the note', async () => {
    const written: FakeItem[] = [];
    stubClipboard(async (items) => void written.push(...items));
    const bytes = new Blob(['png'], { type: 'image/png' });
    // Not a real Response: jsdom's Blob and Node's Response disagree about streams.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers(), blob: async () => bytes })));

    expect(await copyAttachmentToClipboard(NOTE, png, { origin: ORIGIN })).toBe('image');
    const { parts } = written[0]!;
    expect(await text(parts['text/plain'])).toBe(`![photo.png](${ORIGIN}/api/notes/note-1/files/photo.png)`);
    expect(await text(parts['text/html'])).toBe(
      `<img src="${ORIGIN}/api/notes/note-1/files/photo.png" alt="photo.png">`,
    );
    // Marked as a view, so the service worker answers from the copy it kept offline.
    expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/api/notes/note-1/files/photo.png`, {
      headers: { 'X-Unbent-View': '1' },
    });
    expect(await text(parts['image/png'])).toBe('png');
  });

  it('falls back to the text alone when the rich write is refused', async () => {
    const { writeText } = stubClipboard(async () => {
      throw new DOMException('no', 'NotAllowedError');
    });
    expect(await copyAttachmentToClipboard(NOTE, pdf, { origin: ORIGIN })).toBe('link');
    expect(writeText).toHaveBeenCalledWith(
      `[Sample receipt.pdf](${ORIGIN}/api/notes/note-1/files/Sample%20receipt.pdf)`,
    );
  });

  it('uses the text write where ClipboardItem does not exist', async () => {
    const { writeText } = stubClipboard(undefined);
    expect(await copyAttachmentToClipboard(NOTE, png, { origin: ORIGIN })).toBe('link');
    expect(writeText).toHaveBeenCalledOnce();
  });
});
