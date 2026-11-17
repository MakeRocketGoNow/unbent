import { describe, expect, it } from 'vitest';
import { appLinks } from '../../lib/app-links.js';
import { registerAttachmentTools } from './attachments.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import type { UploadGrantsRepo } from '../../lib/upload-grants.js';
import { fakeJpeg, page, pageTree, pdfOf, type TestObject } from '../../lib/test-pdf.js';
import { withReaderSlot } from '../../lib/reader-gate.js';

/**
 * The upload link, minted on the instance's own address for the caller's note only, with
 * the type left to the extension when none is given; and the pair that lets an assistant
 * read a picture itself since MAK-179 confined the instance's model to an Auto-fill press:
 * the bytes out as an image, and what the assistant read back in, marked as its own.
 */

interface Registered {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  }>;
}

const noteId = '11111111-1111-4111-8111-111111111111';
const otherNote = '22222222-2222-4222-8222-222222222222';

/** Collects the tools instead of serving them, so a handler can be called directly. */
function collect(
  env: Record<string, unknown>,
  attachments: unknown,
  uploads: unknown = {},
): Map<string, Registered['handler']> {
  const tools = new Map<string, Registered['handler']>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Registered['handler']) {
      tools.set(name, handler);
      return {} as never;
    },
  };
  registerAttachmentTools(
    server as never,
    env as never,
    { waitUntil() {} },
    {
      notes: {} as NotesRepo,
      attachments: attachments as AttachmentsRepo,
      uploads: uploads as UploadGrantsRepo,
    },
    appLinks('https://notes.example.com'),
    async () => null,
  );
  return tools;
}

