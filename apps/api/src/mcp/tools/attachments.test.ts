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
  );
  return tools;
}

/** The one thing the upload-link tool asks of the attachments repo: whose note this is. */
function fakeAttachments() {
  return { repo: { ownsNote: async (id: string) => id === noteId } };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A note with a small picture, a big one and a PDF on it, and a record of what an assistant wrote. */
function pictured() {
  const rows: Record<string, { id: string; filename: string; content_type: string; size: number; r2_key: string }> = {
    'card.png': { id: 'a1', filename: 'card.png', content_type: 'image/png', size: png.length, r2_key: 'k/card' },
    'poster.jpg': { id: 'a2', filename: 'poster.jpg', content_type: 'image/jpeg', size: 9 * 1024 * 1024, r2_key: 'k/poster' },
    'scan.pdf': { id: 'a3', filename: 'scan.pdf', content_type: 'application/pdf', size: 10, r2_key: 'k/scan' },
    'fresh.pdf': { id: 'a4', filename: 'fresh.pdf', content_type: 'application/pdf', size: 10, r2_key: 'k/fresh' },
  };
  const written: Array<{ filename: string; text: string }> = [];
  const refuse: Record<string, 'unread' | 'layer' | 'vision'> = { 'scan.pdf': 'layer', 'poster.jpg': 'vision', 'fresh.pdf': 'unread' };
  return {
    written,
    repo: {
      resolve: async (id: string, filename: string) => (id === noteId ? (rows[filename] ?? null) : null),
      writeAssistantText: async (id: string, filename: string, text: string) => {
        if (id !== noteId || !rows[filename]) return { ok: false, reason: 'missing' };
        if (refuse[filename]) return { ok: false, reason: refuse[filename] };
        written.push({ filename, text });
        return { ok: true, reason: null };
      },
    },
    blobs: { get: async (key: string) => (key === 'k/card' ? { arrayBuffer: async () => png.buffer as ArrayBuffer } : null) },
  };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe('get_attachment', () => {
  it('hands a picture over as an image, with what to do next', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs }, repo).get('get_attachment')!;
    const result = await get({ noteId, filename: 'card.png' });
    expect(result.isError).toBeFalsy();
    const [image, text] = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    expect(image).toEqual({ type: 'image', data: btoa(String.fromCharCode(...png)), mimeType: 'image/png' });
    expect(JSON.parse(text!.text!)).toMatchObject({ filename: 'card.png', contentType: 'image/png', size: png.length });
    expect(text!.text).toContain('set_attachment_text');
  });

  it('refuses a PDF, a picture past the cap, and a file that is not there', async () => {
    const { repo, blobs } = pictured();
    const get = collect({ BLOBS: blobs }, repo).get('get_attachment')!;
    const pdf = await get({ noteId, filename: 'scan.pdf' });
    expect(pdf.isError).toBe(true);
    expect(pdf.content[0]!.text).toMatch(/text layer/);
    const big = await get({ noteId, filename: 'poster.jpg' });
    expect(big.isError).toBe(true);
    expect(big.content[0]!.text).toMatch(/9\.0 MB, over the 3\.7 MB/);
    expect((await get({ noteId, filename: 'ghost.png' })).isError).toBe(true);
    expect((await get({ noteId: otherNote, filename: 'card.png' })).isError).toBe(true);
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
