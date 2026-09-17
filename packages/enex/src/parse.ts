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

/** Extension implied by a resource's declared `<mime>`. */
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

/**
 * Mirrors `MAX_FILENAME_LENGTH` in `@unbent/shared`, which is what the upload enforces.
 *
 * Copied rather than imported: this package parses ENEX with no knowledge of the server it
 * feeds, and one number is not worth a dependency edge onto the API's schemas. Truncating
 * to a larger value than the server accepts would only move the 400, so the two must agree.
 */
const MAX_FILENAME_LENGTH = 768;

export function fallbackFilename(md5: string, mime: string): string {
  return `${md5.slice(0, 12)}.${MIME_EXT[mime] ?? 'bin'}`;
}

/**
 * The name to store a resource under, given what the ENEX declared.
 *
 * Evernote's `<file-name>` is a display label, not a path: it is routinely written with a
 * trailing space and, for anything the user did not attach from a file, with no extension
 * at all. A real export has PDFs named `Menu Card` and `Lease Summary - DRAFT DRAFT `.
 *
 * That matters because the extension is load-bearing downstream — the preview decides
 * whether to embed a document viewer by the path it resolves, the export writes these
 * names to disk, and a phone picks its handler the same way. So the declared `<mime>`,
 * which is the one trustworthy thing in the pair, supplies what the name is missing.
 *
 * An existing extension is left alone even when it disagrees with the mime: renaming
 * `receipt.jpeg` to `receipt.jpg` would churn names for nothing, and a genuine mismatch is
 * the exporter's claim to make, not ours to correct.
 *
 * Being a label and not a path, it may also hold characters a filename cannot: a real
 * export has one named `Special Characters and Symbols for HTML, CSS and JS / ASCII /
 * Unicode`. Separators are replaced rather than stripped so the words stay readable and
 * two labels differing only there cannot collide, a leading dot is dropped because
 * `filenameSchema` reserves it, and an over-long label is truncated with its extension
 * kept — the extension is what the preview and the export dispatch on. Sanitizing here
 * rather than letting the upload 400 keeps a cosmetic quirk of the label from costing the
 * note its attachment.
 */
export function resourceFilename(declared: string, md5: string, mime: string): string {
  const name = sanitizeLabel(declared);
  // A label that was only separators or dots sanitizes to nothing worth keeping; `-.png`
  // is no more useful than the empty name the fallback already covers.
  if (!/[\p{L}\p{N}]/u.test(name)) return fallbackFilename(md5, mime);

  const ext = MIME_EXT[mime];
  if (!ext) return truncate(name, '');
  // A trailing dot is not an extension; `Rev.` should become `Rev..pdf`, not stay as-is.
  if (/\.[a-z0-9]+$/i.test(name)) return truncate(name, '');
  return truncate(name, `.${ext}`);
}

/** Strips what a filename may not carry, leaving the label as legible as it started. */
function sanitizeLabel(declared: string): string {
  return declared
    .replace(/[/\\]/g, '-')
    // Control characters survive neither an R2 key nor a filesystem.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/^[.\-]+/, '')
    .trim();
}

/**
 * Fits `name + ext` inside the filename limit, keeping the extension.
 *
 * Measured in UTF-16 code units because that is what `filenameSchema` counts; the limit
 * itself is sized so this stays inside R2's byte cap for multi-byte names.
 *
 * The cut is taken on a code point rather than a code unit: slicing an emoji filename mid
 * surrogate pair leaves a lone surrogate, which is not a well-formed string and would be
 * written into the R2 key as a replacement character.
 */
function truncate(name: string, ext: string): string {
  if (name.length + ext.length <= MAX_FILENAME_LENGTH) return `${name}${ext}`;
  let stem = name.slice(0, MAX_FILENAME_LENGTH - ext.length);
  // Slicing between the halves of a pair leaves a high surrogate at the end; drop it.
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return `${stem.trimEnd()}${ext}`;
}

