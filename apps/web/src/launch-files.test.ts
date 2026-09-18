import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteFromFiles, titleFor } from './launch-files.js';

vi.mock('./index-files.js', () => ({ indexUploadedFile: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

/** Answers the three calls a launch makes: create, one PUT per file, then the body patch. */
function stubApi() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({
        method,
        url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      });
      if (method === 'POST') return Response.json({ id: 'n1', title: 'x', body: '' });
      if (method === 'PUT') {
        const name = decodeURIComponent((init.headers as Record<string, string>)['X-Filename'] ?? '');
        return Response.json({ filename: name, path: `files/${name}`, indexing: 'server' });
      }
      return Response.json({ id: 'n1' });
    }),
  );
  return calls;
}

describe('titleFor', () => {
  it('drops the extension and nothing else', () => {
    expect(titleFor('2026-09-18 Water bill.pdf')).toBe('2026-09-18 Water bill');
    expect(titleFor('scan')).toBe('scan');
  });
});

describe('noteFromFiles', () => {
  it('names the note after the first file and links every upload', async () => {
    const calls = stubApi();
    const id = await noteFromFiles([
      new File(['%PDF'], 'Water bill.pdf', { type: 'application/pdf' }),
      new File(['png'], 'page 2.png', { type: 'image/png' }),
    ]);
    expect(id).toBe('n1');
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'PUT', 'PATCH']);
    expect(calls[0]?.body).toEqual({ title: 'Water bill', body: '' });
    expect(calls[3]?.body).toEqual({
      body: '[Water bill.pdf](<files/Water bill.pdf>)\n\n![page 2.png](<files/page 2.png>)\n',
    });
  });
});