/** The one thing the upload-link tool asks of the attachments repo: whose note this is. */
function fakeAttachments() {
  return { repo: { ownsNote: async (id: string) => id === noteId } };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's signature and IHDR, as far as the size: all the tool reads of an original. */
function pngHead(width: number, height: number): Uint8Array {
  const head = new Uint8Array(24);
  head.set([...png, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(head.buffer).setUint32(16, width);
  new DataView(head.buffer).setUint32(20, height);
  return head;
}

/** A JPEG page of a scan: its header, padded out to `bytes` when the test needs it heavy. */
function jpegPage(num: number, width: number, height: number, bytes = 0): TestObject {
  const head = fakeJpeg(width, height);
  const stream = new Uint8Array(Math.max(bytes, head.length));
  stream.set(head);
  return { num, body: `<< /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>`, stream };
}

/** Seven scanned pages, the second shown turned a quarter clockwise. */
const sevenPages = pdfOf([
  ...pageTree([3, 4, 5, 6, 7, 8, 9]),
  ...[3, 4, 5, 6, 7, 8, 9].map((n) => page(n, [n + 10], n === 4 ? { rotate: 90 } : {})),
  ...[13, 14, 15, 16, 17, 18, 19].map((n) => jpegPage(n, 1700, 2200)),
]);

/** A page as a fax image, which is not taken out, and a page of text. */
const faxed = pdfOf([
  ...pageTree([3, 4]),
  page(3, [10]),
  page(4, [], { font: true }),
  { num: 10, body: '<< /Subtype /Image /Width 1700 /Height 2200 /ImageMask true /Filter /CCITTFaxDecode >>', stream: new Uint8Array(8) },
]);

/** Three pages, each drawn in five strips, as some scanners store a page. */
const striped = pdfOf([
  ...pageTree([3, 4, 5]),
  ...[3, 4, 5].map((n) => page(n, [0, 1, 2, 3, 4].map((k) => 10 * n + k))),
  ...[3, 4, 5].flatMap((n) => [0, 1, 2, 3, 4].map((k) => jpegPage(10 * n + k, 1700, 440))),
]);

/** The bytes in the fake bucket, by key. */
const stored: Record<string, Uint8Array> = {
  'k/pages': sevenPages,
  'k/fax': faxed,
  'k/striped': striped,
  'k/locked': pdfOf([...pageTree([3]), page(3, [])], '<< /Root 1 0 R /Encrypt 9 0 R >>'),
  // Two pages whose pictures are 2 MB each as stored, so both do not fit one answer unshrunk.
  'k/heavy': pdfOf([...pageTree([3, 4]), page(3, [10]), page(4, [11]), jpegPage(10, 1200, 1500, 2_000_000), jpegPage(11, 1200, 1500, 2_000_000)]),
  'k/card': png,
  'k/poster': png,
  'k/shot': pngHead(1200, 800),
  'k/wide': pngHead(3000, 2000),
  // Stored as a JPEG, and none of the four types the model takes.
  'k/odd': new Uint8Array([0, 0, 0, 0x18]),
};

/** A note with a small picture, a big one and a PDF on it, and a record of what an assistant wrote. */
function pictured() {
  const rows: Record<string, { id: string; filename: string; content_type: string; size: number; r2_key: string }> = {
    'card.png': { id: 'a1', filename: 'card.png', content_type: 'image/png', size: png.length, r2_key: 'k/card' },
    'poster.jpg': { id: 'a2', filename: 'poster.jpg', content_type: 'image/jpeg', size: 9 * 1024 * 1024, r2_key: 'k/poster' },
    'shot.png': { id: 'a6', filename: 'shot.png', content_type: 'image/png', size: 2 * 1024 * 1024, r2_key: 'k/shot' },
    'snapshot.jpg': { id: 'a8', filename: 'snapshot.jpg', content_type: 'image/jpeg', size: 24, r2_key: 'k/shot' },
    'odd.jpg': { id: 'a9', filename: 'odd.jpg', content_type: 'image/jpeg', size: 4, r2_key: 'k/odd' },
    'wide.png': { id: 'a7', filename: 'wide.png', content_type: 'image/png', size: 2 * 1024 * 1024, r2_key: 'k/wide' },
    'mural.png': { id: 'a5', filename: 'mural.png', content_type: 'image/png', size: 24 * 1024 * 1024, r2_key: 'k/mural' },
    'scan.pdf': { id: 'a3', filename: 'scan.pdf', content_type: 'application/pdf', size: 10, r2_key: 'k/scan' },
    'fresh.pdf': { id: 'a4', filename: 'fresh.pdf', content_type: 'application/pdf', size: 10, r2_key: 'k/fresh' },
    'pages.pdf': { id: 'b1', filename: 'pages.pdf', content_type: 'application/pdf', size: sevenPages.length, r2_key: 'k/pages' },
    'fax.pdf': { id: 'b2', filename: 'fax.pdf', content_type: 'application/pdf', size: faxed.length, r2_key: 'k/fax' },
    'locked.pdf': { id: 'b3', filename: 'locked.pdf', content_type: 'application/pdf', size: 200, r2_key: 'k/locked' },
    'heavy.pdf': { id: 'b4', filename: 'heavy.pdf', content_type: 'application/pdf', size: 4_000_400, r2_key: 'k/heavy' },
    'striped.pdf': { id: 'b9', filename: 'striped.pdf', content_type: 'application/pdf', size: striped.length, r2_key: 'k/striped' },
    'book.pdf': { id: 'b5', filename: 'book.pdf', content_type: 'application/pdf', size: 40 * 1024 * 1024, r2_key: 'k/book' },
    // The fax scan again, past the size the model takes a PDF at, so no press reads it.
    'bigfax.pdf': { id: 'b6', filename: 'bigfax.pdf', content_type: 'application/pdf', size: 9 * 1024 * 1024, r2_key: 'k/fax' },
  };
  /** How each file's text came to be; anything unnamed is pending, and read by the layer. */
  const reads: Record<string, string> = { 'scan.pdf': 'text', 'seen.pdf': 'vision', 'layered.pdf': 'text' };
  /** The PDFs nothing has read yet. */
  const unread = new Set(['fresh.pdf']);
  rows['seen.pdf'] = { ...rows['pages.pdf']!, id: 'b7', filename: 'seen.pdf' };
  rows['fresh.pdf'] = { ...rows['pages.pdf']!, id: 'a4', filename: 'fresh.pdf' };
  // A typed cover sheet's layer in front of scanned pages.
  rows['layered.pdf'] = { ...rows['pages.pdf']!, id: 'b8', filename: 'layered.pdf' };
  const written: Array<{ filename: string; text: string }> = [];
  /** The arguments each lookup was made with. */
  const resolved: unknown[] = [];
  const refuse: Record<string, 'unread' | 'layer' | 'vision'> = { 'scan.pdf': 'layer', 'poster.jpg': 'vision', 'fresh.pdf': 'unread' };
  return {
    written,
    resolved,
    repo: {
      resolveWithRead: async (id: string, filename: string, vision: boolean) => {
        resolved.push({ filename, vision });
        const row = id === noteId ? rows[filename] : undefined;
        return row ? { ...row, read: reads[filename] ?? 'pending', unread: unread.has(filename) } : null;
      },
      writeAssistantText: async (id: string, filename: string, text: string) => {
        if (id !== noteId || !rows[filename]) return { ok: false, reason: 'missing', filename: null };
        if (refuse[filename]) return { ok: false, reason: refuse[filename], filename: null };
        written.push({ filename, text });
        return { ok: true, reason: null, filename };
      },
    },
    blobs: {
      get: async (key: string) => {
        const bytes = stored[key];
        return bytes ? { body: new Response(bytes).body!, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer } : null;
      },
    },
  };
}

/** The head of a JPEG 1176 by 1568: SOI, then a baseline frame header naming its size. */
const shrunk = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x20, 0x04, 0x98, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]);

/** Stands in for the Images binding: records the edge it was asked for, or fails as told. */
function fakeImages(fail: false | 'throw' | 'huge' = false) {
  const asked: unknown[] = [];
  return {
    asked,
    binding: {
      input() {
        const transformer = {
          transform(t: unknown) {
            asked.push(t);
            return transformer;
          },
          async output() {
            if (fail === 'throw') throw new Error('9422: free plan used up');
            // A JPEG over the cap, which no real picture at these edges comes near.
            const out = fail === 'huge' ? new Uint8Array(4 * 1024 * 1024) : shrunk;
            return { image: () => new Response(out).body! };
          },
        };
        return transformer;
      },
    },
  };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe('get_attachment', () => {
  it('hands a picture over as an image, with what to do next', async () => {
    const { repo, blobs, resolved } = pictured();
    const get = collect({ BLOBS: blobs }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'card.png' });
    expect(result.isError).toBeFalsy();
    const [image, text] = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    expect(image).toEqual({ type: 'image', data: btoa(String.fromCharCode(...png)), mimeType: 'image/png' });
    expect(JSON.parse(text!.text!)).toMatchObject({ filename: 'card.png', contentType: 'image/png', size: png.length });
    expect(text!.text).toContain('set_attachment_text');
    // One lookup, which matches the name loosely (MAK-254) and says how the text came to be.
    expect(resolved).toEqual([{ filename: 'card.png', vision: false }]);
  });

  it('refuses a PDF with a text layer, a picture past the cap, and a file that is not there', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs }, repo).get('get_attachment')!;
    const pdf = await get({ noteId, filename: 'scan.pdf' });
    expect(pdf.isError).toBe(true);
    expect(pdf.content[0]!.text).toMatch(/text layer/);
    // Without the Images binding a big picture cannot be shrunk, and the refusal says why
    // and what would get it read: a 9 MB one is past Auto-fill's reach too.
    const big = await get({ noteId, filename: 'poster.jpg' });
    expect(big.isError).toBe(true);
    expect(big.content[0]!.text).toMatch(/9\.0 MB, over the 3\.7 MB/);
    expect(big.content[0]!.text).toMatch(/no Images binding/);
    expect(big.content[0]!.text).toMatch(/smaller copy/);
    expect((await get({ noteId, filename: 'ghost.png' })).isError).toBe(true);
    expect((await get({ noteId: otherNote, filename: 'card.png' })).isError).toBe(true);
  });
});

