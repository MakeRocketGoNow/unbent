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
    /**
     * The one setting that keeps a hostile PDF's code out of this origin.
     *
     * pdf.js never runs a document's own JavaScript — `/OpenAction` scripts, form
     * calculations and the rest are handled only by the viewer's scripting sandbox
     * (`pdf.scripting.mjs`), which this module does not load. Keep it that way: don't
     * pull in the viewer or pass `enableScripting` to show a form's computed fields.
     *
     * What pdf.js core can do is compile a font's glyph outlines with `new Function` for
     * speed, from values the file supplies. CVE-2024-4367 was exactly that: a crafted
     * FontMatrix became script in the page. The bug is patched, but this path is the one
     * that would carry the next one, and the canvas renderer does not need it.
     * `render.test.ts` pins the option.
     */
    isEvalSupported: false,
    /**
     * Where the image decoders live; `vite.config.ts` serves them there.
     *
     * Without this every JBIG2 or CCITT fax image fails to decode — pdf.js 6 handles
     * both in WebAssembly — and a black-and-white scan renders as a blank white page,
     * with only its invisible OCR text layer drawn.
     */
    wasmUrl: '/pdfjs/wasm/',
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

      /**
       * `canvas` alone, and the device-pixel scale as a `transform`.
       *
       * pdf.js 6 treats `canvas` and `canvasContext` as alternatives, and when both are
       * given it keeps the canvas and drops the context outright
       * (`_canvasContext = params.canvas ? null : params.canvasContext`). It then fetches
       * its own context with `{ alpha: false }`. So a `ctx.scale(dpr, dpr)` applied to a
       * context passed in here was being silently discarded: pages drew at 1x into a
       * canvas sized for 2x, filling a quarter of it and leaving the rest blank.
       *
       * `transform` is where pdf.js wants that scale, and it survives because pdf.js
       * applies it to the context it built itself.
       */
      await page.render({
        canvas,
        viewport,
        // `undefined` rather than `null` at 1x: pdf.js defaults the parameter to null
        // itself, and its published type does not admit null from a caller.
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      }).promise;
    },

    destroy() {
      void task.destroy();
    },
  };
}

/**
 * Shared, reference-counted documents for callers that mount and unmount repeatedly.
 *
 * `loadPdf` gives each caller its own copy, which is right for the preview pane: one
 * component owns one document for as long as it is on screen. The editor is the opposite
 * case. Its decorations are rebuilt on every keystroke, selection move, and scroll, and a
 * widget scrolled out of the viewport is destroyed outright — so an unshared document
 * would re-download and re-parse the same file on every pass over a note holding nine of
 * them.
 *
 * Keyed by URL because that is what identifies an attachment. Entries are dropped when the
 * last holder releases, so switching notes does not accumulate parsed documents.
 */
interface CacheEntry {
  doc: Promise<LoadedPdf>;
  holders: number;
}

const shared = new Map<string, CacheEntry>();

/** A shared document, opened on first use. Every call must be matched by `releasePdf`. */
export function acquirePdf(url: string): Promise<LoadedPdf> {
  const existing = shared.get(url);
  if (existing) {
    existing.holders += 1;
    return existing.doc;
  }

  const entry: CacheEntry = {
    holders: 1,
    doc: loadPdf(url).catch((err: unknown) => {
      // A failed open must not be cached, or one transient error would make the
      // attachment permanently unrenderable for the rest of the session.
      shared.delete(url);
      throw err;
    }),
  };
  shared.set(url, entry);
  return entry.doc;
}

/** Drops one holder, destroying the document when the last one lets go. */
export function releasePdf(url: string): void {
  const entry = shared.get(url);
  if (!entry) return;

  entry.holders -= 1;
  if (entry.holders > 0) return;

  shared.delete(url);
  // The open may still be in flight; destroy once it settles, and swallow a rejection
  // that `acquirePdf`'s caller has already been handed.
  void entry.doc.then(
    (doc) => doc.destroy(),
    () => {},
  );
}
