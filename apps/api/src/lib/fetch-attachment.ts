import { FALLBACK_CONTENT_TYPE, filenameSchema, normalizeContentType, splitExt } from '@unbent/shared';
import { rejectWebImageUrl } from './web-image.js';

/**
 * Fetching a file from a URL on an assistant's behalf, so it can be stored as an attachment.
 *
 * An MCP tool call is JSON the model writes token by token, so bytes cannot ride in one:
 * a two-megabyte PDF is close to three million characters of base64, and no client fills
 * an argument in on the model's behalf. What a model *can* hand over is a reference the
 * server can follow — the signed download URL another system gave it for the file — and
 * the transfer then happens server to server, with the model never seeing a byte. This
 * module is the fetching half of that; storing what comes back is `storeAttachment`.
 *
 * The bytes go to R2 as a stream when the source says how long it is, which is what lets
 * a file be larger than the Worker's memory. A source that does not say — chunked
 * transfer, some proxies — is read into memory instead, under a cap that keeps the
 * isolate well clear of its ceiling. Nearly every real download URL declares a length;
 * the buffered path is for the rest, not the norm.
 *
 * No credentials go with the request. The fetch is anonymous by construction: a signed
 * URL carries its own authority in its query string, and there is nothing else this
 * server could send that would be right for an arbitrary host.
 */

/** A source that does not declare its length is read into memory, up to this. */
export const MAX_UNSIZED_FETCH_BYTES = 25 * 1024 * 1024;

/**
 * The whole fetch, from the request to the last byte, has this long.
 *
 * Long enough for a slow host to deliver a large scan, and short enough that an unreachable
 * one answers with a message rather than a client's timeout. Workers impose no wall-clock
 * limit of their own on a request in flight, so without this a dead host would hang the
 * tool call until the MCP client gave up on it.
 */
const FETCH_TIMEOUT_MS = 60_000;

/** As many redirect hops as the web-image fetch allows, for the same reason: a CDN chain. */
const MAX_REDIRECTS = 5;

/**
 * Whether a URL is one this server will fetch.
 *
 * Two refusals with different shapes. A non-http scheme is almost never an attack: it is a
 * reference from inside another application — `file:` from a document store, a scheme of
 * its own — that a model read off a page and passed along, so the message says to read the
 * containing page for a real download URL. A loopback or private-network host is the SSRF
 * case, and the guard is shared with the web-image fetch (`rejectWebImageUrl`) so the two
 * server-side fetchers cannot disagree on what is off limits — the Worker fetching an
 * address a caller supplied is the one place this app reaches a URL it did not build, and
 * `add_attachment` is now a second door onto it. `allowLoopback` is the same escape hatch
 * the image fetch uses, for the test suite's own server and local development, keyed on
 * `ALLOW_TEST_CREDENTIALS` by the caller.
 *
 * The host is re-checked after every redirect in `fetchSource`; this is only the entry
 * point.
 */