describe('get_attachment on a scanned PDF', () => {
  type Block = { type: string; text?: string; data?: string; mimeType?: string };
  const blocks = (result: { content: unknown[] }) => result.content as Block[];
  const answer = (result: { content: unknown[] }) => JSON.parse(blocks(result).at(-1)!.text!) as Record<string, unknown>;

  it('hands over the first five pages, each after a line naming it, and says what to ask for next', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'pages.pdf' });
    expect(result.isError).toBeFalsy();
    const content = blocks(result);
    expect(content.slice(0, 4)).toEqual([
      { type: 'text', text: 'Page 1 of 7' },
      { type: 'image', data: btoa(String.fromCharCode(...fakeJpeg(1700, 2200))), mimeType: 'image/jpeg' },
      { type: 'text', text: 'Page 2 of 7 (shown turned 90° clockwise)' },
      expect.objectContaining({ type: 'image' }),
    ]);
    expect(content.filter((b) => b.type === 'image')).toHaveLength(5);
    const said = answer(result);
    expect(said).toMatchObject({ filename: 'pages.pdf', contentType: 'application/pdf', pages: 7, notSent: [] });
    expect(said.sent).toHaveLength(5);
    expect((said.sent as unknown[])[1]).toEqual({ page: 2, turned: 90, contentType: 'image/jpeg', width: 1700, height: 2200, bytes: 23, downscaled: false });
    expect(said.next).toMatch(/ask for pages "6-7" next/);
    expect(said.next).toMatch(/turned/);
  });

  it('sends the pages asked for, and says when the last has gone', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'pages.pdf', pages: '6-9' });
    expect((answer(result).sent as Array<{ page: number }>).map((s) => s.page)).toEqual([6, 7]);
    expect(answer(result).next).toMatch(/^That was the last page\. Record what you read with set_attachment_text/);
    const one = await get({ noteId, filename: 'pages.pdf', pages: '3' });
    expect((answer(one).sent as Array<{ page: number }>).map((s) => s.page)).toEqual([3]);
    expect((await get({ noteId, filename: 'pages.pdf', pages: '8' })).content[0]!.text).toMatch(/has 7 pages/);
    expect((await get({ noteId, filename: 'pages.pdf', pages: '4-2' })).isError).toBe(true);
  });

  it('shrinks a page larger than the edge where the instance binds Images', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const get = collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'pages.pdf', pages: '1' });
    expect(blocks(result)[1]).toEqual({ type: 'image', data: btoa(String.fromCharCode(...shrunk)), mimeType: 'image/jpeg' });
    expect((answer(result).sent as unknown[])[0]).toMatchObject({ page: 1, width: 1176, height: 1568, maxEdge: 1568, downscaled: true });
    expect(answer(result).next).toMatch(/maxEdge 2576/);
    expect(images.asked).toEqual([{ width: 1568, height: 1568, fit: 'scale-down' }]);
  });

  it('stops at a page boundary when the next page would make the answer too large', async () => {
    const { repo, blobs } = pictured();
    const result = await collect({ BLOBS: blobs }, repo).get('get_attachment')!({ noteId, filename: 'heavy.pdf' });
    expect((answer(result).sent as Array<{ page: number }>).map((s) => s.page)).toEqual([1]);
    expect(answer(result).next).toMatch(/^Page 2 was not sent; ask for page "2" next/);
  });

  it('stops before a page whose pictures would pass the cap on pictures a call', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const result = await collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!({ noteId, filename: 'striped.pdf' });
    // Two pages of five strips fit under twelve; the third is left for the next call, undecoded.
    expect((answer(result).sent as Array<{ page: number }>).map((s) => s.page)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    expect(blocks(result).filter((b) => b.type === 'text' && b.text!.startsWith('Page'))).toHaveLength(2);
    expect(images.asked).toHaveLength(10);
    expect(answer(result).next).toMatch(/^Page 3 was not sent; ask for page "3" next/);
  });

  it('says why a page was not sent, and refuses when nothing could be', async () => {
    const { repo, blobs } = pictured();
    const result = await collect({ BLOBS: blobs, ANTHROPIC_API_KEY: 'k' }, repo).get('get_attachment')!({ noteId, filename: 'fax.pdf' });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toMatch(/page 1: its picture could not be sent: encoded as CCITT fax/);
    expect(text).toMatch(/page 2: it is text, not a picture; get_attachment_text has the text layer/);
    expect(text).toMatch(/Auto-fill press/);
    // Without a model nothing else reads it, and nothing is promised; nor with one, for a
    // PDF past the size a press hands the model.
    const bare = await collect({ BLOBS: blobs }, repo).get('get_attachment')!({ noteId, filename: 'fax.pdf' });
    expect(bare.content[0]!.text).not.toMatch(/Auto-fill/);
    const big = await collect({ BLOBS: blobs, ANTHROPIC_API_KEY: 'k' }, repo).get('get_attachment')!({ noteId, filename: 'bigfax.pdf' });
    expect(big.content[0]!.text).toMatch(/encoded as CCITT fax/);
    expect(big.content[0]!.text).not.toMatch(/Auto-fill/);
  });

  it('refuses a scan the model has read, and says a scan nothing has read cannot be recorded yet', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs, ANTHROPIC_API_KEY: 'k' }, repo).get('get_attachment')!;
    const seen = await get({ noteId, filename: 'seen.pdf' });
    expect(seen.isError).toBe(true);
    expect(seen.content[0]!.text).toMatch(/vision model has read this PDF, and get_attachment_text has its reading/);
    const fresh = await get({ noteId, filename: 'fresh.pdf' });
    expect(fresh.isError).toBeFalsy();
    expect(answer(fresh).next).toMatch(/^Pages 6 to 7 were not sent; ask for pages "6-7" next\. Its text layer has not been read yet, and set_attachment_text takes nothing/);
    expect(answer(fresh).next).not.toMatch(/read them all before recording/);
  });

  it('sends the pages asked for from a PDF with a text layer, with nothing to record', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs }, repo).get('get_attachment')!;
    // Asked for whole, it points at the text and at asking for the pages the layer leaves out.
    expect((await get({ noteId, filename: 'layered.pdf' })).content[0]!.text).toMatch(/ask for those with pages/);
    const asked = await get({ noteId, filename: 'layered.pdf', pages: '6-7' });
    expect(asked.isError).toBeFalsy();
    expect(answer(asked).next).toMatch(/^That was the last page\. Its text layer is in get_attachment_text, and set_attachment_text does not replace it/);
  });

  it('waits its turn at the read gate before fetching the file', async () => {
    const { repo, blobs } = pictured();
    const fetched: string[] = [];
    const watched = { get: async (key: string) => (fetched.push(key), blobs.get(key)) };
    const get = collect({ BLOBS: watched }, repo).get('get_attachment')!;
    // Two other reads hold the isolate's two slots, as an import's text-layer reads can.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holders = [withReaderSlot(() => held), withReaderSlot(() => held)];
    const pending = get({ noteId, filename: 'pages.pdf', pages: '1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetched).toEqual([]);
    release();
    await Promise.all(holders);
    expect((await pending).isError).toBeFalsy();
    expect(fetched).toEqual(['k/pages']);
  });

  it('refuses a PDF with a text layer before fetching it, and one that is encrypted or too large to open', async () => {
    const { repo, blobs } = pictured();
    const fetched: string[] = [];
    const watched = { get: async (key: string) => (fetched.push(key), blobs.get(key)) };
    const get = collect({ BLOBS: watched }, repo).get('get_attachment')!;
    expect((await get({ noteId, filename: 'scan.pdf' })).content[0]!.text).toMatch(/get_attachment_text has its text/);
    expect((await get({ noteId, filename: 'locked.pdf' })).content[0]!.text).toMatch(/encrypted/);
    expect((await get({ noteId, filename: 'book.pdf' })).content[0]!.text).toMatch(/40\.0 MB, over the 16\.0 MB/);
    expect(fetched).toEqual(['k/locked']);
  });
});

