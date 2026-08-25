/// <reference path="./pdf-worker-url.d.ts" />
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

/** True when this module is evaluating inside a dedicated Web Worker. */
function isWorkerScope(): boolean {
  return typeof self !== 'undefined' && self.constructor?.name === 'DedicatedWorkerGlobalScope';
}

async function loadPdfjs(): Promise<PdfModule> {
  if (pdfjs) return pdfjs;

  const lib = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;

  /**
   * Configure how pdf.js runs its parse thread.
   *
   * pdf.js 6 dropped `disableWorker`. A blank `workerSrc` still throws in the browser
   * before any fallback, which is why Node tests once passed while every real file failed.
   *
   * Import already runs inside a Web Worker. Spawning a *nested* Worker from that scope
   * (via a Vite `?url` workerSrc) is what killed the importer on the first PDF: the parent
   * worker died with an empty `onerror`, the UI froze after the last attachment-free note,
   * and a resume skipped the half-imported note forever. Loading the worker script into
   * *this* scope registers `globalThis.pdfjsWorker`, which makes pdf.js take its in-process
   * path instead.
   */
  if (isWorkerScope()) {
    await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs');
    if (!lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = 'pdf.worker.mjs';
    }
  } else if (!lib.GlobalWorkerOptions.workerSrc) {
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
      isEvalSupported: false,
      // Fonts and images are irrelevant when only the text layer is wanted, and skipping
      // them is a large speedup across thousands of scans.
      disableFontFace: true,
      useSystemFonts: false,
    } as Parameters<typeof lib.getDocument>[0]);    const doc = await task.promise;

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
