import { describe, expect, it } from 'vitest';
import { appLinks } from '../../lib/app-links.js';
import { registerAttachmentTools } from './attachments.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import type { NotesRepo } from '../../lib/notes-repo.js';
import type { UploadGrantsRepo } from '../../lib/upload-grants.js';

/**
 * The upload link: minted on the instance's own address, for the caller's note only, with
 * the type left to the extension when none is given. A read tool lived beside it until
 * MAK-179; the model reads a file only inside an Auto-fill press now, and no tool asks.
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

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;

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