describe('get_attachment where the instance binds Images', () => {
  it('hands over a picture too large to send as it is, shrunk to the default edge, with the size it was sent at', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const get = collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'poster.jpg' });
    expect(result.isError).toBeFalsy();
    const [image, text] = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    expect(image).toEqual({ type: 'image', data: btoa(String.fromCharCode(...shrunk)), mimeType: 'image/jpeg' });
    const answer = JSON.parse(text!.text!) as Record<string, unknown>;
    // The original's name, type and size, so set_attachment_text is called on the file itself.
    expect(answer).toMatchObject({ filename: 'poster.jpg', contentType: 'image/jpeg', size: 9 * 1024 * 1024 });
    expect(answer.sent).toEqual({
      contentType: 'image/jpeg',
      width: 1176,
      height: 1568,
      bytes: shrunk.length,
      maxEdge: 1568,
      downscaled: true,
    });
    expect(answer.next).toMatch(/JPEG copy no larger than 1568 px/);
    expect(answer.next).toMatch(/maxEdge 2576/);
    expect(images.asked).toEqual([{ width: 1568, height: 1568, fit: 'scale-down' }]);
  });

  it('sends a picture already within the edge as it is, without asking the binding', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const get = collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'shot.png' });
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(JSON.parse(result.content[1]!.text)).toMatchObject({
      sent: { contentType: 'image/png', width: 1200, height: 800, downscaled: false },
    });
    expect(images.asked).toEqual([]);
  });

  it('refuses an original whose bytes are no picture the model takes, rather than mislabel it', async () => {
    const { repo, blobs } = pictured();
    // Without the binding the original is the only thing to send; with one that refuses
    // the file, the original is the fallback. Neither may go out labelled a JPEG.
    for (const env of [{ BLOBS: blobs }, { BLOBS: blobs, IMAGES: fakeImages('throw').binding }]) {
      const result = await collect(env, repo).get('get_attachment')!({ noteId, filename: 'odd.jpg' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/stored as image\/jpeg, but its bytes are not/);
    }
  });

  it('sends an original as the type its bytes are, not the type it was stored under', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const get = collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!;
    // A PNG stored as `image/jpeg`, as an imported snapshot can be.
    const result = await get({ noteId, filename: 'snapshot.jpg' });
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(JSON.parse(result.content[1]!.text)).toMatchObject({
      contentType: 'image/jpeg',
      sent: { contentType: 'image/png', downscaled: false },
    });
    expect(images.asked).toEqual([]);
  });

  it('shrinks a picture small enough to send but larger than the edge', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const get = collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'wide.png' });
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(images.asked).toEqual([{ width: 1568, height: 1568, fit: 'scale-down' }]);
  });

  it('shrinks to the edge the assistant asks for', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const get = collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'card.png', maxEdge: 2576 });
    expect((JSON.parse(result.content[1]!.text) as { next: string }).next).not.toMatch(/maxEdge/);
    expect(images.asked).toEqual([{ width: 2576, height: 2576, fit: 'scale-down' }]);
  });

  it('sends a small original when shrinking fails, and says so when a big one cannot be sent', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs, IMAGES: fakeImages('throw').binding }, repo).get('get_attachment')!;
    const small = await get({ noteId, filename: 'card.png' });
    expect(small.isError).toBeFalsy();
    expect(small.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(JSON.parse(small.content[1]!.text)).toMatchObject({ sent: { downscaled: false } });
    const big = await get({ noteId, filename: 'poster.jpg' });
    expect(big.isError).toBe(true);
    // No "try again later": a refusal from the binding is as likely to last the month.
    expect(big.content[0]!.text).toMatch(/Shrinking it failed on this instance\. /);
    expect(big.content[0]!.text).not.toMatch(/later/);
  });

  it('asks for a smaller edge when the JPEG it made is still over the cap', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs, IMAGES: fakeImages('huge').binding }, repo).get('get_attachment')!;
    const big = await get({ noteId, filename: 'poster.jpg', maxEdge: 2576 });
    expect(big.isError).toBe(true);
    expect(big.content[0]!.text).toMatch(/Shrunk to 2576 px it was still larger than that; ask again with a smaller maxEdge/);
  });

  it('refuses a picture past what the binding takes, without asking it', async () => {
    const { repo, blobs } = pictured();
    const images = fakeImages();
    const get = collect({ BLOBS: blobs, IMAGES: images.binding }, repo).get('get_attachment')!;
    const huge = await get({ noteId, filename: 'mural.png' });
    expect(huge.isError).toBe(true);
    expect(huge.content[0]!.text).toMatch(/24\.0 MB.*over the 19\.1 MB this instance can shrink/);
    expect(images.asked).toEqual([]);
  });
});

