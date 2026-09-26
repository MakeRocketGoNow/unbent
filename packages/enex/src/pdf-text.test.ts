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

/**
 * A PDF that tries to run script the moment it is opened, built by hand so every byte is
 * visible: an `/OpenAction`, a page-open `/AA` action and a document-level named script,
 * all setting the same global.
 *
 * pdf.js reads these as data and runs none of them; only its viewer's scripting sandbox
 * would. This goes through real pdf.js rather than a mock, so an upgrade that changed
 * that would fail here instead of in someone's archive.
 */
function scriptedPdf(): Uint8Array {
  const js = '(globalThis.__unbentPdfScriptRan = true)';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R /Names << /JavaScript << /Names [(init) 5 0 R] >> >> >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> /AA << /O 5 0 R >> >>`,
    null, // the content stream, below, since its length is part of it
    `<< /S /JavaScript /JS (${js}) >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  const stream = 'BT /F1 18 Tf 20 100 Td (Harmless invoice text) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('a PDF carrying JavaScript', () => {
  it('is read for its text and its scripts never run', async () => {
    const scope = globalThis as { __unbentPdfScriptRan?: boolean };
    delete scope.__unbentPdfScriptRan;

    const result = await extractPdfText(scriptedPdf());

    // Proves the file was actually opened and walked, not rejected before its actions
    // were ever reached.
    expect(result.error).toBeUndefined();
    expect(result.pages).toBe(1);
    expect(result.text).toContain('Harmless invoice text');
    expect(scope.__unbentPdfScriptRan).toBeUndefined();
  }, 30_000);

  /**
   * Without this the test above could pass by accident: a fixture pdf.js failed to
   * parse the actions from would carry no script at all, and nothing would run either.
   */
  it('really does carry scripts pdf.js can see', async () => {
    await extractPdfText(new Uint8Array(0)); // configures the worker
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = lib.getDocument({ data: scriptedPdf(), isEvalSupported: false } as Parameters<
      typeof lib.getDocument
    >[0]);
    const doc = await task.promise;

    const docActions = (await doc.getJSActions()) as Map<string, string[]> | null;
    const pageActions = (await (await doc.getPage(1)).getJSActions()) as Map<
      string,
      string[]
    > | null;
    expect([...(docActions?.keys() ?? [])]).toEqual(expect.arrayContaining(['OpenAction', 'init']));
    expect([...(pageActions?.keys() ?? [])]).toEqual(['PageOpen']);
    await task.destroy();
  }, 30_000);
});