/**
 * Makes each resource's filename unique within the note, the way the upload suffixes a
 * collision (`name-2.ext`, `name-3.ext`, …).
 *
 * Evernote's `<file-name>` is a label, and a real note often repeats one: two camera
 * photos both called `IMG_1234.jpg`, two screenshots both `image.png`, or two labels
 * that only differed by a slash and became the same after `resourceFilename` replaced
 * the separator. The markdown is written from these names (`files/<filename>`), and
 * the upload then suffixes the second. A later substring rewrite of `files/image.png`
 * would retarget *every* link — including the first file's, and including a neighbour
 * like `files/image.png.bak` — so both attachments have to carry distinct names before
 * either the conversion or the upload sees them.
 *
 * Same algorithm as `availableFilename` in the API, and deterministic, so a resumed
 * import assigns the same names the first run stored and can still fill in a miss.
 */
export function uniqueResourceFilenames(resources: EnexResource[]): EnexResource[] {
  if (resources.length <= 1) return resources;
  // Every original name is reserved so a suffix never steals a neighbour that already
  // held `image-2.png` — that file is a different attachment, and renaming it would
  // retarget its link the same way a substring replace used to.
  const reserved = new Set(resources.map((r) => r.filename));
  const assigned = new Set<string>();
  return resources.map((resource) => {
    if (!assigned.has(resource.filename)) {
      assigned.add(resource.filename);
      return resource;
    }
    const filename = nextAvailableFilename(resource.filename, reserved);
    reserved.add(filename);
    assigned.add(filename);
    return { ...resource, filename };
  });
}

/** Splits `name.ext` so a collision can be suffixed as `name-2.ext`. */
function splitExt(filename: string): [string, string] {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return [filename, ''];
  return [filename.slice(0, dot), filename.slice(dot)];
}

function nextAvailableFilename(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  const [stem, ext] = splitExt(desired);
  for (let n = 2; n < Number.MAX_SAFE_INTEGER; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${taken.size}${ext}`;
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
  /**
   * Stops the parse where it stands, leaving the notes already handed over untouched.
   *
   * `onNote` returning early is not enough on its own: the reader would still pull the
   * rest of the file through the parser, which for the largest real export is another
   * minute of CPU after the caller has stopped caring. Checked between chunks and between
   * notes, so a stop takes effect at the next note rather than mid-upload.
   */
  signal?: AbortSignal;
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
          resources: uniqueResourceFilenames(note.resources),
        });
        note = { resources: [], tags: [] };
        break;
      default:
        break;
    }
  });

  let bytesRead = 0;

  /**
   * Count bytes before decoding, not characters after.
   *
   * `TextDecoderStream` yields strings, so measuring the decoded chunk counts UTF-16 code
   * units — which disagrees with the `File.size` the UI shows progress against as soon as
   * a file contains any non-ASCII text. Tapping the byte stream on the way past keeps the
   * two in the same unit.
   */
  const counted = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  // TextDecoderStream's writable is typed as BufferSource, which is wider than the
  // Uint8Array stream we hold; the cast reconciles the two without weakening the input.
  const decoded = counted.pipeThrough(
    new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>,
  );
  const reader = decoded.getReader();

  /**
   * Processes every note the parser has completed so far.
   *
   * Progress is reported after *each* note rather than once per chunk. A chunk is
   * 64KB–512KB of ENEX, which can hold many notes, and the uploads inside `onNote` are the
   * slow part — so a per-chunk update leaves the UI frozen for the entire time real work is
   * happening, which reads as a hang. This is the difference between a progress bar that
   * moves and one that appears stuck at its first value.
   */
  async function drain(): Promise<void> {
    while (ready.length > 0) {
      if (callbacks.signal?.aborted) return;
      const next = ready.shift()!;
      try {
        await callbacks.onNote(next);
        notes += 1;
      } catch (err) {
        errors += 1;
        callbacks.onError?.(`${next.title || 'untitled'}: ${(err as Error).message}`);
      }
      callbacks.onProgress?.(bytesRead);
    }
  }

  try {
    for (;;) {
      if (callbacks.signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      parser.write(value);

      // Drain outside the SAX callbacks: handlers are synchronous, so awaiting an upload
      // has to happen here, between chunks.
      await drain();

      callbacks.onProgress?.(bytesRead);
    }

    // Only a stream read to the end is a well-formed document; closing a parser stopped
    // partway through would throw on the tags the file never got to close.
    if (!callbacks.signal?.aborted) {
      parser.close();
      await drain();
    }
    callbacks.onProgress?.(bytesRead);
  } finally {
    if (callbacks.signal?.aborted) await reader.cancel().catch(() => {});
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
    filename: resourceFilename(pending.filename, md5, mime),
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
