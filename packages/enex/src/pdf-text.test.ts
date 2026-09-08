/**
 * PDF text extraction against scanned attachments shaped like an Evernote export's.
 *
 * The feature exists because real scans carry Evernote's OCR layer — a page image with
 * invisible text laid over it — and its quality varies enough that both a good and a
 * failed scan are worth asserting on. The fixtures used to be two of those real files;
 * they were personal documents and have been withdrawn from the repository and its
 * history. `scripts/make-scan-fixtures.mjs` now builds a pair with the same structure and
 * invented content, and the assertions are what they always were.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isExtractable } from './ocr-text.js';
import { extractPdfText } from './pdf-text.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url)));
}

describe('isExtractable', () => {
  it('accepts pdfs and rejects everything else', () => {
    expect(isExtractable('application/pdf')).toBe(true);
    expect(isExtractable('image/png')).toBe(false);
    expect(isExtractable('audio/mpeg')).toBe(false);
  });
});

/**
 * pdf.js resolves GlobalWorkerOptions.workerSrc before deciding whether to spawn a worker
 * and throws when it is blank — in the browser, even on the legacy build. Node tolerates a
 * blank value, which is why a version that failed on every real file passed these tests.
 * Asserting the setting directly is the part that transfers.
 */
describe('worker configuration', () => {
  it('sets a non-empty workerSrc', async () => {
    // Extraction triggers the lazy load that configures it.
    await extractPdfText(new Uint8Array(0));
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    expect(lib.GlobalWorkerOptions.workerSrc).toBeTruthy();
  }, 30_000);
});

describe('extractPdfText', () => {
  it('extracts usable text from a scan with good OCR', async () => {
    const result = await extractPdfText(fixture('scan-good.pdf'));

    expect(result.error).toBeUndefined();
    expect(result.pages).toBeGreaterThan(0);
    expect(result.quality.usable).toBe(true);
    expect(result.text.length).toBeGreaterThan(500);
    // Real content from a pharmacy record — the kind of thing worth searching for.
    expect(result.text).toContain('Northfield');
  }, 30_000);

  it('rejects a scan whose OCR produced noise', async () => {
    const result = await extractPdfText(fixture('scan-poor.pdf'));

    // Extraction succeeds; the text is simply not language.
    expect(result.error).toBeUndefined();
    expect(result.quality.usable).toBe(false);
  }, 30_000);

  it('does not consume the caller buffer', async () => {
    // pdf.js detaches the buffer it is handed; the importer still needs the bytes to
    // upload afterwards, so extraction must work on a copy.
    const bytes = fixture('scan-good.pdf');
    const before = bytes.length;
    await extractPdfText(bytes);
    expect(bytes.length).toBe(before);
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 30_000);

  it('returns an error rather than throwing on a non-pdf', async () => {
    const result = await extractPdfText(new TextEncoder().encode('this is not a pdf'));
    expect(result.quality.usable).toBe(false);
    expect(result.error).toBeTruthy();
  }, 30_000);

  it('handles an empty buffer', async () => {
    const result = await extractPdfText(new Uint8Array(0));
    expect(result.quality.usable).toBe(false);
  }, 30_000);
});
