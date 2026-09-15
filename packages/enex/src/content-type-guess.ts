import { FALLBACK_CONTENT_TYPE } from '@unbent/shared';

/**
 * A content type for a file that arrived without one.
 *
 * An export archive carries bytes and names, not types: a zip has nowhere to put them,
 * and writing a manifest beside every note would make the "plain files" promise a lie.
 * So the type is recovered on the way back in, and it matters more than it looks — the
 * stored type is what decides whether a PDF gets its text extracted for search and
 * whether an image renders inline or downloads.
 *
 * Bytes are consulted before the name. A real export holds PDFs called `Menu Card` and
 * `Receipt`: ENEX `<file-name>` was a display label, so those files were stored without an
 * extension and are exported without one. The signatures checked are the handful that are
 * unambiguous from the first bytes alone; everything else goes by extension, which is why
 * office documents — zips inside — are not sniffed.
 */
export function guessContentType(filename: string, bytes: Uint8Array): string {
  return sniff(bytes) ?? byExtension(filename) ?? FALLBACK_CONTENT_TYPE;
}

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((b, i) => bytes[at + i] === b);
}

function sniff(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'; // %PDF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'; // GIF8
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  epub: 'application/epub+zip',
};

function byExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  // A dot at the very start is a hidden file's marker, not an extension.
  if (dot <= 0) return null;
  return BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null;
}
