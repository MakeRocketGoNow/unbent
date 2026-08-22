import { cleanExtractedText, type CleanedText } from './ocr-text.js';

/**
 * Pulls the existing text layer out of a PDF.
 *
 * This is extraction, not OCR. Evernote already ran OCR on scanned attachments and
 * embedded the result, so the searchable text is sitting in the file — most notes in a
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
  if (!pdfjs) {
    /**
     * The legacy build runs without a separate worker script.
     *
     * Extraction already happens inside a Web Worker during import, so spawning a nested
     * one buys nothing — but the standard build insists on resolving `workerSrc` and
     * fails when it is blank. The legacy build is bundled for exactly this case and
     * resolves identically in the browser and in Node.
     */
    pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;
  }
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
      disableWorker: true,
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

/** Content types worth attempting extraction on. */
export function isExtractable(mime: string): boolean {
  return mime === 'application/pdf';
}