describe('set_attachment_text', () => {
  it('records what the assistant read, marked as its own, and says a press will replace it where a model exists', async () => {
    const { repo, written } = pictured();
    const set = collect({ ANTHROPIC_API_KEY: 'k' }, repo).get('set_attachment_text')!;
    const result = await set({ noteId, filename: 'card.png', text: '  Plumber card\nJane Doe, Acme Plumbing\n\n555-0100  ' });
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ filename: 'card.png', read: 'assistant' });
    expect(parse(result).note).toMatch(/Auto-fill/);
    expect(written).toEqual([{ filename: 'card.png', text: 'Plumber card\nJane Doe, Acme Plumbing\n\n555-0100' }]);

    // Without a model key nothing will ever replace the words, and the tool says so.
    const bare = await collect({}, pictured().repo).get('set_attachment_text')!({ noteId, filename: 'card.png', text: 'A card' });
    expect(parse(bare).note).toMatch(/no vision model/);
  });

  it("refuses to replace a text layer or the model's reading, and says why", async () => {
    const { repo, written } = pictured();
    const set = collect({}, repo).get('set_attachment_text')!;
    const layer = await set({ noteId, filename: 'scan.pdf', text: 'x' });
    expect(layer.isError).toBe(true);
    expect(layer.content[0]!.text).toMatch(/text layer/);
    const vision = await set({ noteId, filename: 'poster.jpg', text: 'x' });
    expect(vision.isError).toBe(true);
    expect(vision.content[0]!.text).toMatch(/vision model/);
    // A PDF the free reader has not reached yet keeps its turn.
    const unread = await set({ noteId, filename: 'fresh.pdf', text: 'x' });
    expect(unread.isError).toBe(true);
    expect(unread.content[0]!.text).toMatch(/not been read yet/);
    expect((await set({ noteId, filename: 'ghost.png', text: 'x' })).isError).toBe(true);
    expect((await set({ noteId, filename: 'card.png', text: '   ' })).isError).toBe(true);
    expect(written).toEqual([]);
  });

  it('answers with the name the file is stored under, not a loose one it was asked with', async () => {
    // The store matched a plain space to the narrow one macOS writes (MAK-254); the answer
    // is what an assistant copies into a link, so it must be the name that resolves.
    const stored = 'Shot 10.22\u202FAM.png';
    const repo = { writeAssistantText: async () => ({ ok: true, reason: null, filename: stored }) };
    const result = await collect({}, repo).get('set_attachment_text')!({ noteId, filename: 'Shot 10.22 AM.png', text: 'A screen' });
    expect(parse(result)).toMatchObject({ filename: stored, read: 'assistant' });
  });
});

