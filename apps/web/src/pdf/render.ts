/**
 * PDF rasterizing for inline preview.
 *
 * pdf.js rather than an `<iframe>` pointing at the browser's own viewer: attachment
 * responses carry `Content-Security-Policy: sandbox`, which stops the built-in viewer from
 * rendering at all. Rasterizing to a canvas ourselves needs no document context, so the
 * header stays exactly as the attachment hardening set it.
 *
 * This module deliberately holds no React. It owns loading the library, opening a document,
 * and drawing a page; components decide what to show and when.
 */

type PdfModule = typeof import('pdfjs-dist');

/** Loaded once per session, and only when a PDF is actually previewed. */
let pdfjs: PdfModule | null = null;
let loading: Promise<PdfModule> | null = null;

async function loadPdfjs(): Promise<PdfModule> {
  if (pdfjs) return pdfjs;
  // Concurrent previews on one note must not each start their own import.
  if (loading) return loading;

  loading = (async () => {
    const lib = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfModule;

    /**
     * pdf.js resolves `workerSrc` before deciding whether to spawn a worker and throws
     * when it is blank, even on the legacy build. This mirrors the extraction path in
     * `packages/enex/src/pdf-text.ts`, where a blank value passed tests under Node and
     * failed on every real file in the browser.
     */
    if (!lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc = (
        await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
      ).default;
    }

    pdfjs = lib;
    return lib;
  })();

  return loading;
}

export interface LoadedPdf {
  pageCount: number;
  /** Draws one 1-based page onto a canvas, sized for the given CSS width. */
  renderPage: (pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number) => Promise<void>;
  /** Releases the worker's copy of the document. */
  destroy: () => void;
}

/**
 * Opens a PDF from the attachment API.
 *
 * Fetched as bytes rather than handed to pdf.js as a URL so a 404 or an auth failure
 * surfaces as an ordinary fetch error the caller can show, instead of a pdf.js internal.
 */
export async function loadPdf(url: string, signal?: AbortSignal): Promise<LoadedPdf> {
  const lib = await loadPdfjs();

  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const task = lib.getDocument({
    data: bytes,
    /**
     * Fonts stay enabled here, unlike the extraction path.
     *
     * `pdf-text.ts` disables them because only the text layer matters there and skipping
     * fonts is a large speedup across thousands of scans. Rendering needs them: without
     * real glyphs the page draws with substituted fonts and wrong metrics.
     */
    isEvalSupported: false,
  } as Parameters<typeof lib.getDocument>[0]);

  const doc = await task.promise;

  return {
    pageCount: doc.numPages,

    async renderPage(pageNumber, canvas, cssWidth) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });

      // Scale so the page fills the available width rather than its intrinsic size.
      const scale = cssWidth / base.width;
      const viewport = page.getViewport({ scale });

      /**
       * Draw at device resolution, display at CSS resolution.
       *
       * Without this a page is rasterized at 1x and upscaled by the display, which looks
       * soft on any retina screen — and scanned medical documents are exactly the case
       * where small text has to stay legible. Capped at 2x: beyond that the memory cost
       * grows faster than the visible gain.
       */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.scale(dpr, dpr);

      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    },

    destroy() {
      void task.destroy();
    },
  };
}
