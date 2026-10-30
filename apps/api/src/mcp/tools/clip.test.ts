import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLinks } from '../../lib/app-links.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import { registerClipTool } from './clip.js';

/**
 * The tool's own part of a clip: fields by name before anything is fetched, the note
 * answered as every tool answers one, and a page this server cannot have answered with
 * the way round it. What the clip itself does is `lib/clip.test.ts`'s.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

const PAGE = 'https://example.com/guides/forge';
const ARTICLE =
  '<html><head><title>Lighting a forge</title></head><body><article><h1>Lighting a forge</h1>' +
  '<p>Start the fire small, with dry kindling under a loose bed of coke, and feed the air gently until the bed glows evenly.</p>'.repeat(6) +
  '</article></body></html>';

function tool(notes: Partial<Record<keyof NotesRepo, unknown>>): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, cb: Handler) {
      handler = cb;
      return {} as never;
    },
  };
  registerClipTool(
    server as never,
    { BLOBS: {}, WEB_CLIP: '1' } as never,
    { waitUntil() {} },
    { notes: notes as unknown as NotesRepo, attachments: {} as AttachmentsRepo },
    appLinks('https://notes.example.com'),
    async () => null,
  );
  return handler!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clip_web_page', () => {
  it('files the clip by notebook and field name, and answers with the note link and the pictures', async () => {
    vi.stubGlobal('fetch', async () => new Response(ARTICLE, { headers: { 'content-type': 'text/html' } }));
    const created: Array<Record<string, unknown>> = [];
    const clip = tool({
      notebookByName: async () => ({ id: 'nb', fields: [{ id: 'f-source', name: 'Source', type: 'text', notebookId: 'nb' }] }),
      createOrFind: async (input: Record<string, unknown>) => {
        created.push(input);
        return { note: { ...input, tags: [], createdAt: 0, updatedAt: 0, deletedAt: null }, existing: false };
      },
    });

    const result = await clip({ url: PAGE, notebook: 'Guides', tags: ['forge'], fields: { source: 'Acme' } });

    expect(result.isError).toBeFalsy();
    const answer = JSON.parse(result.content[0]!.text);
    expect(answer.url).toMatch(/^https:\/\/notes\.example\.com\//);
    expect(answer.title).toBe('Lighting a forge');
    expect(answer.images).toEqual({ stored: 0, failed: [] });
    expect(created[0]).toMatchObject({ notebook: 'Guides', tags: ['forge'], fields: { 'f-source': 'Acme' } });
  });

  it('refuses a field the notebook does not have before fetching the page', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const clip = tool({ notebookByName: async () => ({ id: 'nb', fields: [] }) });
    const result = await clip({ url: PAGE, notebook: 'Guides', fields: { Merchant: 'Acme' } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No field called "Merchant"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('tells the assistant to read a page the host refused itself, with create_note', async () => {
    vi.stubGlobal('fetch', async () => new Response('denied', { status: 403 }));
    const result = await tool({})({ url: PAGE });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('example.com answered 403');
    expect(result.content[0]!.text).toContain('create_note');
  });
});
