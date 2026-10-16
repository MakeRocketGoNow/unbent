import { normalizeContentType } from '@unbent/shared';

/**
 * Fetching a picture off the web into a note.
 *
 * A note converted from a bookmark, or written by an assistant, draws its pictures from
 * the site they came from. The browser cannot bring them in: a cross-origin image can be
 * shown but not read, so a fetch from the page fails on CORS and a canvas draw of it is
 * tainted. The Worker can, and doing it here is also what makes a whole note, or one
 * day a whole account, convertible in one pass.
 *
 * The Worker fetching an address a user typed is the one place this app reaches out to
 * a URL it did not build, so the address is checked before and after every redirect:
 * http(s) only, and nothing that names a loopback or private network. Cloudflare's
 * runtime refuses those anyway; a self-hoster's might not. Local development keeps
 * loopback open, since that is where the test suite's picture server lives.
 */

/** Smaller than the upload cap: the bytes are buffered here, and the Worker has 128MB. */
export const MAX_WEB_IMAGE_BYTES = 30 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;

/** Why an address may not be fetched, or null when it may. */
export function rejectWebImageUrl(raw: string, opts: { allowLoopback?: boolean } = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid web address';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https addresses';
  if (url.username || url.password) return 'Addresses with credentials are not fetched';

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
  if (loopback) return opts.allowLoopback ? null : 'Local addresses are not fetched';
  if (isPrivateHost(host)) return 'Private network addresses are not fetched';
  return null;
}

/** Numeric hosts inside the ranges a Worker must never be pointed at. */
function isPrivateHost(host: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a >= 224
    );
  }
  if (host.includes(':')) {
    // Unique-local (fc00::/7), link-local (fe80::/10), unspecified, and v4-mapped.
    return /^(f[cd]|fe[89ab])/i.test(host) || host === '::' || host.startsWith('::ffff:');
  }
  return false;
}

const EXTENSION_FOR: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
};

/**
 * A filename for the fetched picture: the one the server named, else the address's last
 * path segment, else `image`. Given an extension from the type when it has none: a CDN
 * path like `/v1/abc123` says nothing, and a name without one draws no icon in the panel
 * and opens in nothing. Path separators and leading dots are stripped so the name passes
 * the same rules an upload does.
 */
export function filenameForWebImage(
  url: URL,
  contentType: string,
  disposition: string | null,
): string {
  let name = disposition ? filenameFromDisposition(disposition) : '';
  if (!name) {
    const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      name = decodeURIComponent(segment);
    } catch {
      name = segment;
    }
  }
  // The last segment of anything path-shaped, then no leading dots: an upload's rules.
  name = (name.split(/[/\\]/).pop() ?? '').replace(/^\.+/, '').trim().slice(0, 200);
  if (!name) name = 'image';

  const ext = EXTENSION_FOR[normalizeContentType(contentType)];
  if (ext && !/\.[a-z0-9]{2,5}$/i.test(name)) name = `${name}.${ext}`;
  return name;
}

function filenameFromDisposition(header: string): string {
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain?.[1]?.trim() ?? '';
}

export type WebImageResult =
  | { ok: true; bytes: ArrayBuffer; contentType: string; filename: string }
  | { ok: false; status: 400 | 413 | 415 | 502; error: string };

/**
 * Fetches the picture, following a few redirects and checking each hop's address.
 *
 * Redirects are followed by hand rather than by `fetch` so that a public address cannot
 * bounce the Worker onto a private one. The body is buffered, not streamed: R2 needs a
 * known length and a web server need not send one.
 */
export async function fetchWebImage(
  raw: string,
  opts: { allowLoopback: boolean },
): Promise<WebImageResult> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const rejected = rejectWebImageUrl(current, opts);
    if (rejected) return { ok: false, status: 400, error: rejected };

    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'image/*,*/*;q=0.5', 'User-Agent': 'Unbent (+https://unbent.app)' },
      });
    } catch (err) {
      return { ok: false, status: 502, error: `Could not reach the site: ${(err as Error).message}` };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location');
      if (!location) return { ok: false, status: 502, error: 'The site redirected nowhere' };
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) return { ok: false, status: 502, error: `The site answered ${res.status}` };

    const contentType = normalizeContentType(res.headers.get('Content-Type'));
    if (!contentType.startsWith('image/')) {
      return { ok: false, status: 415, error: `Not an image (${contentType || 'no type'})` };
    }

    const declared = Number(res.headers.get('Content-Length') ?? '0');
    if (declared > MAX_WEB_IMAGE_BYTES) return { ok: false, status: 413, error: 'Image too large' };

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_WEB_IMAGE_BYTES) return { ok: false, status: 413, error: 'Image too large' };
    if (bytes.byteLength === 0) return { ok: false, status: 502, error: 'The site sent an empty image' };

    const filename = filenameForWebImage(new URL(current), contentType, res.headers.get('Content-Disposition'));
    return { ok: true, bytes, contentType, filename };
  }
  return { ok: false, status: 502, error: 'Too many redirects' };
}
