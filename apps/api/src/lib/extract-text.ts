import { cleanExtractedText, isExtractable, type CleanedText } from '@unbent/enex/ocr-text';

/**
 * Text extraction on the server, through Workers AI's document conversion.
 *
 * pdf.js cannot run here: a Worker on the free plan gets 10ms of CPU per request and a
 * scan takes hundreds, so extraction has lived in the browser, with the phone hosting a
 * hidden page to get at it. Workers AI's `toMarkdown` sidesteps the cap (the work
 * happens in Cloudflare's service, not this isolate) and converting a PDF through it is
 * free. It reads the text layer, as pdf.js does, so a scan with no layer comes back
 * empty from both. Measured on fifty scans from a real export: the two agree on which
 * files have text (41 of 49) and which have none (8), with a median word overlap of 0.89.
 *
 * The browser paths stay as the fallback. A deployment without the binding, a file over
 * the size cap, a conversion that fails or overruns the thirty seconds a Worker may keep
 * working after its response: all of those leave the row pending, and the pass the app
 * makes on open catches it.
 */

/**
 * The whole file has to be held in memory to convert it, inside a 128MB isolate that is
 * also serving the request. Twenty-five megabytes is well clear of that and covers all
 * but the longest scans; the rest go the browser's way.
 */
export const MAX_SERVER_EXTRACT_BYTES = 25 * 1024 * 1024;

/** What this asks of the binding, so a test can hand in a fake. */
export interface MarkdownConverter {
  toMarkdown(): {
    transform(document: {
      name: string;
      blob: Blob;
    }): Promise<{ format: string; data?: string; error?: string }>;
  };
}

export function canExtractOnServer(
  env: { AI?: unknown },
  contentType: string,
  size: number,
): boolean {
  return env.AI !== undefined && isExtractable(contentType) && size <= MAX_SERVER_EXTRACT_BYTES;
}

/**
 * Drops what the converter says about the file rather than from it.
 *
 * The output opens with the filename as a heading and a Metadata list (PDF version,
 * producer, the scanner's name), then "## Contents" and a heading per page. For a scan
 * with no text layer that preamble is the entire output, and it passes the quality
 * filter on its own: "ScanSnap Manager" and "Quartz PDFContext" are perfectly good words.
 * Indexed, every scan from the same scanner would match a search for it.
 */
export function stripConversionPreamble(markdown: string): string {
  return markdown
    .replace(/^# [^\n]*\n(?:\s*\n)*## Metadata\n(?:- [^\n]*\n?)*/u, '')
    .replace(/^#{2,3} (?:Contents|Page \d+)[ \t]*$/gmu, '');
}

/**
 * Converts and cleans. Null when the service could not read the file at all, which is
 * different from a file it read and found nothing in: that is `usable: false`, and gets
 * the empty row that stops a later pass from trying it again. A throw is a fault in the
 * service rather than an answer about the file, and is the caller's to handle.
 *
 * Takes the bytes and their type rather than a blob, because the blob must be typed: the
 * conversion refuses one with no type outright (it throws "expected string to have >=1
 * characters" rather than answering an error), and an untyped one is what
 * `new Blob([bytes])` makes. That went unnoticed long enough for every PDF read on the
 * server to stay pending, and for Auto-fill to title notes from their files' names
 * because it had nothing else to read. Built here, nobody can hand it one untyped again.
 */
export async function extractOnServer(
  ai: MarkdownConverter,
  name: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<CleanedText | null> {
  const blob = new Blob([bytes], { type: contentType });
  const result = await ai.toMarkdown().transform({ name, blob });
  if (result.format === 'error' || typeof result.data !== 'string') return null;
  return cleanExtractedText(stripConversionPreamble(result.data));
}