export function checkSourceUrl(
  raw: string,
  opts: { allowLoopback?: boolean } = {},
): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `"${raw}" is not a URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      error:
        `Only http and https URLs can be fetched; this one is ${url.protocol.slice(0, -1)}. ` +
        'A reference like that is internal to the system that holds the file — read the ' +
        'page or record that contains it for a download URL, and pass that instead.',
    };
  }
  if (url.username || url.password) {
    return { error: 'A URL with credentials in it is refused. Use a signed URL instead.' };
  }
  const unroutable = rejectWebImageUrl(raw, opts);
  if (unroutable) return { error: `${unroutable}.` };
  return { url };
}

/**
 * The filename a Content-Disposition header offers, or null when it offers none.
 *
 * `filename*` (RFC 5987, percent-encoded with a charset prefix) wins over `filename` when
 * both are present, as RFC 6266 says it should — it is the one that can spell a name the
 * plain form cannot. A percent-encoding that fails to decode falls back to the plain form
 * rather than to a mangled name.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:[\w-]+)?'[\w-]*'([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      const decoded = decodeURIComponent(extended[1].trim()).trim();
      if (decoded) return decoded;
    } catch {
      // Fall through to the plain form.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1] !== undefined) {
    const unescaped = quoted[1].replace(/\\(.)/g, '$1').trim();
    return unescaped || null;
  }
  const bare = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return bare?.[1]?.trim() || null;
}

/**
 * The last segment of a URL's path, decoded, or null when there is not a usable one.
 *
 * A trailing slash, a bare origin and a segment of nothing but punctuation all yield null;
 * the caller has better fallbacks than `%2F` or `-`.
 */
export function filenameFromUrl(url: URL): string | null {
  // The segment after the last slash, so a trailing slash — a directory, not a file — is
  // an empty segment and not the directory's name.
  const segment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  if (!segment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  decoded = decoded.trim();
  return /[\p{L}\p{N}]/u.test(decoded) ? decoded : null;
}

/**
 * Types that can be told from an extension, for a source that declares none — or declares
 * the generic binary type, which is a way of declaring none.
 *
 * Deliberately short. It exists so a PDF fetched from a host that says `octet-stream`
 * still gets its text extracted and still opens inline: `isExtractable` and the serving
 * allowlist both key on the stored type, and a wrong "unknown" costs search a document.
 * A wrong guess the other way would be worse, so nothing is inferred that a browser could
 * execute.
 */
const TYPES_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

/** The extension to give a file whose only known fact is its type. */
function extensionForType(contentType: string): string {
  const match = Object.entries(TYPES_BY_EXTENSION).find(([, type]) => type === contentType);
  return match ? `.${match[0]}` : '';
}

/**
 * The type to store, given what the source declared and what the file is called.
 *
 * The declaration wins when it says something. `application/octet-stream` — and S3's
 * `binary/octet-stream` — say nothing, so the extension is consulted, and a name with no
 * telling extension stores the fallback exactly as an upload with no header would.
 */
export function chooseContentType(declared: string | null | undefined, filename: string): string {
  const normalized = normalizeContentType(declared);
  if (normalized && !normalized.endsWith('/octet-stream')) return normalized;
  const ext = splitExt(filename)[1].slice(1).toLowerCase();
  return TYPES_BY_EXTENSION[ext] ?? (normalized || FALLBACK_CONTENT_TYPE);
}

/**
 * The name to store the file under, from the best of what is known.
 *
 * In order: the name the caller asked for, the one the source's Content-Disposition
 * offers, the last segment of the URL. Each must be a name this server may store —
 * `filenameSchema`, the same rule the upload applies — and the first that is wins. When
 * nothing usable is known, a generic name with the type's extension, so a PDF that
 * arrived nameless is at least `attachment.pdf` and not a bare word.
 *
 * The URL is last for a reason a model should be told (the tool description says it):
 * download URLs often end in a generic name — `upload.pdf`, `image` — that says nothing
 * about the file, and the caller usually knows a better one from wherever it read the
 * link.
 */
export function chooseFilename(input: {
  requested?: string | undefined;
  contentDisposition: string | null | undefined;
  url: URL;
  contentType: string | null | undefined;
}): string {
  const candidates = [
    input.requested,
    filenameFromContentDisposition(input.contentDisposition),
    filenameFromUrl(input.url),
  ];
  for (const candidate of candidates) {
    if (candidate && filenameSchema.safeParse(candidate).success) return candidate;
  }
  return `attachment${extensionForType(normalizeContentType(input.contentType))}`;
}

export type FetchedSource =
  | {
      ok: true;
      /** A stream of known length when the source declared one; otherwise the bytes. */
      body: ReadableStream | ArrayBuffer;
      /** Declared by the source, or counted, in bytes. */
      size: number;
      contentType: string | null;
      contentDisposition: string | null;
      /** Where the bytes actually came from, after any redirects. */
      url: URL;
    }
  | { ok: false; error: string };

/**
 * Fetches a URL and hands back its body in a form `storeAttachment` can put straight
 * into R2, or a message the caller should read and act on.
 *
 * `maxBytes` refuses a source that declares more than that before a byte of it is read.
 * A source that declares nothing is read up to `MAX_UNSIZED_FETCH_BYTES` and refused
 * past it, since there is no other way to learn how large it is.
 *
 * Redirects are followed by hand, not by `fetch`, so that every hop's host passes the same
 * SSRF check the entry point did: a public URL that 302s to `http://127.0.0.1` is the
 * classic way past a check that only looked at the address the caller typed. `allowLoopback`
 * carries that policy to each hop, the same value `checkSourceUrl` was given.
 */