describe('prepare_attachment_upload', () => {
  function fakeUploads() {
    const minted: unknown[] = [];
    return {
      minted,
      repo: {
        create: async (grant: unknown) => {
          minted.push(grant);
          return { token: 'tok123', expiresAt: Date.UTC(2026, 8, 29, 12, 30) };
        },
      },
    };
  }

  it('mints a link on the instance\'s own address for the caller\'s note', async () => {
    const { repo: attachments } = fakeAttachments();
    const { minted, repo } = fakeUploads();
    const prepare = collect({ APP_URL: 'https://notes.example.com' }, attachments, repo).get(
      'prepare_attachment_upload',
    )!;

    const result = await prepare({
      noteId,
      filename: 'Receipt (final).png',
      contentType: 'Image/PNG; charset=binary',
      link: false,
    });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({
      uploadUrl: 'https://notes.example.com/api/uploads/tok123',
      method: 'PUT',
      expiresAt: '2026-09-29T12:30:00.000Z',
    });
    expect(parse(result).example).toContain('curl -T');
    // Normalized as an upload's header would be, so the route stores exactly this.
    expect(minted).toEqual([{ noteId, filename: 'Receipt (final).png', contentType: 'image/png', link: false }]);
  });

  it('leaves the type to the extension when none is given', async () => {
    const { repo: attachments } = fakeAttachments();
    const { minted, repo } = fakeUploads();
    const prepare = collect({ APP_URL: 'https://notes.example.com' }, attachments, repo).get(
      'prepare_attachment_upload',
    )!;

    await prepare({ noteId, filename: 'scan.pdf', link: true });

    expect(minted).toEqual([{ noteId, filename: 'scan.pdf', contentType: null, link: true }]);
  });

  it('mints nothing for a note that is not the caller\'s', async () => {
    const { repo: attachments } = fakeAttachments();
    const { minted, repo } = fakeUploads();
    const prepare = collect({ APP_URL: 'https://notes.example.com' }, attachments, repo).get(
      'prepare_attachment_upload',
    )!;

    const result = await prepare({ noteId: otherNote, filename: 'scan.pdf', link: true });

    expect(result.isError).toBe(true);
    expect(minted).toEqual([]);
  });
});
