import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWebImage, filenameForWebImage, rejectWebImageUrl } from './web-image.js';

/**
 * The address policy is the security property of fetching web images; the filename rules
 * decide what the panel shows and whether the picture opens in anything.
 */
describe('rejectWebImageUrl', () => {
  it('allows ordinary public addresses', () => {
    expect(rejectWebImageUrl('https://cdn.example.com/a.jpg')).toBeNull();
    expect(rejectWebImageUrl('http://example.org/pics/b%20c.png?x=1')).toBeNull();
  });

  it('refuses anything but http and https', () => {
    expect(rejectWebImageUrl('ftp://example.com/a.jpg')).toMatch(/http/);
    expect(rejectWebImageUrl('file:///etc/passwd')).toMatch(/http/);
    expect(rejectWebImageUrl('not a url')).toMatch(/valid/);
  });

  it('refuses loopback and private networks', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '[::1]',
      '[fc00::1]',
      '[fe80::1]',
      '[::ffff:10.0.0.1]',
    ]) {
      expect(rejectWebImageUrl(`http://${host}/a.png`), host).not.toBeNull();
    }
    expect(rejectWebImageUrl('http://172.32.0.1/a.png')).toBeNull();
  });

  it('opens loopback for local development only', () => {
    expect(rejectWebImageUrl('http://127.0.0.1:4000/a.png', { allowLoopback: true })).toBeNull();
    expect(rejectWebImageUrl('http://10.0.0.5/a.png', { allowLoopback: true })).not.toBeNull();
  });

  it('refuses credentials in the address', () => {
    expect(rejectWebImageUrl('https://user:pw@example.com/a.png')).toMatch(/credentials/);
  });
});

describe('filenameForWebImage', () => {
  const url = (s: string) => new URL(s);

  it('takes the last path segment, decoded', () => {
    expect(filenameForWebImage(url('https://x.example/p/my%20photo.jpg?w=1'), 'image/jpeg', null)).toBe(
      'my photo.jpg',
    );
  });

  it('prefers the name the server sent', () => {
    expect(
      filenameForWebImage(url('https://x.example/v1/abc'), 'image/png', 'attachment; filename="Photo (1).png"'),
    ).toBe('Photo (1).png');
    expect(
      filenameForWebImage(url('https://x.example/v1/abc'), 'image/png', "attachment; filename*=UTF-8''caf%C3%A9.png"),
    ).toBe('café.png');
  });

  it('adds an extension from the type when the name has none', () => {
    expect(filenameForWebImage(url('https://x.example/v1/abc123'), 'image/webp', null)).toBe('abc123.webp');
    expect(filenameForWebImage(url('https://x.example/'), 'image/jpeg; charset=binary', null)).toBe('image.jpg');
  });

  it('keeps a name inside the rules an upload follows', () => {
    expect(filenameForWebImage(url('https://x.example/a'), 'image/png', 'attachment; filename="../.hidden"')).toBe(
      'hidden.png',
    );
  });
});

describe('fetchWebImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A picture sent in chunks, declaring `length` (none when null), with `encoding` if any. */
  function serve(chunks: number[][], length: number | null, encoding?: string) {
    vi.stubGlobal('fetch', async () => {
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      });
      const headers: Record<string, string> = { 'content-type': 'image/png' };
      if (length !== null) headers['content-length'] = String(length);
      if (encoding) headers['content-encoding'] = encoding;
      return new Response(body, { headers });
    });
  }

  async function bytesOf(): Promise<number[]> {
    const result = await fetchWebImage('https://example.com/a.png', { allowLoopback: false });
    if (!result.ok) throw new Error(result.error);
    return Array.from(new Uint8Array(result.bytes));
  }

  /* One buffer when the size is declared; the bytes the same whichever way they were read. */
  it('reads the bytes whole, whether the size was declared, short, long or not at all', async () => {
    const chunks = [[1, 2, 3], [4, 5], [6]];
    for (const length of [6, null, 4, 9]) {
      serve(chunks, length);
      expect(await bytesOf()).toEqual([1, 2, 3, 4, 5, 6]);
    }
    serve(chunks, 2, 'gzip');
    expect(await bytesOf()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stops at the limit however the size was declared', async () => {
    serve([[1, 2, 3], [4, 5, 6]], 3);
    const result = await fetchWebImage('https://example.com/a.png', { allowLoopback: false, maxBytes: 5 });
    expect(result).toMatchObject({ ok: false, status: 413 });
  });
});
