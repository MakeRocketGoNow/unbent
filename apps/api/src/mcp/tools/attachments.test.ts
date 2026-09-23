import { describe, expect, it } from 'vitest';
import { registerAttachmentTools } from './attachments.js';
import type { AttachmentsRepo } from '../../lib/attachments-repo.js';
import type { MarkdownConverter } from '../../lib/extract-text.js';
import type { NotesRepo } from '../../lib/notes-repo.js';

/**
 * The read tool's one piece of logic worth pinning: telling a file that is waiting for a
 * reader from one already read, and from one this instance cannot read at all. Each of
 * those is a different answer, and two of them cost nothing — a model that is told "read
 * this" for a file already read must not be charged for a second look, and one asking
 * about a file nobody here can read must be told so rather than handed an empty string
 * that looks like a blank page.
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

const prose =
  'Your diagnosis based on what you shared about how you are feeling is allergic rhinitis, ' +
  'also known as hay fever, and the plan is an antihistamine each morning for two weeks.';

function converter(data: string): MarkdownConverter {
  return { toMarkdown: () => ({ transform: async () => ({ format: 'markdown', data }) }) };
}

const blobs = {
  get: async () => ({ arrayBuffer: async () => new TextEncoder().encode('bytes').buffer as ArrayBuffer }),
};

/** Collects the tools instead of serving them, so a handler can be called directly. */
function collect(env: Record<string, unknown>, attachments: unknown): Map<string, Registered['handler']> {
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
    { notes: {} as NotesRepo, attachments: attachments as AttachmentsRepo },
  );
  return tools;
}

/**
 * One note with one scan on it, in whichever state a test needs: `text` is what the repo
 * has recorded (null for no such file), and the two flags say which pending list the file
 * would appear in.
 */
function fakeAttachments(state: { text: string | null; pendingText?: boolean; pendingVision?: boolean }) {
  const file = { id: 'a1', noteId, filename: 'scan.pdf', contentType: 'application/pdf', size: 100, r2Key: 'k' };
  const recorded: Array<{ text: string; readBy: 'vision' | null }> = [];
  return {
    recorded,
    repo: {
      ownsNote: async (id: string) => id === noteId,
      textFor: async (id: string, filename: string) => (id === noteId && filename === 'scan.pdf' ? state.text : null),
      needingText: async (_limit: number, id?: string) => (id === noteId && state.pendingText ? [file] : []),
      needingVision: async (_limit: number, id?: string) => (id === noteId && state.pendingVision ? [file] : []),
      recordText: async ({ text, readBy }: { text: string; readBy: 'vision' | null }) => {
        recorded.push({ text, readBy });
        state.text = text;
      },
    },
  };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text) as Record<string, unknown>;

describe('read_attachment', () => {
  it('reads a scan nothing has looked at through its layer and answers with the text', async () => {
    const { recorded, repo } = fakeAttachments({ text: '', pendingText: true });
    const read = collect({ BLOBS: blobs, AI: converter(`# scan.pdf\n## Contents\n${prose}`) }, repo).get('read_attachment')!;

    const result = await read({ noteId, filename: 'scan.pdf' });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toMatchObject({ filename: 'scan.pdf', read: true, outcome: 'text', indexed: true });
    expect(parse(result).text).toContain('allergic');
    expect(recorded).toEqual([{ text: expect.stringContaining('allergic'), readBy: null }]);
  });

  it('hands back a file already read as it is, without a second look', async () => {
    const { recorded, repo } = fakeAttachments({ text: 'ACME' });
    const read = collect({ BLOBS: blobs, AI: converter('should not be called') }, repo).get('read_attachment')!;

    const result = await read({ noteId, filename: 'scan.pdf' });

    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({ filename: 'scan.pdf', read: false, indexed: true, text: 'ACME' });
    expect(recorded).toEqual([]);
  });

  it('says so when this instance has no reader for the file, rather than answering blank', async () => {
    const { recorded, repo } = fakeAttachments({ text: '', pendingText: true });
    // No Workers AI and no model key: a PDF's layer is the browser's to read here.
    const read = collect({ BLOBS: blobs }, repo).get('read_attachment')!;

    const result = await read({ noteId, filename: 'scan.pdf' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no reader/);
    expect(recorded).toEqual([]);
  });

  it('reports a note that is not the caller’s, and a file the note does not have', async () => {
    const { repo } = fakeAttachments({ text: null });
    const read = collect({ BLOBS: blobs }, repo).get('read_attachment')!;

    expect((await read({ noteId: otherNote, filename: 'scan.pdf' })).isError).toBe(true);
    expect((await read({ noteId, filename: 'other.pdf' })).isError).toBe(true);
  });
});
