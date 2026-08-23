/**
 * Deciding what content type an attachment may be *served* as.
 *
 * The type stored on an attachment row is not trustworthy: on upload it is whatever the
 * client put in the `Content-Type` header, and on import it is the `<mime>` value copied
 * out of an ENEX file that some other program wrote. Neither is verified against the bytes.
 *
 * Replaying such a value from our own origin is what makes it dangerous. A file uploaded as
 * `text/html` and served inline executes as a same-origin document: its scripts can read the
 * DOM and call `/api/*` with the user's session. `X-Content-Type-Options: nosniff` does not
 * help — it stops the browser *guessing* a type, not honouring one we declared.
 *
 * So the declared type is kept for metadata (search filters on `application/pdf`, the export
 * needs real types, the UI shows them) and this module governs the response only. Types that
 * cannot execute are passed through; everything else is served as a generic binary type,
 * which browsers download rather than run.
 */

/**
 * Types safe to echo back in a response.
 *
 * Chosen by what a browser will *execute or script*, not by what is "trusted". Images,
 * audio, video, and PDFs are inert as documents. Excluded, deliberately:
 *
 * - `text/html`, `application/xhtml+xml` — script in a same-origin document.
 * - `image/svg+xml` — an image to a human, a scriptable document to a browser.
 * - `text/xml`, `application/xml` — can carry XSLT that renders as markup.
 * - `text/css`, `application/javascript` — usable to attack pages that include them.
 * - Everything unlisted, including office documents and archives.
 */
const INLINE_SAFE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/tiff',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'text/plain',
  'text/csv',
]);

/** What anything not on the list is served as. Browsers download rather than render it. */
export const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * Strips parameters and normalizes case.
 *
 * `Text/HTML; charset=utf-8` and `text/html` are the same type to a browser, so they must
 * be the same type to the allowlist — comparing the raw header would let the first through.
 */
export function normalizeContentType(raw: string | null | undefined): string {
  if (!raw) return '';
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

/** True when this type may be sent back as declared. */
export function isInlineSafe(raw: string | null | undefined): boolean {
  return INLINE_SAFE.has(normalizeContentType(raw));
}

/**
 * The content type to put on a response for a stored attachment.
 *
 * Everything unsafe collapses to `application/octet-stream`, which no browser executes.
 * The stored value is left alone; only what we serve changes.
 */
export function serveContentType(stored: string | null | undefined): string {
  return isInlineSafe(stored) ? normalizeContentType(stored) : FALLBACK_CONTENT_TYPE;
}

/**
 * How the response should be disposed.
 *
 * Safe types render in place. Anything else is marked `attachment`, so even if a future
 * change let a real type through, the browser saves the file instead of opening it as a
 * document in our origin. Defence in depth: the type alone should already be enough.
 */
export function serveDisposition(stored: string | null | undefined): 'inline' | 'attachment' {
  return isInlineSafe(stored) ? 'inline' : 'attachment';
}
