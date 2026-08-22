import { SaxesParser } from 'saxes';
import type { EnexNote, EnexResource } from './types.js';

/**
 * Streaming ENEX parser.
 *
 * Holds exactly one `<note>` in memory at a time. The largest file in a real export is
 * 3.4GB in a single XML document — it cannot be read into a string, cannot be uploaded
 * whole (Cloudflare caps request bodies at 100MB), and cannot be chunked across requests
 * without reassembling parser state server-side. Streaming a SAX parse in the browser
 * avoids all three: `File` is already a disk-backed handle.
 */

/** ENEX uses ISO-8601 *basic* format, which `new Date()` does not parse. */
export function parseEnexDate(value: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  if (!m) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? undefined : fallback;
  }
  const [, y, mo, d, h, mi, s] = m;
  return new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
}

/** Extension for a resource that arrived without a `<file-name>`. */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'text/plain': 'txt',
  'text/html': 'html',
};

export function fallbackFilename(md5: string, mime: string): string {
  return `${md5.slice(0, 12)}.${MIME_EXT[mime] ?? 'bin'}`;
}

interface PendingResource {
  base64: string[];
  mime: string;
  filename: string;
}

export interface ParseCallbacks {
  onNote: (note: EnexNote) => Promise<void> | void;
  /** Byte offset consumed so far, for progress reporting. */
  onProgress?: (bytesRead: number) => void;
  onError?: (message: string) => void;
}

/**
 * Parses an ENEX stream, invoking `onNote` for each note as it completes.
 *
 * `onNote` is awaited, so a caller that uploads inside it applies natural backpressure —
 * parsing pauses while the upload runs and memory stays bounded by one note.
 */
export async function parseEnexStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: ParseCallbacks,
): Promise<{ notes: number; errors: number }> {
  const parser = new SaxesParser({ fragment: false });

  let note: Partial<EnexNote> & { resources: EnexResource[] } = { resources: [], tags: [] };
  let resource: PendingResource | null = null;
  let text: string[] = [];
  const path: string[] = [];

  let notes = 0;
  let errors = 0;

  /** Notes ready to hand to the caller; drained between chunks so awaits are legal. */
  const ready: EnexNote[] = [];

  parser.on('error', (err) => {
    errors += 1;
    callbacks.onError?.(err.message);
  });

  parser.on('opentag', (tag) => {
    path.push(tag.name);
    text = [];

    if (tag.name === 'note') {
      note = { resources: [], tags: [] };
    } else if (tag.name === 'resource') {
      resource = { base64: [], mime: '', filename: '' };
    }
  });

  parser.on('text', (chunk) => {
    text.push(chunk);
  });

  parser.on('cdata', (chunk) => {
    text.push(chunk);
  });

  parser.on('closetag', (tag) => {
    const value = text.join('');
    text = [];
    path.pop();

    switch (tag.name) {
      case 'title':
        note.title = value.trim();
        break;
      case 'created':
        note.created = parseEnexDate(value);
        break;
      case 'updated':
        note.updated = parseEnexDate(value);
        break;
      case 'content':
        note.enml = value;
        break;
      case 'tag':
        if (value.trim()) note.tags!.push(value.trim());
        break;
      case 'source-url':
        note.sourceUrl = value.trim();
        break;
      case 'data':
        if (resource) resource.base64.push(value);
        break;
      case 'mime':
        if (resource) resource.mime = value.trim();
        break;
      case 'file-name':
        if (resource) resource.filename = value.trim();
        break;
      case 'resource':
        if (resource) {
          const decoded = decodeResource(resource);
          if (decoded) note.resources.push(decoded);
          resource = null;
        }
        break;
      case 'note':
        ready.push({
          title: note.title ?? '',
          enml: note.enml ?? '',
          created: note.created,
          updated: note.updated,
          tags: note.tags ?? [],
          sourceUrl: note.sourceUrl,
          resources: note.resources,
        });
        note = { resources: [], tags: [] };
        break;
      default:
        break;
    }
  });

  // TextDecoderStream's writable is typed as BufferSource, which is wider than the
  // Uint8Array stream we hold; the cast reconciles the two without weakening the input.
  const decoded = stream.pipeThrough(
    new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>,
  );
  const reader = decoded.getReader();
  let bytesRead = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.length;
      parser.write(value);

      // Drain outside the SAX callbacks: handlers are synchronous, so awaiting an upload
      // has to happen here, between chunks.
      while (ready.length > 0) {
        const next = ready.shift()!;
        try {
          await callbacks.onNote(next);
          notes += 1;
        } catch (err) {
          errors += 1;
          callbacks.onError?.(`${next.title || 'untitled'}: ${(err as Error).message}`);
        }
      }

      callbacks.onProgress?.(bytesRead);
    }

    parser.close();

    while (ready.length > 0) {
      const next = ready.shift()!;
      try {
        await callbacks.onNote(next);
        notes += 1;
      } catch (err) {
        errors += 1;
        callbacks.onError?.(`${next.title || 'untitled'}: ${(err as Error).message}`);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { notes, errors };
}

/** Decodes a resource's base64 and computes the MD5 that en-media references. */
function decodeResource(pending: PendingResource): EnexResource | null {
  const base64 = pending.base64.join('').replace(/\s+/g, '');
  if (base64 === '') return null;

  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }

  const md5 = md5Hex(bytes);
  const mime = pending.mime || 'application/octet-stream';

  return {
    md5,
    mime,
    filename: pending.filename || fallbackFilename(md5, mime),
    bytes,
  };
}

/**
 * MD5 of the decoded bytes — the value `<en-media hash>` refers to.
 *
 * Implemented here rather than pulled from a dependency because WebCrypto deliberately
 * omits MD5, and this is the only place it is needed. It is used purely to match Evernote's
 * own identifiers, never for security.
 */
export function md5Hex(bytes: Uint8Array): string {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const len = bytes.length;
  const withPadding = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPadding.set(bytes);
  withPadding[len] = 0x80;

  const bitLen = len * 8;
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 8, bitLen >>> 0, true);
  view.setUint32(withPadding.length - 4, Math.floor(bitLen / 4294967296), true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i += 1) M[i] = view.getInt32(offset + i * 4, true);

    let [A, B, C, D] = [a, b, c, d];

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      const tmp = D;
      D = C;
      C = B;
      const sum = (A + f + K[i]! + M[g]!) | 0;
      B = (B + ((sum << S[i]!) | (sum >>> (32 - S[i]!)))) | 0;
      A = tmp;
    }

    a = (a + A) | 0;
    b = (b + B) | 0;
    c = (c + C) | 0;
    d = (d + D) | 0;
  }

  return [a, b, c, d]
    .map((word) =>
      Array.from({ length: 4 }, (_, i) =>
        ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0'),
      ).join(''),
    )
    .join('');
}
