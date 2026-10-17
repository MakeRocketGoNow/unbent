import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@unbent/enex', () => ({
  extractPdfText: vi.fn(async () => ({ text: 'page text', quality: { usable: true } })),
}));
import { indexPendingFiles } from './attachment-text.js';

/**
 * The pass over pending files when the store has no room for their text (MAK-234): it
 * stops at the first refusal rather than downloading and extracting every pending scan
 * only to have each refused, and a file it could not read is still skipped, not a stop.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Three pending files; one leaves the list once its text is taken, as the server's does. */
function server({ textAnswer }: { textAnswer: () => Response }) {
  const asked: string[] = [];
  const pending = new Set(['n1', 'n2', 'n3']);
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${input}`);
    if (input.startsWith('/api/attachments/pending-text')) {
      return json({ pending: [...pending].map((noteId) => ({ noteId, filename: 'scan.pdf' })), remaining: pending.size });
    }
    if (method === 'PUT') {
      const answer = textAnswer();
      if (answer.ok) pending.delete(input.split('/')[3]!);
      return answer;
    }
    return new Response(new Uint8Array([1, 2, 3]));
  });
  vi.stubGlobal('fetch', fetch);
  return { asked };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('indexPendingFiles and the store limit', () => {
  it('stops at the first file the store has no room for, and downloads no more', async () => {
    const { asked } = server({ textAnswer: () => json({ code: 'STORAGE_FULL', of: 'notes', error: 'No room.' }, 402) });
    const result = await indexPendingFiles();
    expect(result).toMatchObject({ done: 1, indexed: 0, failed: 1 });
    expect(asked.filter((a) => a.startsWith('GET /api/notes/'))).toEqual(['GET /api/notes/n1/files/scan.pdf']);
  });

  it('skips a file refused for any other reason and goes on to the next', async () => {
    let calls = 0;
    const { asked } = server({ textAnswer: () => (++calls === 1 ? json({ error: 'Bad text' }, 400) : new Response(null, { status: 204 })) });
    const result = await indexPendingFiles();
    expect(result).toMatchObject({ indexed: 2, failed: 1 });
    expect(asked.filter((a) => a.startsWith('GET /api/notes/'))).toHaveLength(3);
  });
});
