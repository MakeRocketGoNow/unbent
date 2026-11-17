import { describe, expect, it } from 'vitest';
import { appLinks } from '../../lib/app-links.js';
import { registerAttachmentTools } from './attachments.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import type { UploadGrantsRepo } from '../../lib/upload-grants.js';

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

/** The bytes in the fake bucket, by key. */
const stored: Record<string, Uint8Array> = {
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
  };
  const written: Array<{ filename: string; text: string }> = [];
  /** The options each `resolve` was asked with. */
  const resolved: unknown[] = [];
  const refuse: Record<string, 'unread' | 'layer' | 'vision'> = { 'scan.pdf': 'layer', 'poster.jpg': 'vision', 'fresh.pdf': 'unread' };
  return {
    written,
    resolved,
    repo: {
      resolve: async (id: string, filename: string, opts?: unknown) => {
        resolved.push(opts);
        return id === noteId ? (rows[filename] ?? null) : null;
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
    // The name came from an assistant, so the store may match it loosely (MAK-254).
    expect(resolved).toEqual([{ loose: true }]);
  });

  it('refuses a PDF, a picture past the cap, and a file that is not there', async () => {
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