export async function fetchSource(
  url: URL,
  limits: { maxBytes: number; allowLoopback?: boolean },
): Promise<FetchedSource> {
  let current = url;
  let res: Response;
  for (let hop = 0; ; hop += 1) {
    // Every hop after the first is an address the *previous response* chose, not the
    // caller, so it has had no check of its own until here.
    if (hop > 0) {
      const unroutable = rejectWebImageUrl(current.href, { allowLoopback: limits.allowLoopback });
      if (unroutable) return { ok: false, error: `A redirect pointed somewhere it may not: ${unroutable}.` };
    }

    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      return { ok: false, error: `Could not fetch from ${current.host}: ${describe(err)}` };
    }

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      if (!location) return { ok: false, error: `${current.host} redirected nowhere.` };
      if (hop >= MAX_REDIRECTS) return { ok: false, error: 'Too many redirects.' };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, error: `${current.host} redirected to an address that is not a URL.` };
      }
      continue;
    }
    break;
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const hint =
      res.status === 403 || res.status === 401
        ? ' A signed URL may have expired; read the source again for a fresh one.'
        : '';
    return { ok: false, error: `${current.host} answered ${res.status} ${res.statusText}.${hint}` };
  }
  if (!res.body) return { ok: false, error: `${current.host} sent no file.` };

  const contentType = res.headers.get('content-type');
  const contentDisposition = res.headers.get('content-disposition');
  const finalUrl = new URL(res.url || current.href);
  const declared = res.headers.get('content-length');
  const length = declared === null ? Number.NaN : Number(declared);

  if (Number.isInteger(length) && length >= 0) {
    if (length === 0) {
      await res.body.cancel().catch(() => {});
      return { ok: false, error: `${current.host} sent an empty file.` };
    }
    if (length > limits.maxBytes) {
      await res.body.cancel().catch(() => {});
      return { ok: false, error: tooLarge(length, limits.maxBytes) };
    }
    /**
     * R2 will only take a stream whose length it knows, and a fetched body is not
     * guaranteed to carry one. FixedLengthStream is the documented way to promise it a
     * length — and to have the transfer fail, rather than store a short file, if the
     * source sends fewer bytes than it declared. The pipe runs alongside the put; its
     * failure surfaces through the readable side as the put's error, so the rejection
     * here has nothing left to say.
     */
    const { readable, writable } = new FixedLengthStream(length);
    res.body.pipeTo(writable).catch(() => {});
    return { ok: true, body: readable, size: length, contentType, contentDisposition, url: finalUrl };
  }

  // No usable length: read it, counting, and stop the moment it is too much.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UNSIZED_FETCH_BYTES) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          error:
            `${current.host} did not say how large the file is, and it is over ` +
            `${megabytes(MAX_UNSIZED_FETCH_BYTES)}MB — the most that can be taken from a ` +
            'source that does not declare a length.',
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    return { ok: false, error: `Reading from ${current.host} failed: ${describe(err)}` };
  }
  if (total === 0) return { ok: false, error: `${current.host} sent an empty file.` };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: bytes.buffer, size: total, contentType, contentDisposition, url: finalUrl };
}

function tooLarge(length: number, max: number): string {
  return `That file is ${megabytes(length)}MB; attachments can be at most ${megabytes(max)}MB.`;
}

function megabytes(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' ? 'it did not answer in time' : err.message;
  }
  return String(err);
}
