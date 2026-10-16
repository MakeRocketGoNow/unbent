import { cleanExtractedText, type CleanedText } from './ocr-text.js';

/**
 * Pulls the existing text layer out of a PDF.
 *
 * This is extraction, not OCR. Evernote already ran OCR on scanned attachments and
 * embedded the result, so the searchable text is sitting in the file: most notes in a
 * real export are a scanned PDF with an empty body, and without this they import as
 * title-only stubs nothing can find.
 *
 * pdf.js is imported lazily so the ~1MB library only loads when a PDF actually appears.
 */

/** Page cap: a runaway document should not stall an import of thousands of notes. */
const MAX_PAGES = 100;

export interface PdfTextResult extends CleanedText {
  pages: number;
  /** Set when extraction failed outright rather than producing poor text. */
  error?: string;
}

type PdfModule = typeof import('pdfjs-dist');
let pdfjs: PdfModule | null = null;

async function loadPdfjs(): Promise<PdfModule> {
  if (pdfjs) return pdfjs;

  const lib = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;

  /**
   * Give pdf.js its own worker URL.
   *
   * Importing the worker script directly into the ENEX worker is not equivalent: pdf.js
   * then uses the outer worker's message channel for its internal protocol, leaking raw
   * messages to the React client. A nested worker keeps that protocol isolated.
   */
  if (!lib.GlobalWorkerOptions.workerSrc) {
    try {
      lib.GlobalWorkerOptions.workerSrc = (
        await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
      ).default;
    } catch {
      // Node has no bundler to resolve `?url`; a non-empty value is enough there.
      lib.GlobalWorkerOptions.workerSrc = 'pdf.worker.mjs';
    }
  }

  pdfjs = lib;
  return pdfjs;
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextResult> {
  try {
    const lib = await loadPdfjs();

    // The loading task owns teardown; the document itself has no destroy().
    const task = lib.getDocument({
      // pdf.js transfers and detaches the buffer it is given; the caller still needs the
      // original bytes to upload, so hand it a copy.
      data: new Uint8Array(bytes),
      // No compiling font data into functions: that is how a crafted PDF once ran script
      // (CVE-2024-4367). See the same option in `apps/web/src/pdf/render.ts`.
      isEvalSupported: false,
      // Fonts and images are irrelevant when only the text layer is wanted, and skipping
      // them is a large speedup across thousands of scans.
      disableFontFace: true,
      useSystemFonts: false,
    } as Parameters<typeof lib.getDocument>[0]);
    const doc = await task.promise;

    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const parts: string[] = [];

    for (let i = 1; i <= pageCount; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      parts.push(line);
      // Release page resources as we go; a 100-page scan otherwise accumulates.
      page.cleanup();
    }

    const total = doc.numPages;
    await task.destroy();

    const { text, quality } = cleanExtractedText(parts.join('\n'));
    return { text, quality, pages: total };
  } catch (err) {
    return {
      text: '',
      quality: { usable: false, reason: 'extraction failed', wordRatio: 0, wordCount: 0 },
      pages: 0,
      error: (err as Error).message,
    };
  }
}
